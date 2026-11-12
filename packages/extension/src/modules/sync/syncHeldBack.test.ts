import { describe, expect, it, vi } from 'vitest';
import type { SyncObjectConfig } from '@sandforge/shared';
import { orgCurrenciesOf } from '../../core/common/recordCurrencies.js';
import { heldBackOf, sourceFieldOf } from './syncHeldBack.js';
import type { WriteLookup } from './syncWriteOrder.js';

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

function objectOf(objectApiName: string, over: Partial<SyncObjectConfig> = {}): SyncObjectConfig {
  return {
    objectApiName,
    operation: 'insert',
    fieldMappings: [],
    transformRules: [],
    excludedFields: [],
    addOnFields: [],
    batchSize: 200,
    insertOrder: 0,
    ...over,
  };
}

/** The source: two accounts, a contact under each and one under an account the run does not read. */
const SOURCE: Record<string, Array<Record<string, unknown>>> = {
  Account: [{ Id: fakeId('001', 1) }, { Id: fakeId('001', 2) }],
  Contact: [
    { Id: fakeId('003', 1), AccountId: fakeId('001', 1) },
    { Id: fakeId('003', 2), AccountId: fakeId('001', 2) },
    { Id: fakeId('003', 3), AccountId: fakeId('001', 9) },
    { Id: fakeId('003', 4), AccountId: null },
  ],
};

const LOOKUPS = new Map<string, WriteLookup[]>([
  ['Contact', [{ field: 'AccountId', referenceTo: ['Account'] }]],
]);

/** A read of the source, as the run reads each object, kept to say what was read. */
function reader(source = SOURCE) {
  return vi.fn(async (objectConfig: SyncObjectConfig) => source[objectConfig.objectApiName] ?? []);
}

describe('sourceFieldOf', () => {
  it('names the field a lookup is sent from: its own, or the one a direct or rename mapping takes there', () => {
    expect(sourceFieldOf(objectOf('Contact'), 'AccountId')).toBe('AccountId');
    expect(
      sourceFieldOf(
        objectOf('Contact', {
          fieldMappings: [
            { sourceField: 'Old_Account__c', targetField: 'AccountId', type: 'rename' },
          ],
        }),
        'accountid',
      ),
    ).toBe('Old_Account__c');
  });

  it('names none for a lookup the configuration sets or a rule changes: no source id goes in it', () => {
    expect(
      sourceFieldOf(
        objectOf('Contact', {
          addOnFields: [
            { fieldApiName: 'AccountId', value: fakeId('001', 5), overwriteExisting: true },
          ],
        }),
        'AccountId',
      ),
    ).toBeUndefined();
    expect(
      sourceFieldOf(
        objectOf('Contact', {
          transformRules: [{ type: 'default_value', field: 'AccountId', config: {} }],
        }),
        'AccountId',
      ),
    ).toBeUndefined();
    expect(
      sourceFieldOf(
        objectOf('Contact', {
          fieldMappings: [{ sourceField: 'AccountId', targetField: 'AccountId', type: 'constant' }],
        }),
        'AccountId',
      ),
    ).toBeUndefined();
  });
});

describe('heldBackOf', () => {
  it('holds back the rows whose lookup names a record of an object left out, and no other', async () => {
    const read = reader();

    const held = await heldBackOf({
      ordered: [objectOf('Account', { operation: 'upsert' }), objectOf('Contact')],
      lookups: LOOKUPS,
      leftOut: new Set(['Account']),
      read,
    });

    expect([...held.values()]).toEqual([
      {
        objectApiName: 'Contact',
        rows: 2,
        parent: 'Account',
        field: 'AccountId',
        parents: [{ parent: 'Account', field: 'AccountId', rows: 2 }],
      },
    ]);
  });

  it('lets a row go whose record an earlier run copied: the copy stands in for it, as the run names it', async () => {
    const held = await heldBackOf({
      ordered: [objectOf('Account'), objectOf('Contact')],
      lookups: LOOKUPS,
      leftOut: new Set(['Account']),
      earlier: new Map([[fakeId('001', 1).slice(0, 15), fakeId('001', 501)]]),
      read: reader(),
    });

    expect(held.get('Contact')?.rows).toBe(1);
  });

  it('leaves out of its count the rows an earlier run copied, which the run leaves as they are', async () => {
    const held = await heldBackOf({
      ordered: [objectOf('Account'), objectOf('Contact')],
      lookups: LOOKUPS,
      leftOut: new Set(['Account']),
      copied: new Map([['Contact', new Set([fakeId('003', 2).slice(0, 15)])]]),
      read: reader(),
    });

    expect(held.get('Contact')?.rows).toBe(1);
  });

  it('holds nothing back of an object left out that creates nothing: its rows name records the target holds', async () => {
    const read = reader();

    const held = await heldBackOf({
      ordered: [objectOf('Account', { operation: 'update' }), objectOf('Contact')],
      lookups: LOOKUPS,
      leftOut: new Set(['Account']),
      read,
    });

    expect(held.size).toBe(0);
    expect(read).not.toHaveBeenCalled();
  });

  it('reads nothing of an object whose write carries no lookup at one left out', async () => {
    const read = reader();

    const held = await heldBackOf({
      ordered: [objectOf('Contact'), objectOf('Account')],
      lookups: new Map(),
      leftOut: new Set(['Contact']),
      read,
    });

    expect(held.size).toBe(0);
    expect(read.mock.calls.map(([objectConfig]) => objectConfig.objectApiName)).toEqual([
      'Contact',
    ]);
  });

  it('holds nothing back of an object written before the one left out, as the run sends it', async () => {
    // Written before the accounts, as a cycle of lookups may order them, the
    // contacts name none the run has refused yet.
    const held = await heldBackOf({
      ordered: [objectOf('Contact'), objectOf('Account')],
      lookups: LOOKUPS,
      leftOut: new Set(['Account']),
      read: reader(),
    });

    expect(held.size).toBe(0);
  });

  describe('the standard price book of price books left out', () => {
    const books = { source: fakeId('01s', 1), target: fakeId('01s', 901) };
    const catalog: Record<string, Array<Record<string, unknown>>> = {
      Pricebook2: [{ Id: books.source }, { Id: fakeId('01s', 2) }],
      PricebookEntry: [
        { Id: fakeId('01u', 1), Pricebook2Id: books.source },
        { Id: fakeId('01u', 2), Pricebook2Id: fakeId('01s', 2) },
      ],
    };
    const priced = new Map<string, WriteLookup[]>([
      ['PricebookEntry', [{ field: 'Pricebook2Id', referenceTo: ['Pricebook2'] }]],
    ]);
    const ordered = [objectOf('Pricebook2', { operation: 'upsert' }), objectOf('PricebookEntry')];

    it('lets the standard book’s prices go: it is matched to the target’s, as the run matches it', async () => {
      const held = await heldBackOf({
        ordered,
        lookups: priced,
        leftOut: new Set(['Pricebook2']),
        read: reader(catalog),
        standardPricebooks: async () => books,
      });

      expect([...held.values()]).toEqual([
        {
          objectApiName: 'PricebookEntry',
          rows: 1,
          parent: 'Pricebook2',
          field: 'Pricebook2Id',
          parents: [{ parent: 'Pricebook2', field: 'Pricebook2Id', rows: 1 }],
        },
      ]);
    });

    it('counts the standard book of the books left out as matched, not among the books refused', async () => {
      const matched = new Map<string, number>();

      await heldBackOf({
        ordered,
        lookups: priced,
        leftOut: new Set(['Pricebook2']),
        read: reader(catalog),
        standardPricebooks: async () => books,
        matched,
      });

      expect([...matched]).toEqual([['Pricebook2', 1]]);
    });

    describe('the prices in a currency the target does not hold', () => {
      const currencies = {
        source: orgCurrenciesOf([
          { IsoCode: 'USD', ConversionRate: 1, IsActive: true, IsCorporate: true },
          { IsoCode: 'GBP', ConversionRate: 0.79, IsActive: true },
        ])!,
        target: orgCurrenciesOf([
          { IsoCode: 'USD', ConversionRate: 1, IsActive: true, IsCorporate: true },
        ])!,
      };
      /** Of a product in each book, a price in USD and one in GBP. */
      const twoCurrencies: Record<string, Array<Record<string, unknown>>> = {
        Product2: [{ Id: fakeId('01t', 1) }],
        Pricebook2: catalog.Pricebook2,
        PricebookEntry: [books.source, fakeId('01s', 2)].flatMap((book, at) =>
          ['USD', 'GBP'].map((CurrencyIsoCode, n) => ({
            Id: fakeId('01u', 10 * at + n + 1),
            Pricebook2Id: book,
            Product2Id: fakeId('01t', 1),
            CurrencyIsoCode,
          })),
        ),
      };
      const withProducts = new Map<string, WriteLookup[]>([
        [
          'PricebookEntry',
          [
            { field: 'Pricebook2Id', referenceTo: ['Pricebook2'] },
            { field: 'Product2Id', referenceTo: ['Product2'] },
          ],
        ],
      ]);

      it('counts each price left out for the source’s own in USD as matched, with the standard book, nothing left out', async () => {
        const matched = new Map<string, number>();
        const read = reader(twoCurrencies);

        const held = await heldBackOf({
          ordered: [objectOf('Product2'), objectOf('Pricebook2'), objectOf('PricebookEntry')],
          lookups: withProducts,
          leftOut: new Set(),
          read,
          standardPricebooks: async () => books,
          currencies: async () => currencies,
          matched,
        });

        expect(held.size).toBe(0);
        expect([...matched]).toEqual([
          ['Pricebook2', 1],
          ['PricebookEntry', 2],
        ]);
        // The products are read for nothing: no lookup names one left out.
        expect(read.mock.calls.map(([objectConfig]) => objectConfig.objectApiName)).toEqual([
          'Pricebook2',
          'PricebookEntry',
        ]);
      });

      it('holds back with their product the prices in GBP, matching none of them', async () => {
        const matched = new Map<string, number>();

        const held = await heldBackOf({
          ordered: [
            objectOf('Product2', { operation: 'upsert' }),
            objectOf('Pricebook2'),
            objectOf('PricebookEntry'),
          ],
          lookups: withProducts,
          leftOut: new Set(['Product2']),
          read: reader(twoCurrencies),
          standardPricebooks: async () => books,
          currencies: async () => currencies,
          matched,
        });

        expect(held.get('PricebookEntry')?.rows).toBe(4);
        expect(matched.get('PricebookEntry')).toBeUndefined();
      });

      it('reads no price for it when the target holds every currency of the source', async () => {
        const matched = new Map<string, number>();
        const read = reader(twoCurrencies);

        await heldBackOf({
          ordered: [objectOf('PricebookEntry')],
          lookups: withProducts,
          leftOut: new Set(),
          read,
          standardPricebooks: async () => books,
          currencies: async () => ({ source: currencies.target, target: currencies.target }),
          matched,
        });

        expect(read).not.toHaveBeenCalled();
        expect(matched.size).toBe(0);
      });
    });

    it('holds them back with the rest when both books cannot be read, as the run then sends them unmatched', async () => {
      const held = await heldBackOf({
        ordered,
        lookups: priced,
        leftOut: new Set(['Pricebook2']),
        read: reader(catalog),
        standardPricebooks: async () => undefined,
      });

      expect(held.get('PricebookEntry')?.rows).toBe(2);
    });
  });
});
