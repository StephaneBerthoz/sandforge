import { describe, it, expect } from 'vitest';
import { MetadataReader } from './MetadataReader';
import type {
  ObjectDescribe,
  FieldDescribe,
  RecordTypeInfo,
  ChildRelationship,
} from './MetadataReader';

function createMockField(overrides: Partial<FieldDescribe> = {}): FieldDescribe {
  return {
    name: 'TestField__c',
    label: 'Test Field',
    type: 'string',
    length: 255,
    nillable: true,
    createable: true,
    updateable: true,
    externalId: false,
    referenceTo: [],
    relationshipName: null,
    picklistValues: [],
    defaultValue: null,
    calculated: false,
    autoNumber: false,
    unique: false,
    ...overrides,
  };
}

function createMockObjectDescribe(
  name: string,
  fields: FieldDescribe[] = [],
  overrides: Partial<ObjectDescribe> = {},
): ObjectDescribe {
  return {
    name,
    label: name,
    labelPlural: `${name}s`,
    keyPrefix: '001',
    custom: name.endsWith('__c'),
    createable: true,
    updateable: true,
    deletable: true,
    queryable: true,
    fields,
    recordTypeInfos: [],
    childRelationships: [],
    ...overrides,
  };
}

describe('MetadataReader', () => {
  it('should cache and retrieve a describe result', () => {
    const reader = new MetadataReader();
    const describe = createMockObjectDescribe('Account', [createMockField({ name: 'Name' })]);

    reader.cacheDescribe('Account', describe);

    expect(reader.getDescribe('Account')).toEqual(describe);
    expect(reader.cacheSize).toBe(1);
  });

  it('should use case-insensitive keys for caching', () => {
    const reader = new MetadataReader();
    const describe = createMockObjectDescribe('Account');

    reader.cacheDescribe('Account', describe);

    expect(reader.getDescribe('account')).toEqual(describe);
    expect(reader.getDescribe('ACCOUNT')).toEqual(describe);
    expect(reader.hasCachedDescribe('aCcOuNt')).toBe(true);
  });

  it('should return undefined for uncached objects', () => {
    const reader = new MetadataReader();
    expect(reader.getDescribe('Contact')).toBeUndefined();
    expect(reader.hasCachedDescribe('Contact')).toBe(false);
  });

  it('should return all cached object names', () => {
    const reader = new MetadataReader();
    reader.cacheDescribe('Account', createMockObjectDescribe('Account'));
    reader.cacheDescribe('Contact', createMockObjectDescribe('Contact'));

    const names = reader.getCachedObjectNames();

    expect(names).toHaveLength(2);
    expect(names).toContain('Account');
    expect(names).toContain('Contact');
  });

  it('should return creatable fields', () => {
    const reader = new MetadataReader();
    const fields = [
      createMockField({ name: 'Name', createable: true }),
      createMockField({ name: 'Id', createable: false }),
      createMockField({ name: 'Email__c', createable: true }),
    ];
    reader.cacheDescribe('Contact', createMockObjectDescribe('Contact', fields));

    const creatable = reader.getCreatableFields('Contact');

    expect(creatable).toHaveLength(2);
    expect(creatable.map((f) => f.name)).toEqual(['Name', 'Email__c']);
  });

  it('should return updateable fields', () => {
    const reader = new MetadataReader();
    const fields = [
      createMockField({ name: 'Name', updateable: true }),
      createMockField({ name: 'CreatedDate', updateable: false }),
    ];
    reader.cacheDescribe('Account', createMockObjectDescribe('Account', fields));

    const updateable = reader.getUpdateableFields('Account');

    expect(updateable).toHaveLength(1);
    expect(updateable[0].name).toBe('Name');
  });

  it('should return reference fields', () => {
    const reader = new MetadataReader();
    const fields = [
      createMockField({ name: 'AccountId', referenceTo: ['Account'], relationshipName: 'Account' }),
      createMockField({ name: 'Name', referenceTo: [] }),
      createMockField({
        name: 'OwnerId',
        referenceTo: ['User', 'Group'],
        relationshipName: 'Owner',
      }),
    ];
    reader.cacheDescribe('Contact', createMockObjectDescribe('Contact', fields));

    const refs = reader.getReferenceFields('Contact');

    expect(refs).toHaveLength(2);
    expect(refs.map((f) => f.name)).toEqual(['AccountId', 'OwnerId']);
  });

  it('should return required fields', () => {
    const reader = new MetadataReader();
    const fields = [
      createMockField({ name: 'LastName', createable: true, nillable: false }),
      createMockField({ name: 'FirstName', createable: true, nillable: true }),
      createMockField({ name: 'AutoNum', createable: true, nillable: false, autoNumber: true }),
      createMockField({ name: 'Formula', createable: true, nillable: false, calculated: true }),
      createMockField({
        name: 'HasDefault',
        createable: true,
        nillable: false,
        defaultValue: 'test',
      }),
      createMockField({ name: 'ReadOnly', createable: false, nillable: false }),
    ];
    reader.cacheDescribe('Contact', createMockObjectDescribe('Contact', fields));

    const required = reader.getRequiredFields('Contact');

    expect(required).toHaveLength(1);
    expect(required[0].name).toBe('LastName');
  });

  it('should return external ID fields', () => {
    const reader = new MetadataReader();
    const fields = [
      createMockField({ name: 'ExternalId__c', externalId: true }),
      createMockField({ name: 'Name', externalId: false }),
      createMockField({ name: 'LegacyId__c', externalId: true }),
    ];
    reader.cacheDescribe('Account', createMockObjectDescribe('Account', fields));

    const extIds = reader.getExternalIdFields('Account');

    expect(extIds).toHaveLength(2);
    expect(extIds.map((f) => f.name)).toEqual(['ExternalId__c', 'LegacyId__c']);
  });

  it('should return active record types only', () => {
    const reader = new MetadataReader();
    const recordTypes: RecordTypeInfo[] = [
      {
        recordTypeId: '012000000000001',
        name: 'Standard',
        developerName: 'Standard',
        active: true,
        defaultRecordTypeMapping: true,
      },
      {
        recordTypeId: '012000000000002',
        name: 'Custom',
        developerName: 'Custom',
        active: true,
        defaultRecordTypeMapping: false,
      },
      {
        recordTypeId: '012000000000003',
        name: 'Inactive',
        developerName: 'Inactive',
        active: false,
        defaultRecordTypeMapping: false,
      },
    ];
    reader.cacheDescribe(
      'Account',
      createMockObjectDescribe('Account', [], { recordTypeInfos: recordTypes }),
    );

    const activeRTs = reader.getRecordTypes('Account');

    expect(activeRTs).toHaveLength(2);
    expect(activeRTs.map((rt) => rt.name)).toEqual(['Standard', 'Custom']);
  });

  it('should return child relationships', () => {
    const reader = new MetadataReader();
    const childRelationships: ChildRelationship[] = [
      {
        childSObject: 'Contact',
        field: 'AccountId',
        relationshipName: 'Contacts',
        cascadeDelete: false,
      },
      {
        childSObject: 'Opportunity',
        field: 'AccountId',
        relationshipName: 'Opportunities',
        cascadeDelete: true,
      },
    ];
    reader.cacheDescribe(
      'Account',
      createMockObjectDescribe('Account', [], { childRelationships }),
    );

    const children = reader.getChildRelationships('Account');

    expect(children).toHaveLength(2);
    expect(children[0].childSObject).toBe('Contact');
    expect(children[1].cascadeDelete).toBe(true);
  });

  it('should clear cache for a specific object', () => {
    const reader = new MetadataReader();
    reader.cacheDescribe('Account', createMockObjectDescribe('Account'));
    reader.cacheDescribe('Contact', createMockObjectDescribe('Contact'));

    reader.clearCache('Account');

    expect(reader.hasCachedDescribe('Account')).toBe(false);
    expect(reader.hasCachedDescribe('Contact')).toBe(true);
    expect(reader.cacheSize).toBe(1);
  });

  it('should clear all cache', () => {
    const reader = new MetadataReader();
    reader.cacheDescribe('Account', createMockObjectDescribe('Account'));
    reader.cacheDescribe('Contact', createMockObjectDescribe('Contact'));

    reader.clearAllCache();

    expect(reader.cacheSize).toBe(0);
    expect(reader.getCachedObjectNames()).toEqual([]);
  });

  it('should return empty arrays for uncached objects in field queries', () => {
    const reader = new MetadataReader();

    expect(reader.getCreatableFields('Unknown')).toEqual([]);
    expect(reader.getUpdateableFields('Unknown')).toEqual([]);
    expect(reader.getReferenceFields('Unknown')).toEqual([]);
    expect(reader.getRequiredFields('Unknown')).toEqual([]);
    expect(reader.getExternalIdFields('Unknown')).toEqual([]);
    expect(reader.getRecordTypes('Unknown')).toEqual([]);
    expect(reader.getChildRelationships('Unknown')).toEqual([]);
  });
});
