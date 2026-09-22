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
  return (await queryAllBounded<T>(conn, soql, maxRecords)).records;
}

/**
 * The same read, saying whether a bound cut it short.
 *
 * `queryAll` answers with an array and nothing else, so a caller cannot tell
 * a complete read from one that stopped at the cap — or at a `LIMIT` the
 * caller itself put in the statement, which is how DataOps took a backup of
 * the first two thousand rows of an object and called it done. For a backup
 * that is the worst of the failures available: it is the thing a user relies
 * on before doing something destructive, and a partial one looks exactly like
 * a complete one.
 *
 * `truncated` is true when the page walk stopped with more to come, or when
 * the rows reached the cap exactly — the statement's own `LIMIT` lands there,
 * and a read that stopped precisely on a bound is not one anybody should
 * assume is complete.
 */
export async function queryAllBounded<T extends Record<string, unknown>>(
  conn: Connection,
  soql: string,
  maxRecords: number = DEFAULT_MAX_RECORDS,
): Promise<{ records: T[]; truncated: boolean }> {
  let result: QueryResult<T> = await conn.query<T>(soql);
  const records: T[] = [...result.records];

  while (!result.done && result.nextRecordsUrl && records.length < maxRecords) {
    result = await conn.queryMore<T>(result.nextRecordsUrl);
    records.push(...result.records);
  }

  // More pages were waiting when the walk stopped.
  const stoppedEarly = !result.done && Boolean(result.nextRecordsUrl);

  if (records.length > maxRecords) {
    return { records: records.slice(0, maxRecords), truncated: true };
  }

  return { records, truncated: stoppedEarly || records.length === maxRecords };
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

/** The largest LIMIT Salesforce accepts on a `FIELDS(ALL)` query. */
const FIELDS_ALL_MAX_LIMIT = 200;

/**
 * Error codes an org answers a FIELDS() query with when it will not run it.
 *
 * jsforce carries the code in `errorCode` (and `name`), not in the message:
 * the message is the platform's prose, such as "The SOQL FIELDS function must
 * have a LIMIT of at most 200", which names neither the code nor the query.
 * Matching on the message alone let that refusal through as a failure.
 */
const FIELDS_REFUSAL_CODES: ReadonlySet<string> = new Set(['MALFORMED_QUERY', 'INVALID_FIELD']);

/** Whether an error is the org refusing the FIELDS() form of the query. */
function isFieldsRefusal(err: unknown): boolean {
  const errorCode =
    typeof err === 'object' && err !== null && 'errorCode' in err ? err.errorCode : undefined;
  if (typeof errorCode === 'string' && FIELDS_REFUSAL_CODES.has(errorCode)) return true;
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('FIELDS(') ||
    message.includes('INVALID_FIELD') ||
    message.includes('MALFORMED_QUERY') ||
    message.includes('not supported')
  );
}

/**
 * Whether the query asks `FIELDS(ALL)` for more rows than the platform allows:
 * a LIMIT above 200, or no LIMIT at all. Such a query is refused every time.
 */
function exceedsFieldsAllLimit(soql: string): boolean {
  if (!soql.includes('FIELDS(ALL)')) return false;
  const limit = /\bLIMIT\s+(\d+)/i.exec(soql);
  return limit === null || Number(limit[1]) > FIELDS_ALL_MAX_LIMIT;
}

/**
 * The longest query, URL-encoded, sent with an inlined field list. jsforce sends
 * a query as a GET with the SOQL in `?q=`, so every described field lengthens
 * the URL, and on an object with hundreds of fields it can pass the size a
 * server accepts for a request line (commonly 16 KB). Not measured against an org.
 */
const MAX_ENCODED_QUERY_CHARS = 15_000;

/** The query with FIELDS(ALL) or FIELDS(STANDARD) replaced by the described field list. */
async function describedQuery(
  conn: Connection,
  objectApiName: string,
  soql: string,
): Promise<string> {
  const mode: 'ALL' | 'STANDARD' = soql.includes('FIELDS(ALL)') ? 'ALL' : 'STANDARD';
  const fieldList = await buildFallbackFieldList(conn, objectApiName, mode);
  return soql.replace(/FIELDS\(ALL\)/g, fieldList).replace(/FIELDS\(STANDARD\)/g, fieldList);
}

/**
 * Execute a SOQL query that uses `FIELDS(ALL)` or `FIELDS(STANDARD)`.
 *
 * A `FIELDS(ALL)` query above the platform's 200-row bound is not sent: it
 * would be refused, so the explicit field list obtained via `describe()` is
 * used straight away, with the query's own LIMIT. When that list makes the
 * query too long for its URL and the query has a LIMIT, `FIELDS(ALL)` is sent
 * at 200 rows instead: a smaller sample that runs. Without a LIMIT the long
 * query is still sent, since capping it would silently drop records the caller
 * reads in full. Any other query is tried as written, and retried with the
 * field list if the org refuses its FIELDS() form. All results are
 * automatically paginated via `queryMore`.
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
  if (exceedsFieldsAllLimit(soql)) {
    const described = await describedQuery(conn, objectApiName, soql);
    const limit = /\bLIMIT\s+\d+/i;
    if (encodeURIComponent(described).length > MAX_ENCODED_QUERY_CHARS && limit.test(soql)) {
      return queryAll<T>(conn, soql.replace(limit, `LIMIT ${FIELDS_ALL_MAX_LIMIT}`));
    }
    return queryAll<T>(conn, described);
  }
  try {
    return await queryAll<T>(conn, soql);
  } catch (err: unknown) {
    if (!isFieldsRefusal(err)) {
      throw err;
    }
    return await queryAll<T>(conn, await describedQuery(conn, objectApiName, soql));
  }
}
