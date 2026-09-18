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
    objectApiName: 'Contact',
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
      {
        name: 'OwnerId',
        queryable: true,
        createable: true,
        isReference: true,
        referenceTo: ['User'],
      },
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

  it('sends one of two mutually exclusive fields, keeping the authoritative one', () => {
    const fields: FieldInfo[] = [
      { name: 'Quantity', queryable: true, createable: true, isReference: false },
      { name: 'UnitPrice', queryable: true, createable: true, isReference: false },
      { name: 'TotalPrice', queryable: true, createable: true, isReference: false },
    ];
    const [out] = cleanNodeRecords(
      makeInput({
        objectApiName: 'OpportunityLineItem',
        records: [{ Quantity: 2, UnitPrice: 7.85, TotalPrice: 15.7 }],
        fieldInfos: fields,
        creatableFields: new Set(['Quantity', 'UnitPrice', 'TotalPrice']),
      }),
    );
    // TotalPrice is UnitPrice x Quantity, so the unit price is the one that
    // reproduces the other.
    expect(out.cleaned).toEqual({ Quantity: 2, UnitPrice: 7.85 });
  });

  it('keeps a lone total price when no unit price travels with it', () => {
    const fields: FieldInfo[] = [
      { name: 'TotalPrice', queryable: true, createable: true, isReference: false },
    ];
    const [out] = cleanNodeRecords(
      makeInput({
        objectApiName: 'OpportunityLineItem',
        records: [{ TotalPrice: 15.7 }],
        fieldInfos: fields,
        creatableFields: new Set(['TotalPrice']),
      }),
    );
    expect(out.cleaned).toEqual({ TotalPrice: 15.7 });
  });

  it('applies an owner mapping whose User was never cloned', () => {
    const fields: FieldInfo[] = [
      { name: 'Id', queryable: true, createable: false, isReference: false },
      {
        name: 'OwnerId',
        queryable: true,
        createable: true,
        isReference: true,
        referenceTo: ['User'],
      },
    ];
    // No remapper entry: the case the flag exists for. A User is never
    // cloned, so its source ID is never in the remapper, and the mapping
    // has nothing but the source value to key on.
    const [out] = cleanNodeRecords(
      makeInput({
        records: [{ Id: '003A', OwnerId: '005SOURCE' }],
        fieldInfos: fields,
        ownerMappings: { '005SOURCE': '005TARGET' },
        creatableFields: new Set(['Id', 'OwnerId']),
      }),
    );
    expect(out.cleaned.OwnerId).toBe('005TARGET');
  });

  it('does not queue a lookup at an uncopyable object for pass 2', () => {
    const fields: FieldInfo[] = [
      { name: 'Id', queryable: true, createable: false, isReference: false },
      {
        name: 'OwnerId',
        queryable: true,
        createable: true,
        isReference: true,
        referenceTo: ['User'],
      },
      {
        name: 'AccountId',
        queryable: true,
        createable: true,
        isReference: true,
        referenceTo: ['Account'],
      },
    ];
    const [out] = cleanNodeRecords(
      makeInput({
        records: [{ Id: '003A', OwnerId: '005SOURCE', AccountId: '001ORPHAN' }],
        fieldInfos: fields,
        creatableFields: new Set(['OwnerId', 'AccountId']),
      }),
    );
    // Account can be cloned by a later wave, so its orphan FK is a real
    // debt. No wave will ever produce a User, so pass 2 must not be told
    // to wait for one.
    expect(out.nullifiedFks.map((f) => f.field)).toEqual(['AccountId']);
    expect(out.cleaned.OwnerId).toBeUndefined();
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

  it('treats IsPersonAccount 1 as a person account and null as a business account', () => {
    const fields: FieldInfo[] = [
      { name: 'Id', queryable: true, createable: false, isReference: false },
      { name: 'Name', queryable: true, createable: true, isReference: false },
      { name: 'IsPersonAccount', queryable: true, createable: false, isReference: false },
      { name: 'Custom__pc', queryable: true, createable: true, isReference: false },
    ];
    const creatableFields = new Set(['Name', 'Custom__pc']);

    const [person] = cleanNodeRecords(
      makeInput({
        records: [{ Id: '001C', Name: 'Jane Roe', IsPersonAccount: 1, Custom__pc: 'y' }],
        fieldInfos: fields,
        creatableFields,
      }),
    );
    expect(person.cleaned).toEqual({ Custom__pc: 'y' });

    const [business] = cleanNodeRecords(
      makeInput({
        // An org without Person Accounts enabled returns no value at all.
        records: [{ Id: '001D', Name: 'Globex', IsPersonAccount: null, Custom__pc: 'y' }],
        fieldInfos: fields,
        creatableFields,
      }),
    );
    expect(business.cleaned).toEqual({ Name: 'Globex' });
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
    const describeFields = vi.fn<ForgeExecutorDeps['describeFields']>().mockResolvedValue([
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

describe('lookups at objects no clone creates', () => {
  const ownerField: FieldInfo[] = [
    { name: 'Id', queryable: true, createable: false, isReference: false },
    {
      name: 'OwnerId',
      queryable: true,
      createable: true,
      isReference: true,
      referenceTo: ['User'],
    },
  ];

  it('drops OwnerId so the platform fills it in', () => {
    // A source-org User id written into a target org points at nobody. On a
    // real UAT → DEV run this is what made the second pass report "cycle FK
    // could not be resolved" and lose the record. Dropped, Salesforce sets the
    // owner to the running user — which is what seeding a sandbox wants.
    const [out] = cleanNodeRecords(
      makeInput({
        records: [{ Id: '003A', OwnerId: '005SOURCEONLY' }],
        fieldInfos: ownerField,
        referenceFallback: 'nullify',
        creatableFields: new Set(['OwnerId']),
      }),
    );

    expect('OwnerId' in out.cleaned).toBe(false);
  });

  it('keeps it when the caller asked to carry ids across as they are', () => {
    // `keep` answers a different question — an FK whose target was in the
    // graph and was not cloned — and is meaningful when both orgs are one.
    const [out] = cleanNodeRecords(
      makeInput({
        records: [{ Id: '003A', OwnerId: '005SOURCEONLY' }],
        fieldInfos: ownerField,
        referenceFallback: 'keep',
        creatableFields: new Set(['OwnerId']),
      }),
    );

    expect(out.cleaned.OwnerId).toBe('005SOURCEONLY');
  });

  it('leaves a lookup at an object a clone can create alone', () => {
    const [out] = cleanNodeRecords(
      makeInput({
        records: [{ Id: '003A', AccountId: '001SOURCE' }],
        fieldInfos: [
          { name: 'Id', queryable: true, createable: false, isReference: false },
          {
            name: 'AccountId',
            queryable: true,
            createable: true,
            isReference: true,
            referenceTo: ['Account'],
          },
        ],
        referenceFallback: 'keep',
        creatableFields: new Set(['AccountId']),
      }),
    );

    expect(out.cleaned.AccountId).toBe('001SOURCE');
  });
});
