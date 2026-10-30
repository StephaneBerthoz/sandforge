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
 * - a Bulk API 2.0 job costs one request per call it sends, its records none:
 *   asked live, a job of 200 deletes — opened, its CSV sent, closed, its state
 *   read twice — took five off the day, as many as it sent. A removal deletes
 *   an object's records past 10,000 (`BULK_DELETE_THRESHOLD`) through such
 *   jobs, which also read their results three ways once through; each job is
 *   priced by those calls (`bulkJobRequests`), its reads of its state as many
 *   as its time leaves room for, one every five seconds
 *   (`BULK_POLL_INTERVAL_MS`). Priced as the REST calls of 200 records it
 *   stands for, a job of 50,000 deletes was counted 250 requests for some 25.
 *
 * An act's requests are what it sends whatever it holds, each named, and what
 * each brick it goes through sends per call and per record, counted as the
 * brick's own code sends it: the change reads (`orgStreams.ts`), the bring back
 * (`undeleteRunDeletions`), the give-back (`restoreOverwrites`) and the
 * removal (`removeRunRecords`). What cannot be known before — a record sent
 * again without a field the org refused, what the org's automation does in
 * answer — is left out, and the estimate is about.
 */

import { BYTES_PER_MB } from '@sandforge/shared';
import type {
  CheckpointEstimate,
  CheckpointLeftOutObject,
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
import { BULK_POLL_INTERVAL_MS } from '../../core/engine/BulkApiExecutor.js';
import { RECORDS_PER_CALL } from '../dataops/RecordRemoval.js';
import {
  BULK_DELETE_JOB_RECORDS,
  BULK_DELETE_THRESHOLD,
  BULK_RESULT_READS,
} from '../forge/ForgeRunRemoval.js';
import {
  apiBudgetCheckOf,
  readApiBudget,
  readEmailLimits,
  runRequestsEstimate,
  type ApiBudget,
  type EmailLimit,
  type LimitsTransport,
} from '../forge/ForgeRunGate.js';
import {
  ONE_ROW_CALLS_IN_FLIGHT,
  QUERIES_PER_COMPOSITE,
  SUBREQUESTS_PER_COMPOSITE,
} from './compositeQueries.js';
import { SNAPSHOT_CHUNK_IDS, snapshotIndexBytes } from './snapshotIndex.js';
import { RUN_RECORDS_PAGE } from './spooledRunRecords.js';

// ─── Figures ─────────────────────────────────────────────────────────────────

/**
 * Bytes a record's row takes in the snapshot on this machine, compressed,
 * about. Plain, a row was measured on six standard objects at 0.36 to 0.73
 * KB with the writable fields that hold a value and 1.1 to 1.8 KB with every
 * field, and the snapshot keeps the writable ones, empty or not: about 1 KB,
 * what the plain snapshot was estimated at. Compressed in members of 64 KiB,
 * synthetic Contact rows of 714 bytes took 70, a tenth; a real org's values
 * repeat less than synthetic ones, and 300 is a fold of 3.3, kept until the
 * rows of a real org, read on its worst object, say better.
 */
export const BYTES_PER_RECORD_KEPT = 300;

/**
 * Bytes `checkpoint.json` takes beside its objects and the ones it leaves
 * out, about: the org, the user, the dates, the names. 949 on a scratch org.
 */
const CHECKPOINT_FILE_REST_BYTES = 1_024;

/** Bytes an object read keeps in `snapshots.json`, its snapshot's DataOps metadata, about. */
const SNAPSHOT_META_BYTES_PER_OBJECT = 160;

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

/**
 * Rows the org gives a page of a snapshot at most, whatever it is asked: a
 * take of 60,000 contacts read 49 columns a row in pages of 1,000 where 2,000
 * were asked, 61 calls where its estimate said 31 (P-D2, a scratch org),
 * while the narrow reads beside it — ids, stamps — came back 2,000 a page.
 * The org keeps the right to answer fewer rows than asked; nothing says how
 * many, nor from how many columns. A snapshot reads every field a person
 * sets, dozens of columns on most objects: its pages are priced at this, and
 * a narrow object, which the org may answer in fuller pages, is priced above
 * what it sends.
 */
export const SNAPSHOT_PAGE_ROWS = 1_000;

/** Requests a take's last phase sends before its reads of what moved: T1 on the org's clock, a SOAP call. */
const STABILITY_CLOCK_REQUESTS = 1;

/** Ids a take's read by id names: of records whose links it reads, of files it reads. */
const FILE_IDS_PER_READ = 200;

/**
 * Bytes a link between a file and a record takes in a checkpoint's files,
 * compressed, about: 147 plain, 27 compressed on synthetic ids, which repeat
 * more than an org's.
 */
const BYTES_PER_FILE_LINK_KEPT = 60;

/** Bytes a file takes in a checkpoint's files — its latest version and size — compressed, about: 23 on synthetic ids. */
const BYTES_PER_FILE_KEPT = 50;

/**
 * Bytes an id of the recycle bin at T0 takes in the checkpoint's `bin/`, in
 * clear, a line each as the take spools it: `{"Id":"…"}`, 18 characters,
 * and its line break. Measured on a scratch org whose bin held 77,624 ids:
 * 2,173,472 bytes, 85 % of the checkpoint, where the estimate counted none.
 */
export const BYTES_PER_BIN_ID_KEPT = Buffer.byteLength(
  `${JSON.stringify({ Id: '0'.repeat(18) })}\n`,
);

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
 * Requests an act sends, beside {@link ACT_FIXED_REQUESTS}, to read its user
 * object by object, as the last read counted them (`RewindDiff.access`): the
 * user's id, their permission rows — those of the sets assigned on their
 * own, the groups they are assigned, each group's aggregate, page by page —
 * and the describes that prove an object held through what it hangs from.
 * None with View All Data and Modify All Data, which read nothing more.
 */
function accessRequestsOf(diff: Partial<Pick<RewindDiff, 'access'>>): number {
  return diff.access?.kind === 'perObject' ? diff.access.requests : 0;
}

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

/**
 * Seconds a Bulk API job waits its turn in the org before it deletes a record,
 * about: on a scratch org, 24 of the 25.6 seconds a job of 2,000 contacts took.
 */
const BULK_JOB_WAIT_SECONDS = 24;

/**
 * Records a Bulk API job deletes a second once under way, about: 12,000 in 33
 * seconds, fifty thousand in about a minute and a half, the slower of the two
 * taken, so a job is read as often as it may be.
 */
const BULK_JOB_RECORDS_PER_SECOND = 750;

/** Calls a Bulk API job sends whatever it holds: opened, its CSV sent, closed. */
const BULK_JOB_FIXED_CALLS = 3;

/** The file version, whose records a removal deletes by their document, never by a job. */
const FILE_VERSION = 'ContentVersion';

/**
 * The file, whose records a removal deletes by REST calls of 200 only,
 * however many: nothing asked the Bulk API what it does to a file's versions
 * and links, and 12,000 files take 60 calls.
 */
const FILE_DOCUMENT = 'ContentDocument';

/** Links one REST call of a rewind removes, inserts or updates: a collection of 200. */
const LINKS_PER_CALL = 200;

/**
 * Bytes a rewind's journal keeps of a link it removes — its two ends and its
 * sharing, which an undo inserts again — about.
 */
const JOURNAL_BYTES_PER_LINK = 150;

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

/**
 * What `count` composites of one-row reads cost — pre-checks, counts — sent
 * {@link ONE_ROW_CALLS_IN_FLIGHT} at a time: a request each, and for each
 * three the time of one. Three in flight at once answered in 0.32 to 0.65 s
 * on two orgs, where the three sent one after the other took 0.84 to 1.31 s
 * (P-D3), and one alone 0.23 to 0.45 s.
 */
function oneRowCalls(count: number): Cost {
  return {
    apiRequests: count,
    seconds: callsFor(count, ONE_ROW_CALLS_IN_FLIGHT) * SECONDS_PER_SMALL_CALL,
  };
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
   * Ids in its recycle bin at T0, counted before the take reads them, of an
   * object holding no record too: what prices the bin's pages past the
   * first, and what `bin/` keeps of them. Absent, one page and no byte.
   */
  inBin?: number;
  /**
   * Its records stamped since the change reads' start — five minutes before
   * T0 — live or in the bin, counted before the take reads any: what the
   * take's last phase reads again of an object that moved before T0, as one
   * a load just before the take filled. Absent, none.
   */
  stampedSince?: number;
  /**
   * Present for an object whose records' links to files the take reads: how
   * many there are, counted before; `null` when the org would not count
   * them, which it then reads by lists of the records' ids.
   */
  links?: number | null;
  /**
   * For each of its column groups after the first, the ids one statement
   * reading it by id names ({@link snapshotGroupReads}): none for an object
   * one statement reads whole.
   */
  otherGroups?: readonly number[];
  /**
   * What `checkpoint.json` will say of it — its fields and those left out,
   * its parents — with the counts and the print the take has before it
   * reads: as long as the ones it writes, but for a digit or two. Absent,
   * its entry is not counted.
   */
  entry?: CheckpointObject;
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
  /**
   * The counts asked once the records are, five a call: of each object, its
   * recycle bin at T0; of each holding records, its records stamped since
   * the change reads' start, and its links to files when they are read.
   */
  recounted?: number;
  /** Per object the take holds, its records and how its other column groups are read. */
  objects: readonly TakenObject[];
  /** Rows a page of the snapshot reads: what the org's kind reads at a time. */
  pageRows: number;
  /** The objects the checkpoint names as left out, and why: listed in `checkpoint.json`. */
  leftOut?: readonly CheckpointLeftOutObject[];
  /**
   * Bytes of `fingerprints.json.gz`, measured on the prints the take will
   * write, made from the describes it already read. Absent, not counted.
   */
  printsBytes?: number;
}

/**
 * Bytes the items of a list take in a file written as
 * `JSON.stringify(…, null, 2)`, the list `depth` levels inside it, beside
 * what the empty list, `[]`, takes: each line of an item indented two spaces
 * a level, the comma and line break between two items, and the line breaks
 * and indent around them.
 */
function listedJsonBytes(items: readonly unknown[], depth: number): number {
  if (items.length === 0) return 0;
  let bytes = 2 * (items.length - 1) + 2 + 2 * (depth - 1);
  for (const item of items) {
    const text = JSON.stringify(item, null, 2);
    let lines = 1;
    for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) lines++;
    bytes += Buffer.byteLength(text, 'utf8') + lines * 2 * depth;
  }
  return bytes;
}

/**
 * The bytes a take keeps on this machine, about, made of what each part
 * costs:
 *
 * - each record's row, compressed ({@link BYTES_PER_RECORD_KEPT}): the one
 *   part it cannot know before it reads the rows;
 * - each row of the index, 43 bytes;
 * - the field prints, compressed, as measured on them;
 * - the links of its records to files, and a file each link names, as
 *   counted before the take reads them;
 * - each id of its recycle bin at T0, kept in clear
 *   ({@link BYTES_PER_BIN_ID_KEPT}), as counted before the take reads them;
 * - `checkpoint.json`, which lists every object kept with its fields and
 *   every object left out with why, counted as it will be written.
 *
 * On an org of a thousand objects, most of them empty, the last two are
 * most of the checkpoint. A plain checkpoint of a scratch org's 202 objects
 * holding 70 records took 887,925 bytes, `checkpoint.json` 338,858 of them,
 * where the estimate before the compression — `records × 1,000` and the
 * index, nothing of the rest — said 74,066: twelve times too few. On the
 * same org, its bin since grown to 77,624 ids, a compressed checkpoint took
 * 2,564,779 bytes, its bin 2,173,472 of them, where the estimate, counting
 * none of the bin, said 402,332.
 */
export function takeBytes(
  input: Pick<TakeEstimateInput, 'objects' | 'leftOut' | 'printsBytes'>,
): number {
  let bytes = CHECKPOINT_FILE_REST_BYTES + (input.printsBytes ?? 0);
  const entries: CheckpointObject[] = [];
  for (const object of input.objects) {
    bytes += object.records * BYTES_PER_RECORD_KEPT + snapshotIndexBytes(object.records, 2);
    if (object.records > 0) bytes += SNAPSHOT_META_BYTES_PER_OBJECT;
    bytes += (object.inBin ?? 0) * BYTES_PER_BIN_ID_KEPT;
    // A link and the file it names, at most, one file a link.
    bytes += (object.links ?? 0) * (BYTES_PER_FILE_LINK_KEPT + BYTES_PER_FILE_KEPT);
    if (object.entry !== undefined) entries.push(object.entry);
  }
  // Each list as checkpoint.json nests it: its objects, and its scope's left out.
  return bytes + listedJsonBytes(entries, 2) + listedJsonBytes(input.leftOut ?? [], 3);
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
 * - `counts`: every object kept once described, five a call, three calls in
 *   flight, and again alone each count a call did not answer — an object
 *   then left out, as the org would not count it or as it holds more than
 *   one object may, was counted all the same — then, five a call, one call
 *   after the other, what the next phases' reads hold of each object: its
 *   recycle bin at T0, and of one holding records, its records stamped since
 *   the change reads' start, and its links to files;
 * - `bin`: the recycle bin at T0, five objects at a time, each page of ids a
 *   call for the longest of the five;
 * - `snapshot`: a page a call, of {@link SNAPSHOT_PAGE_ROWS} rows at most
 *   whatever is asked, each page's other column groups by its ids, the read
 *   of which org the snapshot is of; then the links of each object's records
 *   to files, five objects at a time, a page of a statement each call — read
 *   by lists of 200 records' ids where the org would not count them — and
 *   the files they name, read by lists of 200 ids, five lists a call;
 * - `stability`: T1, each object's newest stamp, five a call, three calls in
 *   flight, and, for each object stamped since the change reads' start, its
 *   records stamped since and those deleted since, read as the bin is, then
 *   its count, three calls in flight.
 *
 * The page size the org answers is read off the snapshot's own reads: its
 * handler asks for a page of the org's kind, 2,000 rows in a sandbox or a
 * scratch org (`Sforce-Query-Options: batchSize`), and the org answers fewer
 * for a wide projection — 1,000 for 49 columns (P-D2) — so a snapshot page
 * is priced at {@link SNAPSHOT_PAGE_ROWS} at most. The narrow reads beside
 * it, of ids and stamps, the bin and the stability phase, came back 2,000 a
 * page, and are priced so.
 *
 * Not known before the take reads them, and left out: what moves while the
 * take runs, and what the five minutes before T0 moved of an object that
 * held no record when it was counted; the files a link names that another
 * link of the same file names too, which the estimate takes for one each;
 * and the rows a write moved between two column groups, read again.
 *
 * Its disk is {@link takeBytes}.
 */
export function takeEstimate(
  input: TakeEstimateInput,
): Omit<CheckpointEstimate, 'apiRequestsLeft'> {
  const kept = input.objects.length;
  const describeCalls = callsFor(input.described, SUBREQUESTS_PER_COMPOSITE);
  const describedAlone = input.describedAlone ?? 0;
  // The counts of the objects kept and the newest stamps go three calls in
  // flight; a count asked alone, and the recounts, one after the other.
  const countedTogether = oneRowCalls(callsFor(input.counted ?? kept, QUERIES_PER_COMPOSITE));
  const countedApart =
    (input.countedAlone ?? 0) + callsFor(input.recounted ?? 0, QUERIES_PER_COMPOSITE);
  const counts = countedTogether.apiRequests + countedApart;
  const fiveAtATime = oneRowCalls(callsFor(kept, QUERIES_PER_COMPOSITE));
  const pageRows = Math.min(input.pageRows, SNAPSHOT_PAGE_ROWS);
  let pages = 0;
  let reads = 0;
  let records = 0;
  for (const object of input.objects) {
    records += object.records;
    const calls = snapshotCallsOf(object, pageRows);
    pages += calls.pages;
    reads += calls.reads;
  }
  const bin = streamedReadsCost(input.objects.map((object) => pagesOf(object.inBin ?? 0)));
  const files = filesCost(input.objects);
  const moved = input.objects.filter((object) => (object.stampedSince ?? 0) > 0);
  const changes = sum(
    streamedReadsCost(moved.flatMap((object) => [pagesOf(object.stampedSince ?? 0), 1])),
    oneRowCalls(callsFor(moved.length, QUERIES_PER_COMPOSITE)),
  );
  const snapshot = pages + reads + (pages > 0 ? SNAPSHOT_ORG_REQUESTS : 0);
  const requestsByPhase: Record<CheckpointTakePhase, number> = {
    guard: TAKE_GUARD_REQUESTS,
    scope: TAKE_SCOPE_REQUESTS + describeCalls + describedAlone,
    start: TAKE_START_REQUESTS,
    counts,
    bin: bin.apiRequests,
    snapshot: snapshot + files.apiRequests,
    stability: STABILITY_CLOCK_REQUESTS + fiveAtATime.apiRequests + changes.apiRequests,
  };
  return {
    records,
    apiRequests: Object.values(requestsByPhase).reduce((total, phase) => total + phase, 0),
    requestsByPhase,
    seconds: Math.ceil(
      describeCalls * SECONDS_PER_DESCRIBE_CALL +
        (describedAlone + countedApart) * SECONDS_PER_SMALL_CALL +
        countedTogether.seconds +
        fiveAtATime.seconds +
        bin.seconds +
        changes.seconds +
        files.seconds +
        pages * SECONDS_PER_PAGE +
        reads * SECONDS_PER_READ,
    ),
    bytes: takeBytes(input),
  };
}

/**
 * What a take's reads of its files cost (`takeFiles`): the links of each
 * object's records, five objects at a time — the statement the org would not
 * count tried all the same, then the object's records' ids read 200 a
 * statement, five a call — and the files the links name, 200 a statement,
 * five a call, one file a link at most.
 */
function filesCost(objects: readonly TakenObject[]): Cost {
  const linked = objects.filter((object) => object.links !== undefined);
  if (linked.length === 0) return NOTHING;
  let byIds = 0;
  let named = 0;
  for (const object of linked) {
    if (object.links === null)
      byIds += callsFor(callsFor(object.records, FILE_IDS_PER_READ), QUERIES_PER_COMPOSITE);
    else named += object.links ?? 0;
  }
  return sum(
    streamedReadsCost(linked.map((object) => pagesOf(object.links ?? 0))),
    calls(byIds, SECONDS_PER_READ),
    calls(callsFor(callsFor(named, FILE_IDS_PER_READ), QUERIES_PER_COMPOSITE), SECONDS_PER_READ),
  );
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
 * pre-check of every object, five a call, three calls in flight; then, for
 * each object that moved, the read of what moved (L) and the read of what was
 * deleted (D), streamed five at a time; then the count of each object that
 * moved or that the checkpoint holds records of, five a call, three in
 * flight.
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
    oneRowCalls(callsFor(input.objects, QUERIES_PER_COMPOSITE)),
    streamedReadsCost(
      input.moved.flatMap(({ live, deleted }) => [pagesOf(live), pagesOf(deleted)]),
    ),
    oneRowCalls(callsFor(counted.size, QUERIES_PER_COMPOSITE)),
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
 * The calls one Bulk API 2.0 job sends the org, each one of its daily
 * requests: opened, its CSV sent, closed, each read of its state, and its
 * results read three ways once it is through, unless told how many.
 */
export function bulkJobRequests(job: { stateReads: number; resultReads?: number }): number {
  return BULK_JOB_FIXED_CALLS + job.stateReads + (job.resultReads ?? BULK_RESULT_READS);
}

/** Seconds a Bulk API job of `records` deletes takes, about: its wait, then the deletes. */
function bulkJobSeconds(records: number): number {
  return BULK_JOB_WAIT_SECONDS + records / BULK_JOB_RECORDS_PER_SECOND;
}

/**
 * Reads of its state a Bulk API job of `records` deletes takes: one as it is
 * closed, then one each time the executor waits for it, as long as its time.
 */
export function bulkJobStateReads(records: number): number {
  return 1 + Math.ceil((bulkJobSeconds(records) * 1000) / BULK_POLL_INTERVAL_MS);
}

/**
 * What deleting `records` records of one object costs, as the removal sends
 * them (`deleteRounds`): past {@link BULK_DELETE_THRESHOLD}, jobs of one size
 * of up to {@link BULK_DELETE_JOB_RECORDS} records, each priced by the calls
 * it sends; else, and for a file and its versions whatever their number,
 * REST calls of 200.
 */
function deletesCost(records: number, objectApiName: string | undefined): Cost {
  if (
    records < BULK_DELETE_THRESHOLD ||
    objectApiName === FILE_VERSION ||
    objectApiName === FILE_DOCUMENT
  ) {
    return calls(runRequestsEstimate([{ rows: records }]), SECONDS_PER_WRITE);
  }
  const jobs = Math.ceil(records / BULK_DELETE_JOB_RECORDS);
  const size = Math.ceil(records / jobs);
  let cost = NOTHING;
  for (let left = records; left > 0; left -= size) {
    const job = Math.min(left, size);
    cost = sum(cost, {
      apiRequests: bulkJobRequests({ stateReads: bulkJobStateReads(job) }),
      seconds: bulkJobSeconds(job),
    });
  }
  return cost;
}

/**
 * What one call of `removeRunRecords` costs, per object the records it
 * deletes: the global describe, its clock and its user; per object, its
 * describe, its records read by id, the reads of what depends on them — each
 * relationship asked once whether anything points through it when the object
 * has more than one batch, then read per batch — and the deletes, as REST
 * calls of 200 or, past 10,000 records of an object, as the Bulk API jobs the
 * removal sends them in (`deletesCost`).
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
  objects: ReadonlyArray<{ records: number; dependents: number; objectApiName?: string }>,
  pageRecords = Number.POSITIVE_INFINITY,
): Cost {
  const removed = objects.filter((object) => object.records > 0);
  if (removed.length === 0) return NOTHING;
  return sum(
    calls(REMOVAL_FIXED_REQUESTS, SECONDS_PER_SMALL_CALL),
    ...removed.map(({ records, dependents, objectApiName }) => {
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
        deletesCost(records, objectApiName),
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
    Partial<
      Pick<
        RewindDiff,
        | 'undoCannot'
        | 'withParentDeleted'
        | 'parentsOutsideRequests'
        | 'fieldsRequests'
        | 'described'
        | 'files'
        | 'filesRequests'
        | 'access'
      >
    >;
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

/**
 * Records a rewind sends to the undelete: those that come back with a parent
 * are not sent; carriers are, to be deleted again by the second pass.
 */
function sentBack(object: RewindDiffObject): number {
  return object.toBringBack.inBin + object.toBringBack.deletedWhileTaken + carriers(object);
}

/** Records a rewind brings back for a moment, with what they took along, and deletes again. */
function carriers(object: RewindDiffObject): number {
  return object.toBringBack.carriers ?? 0;
}

/** Records the second pass deletes: what came back with a parent, and the carriers. */
function deletedNext(object: RewindDiffObject): number {
  return object.toDelete.comesBackWithParent + carriers(object);
}

/**
 * Records deleted since with a parent the rewind does not bring back: read in
 * the bin as those it brings back are, and their object described to tell
 * them.
 */
function stranded(object: RewindDiffObject): number {
  return object.cannotUndo
    .filter(
      (cannot) =>
        cannot.reason === 'deletedWithCreatedParent' ||
        cannot.reason === 'deletedWithParentOutside',
    )
    .reduce((total, cannot) => total + cannot.count, 0);
}

/** Records a rewind brings back, those that come with a parent included: not the carriers. */
function broughtBack(object: RewindDiffObject): number {
  return sentBack(object) - carriers(object) + object.toBringBack.withParent;
}

/**
 * Records a rewind gives their checkpoint values back: those changed since,
 * and those it brings back that the snapshot holds, which come back with the
 * values they had when deleted.
 */
function givenBack(object: RewindDiffObject): number {
  return object.toGiveBack.records + object.toBringBack.inBin + object.toBringBack.withParent;
}

/** Records deleted since that the recycle bin no longer holds, and that a rewind cannot make again. */
function goneForGood(object: RewindDiffObject): number {
  return object.cannotUndo
    .filter((cannot) => cannot.reason === 'goneForGood')
    .reduce((total, cannot) => total + cannot.count, 0);
}

/** Records a rewind makes again with new Ids: those the recycle bin no longer gives back. */
function toRecreate(object: RewindDiffObject): number {
  return object.toRecreate ?? 0;
}

/**
 * Records deleted since that the recycle bin no longer gives back, which a
 * read finds by scanning their object's ids: those made again, and those
 * that cannot be.
 */
function lost(object: RewindDiffObject): number {
  return goneForGood(object) + toRecreate(object);
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
  const gone = lost(object);
  return {
    objectApiName: object.objectApiName,
    live: object.toGiveBack.records + object.touched + deletedFirst(object) + object.unexplained,
    deleted: broughtBack(object) + deletedNext(object) + stranded(object),
    valued: object.toGiveBack.records + object.touched + object.toBringBack.withParent,
    backTo:
      broughtBack(object) + carriers(object) + stranded(object) > 0 ||
      (held.undeletable === false && gone > 0),
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
 * explain. A record made again is live under its new Id, which the checkpoint
 * holds it by: stamped since, its values read; only what could not be made
 * again is still scanned for.
 */
function readAfterPass(
  object: RewindDiffObject,
  held: EstimatedObject,
  relationships: ReadonlyMap<string, ObjectRelationships> | undefined,
  secondPassThrough: boolean,
): ObjectRead {
  const first = readOf(object, held, relationships);
  const back = object.toBringBack;
  const waiting = secondPassThrough ? 0 : deletedNext(object);
  return {
    ...first,
    live:
      object.toGiveBack.records +
      object.touched +
      object.unexplained +
      broughtBack(object) +
      toRecreate(object) +
      waiting,
    deleted: deletedFirst(object) + deletedNext(object) - waiting + stranded(object),
    valued:
      object.toGiveBack.records +
      object.touched +
      back.inBin +
      back.withParent +
      toRecreate(object),
    backTo: stranded(object) > 0 || (held.undeletable === false && goneForGood(object) > 0),
    scans: goneForGood(object) > 0 && held.undeletable !== false,
    deletes: waiting,
  };
}

/**
 * What one read of the org since the checkpoint costs, each part as
 * `rewindDiff` sends it, given how it finds each object (`reads`), the
 * objects it reads again for being unread last time, and the users it names:
 *
 * - its clock;
 * - the change reads, of the objects that moved and of those the last read
 *   could not read, in the checkpoint's order, the drift describes of the
 *   objects something moved in between their pre-checks and the rest, 25 a
 *   call with a file's link, and, after the counts, of those nothing moved in
 *   that hold fewer records than the checkpoint, 25 a call: as many as the
 *   last read described (`RewindDiff.described`), or, of a diff that does not
 *   say, every object at once;
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
 *   reads a call; none when it found nothing to delete or give back;
 * - for a checkpoint that holds files, the describe of a file's link beside
 *   the drift describes, the org's objects described once — what tells the
 *   object of the record a link names — and what its reads of the links and
 *   the files sent, as the last read counted them (`filesRequests`): those
 *   reads follow the links and files found, which an estimate cannot know
 *   before;
 * - of the custom fields gone from a drift describe, the reads of the
 *   Tooling API's `FieldDefinition` that told those deleted from those
 *   hidden, as the last read counted them (`fieldsRequests`).
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
  described: RewindDiff['described'],
  parentsOutside = 0,
  files?: FilesRead,
  fieldsTold = 0,
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
  if (files !== undefined) describesGlobal = true;
  const link = files !== undefined ? 1 : 0;
  const describes =
    described === undefined
      ? callsFor(objects.length + link, SUBREQUESTS_PER_COMPOSITE)
      : callsFor(described.first + link, SUBREQUESTS_PER_COMPOSITE) +
        callsFor(described.later, SUBREQUESTS_PER_COMPOSITE);
  return sum(
    calls(DIFF_FIXED_REQUESTS, SECONDS_PER_SMALL_CALL),
    calls(describes, SECONDS_PER_DESCRIBE_CALL),
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
    calls(parentsOutside, SECONDS_PER_SMALL_CALL),
    calls(fieldsTold, SECONDS_PER_SMALL_CALL),
    calls(files?.requests ?? 0, SECONDS_PER_READ),
    ...scans,
    calls(callsFor(callsFor(users, USERS_PER_READ), QUERIES_PER_COMPOSITE), SECONDS_PER_SMALL_CALL),
  );
}

/** What the reads of a checkpoint's files sent, as the last read counted them. */
interface FilesRead {
  requests: number;
}

/** The files' part of a read, for a diff of a checkpoint that holds files; none for one that holds none. */
function filesReadOf(diff: DiffEstimateInput['diff']): FilesRead | undefined {
  return diff.files !== undefined ? { requests: diff.filesRequests ?? 0 } : undefined;
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
    input.diff.described,
    input.diff.parentsOutsideRequests ?? 0,
    filesReadOf(input.diff),
    input.diff.fieldsRequests ?? 0,
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
    !secondPassThrough && input.diff.objects.some((object) => deletedNext(object) > 0);
  // What a pass made again in an object nothing moved in moved it: its
  // describe goes with the others', before the change reads.
  const described = input.diff.described;
  return readCost(
    input.objects,
    readsOf(input, (object, held) =>
      readAfterPass(object, held, input.relationships, secondPassThrough),
    ),
    new Set(input.diff.unread.map((object) => object.objectApiName)),
    waiting ? 1 : 0,
    described === undefined ? undefined : { first: described.first + described.later, later: 0 },
    input.diff.parentsOutsideRequests ?? 0,
    filesReadOf(input.diff),
    input.diff.fieldsRequests ?? 0,
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

/**
 * What making records again costs, per object the records it makes: its
 * describe, which tells the fields a new record takes, and an insert of 200
 * records a call. A lookup to a record made after the one that names it — a
 * record pointing at one of its own object — is filled in by an update of its
 * own, not counted.
 */
export function recreateCost(perObject: readonly number[]): Cost {
  return sum(
    ...perObject
      .filter((records) => records > 0)
      .map((records) =>
        sum(calls(1, SECONDS_PER_SMALL_CALL), calls(batches(records), SECONDS_PER_WRITE)),
      ),
  );
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
 *   objects described for it unless the read before did; what it makes again
 *   (`recreateCost`); the give-back, before and after the deletes
 *   (`givenBackCost`); the removal of what was created or brought back since
 *   (`removalCost`);
 * - the read after it, which plans pass 2 and is the verify when pass 2 has
 *   nothing to do;
 * - pass 2 and the verify after it, when records come back with a parent:
 *   pass 2 deletes them, and gives back what they held in place;
 * - the links between files and records it removes, inserts again and gives
 *   their sharing back, 200 a call each (`linkWritesCost`).
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
  const comingBack = objects.filter((object) => deletedNext(object) > 0);
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
    recreateCost(objects.map(toRecreate)),
    removalCost(
      objects.map((object) => ({
        objectApiName: object.objectApiName,
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
              objectApiName: object.objectApiName,
              records: deletedNext(object),
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
    linkWritesCost(input.diff.files),
    readAfterPassCost(input, false),
    passTwo,
  );
}

/** Links a rewind writes: those it removes, inserts again and gives their sharing back. */
function linksWritten(files: RewindDiff['files']): number {
  return files === undefined ? 0 : files.unlink + files.relink + files.updateLinks;
}

/**
 * What a rewind's writes of links cost: each of the three kinds in REST
 * collections of 200 — a link removed, one inserted again under a new Id
 * (Salesforce brings none back from the recycle bin), one given its sharing
 * back — never mixed in one call. Not counted: what the rewind reads again
 * of the links to tell what the org did not bring back with a file or a
 * record, which follows what it finds.
 */
export function linkWritesCost(files: RewindDiff['files']): Cost {
  if (files === undefined) return NOTHING;
  return calls(
    callsFor(files.unlink, LINKS_PER_CALL) +
      callsFor(files.relink, LINKS_PER_CALL) +
      callsFor(files.updateLinks, LINKS_PER_CALL),
    SECONDS_PER_WRITE,
  );
}

/**
 * The API requests, time and disk a rewind costs, about, from what the
 * preview found, in the order a rewind goes: the guard and the day's limits;
 * the fresh diff, unless it acts on the one the command line just read; and,
 * once it has something to write, the automation read and its writes
 * (`rewindWritesCost`). The records counted are the three numbers of the
 * preview and the records it makes again; the bytes, what the journal keeps
 * of them and of the links it writes. A rewind that writes links alone —
 * a file linked since to a record that stays — writes all the same.
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
  const recreated = objects.reduce((total, object) => total + toRecreate(object), 0);
  const records = toDelete + toGiveBack + toBringBack + recreated;
  const reads = sum(
    calls(ACT_FIXED_REQUESTS + accessRequestsOf(input.diff), SECONDS_PER_SMALL_CALL),
    input.reusesPreview === true ? NOTHING : diffEstimate(input),
  );
  const files = input.diff.files;
  if (records === 0 && linksWritten(files) === 0) {
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
    // A record made again is journaled twice: before its insert, by the Id
    // it had, and after, by its new one.
    bytes:
      journalBytes(
        objects.reduce((total, object) => total + givenBack(object), 0),
        toDelete + toBringBack + 2 * recreated,
      ) + linkJournalBytes(files),
  };
}

/**
 * Bytes, about, a rewind's journal keeps of the links it writes: a link it
 * removes whole, which an undo inserts again; the Id of one it inserts,
 * which an undo removes; the sharing a link had, which an undo gives back.
 */
function linkJournalBytes(files: RewindDiff['files']): number {
  if (files === undefined) return 0;
  return (
    files.unlink * JOURNAL_BYTES_PER_LINK +
    files.relink * JOURNAL_BYTES_PER_ID +
    files.updateLinks * JOURNAL_BYTES_PER_LINK
  );
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
        objectApiName: object.objectApiName,
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
  /**
   * What it has left of its file storage, in MB, read from the same answer;
   * absent when it does not say. A file in the recycle bin takes none, and
   * its undelete counts it again (P-A8): what a rewind brings back of files
   * is held to it (`fileStorageRefusal`).
   */
  fileStorage?: { max: number; remaining: number };
}

/** What `/limits` says of an org's file storage, when it says it. */
const fileStorageSchema = z
  .object({ FileStorageMB: z.object({ Max: z.number(), Remaining: z.number() }).loose() })
  .loose();

/**
 * The requests the org has left today, read once, before anything else of
 * the act: an act that cannot tell does not run, as one that runs the org out
 * of them stops its integrations too. Its daily email limits and its file
 * storage are read from the same answer, no request more.
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
  const files = fileStorageSchema.safeParse(answer);
  return {
    ...budget,
    emails,
    ...(files.success
      ? {
          fileStorage: {
            max: files.data.FileStorageMB.Max,
            remaining: files.data.FileStorageMB.Remaining,
          },
        }
      : {}),
  };
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
 * What each act that brings files back from the recycle bin says it does, and
 * what to do. The refusal comes once the act has read the org — the preview
 * its records, the rewind its fresh diff, the undo the files it would bring
 * back — and before its first write: nothing was written, which is all it
 * can say.
 */
const FILE_STORAGE_WORDS: Readonly<Record<'rewind' | 'undo', { then: string; done: string }>> = {
  rewind: {
    then: 'Free file storage, then rewind again.',
    done: 'Nothing was written.',
  },
  undo: {
    then: 'Free file storage, then undo the rewind again while the recycle bin still holds them.',
    done: 'Nothing was written.',
  },
};

/** Bytes as a person reads a size of file storage: whole megabytes, rounded up past the first. */
function storageMegabytes(bytes: number): string {
  const megabytes = bytes / BYTES_PER_MB;
  return megabytes < 1
    ? `${Math.max(1, Math.round(megabytes * 10)) / 10} MB`
    : `${Math.ceil(megabytes)} MB`;
}

/**
 * The refusal of an act that would bring back from the recycle bin files
 * taking more file storage than the org has left, in the words a person
 * reads; nothing when they fit, or when the org did not say what it has
 * left. A file in the bin takes no storage and its undelete counts it again
 * (P-A8): bringing back exactly what is left fits.
 *
 * @param need - The files it brings back, and the bytes they take once back.
 * @param remainingMb - What the org has left of its file storage, in MB (`/limits`).
 */
export function fileStorageRefusal(
  act: 'rewind' | 'undo',
  need: { files: number; bytes: number },
  remainingMb: number | undefined,
  orgName: string,
): CheckpointRefusal | undefined {
  if (remainingMb === undefined || need.files === 0) return undefined;
  if (need.bytes <= remainingMb * BYTES_PER_MB) return undefined;
  const words = FILE_STORAGE_WORDS[act];
  const files = need.files === 1 ? '1 file' : `${need.files} files`;
  return {
    code: 'FILE_STORAGE',
    message:
      `Bringing back ${files} takes ${storageMegabytes(need.bytes)} of file storage; ` +
      `${orgName} has ${remainingMb} MB left. ${words.then} ${words.done}`,
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
