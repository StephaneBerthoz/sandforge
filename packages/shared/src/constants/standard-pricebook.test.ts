import { describe, it, expect } from 'vitest';
import {
  PRICEBOOK_ENTRY_BOOK_FIELD,
  PRICEBOOK_ENTRY_OBJECT,
  STANDARD_PRICEBOOK_SOQL,
  isPricebookEntry,
  splitStandardPricebookEntries,
  dedupePricebookEntries,
} from './standard-pricebook.js';

describe('isPricebookEntry', () => {
  it('names the one object the rule applies to', () => {
    expect(isPricebookEntry(PRICEBOOK_ENTRY_OBJECT)).toBe(true);
    expect(isPricebookEntry('Pricebook2')).toBe(false);
    expect(isPricebookEntry('Product2')).toBe(false);
  });
});

describe('STANDARD_PRICEBOOK_SOQL', () => {
  it('finds the book by its flag, not by its name', () => {
    // The name is localised: a French org answers "Catalogue de prix standard".
    expect(STANDARD_PRICEBOOK_SOQL).toContain('IsStandard = true');
    expect(STANDARD_PRICEBOOK_SOQL).not.toContain('Name');
  });
});

describe('splitStandardPricebookEntries', () => {
  const rows = [
    { Id: '01u1', [PRICEBOOK_ENTRY_BOOK_FIELD]: '01sSTD' },
    { Id: '01u2', [PRICEBOOK_ENTRY_BOOK_FIELD]: '01sCUSTOM' },
    { Id: '01u3', [PRICEBOOK_ENTRY_BOOK_FIELD]: '01sSTD' },
  ];

  it('puts the standard entries on their own so they can be written first', () => {
    const { standard, custom } = splitStandardPricebookEntries(rows, '01sSTD');
    expect(standard.map((r) => r.Id)).toEqual(['01u1', '01u3']);
    expect(custom.map((r) => r.Id)).toEqual(['01u2']);
  });

  it('orders nothing when the standard book was not found', () => {
    const { standard, custom } = splitStandardPricebookEntries(rows, null);
    expect(standard).toEqual([]);
    expect(custom).toHaveLength(3);
  });

  it('splits on the source id, which is what the rows carry', () => {
    // The rows are as they were read, before any remap.
    const { standard } = splitStandardPricebookEntries(rows, '01sCUSTOM');
    expect(standard.map((r) => r.Id)).toEqual(['01u2']);
  });

  it('leaves a row with no book in the second round', () => {
    const { standard, custom } = splitStandardPricebookEntries([{ Id: '01u9' }], '01sSTD');
    expect(standard).toEqual([]);
    expect(custom).toHaveLength(1);
  });
});

describe('dedupePricebookEntries', () => {
  const book = '01sSTD';
  it('keeps the active row when a source org holds both', () => {
    // A real source org held exactly this: one deactivated entry and one
    // live one, same book, same product, same price.
    const kept = dedupePricebookEntries([
      { Id: 'a', Pricebook2Id: book, Product2Id: '01t1', IsActive: false },
      { Id: 'b', Pricebook2Id: book, Product2Id: '01t1', IsActive: true },
    ]);
    expect(kept.map((r) => r.Id)).toEqual(['b']);
  });

  it('keeps the first when neither is active', () => {
    const kept = dedupePricebookEntries([
      { Id: 'a', Pricebook2Id: book, Product2Id: '01t1', IsActive: false },
      { Id: 'b', Pricebook2Id: book, Product2Id: '01t1', IsActive: false },
    ]);
    expect(kept.map((r) => r.Id)).toEqual(['a']);
  });

  it('leaves different products and different books alone', () => {
    const kept = dedupePricebookEntries([
      { Id: 'a', Pricebook2Id: book, Product2Id: '01t1' },
      { Id: 'b', Pricebook2Id: book, Product2Id: '01t2' },
      { Id: 'c', Pricebook2Id: '01sCUSTOM', Product2Id: '01t1' },
    ]);
    expect(kept.map((r) => r.Id)).toEqual(['a', 'b', 'c']);
  });

  it('holds its place in the order', () => {
    const kept = dedupePricebookEntries([
      { Id: 'a', Pricebook2Id: book, Product2Id: '01t1', IsActive: false },
      { Id: 'b', Pricebook2Id: book, Product2Id: '01t2' },
      { Id: 'c', Pricebook2Id: book, Product2Id: '01t1', IsActive: true },
    ]);
    expect(kept.map((r) => r.Id)).toEqual(['c', 'b']);
  });

  it('leaves a row with no pair to collide on', () => {
    const kept = dedupePricebookEntries([{ Id: 'a' }, { Id: 'b' }]);
    expect(kept).toHaveLength(2);
  });

  describe('in an org with several currencies', () => {
    // A book there holds a product's price once per currency, and a custom
    // price needs the standard price of its own currency. Keyed on book and
    // product alone, the euro standard price was dropped behind the dollar
    // one, and the platform refused the euro custom price for want of it.
    const prices = [
      { Id: 'a', Pricebook2Id: '01sCUSTOM', Product2Id: '01t1', CurrencyIsoCode: 'EUR' },
      { Id: 'b', Pricebook2Id: book, Product2Id: '01t1', CurrencyIsoCode: 'USD' },
      { Id: 'c', Pricebook2Id: book, Product2Id: '01t1', CurrencyIsoCode: 'EUR' },
    ];

    it('keeps a price in each currency, which the book holds apart', () => {
      expect(dedupePricebookEntries(prices).map((r) => r.Id)).toEqual(['a', 'b', 'c']);
      expect(dedupePricebookEntries(prices, { sellingModel: true }).map((r) => r.Id)).toEqual([
        'a',
        'b',
        'c',
      ]);
    });

    it('still keeps one of two prices in the same currency, the active one', () => {
      const kept = dedupePricebookEntries([
        { ...prices[2], Id: 'd', IsActive: false },
        { ...prices[2], Id: 'e', IsActive: true },
        prices[1],
      ]);
      expect(kept.map((r) => r.Id)).toEqual(['e', 'b']);
    });
  });

  describe('with the selling model in the key', () => {
    // What a real source org held for most of its products: the price from
    // before selling models, deactivated, and the live one-time price.
    const both = [
      { Id: 'a', Pricebook2Id: book, Product2Id: '01t1', IsActive: false },
      {
        Id: 'b',
        Pricebook2Id: book,
        Product2Id: '01t1',
        ProductSellingModelId: '0jP1',
        IsActive: true,
      },
    ];

    it('keeps a price with a selling model and one without, which the book holds apart', () => {
      expect(dedupePricebookEntries(both, { sellingModel: true }).map((r) => r.Id)).toEqual([
        'a',
        'b',
      ]);
    });

    it('still keeps one of two prices under the same selling model, the active one', () => {
      const kept = dedupePricebookEntries(
        [
          { ...both[1], Id: 'c', IsActive: false },
          { ...both[1], Id: 'd', IsActive: true },
        ],
        { sellingModel: true },
      );
      expect(kept.map((r) => r.Id)).toEqual(['d']);
    });

    it('reads them as one entry when the selling model is not written', () => {
      expect(dedupePricebookEntries(both).map((r) => r.Id)).toEqual(['b']);
    });
  });
});
