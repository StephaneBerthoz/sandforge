import { describe, expect, it, vi } from 'vitest';
import { SchemaAligner, type SchemaAlignObjectInput } from './SchemaAligner.js';
import type { PicklistRule, TargetFieldDescribe, TargetObjectDescribe } from './loadTypes.js';
import type { FrozenRecord } from './types.js';

function field(overrides: Partial<TargetFieldDescribe>): TargetFieldDescribe {
  return {
    name: 'Field__c',
    type: 'string',
    createable: true,
    nillable: true,
    defaultedOnCreate: false,
    ...overrides,
  };
}

function makeDescribe(fields: TargetFieldDescribe[]): TargetObjectDescribe {
  return { name: 'Contact', fields };
}

function makeInput(overrides?: Partial<SchemaAlignObjectInput>): SchemaAlignObjectInput {
  return {
    orgId: '00D-target',
    objectApiName: 'Contact',
    records: [],
    describe: makeDescribe([]),
    resolvedRecordTypes: new Map(),
    ruleFor: () => ({ action: 'clear' }),
    ...overrides,
  };
}

describe('SchemaAligner — field alignment', () => {
  it('removes fields absent from the target describe and lists them', async () => {
    const aligner = new SchemaAligner({
      query: vi.fn(),
      describe: vi.fn(),
      picklistValues: vi.fn(),
    });
    const records: FrozenRecord[] = [
      { referenceId: 'Contact-000001', fields: { LastName: 'Doe', GhostField__c: 'x' } },
      { referenceId: 'Contact-000002', fields: { LastName: 'Roe', GhostField__c: 'y' } },
    ];
    const result = await aligner.alignObject(
      makeInput({ records, describe: makeDescribe([field({ name: 'LastName' })]) }),
    );

    expect(result.alignedRecords).toEqual([{ LastName: 'Doe' }, { LastName: 'Roe' }]);
    expect(result.removals).toEqual([
      {
        objectApiName: 'Contact',
        field: 'GhostField__c',
        reason: 'not-in-target',
        affectedRecords: 2,
      },
    ]);
  });

  it('removes non-createable fields and lists them', async () => {
    const aligner = new SchemaAligner({
      query: vi.fn(),
      describe: vi.fn(),
      picklistValues: vi.fn(),
    });
    const records: FrozenRecord[] = [
      { referenceId: 'Contact-000001', fields: { LastName: 'Doe', Formula__c: 'fx' } },
    ];
    const result = await aligner.alignObject(
      makeInput({
        records,
        describe: makeDescribe([
          field({ name: 'LastName' }),
          field({ name: 'Formula__c', createable: false }),
        ]),
      }),
    );

    expect(result.alignedRecords).toEqual([{ LastName: 'Doe' }]);
    expect(result.removals[0]).toMatchObject({ field: 'Formula__c', reason: 'not-createable' });
  });
});

describe('SchemaAligner — restricted picklists', () => {
  const statusField = field({
    name: 'Status__c',
    type: 'picklist',
    restrictedPicklist: true,
    picklistValues: [
      { value: 'Active', active: true },
      { value: 'Retired', active: false },
    ],
  });

  it('clears a globally inactive value per the declared rule and lists it', async () => {
    const aligner = new SchemaAligner({
      query: vi.fn(),
      describe: vi.fn(),
      picklistValues: vi.fn(),
    });
    const records: FrozenRecord[] = [
      { referenceId: 'Contact-000001', fields: { Status__c: 'Retired' } },
    ];
    const result = await aligner.alignObject(
      makeInput({ records, describe: makeDescribe([statusField]) }),
    );

    expect(result.alignedRecords).toEqual([{ Status__c: '' }]);
    expect(result.adjustments).toEqual([
      {
        objectApiName: 'Contact',
        field: 'Status__c',
        referenceId: 'Contact-000001',
        value: 'Retired',
        rule: { action: 'clear' },
        scope: 'global',
      },
    ]);
  });

  it('applies a declared replacement rule', async () => {
    const replace: PicklistRule = { action: 'replace', value: 'Active' };
    const aligner = new SchemaAligner({
      query: vi.fn(),
      describe: vi.fn(),
      picklistValues: vi.fn(),
    });
    const records: FrozenRecord[] = [
      { referenceId: 'Contact-000001', fields: { Status__c: 'Retired' } },
    ];
    const result = await aligner.alignObject(
      makeInput({ records, describe: makeDescribe([statusField]), ruleFor: () => replace }),
    );

    expect(result.alignedRecords).toEqual([{ Status__c: 'Active' }]);
    expect(result.adjustments[0].rule).toEqual(replace);
  });

  it('removes only the inactive components of a multipicklist', async () => {
    const aligner = new SchemaAligner({
      query: vi.fn(),
      describe: vi.fn(),
      picklistValues: vi.fn(),
    });
    const multi = field({
      name: 'Tags__c',
      type: 'multipicklist',
      restrictedPicklist: true,
      picklistValues: [
        { value: 'A', active: true },
        { value: 'B', active: false },
        { value: 'C', active: true },
      ],
    });
    const records: FrozenRecord[] = [
      { referenceId: 'Contact-000001', fields: { Tags__c: 'A;B;C' } },
    ];
    const result = await aligner.alignObject(
      makeInput({ records, describe: makeDescribe([multi]) }),
    );

    expect(result.alignedRecords).toEqual([{ Tags__c: 'A;C' }]);
    expect(result.adjustments[0]).toMatchObject({ scope: 'global', value: 'A;B;C' });
  });

  it('detects a RecordType assignment gap via the UI API (spec pitfall 2)', async () => {
    // Value active GLOBALLY but not assigned to the record's RecordType —
    // invisible to describe, only the UI API sees it.
    const picklistValues = vi.fn().mockResolvedValue(['Other']);
    const aligner = new SchemaAligner({ query: vi.fn(), describe: vi.fn(), picklistValues });
    const records: FrozenRecord[] = [
      { referenceId: 'Contact-000001', fields: { Status__c: 'Active', RecordTypeId: '012RT1' } },
    ];
    const result = await aligner.alignObject(
      makeInput({
        records,
        describe: makeDescribe([statusField, field({ name: 'RecordTypeId', type: 'reference' })]),
        resolvedRecordTypes: new Map([['Contact-000001', '012RT1']]),
      }),
    );

    expect(picklistValues).toHaveBeenCalledWith('00D-target', 'Contact', '012RT1', 'Status__c');
    expect(result.alignedRecords).toEqual([{ Status__c: '', RecordTypeId: '012RT1' }]);
    expect(result.adjustments).toEqual([
      {
        objectApiName: 'Contact',
        field: 'Status__c',
        referenceId: 'Contact-000001',
        value: 'Active',
        rule: { action: 'clear' },
        scope: 'record-type',
      },
    ]);
  });

  it('keeps the value when the UI API read fails, and lists a warning', async () => {
    const picklistValues = vi.fn().mockRejectedValue(new Error('UI API unavailable'));
    const aligner = new SchemaAligner({ query: vi.fn(), describe: vi.fn(), picklistValues });
    const records: FrozenRecord[] = [
      { referenceId: 'Contact-000001', fields: { Status__c: 'Active' } },
    ];
    const result = await aligner.alignObject(
      makeInput({
        records,
        describe: makeDescribe([statusField]),
        resolvedRecordTypes: new Map([['Contact-000001', '012RT1']]),
      }),
    );

    expect(result.alignedRecords).toEqual([{ Status__c: 'Active' }]);
    expect(result.adjustments).toEqual([]);
    expect(result.uiApiWarnings).toHaveLength(1);
    expect(result.uiApiWarnings[0]).toContain('UI API picklist-values read failed');
  });
});

describe('SchemaAligner — required fields (spec pitfall 3)', () => {
  it('lists a required lookup absent from every record', async () => {
    const aligner = new SchemaAligner({
      query: vi.fn(),
      describe: vi.fn(),
      picklistValues: vi.fn(),
    });
    const records: FrozenRecord[] = [
      { referenceId: 'Contact-000001', fields: { LastName: 'Doe' } },
    ];
    const result = await aligner.alignObject(
      makeInput({
        records,
        describe: makeDescribe([
          field({ name: 'LastName' }),
          field({
            name: 'Mandatory_Lookup__c',
            type: 'reference',
            nillable: false,
            referenceTo: ['Account'],
          }),
          // Defaulted-on-create fields are NOT flagged (platform fills them).
          field({ name: 'OwnerId', type: 'reference', nillable: false, defaultedOnCreate: true }),
        ]),
      }),
    );

    expect(result.missingRequired).toEqual([
      {
        objectApiName: 'Contact',
        field: 'Mandatory_Lookup__c',
        isLookup: true,
        referenceTo: ['Account'],
      },
    ]);
  });

  it('does not flag a required field carried by at least one record', async () => {
    const aligner = new SchemaAligner({
      query: vi.fn(),
      describe: vi.fn(),
      picklistValues: vi.fn(),
    });
    const records: FrozenRecord[] = [
      { referenceId: 'Contact-000001', fields: { LastName: 'Doe' } },
    ];
    const result = await aligner.alignObject(
      makeInput({
        records,
        describe: makeDescribe([field({ name: 'LastName', nillable: false })]),
      }),
    );
    expect(result.missingRequired).toEqual([]);
  });
});
