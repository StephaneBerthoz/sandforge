import { describe, it, expect } from 'vitest';
import type { SyncConfig, SyncObjectConfig } from '@sandforge/shared';
import { SyncOrchestrator } from './SyncOrchestrator.js';
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
        if (!priced || priced['CurrencyIsoCode'] !== deal?.['CurrencyIsoCode']) {
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
    expect(result.objectResults[1].errors).toContain(
      "The standard price book is matched to the target org's, never written.",
    );
    expect(result.objectResults[2].errors).toContain(
      "2 GBP → USD: price(s) in a currency the target does not hold active replaced by the source's " +
        'own price in the currency written, for the same product and price book.',
    );
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
  });

  it('sends the standard price book’s prices with the source’s id of it when the run cannot read both books', async () => {
    const target = targetOrg();

    const result = await orchestrator(target, false).execute(CONFIG);

    expect(result.objectResults.find((r) => r.objectApiName === 'PricebookEntry')?.success).toBe(0);
  });
});
