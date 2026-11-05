import { describe, expect, it } from 'vitest';
import { quotesLeftUnsynced, quotesLeftUnsyncedNote, type AlignedRecords } from './syncedQuotes.js';

/** An opportunity syncing with its quote, `products` under it and `lines` under the quote. */
function records(products: number, lines: number, synced = 'Q1'): AlignedRecords {
  return new Map<string, Array<{ referenceId: string; fields: Record<string, unknown> }>>([
    ['Opportunity', [{ referenceId: 'O1', fields: { Name: 'Deal', SyncedQuoteId: synced } }]],
    ['Quote', [{ referenceId: 'Q1', fields: { OpportunityId: 'O1' } }]],
    [
      'OpportunityLineItem',
      Array.from({ length: products }, (_, i) => ({
        referenceId: `P${i + 1}`,
        fields: { OpportunityId: 'O1' },
      })),
    ],
    [
      'QuoteLineItem',
      Array.from({ length: lines }, (_, i) => ({
        referenceId: `L${i + 1}`,
        fields: { QuoteId: 'Q1', OpportunityLineItemId: `P${i + 1}` },
      })),
    ],
  ]);
}

const everything = (): boolean => true;

describe('quotesLeftUnsynced', () => {
  it('names an opportunity whose quote the load writes fewer lines under than products under it', () => {
    expect(quotesLeftUnsynced(records(2, 0), everything)).toEqual([
      { opportunity: 'O1', quote: 'Q1', products: 2, lines: 0 },
    ]);
    expect(quotesLeftUnsynced(records(2, 1), everything)).toEqual([
      { opportunity: 'O1', quote: 'Q1', products: 2, lines: 1 },
    ]);
  });

  it('names none whose quote holds as many lines as it holds products, or that has no product', () => {
    expect(quotesLeftUnsynced(records(2, 2), everything)).toEqual([]);
    expect(quotesLeftUnsynced(records(0, 0), everything)).toEqual([]);
  });

  it('counts only what the load wrote', () => {
    // A line the target refused is none the sync can keep a product by.
    expect(quotesLeftUnsynced(records(2, 2), (ref) => ref !== 'L2')).toEqual([
      { opportunity: 'O1', quote: 'Q1', products: 2, lines: 1 },
    ]);
    // A product refused is none the sync can take.
    expect(quotesLeftUnsynced(records(2, 1), (ref) => ref !== 'P2')).toEqual([]);
  });

  it('leaves alone an opportunity or a quote the load did not write, and a quote the dataset does not hold', () => {
    expect(quotesLeftUnsynced(records(2, 0), (ref) => ref !== 'O1')).toEqual([]);
    expect(quotesLeftUnsynced(records(2, 0), (ref) => ref !== 'Q1')).toEqual([]);
    expect(quotesLeftUnsynced(records(2, 0, 'Q9'), everything)).toEqual([]);
  });
});

describe('quotesLeftUnsyncedNote', () => {
  it('says how many it leaves unsynced, what it wrote under each, and that the products are kept', () => {
    expect(
      quotesLeftUnsyncedNote([{ opportunity: 'O1', quote: 'Q1', products: 2, lines: 0 }], true),
    ).toEqual({
      objectApiName: 'Opportunity',
      count: 1,
      note:
        "1 left unsynced with its quote: the load wrote 2 of its products and none of the quote's " +
        'lines, which excludedObjects leaves out — synced, the platform replaces an ' +
        "opportunity's products with its quote's lines; SyncedQuoteId left empty, the products kept",
    });
  });

  it('says it of several, and in a preview what it would do, naming excludedObjects only when it is why', () => {
    const left = [
      { opportunity: 'O1', quote: 'Q1', products: 2, lines: 1 },
      { opportunity: 'O2', quote: 'Q2', products: 3, lines: 0 },
    ];
    expect(quotesLeftUnsyncedNote(left, false, true)?.note).toBe(
      "2 would be left unsynced with their quote: the load would write 5 of their products and 1 of the quotes' " +
        "lines — synced, the platform replaces an opportunity's products with its quote's lines; " +
        'SyncedQuoteId left empty, the products kept',
    );
    expect(quotesLeftUnsyncedNote([], true)).toBeUndefined();
  });
});
