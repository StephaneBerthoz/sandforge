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
 * Memory stays bounded as the journal's readers keep it: the journal is gone
 * through with the records it names held as hashed keys, a few bytes each and
 * no id, and the window is read a page at a time, keeping of each record its
 * id and its fingerprints.
 */

import type { Connection } from 'jsforce';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import {
  ANSWERED_TAG,
  FOUND_AFTER_STOP,
  FOUND_OWING_KEPT,
  hashA,
  hashB,
  journalLines,
  owedLine,
  SENT_TAG,
  type OwedAtInsert,
  type RunFile,
} from './ForgeRunStore.js';
import { HashedKeys } from './journalRecords.js';
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
  const text = fields.map((field) => `${field}\u0001${canonical(row[field])}`).join('\u0002');
  return hashA(text).toString(36).padStart(7, '0') + hashB(text).toString(36).padStart(7, '0');
}

/** A row of a call the journal says was sent. */
interface SentRow {
  sourceId: string;
  fingerprint: string;
  /** The lookups it went in without, owed to the second pass once it is in. */
  owes: OwedAtInsert[];
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
  const [, callId, objectApiName, at, fields, rows, owed] = value as unknown[];
  if (typeof callId !== 'string' || typeof objectApiName !== 'string') return undefined;
  if (!API_NAME.test(objectApiName) || typeof at !== 'string') return undefined;
  const sentAt = Date.parse(at);
  if (!Number.isFinite(sentAt) || !Array.isArray(fields) || !Array.isArray(rows)) return undefined;
  if (!fields.every((field) => typeof field === 'string' && API_NAME.test(field))) return undefined;
  const read: SentRow[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 2) return undefined;
    const [sourceId, fingerprint] = row as unknown[];
    if (typeof sourceId !== 'string' || !RECORD_ID.test(sourceId)) return undefined;
    if (typeof fingerprint !== 'string') return undefined;
    read.push({ sourceId, fingerprint, owes: [] });
  }
  const owesKept = owed !== undefined;
  if (owesKept && !readOwes(owed, read)) return undefined;
  return { callId, objectApiName, at: sentAt, fields: fields as string[], rows: read, owesKept };
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
  };
}

/** Rows of one object. */
export interface InFlightObjectRows {
  objectApiName: string;
  rows: number;
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
  /** Matched to a row. */
  taken: boolean;
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
  // The calls left open, and the journal's last time.
  const open = new Map<string, { offset: number; length: number }>();
  let last = Number.NEGATIVE_INFINITY;
  for (const line of journalLines(file)) {
    const answered = answeredCallOf(line.text);
    if (answered !== undefined) {
      open.delete(answered);
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
  for (const line of journalLines(file)) {
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
  for (const objectApiName of objects) {
    const ofObject = calls.filter((call) => call.objectApiName === objectApiName);
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
    const fields = [...new Set(ofObject.flatMap((call) => call.fields))].sort();
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
          candidates.push({ id, fingerprints, taken: false });
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

    // Each call's rows matched in turn, to the records left unmatched.
    const unmatched: Array<{ callId: string; sourceId: string }> = [];
    const doubtful = new Set<string>();
    for (const { call, rows } of rowsLeft) {
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
        // the order the org created them in. Each is kept as the call's
        // answer would have kept it: the record, and the lookups the row
        // went in without, owed to the second pass.
        held.forEach((candidate, index) => {
          candidate.taken = true;
          const row = same[index];
          lines.push(
            JSON.stringify([
              'c',
              row.sourceId,
              candidate.id,
              objectApiName,
              call.owesKept ? FOUND_OWING_KEPT : FOUND_AFTER_STOP,
            ]),
          );
          for (const { field, sourceRefId, insertOnly } of row.owes) {
            lines.push(
              owedLine({
                objectApiName,
                newId: candidate.id,
                sourceId: row.sourceId,
                fieldName: field,
                sourceRefId,
                ...(insertOnly ? { insertOnly } : {}),
              }),
            );
          }
          tally(outcome.found, objectApiName);
        });
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
    `${reconciled.calls} insert call(s) were under way when the run stopped, their answer ` +
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
  for (const { objectApiName, reason } of reconciled.unread) {
    lines.push(`  ${objectApiName} could not be read in ${org}: ${reason}`);
  }
  return lines;
}

/** The rows a reconciliation left uncertain, every object together. */
export function uncertainRows(reconciled: InFlightReconciliation): number {
  return reconciled.uncertain.reduce((sum, { rows }) => sum + rows, 0);
}
