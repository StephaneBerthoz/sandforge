/**
 * The rows of a run of whole tables, a page at a time.
 *
 * A run held every row it read of an object until it had cleaned and written
 * them, and its reads stopped at a bound so that a table of millions would
 * not go into the extension host's memory whole. Read page by page, each
 * page written before the next is asked for, a run holds a page whatever the
 * table holds: what grows with the table is what the run keeps of what it
 * wrote, never the rows.
 */

/** A row as the source org answers it. */
export type SourceRow = Record<string, unknown>;

/**
 * The pages of `pages`, cut to `size` rows each — the last one shorter —
 * holding no more than one page of the source and one of the answer at once.
 * Without a size, each page as the source gave it. At least one page, empty
 * when the source had no row: the caller hears the read was made.
 *
 * The size is a test seam, not a setting: an org answers a cursor in pages of
 * up to 2 000 rows and takes no page smaller than 200, while a run's paging is
 * proved with pages of a few rows.
 */
export async function* inPagesOf<T>(pages: AsyncIterable<T[]>, size?: number): AsyncGenerator<T[]> {
  const cut = size !== undefined && Number.isFinite(size) && size >= 1 ? Math.floor(size) : 0;
  let given = 0;
  let held: T[] = [];
  for await (const page of pages) {
    if (cut === 0) {
      if (page.length === 0 && given > 0) continue;
      given++;
      yield page;
      continue;
    }
    held = held.length === 0 ? [...page] : [...held, ...page];
    while (held.length >= cut) {
      given++;
      yield held.slice(0, cut);
      held = held.slice(cut);
    }
  }
  if (held.length > 0 || given === 0) yield held;
}

/** What reading a node page by page needs of the run's deps. */
export interface PagedReadDeps {
  /** Each page of a statement as the org answers it; see `ForgeExecutorDeps.queryPages`. */
  queryPages?: (orgId: string, soql: string) => AsyncIterable<SourceRow[]>;
  /** Every row of a statement at once: what a run reads with when the deps give no pages. */
  queryRecords: (orgId: string, soql: string, onTruncated?: () => void) => Promise<SourceRow[]>;
}

/**
 * The pages of `soql`, `size` rows each: through the org's cursor when the
 * deps give one, so that no more than a page is held; otherwise read whole
 * and cut, which holds the table as a run always did and pages its writes
 * all the same — the path of deps that answer a statement at once.
 */
export function pagesOfStatement(
  deps: PagedReadDeps,
  orgId: string,
  soql: string,
  size?: number,
  onTruncated?: () => void,
): AsyncGenerator<SourceRow[]> {
  const { queryPages } = deps;
  if (queryPages) return inPagesOf(queryPages(orgId, soql), size);
  return inPagesOf(
    (async function* whole(): AsyncGenerator<SourceRow[]> {
      yield await deps.queryRecords(orgId, soql, onTruncated);
    })(),
    size,
  );
}
