/**
 * CloneRecordFetcher queries records from a source Salesforce org
 * using cursor-based pagination (queryMore) for the Clone pipeline.
 */

import type { Connection } from 'jsforce';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';

/**
 * Reject SOQL WHERE-clause inputs that contain comment markers, statement
 * separators, or are unreasonably long. Mirrors the Forge schema defense
 * (forge.schema.ts) so all SOQL builders share the same minimum baseline.
 */
function assertSafeWhereClause(where: string): string {
  if (where.length > 512) {
    throw new Error(`SOQL WHERE clause too long (${where.length} > 512 chars)`);
  }
  if (/--|\/\*|\*\/|;\s*$/.test(where)) {
    throw new Error('SOQL WHERE clause contains forbidden comment marker or trailing semicolon');
  }
  return where;
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

  /** @param deps - Injected dependencies. */
  constructor(deps: CloneRecordFetcherDeps) {
    this.log = deps.log;
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
   * @returns Number of matching records.
   */
  async countRecords(
    conn: Connection,
    objectApiName: string,
    whereClause?: string,
  ): Promise<number> {
    let soql = `SELECT COUNT() FROM ${assertSoqlIdentifier(objectApiName)}`;
    if (whereClause) {
      soql += ` WHERE ${assertSafeWhereClause(whereClause)}`;
    }
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
   * @returns Array of sample records.
   */
  async fetchSample(
    conn: Connection,
    objectApiName: string,
    limit: number,
    whereClause?: string,
  ): Promise<Record<string, unknown>[]> {
    const fields = await this.getQueryFields(conn, objectApiName);
    let soql = this.buildSoql(fields, objectApiName, whereClause);
    soql += ` LIMIT ${limit}`;

    const result = await conn.query<Record<string, unknown>>(soql);
    return this.cleanRecords(result.records);
  }

  /**
   * Get the list of fields to query: all createable fields plus Id and reference fields.
   */
  private async getQueryFields(conn: Connection, objectApiName: string): Promise<string[]> {
    const describe = await conn.describe(objectApiName);
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
  private buildSoql(fields: string[], objectApiName: string, whereClause?: string): string {
    // Validate object name and where clause before interpolation to block
    // SOQL injection through caller-controlled inputs (Clone wizard / CLI).
    let soql = `SELECT ${fields.join(', ')} FROM ${assertSoqlIdentifier(objectApiName)}`;
    if (whereClause) {
      soql += ` WHERE ${assertSafeWhereClause(whereClause)}`;
    }
    return soql;
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
