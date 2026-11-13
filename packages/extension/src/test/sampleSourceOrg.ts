/**
 * A source org in memory for the reads that draw a sample of a whole org:
 * rows per object, the columns each object's describe lists, and a cursor
 * that answers pages as the org does and counts every request it answers.
 *
 * It reads its statements as the memory org reads them (`memorySoql.ts`),
 * with what a sample's reads add — `COUNT(Id)` grouped by a field, `OFFSET` —
 * and refuses what the org refuses:
 *
 * - a column the object's describe does not list, in the select list, the
 *   WHERE, the order or the grouping: `INVALID_FIELD`, as the org answered a
 *   read that named `LastModifiedById` of a feed item;
 * - a request line longer than the org holds, measured as it goes on the
 *   wire, each quote as `%27`: a scratch org answered 18 658 characters and
 *   refused 18 676, with a 431 (`ERROR_HTTP_431`);
 * - a third semi-join in a statement, or one beside an OR, in the words a
 *   scratch org answered them with (`EXCEEDED_MAX_SEMIJOIN_SUBSELECTS`,
 *   `MALFORMED_QUERY`);
 * - `COUNT(Id)` of feed items grouped by a field, which a scratch org
 *   refused (`MALFORMED_QUERY`, the id "does not support aggregate operator
 *   COUNT");
 * - an offset past 2 000 (`NUMBER_OUTSIDE_VALID_RANGE`), as Salesforce
 *   documents it and as Autopilot met it past the two thousandth row;
 * - of an object it is told is slow, a statement that holds a lookup to
 *   `= null`: a filter no index serves on a table of millions, which the org
 *   runs past its time and answers `QUERY_TIMEOUT` — in Salesforce's
 *   documented words, never yet met on a test org.
 *
 * A query leaves out the deleted rows and the archived activities;
 * `queryAll` answers both. A cursor answers `pageSize` rows a page, 2 000
 * unless a test asks fewer; a `COUNT()` answers its total and no row.
 *
 * Lives under `src/test/`: a helper, not a suite.
 */

import { cursorPages, type QueryPage } from '../modules/forge/queryAllPages.js';
import type { SampleSource } from '../modules/forge/sample/sampleReader.js';
import { parseSoql, selectFrom, type SoqlRow } from './memorySoql.js';

/**
 * The longest request line of a query, path and statement as they go on the
 * wire, the org answers: a scratch org answered 18 658 characters and
 * refused 18 676, of two objects alike.
 */
export const MOST_WIRE_CHARS = 18_658;

/** The path of a query in front of its statement, as the product's connection sends it (v66.0). */
const QUERY_PATH = '/services/data/v66.0/query?q=';

/**
 * Characters `soql` takes on the wire: percent-encoded as jsforce writes it,
 * and its quotes as `%27`, as node-fetch rewrites the URL (WHATWG) after it.
 */
function wireLength(soql: string): number {
  return QUERY_PATH.length + encodeURIComponent(soql).replace(/'/g, '%27').length;
}

/** Rows a page of the org's cursor holds. */
const ROWS_PER_PAGE = 2_000;

/** The furthest offset the org reads from. */
const MOST_OFFSET = 2_000;

/** A page as the org answers a statement, with the rows it selects in all. */
export interface SourcePage extends QueryPage<SoqlRow> {
  totalSize: number;
}

/** An error as jsforce throws the org's: its code on `errorCode` and `name`, the org's text as the message. */
export function orgError(errorCode: string, message: string): Error {
  return Object.assign(new Error(message), { name: errorCode, errorCode });
}

/** Columns every object answers whatever its rows hold. */
const ALWAYS = ['Id', 'IsDeleted'];

/** An identifier the WHERE of a statement compares, before its operator. */
const COMPARED = /([A-Za-z_][\w.]*)\s*(?:=|!=|<>|<=|>=|<|>|\s(?:NOT\s+)?IN\s*\()/gi;

/** Words of SOQL an identifier before an operator never is. */
const KEYWORDS = new Set(['and', 'or', 'not', 'where', 'in']);

/** `soql` with its quoted literals emptied: what is read for its words. */
function withoutLiterals(soql: string): string {
  return soql.replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

export class SampleSourceOrg {
  /** Rows per object. */
  readonly rows = new Map<string, SoqlRow[]>();
  /**
   * The fields an object's describe lists, as a real describe gave them; an
   * object not set answers the columns its rows hold, the id and `IsDeleted`.
   */
  readonly columns = new Map<string, readonly string[]>();
  /** Objects whose statements with a lookup `= null` run past the org's time. */
  readonly slow = new Set<string>();
  /**
   * Objects whose ids the org will not count by a field: a scratch org
   * refused `COUNT(Id)` of feed items grouped by their parent.
   */
  readonly uncountedIds = new Set(['FeedItem']);
  /**
   * Statements the org refuses besides, by a pattern of their text, with the
   * code and words it refuses them in: a lookup it will not group by.
   */
  readonly refusals: Array<{ pattern: RegExp; errorCode: string; message: string }> = [];
  /** Rows a page of the cursor holds. */
  pageSize = ROWS_PER_PAGE;
  /** Every statement sent, and whether through `queryAll`. */
  readonly sent: Array<{ soql: string; all: boolean }> = [];
  /** Requests answered or refused: each statement, each next page. */
  requests = 0;
  /** Requests under way now, and the most there ever were at once. */
  inFlight = 0;
  mostInFlight = 0;
  private readonly cursors = new Map<string, { rows: SoqlRow[]; total: number }>();
  private opened = 0;

  add(object: string, ...rows: SoqlRow[]): void {
    this.rows.set(object, [...(this.rows.get(object) ?? []), ...rows]);
  }

  /** The columns `object` answers, lower-cased. */
  private columnsOf(object: string): Set<string> | undefined {
    const listed = this.columns.get(object);
    const rows = this.rows.get(object);
    if (!listed && !rows) return undefined;
    const names = listed ?? [...ALWAYS, ...(rows ?? []).flatMap((row) => Object.keys(row))];
    return new Set([...names, 'Id'].map((name) => name.toLowerCase()));
  }

  async query(soql: string): Promise<SourcePage> {
    return this.answer(soql, false);
  }

  async queryAll(soql: string): Promise<SourcePage> {
    return this.answer(soql, true);
  }

  async queryMore(nextRecordsUrl: string): Promise<SourcePage> {
    return this.request(() => {
      const cursor = this.cursors.get(nextRecordsUrl);
      if (!cursor) throw orgError('INVALID_QUERY_LOCATOR', 'invalid query locator');
      return this.page(nextRecordsUrl, cursor);
    });
  }

  /** The org as a sample's reads take it: each page as the cursor answers it, and counts. */
  source(): SampleSource {
    return {
      pages: (soql, options) => cursorPages(this, soql, options),
      count: async (soql, options) =>
        (options?.all ? await this.queryAll(soql) : await this.query(soql)).totalSize,
    };
  }

  private async request(answer: () => SourcePage): Promise<SourcePage> {
    this.requests++;
    this.inFlight++;
    this.mostInFlight = Math.max(this.mostInFlight, this.inFlight);
    try {
      // The request is in the air while the org runs it: another may start.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      return answer();
    } finally {
      this.inFlight--;
    }
  }

  private page(locator: string, cursor: { rows: SoqlRow[]; total: number }): SourcePage {
    const records = cursor.rows.splice(0, this.pageSize);
    const done = cursor.rows.length === 0;
    if (done) this.cursors.delete(locator);
    return {
      records,
      done,
      totalSize: cursor.total,
      ...(done ? {} : { nextRecordsUrl: locator }),
    };
  }

  private answer(soql: string, all: boolean): Promise<SourcePage> {
    return this.request(() => {
      this.sent.push({ soql, all });
      // jsforce sends the statement in the URI, and the org refuses one past
      // what it holds, with the code jsforce builds from the status.
      if (wireLength(soql) > MOST_WIRE_CHARS) {
        throw orgError('ERROR_HTTP_431', 'Request Header Fields Too Large');
      }
      const refused = this.refusals.find((refusal) => refusal.pattern.test(soql));
      if (refused) throw orgError(refused.errorCode, refused.message);
      const rows = this.read(this.withSemiJoinsRead(soql, all), all);
      if (rows === 'count') return { records: [], done: true, totalSize: this.counted };
      const locator = `/query/c${++this.opened}`;
      const cursor = { rows, total: rows.length };
      this.cursors.set(locator, cursor);
      return this.page(locator, cursor);
    });
  }

  private counted = 0;

  /** The rows `soql` answers, each with the columns it names; `'count'` for a `COUNT()`, its total in `counted`. */
  private read(soql: string, all: boolean): SoqlRow[] | 'count' {
    let statement = soql;
    let offset = 0;
    const offsetAt = / OFFSET (\d+)$/.exec(statement);
    if (offsetAt) {
      offset = Number(offsetAt[1]);
      if (offset > MOST_OFFSET) {
        throw orgError(
          'NUMBER_OUTSIDE_VALID_RANGE',
          `Maximum SOQL offset allowed is ${MOST_OFFSET}`,
        );
      }
      statement = statement.slice(0, offsetAt.index);
    }
    const grouped =
      /^SELECT (\w+), COUNT\(Id\) (\w+) FROM (\w+)((?: WHERE .+?)?) GROUP BY (\w+)$/.exec(
        statement,
      );
    if (grouped) {
      const [, field, alias, object, where, by] = grouped;
      if (this.uncountedIds.has(object)) {
        throw orgError('MALFORMED_QUERY', 'field Id does not support aggregate operator COUNT');
      }
      if (field !== by)
        throw orgError('MALFORMED_QUERY', `Field must be grouped or aggregated: ${field}`);
      const rows = this.selected(`SELECT ${field} FROM ${object}${where}`, all);
      const counts = new Map<string, { value: unknown; n: number }>();
      for (const row of rows) {
        const value = row[field];
        const key = String(value);
        const held = counts.get(key);
        if (held) held.n++;
        else counts.set(key, { value, n: 1 });
      }
      return [...counts.values()].map(({ value, n }) => ({ [field]: value, [alias]: n }));
    }
    // The org skips the offset's rows first, then reads up to its limit.
    let limit: number | undefined;
    const limitAt = / LIMIT (\d+)$/.exec(statement);
    if (offsetAt && limitAt) {
      limit = Number(limitAt[1]);
      statement = statement.slice(0, limitAt.index);
    }
    const parsed = parseSoql(statement);
    const skipped = this.selected(statement, all).slice(offset);
    const rows = limit === undefined ? skipped : skipped.slice(0, limit);
    if (parsed.columns === null) {
      this.counted = rows.length;
      return 'count';
    }
    const columns = parsed.columns;
    return rows.map((row) => Object.fromEntries(columns.map((c) => [c, row[c] ?? null])));
  }

  /**
   * Refuse a column of `object` its describe does not list, named anywhere
   * in `statement`: its select list, a comparison of its WHERE, its order or
   * its grouping, as the org refuses it before it reads a row.
   */
  private refuseUnknownColumns(statement: string, object: string): void {
    const known = this.columnsOf(object);
    if (!known) throw orgError('INVALID_TYPE', `sObject type '${object}' is not supported.`);
    const plain = withoutLiterals(statement);
    const named = new Set<string>();
    const select = /^SELECT (.+?) FROM /.exec(plain)?.[1] ?? '';
    for (const column of select.split(',')) {
      const name = column.trim().split(/\s+/)[0] ?? '';
      if (/^COUNT\(/i.test(name)) continue;
      named.add(name);
    }
    for (const [, name] of plain.matchAll(COMPARED)) named.add(name);
    for (const [, name] of plain.matchAll(/\b(?:ORDER|GROUP) BY ([A-Za-z_]\w*)/g)) named.add(name);
    for (const name of named) {
      if (name === '' || KEYWORDS.has(name.toLowerCase())) continue;
      if (!known.has(name.toLowerCase())) {
        throw orgError(
          'INVALID_FIELD',
          `No such column '${name}' on entity '${object}'. If you are attempting to use a custom ` +
            "field, be sure to append the '__c' after the custom field name. Please reference " +
            'your WSDL or the describe call for the appropriate names.',
        );
      }
    }
  }

  /**
   * `soql` with each semi-join, `IN (SELECT Column FROM Object [WHERE …])`,
   * read as the list of what its statement selects; a third one in a
   * statement, or one beside an OR, refused as a scratch org refused them.
   */
  private withSemiJoinsRead(soql: string, all: boolean): string {
    const semiJoin = /\bIN\s*\(\s*SELECT\s+(\w+)\s+FROM\s+(\w+)((?:\s+WHERE\s+[^()]+)?)\s*\)/gi;
    const found = soql.match(semiJoin) ?? [];
    if (found.length > 2) {
      throw orgError(
        'EXCEEDED_MAX_SEMIJOIN_SUBSELECTS',
        'Maximum 2 semi join sub-selects are allowed',
      );
    }
    if (found.length > 0 && /\bOR\b/i.test(withoutLiterals(soql.replace(semiJoin, '')))) {
      throw orgError(
        'MALFORMED_QUERY',
        "Semi join sub-selects are not allowed with the 'OR' operator",
      );
    }
    return soql.replace(semiJoin, (_whole, column: string, object: string, where: string) => {
      const values = this.selected(`SELECT ${column} FROM ${object}${where}`, all)
        .map((row) => row[column])
        .filter((value): value is string => typeof value === 'string');
      // An empty list is no statement the org reads: one no id can match.
      const listed = values.length > 0 ? values : ['000000000000000AAA'];
      return `IN (${listed.map((value) => `'${value}'`).join(', ')})`;
    });
  }

  /** The rows of the object `statement` reads that it selects, in its order, up to its limit. */
  private selected(statement: string, all: boolean): SoqlRow[] {
    const parsed = parseSoql(statement);
    this.refuseUnknownColumns(statement, parsed.object);
    if (
      this.slow.has(parsed.object) &&
      /\b[A-Za-z_]\w* = null\b/.test(withoutLiterals(statement))
    ) {
      throw orgError('QUERY_TIMEOUT', 'Your query request was running for too long.');
    }
    const rows = (this.rows.get(parsed.object) ?? []).filter(
      (row) => all || (row['IsDeleted'] !== true && row['IsArchived'] !== true),
    );
    return selectFrom(rows, parsed);
  }
}
