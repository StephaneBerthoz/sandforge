/**
 * SOQL query helpers with FIELDS() fallback and queryMore pagination.
 *
 * Provides resilient query execution for Salesforce orgs that may not
 * support the `FIELDS(ALL)` / `FIELDS(STANDARD)` syntax, and automatic
 * pagination via `queryMore` for result sets exceeding a single page.
 */
import type { Connection, QueryResult } from 'jsforce';

/** Default maximum number of records returned by queryAll before stopping pagination. */
const DEFAULT_MAX_RECORDS = 50_000;

/**
 * Execute a SOQL query and automatically paginate through all results
 * using `queryMore` when the response indicates more records are available.
 *
 * @param conn - The jsforce Connection to query against.
 * @param soql - The SOQL query string.
 * @param maxRecords - Safety cap on the total number of records to fetch (default: 50000).
 * @returns All records across all pages, capped at maxRecords.
 */
export async function queryAll<T extends Record<string, unknown>>(
  conn: Connection,
  soql: string,
  maxRecords: number = DEFAULT_MAX_RECORDS,
): Promise<T[]> {
  let result: QueryResult<T> = await conn.query<T>(soql);
  const records: T[] = [...result.records];

  while (!result.done && result.nextRecordsUrl && records.length < maxRecords) {
    result = await conn.queryMore<T>(result.nextRecordsUrl);
    records.push(...result.records);
  }

  if (records.length > maxRecords) {
    return records.slice(0, maxRecords);
  }

  return records;
}

/**
 * Build a fallback field list by calling `describe()` on the given object.
 *
 * When `FIELDS(ALL)` is requested, returns all queryable fields.
 * When `FIELDS(STANDARD)` is requested, returns only non-custom fields.
 *
 * @param conn - The jsforce Connection used for the describe call.
 * @param objectApiName - The SObject API name to describe.
 * @param mode - Whether to get all fields or only standard ones.
 * @returns A comma-separated field list string.
 */
async function buildFallbackFieldList(
  conn: Connection,
  objectApiName: string,
  mode: 'ALL' | 'STANDARD',
): Promise<string> {
  const desc = await conn.describe(objectApiName);
  const fields = (desc.fields as Array<{ name: string; custom?: boolean }>)
    .filter((f) => mode === 'ALL' || !f.custom)
    .map((f) => f.name);
  return fields.join(', ');
}

/**
 * Execute a SOQL query that uses `FIELDS(ALL)` or `FIELDS(STANDARD)`.
 *
 * If the org does not support the FIELDS() syntax, catches the error
 * and retries with an explicit field list obtained via `describe()`.
 * All results are automatically paginated via `queryMore`.
 *
 * @param conn - The jsforce Connection to query against.
 * @param objectApiName - The sanitized SObject API name used in the query.
 * @param soql - The original SOQL string containing FIELDS(ALL) or FIELDS(STANDARD).
 * @returns All matching records.
 */
export async function queryWithFieldsFallback<T extends Record<string, unknown>>(
  conn: Connection,
  objectApiName: string,
  soql: string,
): Promise<T[]> {
  try {
    return await queryAll<T>(conn, soql);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const isFieldsSyntaxError =
      message.includes('FIELDS(') ||
      message.includes('INVALID_FIELD') ||
      message.includes('MALFORMED_QUERY') ||
      message.includes('not supported');

    if (!isFieldsSyntaxError) {
      throw err;
    }

    // Determine which mode was used
    const mode: 'ALL' | 'STANDARD' = soql.includes('FIELDS(ALL)') ? 'ALL' : 'STANDARD';
    const fieldList = await buildFallbackFieldList(conn, objectApiName, mode);

    // Replace FIELDS(ALL) or FIELDS(STANDARD) with explicit field list
    const fallbackSoql = soql
      .replace(/FIELDS\(ALL\)/g, fieldList)
      .replace(/FIELDS\(STANDARD\)/g, fieldList);

    return await queryAll<T>(conn, fallbackSoql);
  }
}
