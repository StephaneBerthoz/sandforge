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

import { z } from 'zod';
import {
  BYTES_PER_MB,
  assignPermsetCommand,
  bypassAssignmentsOf,
  bypassesOfWrites,
  firedOnRemovalOf,
  firedOnWriteOf,
  heldBypassPermissionsOf,
  orgTypeToGuardTier,
} from '@sandforge/shared';
import type {
  ForgeEmailLimit,
  ForgeEmailsPerInsert,
  ForgeFiredOnWrite,
  ForgeGraph,
  ForgeRemovalRisk,
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
  SafetyTier,
  WriteConfirmationStorage,
} from '../../core/precheck/ProductionGuard.js';
import type { ForgeWriteBoundary } from './ForgeExecutor.js';
import { ordersTheWrite } from './stages/ScopeResolver.js';
import { objectsTheRunWrites } from './TargetAutomationReader.js';

/**
 * Whether an org's edition, as `Organization.OrganizationType` gives it, is a
 * Developer Edition org's — a Trailhead playground is one.
 *
 * Such an org says `IsSandbox` false, and is registered as a production org,
 * while it holds nobody's business: refused as one, it left those who try
 * SandForge with no sandbox of their own nowhere to clone into.
 */
export function isDeveloperEdition(edition: unknown): boolean {
  return typeof edition === 'string' && edition.trim().toLowerCase() === 'developer edition';
}

/**
 * The tier a Forge run takes its target for: the guard's tier of the org's
 * type, except a Developer Edition org, which the guard reads as production,
 * taken for the development org it is. An org whose edition is not known
 * stays production, as an org of unknown type does to the guard.
 *
 * @param orgType - The type the org was registered with.
 * @param edition - Its edition, as kept when it was connected.
 */
export function forgeTargetTier(orgType: string, edition: unknown): SafetyTier {
  const tier = orgTypeToGuardTier(orgType);
  return tier === 'production' && isDeveloperEdition(edition) ? 'development' : tier;
}

/** The volume past which the extension asks before a run writes (`sandforge.safety.confirmAboveRecords`). */
export const DEFAULT_CONFIRM_ABOVE_RECORDS = 2_000;

/** The most records a command-line clone writes unless `--max-total` says otherwise. */
export const DEFAULT_MAX_TOTAL = 10_000;

/**
 * The most rows of one object a run of the panel reads without asking first.
 *
 * A run holds every row it reads of an object until it has cleaned and
 * written them: the second pass, the rows held back for want of a parent and
 * the check that no two rows share an upsert key all take the object whole.
 * With Records per object on "All", nothing bounded that read — a cap is the
 * only bound a run of whole tables has, and a clone of one record reads all
 * its record reaches — and a table of millions of rows would go into the
 * extension host's memory, with nothing said before it.
 */
export const READ_CEILING_PER_OBJECT = 50_000;

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
  rows: number;
  storageBytes: number;
}

/** What a run is about to write: per object, the most first, and in all. */
export interface WritePlan {
  objects: WritePlanObject[];
  totalRows: number;
  storageBytes: number;
}

/** The rows a run is about to write, counted and measured. An object with none is left out. */
export function writePlanOf(objects: ForgeWriteBoundary['objects']): WritePlan {
  const measured = objects
    .filter(({ rows }) => rows.length > 0)
    .map(({ objectApiName, rows }) => ({
      objectApiName,
      rows: rows.length,
      storageBytes: rows.reduce((sum, row) => sum + rowStorageBytes(objectApiName, row), 0),
    }))
    .sort((a, b) => b.rows - a.rows || a.objectApiName.localeCompare(b.objectApiName));
  return {
    objects: measured,
    totalRows: measured.reduce((sum, object) => sum + object.rows, 0),
    storageBytes: measured.reduce((sum, object) => sum + object.storageBytes, 0),
  };
}

/** What an org says of its data storage, in MB. */
export interface DataStorage {
  maxMB: number;
  remainingMB: number;
}

/** The part of a connection reading an org's limits needs. */
export interface LimitsTransport {
  request(request: { method: 'GET'; url: string }): Promise<unknown>;
}

/** What `/limits` says of an org's data storage. */
const dataStorageSchema = z
  .object({
    DataStorageMB: z.object({ Max: z.number(), Remaining: z.number() }).loose(),
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

/** The emails a run's inserts make the target send against one daily limit, and what is left of it. */
export interface EmailCheck {
  limit: ForgeEmailLimit;
  /** The emails, per object: the records inserted and the emails each sends. */
  objects: Array<{ objectApiName: string; rows: number; perRecord: number; sentBy: string[] }>;
  emails: number;
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

/** How each daily email limit is said. */
const EMAIL_LIMIT_WORDS: Readonly<Record<ForgeEmailLimit, string>> = {
  SingleEmail: 'single emails',
  DailyWorkflowEmails: 'workflow emails',
};

/** What the command's write gate says of the emails the rows make the target send. */
export function emailCheckLines(checks: readonly EmailCheck[], org: string): string[] {
  return checks.map((check) => {
    const words = EMAIL_LIMIT_WORDS[check.limit];
    const per = check.objects
      .map((o) => `${o.perRecord} per ${o.objectApiName}, by ${o.sentBy.join(', ')}`)
      .join('; ');
    const sent = `  emails: these records make ${org} send about ${check.emails} ${words} (${per})`;
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
  ForgeRunGateCode | 'MAX_TOTAL_EXCEEDED' | 'AUTOMATION_NOT_ACCEPTED';

/**
 * Raised when a run's gate stops it: before it reads anything, or once it has
 * read the rows it was about to write and before it writes the first. Nothing
 * was written.
 */
export class ForgeRunGateError extends Error {
  readonly code: ForgeRunGateErrorCode;
  /** For a refusal for storage: what the rows take, and what the target had left, in MB. */
  readonly storage?: { estimateMB: number; remainingMB: number };

  constructor(
    code: ForgeRunGateErrorCode,
    message: string,
    storage?: { estimateMB: number; remainingMB: number },
  ) {
    super(message);
    this.name = 'ForgeRunGateError';
    this.code = code;
    if (storage) this.storage = storage;
  }

  /** The stop as the page is told it; none for a code of the command line's own. */
  get stop(): ForgeRunGateStop | undefined {
    if (this.code === 'MAX_TOTAL_EXCEEDED' || this.code === 'AUTOMATION_NOT_ACCEPTED') {
      return undefined;
    }
    return this.storage ? { code: this.code, storage: this.storage } : { code: this.code };
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
