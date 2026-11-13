import { describe, it, expect, vi } from 'vitest';
import type { ForgeGraph, ForgeGraphEdge, ForgeGraphNode } from '@sandforge/shared';
import {
  forgeGapId,
  ignoredGapEntry,
  picklistMappingEntry,
  skippedRowsEntry,
} from '@sandforge/shared';
import { ForgeExecutor } from './ForgeExecutor.js';
import type {
  ExecuteOptions,
  ExecutionSummary,
  FieldInfo,
  ForgeExecutorDeps,
  ForgeProgressEvent,
  ForgeWriteBoundary,
  InsertResult,
  TargetObjectInfo,
} from './ForgeExecutor.js';
import { writePlanOf, type WritePlan } from './ForgeRunGate.js';
import type {
  RecordTypePicklist,
  RecordTypePicklists,
} from '../../core/metadata/recordTypePicklists.js';
import type { RecordTypeAvailability } from '../../core/metadata/recordTypeAvailability.js';
import { selectRows, type FakeRow } from '../../test/fakeSoql.js';
import { CURRENCY_TYPES_SOQL } from '../../core/common/recordCurrencies.js';
import { RECORD_TYPE_NAMES_SOQL } from '../../core/metadata/recordTypeNames.js';
import { RecordTypeMapper } from '../sync/RecordTypeMapper.js';

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
      // The source holds euros, its corporate currency, and dollars at 1.25
      // to the euro; the target euros alone.
      if (org === 'src') {
        if (soql === CURRENCY_TYPES_SOQL) {
          return [
            { IsoCode: 'EUR', ConversionRate: 1, IsActive: true, IsCorporate: true },
            { IsoCode: 'USD', ConversionRate: 1.25, IsActive: true, IsCorporate: false },
          ];
        }
        return selectRows(SOURCE, soql);
      }
      targetQueries.push(soql);
      if (soql === CURRENCY_TYPES_SOQL) {
        return [{ IsoCode: 'EUR', ConversionRate: 1, IsActive: true, IsCorporate: true }];
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

/** The region the target requires of an order, given each row by a decision. */
const REGION_GIVEN: NonNullable<ExecuteOptions['decisions']> = {
  defaultValues: [{ object: 'Order__c', field: 'Region__c', value: 'North' }],
};

describe('ForgeExecutor, a simulation through the write stage', () => {
  it('writes nothing, and gives back none of the ids it used in place of the target’s', async () => {
    const { deps } = fakeOrgs();

    // The region the target requires given, as a real run would have to.
    const { summary } = await run(deps, { ...OPTIONS, dryRun: true, decisions: REGION_GIVEN });

    expect(deps.insertRecords).not.toHaveBeenCalled();
    expect(deps.updateRecords).not.toHaveBeenCalled();
    expect(deps.upsertRecords).not.toHaveBeenCalled();
    expect(summary.dryRun).toBe(true);
    // The account and its three orders, none held back for want of the
    // account it would have written first: two orders inserted, the one
    // holding a code the target holds linked to its record.
    expect(summary.wouldInsertCount).toBe(3);
    expect(summary.linkedCount).toBe(1);
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

    const { events } = await run(deps, { ...OPTIONS, dryRun: true, decisions: REGION_GIVEN });

    const last = events.filter((e) => e.objectName === 'Order__c').at(-1);
    expect(last?.status).toBe('done');
    expect(last?.message).toMatch(
      /^Simulated Order__c: 2 would be inserted, 1 linked to records already in the target, 0 failed/,
    );
  });

  it('ends an object whose every row leaves a field the target requires empty on its refusal', async () => {
    const { deps } = fakeOrgs();

    const { summary, events } = await run(deps, { ...OPTIONS, dryRun: true });

    const last = events.filter((e) => e.objectName === 'Order__c').at(-1);
    expect(last?.status).toBe('error');
    expect(summary.wouldInsertCount).toBe(1);
    expect(summary.failedCount).toBe(3);
    expect(
      summary.errors.find((error) => error.objectApiName === 'Order__c')?.samples[0]?.messages,
    ).toEqual(['REQUIRED_FIELD_MISSING: Required fields are missing: [Region__c]']);
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

  it('counts a row whose unique value the target holds as linked, as the run that links it to the record its refusal names', async () => {
    // A real target refuses the row "DUPLICATE_VALUE: duplicate value found:
    // Code__c duplicates value on record with id: <its id>", and the run
    // links it. Run on a Developer Edition, the dry run of a contact's clone
    // said 3 to insert and 0 linked, and the run inserted 2 and linked 1.
    const held = id('a01', 500);
    const { deps } = fakeOrgs();
    const real = fakeOrgs();
    const inserting = real.deps.insertRecords.getMockImplementation();
    real.deps.insertRecords.mockImplementation(async (org, object, rows) => {
      const answers = (await inserting?.(org, object, rows)) ?? [];
      return answers.map((answer, at) =>
        rows[at]?.['Code__c'] === 'TAKEN'
          ? {
              id: '',
              success: false,
              errors: [
                `DUPLICATE_VALUE: duplicate value found: Code__c duplicates value on record with id: ${held}`,
              ],
            }
          : answer,
      );
    });

    const { summary, events } = await run(deps, {
      ...OPTIONS,
      dryRun: true,
      decisions: REGION_GIVEN,
    });
    const { summary: written } = await run(real.deps, { ...OPTIONS, decisions: REGION_GIVEN });

    expect(written).toMatchObject({ successCount: 3, linkedCount: 1 });
    expect(written.existingRecords).toEqual([
      { objectApiName: 'Order__c', linked: 1, unidentified: 0 },
    ]);
    expect(summary).toMatchObject({ wouldInsertCount: 3, linkedCount: 1, failedCount: 0 });
    expect(summary.existingRecords).toEqual([
      { objectApiName: 'Order__c', linked: 1, unidentified: 0 },
    ]);
    expect(events.filter((e) => e.objectName === 'Order__c').at(-1)?.message).toMatch(
      /^Simulated Order__c: 2 would be inserted, 1 linked to records already in the target, 0 failed/,
    );
    // Said as the rehearsal says the target's refusal of it: the run links it.
    expect(
      gapOf(summary, forgeGapId('unique_value_collision', 'Order__c', 'Code__c')),
    ).toMatchObject({
      severity: 'warning',
      rows: 1,
      detail: { colliding: 1, linkedToTheRecordItNames: true },
      defaultDecision: 'ignore',
    });
    // Its id is the simulation's own, never given back.
    expect(summary.remapTable).toEqual({});
    expect(summary.existingSourceIds).toEqual([]);
  });

  describe('the write gate of a row the target holds by its unique value', () => {
    /** A run's gate, kept by the name of the run: what it was shown, counted as the command line counts it. */
    function gates() {
      const shown = new Map<string, WritePlan>();
      return {
        shown,
        of: (name: string) => async (boundary: ForgeWriteBoundary) => {
          shown.set(name, writePlanOf(boundary.objects));
        },
      };
    }

    /** A target that refuses the order holding a code it holds, naming its record, as a real one does. */
    function refusingTheCode() {
      const real = fakeOrgs();
      const inserting = real.deps.insertRecords.getMockImplementation();
      real.deps.insertRecords.mockImplementation(async (org, object, rows) => {
        const answers = (await inserting?.(org, object, rows)) ?? [];
        return answers.map((answer, at) =>
          rows[at]?.['Code__c'] === 'TAKEN'
            ? {
                id: '',
                success: false,
                errors: [
                  `DUPLICATE_VALUE: duplicate value found: Code__c duplicates value on record with id: ${id('a01', 500)}`,
                ],
              }
            : answer,
        );
      });
      return real;
    }

    it('leaves it out of the gate of the dry run and of the run alike, said linked, as many as the simulation inserts and the run creates', async () => {
      // Run on a Developer Edition, the dry run of a contact's clone said
      // "write gate: 3 record(s)", then that its simulation linked one of
      // them, and the run inserted 2. An environment holds a run to its dry
      // run's gate: both gates count alike.
      const gate = gates();
      const real = refusingTheCode();

      const { summary } = await run(fakeOrgs().deps, {
        ...OPTIONS,
        dryRun: true,
        decisions: REGION_GIVEN,
        beforeWrite: gate.of('dry run'),
      });
      const { summary: written } = await run(real.deps, {
        ...OPTIONS,
        decisions: REGION_GIVEN,
        beforeWrite: gate.of('run'),
      });

      for (const name of ['dry run', 'run']) {
        const plan = gate.shown.get(name);
        expect(plan?.objects.map(({ objectApiName, rows }) => [objectApiName, rows])).toEqual([
          ['Order__c', 2],
          ['Account', 1],
        ]);
        expect(plan?.leftOut?.linkedByValue).toEqual([
          { objectApiName: 'Order__c', rows: 1, fields: ['Code__c'] },
        ]);
      }
      expect(summary).toMatchObject({ wouldInsertCount: 3, linkedCount: 1 });
      expect(gate.shown.get('dry run')?.totalRows).toBe(summary.wouldInsertCount);
      expect(written).toMatchObject({ successCount: 3, linkedCount: 1 });
      expect(gate.shown.get('run')?.totalRows).toBe(written.successCount);
      // The row still goes in the run's call, which the target refuses.
      expect(real.sent.filter(({ row }) => row['Code__c'] === 'TAKEN')).toHaveLength(1);
    });

    it('counts it where the value sent is not the value read: a field the write leaves out, or cuts', async () => {
      for (const changed of [
        { fieldExclusions: { Order__c: ['Code__c'] } },
        {
          decisions: {
            ...REGION_GIVEN,
            truncateFields: [{ object: 'Order__c', field: 'Code__c' }],
          },
        },
      ] satisfies ExecuteOptions[]) {
        const gate = gates();

        await run(fakeOrgs().deps, {
          ...OPTIONS,
          decisions: REGION_GIVEN,
          ...changed,
          dryRun: true,
          beforeWrite: gate.of('dry run'),
        });

        expect(gate.shown.get('dry run')?.totalRows).toBe(4);
        expect(gate.shown.get('dry run')?.leftOut?.linkedByValue).toBeUndefined();
      }
    });

    /**
     * A target holding the code `taken`, the field described as telling case
     * apart or not (`caseSensitive`, absent when the describe does not say),
     * answering a statement of codes as an org compares them: in any case for
     * a unique field that ignores case, as written for one that tells case
     * apart. The row holds `TAKEN`.
     */
    function holdingInAnotherCase(caseSensitive: boolean | undefined) {
      const orgs = fakeOrgs();
      const fields = TARGET_ORDER_FIELDS.map((f) =>
        f.name === 'Code__c' && caseSensitive !== undefined ? { ...f, caseSensitive } : f,
      );
      const describe = orgs.deps.describeFields.getMockImplementation();
      orgs.deps.describeFields.mockImplementation(async (org, object) =>
        org === 'tgt' && object === 'Order__c' ? fields : ((await describe?.(org, object)) ?? []),
      );
      const answer = orgs.deps.queryRecords.getMockImplementation();
      orgs.deps.queryRecords.mockImplementation(async (org, soql) => {
        if (org !== 'tgt' || !soql.startsWith('SELECT Code__c FROM Order__c WHERE Code__c IN (')) {
          return (await answer?.(org, soql)) ?? [];
        }
        const asked = [...soql.matchAll(/'([^']*)'/g)].map(([, value]) => value ?? '');
        const held = asked.some((value) =>
          caseSensitive === true ? value === 'taken' : value.toLowerCase() === 'taken',
        );
        return held ? [{ Code__c: 'taken' }] : [];
      });
      return orgs;
    }

    it('links a value the target holds in another case where its describe says the field ignores case, the gate and the simulation alike', async () => {
      const gate = gates();

      const { summary } = await run(holdingInAnotherCase(false).deps, {
        ...OPTIONS,
        dryRun: true,
        decisions: REGION_GIVEN,
        beforeWrite: gate.of('dry run'),
      });

      // The target refuses `TAKEN` as a duplicate of `taken`, and the run links it.
      expect(summary).toMatchObject({ wouldInsertCount: 3, linkedCount: 1 });
      expect(gate.shown.get('dry run')?.totalRows).toBe(summary.wouldInsertCount);
      expect(gate.shown.get('dry run')?.leftOut?.linkedByValue).toEqual([
        { objectApiName: 'Order__c', rows: 1, fields: ['Code__c'] },
      ]);
    });

    it('counts it written where the field tells case apart, or its describe does not say, the gate and the simulation alike', async () => {
      // Compared in lower case by the simulation and as written by the gate,
      // a dry run said 3 to insert and 1 linked under a gate of 4.
      for (const caseSensitive of [true, undefined]) {
        const gate = gates();

        const { summary } = await run(holdingInAnotherCase(caseSensitive).deps, {
          ...OPTIONS,
          dryRun: true,
          decisions: REGION_GIVEN,
          beforeWrite: gate.of('dry run'),
        });

        expect(summary).toMatchObject({ wouldInsertCount: 4, linkedCount: 0 });
        expect(gate.shown.get('dry run')?.totalRows).toBe(4);
        expect(
          gapOf(summary, forgeGapId('unique_value_collision', 'Order__c', 'Code__c')),
        ).toBeUndefined();
      }
    });

    it('counts a value the target holds in another case, and every row when the target will not say what it holds', async () => {
      const otherCase = fakeOrgs();
      const answer = otherCase.deps.queryRecords.getMockImplementation();
      otherCase.deps.queryRecords.mockImplementation(async (org, soql) =>
        org === 'tgt' && soql.startsWith('SELECT Code__c FROM Order__c')
          ? [{ Code__c: 'taken' }]
          : ((await answer?.(org, soql)) ?? []),
      );
      const refusing = fakeOrgs();
      const read = refusing.deps.queryRecords.getMockImplementation();
      refusing.deps.queryRecords.mockImplementation(async (org, soql) => {
        if (org === 'tgt' && soql.startsWith('SELECT Code__c FROM Order__c')) {
          throw new Error('INVALID_FIELD');
        }
        return (await read?.(org, soql)) ?? [];
      });

      for (const deps of [otherCase.deps, refusing.deps]) {
        const gate = gates();
        await run(deps, {
          ...OPTIONS,
          dryRun: true,
          decisions: REGION_GIVEN,
          beforeWrite: gate.of('dry run'),
        });
        expect(gate.shown.get('dry run')?.totalRows).toBe(4);
      }
    });
  });

  it('says on its dry-run lines one fewer to insert for a row linked by its unique value, as its Simulated line and summary count it', async () => {
    // Run on a Developer Edition, the dry run of a contact's clone said
    // "[dry-run] Account: 2 record(s) would be inserted" where its Simulated
    // line and its summary said 1 inserted and 1 linked, as the run did.
    const { deps } = fakeOrgs();

    const { summary, events } = await run(deps, {
      ...OPTIONS,
      dryRun: true,
      decisions: REGION_GIVEN,
    });

    const lines = events
      .filter((e) => e.objectName === 'Order__c' && e.message.startsWith('[dry-run] '))
      .map((e) => e.message);
    // What the lines come to, as one reads them down: the rows the read
    // brings, more as more are read, fewer as fewer go.
    const said = lines.reduce((sum, line) => {
      const more = /^\[dry-run\] Order__c: (\d+) (?:more )?record\(s\) would be inserted/.exec(
        line,
      );
      const fewer = /^\[dry-run\] Order__c: (\d+) fewer would be inserted/.exec(line);
      return sum + (more ? Number(more[1]) : 0) - (fewer ? Number(fewer[1]) : 0);
    }, 0);
    expect(said).toBe(2);
    expect(lines).toContain(
      '[dry-run] Order__c: 1 fewer would be inserted, linked to the record the target holds ' +
        'under the same Code__c, which its refusal of the row names',
    );
    expect(events.filter((e) => e.objectName === 'Order__c').at(-1)?.message).toMatch(
      /^Simulated Order__c: 2 would be inserted, 1 linked to records already in the target, 0 failed/,
    );
    expect(summary).toMatchObject({ linkedCount: 1 });
  });

  it('says a currency the target does not hold active, read once, with the currency its rows go in and the amounts converted', async () => {
    const { deps, targetQueries } = fakeOrgs();

    const { summary } = await run(deps, { ...OPTIONS, dryRun: true });

    expect(
      gapOf(
        summary,
        forgeGapId('currency_inactive', 'Order__c', 'CurrencyIsoCode', undefined, 'USD'),
      ),
    ).toMatchObject({
      severity: 'warning',
      rows: 1,
      detail: { replacement: 'EUR', amountsConverted: ['Amount__c'] },
      defaultDecision: 'map_value',
    });
    expect(targetQueries.filter((q) => q.includes('FROM CurrencyType'))).toHaveLength(1);
    expect(summary.currenciesReplaced).toEqual([
      {
        objectApiName: 'Order__c',
        from: 'USD',
        to: 'EUR',
        chosenBy: 'corporate',
        rows: 1,
        fields: ['Amount__c'],
      },
    ]);
  });

  it("writes a row in a currency the target does not hold active in its corporate currency, its amounts converted at the source's rates, and says so", async () => {
    const { deps, sent } = fakeOrgs();

    const { summary, events } = await run(deps, OPTIONS);

    // 10 USD at 1.25 to the euro: 8 EUR. The euro rows go as read.
    const orders = sent.filter((s) => s.object === 'Order__c').map((s) => s.row);
    expect(orders.map((row) => [row['Name'], row['CurrencyIsoCode'], row['Amount__c']])).toEqual([
      ['Longer than five', 'EUR', '10'],
      ['O2', 'EUR', '12345.5'],
      ['O3', 'EUR', 8],
    ]);
    expect(summary.currenciesReplaced).toEqual([
      expect.objectContaining({ from: 'USD', to: 'EUR', rows: 1, fields: ['Amount__c'] }),
    ]);
    expect(events.map((e) => e.message).join('\n')).toContain(
      "written in another currency: 1 row(s) in USD written in EUR, the target's corporate " +
        "currency, USD not being active there: amounts converted at the source's rates (Amount__c)",
    );
    expect(summary.picklistValuesChanged ?? []).not.toContainEqual(
      expect.objectContaining({ field: 'CurrencyIsoCode' }),
    );
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
      decisions: { ...REGION_GIVEN, skippedRows: [{ object: 'Order__c', gapId: RETAIL_OLD }] },
    });

    // The account and one order: the order holding a code the target holds is
    // linked to its record.
    expect(summary.wouldInsertCount).toBe(2);
    expect(summary.linkedCount).toBe(1);
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

describe('ForgeExecutor, a package’s record type beside the org’s own of the same DeveloperName', () => {
  // The source's Trade orders go in, here, with a record type package `ns`
  // installed, which carries the DeveloperName of the org's own Retail. The
  // describe calls both "Retail": only the RecordType rows, by id, say which
  // is the package's.
  const PACKAGED = SOURCE_TRADE;
  const TARGET_PACKAGED = TARGET_TRADE;
  const row = (Id: string, DeveloperName: string, NamespacePrefix: string | null) => ({
    Id,
    SobjectType: 'Order__c',
    DeveloperName,
    NamespacePrefix,
  });
  const SOURCE_ROWS = [row(SOURCE_RETAIL, 'Retail', null), row(PACKAGED, 'Retail', 'ns')];

  /**
   * The orgs of {@link fakeOrgs}, the source with both record types, the
   * target with the org's own Retail and Wholesale — and the package's when
   * `packageInTarget` — and the mapping built from both orgs' rows as a run
   * is handed it.
   */
  function namespacedOrgs({ packageInTarget }: { packageInTarget: boolean }) {
    const orgs = fakeOrgs();
    const targetRows = [
      row(TARGET_RETAIL, 'Retail', null),
      row(TARGET_WHOLESALE, 'Wholesale', null),
      ...(packageInTarget ? [row(TARGET_PACKAGED, 'Retail', 'ns')] : []),
    ];
    const answer = orgs.deps.queryRecords.getMockImplementation()!;
    orgs.deps.queryRecords.mockImplementation(async (org: string, soql: string) => {
      if (soql === RECORD_TYPE_NAMES_SOQL) return org === 'tgt' ? targetRows : SOURCE_ROWS;
      return answer(org, soql);
    });
    orgs.deps.describeObject.mockImplementation(async (org: string, object: string) => {
      if (object !== 'Order__c') return { keyPrefix: '001', recordTypes: [] };
      return org === 'tgt'
        ? {
            keyPrefix: 'a01',
            recordTypes: [
              recordType(TARGET_RETAIL, 'Retail'),
              recordType(TARGET_WHOLESALE, 'Wholesale'),
              ...(packageInTarget ? [recordType(TARGET_PACKAGED, 'Retail')] : []),
            ],
          }
        : {
            keyPrefix: 'a01',
            recordTypes: [recordType(SOURCE_RETAIL, 'Retail'), recordType(PACKAGED, 'Retail')],
          };
    });
    const info = (r: ReturnType<typeof row>) => ({
      id: r.Id,
      name: r.DeveloperName,
      developerName: r.DeveloperName,
      namespacePrefix: r.NamespacePrefix,
      sobjectType: r.SobjectType,
    });
    const recordTypeMappings = new RecordTypeMapper().buildMapping(
      SOURCE_ROWS.map(info),
      targetRows.map(info),
    );
    return { ...orgs, options: { ...OPTIONS, recordTypeMappings } };
  }

  const sentTypes = (sent: Array<{ object: string; row: Record<string, unknown> }>) =>
    sent.filter((s) => s.object === 'Order__c').map((s) => s.row['RecordTypeId']);

  it('writes each with its own counterpart when both orgs have both', async () => {
    const { deps, sent, options } = namespacedOrgs({ packageInTarget: true });

    await run(deps, options);

    expect(sentTypes(sent)).toEqual([TARGET_RETAIL, TARGET_RETAIL, TARGET_PACKAGED]);
  });

  it('never writes the package’s with the org’s own, and offers its gap under its namespaced name', async () => {
    const { deps, sent, options } = namespacedOrgs({ packageInTarget: false });

    const { summary } = await run(deps, { ...options, dryRun: true });
    await run(deps, options);

    expect(
      gapOf(
        summary,
        forgeGapId('record_type_unmapped', 'Order__c', 'RecordTypeId', undefined, 'ns__Retail'),
      ),
    ).toMatchObject({
      severity: 'blocking',
      rows: 1,
      detail: { mapTo: ['Retail', 'Wholesale'] },
      decisions: ['map_record_type', 'exclude_object', 'ignore'],
    });
    // Unmapped, the package's order keeps the source's id; the org's own go
    // with the target's Retail.
    expect(sentTypes(sent)).toEqual([TARGET_RETAIL, TARGET_RETAIL, PACKAGED]);
  });

  it('writes the package’s record type where a decision naming it `ns__Retail` says', async () => {
    const { deps, sent, options } = namespacedOrgs({ packageInTarget: false });

    const { summary } = await run(deps, {
      ...options,
      decisions: {
        recordTypeMappings: [{ object: 'Order__c', from: 'ns__Retail', to: 'Wholesale' }],
      },
    });

    expect(sentTypes(sent)).toEqual([TARGET_RETAIL, TARGET_RETAIL, TARGET_WHOLESALE]);
    expect(summary.decisionsApplied).toEqual([
      {
        kind: 'map_record_type',
        objectApiName: 'Order__c',
        from: 'ns__Retail',
        to: 'Wholesale',
        rows: 1,
      },
    ]);
  });

  it('applies a decision naming a bare Retail both record types carry to the org’s own', async () => {
    const { deps, sent, options } = namespacedOrgs({ packageInTarget: true });

    const { summary } = await run(deps, {
      ...options,
      decisions: { recordTypeMappings: [{ object: 'Order__c', from: 'Retail', to: 'Wholesale' }] },
    });

    // The org's own Retail goes where the decision says; the package's keeps its own.
    expect(sentTypes(sent)).toEqual([TARGET_WHOLESALE, TARGET_WHOLESALE, TARGET_PACKAGED]);
    expect(JSON.stringify(summary.errors)).not.toContain('was not applied');
  });

  it('maps and holds back by a decision taken on the org’s own Retail its rows alone, the package’s going as read', async () => {
    // The org's own Retail refuses Old, which the package's Retail keeps:
    // Review offers the gap of the first, under its bare name. A real run
    // took the decision for the package's rows too, and wrote its order with
    // New, or held it back, while nobody had decided anything of them.
    const ownRefusesOld = forgeGapId(
      'picklist_value_refused',
      'Order__c',
      'Status__c',
      'Retail',
      'Old',
    );
    const decided: Array<NonNullable<ExecuteOptions['decisions']>> = [
      {
        ...REGION_GIVEN,
        picklistValueMappings: [
          { object: 'Order__c', field: 'Status__c', recordType: 'Retail', from: 'Old', to: 'New' },
        ],
      },
      { ...REGION_GIVEN, skippedRows: [{ object: 'Order__c', gapId: ownRefusesOld }] },
    ];
    const statuses: unknown[][] = [];
    for (const decisions of decided) {
      const { deps, sent, options } = namespacedOrgs({ packageInTarget: true });
      await run(deps, { ...options, decisions });
      statuses.push(
        sent
          .filter((s) => s.object === 'Order__c')
          .map((s) => [s.row['RecordTypeId'], s.row['Status__c']]),
      );
    }

    expect(statuses).toEqual([
      [
        [TARGET_RETAIL, 'New'],
        [TARGET_RETAIL, 'Open'],
        [TARGET_PACKAGED, 'Old'],
      ],
      [
        [TARGET_RETAIL, 'Open'],
        [TARGET_PACKAGED, 'Old'],
      ],
    ]);
  });

  it('leaves the package’s unmapped Retail undecided by an ignore kept under the bare name the org’s own carries', async () => {
    // The source's own Retail goes in as the target's own, and has no gap:
    // the read holds the package's alone. An ignore kept before namespaces,
    // under the bare name, is the org's own's as the run names it, and said
    // the package's "left as it is", which nobody had decided.
    const { deps, options } = namespacedOrgs({ packageInTarget: false });
    const unmapped = (name: string) =>
      forgeGapId('record_type_unmapped', 'Order__c', 'RecordTypeId', undefined, name);

    const { summary } = await run(deps, {
      ...options,
      dryRun: true,
      decisions: { ...REGION_GIVEN, ignoredGaps: [unmapped('Retail')] },
    });

    const ids = (summary.gaps ?? []).map((gap) => gap.id);
    const packaged = gapOf(summary, unmapped('ns__Retail'));
    expect(ids).not.toContain(unmapped('Retail'));
    expect(packaged).toMatchObject({ severity: 'blocking', rows: 1 });
    expect(packaged?.detail).toMatchObject({ sameDeveloperName: ['Retail'] });
    expect(packaged?.detail?.['ignored']).toBeUndefined();
    expect(packaged && ignoredGapEntry([unmapped('Retail')], packaged, ids)).toBeUndefined();
  });

  it('leaves the package’s refused value undecided by a decision kept under the bare name of the org’s own Retail, which takes the value', async () => {
    // The target's own Retail takes Open, which the package's refuses: the
    // read holds the package's gap of Open alone. Held back or mapped under
    // the bare name, as a template kept it before namespaces, the run applies
    // it to the org's own rows alone and sends the package's order with
    // Open; Review read the decision as the package's gap's, and said it
    // decided.
    const ownOpen = forgeGapId('picklist_value_refused', 'Order__c', 'Status__c', 'Retail', 'Open');
    const packagedOpen = forgeGapId(
      'picklist_value_refused',
      'Order__c',
      'Status__c',
      'ns__Retail',
      'Open',
    );
    const mapping = {
      object: 'Order__c',
      field: 'Status__c',
      recordType: 'Retail',
      from: 'Open',
      to: 'New',
    };
    const skipped = { object: 'Order__c', gapId: ownOpen };
    const decided: Array<NonNullable<ExecuteOptions['decisions']>> = [
      { ...REGION_GIVEN, skippedRows: [skipped] },
      { ...REGION_GIVEN, picklistValueMappings: [mapping] },
    ];
    const found: Array<{ ids: string[]; gap: ExecutionSummary['gaps'] }> = [];
    for (const decisions of decided) {
      const { deps, options } = namespacedOrgs({ packageInTarget: true });
      const answer = deps.queryRecords.getMockImplementation()!;
      deps.queryRecords.mockImplementation(async (org: string, soql: string) =>
        org === 'src' && soql.includes(' FROM Order__c')
          ? selectRows({ Order__c: [...SOURCE.Order__c, order(4, PACKAGED, 'Open')] }, soql)
          : answer(org, soql),
      );
      const { summary } = await run(deps, { ...options, dryRun: true, decisions });
      const ids = (summary.gaps ?? []).map((gap) => gap.id);
      found.push({ ids, gap: summary.gaps?.filter((gap) => gap.id === packagedOpen) });
    }

    for (const { ids, gap } of found) {
      expect(ids).not.toContain(ownOpen);
      expect(gap).toEqual([
        expect.objectContaining({
          recordType: 'ns__Retail',
          rows: 1,
          detail: expect.objectContaining({ sameDeveloperName: ['Retail'] }),
        }),
      ]);
    }
    const [held, mapped] = found;
    expect(skippedRowsEntry([skipped], held.gap![0], held.ids)).toBeUndefined();
    expect(picklistMappingEntry([mapping], mapped.gap![0], mapped.ids)).toBeUndefined();
  });
});

describe('ForgeExecutor, a simulation of the rows the target refuses for a field it requires', () => {
  const OPPORTUNITY = id('006', 1);
  const MEMBER = id('00q', 1);
  const SOURCE_OWNER = id('005', 1);

  const opportunityFields: FieldInfo[] = [field('Id'), field('Name', { type: 'string' })];
  /**
   * An opportunity team member, as both orgs describe it: its user is
   * required, and a user is never copied, so the lookup goes empty.
   */
  const memberFields: FieldInfo[] = [
    field('Id'),
    field('OpportunityId', { isReference: true, referenceTo: ['Opportunity'], nillable: false }),
    field('UserId', { isReference: true, referenceTo: ['User'], nillable: false }),
    field('TeamMemberRole', { type: 'picklist' }),
  ];
  const graph: ForgeGraph = {
    nodes: [node('Opportunity', 0), node('OpportunityTeamMember', 1)],
    edges: [
      {
        sourceObject: 'Opportunity',
        targetObject: 'OpportunityTeamMember',
        relationshipName: 'OpportunityTeamMembers',
        type: 'lookup',
      },
    ],
    totalRecords: 2,
    estimatedSizeMB: 0,
    estimatedDurationSeconds: 0,
  };
  const source: Record<string, FakeRow[]> = {
    Opportunity: [{ Id: OPPORTUNITY, Name: 'Deal 05' }],
    OpportunityTeamMember: [
      {
        Id: MEMBER,
        OpportunityId: OPPORTUNITY,
        UserId: SOURCE_OWNER,
        TeamMemberRole: 'Opportunity Owner',
      },
    ],
  };

  /** Both orgs, the target refusing a member without its user as a real org refused it. */
  function teamOrgs() {
    let next = 0;
    const deps = {
      describeFields: vi.fn(async (_org: string, object: string) =>
        object === 'Opportunity' ? opportunityFields : memberFields,
      ),
      queryRecords: vi.fn(async (org: string, soql: string) =>
        org === 'src' ? selectRows(source, soql) : [],
      ),
      insertRecords: vi.fn(async (_org: string, object: string, rows: Record<string, unknown>[]) =>
        rows.map((row): InsertResult => {
          if (object === 'OpportunityTeamMember' && !row['UserId']) {
            return {
              id: '',
              success: false,
              errors: ['REQUIRED_FIELD_MISSING: Required fields are missing: [UserId]'],
            };
          }
          next++;
          return { id: id('006', 100 + next), success: true, errors: [] };
        }),
      ),
      updateRecords: vi.fn(async () => []),
      upsertRecords: vi.fn(async () => []),
      describeObject: vi.fn(async (_org: string, object: string): Promise<TargetObjectInfo> => ({
        keyPrefix: object === 'Opportunity' ? '006' : '00q',
        recordTypes: [],
      })),
    } satisfies ForgeExecutorDeps;
    return deps;
  }

  const options: ExecuteOptions = {
    rootRecordId: OPPORTUNITY,
    rootObjectApiName: 'Opportunity',
  };
  const execute = (deps: ForgeExecutorDeps, more: Partial<ExecuteOptions>) =>
    new ForgeExecutor(deps).execute(graph, 'src', 'tgt', () => {}, { ...options, ...more });
  const refused = (summary: ExecutionSummary) =>
    summary.errors.find((error) => error.objectApiName === 'OpportunityTeamMember');

  it('holds back, in a dry run as in the real run, a member whose user the target has no counterpart of, where it said all would be inserted', async () => {
    // Run for real with Team Selling on, the clone of an opportunity had its
    // team member refused, REQUIRED_FIELD_MISSING [UserId], and its dry run
    // had said it would be inserted, nothing refused. The user is none the
    // target has — not the opportunity's owner, which the source does not
    // say here, nor one a mapping gives — so neither sends it.
    const real = await execute(teamOrgs(), {});
    const dry = await execute(teamOrgs(), { dryRun: true });

    const why = [
      "Not written: UserId names a user the target has no counterpart of: a team member and a split go in for the opportunity's owner, which is the owner of its copy in the target, for a user an owner mapping gives, or for a user of the same id the target holds active.",
    ];
    expect(real.successCount).toBe(1);
    expect(real.failedCount).toBe(1);
    expect(refused(real)).toMatchObject({ failedCount: 1, attemptedCount: 0 });
    expect(refused(real)?.samples[0]?.messages).toEqual(why);
    expect(dry.wouldInsertCount).toBe(1);
    expect(dry.failedCount).toBe(1);
    expect(refused(dry)).toMatchObject({ failedCount: 1, attemptedCount: 0 });
    expect(refused(dry)?.samples[0]?.messages).toEqual(why);
    // The gap a decision can close, as for any field the target requires.
    expect(
      gapOf(dry, forgeGapId('required_field_missing', 'OpportunityTeamMember', 'UserId')),
    ).toMatchObject({ severity: 'blocking', rows: 1 });
  });

  it('counts the row as would be inserted once a decision gives the field a value', async () => {
    const dry = await execute(teamOrgs(), {
      dryRun: true,
      decisions: {
        defaultValues: [{ object: 'OpportunityTeamMember', field: 'UserId', value: id('005', 9) }],
      },
    });

    expect(dry.wouldInsertCount).toBe(2);
    expect(dry.failedCount).toBe(0);
  });
});
