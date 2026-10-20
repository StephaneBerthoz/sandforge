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
 * Two fake orgs with several currencies: a source holding USD, its corporate
 * currency, EUR at 0.92 and GBP at 0.79; a target holding USD and EUR at
 * 0.90, and no GBP, whose insert refuses a currency it does not hold active
 * as Salesforce refused it on a real pair of orgs.
 */

const CURRENCIES: RunCurrencies = {
  source: orgCurrenciesOf([
    { IsoCode: 'USD', ConversionRate: 1, IsActive: true, IsCorporate: true },
    { IsoCode: 'EUR', ConversionRate: 0.92, IsActive: true },
    { IsoCode: 'GBP', ConversionRate: 0.79, IsActive: true },
  ])!,
  target: orgCurrenciesOf([
    { IsoCode: 'USD', ConversionRate: 1, IsActive: true, IsCorporate: true },
    { IsoCode: 'EUR', ConversionRate: 0.9, IsActive: true },
  ])!,
};

const DESCRIBES: Record<string, TargetWriteFields> = {
  Account: targetWriteFieldsOf({
    name: 'Account',
    fields: [
      { name: 'Name', createable: true, type: 'string' },
      { name: 'CurrencyIsoCode', createable: true, type: 'picklist' },
      { name: 'AnnualRevenue', createable: true, type: 'currency', precision: 18, scale: 0 },
    ],
  }),
  Opportunity: targetWriteFieldsOf({
    name: 'Opportunity',
    fields: [
      { name: 'Name', createable: true, type: 'string' },
      { name: 'CurrencyIsoCode', createable: true, type: 'picklist' },
      { name: 'Amount', createable: true, type: 'currency', precision: 18, scale: 2 },
      { name: 'AccountId', createable: true, type: 'reference' },
    ],
  }),
  Contact: targetWriteFieldsOf({
    name: 'Contact',
    fields: [{ name: 'LastName', createable: true, type: 'string' }],
  }),
  // The platform gives a line item its opportunity's currency, and takes none of its own.
  OpportunityLineItem: targetWriteFieldsOf({
    name: 'OpportunityLineItem',
    fields: [
      { name: 'Name', createable: true, type: 'string' },
      { name: 'OpportunityId', createable: true, type: 'reference' },
      { name: 'CurrencyIsoCode', createable: false, type: 'picklist' },
      { name: 'UnitPrice', createable: true, type: 'currency', precision: 18, scale: 2 },
    ],
  }),
};

const SOURCE_ROWS: Record<string, Array<Record<string, unknown>>> = {
  Account: [
    { Id: '001000000000001AAA', Name: 'Business 05', CurrencyIsoCode: 'GBP', AnnualRevenue: 790 },
    { Id: '001000000000002AAA', Name: 'Business 06', CurrencyIsoCode: 'EUR', AnnualRevenue: 920 },
  ],
  Opportunity: [
    {
      Id: '006000000000001AAA',
      Name: 'Deal 05',
      CurrencyIsoCode: 'GBP',
      Amount: 5000.55,
      AccountId: '001000000000001AAA',
    },
    {
      Id: '006000000000002AAA',
      Name: 'Deal 06',
      CurrencyIsoCode: 'EUR',
      Amount: 100,
      AccountId: '001000000000002AAA',
    },
  ],
  Contact: [{ Id: '003000000000001AAA', LastName: 'Roe' }],
  OpportunityLineItem: [
    {
      Id: '00k000000000001AAA',
      Name: 'Line 05',
      OpportunityId: '006000000000001AAA',
      CurrencyIsoCode: 'GBP',
      UnitPrice: 79,
    },
    {
      Id: '00k000000000002AAA',
      Name: 'Line 06',
      OpportunityId: '006000000000002AAA',
      CurrencyIsoCode: 'EUR',
      UnitPrice: 50,
    },
  ],
};

/** The target org: what it holds, and an insert that refuses a currency it does not hold active. */
function targetOrg() {
  const held = new Map<string, Record<string, unknown>>();
  let next = 900;
  const insert = async (
    object: string,
    records: Record<string, unknown>[],
  ): Promise<OperationOutcome[]> =>
    records.map((record) => {
      const currency = record['CurrencyIsoCode'];
      if (typeof currency === 'string' && !CURRENCIES.target.active.has(currency)) {
        return {
          success: false,
          errors: [
            `INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: ${object} Currency: invalid currency code: ${currency}`,
          ],
        };
      }
      const id = `${object.slice(0, 3)}000000000${next++}AAA`;
      held.set(id, { ...record, object });
      return { id, success: true, errors: [] };
    });
  const find = async (): Promise<ReadonlyMap<string, number>> => new Map();
  return { held, insert, find };
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
  id: 'config-currencies',
  name: 'Accounts and opportunities',
  description: '',
  sourceOrgId: 'src-org',
  targetOrgId: 'tgt-org',
  direction: 'source_to_target',
  mode: 'full',
  objects: [objectConfig('Account', 0), objectConfig('Opportunity', 1)],
  conflictStrategy: 'source_wins',
  enableRollback: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function orchestrator(
  target: ReturnType<typeof targetOrg>,
  currencies?: () => Promise<RunCurrencies | undefined>,
) {
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
    findInTarget: target.find,
    describeTargetFields,
    ...(currencies ? { currencies } : {}),
  });
}

const GBP_ACCOUNT =
  "1 row(s) in GBP written in USD, the target's corporate currency, GBP not being active " +
  "there: amounts converted at the source's rates (AnnualRevenue).";
const GBP_DEAL =
  "1 row(s) in GBP written in USD, the target's corporate currency, GBP not being active " +
  "there: amounts converted at the source's rates (Amount).";

describe('SyncOrchestrator — a currency the target does not hold active', () => {
  it('writes the row in the target’s corporate currency, its amounts converted at the source’s rates', async () => {
    const target = targetOrg();

    const result = await orchestrator(target, async () => CURRENCIES).execute(CONFIG);

    expect(result.totalFailed).toBe(0);
    const written = [...target.held.values()];
    expect(written.find((r) => r['Name'] === 'Deal 05')).toMatchObject({
      CurrencyIsoCode: 'USD',
      Amount: 6329.81,
    });
    expect(written.find((r) => r['Name'] === 'Business 05')).toMatchObject({
      CurrencyIsoCode: 'USD',
      AnnualRevenue: 1000,
    });
    // A currency the target holds goes as read, its amounts with it.
    expect(written.find((r) => r['Name'] === 'Deal 06')).toMatchObject({
      CurrencyIsoCode: 'EUR',
      Amount: 100,
    });
    // Said apart from the errors — none of them is one — as the history
    // shows them, in the user's language.
    expect(result.objectResults[0].currenciesReplaced).toEqual([
      expect.objectContaining({ from: 'GBP', to: 'USD', rows: 1, fields: ['AnnualRevenue'] }),
    ]);
    expect(result.objectResults[1].currenciesReplaced).toEqual([
      expect.objectContaining({ from: 'GBP', to: 'USD', rows: 1, fields: ['Amount'] }),
    ]);
    expect(result.objectResults[1].errors).not.toContain(GBP_DEAL);
  });

  it('predicts in the simulation the currency and the amounts the run writes, reading both orgs once', async () => {
    let asked = 0;
    const currencies = async () => {
      asked++;
      return CURRENCIES;
    };

    const simulated = await orchestrator(targetOrg(), currencies).simulate(CONFIG);
    const run = await orchestrator(targetOrg(), async () => CURRENCIES).execute(CONFIG);

    expect(simulated.error).toBeUndefined();
    expect(asked).toBe(1);
    expect(simulated.objects.map((o) => [o.objectApiName, o.insert, o.refused])).toEqual(
      run.objectResults.map((r) => [r.objectApiName, r.success, r.failed]),
    );
    expect(simulated.objects[0].notes).toContain(GBP_ACCOUNT);
    expect(simulated.objects[1].notes).toContain(GBP_DEAL);
  });

  it("converts an opportunity's line items as the opportunity was converted, in the run as in its simulation", async () => {
    const target = targetOrg();
    const withLines: SyncConfig = {
      ...CONFIG,
      objects: [...CONFIG.objects, objectConfig('OpportunityLineItem', 2)],
    };

    const simulated = await orchestrator(targetOrg(), async () => CURRENCIES).simulate(withLines);
    const result = await orchestrator(target, async () => CURRENCIES).execute(withLines);

    const written = [...target.held.values()];
    expect(written.find((r) => r['Name'] === 'Line 05')).toMatchObject({ UnitPrice: 100 });
    expect(written.find((r) => r['Name'] === 'Line 05')).not.toHaveProperty('CurrencyIsoCode');
    expect(written.find((r) => r['Name'] === 'Line 06')).toMatchObject({ UnitPrice: 50 });
    const line =
      '1 row(s) in GBP written in USD, the currency of the record they belong to: amounts ' +
      "converted at the source's rates (UnitPrice).";
    expect(result.objectResults[2].currenciesReplaced).toEqual([
      expect.objectContaining({ chosenBy: 'parent', rows: 1, fields: ['UnitPrice'] }),
    ]);
    expect(simulated.objects[2].notes).toContain(line);
  });

  it('reads no currency for objects whose rows carry none', async () => {
    let asked = 0;

    await orchestrator(targetOrg(), async () => {
      asked++;
      return CURRENCIES;
    }).execute({ ...CONFIG, objects: [objectConfig('Contact', 0)] });

    expect(asked).toBe(0);
  });
});
