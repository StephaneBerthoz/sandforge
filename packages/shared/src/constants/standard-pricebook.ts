/**
 * The standard price book, and why a clone has to know about it.
 *
 * Salesforce will not accept a price for a product in a custom price book
 * until that product has a price in the standard one. The rule is not in any
 * describe: `PricebookEntry` looks like an ordinary child of `Pricebook2` and
 * `Product2`, and the refusal only arrives at the insert, as
 * `STANDARD_PRICE_NOT_DEFINED`. Run between two real sandboxes, that is what
 * every line item of a cloned opportunity came down to — the products were
 * copied, their custom prices were read correctly, and the target had no
 * standard price to hang them on.
 *
 * The standard price book itself is never cloned. Every org has exactly one
 * and it cannot be created, so it is matched: `IsStandard = true` on each
 * side, and the two ids registered with each other. (In a sandbox freshly
 * taken from its source the two are the same id, because a refresh keeps the
 * ids of what it copied — which is exactly the case where an id-based match
 * would look like it worked for the wrong reason, and a name-based one would
 * break on a localised org.)
 *
 * So a clone that carries `PricebookEntry` reads the standard entries of the
 * products in scope alongside the custom ones, and writes them first.
 */

/** The join between a product and a price book. */
export const PRICEBOOK_ENTRY_OBJECT = 'PricebookEntry';

/** The price book object itself. */
export const PRICEBOOK_OBJECT = 'Pricebook2';

/** The field on a price book entry that says which book it belongs to. */
export const PRICEBOOK_ENTRY_BOOK_FIELD = 'Pricebook2Id';

/**
 * Finds the one standard price book of an org.
 *
 * `IsStandard` rather than the name: the name is localised, and an org in
 * French answers "Catalogue de prix standard".
 */
export const STANDARD_PRICEBOOK_SOQL = 'SELECT Id FROM Pricebook2 WHERE IsStandard = true LIMIT 1';

/** Whether this object is the one the rule above applies to. */
export function isPricebookEntry(objectApiName: string): boolean {
  return objectApiName === PRICEBOOK_ENTRY_OBJECT;
}

/**
 * Split price book entries into the ones that have to be written first and
 * the rest.
 *
 * `standardPricebookId` is the **source** id, because the split is made on
 * rows as they were read. An empty first half means nothing needs ordering
 * and the caller can write in one round as before.
 */
export function splitStandardPricebookEntries<T extends Record<string, unknown>>(
  records: readonly T[],
  standardPricebookId: string | null,
): { standard: T[]; custom: T[] } {
  if (!standardPricebookId) return { standard: [], custom: [...records] };
  const standard: T[] = [];
  const custom: T[] = [];
  for (const record of records) {
    if (record[PRICEBOOK_ENTRY_BOOK_FIELD] === standardPricebookId) standard.push(record);
    else custom.push(record);
  }
  return { standard, custom };
}

/** The field naming the product a price book entry prices. */
export const PRICEBOOK_ENTRY_PRODUCT_FIELD = 'Product2Id';

/**
 * The field naming the selling model a price applies to, in an org that sells
 * by selling models: one-time, evergreen, term-defined.
 */
export const PRICEBOOK_ENTRY_SELLING_MODEL_FIELD = 'ProductSellingModelId';

/** A selling model: how a product is sold, one per type, term and unit. */
export const SELLING_MODEL_OBJECT = 'ProductSellingModel';

/**
 * What lets a product be sold under a selling model.
 *
 * The same kind of rule as the standard price, and as invisible: the
 * platform refuses a price for a product under a selling model the product
 * has no option for — "add a product selling model option to the product
 * first" — standard price included. Run between two sandboxes, every price
 * of a cloned opportunity was refused that way, and every line item behind
 * them was skipped.
 */
export const SELLING_MODEL_OPTION_OBJECT = 'ProductSellingModelOption';

/** How {@link dedupePricebookEntries} tells two entries apart. */
export interface PricebookEntryKey {
  /**
   * Whether the entry's selling model is part of its key. True when the
   * clone carries the selling models, so the lookup is written: a book then
   * holds one entry per product and selling model, and a product priced both
   * with a selling model and without one keeps both prices.
   */
  sellingModel?: boolean;
}

/**
 * The field an org with several currencies gives every record, a price
 * included. Absent from an org with one currency.
 */
const CURRENCY_FIELD = 'CurrencyIsoCode';

/**
 * Keep one entry per (book, product), preferring the active one — per (book,
 * product, selling model) when `key.sellingModel` says so, and per currency in
 * an org with several.
 *
 * A price book holds at most one entry per product, and the target enforces
 * it on insert whatever `IsActive` says. A source org can still hold two —
 * one deactivated, one live — and a real pair of sandboxes did: sending both
 * cost the second a `DUPLICATE_VALUE`, and with it the mapping every line
 * item needed to point at its price.
 *
 * Those two differed by their selling model: the deactivated price had none,
 * the live one had the org's one-time model. Written without selling models
 * they are the same entry, and the rule above holds. Written with them they
 * are two, and read the first way the clone dropped half the standard prices
 * of the products it carried — the ones its custom prices needed.
 *
 * An org with several currencies holds a product's price once per currency,
 * and a custom price needs the standard one of its own currency: the currency
 * a row carries is part of its key.
 *
 * Order is otherwise preserved, and a row missing either field is left alone:
 * it cannot collide on a pair it does not have.
 */
export function dedupePricebookEntries<T extends Record<string, unknown>>(
  records: readonly T[],
  key: PricebookEntryKey = {},
): T[] {
  const byPair = new Map<string, number>();
  const kept: T[] = [];
  for (const record of records) {
    const book = record[PRICEBOOK_ENTRY_BOOK_FIELD];
    const product = record[PRICEBOOK_ENTRY_PRODUCT_FIELD];
    if (typeof book !== 'string' || typeof product !== 'string') {
      kept.push(record);
      continue;
    }
    const sellingModel = key.sellingModel
      ? `|${String(record[PRICEBOOK_ENTRY_SELLING_MODEL_FIELD] ?? '')}`
      : '';
    const currency = `|${String(record[CURRENCY_FIELD] ?? '')}`;
    const pair = `${book}|${product}${sellingModel}${currency}`;
    const seenAt = byPair.get(pair);
    if (seenAt === undefined) {
      byPair.set(pair, kept.length);
      kept.push(record);
      continue;
    }
    // A live price says more about the product than a retired one.
    if (record['IsActive'] === true && kept[seenAt]['IsActive'] !== true) {
      kept[seenAt] = record;
    }
  }
  return kept;
}
