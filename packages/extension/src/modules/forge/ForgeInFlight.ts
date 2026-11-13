/**
 * The insert calls a run had sent when it stopped and whose answer never
 * reached its journal, looked for in the target before anything is written
 * again.
 *
 * Run for real between two scratch orgs, a clone of 12 060 contacts was
 * killed at 5 600 written, and its journal held 5 400. One call of 200 rows
 * was under way: the org committed it, its answer never reached the journal,
 * and the resume wrote those rows again — the target ended with 12 200
 * contacts, 200 of them twice.
 *
 * So the journal keeps a line before each insert call goes
 * (`ForgeRunStore.sent`): the object, the rows' source ids in the order sent,
 * the fields whose values tell the rows apart, and per row a fingerprint of
 * those values — a hash, never the values. The call's answer closes it
 * (`ForgeRunStore.answered`). A call the journal names no answer of is read
 * back here: the target's records of its object created by the user the run
 * writes as, in the window of the run's last writes, that no line of the
 * journal names, each fingerprinted the same way from the fields read back
 * and matched to a row one for one — by fingerprint, then by the order the
 * call sent them, which is the order the org created them in. A row matched
 * is in the target: it goes into the journal as a record the run created,
 * which the run links to and a removal takes back, and is never sent again;
 * the lookups it went in without, which the sent line names, are owed to the
 * second pass as the call's answer would have owed them, and no other.
 * A row matched to nothing is written by the resume when nothing is left
 * unexplained in the window. A row the target may hold — more records than
 * rows under its fingerprint, or records left unmatched beside it, which the
 * target's own automation may have changed as it saved them — is not written
 * unless the user says so: a duplicate is a decision.
 *
 * An upsert call is kept and read back the same way, by the value of the
 * external id it matches on, which the target holds one record of at most
 * (`externalIdKey`): a record of the window carrying a row's value is the one
 * the row created, the run's, which a removal takes back; a row no such
 * record carries wrote over one the target held before the run, which stays,
 * or wrote nothing. Upsert calls were not kept, and a removal of a run whose
 * upsert was under way left what that call created in the target.
 *
 * A call sent as a Bulk API job is kept with the id the org gave the job
 * (`ForgeRunStore.jobOpened`), and read back by it rather than looked for in
 * the target: the job goes on to its end on the org's side whatever became of
 * the run, and its results say, row by row, what it wrote. Each of its
 * results is laid on its row by every value the row was sent with, as the
 * run that sent the job lays them (`cellsKey`): the key the journal keeps of
 * each row of an insert job (`jobRowKeys`), recomputed from the cells the
 * result echoes — the records it wrote, those it refused, those it left
 * unprocessed. A journal that kept no such key matches by the fingerprint,
 * which may be one for many rows: live, 2 522 cases had one, and the 2 520
 * records their job wrote were matched to none. Rows that share a key or a
 * fingerprint the job wrote records under are linked to none of them, and
 * said so (`untold`): never a record taken for another row's. A job still
 * running leaves its rows uncertain, and is said with what the org says of
 * it (`underway`); one never closed wrote nothing; and the records it wrote
 * that no row could be matched to are kept as the run's
 * (`ForgeRunStore.createdUnattributed`), for a removal to take back. Beside
 * such records, a row no result was laid on may be one of them, and stays
 * uncertain, as one the window leaves unexplained does. When the job ended
 * is kept too (`jobEndedLine`): it wrote after the journal's last line.
 *
 * Memory stays bounded as the journal's readers keep it: the journal is gone
 * through with the records it names held as hashed keys, a few bytes each and
 * no id, and the window is read a page at a time, keeping of each record its
 * id and its fingerprints.
 */

import type { Connection } from 'jsforce';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { buildBulkCsv, cellsKey } from '../../core/engine/bulkCsv.js';
import type { JsforceIngestJobResults } from '../../core/engine/BulkApiExecutor.js';
import { readJobResults, type JobResultsRead } from '../../core/engine/ingestJobRead.js';
import { jsforceBulk } from '../../core/engine/jsforceBulk.js';
import {
  ANSWERED_TAG,
  FOUND_AFTER_STOP,
  FOUND_OWING_KEPT,
  hashA,
  hashB,
  JOB_ENDED_TAG,
  JOB_TAG,
  jobEndedLine,
  journalLines,
  owedLine,
  SENT_TAG,
  UNATTRIBUTED_TAG,
  type OwedAtInsert,
  type RunFile,
} from './ForgeRunStore.js';
import { HashedKeys, unattributedOf } from './journalRecords.js';
import { cursorPages } from './queryAllPages.js';

/** A Salesforce id, as every id a journal holds is. */
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
/** An API name, of an object or of a field. */
const API_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
/** A date and time as the org writes one, or as a row read from it holds one. */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * Values longer than this tell nothing: a long text the target may trim, or a
 * rich text it cleans as it saves, would match no record of its row.
 */
const LONGEST_VALUE = 255;

/** Fields a call's fingerprints take, at most: enough to tell rows apart, and a query of a sensible length. */
const MOST_FIELDS = 40;

/**
 * How long before a call was sent its records may be dated, by the org's
 * clock once this machine's is set to it: the two clocks may still differ by
 * the time a request takes.
 */
export const IN_FLIGHT_LEAD_MS = 2 * 60_000;

/**
 * How long after the journal's last line a call under way may have been
 * committed: a request the org takes longer to answer than this times out,
 * and the records of a call are dated as it saves them.
 */
export const IN_FLIGHT_TRAIL_MS = 10 * 60_000;

/**
 * The fields of a call's rows whose values fingerprint them: those every row
 * sends a plain value in — a text, a number, a yes or no — none longer than
 * {@link LONGEST_VALUE}, sorted, {@link MOST_FIELDS} at most. A field one row
 * leaves empty is left out for all of them: an empty field takes the target's
 * default, which the row did not send.
 */
export function fingerprintFields(payloads: readonly Record<string, unknown>[]): string[] {
  const [first] = payloads;
  if (!first) return [];
  return Object.keys(first)
    .filter((field) => field !== 'Id' && API_NAME.test(field))
    .filter((field) => payloads.every((payload) => fingerprinted(payload[field])))
    .sort()
    .slice(0, MOST_FIELDS);
}

/** Whether a value goes into a fingerprint: see {@link fingerprintFields}. */
function fingerprinted(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '' && value.length <= LONGEST_VALUE;
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'boolean';
}

/**
 * A value as both sides of a match read it: a record's id by its first
 * fifteen characters, a date and time in one form, a number as a number,
 * the values of a multi-select list in one order, a text without the case
 * and the spaces the target may change as it saves it.
 */
function canonical(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (RECORD_ID.test(text)) return text.slice(0, 15);
  if (DATE_TIME.test(text)) {
    const at = Date.parse(text);
    if (Number.isFinite(at)) return new Date(at).toISOString();
  }
  if (text !== '' && Number.isFinite(Number(text))) return String(Number(text));
  const words = text.replace(/\s+/g, ' ').toLowerCase();
  return words.includes(';')
    ? words
        .split(';')
        .map((part) => part.trim())
        .sort()
        .join(';')
    : words;
}

/**
 * The fingerprint of a row, or of a record read back, over `fields`: two
 * hashes of its values, fourteen characters, which tell two rows apart and
 * hold neither.
 */
export function rowFingerprint(row: Record<string, unknown>, fields: readonly string[]): string {
  return hashed(fields.map((field) => `${field}\u0001${canonical(row[field])}`).join('\u0002'));
}

/** Two hashes of `text`, fourteen characters, which hold none of it. */
function hashed(text: string): string {
  return hashA(text).toString(36).padStart(7, '0') + hashB(text).toString(36).padStart(7, '0');
}

/**
 * The key each row of an insert sent as a Bulk API job is found by in the
 * job's results, in the order given: every value the job sends of it, in the
 * form the platform echoes it in (`cellsKey`), hashed as a fingerprint is.
 * Rows the job would take for twins — kept out of it, and written by REST —
 * share theirs; any other two rows have their own.
 */
export function jobRowKeys(payloads: readonly Record<string, unknown>[]): string[] {
  const csv = buildBulkCsv('insert', payloads);
  return csv.rows.map((cells) =>
    hashed(cellsKey(csv.columns.map((column, i) => [column, cells[i] ?? ''] as const))),
  );
}

/** A job's own columns in its results, beside those it echoes: `sf__Id`, `sf__Created`, `sf__Error`. */
const RESULT_COLUMN = /^sf__/;

/** The key of the row a result of a job echoes: see {@link jobRowKeys}. */
function resultRowKey(result: Readonly<Record<string, unknown>>): string {
  const cells: Array<[string, string]> = [];
  for (const [field, value] of Object.entries(result)) {
    if (RESULT_COLUMN.test(field)) continue;
    cells.push([field, typeof value === 'string' ? value : value == null ? '' : String(value)]);
  }
  return hashed(cellsKey(cells));
}

/**
 * The fingerprint of the external id a row is upserted by, its value alone,
 * as {@link rowFingerprint} takes it — the same for the row sent and for the
 * record read back, whichever case or spacing the target keeps the value in.
 */
export function externalIdKey(row: Record<string, unknown>, field: string): string {
  return rowFingerprint(row, [field]);
}

/** A row of a call the journal says was sent. */
interface SentRow {
  sourceId: string;
  fingerprint: string;
  /** The lookups it went in without, owed to the second pass once it is in. */
  owes: OwedAtInsert[];
  /** For an upsert call: the fingerprint of the external id value it matches on. */
  externalKey?: string;
  /** For an insert call sent as a Bulk API job: the key its results find it by (`jobRowKeys`). */
  jobKey?: string;
}

/** A call the journal says was sent, as {@link reconcileInFlight} reads it back. */
interface SentCall {
  callId: string;
  objectApiName: string;
  /** When it was sent, on the clock of the machine that sent it. */
  at: number;
  fields: string[];
  /** Its rows, in the order sent: each source id and fingerprint. */
  rows: SentRow[];
  /**
   * Whether the line says what each row went in without: not one of 1.61,
   * whose rows found are owed again every lookup they name.
   */
  owesKept: boolean;
  /**
   * The external id an upsert call matches its rows by: a row of it the
   * target took created a record, or wrote over one it held. Absent for an
   * insert.
   */
  upsertField?: string;
}

/** The lookups a sent line says its rows went in without, onto `rows`; false for a line that says it wrongly. */
function readOwes(owed: unknown, rows: SentRow[]): boolean {
  if (!Array.isArray(owed)) return false;
  for (const entry of owed) {
    if (!Array.isArray(entry) || entry.length < 4) return false;
    const [row, field, sourceRefId, insertOnly] = entry as unknown[];
    if (typeof row !== 'number' || !Number.isInteger(row) || !rows[row]) return false;
    if (typeof field !== 'string' || !API_NAME.test(field)) return false;
    if (typeof sourceRefId !== 'string' || !RECORD_ID.test(sourceRefId)) return false;
    rows[row].owes.push({ field, sourceRefId, ...(insertOnly === 1 ? { insertOnly: true } : {}) });
  }
  return true;
}

/** The call a sent line holds; nothing for any other line. */
function sentCallOf(text: string): SentCall | undefined {
  if (!text.startsWith(`["${SENT_TAG}"`)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value) || value.length < 6) return undefined;
  const [, callId, objectApiName, at, fields, rows, owed, upsertField] = value as unknown[];
  if (typeof callId !== 'string' || typeof objectApiName !== 'string') return undefined;
  if (!API_NAME.test(objectApiName) || typeof at !== 'string') return undefined;
  const sentAt = Date.parse(at);
  if (!Number.isFinite(sentAt) || !Array.isArray(fields) || !Array.isArray(rows)) return undefined;
  if (!fields.every((field) => typeof field === 'string' && API_NAME.test(field))) return undefined;
  if (upsertField !== undefined && (typeof upsertField !== 'string' || !API_NAME.test(upsertField)))
    return undefined;
  const read: SentRow[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 2) return undefined;
    const [sourceId, fingerprint, externalKey, jobKey] = row as unknown[];
    if (typeof sourceId !== 'string' || !RECORD_ID.test(sourceId)) return undefined;
    if (typeof fingerprint !== 'string') return undefined;
    if (externalKey !== undefined && typeof externalKey !== 'string') return undefined;
    if (jobKey !== undefined && typeof jobKey !== 'string') return undefined;
    read.push({
      sourceId,
      fingerprint,
      owes: [],
      // A row of an insert job keeps no external id: its place is left empty.
      ...(typeof externalKey === 'string' && externalKey !== '' ? { externalKey } : {}),
      ...(typeof jobKey === 'string' && jobKey !== '' ? { jobKey } : {}),
    });
  }
  const owesKept = owed !== undefined;
  if (owesKept && !readOwes(owed, read)) return undefined;
  return {
    callId,
    objectApiName,
    at: sentAt,
    fields: fields as string[],
    rows: read,
    owesKept,
    ...(typeof upsertField === 'string' ? { upsertField } : {}),
  };
}

/** The call id an answered line closes; nothing for any other line. */
function answeredCallOf(text: string): string | undefined {
  if (!text.startsWith(`["${ANSWERED_TAG}"`)) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) && typeof value[1] === 'string' ? value[1] : undefined;
  } catch {
    return undefined;
  }
}

/** The call a line saying when its job ended names; nothing for any other line. */
function jobEndedOf(text: string): string | undefined {
  if (!text.startsWith(`["${JOB_ENDED_TAG}"`)) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) && typeof value[1] === 'string' ? value[1] : undefined;
  } catch {
    return undefined;
  }
}

/** The call and the job a job line names; nothing for any other line. */
function jobOf(text: string): { callId: string; jobId: string } | undefined {
  if (!text.startsWith(`["${JOB_TAG}"`)) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value)) return undefined;
    const [, callId, jobId] = value as unknown[];
    if (typeof callId !== 'string' || typeof jobId !== 'string' || jobId === '') return undefined;
    return { callId, jobId };
  } catch {
    return undefined;
  }
}

/** A mapping line: a record a run created, linked to or wrote over. */
function mappingOf(
  text: string,
): { sourceId: string; targetId: string; object: string } | undefined {
  if (!text.startsWith('["c"') && !text.startsWith('["e"') && !text.startsWith('["u"')) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value)) return undefined;
    const [, sourceId, targetId, object] = value as unknown[];
    if (typeof sourceId !== 'string' || typeof targetId !== 'string') return undefined;
    if (!RECORD_ID.test(sourceId) || !RECORD_ID.test(targetId)) return undefined;
    return { sourceId, targetId, object: typeof object === 'string' ? object : '' };
  } catch {
    return undefined;
  }
}

/** The times a line of the journal holds: its head's start, a part's, an end, a call sent. */
function timeOf(text: string): number {
  const match = /"(?:startedAt|at)":"([^"]{10,40})"/.exec(text);
  if (match) return Date.parse(match[1]);
  return Number.NaN;
}

/** What a reconciliation reads of the org a run wrote to. */
export interface InFlightTarget {
  /** A query's rows, a page at a time. */
  queryPages(soql: string): AsyncIterable<Record<string, unknown>[]>;
  /** The id of the user the run writes as, who created the run's records. */
  userId(): Promise<string>;
  /** The org's clock now, as it writes a date: what this machine's clock is set to. */
  serverTime?(): Promise<string>;
  /**
   * A Bulk API job read back by its id: its state, and once it has ended,
   * its results (`readJobResults`). Without it, a call sent as a job is
   * looked for in the target as a REST call is.
   */
  readJob?(jobId: string): Promise<JobResultsRead>;
}

/**
 * The org a run wrote to, over its connection, as a reconciliation reads it:
 * its records a page at a time, the user the connection is of, its clock.
 */
export function inFlightTargetOf(conn: Connection): InFlightTarget {
  return {
    queryPages: (soql) =>
      cursorPages<Record<string, unknown>>(
        {
          query: async (q) => conn.query<Record<string, unknown>>(q),
          queryMore: async (url) => conn.queryMore<Record<string, unknown>>(url),
        },
        soql,
      ),
    userId: async () => (await conn.identity()).user_id,
    serverTime: async () => (await conn.soap.getServerTimestamp()).timestamp,
    // Through the typed adapter, which holds what the org says of a job to an
    // ingest job's states: a state it does not name is not read as one.
    readJob: (jobId) => readJobResults(jsforceBulk(conn), jobId),
  };
}

/** Rows of one object. */
export interface InFlightObjectRows {
  objectApiName: string;
  rows: number;
}

/** A Bulk API job a run had under way that the org has not ended yet: see {@link InFlightReconciliation.underway}. */
export interface InFlightJobUnderway {
  objectApiName: string;
  /** The job, by the id the org gave it. */
  jobId: string;
  /** The rows of the call it went as, not mapped yet: among the uncertain. */
  rows: number;
  /** Its state as the org says it: `Open`, `UploadComplete` or `InProgress`. */
  state?: string;
  /** The rows the org has processed of it so far. */
  processed?: number;
  /**
   * For a job still open, when its hour of grace ends on the org's clock:
   * a read of it from then aborts it if it is open still (`readJobResults`).
   */
  openUntil?: string;
  /** How long that hour has left, on this machine's clock, as it was read. */
  graceLeftMs?: number;
}

/** What a reconciliation found of the calls a run had under way when it stopped. */
export interface InFlightReconciliation {
  /** Insert calls the journal names no answer of. */
  calls: number;
  /** Per object, the rows found in the target: now in the journal as the run's. */
  found: InFlightObjectRows[];
  /** Per object, the rows not in the target: the resume writes them. */
  notFound: InFlightObjectRows[];
  /**
   * Per object, the rows the target may hold already: written again only
   * when the user says so, each of them may then be there twice.
   */
  uncertain: InFlightObjectRows[];
  /** Per object, why the target could not be read: its rows are among the uncertain. */
  unread: Array<{ objectApiName: string; reason: string }>;
  /**
   * The Bulk API jobs still open or running, as the org says them: their
   * rows are among the uncertain, known once the job has ended. Run for real,
   * a resume a few minutes after its run was killed found its job open, 0
   * rows processed, and said only that the target held records it could not
   * tell from them.
   */
  underway?: InFlightJobUnderway[];
  /**
   * Per object, of the uncertain rows, those of a Bulk API job that ended:
   * which of them a record it wrote is cannot be told, and every record it
   * wrote with an id is in the journal as the run's, under no row
   * (`ForgeRunStore.createdUnattributed`), which a removal takes back.
   */
  ofEndedJobs?: InFlightObjectRows[];
  /**
   * Per object, of those, the rows the journal cannot tell apart: several of
   * them under one key, or one fingerprint, under which the job wrote
   * records. None of those records is linked to a row.
   */
  untold?: InFlightObjectRows[];
  /**
   * Per object, the records Bulk API jobs wrote that no row could be matched
   * to, in the journal as the run's under no row: a removal takes them back.
   */
  unattributed?: InFlightObjectRows[];
  /**
   * The source ids of the rows of those calls, each looked for: a call that
   * threw before its answer is among them, and the rows a run's own count
   * says it may have written (`ForgeExecutionResult.mayHaveBeenWritten`) are
   * known once looked for. None when no call was under way.
   */
  lookedFor?: ReadonlySet<string>;
}

/** A reconciliation that found no call under way. */
function noCallsInFlight(): InFlightReconciliation {
  return { calls: 0, found: [], notFound: [], uncertain: [], unread: [] };
}

/** Count a row of `objectApiName` in `list`. */
function tally(list: InFlightObjectRows[], objectApiName: string, rows = 1): void {
  if (rows <= 0) return;
  const known = list.find((entry) => entry.objectApiName === objectApiName);
  if (known) known.rows += rows;
  else list.push({ objectApiName, rows });
}

/** A date for a SOQL condition: to the second, as the org dates records. */
function soqlDate(epoch: number): string {
  return new Date(epoch).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** A record of the window no line of the journal names: its id, and its fingerprint under each call's fields. */
interface Candidate {
  id: string;
  fingerprints: Map<string, string>;
  /** Per external id an upsert call of its object matches by, the fingerprint of its value. */
  externalKeys: Map<string, string>;
  /** Matched to a row. */
  taken: boolean;
}

/**
 * The lines that keep `row` as the record `id` its call created: the record,
 * and the lookups the row went in without, owed to the second pass, as the
 * call's answer would have kept them.
 */
function foundLines(call: SentCall, row: SentRow, id: string): string[] {
  return [
    JSON.stringify([
      'c',
      row.sourceId,
      id,
      call.objectApiName,
      call.owesKept ? FOUND_OWING_KEPT : FOUND_AFTER_STOP,
    ]),
    ...row.owes.map(({ field, sourceRefId, insertOnly }) =>
      owedLine({
        objectApiName: call.objectApiName,
        newId: id,
        sourceId: row.sourceId,
        fieldName: field,
        sourceRefId,
        ...(insertOnly ? { insertOnly } : {}),
      }),
    ),
  ];
}

/** What a reconciliation made of a call read back by its job. */
interface JobReconciled {
  /** The lines to add to the journal: rows found, records no row was matched to, the call closed. */
  lines: string[];
  /** The target ids it took, found or kept unmatched: none of them a record of another call. */
  taken: string[];
}

/** A call sent as a job, read back by its job: see {@link reconcileByJob}. */
interface JobCall {
  call: SentCall;
  /** Its rows not mapped yet. */
  rows: readonly SentRow[];
  /** The job, by the id the org gave it. */
  jobId: string;
  /** What the org says of it. */
  read: JobResultsRead;
  /**
   * How far the org's clock runs ahead of this machine's, in milliseconds:
   * when the job ended is kept on both.
   */
  ahead: number;
  /** Whether the journal says already when the job ended. */
  endKept: boolean;
}

/**
 * Read back by its job the call `call`, its rows not mapped yet `rows`.
 *
 * Each result of the job is laid on its row by the key the journal kept of
 * it (`jobRowKeys`), every value the row was sent with, as the run that sent
 * the job laid them: a record it wrote is found, a row it refused or left
 * unprocessed was not written, and the resume writes it. Rows that share a
 * key were kept out of the job as twins, and written by nothing: the resume
 * writes them. Of a journal that kept no key, or of an upsert, the records
 * are matched by the fingerprint over the call's fields, or by the value of
 * the external id, a record it created and not one it wrote over, one for one.
 *
 * Several rows under one key or fingerprint under which the job wrote
 * records are linked to none of those records, which are kept as the run's
 * without a row, and said (`untold`). A record the job wrote under no row's
 * key leaves uncertain the rows no result was laid on: it may be one of them,
 * its cells not what the run sent. The call is closed once every row is
 * found or known not written; and once the job has ended, when it did is kept
 * ({@link jobEndedLine}).
 *
 * @param named - The records the journal names: none of them the job's to match.
 * @param unattributed - Those of them named as the run's under no row
 *   (`createdUnattributed`), by an earlier reconciliation of this call: the
 *   job's still, matched again, and not named a second time.
 */
function reconcileByJob(
  job: JobCall,
  named: HashedKeys,
  unattributed: HashedKeys,
  outcome: InFlightReconciliation,
): JobReconciled {
  const { call, rows, read } = job;
  const { objectApiName } = call;
  const closed = JSON.stringify([ANSWERED_TAG, call.callId]);
  if (read.state === 'never-closed') {
    // Never closed, it wrote nothing: the resume writes its rows.
    tally(outcome.notFound, objectApiName, rows.length);
    return { lines: [closed], taken: [] };
  }
  if (read.state === 'running') {
    tally(outcome.uncertain, objectApiName, rows.length);
    (outcome.underway ??= []).push({
      objectApiName,
      jobId: job.jobId,
      rows: rows.length,
      ...(read.info ? { state: read.info.state } : {}),
      ...(read.info?.numberRecordsProcessed !== undefined
        ? { processed: read.info.numberRecordsProcessed }
        : {}),
      ...(read.openUntil ? { openUntil: read.openUntil } : {}),
      ...(read.graceLeftMs !== undefined ? { graceLeftMs: read.graceLeftMs } : {}),
    });
    return { lines: [], taken: [] };
  }
  if (read.state === 'unread') {
    outcome.unread.push({ objectApiName, reason: read.reason });
    tally(outcome.uncertain, objectApiName, rows.length);
    return { lines: [], taken: [] };
  }
  const reconciled =
    call.upsertField === undefined && rows.every((row) => row.jobKey !== undefined)
      ? byRowKeys(call, rows, read.results, named, unattributed, outcome)
      : byFingerprints(call, rows, read.results, named, unattributed, outcome);
  // What the job wrote, it wrote after the journal's last line: the part
  // that sent it ends no earlier than the job, as the org dated its end.
  const orgEnd = Date.parse(read.info.systemModstamp ?? '');
  if (!job.endKept && reconciled.taken.length > 0 && Number.isFinite(orgEnd)) {
    reconciled.lines.unshift(
      jobEndedLine(
        call.callId,
        job.jobId,
        new Date(orgEnd).toISOString(),
        new Date(orgEnd - job.ahead).toISOString(),
      ),
    );
  }
  return reconciled;
}

/**
 * The rows of `call` read back by the key each was sent with (`jobRowKeys`):
 * see {@link reconcileByJob}.
 */
function byRowKeys(
  call: SentCall,
  rows: readonly SentRow[],
  results: JsforceIngestJobResults,
  named: HashedKeys,
  unattributed: HashedKeys,
  outcome: InFlightReconciliation,
): JobReconciled {
  const { objectApiName } = call;
  /** Per key, the records the job wrote under it that no line names yet. */
  const wrote = new Map<string, string[]>();
  /** Keys under which the job wrote a record and gave no id of it. */
  const wroteUnnamed = new Set<string>();
  for (const result of results.successfulResults ?? []) {
    const id = result['sf__Id'];
    const key = resultRowKey(result);
    if (typeof id !== 'string' || !RECORD_ID.test(id)) {
      wroteUnnamed.add(key);
      continue;
    }
    const known = id.slice(0, 15);
    if (named.has(known) && !unattributed.has(known)) continue;
    wrote.set(key, [...(wrote.get(key) ?? []), id]);
  }
  /** Keys of the rows the job refused, or did not process: not written. */
  const notWritten = new Set<string>();
  const unprocessed = results.unprocessedRecords;
  for (const result of [
    ...(results.failedResults ?? []),
    ...(Array.isArray(unprocessed) ? unprocessed : []),
  ]) {
    notWritten.add(resultRowKey(result));
  }
  const byKey = new Map<string, SentRow[]>();
  for (const row of rows) {
    const key = row.jobKey ?? '';
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }
  const lines: string[] = [];
  const taken: string[] = [];
  const unmatched: string[] = [];
  /** The rows no result was laid on: none written, unless the job wrote a record no row is. */
  let noResult = 0;
  let doubtful = false;
  /** Rows uncertain whose every record the journal names. */
  let ofEnded = 0;
  for (const [key, same] of byKey) {
    const holding = wrote.get(key) ?? [];
    wrote.delete(key);
    const unnamed = wroteUnnamed.delete(key);
    if (same.length === 1 && holding.length === 1 && !unnamed) {
      lines.push(...foundLines(call, same[0], holding[0]));
      taken.push(holding[0]);
      tally(outcome.found, objectApiName);
      continue;
    }
    if (holding.length > 0 || unnamed) {
      // Several rows under one key, or one row two records echo: which
      // record is which row cannot be told. Linked to none, and said.
      tally(outcome.uncertain, objectApiName, same.length);
      if (same.length > 1) tally((outcome.untold ??= []), objectApiName, same.length);
      if (!unnamed) ofEnded += same.length;
      unmatched.push(...holding);
      doubtful = true;
      continue;
    }
    // Rows that share a key were kept out of the job as twins, and a row the
    // job refused or left unprocessed wrote nothing: the resume writes them.
    if (same.length > 1 || notWritten.has(key)) {
      tally(outcome.notFound, objectApiName, same.length);
      continue;
    }
    noResult += same.length;
  }
  // A record the job wrote under no row's key is the run's, under no row: a
  // row no result was laid on may be it, and is never written a second time.
  let unexplained = wroteUnnamed.size > 0;
  for (const ids of wrote.values()) {
    unmatched.push(...ids);
    if (ids.length > 0) unexplained = true;
  }
  if (noResult > 0) {
    tally(unexplained ? outcome.uncertain : outcome.notFound, objectApiName, noResult);
    if (unexplained) {
      doubtful = true;
      if (wroteUnnamed.size === 0) ofEnded += noResult;
    }
  }
  if (ofEnded > 0) tally((outcome.ofEndedJobs ??= []), objectApiName, ofEnded);
  lines.push(...closingLines(call, unmatched, unattributed, doubtful, outcome));
  return { lines, taken: [...taken, ...unmatched] };
}

/**
 * The lines that end a reconciliation of `call` by its job: the records it
 * wrote that no row was matched to, as the run's, those an earlier
 * reconciliation named left out; and, once no row is doubtful, the line that
 * closes the call. A call left open is read again, and its job says the same.
 */
function closingLines(
  call: SentCall,
  unmatched: readonly string[],
  unattributed: HashedKeys,
  doubtful: boolean,
  outcome: InFlightReconciliation,
): string[] {
  if (unmatched.length > 0) {
    tally((outcome.unattributed ??= []), call.objectApiName, unmatched.length);
  }
  const newly = unmatched.filter((id) => !unattributed.has(id.slice(0, 15)));
  return [
    ...(newly.length > 0 ? [JSON.stringify([UNATTRIBUTED_TAG, call.objectApiName, newly])] : []),
    ...(doubtful ? [] : [JSON.stringify([ANSWERED_TAG, call.callId])]),
  ];
}

/**
 * The rows of `call` read back by their fingerprint over the call's fields,
 * or for an upsert by the value of its external id: a journal that kept no
 * key of its rows. See {@link reconcileByJob}.
 */
function byFingerprints(
  call: SentCall,
  rows: readonly SentRow[],
  results: JsforceIngestJobResults,
  named: HashedKeys,
  unattributed: HashedKeys,
  outcome: InFlightReconciliation,
): JobReconciled {
  const { objectApiName } = call;
  const upsertField = call.upsertField;
  /** Per fingerprint, the records the job created under it that no line names yet. */
  const held = new Map<string, string[]>();
  for (const result of results.successfulResults ?? []) {
    const id = result['sf__Id'];
    if (typeof id !== 'string' || !RECORD_ID.test(id)) continue;
    const key = id.slice(0, 15);
    if (named.has(key) && !unattributed.has(key)) continue;
    // A record an upsert wrote over was the target's before the run: not its own.
    if (upsertField !== undefined && String(result['sf__Created']).toLowerCase() !== 'true') {
      continue;
    }
    const fingerprint =
      upsertField !== undefined
        ? externalIdKey(result, upsertField)
        : rowFingerprint(result, call.fields);
    held.set(fingerprint, [...(held.get(fingerprint) ?? []), id]);
  }
  const byKey = new Map<string, SentRow[]>();
  for (const row of rows) {
    const key = upsertField !== undefined ? (row.externalKey ?? '') : row.fingerprint;
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }
  const lines: string[] = [];
  const taken: string[] = [];
  const unmatched: string[] = [];
  /** The rows no record of the job carries the fingerprint of. */
  let unfound = 0;
  let doubtful = false;
  for (const [key, same] of byKey) {
    const holding = key === '' ? [] : (held.get(key) ?? []);
    held.delete(key);
    if (holding.length === 0) {
      unfound += same.length;
      continue;
    }
    if (same.length === 1 && holding.length === 1) {
      lines.push(...foundLines(call, same[0], holding[0]));
      taken.push(holding[0]);
      tally(outcome.found, objectApiName);
      continue;
    }
    // Which row each record is cannot be told: the rows may be there, and
    // the records are the run's all the same. Several rows under one
    // fingerprint are said so: live, the three fields every one of 2 522
    // cases filled held the same values on all of them.
    tally(outcome.uncertain, objectApiName, same.length);
    tally((outcome.ofEndedJobs ??= []), objectApiName, same.length);
    if (same.length > 1) tally((outcome.untold ??= []), objectApiName, same.length);
    unmatched.push(...holding);
    doubtful = true;
  }
  // Records the job wrote under no row's fingerprint are the run's, under no
  // row. A job's results echo the cells it was sent, so such a record is a
  // row whose cells the fingerprint did not find again: any row no record was
  // found for may be it, and stays uncertain — never written a second time —
  // as a row the window cannot explain does. With none, a row no record was
  // found for was refused, left unprocessed, kept out of the job, or an
  // upsert that wrote over a record the target held: the resume writes it.
  let unexplained = false;
  for (const ids of held.values()) {
    unmatched.push(...ids);
    if (ids.length > 0) unexplained = true;
  }
  if (unfound > 0) {
    tally(unexplained ? outcome.uncertain : outcome.notFound, objectApiName, unfound);
    if (unexplained) {
      doubtful = true;
      tally((outcome.ofEndedJobs ??= []), objectApiName, unfound);
    }
  }
  lines.push(...closingLines(call, unmatched, unattributed, doubtful, outcome));
  return { lines, taken: [...taken, ...unmatched] };
}

/**
 * The insert calls the journal `file` names no answer of: read without the
 * target, to know whether a reconciliation has anything to look for.
 */
export function callsInFlight(file: RunFile): number {
  const open = new Set<string>();
  for (const line of journalLines(file)) {
    const answered = answeredCallOf(line.text);
    if (answered !== undefined) open.delete(answered);
    else {
      const call = line.text.startsWith(`["${SENT_TAG}"`) ? sentCallOf(line.text) : undefined;
      if (call) open.add(call.callId);
    }
  }
  return open.size;
}

/**
 * Look for the rows of the insert calls the journal names no answer of in
 * the target, and keep in the journal what was found: a line per row found,
 * as a record the run created, and, for each call whose every row is found
 * or known not to be there, a line that closes it. Lines added at the end of
 * the journal, before the part that takes the run up begins: the rows found
 * are the part's that sent them, which a removal of the run takes back.
 *
 * A journal kept before calls were journaled has none: nothing is read of
 * the target, and nothing written.
 *
 * @param file - The journal, opened to add to.
 * @param target - The org the run wrote to.
 * @param now - This machine's clock, set against the org's.
 */
export async function reconcileInFlight(
  file: RunFile,
  target: InFlightTarget,
  now: () => Date = () => new Date(),
): Promise<InFlightReconciliation> {
  const outcome = noCallsInFlight();
  // The calls left open, the jobs they went as, and the journal's last time.
  const open = new Map<string, { offset: number; length: number }>();
  const jobs = new Map<string, string>();
  /** The calls whose job the journal says when it ended. */
  const ended = new Set<string>();
  let last = Number.NEGATIVE_INFINITY;
  for (const line of journalLines(file)) {
    const answered = answeredCallOf(line.text);
    if (answered !== undefined) {
      open.delete(answered);
      continue;
    }
    const job = jobOf(line.text);
    if (job) {
      jobs.set(job.callId, job.jobId);
      continue;
    }
    const endedCall = jobEndedOf(line.text);
    if (endedCall !== undefined) {
      ended.add(endedCall);
      continue;
    }
    if (line.text.startsWith(`["${SENT_TAG}"`)) {
      const call = sentCallOf(line.text);
      if (call) {
        open.set(call.callId, { offset: line.offset, length: line.length });
        last = Math.max(last, call.at);
      }
      continue;
    }
    if (line.text.startsWith('{')) {
      const at = timeOf(line.text);
      if (Number.isFinite(at)) last = Math.max(last, at);
    }
  }
  if (open.size === 0) return outcome;
  const calls: SentCall[] = [];
  for (const { offset, length } of open.values()) {
    const call = sentCallOf(file.read(offset, length).toString('utf8'));
    if (call) calls.push(call);
  }
  outcome.calls = calls.length;
  const objects = new Set(calls.map((call) => call.objectApiName));
  const openSources = new Set(calls.flatMap((call) => call.rows.map((row) => row.sourceId)));
  outcome.lookedFor = openSources;
  // What the journal names already: the rows of the open calls it mapped —
  // their answer came in, and the line that closes their call did not —
  // and, of their objects, every record it names, which is none of theirs.
  const mapped = new Set<string>();
  const named = new HashedKeys();
  // The records a job wrote that no row was matched to, as the run kept
  // them: none of them a record of a call looked for in the window, and a
  // call read again by its job matches them again.
  const unattributed = new HashedKeys();
  for (const line of journalLines(file)) {
    const kept = unattributedOf(line.text);
    if (kept) {
      if (objects.has(kept.object)) {
        for (const id of kept.ids) {
          named.add(id.slice(0, 15));
          unattributed.add(id.slice(0, 15));
        }
      }
      continue;
    }
    const mapping = mappingOf(line.text);
    if (!mapping) continue;
    if (openSources.has(mapping.sourceId)) mapped.add(mapping.sourceId);
    if (mapping.object === '' || objects.has(mapping.object)) {
      named.add(mapping.targetId.slice(0, 15));
    }
  }

  // This machine's clock against the org's: a call's records are dated by the org.
  let ahead = 0;
  if (target.serverTime) {
    try {
      const before = now().getTime();
      const orgNow = Date.parse(await target.serverTime());
      if (Number.isFinite(orgNow)) ahead = orgNow - (before + now().getTime()) / 2;
    } catch {
      // Untold: this machine's clock stands for the org's, give or take the lead.
    }
  }
  let user: string | undefined;
  let userUnread: string | undefined;

  const lines: string[] = [];
  // The calls sent as jobs first, each read back by its job: what they took
  // is no record for the calls looked for in the window to match.
  const readJob = target.readJob?.bind(target);
  const byJob = new Set<string>();
  if (readJob) {
    for (const call of calls) {
      const jobId = jobs.get(call.callId);
      if (jobId === undefined) continue;
      byJob.add(call.callId);
      const rows = call.rows.filter((row) => !mapped.has(row.sourceId));
      if (rows.length === 0) {
        lines.push(JSON.stringify([ANSWERED_TAG, call.callId]));
        continue;
      }
      const reconciled = reconcileByJob(
        { call, rows, jobId, read: await readJob(jobId), ahead, endKept: ended.has(call.callId) },
        named,
        unattributed,
        outcome,
      );
      lines.push(...reconciled.lines);
      for (const id of reconciled.taken) named.add(id.slice(0, 15));
    }
  }

  for (const objectApiName of objects) {
    const ofObject = calls.filter(
      (call) => call.objectApiName === objectApiName && !byJob.has(call.callId),
    );
    if (ofObject.length === 0) continue;
    const rowsLeft = ofObject.map((call) => ({
      call,
      rows: call.rows.filter((row) => !mapped.has(row.sourceId)),
    }));
    const left = rowsLeft.reduce((sum, { rows }) => sum + rows.length, 0);
    if (left === 0) {
      for (const { call } of rowsLeft) lines.push(JSON.stringify([ANSWERED_TAG, call.callId]));
      continue;
    }
    const fieldSets = new Map<string, string[]>();
    for (const call of ofObject) fieldSets.set(call.fields.join(','), call.fields);
    /** The external ids the upsert calls of the object match by. */
    const upsertFields = [
      ...new Set(ofObject.flatMap((call) => (call.upsertField ? [call.upsertField] : []))),
    ];
    const fields = [
      ...new Set([...ofObject.flatMap((call) => call.fields), ...upsertFields]),
    ].sort();
    let candidates: Candidate[];
    try {
      if (user === undefined && userUnread === undefined) {
        try {
          user = await target.userId();
        } catch (err: unknown) {
          userUnread = extractErrorMessage(err);
        }
      }
      if (user === undefined)
        throw new Error(`the user the run writes as is not known: ${userUnread}`);
      const from = Math.min(...ofObject.map((call) => call.at)) + ahead - IN_FLIGHT_LEAD_MS;
      const to = last + ahead + IN_FLIGHT_TRAIL_MS;
      // A run that writes the source's audit fields dates its records by the
      // source and names their creator from it: the system stamp is the org's
      // own, and the user is told by the fingerprint then.
      const dated = fields.includes('CreatedDate') ? 'SystemModstamp' : 'CreatedDate';
      const by = fields.includes('CreatedById') ? '' : `CreatedById = '${user}' AND `;
      const soql =
        `SELECT ${['Id', ...fields.filter((field) => field !== 'Id')].join(', ')} ` +
        `FROM ${assertSoqlIdentifier(objectApiName)} ` +
        `WHERE ${by}${dated} >= ${soqlDate(from)} AND ${dated} <= ${soqlDate(to)} ORDER BY Id`;
      candidates = [];
      for await (const page of target.queryPages(soql)) {
        for (const record of page) {
          const id = record['Id'];
          if (typeof id !== 'string' || !RECORD_ID.test(id)) continue;
          if (named.has(id.slice(0, 15))) continue;
          const fingerprints = new Map<string, string>();
          for (const [key, set] of fieldSets) fingerprints.set(key, rowFingerprint(record, set));
          const externalKeys = new Map<string, string>();
          for (const field of upsertFields) externalKeys.set(field, externalIdKey(record, field));
          candidates.push({ id, fingerprints, externalKeys, taken: false });
        }
      }
    } catch (err: unknown) {
      outcome.unread.push({ objectApiName, reason: extractErrorMessage(err) });
      tally(outcome.uncertain, objectApiName, left);
      continue;
    }
    candidates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    // The records under each fingerprint, per set of fields, in the order of their ids.
    const index = new Map<string, Map<string, Candidate[]>>();
    for (const key of fieldSets.keys()) {
      const byFingerprint = new Map<string, Candidate[]>();
      for (const candidate of candidates) {
        const fingerprint = candidate.fingerprints.get(key) ?? '';
        const same = byFingerprint.get(fingerprint) ?? [];
        same.push(candidate);
        byFingerprint.set(fingerprint, same);
      }
      index.set(key, byFingerprint);
    }

    /** Keep `row` as the record `candidate` the call created: see `foundLines`. */
    const found = (call: SentCall, row: SentRow, candidate: Candidate): void => {
      candidate.taken = true;
      lines.push(...foundLines(call, row, candidate.id));
      tally(outcome.found, objectApiName);
    };

    const doubtful = new Set<string>();
    // The upsert calls first, each row by the value of the external id it
    // matches on, which the target holds one record of at most: a record of
    // the window carrying it is the one the row created, and a row none
    // carries created nothing — it wrote over a record the target held before
    // the run, which stays, or it wrote nothing. Neither is the run's to take.
    for (const { call, rows } of rowsLeft) {
      const field = call.upsertField;
      if (field === undefined) continue;
      const held = new Map<string, Candidate[]>();
      for (const candidate of candidates) {
        const key = candidate.externalKeys.get(field);
        if (candidate.taken || key === undefined) continue;
        held.set(key, [...(held.get(key) ?? []), candidate]);
      }
      const byKey = new Map<string, SentRow[]>();
      for (const row of rows) {
        const key = row.externalKey ?? '';
        byKey.set(key, [...(byKey.get(key) ?? []), row]);
      }
      for (const [key, same] of byKey) {
        const holding = key === '' ? [] : (held.get(key) ?? []);
        // A value two rows share, two records carry, or a row kept without
        // one: which is which cannot be told.
        if (key === '' || same.length > 1 || holding.length > 1) {
          tally(outcome.uncertain, objectApiName, same.length);
          doubtful.add(call.callId);
          continue;
        }
        if (holding.length === 1) found(call, same[0], holding[0]);
        else tally(outcome.notFound, objectApiName);
      }
    }

    // Each insert call's rows matched in turn, to the records left unmatched.
    const unmatched: Array<{ callId: string; sourceId: string }> = [];
    for (const { call, rows } of rowsLeft) {
      if (call.upsertField !== undefined) continue;
      const key = call.fields.join(',');
      const byFingerprint = new Map<string, SentRow[]>();
      for (const row of rows) {
        const same = byFingerprint.get(row.fingerprint) ?? [];
        same.push(row);
        byFingerprint.set(row.fingerprint, same);
      }
      for (const [fingerprint, same] of byFingerprint) {
        const held = (index.get(key)?.get(fingerprint) ?? []).filter(
          (candidate) => !candidate.taken,
        );
        if (held.length > same.length) {
          // More records than rows under the fingerprint: which are the
          // call's cannot be told.
          for (const row of same) unmatched.push({ callId: call.callId, sourceId: row.sourceId });
          doubtful.add(call.callId);
          continue;
        }
        // As many or fewer: the call's, in the order it sent them, which is
        // the order the org created them in.
        held.forEach((candidate, index) => found(call, same[index], candidate));
        for (const row of same.slice(held.length)) {
          unmatched.push({ callId: call.callId, sourceId: row.sourceId });
        }
      }
    }
    // A record of the window none of the rows matched may be one of them,
    // changed by the target as it saved it: a row matched to nothing is then
    // one the target may hold. With none left, it is not there.
    const unexplained = candidates.some((candidate) => !candidate.taken);
    for (const row of unmatched) {
      if (unexplained || doubtful.has(row.callId)) {
        tally(outcome.uncertain, objectApiName);
        doubtful.add(row.callId);
      } else {
        tally(outcome.notFound, objectApiName);
      }
    }
    for (const { call } of rowsLeft) {
      if (!doubtful.has(call.callId)) lines.push(JSON.stringify([ANSWERED_TAG, call.callId]));
    }
  }
  if (lines.length > 0) file.append(`${lines.join('\n')}\n`);
  return outcome;
}

/**
 * The lines a command or a log says of a reconciliation: the calls under way
 * when the run stopped, what of their rows the target holds, and what it may
 * hold — for a resume, what it writes; for a removal, what it takes back.
 * None when no call was under way.
 */
export function inFlightLines(
  reconciled: InFlightReconciliation,
  org: string,
  before: 'resume' | 'removal' = 'resume',
): string[] {
  if (reconciled.calls === 0) return [];
  const each = (list: InFlightObjectRows[]): string =>
    list.map(({ objectApiName, rows }) => `${rows} ${objectApiName}`).join(', ');
  const lines = [
    `${reconciled.calls} insert or upsert call(s) were under way when the run stopped, their answer ` +
      `never kept: their rows were looked for in ${org}`,
  ];
  if (reconciled.found.length > 0) {
    lines.push(
      before === 'resume'
        ? `  found in ${org}, kept as written by the run and not written again: ${each(reconciled.found)}`
        : `  found in ${org}, kept as written by the run and removed with its records: ${each(reconciled.found)}`,
    );
  }
  if (reconciled.notFound.length > 0) {
    lines.push(
      before === 'resume'
        ? `  not in ${org}, written by the resume: ${each(reconciled.notFound)}`
        : `  not in ${org}, nothing of them to remove: ${each(reconciled.notFound)}`,
    );
  }
  if (reconciled.uncertain.length > 0) {
    lines.push(`  may already be in ${org}: ${each(reconciled.uncertain)}`);
  }
  for (const job of reconciled.underway ?? []) lines.push(`  ${underwayWords(job, before)}`);
  for (const { objectApiName, rows } of reconciled.untold ?? []) {
    lines.push(
      `  ${objectApiName}: ${rows} row(s) the journal cannot tell apart, several under one ` +
        'fingerprint, under which the Bulk API job wrote records: none of those records is ' +
        'linked to a row',
    );
  }
  if ((reconciled.unattributed ?? []).length > 0) {
    lines.push(
      `  written by a Bulk API job and matched to no row, kept as written by the run` +
        `${before === 'resume' ? '' : ' and removed with its records'}: ` +
        each(reconciled.unattributed ?? []),
    );
  }
  for (const { objectApiName, reason } of reconciled.unread) {
    lines.push(`  ${objectApiName} could not be read in ${org}: ${reason}`);
  }
  return lines;
}

/** Minutes, rounded up, of a span of milliseconds: what is said of the time left. */
function minutesOf(ms: number): number {
  return Math.max(1, Math.ceil(ms / 60_000));
}

/**
 * What a job the run had under way and the org has not ended is, said with
 * its id, its state and what it processed: one still open was never closed
 * by its sender, and closed would write its rows, until its hour of grace
 * ends and a read of it aborts it; one closed goes on to its end on the
 * org's side, and is read once it has ended.
 */
function underwayWords(job: InFlightJobUnderway, before: 'resume' | 'removal'): string {
  const head =
    `${job.objectApiName}: Bulk API job ${job.jobId} is ${job.state ?? 'not ended'}` +
    (job.processed !== undefined ? `, ${job.processed} row(s) processed` : '');
  if (job.state === 'Open') {
    const from =
      job.openUntil !== undefined
        ? ` from ${job.openUntil}` +
          (job.graceLeftMs !== undefined
            ? `, in about ${minutesOf(job.graceLeftMs)} minute(s),`
            : '')
        : ' an hour after it was opened';
    return (
      `${head}: the run stopped before it closed it, and closed, it would still write them; ` +
      `${before === 'resume' ? 'a resume' : 'a removal'}${from} aborts it if it is open still` +
      (before === 'resume' ? ', then writes its rows' : '')
    );
  }
  return (
    `${head}: the org writes it to its end whatever became of the run; ` +
    (before === 'resume'
      ? 'a resume once it has ended reads what it wrote'
      : 'a removal once it has ended takes what it wrote')
  );
}

/** The rows a reconciliation left uncertain, every object together. */
export function uncertainRows(reconciled: InFlightReconciliation): number {
  return reconciled.uncertain.reduce((sum, { rows }) => sum + rows, 0);
}

/**
 * Of the rows a reconciliation left uncertain, those whose records, if the
 * target holds them, the journal does not name: every row but those of a
 * Bulk API job that ended, every record of which it named as the run's
 * (`ofEndedJobs`). What a removal leaves behind, and says so.
 */
export function unnamedUncertainRows(reconciled: InFlightReconciliation): number {
  const named = (reconciled.ofEndedJobs ?? []).reduce((sum, { rows }) => sum + rows, 0);
  return Math.max(0, uncertainRows(reconciled) - named);
}
