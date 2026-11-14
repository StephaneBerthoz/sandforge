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
 *   every id of them (`uniform`), or the newest first (`recent`), by the date
 *   each was made, paged after the date and id of the last row read — an
 *   offset past 2 000 is refused, and an object's ids do not follow the
 *   making of its records from one load to the next. A lookup that may name
 *   records of several objects (`WhatId`) is read with the ids and tested
 *   here, by the key prefix of what it names: tested in the statement, it
 *   would take a semi-join per object, and the org takes two at most and
 *   none beside an OR. A `= null` that no index serves on a table of
 *   millions may run past the org's time (`QUERY_TIMEOUT`; none did on a
 *   scratch org of 74 000 rows): the object is then read without it, its
 *   lookups tested here, as many pages as the table.
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
 * was made where the newest are kept.
 */

import type { ForgeSampleDraw, ForgeSamplingProgress } from '@sandforge/shared';
import { extractErrorCode, extractErrorMessage } from '../../../core/common/extractErrorMessage.js';
import { assertSoqlIdentifier } from '../../../core/common/soqlValidator.js';
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

/** The roots of one object to count or read. */
export interface RootRead {
  objectApiName: string;
  carriers: readonly RootCarrier[];
}

/** The roots of one object to read the newest first, and how many it keeps. */
export interface RecentRootRead extends RootRead {
  take: number;
}

/**
 * The order the newest roots of one object were read in: by `created`, the
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
  /** Set when the count with its `= null` ran past the org's time, and the object is read without it. */
  timedOut?: true;
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

/** How the roots of one object are read: see `SampleSourceReader.rootShapeOf`. */
interface RootShape {
  object: string;
  /** The id, then the lookups tested here. */
  select: string[];
  /** The object's filter, and the lookups held to `= null`. */
  terms: string[];
  /** Whether a lookup is held to `= null`: a statement that may run past the org's time. */
  held: boolean;
  /** Whether a lookup is tested here: a row read may be no root. */
  tested: boolean;
  isRoot: (row: SourceRow) => boolean;
}

/** The field the newest records are found by: the date each was made, to the second. */
const CREATED = 'CreatedDate';

/** `text` with its quoted literals emptied: what is read for its words. */
function withoutLiterals(text: string): string {
  return text.replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

/** Whether a filter holds a semi-join, `IN (SELECT …)`: the org then takes no OR beside it. */
function holdsSemiJoin(filter: string): boolean {
  return /\(\s*SELECT\b/i.test(withoutLiterals(filter));
}

/** Whether a value names no record: a lookup left empty. */
function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '';
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
   * held at the config's schema; it may hold a semi-join, which the org then
   * takes no OR beside ({@link holdsSemiJoin}).
   */
  private termsOf(objectApiName: string): string[] {
    const filter = this.options.filterOf?.(objectApiName);
    return [
      ...(filter !== undefined && filter.trim() !== '' ? [`(${filter})`] : []),
      ...(ARCHIVED_ACTIVITIES.has(objectApiName) ? ['IsDeleted = false'] : []),
    ];
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
   * How `read`'s roots are read: the lookups held to `= null` in the
   * statement — those that name a drawn object alone —, those read with the
   * ids and tested here — those that may name several, and every one of an
   * object whose `= null` ran past the org's time —, and the test.
   */
  private rootShapeOf(read: RootRead): RootShape {
    const object = assertSoqlIdentifier(read.objectApiName);
    const slow = this.slow.has(object);
    const carriers = read.carriers.map((carrier) => ({
      field: this.fieldOf(object, carrier.field),
      prefixes: carrier.drawnPrefixes === undefined ? undefined : [...carrier.drawnPrefixes],
    }));
    const held = slow ? [] : carriers.filter((carrier) => carrier.prefixes === undefined);
    const tested = carriers.filter((carrier) => !held.includes(carrier));
    const names = (value: unknown, prefixes: string[] | undefined): boolean =>
      !isEmpty(value) &&
      (prefixes === undefined || prefixes.some((prefix) => String(value).startsWith(prefix)));
    return {
      object,
      select: this.columnsOf(
        object,
        tested.map((carrier) => carrier.field),
      ),
      terms: [...this.termsOf(object), ...held.map((carrier) => `${carrier.field} = null`)],
      held: held.length > 0,
      tested: tested.length > 0,
      isRoot: (row) => !tested.some((carrier) => names(row[carrier.field], carrier.prefixes)),
    };
  }

  /**
   * Count the roots of each object, six objects at a time: what prices the
   * read of their ids before one is read. A count whose `= null` runs past
   * the org's time is made again without it — every row of the object — and
   * the object read without it from then on.
   */
  async countRoots(reads: readonly RootRead[]): Promise<RootCount[]> {
    const counts: RootCount[] = new Array<RootCount>(reads.length);
    let done = 0;
    await eachInPool(reads, async (read, index) => {
      const count = await this.countRootsOf(read);
      counts[index] = count;
      this.counted.set(read.objectApiName, count.rows);
      done++;
      this.progress('counting', { objectApiName: read.objectApiName, done, total: reads.length });
    });
    return counts;
  }

  private async countRootsOf(read: RootRead): Promise<RootCount> {
    const objectApiName = read.objectApiName;
    const options = this.readOptionsOf(objectApiName);
    const first = this.rootShapeOf(read);
    const countOf = (shape: RootShape): Promise<number> =>
      this.count(`SELECT COUNT() FROM ${shape.object}${whereOf(shape.terms)}`, options);
    if (!this.slow.has(objectApiName)) {
      try {
        const rows = await countOf(first);
        return { objectApiName, rows, exact: !first.tested };
      } catch (error) {
        if (!first.held || !ranPastItsTime(error)) throw error;
        this.slow.add(objectApiName);
      }
    }
    const rows = await countOf(this.rootShapeOf(read));
    return { objectApiName, rows, exact: false, timedOut: true };
  }

  /**
   * Read every root id of each object, six objects at a time, and hand each
   * page's roots to `onRoots` as it comes: no more than a page of each is
   * held. An object counted to hold none is not read.
   */
  async drawUniform(
    reads: readonly RootRead[],
    onRoots: (objectApiName: string, ids: string[]) => void | Promise<void>,
  ): Promise<void> {
    let done = 0;
    await eachInPool(reads, async (read) => {
      if (this.counted.get(read.objectApiName) !== 0) await this.scanRoots(read, onRoots);
      done++;
      this.progress('drawing', { objectApiName: read.objectApiName, done, total: reads.length });
    });
  }

  /**
   * Every root of one object, a page at a time. A read whose `= null` runs
   * past the org's time before its first page is read again without it; past
   * its first page, it has handed roots on, and fails rather than hand them
   * twice.
   */
  private async scanRoots(
    read: RootRead,
    onRoots: (objectApiName: string, ids: string[]) => void | Promise<void>,
  ): Promise<void> {
    const options = this.readOptionsOf(read.objectApiName);
    for (;;) {
      const shape = this.rootShapeOf(read);
      const soql = `SELECT ${shape.select.join(', ')} FROM ${shape.object}${whereOf(shape.terms)}`;
      let answered = false;
      try {
        for await (const page of this.pages(soql, options)) {
          answered = true;
          const ids = page.filter(shape.isRoot).map((row) => String(row['Id']));
          if (ids.length > 0) await onRoots(read.objectApiName, ids);
        }
        return;
      } catch (error) {
        if (answered || !shape.held || !ranPastItsTime(error)) throw error;
        this.slow.add(read.objectApiName);
      }
    }
  }

  /**
   * Read the newest roots of each object first, as many as each `take`s, six
   * objects at a time, and hand them to `onRoots` in that order: by the date
   * each record was made, `ORDER BY CreatedDate DESC, Id DESC`, statements of
   * up to {@link ROWS_PER_PAGE} rows, each after the date and id of the last
   * row the one before read — never by an offset, which the org refuses past
   * 2 000. Not by their ids alone: an object's ids follow the making of its
   * records within a load, not from one load to the next, and a scratch org
   * had none of its ten newest contacts among the ten greatest ids. An
   * object with no creation date it orders by is read by its ids, and the
   * answer says so. What is read is what is kept, but for the rows a lookup
   * tested here takes out.
   */
  async drawRecent(
    reads: readonly RecentRootRead[],
    onRoots: (objectApiName: string, ids: string[]) => void | Promise<void>,
  ): Promise<RecentDraw[]> {
    const drawn = reads.map((read) => ({
      objectApiName: read.objectApiName,
      by: this.newestBy(read.objectApiName),
    }));
    let done = 0;
    await eachInPool(reads, async (read, index) => {
      if (read.take > 0 && this.counted.get(read.objectApiName) !== 0) {
        await this.newestRoots(read, drawn[index].by, onRoots);
      }
      done++;
      this.progress('drawing', { objectApiName: read.objectApiName, done, total: reads.length });
    });
    return drawn;
  }

  /**
   * How the newest records of `objectApiName` are found: by the date each was
   * made, when its describe lists one the org orders by; by its ids otherwise.
   */
  private newestBy(objectApiName: string): RecentDraw['by'] {
    const listed = this.options.fieldsOf(objectApiName) ?? [];
    const dated = listed.some((field) => field.toLowerCase() === CREATED.toLowerCase());
    return dated && this.options.sorts?.(objectApiName, CREATED) !== false ? 'created' : 'id';
  }

  /**
   * Whether the newest records of `objectApiName` are read a second apart: by
   * their creation date, under a filter that holds a semi-join, beside which
   * the org takes no OR. Each page past the first then costs a request more
   * ({@link rootScanRequestsOf}).
   */
  readsNewestApart(objectApiName: string): boolean {
    const filter = this.options.filterOf?.(objectApiName);
    return (
      this.newestBy(objectApiName) === 'created' && filter !== undefined && holdsSemiJoin(filter)
    );
  }

  /**
   * The newest roots of one object. Past a page, the next statement starts
   * after the last row read: `(CreatedDate < :d OR (CreatedDate = :d AND Id <
   * :id))`, rows made in the same second ordered by their ids. Under a filter
   * that holds a semi-join, the org takes no OR: the rest of the last second
   * is read on its own, `CreatedDate = :d AND Id < :id`, and the rows made
   * before it after, `CreatedDate < :d`.
   */
  private async newestRoots(
    read: RecentRootRead,
    by: RecentDraw['by'],
    onRoots: (objectApiName: string, ids: string[]) => void | Promise<void>,
  ): Promise<void> {
    const object = read.objectApiName;
    const options = this.readOptionsOf(object);
    const apart = this.readsNewestApart(object);
    let given = 0;
    let last: { at: string; id: string } | undefined;
    let sameSecond = false;
    while (given < read.take) {
      const shape = this.rootShapeOf(read);
      // Every row a root but where a lookup is tested here: a statement of a page then.
      const limit = shape.tested ? ROWS_PER_PAGE : Math.min(ROWS_PER_PAGE, read.take - given);
      const select =
        by === 'created' ? this.columnsOf(object, [...shape.select, CREATED]) : shape.select;
      const { after, order } = afterTheLast(by, last, apart, sameSecond);
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
        .slice(0, read.take - given);
      given += ids.length;
      if (ids.length > 0) await onRoots(object, ids);
      if (rows.length < limit) {
        // The rest of a second read apart is done: the rows made before it come next.
        if (!(apart && sameSecond)) return;
        sameSecond = false;
        continue;
      }
      const tail = rows[rows.length - 1];
      last = lastRowOf(object, tail, by);
      sameSecond = apart;
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
    const by = this.newestBy(object);
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
 * What a statement of the newest records of an object holds after `last`,
 * beside the roots' own terms, and its order: see
 * `SampleSourceReader.newestRoots`. Every date is the org's own, to the
 * second, and no term is a semi-join.
 */
function afterTheLast(
  by: RecentDraw['by'],
  last: { at: string; id: string } | undefined,
  apart: boolean,
  sameSecond: boolean,
): { after: string[]; order: string } {
  const newest = newestOrderOf('created');
  if (by === 'id') {
    return { after: last ? [`Id < '${last.id}'`] : [], order: newestOrderOf('id') };
  }
  if (!last) return { after: [], order: newest };
  if (!apart) {
    return {
      after: [`(${CREATED} < ${last.at} OR (${CREATED} = ${last.at} AND Id < '${last.id}'))`],
      order: newest,
    };
  }
  return sameSecond
    ? { after: [`${CREATED} = ${last.at}`, `Id < '${last.id}'`], order: 'Id DESC' }
    : { after: [`${CREATED} < ${last.at}`], order: newest };
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
 * pages of every root (`uniform`), or the statements of the `take` newest
 * (`recent`), each of up to {@link ROWS_PER_PAGE} rows — and, read a second
 * apart (`SampleSourceReader.readsNewestApart`), the rest of each page's last
 * second besides. None for an object counted to hold none. Of a count that
 * is not exact, the newest are priced as if every row read were a root: the
 * read goes on past the rows it tests out, and sends what it sends.
 */
export function rootScanRequestsOf(
  count: RootCount,
  draw: ForgeSampleDraw,
  take = 0,
  apart = false,
): number {
  if (count.rows <= 0) return 0;
  if (draw === 'uniform') return Math.ceil(count.rows / ROWS_PER_PAGE);
  const pages = Math.ceil(Math.min(Math.max(0, take), count.rows) / ROWS_PER_PAGE);
  return apart ? pages + Math.max(0, pages - 1) : pages;
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
