/**
 * What the acts of a checkpoint cost, said before they run — the API requests
 * each sends the org, about how long it takes, what it keeps on this machine —
 * and the refusal of an act that would take more requests than the org has
 * left today, given before it reads a record.
 *
 * How an org counts its daily requests was asked of a scratch org and a
 * Developer Edition org, both answering alike:
 *
 * - one composite costs one request, whatever it holds: forty composites of
 *   five queries took 37 to 53 requests off the day, not 200, and over whole
 *   windows the count fell by 189 for 190 calls sent, and by 195 for 192. An
 *   estimate counts calls, never subrequests: five queries a call
 *   ({@link QUERIES_PER_COMPOSITE}), twenty-five describes
 *   ({@link SUBREQUESTS_PER_COMPOSITE});
 * - a cursor's next page is one of a composite's five queries: the pages of
 *   reads run together drain five a call;
 * - a SOAP call — the org's clock, the user a session runs as, an undelete of
 *   up to 200 records — costs a request like any other, and the count of a
 *   connection's requests did not see them (a live run made 17 it never
 *   showed): every one is listed here, by what sends it;
 * - `/limits` costs one, and trails the calls by a minute or two: it is read
 *   once, before anything else, and never to measure a run;
 * - pages are not all of a size — 2,000 rows, then 1,972 — so an estimate
 *   takes 2,000 a page where nothing reads one into a page.
 *
 * Whether a Bulk API call counts against the daily requests is not known. No
 * estimate prices one: a removal past 10,000 records of an object
 * (`BULK_DELETE_THRESHOLD`) deletes them through a Bulk job of a handful of
 * calls, and they are counted as the REST calls of 200 records the job stands
 * for, which is more, so the gate errs toward refusing.
 *
 * An act's requests are what it sends whatever it holds, each named, and what
 * each brick it goes through sends per call and per record, counted as the
 * brick's own code sends it: the change reads (`orgStreams.ts`), the bring back
 * (`undeleteRunDeletions`), the give-back (`restoreOverwrites`) and the
 * removal (`removeRunRecords`). What cannot be known before — a record sent
 * again without a field the org refused, what the org's automation does in
 * answer — is left out, and the estimate is about.
 */

import type {
  CheckpointEstimate,
  CheckpointObject,
  CheckpointRefusal,
  RewindDiff,
  RewindDiffObject,
} from '@sandforge/shared';
import * as z from 'zod';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { columnGroups } from '../../core/common/wideRead.js';
import { RECORDS_PER_CALL } from '../dataops/RecordRemoval.js';
import {
  apiBudgetCheckOf,
  readApiBudget,
  runRequestsEstimate,
  type ApiBudget,
  type LimitsTransport,
} from '../forge/ForgeRunGate.js';
import { QUERIES_PER_COMPOSITE, SUBREQUESTS_PER_COMPOSITE } from './compositeQueries.js';
import { SNAPSHOT_CHUNK_IDS, snapshotIndexBytes } from './snapshotIndex.js';

// ─── Figures ─────────────────────────────────────────────────────────────────

/**
 * Bytes a record takes on this machine, about: measured on six standard
 * objects, 0.36 to 0.73 KB with the writable fields that hold a value, 1.1 to
 * 1.8 KB with every field; the snapshot keeps the writable ones, empty or not.
 */
const BYTES_PER_RECORD = 1_000;

/**
 * Bytes a rewind's journal keeps of a record it gives back: the values it
 * writes over, kept before it writes them, about 0.5 KB a record.
 */
const JOURNAL_BYTES_PER_VALUES = 500;

/**
 * Bytes a rewind's journal keeps of a record it deletes or brings back: its
 * id on a line, about.
 */
const JOURNAL_BYTES_PER_ID = 40;

/**
 * Requests every take sends whatever it holds: the guard's Organization,
 * edition and permissions reads, the day's limits, the two global describes
 * (data and Tooling), the View Encrypted Data permission, the Automated
 * Process user, the user's own id, the clock at T0 and at T1, and the
 * snapshot's read of which org it is.
 */
const TAKE_FIXED_REQUESTS = 12;

/**
 * Requests a rewind, and an undo, send whatever they hold before their first
 * read of a record: the guard's three — the org's Organization record, its
 * edition (asked of an org that is not a sandbox, a Developer Edition org's
 * case), the user's View All Data and Modify All Data — and the day's limits.
 */
const ACT_FIXED_REQUESTS = 4;

/**
 * Requests a read of what changed since a checkpoint sends whatever it finds:
 * the moment it reads from, on the org's clock (a SOAP call). The names of
 * the users who last changed what it finds are read only when it finds some,
 * two hundred a read.
 */
const DIFF_FIXED_REQUESTS = 1;

/** Users whose names one read of `User` asks, by their ids. */
const USERS_PER_READ = 200;

/**
 * SOAP calls one call of `undeleteRunDeletions` sends whatever it brings
 * back: the org's clock as it begins, and the user it writes as, read once
 * for the stamps it says back.
 */
const UNDELETE_FIXED_REQUESTS = 2;

/**
 * Requests per batch of 200 an undelete sends: the batch read in the recycle
 * bin, then among the live records, the undelete itself (a SOAP call), and
 * the stamps it left read back.
 */
const UNDELETE_REQUESTS_PER_BATCH = 4;

/**
 * SOAP calls one call of `restoreOverwrites` sends for one object, whatever
 * it gives back: the org's clock as its writes begin, and the user it writes
 * as, read once for the stamps it says back.
 */
const RESTORE_FIXED_REQUESTS = 2;

/**
 * Requests one call of `removeRunRecords` sends whatever it deletes: the
 * org's global describe, which tells the objects its dependents check reads,
 * and the org's clock and the user it runs as, both SOAP calls.
 */
const REMOVAL_FIXED_REQUESTS = 3;

/**
 * Statements a page of a wide object's snapshot costs per column group past
 * the first: the page's ids read again by their ids, 500 a statement.
 */
const STATEMENTS_PER_GROUP = 4;

/**
 * Rows a page of a read takes, in an estimate. The org gives about as many,
 * not always as many: nothing reads this into a page.
 */
const ESTIMATE_PAGE_ROWS = 2_000;

/**
 * Columns past which a read by id names a quarter as many ids a statement,
 * as `readRecordsById` and `restoreOverwrites` do: the columns and the ids
 * together stay short of the longest statement the org takes.
 */
const WIDE_READ_COLUMNS = 100;

/** The columns every column group of a snapshot carries: the id, and the stamp a write moves. */
const CARRIED_COLUMNS = ['Id', 'SystemModstamp'];

/**
 * Relationships counted, for an object whose describe the caller did not
 * read, where its dependents and the children that come back with it are
 * read: the most a removal was seen to read for one object, a contact's 23
 * per 200 records (`ForgeRunRemoval.ts`, 12,000 contacts in 1,380 reads).
 */
const UNDESCRIBED_RELATIONSHIPS = 23;

/** Seconds a call of 25 describes takes, about (2.1 to 2.9 s measured). */
const SECONDS_PER_DESCRIBE_CALL = 2.5;
/**
 * Seconds a composite of five small queries takes, about (0.23 to 0.45 s
 * measured); a SOAP call of the clock or the user too.
 */
const SECONDS_PER_SMALL_CALL = 0.35;
/** Seconds a page of the snapshot takes, about. */
const SECONDS_PER_PAGE = 1;
/**
 * Seconds a call of pages of ids takes, about: five pages of 2,000 ids in one
 * composite, 0.86 to 0.91 s measured.
 */
const SECONDS_PER_ID_PAGES = 0.9;
/** Seconds a read of up to 200 records by their ids takes, about. */
const SECONDS_PER_READ = 0.5;
/** Seconds a read of a record's dependents takes, about: a quarter of a second on a scratch org. */
const SECONDS_PER_DEPENDENTS_READ = 0.25;
/**
 * Seconds a write of up to 200 records takes, about: 2,000 contacts deleted
 * in 8.6 s by ten calls.
 */
const SECONDS_PER_WRITE = 0.86;

// ─── Counting ────────────────────────────────────────────────────────────────

/** Requests and time, about, of a part of an act. */
export interface Cost {
  apiRequests: number;
  /** Seconds, unrounded. */
  seconds: number;
}

const NOTHING: Cost = { apiRequests: 0, seconds: 0 };

/** `count` calls of `secondsEach`. */
function calls(count: number, secondsEach: number): Cost {
  return { apiRequests: count, seconds: count * secondsEach };
}

function sum(...costs: readonly Cost[]): Cost {
  return costs.reduce(
    (total, cost) => ({
      apiRequests: total.apiRequests + cost.apiRequests,
      seconds: total.seconds + cost.seconds,
    }),
    NOTHING,
  );
}

/** Calls of `per` items each that `items` take. */
function callsFor(items: number, per: number): number {
  return items > 0 ? Math.ceil(items / per) : 0;
}

/** Calls of {@link RECORDS_PER_CALL} records that `records` take. */
function batches(records: number): number {
  return callsFor(records, RECORDS_PER_CALL);
}

/** The column groups a read of `fields` names them in, the id and the stamp in every one. */
export function readGroupsOf(fields: readonly string[]): number {
  return columnGroups(fields, CARRIED_COLUMNS).length;
}

/** Ids one read by id names, for an object read with `fields`. */
function idsPerRead(fields: readonly string[]): number {
  return fields.length > WIDE_READ_COLUMNS ? RECORDS_PER_CALL / 4 : RECORDS_PER_CALL;
}

/** Calls a read of `records` records by their ids takes, with every one of `fields`. */
function readsById(records: number, fields: readonly string[]): number {
  return callsFor(records, idsPerRead(fields)) * readGroupsOf(fields);
}

// ─── The take ────────────────────────────────────────────────────────────────

/** What a take's estimate is made from. */
export interface TakeEstimateInput {
  /** Objects described: the scope's candidates. */
  described: number;
  /** Per object the take holds, its records and the column groups a page of it is read in. */
  objects: ReadonlyArray<{ records: number; groups: number }>;
  /** Rows a page of the snapshot reads: what the org's kind reads at a time. */
  pageRows: number;
}

/**
 * The API requests, time and disk a take costs, about. One composite costs
 * the org one request whatever it holds, so the describes go 25 a call, and
 * the counts, the recycle bin's reads and the checks of what moved five a
 * call; the snapshot reads a page a call, and a wide object's other column
 * groups by the page's ids. Further pages of the bin, and the reads of what
 * moved while it ran, are not known before.
 */
export function takeEstimate(
  input: TakeEstimateInput,
): Omit<CheckpointEstimate, 'apiRequestsLeft'> {
  const objects = input.objects.length;
  const describeCalls = Math.ceil(input.described / SUBREQUESTS_PER_COMPOSITE);
  const smallCalls = 3 * Math.ceil(objects / QUERIES_PER_COMPOSITE);
  let pageCalls = 0;
  let records = 0;
  let bytes = 0;
  for (const object of input.objects) {
    records += object.records;
    bytes += object.records * BYTES_PER_RECORD + snapshotIndexBytes(object.records);
    if (object.records === 0) continue;
    const pages = Math.ceil(object.records / input.pageRows);
    pageCalls += pages * (1 + Math.max(0, object.groups - 1) * STATEMENTS_PER_GROUP);
  }
  return {
    records,
    apiRequests: TAKE_FIXED_REQUESTS + describeCalls + smallCalls + pageCalls,
    seconds: Math.ceil(
      describeCalls * SECONDS_PER_DESCRIBE_CALL +
        smallCalls * SECONDS_PER_SMALL_CALL +
        pageCalls * SECONDS_PER_PAGE,
    ),
    bytes,
  };
}

// ─── The bricks a rewind and an undo go through ──────────────────────────────

/** Pages a read of `rows` rows takes: its first page, asked even when nothing answers it. */
function pagesOf(rows: number): number {
  return Math.max(1, callsFor(rows, ESTIMATE_PAGE_ROWS));
}

/**
 * What streamed reads cost, given each one's pages in the order they are
 * sent (`readStreams`): five at a time, their first pages in one composite,
 * then a page of each read still open a call, until the last of the five
 * ends, before the next five are opened. Five reads cost as many calls as
 * the longest of them has pages.
 */
export function streamedReadsCost(pages: readonly number[]): Cost {
  let first = 0;
  let next = 0;
  for (let start = 0; start < pages.length; start += QUERIES_PER_COMPOSITE) {
    const longest = Math.max(1, ...pages.slice(start, start + QUERIES_PER_COMPOSITE));
    first += 1;
    next += longest - 1;
  }
  return sum(calls(first, SECONDS_PER_SMALL_CALL), calls(next, SECONDS_PER_ID_PAGES));
}

/** An object the change reads found moved, in their order, with the rows of its L and D. */
export interface MovedObject {
  objectApiName: string;
  /** Rows of what moved since among the live records (L). */
  live: number;
  /** Rows of what was deleted since (D). */
  deleted: number;
}

/**
 * What the change reads of a checkpoint's objects cost (`readChanges`): the
 * pre-check of every object, five a call; then, for each object that moved,
 * the read of what moved (L) and the read of what was deleted (D), streamed
 * five at a time; then the count of each object that moved or that the
 * checkpoint holds records of, five a call.
 */
export function changeReadsCost(input: {
  /** Objects read. */
  objects: number;
  /** Of them, those counted whether they moved or not: the checkpoint holds records of them. */
  held: readonly string[];
  /** Of them, those that moved, in the order the reads take them. */
  moved: readonly MovedObject[];
}): Cost {
  const counted = new Set([...input.held, ...input.moved.map((object) => object.objectApiName)]);
  return sum(
    calls(callsFor(input.objects, QUERIES_PER_COMPOSITE), SECONDS_PER_SMALL_CALL),
    streamedReadsCost(
      input.moved.flatMap(({ live, deleted }) => [pagesOf(live), pagesOf(deleted)]),
    ),
    calls(callsFor(counted.size, QUERIES_PER_COMPOSITE), SECONDS_PER_SMALL_CALL),
  );
}

/**
 * What one call of `undeleteRunDeletions` costs, per object the records it
 * brings back: its clock and its user, then, per batch of 200, the bin read,
 * the live read, the undelete and the stamps read back.
 */
export function undeleteCost(records: readonly number[]): Cost {
  const batchCount = records.reduce((total, count) => total + batches(count), 0);
  if (batchCount === 0) return NOTHING;
  return sum(
    calls(UNDELETE_FIXED_REQUESTS, SECONDS_PER_SMALL_CALL),
    calls(batchCount * (UNDELETE_REQUESTS_PER_BATCH - 1), SECONDS_PER_READ),
    calls(batchCount, SECONDS_PER_WRITE),
  );
}

/**
 * What giving `records` records of one object their values back costs, in
 * chunks of {@link SNAPSHOT_CHUNK_IDS}, a call of `restoreOverwrites` each:
 * per chunk, its clock and its user; the org's values read by id, in the
 * object's column groups; the updates; and the stamps they left read back.
 */
export function restoreCost(records: number, fields: readonly string[]): Cost {
  let cost = NOTHING;
  for (let left = records; left > 0; left -= SNAPSHOT_CHUNK_IDS) {
    const chunk = Math.min(left, SNAPSHOT_CHUNK_IDS);
    cost = sum(
      cost,
      calls(RESTORE_FIXED_REQUESTS, SECONDS_PER_SMALL_CALL),
      calls(readsById(chunk, fields), SECONDS_PER_READ),
      calls(runRequestsEstimate([{ rows: chunk }]), SECONDS_PER_WRITE),
      calls(batches(chunk), SECONDS_PER_READ),
    );
  }
  return cost;
}

/** The relationships of an object, as its describe lists them, that a rewind reads through. */
export interface ObjectRelationships {
  /**
   * Child relationships the org deletes along or restricts a delete by: what
   * the dependents check reads.
   */
  dependents: number;
  /** Child relationships the org deletes along: the children that come back with a record. */
  cascades: number;
  /**
   * Of the child relationships the org deletes along, those to an object
   * outside the checkpoint, and of them those to an object a person works
   * in. A read of what changed since describes the org's objects once when
   * an object it would delete records of has the first, and reads the
   * second under every two hundred of those records. Absent, both are
   * counted from the objects outside the last read found records in.
   */
  outside?: { all: number; worked: number };
}

const childRelationshipsSchema = z
  .object({
    childRelationships: z
      .array(
        z
          .object({
            childSObject: z.string().optional(),
            cascadeDelete: z.boolean().optional(),
            restrictedDelete: z.boolean().optional(),
          })
          .loose(),
      )
      .nullish(),
  })
  .loose();

/** What is outside a checkpoint, as {@link relationshipsOf} tells an object's children. */
export interface CheckpointBounds {
  /** The checkpoint's objects, by API name in lower case. */
  inCheckpoint: ReadonlySet<string>;
  /**
   * The objects a person works in (`workedObjects`), by API name; none known
   * when the org's objects were not described.
   */
  worked?: ReadonlySet<string>;
}

/**
 * An object's relationships as its describe lists them: every one the org
 * deletes along or restricts a delete by. The dependents check reads those
 * whose child people work in only, so this is the most it reads. Given the
 * checkpoint's bounds, those it deletes along to an object outside them too.
 */
export function relationshipsOf(describe: unknown, bounds?: CheckpointBounds): ObjectRelationships {
  const children = childRelationshipsSchema.parse(describe).childRelationships ?? [];
  const relationships: ObjectRelationships = {
    dependents: children.filter((r) => r.cascadeDelete === true || r.restrictedDelete === true)
      .length,
    cascades: children.filter((r) => r.cascadeDelete === true).length,
  };
  if (bounds === undefined) return relationships;
  const outside = children.filter(
    (r) =>
      r.cascadeDelete === true &&
      r.childSObject !== undefined &&
      !bounds.inCheckpoint.has(r.childSObject.toLowerCase()),
  );
  const worked = outside.filter(
    (r) => r.childSObject !== undefined && bounds.worked?.has(r.childSObject) === true,
  );
  return { ...relationships, outside: { all: outside.length, worked: worked.length } };
}

/** The relationships of `objectApiName` given, or the most read for one object when none were. */
function relationshipsFor(
  relationships: ReadonlyMap<string, ObjectRelationships> | undefined,
  objectApiName: string,
): ObjectRelationships {
  return (
    relationships?.get(objectApiName) ?? {
      dependents: UNDESCRIBED_RELATIONSHIPS,
      cascades: UNDESCRIBED_RELATIONSHIPS,
    }
  );
}

/**
 * What one call of `removeRunRecords` costs, per object the records it
 * deletes: the global describe, its clock and its user; per object, its
 * describe, its records read by id, the reads of what depends on them — each
 * relationship asked once whether anything points through it when the object
 * has more than one batch, then read per batch — and the deletes, as REST
 * calls of 200, never priced as a Bulk job.
 *
 * Which records a record that stays holds is known only once the rest has
 * gone: those it holds are checked again then, and what the removal leaves
 * is read back, a few requests per 200 records held that are not counted.
 */
export function removalCost(objects: ReadonlyArray<{ records: number; dependents: number }>): Cost {
  const removed = objects.filter((object) => object.records > 0);
  if (removed.length === 0) return NOTHING;
  return sum(
    calls(REMOVAL_FIXED_REQUESTS, SECONDS_PER_SMALL_CALL),
    ...removed.map(({ records, dependents }) => {
      const batchCount = batches(records);
      const anyPointing = batchCount > 1 ? dependents : 0;
      return sum(
        calls(1, SECONDS_PER_SMALL_CALL),
        calls(batchCount, SECONDS_PER_READ),
        calls(anyPointing + dependents * batchCount, SECONDS_PER_DEPENDENTS_READ),
        calls(runRequestsEstimate([{ rows: records }]), SECONDS_PER_WRITE),
      );
    }),
  );
}

// ─── A read of what changed since a checkpoint ───────────────────────────────

/**
 * An object of a checkpoint, as an estimate reads it. Whether Salesforce
 * undeletes its records on their own tells, of its records gone for good,
 * those a read found by scanning its ids from those it named so as they lay
 * in the recycle bin: absent, it does.
 */
export type EstimatedObject = Pick<CheckpointObject, 'objectApiName' | 'records' | 'fields'> &
  Partial<Pick<CheckpointObject, 'undeletable'>>;

/** What the reads of what changed since a checkpoint are estimated from. */
export interface DiffEstimateInput {
  /** The checkpoint's objects (`OrgCheckpoint.objects`). */
  objects: readonly EstimatedObject[];
  /** What the last read found: the objects that moved, and those it could not read. */
  diff: Pick<RewindDiff, 'objects' | 'unread'>;
  /**
   * Per object, its relationships as its describe lists them
   * ({@link relationshipsOf}). One not given, of an object the rewind
   * deletes from or brings back to, is counted at the most a removal was
   * seen to read for one object; and what a read counts outside the
   * checkpoint under its records to delete, from the objects outside the
   * last read found records in.
   */
  relationships?: ReadonlyMap<string, ObjectRelationships>;
}

/** Records created or brought back since that a rewind deletes, in its first pass. */
function deletedFirst(object: RewindDiffObject): number {
  return object.toDelete.createdSince + object.toDelete.broughtBackSince;
}

/** Records a rewind sends to the undelete: those that come back with a parent are not sent. */
function sentBack(object: RewindDiffObject): number {
  return object.toBringBack.inBin + object.toBringBack.deletedWhileTaken;
}

/** Records a rewind brings back, those that come with a parent included. */
function broughtBack(object: RewindDiffObject): number {
  return sentBack(object) + object.toBringBack.withParent;
}

/**
 * Records a rewind gives their checkpoint values back: those changed since,
 * and those it brings back that the snapshot holds, which come back with the
 * values they had when deleted.
 */
function givenBack(object: RewindDiffObject): number {
  return object.toGiveBack.records + object.toBringBack.inBin + object.toBringBack.withParent;
}

/** Records the change reads find stamped since, among the live ones. */
function liveRows(object: RewindDiffObject): number {
  return object.toGiveBack.records + object.touched + deletedFirst(object) + object.unexplained;
}

/** Records the change reads find deleted since. */
function deletedRows(object: RewindDiffObject): number {
  return broughtBack(object) + object.toDelete.comesBackWithParent;
}

/** Records deleted since that the recycle bin no longer holds. */
function goneForGood(object: RewindDiffObject): number {
  return object.cannotUndo
    .filter((cannot) => cannot.reason === 'goneForGood')
    .reduce((total, cannot) => total + cannot.count, 0);
}

/**
 * Calls the reads of what lies outside the checkpoint under `records`
 * records to delete take: a chunk of {@link SNAPSHOT_CHUNK_IDS} at a time, a
 * read of each of `relationships` per 200 of them, five reads a call.
 */
function outsideReads(records: number, relationships: number): number {
  let reads = 0;
  for (let left = records; left > 0 && relationships > 0; left -= SNAPSHOT_CHUNK_IDS) {
    const chunk = Math.min(left, SNAPSHOT_CHUNK_IDS);
    reads += callsFor(relationships * batches(chunk), QUERIES_PER_COMPOSITE);
  }
  return reads;
}

/**
 * What one read of the org since the checkpoint costs — a preview, a
 * rewind's fresh diff, its convergence pass and its verify read it alike — as
 * the last read found the org, each part as `rewindDiff` sends it:
 *
 * - its clock;
 * - the drift describes, 25 a call;
 * - the change reads, of the objects that moved and of those the last read
 *   could not read, in the checkpoint's order;
 * - the values of the records changed since, and of those that come back
 *   with a parent — their lookup names a record brought back, so they are
 *   read whatever their stamps — by id, in each object's column groups;
 * - the describes of the objects it brings records back to, 25 a call, which
 *   tell the lookups that name them; then the describe of each object it
 *   deletes records of that none of those was; the org's objects, described
 *   once, when one of them deletes records along outside the checkpoint; and
 *   a read of each such relationship to an object a person works in, per 200
 *   records to delete, five a call;
 * - every id of each object some of whose records it found gone for good, an
 *   object at a time;
 * - the names of the users who last changed what it found, 200 a read, five
 *   reads a call; none when it found nothing to delete or give back.
 *
 * A drift describe that came back whole — the object's fields changed in the
 * day before the take or since, which its drift tells — answers for its
 * relationships too, and the object is not described again.
 */
export function diffEstimate(input: DiffEstimateInput): Cost {
  const found = new Map(input.diff.objects.map((object) => [object.objectApiName, object]));
  const unread = new Set(input.diff.unread.map((object) => object.objectApiName));
  const moved: MovedObject[] = [];
  const scans: Cost[] = [];
  /** The objects it brings records back to: their relationships are described up front. */
  const backTo = new Set<string>();
  let values = 0;
  for (const { objectApiName, records, fields, undeletable } of input.objects) {
    const object = found.get(objectApiName);
    if (object === undefined) {
      if (unread.has(objectApiName)) moved.push({ objectApiName, live: 0, deleted: 0 });
      continue;
    }
    moved.push({ objectApiName, live: liveRows(object), deleted: deletedRows(object) });
    values += readsById(
      object.toGiveBack.records + object.touched + object.toBringBack.withParent,
      fields,
    );
    // A record of an object Salesforce undeletes only with its parent, found
    // in the bin with its parent staying, is gone for good: brought back by
    // nothing, it was still read as one coming back. Of any other object, a
    // record gone for good was found by scanning the object's ids.
    const gone = goneForGood(object);
    if (broughtBack(object) > 0 || (undeletable === false && gone > 0)) backTo.add(objectApiName);
    if (gone > 0 && undeletable !== false) scans.push(streamedReadsCost([pagesOf(records)]));
  }
  const whole = (object: RewindDiffObject): boolean => object.schemaDrift !== undefined;
  const describedFirst = input.diff.objects.filter(
    (object) => backTo.has(object.objectApiName) && !whole(object),
  ).length;
  let describedAfter = 0;
  let describesGlobal = false;
  let outside = 0;
  for (const { objectApiName } of input.objects) {
    const object = found.get(objectApiName);
    if (object === undefined || deletedFirst(object) === 0) continue;
    if (!whole(object) && !backTo.has(objectApiName)) describedAfter++;
    const relationships = input.relationships?.get(objectApiName)?.outside ?? {
      all: object.outside.length,
      worked: object.outside.length,
    };
    if (relationships.all > 0) describesGlobal = true;
    outside += outsideReads(deletedFirst(object), relationships.worked);
  }
  const users = new Set(input.diff.objects.flatMap((object) => Object.keys(object.lastChangedBy)));
  return sum(
    calls(DIFF_FIXED_REQUESTS, SECONDS_PER_SMALL_CALL),
    calls(callsFor(input.objects.length, SUBREQUESTS_PER_COMPOSITE), SECONDS_PER_DESCRIBE_CALL),
    changeReadsCost({
      objects: input.objects.length,
      held: input.objects
        .filter((object) => object.records > 0)
        .map((object) => object.objectApiName),
      moved,
    }),
    calls(values, SECONDS_PER_READ),
    calls(callsFor(describedFirst, SUBREQUESTS_PER_COMPOSITE), SECONDS_PER_DESCRIBE_CALL),
    calls(describedAfter, SECONDS_PER_SMALL_CALL),
    calls(describesGlobal ? 1 : 0, SECONDS_PER_DESCRIBE_CALL),
    calls(outside, SECONDS_PER_SMALL_CALL),
    ...scans,
    calls(
      callsFor(callsFor(users.size, USERS_PER_READ), QUERIES_PER_COMPOSITE),
      SECONDS_PER_SMALL_CALL,
    ),
  );
}

// ─── The rewind and the undo ─────────────────────────────────────────────────

/** What a rewind's estimate is made from. */
export interface RewindEstimateInput extends DiffEstimateInput {
  /**
   * Requests the preview's read of the org's automation took
   * (`ForgeTargetAutomation.requests`): the rewind reads it again before it
   * writes. 0 when the preview read none.
   */
  automationRequests: number;
  /**
   * The rewind acts on the diff the command line just showed, read in the
   * same command, and reads no fresh one.
   */
  reusesPreview?: boolean;
}

/** Bytes, about, a rewind keeps in its journal for 15 days. */
function journalBytes(given: number, ids: number): number {
  return given * JOURNAL_BYTES_PER_VALUES + ids * JOURNAL_BYTES_PER_ID;
}

/**
 * The API requests, time and disk a rewind costs, about, from what the
 * preview found, in the order a rewind goes:
 *
 * - the guard and the day's limits; the fresh diff, unless it acts on the
 *   one the command line just read;
 * - once it has something to write, the automation read; pass 1 — bring
 *   back, parents first, with the reads of the children that came back
 *   through each relationship the org deletes along; the give-back, by
 *   chunks of 2,000; the removal of what was created or brought back since —;
 *   pass 2, a diff read and the removal of what came back with its parent;
 *   and the verify, a diff read.
 *
 * Pass 2 runs only when pass 1 made progress, and is counted whenever the
 * rewind writes. The records counted are the three numbers of the preview;
 * the bytes, what the journal keeps of them.
 */
export function rewindEstimate(
  input: RewindEstimateInput,
): Omit<CheckpointEstimate, 'apiRequestsLeft'> {
  const objects = input.diff.objects;
  const fieldsOf = new Map(input.objects.map((object) => [object.objectApiName, object.fields]));
  const toDelete = objects.reduce(
    (total, object) => total + deletedFirst(object) + object.toDelete.comesBackWithParent,
    0,
  );
  const toGiveBack = objects.reduce((total, object) => total + object.toGiveBack.records, 0);
  const toBringBack = objects.reduce((total, object) => total + broughtBack(object), 0);
  const records = toDelete + toGiveBack + toBringBack;
  const diff = diffEstimate(input);
  const reads = sum(
    calls(ACT_FIXED_REQUESTS, SECONDS_PER_SMALL_CALL),
    input.reusesPreview === true ? NOTHING : diff,
  );
  if (records === 0) {
    return {
      records: 0,
      apiRequests: reads.apiRequests,
      seconds: Math.ceil(reads.seconds),
      bytes: 0,
    };
  }

  const relationships = (objectApiName: string): ObjectRelationships =>
    relationshipsFor(input.relationships, objectApiName);
  const childrenBack = objects.reduce(
    (total, object) =>
      total + relationships(object.objectApiName).cascades * batches(sentBack(object)),
    0,
  );
  const passOne = sum(
    undeleteCost(objects.map(sentBack)),
    calls(childrenBack, SECONDS_PER_READ),
    ...objects.map((object) =>
      restoreCost(givenBack(object), fieldsOf.get(object.objectApiName) ?? []),
    ),
    removalCost(
      objects.map((object) => ({
        records: deletedFirst(object),
        dependents: relationships(object.objectApiName).dependents,
      })),
    ),
  );
  const passTwo = sum(
    diff,
    removalCost(
      objects.map((object) => ({
        records: object.toDelete.comesBackWithParent,
        dependents: relationships(object.objectApiName).dependents,
      })),
    ),
  );
  const cost = sum(
    reads,
    calls(input.automationRequests, SECONDS_PER_READ),
    passOne,
    passTwo,
    diff,
  );
  return {
    records,
    apiRequests: cost.apiRequests,
    seconds: Math.ceil(cost.seconds),
    bytes: journalBytes(
      objects.reduce((total, object) => total + givenBack(object), 0),
      toDelete + toBringBack,
    ),
  };
}

/** What a rewind did to one object, as its journal says: what an undo takes back. */
export interface RewoundObject {
  objectApiName: string;
  /** Records it deleted: an undo brings them back. */
  deleted: number;
  /** Records it brought back: an undo sends them back to the recycle bin. */
  broughtBack: number;
  /** Records it gave values back: an undo gives them the values it wrote over. */
  givenBack: number;
}

/**
 * Requests per batch of 200 an undo's bring back sends: the batch read in the
 * recycle bin, then among the live records, and the undelete itself (a SOAP
 * call). It says back no stamps — an undo taken up again plans only what the
 * one before left — so it reads neither the clock nor its user.
 */
const UNDO_UNDELETE_REQUESTS_PER_BATCH = 3;

/**
 * SOAP calls one call of `restoreOverwrites` sends in an undo, whatever it
 * gives back: the org's clock, which the rewind's last write, dated by this
 * machine's, is read on. It says back no stamps, so it reads no user.
 */
const UNDO_RESTORE_FIXED_REQUESTS = 1;

/**
 * What an undo's bring back costs, per object the records it brings back:
 * per batch of 200, the bin read, the live read and the undelete.
 */
function undoUndeleteCost(records: readonly number[]): Cost {
  const batchCount = records.reduce((total, count) => total + batches(count), 0);
  return sum(
    calls(batchCount * (UNDO_UNDELETE_REQUESTS_PER_BATCH - 1), SECONDS_PER_READ),
    calls(batchCount, SECONDS_PER_WRITE),
  );
}

/**
 * What an undo's give-back of `records` records of one object costs, a chunk
 * of {@link SNAPSHOT_CHUNK_IDS} a call of `restoreOverwrites`: per chunk, its
 * clock, the org's values read by id in the object's column groups, the
 * updates; then the records read again by id, once the undo is through.
 */
function undoRestoreCost(records: number, fields: readonly string[]): Cost {
  let cost = NOTHING;
  for (let left = records; left > 0; left -= SNAPSHOT_CHUNK_IDS) {
    const chunk = Math.min(left, SNAPSHOT_CHUNK_IDS);
    cost = sum(
      cost,
      calls(UNDO_RESTORE_FIXED_REQUESTS, SECONDS_PER_SMALL_CALL),
      calls(readsById(chunk, fields), SECONDS_PER_READ),
      calls(runRequestsEstimate([{ rows: chunk }]), SECONDS_PER_WRITE),
      calls(readsById(chunk, fields), SECONDS_PER_READ),
    );
  }
  return cost;
}

/** What an undo's estimate is made from. */
export interface UndoEstimateInput {
  /** The checkpoint's objects (`OrgCheckpoint.objects`). */
  objects: readonly EstimatedObject[];
  /** What the rewind's journal says it did, per object. */
  rewound: readonly RewoundObject[];
  /** Requests a read of the org's automation takes: the undo reads it before it writes. */
  automationRequests: number;
  /** As {@link RewindEstimateInput.relationships}. */
  relationships?: ReadonlyMap<string, ObjectRelationships>;
}

/**
 * The API requests and time an undo costs, about, from what the rewind's
 * journal says it did (`rewoundObjects`), each brick as `undoRewind` sends
 * it: the guard and the day's limits; the automation read; the removal of
 * what the rewind brought back; what it deleted brought back, saying back no
 * stamps; what it wrote over given back, by chunks of 2,000; and one verify,
 * the records it gave back read again by their ids. What it brought back and
 * sent back the bricks read around their own writes, and are not read again.
 * It keeps nothing more on this machine.
 */
export function undoEstimate(
  input: UndoEstimateInput,
): Omit<CheckpointEstimate, 'apiRequestsLeft'> {
  const fieldsOf = new Map(input.objects.map((object) => [object.objectApiName, object.fields]));
  const records = input.rewound.reduce(
    (total, object) => total + object.deleted + object.broughtBack + object.givenBack,
    0,
  );
  const fixed = calls(ACT_FIXED_REQUESTS, SECONDS_PER_SMALL_CALL);
  if (records === 0) {
    return {
      records: 0,
      apiRequests: fixed.apiRequests,
      seconds: Math.ceil(fixed.seconds),
      bytes: 0,
    };
  }
  const cost = sum(
    fixed,
    calls(input.automationRequests, SECONDS_PER_READ),
    removalCost(
      input.rewound.map((object) => ({
        records: object.broughtBack,
        dependents: relationshipsFor(input.relationships, object.objectApiName).dependents,
      })),
    ),
    undoUndeleteCost(input.rewound.map((object) => object.deleted)),
    ...input.rewound.map((object) =>
      undoRestoreCost(object.givenBack, fieldsOf.get(object.objectApiName) ?? []),
    ),
  );
  return { records, apiRequests: cost.apiRequests, seconds: Math.ceil(cost.seconds), bytes: 0 };
}

// ─── The budget gate ─────────────────────────────────────────────────────────

/** An act a checkpoint refuses past the requests the org has left today. */
export type BudgetedAct = 'take' | 'rewind' | 'undo';

/** What each act says it is, what to do, and what it did not do, as its refusal reads. */
const BUDGET_WORDS: Readonly<Record<BudgetedAct, { what: string; then: string; done: string }>> = {
  take: {
    what: 'This checkpoint',
    then:
      'Take it once the org has requests to spare — the limit is counted over the last 24 ' +
      'hours — or pick fewer objects.',
    done: 'No record was read.',
  },
  rewind: {
    what: 'This rewind',
    then: 'Rewind once the org has requests to spare — the limit is counted over the last 24 hours.',
    done: 'No record was read or written.',
  },
  undo: {
    what: 'This undo',
    then:
      'Undo the rewind once the org has requests to spare — the limit is counted over the last ' +
      '24 hours — while the recycle bin still holds what it brings back.',
    done: 'No record was read or written.',
  },
};

/**
 * The requests the org has left today, read once, before anything else of
 * the act: an act that cannot tell does not run, as one that runs the org out
 * of them stops its integrations too.
 *
 * @throws When the org does not say, naming it.
 */
export async function readBudget(org: LimitsTransport, orgName: string): Promise<ApiBudget> {
  try {
    return await readApiBudget(org);
  } catch (err: unknown) {
    throw new Error(
      `${orgName} did not say how many API requests it has left today: ${extractErrorMessage(err)}`,
    );
  }
}

/**
 * The refusal of an act that would take more API requests than `budget`
 * leaves the org today, in the words a person reads; nothing when it fits.
 */
export function budgetRefusal(
  act: BudgetedAct,
  apiRequests: number,
  budget: ApiBudget,
  orgName: string,
): CheckpointRefusal | undefined {
  if (apiBudgetCheckOf(apiRequests, budget).verdict !== 'exceeds') return undefined;
  const words = BUDGET_WORDS[act];
  return {
    code: 'API_BUDGET',
    message:
      `${words.what} takes about ${apiRequests} API requests; ${orgName} has ` +
      `${budget.remaining} of its ${budget.max} left today. ${words.then} ${words.done}`,
  };
}

/**
 * An act's estimate against the requests the org has left today, and its
 * refusal when it would take more.
 */
export interface BudgetGate {
  estimate: CheckpointEstimate;
  refusal?: CheckpointRefusal;
}

/**
 * Hold an act's estimate to the requests the org has left today: the day's
 * limits read, and nothing else of the org, so a refusal comes before any
 * record is read or written.
 *
 * @throws When the org does not say what it has left: the act does not run.
 */
export async function budgetGate(
  org: LimitsTransport,
  act: BudgetedAct,
  orgName: string,
  cost: Omit<CheckpointEstimate, 'apiRequestsLeft'>,
): Promise<BudgetGate> {
  const budget = await readBudget(org, orgName);
  const estimate: CheckpointEstimate = { ...cost, apiRequestsLeft: budget.remaining };
  const refusal = budgetRefusal(act, cost.apiRequests, budget, orgName);
  return refusal === undefined ? { estimate } : { estimate, refusal };
}
