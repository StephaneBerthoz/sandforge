import { describe, it, expect, vi } from 'vitest';
import {
  cleanNodeRecords,
  describeTargetFieldSets,
  intersect,
  type CleanNodeRecordsInput,
} from './RecordCleaner.js';
import { IdRemapper } from '../IdRemapper.js';
import type { FieldInfo, ForgeExecutorDeps } from '../ForgeExecutor.js';

const FIELDS: FieldInfo[] = [
  { name: 'Id', queryable: true, createable: false, isReference: false },
  { name: 'Name', queryable: true, createable: true, isReference: false },
  {
    name: 'AccountId',
    queryable: true,
    createable: true,
    isReference: true,
    referenceTo: ['Account'],
  },
  {
    name: 'RecordTypeId',
    queryable: true,
    createable: true,
    isReference: true,
    referenceTo: ['RecordType'],
  },
];

function makeInput(overrides?: Partial<CleanNodeRecordsInput>): CleanNodeRecordsInput {
  return {
    records: [],
    fieldInfos: FIELDS,
    remapper: new IdRemapper(),
    referenceFallback: 'nullify',
    ownerMappings: {},
    excludedFields: new Set(),
    fieldRename: {},
    creatableFields: new Set(['Id', 'Name', 'AccountId', 'RecordTypeId']),
    picklistValuesByField: null,
    ...overrides,
  };
}

describe('cleanNodeRecords', () => {
  it('remaps lookup values through the IdRemapper', () => {
    const remapper = new IdRemapper();
    remapper.add('001OLD', '001NEW');
    const [out] = cleanNodeRecords(
      makeInput({ records: [{ Id: '003A', AccountId: '001OLD', Name: 'X' }], remapper }),
    );
    expect(out.cleaned.AccountId).toBe('001NEW');
  });

  it('nullifies orphan FKs and records them for pass 2 (nullify fallback)', () => {
    const [out] = cleanNodeRecords(
      makeInput({ records: [{ Id: '003A', AccountId: '001ORPHAN', Name: 'X' }] }),
    );
    expect('AccountId' in out.cleaned).toBe(false);
    expect(out.nullifiedFks).toEqual([
      { field: 'AccountId', sourceRefId: '001ORPHAN', targetObjects: ['Account'] },
    ]);
  });

  it('keeps orphan FK values under the keep fallback', () => {
    const [out] = cleanNodeRecords(
      makeInput({
        records: [{ Id: '003A', AccountId: '001ORPHAN' }],
        referenceFallback: 'keep',
      }),
    );
    expect(out.cleaned.AccountId).toBe('001ORPHAN');
    expect(out.nullifiedFks).toEqual([]);
  });

  it('never nullifies RecordTypeId and never remaps it through the generic remapper', () => {
    const remapper = new IdRemapper();
    remapper.add('012SOURCE', '012ACCIDENTAL');
    const [out] = cleanNodeRecords(
      makeInput({ records: [{ Id: '003A', RecordTypeId: '012SOURCE' }], remapper }),
    );
    expect(out.cleaned.RecordTypeId).toBe('012SOURCE');
    expect(out.nullifiedFks).toEqual([]);
  });

  it('applies owner mappings before insert', () => {
    const fields: FieldInfo[] = [
      { name: 'Id', queryable: true, createable: false, isReference: false },
      { name: 'OwnerId', queryable: true, createable: true, isReference: true, referenceTo: ['User'] },
    ];
    const remapper = new IdRemapper();
    remapper.add('005EX_EMPLOYEE', '005REMAPPED');
    const [out] = cleanNodeRecords(
      makeInput({
        records: [{ Id: '003A', OwnerId: '005EX_EMPLOYEE' }],
        fieldInfos: fields,
        remapper,
        ownerMappings: { '005REMAPPED': '005FINAL' },
        creatableFields: new Set(['Id', 'OwnerId']),
      }),
    );
    expect(out.cleaned.OwnerId).toBe('005FINAL');
  });

  it('strips non-createable fields, exclusions and null values', () => {
    const [out] = cleanNodeRecords(
      makeInput({
        records: [{ Id: '003A', Name: null, AccountId: '001ORPHAN' }],
        excludedFields: new Set(['Name']),
        creatableFields: new Set(['Name', 'AccountId']),
      }),
    );
    // Id not createable, Name excluded, AccountId nullified → null → omitted.
    expect(out.cleaned).toEqual({});
  });

  it('writes renamed fields under the target API name, bypassing the source createable check', () => {
    const [out] = cleanNodeRecords(
      makeInput({
        records: [{ Id: '003A', Region__c: 'EMEA' }],
        fieldRename: { Region__c: 'Region__pc' },
        creatableFields: new Set(['Region__c']),
      }),
    );
    expect(out.cleaned).toEqual({ Region__pc: 'EMEA' });
  });

  it('strips __pc fields from business accounts but keeps them on person accounts (string coercion)', () => {
    const fields: FieldInfo[] = [
      { name: 'Id', queryable: true, createable: false, isReference: false },
      { name: 'Name', queryable: true, createable: true, isReference: false },
      { name: 'IsPersonAccount', queryable: true, createable: false, isReference: false },
      { name: 'PersonEmail', queryable: true, createable: true, isReference: false },
      { name: 'Custom__pc', queryable: true, createable: true, isReference: false },
    ];
    const creatableFields = new Set(['Name', 'PersonEmail', 'Custom__pc']);
    const [business] = cleanNodeRecords(
      makeInput({
        records: [{ Id: '001A', Name: 'Acme', IsPersonAccount: false, Custom__pc: 'x' }],
        fieldInfos: fields,
        creatableFields,
      }),
    );
    expect(business.cleaned).toEqual({ Name: 'Acme' });

    const [person] = cleanNodeRecords(
      makeInput({
        // jsforce SOAP-normalized string 'true' must still count as person account.
        records: [{ Id: '001B', Name: 'John Doe', IsPersonAccount: 'true', Custom__pc: 'x' }],
        fieldInfos: fields,
        creatableFields,
      }),
    );
    // Name is auto-computed on person accounts → dropped; __pc kept.
    expect(person.cleaned).toEqual({ Custom__pc: 'x' });
  });

  it('drops picklist values the target org does not accept', () => {
    const fields: FieldInfo[] = [
      { name: 'Id', queryable: true, createable: false, isReference: false },
      { name: 'Status', queryable: true, createable: true, isReference: false },
    ];
    const picklistValuesByField = new Map([['Status', new Set(['Open', 'Closed'])]]);
    const [kept, dropped] = cleanNodeRecords(
      makeInput({
        records: [
          { Id: '003A', Status: 'Open' },
          { Id: '003B', Status: 'SourceOnlyValue' },
        ],
        fieldInfos: fields,
        creatableFields: new Set(['Status']),
        picklistValuesByField,
      }),
    );
    expect(kept.cleaned.Status).toBe('Open');
    expect('Status' in dropped.cleaned).toBe(false);
  });
});

describe('describeTargetFieldSets', () => {
  it('returns the createable set and picklist whitelists', async () => {
    const describeFields = vi
      .fn<ForgeExecutorDeps['describeFields']>()
      .mockResolvedValue([
        { name: 'Id', queryable: true, createable: false, isReference: false },
        {
          name: 'Status',
          queryable: true,
          createable: true,
          isReference: false,
          picklistValues: ['Open'],
        },
      ]);
    const sets = await describeTargetFieldSets(describeFields, 'tgt', 'Case');
    expect(describeFields).toHaveBeenCalledWith('tgt', 'Case');
    expect(sets.creatable).toEqual(new Set(['Status']));
    expect(sets.picklistValuesByField?.get('Status')).toEqual(new Set(['Open']));
  });

  it('returns a null picklist map when no restricted picklist exists', async () => {
    const describeFields = vi
      .fn<ForgeExecutorDeps['describeFields']>()
      .mockResolvedValue([{ name: 'Name', queryable: true, createable: true, isReference: false }]);
    const sets = await describeTargetFieldSets(describeFields, 'tgt', 'Account');
    expect(sets.picklistValuesByField).toBeNull();
  });

  it('propagates describe failures so the caller can fall back to source schema', async () => {
    const describeFields = vi
      .fn<ForgeExecutorDeps['describeFields']>()
      .mockRejectedValue(new Error('auth expired'));
    await expect(describeTargetFieldSets(describeFields, 'tgt', 'Account')).rejects.toThrow(
      'auth expired',
    );
  });
});

describe('intersect', () => {
  it('keeps only values present in both sets', () => {
    expect(intersect(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']))).toEqual(
      new Set(['b', 'c']),
    );
  });
});
