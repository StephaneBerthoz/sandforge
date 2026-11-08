import { describe, it, expect, vi } from 'vitest';
import { forgeGapId } from '@sandforge/shared';
import type { FieldInfo } from '../ForgeExecutor.js';
import type { PicklistField } from './RecordTypePicklists.js';
import type { RecordTypeAvailability } from '../../../core/metadata/recordTypeAvailability.js';
import {
  SimulationGaps,
  currencyGapOf,
  picklistGapsOf,
  recordTypeGapOf,
  rowGapsOf,
  uniqueCollisionGapOf,
  type RowToCheck,
} from './SimulationGaps.js';

vi.mock('../../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const field = (name: string, overrides: Partial<FieldInfo> = {}): FieldInfo => ({
  name,
  queryable: true,
  createable: true,
  isReference: false,
  ...overrides,
});

const rowOf = (payload: Record<string, unknown>, typed = false): RowToCheck => ({
  payload,
  source: payload,
  typed,
});

/** The gaps the rows hold against `targetFields`. */
function check(
  rows: RowToCheck[],
  targetFields: FieldInfo[],
  picklists: { values?: Map<string, Set<string>>; fields?: Map<string, PicklistField> } = {},
  objectApiName = 'Order__c',
) {
  const gaps = new SimulationGaps();
  rowGapsOf(
    {
      objectApiName,
      rows,
      targetFields,
      picklistValuesByField: picklists.values ?? null,
      picklistFields: picklists.fields ?? new Map(),
    },
    gaps,
  );
  return gaps.list(new Set());
}

describe('the id of a gap of a package’s record type, before its namespace', () => {
  it('marks the gap ignored all the same', () => {
    const gaps = new SimulationGaps();
    gaps.add({
      kind: 'record_type_unavailable',
      severity: 'blocking',
      objectApiName: 'Case',
      recordType: 'ns__Support',
      rows: 1,
      decisions: ['ignore'],
    } as Parameters<SimulationGaps['add']>[0]);
    const before = forgeGapId('record_type_unavailable', 'Case', undefined, 'Support');

    expect(gaps.list(new Set([before])).map((gap) => gap.detail?.['ignored'])).toEqual([true]);
  });

  it('marks not the package’s gap ignored by the org’s own gap the simulation found too', () => {
    // The target holds both record types, each closed to the user: the dry
    // run said the package's ignored, which nobody had decided.
    const gaps = new SimulationGaps();
    for (const recordType of ['Support', 'ns__Support']) {
      gaps.add(recordTypeGapOf('record_type_unavailable', 'Case', recordType, 1, ['Other']));
    }
    const own = forgeGapId('record_type_unavailable', 'Case', 'RecordTypeId', 'Support');

    expect(
      gaps.list(new Set([own])).map((gap) => [gap.recordType, gap.detail?.['ignored'] ?? false]),
    ).toEqual([
      ['ns__Support', false],
      ['Support', true],
    ]);
  });

  it('marks an unmapped record type of a package ignored by the id it had before its namespace', () => {
    const gaps = new SimulationGaps();
    gaps.add(recordTypeGapOf('record_type_unmapped', 'Account', 'ns__Retail', 2, ['Other']));
    const old = forgeGapId('record_type_unmapped', 'Account', 'RecordTypeId', undefined, 'Retail');

    expect(gaps.list(new Set([old])).map((gap) => gap.detail?.['ignored'])).toEqual([true]);
  });
});

describe('the record types a package’s carries the name of', () => {
  const type = (
    recordTypeId: string,
    developerName: string,
    namespacePrefix?: string | null,
    master = false,
  ): RecordTypeAvailability => ({
    recordTypeId,
    developerName,
    ...(namespacePrefix !== undefined ? { namespacePrefix } : {}),
    name: developerName,
    available: true,
    active: true,
    master,
    defaultRecordTypeMapping: false,
  });
  const MASTER = type('012000000000000AAA', 'Master', undefined, true);
  const OWN = type('012000000000001AAA', 'Retail', null);
  const PACKAGED = type('012000000000002AAA', 'ns__Retail', 'ns');
  const OTHER_PACKAGE = type('012000000000003AAA', 'other__Retail', 'other');

  it('says beside a package’s gap the other record types of its org of the same DeveloperName', () => {
    // The org's own Retail takes the value the package's refuses: the read
    // holds no gap of it, and nothing told a decision kept under the bare
    // name for the org's own.
    const gaps = new SimulationGaps();
    gaps.knowRecordTypes('Order__c', 'target', [MASTER, OWN, PACKAGED, OTHER_PACKAGE]);
    for (const recordType of ['ns__Retail', 'Retail']) {
      gaps.add({
        kind: 'picklist_value_refused',
        severity: 'blocking',
        objectApiName: 'Order__c',
        field: 'Status__c',
        recordType,
        value: 'Open',
        rows: 1,
        decisions: ['map_value', 'skip_rows', 'ignore'],
      });
    }

    expect(
      gaps.list(new Set()).map((gap) => [gap.recordType, gap.detail?.['sameDeveloperName']]),
    ).toEqual([
      ['ns__Retail', ['Retail', 'other__Retail']],
      ['Retail', undefined],
    ]);
  });

  it('reads an unmapped record type among the source’s, and leaves it unmarked by an ignore kept under the bare name', () => {
    const gaps = new SimulationGaps();
    gaps.knowRecordTypes('Order__c', 'source', [OWN, PACKAGED]);
    gaps.knowRecordTypes('Order__c', 'target', [type('012000000000009AAA', 'Wholesale', null)]);
    gaps.add(recordTypeGapOf('record_type_unmapped', 'Order__c', 'ns__Retail', 1, ['Wholesale']));
    const old = forgeGapId('record_type_unmapped', 'Order__c', 'RecordTypeId', undefined, 'Retail');

    expect(gaps.list(new Set([old]))[0]?.detail).toEqual({
      mapTo: ['Wholesale'],
      sameDeveloperName: ['Retail'],
    });
  });

  it('says nothing of a package’s record type alone of its name, nor of record types read without their namespace', () => {
    const gaps = new SimulationGaps();
    gaps.knowRecordTypes('Order__c', 'target', [MASTER, PACKAGED]);
    gaps.knowRecordTypes('Case', 'target', [
      type('012000000000004AAA', 'Retail'),
      type('012000000000005AAA', 'ns__Retail'),
    ]);
    for (const objectApiName of ['Order__c', 'Case']) {
      gaps.add(recordTypeGapOf('record_type_unavailable', objectApiName, 'ns__Retail', 1, []));
    }
    const old = (objectApiName: string) =>
      forgeGapId('record_type_unavailable', objectApiName, 'RecordTypeId', 'Retail');

    // Without the names, the read alone tells, as before.
    expect(
      gaps
        .list(new Set([old('Order__c'), old('Case')]))
        .map((gap) => [gap.objectApiName, gap.detail]),
    ).toEqual([
      ['Case', { mapTo: [], ignored: true }],
      ['Order__c', { mapTo: [], ignored: true }],
    ]);
  });
});

describe('SimulationGaps', () => {
  it('counts a gap once however many rows find it, adding up its rows and keeping the longest length', () => {
    const gaps = new SimulationGaps();
    const tooLong = (longest: number) => ({
      kind: 'value_too_long' as const,
      severity: 'blocking' as const,
      objectApiName: 'Case',
      field: 'Subject',
      rows: 1,
      detail: { length: 5, longest },
      decisions: ['truncate' as const],
    });

    gaps.add(tooLong(9));
    gaps.add(tooLong(30));
    gaps.add(tooLong(7));

    expect(gaps.list(new Set())).toEqual([
      {
        ...tooLong(30),
        id: forgeGapId('value_too_long', 'Case', 'Subject'),
        source: 'simulation',
        rows: 3,
      },
    ]);
  });

  it('marks the gaps the user chose to ignore, and keeps them', () => {
    const gaps = new SimulationGaps();
    gaps.add(uniqueCollisionGapOf('Case', 'Code__c', 2, 1));
    const ignored = forgeGapId('unique_value_collision', 'Case', 'Code__c');

    expect(gaps.list(new Set([ignored]))).toEqual([
      expect.objectContaining({
        id: ignored,
        detail: { colliding: 1, linkedToTheRecordItNames: true, ignored: true },
      }),
    ]);
  });

  it('lists the gravest first', () => {
    const gaps = new SimulationGaps();
    gaps.add({
      kind: 'picklist_value_absent',
      severity: 'info',
      objectApiName: 'A',
      field: 'F',
      value: 'v',
      rows: 1,
      decisions: ['ignore'],
    });
    gaps.add(currencyGapOf('B', 'USD', 1));

    expect(gaps.list(new Set()).map((gap) => gap.severity)).toEqual(['warning', 'info']);
  });
});

describe('picklistGapsOf', () => {
  it('gives each refused value a gap, with what the run writes instead as its default', () => {
    const found = picklistGapsOf(
      'Case',
      [
        {
          field: 'Status__c',
          reason: 'record-type',
          values: ['Old'],
          recordType: 'Support',
          replacedBy: 'New',
          replacement: 'default',
        },
        { field: 'Kind__c', reason: 'not-in-target', values: ['X', 'Y'] },
      ],
      (change) => (change.field === 'Status__c' ? ['Open', 'New'] : undefined),
    );

    expect(found).toEqual([
      {
        kind: 'picklist_value_refused',
        severity: 'warning',
        objectApiName: 'Case',
        field: 'Status__c',
        recordType: 'Support',
        value: 'Old',
        rows: 1,
        detail: { reason: 'record-type', allowed: ['New', 'Open'], replacement: 'New' },
        decisions: ['map_value', 'leave_empty', 'skip_rows', 'exclude_object', 'ignore'],
        defaultDecision: 'map_value',
      },
      expect.objectContaining({ field: 'Kind__c', value: 'X', defaultDecision: 'leave_empty' }),
      expect.objectContaining({ field: 'Kind__c', value: 'Y', defaultDecision: 'leave_empty' }),
    ]);
  });

  it('offers no holding back of the rows of a value its controlling value refused', () => {
    // The rows holding it under a controlling value that allows it go in as
    // they are: holding back every row holding it would take those too.
    const [found] = picklistGapsOf(
      'Case',
      [
        {
          field: 'Sub_Status__c',
          reason: 'controlling-value',
          values: ['Waiting'],
          controllingField: 'Status__c',
        },
      ],
      () => undefined,
    );

    expect(found?.decisions).toEqual(['map_value', 'leave_empty', 'exclude_object', 'ignore']);
  });

  it('takes the holding back of the rows off a gap one of whose rows its controlling value refused', () => {
    const gaps = new SimulationGaps();
    const [byRecordType] = picklistGapsOf(
      'Case',
      [{ field: 'Kind__c', reason: 'not-in-target', values: ['X'] }],
      () => undefined,
    );
    const [byController] = picklistGapsOf(
      'Case',
      [{ field: 'Kind__c', reason: 'controlling-value', values: ['X'], controllingField: 'Type' }],
      () => undefined,
    );

    gaps.add(byRecordType!);
    gaps.add(byController!);

    expect(gaps.list(new Set())[0]?.decisions).not.toContain('skip_rows');
  });

  it('leaves the currency code to its own check', () => {
    expect(
      picklistGapsOf(
        'Case',
        [{ field: 'CurrencyIsoCode', reason: 'not-in-target', values: ['USD'] }],
        () => undefined,
      ),
    ).toEqual([]);
  });
});

describe('rowGapsOf', () => {
  it('finds a field the target requires and gives no value of its own, absent or empty', () => {
    const fields = [
      field('Region__c', { type: 'string', nillable: false }),
      field('Owner', { type: 'reference', nillable: false, defaultedOnCreate: true }),
      field('Flag__c', { type: 'boolean', nillable: false }),
      field('Formula__c', { type: 'string', nillable: false, calculated: true, createable: false }),
    ];

    const gaps = check(
      [rowOf({}), rowOf({ Region__c: '' }), rowOf({ Region__c: 'North' })],
      fields,
    );

    expect(gaps).toEqual([
      expect.objectContaining({
        kind: 'required_field_missing',
        field: 'Region__c',
        rows: 2,
        severity: 'blocking',
      }),
    ]);
  });

  it("leaves a person account's name to the platform", () => {
    const gaps = check(
      [rowOf({ IsPersonAccount: true, LastName: 'Doe' })],
      [field('Name', { type: 'string', nillable: false })],
      {},
      'Account',
    );

    expect(gaps).toEqual([]);
  });

  it('finds a text longer than its field, saying the lengths alone', () => {
    const gaps = check(
      [
        rowOf({ Subject: 'abcdefgh' }),
        rowOf({ Subject: 'abc' }),
        rowOf({ Subject: 'abcdefghijk' }),
      ],
      [field('Subject', { type: 'string', length: 5 })],
    );

    expect(gaps).toEqual([
      expect.objectContaining({
        kind: 'value_too_long',
        rows: 2,
        detail: { length: 5, longest: 11 },
      }),
    ]);
    expect(JSON.stringify(gaps)).not.toContain('abc');
  });

  it('finds a number with more digits before its point than the field holds, not one with more decimals', () => {
    const gaps = check(
      [
        rowOf({ Amount__c: 999.999 }),
        rowOf({ Amount__c: '1000' }),
        rowOf({ Amount__c: -1234.5 }),
        rowOf({ Count__c: 100 }),
      ],
      [
        field('Amount__c', { type: 'currency', precision: 5, scale: 2 }),
        field('Count__c', { type: 'int', digits: 2 }),
      ],
    );

    expect(gaps).toEqual([
      expect.objectContaining({
        kind: 'number_out_of_range',
        field: 'Amount__c',
        rows: 2,
        detail: { precision: 5, scale: 2 },
      }),
      expect.objectContaining({
        kind: 'number_out_of_range',
        field: 'Count__c',
        rows: 1,
        detail: { digits: 2 },
      }),
    ]);
  });

  it('says a value of a picklist the target takes any value of that its list does not hold', () => {
    const gaps = check(
      [rowOf({ Tags__c: 'Red;Blue' }), rowOf({ Tags__c: 'Red' })],
      [field('Tags__c', { type: 'multipicklist' })],
      {
        values: new Map([['Tags__c', new Set(['Red'])]]),
        fields: new Map([
          ['Tags__c', { multi: true, restricted: false, required: false, anyValue: true }],
        ]),
      },
    );

    expect(gaps).toEqual([
      expect.objectContaining({
        kind: 'picklist_value_absent',
        severity: 'info',
        value: 'Blue',
        rows: 1,
      }),
    ]);
  });

  describe('a dependent picklist, by its validFor', () => {
    // Bits read left to right: "Laptop" allowed under the controller's first
    // value only (0x80), "Phone" under its second only (0x40).
    const fields = [
      field('Category__c', {
        type: 'picklist',
        controllingValues: ['Computers', 'Mobile'],
      }),
      field('Product__c', {
        type: 'picklist',
        controllerName: 'Category__c',
        validFor: { Laptop: 'gA==', Phone: 'QA==' },
      }),
    ];
    const picklists = {
      fields: new Map<string, PicklistField>([
        [
          'Product__c',
          { multi: false, restricted: true, required: false, controllerName: 'Category__c' },
        ],
      ]),
    };

    it('finds a dependent value its controlling value does not allow', () => {
      const gaps = check(
        [
          rowOf({ Category__c: 'Computers', Product__c: 'Laptop' }),
          rowOf({ Category__c: 'Computers', Product__c: 'Phone' }),
          rowOf({ Product__c: 'Phone' }),
        ],
        fields,
        picklists,
      );

      expect(gaps).toEqual([
        expect.objectContaining({
          kind: 'dependent_value_invalid',
          severity: 'blocking',
          field: 'Product__c',
          value: 'Phone',
          rows: 2,
          detail: { controllingField: 'Category__c', allowed: ['Mobile'] },
        }),
      ]);
    });

    it('leaves alone a row whose record type was read, its values checked against it', () => {
      const gaps = check(
        [rowOf({ Category__c: 'Computers', Product__c: 'Phone' }, true)],
        fields,
        picklists,
      );

      expect(gaps).toEqual([]);
    });
  });
});

describe('the gaps found against the target itself', () => {
  it('says a currency the target does not hold active, replaced by default, no row refused for it', () => {
    expect(currencyGapOf('Opportunity', 'USD', 3)).toEqual({
      kind: 'currency_inactive',
      severity: 'warning',
      objectApiName: 'Opportunity',
      field: 'CurrencyIsoCode',
      value: 'USD',
      rows: 3,
      decisions: ['map_value', 'skip_rows', 'exclude_object', 'ignore'],
      defaultDecision: 'map_value',
    });
  });

  it('says the currency the rows go in instead and the amounts converted into it', () => {
    expect(
      currencyGapOf('Opportunity', 'GBP', 2, { to: ['USD'], converted: ['Amount'], asRead: false })
        .detail,
    ).toEqual({ replacement: 'USD', amountsConverted: ['Amount'] });
    expect(
      currencyGapOf('Opportunity', 'JPY', 1, { to: ['USD'], converted: [], asRead: true }).detail,
    ).toEqual({ replacement: 'USD', amountsAsRead: true });
  });

  it('says a record type closed to the user under its target name, and one unmapped under its source name', () => {
    expect(recordTypeGapOf('record_type_unavailable', 'Case', 'Support', 2, ['B', 'A'])).toEqual(
      expect.objectContaining({ recordType: 'Support', detail: { mapTo: ['A', 'B'] } }),
    );
    const unmapped = recordTypeGapOf('record_type_unmapped', 'Case', 'Legacy', 1, []);
    expect(unmapped.value).toBe('Legacy');
    expect(unmapped.recordType).toBeUndefined();
  });
});
