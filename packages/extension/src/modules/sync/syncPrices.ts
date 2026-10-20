/**
 * The price books and prices of a Sync run, as the platform takes them.
 *
 * Run between two scratch orgs, a sync of a catalog and of an opportunity's
 * lines wrote neither a price nor a line. Every org has one standard price
 * book, which no copy can create, and the run sent the standard prices with
 * the source's id of it: `REQUIRED_FIELD_MISSING [Pricebook2Id]`. A custom
 * price is refused for a product with no standard price in its currency, and
 * the run sent both in one call: `STANDARD_PRICE_NOT_DEFINED`. And a price in
 * a currency the target lacks, written in the corporate one, is the product's
 * own price in that currency twice in the book. The lines, which cannot go
 * without their price, were all held back.
 *
 * So the standard price book is matched — the source's linked to the target's,
 * and never written — the standard prices go in calls of their own before the
 * custom ones, and a price in a currency the target does not hold active is
 * left out where the run writes the source's own price of the same product,
 * book and selling model in the currency it would go in: linked to that one,
 * which a line pointing at it is pointed at, as Forge does
 * (`settlePriceCurrencies`).
 */

import {
  PRICEBOOK_ENTRY_BOOK_FIELD,
  PRICEBOOK_ENTRY_OBJECT,
  PRICEBOOK_ENTRY_SELLING_MODEL_FIELD,
  PRICEBOOK_OBJECT,
  STANDARD_PRICEBOOK_SOQL,
} from '@sandforge/shared';
import type { SoqlQuery } from '../../core/common/platformRecords.js';
import { replacementCurrency, type RunCurrencies } from '../../core/common/recordCurrencies.js';
import { describePriceCurrencies, settlePriceCurrencies } from '../forge/stages/PriceCurrencies.js';

/** Each org's standard price book. */
export interface StandardPricebooks {
  readonly source: string;
  readonly target: string;
}

/**
 * Both orgs' standard price books, or nothing when either read fails or an
 * org answers none.
 */
export async function readStandardPricebooks(
  source: SoqlQuery,
  target: SoqlQuery,
): Promise<StandardPricebooks | undefined> {
  try {
    const [inSource, inTarget] = await Promise.all([
      source(STANDARD_PRICEBOOK_SOQL),
      target(STANDARD_PRICEBOOK_SOQL),
    ]);
    const sourceId = inSource[0]?.['Id'];
    const targetId = inTarget[0]?.['Id'];
    return typeof sourceId === 'string' && typeof targetId === 'string'
      ? { source: sourceId, target: targetId }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a write of `objectApiName` needs the standard price book matched. */
export function namesAPricebook(
  objectApiName: string,
  sources: ReadonlyArray<Record<string, unknown>>,
): boolean {
  return (
    objectApiName === PRICEBOOK_OBJECT ||
    sources.some((row) => typeof row[PRICEBOOK_ENTRY_BOOK_FIELD] === 'string')
  );
}

/** The rows of one object's write, the records and the source rows they come from, side by side. */
export interface SyncRows {
  readonly records: Record<string, unknown>[];
  readonly sources: Record<string, unknown>[];
  readonly sourceIds: Array<string | undefined>;
}

/** What {@link settleSyncPrices} made of a write. */
export interface SettledSyncRows extends SyncRows {
  /** A price left out, by its source id, and the price whose copy it is linked to. */
  readonly standsFor: ReadonlyMap<string, string>;
  /** How many rows, from the first, are standard prices: written in calls of their own. */
  readonly standardFirst: number;
  /** What the object's result says of it. */
  readonly notes: string[];
}

/**
 * The rows of a write as the platform takes them: of the price books, the
 * standard one left out, matched; of the prices, those in a currency the
 * target does not hold active left out where the source's own price in the
 * currency they would go in is among the rows, then the standard prices
 * first. Any other object's rows are handed back as they are.
 */
export function settleSyncPrices(
  objectApiName: string,
  rows: SyncRows,
  standard: StandardPricebooks | undefined,
  currencies: RunCurrencies | undefined,
): SettledSyncRows {
  const none: SettledSyncRows = { ...rows, standsFor: new Map(), standardFirst: 0, notes: [] };
  if (!standard) return none;
  const at = rows.records.map((_, index) => index);
  const pick = (indexes: readonly number[]): SyncRows => ({
    records: indexes.map((i) => rows.records[i]),
    sources: indexes.map((i) => rows.sources[i]),
    sourceIds: indexes.map((i) => rows.sourceIds[i]),
  });
  if (objectApiName === PRICEBOOK_OBJECT) {
    const kept = at.filter((i) => rows.sourceIds[i] !== standard.source);
    if (kept.length === at.length) return none;
    return {
      ...pick(kept),
      standsFor: new Map(),
      standardFirst: 0,
      notes: ["The standard price book is matched to the target org's, never written."],
    };
  }
  if (objectApiName !== PRICEBOOK_ENTRY_OBJECT) return none;

  let kept = at;
  const standsFor = new Map<string, string>();
  const notes: string[] = [];
  if (currencies) {
    const { target } = currencies;
    const prices = rows.sources;
    const plan = settlePriceCurrencies(
      {
        prices,
        standardBookId: standard.source,
        sellingModels: prices.some(
          (row) => typeof row[PRICEBOOK_ENTRY_SELLING_MODEL_FIELD] === 'string',
        ),
        writtenIn: (code) =>
          target.active.has(code) ? code : replacementCurrency(undefined, target)?.to,
        active: target.active,
      },
      [],
    );
    const left = new Set(plan.standsFor.keys());
    kept = at.filter((i) => {
      const id = rows.sourceIds[i];
      return id === undefined || !left.has(id);
    });
    for (const [price, stand] of plan.standsFor) standsFor.set(price, stand);
    notes.push(...describePriceCurrencies(plan.said).map((sentence) => `${sentence}.`));
  }
  const isStandard = (i: number): boolean =>
    rows.sources[i][PRICEBOOK_ENTRY_BOOK_FIELD] === standard.source;
  const ordered = [...kept.filter(isStandard), ...kept.filter((i) => !isStandard(i))];
  return {
    ...pick(ordered),
    standsFor,
    standardFirst: kept.filter(isStandard).length,
    notes,
  };
}
