/**
 * The objects an active duplicate rule watches in an org, which a seed writes
 * through the REST API rather than a Bulk API job.
 *
 * A seed's inserts carry the header that lets a duplicate rule's matches be
 * saved: the rows are invented, and land in an org that may already hold rows
 * like them. A Bulk API job carries no header, and the panel sends an object
 * of more than 200 records as one: run into a new Developer Edition, Sales
 * Cloud Starter's 500 accounts went as a job, and the org's standard account
 * rule refused 296 of them with DUPLICATES_DETECTED — and with them their
 * contacts, opportunities and line items. Such an object is written 200
 * records a call through REST, with the header; any other still goes as a job.
 */

const ACTIVE_DUPLICATE_RULES = 'SELECT SobjectType FROM DuplicateRule WHERE IsActive = true';

/**
 * The objects an active duplicate rule watches, or undefined when the org
 * will not say: the caller then writes as it did, and says so.
 */
export async function objectsUnderDuplicateRules(conn: {
  query: (soql: string) => PromiseLike<{ records: Array<Record<string, unknown>> }>;
}): Promise<ReadonlySet<string> | undefined> {
  try {
    const answer = await conn.query(ACTIVE_DUPLICATE_RULES);
    return new Set(
      answer.records.flatMap((row) =>
        typeof row['SobjectType'] === 'string' ? [row['SobjectType']] : [],
      ),
    );
  } catch {
    return undefined;
  }
}
