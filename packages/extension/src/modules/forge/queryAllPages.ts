/**
 * Follow a SOQL result cursor to the end, bounded.
 *
 * `conn.query()` returns only the first page — 2 000 records at most — and
 * Forge read exactly that and stopped: a 50 000-row object cloned
 * as 2 000 rows and reported success, next to a wizard showing the real
 * `SELECT COUNT()` from discovery.
 *
 * This lives in its own module rather than inside `initForgeComposition`
 * because the composition root is on the allowlist of
 * `scripts/audit-test-siblings.ts` — "one function of dynamic imports and late
 * setters" — and thirty lines of two-bound loop with a truncation report is
 * not that. The first version of this fix was written there and had no test at
 * all, which is the pattern that produced the defect it was fixing.
 */

/**
 * Heap bound of a read that holds its rows, unless the run asks for another
 * (`sandforge.forge.maxRecordsPerObject`, the clone command's
 * `--max-records-per-object`).
 */
export const FORGE_QUERY_MAX_RECORDS = 50_000;

/**
 * Termination bound, independent of the record count: the pages of a read
 * of the default bound, and as many as a higher one needs at the smallest
 * page an org answers with, 200 rows.
 *
 * A cursor that keeps returning `done: false` with zero records would spin
 * forever against the record cap alone.
 */
export const FORGE_QUERY_MAX_PAGES = 500;

/** The smallest page an org answers a cursor with. */
const SMALLEST_PAGE = 200;

/** One page of a SOQL result, as jsforce returns it. */
export interface QueryPage<T> {
  records: T[];
  done: boolean;
  nextRecordsUrl?: string;
}

/** The subset of a jsforce connection this needs. */
export interface PagedQuerySource<T> {
  query(soql: string): Promise<QueryPage<T>>;
  queryMore(nextRecordsUrl: string): Promise<QueryPage<T>>;
}

/** Outcome of a paged read. */
export interface PagedQueryResult<T> {
  records: T[];
  pages: number;
  /** True when a bound stopped the read before the source was exhausted. */
  truncated: boolean;
}

/**
 * Read every page of `soql`, up to the two bounds above.
 *
 * @param source - Connection-like object exposing `query` / `queryMore`.
 * @param soql - The query to run.
 * @param maxRecords - The most rows the read holds: {@link FORGE_QUERY_MAX_RECORDS}
 *   unless the run asks for another.
 * @returns The records read, the page count, and whether a bound cut it short.
 */
export async function queryAllPages<T>(
  source: PagedQuerySource<T>,
  soql: string,
  maxRecords: number = FORGE_QUERY_MAX_RECORDS,
): Promise<PagedQueryResult<T>> {
  const maxPages = Math.max(FORGE_QUERY_MAX_PAGES, Math.ceil(maxRecords / SMALLEST_PAGE));
  let page = await source.query(soql);
  const records: T[] = [...page.records];
  let pages = 1;

  while (!page.done && page.nextRecordsUrl && records.length < maxRecords && pages < maxPages) {
    page = await source.queryMore(page.nextRecordsUrl);
    records.push(...page.records);
    pages++;
  }

  const capped = records.length > maxRecords ? records.slice(0, maxRecords) : records;

  // Cut by the bound on its last page, the read left rows out all the same.
  return { records: capped, pages, truncated: !page.done || capped.length < records.length };
}

/**
 * Empty pages in a row after which a cursor that says it is not done is taken
 * as one that will never be: the termination bound of a read that holds no
 * count of the rows, as {@link FORGE_QUERY_MAX_PAGES} is of one that does.
 */
export const FORGE_CURSOR_MAX_EMPTY_PAGES = 5;

/**
 * Each page of `soql` as the org answers it, the next asked only once the
 * caller has taken the one before: nothing holds the rows of two pages, and a
 * run that writes each page before it asks for the next holds a page at a
 * time whatever the table holds. No bound on the rows: the statement's own
 * `LIMIT` is the caller's.
 *
 * @param source - Connection-like object exposing `query` / `queryMore`.
 * @param soql - The query to run.
 */
export async function* cursorPages<T>(
  source: PagedQuerySource<T>,
  soql: string,
): AsyncGenerator<T[]> {
  let page = await source.query(soql);
  let empty = page.records.length === 0 ? 1 : 0;
  yield page.records;
  while (!page.done && page.nextRecordsUrl && empty < FORGE_CURSOR_MAX_EMPTY_PAGES) {
    page = await source.queryMore(page.nextRecordsUrl);
    empty = page.records.length === 0 ? empty + 1 : 0;
    yield page.records;
  }
}

/**
 * The object a query reads from, for a log line.
 *
 * The query itself is never logged: a WHERE clause can carry record values and
 * the output channel is not a PII sink.
 *
 * @param soql - The query to inspect.
 * @returns The object API name, or a placeholder when it cannot be read.
 */
export function objectOfQuery(soql: string): string {
  return /\bFROM\s+([A-Za-z0-9_]+)/i.exec(soql)?.[1] ?? 'unknown object';
}
