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

import {
  oneStampOf,
  pagesColumnsApart,
  readOtherColumns,
  readOtherColumnsAtOneStamp,
  wideStatement,
} from '../../../core/common/wideRead.js';

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

/**
 * `deps`, reading a statement too wide for one query URI in column groups
 * (`core/common/wideRead`): the statement as written naming its first group,
 * the others read by the ids it returned. Every read of a run goes through
 * these two — the stages' too, which are handed the run's deps — so none
 * sends a statement past the URI an org accepts: an Account of eight hundred
 * fields failed its root read with ERROR_HTTP_431 before a row was read. A
 * statement that fits goes to `deps` as it was given.
 *
 * A row is held to one write (`oneStampOf`): every group carries the record's
 * `SystemModstamp` when the statement names it — a read of every field of an
 * object that has one — and a row a later group answers with another stamp
 * is read again, one it no longer finds dropped. Merged as they were read, a
 * record saved between two groups was copied to the target with the values
 * of two saves, and one deleted between them with the first group's alone.
 *
 * Everything else is `deps`' own, read when it is called, as `deps` itself
 * would be.
 */
export function readingInColumnGroups<D extends PagedReadDeps>(deps: D): D {
  const queryRecords: PagedReadDeps['queryRecords'] = async (...args) => {
    const [orgId, soql, ...rest] = args;
    const oneStamp = oneStampOf(soql);
    const wide = wideStatement(soql, oneStamp === undefined ? undefined : ['Id', oneStamp.stamp]);
    if (!wide) return deps.queryRecords(...args);
    const first = await deps.queryRecords(orgId, wide.first, ...rest);
    const byIds = (statement: string): Promise<SourceRow[]> => deps.queryRecords(orgId, statement);
    return oneStamp === undefined
      ? readOtherColumns(first, wide, byIds)
      : readOtherColumnsAtOneStamp(first, wide, byIds, oneStamp);
  };
  const queryPages = (orgId: string, soql: string): AsyncIterable<SourceRow[]> =>
    pagesColumnsApart(
      soql,
      (statement) => deps.queryPages?.(orgId, statement) ?? noPages(),
      (statement) => deps.queryRecords(orgId, statement),
      oneStampOf(soql),
    );
  return new Proxy(deps, {
    get(target, property, receiver) {
      if (property === 'queryRecords') return queryRecords;
      if (property === 'queryPages') return target.queryPages ? queryPages : undefined;
      return Reflect.get(target, property, receiver);
    },
  });
}

/** No page at all: what a cursor gone from the deps since gives. */
async function* noPages(): AsyncGenerator<SourceRow[]> {}
