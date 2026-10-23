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
  CheckpointReadMode,
  CheckpointRefusal,
  CheckpointTakePhase,
  ForgeEmailLimit,
  RewindDiff,
  RewindDiffObject,
} from '@sandforge/shared';
import * as z from 'zod';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { columnGroups, idsPerStatement } from '../../core/common/wideRead.js';
import { RECORDS_PER_CALL } from '../dataops/RecordRemoval.js';
import {
  apiBudgetCheckOf,
  readApiBudget,
  readEmailLimits,
  runRequestsEstimate,
  type ApiBudget,
  type EmailLimit,
  type LimitsTransport,
} from '../forge/ForgeRunGate.js';
import { QUERIES_PER_COMPOSITE, SUBREQUESTS_PER_COMPOSITE } from './compositeQueries.js';
import { SNAPSHOT_CHUNK_IDS, snapshotIndexBytes } from './snapshotIndex.js';
import { RUN_RECORDS_PAGE } from './spooledRunRecords.js';

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
 * Requests a take's guard phase sends whatever the org holds: the guard's
 * reads of the org's Organization record and edition (one of them asked by
 * the take itself of a sandbox, whose edition the guard does not read) and of
 * the user's permissions, then the day's limits.
 */
const TAKE_GUARD_REQUESTS = 4;

/**
 * Requests a take's scope sends beside its object describes: the two global
 * describes, the data API's and the Tooling API's, and the user's View
 * Encrypted Data permission.
 */
const TAKE_SCOPE_REQUESTS = 3;

/**
 * Requests a take sends once its scope is read: the user it reads as and T0
 * on the org's clock, both SOAP calls, and the org's Automated Process user.
 */
const TAKE_START_REQUESTS = 3;

/**
 * Requests a take's snapshot sends beside its pages: which org it read, asked
 * once the objects are read. None when no object holds a record, as then no
 * snapshot is read.
 */
const SNAPSHOT_ORG_REQUESTS = 1;

/** Requests a take's last phase sends before its reads of what moved: T1 on the org's clock, a SOAP call. */
const STABILITY_CLOCK_REQUESTS = 1;

/**
 * The term the reads by id of a snapshot read through the recycle bin keep
 * to (DataOps' `LIVE_ROWS`): a Task's or an Event's other column groups name
 * it beside their ids, which leaves room for fewer ids.
 */
const SNAPSHOT_LIVE_ROWS = 'IsDeleted = false';

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
 * Requests per batch of 200 `undeleteRunDeletions` sends when it is asked
 * for no stamps: the batch read in the recycle bin, then among the live
 * records, and the undelete itself (a SOAP call). Asked for none, it reads
 * neither the org's clock nor its user.
 */
const UNDELETE_REQUESTS_PER_BATCH = 3;

/**
 * Requests per batch of 200 a rewind sends beside the undelete's own: what
 * the undelete left on its records, read back by their ids.
 */
const REWIND_UNDELETE_STAMPS_PER_BATCH = 1;

/** The user a rewind writes as, a SOAP call, read once it will write. */
const REWIND_USER_REQUESTS = 1;

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
function readGroupsOf(fields: readonly string[]): number {
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

/** One object a take holds, as its estimate reads it. */
export interface TakenObject {
  records: number;
  /**
   * For each of its column groups after the first, the ids one statement
   * reading it by id names ({@link snapshotGroupReads}): none for an object
   * one statement reads whole.
   */
  otherGroups?: readonly number[];
}

/** What a take's estimate is made from. */
export interface TakeEstimateInput {
  /** Objects described: the scope's candidates, 25 a composite. */
  described: number;
  /** Of them, those whose describe a composite did not answer, each asked again alone. */
  describedAlone?: number;
  /**
   * Objects counted: every object the scope kept once described, those the
   * org then would not count whole and those past the limit for one object
   * among them. As many as {@link objects} unless given.
   */
  counted?: number;
  /** Of them, those whose count a composite did not answer, each asked again alone. */
  countedAlone?: number;
  /** Per object the take holds, its records and how its other column groups are read. */
  objects: readonly TakenObject[];
  /** Rows a page of the snapshot reads: what the org's kind reads at a time. */
  pageRows: number;
}

/**
 * For each column group of a snapshot's object after the first, the ids one
 * statement reading it by id names, as the snapshot's handler reads them
 * (`readOtherColumnsAtOneStamp`): every group carries the id and the stamp,
 * and an object read through the recycle bin keeps each read to its live
 * rows. None for an object whose fields one statement names.
 */
export function snapshotGroupReads(
  objectApiName: string,
  fields: readonly string[],
  readMode: CheckpointReadMode,
): number[] {
  const [, ...others] = columnGroups(fields, CARRIED_COLUMNS);
  const where = readMode === 'scanAllLive' ? SNAPSHOT_LIVE_ROWS : undefined;
  return others.map((group) => idsPerStatement(objectApiName, group, where));
}

/** Statements the reads by id of a page of `rows` rows send, one column group after another. */
function groupReadsOf(rows: number, otherGroups: readonly number[]): number {
  return otherGroups.reduce((total, ids) => total + callsFor(rows, Math.max(1, ids)), 0);
}

/**
 * The snapshot's calls for one object: its pages, `pageRows` rows each and
 * what is left on the last, a call each; and each page's other column groups
 * read by its ids, as many a statement as the group leaves room for, so a
 * page of fewer rows takes fewer statements and a group of many columns more.
 */
function snapshotCallsOf(object: TakenObject, pageRows: number): { pages: number; reads: number } {
  if (object.records === 0) return { pages: 0, reads: 0 };
  const full = Math.floor(object.records / pageRows);
  const rest = object.records - full * pageRows;
  const groups = object.otherGroups ?? [];
  return {
    pages: full + (rest > 0 ? 1 : 0),
    reads: full * groupReadsOf(pageRows, groups) + groupReadsOf(rest, groups),
  };
}

/**
 * The API requests, time and disk a take costs, about, phase by phase as the
 * take sends them, a composite one request whatever it holds:
 *
 * - `guard`: the org, its edition and the user's permissions, then the day's
 *   limits;
 * - `scope`: the two global describes, the objects' describes 25 a call and
 *   again alone each one a call did not answer, the View Encrypted Data
 *   permission;
 * - `start`: the user, the Automated Process user and T0;
 * - `counts`: every object kept once described, five a call, and again alone
 *   each count a call did not answer — an object then left out, as the org
 *   would not count it or as it holds more than one object may, was counted
 *   all the same;
 * - `bin`: the recycle bin at T0, each object's first page, five a call;
 * - `snapshot`: a page a call, each page's other column groups by its ids,
 *   and the read of which org the snapshot is of;
 * - `stability`: T1, then each object's newest stamp, five a call.
 *
 * Not known before the take reads them, and left out: the recycle bin's
 * further pages (an object holding more than a page of ids in the bin at T0
 * takes a call per page past the first, for the longest of the five objects
 * read with it); what moved in the five minutes before T0 or while the take
 * ran (two reads an object that moved, five a call, followed to their end,
 * and its count); the pages of an org that answers fewer rows than it is
 * asked; and the rows a write moved between two column groups, read again.
 */
export function takeEstimate(
  input: TakeEstimateInput,
): Omit<CheckpointEstimate, 'apiRequestsLeft'> {
  const kept = input.objects.length;
  const describeCalls = callsFor(input.described, SUBREQUESTS_PER_COMPOSITE);
  const describedAlone = input.describedAlone ?? 0;
  const counts = callsFor(input.counted ?? kept, QUERIES_PER_COMPOSITE) + (input.countedAlone ?? 0);
  const fiveAtATime = callsFor(kept, QUERIES_PER_COMPOSITE);
  let pages = 0;
  let reads = 0;
  let records = 0;
  let bytes = 0;
  for (const object of input.objects) {
    records += object.records;
    bytes += object.records * BYTES_PER_RECORD + snapshotIndexBytes(object.records);
    const calls = snapshotCallsOf(object, input.pageRows);
    pages += calls.pages;
    reads += calls.reads;
  }
  const requestsByPhase: Record<CheckpointTakePhase, number> = {
    guard: TAKE_GUARD_REQUESTS,
    scope: TAKE_SCOPE_REQUESTS + describeCalls + describedAlone,
    start: TAKE_START_REQUESTS,
    counts,
    bin: fiveAtATime,
    snapshot: pages + reads + (pages > 0 ? SNAPSHOT_ORG_REQUESTS : 0),
    stability: STABILITY_CLOCK_REQUESTS + fiveAtATime,
  };
  return {
    records,
    apiRequests: Object.values(requestsByPhase).reduce((total, phase) => total + phase, 0),
    requestsByPhase,
    seconds: Math.ceil(
      describeCalls * SECONDS_PER_DESCRIBE_CALL +
        (describedAlone + counts + 2 * fiveAtATime) * SECONDS_PER_SMALL_CALL +
        pages * SECONDS_PER_PAGE +
        reads * SECONDS_PER_READ,
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
 * What `undeleteRunDeletions` costs when it is asked for no stamps, per
 * object the records it brings back: per batch of 200, the bin read, the
 * live read and the undelete.
 */
export function undeleteCost(records: readonly number[]): Cost {
  const batchCount = records.reduce((total, count) => total + batches(count), 0);
  return sum(
    calls(batchCount * (UNDELETE_REQUESTS_PER_BATCH - 1), SECONDS_PER_READ),
    calls(batchCount, SECONDS_PER_WRITE),
  );
}

/** An object a rewind brings records back to, as its bring back reads it. */
export interface BroughtBackObject {
  /** Records sent to the undelete: those that come back with a parent are not. */
  records: number;
  /** Child relationships it deletes along: the children that come back with each batch. */
  cascades: number;
  /** Whether the read the rewind acts on described it: one it did not is described first. */
  described: boolean;
}

/**
 * What a rewind's bring back costs (`rewindOrg`): per object, its describe
 * when the read it acts on gave none — the relationships its children come
 * back through —; per batch of 200, the undelete's own three requests, the
 * children the recycle bin holds of the batch read through each of those
 * relationships before it goes, five reads a call, and what the undelete
 * left on its records read back.
 */
export function bringBackCost(objects: readonly BroughtBackObject[]): Cost {
  return sum(
    ...objects
      .filter((object) => object.records > 0)
      .map(({ records, cascades, described }) => {
        const batchCount = batches(records);
        return sum(
          calls(described ? 0 : 1, SECONDS_PER_DESCRIBE_CALL),
          undeleteCost([records]),
          calls(batchCount * callsFor(cascades, QUERIES_PER_COMPOSITE), SECONDS_PER_SMALL_CALL),
          calls(batchCount * REWIND_UNDELETE_STAMPS_PER_BATCH, SECONDS_PER_READ),
        );
      }),
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

/**
 * What a rewind's bring back costs beyond its own for the `records` records
 * of one object of the checkpoint that come back with a parent it brings
 * back: their describe when the read it acts on gave none, then, as each
 * batch of what it brings back is named, the records the bin holds under
 * them through each of the object's `cascades`, five a call, 200 of them at
 * a time — at most a part-full read per batch it brings back
 * (`topBatches`), and one per 200 of them. Under records outside the
 * checkpoint that come back with a parent, what the bin holds is read as it
 * is found, and not counted.
 */
function cameBackUnderCost(
  records: number,
  cascades: number,
  topBatches: number,
  described: boolean,
): Cost {
  if (records === 0 || topBatches === 0) return NOTHING;
  return sum(
    calls(described ? 0 : 1, SECONDS_PER_DESCRIBE_CALL),
    calls(
      (topBatches + batches(records)) * callsFor(cascades, QUERIES_PER_COMPOSITE),
      SECONDS_PER_SMALL_CALL,
    ),
  );
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
   * The objects of those children, by API name: a record of one the rewind
   * deletes may hold values of this one's in place. Absent, any object read
   * before this one in the checkpoint's order may.
   */
  cascadeChildren?: string[];
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
  const cascading = children.filter((r) => r.cascadeDelete === true);
  const relationships: ObjectRelationships = {
    dependents: children.filter((r) => r.cascadeDelete === true || r.restrictedDelete === true)
      .length,
    cascades: cascading.length,
    cascadeChildren: [
      ...new Set(cascading.flatMap((r) => (r.childSObject === undefined ? [] : [r.childSObject]))),
    ],
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
 *
 * @param pageRecords - The records of an object the removal is handed a page
 *   at a time, and checks its dependents for a page at a time: a rewind's
 *   spooled plan comes in pages of 2,000 (`RUN_RECORDS_PAGE`), each of more
 *   than one batch asking its relationships again whether anything points
 *   through them. A plan held in memory is one page.
 */
export function removalCost(
  objects: ReadonlyArray<{ records: number; dependents: number }>,
  pageRecords = Number.POSITIVE_INFINITY,
): Cost {
  const removed = objects.filter((object) => object.records > 0);
  if (removed.length === 0) return NOTHING;
  return sum(
    calls(REMOVAL_FIXED_REQUESTS, SECONDS_PER_SMALL_CALL),
    ...removed.map(({ records, dependents }) => {
      const batchCount = batches(records);
      let pagesOfMore = 0;
      for (let left = records; left > 0; left -= pageRecords) {
        if (Math.min(left, pageRecords) > RECORDS_PER_CALL) pagesOfMore++;
      }
      const anyPointing = pagesOfMore * dependents;
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
 * in the recycle bin: absent, it does. Its place in the checkpoint's order
 * and its fields a parent's delete takes it along by tell which objects its
 * records may hold values of in place: absent, any object.
 */
export type EstimatedObject = Pick<CheckpointObject, 'objectApiName' | 'records' | 'fields'> &
  Partial<Pick<CheckpointObject, 'undeletable' | 'readOrder' | 'cascadeParents'>>;

/** What the reads of what changed since a checkpoint are estimated from. */
export interface DiffEstimateInput {
  /** The checkpoint's objects (`OrgCheckpoint.objects`). */
  objects: readonly EstimatedObject[];
  /**
   * What the last read found: the objects that moved, those it could not
   * read, the records to delete that go with a parent it deletes too, never
   * sent, and, of the records to delete of objects Salesforce undeletes only
   * with their parent, those deleted on their own, whatever the reason Undo
   * couldn't bring them back. Told neither, every record to delete is
   * counted sent.
   */
  diff: Pick<RewindDiff, 'objects' | 'unread'> &
    Partial<Pick<RewindDiff, 'undoCannot' | 'withParentDeleted'>>;
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

/** One object of the checkpoint as a read of what changed since reads it. */
interface ObjectRead {
  objectApiName: string;
  /** Rows of its read of what moved, among the live records (L). */
  live: number;
  /** Rows of its read of what was deleted (D). */
  deleted: number;
  /** Records whose current values it reads by id. */
  valued: number;
  /** Whether it is described up front: it has records to bring back, or read coming back. */
  backTo: boolean;
  /** Records it finds to delete: its describe after, and what lies outside under them. */
  deletes: number;
  /** Whether every id of it is scanned for the records gone for good. */
  scans: boolean;
  /** Whether its drift describe came back whole, answering for its relationships. */
  whole: boolean;
  /** Its relationships to objects outside the checkpoint, as described or as last found. */
  outside: { all: number; worked: number };
}

/**
 * How a read finds `object`, as the last read found it: what moved, which
 * values it reads, what it describes. A record of an object Salesforce
 * undeletes only with its parent, found in the bin with its parent staying,
 * is gone for good: brought back by nothing, it was still read as one coming
 * back. Of any other object, a record gone for good was found by scanning the
 * object's ids.
 */
function readOf(
  object: RewindDiffObject,
  held: EstimatedObject,
  relationships: ReadonlyMap<string, ObjectRelationships> | undefined,
): ObjectRead {
  const gone = goneForGood(object);
  return {
    objectApiName: object.objectApiName,
    live: object.toGiveBack.records + object.touched + deletedFirst(object) + object.unexplained,
    deleted: broughtBack(object) + object.toDelete.comesBackWithParent,
    valued: object.toGiveBack.records + object.touched + object.toBringBack.withParent,
    backTo: broughtBack(object) > 0 || (held.undeletable === false && gone > 0),
    deletes: deletedFirst(object),
    scans: gone > 0 && held.undeletable !== false,
    whole: object.schemaDrift !== undefined,
    outside: relationships?.get(object.objectApiName)?.outside ?? {
      all: object.outside.length,
      worked: object.outside.length,
    },
  };
}

/**
 * How a read finds `object` once a pass of the rewind went through, as the
 * last read found it: what it gave back and brought back moved since and holds
 * its checkpoint values — its values read, nothing to do —, what it deleted is
 * in the recycle bin, what came back with a parent waits for the second pass
 * until it deletes it, and what it does not touch is found as before. A
 * record brought back that was deleted while the checkpoint was taken is live
 * and not in the snapshot: found, and left, as one the checkpoint does not
 * explain.
 */
function readAfterPass(
  object: RewindDiffObject,
  held: EstimatedObject,
  relationships: ReadonlyMap<string, ObjectRelationships> | undefined,
  secondPassThrough: boolean,
): ObjectRead {
  const first = readOf(object, held, relationships);
  const back = object.toBringBack;
  const waiting = secondPassThrough ? 0 : object.toDelete.comesBackWithParent;
  return {
    ...first,
    live:
      object.toGiveBack.records +
      object.touched +
      object.unexplained +
      broughtBack(object) +
      waiting,
    deleted: deletedFirst(object) + object.toDelete.comesBackWithParent - waiting,
    valued: object.toGiveBack.records + object.touched + back.inBin + back.withParent,
    backTo: held.undeletable === false && goneForGood(object) > 0,
    deletes: waiting,
  };
}

/**
 * What one read of the org since the checkpoint costs, each part as
 * `rewindDiff` sends it, given how it finds each object (`reads`), the
 * objects it reads again for being unread last time, and the users it names:
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
function readCost(
  objects: readonly EstimatedObject[],
  reads: ReadonlyMap<string, ObjectRead>,
  unread: ReadonlySet<string>,
  users: number,
): Cost {
  const moved: MovedObject[] = [];
  const scans: Cost[] = [];
  let values = 0;
  let describedFirst = 0;
  let describedAfter = 0;
  let describesGlobal = false;
  let outside = 0;
  for (const { objectApiName, records, fields } of objects) {
    const read = reads.get(objectApiName);
    if (read === undefined) {
      if (unread.has(objectApiName)) moved.push({ objectApiName, live: 0, deleted: 0 });
      continue;
    }
    moved.push({ objectApiName, live: read.live, deleted: read.deleted });
    values += readsById(read.valued, fields);
    if (read.backTo && !read.whole) describedFirst++;
    if (read.scans) scans.push(streamedReadsCost([pagesOf(records)]));
    if (read.deletes === 0) continue;
    if (!read.whole && !read.backTo) describedAfter++;
    if (read.outside.all > 0) describesGlobal = true;
    outside += outsideReads(read.deletes, read.outside.worked);
  }
  return sum(
    calls(DIFF_FIXED_REQUESTS, SECONDS_PER_SMALL_CALL),
    calls(callsFor(objects.length, SUBREQUESTS_PER_COMPOSITE), SECONDS_PER_DESCRIBE_CALL),
    changeReadsCost({
      objects: objects.length,
      held: objects.filter((object) => object.records > 0).map((object) => object.objectApiName),
      moved,
    }),
    calls(values, SECONDS_PER_READ),
    calls(callsFor(describedFirst, SUBREQUESTS_PER_COMPOSITE), SECONDS_PER_DESCRIBE_CALL),
    calls(describedAfter, SECONDS_PER_SMALL_CALL),
    calls(describesGlobal ? 1 : 0, SECONDS_PER_DESCRIBE_CALL),
    calls(outside, SECONDS_PER_SMALL_CALL),
    ...scans,
    calls(callsFor(callsFor(users, USERS_PER_READ), QUERIES_PER_COMPOSITE), SECONDS_PER_SMALL_CALL),
  );
}

/** The checkpoint's objects the last read found, by name, each with how a read finds it. */
function readsOf(
  input: DiffEstimateInput,
  find: (object: RewindDiffObject, held: EstimatedObject) => ObjectRead,
): Map<string, ObjectRead> {
  const found = new Map(input.diff.objects.map((object) => [object.objectApiName, object]));
  const reads = new Map<string, ObjectRead>();
  for (const held of input.objects) {
    const object = found.get(held.objectApiName);
    if (object) reads.set(held.objectApiName, find(object, held));
  }
  return reads;
}

/**
 * What one read of the org since the checkpoint costs as the last read found
 * the org — a preview, a rewind's fresh diff — each part as `rewindDiff`
 * sends it: see {@link readCost}.
 */
export function diffEstimate(input: DiffEstimateInput): Cost {
  const users = new Set(input.diff.objects.flatMap((object) => Object.keys(object.lastChangedBy)));
  return readCost(
    input.objects,
    readsOf(input, (object, held) => readOf(object, held, input.relationships)),
    new Set(input.diff.unread.map((object) => object.objectApiName)),
    users.size,
  );
}

/**
 * What a read of the org costs once a pass of the rewind went through, as the
 * last read found it (`readAfterPass`): the read after the first pass, which
 * plans the second, or the verify, once the second deleted what came back
 * with a parent. Before the second, the records that came back with a parent
 * are to delete, and the users who last changed them named.
 */
function readAfterPassCost(input: DiffEstimateInput, secondPassThrough: boolean): Cost {
  const waiting =
    !secondPassThrough &&
    input.diff.objects.some((object) => object.toDelete.comesBackWithParent > 0);
  return readCost(
    input.objects,
    readsOf(input, (object, held) =>
      readAfterPass(object, held, input.relationships, secondPassThrough),
    ),
    new Set(input.diff.unread.map((object) => object.objectApiName)),
    waiting ? 1 : 0,
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
   * same command, and reads no fresh one: the objects it brings records back
   * to are then described as it brings them back.
   */
  reusesPreview?: boolean;
}

/** Bytes, about, a rewind keeps in its journal for 15 days. */
function journalBytes(given: number, ids: number): number {
  return given * JOURNAL_BYTES_PER_VALUES + ids * JOURNAL_BYTES_PER_ID;
}

/**
 * What one more call of `restoreOverwrites` over some records of an object
 * costs beyond what one over all of them costs: its clock and its user, and
 * a part-full read of each column group, update and stamps read.
 */
function splitCost(fields: readonly string[]): Cost {
  return sum(
    calls(RESTORE_FIXED_REQUESTS, SECONDS_PER_SMALL_CALL),
    calls(readGroupsOf(fields), SECONDS_PER_READ),
    calls(1, SECONDS_PER_WRITE),
    calls(1, SECONDS_PER_READ),
  );
}

/** How a rewind may give an object's records back, as far as the diff tells. */
interface GivenBackWays {
  /** After its deletes: records of an object it deletes may hold values of these in place. */
  held: boolean;
  /** Before them as well: records of an object it deletes may be parents of these. */
  twice: boolean;
  /** In its second pass: records of an object that comes back with a parent may hold them. */
  nextPass: boolean;
}

/**
 * What giving `records` records of one object back costs, as `rewindOrg`
 * gives them, a chunk of 2,000 a call (`restoreCost`):
 *
 * - an order's status, alone, before its other fields: a call of its own per
 *   chunk, on the orders that were Draft at the checkpoint;
 * - records it gives back after its deletes — values the records it deletes
 *   held in place — kept first, read by id before the pass writes, and given
 *   back in calls of their own;
 * - of those, records it gives back before its deletes as well, children of
 *   records it deletes: given back before in calls of their own too;
 * - records whose children come back with a parent, given back by the second
 *   pass after it deleted those: kept first, and given back there.
 *
 * Which of an object's records each of these takes is known once the rewind
 * plans its pass: an object that may take some is counted as if each took
 * all of its records, so the count is the most it sends.
 */
function givenBackCost(
  objectApiName: string,
  records: number,
  fields: readonly string[],
  ways: GivenBackWays,
): Cost {
  if (records === 0) return NOTHING;
  const status =
    objectApiName === 'Order'
      ? fields.find((field) => field.toLowerCase() === 'status')
      : undefined;
  const statusFields = status === undefined ? [] : [status];
  const phase = (count: number): Cost =>
    sum(restoreCost(count, fields), status ? restoreCost(count, statusFields) : NOTHING);
  const split = sum(splitCost(fields), status ? splitCost(statusFields) : NOTHING);
  const keptFirst = calls(readsById(records, fields), SECONDS_PER_READ);
  return sum(
    phase(records),
    ways.held ? sum(keptFirst, split) : NOTHING,
    ways.held && ways.twice ? sum(phase(records), split) : NOTHING,
    ways.nextPass ? sum(keptFirst, split) : NOTHING,
  );
}

/**
 * Whether records of `child` may hold values of `parent`'s in place: the
 * describe of `parent` lists `child` among the objects its delete takes along;
 * or, not described, `child` is held by some parent's delete and read before
 * `parent` in the checkpoint's order, children first.
 */
function mayHangFrom(
  child: EstimatedObject | undefined,
  childName: string,
  parent: EstimatedObject,
  relationships: ReadonlyMap<string, ObjectRelationships> | undefined,
): boolean {
  const children = relationships?.get(parent.objectApiName)?.cascadeChildren;
  if (children !== undefined) return children.includes(childName);
  if (child?.cascadeParents !== undefined && child.cascadeParents.length === 0) return false;
  if (child?.readOrder !== undefined && parent.readOrder !== undefined) {
    return child.readOrder < parent.readOrder;
  }
  return true;
}

/**
 * What a rewind sends once it has read the org and found something to write,
 * each part as `rewindOrg` sends it:
 *
 * - the user it writes as;
 * - pass 1: the bring back, parents first (`bringBackCost`), and the org's
 *   objects described for it unless the read before did; the give-back,
 *   before and after the deletes (`givenBackCost`); the removal of what was
 *   created or brought back since (`removalCost`);
 * - the read after it, which plans pass 2 and is the verify when pass 2 has
 *   nothing to do;
 * - pass 2 and the verify after it, when records come back with a parent:
 *   pass 2 deletes them, and gives back what they held in place.
 *
 * The read after a pass finds the org as the rewind leaves it, never a
 * preview's worth of work. Not counted: a record sent again without a field
 * the org refused, what the org's automation does in answer, a second pass
 * for what the first left refused, and the records the first leaves for one
 * of these reasons, which the read after it finds.
 */
export function rewindWritesCost(input: RewindEstimateInput): Cost {
  const objects = input.diff.objects;
  const heldOf = new Map(input.objects.map((object) => [object.objectApiName, object]));
  const relationships = (objectApiName: string): ObjectRelationships =>
    relationshipsFor(input.relationships, objectApiName);
  // Every reason together: of an object Salesforce undeletes only with its
  // parent, a record Undo couldn't bring back is sent on its own, whether its
  // parent stays or is deleted after it.
  const alone = input.diff.undoCannot
    ? input.diff.undoCannot.reduce(
        (sum, { objectApiName, count }) =>
          sum.set(objectApiName, (sum.get(objectApiName) ?? 0) + count),
        new Map<string, number>(),
      )
    : undefined;
  const along = input.diff.withParentDeleted
    ? new Map(
        input.diff.withParentDeleted.map(({ objectApiName, count }) => [objectApiName, count]),
      )
    : undefined;
  /**
   * Records the first pass hands its removal: all but those that go with a
   * parent it deletes too, which hold nothing given back in place. A diff that
   * does not count those tells, of an object Salesforce undeletes only with
   * its parent, the records deleted on their own, but those that come back
   * with a parent, which the second pass deletes.
   */
  const sentFirst = (object: RewindDiffObject): number => {
    if (along !== undefined) {
      return Math.max(0, deletedFirst(object) - (along.get(object.objectApiName) ?? 0));
    }
    if (alone === undefined || heldOf.get(object.objectApiName)?.undeletable !== false) {
      return deletedFirst(object);
    }
    const own = (alone.get(object.objectApiName) ?? 0) - object.toDelete.comesBackWithParent;
    return Math.max(0, Math.min(deletedFirst(object), own));
  };
  const deleting = objects.filter((object) => sentFirst(object) > 0);
  const comingBack = objects.filter((object) => object.toDelete.comesBackWithParent > 0);
  /** Whether records of one of `children` may hang from records of `parent`. */
  const holds = (parent: EstimatedObject, children: readonly RewindDiffObject[]): boolean =>
    children.some(
      (child) =>
        child.objectApiName !== parent.objectApiName &&
        mayHangFrom(
          heldOf.get(child.objectApiName),
          child.objectApiName,
          parent,
          input.relationships,
        ),
    );
  /** Whether records of `child` may hang from records of one of `parents`. */
  const hangs = (child: EstimatedObject, parents: readonly RewindDiffObject[]): boolean =>
    parents.some((parent) => {
      const held = heldOf.get(parent.objectApiName);
      return (
        held !== undefined &&
        parent.objectApiName !== child.objectApiName &&
        mayHangFrom(child, child.objectApiName, held, input.relationships)
      );
    });
  const topBatches = objects.reduce((total, object) => total + batches(sentBack(object)), 0);
  // The org's objects, described once a record with children to read comes
  // back — which of them the org does not query — unless the read the rewind
  // acts on described them, for records to delete with children outside it.
  const describedBefore =
    input.reusesPreview !== true &&
    objects.some(
      (object) =>
        deletedFirst(object) > 0 &&
        (input.relationships?.get(object.objectApiName)?.outside?.all ?? object.outside.length) > 0,
    );
  const backWithChildren = objects.some(
    (object) => sentBack(object) > 0 && relationships(object.objectApiName).cascades > 0,
  );
  const passOne = sum(
    calls(backWithChildren && !describedBefore ? 1 : 0, SECONDS_PER_DESCRIBE_CALL),
    bringBackCost(
      objects.map((object) => ({
        records: sentBack(object),
        cascades: relationships(object.objectApiName).cascades,
        described: input.reusesPreview !== true,
      })),
    ),
    ...objects.map((object) =>
      cameBackUnderCost(
        object.toBringBack.withParent,
        relationships(object.objectApiName).cascades,
        topBatches,
        input.reusesPreview !== true,
      ),
    ),
    ...objects.map((object) => {
      const held = heldOf.get(object.objectApiName);
      if (held === undefined) return NOTHING;
      return givenBackCost(object.objectApiName, givenBack(object), held.fields, {
        held: holds(held, deleting),
        twice: hangs(held, deleting),
        nextPass: holds(held, comingBack),
      });
    }),
    removalCost(
      objects.map((object) => ({
        records: sentFirst(object),
        dependents: relationships(object.objectApiName).dependents,
      })),
      RUN_RECORDS_PAGE,
    ),
  );
  const passTwo =
    comingBack.length > 0
      ? sum(
          removalCost(
            comingBack.map((object) => ({
              records: object.toDelete.comesBackWithParent,
              dependents: relationships(object.objectApiName).dependents,
            })),
            RUN_RECORDS_PAGE,
          ),
          readAfterPassCost(input, true),
        )
      : NOTHING;
  return sum(
    calls(REWIND_USER_REQUESTS, SECONDS_PER_SMALL_CALL),
    passOne,
    readAfterPassCost(input, false),
    passTwo,
  );
}

/**
 * The API requests, time and disk a rewind costs, about, from what the
 * preview found, in the order a rewind goes: the guard and the day's limits;
 * the fresh diff, unless it acts on the one the command line just read; and,
 * once it has something to write, the automation read and its writes
 * (`rewindWritesCost`). The records counted are the three numbers of the
 * preview; the bytes, what the journal keeps of them.
 */
export function rewindEstimate(
  input: RewindEstimateInput,
): Omit<CheckpointEstimate, 'apiRequestsLeft'> {
  const objects = input.diff.objects;
  const toDelete = objects.reduce(
    (total, object) => total + deletedFirst(object) + object.toDelete.comesBackWithParent,
    0,
  );
  const toGiveBack = objects.reduce((total, object) => total + object.toGiveBack.records, 0);
  const toBringBack = objects.reduce((total, object) => total + broughtBack(object), 0);
  const records = toDelete + toGiveBack + toBringBack;
  const reads = sum(
    calls(ACT_FIXED_REQUESTS, SECONDS_PER_SMALL_CALL),
    input.reusesPreview === true ? NOTHING : diffEstimate(input),
  );
  if (records === 0) {
    return {
      records: 0,
      apiRequests: reads.apiRequests,
      seconds: Math.ceil(reads.seconds),
      bytes: 0,
    };
  }
  const cost = sum(
    reads,
    calls(input.automationRequests, SECONDS_PER_READ),
    rewindWritesCost(input),
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
  /**
   * Of {@link givenBack}, those whose values records it deleted held in
   * place: an undo gives them back in calls of their own, before those
   * records come back. Absent when there is none.
   */
  givenBackHeld?: number;
}

/**
 * SOAP calls one call of `restoreOverwrites` sends in an undo, whatever it
 * gives back: the org's clock, which the rewind's last write, dated by this
 * machine's, is read on. It says back no stamps, so it reads no user.
 */
const UNDO_RESTORE_FIXED_REQUESTS = 1;

/**
 * What an undo's give-back of `records` records of one object costs, a chunk
 * of {@link SNAPSHOT_CHUNK_IDS} a call of `restoreOverwrites`: per chunk, its
 * clock, the org's values read by id in the object's column groups, the
 * updates.
 */
function undoGiveBackCalls(records: number, fields: readonly string[]): Cost {
  let cost = NOTHING;
  for (let left = records; left > 0; left -= SNAPSHOT_CHUNK_IDS) {
    const chunk = Math.min(left, SNAPSHOT_CHUNK_IDS);
    cost = sum(
      cost,
      calls(UNDO_RESTORE_FIXED_REQUESTS, SECONDS_PER_SMALL_CALL),
      calls(readsById(chunk, fields), SECONDS_PER_READ),
      calls(runRequestsEstimate([{ rows: chunk }]), SECONDS_PER_WRITE),
    );
  }
  return cost;
}

/**
 * What an undo's give-back of one object's records costs: those held in
 * place given back in calls of their own, before the records that held them
 * come back, the rest after (`undoGiveBackCalls`); then every one read again
 * by id, a chunk at a time, once the undo is through.
 */
function undoRestoreCost(object: RewoundObject, fields: readonly string[]): Cost {
  const held = Math.min(object.givenBackHeld ?? 0, object.givenBack);
  let reread = NOTHING;
  for (let left = object.givenBack; left > 0; left -= SNAPSHOT_CHUNK_IDS) {
    reread = sum(
      reread,
      calls(readsById(Math.min(left, SNAPSHOT_CHUNK_IDS), fields), SECONDS_PER_READ),
    );
  }
  return sum(
    undoGiveBackCalls(held, fields),
    undoGiveBackCalls(object.givenBack - held, fields),
    reread,
  );
}

/**
 * SOAP calls an undo sends once, before its first undelete, when it brings
 * records back and gives some back: the org's clock and its user, what the
 * records its undeletes restamp are read by.
 */
const UNDO_RESTAMPED_FIXED_REQUESTS = 2;

/**
 * What reading what an undo's undeletes restamped of one object's records it
 * gives back costs (`undoRewind`): before its first undelete, a read by id
 * per {@link RECORDS_PER_CALL} records of whether each changed since the
 * rewind; before each of its give-backs, another of those that did not, those
 * held in place apart from the rest.
 */
function undoRestampedReads(object: RewoundObject): Cost {
  const held = Math.min(object.givenBackHeld ?? 0, object.givenBack);
  return calls(
    batches(object.givenBack) + batches(held) + batches(object.givenBack - held),
    SECONDS_PER_READ,
  );
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
 * stamps; what its undeletes restamped of what it gives back, read before each
 * give-back; what it wrote over given back, by chunks of 2,000; and one verify,
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
  const brings = input.rewound.some((object) => object.deleted > 0);
  const gives = input.rewound.some((object) => object.givenBack > 0);
  const restamped =
    brings && gives
      ? sum(
          calls(UNDO_RESTAMPED_FIXED_REQUESTS, SECONDS_PER_SMALL_CALL),
          ...input.rewound.map(undoRestampedReads),
        )
      : NOTHING;
  const cost = sum(
    fixed,
    calls(input.automationRequests, SECONDS_PER_READ),
    restamped,
    removalCost(
      input.rewound.map((object) => ({
        records: object.broughtBack,
        dependents: relationshipsFor(input.relationships, object.objectApiName).dependents,
      })),
    ),
    // Saying back no stamps — an undo taken up again plans only what the one
    // before left — it reads neither the clock nor its user.
    undeleteCost(input.rewound.map((object) => object.deleted)),
    ...input.rewound.map((object) =>
      undoRestoreCost(object, fieldsOf.get(object.objectApiName) ?? []),
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

/** What an org has left today, as an act reads it once before anything else of it. */
export interface CheckpointBudget extends ApiBudget {
  /**
   * What it has left of its daily email limits, read from the same answer —
   * those it lists — or why it could not be read: an act whose writes send
   * emails is held to them (`rewindEmails.ts`).
   */
  emails: Partial<Record<ForgeEmailLimit, EmailLimit>> | { unread: string };
}

/**
 * The requests the org has left today, read once, before anything else of
 * the act: an act that cannot tell does not run, as one that runs the org out
 * of them stops its integrations too. Its daily email limits are read from
 * the same answer, no request more.
 *
 * @throws When the org does not say, naming it.
 */
export async function readBudget(org: LimitsTransport, orgName: string): Promise<CheckpointBudget> {
  let answer: unknown;
  let budget: ApiBudget;
  try {
    answer = await org.request({ method: 'GET', url: '/limits' });
    budget = await readApiBudget({ request: () => Promise.resolve(answer) });
  } catch (err: unknown) {
    throw new Error(
      `${orgName} did not say how many API requests it has left today: ${extractErrorMessage(err)}`,
    );
  }
  let emails: CheckpointBudget['emails'];
  try {
    emails = await readEmailLimits({ request: () => Promise.resolve(answer) });
  } catch (err: unknown) {
    emails = { unread: extractErrorMessage(err) };
  }
  return { ...budget, emails };
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
