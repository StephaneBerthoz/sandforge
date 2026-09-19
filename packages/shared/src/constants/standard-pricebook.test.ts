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
});
