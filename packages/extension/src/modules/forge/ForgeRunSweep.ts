/**
 * The sweep a removal of a Forge run, or of a Frozen load, may be asked to
 * make before the run's own records go: what the target's automation created
 * during the run, as the run's user, that the run's id map does not hold.
 * Made after them, a record the automation hung under one of the run's after
 * its last write held that record back as a record that stays.
 *
 * Run for real into a client sandbox, a clone of 1 284 records made the
 * target's automation create some 585 more in the same minute, as the user
 * the run wrote as: 484 feed items, 66 assets — a Case flow "cloned the
 * insured risk" into a new Asset for each case and linked it — and 35 tasks.
 * No remap held them, and a removal takes back only what the run wrote: some
 * went in cascade with their parents, the assets stayed.
 *
 * What a sweep looks at:
 * - the window: the run's writes as the target dated them
 *   (`ForgeWrittenBetween`), from {@link SWEEP_LEAD_MS} before the first to
 *   {@link SWEEP_TRAIL_MS} after the last — the org dates a record to the
 *   second, and what the target's automation does once the save is committed
 *   (an asynchronous path, a queued job) lands seconds after the write;
 * - the user: the one the run kept it wrote as, or else the one who created
 *   the run's records, read from them, in the org or its recycle bin — the
 *   run's own records may be gone by then;
 * - the objects the run wrote, the objects the platform and its automation
 *   commonly fill beside a record ({@link SWEEP_SIDE_OBJECTS}), and the
 *   objects the target's flows on the run's objects create
 *   (`ForgeTargetFlow.creates`), said when they could not all be read;
 * - minus every record the run's id map holds: what the run wrote, linked to
 *   or matched; and never an object of {@link NEVER_SWEPT}.
 *
 * A sweep takes only what is tied to the run ({@link SweepInput.ties},
 * {@link sweepTiesOf}). The run's user is not proof enough: a quote line the
 * platform copied from an opportunity line the run inserted carries the run's
 * user as its creator, as the run's own lines do.
 * Every child object of the run's objects is looked at too, counted first,
 * five counts a composite where the org lets them go so
 * ({@link SweepOrg.counts}), {@link SWEEP_LOOK_BOUND} objects at most; what is
 * tied goes (`made`, `madeOver`), what came late or tied to nothing is listed
 * and kept unless asked for (`sweepLate`, `sweepUntied`), and a record a
 * record of the run points at by a lookup the org refuses its delete for —
 * the asset a case of the run names — waits for that record to go
 * ({@link sweepParts}). The ties are read before the sweep's first delete:
 * once a record of the run is deleted, a lookup the org clears with it
 * (`Task.AccountId`) no longer tells the tie.
 *
 * Hand work is not swept: records the run's user created in the window on
 * objects people make by hand ({@link HAND_WORK_OBJECTS}), tied to nothing of
 * the run, are said, left, and refuse what is tied to nothing. Nothing outside
 * the window, or created by anyone else, is ever deleted: each row the org
 * answers is checked again against both before its delete is sent.
 */

import type {
  AuditObjectCounts,
  ForgeRemovalLeftCount,
  ForgeRemovalSpan,
  ForgeSweepAutomationGaps,
  ForgeSweepClasses,
  ForgeSweepFound,
  ForgeSweepLeftClass,
  ForgeSweepListing,
  ForgeSweepObjectResult,
  ForgeSweepMark,
  ForgeSweepResult,
  ForgeSweepUnread,
  ForgeSweepWindow,
  ForgeTargetAutomation,
  ForgeUndoStatus,
  ForgeWrittenBetween,
} from '@sandforge/shared';

import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { readOtherColumns, wideStatement } from '../../core/common/wideRead.js';
import { emptyCounts } from '../audit/auditTrail.js';
import type { CompositeReader } from '../checkpoint/compositeQueries.js';
import { describedObjectSchema, type DescribedObject } from '../dataops/DataQualityScanner.js';
import { idLists, readRecordsById, RECORDS_PER_CALL } from '../dataops/RecordRemoval.js';
import {
  deleteBatch,
  removalOrder,
  takenAlong,
  type DeleteOutcome,
  type RecordKeys,
  type RemovalOrg,
} from './ForgeRunRemoval.js';
import {
  LATE_WITHIN_MS,
  SAME_SAVE_MS,
  sweepTiesOf,
  type SweepAnchor,
  type SweepCandidate,
  type SweepClass,
  type SweepPointer,
  type SweepReference,
  type SweepTie,
  type SweepTurn,
} from './sweepTies.js';

/**
 * The objects the platform and the target's automation commonly fill beside
 * a record it was saved for: activities, feed, email messages, notes, case
 * comments and file links. Looked at by every sweep, whatever the run wrote.
 */
export const SWEEP_SIDE_OBJECTS: readonly string[] = [
  'Task',
  'Event',
  'FeedItem',
  'FeedComment',
  'EmailMessage',
  'ContentDocumentLink',
  'Note',
  'CaseComment',
];

/**
 * Objects a person creates by hand. A record the run's user created in the
 * window, tied to nothing of the run, is taken for hand work on any of them,
 * the run's own objects among them: never swept, and it refuses what is tied
 * to nothing.
 */
export const HAND_WORK_OBJECTS: readonly string[] = [
  'Account',
  'Contact',
  'Lead',
  'Opportunity',
  'Case',
  'Campaign',
  'Contract',
  'Order',
  'Asset',
  'Product2',
];

/**
 * Objects no sweep ever looks at, whatever created their records in the
 * window: users, groups and their members, permission sets and their
 * assignments, record types, profiles and roles. The permission sets a run's
 * mute assigned are created by the run's user in its window: swept as tied to
 * nothing, they would take the bypass from another run under way.
 */
export const NEVER_SWEPT: readonly string[] = [
  'User',
  'Group',
  'GroupMember',
  'PermissionSet',
  'PermissionSetAssignment',
  'PermissionSetGroup',
  'RecordType',
  'Profile',
  'UserRole',
];

/** How far before the run's first write a sweep looks: the second the org dates a record to. */
export const SWEEP_LEAD_MS = 1_000;

/**
 * How far after the run's last write a sweep looks: what the target's
 * automation runs once the save is committed — an asynchronous path, a queued
 * job, a platform event's subscriber — writes seconds after the record.
 */
export const SWEEP_TRAIL_MS = 60_000;

/**
 * The most records a sweep takes of one object. Past it, none of them is
 * swept: that many records created in the run's window are more than a run's
 * side effects are known to come to, and are said rather than deleted.
 */
export const SWEEP_OBJECT_BOUND = 10_000;

/**
 * The most objects a sweep counts the records of: the run's objects, the side
 * objects, what the automation creates and the hand-work objects first, then
 * the children of the run's objects. An account has some
 * 165 child objects on a scratch org; past the bound, the rest are named, not
 * looked at. Kept from the design until P2-4 (a tour 0 probe deferred: how
 * many objects are left of an account's, a contact's, a case's, an
 * opportunity's and a quote's children once filtered) counts them.
 */
export const SWEEP_LOOK_BOUND = 300;

/** Rows one read of an object's records takes: the most one page of a query answers. */
const PAGE = 2_000;

/** The run's records read per object to tell the user it wrote as. */
const USER_SAMPLE = 50;

/** Objects whose records are read for that user before it is taken as told. */
const USER_SAMPLE_OBJECTS = 3;

/** Names said per object a sweep found records of. */
const NAMES_SHOWN = 3;

/** Reasons kept per object: an org repeats the same few. */
const REASON_LIMIT = 5;

/** The parts of an automation read whose refusal leaves what its flows create unknown. */
const CREATING_PARTS: ReadonlySet<string> = new Set([
  'flows',
  'processes',
  'triggers',
  'conditions',
  'definitions',
]);

/**
 * The lookups a tie is never read from: who owns, created and last modified a
 * record, and its record type, point at no record a run creates.
 */
const NOT_A_TIE: ReadonlySet<string> = new Set([
  'OwnerId',
  'CreatedById',
  'LastModifiedById',
  'RecordTypeId',
]);

/** A 15- or 18-character Salesforce id. */
const SF_ID_RE = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** A record by its first fifteen characters: the same record, whichever length its id is written in. */
function recordKey(id: string): string {
  return id.slice(0, 15);
}

/** A date the org wrote, in epoch milliseconds; NaN when there is none to read. */
function epochOf(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : Number.NaN;
}

/** A date as a SOQL literal takes it, to the second. */
function soqlDate(epoch: number): string {
  return new Date(epoch).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The window a sweep looks in, in epoch milliseconds. */
interface Window {
  from: number;
  to: number;
}

/**
 * The window a sweep looks in, from the run's writes as the target dated
 * them: a second before the first, a minute after the last, each to the
 * second. Undefined for a run whose writes were not dated.
 */
export function sweepWindowOf(
  written: ForgeWrittenBetween | undefined,
): ForgeSweepWindow | undefined {
  const window = windowOf(written);
  return window && { from: soqlDate(window.from), to: soqlDate(window.to) };
}

function windowOf(written: ForgeWrittenBetween | undefined): Window | undefined {
  const first = epochOf(written?.first);
  const last = epochOf(written?.last);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return undefined;
  return {
    from: Math.floor((first - SWEEP_LEAD_MS) / 1000) * 1000,
    to: Math.ceil((Math.max(first, last) + SWEEP_TRAIL_MS) / 1000) * 1000,
  };
}

/** What a sweep reads of the target's automation: the objects its flows create, and what it could not tell. */
export interface SweepAutomation {
  creates: string[];
  gaps?: ForgeSweepAutomationGaps;
}

/**
 * The objects the target's flows and processes create when the run's
 * records are saved, from what the target runs on the run's objects; and
 * what of it could not be told — a flow whose metadata was not read, an Apex
 * trigger, which no metadata reads for what it creates, a part of the read
 * the org refused. A flow that starts on a delete fires on the removal, not
 * on the run, and is left out.
 *
 * @param automation - The read, or why it failed.
 */
export function sweepAutomationOf(
  automation: ForgeTargetAutomation | { error: string },
): SweepAutomation {
  if ('error' in automation) {
    return { creates: [], gaps: { flowsNotRead: 0, triggers: 0, error: automation.error } };
  }
  const creates: string[] = [];
  let flowsNotRead = 0;
  let triggers = 0;
  for (const object of automation.objects) {
    for (const flow of [...object.flows, ...(object.processes ?? [])]) {
      if (flow.startsOn === 'delete') continue;
      if (flow.condition !== 'read') flowsNotRead++;
      for (const name of flow.creates ?? []) {
        if (!creates.some((known) => known.toLowerCase() === name.toLowerCase()))
          creates.push(name);
      }
    }
    triggers += object.triggers.filter((trigger) =>
      trigger.events.some((event) => event !== 'beforeDelete' && event !== 'afterDelete'),
    ).length;
  }
  const refused = automation.unread
    .filter((part) => CREATING_PARTS.has(part.part))
    .map((part) => part.reason);
  if (flowsNotRead === 0 && triggers === 0 && refused.length === 0) return { creates };
  return {
    creates,
    gaps: {
      flowsNotRead,
      triggers,
      ...(refused.length > 0 ? { error: [...new Set(refused)].join('; ') } : {}),
    },
  };
}

/**
 * What tells the records tied to a run from the rest of what its user
 * created in its window ({@link sweepTiesOf}), beside the records it created
 * ({@link SweepInput.created}), which tie the most.
 */
export interface SweepTies {
  /**
   * The records the run only wrote over — a Sync run's updates and matched
   * upserts — per object: what is tied to them alone is `madeOver`. With the
   * span of their writes on the org's clock when the run kept it; absent,
   * the run's.
   */
  writtenOver?: ReadonlyArray<{
    readonly objectApiName: string;
    readonly ids: readonly string[];
    readonly between?: ForgeWrittenBetween;
  }>;
  /**
   * The records of the runs of this machine that wrote to the target within
   * the run's window, each run's ids together: never swept, and while there
   * is one, what is tied to nothing is not swept either — whose it is cannot
   * be told. A run whose records could not be named (`idsUntold`) wrote in
   * the window all the same: nothing keeps its records from being tied, and
   * what is tied to nothing is not swept.
   */
  otherRuns?: ReadonlyArray<{ readonly ids: readonly string[]; readonly idsUntold?: true }>;
  /**
   * The ids of the assignments the run's mute created: never swept. No caller
   * has them to pass: a lease keeps no ids, and {@link NEVER_SWEPT} holds what
   * they would be ids of.
   */
  leased?: readonly string[];
  /** What the run's mute kept quiet and what still ran, said with the listing. */
  muted?: ForgeSweepListing['muted'];
  /**
   * When the run's first removal began, on the org's clock: a record created
   * since is a removal's doing, never the run's. Absent, the removal under
   * way's own start, as its spans say, or none.
   */
  removalBegan?: string;
  /**
   * The records an earlier sweep found made for the run, by id: `made` still,
   * though a removal since deleted the record they were tied to and the org
   * cleared the lookup that told it.
   */
  madeEarlier?: readonly string[];
  /**
   * The records an earlier sweep found made late for the run and left, by
   * id: `late` still, though the record they were tied to went since and the
   * org cleared the lookup that told it.
   */
  lateEarlier?: readonly string[];
}

/** What a sweep is told of the run it sweeps after. */
export interface SweepInput {
  /** When the target dated the run's writes; a run it did not date is not swept. */
  writtenBetween: ForgeWrittenBetween | undefined;
  /**
   * The records the run created, per object, by target id: the objects it
   * wrote, and the records the user it wrote as is read from. Only a few ids
   * of each are read.
   */
  created: ReadonlyArray<{ readonly objectApiName: string; readonly ids: readonly string[] }>;
  /** Every record the run's id map holds — written, linked to or matched — by key: never swept. */
  remap: RecordKeys;
  /** What the target's automation creates, as {@link sweepAutomationOf} reads it. */
  automation: SweepAutomation;
  /**
   * The user the run kept it wrote as (`runUserId`): taken before anything
   * is read to tell it.
   */
  runUserId?: string;
  /**
   * The user the run wrote as, told where none of its records can tell it: a
   * Sync run that created nothing and only wrote over records the target
   * held (`seedSweepInput`). Records the run created tell it first.
   */
  user?: string;
  /** What tells the records tied to the run, the only ones it takes, from the rest, which it lists. */
  ties: SweepTies;
  /** Stops the sweep before its next call to the org. */
  signal?: AbortSignal;
}

/**
 * The org a sweep works on: a removal's, and, where the connection carries
 * them, its counts sent several to a call.
 */
export type SweepOrg = RemovalOrg & {
  /**
   * The answers of `SELECT COUNT()` statements, in their order: each the
   * count, or why the org refused it. Five go in one composite, which costs
   * the org one request of its day as one query does
   * ({@link sweepCountsOf}). Absent, each goes in a call of its own.
   */
  counts?(statements: readonly string[]): Promise<Array<number | { reason: string }>>;
};

/**
 * The counts of a sweep sent through `reader`'s composites: five a call,
 * three calls in flight, as the checkpoint's reads send theirs.
 */
export function sweepCountsOf(
  reader: Pick<CompositeReader, 'lane'>,
): NonNullable<SweepOrg['counts']> {
  return (statements) =>
    Promise.all(
      statements.map(async (statement): Promise<number | { reason: string }> => {
        const lane = reader.lane({ oneRow: true });
        try {
          const page = await lane.query(statement);
          return page.totalSize ?? page.records.length;
        } catch (err: unknown) {
          return { reason: extractErrorMessage(err) };
        } finally {
          lane.close();
        }
      }),
    );
}

/** A record a sweep found, as far as its delete and its class need it. */
interface SweepRow {
  id: string;
  modified: number;
  modifiedBy?: string;
  /** When it was created: what tells a record changed since from a record made late. */
  created: number;
  /** Its class, which says whether it is taken. */
  class: SweepClass;
  sameSave?: boolean;
  /** When it goes against the run's own records. */
  turn: SweepTurn;
  name?: string;
}

/** What a sweep found, before it deletes anything. */
interface SweepFindings {
  listing: ForgeSweepListing;
  window?: Window;
  /** Per object, the records to sweep: an object past the bound is not among them. */
  rows: Map<string, SweepRow[]>;
  /** Whether a stop came before the reads were through. */
  stopped: boolean;
  /**
   * The org the order of the deletes is read from: the describes the sweep
   * already read, so nothing more is read once the sweep was asked.
   */
  ordering?: RemovalOrg;
}

/** An object's describe, as far as a sweep reads it. */
interface SweptObject {
  name: string;
  /** The column it is read by for when a record was last modified. */
  modified: string;
  /** The column that says who last modified a record, where the object keeps it. */
  modifiedBy?: string;
  /** The field that names a record, where the object has one. */
  nameField?: string;
  /** Its lookups a tie may be read from, by field name. */
  references: string[];
}

/**
 * The user the run wrote as, by the creator of its records, read from the
 * org and its recycle bin: a run's records may be gone by the time it is
 * swept, a removal having taken them. A few records of a few objects are
 * read; their creators must agree.
 */
async function runUserOf(
  org: RemovalOrg,
  created: SweepInput['created'],
  stopped: () => boolean,
): Promise<{ user: string } | { refusal: string }> {
  /** The id of each creator, by its key. */
  const creators = new Map<string, string>();
  let objectsRead = 0;
  let failure: string | undefined;
  for (const { objectApiName, ids } of created) {
    if (objectsRead >= USER_SAMPLE_OBJECTS || creators.size > 1 || stopped()) break;
    const sample = ids.slice(0, USER_SAMPLE);
    if (sample.length === 0) continue;
    try {
      const [list] = idLists(sample, sample.length);
      const answer = await org.queryDeleted(
        `SELECT CreatedById FROM ${assertSoqlIdentifier(objectApiName)} WHERE Id IN (${list})`,
      );
      let told = false;
      for (const row of answer.records) {
        const creator = (row as { CreatedById?: unknown } | null)?.CreatedById;
        // It goes into the sweep's queries: an id, or nothing.
        if (typeof creator === 'string' && SF_ID_RE.test(creator)) {
          if (!creators.has(recordKey(creator))) creators.set(recordKey(creator), creator);
          told = true;
        }
      }
      if (told) objectsRead++;
    } catch (err: unknown) {
      failure ??= extractErrorMessage(err);
    }
  }
  if (creators.size === 1) return { user: [...creators.values()][0] };
  if (creators.size > 1) {
    return {
      refusal:
        `The run's records were created by ${creators.size} different users: whose records ` +
        'came with the run cannot be told, and nothing is swept.',
    };
  }
  return {
    refusal:
      'The user the run wrote as could not be read: none of its records is left in the org or ' +
      `its recycle bin to tell it${failure ? ` (${failure})` : ''}. Nothing is swept.`,
  };
}

/** One object of the org's list, with what it says of its records where it says it. */
interface ListedObject {
  name: string;
  queryable?: boolean;
  deletable?: boolean;
  createable?: boolean;
  layoutable?: boolean;
}

/** The objects the org lists, by lower-cased API name, or undefined when it would not list them. */
async function objectsListed(org: RemovalOrg): Promise<Map<string, ListedObject> | undefined> {
  try {
    const global = (await org.describeGlobal()) as { sobjects?: unknown } | null;
    const sobjects = Array.isArray(global?.sobjects) ? global.sobjects : [];
    const listed = new Map<string, ListedObject>();
    for (const sobject of sobjects) {
      const entry = (sobject ?? {}) as Record<string, unknown>;
      if (typeof entry.name !== 'string') continue;
      const flag = (key: string): { [key: string]: boolean } =>
        typeof entry[key] === 'boolean' ? { [key]: entry[key] } : {};
      listed.set(entry.name.toLowerCase(), {
        name: entry.name,
        ...flag('queryable'),
        ...flag('deletable'),
        ...flag('createable'),
        ...flag('layoutable'),
      });
    }
    return listed;
  } catch {
    return undefined;
  }
}

/**
 * Whether an object a run's object has as a child is one a sweep looks at:
 * one people work with, whose records may be queried, created and deleted —
 * which leaves out what the org keeps for itself behind a record, its
 * history, its sharing rows. A flag the org does not give is not held
 * against it.
 */
function childLookedAt(listed: ListedObject): boolean {
  return (
    listed.queryable !== false &&
    listed.deletable !== false &&
    listed.createable !== false &&
    listed.layoutable !== false &&
    !NEVER_SWEPT.some((name) => name.toLowerCase() === listed.name.toLowerCase())
  );
}

/** How a sweep reads an object, or why it cannot. */
async function sweptObjectOf(
  objectApiName: string,
  describeOf: (objectApiName: string) => Promise<DescribedObject>,
): Promise<SweptObject | { reason: string }> {
  let described;
  try {
    described = await describeOf(objectApiName);
  } catch (err: unknown) {
    return { reason: extractErrorMessage(err) };
  }
  if (described.queryable === false) return { reason: 'The org does not let it be queried.' };
  if (described.deletable !== true) {
    return { reason: 'The org does not let its records be deleted.' };
  }
  const fields = new Set(described.fields.map((field) => field.name));
  if (!fields.has('CreatedById') || !fields.has('CreatedDate')) {
    return {
      reason:
        'It keeps no creator or creation date to tell what the run’s user created in the ' +
        'window: its records go with the records they belong to.',
    };
  }
  const modified = fields.has('LastModifiedDate')
    ? 'LastModifiedDate'
    : fields.has('SystemModstamp')
      ? 'SystemModstamp'
      : 'CreatedDate';
  const nameField = described.fields.find((field) => field.nameField === true)?.name;
  return {
    name: described.name,
    modified,
    ...(fields.has('LastModifiedById') ? { modifiedBy: 'LastModifiedById' } : {}),
    ...(nameField && nameField !== 'Id' ? { nameField } : {}),
    references: tieFieldsOf(described),
  };
}

/**
 * The lookups of an object a tie may be read from: every reference field but
 * who owns, created and last modified a record and its record type, and but
 * those that point only at users, groups and the like, which no run creates.
 * Polymorphic ones count: `WhatId`, `WhoId`, `ParentId`, `LinkedEntityId`,
 * `RelatedToId`.
 */
function tieFieldsOf(described: DescribedObject): string[] {
  return described.fields
    .filter(
      (field) =>
        field.type === 'reference' &&
        !NOT_A_TIE.has(field.name) &&
        !(
          (field.referenceTo ?? []).length > 0 &&
          (field.referenceTo ?? []).every((to) => NEVER_SWEPT.includes(to))
        ),
    )
    .map((field) => field.name);
}

/** The condition every read of a sweep carries: the user, and the window. */
function createdBy(user: string, window: Window): string {
  return (
    `CreatedById = '${user}' AND CreatedDate >= ${soqlDate(window.from)} ` +
    `AND CreatedDate <= ${soqlDate(window.to)}`
  );
}

/** The same, for a sweep that reads what any of `creators` created. */
function createdByAny(creators: readonly string[], window: Window): string {
  if (creators.length === 1) return createdBy(creators[0], window);
  return (
    `CreatedById IN (${creators.map((creator) => `'${creator}'`).join(', ')}) ` +
    `AND CreatedDate >= ${soqlDate(window.from)} AND CreatedDate <= ${soqlDate(window.to)}`
  );
}

/**
 * Find what a sweep would take, reading only: the run's window and user, then
 * what is tied to the run among what that user created ({@link findTied}).
 */
async function findSweep(
  org: SweepOrg,
  input: SweepInput,
  removalSpans: readonly ForgeRemovalSpan[] = [],
): Promise<SweepFindings> {
  const stopped = (): boolean => input.signal?.aborted === true;
  const listing: ForgeSweepListing = {
    looked: [],
    found: [],
    unread: [],
    handWork: [],
    ...(input.automation.gaps ? { automationGaps: input.automation.gaps } : {}),
  };
  const findings: SweepFindings = { listing, rows: new Map(), stopped: false };
  const window = windowOf(input.writtenBetween);
  if (!window) {
    listing.refusal =
      'The target did not date this run’s writes: the window its automation wrote in cannot be ' +
      'told, and nothing is swept.';
    return findings;
  }
  findings.window = window;
  listing.window = { from: soqlDate(window.from), to: soqlDate(window.to) };

  // A user told goes into the sweep's queries: an id, or nothing.
  const kept =
    input.runUserId !== undefined && SF_ID_RE.test(input.runUserId) ? input.runUserId : undefined;
  const toldUser = input.user !== undefined && SF_ID_RE.test(input.user) ? input.user : undefined;
  const createdAny = input.created.some((object) => object.ids.length > 0);
  const told = kept
    ? { user: kept }
    : createdAny
      ? await runUserOf(org, input.created, stopped)
      : toldUser !== undefined
        ? { user: toldUser }
        : {
            refusal:
              'The run created nothing, and none of the records it wrote over still says, in its ' +
              'window, who last modified it: the user it wrote as cannot be told, and nothing is ' +
              'swept.',
          };
  if ('refusal' in told) {
    listing.refusal = told.refusal;
    findings.stopped = stopped();
    return findings;
  }
  return findTied(org, input, input.ties, told.user, findings, window, removalSpans);
}

/** Records per object, as a sentence names them. */
function handWorkWords(counts: readonly ForgeRemovalLeftCount[]): string {
  return counts.map((count) => `${count.objectApiName}: ${count.count}`).join(', ');
}

// ─── What ties a record to the run ───────────────────────────────────────────

/** A record a sweep found, before its class: with who created it and what it points at. */
interface TiedRow extends Omit<SweepRow, 'class' | 'sameSave' | 'turn'> {
  creator: string;
  /** Its lookups read, field by field, to a record id's key. */
  references: Array<{ field: string; key: string }>;
}

/** The answer of each `SELECT COUNT()` in its order, `undefined` for one a stop left unsent. */
async function countsOf(
  org: SweepOrg,
  statements: readonly string[],
  stopped: () => boolean,
): Promise<Array<number | { reason: string } | undefined>> {
  if (statements.length === 0) return [];
  if (org.counts) {
    try {
      return await org.counts(statements);
    } catch (err: unknown) {
      const reason = extractErrorMessage(err);
      return statements.map(() => ({ reason }));
    }
  }
  const answers: Array<number | { reason: string } | undefined> = [];
  for (const statement of statements) {
    if (stopped()) {
      answers.push(undefined);
      continue;
    }
    try {
      answers.push((await org.query(statement)).totalSize);
    } catch (err: unknown) {
      answers.push({ reason: extractErrorMessage(err) });
    }
  }
  return answers;
}

/** The ids of the org's Automated Process users, which its asynchronous automation may run as. */
async function automatedProcessUsers(org: RemovalOrg): Promise<string[]> {
  try {
    const answer = await org.query("SELECT Id FROM User WHERE UserType = 'AutomatedProcess'");
    return answer.records
      .map((row) => (row as { Id?: unknown } | null)?.Id)
      .filter((value): value is string => typeof value === 'string' && SF_ID_RE.test(value));
  } catch {
    return [];
  }
}

/**
 * Read the records of one object any of `creators` created between `from`
 * and `to`, with every lookup a tie may be read from — in groups of columns
 * when the object is too wide to name them in one query — page after page by
 * id, the records `excluded` holds left out. Each row is checked again
 * against the creators and the span before it is kept.
 */
async function readTiedRows(
  org: RemovalOrg,
  object: SweptObject,
  creators: ReadonlyMap<string, string>,
  span: Window,
  excluded: (key: string) => boolean,
  stopped: () => boolean,
): Promise<{ rows: TiedRow[]; overBound: boolean; stopped: boolean } | { reason: string }> {
  const name = assertSoqlIdentifier(object.name);
  const columns = [
    ...new Set(
      [
        'Id',
        'CreatedById',
        'CreatedDate',
        object.modified,
        object.modifiedBy,
        object.nameField,
        ...object.references,
      ]
        .filter((column): column is string => column !== undefined)
        .map(assertSoqlIdentifier),
    ),
  ];
  const read = async (statement: string): Promise<Array<Record<string, unknown>>> =>
    (await org.query(statement)).records.filter(
      (record): record is Record<string, unknown> => typeof record === 'object' && record !== null,
    );
  const rows: TiedRow[] = [];
  let after: string | undefined;
  for (;;) {
    if (stopped()) return { rows, overBound: false, stopped: true };
    const soql =
      `SELECT ${columns.join(', ')} FROM ${name} WHERE ${createdByAny([...creators.values()], span)}` +
      `${after ? ` AND Id > '${after}'` : ''} ORDER BY Id LIMIT ${PAGE}`;
    let page: Array<Record<string, unknown>>;
    try {
      const wide = wideStatement(soql);
      page = wide ? await readOtherColumns(await read(wide.first), wide, read) : await read(soql);
    } catch (err: unknown) {
      return { reason: extractErrorMessage(err) };
    }
    for (const row of page) {
      if (typeof row.Id !== 'string') continue;
      after = row.Id;
      const creator = typeof row.CreatedById === 'string' ? recordKey(row.CreatedById) : '';
      const created = epochOf(row.CreatedDate);
      if (!creators.has(creator) || !(created >= span.from && created <= span.to)) continue;
      if (excluded(recordKey(row.Id))) continue;
      const modifiedBy = object.modifiedBy ? row[object.modifiedBy] : undefined;
      const named = object.nameField ? row[object.nameField] : undefined;
      const references: TiedRow['references'] = [];
      for (const field of object.references) {
        const value = row[field];
        if (typeof value === 'string' && SF_ID_RE.test(value)) {
          references.push({ field, key: recordKey(value) });
        }
      }
      rows.push({
        id: row.Id,
        modified: epochOf(row[object.modified]),
        created,
        creator,
        references,
        ...(typeof modifiedBy === 'string' ? { modifiedBy: recordKey(modifiedBy) } : {}),
        ...(typeof named === 'string' && named.trim() !== ''
          ? { name: named.trim().slice(0, 80) }
          : {}),
      });
      if (rows.length > SWEEP_OBJECT_BOUND) {
        return { rows: rows.slice(0, SWEEP_OBJECT_BOUND), overBound: true, stopped: false };
      }
    }
    if (page.length < PAGE) return { rows, overBound: false, stopped: false };
  }
}

/** A record of the run's a sweep ties records to, with its object and its id as the run kept it. */
interface Anchor extends SweepAnchor {
  objectApiName: string;
  id: string;
}

/** The describes a sweep reads, each once. */
interface Describes {
  /** The describe, or the org's refusal. */
  of(objectApiName: string): Promise<DescribedObject>;
  /** The describe, or undefined when the org refused it. */
  now(objectApiName: string): Promise<DescribedObject | undefined>;
  /** What the org does to `child`'s `field` when the record of `parent` it names goes. */
  relation(
    parent: string,
    child: string,
    field: string,
  ): Promise<{ cascade: boolean; restricted: boolean }>;
}

function describesOf(org: RemovalOrg): Describes {
  const held = new Map<string, Promise<DescribedObject>>();
  const of = (name: string): Promise<DescribedObject> => {
    const key = name.toLowerCase();
    let described = held.get(key);
    if (!described) {
      described = (async () => describedObjectSchema.parse(await org.describe(name)))();
      // Asked again, it fails again: no unhandled refusal in between.
      described.catch(() => undefined);
      held.set(key, described);
    }
    return described;
  };
  const now = async (name: string): Promise<DescribedObject | undefined> => {
    try {
      return await of(name);
    } catch {
      return undefined;
    }
  };
  return {
    of,
    now,
    async relation(parent, child, field) {
      const relation = (await now(parent))?.childRelationships?.find(
        (r) => r.childSObject.toLowerCase() === child.toLowerCase() && r.field === field,
      );
      return {
        cascade: relation?.cascadeDelete === true,
        restricted: relation?.restrictedDelete === true,
      };
    },
  };
}

/**
 * The objects a sweep counts: those it always looks at, the hand-work ones,
 * then the children of the run's objects people work with, up to
 * {@link SWEEP_LOOK_BOUND}; past it, named as not looked at.
 */
async function objectsToCount(
  org: RemovalOrg,
  anchorObjects: readonly string[],
  creates: readonly string[],
  describes: Describes,
  listing: ForgeSweepListing,
  stopped: () => boolean,
): Promise<{ looked: string[]; notLooked: string[] } | undefined> {
  const listed = await objectsListed(org);
  const inOrg = (name: string): ListedObject | undefined =>
    listed ? listed.get(name.toLowerCase()) : { name };
  const looked: string[] = [];
  const notLooked: string[] = [];
  const has = (name: string): boolean =>
    looked.some((known) => known.toLowerCase() === name.toLowerCase());
  const never = (name: string): boolean =>
    NEVER_SWEPT.some((known) => known.toLowerCase() === name.toLowerCase());
  const look = (name: string, said: boolean): void => {
    if (has(name) || never(name)) return;
    const spelled = inOrg(name)?.name;
    if (!spelled) {
      if (said) listing.unread.push({ objectApiName: name, reason: 'The org has no such object.' });
      return;
    }
    if (looked.length >= SWEEP_LOOK_BOUND) {
      if (!notLooked.includes(spelled)) notLooked.push(spelled);
      return;
    }
    looked.push(spelled);
  };
  for (const name of anchorObjects) look(name, true);
  for (const name of SWEEP_SIDE_OBJECTS) look(name, false);
  for (const name of creates) look(name, true);
  for (const name of HAND_WORK_OBJECTS) look(name, false);
  for (const name of anchorObjects) {
    if (stopped()) return undefined;
    for (const relation of (await describes.now(name))?.childRelationships ?? []) {
      const child = inOrg(relation.childSObject);
      if (child && childLookedAt(child) && !has(child.name)) look(child.name, false);
    }
  }
  return { looked, notLooked };
}

/**
 * The run's records' lookups to the records found, read from the run's
 * records still in the org by the ids found: per lookup of a run's object to
 * an object found, one query per {@link RECORDS_PER_CALL} ids. A lookup that
 * cannot be read is said; what only it ties is then tied to nothing.
 */
async function pointersOf(
  org: RemovalOrg,
  anchorObjects: readonly string[],
  anchors: ReadonlyMap<string, Anchor>,
  found: ReadonlyMap<string, TiedRow[]>,
  describes: Describes,
  listing: ForgeSweepListing,
  stopped: () => boolean,
): Promise<SweepPointer[] | undefined> {
  const pointers: SweepPointer[] = [];
  const foundByObject = new Map([...found.keys()].map((name) => [name.toLowerCase(), name]));
  for (const anchorObject of anchorObjects) {
    const fields = ((await describes.now(anchorObject))?.fields ?? []).filter(
      (field) => field.type === 'reference' && !NOT_A_TIE.has(field.name),
    );
    for (const field of fields) {
      for (const to of field.referenceTo ?? []) {
        const target = foundByObject.get(to.toLowerCase());
        if (!target) continue;
        const ids = (found.get(target) ?? []).map((row) => row.id);
        const { restricted } = await describes.relation(target, anchorObject, field.name);
        const lookup = assertSoqlIdentifier(field.name);
        for (const list of idLists(ids)) {
          if (stopped()) return undefined;
          let rows: unknown[];
          try {
            rows = (
              await org.query(
                `SELECT Id, ${lookup} FROM ${assertSoqlIdentifier(anchorObject)} ` +
                  `WHERE ${lookup} IN (${list})`,
              )
            ).records;
          } catch (err: unknown) {
            listing.unread.push({
              objectApiName: anchorObject,
              reason:
                `What its ${field.name} points at among the records found could not be read ` +
                `(${extractErrorMessage(err)}): what only it ties is left as tied to nothing.`,
            });
            continue;
          }
          for (const row of rows) {
            const { Id: from, [field.name]: value } = (row ?? {}) as Record<string, unknown>;
            if (typeof from !== 'string' || typeof value !== 'string') continue;
            if (!anchors.has(recordKey(from))) continue;
            pointers.push({ from: recordKey(from), to: recordKey(value), restricted });
          }
        }
      }
    }
  }
  return pointers;
}

/**
 * Date the records the run created that something found is tied to, by
 * their `CreatedDate` in the org or its recycle bin: those alone are read.
 * One that cannot be read keeps no date, and is taken as written in the
 * run's span. False when a stop came first.
 */
async function dateAnchors(
  org: RemovalOrg,
  anchors: ReadonlyMap<string, Anchor>,
  linked: ReadonlySet<string>,
  stopped: () => boolean,
): Promise<boolean> {
  const toDate = new Map<string, string[]>();
  for (const key of linked) {
    const anchor = anchors.get(key);
    if (anchor?.kind !== 'created') continue;
    toDate.set(anchor.objectApiName, [...(toDate.get(anchor.objectApiName) ?? []), anchor.id]);
  }
  for (const [objectApiName, ids] of toDate) {
    for (const list of idLists(ids)) {
      if (stopped()) return false;
      try {
        const answer = await org.queryDeleted(
          `SELECT Id, CreatedDate FROM ${assertSoqlIdentifier(objectApiName)} WHERE Id IN (${list})`,
        );
        for (const row of answer.records) {
          const { Id: id, CreatedDate: date } = (row ?? {}) as Record<string, unknown>;
          const anchor = typeof id === 'string' ? anchors.get(recordKey(id)) : undefined;
          const at = epochOf(date);
          if (anchor && Number.isFinite(at)) {
            anchor.from = at;
            anchor.to = at;
          }
        }
      } catch {
        // Undated, a record of the run is taken as written in the run's span.
      }
    }
  }
  return true;
}

/**
 * Put each record found in its class, per object, into the listing and the
 * rows to sweep: what is tied to nothing on an object people make by hand is
 * hand work, never swept, and refuses what is tied to nothing, as another run
 * of this machine in the window does.
 */
function classify(
  found: ReadonlyMap<string, TiedRow[]>,
  tied: ReadonlyMap<string, SweepTie>,
  ties: SweepTies,
  findings: SweepFindings,
  window: Window,
  removalSpans: readonly ForgeRemovalSpan[],
): void {
  const { listing } = findings;
  const handWorkKeys = new Set(HAND_WORK_OBJECTS.map((name) => name.toLowerCase()));
  const untied: ForgeRemovalLeftCount[] = [];
  const late: ForgeRemovalLeftCount[] = [];
  const order: readonly SweepClass[] = ['made', 'madeOver', 'late', 'untied'];
  for (const [objectApiName, rows] of found) {
    const kept: SweepRow[] = [];
    let handWork = 0;
    for (const row of rows) {
      const tie = tied.get(recordKey(row.id));
      if (!tie) continue;
      if (tie.class === 'untied' && handWorkKeys.has(objectApiName.toLowerCase())) {
        handWork++;
        continue;
      }
      kept.push({
        id: row.id,
        modified: row.modified,
        created: row.created,
        class: tie.class,
        sameSave: tie.sameSave,
        turn: tie.turn,
        ...(row.modifiedBy !== undefined ? { modifiedBy: row.modifiedBy } : {}),
        ...(row.name !== undefined ? { name: row.name } : {}),
      });
    }
    if (handWork > 0) listing.handWork.push({ objectApiName, count: handWork });
    if (kept.length === 0) continue;
    const classes: ForgeSweepClasses = { made: 0, madeOver: 0, late: 0, untied: 0 };
    let sameSave = 0;
    let changed = 0;
    // By class: a list counted a task changed since among what --sweep-untied
    // would delete, which the sweep then kept.
    const changedIn: NonNullable<ForgeSweepClasses['changedIn']> = {};
    for (const row of kept) {
      classes[row.class]++;
      if (row.sameSave) sameSave++;
      if (changedSince(row, window, removalSpans)) {
        changed++;
        changedIn[row.class] = (changedIn[row.class] ?? 0) + 1;
      }
    }
    listing.found.push({
      objectApiName,
      count: kept.length,
      // The records it takes first.
      names: order
        .flatMap((name) => kept.filter((row) => row.class === name))
        .flatMap((row) => (row.name ? [row.name] : []))
        .slice(0, NAMES_SHOWN),
      classes: {
        ...classes,
        ...(sameSave > 0 ? { sameSave } : {}),
        ...(changed > 0 ? { changed, changedIn } : {}),
      },
    });
    if (classes.untied > 0) untied.push({ objectApiName, count: classes.untied });
    if (classes.late > 0) late.push({ objectApiName, count: classes.late });
    findings.rows.set(objectApiName, kept);
  }

  const refusals: string[] = [];
  if (listing.handWork.length > 0) {
    refusals.push(
      `The run's user created records in the run's window tied to nothing of the run, on objects ` +
        `people make by hand (${handWorkWords(listing.handWork)}): hand work, likely, in the same ` +
        'span. They are left, and so is everything tied to nothing: what was made by hand could ' +
        'not be told from what the automation made.',
    );
  }
  const others = (ties.otherRuns ?? []).filter(
    (run) => run.ids.length > 0 || run.idsUntold === true,
  ).length;
  if (others > 0) {
    refusals.push(
      `${others === 1 ? 'Another run' : `${others} other runs`} of this machine wrote to the ` +
        'target in this run’s window: what is tied to nothing of this run may be theirs, and is ' +
        'left.',
    );
  }
  if (refusals.length > 0) {
    refusals.push('The runs of another machine, or of a CI, in the same window are not seen.');
  }
  listing.untied = {
    objects: untied,
    ...(refusals.length > 0 ? { refusal: refusals.join(' ') } : {}),
  };
  listing.late = late;
}

/**
 * Find what a sweep would take among what the run's user created, reading
 * only, every read before the first delete: the objects the run's records have
 * as children beside those every sweep looks at, counted first; the records
 * the run's user — and the org's Automated Process user — created in the
 * window, and up to
 * {@link LATE_WITHIN_MS} after the run's last write for what comes late; their
 * lookups, the run's records' lookups to them, and when the records of the
 * run they are tied to were created; then each one's class.
 */
async function findTied(
  org: SweepOrg,
  input: SweepInput,
  ties: SweepTies,
  user: string,
  findings: SweepFindings,
  window: Window,
  removalSpans: readonly ForgeRemovalSpan[],
): Promise<SweepFindings> {
  const { listing } = findings;
  const stopped = (): boolean => input.signal?.aborted === true;
  const halt = (): SweepFindings => {
    findings.stopped = true;
    return findings;
  };

  // The run's span, and how far past it what comes late is read: never past
  // the removal's start, whose own doing is never the run's.
  const first = epochOf(input.writtenBetween?.first);
  const last = Math.max(first, epochOf(input.writtenBetween?.last));
  const removalBegan = Math.min(
    Number.POSITIVE_INFINITY,
    ...[ties.removalBegan, ...removalSpans.map((span) => span.first)]
      .map(epochOf)
      .filter(Number.isFinite),
  );
  const lateEnd = Math.ceil((last + LATE_WITHIN_MS) / 1000) * 1000;
  const span: Window = {
    from: window.from,
    to: Math.max(window.to, Math.min(lateEnd, Math.floor(removalBegan / 1000) * 1000)),
  };

  // The records of the run, by key: what it created, then what it only
  // wrote over. Never what it only linked to.
  const anchors = new Map<string, Anchor>();
  const runSpan = { from: first, to: last };
  for (const { objectApiName, ids } of input.created) {
    for (const id of ids) {
      anchors.set(recordKey(id), {
        kind: 'created',
        objectApiName,
        id,
        from: Number.NaN,
        to: Number.NaN,
      });
    }
  }
  for (const { objectApiName, ids, between } of ties.writtenOver ?? []) {
    const from = epochOf(between?.first);
    const to = epochOf(between?.last);
    for (const id of ids) {
      if (anchors.has(recordKey(id))) continue;
      anchors.set(recordKey(id), { kind: 'overwritten', objectApiName, id, from, to });
    }
  }
  const anchorObjects = [
    ...new Set(
      [...input.created, ...(ties.writtenOver ?? [])]
        .filter((object) => object.ids.length > 0)
        .map((object) => object.objectApiName),
    ),
  ];
  const excludedKeys = new Set<string>([
    ...(ties.otherRuns ?? []).flatMap((run) => run.ids.map(recordKey)),
    ...(ties.leased ?? []).map(recordKey),
  ]);
  const excluded = (key: string): boolean =>
    input.remap.has(key) || anchors.has(key) || excludedKeys.has(key);

  const ap = await automatedProcessUsers(org);
  const creators = new Map<string, string>([[recordKey(user), user]]);
  for (const id of ap) if (!creators.has(recordKey(id))) creators.set(recordKey(id), id);
  const automatedProcess = new Set(ap.map(recordKey).filter((key) => key !== recordKey(user)));

  const describes = describesOf(org);
  const toCount = await objectsToCount(
    org,
    anchorObjects,
    input.automation.creates,
    describes,
    listing,
    stopped,
  );
  if (!toCount) return halt();
  const { looked, notLooked } = toCount;
  listing.looked = looked;
  if (notLooked.length > 0) listing.notLooked = notLooked;

  // Counted first: only the objects that hold something are described and read.
  const counted = await countsOf(
    org,
    looked.map(
      (name) =>
        `SELECT COUNT() FROM ${assertSoqlIdentifier(name)} WHERE ${createdByAny([...creators.values()], span)}`,
    ),
    stopped,
  );
  if (stopped()) return halt();
  const found = new Map<string, TiedRow[]>();
  const overBound: ForgeSweepFound[] = [];
  for (const [at, objectApiName] of looked.entries()) {
    const count = counted[at];
    if (count === undefined) return halt();
    if (count === 0) continue;
    if (stopped()) return halt();
    // An object the org would not count is said in the sweep's words when its
    // describe tells why — no creator to tell what the run's user created —,
    // in the org's otherwise.
    const swept = await sweptObjectOf(objectApiName, describes.of);
    if ('reason' in swept) {
      listing.unread.push({ objectApiName, reason: swept.reason });
      continue;
    }
    if (typeof count === 'object') {
      listing.unread.push({ objectApiName, reason: count.reason });
      continue;
    }
    const read = await readTiedRows(org, swept, creators, span, excluded, stopped);
    if ('reason' in read) {
      listing.unread.push({ objectApiName, reason: read.reason });
      continue;
    }
    if (read.stopped) return halt();
    if (read.overBound) {
      overBound.push({
        objectApiName,
        count: read.rows.length,
        names: read.rows.flatMap((row) => (row.name ? [row.name] : [])).slice(0, NAMES_SHOWN),
        overBound: true,
      });
    } else if (read.rows.length > 0) {
      found.set(objectApiName, read.rows);
    }
  }

  // The lookups of the records found, to the run's records and to one another.
  const objectOf = new Map<string, string>();
  for (const [key, anchor] of anchors) objectOf.set(key, anchor.objectApiName);
  for (const [objectApiName, rows] of found) {
    for (const row of rows) objectOf.set(recordKey(row.id), objectApiName);
  }
  const candidates: SweepCandidate[] = [];
  const linked = new Set<string>();
  for (const [objectApiName, rows] of found) {
    for (const row of rows) {
      const references: SweepReference[] = [];
      for (const reference of row.references) {
        const parent = objectOf.get(reference.key);
        if (!parent) continue;
        if (anchors.has(reference.key)) linked.add(reference.key);
        const { cascade } = await describes.relation(parent, objectApiName, reference.field);
        references.push({ key: reference.key, cascade });
      }
      candidates.push({
        key: recordKey(row.id),
        created: row.created,
        automatedProcess: automatedProcess.has(row.creator),
        references,
      });
    }
  }
  const pointers = await pointersOf(
    org,
    anchorObjects,
    anchors,
    found,
    describes,
    listing,
    stopped,
  );
  if (!pointers) return halt();
  for (const pointer of pointers) linked.add(pointer.from);
  if (!(await dateAnchors(org, anchors, linked, stopped))) return halt();

  const tied = sweepTiesOf({
    anchors,
    candidates,
    pointers,
    runSpan,
    window,
    removalBegan,
    madeEarlier: new Set((ties.madeEarlier ?? []).map(recordKey)),
    lateEarlier: new Set((ties.lateEarlier ?? []).map(recordKey)),
  });
  classify(found, tied, ties, findings, window, removalSpans);
  listing.found.push(...overBound);
  if (ties.muted) listing.muted = ties.muted;
  // The order of the deletes is read from the describes read already: once
  // the sweep was asked, it reads nothing more before its first delete.
  findings.ordering = {
    query: (soql) => org.query(soql),
    queryDeleted: (soql) => org.queryDeleted(soql),
    describe: async (name) => (await describes.now(name)) ?? org.describe(name),
    describeGlobal: () => org.describeGlobal(),
    destroy: (objectApiName, ids) => org.destroy(objectApiName, ids),
    update: (objectApiName, records) => org.update(objectApiName, records),
    serverTime: () => org.serverTime(),
    userId: () => org.userId(),
  };
  return findings;
}

/**
 * Whether a record was changed since the run by someone other than a
 * removal of it: last modified after the window, or, for one created late,
 * after the save that created it — a date that cannot be read cannot show
 * it was left alone.
 */
function changedSince(
  row: SweepRow,
  window: Window,
  removalSpans: readonly ForgeRemovalSpan[],
): boolean {
  const since = Math.max(window.to, row.created + SAME_SAVE_MS);
  return !(row.modified <= since) && !byRemoval(row, removalSpans);
}

/** Whether a removal of the run, as the user it ran as, last modified the record while it ran. */
function byRemoval(row: SweepRow, removalSpans: readonly ForgeRemovalSpan[]): boolean {
  return (
    row.modifiedBy !== undefined &&
    removalSpans.some(
      (span) =>
        row.modifiedBy === recordKey(span.userId) &&
        row.modified >= epochOf(span.first) &&
        row.modified <= epochOf(span.last),
    )
  );
}

/**
 * List what a sweep would take, reading only: what a removal's confirmation
 * shows, and what the command line prints before it deletes anything.
 *
 * @param removalSpans - When the earlier removals of the run ran, and as
 *   whom: what they changed is no change since the run.
 */
export async function listSweep(
  org: SweepOrg,
  input: SweepInput,
  removalSpans: readonly ForgeRemovalSpan[] = [],
): Promise<ForgeSweepListing> {
  return (await findSweep(org, input, removalSpans)).listing;
}

/** How a sweep goes, beside what it is told of the run. */
export interface SweepOptions {
  /** Delete too the records modified since the run by someone other than a removal of it. */
  includeChanged: boolean;
  /**
   * When the removals of the run that wrote ran, the one the sweep follows
   * included, and as which user: what each changed while it ran was its own
   * doing, not a change since the run.
   */
  removalSpans: readonly ForgeRemovalSpan[];
  /**
   * Take too what the sweep finds tied to the run but made late (`late`):
   * listed and kept otherwise.
   */
  sweepLate?: boolean;
  /**
   * Take too what the sweep finds tied to nothing of the run (`untied`),
   * unless that is refused (`ForgeSweepListing.untied.refusal`): listed and
   * kept otherwise.
   */
  sweepUntied?: boolean;
  /**
   * Asked once the records are found, before the first delete, with what was
   * found: why the sweep stops there, when it does — Production Guard's
   * refusal, a person declining. Nothing is asked when nothing is to be taken.
   */
  approve?: (listing: ForgeSweepListing) => Promise<string | undefined>;
}

/**
 * What a sweep keeps of what it found, as it was asked, by class: what came
 * late without `sweepLate`, and what is tied to nothing without `sweepUntied`
 * or while that is refused. Said with its result: a `--sweep` ended a success
 * with five tasks left, which its line before the first delete alone had named.
 */
function sweepLeftOf(
  listing: ForgeSweepListing,
  options: Pick<SweepOptions, 'sweepLate' | 'sweepUntied'>,
): ForgeSweepLeftClass[] {
  const left: ForgeSweepLeftClass[] = [];
  const late = listing.late ?? [];
  if (late.length > 0 && options.sweepLate !== true) {
    left.push({ class: 'late', objects: late, option: '--sweep-late' });
  }
  const { objects: untied = [], refusal } = listing.untied ?? {};
  if (untied.length > 0 && (options.sweepUntied !== true || refusal !== undefined)) {
    left.push({
      class: 'untied',
      objects: untied,
      option: '--sweep-untied',
      ...(refusal !== undefined ? { refusal } : {}),
    });
  }
  return left;
}

/** Where a sweep stands with one object's records. */
interface ObjectSweep {
  result: ForgeSweepObjectResult;
  /** The records the org refused, by id, with its reason. */
  refused: Map<string, string>;
  /** The records that wait for the run's own: under them in cascade, or pointed at by them. */
  later: string[];
}

/**
 * A sweep in the parts a removal makes it in, around the run's own records:
 * `ask` before a mute's lease, `first` as the removal's `sweep`,
 * `automationMade` as its `automationMade`, `afterRemoval` as its
 * `afterRemoval`.
 */
export interface SweepParts {
  /**
   * Find what to take and ask, deleting nothing: the sweep's reads and its
   * question, for a removal to make before it takes a mute's lease. A person
   * taking their time over the question then holds no permission set
   * assigned. Asked once, however often it is called; `first` makes it when
   * nobody has. A refused sweep deletes nothing, now or after.
   */
  ask(): Promise<void>;
  /**
   * What the sweep found, once `ask` has read it, what it keeps among it
   * included: what a sweep that took nothing says it left. Undefined before,
   * and for a sweep stopped before it had read the run's user.
   */
  readonly listing: ForgeSweepListing | undefined;
  /**
   * The objects the sweep deletes records of, once `ask` has read them and
   * nothing refused it: what the removal adds to the objects it reads the
   * target's automation on, plans its mute from and asks about. On a real org,
   * a Flow on an asset the run never wrote refused the sweep's delete, after
   * the removal had said that nothing fired and that there was nothing to mute.
   */
  readonly takes: readonly string[];
  /**
   * Delete what goes before the run's records — what neither goes along with
   * one of them nor waits for one — once `ask` found it and nothing refused
   * it; it resolves to whether it deleted anything. A refused sweep deletes
   * nothing, now or after.
   */
  first(): Promise<boolean>;
  /**
   * The ids of what the sweep takes, as the org wrote them, filled by
   * `first` before the removal's first write: a record among them under a
   * record of the run holds it back no more. What the sweep keeps, changed
   * since, is not among them.
   */
  readonly automationMade: ReadonlySet<string>;
  /**
   * The ids of what the sweep found made for the run (`made`, `madeOver`),
   * as the org wrote them: what the run keeps beside it for the next sweep
   * (`SweepTies.madeEarlier`), once a lookup that told the tie may be gone.
   * Filled by `ask`, whatever its question is answered: a sweep refused
   * there left them tied to a run whose records a reload's purge then took.
   */
  readonly made: ReadonlySet<string>;
  /**
   * The ids of what the sweep found made late for the run (`late`), filled by
   * `ask` as `made` is: what the run keeps for the next sweep
   * (`SweepTies.lateEarlier`), which takes them when what came late is asked
   * for. Its record gone, nothing else told them the run's.
   */
  readonly late: ReadonlySet<string>;
  /**
   * Once the run's records are deleted: delete what waited for them, what
   * should have gone with them still in the org, then send once more what
   * the org refused; it resolves to whether it deleted anything. Nothing,
   * for a sweep whose first part did not end.
   */
  afterRemoval(): Promise<boolean>;
  /** What the sweep did so far: what `first` did, with what `afterRemoval` did once it ran. */
  result(): ForgeSweepResult;
}

/**
 * A sweep made in parts, around the run's own records: before them, what
 * neither goes along with them nor waits for them; with them, in cascade,
 * what is under them; after them, what they point at by a lookup the org
 * refuses the delete for. Records modified since the run are kept unless the
 * request includes them; the rest is deleted children before their parents,
 * {@link RECORDS_PER_CALL} at a time, stopped between two calls when asked.
 * What the org refuses is counted with its reasons, and sent once more after
 * the last part. A refused sweep deletes nothing.
 */
export function sweepParts(org: SweepOrg, input: SweepInput, options: SweepOptions): SweepParts {
  const stopped = (): boolean => input.signal?.aborted === true;
  const automationMade = new Set<string>();
  const made = new Set<string>();
  const late = new Set<string>();
  const sweeps: ObjectSweep[] = [];
  let state: 'new' | 'asked' | 'cancelled' | 'refused' | 'first' | 'done' = 'new';
  let refusal: string | undefined;
  /** `ask`'s one call, however often it is asked, and what it found and takes. */
  let asking: Promise<void> | undefined;
  let found: SweepFindings | undefined;
  let taking = new Map<string, SweepRow[]>();
  let base: Omit<ForgeSweepResult, 'status' | 'objects' | 'refusal'> = {
    unread: [],
    handWork: [],
  };

  const settle = (
    sweep: ObjectSweep,
    batch: readonly string[],
    outcomes: DeleteOutcome[],
  ): void => {
    batch.forEach((id, index) => {
      const outcome = outcomes[index];
      if (outcome.kind === 'refused') {
        sweep.refused.set(id, outcome.reason);
        return;
      }
      sweep.refused.delete(id);
      if (outcome.kind === 'deleted') sweep.result.deleted++;
      else sweep.result.alreadyGone++;
    });
  };
  /** Delete `ids` of one object, a call at a time; false when a stop came first. */
  const send = async (
    sweep: ObjectSweep,
    ids: readonly string[],
    after = false,
  ): Promise<boolean> => {
    for (let at = 0; at < ids.length; at += RECORDS_PER_CALL) {
      if (stopped()) return false;
      const batch = ids.slice(at, at + RECORDS_PER_CALL);
      const before = sweep.result.deleted;
      settle(sweep, batch, await deleteBatch(org, sweep.result.objectApiName, batch));
      if (after && sweep.result.deleted > before) {
        sweep.result.afterRemoval =
          (sweep.result.afterRemoval ?? 0) + sweep.result.deleted - before;
      }
    }
    return true;
  };
  const deleted = (): number => sweeps.reduce((sum, sweep) => sum + sweep.result.deleted, 0);
  /**
   * What it found and kept — made late, tied to nothing — read back once the
   * run's records are gone: one the org no longer holds — what hangs from
   * them went along with them — is said so, not left. Run for real on the trap org, a removal said
   * "left, made late: DuplicateRecordItem: 25" of the duplicate items its
   * contacts had taken with them. Found by a query, each was seen; a read
   * that fails, or a stop, leaves them left. Nothing is deleted from it.
   */
  const settleLeft = async (): Promise<void> => {
    const left = base.left ?? [];
    if (left.length === 0 || !found) return;
    const rows = found.rows;
    const staying: ForgeSweepLeftClass[] = [];
    const goneAlong: NonNullable<ForgeSweepResult['goneAlong']> = [];
    for (const kept of left) {
      const stays: ForgeRemovalLeftCount[] = [];
      const went: ForgeRemovalLeftCount[] = [];
      for (const count of kept.objects) {
        const ids = (rows.get(count.objectApiName) ?? [])
          .filter((row) => row.class === kept.class)
          .map((row) => row.id);
        const { gone } = stopped()
          ? { gone: [] }
          : await takenAlong(
              ids,
              (asked) => readRecordsById(org, count.objectApiName, [], asked),
              () => true,
            );
        const away = Math.min(gone.length, count.count);
        if (count.count > away) stays.push({ ...count, count: count.count - away });
        if (away > 0) went.push({ objectApiName: count.objectApiName, count: away });
      }
      if (stays.length > 0) staying.push({ ...kept, objects: stays });
      if (went.length > 0) goneAlong.push({ class: kept.class, objects: went });
    }
    if (goneAlong.length === 0) return;
    const rest = { ...base };
    delete rest.left;
    base = { ...rest, ...(staying.length > 0 ? { left: staying } : {}), goneAlong };
  };

  const ask = (): Promise<void> => {
    asking ??= (async () => {
      const findings = await findSweep(org, input, options.removalSpans);
      found = findings;
      const { listing } = findings;
      base = {
        ...(listing.window ? { window: listing.window } : {}),
        unread: [
          ...listing.unread,
          ...listing.found
            .filter((found) => found.overBound)
            .map((found): ForgeSweepUnread => ({
              objectApiName: found.objectApiName,
              reason:
                `More than ${SWEEP_OBJECT_BOUND} records created by the run's user in the window: ` +
                'none is swept, as that many are more than the run’s side effects come to.',
            })),
        ],
        ...(listing.automationGaps ? { automationGaps: listing.automationGaps } : {}),
        handWork: listing.handWork,
      };
      // A stop before the run's user was read leaves it untold: the refusal
      // that says so is the stop's doing, and the sweep was cancelled.
      if (findings.stopped) {
        state = 'cancelled';
        return;
      }
      // What it found tied to the run, kept for the next sweep whatever is
      // answered below.
      for (const rows of findings.rows.values()) {
        for (const row of rows) {
          if (row.class === 'made' || row.class === 'madeOver') made.add(row.id);
          else if (row.class === 'late') late.add(row.id);
        }
      }
      if (listing.refusal !== undefined) {
        state = 'refused';
        refusal = listing.refusal;
        return;
      }
      const untiedTaken = options.sweepUntied === true && listing.untied?.refusal === undefined;
      const taken = (row: SweepRow): boolean =>
        row.class === 'made' ||
        row.class === 'madeOver' ||
        (row.class === 'late' && options.sweepLate === true) ||
        (row.class === 'untied' && untiedTaken);
      taking = new Map(
        [...findings.rows]
          .map(([objectApiName, all]) => [objectApiName, all.filter(taken)] as const)
          .filter(([, all]) => all.length > 0),
      );
      if (options.approve && taking.size > 0) {
        const answer = await options.approve(listing);
        if (answer !== undefined) {
          state = 'refused';
          refusal = answer;
          return;
        }
      }
      const left = sweepLeftOf(listing, options);
      if (left.length > 0) base = { ...base, left };
      state = 'asked';
    })();
    return asking;
  };

  return {
    automationMade,
    made,
    late,

    get listing() {
      return found && !found.stopped ? found.listing : undefined;
    },

    get takes() {
      return state === 'asked' ? [...taking.keys()] : [];
    },

    ask,

    async first() {
      await ask();
      if (state !== 'asked' || !found) return false;
      const findings = found;
      const rows = taking;
      const window = findings.window!;
      const order = await removalOrder(
        findings.ordering ?? org,
        [...rows.keys()].map((objectApiName) => ({ objectApiName })),
      );
      const now: Array<[ObjectSweep, string[]]> = [];
      for (const { objectApiName } of order) {
        const all = rows.get(objectApiName) ?? [];
        const sweep: ObjectSweep = {
          result: {
            objectApiName,
            found: all.length,
            deleted: 0,
            alreadyGone: 0,
            keptChanged: 0,
            refused: 0,
            reasons: [],
          },
          refused: new Map(),
          later: [],
        };
        sweeps.push(sweep);
        const before: string[] = [];
        for (const row of all) {
          if (changedSince(row, window, options.removalSpans) && !options.includeChanged) {
            sweep.result.keptChanged++;
            continue;
          }
          automationMade.add(row.id);
          if (row.turn === 'before') before.push(row.id);
          else sweep.later.push(row.id);
        }
        now.push([sweep, before]);
      }
      for (const [sweep, ids] of now) {
        if (!(await send(sweep, ids))) {
          state = 'cancelled';
          return deleted() > 0;
        }
      }
      state = 'first';
      return deleted() > 0;
    },

    async afterRemoval() {
      if (state !== 'first') return false;
      const before = deleted();
      for (const sweep of sweeps) {
        const ids = sweep.later.splice(0);
        if (!(await send(sweep, ids, true))) {
          state = 'cancelled';
          return deleted() > before;
        }
      }
      // What the org refused goes once more, once the rest has gone: a record
      // refused for one hanging from it may be free by then, as a removal finds.
      if (deleted() > 0) {
        for (const sweep of sweeps) {
          if (!(await send(sweep, [...sweep.refused.keys()]))) {
            state = 'cancelled';
            return deleted() > before;
          }
        }
      }
      // What the org still refused is read back, as the removal reads back
      // its own (`takenAlong`): one it no longer holds went with a record of
      // the run, and is gone. Run for real with Team Selling on, the member
      // the org adds to an opportunity's team was refused before the
      // opportunity, went with it, and the sweep still said it refused one:
      // the removal ended partial with nothing left. The sweep found each of
      // them by a query, so the session saw them; a read that fails leaves
      // them refused. Nothing is decided from it: what it deletes was shown.
      for (const sweep of sweeps) {
        if (stopped()) break;
        const { gone } = await takenAlong(
          [...sweep.refused.keys()],
          (ids) => readRecordsById(org, sweep.result.objectApiName, [], ids),
          () => true,
        );
        for (const id of gone) {
          sweep.refused.delete(id);
          sweep.result.alreadyGone++;
        }
      }
      await settleLeft();
      state = 'done';
      return deleted() > before;
    },

    result() {
      if (state === 'refused') {
        return { status: 'refused', refusal: refusal ?? '', objects: [], ...base };
      }
      if (state === 'new' || state === 'asked') {
        return { status: 'cancelled', objects: [], ...base };
      }
      const objects = sweeps.map(({ result, refused }) => {
        result.refused = refused.size;
        result.reasons = [...new Set(refused.values())].slice(0, REASON_LIMIT);
        return result;
      });
      const waiting = sweeps.some((sweep) => sweep.later.length > 0);
      return {
        status: sweepStatus(objects, state === 'cancelled', waiting, askedAndLeft(base, options)),
        objects,
        ...base,
      };
    },
  };
}

/**
 * Sweep in one go, the run's own records gone already or left as they are:
 * find what is tied to the run, keep what someone changed since the run
 * unless the request includes it, and delete the rest, children before their
 * parents — what waits for one of the run's records last, where it goes only
 * once that record went — {@link RECORDS_PER_CALL} at a time, stopped between two calls when asked. Records the org refuses
 * are counted with its reasons, and sent once more when the rest has gone. A
 * refused sweep deletes nothing.
 */
export async function sweepRunRecords(
  org: SweepOrg,
  input: SweepInput,
  options: SweepOptions,
): Promise<ForgeSweepResult> {
  const parts = sweepParts(org, input, options);
  await parts.first();
  await parts.afterRemoval();
  return parts.result();
}

/**
 * How a sweep ended: nothing it found left in the org is a success; some
 * deleted and some left, partial; none deleted and some left, a failure.
 * Records still waiting for the run's own are left, and so is a class it was
 * asked to take and did not (`askedAndLeft`): a refused --sweep-untied ended
 * a success, exit 0, above the thirty tasks it left, where the help says a
 * sweep that did not take all it was asked to exits 3.
 */
function sweepStatus(
  objects: readonly ForgeSweepObjectResult[],
  cancelled: boolean,
  waiting = false,
  classLeft = false,
): ForgeUndoStatus {
  if (cancelled) return 'cancelled';
  const left =
    waiting || classLeft || objects.some((object) => object.keptChanged + object.refused > 0);
  if (!left) return 'success';
  return objects.some((object) => object.deleted > 0) ? 'partial' : 'failure';
}

/**
 * Whether a sweep left a class it was asked to take (`sweepLeftOf`): what is
 * tied to nothing, with `--sweep-untied`, while taking it is refused. A class
 * left unasked was no part of what it had to do.
 */
function askedAndLeft(
  result: Pick<ForgeSweepResult, 'left'>,
  options: Pick<SweepOptions, 'sweepLate' | 'sweepUntied'>,
): boolean {
  return (result.left ?? []).some(
    (left) =>
      (left.class === 'late' && options.sweepLate === true) ||
      (left.class === 'untied' && options.sweepUntied === true),
  );
}

/**
 * The sweep as the run it followed keeps it: when it ended, what every sweep
 * of the run deleted, and what the last one kept and had refused. Nothing for
 * a sweep that would not run: it leaves the run as it found it.
 *
 * @param earlier - The mark the sweeps before this one left on the run.
 */
export function sweepMarkOf(
  result: ForgeSweepResult,
  sweptAt: string,
  earlier?: ForgeSweepMark,
): ForgeSweepMark | undefined {
  if (result.status === 'refused') return undefined;
  const sum = (count: (object: ForgeSweepObjectResult) => number): number =>
    result.objects.reduce((total, object) => total + count(object), 0);
  return {
    sweptAt,
    deleted: (earlier?.deleted ?? 0) + sum((object) => object.deleted),
    keptChanged: sum((object) => object.keptChanged),
    refused: sum((object) => object.refused),
  };
}

/** What a sweep deleted and what the org refused, per object, for the audit trail. */
export function sweepAuditObjects(result: ForgeSweepResult): AuditObjectCounts[] {
  return result.objects
    .filter((object) => object.deleted + object.refused > 0)
    .map((object) => ({
      ...emptyCounts(object.objectApiName),
      deleted: object.deleted,
      failed: object.refused,
    }));
}

/**
 * What a sweep's entry in the audit trail says beside its counts: that it is
 * a sweep, of which run, and its totals. Counts and words only.
 */
export function sweepAuditDetails(
  result: ForgeSweepResult,
  forgeId: string,
): Record<string, string | number | boolean> {
  const sum = (count: (object: ForgeSweepObjectResult) => number): number =>
    result.objects.reduce((total, object) => total + count(object), 0);
  return {
    sweep: true,
    forgeId,
    found: sum((object) => object.found),
    deleted: sum((object) => object.deleted),
    keptChanged: sum((object) => object.keptChanged),
    refused: sum((object) => object.refused),
    handWork: result.handWork.reduce((total, count) => total + count.count, 0),
  };
}

/** Records a sweep found, over every object. */
export function sweepFoundCount(listing: Pick<ForgeSweepListing, 'found'>): number {
  return listing.found.reduce((sum, found) => sum + found.count, 0);
}

/** The objects a sweep found records of, by API name. */
export function sweepFoundObjects(listing: Pick<ForgeSweepListing, 'found'>): string[] {
  return listing.found.map((found) => found.objectApiName);
}
