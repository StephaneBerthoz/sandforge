/**
 * What drawing a sample of the whole org reads of the source, and how: the
 * statements, the ids they name, how a read too long for one statement is
 * cut, and the requests it all sends.
 *
 * A sample is drawn from ids and lookups alone (`forge/sample/`): the roots
 * of each object, the records they name and those under them. This reader
 * sends what that takes, and nothing the org refuses:
 *
 * - **Roots.** Each object's are counted first, `SELECT COUNT() FROM O WHERE
 *   <carriers> = null`, which prices their ids before one is read; then read,
 *   every id of them (`uniform`), or the newest first (`recent`) or the
 *   oldest (`oldest`), by the date each was made, paged after the date and id
 *   of the last row read — an offset past 2 000 is refused, and an object's
 *   ids do not follow the making of its records from one load to the next.
 *   A lookup that may name records of several objects (`WhatId`) is read
 *   with the ids and tested here, by the key prefix of what it names: tested
 *   in the statement, it would take a semi-join per object, and the org
 *   takes two at most. A `= null` that no index serves on a table of
 *   millions may run past the org's time (`QUERY_TIMEOUT`; none did on a
 *   scratch org of 74 000 rows): the object is then read without it, its
 *   lookups tested here, as many pages as the table.
 * - **Which roots.** A draw may hold the roots to a window of dates, made or
 *   last modified (`CreatedDate >= :from AND CreatedDate < :to`, instants to
 *   the second, as a scratch org compared them), and to a condition of the
 *   user's on an object's roots; and stratify them by a field, counted by
 *   its values, `SELECT F, COUNT(Id) n … GROUP BY F`, and read by date one
 *   value at a time, `AND F = :value`. These terms hold the reads of the
 *   roots alone: never the records they name or hold, which come whatever
 *   their date or values. A window on `LastModifiedDate` also holds
 *   `SystemModstamp`, which an index serves and which a scratch org stamped
 *   at or after it on every row of six objects; past the org's time, the
 *   date of the change is tested here instead, as a lookup's `= null` is.
 *   Restricted so, an object's roots are counted again without the window
 *   and the condition: its roots of the source, beside those of the draw.
 * - **Semi-joins.** A filter of the user's may hold one: a scratch org took
 *   an OR beside it, the page after a date and an id, as long as the
 *   semi-join stays a term of the statement's own AND, and refused one in
 *   parentheses an OR is part of. A condition that holds one and no OR of
 *   its own is written as the statement's own terms, never in parentheses
 *   beside others, a form no org was asked.
 * - **Records named.** By their ids, `Id IN (…)`, in lists as long as the
 *   URI and 500 ids allow, measured as the request goes on the wire, a
 *   select too wide for one statement read in column groups
 *   (`core/common/wideRead`). An id the source does not answer is said to be
 *   absent, or outside its object's filter when the read without it answers
 *   it.
 * - **Records under.** By their parents' ids. A list whose object holds no
 *   more than the cap times its parents is read at once, the newest of each
 *   parent kept; otherwise counted by parent first, `GROUP BY`, the parents
 *   under the cap read at once and each over it, its newest alone, `ORDER BY
 *   CreatedDate DESC, Id DESC LIMIT n`. The newest by the date each was made,
 *   as the roots of a draw by recency: a scratch org's ids interleaved loads
 *   hours apart, and none of its ten greatest contact ids was among its ten
 *   newest. An object with no creation date the org orders by keeps its
 *   greatest ids, in the order of their bytes, as a scratch org gave them,
 *   and the answer says so. An object the org will not count so (`COUNT(Id)`
 *   of feed items) is read at once. A lookup that may name several objects
 *   takes one list of mixed ids: a scratch org answered `WhatId IN` and
 *   `WhoId IN` of mixed prefixes, through `query` and `queryAll`, as the
 *   union of a list per prefix.
 *
 * Only the columns an object's describe lists are named: a field one org has
 * — `IsPersonAccount`, `CurrencyIsoCode` — is not asked of another, which
 * refuses the statement (`INVALID_FIELD`). Each object's filter holds every
 * read of it. Tasks and events are read through `queryAll`, the deleted ones
 * left out by the statement: an org archives an activity a year after it is
 * done, and `query` no longer answers it.
 *
 * Every request is counted as it is sent — a statement, each next page of
 * it, a count — whether the org answers or refuses it: the source's day is
 * spent by what is sent. Objects are read six at a time
 * (`CONCURRENT_DESCRIBE_LIMIT`), as discovery reads them.
 *
 * No value of a record is read but ids, lookups, and what the closure of a
 * sample asks to decide what it keeps: a record type, `IsPersonAccount`, a
 * price's book, product, currency, model and state, and the date a record
 * was made where the newest are kept; and, of the roots, the value of their
 * stratum, and the date of their last change where the org could not test it.
 */

import type {
  ForgeRunGateCode,
  ForgeSampleDraw,
  ForgeSampleWindow,
  ForgeSamplingProgress,
} from '@sandforge/shared';
import { extractErrorCode, extractErrorMessage } from '../../../core/common/extractErrorMessage.js';
import { assertSoqlIdentifier, sanitizeSoqlValue } from '../../../core/common/soqlValidator.js';
import {
  MAX_STATEMENT_URI_CHARS,
  columnGroups,
  firstColumns,
  idsPerStatement,
  pagesColumnsApart,
  readColumnsApart,
  uriLength,
} from '../../../core/common/wideRead.js';
import { ARCHIVED_ACTIVITIES } from '../../../core/removal/tableIds.js';
import { soqlInstant } from '../../checkpoint/orgStreams.js';
import { ForgeRunGateError } from '../ForgeRunGate.js';
import type { SourceRow } from '../stages/PagedRows.js';
import { eachInPool } from '../WholeOrgDiscovery.js';
import { compareIds, idKey } from './sampleRank.js';

/** How a statement is read: `all`, through the org's `queryAll`. */
export interface SampleReadOptions {
  all?: true;
}

/**
 * The source as the reads of a sample take it: the run's own reads of it
 * (`ForgeExecutorDeps.queryPages` and `countRecords`).
 */
export interface SampleSource {
  /**
   * Each page of `soql` as the org answers it, the next asked once the one
   * before is taken: one request a page, the first the statement itself.
   */
  pages(soql: string, options?: SampleReadOptions): AsyncIterable<SourceRow[]>;
  /** The rows a `SELECT COUNT() …` selects: one request. */
  count(soql: string, options?: SampleReadOptions): Promise<number>;
}

/** Rows a page of the org's cursor holds, and the most a statement with a `LIMIT` reads in one page. */
export const ROWS_PER_PAGE = 2_000;

/** Most ids one statement names: what an `Id IN` read by id names at most (`wideRead`). */
const IDS_PER_LIST = 500;

/** A record id, 15 or 18 letters and digits. */
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/**
 * The objects whose records are read by a cursor over the table, never by
 * their ids, when a run reads the plan ({@link runReadOf}): an activity the
 * org archived is read through `queryAll`, and whether `Id IN` under it
 * answers one is not known — the orgs it was asked of held none. Read by
 * ids, an archived task of the plan could come back as gone.
 */
export const READ_BY_CURSOR_ALONE: ReadonlySet<string> = ARCHIVED_ACTIVITIES;

// ─── What the reads are asked ────────────────────────────────────────────────

/**
 * A lookup of a drawn object whose record, when it names one, takes the row
 * out of the roots (a carrier).
 */
export interface RootCarrier {
  field: string;
  /**
   * Of a lookup that may name records of several objects (`WhatId`), the key
   * prefixes of the drawn ones among them: a value that starts with none of
   * them leaves the row a root. Absent, the lookup names a drawn object
   * alone, and any value takes the row out.
   */
  drawnPrefixes?: ReadonlySet<string>;
}

/**
 * A value of the field the roots of an object are stratified by: a
 * picklist's, a checkbox's, the id a lookup names (`RecordTypeId`,
 * `OwnerId`), or none — `null`, which the org counts as a group of its own.
 */
export type StratumValue = string | boolean | null;

/**
 * The dates the roots of an object are drawn in, the window's instants
 * resolved (a window of the last days turned into its `from` when the
 * sample is drawn): made, or last modified, from `from`, included, to before
 * `to`, each an instant in UTC to the second, either left out.
 */
export type RootWindow = Pick<ForgeSampleWindow, 'field' | 'from' | 'to'>;

/** The roots of one object to count or read. */
export interface RootRead {
  objectApiName: string;
  carriers: readonly RootCarrier[];
  /** The dates its roots are drawn in: a record outside them is no root of the draw. */
  window?: RootWindow;
  /**
   * The condition, without WHERE, its roots are drawn among
   * (`ForgeSampleOptions.rootWhere`): held by the reads of its roots alone,
   * never by those of the records they name or hold.
   */
  where?: string;
  /**
   * The field its roots are stratified by: counted by its values
   * (`RootCount.strata`), and each root handed on with its own.
   */
  stratifiedBy?: string;
}

/** How many roots of one value of a stratum a draw by date takes. */
export interface StratumTake {
  value: StratumValue;
  take: number;
}

/** The roots of one object to read by the date they were made, and how many it keeps. */
export interface DatedRootRead extends RootRead {
  /**
   * The roots it keeps; of an object stratified, those each value keeps,
   * each value read by its own statements, `AND <field> = <value>`.
   */
  take: number | readonly StratumTake[];
}

/**
 * The order the roots of one object were read in by date: by `created`, the
 * date each record was made, ties by id; or by `id` alone, where the object
 * has no creation date it orders by — which the plan says, as an object's
 * ids follow its records' making within a load, not from one to the next.
 */
export interface RecentDraw {
  objectApiName: string;
  by: 'created' | 'id';
}

/** What counting an object's roots said. */
export interface RootCount {
  objectApiName: string;
  /**
   * The rows the count selected: the roots, but for those a lookup that may
   * name several objects takes out (`exact` false), which only the read
   * tells; or, of a count that ran past the org's time, every row of the
   * object (`timedOut`).
   */
  rows: number;
  /** Whether `rows` is the roots themselves. */
  exact: boolean;
  /**
   * Set when the count with its `= null`, or its window of the last change,
   * ran past the org's time, and the object is read without them.
   */
  timedOut?: true;
  /**
   * Of an object stratified, its roots by value of the field, as the org
   * grouped them and in its order, each counted as `rows` is.
   */
  strata?: Array<{ value: StratumValue; rows: number }>;
  /**
   * Of an object whose roots a window or a condition restricts, its roots
   * without them, those of the source: `exact` as `rows` is, false where a
   * lookup is tested on the rows read or the count ran without its nulls.
   */
  inTheSource?: { rows: number; exact: boolean };
}

/** Records of one object to read by their ids. */
export interface ParentRead {
  objectApiName: string;
  ids: readonly string[];
  /** The columns besides the id; only those the describe lists are read. */
  columns: readonly string[];
}

/** What reading records by their ids answered. */
export interface ParentRows {
  objectApiName: string;
  rows: SourceRow[];
  /** The columns read: the id, then those asked that the describe lists. */
  columns: string[];
  /** Ids the source does not answer, filter or not. */
  absent: string[];
  /** The rows the source answers outside the object's filter, with the same columns. */
  outsideFilter: SourceRow[];
}

/** The records of one object under some parents, through one lookup. */
export interface ChildrenRead {
  objectApiName: string;
  /** The lookup that names the parent. */
  field: string;
  parentIds: readonly string[];
  /** The columns besides the id and the lookup; only those the describe lists are read. */
  columns: readonly string[];
  /** The newest children of each parent kept, by the date each was made, or `all` — a master-detail relation's. */
  cap: number | 'all';
  /**
   * The records the object holds, as discovery counted them: a list of
   * parents of no more than `cap` times as many is read at once.
   */
  sourceRows: number;
}

/** What reading records under some parents answered. */
export interface ChildrenRows {
  objectApiName: string;
  field: string;
  rows: SourceRow[];
  columns: string[];
  /** The children the cap left out, by parent. */
  cut: Array<{ parentId: string; rows: number }>;
  /**
   * Of each parent asked, by its id as asked, the children it holds under
   * the object's filter, those past the cap too: none for one that holds
   * none.
   */
  counts: Map<string, number>;
  /**
   * How the newest under the cap were told: by `created`, the date each was
   * made, which the rows then hold (`CreatedDate`), ties by id; or by `id`
   * alone, of an object with no creation date the org orders by — which the
   * plan says where the cap left some out.
   */
  newestBy: RecentDraw['by'];
}

/** Records of one object read whole. */
export interface WholeRead {
  objectApiName: string;
  columns: readonly string[];
}

/** What a reader needs besides the source. */
export interface SampleReaderOptions {
  /**
   * The fields an object's describe lists that may be read: no other is
   * named. Undefined for an object the run has no describe of, which is not
   * read.
   */
  fieldsOf(objectApiName: string): readonly string[] | undefined;
  /** An object's filter as the run holds it (`ForgeConfig.objectSoqlFilters`). */
  filterOf?(objectApiName: string): string | undefined;
  /**
   * Whether the org counts `objectApiName`'s records grouped by `field`, as
   * its describe says: its `Id` `aggregatable`, the field `groupable`.
   * Undefined when the describe does not say: the count is asked, and a
   * refusal taken for no. A scratch org refused `COUNT(Id)` of feed items.
   */
  countsBy?(objectApiName: string, field: string): boolean | undefined;
  /**
   * Whether the org orders `objectApiName` by `field`, as its describe says
   * (`sortable`). Undefined when it does not say: a field the describe lists
   * is taken to be.
   */
  sorts?(objectApiName: string, field: string): boolean | undefined;
  /** Told where the reading stands, as each object is counted and each page drawn. */
  onProgress?(progress: ForgeSamplingProgress): void;
  /** Stops the reads before their next request. */
  signal?: AbortSignal;
}

// ─── Statements ──────────────────────────────────────────────────────────────

/** ` WHERE a AND b`, or nothing for no term. */
function whereOf(terms: readonly string[]): string {
  return terms.length === 0 ? '' : ` WHERE ${terms.join(' AND ')}`;
}

/**
 * Characters `text` takes in the request as it goes on the wire: percent-
 * encoded as jsforce writes it, and each quote as `%27`, which node-fetch
 * writes in its place when it parses the URL again (WHATWG). Measured by
 * {@link uriLength} alone, an id in quotes is 26 characters; sent, it is 30:
 * a scratch org answered 18 658 characters of path and statement and refused
 * 18 676, of two objects alike, only so counted.
 */
function wireLength(text: string): number {
  return uriLength(text) + 2 * (text.match(/'/g)?.length ?? 0);
}

/**
 * `values` in the lists of statements that name them, `head` before each
 * list and `tail` after it: as many as {@link MAX_STATEMENT_URI_CHARS} holds,
 * measured on the wire ({@link wireLength}), and {@link IDS_PER_LIST} at
 * most. An id takes 30 characters with its quotes and the comma and space
 * after it, and a select list of a hundred and twenty lookups leaves room for
 * fewer than 500.
 */
function listsOf(head: string, values: readonly string[], tail: string): string[][] {
  const frame = wireLength(head) + wireLength(tail);
  const separator = wireLength(', ');
  const lists: string[][] = [];
  let list: string[] = [];
  let length = frame;
  for (const value of values) {
    const item = wireLength(`'${value}'`);
    if (
      list.length > 0 &&
      (length + separator + item > MAX_STATEMENT_URI_CHARS || list.length >= IDS_PER_LIST)
    ) {
      lists.push(list);
      list = [];
      length = frame;
    }
    length += (list.length > 0 ? separator : 0) + item;
    list.push(value);
  }
  if (list.length > 0) lists.push(list);
  return lists;
}

/** The ids of `ids` that are ids, each once by its key, in their order. */
function idsOnce(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const once: string[] = [];
  for (const id of ids) {
    if (!RECORD_ID.test(id)) continue;
    const key = idKey(id);
    if (seen.has(key)) continue;
    seen.add(key);
    once.push(id);
  }
  return once;
}

/** Whether the org answered a statement too late for it: `QUERY_TIMEOUT`. */
function ranPastItsTime(error: unknown): boolean {
  return extractErrorCode(extractErrorMessage(error)) === 'QUERY_TIMEOUT';
}

/**
 * Codes of an org that refused a statement for its shape, which another
 * statement reads instead: a lookup it will not group by, an order it will
 * not take.
 */
const SHAPE_REFUSALS: ReadonlySet<string> = new Set(['MALFORMED_QUERY', 'INVALID_FIELD']);

/** Whether the org refused a statement for its shape ({@link SHAPE_REFUSALS}). */
function refusedItsShape(error: unknown): boolean {
  const code = extractErrorCode(extractErrorMessage(error));
  return code !== undefined && SHAPE_REFUSALS.has(code);
}

/**
 * Codes of an org that refused the statement counting the roots of a draw
 * for what it says: a field its describe does not list or that it will not
 * group by, a condition it cannot read, more semi-joins than it takes. Words
 * of a condition of the user's, or of a field to stratify by, which only the
 * org tells: the draw is refused (`SAMPLE_DRAW_INVALID`) in them.
 */
const DRAW_REFUSALS: ReadonlySet<string> = new Set([
  'MALFORMED_QUERY',
  'INVALID_FIELD',
  'EXCEEDED_MAX_SEMIJOIN_SUBSELECTS',
]);

/** The code a draw the source cannot count is refused under. */
const SAMPLE_DRAW_INVALID = 'SAMPLE_DRAW_INVALID' satisfies ForgeRunGateCode;

/** What a draw is refused for: the condition of its roots, its stratum, or either. */
type DrawRefusedFor = 'where' | 'strata' | 'either';

/**
 * What the source's refusal of a count of the roots of `read` is for, read
 * from its words: a semi-join past the most, or a column of its condition it
 * does not hold, is the condition's; a field it will not group by, or one
 * its stratum names that it does not hold, the stratum's; either otherwise.
 * Said both ways out, a condition naming an unknown field drew "Stratify
 * Account by a field of few values…" beside its own.
 */
function refusedFor(read: RootRead, code: string, said: string): DrawRefusedFor {
  if (read.where === undefined) return 'strata';
  if (read.stratifiedBy === undefined) return 'where';
  if (code === 'EXCEEDED_MAX_SEMIJOIN_SUBSELECTS') return 'where';
  if (/can ?not be grouped/i.test(said)) return 'strata';
  const column = /No such column '([^']+)'/i.exec(said)?.[1]?.toLowerCase();
  if (column === undefined) return 'either';
  const named = (text: string): boolean => text.toLowerCase().split(/\W+/).includes(column);
  const inWhere = named(read.where);
  const inStratum = named(read.stratifiedBy);
  return inWhere === inStratum ? 'either' : inWhere ? 'where' : 'strata';
}

/** How the roots of one object are read: see `SampleSourceReader.rootShapeOf`. */
interface RootShape {
  object: string;
  /** The id, then the fields tested here, and the stratum's when its values are read. */
  select: string[];
  /**
   * The object's filter, the lookups held to `= null`, the window, the
   * condition of its roots, and the value of the stratum read.
   */
  terms: string[];
  /**
   * Whether a term may run past the org's time, which can be tested here
   * instead: a field held to `= null`, a window on the date of the last change.
   */
  held: boolean;
  /** Whether a term is tested here: a row read may be no root. */
  tested: boolean;
  isRoot: (row: SourceRow) => boolean;
}

/** What a shape of the roots of one object is asked for, beside the roots themselves. */
interface ShapeAsked {
  /** The roots of the source: without the window and the condition of the draw. */
  natural?: true;
  /** The roots of one value of the stratum alone. */
  stratum?: StratumTake;
  /** Each root read with the value of its stratum. */
  values?: true;
  /** Read as of an object whose nulls and changes run past the org's time, or not, whatever it was found to be. */
  slow?: boolean;
}

/** The field the newest records are found by: the date each was made, to the second. */
const CREATED = 'CreatedDate';

/** The date of a record's last change, which no index serves: a window on it may run past the org's time. */
const MODIFIED = 'LastModifiedDate';

/**
 * The stamp of a record's last change by anyone, the platform's own too,
 * which an index serves: a scratch org stamped it at or after
 * `LastModifiedDate` on every row of six objects, so a window from a date
 * holds it from the same date without leaving a row out.
 */
const STAMPED = 'SystemModstamp';

/** `text` with its quoted literals emptied: what is read for its words. */
function withoutLiterals(text: string): string {
  return text.replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

/** Whether a condition holds a semi-join, `IN (SELECT …)`. */
function holdsSemiJoin(condition: string): boolean {
  return /\(\s*SELECT\b/i.test(withoutLiterals(condition));
}

/** Whether a condition holds an OR of its own level, outside its parentheses and quotes. */
function orAtItsTop(condition: string): boolean {
  let depth = 0;
  let top = '';
  for (const char of withoutLiterals(condition)) {
    if (char === '(') depth++;
    top += depth === 0 ? char : ' ';
    if (char === ')') depth = Math.max(0, depth - 1);
  }
  return /\bOR\b/i.test(top);
}

/**
 * A condition of the user's — an object's filter, the condition of its
 * roots — as a term of a statement's AND: in parentheses, but for one that
 * holds a semi-join and no OR of its own, whose terms are written as the
 * statement's own. A scratch org took an OR beside a semi-join of the top
 * level and refused one in parentheses an OR is part of; one in parentheses
 * beside other terms of an AND was never asked of an org.
 */
function conditionTermOf(condition: string): string {
  const text = condition.trim();
  return holdsSemiJoin(text) && !orAtItsTop(text) ? text : `(${text})`;
}

/** Whether a value names no record: a lookup left empty. */
function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

/** The stratum a row's value puts it in: a text, a checkbox, or none. */
function stratumOf(value: unknown): StratumValue {
  if (isEmpty(value)) return null;
  return typeof value === 'boolean' ? value : String(value);
}

/** One key per value of a stratum, a text apart from a checkbox of the same words. */
function stratumKeyOf(value: StratumValue): string {
  return value === null ? '\u0000' : `${typeof value}:${String(value)}`;
}

/**
 * `field = value` as SOQL writes it: a text quoted and escaped, a checkbox
 * bare, none as `null` — which a scratch org took of its accounts of no
 * record type.
 */
function stratumTermOf(field: string, value: StratumValue): string {
  if (value === null) return `${field} = null`;
  if (typeof value === 'boolean') return `${field} = ${String(value)}`;
  return `${field} = '${sanitizeSoqlValue(value)}'`;
}

/** `text` as a sentence of a message: ended by one full stop, the org's own or one added. */
function sentenceOf(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Whether a date a row was read with stands in `window`: from its `from`, included, to before its `to`. */
function inWindow(value: unknown, window: RootWindow): boolean {
  const at = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(at)) return false;
  if (window.from !== undefined && at < Date.parse(window.from)) return false;
  return window.to === undefined || at < Date.parse(window.to);
}

// ─── The reader ──────────────────────────────────────────────────────────────

/**
 * The reads of a sample against one source, counted: see the module's
 * comment.
 */
export class SampleSourceReader {
  private sent = 0;
  private rowsRead = 0;
  /** Objects whose `= null` ran past the org's time: read without it from then on. */
  private readonly slow = new Set<string>();
  /** Objects whose children the org would not count by parent: read at once from then on. */
  private readonly ungrouped = new Set<string>();
  /** The roots counted of each object: one counted none is not read. */
  private readonly counted = new Map<string, number>();
  /** The roots counted of each value of an object's stratum, by its key: a value counted none is not read. */
  private readonly countedStrata = new Map<string, Map<string, number>>();
  /** The id of the standard price book, once read; null when the source has none. */
  private standardBook?: string | null;

  constructor(
    private readonly source: SampleSource,
    private readonly options: SampleReaderOptions,
  ) {}

  /**
   * Requests sent so far — each statement, each next page of one, each count
   * —, each counted once its answer or its refusal is back.
   */
  get requests(): number {
    return this.sent;
  }

  // ─── Requests ──────────────────────────────────────────────────────────────

  /**
   * Each page of `soql`, a request counted as each is asked: the statement,
   * then each next page. One the org refuses, or never answers, was sent all
   * the same, and counted.
   */
  private async *pages(soql: string, options?: SampleReadOptions): AsyncGenerator<SourceRow[]> {
    this.options.signal?.throwIfAborted();
    let answered = 0;
    try {
      for await (const page of this.source.pages(soql, options)) {
        answered++;
        this.sent++;
        this.rowsRead += page.length;
        yield page;
      }
    } catch (error) {
      this.sent++;
      throw error;
    }
    // A source that answers a statement of no row with no page sent it all the same.
    if (answered === 0) this.sent++;
  }

  /** Every row of `soql`, its pages gathered. */
  private async gather(soql: string, options?: SampleReadOptions): Promise<SourceRow[]> {
    const rows: SourceRow[] = [];
    for await (const page of this.pages(soql, options)) for (const row of page) rows.push(row);
    return rows;
  }

  /** What `soql` counts: one request. */
  private async count(soql: string, options?: SampleReadOptions): Promise<number> {
    this.options.signal?.throwIfAborted();
    try {
      return await this.source.count(soql, options);
    } finally {
      this.sent++;
    }
  }

  private progress(
    step: ForgeSamplingProgress['step'],
    extra: Partial<ForgeSamplingProgress>,
  ): void {
    this.options.onProgress?.({ step, rows: this.rowsRead, requests: this.sent, ...extra });
  }

  // ─── Objects ───────────────────────────────────────────────────────────────

  /**
   * The columns read of `objectApiName`: the id, then each of `asked` once
   * that its describe lists. A field one org has and another has not —
   * `IsPersonAccount`, `CurrencyIsoCode`, `ProductSellingModelId` — is left
   * out where the describe does not list it: named, the statement is refused
   * whole (`INVALID_FIELD`).
   *
   * @throws When the run has no describe of the object.
   */
  private columnsOf(objectApiName: string, asked: readonly string[]): string[] {
    const listed = this.options.fieldsOf(objectApiName);
    if (listed === undefined) {
      throw new Error(`No describe of ${objectApiName}: its records cannot be read for a sample.`);
    }
    const known = new Set(listed.map((field) => field.toLowerCase()));
    const columns = ['Id'];
    const named = new Set(['id']);
    for (const column of asked) {
      const key = column.toLowerCase();
      if (named.has(key) || !known.has(key)) continue;
      named.add(key);
      columns.push(assertSoqlIdentifier(column));
    }
    return columns;
  }

  /** How `objectApiName` is read: through `queryAll` for an activity an org archives. */
  private readOptionsOf(objectApiName: string): SampleReadOptions | undefined {
    return ARCHIVED_ACTIVITIES.has(objectApiName) ? { all: true } : undefined;
  }

  /**
   * The terms every read of `objectApiName` holds: its filter, and, read
   * through `queryAll`, `IsDeleted = false` — as the run's own reads hold
   * them (`ForgeExecutor.filterOf`). The filter is the user's own WHERE,
   * held at the config's schema; it may hold a semi-join, written as a term
   * of the statement's own AND ({@link conditionTermOf}).
   */
  private termsOf(objectApiName: string): string[] {
    const filter = this.options.filterOf?.(objectApiName);
    return [
      ...(filter !== undefined && filter.trim() !== '' ? [conditionTermOf(filter)] : []),
      ...(ARCHIVED_ACTIVITIES.has(objectApiName) ? ['IsDeleted = false'] : []),
    ];
  }

  /** Whether the describe of `objectApiName` lists `field`. */
  private lists(objectApiName: string, field: string): boolean {
    const wanted = field.toLowerCase();
    return (this.options.fieldsOf(objectApiName) ?? []).some(
      (name) => name.toLowerCase() === wanted,
    );
  }

  /**
   * `field` of `objectApiName`, which a read cannot do without: a lookup the
   * roots are held by, or the one children are read through.
   *
   * @throws When the object's describe does not list it.
   */
  private fieldOf(objectApiName: string, field: string): string {
    const listed = this.options.fieldsOf(objectApiName) ?? [];
    const named = listed.find((name) => name.toLowerCase() === field.toLowerCase());
    if (named === undefined) {
      throw new Error(`${objectApiName}.${field} is no field of the source's describe.`);
    }
    return assertSoqlIdentifier(field);
  }

  // ─── Roots ─────────────────────────────────────────────────────────────────

  /**
   * How `read`'s roots are read, in this order of terms: the object's
   * filter; the lookups held to `= null` — those that name a drawn object
   * alone —; the window, `W >= :from AND W < :to`, and, on the date of the
   * last change, `SystemModstamp >= :from` where the describe lists it; the
   * condition of its roots; the value of its stratum asked. Tested here, on
   * the rows read: the lookups that may name several objects, and, of an
   * object whose terms ran past the org's time, every `= null` and the
   * window on the date of the last change. Of its roots in the source
   * (`natural`), the window and the condition are left out.
   */
  private rootShapeOf(read: RootRead, asked: ShapeAsked = {}): RootShape {
    const object = assertSoqlIdentifier(read.objectApiName);
    const slow = asked.slow ?? this.slow.has(object);
    const carriers = read.carriers.map((carrier) => ({
      field: this.fieldOf(object, carrier.field),
      prefixes: carrier.drawnPrefixes === undefined ? undefined : [...carrier.drawnPrefixes],
    }));
    const held = slow ? [] : carriers.filter((carrier) => carrier.prefixes === undefined);
    const tested = carriers.filter((carrier) => !held.includes(carrier));
    const names = (value: unknown, prefixes: string[] | undefined): boolean =>
      !isEmpty(value) &&
      (prefixes === undefined || prefixes.some((prefix) => String(value).startsWith(prefix)));

    const window = asked.natural ? undefined : read.window;
    const windowField = window ? this.fieldOf(object, window.field) : undefined;
    const modified = window?.field === MODIFIED;
    // The date of the last change, which no index serves, tested here once it ran past the org's time.
    const windowHere = window !== undefined && modified && slow;
    const windowTerms =
      window && windowField && !windowHere
        ? [
            ...(window.from !== undefined ? [`${windowField} >= ${soqlInstant(window.from)}`] : []),
            ...(window.to !== undefined ? [`${windowField} < ${soqlInstant(window.to)}`] : []),
            ...(modified && window.from !== undefined && this.lists(object, STAMPED)
              ? [`${STAMPED} >= ${soqlInstant(window.from)}`]
              : []),
          ]
        : [];
    const where = asked.natural || read.where?.trim() === '' ? undefined : read.where;

    const stratumField =
      read.stratifiedBy !== undefined && (asked.stratum !== undefined || asked.values)
        ? this.fieldOf(object, read.stratifiedBy)
        : undefined;
    // None of a stratum is a field held to `= null`: tested here too, past the org's time.
    const none = asked.stratum?.value === null;
    const stratumTerms =
      asked.stratum !== undefined && stratumField !== undefined && !(none && slow)
        ? [stratumTermOf(stratumField, asked.stratum.value)]
        : [];

    const checks: Array<(row: SourceRow) => boolean> = [];
    if (windowHere && window && windowField) {
      checks.push((row) => inWindow(row[windowField], window));
    }
    if (none && slow && stratumField !== undefined) {
      checks.push((row) => stratumOf(row[stratumField]) === null);
    }
    return {
      object,
      select: this.columnsOf(object, [
        ...tested.map((carrier) => carrier.field),
        ...(windowHere && windowField ? [windowField] : []),
        ...(stratumField !== undefined && (asked.values || (none && slow)) ? [stratumField] : []),
      ]),
      terms: [
        ...this.termsOf(object),
        ...held.map((carrier) => `${carrier.field} = null`),
        ...windowTerms,
        ...(where !== undefined ? [conditionTermOf(where)] : []),
        ...stratumTerms,
      ],
      held:
        held.length > 0 ||
        (modified && windowTerms.length > 0) ||
        (none && stratumTerms.length > 0),
      tested: tested.length > 0 || checks.length > 0,
      isRoot: (row) =>
        !tested.some((carrier) => names(row[carrier.field], carrier.prefixes)) &&
        checks.every((check) => check(row)),
    };
  }

  /**
   * Count the roots of each object, six objects at a time: what prices the
   * read of their ids before one is read. A count whose `= null`, or whose
   * window on the date of the last change, runs past the org's time is made
   * again without them — every row of the object, or of the window's other
   * terms — and the object read without them from then on. An object
   * stratified is counted by the values of its field; one restricted by a
   * window or a condition is counted again without them, a request more.
   *
   * @throws `SAMPLE_DRAW_INVALID` when the org refuses the count of a draw
   *   restricted or stratified in its own words — a condition it cannot
   *   read, a field it will not group by —, or its field has more values
   *   than one answer holds.
   */
  async countRoots(reads: readonly RootRead[]): Promise<RootCount[]> {
    const counts: RootCount[] = new Array<RootCount>(reads.length);
    let done = 0;
    await eachInPool(reads, async (read, index) => {
      const count = await this.countRootsOf(read);
      counts[index] = count;
      this.counted.set(read.objectApiName, count.rows);
      if (count.strata) {
        this.countedStrata.set(
          read.objectApiName,
          new Map(count.strata.map((stratum) => [stratumKeyOf(stratum.value), stratum.rows])),
        );
      }
      done++;
      this.progress('counting', { objectApiName: read.objectApiName, done, total: reads.length });
    });
    return counts;
  }

  private async countRootsOf(read: RootRead): Promise<RootCount> {
    const objectApiName = read.objectApiName;
    const options = this.readOptionsOf(objectApiName);
    if (read.stratifiedBy !== undefined) this.refuseUngroupedStratum(read, read.stratifiedBy);
    let timedOut = false;
    for (;;) {
      const shape = this.rootShapeOf(read);
      let drawn: { rows: number; strata?: Array<{ value: StratumValue; rows: number }> };
      try {
        drawn =
          read.stratifiedBy === undefined
            ? {
                rows: await this.count(
                  `SELECT COUNT() FROM ${shape.object}${whereOf(shape.terms)}`,
                  options,
                ),
              }
            : await this.countByStratum(read, read.stratifiedBy, shape, options);
      } catch (error) {
        if (timedOut || !shape.held || !ranPastItsTime(error)) {
          throw this.drawRefusalOf(read, error);
        }
        timedOut = true;
        this.slow.add(objectApiName);
        continue;
      }
      const inTheSource = this.restricts(read)
        ? await this.countInTheSource(read, {
            terms: shape.terms,
            rows: drawn.rows,
            exact: !shape.tested,
          })
        : undefined;
      return {
        objectApiName,
        rows: drawn.rows,
        exact: !shape.tested,
        ...(timedOut ? { timedOut: true as const } : {}),
        ...(drawn.strata ? { strata: drawn.strata } : {}),
        ...(inTheSource ? { inTheSource } : {}),
      };
    }
  }

  /** Whether a window or a condition restricts the roots of `read`: its roots of the source are then counted apart. */
  private restricts(read: RootRead): boolean {
    return read.window !== undefined || (read.where !== undefined && read.where.trim() !== '');
  }

  /**
   * The roots of `read` in the source, its window and condition left out: a
   * count of its own, which runs past the org's time apart from the draw's —
   * made again without its nulls, the draw's reads unchanged. None is sent
   * when the draw's count held the same terms — a window on the date of the
   * last change tested here, and no condition —: its rows are the source's.
   */
  private async countInTheSource(
    read: RootRead,
    drawn: { terms: readonly string[]; rows: number; exact: boolean },
  ): Promise<RootCount['inTheSource']> {
    const options = this.readOptionsOf(read.objectApiName);
    let slow = this.slow.has(read.objectApiName);
    for (;;) {
      const shape = this.rootShapeOf(read, { natural: true, slow });
      if (shape.terms.join('\n') === drawn.terms.join('\n')) {
        return { rows: drawn.rows, exact: drawn.exact };
      }
      try {
        const rows = await this.count(
          `SELECT COUNT() FROM ${shape.object}${whereOf(shape.terms)}`,
          options,
        );
        return { rows, exact: !shape.tested };
      } catch (error) {
        if (slow || !shape.held || !ranPastItsTime(error)) throw error;
        slow = true;
      }
    }
  }

  /**
   * The roots of `read` by the values of `field`, `SELECT F, COUNT(Id) n …
   * GROUP BY F`, a group of none among them: the first answer alone. An
   * answer that holds {@link ROWS_PER_PAGE} values or more, or has a next
   * page, is refused rather than cut: an aggregate is not paged on (a next
   * page asked is refused), and a stratum left out would draw no root of it.
   */
  private async countByStratum(
    read: RootRead,
    field: string,
    shape: RootShape,
    options: SampleReadOptions | undefined,
  ): Promise<{ rows: number; strata: Array<{ value: StratumValue; rows: number }> }> {
    const by = this.fieldOf(shape.object, field);
    const soql = `SELECT ${by}, COUNT(Id) n FROM ${shape.object}${whereOf(shape.terms)} GROUP BY ${by}`;
    const rows: SourceRow[] = [];
    let pages = 0;
    try {
      for await (const page of this.pages(soql, options)) {
        pages++;
        if (pages > 1) break;
        for (const row of page) rows.push(row);
      }
    } catch (error) {
      if (pages === 0) throw error;
      // Its next page refused: an aggregate of more than one answer.
      pages = 2;
    }
    if (pages > 1 || rows.length >= ROWS_PER_PAGE) {
      throw this.drawRefused(
        read,
        'strata',
        `${read.objectApiName}.${field} has too many values among the roots of the draw to ` +
          `stratify them: the source counts them in one answer of fewer than ${ROWS_PER_PAGE}, ` +
          `and this one ${pages > 1 ? 'had more after it' : `held ${rows.length}`}.`,
      );
    }
    const strata: Array<{ value: StratumValue; rows: number }> = [];
    for (const row of rows) {
      const n = Number(row['n']);
      if (Number.isFinite(n)) strata.push({ value: stratumOf(row[by]), rows: n });
    }
    return { rows: strata.reduce((sum, stratum) => sum + stratum.rows, 0), strata };
  }

  /**
   * Refuse, before a request, a stratum the describe says the source does
   * not count by (`countsBy`): its id not `aggregatable`, the field not
   * `groupable`.
   */
  private refuseUngroupedStratum(read: RootRead, field: string): void {
    if (this.options.countsBy?.(read.objectApiName, field) !== false) return;
    throw this.drawRefused(
      read,
      'strata',
      `The source's describe says the records of ${read.objectApiName} are not counted by ` +
        `${field}.`,
    );
  }

  /**
   * The refusal of a draw the source would not count, in its own words —
   * `error` as the org gave it —, or `error` itself: a refusal of a count of
   * roots neither restricted nor stratified, or a failure of another kind.
   */
  private drawRefusalOf(read: RootRead, error: unknown): unknown {
    const said = extractErrorMessage(error);
    const code = extractErrorCode(said);
    if (code === undefined || !DRAW_REFUSALS.has(code)) return error;
    if (!this.restricts(read) && read.stratifiedBy === undefined) return error;
    return this.drawRefused(
      read,
      refusedFor(read, code, said),
      `The source refused to count the roots of ${read.objectApiName} in the draw: ${said}`,
    );
  }

  /**
   * A draw refused before a root is read (`SAMPLE_DRAW_INVALID`): `reason`,
   * what the counts sent, and the ways out of what refused it — the condition
   * of its roots, its stratum, or either when the source's words name
   * neither.
   */
  private drawRefused(read: RootRead, about: DrawRefusedFor, reason: string): ForgeRunGateError {
    const object = read.objectApiName;
    const ways: string[] = [];
    if (read.where !== undefined && about !== 'strata') {
      ways.push(
        `The source reads the condition of its roots (--fit-where ${object}=…) as it is ` +
          'written: its fields are those of the object, and with the filter it holds two ' +
          'semi-joins at most, none in parentheses an OR is part of.',
      );
    }
    if (read.stratifiedBy !== undefined && about !== 'where') {
      ways.push(
        `Stratify ${object} by a field of few values the source groups by — a picklist, a ` +
          `checkbox, a record type or an owner (--fit-strata ${object}.<Field>) —, or narrow ` +
          `its roots first (--fit-where ${object}=…).`,
      );
    }
    return new ForgeRunGateError(
      SAMPLE_DRAW_INVALID,
      [
        sentenceOf(reason),
        `Nothing was written, and the counts sent ${this.sent} request(s) of the source.`,
        ...ways,
      ].join(' '),
      undefined,
      undefined,
      undefined,
      { sample: { requests: this.sent } },
    );
  }

  /**
   * Read every root id of each object, six objects at a time, and hand each
   * page's roots to `onRoots` as it comes: no more than a page of each is
   * held. An object counted to hold none is not read. Of an object
   * stratified, each root is read with the value of its field, and a page's
   * roots handed on by value, the value third: `null` for those of none,
   * never left out as it is of an object not stratified.
   */
  async drawUniform(
    reads: readonly RootRead[],
    onRoots: (objectApiName: string, ids: string[], stratum?: StratumValue) => void | Promise<void>,
  ): Promise<void> {
    let done = 0;
    await eachInPool(reads, async (read) => {
      if (this.counted.get(read.objectApiName) !== 0) await this.scanRoots(read, onRoots);
      done++;
      this.progress('drawing', { objectApiName: read.objectApiName, done, total: reads.length });
    });
  }

  /**
   * Every root of one object, a page at a time. A read whose terms run past
   * the org's time before its first page is read again without them; past
   * its first page, it has handed roots on, and fails rather than hand them
   * twice.
   */
  private async scanRoots(
    read: RootRead,
    onRoots: (objectApiName: string, ids: string[], stratum?: StratumValue) => void | Promise<void>,
  ): Promise<void> {
    const options = this.readOptionsOf(read.objectApiName);
    const field = read.stratifiedBy;
    for (;;) {
      const shape = this.rootShapeOf(read, field === undefined ? {} : { values: true });
      const soql = `SELECT ${shape.select.join(', ')} FROM ${shape.object}${whereOf(shape.terms)}`;
      let answered = false;
      try {
        for await (const page of this.pages(soql, options)) {
          answered = true;
          const roots = page.filter(shape.isRoot);
          if (field === undefined) {
            const ids = roots.map((row) => String(row['Id']));
            if (ids.length > 0) await onRoots(read.objectApiName, ids);
            continue;
          }
          for (const { value, ids } of byStratum(roots, field)) {
            await onRoots(read.objectApiName, ids, value);
          }
        }
        return;
      } catch (error) {
        if (answered || !shape.held || !ranPastItsTime(error)) throw error;
        this.slow.add(read.objectApiName);
      }
    }
  }

  /**
   * Read the roots of each object by the date each was made, the newest
   * first (`recent`) or the oldest (`oldest`), as many as each `take`s, six
   * objects at a time, and hand them to `onRoots` in that order: `ORDER BY
   * CreatedDate DESC, Id DESC` or `ASC, Id ASC`, statements of up to
   * {@link ROWS_PER_PAGE} rows, each after the date and id of the last row
   * the one before read — never by an offset, which the org refuses past
   * 2 000. Not by their ids alone: an object's ids follow the making of its
   * records within a load, not from one load to the next, and a scratch org
   * had none of its ten newest contacts among the ten greatest ids. An
   * object with no creation date it orders by is read by its ids, and the
   * answer says so. What is read is what is kept, but for the rows a term
   * tested here takes out. Of an object stratified, each value is read by
   * statements of its own, `AND <field> = <value>`, as many as it takes, and
   * its roots handed on with it; a value counted to hold none is not read.
   */
  async drawByDate(
    reads: readonly DatedRootRead[],
    draw: Exclude<ForgeSampleDraw, 'uniform'>,
    onRoots: (objectApiName: string, ids: string[], stratum?: StratumValue) => void | Promise<void>,
  ): Promise<RecentDraw[]> {
    const drawn = reads.map((read) => ({
      objectApiName: read.objectApiName,
      by: this.orderedBy(read.objectApiName),
    }));
    let done = 0;
    await eachInPool(reads, async (read, index) => {
      const object = read.objectApiName;
      if (this.counted.get(object) !== 0) {
        const by = drawn[index].by;
        if (typeof read.take === 'number') {
          if (read.take > 0) await this.rootsByDate(read, draw, by, read.take, undefined, onRoots);
        } else {
          const counted = this.countedStrata.get(object);
          for (const stratum of read.take) {
            if (stratum.take <= 0 || counted?.get(stratumKeyOf(stratum.value)) === 0) continue;
            await this.rootsByDate(read, draw, by, stratum.take, stratum, onRoots);
          }
        }
      }
      done++;
      this.progress('drawing', { objectApiName: object, done, total: reads.length });
    });
    return drawn;
  }

  /**
   * How the records of `objectApiName` are told apart by date: by the date
   * each was made, when its describe lists one the org orders by; by its ids
   * otherwise.
   */
  private orderedBy(objectApiName: string): RecentDraw['by'] {
    return this.lists(objectApiName, CREATED) &&
      this.options.sorts?.(objectApiName, CREATED) !== false
      ? 'created'
      : 'id';
  }

  /**
   * The `take` roots of one object, or of one value of its stratum, by date.
   * Past a page, the next statement starts after the last row read: `(d <
   * :d OR (d = :d AND Id < :id))` of the newest, `>` of the oldest, rows made
   * in the same second ordered by their ids. The OR is a term of the
   * statement's AND, beside the semi-joins a filter or a condition holds: a
   * scratch org took it so, and read the same rows as one sorted here.
   */
  private async rootsByDate(
    read: RootRead,
    draw: Exclude<ForgeSampleDraw, 'uniform'>,
    by: RecentDraw['by'],
    take: number,
    stratum: StratumTake | undefined,
    onRoots: (objectApiName: string, ids: string[], stratum?: StratumValue) => void | Promise<void>,
  ): Promise<void> {
    const object = read.objectApiName;
    const options = this.readOptionsOf(object);
    let given = 0;
    let last: { at: string; id: string } | undefined;
    while (given < take) {
      const shape = this.rootShapeOf(read, stratum === undefined ? {} : { stratum });
      // Every row a root but where a term is tested here: a statement of a page then.
      const limit = shape.tested ? ROWS_PER_PAGE : Math.min(ROWS_PER_PAGE, take - given);
      const select =
        by === 'created' ? this.columnsOf(object, [...shape.select, CREATED]) : shape.select;
      const { after, order } = afterTheLast(by, draw, last);
      const soql =
        `SELECT ${select.join(', ')} FROM ${shape.object}${whereOf([...shape.terms, ...after])}` +
        ` ORDER BY ${order} LIMIT ${limit}`;
      let rows: SourceRow[];
      try {
        rows = await this.gather(soql, options);
      } catch (error) {
        if (!shape.held || !ranPastItsTime(error)) throw error;
        this.slow.add(object);
        continue;
      }
      const ids = rows
        .filter(shape.isRoot)
        .map((row) => String(row['Id']))
        .slice(0, take - given);
      given += ids.length;
      if (ids.length > 0) {
        await (stratum === undefined ? onRoots(object, ids) : onRoots(object, ids, stratum.value));
      }
      if (rows.length < limit) return;
      last = lastRowOf(object, rows[rows.length - 1], by);
    }
  }

  // ─── Records named ─────────────────────────────────────────────────────────

  /**
   * Read records by their ids, six objects at a time: each object's in lists
   * of as many ids as a statement holds, the columns asked that its describe
   * lists. An id not answered is read again without the object's filter,
   * when it has one, to tell one outside it from one the source does not
   * hold.
   */
  async readParents(reads: readonly ParentRead[]): Promise<ParentRows[]> {
    const answers: ParentRows[] = new Array<ParentRows>(reads.length);
    await eachInPool(reads, async (read, index) => {
      answers[index] = await this.parentsOf(read);
    });
    return answers;
  }

  private async parentsOf(read: ParentRead): Promise<ParentRows> {
    const object = assertSoqlIdentifier(read.objectApiName);
    const columns = this.columnsOf(object, read.columns);
    const ids = idsOnce(read.ids);
    const options = this.readOptionsOf(object);
    const rows = await this.byList(object, columns, 'Id', ids, this.termsOf(object), options);
    const found = new Set(rows.map((row) => idKey(String(row['Id']))));
    const missing = ids.filter((id) => !found.has(idKey(id)));
    const filter = this.options.filterOf?.(object);
    let outside: SourceRow[] = [];
    if (missing.length > 0 && filter !== undefined && filter.trim() !== '') {
      const live = ARCHIVED_ACTIVITIES.has(object) ? ['IsDeleted = false'] : [];
      outside = await this.byList(object, columns, 'Id', missing, live, options);
    }
    const answered = new Set(outside.map((row) => idKey(String(row['Id']))));
    return {
      objectApiName: read.objectApiName,
      rows,
      columns,
      absent: missing.filter((id) => !answered.has(idKey(id))),
      outsideFilter: outside,
    };
  }

  /**
   * The standard prices of `productIds`, in the source's standard price
   * book, the columns asked that the describe lists: the price a custom one
   * cannot be written without. None when the source has no standard book.
   * The book is read once, by `IsStandard`, never by its name, which an org
   * translates.
   */
  async readStandardPrices(
    productIds: readonly string[],
    columns: readonly string[],
  ): Promise<SourceRow[]> {
    const ids = idsOnce(productIds);
    if (ids.length === 0) return [];
    if (this.standardBook === undefined) {
      const [book] = await this.gather('SELECT Id FROM Pricebook2 WHERE IsStandard = true');
      const id = book?.['Id'];
      this.standardBook = typeof id === 'string' && RECORD_ID.test(id) ? id : null;
    }
    if (this.standardBook === null) return [];
    const select = this.columnsOf('PricebookEntry', ['Product2Id', ...columns]);
    const terms = [...this.termsOf('PricebookEntry'), `Pricebook2Id = '${this.standardBook}'`];
    return this.byList('PricebookEntry', select, 'Product2Id', ids, terms, undefined);
  }

  /**
   * The prices of `productIds` in the books `bookIds` and the currency
   * `currency`, the columns asked that the describe lists: the price a price
   * in a currency the target does not hold goes as, the run writing the
   * source's own of the same product and book in the currency it writes it
   * in. None for a code that is not one.
   */
  async readPricesIn(
    currency: string,
    productIds: readonly string[],
    bookIds: readonly string[],
    columns: readonly string[],
  ): Promise<SourceRow[]> {
    if (!/^[A-Z]{3}$/.test(currency)) return [];
    const products = idsOnce(productIds);
    const books = idsOnce(bookIds);
    if (products.length === 0 || books.length === 0) return [];
    const select = this.columnsOf('PricebookEntry', ['Product2Id', 'Pricebook2Id', ...columns]);
    const terms = [
      ...this.termsOf('PricebookEntry'),
      `Pricebook2Id IN (${books.map((id) => `'${id}'`).join(', ')})`,
      `CurrencyIsoCode = '${currency}'`,
    ];
    return this.byList('PricebookEntry', select, 'Product2Id', products, terms, undefined);
  }

  /**
   * The rows whose `field` names one of `values`, in lists the URI holds
   * with the first group of `columns`, a select too wide for one statement
   * read in column groups.
   */
  private async byList(
    object: string,
    columns: readonly string[],
    field: string,
    values: readonly string[],
    terms: readonly string[],
    options: SampleReadOptions | undefined,
  ): Promise<SourceRow[]> {
    const where = [...terms, `${field} IN (`].join(' AND ');
    const head = `SELECT ${firstColumns(columns).join(', ')} FROM ${object} WHERE ${where}`;
    const rows: SourceRow[] = [];
    for (const list of listsOf(head, values, ')')) {
      const statement =
        `SELECT ${columns.join(', ')} FROM ${object} WHERE ${where}` +
        `${list.map((value) => `'${value}'`).join(', ')})`;
      for (const row of await readColumnsApart(statement, (soql) => this.gather(soql, options))) {
        rows.push(row);
      }
    }
    return rows;
  }

  // ─── Records under ─────────────────────────────────────────────────────────

  /**
   * Read the records under some parents through a lookup, six reads at a
   * time, the newest `cap` of each parent kept: see the module's comment.
   */
  async readChildren(reads: readonly ChildrenRead[]): Promise<ChildrenRows[]> {
    const answers: ChildrenRows[] = new Array<ChildrenRows>(reads.length);
    await eachInPool(reads, async (read, index) => {
      answers[index] = await this.childrenOf(read);
    });
    return answers;
  }

  private async childrenOf(read: ChildrenRead): Promise<ChildrenRows> {
    const object = assertSoqlIdentifier(read.objectApiName);
    const field = this.fieldOf(object, read.field);
    const cap = read.cap;
    // Under a cap, the newest are kept by the date each was made, read with them.
    const by = this.orderedBy(object);
    const dated = cap !== 'all' && by === 'created';
    const columns = this.columnsOf(object, [field, ...read.columns, ...(dated ? [CREATED] : [])]);
    const parents = idsOnce(read.parentIds);
    const options = this.readOptionsOf(object);
    const terms = this.termsOf(object);
    const counted = new Map<string, number>();
    const answer: ChildrenRows = {
      objectApiName: object,
      field,
      rows: [],
      columns,
      cut: [],
      counts: new Map(),
      newestBy: by,
    };
    const done = (): ChildrenRows => {
      for (const parent of parents) answer.counts.set(parent, counted.get(idKey(parent)) ?? 0);
      return answer;
    };
    if (parents.length === 0) return answer;
    if (cap === 'all') {
      const all = newestOf(
        await this.byList(object, columns, field, parents, terms, options),
        field,
        Infinity,
        by,
      );
      answer.rows = all.rows;
      for (const [key, n] of all.counts) counted.set(key, n);
      return done();
    }
    const where = [...terms, `${field} IN (`].join(' AND ');
    const grouping = {
      head: `SELECT ${field}, COUNT(Id) n FROM ${object} WHERE ${where}`,
      tail: `) GROUP BY ${field}`,
    };
    const listing = {
      head: `SELECT ${firstColumns(columns).join(', ')} FROM ${object} WHERE ${where}`,
      tail: ')',
    };
    // Lists as long as both of their statements hold.
    const longer =
      wireLength(grouping.head + grouping.tail) > wireLength(listing.head + listing.tail)
        ? grouping
        : listing;
    const atOnce: string[] = [];
    const hubs: Array<{ parentId: string; rows: number }> = [];
    for (const list of listsOf(longer.head, parents, longer.tail)) {
      const byParent =
        read.sourceRows <= cap * list.length ||
        this.ungrouped.has(object) ||
        this.options.countsBy?.(object, field) === false
          ? undefined
          : await this.countedByParent(object, grouping, field, list, options);
      if (byParent === undefined) {
        atOnce.push(...list);
        continue;
      }
      for (const parent of byParent) {
        if (parent.rows > cap) hubs.push(parent);
        else atOnce.push(parent.parentId);
      }
    }
    const kept = newestOf(
      await this.byList(object, columns, field, atOnce, terms, options),
      field,
      cap,
      by,
    );
    answer.rows.push(...kept.rows);
    answer.cut.push(...kept.cut);
    for (const [key, n] of kept.counts) counted.set(key, n);
    for (const hub of hubs) {
      const statement =
        `SELECT ${columns.join(', ')} FROM ${object} WHERE ` +
        `${[...terms, `${field} = '${hub.parentId}'`].join(' AND ')} ` +
        `ORDER BY ${newestOrderOf(by)} LIMIT ${cap}`;
      let newest: SourceRow[];
      try {
        newest = await readColumnsApart(statement, (soql) => this.gather(soql, options));
      } catch (error) {
        if (!refusedItsShape(error)) throw error;
        // Read whole and cut here, as a list of one.
        const whole = newestOf(
          await this.byList(object, columns, field, [hub.parentId], terms, options),
          field,
          cap,
          by,
        );
        answer.rows.push(...whole.rows);
        answer.cut.push(...whole.cut);
        for (const [key, n] of whole.counts) counted.set(key, n);
        continue;
      }
      answer.rows.push(...newest);
      answer.cut.push({ parentId: hub.parentId, rows: Math.max(0, hub.rows - newest.length) });
      counted.set(idKey(hub.parentId), hub.rows);
    }
    return done();
  }

  /**
   * The children of each parent of `list`, counted by the org: undefined
   * when it refuses the statement, the list then read at once, and every
   * list of the object after it. A scratch org would not count a feed item's
   * ids (`field Id does not support aggregate operator COUNT`); a lookup it
   * will not group by would be refused alike.
   */
  private async countedByParent(
    object: string,
    grouping: { head: string; tail: string },
    field: string,
    list: readonly string[],
    options: SampleReadOptions | undefined,
  ): Promise<Array<{ parentId: string; rows: number }> | undefined> {
    const statement = `${grouping.head}${list.map((id) => `'${id}'`).join(', ')}${grouping.tail}`;
    let rows: SourceRow[];
    try {
      rows = await this.gather(statement, options);
    } catch (error) {
      if (!refusedItsShape(error)) throw error;
      this.ungrouped.add(object);
      return undefined;
    }
    const counted: Array<{ parentId: string; rows: number }> = [];
    for (const row of rows) {
      const parentId = row[field];
      const n = Number(row['n']);
      if (typeof parentId === 'string' && Number.isFinite(n)) counted.push({ parentId, rows: n });
    }
    return counted;
  }

  // ─── Records whole ─────────────────────────────────────────────────────────

  /**
   * Read every record of objects the sample copies whole, six objects at a
   * time, and hand each page to `onRows` as it comes.
   */
  async readWhole(
    reads: readonly WholeRead[],
    onRows: (objectApiName: string, rows: SourceRow[]) => void | Promise<void>,
  ): Promise<void> {
    await eachInPool(reads, async (read) => {
      const object = assertSoqlIdentifier(read.objectApiName);
      const columns = this.columnsOf(object, read.columns);
      const options = this.readOptionsOf(object);
      const soql = `SELECT ${columns.join(', ')} FROM ${object}${whereOf(this.termsOf(object))}`;
      for await (const page of pagesColumnsApart(
        soql,
        (statement) => this.pages(statement, options),
        (statement) => this.gather(statement, options),
      )) {
        await onRows(read.objectApiName, page);
      }
    });
  }
}

/**
 * The order the newest records of an object are read in: the date each was
 * made, the latest first, ties by id; or, of an object with no creation date
 * the org orders by, its ids alone, the greatest first.
 */
function newestOrderOf(by: RecentDraw['by']): string {
  return by === 'created' ? `${CREATED} DESC, Id DESC` : 'Id DESC';
}

/**
 * What a statement of the roots of an object read by date holds after
 * `last`, beside the roots' own terms, and its order: see
 * `SampleSourceReader.rootsByDate`. The newest are read down from the
 * latest, the oldest up from the first, ties by id either way. Every date is
 * the org's own, to the second.
 */
function afterTheLast(
  by: RecentDraw['by'],
  draw: Exclude<ForgeSampleDraw, 'uniform'>,
  last: { at: string; id: string } | undefined,
): { after: string[]; order: string } {
  const down = draw === 'recent';
  const past = down ? '<' : '>';
  const way = down ? 'DESC' : 'ASC';
  if (by === 'id') {
    return { after: last ? [`Id ${past} '${last.id}'`] : [], order: `Id ${way}` };
  }
  const order = `${CREATED} ${way}, Id ${way}`;
  if (!last) return { after: [], order };
  return {
    after: [
      `(${CREATED} ${past} ${last.at} OR (${CREATED} = ${last.at} AND Id ${past} '${last.id}'))`,
    ],
    order,
  };
}

/**
 * The ids of `rows` by the value of their `field`, each value once, in the
 * order their first row came: what a page of roots of an object stratified
 * hands on.
 */
function byStratum(
  rows: readonly SourceRow[],
  field: string,
): Array<{ value: StratumValue; ids: string[] }> {
  const groups = new Map<string, { value: StratumValue; ids: string[] }>();
  for (const row of rows) {
    const value = stratumOf(row[field]);
    const key = stratumKeyOf(value);
    const group = groups.get(key) ?? { value, ids: [] };
    group.ids.push(String(row['Id']));
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * Where the last row of a page of the newest records stands: its id, and
 * the second it was made, as a SOQL literal.
 *
 * @throws When the org gave the row without an id, or without the date it ordered it by.
 */
function lastRowOf(
  objectApiName: string,
  row: SourceRow,
  by: RecentDraw['by'],
): { at: string; id: string } {
  const id = row['Id'];
  if (typeof id !== 'string' || !RECORD_ID.test(id)) {
    throw new Error(`A record of ${objectApiName} came back without its id.`);
  }
  if (by === 'id') return { at: '', id };
  const at = row[CREATED];
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) {
    throw new Error(`A record of ${objectApiName} came back without the date it was made.`);
  }
  return { at: soqlInstant(at), id };
}

/**
 * The moment a row read with its creation date was made, in milliseconds;
 * undefined for a row without one, which is read by its id.
 */
function madeAt(row: SourceRow): number | undefined {
  const at = row[CREATED];
  const ms = typeof at === 'string' ? Date.parse(at) : Number.NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Whether row `a` is newer than row `b`, as `ORDER BY CreatedDate DESC, Id
 * DESC` reads them: the later made first, ties — and rows without a date,
 * after those with one — by their ids, the greatest first, in the order of
 * their bytes as a scratch org gave them, which {@link compareIds} is.
 */
function newerFirst(a: SourceRow, b: SourceRow): number {
  const at = madeAt(a);
  const bt = madeAt(b);
  if (at !== bt) {
    if (at === undefined) return 1;
    if (bt === undefined) return -1;
    return bt - at;
  }
  return compareIds(String(b['Id']), String(a['Id']));
}

/**
 * Of `rows`, the newest `cap` of each parent `field` names — by the date
 * each was made, as {@link newestOrderOf} reads them, or, read `by` their
 * ids, the greatest — and, of each parent, the children the cap left out
 * and those it holds.
 */
function newestOf(
  rows: readonly SourceRow[],
  field: string,
  cap: number,
  by: RecentDraw['by'],
): {
  rows: SourceRow[];
  cut: Array<{ parentId: string; rows: number }>;
  counts: Map<string, number>;
} {
  const byParent = new Map<string, { parentId: string; rows: SourceRow[] }>();
  for (const row of rows) {
    const parentId = row[field];
    if (typeof parentId !== 'string') continue;
    const key = idKey(parentId);
    const held = byParent.get(key);
    if (held) held.rows.push(row);
    else byParent.set(key, { parentId, rows: [row] });
  }
  const kept: SourceRow[] = [];
  const cut: Array<{ parentId: string; rows: number }> = [];
  const counts = new Map<string, number>();
  for (const [key, { parentId, rows: children }] of byParent) {
    children.sort(
      by === 'created' ? newerFirst : (a, b) => compareIds(String(b['Id']), String(a['Id'])),
    );
    kept.push(...children.slice(0, cap));
    if (children.length > cap) cut.push({ parentId, rows: children.length - cap });
    counts.set(key, children.length);
  }
  return { rows: kept, cut, counts };
}

// ─── What the reads cost ─────────────────────────────────────────────────────

/**
 * The requests reading an object's roots sends once they are counted: the
 * pages of every root (`uniform`), stratified or not; or the statements of
 * the `take` newest or oldest (`recent`, `oldest`), each of up to
 * {@link ROWS_PER_PAGE} rows — of an object stratified, those of each value
 * it takes, one at least of each value counted to hold a root. None for an
 * object, or a value, counted to hold none. Of a count that is not exact,
 * the roots by date are priced as if every row read were a root: the read
 * goes on past the rows it tests out, and sends what it sends.
 */
export function rootScanRequestsOf(
  count: RootCount,
  draw: ForgeSampleDraw,
  take: DatedRootRead['take'] = 0,
): number {
  if (count.rows <= 0) return 0;
  if (draw === 'uniform') return Math.ceil(count.rows / ROWS_PER_PAGE);
  const pagesOf = (wanted: number, rows: number): number =>
    Math.ceil(Math.min(Math.max(0, wanted), rows) / ROWS_PER_PAGE);
  if (typeof take === 'number') return pagesOf(take, count.rows);
  const counted = new Map(
    (count.strata ?? []).map((stratum) => [stratumKeyOf(stratum.value), stratum.rows]),
  );
  return take.reduce(
    (sum, stratum) =>
      sum + pagesOf(stratum.take, counted.get(stratumKeyOf(stratum.value)) ?? stratum.take),
    0,
  );
}

/** How a run reads the records of one object of its plan, and what it costs. */
export interface RunRead {
  /** `ids`: by the plan's ids, `Id IN (…)`; `cursor`: the table in the order of its ids, the plan's kept. */
  by: 'ids' | 'cursor';
  /** The requests of the read chosen. */
  requests: number;
  /** The requests of each read, the one chosen among them. */
  byIds: number;
  byCursor: number;
  /** Set when the object is read by cursor whatever it costs: see {@link READ_BY_CURSOR_ALONE}. */
  cursorAlone?: true;
}

/** What {@link runReadOf} prices. */
export interface RunReadInput {
  objectApiName: string;
  /** The run's select list of the object. */
  columns: readonly string[];
  /** The records the cursor reads: the object's, under its filter. */
  sourceRows: number;
  /** The records of the plan. */
  planRows: number;
}

/**
 * The cheaper of the two reads of an object of the plan, in requests, as a
 * run sends them (`readingInColumnGroups`): by the plan's ids, each group of
 * columns in lists of {@link idsPerStatement}; or by the cursor over the
 * table, every page and, of a wide object, its other groups for every row
 * of each page. An object read by cursor alone is read so
 * ({@link READ_BY_CURSOR_ALONE}).
 */
export function runReadOf(input: RunReadInput): RunRead {
  const object = assertSoqlIdentifier(input.objectApiName);
  const stamped = input.columns.some((column) => column.toLowerCase() === 'systemmodstamp');
  const groups = columnGroups(input.columns, stamped ? ['Id', 'SystemModstamp'] : ['Id']);
  const planned = Math.max(0, input.planRows);
  const rows = Math.max(0, input.sourceRows);
  const perStatement = groups.map((group) => idsPerStatement(object, group));
  const byIds = perStatement.reduce((sum, per) => sum + Math.ceil(planned / per), 0);
  const pages = Math.max(1, Math.ceil(rows / ROWS_PER_PAGE));
  const fullPages = Math.floor(rows / ROWS_PER_PAGE);
  const rest = rows % ROWS_PER_PAGE;
  const byCursor =
    pages +
    perStatement
      .slice(1)
      .reduce(
        (sum, per) =>
          sum + fullPages * Math.ceil(ROWS_PER_PAGE / per) + (rest > 0 ? Math.ceil(rest / per) : 0),
        0,
      );
  if (READ_BY_CURSOR_ALONE.has(object)) {
    return { by: 'cursor', requests: byCursor, byIds, byCursor, cursorAlone: true };
  }
  return byIds <= byCursor
    ? { by: 'ids', requests: byIds, byIds, byCursor }
    : { by: 'cursor', requests: byCursor, byIds, byCursor };
}
