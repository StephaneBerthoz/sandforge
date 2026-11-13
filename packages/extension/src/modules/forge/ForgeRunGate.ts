/**
 * What a Forge run is held to before it writes into an org: what the target
 * runs as the run inserts its records and updates those it writes a second
 * time, how many records it writes, and the data storage they take there;
 * and what a removal of its records sets off as it deletes them.
 *
 * Run for real, a clone whose dry run said 37 records wrote 34 216 into a
 * client sandbox — a parent added to its graph widened what was read of its
 * children — and stopped only when the sandbox's data storage ran out.
 * Nothing had looked at either figure before the first write, and the flows
 * the target ran on every record it created were said and never asked about.
 * The executor now hands its caller every row it is about to write before the
 * first one goes (`ExecuteOptions.beforeWrite`), and the extension and the
 * command line hold them here to the same measures: the extension asks past
 * a volume, the command refuses past `--max-total`, and both refuse rows the
 * target has no storage left for.
 *
 * Kept apart from the executor, so the bridge reads it without loading it.
 */

import * as z from 'zod';
import {
  BYTES_PER_MB,
  DATA_STORAGE_NOT_TOLD,
  FORGE_READ_CEILING_PER_OBJECT,
  assignPermsetCommand,
  automationByWrite,
  bypassAssignmentsOf,
  bypassesOfWrites,
  emailsPerInsertOf,
  firedOnRemovalOf,
  firedOnRemovalStepsOf,
  firedOnWriteOf,
  heldBypassPermissionsOf,
  isForgeRunGateCode,
} from '@sandforge/shared';
import type {
  CheckpointRefusal,
  CheckpointRefusalCode,
  EmailDeliverability,
  EmailSender,
  ForgeAutomationWrite,
  ForgeConfig,
  ForgeEmailLimit,
  ForgeEmailsPerInsert,
  ForgeFiredOnRemovalStep,
  ForgeFiredOnWrite,
  ForgeGraph,
  ForgeLeftOutCount,
  ForgeLeftOutObject,
  ForgeRemovalRisk,
  ForgeRemovalStep,
  ForgeRemovalSteps,
  ForgeRunGateCode,
  ForgeRunGateStop,
  ForgeTargetAutomation,
  ForgeTargetFlow,
  RunCheckpointEstimate,
  RunCheckpointTaken,
  RunDeliverability,
} from '@sandforge/shared';
import {
  beforeRunFailedWords,
  beforeRunRefusedWords,
  type BeforeRunTake,
} from '../checkpoint/beforeRunCheckpoint.js';
import {
  ACCOUNT,
  CONTACT,
  EMAIL_MESSAGE,
  FLAGS_THE_PLATFORM_LEAVES,
  STATUS_LIFECYCLES,
  isPersonAccountRow,
  writtenWithWords,
} from '../../core/common/platformRecords.js';
import type {
  AutomationConfirmation,
  BypassToAssign,
  FiredOnInsert,
  RunUpdateStep,
  WriteConfirmation,
  WriteConfirmationStorage,
} from '../../core/precheck/ProductionGuard.js';
import type { ForgeMayBeByThePlatform, ForgeWriteBoundary } from './ForgeExecutor.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import {
  FORGE_BULK_POLL_SCHEDULE,
  bulkJobCost,
  bulkJobRequests,
  bulkJobSeconds,
  bulkJobStateReads,
} from '../../core/engine/bulkJobCost.js';
import {
  DUPLICATE_RULE_FALLBACK_OBJECTS,
  FORGE_BULK_MIN_ROWS,
  FORGE_REST_ONLY_OBJECTS,
} from './ForgeBatchStrategy.js';
import { RUN_CANCELLED } from './forgeAudit.js';
import { ordersTheWrite } from './stages/ScopeResolver.js';
import { AUTOMATION_READ_MOST, objectsTheRunWrites } from './TargetAutomationReader.js';

/** The volume past which the extension asks before a run writes (`sandforge.safety.confirmAboveRecords`). */
export const DEFAULT_CONFIRM_ABOVE_RECORDS = 2_000;

/** The most records a command-line clone writes unless `--max-total` says otherwise. */
export const DEFAULT_MAX_TOTAL = 10_000;

/**
 * The most rows of one object a run of the panel reads without asking first,
 * unless `sandforge.forge.maxRecordsPerObject` says another number.
 *
 * A run read from a record holds every row it reads of an object until it has
 * cleaned and written them: the second pass, the rows held back for want of a
 * parent and the check that no two rows share an upsert key all take the
 * object whole. With Records per object on "All", nothing bounded that read —
 * a cap is the only bound — and a table of millions of rows would go into the
 * extension host's memory, with nothing said before it. A run of whole tables
 * reads and writes each page before the next (`ExecuteOptions.stream`), and
 * this number is the most it reads of one object.
 */
export const READ_CEILING_PER_OBJECT = FORGE_READ_CEILING_PER_OBJECT;

/**
 * The objects a run reads past `ceiling` rows: those it writes whose table
 * holds more, as discovery counted it, that the run's cap per object does not
 * bring under it, the most first. A table is the most a node's read can take;
 * a clone of one record reads only what its record reaches of it, which no
 * count before the read can say. A table discovery could not count is not
 * among them: no figure says it is past.
 *
 * @param maxRecordsPerObject - The run's cap per object, `undefined` for none.
 */
export function objectsAboveReadCeiling(
  graph: Pick<ForgeGraph, 'nodes'>,
  maxRecordsPerObject: number | undefined,
  ceiling: number = READ_CEILING_PER_OBJECT,
): Array<{ objectApiName: string; rows: number }> {
  const cap =
    maxRecordsPerObject !== undefined && maxRecordsPerObject > 0
      ? Math.floor(maxRecordsPerObject)
      : undefined;
  if (cap !== undefined && cap <= ceiling) return [];
  return graph.nodes
    .filter((node) => node.included && node.recordCountUnknown !== true)
    .map((node) => ({
      objectApiName: node.objectApiName,
      rows: cap === undefined ? node.recordCount : Math.min(node.recordCount, cap),
    }))
    .filter((object) => object.rows > ceiling)
    .sort((a, b) => b.rows - a.rows);
}

/**
 * Share of the data storage the target has left past which a run is said to
 * come near it. Salesforce counts storage a while after a load, so what an
 * org says it has left right after one is more than it has: the margin is
 * kept for that.
 */
export const STORAGE_NEAR_SHARE = 0.8;

const KB = 1024;

/*
 * The data storage a record takes, as Salesforce documents it
 * (help.salesforce.com, knowledge article 000383664, "Data and file storage
 * allocations"): most records take 2 KB whatever their fields hold; a person
 * account 4 KB, being an account and a contact; a campaign 8 KB; a campaign
 * member 1 KB; an article 4 KB, and more with rich text; an email message its
 * actual size.
 */
const RECORD_BYTES = 2 * KB;
const PERSON_ACCOUNT_BYTES = 4 * KB;
const CAMPAIGN_BYTES = 8 * KB;
const CAMPAIGN_MEMBER_BYTES = 1 * KB;
const ARTICLE_BYTES = 4 * KB;

/** A text field holds 255 characters at most: a longer value is a long or rich text area's. */
const TEXT_FIELD_MAX = 255;

/** The article versions of Salesforce Knowledge, `Knowledge__kav` and its kind. */
const ARTICLE_OBJECT = /__kav$/i;

/** The objects of a size of their own, by their name in lower case. */
const SIZED_OBJECTS: ReadonlyMap<string, string> = new Map(
  [EMAIL_MESSAGE, ACCOUNT, CONTACT, 'Campaign', 'CampaignMember'].map((name) => [
    name.toLowerCase(),
    name,
  ]),
);

/**
 * The name the sizes read `objectApiName` by: a configuration may write it in
 * any case, an SFDMU query's `from account` keeps its own, and the org reads
 * it all the same.
 */
function sizedName(objectApiName: string): string {
  return SIZED_OBJECTS.get(objectApiName.toLowerCase()) ?? objectApiName;
}

/** The bytes the text values of a row take. */
function textBytes(row: Record<string, unknown>, longerThan = 0): number {
  let bytes = 0;
  for (const value of Object.values(row)) {
    if (typeof value === 'string' && value.length > longerThan) {
      bytes += Buffer.byteLength(value, 'utf8');
    }
  }
  return bytes;
}

/**
 * The data storage one row of `objectApiName` takes once written, by the
 * documented sizes. The contact of a person account takes none of its own:
 * the 4 KB of its account count both, and the platform writes it with the
 * account.
 */
export function rowStorageBytes(objectApiName: string, row: Record<string, unknown>): number {
  const sized = sizedName(objectApiName);
  if (sized === EMAIL_MESSAGE) return textBytes(row);
  if (sized === ACCOUNT) {
    return isPersonAccountRow(row) ? PERSON_ACCOUNT_BYTES : RECORD_BYTES;
  }
  if (sized === CONTACT && isPersonAccountRow(row)) return 0;
  if (sized === 'Campaign') return CAMPAIGN_BYTES;
  if (sized === 'CampaignMember') return CAMPAIGN_MEMBER_BYTES;
  // The rich text an article holds is counted as the long values it has: a
  // long text area counted with it says a little too much, never too little.
  if (ARTICLE_OBJECT.test(objectApiName)) return ARTICLE_BYTES + textBytes(row, TEXT_FIELD_MAX);
  return RECORD_BYTES;
}

/** What a run is about to write of one object. */
export interface WritePlanObject {
  objectApiName: string;
  /** The rows, those the write may read besides counted in. */
  rows: number;
  storageBytes: number;
  /** Of `rows`, the prices the write may read besides those in hand, at most: see `ForgeWriteBoundary`. */
  mayAdd?: number;
  /** Of `rows`, those the platform may write itself, at most: see `ForgeWriteBoundary`. */
  mayBeByThePlatform?: ForgeMayBeByThePlatform;
}

/** What a run is about to write: per object, the most first, and in all. */
export interface WritePlan {
  objects: WritePlanObject[];
  totalRows: number;
  storageBytes: number;
  /**
   * What the run will not write of what it read or counted, left out of the
   * rows above: see `ForgeWriteBoundary.objects`. Absent when nothing is.
   */
  leftOut?: WritePlanLeftOut;
}

/** What a run will not write of what it read or counted. */
export interface WritePlanLeftOut {
  /** Rows the run it retries or resumes wrote, which it links to. */
  writtenBefore: number;
  /**
   * Per object, its rows held back for a record type closed to the user the
   * run writes as: the whole object, or, in a clone of the whole org that
   * writes its other rows, those of the closed types.
   */
  heldBack: Array<{ objectApiName: string; rows: number }>;
  /**
   * Of a clone of the whole org, per object, the rows held back with a
   * record they cannot be written without, held back itself. Absent when none.
   */
  withoutParent?: Array<{ objectApiName: string; rows: number }>;
  /**
   * Of a clone of the whole org, per object, the rows left aside: a lookup
   * they may not leave empty names a record the source does not hold, or
   * one so left aside. Absent when none.
   */
  noParentInSource?: Array<{ objectApiName: string; rows: number }>;
  /**
   * Per object, the rows the platform writes itself with a record the run
   * creates, which the write links to and never sends. Absent when none.
   */
  byThePlatform?: Array<{ objectApiName: string; rows: number }>;
  /**
   * Per object, the rows holding in a unique field a value the target holds
   * already, and the fields: sent, refused, and linked to the target's
   * record, which the write creates none of. Absent when none.
   */
  linkedByValue?: Array<{ objectApiName: string; rows: number; fields: readonly string[] }>;
}

/**
 * The data storage the rows a count says a run will write of `objectApiName`
 * take, by the documented sizes: the person accounts apart — 4 KB each, being
 * an account and a contact, and none for their contacts, which the platform
 * writes with them. A count says nothing of an email's size: an object read
 * page by page holds no email, which a run with emails reads whole.
 */
export function countedStorageBytes(
  objectApiName: string,
  counted: { rows: number; personAccounts?: number },
): number {
  const persons = Math.min(counted.personAccounts ?? 0, counted.rows);
  const others = counted.rows - persons;
  const sized = sizedName(objectApiName);
  if (sized === ACCOUNT) return others * RECORD_BYTES + persons * PERSON_ACCOUNT_BYTES;
  if (sized === CONTACT) return others * RECORD_BYTES;
  return others * rowStorageBytes(objectApiName, {});
}

/**
 * The rows a run is about to write, counted and measured. An object with none
 * is left out. One that comes with what its count says (`counted`) — a run
 * read page by page holds no row before it writes — is measured by the count.
 * The prices the write may read besides those in hand (`mayAdd`) are counted
 * in, at the size of a price.
 */
export function writePlanOf(objects: ForgeWriteBoundary['objects']): WritePlan {
  const measured = objects
    .map(({ objectApiName, rows, counted, mayAdd = 0, mayBeByThePlatform }): WritePlanObject => {
      const more = {
        rows: mayAdd,
        storageBytes: mayAdd * rowStorageBytes(objectApiName, {}),
        ...(mayAdd > 0 ? { mayAdd } : {}),
        ...(mayBeByThePlatform && mayBeByThePlatform.rows > 0 ? { mayBeByThePlatform } : {}),
      };
      return counted
        ? {
            objectApiName,
            ...more,
            rows: counted.rows + more.rows,
            storageBytes: countedStorageBytes(objectApiName, counted) + more.storageBytes,
          }
        : {
            objectApiName,
            ...more,
            rows: rows.length + more.rows,
            storageBytes:
              rows.reduce((sum, row) => sum + rowStorageBytes(objectApiName, row), 0) +
              more.storageBytes,
          };
    })
    .filter(({ rows }) => rows > 0)
    .sort((a, b) => b.rows - a.rows || a.objectApiName.localeCompare(b.objectApiName));
  const writtenBefore = objects.reduce(
    (sum, object) => sum + (object.leftOut?.writtenBefore ?? 0),
    0,
  );
  const heldBack = objects
    .filter((object) => (object.leftOut?.heldBack ?? 0) > 0)
    .map(({ objectApiName, leftOut }) => ({ objectApiName, rows: leftOut?.heldBack ?? 0 }));
  const byThePlatform = objects
    .filter((object) => (object.leftOut?.byThePlatform ?? 0) > 0)
    .map(({ objectApiName, leftOut }) => ({ objectApiName, rows: leftOut?.byThePlatform ?? 0 }));
  const linkedByValue = objects.flatMap(({ objectApiName, leftOut }) =>
    leftOut?.linkedByValue && leftOut.linkedByValue.rows > 0
      ? [{ objectApiName, ...leftOut.linkedByValue }]
      : [],
  );
  const rowsOf = (kind: 'withoutParent' | 'noParentInSource') =>
    objects
      .filter((object) => (object.leftOut?.[kind] ?? 0) > 0)
      .map(({ objectApiName, leftOut }) => ({ objectApiName, rows: leftOut?.[kind] ?? 0 }));
  const withoutParent = rowsOf('withoutParent');
  const noParentInSource = rowsOf('noParentInSource');
  return {
    objects: measured,
    totalRows: measured.reduce((sum, object) => sum + object.rows, 0),
    storageBytes: measured.reduce((sum, object) => sum + object.storageBytes, 0),
    ...(writtenBefore > 0 ||
    heldBack.length > 0 ||
    byThePlatform.length > 0 ||
    linkedByValue.length > 0 ||
    withoutParent.length > 0 ||
    noParentInSource.length > 0
      ? {
          leftOut: {
            writtenBefore,
            heldBack,
            ...(byThePlatform.length > 0 ? { byThePlatform } : {}),
            ...(linkedByValue.length > 0 ? { linkedByValue } : {}),
            ...(withoutParent.length > 0 ? { withoutParent } : {}),
            ...(noParentInSource.length > 0 ? { noParentInSource } : {}),
          },
        }
      : {}),
  };
}

/**
 * What tells one case from another for the volume a run writes: the orgs and
 * the input — the record, the query, the template, the prompt — and nothing
 * the user may change between a simulation and the run of it.
 *
 * The objects discovery found are left out, where the audit entry's case
 * holds them (`forgeCaseKey`), and so are the depth, the caps and the
 * filters: a clone whose dry run said 37 records wrote 34 216, a parent added
 * to its graph having widened what was read of its children. Held to the
 * same objects, the run that wrote them would have had no simulation to be
 * compared with.
 */
export function forgeVolumeCaseKey(
  config: Pick<
    ForgeConfig,
    | 'sourceOrgId'
    | 'targetOrgId'
    | 'inputMode'
    | 'recordId'
    | 'soqlQuery'
    | 'templateId'
    | 'aiPrompt'
  >,
): string {
  return JSON.stringify([
    config.sourceOrgId,
    config.targetOrgId,
    config.inputMode,
    config.recordId ?? null,
    config.soqlQuery ?? null,
    config.templateId ?? null,
    config.aiPrompt ?? null,
  ]);
}

/** What a simulation counted to write, as its gate measured it: see {@link LastSimulations}. */
export interface SimulatedWrite {
  /** When the simulation ended, in epoch milliseconds. */
  at: number;
  total: number;
  /** Per object it would write, the most first. */
  objects: Array<{ objectApiName: string; rows: number }>;
}

/** The cases whose last simulation is kept: the oldest go first. */
const SIMULATED_CASES_KEPT = 16;

/**
 * The last simulation of each case this window ran ({@link forgeVolumeCaseKey}),
 * for the gate of the run that follows: what it counted to write, measured
 * as that gate measures the run's rows (`writePlanOf`). Bounded: a case not
 * simulated again drops out once {@link SIMULATED_CASES_KEPT} others were.
 */
export class LastSimulations {
  private readonly kept = new Map<string, SimulatedWrite>();

  /** A simulation of the case `key` ended at `at`, having counted `plan`. */
  note(key: string, plan: Pick<WritePlan, 'objects' | 'totalRows'>, at: number = Date.now()): void {
    this.kept.delete(key);
    this.kept.set(key, {
      at,
      total: plan.totalRows,
      objects: plan.objects.map(({ objectApiName, rows }) => ({ objectApiName, rows })),
    });
    for (const oldest of this.kept.keys()) {
      if (this.kept.size <= SIMULATED_CASES_KEPT) break;
      this.kept.delete(oldest);
    }
  }

  /** The last simulation of the case `key`, when this window ran one. */
  of(key: string): SimulatedWrite | undefined {
    return this.kept.get(key);
  }
}

/** Records past a simulation's total past which a run is asked about, whatever its volume. */
const RECORDS_PAST_THE_SIMULATION = 500;

/**
 * Whether `total` is far past what the simulation of its case counted: more
 * than twice its total, or more than {@link RECORDS_PAST_THE_SIMULATION}
 * records more. Fewer records than it counted never are: a decision taken on
 * its gaps — an object left out, rows held back — writes fewer.
 */
export function farPastTheSimulation(total: number, simulated: number): boolean {
  return total > 2 * simulated || total - simulated > RECORDS_PAST_THE_SIMULATION;
}

/**
 * What a run's question says of the last simulation of its case: what it
 * counted, how long before, and whether the run is far past it.
 */
export function confirmationSimulatedOf(
  simulated: SimulatedWrite,
  total: number,
  now: number = Date.now(),
): NonNullable<WriteConfirmation['simulated']> {
  return {
    minutesBefore: Math.max(1, Math.ceil((now - simulated.at) / 60_000)),
    total: simulated.total,
    objects: simulated.objects.map(({ objectApiName, rows }) => ({ objectApiName, rows })),
    ...(farPastTheSimulation(total, simulated.total) ? { farAbove: true as const } : {}),
  };
}

/** The prices a plan counts the write may read besides those in hand, as a run's question says them. */
export function pricesForLinesOf(plan: Pick<WritePlan, 'objects'>): { pricesForLines?: number } {
  const rows = plan.objects.reduce((sum, object) => sum + (object.mayAdd ?? 0), 0);
  return rows > 0 ? { pricesForLines: rows } : {};
}

/**
 * The contact roles a plan counts that the platform may write itself, at
 * most, as a run's question says them: counted in, where the gate could not
 * tell them from the others.
 */
export function rolesMayBeOf(
  plan: Pick<WritePlan, 'objects'>,
): Pick<WriteConfirmation, 'rolesMayBeByThePlatform'> {
  const may = plan.objects.find((object) => object.mayBeByThePlatform)?.mayBeByThePlatform;
  if (!may || may.rows <= 0) return {};
  return {
    rolesMayBeByThePlatform: { rows: may.rows, ...(may.before === true ? { before: true } : {}) },
  };
}

/** What an org says of its data storage, in MB. */
export interface DataStorage {
  maxMB: number;
  remainingMB: number;
  /**
   * The daily API requests it has, read from the same answer: absent when
   * the answer did not list them.
   */
  dailyApiRequests?: ApiBudget;
  /**
   * The daily Bulk API batches it has, from the same answer — what a job of
   * Bulk API 2.0 takes a batch of per ten thousand records, shared with Bulk
   * API 1.0: absent when the answer did not list them.
   */
  dailyBulkApiBatches?: ApiBudget;
  /**
   * Its file storage, in MB, from the same answer — what the files a clone of
   * the whole org copies take: absent when the answer did not list it.
   */
  fileStorage?: { maxMB: number; remainingMB: number };
}

/** What an org has of its daily API requests, as its `/limits` say. */
export interface ApiBudget {
  max: number;
  remaining: number;
}

/** The part of a connection reading an org's limits needs. */
export interface LimitsTransport {
  request(request: { method: 'GET'; url: string }): Promise<unknown>;
}

/** A limit as `/limits` gives each: its most, and what is left of it. */
const limitSchema = z.object({ Max: z.number(), Remaining: z.number() }).loose();

/**
 * What `/limits` says of an org's data storage, and, when it lists them, of
 * its daily API requests, its daily Bulk API batches and its file storage:
 * one answer the write gate reads them all from.
 */
const dataStorageSchema = z
  .object({
    DataStorageMB: limitSchema,
    DailyApiRequests: limitSchema.optional(),
    DailyBulkApiBatches: limitSchema.optional(),
    FileStorageMB: limitSchema.optional(),
  })
  .loose();

/** What `/limits` says of an org's daily API requests. */
const apiBudgetSchema = z
  .object({
    DailyApiRequests: z.object({ Max: z.number(), Remaining: z.number() }).loose(),
  })
  .loose();

/**
 * Why the daily API requests an org has left are not known when its
 * `/limits` list none, as {@link DATA_STORAGE_NOT_TOLD} is for its storage.
 */
export const API_REQUESTS_NOT_TOLD = 'the org does not tell this user its daily API requests';

/**
 * Throws `notTold` when an answer of `/limits` lists no `limit`: the org's way
 * of not telling the user it. Parsed, the answer threw the schema's issues,
 * which the command lines and Sync's page printed as the reason, a JSON dump.
 */
function sayWhenNotTold(answer: unknown, limit: string, notTold: string): void {
  if (answer !== null && typeof answer === 'object' && !(limit in answer)) {
    throw new Error(notTold);
  }
}

/**
 * The data storage an org has, as its `/limits` say. The org may refuse it to
 * the user the run writes as, or leave it out of what it tells a Standard
 * User ({@link DATA_STORAGE_NOT_TOLD}); the caller says so, and never takes it
 * for enough.
 */
export async function readDataStorage(transport: LimitsTransport): Promise<DataStorage> {
  const answer = await transport.request({ method: 'GET', url: '/limits' });
  sayWhenNotTold(answer, 'DataStorageMB', DATA_STORAGE_NOT_TOLD);
  const limits = dataStorageSchema.parse(answer);
  return {
    maxMB: limits.DataStorageMB.Max,
    remainingMB: limits.DataStorageMB.Remaining,
    ...(limits.DailyApiRequests
      ? {
          dailyApiRequests: {
            max: limits.DailyApiRequests.Max,
            remaining: limits.DailyApiRequests.Remaining,
          },
        }
      : {}),
    ...(limits.DailyBulkApiBatches
      ? {
          dailyBulkApiBatches: {
            max: limits.DailyBulkApiBatches.Max,
            remaining: limits.DailyBulkApiBatches.Remaining,
          },
        }
      : {}),
    ...(limits.FileStorageMB
      ? {
          fileStorage: {
            maxMB: limits.FileStorageMB.Max,
            remainingMB: limits.FileStorageMB.Remaining,
          },
        }
      : {}),
  };
}

/**
 * The daily API requests an org has left, as its `/limits` say: for a run
 * that reads nothing else of them. The org may refuse it to the user the run
 * writes as; the caller says so, and never takes it for enough.
 */
export async function readApiBudget(transport: LimitsTransport): Promise<ApiBudget> {
  const answer = await transport.request({ method: 'GET', url: '/limits' });
  sayWhenNotTold(answer, 'DailyApiRequests', API_REQUESTS_NOT_TOLD);
  const limits = apiBudgetSchema.parse(answer);
  return { max: limits.DailyApiRequests.Max, remaining: limits.DailyApiRequests.Remaining };
}

/** Records a REST call writes, as the runs send them, and the most one takes. */
const ROWS_PER_REST_CALL = 200;
/** Records a query page reads. */
const ROWS_PER_READ = 2_000;
/**
 * The share of its daily requests an org may be left with, under which a run
 * that asks before it writes says so.
 */
export const API_BUDGET_NEAR_SHARE = 0.1;

/**
 * The calls a run makes of the org it writes to, roughly: per object, a REST
 * call per {@link ROWS_PER_REST_CALL} records — per `perCall`, when its
 * writer sends fewer a call —, or, for records sent as one Bulk API 2.0 job
 * (`bulk`), every call that job sends over its whole time (`bulkJobCost`):
 * opened, sent, closed, its state read as long as it runs, its results read
 * three ways; and a call per page of {@link ROWS_PER_READ} records it reads
 * of that org. A writer that sends an object in several jobs gives each its
 * own entry.
 *
 * A job was counted five calls per 10,000 records, whatever it held: its
 * reads of results were left out, and so was every read of its state past
 * the first. A seed of 600 records sent as one job took twelve calls,
 * counted five.
 */
export function runRequestsEstimate(
  objects: ReadonlyArray<{ rows: number; bulk?: boolean; readRows?: number; perCall?: number }>,
): number {
  return objects.reduce((sum, { rows, bulk, readRows, perCall }) => {
    const restPerCall = Math.min(ROWS_PER_REST_CALL, Math.max(1, perCall ?? ROWS_PER_REST_CALL));
    const writes = rows <= 0 ? 0 : bulk ? bulkJobCost(rows) : Math.ceil(rows / restPerCall);
    const reads = readRows && readRows > 0 ? Math.ceil(readRows / ROWS_PER_READ) : 0;
    return sum + writes + reads;
  }, 0);
}

/**
 * The parts of the API requests a run takes of the org it writes to, each
 * counted by what adds it and named where the run is refused for them:
 *
 * - `run`: its own reads and writes ({@link runRequestsEstimate});
 * - `checkpoint`: the checkpoint it takes first of what it writes, as the
 *   take estimates it (`Checkpoint first`);
 * - `mute`: the lease of the mute of the target's automation it holds while
 *   it writes, from its take to its release (`muteLeaseRequests`);
 * - `readBack`: the reads of the record type the target gave the records it
 *   created without one, one an object;
 * - `deliverability`: the read of whether the target delivers its emails,
 *   when something that still runs sends one;
 * - `fit`: the reads that fit it to the target's storage.
 *
 * A part a run does not have is absent, or 0. The refusal and the question
 * "near" are judged on their sum ({@link runRequestsTotal}); each idea adds
 * its own part, none rewrites the sum.
 */
export interface RunRequestParts {
  run: number;
  checkpoint?: number;
  mute?: number;
  readBack?: number;
  deliverability?: number;
  fit?: number;
}

/** The parts of a run's requests beside its own, in the order a refusal names them. */
const OTHER_PARTS = ['checkpoint', 'mute', 'readBack', 'deliverability', 'fit'] as const;

/** What each part beside the run's own is for, as a refusal says it. */
const PART_WORDS: Readonly<Record<(typeof OTHER_PARTS)[number], string>> = {
  checkpoint: 'for the checkpoint taken first',
  mute: "to assign and take back the permission sets that mute the target's automation",
  readBack: 'to read back the record types the target gave',
  deliverability: 'to read whether the target delivers its emails',
  fit: 'to fit the run to the storage',
};

/** The API requests of a run, every part together. */
export function runRequestsTotal(parts: RunRequestParts): number {
  return OTHER_PARTS.reduce((sum, part) => sum + Math.max(0, parts[part] ?? 0), parts.run);
}

/** The parts of `parts` beside the run's own that add a request; undefined when none does. */
function partsBeside(parts: RunRequestParts): RunRequestParts | undefined {
  return OTHER_PARTS.some((part) => (parts[part] ?? 0) > 0) ? { ...parts } : undefined;
}

/**
 * The calls a run makes against what the org it writes to has left today, or
 * why that is not known. `estimate` is every part together; `parts` says them
 * apart, absent when the run's own are all there is.
 */
export type ApiBudgetCheck =
  | {
      verdict: 'fits' | 'near' | 'exceeds';
      estimate: number;
      max: number;
      remaining: number;
      parts?: RunRequestParts;
    }
  | { verdict: 'unread'; estimate: number; unread: string; parts?: RunRequestParts };

/**
 * A run's calls against the target's daily API requests: `exceeds` past what
 * it has left, `near` when the run would leave it under
 * {@link API_BUDGET_NEAR_SHARE} of its daily limit, `unread` when it did not
 * say. Only Forge's Review compared them: a seed, a sync or an Autopilot run
 * into an org whose integrations had used the day's requests stopped part way
 * through, its records refused with REQUEST_LIMIT_EXCEEDED.
 */
export function apiBudgetCheckOf(
  requests: number | RunRequestParts,
  budget: ApiBudget | { unread: string } | undefined,
): ApiBudgetCheck {
  const parts = typeof requests === 'number' ? undefined : partsBeside(requests);
  const estimate = typeof requests === 'number' ? requests : runRequestsTotal(requests);
  const named = parts ? { parts } : {};
  if (!budget) {
    return {
      verdict: 'unread',
      estimate,
      unread: 'the limits the org answered list no DailyApiRequests',
      ...named,
    };
  }
  if ('unread' in budget) return { verdict: 'unread', estimate, unread: budget.unread, ...named };
  const { max, remaining } = budget;
  const verdict =
    estimate > remaining
      ? 'exceeds'
      : remaining - estimate < API_BUDGET_NEAR_SHARE * max
        ? 'near'
        : 'fits';
  return { verdict, estimate, max, remaining, ...named };
}

/**
 * The parts of a check's requests beside the run's own, as a refusal names
 * them: " (58 of them for the checkpoint taken first, 3 to read back the
 * record types the target gave)"; nothing when the run's own are all there is.
 */
function partsWords(parts: RunRequestParts | undefined): string {
  if (!parts) return '';
  const named = OTHER_PARTS.filter((part) => (parts[part] ?? 0) > 0).map(
    (part, i) => `${parts[part]}${i === 0 ? ' of them' : ''} ${PART_WORDS[part]}`,
  );
  return named.length > 0 ? ` (${named.join(', ')})` : '';
}

/**
 * The code every module's run is refused under past the daily API requests
 * its target has left, worded by the panel (`error-hints.ts`).
 */
export const API_BUDGET_EXCEEDED = 'API_BUDGET_EXCEEDED';

/** Why a run cannot be written for the API requests it takes, or nothing when it can. */
export function apiBudgetRefusal(check: ApiBudgetCheck, target: string): string | undefined {
  if (check.verdict !== 'exceeds') return undefined;
  return (
    `The run takes about ${check.estimate} API requests${partsWords(check.parts)}, and ${target} ` +
    `has ${check.remaining} ` +
    `of its ${check.max} daily requests left: it would stop part way through, its records ` +
    'refused with REQUEST_LIMIT_EXCEEDED. Run it once the org has requests to spare — the ' +
    'limit is counted over the last 24 hours — or write fewer records. Nothing was written.'
  );
}

/** The API requests of a check, as a run's question says them: only when they run short. */
export function confirmationApiOf(
  check: ApiBudgetCheck,
): { apiRequests: NonNullable<WriteConfirmation['apiRequests']> } | Record<string, never> {
  return check.verdict === 'near'
    ? {
        apiRequests: {
          estimate: check.estimate,
          remaining: check.remaining,
          max: check.max,
          ...(check.parts ? { parts: { ...check.parts } } : {}),
        },
      }
    : {};
}

/**
 * The code every module's run is refused under for the checkpoint it was
 * asked to take of what it writes before its first write (`Checkpoint
 * first`): its scope refused at the gate, or its take refused or failed once
 * the question was answered. The take's own refusal goes with it, for its
 * code (`DISK`, `NOTHING_HELD`, `API_BUDGET`…). Nothing was written, and the
 * mute assigned nothing: the take comes before the lease.
 */
export const CHECKPOINT_REFUSED = 'CHECKPOINT_REFUSED';

/**
 * The `checkpoint` part of a run's API requests: what the take of its
 * checkpoint first is estimated to send — the objects' records and their
 * recycle bin, as its scope counted them at the gate. Absent for a run that
 * takes none.
 */
export function checkpointPartOf(
  checkpoint: Pick<RunCheckpointEstimate, 'estimate'> | undefined,
): Pick<RunRequestParts, 'checkpoint'> {
  return checkpoint ? { checkpoint: checkpoint.estimate.apiRequests } : {};
}

/** Why a run stops before its first write for the checkpoint it was asked to take first. */
export interface CheckpointFirstStop {
  /** {@link CHECKPOINT_REFUSED}, or `RUN_CANCELLED` when the run's Stop came while the take read. */
  code: typeof CHECKPOINT_REFUSED | typeof RUN_CANCELLED;
  message: string;
  /** The take's refusal, by its code; absent for a take that failed or was stopped. */
  refusal?: CheckpointRefusal;
}

/**
 * Why a run is refused at its gate for the checkpoint it takes first: the
 * refusal its scope met there — another run writing, the org's lock, its
 * limits, the day's requests, the disk of this machine, or none of the
 * objects the run writes held. The run is refused before its question,
 * nothing taken and nothing written.
 */
export function checkpointScopeStop(
  checkpoint: Pick<RunCheckpointEstimate, 'refusal'> | undefined,
): { code: typeof CHECKPOINT_REFUSED; message: string; refusal: CheckpointRefusal } | undefined {
  const refusal = checkpoint?.refusal;
  if (refusal === undefined) return undefined;
  return { code: CHECKPOINT_REFUSED, message: beforeRunRefusedWords(refusal), refusal };
}

/** What a run says when its Stop came while it took the checkpoint first. */
export const CHECKPOINT_STOPPED_WORDS =
  'The run was stopped while it took the checkpoint first: nothing of it was kept, and nothing ' +
  'was written.';

/**
 * The take of the checkpoint a run asked for first, once its question is
 * answered and before the mute's lease is taken: the checkpoint, or why the
 * run stops with nothing written — the take refused, failed, or stopped by
 * the run's Stop, keeping nothing. A take that failed keeps nothing either,
 * and the run would have no checkpoint to rewind to, which the option
 * promised: it writes nothing.
 */
export async function takeCheckpointFirst(
  take: () => Promise<BeforeRunTake>,
): Promise<{ checkpoint: RunCheckpointTaken } | { stop: CheckpointFirstStop }> {
  let outcome: BeforeRunTake;
  try {
    outcome = await take();
  } catch (err: unknown) {
    return { stop: { code: CHECKPOINT_REFUSED, message: beforeRunFailedWords(err) } };
  }
  if (outcome.taken) return { checkpoint: outcome.checkpoint };
  if ('stopped' in outcome) {
    return { stop: { code: RUN_CANCELLED, message: CHECKPOINT_STOPPED_WORDS } };
  }
  return {
    stop: {
      code: CHECKPOINT_REFUSED,
      message: beforeRunRefusedWords(outcome.refusal),
      refusal: outcome.refusal,
    },
  };
}

/**
 * Records of one object Forge's writer sends in one Bulk API job at most:
 * `FORGE_BULK_JOB_ROWS` of `forgeBulkWrite`, which the gate does not load.
 */
const ROWS_PER_FORGE_JOB = 10_000;

/**
 * Records of a Bulk API 2.0 job one of the day's Bulk API batches counts:
 * the platform cuts what a job is sent into batches of this many, each taken
 * from `DailyBulkApiBatches`, which Bulk API 1.0 shares.
 */
const ROWS_PER_BULK_BATCH = 10_000;

/**
 * Seconds a REST write takes a record, about: the figure discovery gives a
 * graph's duration (`SECONDS_PER_RECORD`).
 */
const REST_SECONDS_PER_ROW = 0.01;

/**
 * How a run that writes through the Bulk API (`ExecuteOptions.writeApi:
 * 'auto'`, a clone of the whole org) sends its writes, as its gate prices
 * them.
 */
export interface ForgeBulkWrites {
  /**
   * The objects it writes by REST whatever their number besides those always
   * written so (`FORGE_REST_ONLY_OBJECTS`): those an active duplicate rule of
   * the target watches, which no job can waive. Absent while the target has
   * not said, the objects of the standard rules every org starts with
   * (`DUPLICATE_RULE_FALLBACK_OBJECTS`), as the writer takes them then.
   */
  restOnly?: ReadonlySet<string>;
}

/**
 * Whether a run that writes through the Bulk API writes `rows` records of
 * `objectApiName` by REST all the same: under {@link FORGE_BULK_MIN_ROWS},
 * an object always written by REST ({@link FORGE_REST_ONLY_OBJECTS}), or one
 * a duplicate rule watches ({@link ForgeBulkWrites.restOnly}).
 */
function likelyRest(objectApiName: string, rows: number, restOnly?: ReadonlySet<string>): boolean {
  return (
    rows < FORGE_BULK_MIN_ROWS ||
    FORGE_REST_ONLY_OBJECTS.has(objectApiName) ||
    (restOnly ?? DUPLICATE_RULE_FALLBACK_OBJECTS).has(objectApiName)
  );
}

/**
 * How Forge's writer sends `rows` records of one object when the run writes
 * through the Bulk API: in jobs of {@link ROWS_PER_FORGE_JOB}, what is left
 * past them by REST when it is under {@link FORGE_BULK_MIN_ROWS}
 * (`BatchWriter.sendRows`), and every row by REST for an object no job
 * writes ({@link likelyRest}). Priced for a writer handed ten thousand rows
 * at a time, as a clone of the whole org streams them: one handed fewer
 * would send smaller jobs, each priced whole.
 *
 * @returns The rows of each job, in order, and those sent by REST.
 */
export function forgeWritesOf(
  objectApiName: string,
  rows: number,
  bulk: ForgeBulkWrites,
): { jobs: number[]; rest: number } {
  if (rows <= 0) return { jobs: [], rest: 0 };
  if (likelyRest(objectApiName, rows, bulk.restOnly)) return { jobs: [], rest: rows };
  const jobs: number[] = [];
  for (let left = rows; left > 0; left -= ROWS_PER_FORGE_JOB) {
    const job = Math.min(left, ROWS_PER_FORGE_JOB);
    if (job < FORGE_BULK_MIN_ROWS) return { jobs, rest: job };
    jobs.push(job);
  }
  return { jobs, rest: 0 };
}

/**
 * Every call one Bulk API job of Forge's writer sends: opened, sent, closed,
 * its state read after the waits Forge's writer grows
 * (`FORGE_BULK_POLL_SCHEDULE`) for as long as a job that saves `records`
 * takes, and its results read three ways (`bulkJobRequests`).
 *
 * Priced as a job that saves its records, at the pace a seed of 12,000 cases
 * was measured at: a job of ten thousand rows sends thirteen calls, where
 * the pace of deletes priced it eleven.
 */
function forgeJobRequests(records: number): number {
  return bulkJobRequests({
    stateReads: bulkJobStateReads(records, FORGE_BULK_POLL_SCHEDULE, 'save'),
  });
}

/**
 * The calls Forge's writer sends `rows` records of one object in when the
 * run writes through the Bulk API: each job by the calls it sends, what is
 * left by REST calls of {@link ROWS_PER_REST_CALL} ({@link forgeWritesOf}).
 */
function forgeWriteRequests(objectApiName: string, rows: number, bulk: ForgeBulkWrites): number {
  const { jobs, rest } = forgeWritesOf(objectApiName, rows, bulk);
  return (
    jobs.reduce((calls, job) => calls + forgeJobRequests(job), 0) +
    Math.ceil(rest / ROWS_PER_REST_CALL)
  );
}

/**
 * The requests a clone of the whole org sends the target as it writes an
 * object, besides the writes themselves, as its gate prices them: what it
 * reads of the target for each object it writes — the records the target
 * holds by a value, the prices and record types it matches, a describe read
 * again —, which no count says.
 *
 * Asked live (13/11), a clone of 157 records of 19 objects, all by REST,
 * sent the target about 147 requests past what its dry run had, where its
 * gate priced 87, the checkpoint first's 64 among them: some 60 the price
 * left out, about three an object written. Four are taken.
 */
export const WHOLE_ORG_TARGET_READS_PER_OBJECT = 4;

/**
 * The requests a clone of the whole org sends the source as it reads an
 * object, besides its pages, as its gate prices them: the parents and the
 * rows its lookups name read again, the prices and record types it matches.
 *
 * Asked live (13/11), the same clone sent the source about 68 requests past
 * what its dry run had, where its gate priced 21, a page an object: some 47
 * left out, about two and a half an object. Three are taken.
 */
export const WHOLE_ORG_SOURCE_READS_PER_OBJECT = 3;

/**
 * The parts of the API requests a Forge run takes of its target once its
 * write gate lets the rows through:
 *
 * - `run`: its writes — a REST call per 200 rows of each object, every row
 *   going through sObject collections, and as many again for the objects its
 *   second pass updates (`objectsUpdatedAfterInsert`), at most; for a run
 *   that writes through the Bulk API (`bulk`), an object's rows as its
 *   writer sends them, jobs and REST ({@link forgeWritesOf}), and what it
 *   reads of the target as it writes each object
 *   ({@link WHOLE_ORG_TARGET_READS_PER_OBJECT}); a call per file it copies
 *   (`files`); and, from the command line, what the command sent the target
 *   before the gate, as counted (`sentBefore`);
 * - `checkpoint`: the take of the checkpoint it takes first, as its scope
 *   estimates it;
 * - `mute`: the lease of the mute it holds while it writes, from its take
 *   to its release (`muteLeaseRequests`);
 * - `readBack`: the reads of the record types the target gave the records
 *   created without one (`ForgeWriteBoundary.readBack`), at most;
 * - `deliverability`: what the read of whether the target delivers its emails
 *   sent, when something that still runs sends one.
 *
 * Its reads are past by then, and of the source: the target's budget never
 * paid for them.
 */
export function forgeRequestPartsOf(input: {
  plan: Pick<WritePlan, 'objects' | 'leftOut'>;
  /** The objects whose rows the run writes a second time. */
  updatedAfterInsert?: readonly string[];
  readBack?: number;
  checkpoint?: Pick<RunCheckpointEstimate, 'estimate'>;
  /** What the lease of the mute it holds while it writes sends (`muteLeaseRequests`). */
  mute?: number;
  /** What the read of whether the target delivers its emails sent (`deliverabilityPartOf`). */
  deliverability?: number;
  /** How the run sends its writes when it writes through the Bulk API; absent, every one by REST. */
  bulk?: ForgeBulkWrites;
  /** The files the run copies, a call each. */
  files?: number;
  /**
   * The requests the command line sent the target before the gate priced
   * the run, counted as they went (`countRequests`), the read of the
   * deliverability apart: priced as sent, so that the price is of the whole
   * run, as the summary's `sent` counts it. Absent, none.
   */
  sentBefore?: number;
}): RunRequestParts {
  const updated = new Set(input.updatedAfterInsert ?? []);
  // The rows a write links by a value the target holds create nothing, and
  // still go in its calls: counted with their object's.
  const linked = new Map(
    (input.plan.leftOut?.linkedByValue ?? []).map(({ objectApiName, rows }) => [
      objectApiName,
      rows,
    ]),
  );
  const writes = [
    ...input.plan.objects.map(({ objectApiName, rows }) => ({
      objectApiName,
      rows: rows + (linked.get(objectApiName) ?? 0),
    })),
    ...[...linked]
      .filter(([name]) => !input.plan.objects.some((o) => o.objectApiName === name))
      .map(([objectApiName, rows]) => ({ objectApiName, rows })),
  ];
  const updates = input.plan.objects
    .filter(({ objectApiName }) => updated.has(objectApiName))
    .map(({ objectApiName, rows }) => ({ objectApiName, rows }));
  const { bulk } = input;
  const files = input.files !== undefined && input.files > 0 ? input.files : 0;
  const reads = bulk
    ? WHOLE_ORG_TARGET_READS_PER_OBJECT * writes.filter(({ rows }) => rows > 0).length
    : 0;
  return {
    run:
      (bulk
        ? [...writes, ...updates].reduce(
            (calls, { objectApiName, rows }) =>
              calls + forgeWriteRequests(objectApiName, rows, bulk),
            0,
          )
        : runRequestsEstimate([...writes, ...updates])) +
      files +
      reads +
      Math.max(0, input.sentBefore ?? 0),
    ...checkpointPartOf(input.checkpoint),
    ...(input.mute !== undefined && input.mute > 0 ? { mute: input.mute } : {}),
    ...(input.readBack !== undefined && input.readBack > 0 ? { readBack: input.readBack } : {}),
    ...(input.deliverability !== undefined && input.deliverability > 0
      ? { deliverability: input.deliverability }
      : {}),
  };
}

/**
 * What a clone of the whole org measured of both orgs before its write gate,
 * beside the records of each object its counts hand the gate
 * (`ForgeWriteBoundary.objects`): what the gate holds the run to that no
 * count says.
 */
export interface WholeOrgMeasures {
  /**
   * The data storage the text of the emails it writes takes, in bytes, as the
   * source summed it page by page: an email takes the size of its text
   * (`rowStorageBytes`), and counted, it took none. Absent when it writes none.
   */
  emailTextBytes?: number;
  /**
   * The files it copies, as the source summed them: how many, and their
   * bytes. Absent when it copies none, as it does unless asked; `unmeasured`
   * when the source would neither sum them nor list them.
   */
  files?: { count: number; bytes: number } | { unmeasured: true };
  /**
   * The requests its reads of the source still send once its gate lets it
   * through. Absent, the gate counts them: a page per 2,000 rows of each
   * object it writes, a read of each file's content, and a query of their
   * links per 200 files.
   */
  sourceReads?: number;
  /**
   * The requests it sent the source before its gate to tell the rows it
   * holds back one by one — an anti-join per lookup its rows may not leave
   * empty, the rows of a record type closed to the user it writes as, and
   * the rows under those it holds back, read by id —, which its dry run
   * sends too. Priced unless the command line priced what it sent before the
   * gate (`sourceSentBefore`), which counts them. Absent, none.
   */
  heldReads?: number;
  /** The objects it writes by REST whatever their number besides those always written so: see {@link ForgeBulkWrites}. */
  restOnly?: ReadonlySet<string>;
  /**
   * The objects it reads whole — the price catalog, an object mapped by name
   * — whose rows are past the bound of such a read, with that bound: read so,
   * the run would write part of them. Absent when none is.
   */
  readWholeOver?: ReadonlyArray<{ objectApiName: string; rows: number; bound: number }>;
}

/** Files whose links to their records one query reads, as a clone of the whole org asks for them. */
const FILES_PER_LINK_QUERY = 200;

/**
 * What a clone of the whole org takes beside the target's requests, which
 * its gate counts part by part ({@link forgeRequestPartsOf}): see
 * {@link wholeOrgCostOf}.
 */
export interface WholeOrgCost {
  /** Per object it writes, its rows and the Bulk API jobs they go in, none when they go by REST; the most first. */
  objects: Array<{ objectApiName: string; rows: number; jobs: number }>;
  /**
   * The API requests its reads take of the source: those still to come, and
   * those the command line sent before the gate, when it says them.
   */
  sourceRequests: number;
  /** The Bulk API batches its jobs take of the target's day, its second pass's among them. */
  bulkBatches: number;
  /** The seconds its writes take, about, one job or call after another. */
  durationSeconds: number;
  /** The objects with rows to write that it writes by REST all the same, by name. */
  restObjects: string[];
}

/**
 * What a clone of the whole org is about to take besides the target's
 * requests, from the rows its gate counted and what it measured:
 * - of the source, the requests its reads still send ({@link WholeOrgMeasures.sourceReads}),
 *   and what it reads of the source besides its pages, per object
 *   ({@link WHOLE_ORG_SOURCE_READS_PER_OBJECT}); the counts, the describes
 *   and the measure of the emails' text were taken before the gate, and are
 *   priced as the command line counted them when it says (`sourceSentBefore`),
 *   for the price to be of the whole run; when it does not, what the gate
 *   read to tell the rows held back one by one ({@link WholeOrgMeasures.heldReads}),
 *   which its dry run reads too and a dry run priced at none;
 * - of the target's day, a Bulk API batch per {@link ROWS_PER_BULK_BATCH}
 *   records of each job its writes and its second pass send;
 * - of the time, its writes and updates one after another: a job its wait
 *   and then its records, at the pace of a job that saves them, a REST
 *   write {@link REST_SECONDS_PER_ROW} a record.
 */
export function wholeOrgCostOf(input: {
  plan: Pick<WritePlan, 'objects'>;
  /** The objects whose rows the run writes a second time. */
  updatedAfterInsert?: readonly string[];
  measures: WholeOrgMeasures;
  /** What the command line sent the source before the gate, as counted (`countRequests`). */
  sourceSentBefore?: number;
}): WholeOrgCost {
  const bulk: ForgeBulkWrites = {
    ...(input.measures.restOnly ? { restOnly: input.measures.restOnly } : {}),
  };
  const updated = new Set(input.updatedAfterInsert ?? []);
  const objects = input.plan.objects.map(({ objectApiName, rows }) => ({
    objectApiName,
    rows,
    writes: forgeWritesOf(objectApiName, rows, bulk),
    updates: updated.has(objectApiName) ? forgeWritesOf(objectApiName, rows, bulk) : undefined,
  }));
  const sent = objects.flatMap(({ writes, updates }) => (updates ? [writes, updates] : [writes]));
  const files = input.measures.files;
  const fileCount = files && 'count' in files && files.count > 0 ? files.count : 0;
  return {
    objects: objects.map(({ objectApiName, rows, writes }) => ({
      objectApiName,
      rows,
      jobs: writes.jobs.length,
    })),
    sourceRequests:
      (input.measures.sourceReads ??
        objects.reduce((sum, { rows }) => sum + Math.ceil(Math.max(0, rows) / ROWS_PER_READ), 0) +
          fileCount +
          Math.ceil(fileCount / FILES_PER_LINK_QUERY)) +
      WHOLE_ORG_SOURCE_READS_PER_OBJECT * objects.filter(({ rows }) => rows > 0).length +
      (input.sourceSentBefore === undefined
        ? Math.max(0, input.measures.heldReads ?? 0)
        : Math.max(0, input.sourceSentBefore)),
    bulkBatches: sent.reduce(
      (sum, { jobs }) =>
        sum + jobs.reduce((batches, job) => batches + Math.ceil(job / ROWS_PER_BULK_BATCH), 0),
      0,
    ),
    durationSeconds: sent.reduce(
      (sum, { jobs, rest }) =>
        sum +
        jobs.reduce((seconds, job) => seconds + bulkJobSeconds(job, 'save'), 0) +
        rest * REST_SECONDS_PER_ROW,
      0,
    ),
    restObjects: objects
      .filter(({ rows, writes }) => rows > 0 && writes.jobs.length === 0)
      .map(({ objectApiName }) => objectApiName),
  };
}

/**
 * Why the target's daily Bulk API batches are not known when its `/limits`
 * list none, as {@link API_REQUESTS_NOT_TOLD} is for its requests.
 */
export const BULK_BATCHES_NOT_TOLD = 'the limits the org answered list no DailyBulkApiBatches';

/**
 * Why a clone of the whole org cannot be written for the Bulk API batches
 * its jobs take of the target's day, or nothing when it can.
 */
export function bulkBatchesRefusal(check: ApiBudgetCheck, target: string): string | undefined {
  if (check.verdict !== 'exceeds') return undefined;
  return (
    `The run writes through Bulk API jobs that take about ${check.estimate} of the daily Bulk ` +
    `API batches, and ${target} has ${check.remaining} of its ${check.max} left: its jobs would ` +
    'be refused part way through. Run it once the org has batches to spare — the limit is ' +
    'counted over the last 24 hours, and Bulk API 1.0 shares it — or leave objects out. ' +
    'Nothing was written.'
  );
}

/**
 * Why a clone of the whole org cannot be run for the API requests its reads
 * take of the source, or nothing when it can: the source is often a
 * production org, whose integrations draw on the same daily requests.
 */
export function sourceApiBudgetRefusal(check: ApiBudgetCheck, source: string): string | undefined {
  if (check.verdict !== 'exceeds') return undefined;
  return (
    `The run reads the source records in about ${check.estimate} API requests, and ${source} ` +
    `has ${check.remaining} of its ${check.max} daily requests left: the reads would stop part ` +
    "way through, and the org's own integrations with them. Run it once the org has requests " +
    'to spare — the limit is counted over the last 24 hours — or leave objects out. Nothing ' +
    'was written.'
  );
}

/**
 * Why the files a clone of the whole org copies cannot be written for the
 * file storage they take, or nothing when they can.
 */
export function fileStorageRefusal(check: StorageCheck, target: string): string | undefined {
  if (check.verdict !== 'exceeds') return undefined;
  return (
    `The files to copy take about ${formatMB(check.estimateMB)} MB of file storage, and ` +
    `${target} has ${check.remainingMB} MB left of ${check.maxMB} MB: leave out the objects ` +
    `whose files take it, turn the copy of files off on Review, or free file storage in ` +
    `${target}. Nothing was written.`
  );
}

/**
 * Why a clone of the whole org cannot be run for the objects it reads whole
 * — the price catalog, an object mapped by name — past the most rows of one
 * object the extension lets a run hold at once, each named with its rows.
 * Read so, the run would write part of them; refused, nobody declined
 * anything.
 */
export function readBoundRefusal(
  over: ReadonlyArray<{ objectApiName: string; rows: number }>,
  bound: number,
): string {
  const named = over.map(({ objectApiName, rows }) => `${objectApiName} (${rows} rows)`).join(', ');
  return (
    `A clone of the whole org reads a few objects whole, and ${named} ` +
    `${over.length === 1 ? 'holds' : 'hold'} more than the ${bound} rows of one object the ` +
    'sandforge.forge.maxRecordsPerObject setting lets a run hold at once: raise the setting ' +
    'or leave the object out on Review. Nothing was written.'
  );
}

/**
 * A stop a check of the write gate comes to, nothing written, with what the
 * run's error carries of it ({@link ForgeRunGateError.of}).
 */
export interface ForgeGateStop {
  code: ForgeRunGateErrorCode;
  message: string;
  /** For a checkpoint first refused: the take's refusal. */
  refusal?: CheckpointRefusal;
  /** For a refusal for storage: what is taken, what is left, and which storage. */
  storage?: NonNullable<ForgeRunGateStop['storage']>;
  /** For a refusal of a clone of the whole org for an API budget: which, of which org. */
  api?: NonNullable<ForgeRunGateStop['api']>;
  /** For a refusal for objects read whole: the bound, and the objects past it. */
  readBound?: NonNullable<ForgeRunGateStop['readBound']>;
}

/** The objects a refusal for objects read whole names, at most, as the page reads it. */
const READ_BOUND_NAMED = 200;

/**
 * The stop of a clone of the whole org whose objects read whole are past the
 * bound of such a read (`READ_BOUND_EXCEEDED`), or none. Checked before the
 * target's limits are read: none is spent on a run refused for it.
 */
export function readBoundStopOf(
  over: WholeOrgMeasures['readWholeOver'],
): ForgeGateStop | undefined {
  if (!over || over.length === 0) return undefined;
  const bound = Math.min(...over.map((object) => object.bound));
  const objects = over.map(({ objectApiName, rows }) => ({ objectApiName, rows }));
  return {
    code: 'READ_BOUND_EXCEEDED',
    message: readBoundRefusal(objects, bound),
    readBound: { bound, objects: objects.slice(0, READ_BOUND_NAMED) },
  };
}

/** What the files of a clone of the whole org take against the target's file storage. */
export type WholeOrgFilesCheck = { count: number; check: StorageCheck } | { unmeasured: true };

/**
 * Why a clone of the whole org asked to copy files is refused when the source
 * would neither sum nor list them: what they take of the target's file
 * storage is not known, as the file copier of every other run refuses files
 * it could not all look up (`FILES_UNREAD`).
 */
const FILES_UNREAD = 'FILES_UNREAD';

/**
 * Why a clone of the whole org asked to copy files is refused when the target
 * would not say what file storage it has left, as the file copier of every
 * other run refuses then (`FILE_STORAGE_UNREAD`).
 */
const FILE_STORAGE_UNREAD = 'FILE_STORAGE_UNREAD';

/**
 * The files a clone of the whole org copies against the target's file
 * storage, from the `/limits` its gate read for the data storage: refused
 * past it (`STORAGE_EXCEEDED`, `storage.kind: 'files'`). None to copy, no
 * check. Files the source would neither sum nor list ({@link FILES_UNREAD}),
 * or a file storage the target would not tell ({@link FILE_STORAGE_UNREAD}),
 * refuse the run too, as the file copier of any other run refuses them:
 * copied unmeasured, a whole org's files could fill the target's storage part
 * way through, its records written and their files not.
 */
export function wholeOrgFilesOf(
  files: WholeOrgMeasures['files'],
  limits: DataStorage | { unread: string },
  target: string,
): { files?: WholeOrgFilesCheck; stop?: ForgeGateStop } {
  if (!files) return {};
  if ('unmeasured' in files) {
    return {
      files: { unmeasured: true },
      stop: {
        code: FILES_UNREAD,
        message:
          'The source would neither sum nor list its files, so what they take of the file ' +
          `storage ${target} has left is not known: turn the copy of files off on Review, or ` +
          'run it again once the source answers. Nothing was written.',
      },
    };
  }
  if (files.count <= 0) return {};
  const check = storageCheckOf(
    { storageBytes: files.bytes },
    'unread' in limits
      ? limits
      : (limits.fileStorage ?? { unread: 'the limits the org answered list no FileStorageMB' }),
  );
  if (check.verdict === 'unread') {
    return {
      files: { count: files.count, check },
      stop: {
        code: FILE_STORAGE_UNREAD,
        message:
          `The file storage ${target} has left could not be read (${check.unread}), so the ` +
          `${files.count} files to copy could not be checked against it: turn the copy of ` +
          'files off on Review, or run it again once the org answers. Nothing was written.',
      },
    };
  }
  const refused = fileStorageRefusal(check, target);
  return {
    files: { count: files.count, check },
    ...(refused !== undefined && check.verdict === 'exceeds'
      ? {
          stop: {
            code: 'STORAGE_EXCEEDED',
            message: refused,
            storage: {
              estimateMB: Number(formatMB(check.estimateMB)),
              remainingMB: check.remainingMB,
              kind: 'files',
            },
          },
        }
      : {}),
  };
}

/**
 * What Forge's write gate holds a run's rows to beside their storage and
 * their emails: the target's daily API requests, part by part, and the
 * checkpoint the run takes first; for a clone of the whole org, the source's
 * daily API requests and the target's Bulk API batches besides.
 */
export interface ForgeWriteBudget {
  /** The requests against what the target has left today, every part together. */
  api: ApiBudgetCheck;
  /**
   * Why the run is refused, nothing written: its checkpoint first refused at
   * the gate, or its requests past what the target has left, the refusal
   * naming each part beside the run's own; for a clone of the whole org, its
   * jobs past the target's Bulk API batches, or its reads past the source's
   * requests, the stop's `api` saying which. Absent when none refuses it.
   */
  stop?: ForgeGateStop & { code: typeof API_BUDGET_EXCEEDED | typeof CHECKPOINT_REFUSED };
  /**
   * The refusals past the first, in the order the gate meets them: what a
   * dry run names besides. Absent when there is none.
   */
  alsoRefused?: Array<ForgeGateStop & { code: typeof API_BUDGET_EXCEEDED }>;
  /**
   * Of a clone of the whole org: the source's requests and the target's Bulk
   * API batches against what each has left today — none when it sends no
   * job — and what else it takes. Absent for any other run.
   */
  wholeOrg?: { source: ApiBudgetCheck; bulkBatches?: ApiBudgetCheck; cost: WholeOrgCost };
  /**
   * Whether the gate asks for them, whatever the volume: a checkpoint taken
   * first reads whole tables of the target, not the run's rows, and its cost
   * is said before anything is taken; a clone of the whole org is always
   * asked.
   */
  asks: boolean;
  /** What the run's question says of them: the requests when they run short, and the checkpoint. */
  confirmation: Pick<WriteConfirmation, 'apiRequests' | 'checkpoint'>;
}

/** What a clone of the whole org brings its write gate beside a run's: see {@link forgeWriteBudgetOf}. */
export interface WholeOrgBudgetInput {
  measures: WholeOrgMeasures;
  /** The target's daily Bulk API batches, read with its storage, or why they could not be. */
  bulkBatches: ApiBudget | { unread: string } | undefined;
  /** The source's daily API requests, or why they could not be read. */
  sourceBudget: ApiBudget | { unread: string } | undefined;
  /** The source, as a refusal names it. */
  source: string;
  /** What the command line sent the source before the gate, as counted (`countRequests`). */
  sourceSentBefore?: number;
}

/** What Forge's write gate prices a run's requests from: see {@link forgeWriteBudgetOf}. */
export interface ForgeWriteBudgetInput {
  plan: Pick<WritePlan, 'objects' | 'leftOut'>;
  updatedAfterInsert?: readonly string[];
  readBack?: number;
  checkpoint?: RunCheckpointEstimate;
  mute?: number;
  deliverability?: number;
  /** What the command line sent the target before the gate, as counted: see {@link forgeRequestPartsOf}. */
  sentBefore?: number;
  budget: ApiBudget | { unread: string } | undefined;
  target: string;
  wholeOrg?: WholeOrgBudgetInput;
}

/**
 * Forge's write gate on the API requests its rows take of the target and on
 * the checkpoint it takes first: refused for the checkpoint's own refusal
 * first, then past the requests the target has left, judged on the sum of
 * the parts ({@link forgeRequestPartsOf}); asked whenever a checkpoint is
 * taken first; the question told the requests when they run short, and the
 * checkpoint. Forge's gate held no budget: a clone into an org whose
 * integrations had spent the day's requests stopped part way through, as
 * Sync, Seed and Autopilot no longer do.
 *
 * A clone of the whole org (`wholeOrg`) is held to the same parts, its
 * writes priced as the Bulk API sends them and its files among them, not to
 * a check of its own: then, past the target's requests, to the Bulk API
 * batches its jobs take of the target's day, and to the requests its reads
 * take of the source's, each refusal naming the allowance and the org
 * (`api`). It is always asked.
 *
 * @param input.budget - The daily API requests the target has, read with its
 *   storage (`DataStorage.dailyApiRequests`), or on their own when the
 *   storage could not be read (`readApiBudget`), or why they could not be.
 * @param input.target - The org, as the refusal names it.
 * @param input.wholeOrg - Of a clone of the whole org: what it measured, the
 *   target's daily Bulk API batches read with its storage
 *   (`DataStorage.dailyBulkApiBatches`), the source's daily API requests
 *   (`readApiBudget`), or why either could not be read, and the source as
 *   the refusal names it.
 */
export function forgeWriteBudgetOf(
  input: ForgeWriteBudgetInput & { wholeOrg: WholeOrgBudgetInput },
): ForgeWriteBudget & Required<Pick<ForgeWriteBudget, 'wholeOrg'>>;
export function forgeWriteBudgetOf(input: ForgeWriteBudgetInput): ForgeWriteBudget;
export function forgeWriteBudgetOf(input: ForgeWriteBudgetInput): ForgeWriteBudget {
  const whole = input.wholeOrg;
  const files = whole?.measures.files;
  const api = apiBudgetCheckOf(
    forgeRequestPartsOf({
      ...input,
      ...(whole
        ? {
            bulk: whole.measures.restOnly ? { restOnly: whole.measures.restOnly } : {},
            ...(files && 'count' in files ? { files: files.count } : {}),
          }
        : {}),
    }),
    input.budget,
  );
  const overBudget = apiBudgetRefusal(api, input.target);
  const stops: NonNullable<ForgeWriteBudget['stop']>[] = [];
  const checkpointStop = checkpointScopeStop(input.checkpoint);
  if (checkpointStop) stops.push(checkpointStop);
  if (overBudget !== undefined) {
    stops.push({
      code: API_BUDGET_EXCEEDED,
      message: overBudget,
      ...(whole && api.verdict === 'exceeds'
        ? {
            api: {
              kind: 'requests',
              org: 'target',
              estimate: api.estimate,
              remaining: api.remaining,
            },
          }
        : {}),
    });
  }
  let wholeOrg: ForgeWriteBudget['wholeOrg'];
  if (whole) {
    const cost = wholeOrgCostOf({
      ...input,
      measures: whole.measures,
      ...(whole.sourceSentBefore !== undefined ? { sourceSentBefore: whole.sourceSentBefore } : {}),
    });
    const batches =
      cost.bulkBatches > 0
        ? apiBudgetCheckOf(cost.bulkBatches, whole.bulkBatches ?? { unread: BULK_BATCHES_NOT_TOLD })
        : undefined;
    const overBatches = batches && bulkBatchesRefusal(batches, input.target);
    if (overBatches !== undefined && batches?.verdict === 'exceeds') {
      stops.push({
        code: API_BUDGET_EXCEEDED,
        message: overBatches,
        api: {
          kind: 'bulkBatches',
          org: 'target',
          estimate: batches.estimate,
          remaining: batches.remaining,
        },
      });
    }
    const source = apiBudgetCheckOf(cost.sourceRequests, whole.sourceBudget);
    const overSource = sourceApiBudgetRefusal(source, whole.source);
    if (overSource !== undefined && source.verdict === 'exceeds') {
      stops.push({
        code: API_BUDGET_EXCEEDED,
        message: overSource,
        api: {
          kind: 'requests',
          org: 'source',
          estimate: source.estimate,
          remaining: source.remaining,
        },
      });
    }
    wholeOrg = { source, ...(batches ? { bulkBatches: batches } : {}), cost };
  }
  const [stop, ...also] = stops;
  const alsoRefused = also.filter(
    (refused): refused is ForgeGateStop & { code: typeof API_BUDGET_EXCEEDED } =>
      refused.code === API_BUDGET_EXCEEDED,
  );
  return {
    api,
    ...(stop ? { stop } : {}),
    ...(whole && alsoRefused.length > 0 ? { alsoRefused } : {}),
    ...(wholeOrg ? { wholeOrg } : {}),
    asks: input.checkpoint !== undefined || whole !== undefined,
    confirmation: {
      ...confirmationApiOf(api),
      ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
    },
  };
}

/** What the rows take against what the target has left, or why that could not be told. */
export type StorageCheck =
  | {
      verdict: 'fits' | 'near' | 'exceeds';
      estimateMB: number;
      maxMB: number;
      remainingMB: number;
    }
  | { verdict: 'unread'; estimateMB: number; unread: string };

/**
 * The rows' storage against the target's: `exceeds` past what it has left,
 * `near` past {@link STORAGE_NEAR_SHARE} of it, `unread` when the target did
 * not say.
 */
export function storageCheckOf(
  plan: Pick<WritePlan, 'storageBytes'>,
  storage: DataStorage | { unread: string },
): StorageCheck {
  const estimateMB = plan.storageBytes / BYTES_PER_MB;
  if ('unread' in storage) return { verdict: 'unread', estimateMB, unread: storage.unread };
  const { maxMB, remainingMB } = storage;
  const verdict =
    plan.storageBytes > remainingMB * BYTES_PER_MB
      ? 'exceeds'
      : plan.storageBytes > STORAGE_NEAR_SHARE * remainingMB * BYTES_PER_MB
        ? 'near'
        : 'fits';
  return { verdict, estimateMB, maxMB, remainingMB };
}

/**
 * The write plan of a clone of the whole org: its counts ({@link writePlanOf}),
 * the emails at the size of their text, which the source summed page by page
 * (`WholeOrgMeasures.emailTextBytes`). An email takes the size of its text
 * (`rowStorageBytes`), and counted, without one, it took none.
 */
export function wholeOrgWritePlanOf(
  objects: ForgeWriteBoundary['objects'],
  measures: Pick<WholeOrgMeasures, 'emailTextBytes'>,
): WritePlan {
  const plan = writePlanOf(objects);
  const text = measures.emailTextBytes;
  const counted = objects.some(
    (object) => sizedName(object.objectApiName) === EMAIL_MESSAGE && object.counted,
  );
  if (text === undefined || !Number.isFinite(text) || !counted) return plan;
  const measured = plan.objects.map((object) =>
    sizedName(object.objectApiName) === EMAIL_MESSAGE
      ? { ...object, storageBytes: object.storageBytes + Math.max(0, text) }
      : object,
  );
  return {
    ...plan,
    objects: measured,
    storageBytes: measured.reduce((sum, object) => sum + object.storageBytes, 0),
  };
}

/**
 * The personal fields a run copies as they are, per object it writes: those
 * discovery named personal (`piiFields`) that the run does not anonymize —
 * every one with Anonymize off, those not selected on their node with it on
 * (`anonymizeFields`), as `ForgeComplianceService` reads the run. An object
 * with none is left out.
 *
 * @param written - The objects the run writes rows of.
 */
export function personalFieldsAsIsOf(
  nodes: ReadonlyArray<
    Pick<
      ForgeGraph['nodes'][number],
      'objectApiName' | 'included' | 'piiFields' | 'anonymizeFields'
    >
  >,
  written: ReadonlySet<string>,
  anonymizePII: boolean,
): Array<{ objectApiName: string; fields: string[] }> {
  return nodes.flatMap(({ objectApiName, included, piiFields, anonymizeFields }) => {
    if (!included || !written.has(objectApiName)) return [];
    const anonymized = new Set(anonymizePII ? anonymizeFields : []);
    const fields = piiFields.filter((field) => !anonymized.has(field));
    return fields.length > 0 ? [{ objectApiName, fields }] : [];
  });
}

/** What the dry run of a clone of the whole org reads of its graph: its nodes' fields and who left them out, and what discovery left out. */
export interface WholeOrgGraph {
  nodes: ReadonlyArray<
    Pick<
      ForgeGraph['nodes'][number],
      'objectApiName' | 'included' | 'piiFields' | 'anonymizeFields' | 'leftOutByUser'
    >
  >;
  leftOut?: ForgeGraph['leftOut'];
}

/**
 * What a clone of the whole org leaves of the source, object by object with
 * why: the objects discovery left out (`ForgeGraph.leftOut`), and the nodes
 * the user took out on the page (`excludedByUser`); and how many for each
 * reason, the most first.
 */
export function wholeOrgLeftOutOf(graph: WholeOrgGraph): {
  objects: ForgeLeftOutObject[];
  counts: ForgeLeftOutCount[];
} {
  const listed = graph.leftOut ?? [];
  const named = new Set(listed.map(({ objectApiName }) => objectApiName));
  const objects: ForgeLeftOutObject[] = [
    ...listed,
    ...graph.nodes
      .filter((node) => node.leftOutByUser === true && !named.has(node.objectApiName))
      .map(({ objectApiName }): ForgeLeftOutObject => ({
        objectApiName,
        reason: 'excludedByUser',
      })),
  ];
  const counts = new Map<ForgeLeftOutObject['reason'], number>();
  for (const { reason } of objects) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return {
    objects,
    counts: [...counts]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
  };
}

/**
 * What the dry run of a clone of the whole org says, stopped at its write
 * gate once the source is counted: see {@link wholeOrgDryRunOf}.
 */
export interface WholeOrgDryRun {
  /** Per object, the records the run would insert, the most first, and how many go in Bulk API jobs or by REST. */
  wouldInsert: Array<{ objectApiName: string; rows: number; jobs: number; byRest: number }>;
  /** The records in all. */
  totalRows: number;
  /** The target's API requests, every part together, against what it has left today. */
  targetRequests: ApiBudgetCheck;
  /** The requests its reads would still take of the source, against what the source has left today. */
  sourceRequests: ApiBudgetCheck;
  /** The target's daily Bulk API batches its jobs would take; absent when it would send none. */
  bulkBatches?: ApiBudgetCheck;
  /** The data storage its records would take, emails by their text, against what the target has left. */
  storage: StorageCheck;
  /** The files it would copy against the target's file storage; absent when it copies none. */
  files?: WholeOrgFilesCheck;
  /** The seconds its writes would take, about. */
  durationSeconds: number;
  /**
   * What it leaves out: the objects of the source, each with why, how many
   * for each reason, and of the objects it writes, the rows it would not
   * write (`WritePlan.leftOut`).
   */
  leftOut: {
    objects: ForgeLeftOutObject[];
    counts: ForgeLeftOutCount[];
    rows?: WritePlanLeftOut;
  };
  /** Per object it writes, the personal fields it would copy as they are. */
  personalAsIs: Array<{ objectApiName: string; fields: string[] }>;
  /** Every refusal the run would meet, in the order it meets them; none when it would go through. */
  wouldBeRefused: ForgeGateStop[];
}

/**
 * The most requests a read of whether the target delivers its emails sends
 * (`readEmailDeliverability`): the line of Apex, and the user's Send Email
 * when the org refused it.
 */
export const DELIVERABILITY_READ_MOST = 2;

/**
 * The dry run of a clone of the whole org: stopped at the write gate once
 * the source is counted, it says what the run would write of each object,
 * what it would take of both orgs, what it leaves out and why, the personal
 * fields it copies as they are, and every refusal the run would meet. It
 * reads no row and keeps no journal: what it reads of the orgs is the
 * target's `/limits` — its storage, requests, Bulk API batches and file
 * storage in one answer, the requests alone when that one is refused — and
 * the source's, for its requests. It writes nothing to either.
 *
 * The refusals come in the order the run meets them: the objects it reads
 * whole past their bound, the data storage, the file storage, then the
 * checkpoint first, the target's requests, its Bulk API batches and the
 * source's requests ({@link forgeWriteBudgetOf}).
 *
 * The target's requests are priced as its run's gate prices them, part by
 * part: the read-backs of the record types the target gives the records
 * created without one, which its counts say as a run's do, the lease of the
 * mute when it is asked, and the read of whether the target delivers its
 * emails — what that read sent, when the dry run read it, and otherwise the
 * most it sends ({@link DELIVERABILITY_READ_MOST}), as a run that finds
 * something left to send an email reads it. Priced without either, the dry
 * run said fewer requests than its run's gate then held the run to.
 *
 * @param input.objects - What the run's counts hand its gate, as a run's
 *   (`ForgeWriteBoundary.objects`).
 * @param input.updatedAfterInsert - The objects whose rows its second pass
 *   updates.
 * @param input.checkpoint - The checkpoint first's scope, when it is asked.
 * @param input.readBack - The reads of the record types the target gave,
 *   as the run's counts say them (`ForgeWriteBoundary.readBack`).
 * @param input.mute - What the lease of the mute a run asked to mute holds
 *   sends (`muteLeaseRequests`).
 * @param input.deliverability - What the read of whether the target
 *   delivers its emails sent, when the dry run read it; 0 when nothing that
 *   still runs sends one.
 * @param input.sentBefore - What the command line has sent each org, as
 *   counted, the read of the deliverability apart: read once the dry run has
 *   read the limits, and priced as sent.
 */
export async function wholeOrgDryRunOf(input: {
  objects: ForgeWriteBoundary['objects'];
  measures: WholeOrgMeasures;
  graph: WholeOrgGraph;
  anonymizePII: boolean;
  updatedAfterInsert?: readonly string[];
  checkpoint?: RunCheckpointEstimate;
  readBack?: number;
  mute?: number;
  deliverability?: number;
  sentBefore?: () => { target: number; source: number };
  target: { org: string; limits: LimitsTransport };
  source: { org: string; limits: LimitsTransport };
}): Promise<WholeOrgDryRun> {
  const unread = (err: unknown): { unread: string } => ({ unread: extractErrorMessage(err) });
  const plan = wholeOrgWritePlanOf(input.objects, input.measures);
  const limits = await readDataStorage(input.target.limits).catch(unread);
  const budget =
    'unread' in limits
      ? await readApiBudget(input.target.limits).catch(unread)
      : limits.dailyApiRequests;
  const sourceBudget = await readApiBudget(input.source.limits).catch(unread);

  const storage = storageCheckOf(plan, limits);
  const overStorage = storageRefusal(storage, input.target.org);
  const files = wholeOrgFilesOf(input.measures.files, limits, input.target.org);
  const sent = input.sentBefore?.();
  const requests = forgeWriteBudgetOf({
    plan,
    ...(input.updatedAfterInsert ? { updatedAfterInsert: input.updatedAfterInsert } : {}),
    ...(input.readBack !== undefined ? { readBack: input.readBack } : {}),
    ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
    ...(input.mute !== undefined ? { mute: input.mute } : {}),
    deliverability: input.deliverability ?? DELIVERABILITY_READ_MOST,
    ...(sent ? { sentBefore: sent.target } : {}),
    budget,
    target: input.target.org,
    wholeOrg: {
      measures: input.measures,
      bulkBatches: 'unread' in limits ? limits : limits.dailyBulkApiBatches,
      sourceBudget,
      source: input.source.org,
      ...(sent ? { sourceSentBefore: sent.source } : {}),
    },
  });
  const wouldBeRefused = [
    readBoundStopOf(input.measures.readWholeOver),
    overStorage !== undefined && storage.verdict === 'exceeds'
      ? {
          code: 'STORAGE_EXCEEDED' as const,
          message: `${overStorage} Nothing was written.`,
          storage: {
            estimateMB: Number(formatMB(storage.estimateMB)),
            remainingMB: storage.remainingMB,
          },
        }
      : undefined,
    files.stop,
    requests.stop,
    ...(requests.alsoRefused ?? []),
  ].filter((stop): stop is ForgeGateStop => stop !== undefined);

  const bulk: ForgeBulkWrites = input.measures.restOnly
    ? { restOnly: input.measures.restOnly }
    : {};
  const written = new Set(plan.objects.map(({ objectApiName }) => objectApiName));
  const { wholeOrg } = requests;
  return {
    wouldInsert: plan.objects.map(({ objectApiName, rows }) => {
      const { jobs, rest } = forgeWritesOf(objectApiName, rows, bulk);
      return { objectApiName, rows, jobs: jobs.length, byRest: rest };
    }),
    totalRows: plan.totalRows,
    targetRequests: requests.api,
    sourceRequests: wholeOrg.source,
    ...(wholeOrg.bulkBatches ? { bulkBatches: wholeOrg.bulkBatches } : {}),
    storage,
    ...(files.files ? { files: files.files } : {}),
    durationSeconds: wholeOrg.cost.durationSeconds,
    leftOut: {
      ...wholeOrgLeftOutOf(input.graph),
      ...(plan.leftOut ? { rows: plan.leftOut } : {}),
    },
    personalAsIs: personalFieldsAsIsOf(input.graph.nodes, written, input.anonymizePII),
    wouldBeRefused,
  };
}

/** What an org has of a daily email limit, as its `/limits` say. */
export interface EmailLimit {
  max: number;
  remaining: number;
}

/** What `/limits` says of an org's daily email limits; either may be missing. */
const emailLimitsSchema = z
  .object({
    SingleEmail: z.object({ Max: z.number(), Remaining: z.number() }).loose().optional(),
    DailyWorkflowEmails: z.object({ Max: z.number(), Remaining: z.number() }).loose().optional(),
  })
  .loose();

/**
 * The daily email limits an org has left, as its `/limits` say. A limit the
 * org does not list is left out, and the org may refuse the read to the user
 * the run writes as: the caller says so, and never takes it for enough.
 */
export async function readEmailLimits(
  transport: LimitsTransport,
): Promise<Partial<Record<ForgeEmailLimit, EmailLimit>>> {
  const limits = emailLimitsSchema.parse(
    await transport.request({ method: 'GET', url: '/limits' }),
  );
  const out: Partial<Record<ForgeEmailLimit, EmailLimit>> = {};
  for (const name of ['SingleEmail', 'DailyWorkflowEmails'] as const) {
    const limit = limits[name];
    if (limit) out[name] = { max: limit.Max, remaining: limit.Remaining };
  }
  return out;
}

/** The single emails a day of a Developer Edition. */
export const DEVELOPER_EDITION_SINGLE_EMAILS = 15;

/**
 * Whether the email alerts of an org count against its single emails too: an
 * org held to the fifteen single emails a day of a Developer Edition.
 *
 * Twice the trap Developer Edition counted the email alert of its contact
 * workflow rule against its single emails, its contact flow quiet for the
 * user who wrote: on 2026-10-14, 36 contacts cloned took them from −75 to
 * −117 while its workflow emails did not move; on 2026-10-20, 75 contacts
 * seeded took them from 15 to −60. Counted as workflow emails alone, 8,040 a
 * day there, the 75 contacts fitted.
 */
export function alertsCountAsSingle(limits: Partial<Record<ForgeEmailLimit, EmailLimit>>): boolean {
  const single = limits.SingleEmail;
  return single !== undefined && single.max <= DEVELOPER_EDITION_SINGLE_EMAILS;
}

/**
 * Whether the single emails the flows of an org send count against its
 * workflow emails too: a Developer Edition's do ({@link alertsCountAsSingle}),
 * where its limits list its workflow emails.
 *
 * Measured on the trap Developer Edition on 2026-11-02, a contact at a time,
 * its quotas read from `/limits`: the workflow rule's alert alone took one
 * single email and one workflow email, the flow's two Send Email actions
 * alone two of each. Counted against the single emails alone, a contact was
 * said to take one workflow email, the rule's alert, and took three. No org
 * of another edition was measured, and one is counted as Salesforce says: an
 * alert against the workflow emails, a Send Email against the single emails.
 * A Developer Edition's fifteen single emails run out long before its
 * thousands of workflow emails, which every email there counts against: one
 * whose limits do not list them is not asked about them.
 */
export function singleCountAsWorkflow(
  limits: Partial<Record<ForgeEmailLimit, EmailLimit>>,
): boolean {
  return alertsCountAsSingle(limits) && limits.DailyWorkflowEmails !== undefined;
}

/**
 * The emails each record of an object makes the org send, per daily limit,
 * as the org counts them: the email alerts counted against the single emails
 * as well where the org counts them there, and the single emails a flow sends
 * against the workflow emails as well where it counts them there.
 *
 * @param alertsAsSingle - Whether the org counts its email alerts against its
 *   single emails ({@link alertsCountAsSingle}).
 * @param singleAsWorkflow - Whether it counts its single emails against its
 *   workflow emails ({@link singleCountAsWorkflow}).
 */
export function emailsCountedPerRecord(
  perInsert: readonly ForgeEmailsPerInsert[],
  alertsAsSingle: boolean,
  singleAsWorkflow = false,
): ForgeEmailsPerInsert[] {
  const out = perInsert.map((sending) => ({ ...sending, sentBy: [...sending.sentBy] }));
  /** Count what `from` sends against `limit` too, from what the records were given. */
  const countAlso = (from: ForgeEmailsPerInsert, limit: ForgeEmailLimit): ForgeEmailsPerInsert => {
    const into = out.find(
      (sending) => sending.objectApiName === from.objectApiName && sending.limit === limit,
    );
    if (!into) {
      const added = { ...from, limit, sentBy: [...from.sentBy] };
      out.push(added);
      return added;
    }
    into.perRecord += from.perRecord;
    for (const name of from.sentBy) if (!into.sentBy.includes(name)) into.sentBy.push(name);
    return into;
  };
  const single = perInsert.filter((sending) => sending.limit === 'SingleEmail');
  const alerts = perInsert.filter((sending) => sending.limit === 'DailyWorkflowEmails');
  if (singleAsWorkflow) for (const sending of single) countAlso(sending, 'DailyWorkflowEmails');
  if (alertsAsSingle) {
    for (const alert of alerts) countAlso(alert, 'SingleEmail').alertsAmong = true;
  }
  return out;
}

/** The emails a run's inserts make the target send against one daily limit, and what is left of it. */
export interface EmailCheck {
  limit: ForgeEmailLimit;
  /**
   * The emails, per object: the records inserted and the emails each sends,
   * and of those records the ones the platform writes itself
   * (`byThePlatform`), which the run never sends and whose flows run as any.
   */
  objects: Array<{
    objectApiName: string;
    rows: number;
    perRecord: number;
    sentBy: string[];
    byThePlatform?: number;
  }>;
  emails: number;
  /**
   * Set on the single emails of an org that counts its email alerts against
   * them too, as a Developer Edition does ({@link alertsCountAsSingle}), when
   * the records fire alerts: they are among `emails`.
   */
  alertsCounted?: true;
  /**
   * `exceeds` past what the target has left today: the actions past it fail,
   * and a flow that fails in the save refuses its record. `unread` when the
   * target did not say.
   */
  verdict: 'fits' | 'exceeds' | 'unread';
  remaining?: number;
  max?: number;
  unread?: string;
}

/**
 * What a run's emails are counted of: the records it writes, per object, and
 * the rows the platform writes itself with them (`leftOut.byThePlatform`) —
 * the owner's member and split of an opportunity, a person account's contact
 * — which the run never sends and the target inserts all the same.
 */
type PlanOfInserts = Pick<WritePlan, 'objects'> & {
  leftOut?: Pick<WritePlanLeftOut, 'byThePlatform'>;
};

/**
 * Per object, the records a plan inserts — those the platform writes with them
 * among them — and how many of them the platform writes. Left out of the
 * plan's records, the owner's member of an opportunity sent the emails of its
 * flows uncounted: the platform's insert starts them as the run's would.
 */
function insertedOf(plan: PlanOfInserts): Map<string, { rows: number; byThePlatform: number }> {
  const inserted = new Map(
    plan.objects.map((object) => [object.objectApiName, { rows: object.rows, byThePlatform: 0 }]),
  );
  for (const { objectApiName, rows } of plan.leftOut?.byThePlatform ?? []) {
    const entry = inserted.get(objectApiName) ?? { rows: 0, byThePlatform: 0 };
    inserted.set(objectApiName, {
      rows: entry.rows + rows,
      byThePlatform: entry.byThePlatform + rows,
    });
  }
  return inserted;
}

/** The objects a plan inserts records of, those the platform writes included. */
function objectsInsertedOf(plan: PlanOfInserts): Set<string> {
  return new Set(
    [...insertedOf(plan)].flatMap(([objectApiName, { rows }]) => (rows > 0 ? [objectApiName] : [])),
  );
}

/**
 * The emails the rows about to be written make the target send, per daily
 * limit, against what it has left. Only limits the inserts send emails
 * against are checked; none, and there is nothing to read. The rows the
 * platform writes itself with a record the run creates are inserted too, and
 * counted with them ({@link insertedOf}).
 *
 * Run for real into a Developer Edition, a contact flow's Send Email took
 * the org past its fifteen single emails a day, and thirty contacts were
 * refused, `CANNOT_EXECUTE_FLOW_TRIGGER` "Probably Limit Exceeded": emails
 * neutralized under `.invalid` count all the same.
 */
export function emailChecksOf(
  plan: PlanOfInserts,
  perInsert: readonly ForgeEmailsPerInsert[],
  limits: Partial<Record<ForgeEmailLimit, EmailLimit>> | { unread: string },
): EmailCheck[] {
  const rows = insertedOf(plan);
  const byLimit = new Map<ForgeEmailLimit, EmailCheck>();
  for (const sending of perInsert) {
    const { rows: inserted, byThePlatform } = rows.get(sending.objectApiName) ?? {
      rows: 0,
      byThePlatform: 0,
    };
    if (inserted === 0) continue;
    const check = byLimit.get(sending.limit) ?? {
      limit: sending.limit,
      objects: [],
      emails: 0,
      verdict: 'fits' as const,
    };
    check.objects.push({
      objectApiName: sending.objectApiName,
      rows: inserted,
      perRecord: sending.perRecord,
      sentBy: sending.sentBy,
      ...(byThePlatform > 0 ? { byThePlatform } : {}),
    });
    check.emails += inserted * sending.perRecord;
    byLimit.set(sending.limit, check);
  }
  const unread = isUnread(limits) ? limits.unread : undefined;
  return [...byLimit.values()].map((check): EmailCheck => {
    if (unread !== undefined || isUnread(limits)) {
      return { ...check, verdict: 'unread', unread };
    }
    const limit = limits[check.limit];
    if (!limit) {
      return { ...check, verdict: 'unread', unread: `the org's limits list no ${check.limit}` };
    }
    return {
      ...check,
      verdict: check.emails > limit.remaining ? 'exceeds' : 'fits',
      remaining: limit.remaining,
      max: limit.max,
    };
  });
}

/** Whether the limits could not be read. */
function isUnread(limits: object): limits is { unread: string } {
  return typeof (limits as { unread?: unknown }).unread === 'string';
}

/**
 * The emails the rows about to be written make the target send, per daily
 * limit, as the target counts them ({@link emailChecksOf}): where it counts
 * its email alerts against its single emails too, as a Developer Edition
 * does, the alerts of each record are among its single emails
 * ({@link emailsCountedPerRecord}), and the check says so.
 *
 * Forge's and Autopilot's gates counted an alert against the workflow emails
 * alone. On 2026-10-14 a clone of 36 contacts into the trap Developer Edition
 * said "36 workflow emails; 8019 of 8040 left" while its single emails stood
 * at −75 of 15, and the clone took them to −117.
 */
export function countedEmailChecksOf(
  plan: PlanOfInserts,
  perInsert: readonly ForgeEmailsPerInsert[],
  limits: Partial<Record<ForgeEmailLimit, EmailLimit>> | { unread: string },
): EmailCheck[] {
  const alertsAsSingle = !isUnread(limits) && alertsCountAsSingle(limits);
  const singleAsWorkflow = !isUnread(limits) && singleCountAsWorkflow(limits);
  const checks = emailChecksOf(
    plan,
    emailsCountedPerRecord(perInsert, alertsAsSingle, singleAsWorkflow),
    limits,
  );
  if (!alertsAsSingle) return checks;
  const written = objectsInsertedOf(plan);
  const alerting = perInsert.some(
    (sending) => sending.limit === 'DailyWorkflowEmails' && written.has(sending.objectApiName),
  );
  return alerting
    ? checks.map((check) =>
        check.limit === 'SingleEmail' ? { ...check, alertsCounted: true as const } : check,
      )
    : checks;
}

/** The emails a run's records make the target send, per daily limit, or why they could not be said. */
export interface TargetEmails {
  /** One per daily limit the target's automation sends against as the records go in. */
  checks: EmailCheck[];
  /**
   * Why the target's automation, or the flows, processes or workflow rules of
   * it that send emails, could not be read: their emails were not counted.
   * Absent when they were.
   */
  unread?: string;
}

/**
 * The emails the target's automation sends as a run inserts the records of a
 * plan counted before it reads them, against the daily limits the target has
 * left ({@link countedEmailChecksOf}): what runs on the objects it writes,
 * read as Forge reads it, and the limits only when something sends. Autopilot
 * and Sync count their emails so.
 *
 * @param input.readAutomation - What the target runs on the given objects.
 * @param input.readLimits - The target's daily email limits, as `/limits` say them.
 */
export async function countedTargetEmails(input: {
  plan: WritePlan;
  objects: readonly string[];
  readAutomation: (objects: readonly string[]) => Promise<ForgeTargetAutomation>;
  readLimits: () => Promise<Partial<Record<ForgeEmailLimit, EmailLimit>>>;
}): Promise<TargetEmails> {
  if (input.plan.totalRows === 0 || input.objects.length === 0) return { checks: [] };
  let automation: ForgeTargetAutomation;
  try {
    automation = await input.readAutomation(input.objects);
  } catch (err: unknown) {
    return { checks: [], unread: `the target's automation: ${extractErrorMessage(err)}` };
  }
  // What sends emails and could not be read is counted as nothing: the run
  // is told it was not counted, and asks. A refused read of the flows left
  // their emails out of the count with no word, and the gate let through a
  // run that took a Developer Edition past its fifteen emails a day. So did
  // a flow, a process or a rule whose own definition was not read.
  const hidden = emailsUncountedOf(automation, insertsOf(input.plan));
  const uncounted = hidden !== undefined ? { unread: hidden } : {};
  const sending = emailsPerInsertOf(automation);
  if (sending.length === 0) return { checks: [], ...uncounted };
  const limits = await input
    .readLimits()
    .catch((err: unknown) => ({ unread: extractErrorMessage(err) }));
  // Counted as the target counts them: a Developer Edition's email alerts
  // against its single emails too, as Seed counts them.
  return { checks: countedEmailChecksOf(input.plan, sending, limits), ...uncounted };
}

/**
 * The writes whose emails a run counts as it inserts the records of a plan:
 * the insert of each object it holds records of, those the platform writes
 * with them included, as `emailsPerInsertOf` counts them.
 */
export function insertsOf(
  plan: PlanOfInserts,
): (objectApiName: string, write: ForgeAutomationWrite) => boolean {
  const inserted = objectsInsertedOf(plan);
  return (objectApiName, write) => write === 'insert' && inserted.has(objectApiName);
}

/**
 * Why the emails of the flows, processes and workflow rules that fire on the
 * writes `writes` keeps were not counted: what an org sends as its records
 * are written is counted from the definitions the read took, and what it
 * could not take counts as sending nothing. Named so: first the parts of the
 * automation that send emails the read could not take, each with the org's
 * answer, then, per object, those whose own definition was refused, or left
 * unread past the read's bound. Undefined when every one that fires was
 * read. Sync, Autopilot and a Forge run say it in their question before the
 * write.
 *
 * @param writes - Whether the records of an object are written so: a run's
 *   inserts of the objects its plan holds records of ({@link insertsOf}). An
 *   undelete starts no flow, process or rule.
 * @param whose - Whose automation the reason names: the target's unless told.
 */
export function emailsUncountedOf(
  automation: Pick<ForgeTargetAutomation, 'objects' | 'unread'>,
  writes: (objectApiName: string, write: ForgeAutomationWrite) => boolean,
  whose = "the target's",
): string | undefined {
  const said = [emailSendersUnread(automation.unread, whose), sendersNotReadOf(automation, writes)]
    .filter((reason): reason is string => reason !== undefined)
    .join('; ');
  return said !== '' ? said : undefined;
}

/** How the parts of an org's automation that send emails are named when unread, after whose they are. */
const EMAIL_SENDERS_WORDS: Readonly<
  Partial<Record<ForgeTargetAutomation['unread'][number]['part'], string>>
> = {
  flows: 'flows',
  processes: 'processes',
  workflowRules: 'workflow rules',
};

/**
 * Why the emails of an org's flows, processes or workflow rules were not
 * counted: the parts of its automation that send them the read could not
 * take, each with the org's answer. Undefined when it took them all.
 */
function emailSendersUnread(
  unread: ForgeTargetAutomation['unread'],
  whose: string,
): string | undefined {
  const said = unread.flatMap(({ part, reason }) => {
    const words = EMAIL_SENDERS_WORDS[part];
    return words !== undefined ? [`${whose} ${words}: ${reason}`] : [];
  });
  return said.length > 0 ? said.join('; ') : undefined;
}

/** The flows, processes and rules of an object a reason names before it says how many more there are. */
const SENDERS_NAMED = 10;

/**
 * The package that installed a flow or a process the read could not take, by
 * its namespace: what its API name holds before two underscores, which a
 * flow's own name never does. Probed on a Developer Edition, a flow a package
 * runs after the save of its object came in `FlowDefinitionView` under its
 * namespace, its active version named `<its name>-1`, in no form an id
 * takes, and the Tooling API's `Flow` listed no flow a package installed: no
 * user reads its definition, and what it sends is never counted. Undefined
 * for any other.
 */
function packageOf(flow: ForgeTargetFlow): string | undefined {
  if (flow.condition !== 'unreadable') return undefined;
  const at = flow.apiName.indexOf('__');
  return at > 0 ? flow.apiName.slice(0, at) : undefined;
}

/**
 * Why the emails of flows, processes or workflow rules that fire on the
 * writes `writes` keeps were not counted: their definition — the metadata a
 * flow's start condition and actions are read from, a process's, a rule's —
 * was refused, or left unread past the read's bound, and what they send is
 * not known. Named per object, once though it fires on two writes, and one a
 * package installed with that package and why it is not read; undefined when
 * each one that fires was read. A flow that runs before the save sends
 * nothing, and is not named; one that runs before a delete may, and is.
 *
 * Read with no actions, each counted as sending none: a run into a target
 * whose contact flow was past the bound asked nothing, whatever it sent.
 */
function sendersNotReadOf(
  automation: Pick<ForgeTargetAutomation, 'objects'>,
  writes: (objectApiName: string, write: ForgeAutomationWrite) => boolean,
): string | undefined {
  const named = automation.objects.flatMap((object) => {
    // The same flow, process or rule fires on each write it starts on.
    const unread = new Set(
      automationByWrite(object)
        .filter((entry) => writes(object.objectApiName, entry.write))
        .flatMap((entry) => entry.fired)
        .flatMap(({ flow, keptQuiet }) =>
          flow !== undefined &&
          keptQuiet !== true &&
          flow.condition !== 'read' &&
          flow.timing !== 'beforeSave'
            ? [flow]
            : [],
        ),
    );
    const names = [...unread].map((flow) => {
      const installedBy = packageOf(flow);
      return installedBy !== undefined
        ? `${flow.label} (package ${installedBy}, whose flows the org lets no one read)`
        : flow.label;
    });
    if (names.length === 0) return [];
    const more = names.length > SENDERS_NAMED ? ` and ${names.length - SENDERS_NAMED} more` : '';
    return [
      {
        count: names.length,
        words: `${names.slice(0, SENDERS_NAMED).join(', ')}${more} on ${object.objectApiName}`,
      },
    ];
  });
  if (named.length === 0) return undefined;
  const count = named.reduce((sum, { count: each }) => sum + each, 0);
  return `the definition${count === 1 ? '' : 's'} of ${named.map(({ words }) => words).join('; ')}`;
}

/** A limit the emails go past, as a run's question names it. */
export function overEmailOf(check: EmailCheck): NonNullable<WriteConfirmation['emails']>[number] {
  return {
    limit: check.limit,
    emails: check.emails,
    remaining: check.remaining ?? 0,
    max: check.max ?? 0,
    objects: check.objects.map(({ objectApiName, perRecord }) => ({ objectApiName, perRecord })),
    ...(check.alertsCounted ? { alertsCounted: true as const } : {}),
  };
}

/**
 * A limit the emails are counted against that the target did not say what it
 * has left of, as a run's question names it.
 */
export function unreadEmailOf(
  check: EmailCheck,
): NonNullable<WriteConfirmation['emailsUnread']>[number] {
  return { limit: check.limit, emails: check.emails, unread: check.unread ?? '' };
}

/** How each daily email limit is said, of one email and of more. */
const EMAIL_LIMIT_WORDS: Readonly<Record<ForgeEmailLimit, { one: string; more: string }>> = {
  SingleEmail: { one: 'single email', more: 'single emails' },
  DailyWorkflowEmails: { one: 'workflow email', more: 'workflow emails' },
};

/**
 * `emails` emails of a daily limit, as a line says them: "1 single email",
 * "20 single emails". A clone's gate that counted one said "about 1 single
 * emails", live, as a rewind's preview did.
 */
export function emailsOfLimit(emails: number, limit: ForgeEmailLimit): string {
  const words = EMAIL_LIMIT_WORDS[limit];
  return `${emails} ${emails === 1 ? words.one : words.more}`;
}

/** What a check says of the email alerts among its single emails, when they are. */
function alertsWords(check: EmailCheck, org: string): string {
  return check.alertsCounted
    ? `, its email alerts among them: ${org} counts them against its single emails, as a ` +
        'Developer Edition does'
    : '';
}

/**
 * Why a command-line run is refused for its emails: past what the target has
 * left of a daily limit, as a run past its storage is refused. Undefined when
 * they fit, or could not be counted against a limit.
 */
export function emailRefusal(checks: readonly EmailCheck[], org: string): string | undefined {
  const over = checks.filter((check) => check.verdict === 'exceeds');
  if (over.length === 0) return undefined;
  const said = over
    .map(
      (check) =>
        `about ${emailsOfLimit(check.emails, check.limit)}` +
        (check.alertsCounted
          ? ' (its email alerts among them, as a Developer Edition counts them)'
          : '') +
        `, ${check.remaining ?? 0} of ${check.max ?? 0} left today`,
    )
    .join('; ');
  return (
    `The target's automation would make ${org} send ${said}: past them, each record whose flow ` +
    "fails in the save is refused (CANNOT_EXECUTE_FLOW_TRIGGER), and the org's own emails stop " +
    'for the rest of the day. Assign the user a bypass that keeps what sends quiet, or write ' +
    'fewer records.'
  );
}

/** What the command's write gate says of the emails the rows make the target send. */
export function emailCheckLines(checks: readonly EmailCheck[], org: string): string[] {
  return checks.map((check) => {
    const per = check.objects
      .map(
        (o) =>
          `${o.perRecord} per ${o.objectApiName}, by ${o.sentBy.join(', ')}` +
          (o.byThePlatform
            ? `; ${o.byThePlatform} ${o.objectApiName} written by the platform with ` +
              `${writtenWithWords(o.objectApiName)}, whose flows run all the same`
            : ''),
      )
      .join('; ');
    const sent =
      `  emails: these records make ${org} send about ${emailsOfLimit(check.emails, check.limit)} (${per})` +
      alertsWords(check, org);
    if (check.verdict === 'unread') {
      return `${sent}; what it has left today could not be read (${check.unread ?? ''})`;
    }
    if (check.verdict === 'fits') {
      return `${sent}; it has ${check.remaining ?? '?'} of ${check.max ?? '?'} left today`;
    }
    return (
      `${sent}, more than the ${check.remaining ?? '?'} of ${check.max ?? '?'} it has left ` +
      'today: past them the action fails, and a record whose flow fails in the save is ' +
      'refused (CANNOT_EXECUTE_FLOW_TRIGGER). A bypass that keeps the flow quiet, or a ' +
      'smaller run, avoids it'
    );
  });
}

/**
 * The code a command-line run is refused under when the target would deliver
 * the emails what still runs sends — or would not say whether it does — and
 * the run was not given `--accept-emails`. `--accept-automation` never lifts
 * it: it is the flag a CI script passes on every run.
 */
export const EMAILS_NOT_ACCEPTED = 'EMAILS_NOT_ACCEPTED';

/**
 * Why what may send an email as a run writes could not all be listed: the
 * parts of the target's automation that send them the read could not take —
 * its flows, processes and workflow rules, and its assignment rules when the
 * run applies them — each with the org's answer. Undefined when it took them
 * all. A part refused whole lists nothing, which is not the same as sending
 * nothing: the run reads the org's deliverability all the same.
 */
export function sendersUnreadOf(
  unread: ForgeTargetAutomation['unread'],
  options: { applyAssignmentRules?: boolean } = {},
): string | undefined {
  const said = [
    emailSendersUnread(unread, "the target's"),
    ...(options.applyAssignmentRules === true
      ? unread
          .filter(({ part }) => part === 'assignmentRules')
          .map(({ reason }) => `the target's assignment rules: ${reason}`)
      : []),
  ].filter((reason): reason is string => reason !== undefined);
  return said.length > 0 ? said.join('; ') : undefined;
}

/**
 * The requests a read of the target's automation sent its target, as the
 * read says them (`ForgeTargetAutomation.requests`); for a read that failed
 * whole — its time ran out, or it threw before it answered —, the most a
 * read sends (`AUTOMATION_READ_MOST`): what it sent was not told, and
 * may all have reached the org.
 *
 * Read just before a run's gate, as the panel's Seed, CSV import and clone
 * from an org read it, they were priced nowhere: on the command line, where
 * every request is counted as it goes, a seed of 600 contacts sent five for
 * that read.
 */
export function automationReadRequests(read: ForgeTargetAutomation | { unread: string }): number {
  return 'requests' in read && typeof read.requests === 'number'
    ? Math.max(0, read.requests)
    : AUTOMATION_READ_MOST;
}

/**
 * The `deliverability` part of a run's API requests: what its read of the
 * target's deliverability sent. Absent for a run with nothing left to send,
 * which reads none.
 */
export function deliverabilityPartOf(
  read: { read?: { requests: number } } | undefined,
): Pick<RunRequestParts, 'deliverability'> {
  const requests = read?.read?.requests ?? 0;
  return requests > 0 ? { deliverability: requests } : {};
}

/** The run a deliverability refusal names, as the command lines name it. */
export type DeliverabilityRun =
  | 'clone'
  | 'sync'
  | 'seed'
  | 'autopilot'
  | 'rewind'
  | 'undo'
  | 'masking'
  | 'restore'
  | 'cleanup'
  | 'load';

/** How a refusal names each run, and what `--accept-emails` lets it do. */
const DELIVERABILITY_RUN_WORDS: Readonly<
  Record<DeliverabilityRun, { run: string; allTheSame: string }>
> = {
  clone: { run: 'this clone', allTheSame: 'to clone all the same' },
  sync: { run: 'this sync', allTheSame: 'to sync all the same' },
  seed: { run: 'this seed', allTheSame: 'to seed all the same' },
  autopilot: { run: 'this Autopilot run', allTheSame: 'to run it all the same' },
  rewind: { run: 'this rewind', allTheSame: 'to rewind all the same' },
  undo: { run: 'this undo', allTheSame: 'to undo all the same' },
  masking: { run: 'this masking', allTheSame: 'to mask all the same' },
  restore: { run: 'this restore', allTheSame: 'to restore all the same' },
  cleanup: { run: 'this cleanup', allTheSame: 'to delete all the same' },
  load: { run: 'this load', allTheSame: 'to load all the same' },
};

/** How a sender of emails is named, by its kind. */
const SENDER_KIND_WORDS: Readonly<Record<EmailSender['kind'], string>> = {
  flow: 'flow',
  process: 'process',
  workflowRule: 'workflow rule',
  assignmentRule: 'assignment rule',
};

/** What a sender's name is followed by, by why it counts. */
const SENDER_WHY_WORDS: Readonly<Record<EmailSender['why'], string>> = {
  email: '',
  notRead: ' (its definition was not read)',
  assignment: ' (applied: it can mail the owner it assigns)',
};

/** `a`, `a and b`, `a, b and c`. */
function inWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The senders, named object by object in the order they come: `flow "A" and
 * workflow rule "B" on Contact; assignment rule "C" on Case`, the first
 * {@link SENDERS_NAMED} of an object named and the rest counted.
 */
function sendersWords(senders: readonly EmailSender[]): string {
  const byObject = new Map<string, string[]>();
  for (const sender of senders) {
    const names = byObject.get(sender.objectApiName) ?? [];
    names.push(`${SENDER_KIND_WORDS[sender.kind]} "${sender.name}"${SENDER_WHY_WORDS[sender.why]}`);
    byObject.set(sender.objectApiName, names);
  }
  return [...byObject]
    .map(([objectApiName, names]) => {
      const shown =
        names.length > SENDERS_NAMED
          ? [...names.slice(0, SENDERS_NAMED), `${names.length - SENDERS_NAMED} more`]
          : names;
      return `${inWords(shown)} on ${objectApiName}`;
    })
    .join('; ');
}

/** Where the line of the read comes from, said on every line that gives what it read. */
const READ_WITH = 'read with one line of anonymous Apex that sends nothing';

/** Whether a reading says the org delivers none of the emails of its automation. */
function isWithheld(reading: EmailDeliverability): reading is { level: 'withheld' } {
  return 'level' in reading && reading.level === 'withheld';
}

/** What a command line's report of the target's automation says of its deliverability. */
export function deliverabilityLineOf(reading: EmailDeliverability): string {
  if ('unread' in reading) {
    return (
      `deliverability: not read (${reading.unread}) — the run is refused without ` +
      '--accept-emails, as on All email'
    );
  }
  if (reading.level === 'all') {
    return `deliverability: All email — the emails of what still runs go out (${READ_WITH})`;
  }
  return (
    'deliverability: System email only or No access — none of the emails its flows, ' +
    'processes, workflow rules and Apex send goes out, and the org still counts them against ' +
    `its daily email limits (${READ_WITH})`
  );
}

/** What a run judged on its emails is told: the senders, what may send beside them, and the read. */
export interface DeliverabilityGateInput {
  /** What still runs that may send an email as the run writes (`emailSendersOf`). */
  senders: readonly EmailSender[];
  /** Why what may send could not all be listed ({@link sendersUnreadOf}); absent when it was. */
  sendersUnread?: string;
  /** The org's deliverability, as read; absent when not read, taken for unread when something sends. */
  reading?: EmailDeliverability;
  /**
   * Whether the run was given the accord to send them: `--accept-emails`,
   * "Execute and send the emails", `acceptEmails`, or the Approval that
   * answers a pipeline step's question. Never `--accept-automation`.
   */
  accepted: boolean;
  /** The org, as the refusal names it. */
  target: string;
  run: DeliverabilityRun;
  /**
   * Those of `senders` a mute would keep quiet (`sendersTheMuteQuiets`), for
   * a run that does not mute: the refusal names `--mute-automation` for them.
   * Absent or empty, it does not.
   */
  muteQuiets?: readonly EmailSender[];
  /**
   * Whether the records the run writes keep the addresses they are written
   * with: `--keep-contact-points`, or a rewind's values, which are the org's
   * own. A run that neutralizes them writes them under `.invalid`.
   */
  keepsAddresses?: boolean;
}

/**
 * A run judged on the emails what still runs sends:
 *
 * - `nothingSends`: nothing left sends one, nothing was read, and nothing
 *   is said;
 * - `withheld`: the org delivers none of them, said in a line and asked about
 *   nowhere;
 * - `asks`: the org delivers them all, or would not say — refused without
 *   the accord, which nothing else lifts.
 */
export interface DeliverabilityGate {
  verdict: 'nothingSends' | 'withheld' | 'asks';
  /**
   * What the run's preview, result and `--json` say of it: the reading and
   * the senders, whenever something sends. Absent otherwise.
   */
  deliverability?: RunDeliverability;
  /**
   * What the run's question carries (`AutomationConfirmation.deliverability`,
   * `WriteConfirmation.deliverability`): the block put first, and the answer
   * "Execute and send the emails". Set when it asks.
   */
  confirmation: { deliverability?: RunDeliverability };
  /** Why the run is refused, nothing written: it asks, and was not given the accord. */
  stop?: { code: typeof EMAILS_NOT_ACCEPTED; message: string };
  /** What a command line's report of the target's automation says of it; absent when nothing sends. */
  line?: string;
  /** What the audit trail keeps of the read (`AuditRunContext.deliverability`); absent when nothing sends. */
  audit?: 'all' | 'withheld' | 'unread';
}

/**
 * The words of a refusal for the emails: what the org does with them, who
 * sends them, where they go, and what lets the run through.
 */
function deliverabilityRefusalOf(
  input: DeliverabilityGateInput,
  reading: Exclude<EmailDeliverability, { level: 'withheld' }>,
): string {
  const { run, allTheSame } = DELIVERABILITY_RUN_WORDS[input.run];
  const { target } = input;
  const named = sendersWords(input.senders);
  const unread = input.sendersUnread;
  const whoSends =
    named !== ''
      ? `what still runs as ${run} writes its records sends some: ${named}` +
        (unread !== undefined ? `; what could not be read may send more (${unread})` : '')
      : `what runs as ${run} writes its records could not all be read (${unread ?? ''}), ` +
        'so it may send some';
  const parts: string[] = [];
  if ('unread' in reading) {
    parts.push(
      `Whether ${target} delivers the emails its automation sends could not be read ` +
        `(${reading.unread}), and ${whoSends}.`,
      `Nothing was written. Add --accept-emails ${allTheSame}, or check Setup > ` +
        'Deliverability: on System email only or No access, none of them goes out.',
    );
  } else {
    parts.push(
      `${target} delivers every email its automation sends (Setup > Deliverability: All ` +
        `email), and ${whoSends}.`,
      input.keepsAddresses === true
        ? `They go to the addresses the records and the alerts name: those of the records ` +
            `${run} writes, as they hold them, the records' owners, the records already in ` +
            `${target}, and an address an alert names.`
        : `They go to the addresses the records and the alerts name: those ${run} writes are ` +
            `under .invalid, but not the records' owners, the records already in ${target}, nor ` +
            'an address an alert names.',
      `Nothing was written. Add --accept-emails ${allTheSame}, set the org's deliverability to ` +
        'System email only, or turn off what sends them.',
    );
  }
  const quiets = input.muteQuiets ?? [];
  if (quiets.length > 0) {
    const quieted = new Set(quiets.map((s) => `${s.objectApiName}\u0000${s.kind}\u0000${s.name}`));
    const rest = input.senders.filter(
      (s) => !quieted.has(`${s.objectApiName}\u0000${s.kind}\u0000${s.name}`),
    );
    parts.push(
      `--mute-automation keeps quiet ${sendersWords(quiets)}, which ` +
        `${quiets.length === 1 ? 'tests' : 'test'} a bypass a permission set of ${target} holds` +
        (rest.length > 0 ? `; it cannot quiet ${sendersWords(rest)}.` : '.'),
    );
  }
  return parts.join(' ');
}

/**
 * A run's gate on the emails what still runs sends: on what is left once the
 * mute's plan holds, and on the org's deliverability, read just before the
 * question when something sends ({@link DeliverabilityGateInput}).
 *
 * | Something sends | Read | The run |
 * |---|---|---|
 * | no | not read | nothing said |
 * | yes | `withheld` | goes on, a line says why nothing goes out |
 * | yes | `all` | asks; refused without the accord |
 * | yes | `unread` | asks; refused without the accord, the reason said |
 *
 * An unread deliverability asks, as an unread storage or limit asks: what
 * must not happen here is silence. Only the run's own accord lets it through
 * (`--accept-emails`, "Execute and send the emails"): the answer to the
 * automation question covers what fires, not the emails that leave the org,
 * and a CI script passes `--accept-automation` on every run.
 */
export function deliverabilityGate(input: DeliverabilityGateInput): DeliverabilityGate {
  if (input.senders.length === 0 && input.sendersUnread === undefined) {
    return { verdict: 'nothingSends', confirmation: {} };
  }
  const reading: EmailDeliverability = input.reading ?? { unread: 'the run did not read it' };
  const deliverability: RunDeliverability = {
    reading,
    senders: [...input.senders],
    ...(input.sendersUnread !== undefined ? { sendersUnread: input.sendersUnread } : {}),
  };
  const line = deliverabilityLineOf(reading);
  if (isWithheld(reading)) {
    return { verdict: 'withheld', deliverability, confirmation: {}, line, audit: 'withheld' };
  }
  return {
    verdict: 'asks',
    deliverability,
    confirmation: {
      deliverability:
        input.keepsAddresses === true
          ? { ...deliverability, keepsAddresses: true }
          : deliverability,
    },
    ...(input.accepted
      ? {}
      : {
          stop: {
            code: EMAILS_NOT_ACCEPTED,
            message: deliverabilityRefusalOf(input, reading),
          },
        }),
    line,
    audit: 'unread' in reading ? 'unread' : 'all',
  };
}

/**
 * Of the senders a run's question on its emails names before a row is read
 * (`deliverabilityGate`), those of an object its gate then writes no record
 * of — nor the platform with a record the run creates ({@link insertedOf}):
 * nothing of theirs fires as the run writes. The question is put on every
 * object of the graph, as no row is read yet: a lead's clone named the
 * senders of the contacts, a node of its graph it wrote no record of, while
 * its gate counted one email per lead.
 */
export function sendersOfNothingWritten(
  senders: readonly EmailSender[],
  plan: PlanOfInserts,
): EmailSender[] {
  const inserted = objectsInsertedOf(plan);
  return senders.filter((sender) => !inserted.has(sender.objectApiName));
}

/**
 * What a dry run's gate says of the senders its refusal for the emails named
 * on an object it writes no record of ({@link sendersOfNothingWritten}): they
 * send nothing, and a real run, refused before it reads a row, names them
 * all the same. Undefined when there are none.
 */
export function sendersOfNothingWrittenLine(senders: readonly EmailSender[]): string | undefined {
  if (senders.length === 0) return undefined;
  const objects = [...new Set(senders.map((sender) => sender.objectApiName))];
  return (
    `  emails: ${sendersWords(senders)} send nothing: the run writes no ` +
    `${inWords(objects)} record. A real run is refused all the same, and names them: it asks ` +
    'before it reads which records it writes'
  );
}

/**
 * The check of a run's emails once the mute's lease is taken and read back,
 * before its first write: a set the lease did not hold leaves running what
 * it was to keep quiet, and a sender among them was asked about by no one.
 * Refused unless the run had the accord, or the org delivers none of them;
 * an org whose deliverability was not read — nothing that sent one was to
 * run — is taken for one that delivers them. The run then writes nothing,
 * and gives the lease back.
 *
 * @param input.planned - The senders of what still runs on the lease's plan.
 * @param input.held - Those of what still runs once the lease is read back:
 *   `stillRunningOf` given the sets it holds.
 */
export function deliverabilityAfterLeaseStop(input: {
  planned: readonly EmailSender[];
  held: readonly EmailSender[];
  reading?: EmailDeliverability;
  accepted: boolean;
  target: string;
  run: DeliverabilityRun;
}): { code: typeof EMAILS_NOT_ACCEPTED; message: string; relit: EmailSender[] } | undefined {
  const key = (s: EmailSender): string => `${s.objectApiName}\u0000${s.kind}\u0000${s.name}`;
  const planned = new Set(input.planned.map(key));
  const relit = input.held.filter((sender) => !planned.has(key(sender)));
  if (relit.length === 0 || input.accepted) return undefined;
  const reading = input.reading;
  if (reading !== undefined && isWithheld(reading)) return undefined;
  const { run, allTheSame } = DELIVERABILITY_RUN_WORDS[input.run];
  const delivers =
    reading === undefined
      ? `whether ${input.target} delivers them was not read, as nothing that sends one was to run`
      : 'unread' in reading
        ? `whether ${input.target} delivers them could not be read (${reading.unread})`
        : `${input.target} delivers every one of them (All email)`;
  return {
    code: EMAILS_NOT_ACCEPTED,
    relit,
    message:
      `The mute's lease does not hold every permission set it was to assign, and what they ` +
      `were to keep quiet still runs for ${run}: ${sendersWords(relit)} may send emails, and ` +
      `${delivers}. The run's question did not ask about them. Nothing was written. Add ` +
      `--accept-emails ${allTheSame}, or run it again once the lease can assign them.`,
  };
}

/** The storage of a check, as the confirmation says it. */
export function confirmationStorageOf(check: StorageCheck): WriteConfirmationStorage {
  return check.verdict === 'unread'
    ? { estimateMB: check.estimateMB, unread: check.unread }
    : {
        estimateMB: check.estimateMB,
        maxMB: check.maxMB,
        remainingMB: check.remainingMB,
        near: check.verdict === 'near',
      };
}

/**
 * Megabytes as the gate says them: rounded up, as an estimate that errs says
 * too much rather than too little, to two decimals under 10 MB.
 */
export function formatMB(megabytes: number): string {
  return megabytesAt(megabytes, megabytes < 10 ? 2 : 1);
}

/** Megabytes rounded up to `decimals`. */
function megabytesAt(megabytes: number, decimals: number): string {
  if (megabytes <= 0) return '0';
  const factor = 10 ** decimals;
  // The epsilon keeps a value the float holds a hair above its decimal —
  // 4.69 × 100 is 469.00000000000006 — from rounding up a step.
  return (Math.ceil(megabytes * factor - 1e-9) / factor).toString();
}

/**
 * An amount of megabytes and the bound it is past, each said as
 * {@link formatMB} says it, with a decimal more for both until they differ
 * (six at most). A fit refused with --fit-within 0.001 said it took "0.01
 * MB, past the 0.01 MB that fit": 0.0039 MB and 0.001 MB, both rounded up.
 */
export function formatMBPast(over: number, bound: number): { over: string; bound: string } {
  let decimals = { over: over < 10 ? 2 : 1, bound: bound < 10 ? 2 : 1 };
  for (;;) {
    const said = {
      over: megabytesAt(over, decimals.over),
      bound: megabytesAt(bound, decimals.bound),
    };
    const most = Math.max(decimals.over, decimals.bound);
    if (Number(said.over) > Number(said.bound) || most >= 6) return said;
    decimals = { over: most + 1, bound: most + 1 };
  }
}

/**
 * The entries of `fired` as a run's question names them, without the write
 * or when each runs. What a bypass the run's user holds keeps quiet is not
 * among them: it does not fire for the run's records.
 */
function named(fired: readonly ForgeFiredOnWrite[]): FiredOnInsert[] {
  return fired.map(({ objectApiName, kind, name }) => ({ objectApiName, kind, name }));
}

/** What fires in the target as a run inserts its records, per object. */
export function firedOnInsertOf(
  automation: Pick<ForgeTargetAutomation, 'objects'>,
): FiredOnInsert[] {
  return named(firedOnWriteOf(automation, 'insert'));
}

/**
 * What fires in the target as a run updates the records it inserted, on the
 * objects it updates ({@link objectsUpdatedAfterInsert}), per object.
 */
export function firedOnUpdateOf(
  automation: Pick<ForgeTargetAutomation, 'objects'>,
  updated: readonly string[],
): FiredOnInsert[] {
  const updating = new Set(updated);
  return named(firedOnWriteOf(automation, 'update', (name) => updating.has(name)));
}

/** An object whose records a run writes a second time after inserting them, and why. */
export interface UpdatedAfterInsert {
  objectApiName: string;
  steps: RunUpdateStep[];
}

/** The steps of {@link RunUpdateStep}, in the order it lists them. */
const UPDATE_STEPS: readonly RunUpdateStep[] = [
  'lookups',
  'statuses',
  'invitees',
  'retry',
  'upsert',
];

/**
 * The objects whose records a run of `graph` writes a second time after it
 * inserted them, and why, as far as the graph tells before a row is read —
 * when the run's question is put. Each step is the executor's own
 * ({@link RunUpdateStep}):
 *
 * - `lookups`: an object holding a lookup at itself, or at another object of a
 *   cycle among those the run writes. The run writes a cycle in an order that
 *   puts one of its records first, and leaves its lookup at a record written
 *   later empty for the second pass: which member that is, is the write
 *   order's — read from the fields the run describes, after the question — so
 *   every member that holds such a lookup is counted. A lookup outside a cycle
 *   points at a record written before its own and goes with its insert; one a
 *   record cannot be written without is never left empty, nor one only an
 *   insert sets, nor one no write sets.
 * - `statuses`: the orders and contracts the run writes.
 * - `invitees`: the invitees of events the run writes.
 * - `retry`: on a retry, every object holding a lookup at another the run
 *   writes: the run it retries may have left that lookup empty.
 * - `upsert`: with `--upsert`, every object the run writes.
 *
 * What only a describe tells is not counted: a lookup the user the run writes
 * as may update and not create, which the second pass fills in wherever its
 * record is.
 *
 * @param options - The objects the run leaves out by name, and whether it
 *   retries a run or upserts.
 */
export function objectsUpdatedAfterInsert(
  graph: Pick<ForgeGraph, 'nodes' | 'edges'>,
  options: { leftOut?: ReadonlySet<string>; retry?: boolean; upsert?: boolean } = {},
): UpdatedAfterInsert[] {
  const written = objectsTheRunWrites(graph, options.leftOut);
  const writing = new Set(written);
  const steps = new Map<string, Set<RunUpdateStep>>();
  const add = (objectApiName: string, step: RunUpdateStep): void => {
    if (!writing.has(objectApiName)) return;
    const set = steps.get(objectApiName) ?? new Set<RunUpdateStep>();
    set.add(step);
    steps.set(objectApiName, set);
  };
  // A lookup only an insert sets, or one a record cannot be written without,
  // makes a cycle as any other does, and is never filled in by an update.
  const lookups = graph.edges.filter(
    (edge) =>
      ordersTheWrite(edge) && writing.has(edge.sourceObject) && writing.has(edge.targetObject),
  );
  // Edges run from parent to child: an object reaches, down them, the objects under it.
  const children = new Map<string, string[]>();
  for (const { sourceObject, targetObject } of lookups) {
    if (sourceObject === targetObject) continue;
    children.set(sourceObject, [...(children.get(sourceObject) ?? []), targetObject]);
  }
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>([from]);
    const queue = [from];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      for (const child of children.get(next) ?? []) {
        if (child === to) return true;
        if (!seen.has(child)) {
          seen.add(child);
          queue.push(child);
        }
      }
    }
    return false;
  };
  const updatable = lookups.filter((edge) => edge.required !== true && edge.insertOnly !== true);
  for (const { sourceObject: parent, targetObject: child } of updatable) {
    if (parent === child || reaches(child, parent)) add(child, 'lookups');
  }
  for (const object of Object.keys(STATUS_LIFECYCLES)) add(object, 'statuses');
  for (const object of Object.keys(FLAGS_THE_PLATFORM_LEAVES)) add(object, 'invitees');
  if (options.retry === true) {
    for (const { sourceObject, targetObject } of updatable) {
      if (sourceObject !== targetObject) add(targetObject, 'retry');
    }
  }
  if (options.upsert === true) {
    for (const object of written) add(object, 'upsert');
  }
  return written.flatMap((objectApiName) => {
    const of = steps.get(objectApiName);
    return of ? [{ objectApiName, steps: UPDATE_STEPS.filter((step) => of.has(step)) }] : [];
  });
}

/** The steps that update the objects of `updated`, each once, in the order {@link RunUpdateStep} lists them. */
export function updateStepsOf(updated: readonly UpdatedAfterInsert[]): RunUpdateStep[] {
  const taken = new Set(updated.flatMap((object) => object.steps));
  return UPDATE_STEPS.filter((step) => taken.has(step));
}

/**
 * The custom permissions that keep from starting, for the user who holds
 * them, a flow firing as the run inserts its records, or as it updates those
 * of the objects `updated`, each once.
 */
export function runBypassesOf(
  automation: Pick<ForgeTargetAutomation, 'objects'>,
  updated: readonly string[] = [],
): string[] {
  const updating = new Set(updated);
  return bypassesOfWrites(
    automation,
    (objectApiName, write) =>
      write === 'insert' || (write === 'update' && updating.has(objectApiName)),
  );
}

/**
 * Those of `bypasses` the user the run writes as does not hold, with the
 * permission set that would give each and the command that assigns it, as
 * the read found them. A bypass whose permission sets the read could not look
 * up is listed without either: the question still names it.
 *
 * @param target - The target org by the alias the Salesforce CLI knows it by,
 *   and the user the run writes as; without them, no command is written.
 */
export function bypassesToAssign(
  automation: Pick<ForgeTargetAutomation, 'objects' | 'bypassGrants'>,
  bypasses: readonly string[],
  target?: { alias: string; username: string },
): BypassToAssign[] {
  const held = new Set(heldBypassPermissionsOf(automation).map((name) => name.toLowerCase()));
  const toAssign = bypasses.filter((name) => !held.has(name.toLowerCase()));
  const found = bypassAssignmentsOf(automation, toAssign);
  return toAssign.map((permission) => {
    const assignment = found.find((a) => a.permission.toLowerCase() === permission.toLowerCase());
    const permissionSet = assignment?.permissionSet?.name;
    return {
      permission,
      ...(permissionSet ? { permissionSet } : {}),
      others: assignment?.others.map((other) => other.name) ?? [],
      ...(assignment && !permissionSet ? { noneHolds: true as const } : {}),
      ...(permissionSet && target?.alias && target.username
        ? { command: assignPermsetCommand(permissionSet, target.alias, target.username) }
        : {}),
    };
  });
}

/**
 * Whether a part the read could not take hides what fires on insert. A start
 * condition or a definition not read leaves its flow, process or rule listed
 * as firing; the assignment rules stay off unless the run asks for them; the
 * duplicate rules and the user's permissions decide nothing about what runs.
 */
function isUnreadThatHides(
  part: ForgeTargetAutomation['unread'][number]['part'] | 'automation',
): part is AutomationConfirmation['unread'][number]['part'] {
  return (
    part === 'flows' ||
    part === 'triggers' ||
    part === 'processes' ||
    part === 'workflowRules' ||
    part === 'automation'
  );
}

/**
 * What could not be read of what fires on insert. A start condition that
 * could not be read leaves its flow listed as firing, so it is not among them.
 */
export function automationUnreadOf(
  automation: Pick<ForgeTargetAutomation, 'unread'>,
): AutomationConfirmation['unread'] {
  return automation.unread.flatMap(({ part, reason }) =>
    isUnreadThatHides(part) ? [{ part, reason }] : [],
  );
}

/**
 * The code a clone is refused under, before it reads anything, when its owner
 * mapping gives records to a user the target holds inactive: the target
 * refuses every record that user would own, and the run will not give them to
 * the user it writes as instead of the one chosen. Worded by the panel
 * (`error-hints.ts`), the message naming each user.
 */
export const OWNER_MAP_INACTIVE = 'OWNER_MAP_INACTIVE';

/**
 * The code a clone is refused under, before it reads anything, when its owner
 * mapping gives records to a user the target holds no user of: a template
 * made for another org, an id mistyped. The target refuses every record
 * given to it, and the cure is another user, not one reactivated: a code of
 * its own, as a record type the target lacks is told from one it closes.
 */
export const OWNER_MAP_UNKNOWN = 'OWNER_MAP_UNKNOWN';

/**
 * The codes a run's gate stops it with: the extension's, the command line's
 * own, those every module's run is refused under — past the target's daily
 * API requests, and for the checkpoint it takes first — and a clone's owner
 * mapping to an inactive user, or to one the target lacks.
 */
export type ForgeRunGateErrorCode =
  | ForgeRunGateCode
  | typeof OWNER_MAP_INACTIVE
  | typeof OWNER_MAP_UNKNOWN
  | 'MAX_TOTAL_EXCEEDED'
  | 'AUTOMATION_NOT_ACCEPTED'
  | 'EMAILS_EXCEEDED'
  | typeof EMAILS_NOT_ACCEPTED
  | typeof API_BUDGET_EXCEEDED
  | typeof CHECKPOINT_REFUSED
  | typeof FILES_UNREAD
  | typeof FILE_STORAGE_UNREAD;

/**
 * Raised when a run's gate stops it: before it reads anything, or once it has
 * read the rows it was about to write and before it writes the first. Nothing
 * was written.
 */
export class ForgeRunGateError extends Error {
  readonly code: ForgeRunGateErrorCode;
  /**
   * For a refusal for storage: what the rows or the files take, and what the
   * target had left, in MB, and which storage (`kind`, the data storage when
   * absent).
   */
  readonly storage?: NonNullable<ForgeRunGateStop['storage']>;
  /** For a run cancelled at its read: the most rows of one object it was set to read. */
  readonly ceiling?: number;
  /**
   * For a run refused for the checkpoint it was to take first: what refused
   * the take, by its code (`DISK`, `RUN_WRITING`…). Absent for a take that
   * failed rather than refused.
   */
  readonly reason?: CheckpointRefusalCode;
  /** For a clone of the whole org refused for an API budget: which allowance of which org, what the run takes and what is left. */
  readonly api?: NonNullable<ForgeRunGateStop['api']>;
  /** For a clone of the whole org refused for what it reads whole: the bound, and the objects past it. */
  readonly readBound?: NonNullable<ForgeRunGateStop['readBound']>;

  constructor(
    code: ForgeRunGateErrorCode,
    message: string,
    storage?: NonNullable<ForgeRunGateStop['storage']>,
    ceiling?: number,
    reason?: CheckpointRefusalCode,
    detail?: Pick<ForgeRunGateStop, 'api' | 'readBound'>,
  ) {
    super(message);
    this.name = 'ForgeRunGateError';
    this.code = code;
    if (storage) this.storage = storage;
    if (ceiling !== undefined) this.ceiling = ceiling;
    if (reason !== undefined) this.reason = reason;
    if (detail?.api) this.api = detail.api;
    if (detail?.readBound) this.readBound = detail.readBound;
  }

  /**
   * The stop a gate check of the run's API requests or of its checkpoint
   * first came to ({@link forgeWriteBudgetOf}, {@link takeCheckpointFirst}),
   * with the take's refusal kept by its code: the page said a checkpoint was
   * refused, never by what — the disk of this machine, another run writing,
   * its limit of records — which the English message alone named. A stop of
   * a clone of the whole org keeps what it names besides: the storage and
   * which, the allowance and the org, the objects read whole.
   */
  static of(stop: ForgeGateStop): ForgeRunGateError {
    return new ForgeRunGateError(
      stop.code,
      stop.message,
      stop.storage,
      undefined,
      stop.refusal?.code,
      {
        ...(stop.api ? { api: stop.api } : {}),
        ...(stop.readBound ? { readBound: stop.readBound } : {}),
      },
    );
  }

  /** The stop as the page is told it: none for a code of the command line's own. */
  get stop(): ForgeRunGateStop | undefined {
    if (!isForgeRunGateCode(this.code)) return undefined;
    return {
      code: this.code,
      ...(this.storage ? { storage: this.storage } : {}),
      ...(this.ceiling !== undefined ? { ceiling: this.ceiling } : {}),
      ...(this.reason !== undefined && this.code === CHECKPOINT_REFUSED
        ? { reason: this.reason }
        : {}),
      ...(this.api && this.code === API_BUDGET_EXCEEDED ? { api: this.api } : {}),
      ...(this.readBound && this.code === 'READ_BOUND_EXCEEDED'
        ? { readBound: this.readBound }
        : {}),
    };
  }
}

/**
 * Whether `error` is a run's gate stop. Read by its name as well as its class:
 * thrown from inside the executor, it reaches the bridge through the
 * orchestrator, and what is said of it must not hang on one module instance.
 */
export function isForgeRunGateError(error: unknown): error is ForgeRunGateError {
  return (
    error instanceof ForgeRunGateError ||
    (error instanceof Error &&
      error.name === 'ForgeRunGateError' &&
      typeof (error as { code?: unknown }).code === 'string')
  );
}

/**
 * Why a run that clones no whole org is refused when the files its file
 * copier would copy take more file storage than the target has left, as the
 * command line names it.
 */
const FILE_STORAGE_EXCEEDED = 'FILE_STORAGE_EXCEEDED';

/**
 * The refusal of the file copier of a run that clones no whole org, as the
 * gate's stop of the same code: the files of the records it read could not
 * all be looked up ({@link FILES_UNREAD}), the target would not say what
 * file storage it has left ({@link FILE_STORAGE_UNREAD}), or they take more
 * of it than is left (`FILE_STORAGE_EXCEEDED`), with the megabytes of both
 * (`storage`, `kind: 'files'`) as a clone of the whole org's refusal for its
 * files gives them. Raised before the first write, as a clone of the whole
 * org's gate raises them, and recorded stopped under its code, as the command
 * line records it. Told the page as a run that failed, it was said in English
 * with no hint, on the execution screen, away from the Review where the copy
 * of files is turned off. Read by its name, as a gate stop is. Nothing for
 * any other error, nor for files past the storage that do not say by how much.
 */
export function filesRefusalStop(error: unknown): ForgeRunGateError | undefined {
  if (!(error instanceof Error) || error.name !== 'ForgeFilesRefusedError') return undefined;
  const { code, storage } = error as {
    code?: unknown;
    storage?: { neededBytes?: unknown; remainingBytes?: unknown };
  };
  if (code === FILES_UNREAD || code === FILE_STORAGE_UNREAD) {
    return new ForgeRunGateError(code, error.message);
  }
  const needed = storage?.neededBytes;
  const remaining = storage?.remainingBytes;
  if (
    code !== FILE_STORAGE_EXCEEDED ||
    typeof needed !== 'number' ||
    typeof remaining !== 'number' ||
    !Number.isFinite(needed) ||
    !Number.isFinite(remaining)
  ) {
    return undefined;
  }
  const remainingMB = remaining / BYTES_PER_MB;
  return new ForgeRunGateError(FILE_STORAGE_EXCEEDED, error.message, {
    // Rounded up, as the gate says what a run takes, and said past what is
    // left however close the two are.
    estimateMB: Number(formatMBPast(needed / BYTES_PER_MB, remainingMB).over),
    remainingMB,
    kind: 'files',
  });
}

/** Why the rows cannot be written for the storage they take, or nothing when they can. */
export function storageRefusal(check: StorageCheck, target: string): string | undefined {
  if (check.verdict !== 'exceeds') return undefined;
  return (
    `The records to write take about ${formatMB(check.estimateMB)} MB of data storage, and ` +
    `${target} has ${check.remainingMB} MB left of ${check.maxMB} MB: leave objects out, ` +
    `lower the records per object, or free data storage in ${target}.`
  );
}

/** The objects a list names before it says how many more it leaves out. */
const LISTED_OBJECTS = 10;

/**
 * What the command line says of the rows it is about to write: how many per
 * object, the storage they take, and what the target has left.
 */
export function writePlanLines(plan: WritePlan, check: StorageCheck, target: string): string[] {
  const lines = [
    `write gate: ${plan.totalRows} record(s) to write to ${target}, about ` +
      `${formatMB(check.estimateMB)} MB of data storage`,
  ];
  for (const object of plan.objects.slice(0, LISTED_OBJECTS)) {
    lines.push(`  ${object.objectApiName.padEnd(42)}${String(object.rows).padStart(8)}`);
  }
  const rest = plan.objects.slice(LISTED_OBJECTS);
  if (rest.length > 0) {
    const rows = rest.reduce((sum, object) => sum + object.rows, 0);
    lines.push(`  and ${rest.length} more object(s), ${rows} record(s)`);
  }
  for (const { objectApiName, mayAdd } of plan.objects) {
    if (mayAdd === undefined) continue;
    lines.push(
      `  counted in: up to ${mayAdd} ${objectApiName} record(s) the run may read as it writes ` +
        "them, a price in the currency of the record its lines belong to, the source's own " +
        'beside the one read',
    );
  }
  for (const { objectApiName, mayBeByThePlatform } of plan.objects) {
    if (mayBeByThePlatform === undefined) continue;
    lines.push(
      `  counted in: up to ${mayBeByThePlatform.rows} ${objectApiName} record(s) the platform ` +
        (mayBeByThePlatform.before === true
          ? `may have written with ${writtenWithWords(objectApiName)}, in the run this one takes up`
          : `may write itself with ${writtenWithWords(objectApiName)}`) +
        ', which the run then links to and does not send',
    );
  }
  lines.push(...leftOutLines(plan.leftOut));
  if (check.verdict === 'unread') {
    lines.push(
      `  the data storage ${target} has left could not be read (${check.unread}): ` +
        'whether the records fit is not known',
    );
    return lines;
  }
  lines.push(`  data storage of ${target}: ${check.remainingMB} MB left of ${check.maxMB} MB`);
  if (check.verdict === 'near') {
    lines.push(
      `  that is more than ${Math.round(STORAGE_NEAR_SHARE * 100)} % of what ${target} has left: ` +
        'Salesforce counts storage a while after a load, so less may be left than it says',
    );
  }
  return lines;
}

/**
 * What the command line says of the rows a run read or counted and will not
 * write, left out of the records to write: those the run it retries or
 * resumes wrote, an object held back whole for a record type, the rows the
 * platform writes itself with a record the run creates, and those holding a
 * unique value the target holds, which the write links to.
 */
export function leftOutLines(leftOut: WritePlanLeftOut | undefined): string[] {
  if (!leftOut) return [];
  const lines: string[] = [];
  if (leftOut.writtenBefore > 0) {
    lines.push(
      `  not counted: ${leftOut.writtenBefore} record(s) the run it retries or resumes wrote, ` +
        'which it links to and does not write again',
    );
  }
  for (const { objectApiName, rows } of leftOut.heldBack) {
    lines.push(
      `  not counted: ${objectApiName}, ${rows} record(s), held back for a record type ` +
        'closed to the user the run writes as',
    );
  }
  for (const { objectApiName, rows } of leftOut.withoutParent ?? []) {
    lines.push(
      `  not counted: ${objectApiName}, ${rows} record(s) held back with a record they cannot ` +
        'be written without, held back itself',
    );
  }
  for (const { objectApiName, rows } of leftOut.noParentInSource ?? []) {
    lines.push(
      `  not counted: ${objectApiName}, ${rows} record(s) left aside: a lookup they may not ` +
        'leave empty names a record the source does not hold, which no copy can write',
    );
  }
  for (const { objectApiName, rows } of leftOut.byThePlatform ?? []) {
    lines.push(
      `  not counted: ${objectApiName}, ${rows} record(s) written by the platform with ` +
        `${writtenWithWords(objectApiName)}, which the run links to and does not send`,
    );
  }
  for (const { objectApiName, rows, fields } of leftOut.linkedByValue ?? []) {
    lines.push(
      `  not counted: ${objectApiName}, ${rows} record(s) the target holds under the same ` +
        `${fields.join(', ')}, which the run links to and does not create`,
    );
  }
  return lines;
}

/** What each kind of risk says on the command line, after the object. */
const REMOVAL_RISK_WORDS: Readonly<Record<ForgeRemovalRisk['kind'], (name: string) => string>> = {
  flow: (name) => `flow "${name}" runs before a record is deleted, and can refuse the delete`,
  trigger: (name) => `Apex trigger ${name} runs on a delete, and can refuse it`,
  packageTrigger: (name) =>
    `Apex trigger ${name}, installed by a managed package, runs on a delete and can refuse it; ` +
    'no one in the org can change it',
  lock: () =>
    'once activated, a record locks the records under it, which a removal then takes only ' +
    'with it, or once it is back in Draft',
};

/**
 * The parts of the target's automation that tell what refuses a delete: the
 * flows before one, the Apex triggers on one.
 */
const DELETE_PARTS = ['flows', 'triggers'] as const;

/**
 * What the command line says before a run of what may refuse the removal of
 * its records (`--remove`): per object it writes, the flows before a delete,
 * the Apex triggers on one — a managed package's apart — and the records that
 * lock past Draft; or that none was found. The flows or the Apex triggers the
 * read could not reach are said as not known: run as a Standard User, who may
 * not read `ApexTrigger`, the line claimed "no Apex trigger on one" under the
 * line saying the Apex triggers could not be read.
 *
 * @param unread - What of the target's automation could not be read.
 * @param removal - What takes the run back, as its reader runs it: an
 *   environment's destroy, or the command line's `--remove`.
 */
export function removalRiskLines(
  risks: readonly ForgeRemovalRisk[],
  target: string,
  unread: ReadonlyArray<{ part: string }> = [],
  removal = '--remove',
): string[] {
  const notRead = DELETE_PARTS.filter((part) => unread.some((entry) => entry.part === part));
  const notKnown =
    notRead.length === 0
      ? []
      : [
          `  ${notRead.map((part) => UNREAD_WORDS[part]).join(' and ')} could not be read: ` +
            'whether one refuses the removal is not known',
        ];
  if (risks.length === 0 && notRead.length === 0) {
    return [
      `reversibility: nothing found in ${target} that refuses a removal of this run's records ` +
        '(no flow before a delete, no Apex trigger on one, no record that locks past Draft)',
    ];
  }
  if (risks.length === 0) {
    const none = [
      ...(notRead.includes('flows') ? [] : ['no flow before a delete']),
      ...(notRead.includes('triggers') ? [] : ['no Apex trigger on a delete']),
      'no record that locks past Draft',
    ];
    return [
      `reversibility: nothing found in ${target} that refuses a removal of this run's records ` +
        `in what could be read (${none.join(', ')})`,
      ...notKnown,
    ];
  }
  return [
    `reversibility: a removal of this run's records (${removal}) may be refused in ${target}:`,
    ...risks.map(
      ({ objectApiName, kind, name }) =>
        `  ${objectApiName}: ${REMOVAL_RISK_WORDS[kind](name ?? '')}`,
    ),
    ...notKnown,
  ];
}

/** How the command line names a part of the automation it could not read. */
const UNREAD_WORDS: Record<AutomationConfirmation['unread'][number]['part'], string> = {
  flows: 'the flows',
  triggers: 'the Apex triggers',
  processes: 'the Process Builder processes',
  workflowRules: 'the workflow rules',
  automation: 'the automation',
};

/** How the command line names what fires. */
function firedWords({ kind, name }: Pick<FiredOnInsert, 'kind' | 'name'>): string {
  if (kind === 'flow') return `flow "${name}"`;
  if (kind === 'process') return `process "${name}"`;
  if (kind === 'workflowRule') return `workflow rule "${name}"`;
  return `Apex trigger ${name}`;
}

/** How the command line says why a run updates the records it inserted. */
const UPDATE_STEP_WORDS: Readonly<Record<RunUpdateStep, string>> = {
  lookups: 'a lookup filled in once its record exists',
  statuses: 'an order or a contract given back its status after it went in as a draft',
  invitees: "an event's invitee given its answer",
  retry: 'a lookup the run it retries left empty filled in',
  upsert: 'a record the target holds written over by --upsert',
};

/** `Object: what fires` for each entry, as the command line lists them. */
function namedList(fired: readonly FiredOnInsert[]): string {
  return fired.map((entry) => `${entry.objectApiName}: ${firedWords(entry)}`).join('; ');
}

/**
 * What the command line says of each bypass the user the run writes as does
 * not hold: the permission set that holds it and the command that assigns
 * it, or that none holds it. A bypass whose permission sets were not read is
 * named by the lines of the automation already.
 *
 * @param who - The user the command names: "the clone", "the removal".
 */
export function bypassAssistantSentences(
  assign: readonly BypassToAssign[],
  target: string,
  who: string,
): string[] {
  return assign.flatMap((entry) => {
    if (entry.command) {
      const others =
        entry.others.length > 0
          ? `; ${entry.others.join(', ')} hold${entry.others.length === 1 ? 's' : ''} it too`
          : '';
      return [
        `${entry.permissionSet} is the smallest permission set of ${target} that holds ` +
          `${entry.permission}${others}. Assigned to the user ${who} writes as, it keeps quiet ` +
          `what ${entry.permission} excludes: ${entry.command}`,
      ];
    }
    if (entry.noneHolds) {
      return [
        `No permission set of ${target} holds ${entry.permission}: an admin creates one that ` +
          `includes it, and assigns it to the user ${who} writes as.`,
      ];
    }
    return [];
  });
}

/**
 * What a refusal says of `--mute-automation` when the command can mute what
 * fires itself, the flag not given yet: the sets that would keep it quiet,
 * which a mute assigns for the run alone, under a lease. Never a command that
 * assigns them by hand: given with the user's name, run on the trap org, it
 * left the set assigned past the run, outside any lease, where another
 * session's run held one.
 *
 * @param run - What the command does: "clone", "removal".
 */
function muteSentences(assign: readonly BypassToAssign[], run: string, mayMute: boolean): string[] {
  const sets = [...new Set(assign.flatMap((entry) => entry.permissionSet ?? []))];
  if (!mayMute || sets.length === 0) return [];
  return [
    `With --mute-automation, the ${run} assigns ${sets.join(', ')} to the user it writes as ` +
      `for the ${run} alone, under a lease, and what ${sets.length === 1 ? 'it keeps' : 'they keep'} ` +
      'quiet does not fire.',
  ];
}

/**
 * Why the command line will not write without `--accept-automation`: what the
 * target runs as the clone inserts its records, and as it updates those of
 * `updated`, named, or what of it could not be read; then, for a bypass the
 * user does not hold, the permission set that holds it, which
 * `--mute-automation` assigns. Nothing when nothing fires and everything was
 * read.
 *
 * @param options - The objects the clone updates after inserting them, the
 *   bypasses to assign ({@link bypassesToAssign}), and whether the clone can
 *   mute them itself (`--mute-automation`, not asked yet).
 */
export function automationRefusal(
  automation: Pick<ForgeTargetAutomation, 'objects' | 'unread'>,
  target: string,
  options: {
    updated?: readonly UpdatedAfterInsert[];
    assign?: readonly BypassToAssign[];
    mayMute?: boolean;
  } = {},
): string | undefined {
  const updated = options.updated ?? [];
  const fired = firedOnInsertOf(automation);
  const firedOnUpdate = firedOnUpdateOf(
    automation,
    updated.map((object) => object.objectApiName),
  );
  const unread = automationUnreadOf(automation);
  if (fired.length === 0 && firedOnUpdate.length === 0 && unread.length === 0) return undefined;
  const parts: string[] = [];
  if (fired.length > 0) {
    parts.push(`${target} runs automation on the records this clone inserts: ${namedList(fired)}.`);
  }
  if (firedOnUpdate.length > 0) {
    const why = updateStepsOf(
      updated.filter((object) =>
        firedOnUpdate.some((f) => f.objectApiName === object.objectApiName),
      ),
    ).map((step) => UPDATE_STEP_WORDS[step]);
    parts.push(
      `${target} runs automation as this clone updates records it inserted (${why.join('; ')}): ` +
        `${namedList(firedOnUpdate)}.`,
    );
  }
  const writes = updated.length > 0 ? 'inserts and updates' : 'inserts';
  for (const { part, reason } of unread) {
    parts.push(
      `${UNREAD_WORDS[part][0].toUpperCase()}${UNREAD_WORDS[part].slice(1)} of ${target} ` +
        `could not be read (${reason}), so what fires as the clone ${writes} is not known.`,
    );
  }
  parts.push(...bypassAssistantSentences(options.assign ?? [], target, 'the clone'));
  parts.push(...muteSentences(options.assign ?? [], 'clone', options.mayMute === true));
  parts.push(
    `Nothing was written. Add --accept-automation to clone all the same, or turn that ` +
      `automation off in ${target} first.`,
  );
  return parts.join(' ');
}

/**
 * Why the command line will not remove a run's records without
 * `--accept-automation`: what the target runs as the removal deletes them,
 * and as it sets the records of `drafted` back to Draft before deleting them,
 * named, or what of it could not be read; then the bypasses to assign.
 * Nothing when nothing fires and everything was read.
 *
 * @param options - The objects the removal sets back to Draft, the bypasses
 *   to assign ({@link bypassesToAssign}), and whether the removal can mute
 *   them itself (`--mute-automation`, not asked yet).
 */
export function removalAutomationRefusal(
  automation: Pick<ForgeTargetAutomation, 'objects' | 'unread'>,
  target: string,
  options: {
    drafted?: readonly string[];
    assign?: readonly BypassToAssign[];
    mayMute?: boolean;
  } = {},
): string | undefined {
  const fired = firedOnRemovalOf(automation, options.drafted ?? []);
  const unread = automationUnreadOf(automation);
  if (fired.length === 0 && unread.length === 0) return undefined;
  const parts: string[] = [];
  const updates = fired.filter((entry) => entry.write === 'update');
  const deletes = fired.filter((entry) => entry.write === 'delete');
  if (deletes.length > 0) {
    const named = deletes.map(
      (entry) => `${entry.objectApiName}: ${firedWords(entry)} (${DELETE_WHEN_WORDS[entry.when]})`,
    );
    parts.push(
      `${target} runs automation on the records this removal deletes: ${named.join('; ')}.`,
    );
  }
  if (updates.length > 0) {
    parts.push(
      `${target} runs automation as this removal sets activated records back to Draft, the ` +
        `only way the platform deletes them: ${namedList(updates)}.`,
    );
  }
  for (const { part, reason } of unread) {
    parts.push(
      `${UNREAD_WORDS[part][0].toUpperCase()}${UNREAD_WORDS[part].slice(1)} of ${target} ` +
        `could not be read (${reason}), so what fires as the removal deletes is not known.`,
    );
  }
  parts.push(...bypassAssistantSentences(options.assign ?? [], target, 'the removal'));
  parts.push(...muteSentences(options.assign ?? [], 'removal', options.mayMute === true));
  parts.push(
    `Nothing was deleted. Add --accept-automation to remove all the same, or turn that ` +
      `automation off in ${target} first.`,
  );
  return parts.join(' ');
}

/** When what fires on a delete runs, as the command line says it. */
const DELETE_WHEN_WORDS: Readonly<Record<ForgeFiredOnWrite['when'], string>> = {
  before: 'before delete',
  after: 'after delete',
  beforeAndAfter: 'before and after delete',
};

/**
 * What the command line says, before a removal deletes anything, of what the
 * target runs as it does: per object, what its deletes fire, before or after,
 * and what its updates fire on the records it sets back to Draft; or that
 * nothing does; and what could not be read.
 *
 * @param objects - How many objects the removal deletes records of.
 * @param drafted - The objects whose records past Draft it sets back to Draft first.
 */
export function removalAutomationLines(
  automation: Pick<ForgeTargetAutomation, 'objects' | 'unread'>,
  target: string,
  objects: number,
  drafted: readonly string[],
): string[] {
  const lines = [`removal automation: what ${target} runs as the removal takes the records back`];
  for (const entry of firedOnRemovalOf(automation, drafted)) {
    lines.push(
      entry.write === 'delete'
        ? `  ${entry.objectApiName}: ${DELETE_WHEN_WORDS[entry.when]}: ${firedWords(entry)}`
        : `  ${entry.objectApiName}: set back to Draft before its delete: ${firedWords(entry)}`,
    );
  }
  const unread = automationUnreadOf(automation);
  if (lines.length === 1 && unread.length === 0) {
    lines.push(`  nothing fires on the ${objects} object(s) it deletes records of`);
  }
  for (const { part, reason } of unread) {
    lines.push(`  ${UNREAD_WORDS[part]} could not be read: ${reason}`);
  }
  return lines;
}

/** What a step of a removal that takes a whole run back does to the record it fires on, as the command line says it. */
const REMOVAL_STEP_WORDS: Readonly<Record<Exclude<ForgeRemovalStep, 'delete'>, string>> = {
  bringBack: 'brought back from the recycle bin',
  recreate: 'made again with a new Id',
  giveBack: 'given back its values from before the run',
  setToDraft: 'set back to Draft before its delete',
};

/**
 * What the command line says, before a removal that takes a whole run back
 * writes anything, of what the target runs as it does, step by step as it
 * writes ({@link firedOnRemovalStepsOf}): as it brings back from the recycle
 * bin what the run deleted, gives back what the run wrote over, sets an
 * activated record back to Draft, then before and after each delete; or that
 * nothing does; and what could not be read. A Sync run's removal brought
 * records back and gave values back, and the command line said nothing of
 * what those writes fire, where the panel lists it.
 */
export function removalStepsAutomationLines(
  automation: Pick<ForgeTargetAutomation, 'objects' | 'unread'>,
  target: string,
  steps: ForgeRemovalSteps,
  subject: RemovalStepsSubject = 'removal',
  sweep?: ForgeRemovalSteps,
): string[] {
  const unread = automationUnreadOf(automation);
  /** One writer's lines: what fires as it writes, or that nothing does. */
  const linesOf = (written: ForgeRemovalSteps, writer: RemovalStepsSubject): string[] => {
    const lines = [REMOVAL_STEPS_HEADINGS[writer](target)];
    for (const entry of firedOnRemovalStepsOf(automation, written)) {
      lines.push(
        entry.step === 'delete'
          ? `  ${entry.objectApiName}: ${DELETE_WHEN_WORDS[entry.when]}: ${firedWords(entry)}`
          : `  ${entry.objectApiName}: ${REMOVAL_STEP_WORDS[entry.step]}: ${firedWords(entry)}`,
      );
    }
    if (lines.length === 1 && unread.length === 0) {
      const objects = new Set(Object.values(written).flat()).size;
      // A sweep only deletes: said to write, its line read as the purge's.
      const writes = writer === 'reloadSweep' ? 'deletes' : 'writes';
      lines.push(`  nothing fires on the ${objects} object(s) it ${writes} records of`);
    }
    return lines;
  };
  return [
    ...linesOf(steps, subject),
    // What a reload's sweep deletes, said apart from its purge: a task the
    // sweep took was said to be one the purge deleted.
    ...(sweep ? linesOf(sweep, 'reloadSweep') : []),
    ...unread.map(({ part, reason }) => `  ${UNREAD_WORDS[part]} could not be read: ${reason}`),
  ];
}

/** The first line of what fires as each {@link RemovalStepsSubject} writes. */
const REMOVAL_STEPS_HEADINGS: Readonly<Record<RemovalStepsSubject, (target: string) => string>> = {
  removal: (target) => `removal automation: what ${target} runs as the removal takes the run back`,
  reload: (target) =>
    `reload automation: what ${target} runs as the reload purges what earlier loads created`,
  reloadSweep: (target) =>
    `reload automation: what ${target} runs as the reload's sweep deletes what the target's ` +
    'automation made for the loads it replaces',
};

/**
 * Why the command line will not take a whole run back without
 * `--accept-automation`: what the target runs as each step of the removal
 * writes ({@link removalStepsAutomationLines}), named, or what of it could
 * not be read; then the bypasses to assign. Nothing when nothing fires and
 * everything was read.
 *
 * @param options - What each step writes, the bypasses to assign
 *   ({@link bypassesToAssign}), whether the command can mute them itself
 *   (`--mute-automation`, not asked yet): the sets that would keep quiet what
 *   fires are then named as what a mute assigns, under its lease — and what
 *   writes them: a removal, or the purge a reload runs before it loads.
 */
export function removalStepsAutomationRefusal(
  automation: Pick<ForgeTargetAutomation, 'objects' | 'unread'>,
  target: string,
  options: {
    steps: ForgeRemovalSteps;
    assign?: readonly BypassToAssign[];
    mayMute?: boolean;
    subject?: RemovalStepsSubject;
    /**
     * What the sweep asked with a reload deletes, named apart from what its
     * purge writes (`steps`): each with what deletes it. Said as the purge's,
     * a task the sweep took read as one the purge deleted.
     */
    sweep?: ForgeRemovalSteps;
  },
): string | undefined {
  const fired = firedOnRemovalStepsOf(automation, options.steps);
  const swept = options.sweep ? firedOnRemovalStepsOf(automation, options.sweep) : [];
  const unread = automationUnreadOf(automation);
  if (fired.length === 0 && swept.length === 0 && unread.length === 0) return undefined;
  const of = (step: ForgeRemovalStep): ForgeFiredOnRemovalStep[] =>
    fired.filter((entry) => entry.step === step);
  const words = REMOVAL_STEPS_SUBJECT_WORDS[options.subject ?? 'removal'];
  const parts: string[] = [];
  if (of('bringBack').length > 0) {
    parts.push(
      `${target} runs automation as ${words.this} brings back from the recycle bin what the ` +
        `run deleted: ${namedList(of('bringBack'))}.`,
    );
  }
  if (of('giveBack').length > 0) {
    parts.push(
      `${target} runs automation as ${words.this} gives the records the run wrote over their ` +
        `values from before it: ${namedList(of('giveBack'))}.`,
    );
  }
  if (of('setToDraft').length > 0) {
    parts.push(
      `${target} runs automation as ${words.this} sets activated records back to Draft, the ` +
        `only way the platform deletes them: ${namedList(of('setToDraft'))}.`,
    );
  }
  if (of('delete').length > 0) {
    const named = of('delete').map(
      (entry) => `${entry.objectApiName}: ${firedWords(entry)} (${DELETE_WHEN_WORDS[entry.when]})`,
    );
    parts.push(
      `${target} runs automation on the records ${words.this} deletes: ${named.join('; ')}.`,
    );
  }
  if (swept.length > 0) {
    const named = swept.map(
      (entry) => `${entry.objectApiName}: ${firedWords(entry)} (${DELETE_WHEN_WORDS[entry.when]})`,
    );
    parts.push(
      `${target} runs automation on the records ${REMOVAL_STEPS_SUBJECT_WORDS.reloadSweep.this} ` +
        `deletes: ${named.join('; ')}.`,
    );
  }
  for (const { part, reason } of unread) {
    parts.push(
      `${UNREAD_WORDS[part][0].toUpperCase()}${UNREAD_WORDS[part].slice(1)} of ${target} ` +
        `could not be read (${reason}), so what fires as ${words.the} writes is not known.`,
    );
  }
  parts.push(...bypassAssistantSentences(options.assign ?? [], target, words.who));
  parts.push(...muteSentences(options.assign ?? [], words.run, options.mayMute === true));
  parts.push(
    `Nothing was written or deleted. Add --accept-automation to ${words.verb} all the same, or ` +
      `turn that automation off in ${target} first.`,
  );
  return parts.join(' ');
}

/**
 * What writes the steps a refusal names: a removal that takes a run back,
 * the purge a reload runs before it loads, which deletes as a removal does,
 * or the sweep asked with that reload. Said in a removal's words, the refusal
 * of a reload told a pipeline to "remove all the same" a load it had asked to
 * replace; said in the purge's, the sweep's refusal named the tasks it took as
 * the purge's deletes.
 */
export type RemovalStepsSubject = 'removal' | 'reload' | 'reloadSweep';

/** The words of each {@link RemovalStepsSubject}: what writes, as whom, and what to add. */
const REMOVAL_STEPS_SUBJECT_WORDS: Readonly<
  Record<RemovalStepsSubject, { this: string; the: string; who: string; run: string; verb: string }>
> = {
  removal: {
    this: 'this removal',
    the: 'the removal',
    who: 'the removal',
    run: 'removal',
    verb: 'remove',
  },
  reload: {
    this: "this reload's purge",
    the: "the reload's purge",
    who: 'the reload',
    run: 'reload',
    verb: 'reload',
  },
  reloadSweep: {
    this: "this reload's sweep",
    the: "the reload's sweep",
    who: 'the reload',
    run: 'reload',
    verb: 'reload',
  },
};
