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
  FORGE_READ_CEILING_PER_OBJECT,
  assignPermsetCommand,
  bypassAssignmentsOf,
  bypassesOfWrites,
  emailsPerInsertOf,
  firedOnRemovalOf,
  firedOnRemovalStepsOf,
  firedOnWriteOf,
  heldBypassPermissionsOf,
} from '@sandforge/shared';
import type {
  ForgeConfig,
  ForgeEmailLimit,
  ForgeEmailsPerInsert,
  ForgeFiredOnRemovalStep,
  ForgeFiredOnWrite,
  ForgeGraph,
  ForgeRemovalRisk,
  ForgeRemovalStep,
  ForgeRemovalSteps,
  ForgeRunGateCode,
  ForgeRunGateStop,
  ForgeTargetAutomation,
} from '@sandforge/shared';
import {
  ACCOUNT,
  CONTACT,
  EMAIL_MESSAGE,
  FLAGS_THE_PLATFORM_LEAVES,
  STATUS_LIFECYCLES,
  isPersonAccountRow,
} from '../../core/common/platformRecords.js';
import type {
  AutomationConfirmation,
  BypassToAssign,
  FiredOnInsert,
  RunUpdateStep,
  WriteConfirmation,
  WriteConfirmationStorage,
} from '../../core/precheck/ProductionGuard.js';
import type { ForgeWriteBoundary } from './ForgeExecutor.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { ordersTheWrite } from './stages/ScopeResolver.js';
import { objectsTheRunWrites } from './TargetAutomationReader.js';

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
  if (objectApiName === EMAIL_MESSAGE) return textBytes(row);
  if (objectApiName === ACCOUNT) {
    return isPersonAccountRow(row) ? PERSON_ACCOUNT_BYTES : RECORD_BYTES;
  }
  if (objectApiName === CONTACT && isPersonAccountRow(row)) return 0;
  if (objectApiName === 'Campaign') return CAMPAIGN_BYTES;
  if (objectApiName === 'CampaignMember') return CAMPAIGN_MEMBER_BYTES;
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
  /** Per object held back whole for a record type closed to the user the run writes as, its rows. */
  heldBack: Array<{ objectApiName: string; rows: number }>;
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
  if (objectApiName === ACCOUNT) return others * RECORD_BYTES + persons * PERSON_ACCOUNT_BYTES;
  if (objectApiName === CONTACT) return others * RECORD_BYTES;
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
    .map(({ objectApiName, rows, counted, mayAdd = 0 }): WritePlanObject => {
      const more = {
        rows: mayAdd,
        storageBytes: mayAdd * rowStorageBytes(objectApiName, {}),
        ...(mayAdd > 0 ? { mayAdd } : {}),
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
  return {
    objects: measured,
    totalRows: measured.reduce((sum, object) => sum + object.rows, 0),
    storageBytes: measured.reduce((sum, object) => sum + object.storageBytes, 0),
    ...(writtenBefore > 0 || heldBack.length > 0 ? { leftOut: { writtenBefore, heldBack } } : {}),
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

/** What an org says of its data storage, in MB. */
export interface DataStorage {
  maxMB: number;
  remainingMB: number;
  /**
   * The daily API requests it has, read from the same answer: absent when
   * the answer did not list them.
   */
  dailyApiRequests?: ApiBudget;
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

/** What `/limits` says of an org's data storage, and of its daily API requests when it lists them. */
const dataStorageSchema = z
  .object({
    DataStorageMB: z.object({ Max: z.number(), Remaining: z.number() }).loose(),
    DailyApiRequests: z.object({ Max: z.number(), Remaining: z.number() }).loose().optional(),
  })
  .loose();

/** What `/limits` says of an org's daily API requests. */
const apiBudgetSchema = z
  .object({
    DailyApiRequests: z.object({ Max: z.number(), Remaining: z.number() }).loose(),
  })
  .loose();

/**
 * The data storage an org has, as its `/limits` say. The org may refuse it to
 * the user the run writes as; the caller says so, and never takes it for
 * enough.
 */
export async function readDataStorage(transport: LimitsTransport): Promise<DataStorage> {
  const limits = dataStorageSchema.parse(
    await transport.request({ method: 'GET', url: '/limits' }),
  );
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
  };
}

/**
 * The daily API requests an org has left, as its `/limits` say: for a run
 * that reads nothing else of them. The org may refuse it to the user the run
 * writes as; the caller says so, and never takes it for enough.
 */
export async function readApiBudget(transport: LimitsTransport): Promise<ApiBudget> {
  const limits = apiBudgetSchema.parse(await transport.request({ method: 'GET', url: '/limits' }));
  return { max: limits.DailyApiRequests.Max, remaining: limits.DailyApiRequests.Remaining };
}

/** Records a REST call writes, as the runs send them. */
const ROWS_PER_REST_CALL = 200;
/** Records a Bulk API job takes before another is opened. */
const ROWS_PER_BULK_JOB = 10_000;
/** The calls a Bulk API job costs: open, upload, close, and polling it. */
const CALLS_PER_BULK_JOB = 5;
/** Records a query page reads. */
const ROWS_PER_READ = 2_000;
/**
 * The share of its daily requests an org may be left with, under which a run
 * that asks before it writes says so.
 */
export const API_BUDGET_NEAR_SHARE = 0.1;

/**
 * The calls a run makes of the org it writes to, roughly: per object, a REST
 * call per {@link ROWS_PER_REST_CALL} records, or {@link CALLS_PER_BULK_JOB} per
 * Bulk API job of {@link ROWS_PER_BULK_JOB}, and a call per page of
 * {@link ROWS_PER_READ} records it reads of that org.
 */
export function runRequestsEstimate(
  objects: ReadonlyArray<{ rows: number; bulk?: boolean; readRows?: number }>,
): number {
  return objects.reduce((sum, { rows, bulk, readRows }) => {
    const writes =
      rows <= 0
        ? 0
        : bulk
          ? CALLS_PER_BULK_JOB * Math.ceil(rows / ROWS_PER_BULK_JOB)
          : Math.ceil(rows / ROWS_PER_REST_CALL);
    const reads = readRows && readRows > 0 ? Math.ceil(readRows / ROWS_PER_READ) : 0;
    return sum + writes + reads;
  }, 0);
}

/** The calls a run makes against what the org it writes to has left today, or why that is not known. */
export type ApiBudgetCheck =
  | { verdict: 'fits' | 'near' | 'exceeds'; estimate: number; max: number; remaining: number }
  | { verdict: 'unread'; estimate: number; unread: string };

/**
 * A run's calls against the target's daily API requests: `exceeds` past what
 * it has left, `near` when the run would leave it under
 * {@link API_BUDGET_NEAR_SHARE} of its daily limit, `unread` when it did not
 * say. Only Forge's Review compared them: a seed, a sync or an Autopilot run
 * into an org whose integrations had used the day's requests stopped part way
 * through, its records refused with REQUEST_LIMIT_EXCEEDED.
 */
export function apiBudgetCheckOf(
  estimate: number,
  budget: ApiBudget | { unread: string } | undefined,
): ApiBudgetCheck {
  if (!budget) {
    return {
      verdict: 'unread',
      estimate,
      unread: 'the limits the org answered list no DailyApiRequests',
    };
  }
  if ('unread' in budget) return { verdict: 'unread', estimate, unread: budget.unread };
  const { max, remaining } = budget;
  const verdict =
    estimate > remaining
      ? 'exceeds'
      : remaining - estimate < API_BUDGET_NEAR_SHARE * max
        ? 'near'
        : 'fits';
  return { verdict, estimate, max, remaining };
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
    `The run takes about ${check.estimate} API requests, and ${target} has ${check.remaining} ` +
    `of its ${check.max} daily requests left: it would stop part way through, its records ` +
    'refused with REQUEST_LIMIT_EXCEEDED. Run it once the org has requests to spare — the ' +
    'limit is counted over the last 24 hours — or write fewer records. Nothing was written.'
  );
}

/** The API requests of a check, as a run's question says them: only when they run short. */
export function confirmationApiOf(
  check: ApiBudgetCheck,
): { apiRequests: { estimate: number; remaining: number; max: number } } | Record<string, never> {
  return check.verdict === 'near'
    ? { apiRequests: { estimate: check.estimate, remaining: check.remaining, max: check.max } }
    : {};
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
 * The emails each record of an object makes the org send, per daily limit,
 * as the org counts them: the email alerts counted against the single emails
 * as well where the org counts them there.
 *
 * @param alertsAsSingle - Whether the org counts its email alerts against its
 *   single emails ({@link alertsCountAsSingle}).
 */
export function emailsCountedPerRecord(
  perInsert: readonly ForgeEmailsPerInsert[],
  alertsAsSingle: boolean,
): ForgeEmailsPerInsert[] {
  const out = perInsert.map((sending) => ({ ...sending, sentBy: [...sending.sentBy] }));
  if (!alertsAsSingle) return out;
  for (const alert of perInsert.filter((sending) => sending.limit === 'DailyWorkflowEmails')) {
    const single = out.find(
      (sending) => sending.objectApiName === alert.objectApiName && sending.limit === 'SingleEmail',
    );
    if (!single) {
      out.push({ ...alert, limit: 'SingleEmail', sentBy: [...alert.sentBy] });
      continue;
    }
    single.perRecord += alert.perRecord;
    for (const name of alert.sentBy) if (!single.sentBy.includes(name)) single.sentBy.push(name);
  }
  return out;
}

/** The emails a run's inserts make the target send against one daily limit, and what is left of it. */
export interface EmailCheck {
  limit: ForgeEmailLimit;
  /** The emails, per object: the records inserted and the emails each sends. */
  objects: Array<{ objectApiName: string; rows: number; perRecord: number; sentBy: string[] }>;
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
 * The emails the rows about to be written make the target send, per daily
 * limit, against what it has left. Only limits the inserts send emails
 * against are checked; none, and there is nothing to read.
 *
 * Run for real into a Developer Edition, a contact flow's Send Email took
 * the org past its fifteen single emails a day, and thirty contacts were
 * refused, `CANNOT_EXECUTE_FLOW_TRIGGER` "Probably Limit Exceeded": emails
 * neutralized under `.invalid` count all the same.
 */
export function emailChecksOf(
  plan: Pick<WritePlan, 'objects'>,
  perInsert: readonly ForgeEmailsPerInsert[],
  limits: Partial<Record<ForgeEmailLimit, EmailLimit>> | { unread: string },
): EmailCheck[] {
  const rows = new Map(plan.objects.map((object) => [object.objectApiName, object.rows]));
  const byLimit = new Map<ForgeEmailLimit, EmailCheck>();
  for (const sending of perInsert) {
    const inserted = rows.get(sending.objectApiName) ?? 0;
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
  plan: Pick<WritePlan, 'objects'>,
  perInsert: readonly ForgeEmailsPerInsert[],
  limits: Partial<Record<ForgeEmailLimit, EmailLimit>> | { unread: string },
): EmailCheck[] {
  const alertsAsSingle = !isUnread(limits) && alertsCountAsSingle(limits);
  const checks = emailChecksOf(plan, emailsCountedPerRecord(perInsert, alertsAsSingle), limits);
  if (!alertsAsSingle) return checks;
  const written = new Set(
    plan.objects.filter((object) => object.rows > 0).map((object) => object.objectApiName),
  );
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
  /** Why the target's automation, or its limits, could not be read; absent when they were. */
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
  const sending = emailsPerInsertOf(automation);
  if (sending.length === 0) return { checks: [] };
  const limits = await input
    .readLimits()
    .catch((err: unknown) => ({ unread: extractErrorMessage(err) }));
  // Counted as the target counts them: a Developer Edition's email alerts
  // against its single emails too, as Seed counts them.
  return { checks: countedEmailChecksOf(input.plan, sending, limits) };
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

/** How each daily email limit is said. */
const EMAIL_LIMIT_WORDS: Readonly<Record<ForgeEmailLimit, string>> = {
  SingleEmail: 'single emails',
  DailyWorkflowEmails: 'workflow emails',
};

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
        `about ${check.emails} ${EMAIL_LIMIT_WORDS[check.limit]}` +
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
    const words = EMAIL_LIMIT_WORDS[check.limit];
    const per = check.objects
      .map((o) => `${o.perRecord} per ${o.objectApiName}, by ${o.sentBy.join(', ')}`)
      .join('; ');
    const sent =
      `  emails: these records make ${org} send about ${check.emails} ${words} (${per})` +
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
  if (megabytes <= 0) return '0';
  const factor = megabytes < 10 ? 100 : 10;
  // The epsilon keeps a value the float holds a hair above its decimal —
  // 4.69 × 100 is 469.00000000000006 — from rounding up a step.
  return (Math.ceil(megabytes * factor - 1e-9) / factor).toString();
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

/** The codes a run's gate stops it with: the extension's, and the command line's own. */
export type ForgeRunGateErrorCode =
  ForgeRunGateCode | 'MAX_TOTAL_EXCEEDED' | 'AUTOMATION_NOT_ACCEPTED' | 'EMAILS_EXCEEDED';

/**
 * Raised when a run's gate stops it: before it reads anything, or once it has
 * read the rows it was about to write and before it writes the first. Nothing
 * was written.
 */
export class ForgeRunGateError extends Error {
  readonly code: ForgeRunGateErrorCode;
  /** For a refusal for storage: what the rows take, and what the target had left, in MB. */
  readonly storage?: { estimateMB: number; remainingMB: number };
  /** For a run cancelled at its read: the most rows of one object it was set to read. */
  readonly ceiling?: number;

  constructor(
    code: ForgeRunGateErrorCode,
    message: string,
    storage?: { estimateMB: number; remainingMB: number },
    ceiling?: number,
  ) {
    super(message);
    this.name = 'ForgeRunGateError';
    this.code = code;
    if (storage) this.storage = storage;
    if (ceiling !== undefined) this.ceiling = ceiling;
  }

  /** The stop as the page is told it; none for a code of the command line's own. */
  get stop(): ForgeRunGateStop | undefined {
    if (
      this.code === 'MAX_TOTAL_EXCEEDED' ||
      this.code === 'AUTOMATION_NOT_ACCEPTED' ||
      this.code === 'EMAILS_EXCEEDED'
    ) {
      return undefined;
    }
    return {
      code: this.code,
      ...(this.storage ? { storage: this.storage } : {}),
      ...(this.ceiling !== undefined ? { ceiling: this.ceiling } : {}),
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
 * resumes wrote, and an object held back whole for a record type.
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
      `  not counted: ${objectApiName}, ${rows} record(s), held back whole for a record type ` +
        'closed to the user the run writes as',
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
 * What the command line says before a run of what may refuse the removal of
 * its records (`--remove`): per object it writes, the flows before a delete,
 * the Apex triggers on one — a managed package's apart — and the records that
 * lock past Draft; or that none was found.
 */
export function removalRiskLines(risks: readonly ForgeRemovalRisk[], target: string): string[] {
  if (risks.length === 0) {
    return [
      `reversibility: nothing found in ${target} that refuses a removal of this run's records ` +
        '(no flow before a delete, no Apex trigger on one, no record that locks past Draft)',
    ];
  }
  return [
    `reversibility: a removal of this run's records (--remove) may be refused in ${target}:`,
    ...risks.map(
      ({ objectApiName, kind, name }) =>
        `  ${objectApiName}: ${REMOVAL_RISK_WORDS[kind](name ?? '')}`,
    ),
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
 * Why the command line will not write without `--accept-automation`: what the
 * target runs as the clone inserts its records, and as it updates those of
 * `updated`, named, or what of it could not be read; then, for a bypass the
 * user does not hold, the permission set and the command that would assign
 * it. Nothing when nothing fires and everything was read.
 *
 * @param options - The objects the clone updates after inserting them, and
 *   the bypasses to assign ({@link bypassesToAssign}).
 */
export function automationRefusal(
  automation: Pick<ForgeTargetAutomation, 'objects' | 'unread'>,
  target: string,
  options: { updated?: readonly UpdatedAfterInsert[]; assign?: readonly BypassToAssign[] } = {},
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
 * @param options - The objects the removal sets back to Draft, and the
 *   bypasses to assign ({@link bypassesToAssign}).
 */
export function removalAutomationRefusal(
  automation: Pick<ForgeTargetAutomation, 'objects' | 'unread'>,
  target: string,
  options: { drafted?: readonly string[]; assign?: readonly BypassToAssign[] } = {},
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
): string[] {
  const lines = [`removal automation: what ${target} runs as the removal takes the run back`];
  for (const entry of firedOnRemovalStepsOf(automation, steps)) {
    lines.push(
      entry.step === 'delete'
        ? `  ${entry.objectApiName}: ${DELETE_WHEN_WORDS[entry.when]}: ${firedWords(entry)}`
        : `  ${entry.objectApiName}: ${REMOVAL_STEP_WORDS[entry.step]}: ${firedWords(entry)}`,
    );
  }
  const unread = automationUnreadOf(automation);
  if (lines.length === 1 && unread.length === 0) {
    const objects = new Set(Object.values(steps).flat()).size;
    lines.push(`  nothing fires on the ${objects} object(s) it writes records of`);
  }
  for (const { part, reason } of unread) {
    lines.push(`  ${UNREAD_WORDS[part]} could not be read: ${reason}`);
  }
  return lines;
}

/**
 * Why the command line will not take a whole run back without
 * `--accept-automation`: what the target runs as each step of the removal
 * writes ({@link removalStepsAutomationLines}), named, or what of it could
 * not be read; then the bypasses to assign. Nothing when nothing fires and
 * everything was read.
 *
 * @param options - What each step writes, and the bypasses to assign
 *   ({@link bypassesToAssign}).
 */
export function removalStepsAutomationRefusal(
  automation: Pick<ForgeTargetAutomation, 'objects' | 'unread'>,
  target: string,
  options: { steps: ForgeRemovalSteps; assign?: readonly BypassToAssign[] },
): string | undefined {
  const fired = firedOnRemovalStepsOf(automation, options.steps);
  const unread = automationUnreadOf(automation);
  if (fired.length === 0 && unread.length === 0) return undefined;
  const of = (step: ForgeRemovalStep): ForgeFiredOnRemovalStep[] =>
    fired.filter((entry) => entry.step === step);
  const parts: string[] = [];
  if (of('bringBack').length > 0) {
    parts.push(
      `${target} runs automation as this removal brings back from the recycle bin what the ` +
        `run deleted: ${namedList(of('bringBack'))}.`,
    );
  }
  if (of('giveBack').length > 0) {
    parts.push(
      `${target} runs automation as this removal gives the records the run wrote over their ` +
        `values from before it: ${namedList(of('giveBack'))}.`,
    );
  }
  if (of('setToDraft').length > 0) {
    parts.push(
      `${target} runs automation as this removal sets activated records back to Draft, the ` +
        `only way the platform deletes them: ${namedList(of('setToDraft'))}.`,
    );
  }
  if (of('delete').length > 0) {
    const named = of('delete').map(
      (entry) => `${entry.objectApiName}: ${firedWords(entry)} (${DELETE_WHEN_WORDS[entry.when]})`,
    );
    parts.push(
      `${target} runs automation on the records this removal deletes: ${named.join('; ')}.`,
    );
  }
  for (const { part, reason } of unread) {
    parts.push(
      `${UNREAD_WORDS[part][0].toUpperCase()}${UNREAD_WORDS[part].slice(1)} of ${target} ` +
        `could not be read (${reason}), so what fires as the removal writes is not known.`,
    );
  }
  parts.push(...bypassAssistantSentences(options.assign ?? [], target, 'the removal'));
  parts.push(
    `Nothing was written or deleted. Add --accept-automation to remove all the same, or turn ` +
      `that automation off in ${target} first.`,
  );
  return parts.join(' ');
}
