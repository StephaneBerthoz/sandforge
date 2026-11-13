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

import type {
  CheckpointRefusal,
  GrappeConfig,
  RunCheckpointEstimate,
  SeedTemplate,
} from '@sandforge/shared';
import { seedsStandardPricebook } from '@sandforge/shared';
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
import { seedSliceOf } from './SeedOrchestrator.js';
import { PARENT_IDS_PER_QUERY } from './existingParents.js';

/** Records past which a seed sends an object as a Bulk API job (`seedInsert`'s default). */
const SEED_BULK_THRESHOLD = 200;

/**
 * The query of the org's active duplicate rules a seed's insert sends once,
 * before the first insert past the Bulk API threshold
 * (`objectsUnderDuplicateRules`).
 */
const DUPLICATE_RULES_READ = 1;

/** The read of the org's object list a seed's run sends once (`seedObjectAccess`). */
const OBJECT_LIST_READ = 1;

/**
 * The calls jsforce's `identity` sends a connection that has not asked it
 * before: the API's root, for the identity URL, then that URL.
 */
const IDENTITY_CALLS = 2;

/**
 * What the command line sends to type its target before a real run writes
 * (`typeTarget`): `Organization` read once, and once more for an org that is
 * no sandbox — a scratch org, a Developer Edition.
 */
const ORG_TYPE_READS = 2;

/**
 * The target's `/limits` as a run reads them from its gate on, at most: the
 * gate's read, its read of the daily requests alone when the storage is not
 * told, and the read of the day's emails when something may send one.
 */
const LIMITS_READS = 3;

/** The read of the org's standard price book, once a run, for a seed that points at it. */
const STANDARD_PRICEBOOK_READ = 1;

/**
 * The opportunities whose contact roles one query reads (`contactRolesOf`):
 * those the platform wrote as it took them, found before the roles go.
 */
const PLATFORM_ROLES_PER_READ = 200;

/** The object whose records a run writes only for a Marketing User, which it reads first. */
const CAMPAIGN = 'Campaign';

/** How a seed's records reach its target, as far as what they cost it goes. */
export interface SeedWritePath {
  /**
   * Whether an active duplicate rule watches each object, as the read of the
   * target's automation said it (`duplicateRulesOf`): the insert sends such
   * an object through REST, however many its records, and any other past
   * the threshold as Bulk API jobs. An object it does not name, or every
   * object when absent, may go either way: it is priced the dearer.
   */
  duplicateRules?: ReadonlyMap<string, boolean>;
  /**
   * The records of each insert when the run partitions the seed
   * (`seedPartitionOf`); absent, an object goes a slice at a time
   * (`seedSliceOf`).
   */
  partition?: number;
  /**
   * The records of an insert past which it goes as a Bulk API job, as the
   * run's insert is given it (`RobustnessConfig.bulk.threshold`): 200 when
   * absent. A panel set to 500 sends 300 records by REST; set to 100, it sends
   * 150 as a job, thirteen calls where REST takes one.
   */
  bulkThreshold?: number;
  /**
   * Whether the run reads what its target is before it writes, as the
   * command line does to refuse a production org (`refuseProductionTarget`):
   * a dry run reads none of it, and says what a run would send.
   */
  typedFirst?: boolean;
  /**
   * The requests the command line had sent its target when its gate priced
   * the run, counted as they went (`countRequests`): what typed the org,
   * described the objects the line names, read the target's automation and
   * scoped a checkpoint. Priced as sent, whatever the records; absent, none.
   */
  sentBefore?: number;
  /**
   * The requests the panel's read of the target's automation sent just
   * before its gate (`automationReadRequests`), where nothing counts what a
   * run sends as it goes: the connections are the window's, shared by every
   * page. The command line's is among what it sent ({@link sentBefore}).
   */
  automationRead?: number;
}

/** Whether `rules` say a duplicate rule watches `objectApiName`, whatever its case; nothing when they do not say. */
export function watchedBy(
  rules: ReadonlyMap<string, boolean> | undefined,
  objectApiName: string,
): boolean | undefined {
  if (!rules) return undefined;
  const name = objectApiName.toLowerCase();
  for (const [object, watched] of rules) if (object.toLowerCase() === name) return watched;
  return undefined;
}

/** The records of each insert of `count` records, `size` at a time: at least one, as the run sends. */
function insertsOf(count: number, size: number): number[] {
  const step = Math.max(1, Math.floor(size));
  const inserts: number[] = [];
  let from = 0;
  do {
    const n = Math.max(0, Math.min(step, count - from));
    inserts.push(n);
    from += n;
  } while (from < count);
  return inserts;
}

/**
 * The API requests a seed's writes make of its target, as its insert sends
 * them (`seedInsert`): each object a slice of up to 10,000 records at a time
 * — fewer for a wide one, a partition each when the run partitions the seed
 * —, each slice by REST calls of its batch size up to the Bulk API threshold
 * ({@link SeedWritePath.bulkThreshold}), and past it as one Bulk API job over
 * its whole time, unless a duplicate rule watches the object, which then goes
 * by REST however many its records. Where the read of the rules did not say,
 * the dearer of the two. With a job, the query of the rules; and the calls of
 * the roles the platform writes with the opportunities.
 *
 * A job was counted five calls whatever its time, and an object a rule
 * watches as jobs: 25,000 contacts, which the insert sends in 125 REST calls,
 * were counted 15 requests. What the insert cannot know before — the rows a
 * validation rule refused, sent again without its fields; a call tried again
 * — is left out.
 */
export function seedWritesEstimate(
  template: Pick<SeedTemplate, 'objects'>,
  path: SeedWritePath = {},
): number {
  const threshold = path.bulkThreshold ?? SEED_BULK_THRESHOLD;
  let jobs = false;
  const writes = template.objects.flatMap((object) => {
    const watched = watchedBy(path.duplicateRules, object.objectApiName);
    return insertsOf(object.recordCount, path.partition ?? seedSliceOf(object)).map((records) => {
      const rest = runRequestsEstimate([{ rows: records, perCall: object.batchSize }]);
      if (records <= threshold) return rest;
      jobs = true;
      if (watched === true) return rest;
      const job = runRequestsEstimate([{ rows: records, bulk: true }]);
      return watched === false ? job : Math.max(job, rest);
    });
  });
  return (
    writes.reduce((sum, calls) => sum + calls, 0) +
    (jobs ? DUPLICATE_RULES_READ : 0) +
    runRequestsEstimate(platformRoleCalls(template))
  );
}

/**
 * The API requests a seed's run makes of its target: its writes
 * ({@link seedWritesEstimate}), and what it reads of the target as it writes
 * them ({@link seedRunReads}). What the gate holds the run to, and a fit.
 */
export function seedRequestsEstimate(
  template: Pick<SeedTemplate, 'objects' | 'relations'>,
  path: SeedWritePath = {},
): number {
  return seedWritesEstimate(template, path) + seedRunReads(template, path);
}

/**
 * What a seed's run reads of its target as it writes, at most, each read one
 * of its daily requests: the org's object list, once (`seedObjectAccess`);
 * each object's describe, once (`describedFieldsOf`), for the fields it
 * takes; who the run writes as, for the sweep of its removal (`keepRunUser`);
 * with a campaign, who again, and the Marketing User box of that user; the
 * parents of each relation, a page of 2,000 of those the org holds already,
 * a query of 200 of those named by id; the standard price book, for a seed
 * that points at it; from the command line, what the target is
 * ({@link SeedWritePath.typedFirst}); the target's limits, from the gate on;
 * what the command line sent before its gate ({@link SeedWritePath.sentBefore});
 * and the panel's read of the target's automation ({@link SeedWritePath.automationRead}).
 *
 * Asked live, a seed of 600 contacts under the standard duplicate rule took
 * six requests more than its dry run, and was counted four, the three calls
 * of its records and the query of the rules: the reads that typed the org
 * before it wrote, and who it writes as, were counted nowhere, nor were the
 * object list and the describes each run reads as it writes. Counted call
 * by call, the same seed then sent sixteen and was priced ten: seven reads
 * before its gate — what the org is, the contact's describe for its fields,
 * five of the target's automation — and the gate's own read of its limits
 * were priced nowhere.
 */
export function seedRunReads(
  template: Pick<SeedTemplate, 'objects' | 'relations'>,
  path: Pick<SeedWritePath, 'typedFirst' | 'sentBefore' | 'automationRead'> = {},
): number {
  const names = new Set(template.objects.map((object) => object.objectApiName));
  const pricebook = template.objects.some((object) =>
    object.fieldRules.some((rule) => seedsStandardPricebook(rule, names)),
  );
  const parents = (template.relations ?? []).reduce((sum, { parents: from }) => {
    if (from.kind === 'existing')
      return sum + runRequestsEstimate([{ rows: 0, readRows: from.limit }]);
    if (from.kind === 'records') return sum + Math.ceil(from.ids.length / PARENT_IDS_PER_QUERY);
    return sum;
  }, 0);
  return (
    OBJECT_LIST_READ +
    template.objects.length +
    IDENTITY_CALLS +
    (names.has(CAMPAIGN) ? IDENTITY_CALLS + 1 : 0) +
    parents +
    (pricebook ? STANDARD_PRICEBOOK_READ : 0) +
    (path.typedFirst ? ORG_TYPE_READS : 0) +
    LIMITS_READS +
    Math.max(0, path.sentBefore ?? 0) +
    Math.max(0, path.automationRead ?? 0)
  );
}

/**
 * The records each insert of a seed holds when the run partitions it, as the
 * orchestrator decides (`shouldActivateGrappe`): the setting on, and the
 * seed's records at its threshold or more. Nothing otherwise.
 */
export function seedPartitionOf(
  grappe: Pick<GrappeConfig, 'enabled' | 'autoActivateThreshold' | 'grappeSize'> | undefined,
  template: Pick<SeedTemplate, 'objects'>,
): number | undefined {
  if (!grappe?.enabled) return undefined;
  const total = template.objects.reduce((sum, object) => sum + object.recordCount, 0);
  return total >= grappe.autoActivateThreshold ? grappe.grappeSize : undefined;
}

/**
 * The API requests an import's writes make of its target, as the writer of
 * the CSV import and of the clone sends them (`BulkDataWriter`): an object of
 * no more than `threshold` records by REST calls of `perCall`; past it, one
 * Bulk API job over its whole time, however many its records — more than
 * 10,000 are read into the one job a chunk at a time —, and the rows a
 * duplicate rule refused in it sent again by REST, 200 a call. Every row of
 * an object a rule watches may be refused so, and is counted again; so is
 * every row of one the read of the rules did not say of.
 *
 * The clone priced its records as REST calls: 600 rows, one job of thirteen
 * calls, were counted three. The CSV import priced its rows as jobs of 10,000
 * at five calls each: 25,000 rows, one job of sixty-two, were counted fifteen.
 *
 * An object may say its own `perCall`, as each of a sync's says its batch
 * size; and that it `deletes`: the writer sends nothing of a delete again,
 * a duplicate rule refusing no delete.
 */
export function importRequestsEstimate(
  objects: ReadonlyArray<{
    objectApiName: string;
    rows: number;
    perCall?: number;
    deletes?: boolean;
  }>,
  path: { threshold: number; perCall?: number; duplicateRules?: ReadonlyMap<string, boolean> },
): number {
  return objects.reduce((sum, { objectApiName, rows, perCall, deletes }) => {
    if (rows <= path.threshold) {
      return sum + runRequestsEstimate([{ rows, perCall: perCall ?? path.perCall }]);
    }
    const refusedAgain =
      deletes === true || watchedBy(path.duplicateRules, objectApiName) === false ? 0 : rows;
    return sum + runRequestsEstimate([{ rows, bulk: true }, { rows: refusedAgain }]);
  }, 0);
}

/**
 * What the CSV import and the clone from an org send their target besides
 * their records, from their gate on, at most: its limits, which the gate
 * reads ({@link LIMITS_READS}); who the run writes as, for its removal's
 * sweep (`keepRunUser`), the API's root then the identity URL; for the
 * clone, each object's describe, read again as it writes (`describes`); and
 * the read of the target's automation each sends just before its gate
 * (`automation`, `automationReadRequests`).
 *
 * A seed's price counted who it writes as and the describes it reads as it
 * writes; the two that write through the import's writer priced their
 * records alone, and neither the gate's read nor who the run writes as was
 * counted anywhere. Sync writes through the same writer, and reads the
 * same of its target from its gate on.
 */
export function importRunReads(describes = 0, automation = 0): number {
  return LIMITS_READS + IDENTITY_CALLS + Math.max(0, describes) + Math.max(0, automation);
}

/**
 * The API requests a clone from an org makes of its target, as it sends
 * them: its records as an import's ({@link importRequestsEstimate}); the
 * roles the platform writes with the opportunities it creates, read 200
 * opportunities a query and given the source's fields by the same writer,
 * as many as there are opportunities and roles to link; its second pass,
 * an update of each record of an object written without a lookup the order
 * writes after it (`secondPass`), 200 a call (`fillOwedLookups`); and what
 * it reads of the target as it writes them ({@link importRunReads}).
 *
 * Its records alone were counted: a clone of 600 accounts whose parent
 * account goes in on the second pass sends three updates more than them.
 */
export function cloneRequestsEstimate(
  objects: ReadonlyArray<{ objectApiName: string; rows: number }>,
  path: Parameters<typeof importRequestsEstimate>[1] & {
    secondPass?: ReadonlySet<string>;
    /** What the read of the target's automation sent just before the gate (`automationReadRequests`). */
    automationRead?: number;
  },
): number {
  const rows = (name: string): number =>
    objects.find((object) => object.objectApiName === name)?.rows ?? 0;
  const roles = Math.min(rows('Opportunity'), rows('OpportunityContactRole'));
  const secondPass = objects
    .filter(({ objectApiName }) => path.secondPass?.has(objectApiName) === true)
    .map(({ rows: owing }) => ({ rows: owing }));
  return (
    importRequestsEstimate(objects, path) +
    (roles > 0
      ? Math.ceil(roles / PLATFORM_ROLES_PER_READ) +
        importRequestsEstimate([{ objectApiName: 'OpportunityContactRole', rows: roles }], path)
      : 0) +
    runRequestsEstimate(secondPass) +
    importRunReads(objects.length, path.automationRead)
  );
}

/**
 * The calls a seed of opportunities and contact roles makes besides their
 * inserts, for the role the platform writes with each opportunity it inserts
 * with a contact (`SeedPlatformRoles`): a read of the roles of two hundred
 * opportunities, and an update of two hundred of the roles linked to the
 * platform's. Counted as though every role were linked, and inserted all the
 * same: too high by what is linked, never too low.
 */
function platformRoleCalls(template: Pick<SeedTemplate, 'objects'>): Array<{ rows: number }> {
  const count = (name: string): number =>
    template.objects.find((object) => object.objectApiName === name)?.recordCount ?? 0;
  const linkable = Math.min(count('OpportunityContactRole'), count('Opportunity'));
  return linkable > 0 ? [{ rows: linkable }, { rows: linkable }] : [];
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
 * @param beside - The requests its read of whether the target delivers its
 *   emails sent (`deliverabilityPartOf`), and those the lease of its mute
 *   sends (`mutePartOf`), counted with the seed's.
 * @param path - How its records reach the target, as its requests are
 *   priced: the duplicate rules read with the target's automation, the
 *   partitions of the run, its Bulk API threshold, whether it types the org
 *   first (`seedRequestsEstimate`).
 */
export async function seedStorageGate(
  transport: LimitsTransport,
  template: Pick<SeedTemplate, 'objects' | 'relations'>,
  personObjects: readonly string[],
  target: string,
  checkpoint?: RunCheckpointEstimate,
  beside: Pick<RunRequestParts, 'deliverability' | 'mute'> = {},
  path: SeedWritePath = {},
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
    {
      run: seedRequestsEstimate(template, path),
      ...checkpointPartOf(checkpoint),
      ...beside,
    },
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
    mute: parts.mute ?? 0,
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
