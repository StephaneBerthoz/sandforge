/**
 * An org in miniature that answers SOQL as the data API does, one query a
 * call or several in a `/composite`, with the limits the org showed when it
 * was asked:
 *
 * - five query, `queryAll` or next-page subrequests a composite: the sixth
 *   answers `PROCESSING_HALTED` while the call answers 200;
 * - twenty-five subrequests a composite: twenty-six are refused whole,
 *   `LIMIT_EXCEEDED`;
 * - pages of 2,000 rows unless told otherwise, and next pages that need not
 *   hold as many;
 * - `query` leaves out the recycle bin and archived activities, `queryAll`
 *   reads them;
 * - a datetime literal's milliseconds are dropped, as the org drops them;
 * - a describe asked with `If-Modified-Since` answers 304 with no body when
 *   the object has not changed since.
 *
 * Its cursors can be made to misbehave — released past a number held open,
 * ending without saying done, or answering empty pages without end — so a
 * test proves a read fails rather than ending short in silence.
 *
 * It reads the statements the checkpoint's reads write and only those:
 * `SELECT <fields> | COUNT() FROM <object>`, then an optional `WHERE` of
 * `Field = true | false`, `Field >= <datetime>` and `Field < <datetime>`
 * terms under `AND`, then an optional `ORDER BY SystemModstamp DESC` and
 * `LIMIT`. Anything else is refused as the org refuses a malformed query.
 *
 * Lives under `src/test/` with no `.test.ts` suffix: a helper, not a suite.
 */

import type {
  CompositeQueryConnection,
  CountedPage,
  OrgRow,
} from '../modules/checkpoint/compositeQueries.js';

/** A record of the fake org: live, in the recycle bin (`IsDeleted`), or archived. */
export interface FakeOrgRow {
  Id: string;
  SystemModstamp: string;
  IsDeleted?: boolean;
  IsArchived?: boolean;
  [field: string]: unknown;
}

/** How the fake org misbehaves with a cursor. */
export type BrokenCursor =
  /** Its first page says it is not done and names no next page. */
  | 'noNextPage'
  /** Every page after the first is empty, not done, with a next page. */
  | 'emptyPages';

/** What the fake org holds and how it answers. */
export interface CompositeOrgOptions {
  /** Its records, live and in the bin, by object. */
  tables?: Record<string, FakeOrgRow[]>;
  /** Rows of a cursor's page, by the page's place (0 the first): 2,000 unless given. */
  pageSize?: (page: number) => number;
  /** Queries a composite runs before it halts the rest: 5. */
  queriesPerComposite?: number;
  /** Subrequests a composite may hold: 25. */
  subrequestsPerComposite?: number;
  /** Cursors held open at once before the oldest is released: no limit unless given. */
  cursorLimit?: number;
  /** The error every composite call is refused with, as jsforce throws it. */
  refuseComposite?: Error;
  /** Answer every composite with this instead of a composite answer. */
  compositeAnswer?: unknown;
  /** Whether a statement's cursor misbehaves, and how. */
  brokenCursor?: (soql: string) => BrokenCursor | undefined;
  /** When each object's describe last changed. */
  describedAt?: Record<string, string>;
  /** The API version it speaks: `66.0`. */
  version?: string;
}

/** A call the fake org was sent. */
export type FakeOrgCall =
  | {
      kind: 'composite';
      /** Each subrequest: a query's statement (`query:` or `queryAll:`), a next page (`next:`), a describe (`describe:`). */
      subrequests: string[];
    }
  | { kind: 'query' | 'queryAll' | 'queryMore' | 'get'; what: string };

/** The fake org, the connection to it, and what it was sent. */
export interface CompositeOrg {
  conn: CompositeQueryConnection;
  calls: FakeOrgCall[];
}

/** An error as jsforce throws one the org answered: its code on `errorCode` and `name`. */
export function orgError(errorCode: string, message: string): Error {
  return Object.assign(new Error(message), { name: errorCode, errorCode });
}

/** A cursor the fake org holds open. */
interface Cursor {
  id: string;
  rows: OrgRow[];
  offset: number;
  page: number;
  totalSize: number;
  broken?: BrokenCursor;
}

const QUERY_PREFIX = /^\/services\/data\/v[\d.]+\/(query|queryAll)\?q=(.*)$/;
const NEXT_PAGE = /^\/services\/data\/v[\d.]+\/query(?:All)?\/(01gFAKE\d+)-\d+$/;
const DESCRIBE = /^\/services\/data\/v[\d.]+\/sobjects\/(\w+)\/describe$/;
const STATEMENT =
  /^SELECT (.+?) FROM (\w+)(?: WHERE (.+?))?( ORDER BY SystemModstamp DESC)?(?: LIMIT (\d+))?$/;
const TERM = /^(\w+) (=|>=|<) (\S+)$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/** A literal's value: a boolean, or a datetime the org reads to the second. */
function literal(token: string, soql: string): boolean | number {
  if (token === 'true') return true;
  if (token === 'false') return false;
  if (DATETIME.test(token)) {
    const at = Date.parse(token);
    return at - (((at % 1000) + 1000) % 1000);
  }
  throw orgError('MALFORMED_QUERY', `Not a literal the fake org reads: ${token} in ${soql}`);
}

/** Whether `row` holds `value` in `field` under `operator`. */
function holds(row: FakeOrgRow, field: string, operator: string, value: boolean | number): boolean {
  const cell = field === 'IsDeleted' ? row.IsDeleted === true : row[field];
  if (typeof value === 'boolean') return operator === '=' && cell === value;
  const at = typeof cell === 'string' ? Date.parse(cell) : Number.NaN;
  if (!Number.isFinite(at)) return false;
  return operator === '>=' ? at >= value : operator === '<' ? at < value : at === value;
}

/**
 * The rows `soql` selects from `tables`, projected, with how many it selects
 * in all.
 */
function select(
  tables: Readonly<Record<string, FakeOrgRow[]>>,
  soql: string,
  scanAll: boolean,
): { rows: OrgRow[]; totalSize: number } {
  const statement = STATEMENT.exec(soql);
  if (!statement) throw orgError('MALFORMED_QUERY', `Not a statement the fake org reads: ${soql}`);
  const [, fields, object, where, ordered, limit] = statement;
  const table = tables[object];
  if (!table) throw orgError('INVALID_TYPE', `sObject type '${object}' is not supported.`);
  const terms = (where ?? '')
    .split(' AND ')
    .filter((term) => term !== '')
    .map((term) => {
      const parsed = TERM.exec(term);
      if (!parsed) throw orgError('MALFORMED_QUERY', `Not a term the fake org reads: ${term}`);
      return { field: parsed[1], operator: parsed[2], value: literal(parsed[3], soql) };
    });
  let rows = table.filter(
    (row) =>
      (scanAll || (row.IsDeleted !== true && row.IsArchived !== true)) &&
      terms.every(({ field, operator, value }) => holds(row, field, operator, value)),
  );
  if (ordered) {
    rows = [...rows].sort((a, b) => Date.parse(b.SystemModstamp) - Date.parse(a.SystemModstamp));
  }
  if (limit !== undefined) rows = rows.slice(0, Number(limit));
  if (fields === 'COUNT()') return { rows: [], totalSize: rows.length };
  const names = fields.split(', ');
  return {
    rows: rows.map((row) => ({
      attributes: { type: object, url: `/services/data/v66.0/sobjects/${object}/${row.Id}` },
      ...Object.fromEntries(names.map((name) => [name, row[name] ?? null])),
    })),
    totalSize: rows.length,
  };
}

/**
 * A fake org answering as {@link CompositeOrgOptions} says.
 */
export function compositeOrg(options: CompositeOrgOptions = {}): CompositeOrg {
  const tables = options.tables ?? {};
  const version = options.version ?? '66.0';
  const pageSize = options.pageSize ?? (() => 2_000);
  const queriesPerComposite = options.queriesPerComposite ?? 5;
  const subrequestsPerComposite = options.subrequestsPerComposite ?? 25;
  const cursors = new Map<string, Cursor>();
  const calls: FakeOrgCall[] = [];
  let opened = 0;

  /** The page `cursor` is at, and the cursor moved past it. */
  const pageOf = (cursor: Cursor): CountedPage => {
    const size = cursor.page === 0 || cursor.broken !== 'emptyPages' ? pageSize(cursor.page) : 0;
    const records = cursor.rows.slice(cursor.offset, cursor.offset + size);
    cursor.offset += records.length;
    cursor.page++;
    const more = cursor.offset < cursor.rows.length || cursor.broken === 'emptyPages';
    if (cursor.broken === 'noNextPage') {
      cursors.delete(cursor.id);
      return { records, done: false, totalSize: cursor.totalSize };
    }
    if (!more) {
      cursors.delete(cursor.id);
      return { records, done: true, totalSize: cursor.totalSize };
    }
    return {
      records,
      done: false,
      totalSize: cursor.totalSize,
      nextRecordsUrl: `/services/data/v${version}/query/${cursor.id}-${cursor.offset}`,
    };
  };

  const firstPage = (soql: string, scanAll: boolean): CountedPage => {
    const { rows, totalSize } = select(tables, soql, scanAll);
    const id = `01gFAKE${++opened}`;
    const cursor: Cursor = { id, rows, offset: 0, page: 0, totalSize };
    const broken = options.brokenCursor?.(soql);
    if (broken) cursor.broken = broken;
    cursors.set(id, cursor);
    if (options.cursorLimit !== undefined && cursors.size > options.cursorLimit) {
      // The oldest cursor still open is released.
      const oldest = cursors.keys().next().value;
      if (oldest !== undefined && oldest !== id) cursors.delete(oldest);
    }
    return pageOf(cursor);
  };

  const nextPage = (url: string): CountedPage => {
    const id = NEXT_PAGE.exec(url)?.[1] ?? /\/(01gFAKE\d+)-\d+$/.exec(url)?.[1];
    const cursor = id === undefined ? undefined : cursors.get(id);
    if (!cursor) throw orgError('INVALID_QUERY_LOCATOR', 'invalid query locator');
    return pageOf(cursor);
  };

  const describe = (object: string, since: string | undefined): unknown => {
    const changed = options.describedAt?.[object];
    if (!tables[object] && changed === undefined) {
      throw orgError('NOT_FOUND', `The requested resource does not exist`);
    }
    if (since !== undefined && changed !== undefined && Date.parse(changed) <= Date.parse(since)) {
      return undefined;
    }
    return { name: object, fields: [] };
  };

  const composite = (raw: string): unknown => {
    const body = JSON.parse(raw) as {
      allOrNone?: boolean;
      compositeRequest: Array<{
        method: string;
        url: string;
        referenceId: string;
        httpHeaders?: Record<string, string>;
      }>;
    };
    const subrequests = body.compositeRequest.map(({ url }) => {
      const asQuery = QUERY_PREFIX.exec(url);
      const asDescribe = DESCRIBE.exec(url);
      if (asQuery) return `${asQuery[1]}:${decodeURIComponent(asQuery[2])}`;
      if (NEXT_PAGE.test(url)) return `next:${url}`;
      return asDescribe ? `describe:${asDescribe[1]}` : `unknown:${url}`;
    });
    calls.push({ kind: 'composite', subrequests });
    if (body.compositeRequest.length > subrequestsPerComposite) {
      throw orgError(
        'LIMIT_EXCEEDED',
        `The request can’t contain more than ${subrequestsPerComposite} operations.`,
      );
    }
    if (options.refuseComposite) throw options.refuseComposite;
    if (options.compositeAnswer !== undefined) return options.compositeAnswer;
    let queries = 0;
    const compositeResponse = body.compositeRequest.map(({ url, referenceId, httpHeaders }) => {
      const asQuery = QUERY_PREFIX.exec(url);
      const asDescribe = DESCRIBE.exec(url);
      const isNext = NEXT_PAGE.test(url);
      if (asQuery || isNext) {
        queries++;
        if (queries > queriesPerComposite) {
          return {
            referenceId,
            httpStatusCode: 400,
            body: [
              {
                errorCode: 'PROCESSING_HALTED',
                message: 'Limit number of query or Collections in Rest Operations reached.',
              },
            ],
          };
        }
      }
      try {
        if (asQuery) {
          const soql = decodeURIComponent(asQuery[2]);
          return {
            referenceId,
            httpStatusCode: 200,
            body: firstPage(soql, asQuery[1] === 'queryAll'),
          };
        }
        if (isNext) return { referenceId, httpStatusCode: 200, body: nextPage(url) };
        if (asDescribe) {
          const answer = describe(asDescribe[1], httpHeaders?.['If-Modified-Since']);
          return answer === undefined
            ? { referenceId, httpStatusCode: 304, body: null }
            : { referenceId, httpStatusCode: 200, body: answer };
        }
        throw orgError('NOT_FOUND', `The requested resource does not exist`);
      } catch (err: unknown) {
        const { errorCode, message } = err as { errorCode?: string; message: string };
        return { referenceId, httpStatusCode: 400, body: [{ errorCode, message }] };
      }
    });
    return { compositeResponse };
  };

  const conn: CompositeQueryConnection = {
    version,
    request: async ({ method, url, body, headers }) => {
      if (method === 'POST' && url === '/composite') return composite(body ?? '{}');
      calls.push({ kind: 'get', what: url });
      const asDescribe = DESCRIBE.exec(url);
      if (method === 'GET' && asDescribe) {
        return describe(asDescribe[1], headers?.['If-Modified-Since']) ?? '';
      }
      throw orgError('NOT_FOUND', `The requested resource does not exist`);
    },
    query: async (soql, queryOptions) => {
      const scanAll = queryOptions?.scanAll === true;
      calls.push({ kind: scanAll ? 'queryAll' : 'query', what: soql });
      return firstPage(soql, scanAll);
    },
    queryMore: async (url) => {
      calls.push({ kind: 'queryMore', what: url });
      return nextPage(url);
    },
  };

  return { conn, calls };
}

/**
 * `count` records of `object` whose stamps run one second apart from `from`,
 * ids in order: live unless `deleted`.
 */
export function stampedRows(
  object: string,
  count: number,
  from: string,
  extra: Partial<FakeOrgRow> = {},
): FakeOrgRow[] {
  const start = Date.parse(from);
  const prefix = object.slice(0, 3).toUpperCase();
  return Array.from({ length: count }, (_, index) => ({
    Id: `${prefix}${String(index).padStart(12, '0')}AAA`,
    SystemModstamp: new Date(start + index * 1_000).toISOString(),
    CreatedDate: new Date(start + index * 1_000).toISOString(),
    ...extra,
  }));
}
