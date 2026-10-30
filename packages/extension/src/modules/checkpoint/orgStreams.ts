/**
 * The reads that tell what changed in an org since a checkpoint, each one
 * followed to its end, page by page, to a file on disk.
 *
 * Nothing here holds an object's rows whole, and nothing caps them. The reads
 * the product had before stopped at 50,000 rows, or at a cursor's first page,
 * and said so in a flag a caller could leave unread: a rewind planned from
 * such a read would take an object whose changes it never read for one that
 * did not change. Here a read ends one of two ways: the org said it was done
 * and every page it gave is on disk, or the read failed, with why. A cursor
 * that stops before the org says it is done — empty pages without end, a
 * page that names no next one, a cursor the org released or let expire — is
 * a failed read of its object, which a preview names "could not be read" and
 * never reads as unchanged.
 *
 * The reads of five objects go together in one composite call, and the
 * cursors they open are followed to their end, a page each a call, before the
 * next five are opened: pages are written as they arrive, and a cursor left
 * idle while others are read can expire. The reads the org answers in one row
 * — the pre-checks, the counts — open no cursor to wait on, and go three
 * calls at a time.
 *
 * What a read selects, and from when, follows what the org does with dates:
 *
 * - it dates what it writes to the second, truncated, and drops the
 *   milliseconds of a datetime literal (`< …:04.500Z` selects what
 *   `< …:04Z` selects; asked live on three objects' recycle bins). Every
 *   literal here is written to the second, so the statement says what the org
 *   reads;
 * - `SystemModstamp >= T` and `< T` over the recycle bin partition it
 *   exactly, by count and by id (asked live on 5,446 records): the bin at the
 *   checkpoint is what is stamped before its second;
 * - a delete stamps the record and its cascade children with the second of
 *   the delete, an undelete with its own, and a record's stamp does not move
 *   while it sits in the bin. A record changed, created, deleted or brought
 *   back since the checkpoint is stamped since;
 * - a record saved in a transaction that committed after a read began can
 *   carry a stamp before that read (Sync's delta reads, `DELTA_OVERLAP_MS`):
 *   the change reads start five minutes before the checkpoint.
 *
 * The one-row pre-check reads the newest stamp of an object, live or in the
 * bin (`queryAll … ORDER BY SystemModstamp DESC LIMIT 1`); asked live, it
 * equalled the newer of the two on ten objects of ten. An object whose newest
 * stamp is before the change reads' start has had nothing created, changed,
 * deleted or brought back since, and its change reads are not sent.
 */

import { createReadStream } from 'node:fs';
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { sanitizeSoqlObjectName, type CheckpointReadMode } from '@sandforge/shared';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import { cursorPages, type PagedQuerySource } from '../forge/queryAllPages.js';
import { DELTA_OVERLAP_MS, orgDateTime, type DeltaQuerySource } from '../sync/SyncDelta.js';
import {
  ONE_ROW_CALLS_IN_FLIGHT,
  OrgReadStopped,
  QUERIES_PER_COMPOSITE,
  type CompositeReader,
  type CountedPage,
  type OrgRow,
} from './compositeQueries.js';

/** A read of one object: its statement, and whether it reads the recycle bin too. */
export interface ObjectRead {
  objectApiName: string;
  soql: string;
  scanAll: boolean;
}

/** How a read ended: every row the org gave, or why it gave fewer. */
export type ReadOutcome =
  | {
      objectApiName: string;
      read: true;
      /** Rows taken, page by page. */
      rows: number;
      /** What the org said the statement selects in all, `COUNT()` answering with this alone. */
      totalSize?: number;
    }
  | {
      objectApiName: string;
      read: false;
      /** Rows taken before it failed: not all of them. */
      rows: number;
      reason: string;
    };

/** Why a read whose cursor stopped before the org said it was done failed. */
export const ENDED_BEFORE_DONE =
  'The org stopped answering before it said the read was done: some of its records were not read.';

/** What the files a read is spooled to are made with: the records' values are their owner's alone. */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

// ─── Statements ──────────────────────────────────────────────────────────────

/**
 * `at` as a SOQL datetime literal, rounded down to the second: the org drops a
 * literal's milliseconds, so the statement says what it reads.
 *
 * @throws When `at` is no date.
 */
export function soqlInstant(at: string | number): string {
  const ms = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(ms)) throw new Error(`Not a date: ${String(at)}`);
  const second = ms - (((ms % 1000) + 1000) % 1000);
  return new Date(second).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Where the change reads of a checkpoint read from `readFrom` (T0) start: five
 * minutes before it, to the second.
 */
export function changeReadsFrom(readFrom: string): string {
  const at = Date.parse(readFrom);
  if (!Number.isFinite(at)) throw new Error(`Not a date: ${readFrom}`);
  return soqlInstant(at - DELTA_OVERLAP_MS);
}

/** `fields` after `base`, each once, every one a field name. */
function columns(base: readonly string[], fields: readonly string[]): string {
  return [...new Set([...base, ...fields.map(assertSoqlIdentifier)])].join(', ');
}

/** The live records of an object, as `readMode` reads them: Tasks and Events with the archived ones. */
function liveRead(
  objectApiName: string,
  readMode: CheckpointReadMode,
  select: string,
  where?: string,
): ObjectRead {
  const object = sanitizeSoqlObjectName(objectApiName);
  const terms = [where, readMode === 'scanAllLive' ? 'IsDeleted = false' : undefined].filter(
    (term): term is string => term !== undefined,
  );
  return {
    objectApiName: object,
    soql: `SELECT ${select} FROM ${object}${terms.length > 0 ? ` WHERE ${terms.join(' AND ')}` : ''}`,
    scanAll: readMode === 'scanAllLive',
  };
}

/**
 * The pre-check: the newest stamp of the object's records, live or in the
 * recycle bin, archived activities among them. One row however large the
 * object is: `SystemModstamp` is indexed.
 */
export function preCheckRead(objectApiName: string): ObjectRead {
  const object = sanitizeSoqlObjectName(objectApiName);
  return {
    objectApiName: object,
    soql: `SELECT SystemModstamp FROM ${object} ORDER BY SystemModstamp DESC LIMIT 1`,
    scanAll: true,
  };
}

/** What a read of the records that moved since selects, beside the fields it is asked for. */
const MOVED_COLUMNS = [
  'Id',
  'SystemModstamp',
  'CreatedDate',
  'LastModifiedDate',
  'LastModifiedById',
];

/** What a read of the records deleted since selects, beside the fields it is asked for. */
const DELETED_COLUMNS = ['Id', 'SystemModstamp', 'CreatedDate'];

/**
 * L: the live records stamped since the change reads' start — changed,
 * created or brought back since the checkpoint read from `readFrom`.
 *
 * @param fields - Read beside the stamps: the cascade parent fields.
 */
export function movedRead(
  objectApiName: string,
  readMode: CheckpointReadMode,
  readFrom: string,
  fields: readonly string[] = [],
): ObjectRead {
  return liveRead(
    objectApiName,
    readMode,
    columns(MOVED_COLUMNS, fields),
    `SystemModstamp >= ${changeReadsFrom(readFrom)}`,
  );
}

/**
 * D: the records in the recycle bin stamped since the change reads' start —
 * deleted since the checkpoint read from `readFrom`.
 *
 * @param fields - Read beside the stamps: the cascade parent fields.
 */
export function deletedRead(
  objectApiName: string,
  readFrom: string,
  fields: readonly string[] = [],
): ObjectRead {
  const object = sanitizeSoqlObjectName(objectApiName);
  return {
    objectApiName: object,
    soql:
      `SELECT ${columns(DELETED_COLUMNS, fields)} FROM ${object} ` +
      `WHERE IsDeleted = true AND SystemModstamp >= ${changeReadsFrom(readFrom)}`,
    scanAll: true,
  };
}

/** n: how many live records the object holds, as `readMode` reads them. */
export function countRead(objectApiName: string, readMode: CheckpointReadMode): ObjectRead {
  return liveRead(objectApiName, readMode, 'COUNT()');
}

/**
 * B0: the ids in the recycle bin when the checkpoint began reading at
 * `readFrom` — stamped before its second. One deleted in that second before
 * it is left out and reads, later, as deleted while the checkpoint was taken:
 * brought back, never lost.
 */
export function binLedgerRead(objectApiName: string, readFrom: string): ObjectRead {
  const object = sanitizeSoqlObjectName(objectApiName);
  return {
    objectApiName: object,
    soql: `SELECT Id FROM ${object} WHERE IsDeleted = true AND SystemModstamp < ${soqlInstant(readFrom)}`,
    scanAll: true,
  };
}

/** Every live id of the object, as `readMode` reads them: the scan for records gone for good. */
export function idScanRead(objectApiName: string, readMode: CheckpointReadMode): ObjectRead {
  return liveRead(objectApiName, readMode, 'Id');
}

// ─── Streams ─────────────────────────────────────────────────────────────────

/**
 * Every page of `read` from `source`, each handed to `take` before the next
 * is asked: `cursorPages` over the source, the recycle bin read when the read
 * asks. The read is whole only when its last page said it was done.
 *
 * @param take - Called with each page's rows, the first page's even when
 *   empty. A page it fails to take fails the read.
 * @throws {OrgReadStopped} When the run was stopped: no outcome to give.
 */
export async function streamRead(
  source: DeltaQuerySource,
  read: ObjectRead,
  take: (rows: OrgRow[]) => Promise<void> | void,
): Promise<ReadOutcome> {
  let last: CountedPage | undefined;
  let totalSize: number | undefined;
  const pages: PagedQuerySource<OrgRow> = {
    query: async (soql) => {
      const page: CountedPage = await source.query(soql, { scanAll: read.scanAll });
      last = page;
      totalSize = page.totalSize;
      return page;
    },
    queryMore: async (nextRecordsUrl) => {
      last = await source.queryMore(nextRecordsUrl);
      return last;
    },
  };
  let rows = 0;
  try {
    for await (const records of cursorPages(pages, read.soql)) {
      await take(records);
      rows += records.length;
    }
  } catch (err: unknown) {
    if (err instanceof OrgReadStopped) throw err;
    return {
      objectApiName: read.objectApiName,
      read: false,
      rows,
      reason: extractErrorMessage(err),
    };
  }
  if (last?.done !== true) {
    return { objectApiName: read.objectApiName, read: false, rows, reason: ENDED_BEFORE_DONE };
  }
  return {
    objectApiName: read.objectApiName,
    read: true,
    rows,
    ...(totalSize !== undefined ? { totalSize } : {}),
  };
}

/**
 * `reads`, {@link QUERIES_PER_COMPOSITE} at a time over `reader`: the first
 * pages of five go in one call, and their cursors are followed to their end,
 * a page each a call, before the next five are opened.
 *
 * Reads the org answers in their first page — a pre-check, a `COUNT()` — are
 * read so with `oneRow`: five a call still, but
 * {@link ONE_ROW_CALLS_IN_FLIGHT} groups of five at a time, a group opened as
 * soon as one before it ends. No cursor is left open by such a read, so none
 * waits idle while another group is read.
 *
 * @param take - Called with each page's rows and the place of its read.
 * @returns Each read's outcome, in the order of `reads`.
 * @throws {OrgReadStopped} When the run was stopped.
 */
export async function readStreams(
  reader: CompositeReader,
  reads: readonly ObjectRead[],
  take: (index: number, rows: OrgRow[]) => Promise<void> | void,
  signal?: AbortSignal,
  options: { oneRow?: boolean } = {},
): Promise<ReadOutcome[]> {
  const oneRow = options.oneRow === true;
  const outcomes: ReadOutcome[] = new Array<ReadOutcome>(reads.length);
  const readGroup = async (start: number): Promise<void> => {
    const group = reads.slice(start, start + QUERIES_PER_COMPOSITE);
    // Every lane of the group is open before any read asks, so that their
    // first pages go together.
    const lanes = group.map(() => reader.lane({ oneRow }));
    const settled = await Promise.allSettled(
      group.map(async (read, offset) => {
        const lane = lanes[offset];
        try {
          return await streamRead(lane, read, (rows) => take(start + offset, rows));
        } finally {
          lane.close();
        }
      }),
    );
    for (const [offset, result] of settled.entries()) {
      if (result.status === 'rejected') {
        throw result.reason instanceof Error ? result.reason : new Error(String(result.reason));
      }
      outcomes[start + offset] = result.value;
    }
  };
  let next = 0;
  // Each takes the next group once its own ended: one at a time, or, for
  // one-row reads, as many as may be in flight.
  const reading = async (): Promise<void> => {
    while (next < reads.length) {
      if (signal?.aborted) throw new OrgReadStopped();
      const start = next;
      next += QUERIES_PER_COMPOSITE;
      await readGroup(start);
    }
  };
  const groups = Math.ceil(reads.length / QUERIES_PER_COMPOSITE);
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(oneRow ? ONE_ROW_CALLS_IN_FLIGHT : 1, groups) }, reading),
  );
  for (const result of settled) {
    if (result.status === 'rejected') {
      throw result.reason instanceof Error ? result.reason : new Error(String(result.reason));
    }
  }
  if (signal?.aborted) throw new OrgReadStopped();
  return outcomes;
}

/** A read whose rows go to a file, one NDJSON line each. */
export interface SpooledRead extends ObjectRead {
  file: string;
}

/** A row as it goes into a spool file: its fields, without the org's `attributes`. */
function spoolLine(row: OrgRow): string {
  return `${JSON.stringify(Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'attributes')))}\n`;
}

/**
 * `reads`, each one's rows written to its file as each page arrives, through
 * {@link readStreams}. A file holds a whole read or nothing: the file of a
 * read that failed is removed, so nothing reads part of an object for all of
 * it.
 *
 * @returns Each read's outcome, in the order of `reads`.
 * @throws {OrgReadStopped} When the run was stopped: the files are left to the
 *   folder that holds them.
 */
export async function spoolReads(
  reader: CompositeReader,
  reads: readonly SpooledRead[],
  signal?: AbortSignal,
): Promise<ReadOutcome[]> {
  for (const read of reads) {
    await mkdir(path.dirname(read.file), { recursive: true, mode: DIR_MODE });
    await writeFile(read.file, '', { encoding: 'utf8', mode: FILE_MODE });
  }
  const outcomes = await readStreams(
    reader,
    reads,
    async (index, rows) => {
      if (rows.length === 0) return;
      await appendFile(reads[index].file, rows.map(spoolLine).join(''), {
        encoding: 'utf8',
        mode: FILE_MODE,
      });
    },
    signal,
  );
  await Promise.all(
    outcomes.map((outcome, index) =>
      outcome.read ? undefined : rm(reads[index].file, { force: true }),
    ),
  );
  return outcomes;
}

/**
 * The rows of a spool file, one at a time, without holding the file whole.
 *
 * @throws When a line holds no record: the file is not one a read wrote.
 */
export async function* spooledRows(file: string): AsyncGenerator<OrgRow> {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line === '') continue;
      const row: unknown = JSON.parse(line);
      if (typeof row !== 'object' || row === null || Array.isArray(row)) {
        throw new Error(`${path.basename(file)} holds a line that is no record.`);
      }
      yield row as OrgRow;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

// ─── The detection reads ─────────────────────────────────────────────────────

/** An object's pre-check: the newest stamp of its records, and whether it moved since. */
export type PreCheck =
  | {
      objectApiName: string;
      /** Live or in the bin; null when the object holds no record at all. */
      latest: string | null;
      /** Its newest stamp is at or after the change reads' start. */
      moved: boolean;
    }
  | { objectApiName: string; unread: string };

/**
 * The pre-check of each of `objects`, five a call, three calls in flight,
 * against the change reads' start for a checkpoint read from `readFrom`.
 *
 * @returns One answer per object, in the order of `objects`.
 * @throws {OrgReadStopped} When the run was stopped.
 */
export async function preCheck(
  reader: CompositeReader,
  objects: readonly string[],
  readFrom: string,
  signal?: AbortSignal,
): Promise<PreCheck[]> {
  const since = Date.parse(changeReadsFrom(readFrom));
  const newest: Array<unknown> = [];
  const outcomes = await readStreams(
    reader,
    objects.map(preCheckRead),
    (index, rows) => {
      if (rows.length > 0) newest[index] = rows[0].SystemModstamp;
    },
    signal,
    { oneRow: true },
  );
  return outcomes.map((outcome, index): PreCheck => {
    if (!outcome.read) return { objectApiName: outcome.objectApiName, unread: outcome.reason };
    if (newest[index] === undefined) {
      return { objectApiName: outcome.objectApiName, latest: null, moved: false };
    }
    const latest = orgDateTime(newest[index]);
    if (latest === null) {
      return {
        objectApiName: outcome.objectApiName,
        unread: `${outcome.objectApiName} answered a SystemModstamp that is not a date.`,
      };
    }
    return { objectApiName: outcome.objectApiName, latest, moved: Date.parse(latest) >= since };
  });
}

/** An object as its count is read. */
export interface CountedObject {
  objectApiName: string;
  readMode: CheckpointReadMode;
}

/** How many live records an object holds, or why it could not be counted. */
export type ObjectCount =
  { objectApiName: string; count: number } | { objectApiName: string; unread: string };

/**
 * n for each of `objects`, five a call, three calls in flight.
 *
 * @returns One answer per object, in the order of `objects`.
 * @throws {OrgReadStopped} When the run was stopped.
 */
export async function countRecords(
  reader: CompositeReader,
  objects: readonly CountedObject[],
  signal?: AbortSignal,
): Promise<ObjectCount[]> {
  const outcomes = await readStreams(
    reader,
    objects.map(({ objectApiName, readMode }) => countRead(objectApiName, readMode)),
    () => undefined,
    signal,
    { oneRow: true },
  );
  return outcomes.map((outcome): ObjectCount => {
    if (!outcome.read) return { objectApiName: outcome.objectApiName, unread: outcome.reason };
    return outcome.totalSize === undefined
      ? { objectApiName: outcome.objectApiName, unread: 'The org gave no count of its records.' }
      : { objectApiName: outcome.objectApiName, count: outcome.totalSize };
  });
}

/** An object of a checkpoint, as its change reads read it. */
export interface DetectedObject extends CountedObject {
  /** Read beside the stamps by the change reads: the cascade parent fields. */
  fields?: readonly string[];
  /** Whether the checkpoint holds records of it: such an object is counted even when it did not move. */
  held: boolean;
}

/** A change read spooled: its file, and how many rows it holds. */
export interface SpoolFile {
  file: string;
  rows: number;
}

/** Where the change reads spool the live records of an object stamped since (L), in a preview's folder. */
export function liveSpoolOf(folder: string, objectApiName: string): string {
  return path.join(folder, `${sanitizeSoqlObjectName(objectApiName)}.live.ndjson`);
}

/** Where the change reads spool the records of an object deleted since (D), in a preview's folder. */
export function deletedSpoolOf(folder: string, objectApiName: string): string {
  return path.join(folder, `${sanitizeSoqlObjectName(objectApiName)}.deleted.ndjson`);
}

/** What the change reads found of an object, or why they could not read it. */
export type ObjectChanges =
  | {
      objectApiName: string;
      /** The pre-check's newest stamp, live or in the bin. */
      latest: string | null;
      moved: boolean;
      /** L, spooled: present when it moved. */
      live?: SpoolFile;
      /** D, spooled: present when it moved. */
      deleted?: SpoolFile;
      /** n: present when it moved, or the checkpoint holds records of it. */
      count?: number;
    }
  | { objectApiName: string; unread: string };

/**
 * The change reads for each of `objects` since a checkpoint read from
 * `readFrom`: the pre-check of every object, five a call; then, for those that
 * moved, the records stamped since (L) and those deleted since (D), spooled to
 * `<folder>/<Object>.live.ndjson` and `.deleted.ndjson`; then the count of
 * those that moved or that the checkpoint holds records of.
 *
 * An object any of whose reads failed is `unread`, with why: never read as
 * one that did not change.
 *
 * @param given - The pre-checks of `objects`, one each in their order, when
 *   the caller read them already — a diff reads them before it describes what
 *   moved: not read again.
 * @returns One answer per object, in the order of `objects`.
 * @throws {OrgReadStopped} When the run was stopped.
 */
export async function readChanges(
  reader: CompositeReader,
  objects: readonly DetectedObject[],
  readFrom: string,
  folder: string,
  signal?: AbortSignal,
  given?: readonly PreCheck[],
): Promise<ObjectChanges[]> {
  if (given !== undefined && given.length !== objects.length) {
    throw new Error(`${given.length} pre-checks for ${objects.length} objects`);
  }
  const checks =
    given ??
    (await preCheck(
      reader,
      objects.map(({ objectApiName }) => objectApiName),
      readFrom,
      signal,
    ));
  const unread = new Map<number, string>();
  const movedAt: number[] = [];
  checks.forEach((check, index) => {
    if ('unread' in check) unread.set(index, check.unread);
    else if (check.moved) movedAt.push(index);
  });

  const spooled: SpooledRead[] = movedAt.flatMap((index) => {
    const { objectApiName, readMode, fields = [] } = objects[index];
    const object = sanitizeSoqlObjectName(objectApiName);
    return [
      { ...movedRead(object, readMode, readFrom, fields), file: liveSpoolOf(folder, object) },
      { ...deletedRead(object, readFrom, fields), file: deletedSpoolOf(folder, object) },
    ];
  });
  const changeOutcomes = await spoolReads(reader, spooled, signal);
  const files = new Map<number, { live?: SpoolFile; deleted?: SpoolFile }>();
  movedAt.forEach((index, at) => {
    const live = changeOutcomes[at * 2];
    const deleted = changeOutcomes[at * 2 + 1];
    const failed = [live, deleted].find((outcome) => !outcome.read);
    if (failed && !failed.read) {
      unread.set(index, failed.reason);
      return;
    }
    files.set(index, {
      live: { file: spooled[at * 2].file, rows: live.rows },
      deleted: { file: spooled[at * 2 + 1].file, rows: deleted.rows },
    });
  });

  const countedAt = objects
    .map((object, index) => ({ object, index }))
    .filter(({ object, index }) => !unread.has(index) && (files.has(index) || object.held))
    .map(({ index }) => index);
  const counts = await countRecords(
    reader,
    countedAt.map((index) => objects[index]),
    signal,
  );
  const countOf = new Map<number, number>();
  countedAt.forEach((index, at) => {
    const answer = counts[at];
    if ('unread' in answer) unread.set(index, answer.unread);
    else countOf.set(index, answer.count);
  });

  return checks.map((check, index): ObjectChanges => {
    if ('unread' in check) return check;
    const reason = unread.get(index);
    if (reason !== undefined) return { objectApiName: check.objectApiName, unread: reason };
    const spool = files.get(index);
    const count = countOf.get(index);
    return {
      objectApiName: check.objectApiName,
      latest: check.latest,
      moved: check.moved,
      ...(spool?.live ? { live: spool.live } : {}),
      ...(spool?.deleted ? { deleted: spool.deleted } : {}),
      ...(count !== undefined ? { count } : {}),
    };
  });
}
