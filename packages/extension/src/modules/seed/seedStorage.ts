/**
 * The data storage a seed takes, held against what the target has left before
 * the first record is written — what Forge and Autopilot hold their runs to.
 *
 * A Developer Edition has 5 MB of data storage. The first template of the
 * gallery wrote 7,601 records, about 15 MB at the 2 KB most records take: it
 * filled the org part way through, and left it with records whose children
 * were refused and a STORAGE_LIMIT_EXCEEDED on the first try. Seed read no
 * storage at all; its planned records went to Production Guard alone.
 */

import type { CheckpointRefusal, RunCheckpointEstimate, SeedTemplate } from '@sandforge/shared';
import {
  apiBudgetCheckOf,
  apiBudgetRefusal,
  checkpointPartOf,
  checkpointScopeStop,
  countedStorageBytes,
  readApiBudget,
  readDataStorage,
  runRequestsEstimate,
  storageCheckOf,
  storageRefusal,
  type ApiBudgetCheck,
  type LimitsTransport,
  type RunRequestParts,
  type StorageCheck,
} from '../forge/ForgeRunGate.js';
import { fitBudgetOf, type FitBudget } from '../forge/fitBudget.js';

/** Records past which a seed sends an object as a Bulk API job (`seedInsert`'s default). */
const SEED_BULK_THRESHOLD = 200;

/**
 * The API requests a seed's writes make of its target, roughly: each object
 * by REST up to {@link SEED_BULK_THRESHOLD} records, as a Bulk API job past it.
 */
export function seedRequestsEstimate(template: Pick<SeedTemplate, 'objects'>): number {
  return runRequestsEstimate(
    template.objects.map((object) => ({
      rows: object.recordCount,
      bulk: object.recordCount > SEED_BULK_THRESHOLD,
    })),
  );
}
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';

/**
 * The storage a seed's records take once written, by the sizes Salesforce
 * documents: each object's record count — the most a relation writes, as the
 * guard counts it — at 2 KB a record, 4 KB a person account, 8 KB a campaign,
 * 1 KB a campaign member, 4 KB an article.
 *
 * @param personObjects - The objects written as person accounts.
 */
export function seedStorageBytes(
  template: Pick<SeedTemplate, 'objects'>,
  personObjects: readonly string[],
): number {
  return template.objects.reduce(
    (sum, object) =>
      sum +
      countedStorageBytes(object.objectApiName, {
        rows: object.recordCount,
        personAccounts: personObjects.includes(object.objectApiName) ? object.recordCount : 0,
      }),
    0,
  );
}

/** What the seed takes against what the target has left, and why it cannot run when it cannot. */
export interface SeedStorageGate {
  check: StorageCheck;
  /**
   * Its calls against the daily API requests the target has left, read from
   * the same `/limits`, or on their own when the storage could not be read:
   * those of the checkpoint it takes first among them.
   */
  api: ApiBudgetCheck;
  /**
   * Why nothing is written: the checkpoint it takes first was refused, or
   * the records take more than the target has left of its storage, or of
   * today's API requests (`refusedFor`).
   */
  refusal?: string;
  refusedFor?: 'checkpoint' | 'storage' | 'apiRequests';
  /**
   * The refusal the checkpoint's scope met, by its code — `DISK` where this
   * machine has no room for it, `NOTHING_HELD`, another run writing… — for
   * the run's record to keep beside its own. Set with `refusedFor: 'checkpoint'`.
   */
  checkpointRefusal?: CheckpointRefusal;
}

/**
 * The code a seed refused for the data storage it takes is answered with: in
 * the panel, and in the command's line and summary.
 */
export const SEED_STORAGE_EXCEEDED = 'SEED_STORAGE_EXCEEDED';

/**
 * Hold a seed to the data storage its target has left: refused past it, let
 * through otherwise. A target that does not say what it has left — the user
 * may not read its limits — lets the seed through, its check `unread`, for
 * the caller to say so.
 *
 * Asked to take a checkpoint first, the seed is refused for the refusal its
 * scope met at the gate before anything else — the disk of this machine
 * among them, which the port of the checkpoints reads before anything of the
 * org is: a take that fills it fails and keeps nothing, after minutes of
 * reads — and the checkpoint's requests are counted with the seed's.
 *
 * @param target - The org, as the refusal names it.
 * @param checkpoint - What the checkpoint the seed takes first would hold and
 *   cost, as the port of the checkpoints scoped it; absent when not asked.
 * @param deliverability - The requests its read of whether the target
 *   delivers its emails sent (`deliverabilityPartOf`), counted with the seed's.
 */
export async function seedStorageGate(
  transport: LimitsTransport,
  template: Pick<SeedTemplate, 'objects'>,
  personObjects: readonly string[],
  target: string,
  checkpoint?: RunCheckpointEstimate,
  deliverability: Pick<RunRequestParts, 'deliverability'> = {},
): Promise<SeedStorageGate> {
  const plan = { storageBytes: seedStorageBytes(template, personObjects) };
  let storage: Awaited<ReturnType<typeof readDataStorage>> | { unread: string };
  try {
    storage = await readDataStorage(transport);
  } catch (err: unknown) {
    storage = { unread: extractErrorMessage(err) };
  }
  const check = storageCheckOf(plan, storage);
  // The daily requests on their own when the storage could not be read, as
  // Sync reads them: a Standard User's `/limits` list them and not the
  // storage, and the seed took both for unread, refused past neither.
  const budget =
    'unread' in storage
      ? await readApiBudget(transport).catch((err: unknown) => ({
          unread: extractErrorMessage(err),
        }))
      : storage.dailyApiRequests;
  const api = apiBudgetCheckOf(
    { run: seedRequestsEstimate(template), ...checkpointPartOf(checkpoint), ...deliverability },
    budget,
  );
  const refused = checkpointScopeStop(checkpoint);
  if (refused) {
    return {
      check,
      api,
      refusal: refused.message,
      refusedFor: 'checkpoint',
      checkpointRefusal: refused.refusal,
    };
  }
  const refusal = storageRefusal(check, target);
  if (refusal) {
    return { check, api, refusal: `${refusal} Nothing was written.`, refusedFor: 'storage' };
  }
  const overBudget = apiBudgetRefusal(api, target);
  return overBudget
    ? { check, api, refusal: overBudget, refusedFor: 'apiRequests' }
    : { check, api };
}

/**
 * The budget a fit of the seed is held to, from what its gate read of the
 * target — the data storage and the daily API requests of one `/limits` —
 * so the counts a refusal proposes cost no read more. The requests of the
 * checkpoint taken first are counted beside the seed's own, which the fit
 * leaves room for: it scales the seed's records, not the checkpoint.
 *
 * @param withinMB - The most MB asked of the fit (`--fit-within`), beside what the target has left.
 * @returns Nothing to fit to when the target would not say its storage.
 */
export function seedFitBudgetOf(
  gate: Pick<SeedStorageGate, 'check' | 'api'>,
  withinMB?: number,
): FitBudget | { unread: string } {
  const { check, api } = gate;
  const parts: Partial<RunRequestParts> = api.parts ?? {};
  const others = {
    checkpoint: parts.checkpoint ?? 0,
    readBack: parts.readBack ?? 0,
    deliverability: parts.deliverability ?? 0,
    fit: parts.fit ?? 0,
  };
  return fitBudgetOf({
    storage:
      check.verdict === 'unread'
        ? { unread: check.unread }
        : { maxMB: check.maxMB, remainingMB: check.remainingMB },
    ...(withinMB !== undefined ? { withinMB } : {}),
    api:
      api.verdict === 'unread'
        ? { unread: api.unread }
        : { max: api.max, remaining: api.remaining },
    otherRequests: others,
  });
}
