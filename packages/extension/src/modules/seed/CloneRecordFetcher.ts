/**
 * CloneRecordFetcher queries records from a source Salesforce org
 * using cursor-based pagination (queryMore) for the Clone pipeline.
 */

import type { Connection, DescribeSObjectResult } from 'jsforce';
import { assertSoqlIdentifier, assertSoqlWhere } from '../../core/common/soqlValidator.js';

/**
 * Reject a WHERE clause that is unreasonably long or does more than filter.
 * The fetcher appends `LIMIT` after it for previews, and a clause carrying its
 * own `LIMIT`, `FOR UPDATE` or comment would change what the clone reads; the
 * rule is the one the sync read and the bridge apply.
 */
function assertSafeWhereClause(where: string): string {
  if (where.length > 512) {
    throw new Error(`SOQL WHERE clause too long (${where.length} > 512 chars)`);
  }
  return assertSoqlWhere(where);
}

/** Logger function type for CloneRecordFetcher. */
export type CloneLogFn = (msg: string) => void;

/** Dependencies for CloneRecordFetcher. */
export interface CloneRecordFetcherDeps {
  /** Log function for info/debug output. */
  log: CloneLogFn;
}

/**
 * Fetches records from a source org for cloning.
 * Uses cursor-based pagination via `conn.queryMore()` instead of SOQL OFFSET
 * to support result sets larger than 2000 records.
 */
export class CloneRecordFetcher {
  private readonly log: CloneLogFn;
  /** Per org, each object's describe as first asked: see {@link describe}. */
  private readonly described = new WeakMap<
    Connection,
    Map<string, Promise<DescribeSObjectResult>>
  >();

  /** @param deps - Injected dependencies. */
  constructor(deps: CloneRecordFetcherDeps) {
    this.log = deps.log;
  }

  /**
   * The describe of an object in the org of `conn`, which this fetcher's
   * queries take their fields from: asked of the org once in the fetcher's
   * life, however many queries read the object. The clone orders its objects
   * by the lookups this describe says are read, and its preview samples
   * them: each asked the org again, and a preview of five objects described
   * the source ten times. One fetcher serves one preview or one run, so the
   * next one reads a field deployed in between.
   */
  describe(conn: Connection, objectApiName: string): Promise<DescribeSObjectResult> {
    let ofOrg = this.described.get(conn);
    if (!ofOrg) {
      ofOrg = new Map();
      this.described.set(conn, ofOrg);
    }
    let describe = ofOrg.get(objectApiName);
    if (!describe) {
      describe = conn.describe(objectApiName);
      ofOrg.set(objectApiName, describe);
    }
    return describe;
  }

  /**
   * Fetch all records for an object from the source org.
   * Automatically paginates using cursor-based `queryMore()`.
   *
   * @param conn - jsforce Connection to the source org.
   * @param objectApiName - The Salesforce object API name.
   * @param whereClause - Optional SOQL WHERE clause to filter records.
   * @returns Array of all matching records.
   */
  async fetchRecords(
    conn: Connection,
    objectApiName: string,
    whereClause?: string,
  ): Promise<Record<string, unknown>[]> {
    const fields = await this.getQueryFields(conn, objectApiName);
    const soql = this.buildSoql(fields, objectApiName, whereClause);
    const allRecords: Record<string, unknown>[] = [];

    let result = await conn.query<Record<string, unknown>>(soql);
    allRecords.push(...this.cleanRecords(result.records));

    while (!result.done && result.nextRecordsUrl) {
      result = await conn.queryMore<Record<string, unknown>>(result.nextRecordsUrl);
      allRecords.push(...this.cleanRecords(result.records));
    }

    this.log(`[CloneRecordFetcher] Fetched ${allRecords.length} records from ${objectApiName}`);
    return allRecords;
  }

  /**
   * Count matching records for an object.
   *
   * @param conn - jsforce Connection to the source org.
   * @param objectApiName - The Salesforce object API name.
   * @param whereClause - Optional SOQL WHERE clause.
   * @param sends - Conditions that keep only the rows a copy sends
   *   (`rowsACopySends`), built from checked names, never text from the user.
   * @returns Number of matching records.
   */
  async countRecords(
    conn: Connection,
    objectApiName: string,
    whereClause?: string,
    sends: readonly string[] = [],
  ): Promise<number> {
    const soql = `SELECT COUNT() FROM ${assertSoqlIdentifier(objectApiName)}${this.whereOf(whereClause, sends)}`;
    const result = await conn.query<Record<string, unknown>>(soql);
    return result.totalSize;
  }

  /**
   * Fetch a limited sample of records for preview purposes.
   * Does not use pagination since the result set is small.
   *
   * @param conn - jsforce Connection to the source org.
   * @param objectApiName - The Salesforce object API name.
   * @param limit - Maximum number of sample records to return.
   * @param whereClause - Optional SOQL WHERE clause.
   * @param sends - Conditions that keep only the rows a copy sends, as for
   *   {@link countRecords}.
   * @returns Array of sample records.
   */
  async fetchSample(
    conn: Connection,
    objectApiName: string,
    limit: number,
    whereClause?: string,
    sends: readonly string[] = [],
  ): Promise<Record<string, unknown>[]> {
    const fields = await this.getQueryFields(conn, objectApiName);
    let soql = this.buildSoql(fields, objectApiName, whereClause, sends);
    soql += ` LIMIT ${limit}`;

    const result = await conn.query<Record<string, unknown>>(soql);
    return this.cleanRecords(result.records);
  }

  /**
   * Get the list of fields to query: all createable fields plus Id and reference fields.
   */
  private async getQueryFields(conn: Connection, objectApiName: string): Promise<string[]> {
    const describe = await this.describe(conn, objectApiName);
    const fieldNames = new Set<string>();
    fieldNames.add('Id');

    for (const field of describe.fields) {
      if (field.createable || field.type === 'reference') {
        fieldNames.add(field.name);
      }
    }

    return Array.from(fieldNames);
  }

  /** Build SOQL query string. */
  private buildSoql(
    fields: string[],
    objectApiName: string,
    whereClause?: string,
    sends: readonly string[] = [],
  ): string {
    // Validate object name and where clause before interpolation to block
    // SOQL injection through caller-controlled inputs (Clone wizard / CLI).
    return `SELECT ${fields.join(', ')} FROM ${assertSoqlIdentifier(objectApiName)}${this.whereOf(whereClause, sends)}`;
  }

  /**
   * The WHERE of a query, or nothing: the caller's filter, checked, and the
   * conditions that keep only what a copy sends. The filter is bracketed when
   * they follow it, or an OR in it would reach past them.
   */
  private whereOf(whereClause: string | undefined, sends: readonly string[]): string {
    const filter = whereClause ? assertSafeWhereClause(whereClause) : undefined;
    if (sends.length === 0) return filter ? ` WHERE ${filter}` : '';
    return ` WHERE ${[...(filter ? [`(${filter})`] : []), ...sends].join(' AND ')}`;
  }

  /** Remove jsforce metadata attributes from records. */
  private cleanRecords(records: Record<string, unknown>[]): Record<string, unknown>[] {
    return records.map((r) => {
      const cleaned = { ...r };
      delete cleaned['attributes'];
      return cleaned;
    });
  }
}
