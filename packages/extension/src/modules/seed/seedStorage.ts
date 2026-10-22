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

import type { SeedTemplate } from '@sandforge/shared';
import {
  apiBudgetCheckOf,
  apiBudgetRefusal,
  countedStorageBytes,
  readDataStorage,
  runRequestsEstimate,
  storageCheckOf,
  storageRefusal,
  type ApiBudgetCheck,
  type LimitsTransport,
  type StorageCheck,
} from '../forge/ForgeRunGate.js';

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
  /** Its calls against the daily API requests the target has left, read from the same `/limits`. */
  api: ApiBudgetCheck;
  /**
   * Why nothing is written: the records take more than the target has left
   * of its storage, or of today's API requests (`refusedFor`).
   */
  refusal?: string;
  refusedFor?: 'storage' | 'apiRequests';
}

/**
 * Hold a seed to the data storage its target has left: refused past it, let
 * through otherwise. A target that does not say what it has left — the user
 * may not read its limits — lets the seed through, its check `unread`, for
 * the caller to say so.
 *
 * @param target - The org, as the refusal names it.
 */
export async function seedStorageGate(
  transport: LimitsTransport,
  template: Pick<SeedTemplate, 'objects'>,
  personObjects: readonly string[],
  target: string,
): Promise<SeedStorageGate> {
  const plan = { storageBytes: seedStorageBytes(template, personObjects) };
  let storage: Awaited<ReturnType<typeof readDataStorage>> | { unread: string };
  try {
    storage = await readDataStorage(transport);
  } catch (err: unknown) {
    storage = { unread: extractErrorMessage(err) };
  }
  const check = storageCheckOf(plan, storage);
  const api = apiBudgetCheckOf(
    seedRequestsEstimate(template),
    'unread' in storage ? storage : storage.dailyApiRequests,
  );
  const refusal = storageRefusal(check, target);
  if (refusal) {
    return { check, api, refusal: `${refusal} Nothing was written.`, refusedFor: 'storage' };
  }
  const overBudget = apiBudgetRefusal(api, target);
  return overBudget
    ? { check, api, refusal: overBudget, refusedFor: 'apiRequests' }
    : { check, api };
}
