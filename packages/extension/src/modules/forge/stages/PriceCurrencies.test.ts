import { describe, expect, it } from 'vitest';
import type { ForgeGraph, ForgeGraphEdge, ForgeGraphNode } from '@sandforge/shared';
import {
  LINES_PRICED,
  describePriceCurrencies,
  describeSettledPrices,
  priceInCurrency,
  priceKeyOf,
  pricesToAsk,
  recordsBeforeTheirPrices,
  settlePriceCurrencies,
  settledPricesOf,
  type PriceCurrencyInput,
  type PriceRow,
} from './PriceCurrencies.js';
import { catalogWriteEdges, sortNodesForWriting } from './ScopeResolver.js';

const STANDARD = '01s000000000001AAA';
const BOOK = '01s000000000002AAA';
const WIDGET = '01t000000000001AAA';

/** A price of the widget in `book` and `currency`, its id telling both. */
function price(book: 'standard' | 'custom', currency: string, unitPrice = 10): PriceRow {
  return {
    Id: `01u-${book}-${currency}`,
    Pricebook2Id: book === 'standard' ? STANDARD : BOOK,
    Product2Id: WIDGET,
    CurrencyIsoCode: currency,
    UnitPrice: unitPrice,
    IsActive: true,
  };
}

/** A target that holds USD (corporate) and EUR active, and CHF too when asked. */
function input(
  prices: PriceRow[],
  wanted: Record<string, string[]> = {},
  active = ['USD', 'EUR'],
): PriceCurrencyInput {
  const held = new Set(active);
  return {
    prices,
    standardBookId: STANDARD,
    sellingModels: false,
    writtenIn: (code) => (held.has(code) ? code : 'USD'),
    active: held,
    wanted: new Map(Object.entries(wanted).map(([id, codes]) => [id, new Set(codes)])),
  };
}

const ids = (rows: readonly PriceRow[]): string[] => rows.map((row) => String(row['Id']));

describe('pricesToAsk', () => {
  it('asks the source for the currencies the lines want that no price in hand is in', () => {
    const asked = pricesToAsk(
      input([price('custom', 'GBP'), price('custom', 'EUR'), price('standard', 'GBP')], {
        '01u-custom-GBP': ['EUR', 'USD'],
      }),
    );

    // EUR is in hand for the custom book; the standard price follows the
    // custom one into both.
    expect(asked).toEqual([
      { book: BOOK, product: WIDGET, model: '', currency: 'USD' },
      { book: STANDARD, product: WIDGET, model: '', currency: 'EUR' },
      { book: STANDARD, product: WIDGET, model: '', currency: 'USD' },
    ]);
  });

  it('asks a price nothing asks another of only for the currency it goes in alone', () => {
    expect(pricesToAsk(input([price('custom', 'GBP'), price('custom', 'EUR')]))).toEqual([
      { book: BOOK, product: WIDGET, model: '', currency: 'USD' },
    ]);
  });
});

describe('settlePriceCurrencies', () => {
  it("replaces a price by the source's own in the currency its lines' record goes in", () => {
    const gbp = price('custom', 'GBP');
    const eur = price('custom', 'EUR');

    const plan = settlePriceCurrencies(input([gbp], { [String(gbp['Id'])]: ['EUR'] }), [eur]);

    expect(ids(plan.rows)).toEqual(['01u-custom-EUR']);
    expect(plan.standsFor.get('01u-custom-GBP')).toBe('01u-custom-EUR');
    expect(plan.written.get(priceInCurrency(priceKeyOf(gbp, false), 'EUR'))).toBe('01u-custom-EUR');
    expect(plan.said).toEqual([{ from: 'GBP', to: 'EUR', how: 'replaced', forLines: true }]);
  });

  it('writes a price the source holds in no such currency in it, converted, and says it chose it for the lines', () => {
    const gbp = price('custom', 'GBP');

    const plan = settlePriceCurrencies(input([gbp], { '01u-custom-GBP': ['EUR'] }), []);

    expect(ids(plan.rows)).toEqual(['01u-custom-GBP']);
    expect(plan.convertedInto.get('01u-custom-GBP')).toBe('EUR');
    expect(plan.said).toEqual([{ from: 'GBP', to: 'EUR', how: 'converted', forLines: true }]);
  });

  it('converts no price into the currency it would go in alone: the write does', () => {
    const plan = settlePriceCurrencies(input([price('custom', 'GBP')]), []);

    expect(plan.convertedInto.size).toBe(0);
    expect(plan.said).toEqual([{ from: 'GBP', to: 'USD', how: 'converted', forLines: false }]);
  });

  it('follows the lines of a price in a currency the target holds, sent in another', () => {
    const eur = price('custom', 'EUR');
    const usd = price('custom', 'USD');

    const plan = settlePriceCurrencies(input([eur], { '01u-custom-EUR': ['USD'] }), [usd]);

    expect(ids(plan.rows)).toEqual(['01u-custom-USD']);
    expect(plan.said).toEqual([{ from: 'EUR', to: 'USD', how: 'replaced', forLines: true }]);
  });

  it('keeps a price its lines want as it is, and writes the source’s own beside it for the others', () => {
    const eur = price('custom', 'EUR');
    const usd = price('custom', 'USD');

    const plan = settlePriceCurrencies(input([eur], { '01u-custom-EUR': ['EUR', 'USD'] }), [usd]);

    expect(ids(plan.rows)).toEqual(['01u-custom-EUR', '01u-custom-USD']);
    expect(plan.standsFor.size).toBe(0);
    const key = priceKeyOf(eur, false);
    expect(plan.written.get(priceInCurrency(key, 'EUR'))).toBe('01u-custom-EUR');
    expect(plan.written.get(priceInCurrency(key, 'USD'))).toBe('01u-custom-USD');
  });

  it('says the lines of a currency no price can be written in for', () => {
    // One price written once stands in one currency: its lines want two, and
    // the source holds it in neither.
    const gbp = price('custom', 'GBP');

    const plan = settlePriceCurrencies(
      input([gbp], { '01u-custom-GBP': ['EUR', 'CHF'] }, ['USD', 'EUR', 'CHF']),
      [],
    );

    expect(plan.convertedInto.get('01u-custom-GBP')).toBe('EUR');
    expect(plan.said).toEqual([
      { from: 'GBP', to: 'EUR', how: 'converted', forLines: true },
      { from: 'GBP', to: 'CHF', how: 'none', forLines: true },
    ]);
  });

  it('takes a standard price into the currencies the custom prices of its product go in', () => {
    const custom = price('custom', 'GBP');
    const standard = price('standard', 'GBP');
    const standardInEuros = price('standard', 'EUR');

    const plan = settlePriceCurrencies(input([custom, standard], { '01u-custom-GBP': ['EUR'] }), [
      standardInEuros,
    ]);

    expect(ids(plan.rows)).toEqual(['01u-custom-GBP', '01u-standard-EUR']);
    expect(plan.convertedInto.get('01u-custom-GBP')).toBe('EUR');
    expect(plan.standsFor.get('01u-standard-GBP')).toBe('01u-standard-EUR');
  });

  it('prefers a live price of the source to a retired one', () => {
    const gbp = price('custom', 'GBP');
    const retired = { ...price('custom', 'EUR'), Id: '01u-retired', IsActive: false };

    const plan = settlePriceCurrencies(input([gbp], { '01u-custom-GBP': ['EUR'] }), [
      retired,
      price('custom', 'EUR'),
    ]);

    expect(ids(plan.rows)).toEqual(['01u-custom-EUR']);
  });

  it('leaves a price with no currency, and one nothing asks another of, as they are', () => {
    const bare = { ...price('custom', 'EUR'), CurrencyIsoCode: undefined, Id: '01u-bare' };
    const eur = price('custom', 'EUR');

    const plan = settlePriceCurrencies(input([bare, eur]), []);

    expect(plan.rows).toEqual([bare, eur]);
    expect(plan.said).toEqual([]);
    expect(plan.written.get(priceInCurrency(priceKeyOf(eur, false), 'EUR'))).toBe('01u-custom-EUR');
  });
});

describe('describePriceCurrencies', () => {
  it('says each way the prices went, those that went alone first', () => {
    expect(
      describePriceCurrencies([
        { from: 'GBP', to: 'EUR', how: 'replaced', forLines: true },
        { from: 'GBP', to: 'USD', how: 'replaced', forLines: false },
        { from: 'GBP', to: 'USD', how: 'replaced', forLines: false },
        { from: 'GBP', to: 'EUR', how: 'converted', forLines: true },
        { from: 'GBP', to: 'CHF', how: 'none', forLines: true },
      ]),
    ).toEqual([
      "2 GBP → USD: price(s) in a currency the target does not hold active replaced by the source's " +
        'own price in the currency written, for the same product and price book',
      "1 GBP → EUR: price(s) replaced by the source's own price in the currency of the record their " +
        'lines belong to, for the same product and price book',
      '1 GBP → EUR: no price in the currency of the record their lines belong to in the source for ' +
        'the same product and price book, written in it at its amount converted',
      '1 GBP → CHF: no price in the currency of the record their lines belong to in the source for ' +
        'the same product and price book, and the price goes in another currency for other lines: ' +
        'the target refuses the lines of a record in it',
    ]);
  });
});

describe('settledPricesOf', () => {
  it('counts the prices per currency read, currency wanted and way they went, as a result carries them', () => {
    const said = [
      { from: 'GBP', to: 'USD', how: 'replaced' as const, forLines: false },
      { from: 'GBP', to: 'EUR', how: 'converted' as const, forLines: true },
      { from: 'GBP', to: 'USD', how: 'replaced' as const, forLines: false },
      { from: 'GBP', to: 'USD', how: 'replaced' as const, forLines: true },
    ];

    const settled = settledPricesOf(said);

    expect(settled).toEqual([
      { from: 'GBP', to: 'USD', how: 'replaced', forLines: false, prices: 2 },
      { from: 'GBP', to: 'EUR', how: 'converted', forLines: true, prices: 1 },
      { from: 'GBP', to: 'USD', how: 'replaced', forLines: true, prices: 1 },
    ]);
    // The command line says them as the object's line says what was settled.
    expect(describeSettledPrices(settled)).toEqual(describePriceCurrencies(said));
  });
});

describe('recordsBeforeTheirPrices', () => {
  const node = (objectApiName: string): ForgeGraphNode =>
    ({ objectApiName, included: true }) as ForgeGraphNode;

  it('writes the records lines take their currency from before the prices', () => {
    const objects = new Set(['Opportunity', 'Quote', 'PricebookEntry', 'OpportunityLineItem']);

    expect(
      recordsBeforeTheirPrices(objects, ['OpportunityLineItem', 'QuoteLineItem'], []).map(
        (edge) => [edge.sourceObject, edge.targetObject, edge.required],
      ),
    ).toEqual([
      ['Opportunity', 'PricebookEntry', true],
      ['Quote', 'PricebookEntry', true],
    ]);
    expect(LINES_PRICED['OrderItem']).toEqual({ record: 'Order', field: 'OrderId' });
  });

  it('adds no edge the prices already come before, which would make a cycle', () => {
    const before: ForgeGraphEdge[] = [
      {
        sourceObject: 'PricebookEntry',
        targetObject: 'Deal__c',
        relationshipName: 'Price__c',
        type: 'lookup',
        required: true,
      },
      {
        sourceObject: 'Deal__c',
        targetObject: 'Opportunity',
        relationshipName: 'Deal__c',
        type: 'lookup',
        required: true,
      },
    ];

    expect(
      recordsBeforeTheirPrices(
        new Set(['Opportunity', 'Deal__c', 'PricebookEntry']),
        ['OpportunityLineItem'],
        before,
      ),
    ).toEqual([]);
    expect(recordsBeforeTheirPrices(new Set(['Opportunity']), ['OpportunityLineItem'], [])).toEqual(
      [],
    );
  });

  it('puts an opportunity a graph met after the prices before them', () => {
    // Met first, the prices went first: an opportunity's currency was not yet
    // known when they settled theirs.
    const graph: ForgeGraph = {
      nodes: ['PricebookEntry', 'OpportunityLineItem', 'Opportunity'].map(node),
      edges: [],
    } as unknown as ForgeGraph;
    const objects = new Set(graph.nodes.map((n) => n.objectApiName));
    const lines = ['OpportunityLineItem'];
    const catalog = catalogWriteEdges(objects, lines);

    const order = sortNodesForWriting(graph, [
      ...catalog,
      ...recordsBeforeTheirPrices(objects, lines, catalog),
    ]).map((n) => n.objectApiName);

    expect(order).toEqual(['Opportunity', 'PricebookEntry', 'OpportunityLineItem']);
    expect(sortNodesForWriting(graph, catalog).map((n) => n.objectApiName)[0]).toBe(
      'PricebookEntry',
    );
  });
});
