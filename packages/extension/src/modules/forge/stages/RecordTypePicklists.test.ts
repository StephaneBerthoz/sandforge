import { describe, it, expect, vi } from 'vitest';
import type {
  RecordTypePicklist,
  RecordTypePicklists,
} from '../../../core/metadata/recordTypePicklists.js';
import type { RecordTypeMapping } from '../../sync/RecordTypeMapper.js';
import type { FieldInfo } from '../ForgeExecutor.js';
import {
  PicklistChangeTally,
  RecordTypePicklistReads,
  checkRowPicklists,
  describePicklistChange,
  picklistChangesNote,
  picklistFieldsOf,
  recordTypeReadSample,
  type PicklistField,
  type RecordTypeValues,
} from './RecordTypePicklists.js';

/** Fake record type ids: the source's, and the target's they map to. */
const SOURCE_RETAIL = '012000000000001AAA';
const TARGET_RETAIL = '012000000000101AAA';
const SOURCE_TRADE = '012000000000002AAA';
const TARGET_TRADE = '012000000000102AAA';

const MAPPINGS: RecordTypeMapping[] = [
  { sourceId: SOURCE_RETAIL, targetId: TARGET_RETAIL, developerName: 'Retail' },
  { sourceId: SOURCE_TRADE, targetId: TARGET_TRADE, developerName: 'Trade' },
];

const optional: PicklistField = { multi: false, restricted: true, required: false };

/** What a record type allows of one field. */
const keeps = (
  values: string[],
  defaultValue: string | null = null,
  byControlling?: Record<string, string[]>,
): RecordTypePicklist => ({
  values,
  defaultValue,
  ...(byControlling
    ? {
        allowedByControllingValue: new Map(
          Object.entries(byControlling).map(([value, allowed]) => [value, new Set(allowed)]),
        ),
      }
    : {}),
});

/** The values a record type named `recordType` was read with. */
const typed = (
  picklists: Record<string, RecordTypePicklist>,
  recordType = 'Retail',
): RecordTypeValues => ({ recordType, picklists: new Map(Object.entries(picklists)) });

/** The active values of each field in the target describe. */
const active = (values: Record<string, string[]>): Map<string, Set<string>> =>
  new Map(Object.entries(values).map(([field, list]) => [field, new Set(list)]));

const field = (name: string, overrides: Partial<FieldInfo> = {}): FieldInfo => ({
  name,
  queryable: true,
  createable: true,
  isReference: false,
  ...overrides,
});

describe('picklistFieldsOf', () => {
  it('says of each picklist field whether it is restricted, multi-select, required and dependent', () => {
    const fields = picklistFieldsOf([
      field('Name', { type: 'string' }),
      field('Status__c', { type: 'picklist', restrictedPicklist: true, nillable: false }),
      field('Colors__c', { type: 'multipicklist' }),
      field('Reason__c', {
        type: 'picklist',
        restrictedPicklist: true,
        controllerName: 'Status__c',
      }),
      // Required, and filled in by the org when left out: not a field a row needs a value in.
      field('Stage__c', { type: 'picklist', nillable: false, defaultedOnCreate: true }),
      // A writer that gives no type, only the values.
      field('Rating', { picklistValues: ['Hot'] }),
    ]);

    expect(Object.fromEntries(fields)).toEqual({
      Status__c: { multi: false, restricted: true, required: true },
      Colors__c: { multi: true, restricted: false, required: false },
      Reason__c: { multi: false, restricted: true, required: false, controllerName: 'Status__c' },
      Stage__c: { multi: false, restricted: false, required: false },
      Rating: { multi: false, restricted: false, required: false },
    });
  });
});

describe('checkRowPicklists', () => {
  it("replaces a value the row's record type does not keep with the record type's default", () => {
    const row: Record<string, unknown> = { Name: 'A', Status__c: 'Old' };

    const changes = checkRowPicklists(
      row,
      active({ Status__c: ['New', 'Old'] }),
      new Map([['Status__c', optional]]),
      typed({ Status__c: keeps(['New', 'Open'], 'New') }),
    );

    expect(row).toEqual({ Name: 'A', Status__c: 'New' });
    expect(changes).toEqual([
      {
        field: 'Status__c',
        reason: 'record-type',
        values: ['Old'],
        recordType: 'Retail',
        replacedBy: 'New',
        replacement: 'default',
      },
    ]);
  });

  it('keeps a value the record type keeps', () => {
    const row: Record<string, unknown> = { Status__c: 'Open' };

    const changes = checkRowPicklists(
      row,
      active({ Status__c: ['New', 'Open'] }),
      new Map([['Status__c', optional]]),
      typed({ Status__c: keeps(['New', 'Open'], 'New') }),
    );

    expect(row).toEqual({ Status__c: 'Open' });
    expect(changes).toEqual([]);
  });

  it('leaves out a value the record type does not keep when it sets no default and the field is optional', () => {
    const row: Record<string, unknown> = { Name: 'A', Status__c: 'Old' };

    const changes = checkRowPicklists(
      row,
      active({ Status__c: ['New', 'Old'] }),
      new Map([['Status__c', optional]]),
      typed({ Status__c: keeps(['New']) }),
    );

    expect(row).toEqual({ Name: 'A' });
    expect(changes).toEqual([
      { field: 'Status__c', reason: 'record-type', values: ['Old'], recordType: 'Retail' },
    ]);
  });

  it('writes the first value the record type allows in a required field it sets no default for', () => {
    const row: Record<string, unknown> = { Entity__c: 'East' };

    const changes = checkRowPicklists(
      row,
      active({ Entity__c: ['East', 'North', 'South'] }),
      new Map([['Entity__c', { ...optional, required: true }]]),
      typed({ Entity__c: keeps(['North', 'South']) }),
    );

    expect(row).toEqual({ Entity__c: 'North' });
    expect(changes).toEqual([
      {
        field: 'Entity__c',
        reason: 'record-type',
        values: ['East'],
        recordType: 'Retail',
        replacedBy: 'North',
        replacement: 'first',
      },
    ]);
  });

  it('leaves out a required value when the record type allows no value of the field', () => {
    const row: Record<string, unknown> = { Entity__c: 'East' };

    const changes = checkRowPicklists(
      row,
      active({ Entity__c: ['East'] }),
      new Map([['Entity__c', { ...optional, required: true }]]),
      typed({ Entity__c: keeps([]) }),
    );

    expect(row).toEqual({});
    expect(changes).toEqual([
      { field: 'Entity__c', reason: 'record-type', values: ['East'], recordType: 'Retail' },
    ]);
  });

  it('says a value the target does not hold at all is not one of the field, and replaces it all the same', () => {
    const row: Record<string, unknown> = { Status__c: 'Gone' };

    const changes = checkRowPicklists(
      row,
      active({ Status__c: ['New'] }),
      new Map([['Status__c', optional]]),
      typed({ Status__c: keeps(['New'], 'New') }),
    );

    expect(row).toEqual({ Status__c: 'New' });
    expect(changes).toEqual([
      {
        field: 'Status__c',
        reason: 'not-in-target',
        values: ['Gone'],
        recordType: 'Retail',
        replacedBy: 'New',
        replacement: 'default',
      },
    ]);
  });

  it('checks a dependent value against its controlling value, as that one was written', () => {
    // The controlling value is refused first and replaced by its default; the
    // dependent value is then checked against the value the row goes in with.
    const row: Record<string, unknown> = { Reason__c: 'Late', Status__c: 'Gone' };
    const fields = new Map<string, PicklistField>([
      ['Status__c', optional],
      ['Reason__c', { ...optional, controllerName: 'Status__c' }],
    ]);

    const changes = checkRowPicklists(
      row,
      active({ Status__c: ['Open', 'Closed', 'Gone'], Reason__c: ['Late', 'Done'] }),
      fields,
      typed({
        Status__c: keeps(['Open', 'Closed'], 'Closed'),
        Reason__c: keeps(['Late', 'Done'], null, { Open: ['Late'], Closed: ['Done'] }),
      }),
    );

    expect(row).toEqual({ Status__c: 'Closed' });
    expect(changes).toEqual([
      {
        field: 'Status__c',
        reason: 'record-type',
        values: ['Gone'],
        recordType: 'Retail',
        replacedBy: 'Closed',
        replacement: 'default',
      },
      {
        field: 'Reason__c',
        reason: 'controlling-value',
        values: ['Late'],
        recordType: 'Retail',
        controllingField: 'Status__c',
      },
    ]);
  });

  it('keeps a dependent value its controlling value allows', () => {
    const row: Record<string, unknown> = { Status__c: 'Open', Reason__c: 'Late' };

    const changes = checkRowPicklists(
      row,
      null,
      new Map<string, PicklistField>([
        ['Status__c', optional],
        ['Reason__c', { ...optional, controllerName: 'Status__c' }],
      ]),
      typed({
        Status__c: keeps(['Open', 'Closed']),
        Reason__c: keeps(['Late', 'Done'], null, { Open: ['Late'], Closed: ['Done'] }),
      }),
    );

    expect(row).toEqual({ Status__c: 'Open', Reason__c: 'Late' });
    expect(changes).toEqual([]);
  });

  it('checks a value under a checkbox by the checkbox as the row holds it', () => {
    const row: Record<string, unknown> = { Active__c: false, Detail__c: 'Yes' };

    const changes = checkRowPicklists(
      row,
      null,
      new Map([['Detail__c', { ...optional, controllerName: 'Active__c' }]]),
      typed({ Detail__c: keeps(['Yes', 'No'], null, { true: ['Yes'], false: ['No'] }) }),
    );

    expect(row).toEqual({ Active__c: false });
    expect(changes).toEqual([
      {
        field: 'Detail__c',
        reason: 'controlling-value',
        values: ['Yes'],
        recordType: 'Retail',
        controllingField: 'Active__c',
      },
    ]);
  });

  it('checks a dependent value against the record type alone when the controlling value is not one the answer names', () => {
    const row: Record<string, unknown> = { Reason__c: 'Late' };

    const changes = checkRowPicklists(
      row,
      null,
      new Map([['Reason__c', { ...optional, controllerName: 'Status__c' }]]),
      typed({ Reason__c: keeps(['Late', 'Done'], null, { Open: ['Done'] }) }),
    );

    expect(row).toEqual({ Reason__c: 'Late' });
    expect(changes).toEqual([]);
  });

  it('does not write a default the controlling value does not allow, and takes the first it does in a required field', () => {
    const row: Record<string, unknown> = { Status__c: 'Open', Reason__c: 'Done' };

    const changes = checkRowPicklists(
      row,
      null,
      new Map<string, PicklistField>([
        ['Status__c', optional],
        ['Reason__c', { ...optional, required: true, controllerName: 'Status__c' }],
      ]),
      typed({
        Status__c: keeps(['Open']),
        Reason__c: keeps(['Done', 'Late', 'Lost'], 'Done', {
          Open: ['Late', 'Lost'],
        }),
      }),
    );

    expect(row).toEqual({ Status__c: 'Open', Reason__c: 'Late' });
    expect(changes).toEqual([
      {
        field: 'Reason__c',
        reason: 'controlling-value',
        values: ['Done'],
        recordType: 'Retail',
        controllingField: 'Status__c',
        replacedBy: 'Late',
        replacement: 'first',
      },
    ]);
  });

  it('writes what the record type allows of a selection and leaves out the rest', () => {
    const row: Record<string, unknown> = { Colors__c: 'Red;Blue;Green' };

    const changes = checkRowPicklists(
      row,
      active({ Colors__c: ['Red', 'Blue', 'Green'] }),
      new Map([['Colors__c', { ...optional, multi: true }]]),
      typed({ Colors__c: keeps(['Red', 'Green'], 'Red') }),
    );

    expect(row).toEqual({ Colors__c: 'Red;Green' });
    expect(changes).toEqual([
      { field: 'Colors__c', reason: 'record-type', values: ['Blue'], recordType: 'Retail' },
    ]);
  });

  it("replaces a selection with nothing allowed in it by the record type's default", () => {
    const row: Record<string, unknown> = { Colors__c: 'Blue;Pink' };

    const changes = checkRowPicklists(
      row,
      active({ Colors__c: ['Red', 'Blue'] }),
      new Map([['Colors__c', { ...optional, multi: true }]]),
      typed({ Colors__c: keeps(['Red'], 'Red') }),
    );

    expect(row).toEqual({ Colors__c: 'Red' });
    expect(changes).toEqual([
      {
        field: 'Colors__c',
        reason: 'record-type',
        values: ['Blue'],
        recordType: 'Retail',
        replacedBy: 'Red',
        replacement: 'default',
      },
      {
        field: 'Colors__c',
        reason: 'not-in-target',
        values: ['Pink'],
        recordType: 'Retail',
        replacedBy: 'Red',
        replacement: 'default',
      },
    ]);
  });

  it('checks a picklist that is not restricted against the values of the field alone, record type read or not', () => {
    const row: Record<string, unknown> = { Rating: 'Warm' };

    const changes = checkRowPicklists(
      row,
      active({ Rating: ['Hot', 'Warm'] }),
      new Map([['Rating', { ...optional, restricted: false }]]),
      typed({ Rating: keeps(['Hot'], 'Hot') }),
    );

    expect(row).toEqual({ Rating: 'Warm' });
    expect(changes).toEqual([]);
  });

  it("checks a field the record type's answer leaves out against the values of the field", () => {
    const row: Record<string, unknown> = { Status__c: 'Gone', Kind__c: 'Old' };

    const changes = checkRowPicklists(
      row,
      active({ Status__c: ['New'], Kind__c: ['New', 'Old'] }),
      new Map([
        ['Status__c', optional],
        ['Kind__c', optional],
      ]),
      typed({ Kind__c: keeps(['New'], 'New') }),
    );

    expect(row).toEqual({ Kind__c: 'New' });
    expect(changes).toEqual([
      { field: 'Status__c', reason: 'not-in-target', values: ['Gone'] },
      {
        field: 'Kind__c',
        reason: 'record-type',
        values: ['Old'],
        recordType: 'Retail',
        replacedBy: 'New',
        replacement: 'default',
      },
    ]);
  });

  it('leaves out, without a record type, a value the field does not hold, as it always did', () => {
    const row: Record<string, unknown> = { Status__c: 'Gone', Kind__c: 'New' };

    const changes = checkRowPicklists(
      row,
      active({ Status__c: ['New'], Kind__c: ['New'] }),
      new Map([
        ['Status__c', optional],
        ['Kind__c', optional],
      ]),
      undefined,
    );

    expect(row).toEqual({ Kind__c: 'New' });
    expect(changes).toEqual([{ field: 'Status__c', reason: 'not-in-target', values: ['Gone'] }]);
  });

  it('checks a selection one value at a time against the values of the field', () => {
    // The whole value was looked up as one: a selection of two values the
    // target holds, `Red;Blue`, is no value of the field, and was dropped.
    const kept: Record<string, unknown> = { Colors__c: 'Red;Blue' };
    const trimmed: Record<string, unknown> = { Colors__c: 'Red;Pink' };
    const fields = new Map([['Colors__c', { ...optional, restricted: false, multi: true }]]);
    const values = active({ Colors__c: ['Red', 'Blue'] });

    expect(checkRowPicklists(kept, values, fields, undefined)).toEqual([]);
    expect(kept).toEqual({ Colors__c: 'Red;Blue' });
    expect(checkRowPicklists(trimmed, values, fields, undefined)).toEqual([
      { field: 'Colors__c', reason: 'not-in-target', values: ['Pink'] },
    ]);
    expect(trimmed).toEqual({ Colors__c: 'Red' });
  });

  it('leaves a field written under a rename to the field map', () => {
    const row: Record<string, unknown> = { Status__c: 'Gone' };

    const changes = checkRowPicklists(
      row,
      active({ Status__c: ['New'] }),
      new Map([['Status__c', optional]]),
      typed({ Status__c: keeps(['New'], 'New') }),
      new Set(['Status__c']),
    );

    expect(row).toEqual({ Status__c: 'Gone' });
    expect(changes).toEqual([]);
  });

  it('sends nothing for an empty value, and says nothing of it', () => {
    const row: Record<string, unknown> = { Status__c: '' };

    expect(
      checkRowPicklists(
        row,
        active({ Status__c: ['New'] }),
        new Map([['Status__c', optional]]),
        undefined,
      ),
    ).toEqual([]);
    expect(row).toEqual({});
  });
});

describe('RecordTypePicklistReads', () => {
  const fields = new Map<string, PicklistField>([
    ['Status__c', optional],
    ['Rating', { ...optional, restricted: false }],
  ]);
  const everyField = (): boolean => true;
  const answer: RecordTypePicklists = new Map([['Status__c', keeps(['New'], 'New')]]);

  it('reads each record type of an object once a run, whatever the rows and the writes', async () => {
    const read = vi.fn(async () => answer);
    const reads = new RecordTypePicklistReads(read);
    const rows = [
      { RecordTypeId: SOURCE_RETAIL, Status__c: 'Old' },
      { RecordTypeId: SOURCE_RETAIL, Status__c: 'New' },
      { RecordTypeId: SOURCE_TRADE, Status__c: 'Old' },
    ];
    const input = {
      objectApiName: 'Order__c',
      rows,
      fields,
      written: everyField,
      recordTypeMappings: MAPPINGS,
    };

    const first = await reads.forRows(input);
    const second = await reads.forRows(input);

    expect(read.mock.calls).toEqual([
      ['Order__c', TARGET_RETAIL],
      ['Order__c', TARGET_TRADE],
    ]);
    expect(first.byRecordType.get(SOURCE_RETAIL)).toEqual({
      recordType: 'Retail',
      picklists: answer,
    });
    expect(first.byRecordType.get(SOURCE_TRADE)).toEqual({
      recordType: 'Trade',
      picklists: answer,
    });
    expect(second.byRecordType.size).toBe(2);
  });

  it('reads no record type the mapping does not translate, nor one whose rows hold no restricted value', async () => {
    const read = vi.fn(async () => answer);
    const reads = new RecordTypePicklistReads(read);

    const { byRecordType } = await reads.forRows({
      objectApiName: 'Order__c',
      rows: [
        // Not translated: its record type is not known in the target.
        { RecordTypeId: '012000000000009AAA', Status__c: 'Old' },
        // Only a picklist that is not restricted.
        { RecordTypeId: SOURCE_RETAIL, Rating: 'Hot' },
        { RecordTypeId: SOURCE_TRADE, Status__c: null },
      ],
      fields,
      written: everyField,
      recordTypeMappings: MAPPINGS,
    });

    expect(read).not.toHaveBeenCalled();
    expect(byRecordType.size).toBe(0);
  });

  it('reads nothing when the rows are not written with their record type, or with the restricted field', async () => {
    const read = vi.fn(async () => answer);
    const rows = [{ RecordTypeId: SOURCE_RETAIL, Status__c: 'Old' }];
    const base = { objectApiName: 'Order__c', rows, fields, recordTypeMappings: MAPPINGS };

    await new RecordTypePicklistReads(read).forRows({
      ...base,
      written: (name) => name !== 'RecordTypeId',
    });
    await new RecordTypePicklistReads(read).forRows({
      ...base,
      written: (name) => name !== 'Status__c',
    });
    await new RecordTypePicklistReads(read).forRows({
      ...base,
      written: everyField,
      recordTypeMappings: undefined,
    });
    const unwired = await new RecordTypePicklistReads().forRows({ ...base, written: everyField });

    expect(read).not.toHaveBeenCalled();
    expect(unwired.byRecordType.size).toBe(0);
  });

  it('says once that a record type could not be read, and gives its rows nothing to be checked against', async () => {
    const read = vi.fn(async () => {
      throw new Error('INVALID_TYPE: this entity is not supported');
    });
    const reads = new RecordTypePicklistReads(read);
    const input = {
      objectApiName: 'Order__c',
      rows: [{ RecordTypeId: SOURCE_RETAIL, Status__c: 'Old' }],
      fields,
      written: everyField,
      recordTypeMappings: MAPPINGS,
    };

    const first = await reads.forRows(input);
    const second = await reads.forRows(input);

    expect(read).toHaveBeenCalledTimes(1);
    expect(first.byRecordType.size).toBe(0);
    expect(first.notes).toEqual([
      { recordType: 'Retail', error: 'INVALID_TYPE: this entity is not supported' },
    ]);
    expect(second.notes).toEqual([]);
  });

  it('says a read that throws before it is sent as one that failed, and leaves the run going', async () => {
    const reads = new RecordTypePicklistReads(() => {
      throw new Error('No connection for tgt');
    });

    const { byRecordType, notes } = await reads.forRows({
      objectApiName: 'Order__c',
      rows: [{ RecordTypeId: SOURCE_RETAIL, Status__c: 'Old' }],
      fields,
      written: everyField,
      recordTypeMappings: MAPPINGS,
    });

    expect(byRecordType.size).toBe(0);
    expect(notes).toEqual([{ recordType: 'Retail', error: 'No connection for tgt' }]);
  });

  it('says once which fields a record type’s answer leaves out that its rows hold a value in', async () => {
    const reads = new RecordTypePicklistReads(async () => new Map());
    const input = {
      objectApiName: 'Order__c',
      rows: [{ RecordTypeId: SOURCE_RETAIL, Status__c: 'Old' }],
      fields,
      written: everyField,
      recordTypeMappings: MAPPINGS,
    };

    const first = await reads.forRows(input);
    const second = await reads.forRows(input);

    expect(first.notes).toEqual([{ recordType: 'Retail', leftOut: ['Status__c'] }]);
    expect(first.byRecordType.get(SOURCE_RETAIL)?.recordType).toBe('Retail');
    expect(second.notes).toEqual([]);
  });
});

describe('recordTypeReadSample', () => {
  it('says a record type that could not be read, with why', () => {
    expect(recordTypeReadSample({ recordType: 'Retail', error: 'INVALID_TYPE: no' })).toEqual({
      recordSummary:
        "(picklist values of record type Retail could not be read — checked against each field's values)",
      messages: ['INVALID_TYPE: no'],
    });
  });

  it('says the fields an answer left out', () => {
    expect(
      recordTypeReadSample({ recordType: 'Retail', leftOut: ['Kind__c', 'Status__c'] }),
    ).toEqual({
      recordSummary:
        "(picklist values of record type Retail not given for Kind__c, Status__c — checked against each field's values)",
      messages: ["The target's answer for record type Retail leaves out Kind__c, Status__c."],
    });
  });
});

describe('PicklistChangeTally', () => {
  it('counts the rows of each object, field, reason and outcome, with every value refused', () => {
    const tally = new PicklistChangeTally();
    const replaced = {
      field: 'Status__c',
      reason: 'record-type' as const,
      recordType: 'Retail',
      replacedBy: 'New',
      replacement: 'default' as const,
    };
    tally.add('Order__c', [{ ...replaced, values: ['Old'] }]);
    tally.add('Order__c', [
      { ...replaced, values: ['Older'] },
      { field: 'Kind__c', reason: 'not-in-target', values: ['Gone'] },
    ]);
    tally.add('Order__c', [{ ...replaced, values: ['Old'] }]);
    tally.add('Invoice__c', [{ ...replaced, values: ['Old'] }]);

    expect(tally.size).toBe(3);
    expect(tally.list()).toEqual([
      {
        objectApiName: 'Order__c',
        field: 'Status__c',
        reason: 'record-type',
        values: ['Old', 'Older'],
        rows: 3,
        recordType: 'Retail',
        replacedBy: 'New',
        replacement: 'default',
      },
      {
        objectApiName: 'Order__c',
        field: 'Kind__c',
        reason: 'not-in-target',
        values: ['Gone'],
        rows: 1,
      },
      {
        objectApiName: 'Invoice__c',
        field: 'Status__c',
        reason: 'record-type',
        values: ['Old'],
        rows: 1,
        recordType: 'Retail',
        replacedBy: 'New',
        replacement: 'default',
      },
    ]);
  });
});

describe('describePicklistChange', () => {
  const base = { objectApiName: 'Order__c', field: 'Status__c', values: ['Old'], rows: 2 };

  it('says what was refused, why, and what the rows got instead', () => {
    expect(
      describePicklistChange({
        ...base,
        reason: 'record-type',
        recordType: 'Retail',
        replacedBy: 'New',
        replacement: 'default',
      }),
    ).toBe(
      'Status__c on 2 rows: "Old" not allowed for record type Retail, replaced by "New", the default of record type Retail',
    );
    expect(
      describePicklistChange({
        ...base,
        rows: 1,
        reason: 'record-type',
        recordType: 'Retail',
        replacedBy: 'North',
        replacement: 'first',
      }),
    ).toBe(
      'Status__c on 1 row: "Old" not allowed for record type Retail, replaced by "North", the first value record type Retail allows: the field is required and has no default there',
    );
    expect(
      describePicklistChange({
        ...base,
        values: ['Gone', 'Lost'],
        reason: 'not-in-target',
      }),
    ).toBe('Status__c on 2 rows: "Gone", "Lost" not a value of the field in the target, left out');
    expect(
      describePicklistChange({
        ...base,
        field: 'Reason__c',
        reason: 'controlling-value',
        recordType: 'Retail',
        controllingField: 'Status__c',
      }),
    ).toBe('Reason__c on 2 rows: "Old" not allowed with the value of Status__c, left out');
  });
});

describe('picklistChangesNote', () => {
  it('says the changes of a write on its line, and nothing when there were none', () => {
    expect(picklistChangesNote([])).toBe('');
    expect(
      picklistChangesNote([
        {
          ...{ objectApiName: 'Order__c', field: 'Kind__c', values: ['Gone'], rows: 1 },
          reason: 'not-in-target',
        },
        {
          objectApiName: 'Order__c',
          field: 'Status__c',
          values: ['Old'],
          rows: 2,
          reason: 'record-type',
          recordType: 'Retail',
        },
      ]),
    ).toBe(
      ', picklist values not written as read: Kind__c on 1 row: "Gone" not a value of the field in the target, left out; ' +
        'Status__c on 2 rows: "Old" not allowed for record type Retail, left out',
    );
  });
});
