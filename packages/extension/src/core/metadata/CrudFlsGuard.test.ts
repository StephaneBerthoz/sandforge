import { describe, it, expect, vi } from 'vitest';
import { CrudFlsGuard } from './CrudFlsGuard';
import type { ObjectDescribe } from './MetadataReader';
import type { DescribeFetchFn, CrudOperation } from './CrudFlsGuard';

function makeDescribe(overrides: Partial<ObjectDescribe> = {}): ObjectDescribe {
  return {
    name: 'Account',
    label: 'Account',
    labelPlural: 'Accounts',
    keyPrefix: '001',
    custom: false,
    createable: true,
    updateable: true,
    deletable: true,
    queryable: true,
    fields: [
      {
        name: 'Name',
        label: 'Name',
        type: 'string',
        length: 255,
        nillable: false,
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
      },
      {
        name: 'CreatedDate',
        label: 'Created Date',
        type: 'datetime',
        length: 0,
        nillable: false,
        createable: false,
        updateable: false,
        externalId: false,
        referenceTo: [],
        relationshipName: null,
        picklistValues: [],
        defaultValue: null,
        calculated: false,
        autoNumber: false,
        unique: false,
      },
    ],
    recordTypeInfos: [],
    childRelationships: [],
    ...overrides,
  };
}

describe('CrudFlsGuard', () => {
  describe('checkCrudPermission', () => {
    it('should allow insert when object is createable', async () => {
      const fetch: DescribeFetchFn = vi.fn().mockResolvedValue(makeDescribe());
      const guard = new CrudFlsGuard(fetch);
      const result = await guard.checkCrudPermission('Account', 'insert');
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('');
    });

    it('should deny insert when object is not createable', async () => {
      const fetch: DescribeFetchFn = vi.fn().mockResolvedValue(makeDescribe({ createable: false }));
      const guard = new CrudFlsGuard(fetch);
      const result = await guard.checkCrudPermission('Account', 'insert');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('insert');
    });

    it('should deny upsert when object is not both createable and updateable', async () => {
      const fetch: DescribeFetchFn = vi
        .fn()
        .mockResolvedValue(makeDescribe({ createable: true, updateable: false }));
      const guard = new CrudFlsGuard(fetch);
      const result = await guard.checkCrudPermission('Account', 'upsert');
      expect(result.allowed).toBe(false);
    });

    it('should deny when describe is unavailable', async () => {
      const fetch: DescribeFetchFn = vi.fn().mockResolvedValue(undefined);
      const guard = new CrudFlsGuard(fetch);
      const result = await guard.checkCrudPermission('UnknownObj', 'insert');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not available');
    });

    it.each<CrudOperation>(['insert', 'update', 'upsert', 'delete'])(
      'should allow %s when all permissions are granted',
      async (operation) => {
        const fetch: DescribeFetchFn = vi.fn().mockResolvedValue(makeDescribe());
        const guard = new CrudFlsGuard(fetch);
        const result = await guard.checkCrudPermission('Account', operation);
        expect(result.allowed).toBe(true);
      },
    );
  });

  describe('checkCrudAndFls', () => {
    it('should allow insert when object and field are createable', async () => {
      const fetch: DescribeFetchFn = vi.fn().mockResolvedValue(makeDescribe());
      const guard = new CrudFlsGuard(fetch);
      const result = await guard.checkCrudAndFls('Account', 'insert', ['Name']);
      expect(result.allowed).toBe(true);
      expect(result.deniedFields).toHaveLength(0);
    });

    it('should deny insert when field is not createable', async () => {
      const fetch: DescribeFetchFn = vi.fn().mockResolvedValue(makeDescribe());
      const guard = new CrudFlsGuard(fetch);
      const result = await guard.checkCrudAndFls('Account', 'insert', ['CreatedDate']);
      expect(result.allowed).toBe(false);
      expect(result.deniedFields).toContain('CreatedDate');
    });

    it('should skip FLS check for delete operations', async () => {
      const fetch: DescribeFetchFn = vi.fn().mockResolvedValue(makeDescribe());
      const guard = new CrudFlsGuard(fetch);
      const result = await guard.checkCrudAndFls('Account', 'delete', ['Name']);
      expect(result.allowed).toBe(true);
    });

    it('should handle case-insensitive field matching', async () => {
      const fetch: DescribeFetchFn = vi.fn().mockResolvedValue(makeDescribe());
      const guard = new CrudFlsGuard(fetch);
      const result = await guard.checkCrudAndFls('Account', 'insert', ['name']);
      expect(result.allowed).toBe(true);
    });

    it('should ignore unknown fields (let Salesforce reject them)', async () => {
      const fetch: DescribeFetchFn = vi.fn().mockResolvedValue(makeDescribe());
      const guard = new CrudFlsGuard(fetch);
      const result = await guard.checkCrudAndFls('Account', 'insert', ['NonExistentField__c']);
      expect(result.allowed).toBe(true);
    });
  });
});
