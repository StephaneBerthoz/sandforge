/**
 * The opportunities a load leaves unsynced with the quote the source syncs
 * them with, so that it keeps the products it wrote under them.
 *
 * While an opportunity syncs with a quote (`Opportunity.SyncedQuoteId`), the
 * platform keeps the opportunity's products and the quote's lines the same,
 * and syncing a quote makes the opportunity's products the quote's lines
 * (Salesforce Help, "How Quote Syncing Works"). A load writes the opportunity
 * first, then its quote and its products, and sets the synced quote in its
 * second pass, once the quote has an id. Run on a scratch org, the dataset of
 * an opportunity with two products and its synced quote, QuoteLineItem
 * excluded, went in whole; the second pass set the synced quote, and the
 * platform deleted the two products the load had just written: read back
 * deleted, the opportunity's amount 0, and the load said every record had
 * gone in. The same dataset with the quote's lines kept its two products.
 *
 * So the second pass sets an opportunity's synced quote only where the load
 * wrote under that quote as many lines as it wrote products under the
 * opportunity. One with fewer is left unsynced, its products kept, and the
 * load says so; a preview says it the same way, from what it would write.
 */

import type { FrozenLeftToThePlatform } from '@sandforge/shared';

/** The opportunity, whose `SyncedQuoteId` names the quote it syncs with. */
export const OPPORTUNITY_OBJECT = 'Opportunity';
/** The opportunity's lookup at the quote it syncs with. */
export const SYNCED_QUOTE_FIELD = 'SyncedQuoteId';
/** The opportunity's products. */
const OPPORTUNITY_LINE_OBJECT = 'OpportunityLineItem';
/** The quote's lines. */
export const QUOTE_LINE_OBJECT = 'QuoteLineItem';

/** The records of a dataset as a load aligns them, per object: lookups name other records by their referenceId. */
export type AlignedRecords = ReadonlyMap<
  string,
  ReadonlyArray<{
    readonly referenceId: string;
    readonly fields: Readonly<Record<string, unknown>>;
  }>
>;

/** An opportunity left unsynced with its quote: what the load wrote under each. */
export interface QuoteLeftUnsynced {
  /** The opportunity, by its referenceId. */
  opportunity: string;
  /** The quote the source syncs it with, by its referenceId. */
  quote: string;
  /** The products the load wrote under the opportunity. */
  products: number;
  /** The lines the load wrote under the quote. */
  lines: number;
}

/**
 * Of the opportunities `written` holds, those whose synced quote `written`
 * holds too, with fewer lines written under the quote than products under
 * the opportunity: synced, the platform would replace those products with
 * the quote's lines. In the order the records name them.
 *
 * @param written - Whether the load wrote a record, by its referenceId:
 *   inserted or linked to the target's own.
 */
export function quotesLeftUnsynced(
  records: AlignedRecords,
  written: (referenceId: string) => boolean,
): QuoteLeftUnsynced[] {
  const under = (objectApiName: string, field: string): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const { referenceId, fields } of records.get(objectApiName) ?? []) {
      const parent = fields[field];
      if (typeof parent !== 'string' || parent === '' || !written(referenceId)) continue;
      counts.set(parent, (counts.get(parent) ?? 0) + 1);
    }
    return counts;
  };
  const productsOf = under(OPPORTUNITY_LINE_OBJECT, 'OpportunityId');
  const linesOf = under(QUOTE_LINE_OBJECT, 'QuoteId');
  const quotes = new Set((records.get('Quote') ?? []).map((quote) => quote.referenceId));
  const left: QuoteLeftUnsynced[] = [];
  for (const { referenceId, fields } of records.get(OPPORTUNITY_OBJECT) ?? []) {
    const quote = fields[SYNCED_QUOTE_FIELD];
    if (typeof quote !== 'string' || !quotes.has(quote)) continue;
    if (!written(referenceId) || !written(quote)) continue;
    const products = productsOf.get(referenceId) ?? 0;
    const lines = linesOf.get(quote) ?? 0;
    if (products > lines) left.push({ opportunity: referenceId, quote, products, lines });
  }
  return left;
}

/**
 * What a load, or its preview (`would`), says of the opportunities it leaves
 * unsynced with their quote: `1 left unsynced with its quote: the load wrote
 * 2 of its products and none of the quote's lines, which excludedObjects
 * leaves out — synced, the platform replaces an opportunity's products with
 * its quote's lines; SyncedQuoteId left empty, the products kept`. Undefined
 * when there are none.
 *
 * @param linesExcluded - Whether `excludedObjects` leaves out the quotes' lines.
 */
export function quotesLeftUnsyncedNote(
  left: readonly QuoteLeftUnsynced[],
  linesExcluded: boolean,
  would = false,
): FrozenLeftToThePlatform | undefined {
  if (left.length === 0) return undefined;
  const one = left.length === 1;
  const products = left.reduce((sum, l) => sum + l.products, 0);
  const lines = left.reduce((sum, l) => sum + l.lines, 0);
  const its = one ? 'its' : 'their';
  const quotes = one ? "the quote's" : "the quotes'";
  const linesWritten = lines === 0 ? `none of ${quotes} lines` : `${lines} of ${quotes} lines`;
  const why = linesExcluded && lines === 0 ? ', which excludedObjects leaves out' : '';
  return {
    objectApiName: OPPORTUNITY_OBJECT,
    count: left.length,
    note:
      `${left.length} ${would ? 'would be ' : ''}left unsynced with ${its} quote: the load ` +
      `${would ? 'would write' : 'wrote'} ${products} of ${its} products ` +
      `and ${linesWritten}${why} — synced, the platform replaces an opportunity's products with ` +
      `its quote's lines; ${SYNCED_QUOTE_FIELD} left empty, the products kept`,
  };
}
