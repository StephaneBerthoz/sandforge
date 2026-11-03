import { describe, it, expect } from 'vitest';
import type { SyncConfig, SyncObjectConfig, SyncWriteCheck } from '@sandforge/shared';
import { SyncOrchestrator } from './SyncOrchestrator.js';
import {
  syncWriteGate,
  type SyncCountedWrite,
  type SyncWriteGate,
  type SyncWriteMeasures,
} from './SyncRunGate.js';
import { SyncRunRefused } from './SyncRunFailure.js';
import { DataSync, type OperationOutcome } from './DataSync.js';
import { targetWriteFieldsOf, type TargetWriteFields } from './targetWriteFields.js';
import { FieldMappingService } from './FieldMapping.js';
import { TransformPipeline } from './TransformPipeline.js';
import { ConflictResolver } from './ConflictResolver.js';
import { orgCurrenciesOf, type RunCurrencies } from '../../core/common/recordCurrencies.js';

/*
 * A catalog and an opportunity's line, synced between two fake orgs with
 * several currencies: the source holds USD (corporate) and GBP at 0.79, the
 * target USD alone. The target takes prices as the platform does: a price
 * names one of its own books; a custom price needs a standard price of its
 * product in its currency, written by an earlier call; a book prices a
 * product once per currency; and a line takes a price in its opportunity's
 * currency, with one of its unit and total prices.
 */

const SOURCE_STANDARD = '01s000000000001AAA';
const TARGET_STANDARD = '01s0000000000T1AAA';
const BOOK = '01s000000000002AAA';
const WIDGET = '01t000000000001AAA';
const DEAL = '006000000000001AAA';

const CURRENCIES: RunCurrencies = {
  source: orgCurrenciesOf([
    { IsoCode: 'USD', ConversionRate: 1, IsActive: true, IsCorporate: true },
    { IsoCode: 'GBP', ConversionRate: 0.79, IsActive: true },
  ])!,
  target: orgCurrenciesOf([
    { IsoCode: 'USD', ConversionRate: 1, IsActive: true, IsCorporate: true },
  ])!,
};

const field = (name: string, type = 'string', createable = true) => ({ name, type, createable });
const DESCRIBES: Record<string, TargetWriteFields> = {
  Product2: targetWriteFieldsOf({ name: 'Product2', fields: [field('Name')] }),
  Pricebook2: targetWriteFieldsOf({ name: 'Pricebook2', fields: [field('Name')] }),
  PricebookEntry: targetWriteFieldsOf({
    name: 'PricebookEntry',
    fields: [
      field('Pricebook2Id', 'reference'),
      field('Product2Id', 'reference'),
      field('CurrencyIsoCode', 'picklist'),
      { ...field('UnitPrice', 'currency'), scale: 2 },
    ],
  }),
  Opportunity: targetWriteFieldsOf({
    name: 'Opportunity',
    fields: [
      field('Name'),
      field('Pricebook2Id', 'reference'),
      field('CurrencyIsoCode', 'picklist'),
      { ...field('Amount', 'currency'), scale: 2 },
    ],
  }),
  OpportunityLineItem: targetWriteFieldsOf({
    name: 'OpportunityLineItem',
    fields: [
      field('OpportunityId', 'reference'),
      field('PricebookEntryId', 'reference'),
      field('CurrencyIsoCode', 'picklist', false),
      { ...field('UnitPrice', 'currency'), scale: 2 },
      { ...field('TotalPrice', 'currency'), scale: 2 },
    ],
  }),
};

/** A price of the widget in a book and a currency. */
const price = (id: string, book: string, currency: string, unitPrice: number) => ({
  Id: id,
  Pricebook2Id: book,
  Product2Id: WIDGET,
  CurrencyIsoCode: currency,
  UnitPrice: unitPrice,
});

const SOURCE_ROWS: Record<string, Array<Record<string, unknown>>> = {
  Product2: [{ Id: WIDGET, Name: 'Widget' }],
  Pricebook2: [
    { Id: SOURCE_STANDARD, Name: 'Standard Price Book' },
    { Id: BOOK, Name: 'Partners' },
  ],
  PricebookEntry: [
    price('01u000000000001AAA', SOURCE_STANDARD, 'USD', 100),
    price('01u000000000002AAA', SOURCE_STANDARD, 'GBP', 79),
    price('01u000000000003AAA', BOOK, 'USD', 90),
    price('01u000000000004AAA', BOOK, 'GBP', 71.1),
  ],
  Opportunity: [
    { Id: DEAL, Name: 'Deal', Pricebook2Id: BOOK, CurrencyIsoCode: 'GBP', Amount: 142.2 },
  ],
  OpportunityLineItem: [
    {
      Id: '00k000000000001AAA',
      OpportunityId: DEAL,
      PricebookEntryId: '01u000000000004AAA',
      CurrencyIsoCode: 'GBP',
      UnitPrice: 71.1,
      TotalPrice: 142.2,
    },
  ],
};

/** The target org, refusing what the platform refuses. */
function targetOrg() {
  const held = new Map<string, Record<string, unknown>>([
    [TARGET_STANDARD, { object: 'Pricebook2', Name: 'Standard Price Book' }],
  ]);
  const calls: Array<{ object: string; rows: number }> = [];
  let next = 100;
  const refused = (code: string): OperationOutcome => ({ success: false, errors: [code] });
  const insert = async (
    object: string,
    records: Record<string, unknown>[],
  ): Promise<OperationOutcome[]> => {
    calls.push({ object, rows: records.length });
    // What earlier calls wrote: a row of this call sees none of the others.
    const before = [...held.values()];
    return records.map((record) => {
      if (object === 'PricebookEntry') {
        const book = held.get(String(record['Pricebook2Id']));
        if (book?.['object'] !== 'Pricebook2')
          return refused('REQUIRED_FIELD_MISSING: [Pricebook2Id]');
        const same = (r: Record<string, unknown>, bookId: unknown) =>
          r['object'] === 'PricebookEntry' &&
          r['Pricebook2Id'] === bookId &&
          r['Product2Id'] === record['Product2Id'] &&
          r['CurrencyIsoCode'] === record['CurrencyIsoCode'];
        if (record['Pricebook2Id'] !== TARGET_STANDARD) {
          if (!before.some((r) => same(r, TARGET_STANDARD))) {
            return refused('STANDARD_PRICE_NOT_DEFINED');
          }
        }
        if ([...held.values()].some((r) => same(r, record['Pricebook2Id']))) {
          return refused('DUPLICATE_VALUE: This price definition already exists');
        }
      }
      if (object === 'OpportunityLineItem') {
        if (record['UnitPrice'] !== undefined && record['TotalPrice'] !== undefined) {
          return refused('FIELD_INTEGRITY_EXCEPTION: only one of unit price or total price');
        }
        const deal = held.get(String(record['OpportunityId']));
        const priced = held.get(String(record['PricebookEntryId']));
        // An id the target holds no record of, as the source's own is: an
        // org refuses a lookup at a record of another org.
        if (!priced) return refused('INVALID_CROSS_REFERENCE_KEY: invalid cross reference id');
        if (priced['CurrencyIsoCode'] !== deal?.['CurrencyIsoCode']) {
          return refused('FIELD_INTEGRITY_EXCEPTION: pricebook entry currency code');
        }
      }
      const id = `${object.slice(0, 3)}0000000000${next++}AAA`;
      held.set(id, { ...record, object });
      return { id, success: true, errors: [] };
    });
  };
  return { held, calls, insert };
}

function objectConfig(objectApiName: string, insertOrder: number): SyncObjectConfig {
  return {
    objectApiName,
    operation: 'insert',
    fieldMappings: [],
    transformRules: [],
    excludedFields: [],
    addOnFields: [],
    batchSize: 200,
    insertOrder,
  };
}

const CONFIG: SyncConfig = {
  id: 'config-prices',
  name: 'Catalog and deal',
  description: '',
  sourceOrgId: 'src-org',
  targetOrgId: 'tgt-org',
  direction: 'source_to_target',
  mode: 'full',
  objects: ['Product2', 'Pricebook2', 'PricebookEntry', 'Opportunity', 'OpportunityLineItem'].map(
    objectConfig,
  ),
  conflictStrategy: 'source_wins',
  enableRollback: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function orchestrator(target: ReturnType<typeof targetOrg>, matched = true) {
  const unused = async (): Promise<OperationOutcome[]> => [];
  const describeTargetFields = async (object: string) => DESCRIBES[object];
  return new SyncOrchestrator({
    dataSync: new DataSync({
      insert: (object, records) => target.insert(object, records),
      update: unused,
      upsert: unused,
      delete: unused,
      describeTargetFields,
    }),
    conflictResolver: new ConflictResolver(),
    fieldMapping: new FieldMappingService(),
    transformPipeline: new TransformPipeline(),
    querySource: async (_org, config) => SOURCE_ROWS[config.objectApiName].map((r) => ({ ...r })),
    queryTarget: async () => [],
    findInTarget: async () => new Map(),
    describeTargetFields,
    currencies: async () => CURRENCIES,
    ...(matched
      ? {
          standardPricebooks: async () => ({ source: SOURCE_STANDARD, target: TARGET_STANDARD }),
        }
      : {}),
  });
}

describe('SyncOrchestrator — a catalog and the lines priced from it', () => {
  it('writes the prices and the line, the standard book matched and the standard prices first', async () => {
    // Run between two scratch orgs: the standard prices were refused for the
    // source's id of the standard book, the custom ones for want of them,
    // and the line was held back behind its price.
    const target = targetOrg();

    const result = await orchestrator(target).execute(CONFIG);

    expect(result.objectResults.map((r) => [r.objectApiName, r.success, r.failed])).toEqual([
      ['Product2', 1, 0],
      ['Pricebook2', 1, 0],
      ['PricebookEntry', 2, 0],
      ['Opportunity', 1, 0],
      ['OpportunityLineItem', 1, 0],
    ]);
    const written = [...target.held.values()];
    // The standard book is the target's: no second one is written.
    expect(written.filter((r) => r['object'] === 'Pricebook2').map((r) => r['Name'])).toEqual([
      'Standard Price Book',
      'Partners',
    ]);
    // Each in the currency written, the source's own USD price standing for
    // its GBP one, which would have been the same price twice in the book.
    expect(
      written
        .filter((r) => r['object'] === 'PricebookEntry')
        .map((r) => [r['Pricebook2Id'] === TARGET_STANDARD, r['CurrencyIsoCode'], r['UnitPrice']]),
    ).toEqual([
      [true, 'USD', 100],
      [false, 'USD', 90],
    ]);
    expect(target.calls.filter((c) => c.object === 'PricebookEntry')).toEqual([
      { object: 'PricebookEntry', rows: 1 },
      { object: 'PricebookEntry', rows: 1 },
    ]);
    const line = written.find((r) => r['object'] === 'OpportunityLineItem');
    expect(line).toMatchObject({ UnitPrice: 90 });
    expect(line).not.toHaveProperty('TotalPrice');
    expect(target.held.get(String(line?.['PricebookEntryId']))).toMatchObject({
      CurrencyIsoCode: 'USD',
      UnitPrice: 90,
    });
    // Said beside the price books' line, not among their refusals: the Sync
    // results and history showed it in red.
    expect(result.objectResults[1].errors).toEqual([]);
    expect(result.objectResults[1].standardPricebookMatched).toBe(true);
    // The prices that went in another currency are said apart from the
    // object's refusals: the Sync history listed them among its errors.
    expect(result.objectResults[2].errors).toEqual([]);
    expect(result.objectResults[2].pricesSettled).toEqual([
      { from: 'GBP', to: 'USD', how: 'replaced', forLines: false, prices: 2 },
    ]);
  });

  it('predicts in the simulation what the run writes of them', async () => {
    const simulated = await orchestrator(targetOrg()).simulate(CONFIG);

    expect(simulated.error).toBeUndefined();
    expect(simulated.objects.map((o) => [o.objectApiName, o.insert])).toEqual([
      ['Product2', 1],
      ['Pricebook2', 1],
      ['PricebookEntry', 2],
      ['Opportunity', 1],
      ['OpportunityLineItem', 1],
    ]);
    expect(simulated.objects[1].notes).toContain(
      "The standard price book is matched to the target org's, never written.",
    );
    expect(simulated.objects[2].notes).toContain(
      "2 GBP → USD: price(s) in a currency the target does not hold active replaced by the source's " +
        'own price in the currency written, for the same product and price book.',
    );
  });

  it('sends the standard price book’s prices with the source’s id of it when the run cannot read both books', async () => {
    const target = targetOrg();

    const result = await orchestrator(target, false).execute(CONFIG);

    expect(result.objectResults.find((r) => r.objectApiName === 'PricebookEntry')?.success).toBe(0);
  });
});

describe('SyncOrchestrator — a catalog whose price books the target takes none of', () => {
  /*
   * The price books upserted on a key the target does not match an upsert
   * on, so the run leaves them out. The standard book is matched all the
   * same, never written: its price goes, and so do the deal and the line on
   * it. Only what names the custom book is held back. The describes name
   * each lookup's object, as an org's do.
   */
  const lookup = (name: string, object: string) => ({
    ...field(name, 'reference'),
    referenceTo: [object],
  });
  const KEYED: Record<string, TargetWriteFields> = {
    ...DESCRIBES,
    Pricebook2: targetWriteFieldsOf({
      name: 'Pricebook2',
      createable: true,
      updateable: true,
      fields: [
        { name: 'Id', type: 'id', createable: false, idLookup: true, externalId: false },
        { ...field('Name'), idLookup: false, externalId: false },
        { ...field('Catalog_Key__c'), idLookup: false, externalId: false },
      ],
    }),
    PricebookEntry: targetWriteFieldsOf({
      name: 'PricebookEntry',
      fields: [
        lookup('Pricebook2Id', 'Pricebook2'),
        lookup('Product2Id', 'Product2'),
        { ...field('UnitPrice', 'currency'), scale: 2 },
      ],
    }),
    Opportunity: targetWriteFieldsOf({
      name: 'Opportunity',
      fields: [field('Name'), lookup('Pricebook2Id', 'Pricebook2')],
    }),
    OpportunityLineItem: targetWriteFieldsOf({
      name: 'OpportunityLineItem',
      fields: [
        lookup('OpportunityId', 'Opportunity'),
        lookup('PricebookEntryId', 'PricebookEntry'),
        { ...field('UnitPrice', 'currency'), scale: 2 },
      ],
    }),
  };
  const STANDARD_PRICE = '01u000000000011AAA';
  const BOOK_PRICE = '01u000000000012AAA';
  const BOOK_DEAL = '006000000000002AAA';
  const ROWS: Record<string, Array<Record<string, unknown>>> = {
    Product2: [{ Id: WIDGET, Name: 'Widget' }],
    Pricebook2: [
      { Id: SOURCE_STANDARD, Name: 'Standard Price Book', Catalog_Key__c: 'STD' },
      { Id: BOOK, Name: 'Partners', Catalog_Key__c: 'PARTNERS' },
    ],
    PricebookEntry: [
      { Id: STANDARD_PRICE, Pricebook2Id: SOURCE_STANDARD, Product2Id: WIDGET, UnitPrice: 100 },
      { Id: BOOK_PRICE, Pricebook2Id: BOOK, Product2Id: WIDGET, UnitPrice: 90 },
    ],
    Opportunity: [
      { Id: DEAL, Name: 'Direct deal', Pricebook2Id: SOURCE_STANDARD },
      { Id: BOOK_DEAL, Name: 'Partner deal', Pricebook2Id: BOOK },
    ],
    OpportunityLineItem: [
      {
        Id: '00k000000000011AAA',
        OpportunityId: DEAL,
        PricebookEntryId: STANDARD_PRICE,
        UnitPrice: 100,
      },
      {
        Id: '00k000000000012AAA',
        OpportunityId: BOOK_DEAL,
        PricebookEntryId: BOOK_PRICE,
        UnitPrice: 90,
      },
    ],
  };
  const KEYED_CONFIG: SyncConfig = {
    ...CONFIG,
    objects: CONFIG.objects.map((o) =>
      o.objectApiName === 'Pricebook2'
        ? { ...o, operation: 'upsert' as const, externalIdField: 'Catalog_Key__c' }
        : o,
    ),
  };

  /** A gate that lets the run write, as a user who confirmed leaving the books out, and keeps what it counted. */
  function gate() {
    const held: SyncCountedWrite[] = [];
    const measured: SyncCountedWrite[] = [];
    const check: SyncWriteCheck = {
      objects: [],
      total: 0,
      alreadyCopied: 0,
      storage: { verdict: 'fits', estimateMB: 0 },
      emails: [],
      verdict: 'asks',
    };
    const writeGate: SyncWriteGate = {
      measure: async (counted) => {
        measured.push(counted);
        return check;
      },
      hold: async (counted) => {
        held.push(counted);
        return { check, answer: { go: true, asked: true } };
      },
    };
    return { writeGate, held, measured };
  }

  function keyedOrchestrator(target: ReturnType<typeof targetOrg>, writeGate: SyncWriteGate) {
    const unused = async (): Promise<OperationOutcome[]> => [];
    const describeTargetFields = async (object: string) => KEYED[object];
    return new SyncOrchestrator({
      dataSync: new DataSync({
        insert: (object, records) => target.insert(object, records),
        update: unused,
        upsert: unused,
        delete: unused,
        describeTargetFields,
      }),
      conflictResolver: new ConflictResolver(),
      fieldMapping: new FieldMappingService(),
      transformPipeline: new TransformPipeline(),
      querySource: async (_org, config) => ROWS[config.objectApiName].map((r) => ({ ...r })),
      countSource: async (_org, config) => ROWS[config.objectApiName].length,
      queryTarget: async () => [],
      findInTarget: async () => new Map(),
      describeTargetFields,
      standardPricebooks: async () => ({ source: SOURCE_STANDARD, target: TARGET_STANDARD }),
      writeGate,
    });
  }

  it('counts at its gate only what names the custom book as held back, the standard price being written', async () => {
    const target = targetOrg();
    const ran = gate();

    const result = await keyedOrchestrator(target, ran.writeGate).execute(KEYED_CONFIG);

    expect(result.objectResults.map((r) => [r.objectApiName, r.success, r.failed])).toEqual([
      ['Product2', 1, 0],
      ['Pricebook2', 0, 0],
      ['PricebookEntry', 1, 1],
      ['Opportunity', 1, 1],
      ['OpportunityLineItem', 1, 1],
    ]);
    // What the gate counted held back is what the run held back: the price,
    // the deal and the line under the custom book, one each.
    expect(ran.held[0]?.heldBack).toEqual([
      { objectApiName: 'PricebookEntry', rows: 1, parent: 'Pricebook2', field: 'Pricebook2Id' },
      { objectApiName: 'Opportunity', rows: 1, parent: 'Pricebook2', field: 'Pricebook2Id' },
      {
        objectApiName: 'OpportunityLineItem',
        rows: 1,
        parent: 'Opportunity',
        field: 'OpportunityId',
      },
    ]);
    expect(ran.held[0]?.objects.map((o) => [o.objectApiName, o.rows])).toEqual([
      ['Product2', 1],
      ['PricebookEntry', 1],
      ['Opportunity', 1],
      ['OpportunityLineItem', 1],
    ]);
  });

  it('counts in its dry run what the run holds back, as the dry run’s own objects count it', async () => {
    const simulated = gate();

    const simulation = await keyedOrchestrator(targetOrg(), simulated.writeGate).simulate(
      KEYED_CONFIG,
    );

    expect(simulation.error).toBeUndefined();
    expect(simulated.measured[0]?.heldBack?.map((h) => [h.objectApiName, h.rows])).toEqual([
      ['PricebookEntry', 1],
      ['Opportunity', 1],
      ['OpportunityLineItem', 1],
    ]);
    expect(
      simulation.objects.map((o) => [o.objectApiName, o.insert + o.update, o.refused ?? 0]),
    ).toEqual([
      ['Product2', 1, 0],
      ['Pricebook2', 0, 1],
      ['PricebookEntry', 1, 1],
      ['Opportunity', 1, 1],
      ['OpportunityLineItem', 1, 1],
    ]);
  });

  describe('a price left out for one the run holds back', () => {
    /*
     * The products upserted on a key the target does not match an upsert
     * on, so the run leaves them out, and the source's prices in a currency
     * the target does not hold: each GBP price is left out for the source's
     * own USD price of the same product and book, which the run holds back
     * with its product. The deal goes, its book written; its line names the
     * GBP price. Neither linked nor refused, that price let the line go with
     * the source's id of it, which the target refuses, where the gate had
     * counted the line held back.
     */
    const PRICED: Record<string, TargetWriteFields> = {
      ...KEYED,
      Product2: targetWriteFieldsOf({
        name: 'Product2',
        createable: true,
        updateable: true,
        fields: [
          { name: 'Id', type: 'id', createable: false, idLookup: true, externalId: false },
          { ...field('Name'), idLookup: false, externalId: false },
          { ...field('Catalog_Key__c'), idLookup: false, externalId: false },
        ],
      }),
      PricebookEntry: targetWriteFieldsOf({
        name: 'PricebookEntry',
        fields: [
          lookup('Pricebook2Id', 'Pricebook2'),
          lookup('Product2Id', 'Product2'),
          field('CurrencyIsoCode', 'picklist'),
          { ...field('UnitPrice', 'currency'), scale: 2 },
        ],
      }),
      Opportunity: targetWriteFieldsOf({
        name: 'Opportunity',
        fields: [
          field('Name'),
          lookup('Pricebook2Id', 'Pricebook2'),
          field('CurrencyIsoCode', 'picklist'),
          { ...field('Amount', 'currency'), scale: 2 },
        ],
      }),
      OpportunityLineItem: targetWriteFieldsOf({
        name: 'OpportunityLineItem',
        fields: [
          lookup('OpportunityId', 'Opportunity'),
          lookup('PricebookEntryId', 'PricebookEntry'),
          field('CurrencyIsoCode', 'picklist', false),
          { ...field('UnitPrice', 'currency'), scale: 2 },
          { ...field('TotalPrice', 'currency'), scale: 2 },
        ],
      }),
    };
    const PRICED_ROWS: Record<string, Array<Record<string, unknown>>> = {
      ...SOURCE_ROWS,
      Product2: [{ Id: WIDGET, Name: 'Widget', Catalog_Key__c: 'WIDGET' }],
    };
    const PRICED_CONFIG: SyncConfig = {
      ...CONFIG,
      objects: CONFIG.objects.map((o) =>
        o.objectApiName === 'Product2'
          ? { ...o, operation: 'upsert' as const, externalIdField: 'Catalog_Key__c' }
          : o,
      ),
    };

    function pricedOrchestrator(
      target: ReturnType<typeof targetOrg>,
      writeGate: SyncWriteGate,
      describes: Record<string, TargetWriteFields> = PRICED,
    ) {
      const unused = async (): Promise<OperationOutcome[]> => [];
      const describeTargetFields = async (object: string) => describes[object];
      return new SyncOrchestrator({
        dataSync: new DataSync({
          insert: (object, records) => target.insert(object, records),
          update: unused,
          upsert: unused,
          delete: unused,
          describeTargetFields,
        }),
        conflictResolver: new ConflictResolver(),
        fieldMapping: new FieldMappingService(),
        transformPipeline: new TransformPipeline(),
        querySource: async (_org, config) =>
          PRICED_ROWS[config.objectApiName].map((r) => ({ ...r })),
        countSource: async (_org, config) => PRICED_ROWS[config.objectApiName].length,
        queryTarget: async () => [],
        findInTarget: async () => new Map(),
        describeTargetFields,
        currencies: async () => CURRENCIES,
        standardPricebooks: async () => ({ source: SOURCE_STANDARD, target: TARGET_STANDARD }),
        writeGate,
      });
    }

    it('holds back the line that names it, as its gate counted it, and sends the target nothing of it', async () => {
      const target = targetOrg();
      const ran = gate();

      const result = await pricedOrchestrator(target, ran.writeGate).execute(PRICED_CONFIG);

      expect(ran.held[0]?.heldBack?.find((h) => h.objectApiName === 'OpportunityLineItem')).toEqual(
        {
          objectApiName: 'OpportunityLineItem',
          rows: 1,
          parent: 'PricebookEntry',
          field: 'PricebookEntryId',
        },
      );
      const line = result.objectResults.find((r) => r.objectApiName === 'OpportunityLineItem');
      expect([line?.success, line?.failed]).toEqual([0, 1]);
      expect(line?.errors.join(' ')).toContain(
        'PARENT_REFUSED: 1 OpportunityLineItem record held back, not sent: the PricebookEntry ' +
          'record their PricebookEntryId names was refused in this run',
      );
      expect(target.calls.filter((c) => c.object === 'OpportunityLineItem')).toEqual([]);
      // The deal it is on goes all the same: only the line waits on its price.
      expect(result.objectResults.find((r) => r.objectApiName === 'Opportunity')?.success).toBe(1);
    });

    it('holds back with their product the prices in GBP, as its gate counted them, and says none replaced', async () => {
      // The gate counted the four prices held back; the run held back the
      // two in USD and said the two in GBP "replaced by the source's own
      // price", a price it never wrote.
      const target = targetOrg();
      const ran = gate();

      const result = await pricedOrchestrator(target, ran.writeGate).execute(PRICED_CONFIG);

      expect(ran.held[0]?.heldBack?.find((h) => h.objectApiName === 'PricebookEntry')?.rows).toBe(
        4,
      );
      const prices = result.objectResults.find((r) => r.objectApiName === 'PricebookEntry');
      expect([prices?.success, prices?.failed]).toEqual([0, 4]);
      expect(prices?.errors.join(' ')).toContain(
        'PARENT_REFUSED: 4 PricebookEntry records held back, not sent: the Product2 record ' +
          'their Product2Id names was refused in this run',
      );
      expect(prices?.pricesSettled).toBeUndefined();
      expect(target.calls.filter((c) => c.object === 'PricebookEntry')).toEqual([]);
    });

    it('counts them held back in its dry run, as its gate does, and says none replaced', async () => {
      const simulated = gate();

      const simulation = await pricedOrchestrator(targetOrg(), simulated.writeGate).simulate(
        PRICED_CONFIG,
      );

      expect(
        simulated.measured[0]?.heldBack?.find((h) => h.objectApiName === 'PricebookEntry')?.rows,
      ).toBe(4);
      const prices = simulation.objects.find((o) => o.objectApiName === 'PricebookEntry');
      expect([prices?.read, prices?.insert, prices?.refused]).toEqual([4, 0, 4]);
      expect(prices?.notes).toContain(
        'PARENT_REFUSED: 4 PricebookEntry records held back, not sent: the Product2 record ' +
          'their Product2Id names was refused in this run, and written without it they would ' +
          'stand without their Product2.',
      );
      expect(prices?.notes.join(' ')).not.toContain('replaced by the source');
    });

    it('counts the line held back in its dry run, as the dry run’s gate counts it', async () => {
      const simulated = gate();

      const simulation = await pricedOrchestrator(targetOrg(), simulated.writeGate).simulate(
        PRICED_CONFIG,
      );

      expect(simulation.error).toBeUndefined();
      expect(
        simulated.measured[0]?.heldBack?.find((h) => h.objectApiName === 'OpportunityLineItem')
          ?.rows,
      ).toBe(1);
      const line = simulation.objects.find((o) => o.objectApiName === 'OpportunityLineItem');
      expect([line?.insert, line?.refused ?? 0]).toEqual([0, 1]);
    });

    it('holds back the line on a price left out with the prices the target takes none of', async () => {
      // The prices upserted on a key the target does not match an upsert on:
      // the run leaves them out, the one in GBP among them.
      const target = targetOrg();
      const ran = gate();
      const config: SyncConfig = {
        ...CONFIG,
        objects: CONFIG.objects.map((o) =>
          o.objectApiName === 'PricebookEntry'
            ? { ...o, operation: 'upsert' as const, externalIdField: 'Catalog_Key__c' }
            : o,
        ),
      };
      const keyedPrices: Record<string, TargetWriteFields> = {
        ...PRICED,
        Product2: DESCRIBES.Product2,
        PricebookEntry: targetWriteFieldsOf({
          name: 'PricebookEntry',
          createable: true,
          updateable: true,
          fields: [
            { name: 'Id', type: 'id', createable: false, idLookup: true, externalId: false },
            { ...field('Catalog_Key__c'), idLookup: false, externalId: false },
            lookup('Pricebook2Id', 'Pricebook2'),
            lookup('Product2Id', 'Product2'),
            field('CurrencyIsoCode', 'picklist'),
            { ...field('UnitPrice', 'currency'), scale: 2 },
          ],
        }),
      };

      const result = await pricedOrchestrator(target, ran.writeGate, keyedPrices).execute(config);

      expect(
        ran.held[0]?.heldBack?.find((h) => h.objectApiName === 'OpportunityLineItem')?.rows,
      ).toBe(1);
      const line = result.objectResults.find((r) => r.objectApiName === 'OpportunityLineItem');
      expect([line?.success, line?.failed]).toEqual([0, 1]);
      expect(target.calls.filter((c) => c.object === 'OpportunityLineItem')).toEqual([]);
    });
  });
});

describe('SyncOrchestrator — a catalog of three currencies whose price books the target takes none of', () => {
  /*
   * Replayed from a dry run between two scratch orgs. The source holds USD
   * (corporate), EUR and GBP, the target USD and EUR. Three products, each
   * priced in the three currencies in the standard book, and a custom book
   * of four prices; three deals, two on the custom book and one in GBP on the
   * standard book, with four lines. The books are upserted on Description,
   * which the target does not match an upsert on, so the run leaves them out:
   * the standard book matched, the custom one refused, and what names it
   * held back. The dry run's check counted 9 prices to write where its
   * simulation inserted 6, the 3 in GBP left out for the source's own USD
   * price, and its refusal said "Pricebook2 (2 records)" where its simulation
   * refused 1.
   */
  const lookup = (name: string, object: string) => ({
    ...field(name, 'reference'),
    referenceTo: [object],
  });
  const THREE: RunCurrencies = {
    source: orgCurrenciesOf([
      { IsoCode: 'USD', ConversionRate: 1, IsActive: true, IsCorporate: true },
      { IsoCode: 'EUR', ConversionRate: 0.92, IsActive: true },
      { IsoCode: 'GBP', ConversionRate: 0.79, IsActive: true },
    ])!,
    target: orgCurrenciesOf([
      { IsoCode: 'USD', ConversionRate: 1, IsActive: true, IsCorporate: true },
      { IsoCode: 'EUR', ConversionRate: 0.92, IsActive: true },
    ])!,
  };
  const DESCRIBED: Record<string, TargetWriteFields> = {
    Product2: targetWriteFieldsOf({ name: 'Product2', fields: [field('Name')] }),
    // As the target's describe of Pricebook2 reads: Description is neither
    // an External ID nor an idLookup field.
    Pricebook2: targetWriteFieldsOf({
      name: 'Pricebook2',
      createable: true,
      updateable: true,
      fields: [
        { name: 'Id', type: 'id', createable: false, idLookup: true, externalId: false },
        { ...field('Name'), idLookup: true, externalId: false },
        { ...field('Description', 'textarea'), idLookup: false, externalId: false },
      ],
    }),
    PricebookEntry: targetWriteFieldsOf({
      name: 'PricebookEntry',
      fields: [
        lookup('Pricebook2Id', 'Pricebook2'),
        lookup('Product2Id', 'Product2'),
        field('CurrencyIsoCode', 'picklist'),
        { ...field('UnitPrice', 'currency'), scale: 2 },
        field('IsActive', 'boolean'),
      ],
    }),
    Opportunity: targetWriteFieldsOf({
      name: 'Opportunity',
      fields: [
        field('Name'),
        lookup('Pricebook2Id', 'Pricebook2'),
        field('CurrencyIsoCode', 'picklist'),
        { ...field('Amount', 'currency'), scale: 2 },
      ],
    }),
    OpportunityLineItem: targetWriteFieldsOf({
      name: 'OpportunityLineItem',
      fields: [
        lookup('OpportunityId', 'Opportunity'),
        lookup('PricebookEntryId', 'PricebookEntry'),
        field('CurrencyIsoCode', 'picklist', false),
        { ...field('UnitPrice', 'currency'), scale: 2 },
      ],
    }),
  };
  const PRODUCTS = ['01t000000000101AAA', '01t000000000102AAA', '01t000000000103AAA'];
  const CUSTOM = '01s000000000102AAA';
  /** A price of product `p` (1 to 3) in a book. */
  const priceOf = (id: string, book: string, p: number, currency: string, unitPrice: number) => ({
    Id: id,
    Pricebook2Id: book,
    Product2Id: PRODUCTS[p - 1],
    CurrencyIsoCode: currency,
    UnitPrice: unitPrice,
    IsActive: true,
  });
  /** A line of a deal, priced by `price`. */
  const lineOf = (
    id: string,
    deal: string,
    price: string,
    currency: string,
    unitPrice: number,
  ) => ({
    Id: id,
    OpportunityId: deal,
    PricebookEntryId: price,
    CurrencyIsoCode: currency,
    UnitPrice: unitPrice,
  });
  const DEALS = ['006000000000101AAA', '006000000000102AAA', '006000000000103AAA'];
  const ROWS: Record<string, Array<Record<string, unknown>>> = {
    Product2: PRODUCTS.map((Id, at) => ({ Id, Name: `Catalog ${at + 1}` })),
    Pricebook2: [
      { Id: SOURCE_STANDARD, Name: 'Standard Price Book', Description: null },
      { Id: CUSTOM, Name: 'Partners', Description: 'Partner prices' },
    ],
    PricebookEntry: [
      priceOf('01u000000000111AAA', SOURCE_STANDARD, 1, 'USD', 120.5),
      priceOf('01u000000000112AAA', SOURCE_STANDARD, 1, 'EUR', 110.86),
      priceOf('01u000000000113AAA', SOURCE_STANDARD, 1, 'GBP', 95.2),
      priceOf('01u000000000121AAA', SOURCE_STANDARD, 2, 'USD', 249.99),
      priceOf('01u000000000122AAA', SOURCE_STANDARD, 2, 'EUR', 229.99),
      priceOf('01u000000000123AAA', SOURCE_STANDARD, 2, 'GBP', 197.49),
      priceOf('01u000000000131AAA', SOURCE_STANDARD, 3, 'USD', 39.95),
      priceOf('01u000000000132AAA', SOURCE_STANDARD, 3, 'EUR', 36.75),
      priceOf('01u000000000133AAA', SOURCE_STANDARD, 3, 'GBP', 31.56),
      priceOf('01u000000000141AAA', CUSTOM, 1, 'USD', 115),
      priceOf('01u000000000142AAA', CUSTOM, 2, 'USD', 239),
      priceOf('01u000000000143AAA', CUSTOM, 1, 'EUR', 105),
      { ...priceOf('01u000000000144AAA', CUSTOM, 3, 'EUR', 35), IsActive: false },
    ],
    Opportunity: [
      { Id: DEALS[0], Name: 'Deal 1', Pricebook2Id: CUSTOM, CurrencyIsoCode: 'USD', Amount: 469 },
      {
        Id: DEALS[1],
        Name: 'Deal 2',
        Pricebook2Id: SOURCE_STANDARD,
        CurrencyIsoCode: 'GBP',
        Amount: 592.47,
      },
      { Id: DEALS[2], Name: 'Deal 3', Pricebook2Id: CUSTOM, CurrencyIsoCode: 'EUR', Amount: 105 },
    ],
    OpportunityLineItem: [
      lineOf('00k000000000101AAA', DEALS[0], '01u000000000141AAA', 'USD', 115),
      lineOf('00k000000000102AAA', DEALS[0], '01u000000000142AAA', 'USD', 239),
      lineOf('00k000000000103AAA', DEALS[1], '01u000000000123AAA', 'GBP', 197.49),
      lineOf('00k000000000104AAA', DEALS[2], '01u000000000143AAA', 'EUR', 105),
    ],
  };
  const BOOKS_ON_DESCRIPTION: SyncConfig = {
    ...CONFIG,
    objects: CONFIG.objects.map((o) =>
      o.objectApiName === 'Pricebook2'
        ? { ...o, operation: 'upsert' as const, externalIdField: 'Description' }
        : o,
    ),
  };

  /** What the gate reads of a target with room and nothing that runs on what the sync writes. */
  const measures: SyncWriteMeasures = {
    readStorage: async () => ({ maxMB: 500, remainingMB: 500 }),
    readApiBudget: async () => ({ max: 5_000_000, remaining: 4_996_651 }),
    readAutomation: async () => ({
      objectsRead: [],
      objects: [],
      unread: [],
      conditionsNotRead: 0,
      conditionsBound: 25,
      requests: 1,
    }),
    readLimits: async () => ({}),
    readDeliverability: async () => ({ reading: { level: 'withheld' }, requests: 2 }),
    emails: { target: 'TARGET', accepted: false },
    confirmAboveRecords: 2_000,
  };

  function catalogOrchestrator(target: ReturnType<typeof targetOrg>) {
    const unused = async (): Promise<OperationOutcome[]> => [];
    const describeTargetFields = async (object: string) => DESCRIBED[object];
    return new SyncOrchestrator({
      dataSync: new DataSync({
        insert: (object, records) => target.insert(object, records),
        update: unused,
        upsert: unused,
        delete: unused,
        describeTargetFields,
      }),
      conflictResolver: new ConflictResolver(),
      fieldMapping: new FieldMappingService(),
      transformPipeline: new TransformPipeline(),
      querySource: async (_org, config) => ROWS[config.objectApiName].map((r) => ({ ...r })),
      countSource: async (_org, config) => ROWS[config.objectApiName].length,
      queryTarget: async () => [],
      findInTarget: async () => new Map(),
      describeTargetFields,
      currencies: async () => THREE,
      standardPricebooks: async () => ({ source: SOURCE_STANDARD, target: TARGET_STANDARD }),
      // A run nobody is asked about, as from the command line.
      writeGate: syncWriteGate(measures, {
        policy: 'refuse',
        org: 'TARGET',
        orgTier: 'development',
      }),
    });
  }

  it('counts at its dry run’s check the prices its simulation inserts, the GBP ones standing in', async () => {
    const simulation = await catalogOrchestrator(targetOrg()).simulate(BOOKS_ON_DESCRIPTION);

    expect(simulation.error).toBeUndefined();
    expect(
      simulation.objects.map((o) => [o.objectApiName, o.read, o.insert, o.refused ?? 0]),
    ).toEqual([
      ['Product2', 3, 3, 0],
      ['Pricebook2', 2, 0, 1],
      ['PricebookEntry', 13, 6, 4],
      ['Opportunity', 3, 1, 2],
      ['OpportunityLineItem', 4, 1, 3],
    ]);
    const check = simulation.writeCheck;
    expect(check?.objects).toEqual([
      { objectApiName: 'PricebookEntry', rows: 6 },
      { objectApiName: 'Product2', rows: 3 },
      { objectApiName: 'Opportunity', rows: 1 },
      { objectApiName: 'OpportunityLineItem', rows: 1 },
    ]);
    expect(check?.total).toBe(11);
    expect(check?.notWritten).toBeUndefined();
    expect(check?.heldBack).toEqual([
      { objectApiName: 'PricebookEntry', rows: 4, parent: 'Pricebook2', field: 'Pricebook2Id' },
      { objectApiName: 'Opportunity', rows: 2, parent: 'Pricebook2', field: 'Pricebook2Id' },
      {
        objectApiName: 'OpportunityLineItem',
        rows: 3,
        parent: 'Opportunity',
        field: 'OpportunityId',
      },
    ]);
  });

  it('counts at its gate what it writes when it leaves no object out: the standard book and the GBP prices apart', async () => {
    // The same catalog, its books inserted: the standard one matched, never
    // written, and the GBP prices left out for the USD ones.
    const target = targetOrg();

    const simulation = await catalogOrchestrator(target).simulate(CONFIG);
    const result = await catalogOrchestrator(target).execute(CONFIG);

    const written = result.objectResults.map((r) => [r.objectApiName, r.success, r.failed]);
    expect(written).toEqual([
      ['Product2', 3, 0],
      ['Pricebook2', 1, 0],
      ['PricebookEntry', 10, 0],
      ['Opportunity', 3, 0],
      ['OpportunityLineItem', 4, 0],
    ]);
    expect(
      simulation.writeCheck?.objects
        .map((o) => [o.objectApiName, o.rows])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    ).toEqual([
      ['Opportunity', 3],
      ['OpportunityLineItem', 4],
      ['Pricebook2', 1],
      ['PricebookEntry', 10],
      ['Product2', 3],
    ]);
    expect(simulation.writeCheck?.total).toBe(21);
    expect(simulation.writeCheck?.notWritten).toBeUndefined();
  });

  it('names at its refusal the one price book it refuses, the standard one being matched', async () => {
    const simulation = await catalogOrchestrator(targetOrg()).simulate(BOOKS_ON_DESCRIPTION);

    expect(simulation.writeCheck?.unwritable).toEqual([
      { key: 'Description', objectApiName: 'Pricebook2', rows: 1, why: 'notAKey' },
    ]);
    // The refusal a real run meets, in the words the command line prints.
    const refused = await catalogOrchestrator(targetOrg())
      .execute(BOOKS_ON_DESCRIPTION)
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    expect(refused).toBeInstanceOf(SyncRunRefused);
    expect((refused as SyncRunRefused).code).toBe('SYNC_TARGET_UNWRITABLE');
    expect((refused as SyncRunRefused).message).toContain(
      'TARGET would take no record of one object the sync writes — Pricebook2 (1 record): ' +
        'its upsert matches on Description',
    );
  });
});
