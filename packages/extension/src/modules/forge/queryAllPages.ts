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

/** Heap bound: a clone that big is a configuration mistake, not a use case. */
export const FORGE_QUERY_MAX_RECORDS = 50_000;

/**
 * Termination bound, independent of the record count.
 *
 * A cursor that keeps returning `done: false` with zero records would spin
 * forever against the record cap alone.
 */
export const FORGE_QUERY_MAX_PAGES = 500;

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
 * @returns The records read, the page count, and whether a bound cut it short.
 */
export async function queryAllPages<T>(
  source: PagedQuerySource<T>,
  soql: string,
): Promise<PagedQueryResult<T>> {
  let page = await source.query(soql);
  const records: T[] = [...page.records];
  let pages = 1;

  while (
    !page.done &&
    page.nextRecordsUrl &&
    records.length < FORGE_QUERY_MAX_RECORDS &&
    pages < FORGE_QUERY_MAX_PAGES
  ) {
    page = await source.queryMore(page.nextRecordsUrl);
    records.push(...page.records);
    pages++;
  }

  const capped =
    records.length > FORGE_QUERY_MAX_RECORDS ? records.slice(0, FORGE_QUERY_MAX_RECORDS) : records;

  return { records: capped, pages, truncated: !page.done };
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
