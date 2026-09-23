/**
 * Records the platform owns or makes, and records it refuses to hold twice
 * without saying which one it holds.
 *
 * A copy learns each of these against a real org, and each module used to
 * learn it again for itself: Forge found the direct account-contact relation
 * and the product selling model's key, Frozen Dataset found the order born a
 * draft. One copy of each rule, so the next module that writes records reads
 * it here instead of rediscovering it on a live run.
 */

import { SELLING_MODEL_OPTION_OBJECT } from '@sandforge/shared';
import { assertSoqlIdentifier, sanitizeSoqlValue } from './soqlValidator.js';

/** A SOQL query against the target org, answering the rows it read. */
export type SoqlQuery = (soql: string) => Promise<ReadonlyArray<Record<string, unknown>>>;

/** The join Salesforce creates for a contact inserted with an account. */
export const ACCOUNT_CONTACT_RELATION = 'AccountContactRelation';

/** Contacts per `IN` list when the direct relations are looked up. */
const DIRECT_RELATION_CHUNK = 200;

/**
 * Objects the platform keeps unique on a combination of fields, which a
 * refusal names without naming the record. A product selling model is one
 * per selling model type, pricing term and unit: run for real, a clone was
 * refused "a product selling model already exists for this combination", and
 * every price and line pointing at it lost the link.
 */
export const NATURAL_KEYS: Readonly<Record<string, readonly string[]>> = {
  ProductSellingModel: ['SellingModelType', 'PricingTerm', 'PricingTermUnit'],
};

/**
 * Objects whose status follows a lifecycle, and the object listing each
 * status with its category. A record is born in the Draft category and moves
 * on afterwards — run for real, an activated order was refused: "for a new
 * order, choose Draft" — and an order takes its products only as a draft.
 */
export const STATUS_LIFECYCLES: Readonly<Record<string, string>> = {
  Order: 'OrderStatus',
  Contract: 'ContractStatus',
};

/** A value as a SOQL literal. */
function soqlLiteral(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return `'${sanitizeSoqlValue(String(value))}'`;
}

/**
 * The direct relations the platform created for the contacts a run inserted,
 * by the index of the payload that describes each.
 *
 * A contact inserted with its account gets its direct relation from the
 * platform, and the relation read from the source is that one: inserted
 * again it is refused — "the contact already has a relationship with this
 * account" — and the refusal names no record to link to. The payloads carry
 * target ids already; a relation is direct when the target holds one for the
 * same account and contact.
 */
export async function directAccountContactRelations(
  query: SoqlQuery,
  records: readonly Record<string, unknown>[],
): Promise<Map<number, string>> {
  const found = new Map<number, string>();
  const contactIds = [
    ...new Set(
      records
        .map((r) => r['ContactId'])
        .filter((id): id is string => typeof id === 'string' && id !== ''),
    ),
  ];
  if (contactIds.length === 0) return found;
  const byPair = new Map<string, string>();
  for (let i = 0; i < contactIds.length; i += DIRECT_RELATION_CHUNK) {
    const inList = contactIds
      .slice(i, i + DIRECT_RELATION_CHUNK)
      .map((id) => `'${sanitizeSoqlValue(id)}'`)
      .join(', ');
    const rows = await query(
      `SELECT Id, AccountId, ContactId FROM ${ACCOUNT_CONTACT_RELATION} ` +
        `WHERE IsDirect = true AND ContactId IN (${inList})`,
    );
    for (const row of rows) {
      if (typeof row['Id'] === 'string') {
        byPair.set(`${String(row['AccountId'])}|${String(row['ContactId'])}`, row['Id']);
      }
    }
  }
  records.forEach((r, i) => {
    const id = byPair.get(`${String(r['AccountId'])}|${String(r['ContactId'])}`);
    if (id) found.set(i, id);
  });
  return found;
}

/**
 * Of the price book entries `ids`, the ones in the standard price book.
 *
 * A standard price goes only once the custom prices of its product have:
 * asked for both in one delete call, the target refuses the standard one with
 * an `UNKNOWN_EXCEPTION` — the insert's rule, run backwards. Learnt by the
 * Frozen purge first, and again by Forge's run removal, which left 33
 * standard prices behind, and the products and options they held, the first
 * time a clone's prices went in one call.
 */
export async function standardPriceIds(
  query: SoqlQuery,
  ids: readonly string[],
): Promise<Set<string>> {
  const standard = new Set<string>();
  for (let i = 0; i < ids.length; i += DIRECT_RELATION_CHUNK) {
    const inList = ids
      .slice(i, i + DIRECT_RELATION_CHUNK)
      .map((id) => `'${sanitizeSoqlValue(id)}'`)
      .join(', ');
    const rows = await query(
      `SELECT Id FROM PricebookEntry WHERE Id IN (${inList}) AND Pricebook2.IsStandard = true`,
    );
    for (const row of rows) {
      if (typeof row['Id'] === 'string') standard.add(row['Id']);
    }
  }
  return standard;
}

/** Products per `IN` list when the selling model options are looked up. */
const OPTION_CHUNK = 200;

/**
 * The selling model options the target already holds for the product and
 * selling model a payload names, by the index of the payload.
 *
 * A product sells under a model through one option, and a clone whose
 * product the target already held — linked, not created — finds that option
 * there. Looked up before the insert rather than read from a refusal: which
 * words the platform refuses a second option in is not something a copy
 * should have to learn. The payloads carry target ids already.
 */
export async function existingSellingModelOptions(
  query: SoqlQuery,
  records: readonly Record<string, unknown>[],
): Promise<Map<number, string>> {
  const found = new Map<number, string>();
  const products = [
    ...new Set(
      records
        .map((r) => r['Product2Id'])
        .filter((id): id is string => typeof id === 'string' && id !== ''),
    ),
  ];
  if (products.length === 0) return found;
  const byPair = new Map<string, string>();
  for (let i = 0; i < products.length; i += OPTION_CHUNK) {
    const inList = products
      .slice(i, i + OPTION_CHUNK)
      .map((id) => `'${sanitizeSoqlValue(id)}'`)
      .join(', ');
    const rows = await query(
      `SELECT Id, Product2Id, ProductSellingModelId FROM ${SELLING_MODEL_OPTION_OBJECT} ` +
        `WHERE Product2Id IN (${inList})`,
    );
    for (const row of rows) {
      if (typeof row['Id'] === 'string') {
        byPair.set(
          `${String(row['Product2Id'])}|${String(row['ProductSellingModelId'])}`,
          row['Id'],
        );
      }
    }
  }
  records.forEach((r, i) => {
    const id = byPair.get(`${String(r['Product2Id'])}|${String(r['ProductSellingModelId'])}`);
    if (id) found.set(i, id);
  });
  return found;
}

/**
 * The one target record holding each payload's natural key, by payload
 * index — or nothing where none, or more than one, does.
 */
export async function recordsByNaturalKey(
  query: SoqlQuery,
  objectApiName: string,
  keyFields: readonly string[],
  payloads: readonly Record<string, unknown>[],
): Promise<Array<string | undefined>> {
  const byKey = new Map<string, string | undefined>();
  for (const payload of payloads) {
    const key = JSON.stringify(keyFields.map((f) => payload[f] ?? null));
    if (byKey.has(key)) continue;
    const where = keyFields
      .map((f) => `${assertSoqlIdentifier(f)} = ${soqlLiteral(payload[f])}`)
      .join(' AND ');
    const rows = await query(
      `SELECT Id FROM ${assertSoqlIdentifier(objectApiName)} WHERE ${where} LIMIT 2`,
    );
    byKey.set(
      key,
      rows.length === 1 && typeof rows[0]['Id'] === 'string' ? rows[0]['Id'] : undefined,
    );
  }
  return payloads.map((p) => byKey.get(JSON.stringify(keyFields.map((f) => p[f] ?? null))));
}

/** A lifecycle's statuses in the target, each with its category. */
export interface StatusCategories {
  /** Status API name → its category (`Draft`, `Activated`, …). */
  categoryOf: Map<string, string>;
  /** One status of the Draft category, when the target has any. */
  draft: string | undefined;
}

/**
 * The target's statuses for a lifecycle object, each with its category, and
 * one status of the Draft category — or nothing, when the target cannot say
 * (the object is not enabled there).
 *
 * The categories are the target's own — `OrderStatus` and `ContractStatus`
 * list every value with its category — so nothing about a customised
 * picklist is guessed.
 */
export async function statusCategories(
  query: SoqlQuery,
  lifecycle: string,
): Promise<StatusCategories | undefined> {
  let rows: ReadonlyArray<Record<string, unknown>>;
  try {
    rows = await query(`SELECT ApiName, StatusCode FROM ${assertSoqlIdentifier(lifecycle)}`);
  } catch {
    return undefined;
  }
  return {
    categoryOf: new Map(rows.map((row) => [String(row['ApiName']), String(row['StatusCode'])])),
    draft: rows
      .filter((row) => row['StatusCode'] === 'Draft')
      .map((row) => String(row['ApiName']))
      .sort()[0],
  };
}

/**
 * The Draft status a record has to be inserted with, when its own status is
 * past Draft — or nothing, when it can go in as it is: no status, a status in
 * the Draft category, one the target does not know (the insert will say), or
 * a target with no Draft status to start from.
 */
export function draftStartOf(status: unknown, categories: StatusCategories): string | undefined {
  if (typeof status !== 'string' || status === '' || !categories.draft) return undefined;
  const category = categories.categoryOf.get(status);
  if (category === undefined || category === 'Draft') return undefined;
  return categories.draft;
}
