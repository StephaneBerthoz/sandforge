import { describe, expect, it } from 'vitest';
import { orgCurrenciesOf, type RunCurrencies } from '../../core/common/recordCurrencies.js';
import {
  namesAPricebook,
  readStandardPricebooks,
  settleSyncPrices,
  type SyncRows,
} from './syncPrices.js';

const BOOKS = { source: '01s000000000001AAA', target: '01s0000000000T1AAA' };
const CURRENCIES: RunCurrencies = {
  source: orgCurrenciesOf([
    { IsoCode: 'USD', ConversionRate: 1, IsActive: true, IsCorporate: true },
    { IsoCode: 'GBP', ConversionRate: 0.79, IsActive: true },
  ])!,
  target: orgCurrenciesOf([
    { IsoCode: 'USD', ConversionRate: 1, IsActive: true, IsCorporate: true },
  ])!,
};

/** The rows of a write, each record its source row. */
function rowsOf(sources: Record<string, unknown>[]): SyncRows {
  return {
    records: sources.map((row) => ({ ...row })),
    sources,
    sourceIds: sources.map((row) => row['Id'] as string),
  };
}

/** A price of the widget in a book and a currency. */
const price = (id: string, book: string, currency: string) => ({
  Id: id,
  Pricebook2Id: book,
  Product2Id: '01t000000000001AAA',
  CurrencyIsoCode: currency,
});

describe('readStandardPricebooks', () => {
  it("reads each org's standard price book", async () => {
    const read = await readStandardPricebooks(
      async () => [{ Id: BOOKS.source }],
      async () => [{ Id: BOOKS.target }],
    );

    expect(read).toEqual(BOOKS);
  });

  it('answers nothing when an org answers none, or a read fails', async () => {
    expect(
      await readStandardPricebooks(
        async () => [{ Id: BOOKS.source }],
        async () => [],
      ),
    ).toBeUndefined();
    expect(
      await readStandardPricebooks(
        async () => {
          throw new Error('INVALID_SESSION_ID');
        },
        async () => [{ Id: BOOKS.target }],
      ),
    ).toBeUndefined();
  });
});

describe('namesAPricebook', () => {
  it('asks for the books of a write of price books, or of rows that name one', () => {
    expect(namesAPricebook('Pricebook2', [])).toBe(true);
    expect(namesAPricebook('Opportunity', [{ Pricebook2Id: BOOKS.source }])).toBe(true);
    expect(namesAPricebook('Account', [{ Name: 'Acme' }])).toBe(false);
  });
});

describe('settleSyncPrices', () => {
  it('leaves the standard price book out of a write of price books', () => {
    const settled = settleSyncPrices(
      'Pricebook2',
      rowsOf([{ Id: BOOKS.source }, { Id: '01s000000000002AAA' }]),
      BOOKS,
      undefined,
    );

    expect(settled.sourceIds).toEqual(['01s000000000002AAA']);
    expect(settled.standardMatched).toBe(true);
  });

  it('puts the standard prices first, and leaves out a price whose own in the currency written is among the rows', () => {
    const settled = settleSyncPrices(
      'PricebookEntry',
      rowsOf([
        price('01u-custom-GBP', '01s000000000002AAA', 'GBP'),
        price('01u-custom-USD', '01s000000000002AAA', 'USD'),
        price('01u-standard-USD', BOOKS.source, 'USD'),
      ]),
      BOOKS,
      CURRENCIES,
    );

    expect(settled.sourceIds).toEqual(['01u-standard-USD', '01u-custom-USD']);
    expect(settled.standardFirst).toBe(1);
    expect(settled.standsFor.get('01u-custom-GBP')).toBe('01u-custom-USD');
    // Said as an entry of its own, never as a note the result lists among
    // its refusals.
    expect(settled.standardMatched).toBe(false);
    expect(settled.prices).toEqual([
      { from: 'GBP', to: 'USD', how: 'replaced', forLines: false, prices: 1 },
    ]);
  });

  it('hands back the rows of any other object, and every row when the books could not be read', () => {
    const rows = rowsOf([price('01u-custom-GBP', '01s000000000002AAA', 'GBP')]);

    expect(settleSyncPrices('Opportunity', rows, BOOKS, CURRENCIES).records).toBe(rows.records);
    expect(settleSyncPrices('PricebookEntry', rows, undefined, CURRENCIES).records).toBe(
      rows.records,
    );
  });
});
