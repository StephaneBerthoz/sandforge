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
 * - the user: the one who created the run's records, read from them, in the
 *   org or its recycle bin — the run's own records may be gone by then;
 * - the objects the run wrote, the objects the platform and its automation
 *   commonly fill beside a record ({@link SWEEP_SIDE_OBJECTS}), and the
 *   objects the target's flows on the run's objects create
 *   (`ForgeTargetFlow.creates`), said when they could not all be read;
 * - minus every record the run's id map holds: what the run wrote, linked to
 *   or matched.
 *
 * A window in which the run's user is likely to have worked by hand is not
 * swept: records the user created in it on objects the run never wrote and
 * the target's automation does not reach ({@link HAND_WORK_OBJECTS}) are said,
 * left, and the sweep refused. Nothing outside the window, or created by
 * anyone else, is ever deleted: each row the org answers is checked again
 * against both before its delete is sent.
 */

import type {
  AuditObjectCounts,
  ForgeRemovalLeftCount,
  ForgeRemovalSpan,
  ForgeSweepAutomationGaps,
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
import { emptyCounts } from '../audit/auditTrail.js';
import { describedObjectSchema } from '../dataops/DataQualityScanner.js';
import { idLists, RECORDS_PER_CALL } from '../dataops/RecordRemoval.js';
import {
  deleteBatch,
  removalOrder,
  type DeleteOutcome,
  type RecordKeys,
  type RemovalOrg,
} from './ForgeRunRemoval.js';

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
 * Objects a person creates by hand. Records the run's user created in the
 * window on one of them that the run did not write and the target's
 * automation does not create are taken for hand work, and the sweep refused.
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
   * The user the run wrote as, told where none of its records can tell it: a
   * Sync run that created nothing and only wrote over records the target
   * held (`seedSweepInput`). Records the run created tell it first.
   */
  user?: string;
  /** Stops the sweep before its next call to the org. */
  signal?: AbortSignal;
}

/** A record a sweep found: its id, when it was last modified, and by whom where the object says. */
interface SweepRow {
  id: string;
  modified: number;
  modifiedBy?: string;
}

/** What a sweep found, before it deletes anything. */
interface SweepFindings {
  listing: ForgeSweepListing;
  window?: Window;
  /** Per object, the records to sweep: an object past the bound is not among them. */
  rows: Map<string, SweepRow[]>;
  /** Whether a stop came before the reads were through. */
  stopped: boolean;
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

/** The objects the org lists, by lower-cased API name, or undefined when it would not list them. */
async function objectsListed(org: RemovalOrg): Promise<Map<string, string> | undefined> {
  try {
    const global = (await org.describeGlobal()) as { sobjects?: unknown } | null;
    const sobjects = Array.isArray(global?.sobjects) ? global.sobjects : [];
    const names = new Map<string, string>();
    for (const sobject of sobjects) {
      const name = (sobject as { name?: unknown } | null)?.name;
      if (typeof name === 'string') names.set(name.toLowerCase(), name);
    }
    return names;
  } catch {
    return undefined;
  }
}

/** How a sweep reads an object, or why it cannot. */
async function sweptObjectOf(
  org: RemovalOrg,
  objectApiName: string,
): Promise<SweptObject | { reason: string }> {
  let described;
  try {
    described = describedObjectSchema.parse(await org.describe(objectApiName));
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
  };
}

/** The condition every read of a sweep carries: the user, and the window. */
function createdBy(user: string, window: Window): string {
  return (
    `CreatedById = '${user}' AND CreatedDate >= ${soqlDate(window.from)} ` +
    `AND CreatedDate <= ${soqlDate(window.to)}`
  );
}

/**
 * Find what a sweep would take, reading only: the run's window and user, then
 * per object the records that user created in the window that the run's id
 * map does not hold, and the hand work that refuses the sweep.
 */
async function findSweep(org: RemovalOrg, input: SweepInput): Promise<SweepFindings> {
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
  const toldUser = input.user !== undefined && SF_ID_RE.test(input.user) ? input.user : undefined;
  const createdAny = input.created.some((object) => object.ids.length > 0);
  const told = createdAny
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
  const user = told.user;

  const listed = await objectsListed(org);
  /** The org's spelling of an object, or undefined when the org does not list it. */
  const inOrg = (name: string): string | undefined =>
    listed ? listed.get(name.toLowerCase()) : name;
  const runObjects = input.created.map((object) => object.objectApiName);
  const looked: string[] = [];
  const look = (name: string, said: boolean): void => {
    if (looked.some((known) => known.toLowerCase() === name.toLowerCase())) return;
    const spelled = inOrg(name);
    // An object the org does not have holds nothing to sweep; one the run
    // wrote or its automation creates is said, as it was expected there.
    if (spelled) looked.push(spelled);
    else if (said)
      listing.unread.push({ objectApiName: name, reason: 'The org has no such object.' });
  };
  for (const name of runObjects) look(name, true);
  for (const name of SWEEP_SIDE_OBJECTS) look(name, false);
  for (const name of input.automation.creates) look(name, true);
  listing.looked = looked;
  const lookedKeys = new Set(looked.map((name) => name.toLowerCase()));

  for (const objectApiName of looked) {
    if (stopped()) {
      findings.stopped = true;
      return findings;
    }
    const swept = await sweptObjectOf(org, objectApiName);
    if ('reason' in swept) {
      listing.unread.push({ objectApiName, reason: swept.reason });
      continue;
    }
    const read = await readCreated(org, swept, user, window, input.remap, stopped);
    if ('reason' in read) {
      listing.unread.push({ objectApiName, reason: read.reason });
      continue;
    }
    if (read.stopped) {
      findings.stopped = true;
      return findings;
    }
    if (read.rows.length === 0 && !read.overBound) continue;
    listing.found.push({
      objectApiName,
      count: read.rows.length,
      names: read.names,
      ...(read.overBound ? { overBound: true as const } : {}),
    });
    if (!read.overBound) findings.rows.set(objectApiName, read.rows);
  }

  // Hand work: what the user created in the window where neither the run nor
  // the target's automation writes.
  for (const name of HAND_WORK_OBJECTS) {
    if (lookedKeys.has(name.toLowerCase())) continue;
    const objectApiName = inOrg(name);
    if (!objectApiName) continue;
    if (stopped()) {
      findings.stopped = true;
      return findings;
    }
    try {
      const answer = await org.query(
        `SELECT COUNT() FROM ${assertSoqlIdentifier(objectApiName)} WHERE ${createdBy(user, window)}`,
      );
      if (answer.totalSize > 0) {
        listing.handWork.push({ objectApiName, count: answer.totalSize });
      }
    } catch (err: unknown) {
      listing.unread.push({ objectApiName, reason: extractErrorMessage(err) });
    }
  }
  if (listing.handWork.length > 0) {
    listing.refusal =
      `The run's user created records in the run's window that neither the run nor the ` +
      `target's automation writes (${handWorkWords(listing.handWork)}): hand work, likely, in the ` +
      'same span. They are left, and nothing is swept: what that user created by hand on the ' +
      'objects the sweep looks at could not be told from what the automation created.';
  }
  return findings;
}

/** Records per object, as a sentence names them. */
function handWorkWords(counts: readonly ForgeRemovalLeftCount[]): string {
  return counts.map((count) => `${count.objectApiName}: ${count.count}`).join(', ');
}

/**
 * Read the records of one object the user created in the window, page after
 * page by id, those the run's id map holds left out. Each row is checked
 * again against the user and the window: a row the org answered outside them
 * is never swept. Past {@link SWEEP_OBJECT_BOUND}, the object is said to be
 * over it, and none of its records is swept.
 */
async function readCreated(
  org: RemovalOrg,
  object: SweptObject,
  user: string,
  window: Window,
  remap: RecordKeys,
  stopped: () => boolean,
): Promise<
  { rows: SweepRow[]; names: string[]; overBound: boolean; stopped: boolean } | { reason: string }
> {
  const name = assertSoqlIdentifier(object.name);
  const columns = [
    ...new Set(
      ['Id', 'CreatedById', 'CreatedDate', object.modified, object.modifiedBy, object.nameField]
        .filter((column): column is string => column !== undefined)
        .map(assertSoqlIdentifier),
    ),
  ];
  const rows: SweepRow[] = [];
  const names: string[] = [];
  let after: string | undefined;
  for (;;) {
    if (stopped()) return { rows, names, overBound: false, stopped: true };
    let answer: { records: unknown[] };
    try {
      answer = await org.query(
        `SELECT ${columns.join(', ')} FROM ${name} WHERE ${createdBy(user, window)}` +
          `${after ? ` AND Id > '${after}'` : ''} ORDER BY Id LIMIT ${PAGE}`,
      );
    } catch (err: unknown) {
      return { reason: extractErrorMessage(err) };
    }
    for (const record of answer.records) {
      if (typeof record !== 'object' || record === null) continue;
      const row = record as Record<string, unknown>;
      if (typeof row.Id !== 'string') continue;
      after = row.Id;
      const creator = typeof row.CreatedById === 'string' ? recordKey(row.CreatedById) : '';
      const created = epochOf(row.CreatedDate);
      if (creator !== recordKey(user) || !(created >= window.from && created <= window.to)) {
        continue;
      }
      if (remap.has(recordKey(row.Id))) continue;
      const modifiedBy = object.modifiedBy ? row[object.modifiedBy] : undefined;
      rows.push({
        id: row.Id,
        modified: epochOf(row[object.modified]),
        ...(typeof modifiedBy === 'string' ? { modifiedBy: recordKey(modifiedBy) } : {}),
      });
      const named = object.nameField ? row[object.nameField] : undefined;
      if (typeof named === 'string' && named.trim() !== '' && names.length < NAMES_SHOWN) {
        names.push(named.trim().slice(0, 80));
      }
      if (rows.length > SWEEP_OBJECT_BOUND) {
        return { rows: rows.slice(0, SWEEP_OBJECT_BOUND), names, overBound: true, stopped: false };
      }
    }
    if (answer.records.length < PAGE) return { rows, names, overBound: false, stopped: false };
  }
}

/**
 * List what a sweep would take, reading only: what a removal's confirmation
 * shows, and what the command line prints before it deletes anything.
 */
export async function listSweep(org: RemovalOrg, input: SweepInput): Promise<ForgeSweepListing> {
  return (await findSweep(org, input)).listing;
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
   * Asked once the records are found, before the first delete, with what was
   * found: why the sweep stops there, when it does — Production Guard's
   * refusal, a person declining. Nothing is asked when nothing was found.
   */
  approve?: (listing: ForgeSweepListing) => Promise<string | undefined>;
}

/** Where a sweep stands with one object's records. */
interface ObjectSweep {
  result: ForgeSweepObjectResult;
  /** The records the org refused, by id, with its reason. */
  refused: Map<string, string>;
}

/**
 * Sweep, before the run's own records go: find what the run's user created
 * in the window, keep what someone changed since the run unless the request
 * includes it, and delete the rest, children before their parents, {@link RECORDS_PER_CALL} at a
 * time, stopped between two calls when asked. Records the org refuses are
 * counted with its reasons, and sent once more when the rest has gone. A
 * refused sweep deletes nothing.
 */
export async function sweepRunRecords(
  org: RemovalOrg,
  input: SweepInput,
  options: SweepOptions,
): Promise<ForgeSweepResult> {
  const stopped = (): boolean => input.signal?.aborted === true;
  const findings = await findSweep(org, input);
  const { listing } = findings;
  const base = {
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
  // A stop before the run's user was read leaves it untold: the refusal that
  // says so is the stop's doing, and the sweep was cancelled.
  if (findings.stopped) return { status: 'cancelled', objects: [], ...base };
  if (listing.refusal !== undefined) {
    return { status: 'refused', refusal: listing.refusal, objects: [], ...base };
  }
  if (options.approve && findings.rows.size > 0) {
    const refusal = await options.approve(listing);
    if (refusal !== undefined) return { status: 'refused', refusal, objects: [], ...base };
  }
  const window = findings.window!;
  const spans = options.removalSpans.map((span) => ({
    start: epochOf(span.first),
    end: epochOf(span.last),
    user: recordKey(span.userId),
  }));
  /** Whether a removal of the run, as the user it ran as, last modified the record while it ran. */
  const byRemoval = (row: SweepRow): boolean =>
    row.modifiedBy !== undefined &&
    spans.some(
      (span) =>
        row.modifiedBy === span.user && row.modified >= span.start && row.modified <= span.end,
    );

  const order = await removalOrder(
    org,
    [...findings.rows.keys()].map((objectApiName) => ({ objectApiName })),
  );
  const sweeps: ObjectSweep[] = [];
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
  const ended = (cancelled: boolean): ForgeSweepResult => {
    const objects = sweeps.map(({ result, refused }) => {
      result.refused = refused.size;
      result.reasons = [...new Set(refused.values())].slice(0, REASON_LIMIT);
      return result;
    });
    return { status: sweepStatus(objects, cancelled), objects, ...base };
  };

  for (const { objectApiName } of order) {
    const rows = findings.rows.get(objectApiName) ?? [];
    const sweep: ObjectSweep = {
      result: {
        objectApiName,
        found: rows.length,
        deleted: 0,
        alreadyGone: 0,
        keptChanged: 0,
        refused: 0,
        reasons: [],
      },
      refused: new Map(),
    };
    sweeps.push(sweep);
    const toDelete: string[] = [];
    for (const row of rows) {
      // A date that cannot be read cannot show the record was left alone.
      const changed = !(row.modified <= window.to) && !byRemoval(row);
      if (changed && !options.includeChanged) sweep.result.keptChanged++;
      else toDelete.push(row.id);
    }
    for (let at = 0; at < toDelete.length; at += RECORDS_PER_CALL) {
      if (stopped()) return ended(true);
      const batch = toDelete.slice(at, at + RECORDS_PER_CALL);
      settle(sweep, batch, await deleteBatch(org, objectApiName, batch));
    }
  }

  // What the org refused goes once more, once the rest has gone: a record
  // refused for one hanging from it may be free by then, as a removal finds.
  if (sweeps.some((sweep) => sweep.result.deleted > 0)) {
    for (const sweep of sweeps) {
      const again = [...sweep.refused.keys()];
      for (let at = 0; at < again.length; at += RECORDS_PER_CALL) {
        if (stopped()) return ended(true);
        const batch = again.slice(at, at + RECORDS_PER_CALL);
        settle(sweep, batch, await deleteBatch(org, sweep.result.objectApiName, batch));
      }
    }
  }
  return ended(false);
}

/**
 * How a sweep ended: nothing it found left in the org is a success; some
 * deleted and some left, partial; none deleted and some left, a failure.
 */
function sweepStatus(
  objects: readonly ForgeSweepObjectResult[],
  cancelled: boolean,
): ForgeUndoStatus {
  if (cancelled) return 'cancelled';
  const left = objects.some((object) => object.keptChanged + object.refused > 0);
  if (!left) return 'success';
  return objects.some((object) => object.deleted > 0) ? 'partial' : 'failure';
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
