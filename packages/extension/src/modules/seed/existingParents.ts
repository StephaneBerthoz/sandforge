import type { Connection } from 'jsforce';
import type { SeedRelation } from '@sandforge/shared';
import { SEED_RELATION_LIMITS } from '@sandforge/shared';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
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

/** The ids one `Id IN (…)` names at most: a statement well inside what an org takes. */
const IDS_PER_QUERY = 200;

/** A record id as an org writes one: 15 letters and digits, or 18. */
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** A record's key whichever of its two forms it is given in: its first 15 characters. */
function recordKey(id: string): string {
  return id.slice(0, 15);
}

/**
 * Of `ids`, those of records of `objectApiName` the org holds, as it gives
 * them back. Each id is checked before it becomes query text, and they are
 * asked 200 to a query.
 */
export async function readPresentParentIds(
  conn: Pick<Connection, 'query' | 'queryMore'>,
  objectApiName: string,
  ids: readonly string[],
): Promise<string[]> {
  const object = assertSoqlIdentifier(objectApiName);
  for (const id of ids) {
    if (!RECORD_ID.test(id)) throw new Error(`Not a record id: "${id}".`);
  }
  const present: string[] = [];
  for (let at = 0; at < ids.length; at += IDS_PER_QUERY) {
    const list = ids
      .slice(at, at + IDS_PER_QUERY)
      .map((id) => `'${id}'`)
      .join(', ');
    let page = await conn.query<Record<string, unknown>>(
      `SELECT Id FROM ${object} WHERE Id IN (${list})`,
    );
    for (;;) {
      for (const record of page.records) {
        if (typeof record['Id'] === 'string') present.push(record['Id']);
      }
      if (page.done || !page.nextRecordsUrl) break;
      page = await conn.queryMore<Record<string, unknown>>(page.nextRecordsUrl);
    }
  }
  return present;
}

/** What the run reads of the org to check the parents a relation names by id. */
export interface RecordParentsOrg {
  /** The first three characters of the object's ids, when its describe gives them. */
  keyPrefixOf?: (objectApiName: string) => Promise<string | undefined>;
  /** Of the ids given, those of records of the object the org holds. */
  presentIds?: (objectApiName: string, ids: readonly string[]) => Promise<string[]>;
}

/** The ids a refusal names: the first five, and how many more. */
function named(ids: readonly string[]): string {
  const shown = ids.slice(0, 5).join(', ');
  return ids.length > 5 ? `${shown}, and ${ids.length - 5} more` : shown;
}

/**
 * Why a seed may not place children under the parents its relations name by
 * id, one reason per relation, or none: ids of another object than the
 * relation's parent — told by the key prefix the parent's describe gives,
 * when it gives one — or ids of records no longer in the org. Asked before
 * the run's first write: found at the child's turn, the run would have
 * written the objects before it and stopped with nothing to hang the
 * children from. An org that cannot be asked is a reason too.
 */
export async function recordParentsRefusals(
  relations: readonly SeedRelation[] | undefined,
  org: RecordParentsOrg,
): Promise<string[]> {
  const refusals: string[] = [];
  for (const relation of relations ?? []) {
    if (relation.parents.kind !== 'records') continue;
    const { childObject, lookupField, parentObject } = relation;
    const ids = relation.parents.ids;
    const name = `${childObject}.${lookupField}`;

    let prefix: string | undefined;
    try {
      prefix = await org.keyPrefixOf?.(parentObject);
    } catch {
      prefix = undefined;
    }
    const others = prefix ? ids.filter((id) => id.slice(0, 3) !== prefix) : [];
    if (others.length > 0) {
      refusals.push(
        `The relation on ${name} names ${others.length} id(s) that are not ${parentObject} ids — ` +
          `the org's ${parentObject} ids start with ${prefix}: ${named(others)}. Nothing was ` +
          `written. Give the ids of ${parentObject} records.`,
      );
      continue;
    }

    if (!org.presentIds) {
      refusals.push(
        `This run cannot check that the ${ids.length} ${parentObject} record(s) the relation on ` +
          `${name} names are in the org. Nothing was written.`,
      );
      continue;
    }
    let present: string[];
    try {
      present = await org.presentIds(parentObject, ids);
    } catch (err: unknown) {
      refusals.push(
        `Reading the ${parentObject} records the relation on ${name} names failed ` +
          `(${extractErrorMessage(err)}). Nothing was written.`,
      );
      continue;
    }
    const held = new Set(present.map(recordKey));
    const missing = ids.filter((id) => !held.has(recordKey(id)));
    if (missing.length > 0) {
      refusals.push(
        `${missing.length} of the ${ids.length} ${parentObject} record(s) the relation on ${name} ` +
          `names are no longer in the org: ${named(missing)}. Nothing was written. Run again what ` +
          `created them, or give the ids of ${parentObject} records the org holds.`,
      );
    }
  }
  return refusals;
}
