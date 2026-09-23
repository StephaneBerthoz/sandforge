import type { Connection } from 'jsforce';
import { SEED_RELATION_LIMITS } from '@sandforge/shared';
import { assertSoqlIdentifier, assertSoqlWhere } from '../../core/common/soqlValidator.js';

/**
 * Ids of records already in the org, for a seed relation that draws its
 * parents from there: at most `limit` records of `objectApiName` matching
 * `where`, in the order the org returns them.
 *
 * The object name and the filter come from a template, so both are checked
 * before they become query text — the filter by the rule the sync read and
 * the clone fetcher apply, which refuses a clause that goes on past the
 * filter (`LIMIT`, a subquery, a comment) — and the bound is the relation's.
 */
export async function readExistingParentIds(
  conn: Pick<Connection, 'query' | 'queryMore'>,
  objectApiName: string,
  where: string | undefined,
  limit: number,
): Promise<string[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > SEED_RELATION_LIMITS.maxExistingParents) {
    throw new Error(
      `A relation reads between 1 and ${SEED_RELATION_LIMITS.maxExistingParents} existing records, not ${limit}.`,
    );
  }
  const filter = where?.trim() ? ` WHERE ${assertSoqlWhere(where.trim())}` : '';
  const soql = `SELECT Id FROM ${assertSoqlIdentifier(objectApiName)}${filter} LIMIT ${limit}`;

  const ids: string[] = [];
  let page = await conn.query<Record<string, unknown>>(soql);
  for (;;) {
    for (const record of page.records) {
      if (typeof record['Id'] === 'string') ids.push(record['Id']);
    }
    // A page holds 2,000 records at most, and an org may be set to send
    // fewer: the rest of the bound comes back behind a cursor.
    if (page.done || !page.nextRecordsUrl || ids.length >= limit) break;
    page = await conn.queryMore<Record<string, unknown>>(page.nextRecordsUrl);
  }
  return ids.slice(0, limit);
}
