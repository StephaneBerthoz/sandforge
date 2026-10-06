import { describe, it, expect, vi } from 'vitest';
import type { ForgeGraph, ForgeGraphEdge, ForgeGraphNode } from '@sandforge/shared';
import { forgeGapId } from '@sandforge/shared';
import { ForgeExecutor } from './ForgeExecutor.js';
import type {
  ExecuteOptions,
  ExecutionSummary,
  FieldInfo,
  ForgeExecutorDeps,
  ForgeProgressEvent,
  InsertResult,
  TargetObjectInfo,
} from './ForgeExecutor.js';
import type {
  RecordTypePicklist,
  RecordTypePicklists,
} from '../../core/metadata/recordTypePicklists.js';
import type { RecordTypeAvailability } from '../../core/metadata/recordTypeAvailability.js';
import { selectRows, type FakeRow } from '../../test/fakeSoql.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** A fake id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const ACCOUNT = id('001', 1);
const SOURCE_RETAIL = id('012', 1);
const SOURCE_TRADE = id('012', 2);
const TARGET_RETAIL = id('012', 101);
const TARGET_TRADE = id('012', 102);
const TARGET_WHOLESALE = id('012', 103);

const field = (name: string, overrides: Partial<FieldInfo> = {}): FieldInfo => ({
  name,
  queryable: true,
  createable: name !== 'Id',
  isReference: false,
  ...overrides,
});

/** The order's fields both orgs have. */
const SHARED_FIELDS: FieldInfo[] = [
  field('Id'),
  field('Name', { type: 'string', length: 80 }),
  field('Account__c', { isReference: true, referenceTo: ['Account'], nillable: false }),
  field('RecordTypeId', { isReference: true, referenceTo: ['RecordType'] }),
  field('Status__c', {
    type: 'picklist',
    restrictedPicklist: true,
    picklistValues: ['New', 'Open', 'Old'],
  }),
  field('Amount__c', { type: 'currency', precision: 18, scale: 2 }),
  field('Code__c', { type: 'string', length: 20 }),
  field('CurrencyIsoCode', { type: 'picklist', picklistValues: ['EUR', 'USD'] }),
];

/**
 * The target's describe of the order: a region it requires that the source
 * does not have, a name of 5 characters, an amount of 5 digits with 2 after
 * the point, and a code it holds unique.
 */
const TARGET_ORDER_FIELDS: FieldInfo[] = SHARED_FIELDS.map((f): FieldInfo => {
  if (f.name === 'Name') return { ...f, length: 5 };
  if (f.name === 'Amount__c') return { ...f, precision: 5, scale: 2 };
  if (f.name === 'Code__c') return { ...f, unique: true };
  return f;
}).concat([field('Region__c', { type: 'string', length: 40, nillable: false })]);

const ACCOUNT_FIELDS: FieldInfo[] = [field('Id'), field('Name', { type: 'string', length: 255 })];

function node(objectApiName: string, level: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 3,
    fieldCount: 6,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 5,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'auto',
  };
}

const ORDERS: ForgeGraphEdge = {
  sourceObject: 'Account',
  targetObject: 'Order__c',
  relationshipName: 'Orders__r',
  type: 'lookup',
};

const GRAPH: ForgeGraph = {
  nodes: [node('Account', 0), node('Order__c', 1)],
  edges: [ORDERS],
  totalRecords: 4,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 0,
};

/** An order of the account. */
function order(
  n: number,
  recordType: string,
  status: string,
  extra: Partial<Record<string, string>> = {},
): FakeRow {
  return {
    Id: id('a01', n),
    Name: `O${n}`,
    Account__c: ACCOUNT,
    RecordTypeId: recordType,
    Status__c: status,
    Amount__c: '10',
    Code__c: `C-${n}`,
    CurrencyIsoCode: 'EUR',
    ...extra,
  };
}

const SOURCE: Record<string, FakeRow[]> = {
  Account: [{ Id: ACCOUNT, Name: 'Acme' }],
  Order__c: [
    // "Old" is active in the target, and Retail there does not keep it.
    order(1, SOURCE_RETAIL, 'Old', { Name: 'Longer than five' }),
    order(2, SOURCE_RETAIL, 'Open', { Amount__c: '12345.5' }),
    order(3, SOURCE_TRADE, 'Old', { Code__c: 'TAKEN', CurrencyIsoCode: 'USD' }),
  ],
};

/** What the target holds of the order: the code one row holds. */
const TARGET: Record<string, FakeRow[]> = {
  Order__c: [{ Id: id('a01', 500), Code__c: 'TAKEN' }],
};

const keeps = (values: string[], defaultValue: string | null = null): RecordTypePicklist => ({
  values,
  defaultValue,
});

const TARGET_RECORD_TYPE_VALUES: Record<string, RecordTypePicklists> = {
  [TARGET_RETAIL]: new Map([['Status__c', keeps(['New', 'Open'], 'New')]]),
  [TARGET_TRADE]: new Map([['Status__c', keeps(['New', 'Old'])]]),
  [TARGET_WHOLESALE]: new Map([['Status__c', keeps(['New', 'Open', 'Old'])]]),
};

const recordType = (
  recordTypeId: string,
  developerName: string,
  available = true,
): RecordTypeAvailability => ({
  recordTypeId,
  developerName,
  name: developerName,
  available,
  active: true,
  master: false,
  defaultRecordTypeMapping: false,
});

const OPTIONS: ExecuteOptions = {
  rootRecordId: ACCOUNT,
  rootObjectApiName: 'Account',
  recordTypeMappings: [
    { sourceId: SOURCE_RETAIL, targetId: TARGET_RETAIL, developerName: 'Retail' },
    { sourceId: SOURCE_TRADE, targetId: TARGET_TRADE, developerName: 'Trade' },
  ],
};

/**
 * A source holding the rows above, and a target with the describe above that
 * takes every record it is sent — with Trade closed to the user the run writes
 * as when `tradeClosed`.
 */
function fakeOrgs({ tradeClosed = false }: { tradeClosed?: boolean } = {}) {
  const sent: Array<{ object: string; row: Record<string, unknown> }> = [];
  const targetQueries: string[] = [];
  let next = 0;
  const deps = {
    describeFields: vi.fn(async (org: string, object: string) => {
      if (object === 'Account') return ACCOUNT_FIELDS;
      return org === 'tgt' ? TARGET_ORDER_FIELDS : SHARED_FIELDS;
    }),
    queryRecords: vi.fn(async (org: string, soql: string) => {
      if (org === 'src') return selectRows(SOURCE, soql);
      targetQueries.push(soql);
      if (soql === 'SELECT IsoCode FROM CurrencyType WHERE IsActive = true') {
        return [{ IsoCode: 'EUR' }];
      }
      return soql.includes(' WHERE ') ? selectRows(TARGET, soql) : [];
    }),
    insertRecords: vi.fn(
      async (
        _org: string,
        object: string,
        rows: Record<string, unknown>[],
      ): Promise<InsertResult[]> => {
        for (const row of rows) sent.push({ object, row });
        return rows.map(() => ({ id: id('a99', ++next), success: true, errors: [] }));
      },
    ),
    updateRecords: vi.fn(async () => []),
    upsertRecords: vi.fn(async () => []),
    describeObject: vi.fn(async (org: string, object: string): Promise<TargetObjectInfo> => {
      if (object !== 'Order__c') return { keyPrefix: '001', recordTypes: [] };
      return org === 'tgt'
        ? {
            keyPrefix: 'a01',
            recordTypes: [
              recordType(TARGET_RETAIL, 'Retail'),
              recordType(TARGET_TRADE, 'Trade', !tradeClosed),
              recordType(TARGET_WHOLESALE, 'Wholesale'),
            ],
          }
        : {
            keyPrefix: 'a01',
            recordTypes: [recordType(SOURCE_RETAIL, 'Retail'), recordType(SOURCE_TRADE, 'Trade')],
          };
    }),
    recordTypePicklists: vi.fn(
      async (_org: string, _object: string, rt: string) => TARGET_RECORD_TYPE_VALUES[rt],
    ),
  } satisfies ForgeExecutorDeps;
  return { deps, sent, targetQueries };
}

async function run(deps: ForgeExecutorDeps, options: ExecuteOptions) {
  const events: ForgeProgressEvent[] = [];
  const summary = await new ForgeExecutor(deps).execute(
    GRAPH,
    'src',
    'tgt',
    (event) => events.push(event),
    options,
  );
  return { summary, events };
}

const gapOf = (summary: ExecutionSummary, gapId: string) =>
  summary.gaps?.find((gap) => gap.id === gapId);

describe('ForgeExecutor, a simulation through the write stage', () => {
  it('writes nothing, and gives back none of the ids it used in place of the target’s', async () => {
    const { deps } = fakeOrgs();

    const { summary } = await run(deps, { ...OPTIONS, dryRun: true });

    expect(deps.insertRecords).not.toHaveBeenCalled();
    expect(deps.updateRecords).not.toHaveBeenCalled();
    expect(deps.upsertRecords).not.toHaveBeenCalled();
    expect(summary.dryRun).toBe(true);
    // The account and its three orders, none held back for want of the
    // account it would have written first.
    expect(summary.wouldInsertCount).toBe(4);
    expect(summary.successCount).toBe(0);
    expect(summary.remapTable).toEqual({});
    expect(summary.remapCount).toBe(0);
    expect(summary.createdByObject).toEqual([]);
    expect(summary.remapByObject).toEqual([]);
  });

  it('counts as failed, not as would be inserted, the rows a real run holds back at the write', async () => {
    // Trade is closed to the user the run writes as: a real run holds the
    // order object back whole before its first call. Stopped before the
    // write stage, a dry run said all four would be inserted.
    const { deps } = fakeOrgs({ tradeClosed: true });

    const { summary } = await run(deps, { ...OPTIONS, dryRun: true });

    expect(summary.wouldInsertCount).toBe(1);
    expect(summary.failedCount).toBe(3);
    expect(
      gapOf(summary, forgeGapId('record_type_unavailable', 'Order__c', 'RecordTypeId', 'Trade')),
    ).toMatchObject({
      kind: 'record_type_unavailable',
      severity: 'blocking',
      source: 'simulation',
      rows: 1,
      detail: { mapTo: ['Retail', 'Wholesale'] },
    });
  });

  it('ends each object on what its write would have done', async () => {
    const { deps } = fakeOrgs();

    const { events } = await run(deps, { ...OPTIONS, dryRun: true });

    const last = events.filter((e) => e.objectName === 'Order__c').at(-1);
    expect(last?.status).toBe('done');
    expect(last?.message).toMatch(/^Simulated Order__c: 3 would be inserted, 0 failed/);
  });

  it('finds the picklist values a record type refuses, with what a real run writes instead', async () => {
    const { deps } = fakeOrgs();

    const { summary } = await run(deps, { ...OPTIONS, dryRun: true });

    expect(
      gapOf(
        summary,
        forgeGapId('picklist_value_refused', 'Order__c', 'Status__c', 'Retail', 'Old'),
      ),
    ).toEqual({
      id: forgeGapId('picklist_value_refused', 'Order__c', 'Status__c', 'Retail', 'Old'),
      kind: 'picklist_value_refused',
      severity: 'warning',
      source: 'simulation',
      objectApiName: 'Order__c',
      field: 'Status__c',
      recordType: 'Retail',
      value: 'Old',
      rows: 1,
      detail: { reason: 'record-type', allowed: ['New', 'Open'], replacement: 'New' },
      decisions: ['map_value', 'leave_empty', 'skip_rows', 'exclude_object', 'ignore'],
      defaultDecision: 'map_value',
    });
  });

  it('finds a field only the target requires, a text longer than its field and a number past its digits', async () => {
    const { deps } = fakeOrgs();

    const { summary } = await run(deps, { ...OPTIONS, dryRun: true });

    expect(
      gapOf(summary, forgeGapId('required_field_missing', 'Order__c', 'Region__c')),
    ).toMatchObject({
      severity: 'blocking',
      rows: 3,
      decisions: ['set_default', 'exclude_object', 'ignore'],
    });
    // The lengths, never the text.
    expect(gapOf(summary, forgeGapId('value_too_long', 'Order__c', 'Name'))).toMatchObject({
      rows: 1,
      detail: { length: 5, longest: 16 },
    });
    expect(
      gapOf(summary, forgeGapId('number_out_of_range', 'Order__c', 'Amount__c')),
    ).toMatchObject({
      rows: 1,
      detail: { precision: 5, scale: 2 },
    });
    // The account fits.
    expect(summary.gaps?.some((gap) => gap.objectApiName === 'Account')).toBe(false);
  });

  it('asks the target for the unique values the rows hold and counts those it holds already, never keeping one', async () => {
    const { deps, targetQueries } = fakeOrgs();

    const { summary } = await run(deps, { ...OPTIONS, dryRun: true });

    expect(targetQueries).toContain(
      "SELECT Code__c FROM Order__c WHERE Code__c IN ('C-1', 'C-2', 'TAKEN')",
    );
    const gap = gapOf(summary, forgeGapId('unique_value_collision', 'Order__c', 'Code__c'));
    expect(gap).toMatchObject({ rows: 1, detail: { colliding: 1 } });
    expect(JSON.stringify(summary.gaps)).not.toContain('TAKEN');
  });

  it('says a currency the target does not hold active, read once', async () => {
    const { deps, targetQueries } = fakeOrgs();

    const { summary } = await run(deps, { ...OPTIONS, dryRun: true });

    expect(
      gapOf(
        summary,
        forgeGapId('currency_inactive', 'Order__c', 'CurrencyIsoCode', undefined, 'USD'),
      ),
    ).toMatchObject({
      severity: 'blocking',
      rows: 1,
      defaultDecision: 'leave_empty',
    });
    expect(targetQueries.filter((q) => q.includes('FROM CurrencyType'))).toHaveLength(1);
  });

  it('names a record type the target has no counterpart of by its name in the source', async () => {
    const { deps } = fakeOrgs();

    const { summary } = await run(deps, {
      ...OPTIONS,
      dryRun: true,
      recordTypeMappings: [OPTIONS.recordTypeMappings![0]],
    });

    expect(
      gapOf(
        summary,
        forgeGapId('record_type_unmapped', 'Order__c', 'RecordTypeId', undefined, 'Trade'),
      ),
    ).toMatchObject({
      severity: 'blocking',
      rows: 1,
      detail: { mapTo: ['Retail', 'Trade', 'Wholesale'] },
      decisions: ['map_record_type', 'exclude_object', 'ignore'],
    });
  });

  it('still reports a gap the user chose to ignore, marked so', async () => {
    const { deps } = fakeOrgs();
    const ignored = forgeGapId('required_field_missing', 'Order__c', 'Region__c');

    const { summary } = await run(deps, {
      ...OPTIONS,
      dryRun: true,
      decisions: { ignoredGaps: [ignored] },
    });

    expect(gapOf(summary, ignored)?.detail).toMatchObject({ ignored: true });
  });

  it('reports no gap on a real run', async () => {
    const { deps } = fakeOrgs();

    const { summary } = await run(deps, OPTIONS);

    expect(summary.gaps).toBeUndefined();
    expect(summary.dryRun).toBeUndefined();
  });
});

describe('ForgeExecutor, the user’s decisions about the rows', () => {
  it('writes a picklist value as the user mapped it, for the record type the mapping names', async () => {
    const { deps, sent } = fakeOrgs();

    const { summary } = await run(deps, {
      ...OPTIONS,
      decisions: {
        picklistValueMappings: [
          { object: 'Order__c', field: 'Status__c', recordType: 'Retail', from: 'Old', to: 'Open' },
        ],
      },
    });

    const orders = sent.filter((s) => s.object === 'Order__c').map((s) => s.row['Status__c']);
    // Retail's "Old" goes as "Open"; Trade keeps "Old", which it allows.
    expect(orders).toEqual(['Open', 'Open', 'Old']);
    expect(summary.picklistValuesChanged).toBeUndefined();
    expect(summary.decisionsApplied).toEqual([
      {
        kind: 'map_value',
        objectApiName: 'Order__c',
        field: 'Status__c',
        recordType: 'Retail',
        from: 'Old',
        to: 'Open',
        rows: 1,
      },
    ]);
  });

  it('leaves a value out when the user mapped it to nothing', async () => {
    const { deps, sent } = fakeOrgs();

    const { summary } = await run(deps, {
      ...OPTIONS,
      decisions: {
        picklistValueMappings: [{ object: 'Order__c', field: 'Status__c', from: 'Old', to: null }],
      },
    });

    const orders = sent.filter((s) => s.object === 'Order__c').map((s) => 'Status__c' in s.row);
    expect(orders).toEqual([false, true, false]);
    expect(summary.decisionsApplied).toEqual([
      expect.objectContaining({ kind: 'leave_empty', field: 'Status__c', from: 'Old', rows: 2 }),
    ]);
  });

  it('gives a default to a field the rows leave empty, and cuts a text to the target’s length', async () => {
    const { deps, sent } = fakeOrgs();

    const { summary } = await run(deps, {
      ...OPTIONS,
      decisions: {
        defaultValues: [{ object: 'Order__c', field: 'Region__c', value: 'North' }],
        truncateFields: [{ object: 'Order__c', field: 'Name' }],
      },
    });

    const orders = sent.filter((s) => s.object === 'Order__c').map((s) => s.row);
    expect(orders.map((row) => row['Region__c'])).toEqual(['North', 'North', 'North']);
    expect(orders.map((row) => row['Name'])).toEqual(['Longe', 'O2', 'O3']);
    expect(summary.decisionsApplied).toEqual([
      { kind: 'set_default', objectApiName: 'Order__c', field: 'Region__c', to: 'North', rows: 3 },
      { kind: 'truncate', objectApiName: 'Order__c', field: 'Name', rows: 1 },
    ]);
  });

  it('applies the decisions in a simulation too, and finds no gap they settle', async () => {
    const { deps } = fakeOrgs();

    const { summary } = await run(deps, {
      ...OPTIONS,
      dryRun: true,
      decisions: {
        defaultValues: [{ object: 'Order__c', field: 'Region__c', value: 'North' }],
        truncateFields: [{ object: 'Order__c', field: 'Name' }],
      },
    });

    expect(deps.insertRecords).not.toHaveBeenCalled();
    expect(
      gapOf(summary, forgeGapId('required_field_missing', 'Order__c', 'Region__c')),
    ).toBeUndefined();
    expect(gapOf(summary, forgeGapId('value_too_long', 'Order__c', 'Name'))).toBeUndefined();
    expect(summary.decisionsApplied?.map((d) => d.kind)).toEqual(['set_default', 'truncate']);
  });

  it('writes a source record type as the target one the user chose, and as the default when told', async () => {
    const { deps, sent } = fakeOrgs();

    const { summary } = await run(deps, {
      ...OPTIONS,
      decisions: {
        recordTypeMappings: [
          { object: 'Order__c', from: 'Retail', to: 'Wholesale' },
          { object: 'Order__c', from: 'Trade', to: null },
        ],
      },
    });

    const orders = sent.filter((s) => s.object === 'Order__c').map((s) => s.row);
    expect(orders.map((row) => row['RecordTypeId'])).toEqual([
      TARGET_WHOLESALE,
      TARGET_WHOLESALE,
      undefined,
    ]);
    // Wholesale keeps "Old": no value of the Retail rows is changed.
    expect(orders.map((row) => row['Status__c'])).toEqual(['Old', 'Open', 'Old']);
    expect(summary.decisionsApplied).toEqual([
      {
        kind: 'map_record_type',
        objectApiName: 'Order__c',
        from: 'Retail',
        to: 'Wholesale',
        rows: 2,
      },
      { kind: 'map_record_type', objectApiName: 'Order__c', from: 'Trade', rows: 1 },
    ]);
  });

  it('says a record type decision the orgs cannot back, and applies none of it', async () => {
    const { deps, sent } = fakeOrgs();

    const { summary } = await run(deps, {
      ...OPTIONS,
      decisions: { recordTypeMappings: [{ object: 'Order__c', from: 'Retail', to: 'Missing' }] },
    });

    expect(sent.filter((s) => s.object === 'Order__c')[0]?.row['RecordTypeId']).toBe(TARGET_RETAIL);
    expect(summary.errors).toContainEqual(
      expect.objectContaining({
        objectApiName: 'Order__c',
        failedCount: 0,
        samples: [
          {
            recordSummary: '(record type Retail → Missing)',
            messages: [
              'The decision was not applied: the target has no Order__c record type named Missing.',
            ],
          },
        ],
      }),
    );
  });
});

describe('ForgeExecutor, the rows the user chose to hold back', () => {
  const RETAIL_OLD = forgeGapId('picklist_value_refused', 'Order__c', 'Status__c', 'Retail', 'Old');
  const USD = forgeGapId('currency_inactive', 'Order__c', 'CurrencyIsoCode', undefined, 'USD');

  it('holds back the rows holding the value, for the record type the gap names, and writes the others', async () => {
    const { deps, sent } = fakeOrgs();

    const { summary, events } = await run(deps, {
      ...OPTIONS,
      decisions: { skippedRows: [{ object: 'Order__c', gapId: RETAIL_OLD }] },
    });

    // The Retail order holding "Old" stays out; the Trade one holding it,
    // which Trade allows, goes as read.
    const orders = sent.filter((s) => s.object === 'Order__c').map((s) => s.row['Name']);
    expect(orders).toEqual(['O2', 'O3']);
    expect(summary.failedCount).toBe(0);
    expect(summary.decisionsApplied).toEqual([
      {
        kind: 'skip_rows',
        objectApiName: 'Order__c',
        field: 'Status__c',
        recordType: 'Retail',
        from: 'Old',
        rows: 1,
      },
    ]);
    expect(events.map((e) => e.message)).toContain(
      'Order__c: 1 record held back, as decided on the gaps',
    );
  });

  it('holds back the rows of a currency the target does not hold active', async () => {
    const { deps, sent } = fakeOrgs();

    const { summary } = await run(deps, {
      ...OPTIONS,
      decisions: { skippedRows: [{ object: 'Order__c', gapId: USD }] },
    });

    expect(sent.filter((s) => s.object === 'Order__c').map((s) => s.row['Name'])).toEqual([
      'Longer than five',
      'O2',
    ]);
    expect(summary.decisionsApplied).toEqual([
      expect.objectContaining({
        kind: 'skip_rows',
        field: 'CurrencyIsoCode',
        from: 'USD',
        rows: 1,
      }),
    ]);
  });

  it('holds them back in a simulation too, where the gap they settle is found no more', async () => {
    const { deps } = fakeOrgs();

    const { summary } = await run(deps, {
      ...OPTIONS,
      dryRun: true,
      decisions: { skippedRows: [{ object: 'Order__c', gapId: RETAIL_OLD }] },
    });

    expect(summary.wouldInsertCount).toBe(3);
    expect(gapOf(summary, RETAIL_OLD)).toBeUndefined();
  });

  it('holds back nothing for a gap whose rows are not exactly those holding its value', async () => {
    // A dependent value goes in on the rows whose controlling value allows
    // it, and a rehearsal's refusal judged a sample: neither names the rows.
    const { deps, sent } = fakeOrgs();

    const { summary } = await run(deps, {
      ...OPTIONS,
      decisions: {
        skippedRows: [
          {
            object: 'Order__c',
            gapId: forgeGapId('dependent_value_invalid', 'Order__c', 'Status__c', undefined, 'Old'),
          },
          {
            object: 'Order__c',
            gapId: forgeGapId('rehearsal_refusal', 'Order__c', undefined, undefined, 'X'),
          },
        ],
      },
    });

    expect(sent.filter((s) => s.object === 'Order__c')).toHaveLength(3);
    expect(summary.decisionsApplied).toBeUndefined();
  });

  it('writes nothing of an object whose every row is held back, and fails none of them', async () => {
    const { deps, sent } = fakeOrgs();

    const { summary } = await run(deps, {
      ...OPTIONS,
      decisions: {
        skippedRows: [
          { object: 'Order__c', gapId: RETAIL_OLD },
          {
            object: 'Order__c',
            gapId: forgeGapId('picklist_value_absent', 'Order__c', 'Status__c', undefined, 'Open'),
          },
          { object: 'Order__c', gapId: USD },
        ],
      },
    });

    expect(sent.filter((s) => s.object === 'Order__c')).toEqual([]);
    expect(summary.failedCount).toBe(0);
    expect(summary.successCount).toBe(1);
    expect(summary.decisionsApplied?.reduce((sum, d) => sum + d.rows, 0)).toBe(3);
  });
});

describe('ForgeExecutor, rows a call may have written', () => {
  it('keeps, per object, the rows of a call whose answer never came back', async () => {
    const { deps } = fakeOrgs();
    deps.insertRecords.mockImplementation(async (_org, object, rows) => {
      if (object === 'Order__c') {
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      }
      return rows.map(() => ({ id: id('001', 900), success: true, errors: [] }));
    });

    const { summary } = await run(deps, OPTIONS);

    expect(summary.mayHaveBeenWritten).toEqual([
      { objectApiName: 'Order__c', sourceIds: [id('a01', 1), id('a01', 2), id('a01', 3)] },
    ]);
    // Failed, and none of them among what the run created.
    expect(summary.failedCount).toBe(3);
    expect(summary.createdByObject).toEqual([{ objectApiName: 'Account', sourceIds: [ACCOUNT] }]);
  });

  it('keeps none when every call was answered', async () => {
    const { deps } = fakeOrgs();

    const { summary } = await run(deps, OPTIONS);

    expect(summary.mayHaveBeenWritten).toBeUndefined();
  });
});
