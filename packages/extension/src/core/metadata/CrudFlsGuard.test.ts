import { describe, it, expect, vi } from 'vitest';
import { CrudFlsGuard, CRUD_FLS_DENIED, crudFlsDenials, flsViolation } from './CrudFlsGuard';
import type { ObjectDescribe } from './describeTypes';
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
      // Said under its code, which the panel words in the interface language.
      expect(result.reason.startsWith(`${CRUD_FLS_DENIED}: `)).toBe(true);
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

describe('deniedOf', () => {
  it('answers every object of a run the user may not write as asked, and nothing for the rest', async () => {
    const describes: Record<string, ObjectDescribe> = {
      Account: makeDescribe(),
      Contact: makeDescribe({ name: 'Contact', updateable: false }),
      Lead: makeDescribe({ name: 'Lead' }),
    };
    const guard = new CrudFlsGuard(async (name) => describes[name]);

    const denials = await guard.deniedOf([
      { objectApiName: 'Account', operation: 'update', fieldNames: ['Name'] },
      { objectApiName: 'Contact', operation: 'update', fieldNames: ['Name'] },
      { objectApiName: 'Lead', operation: 'update', fieldNames: ['Name', 'CreatedDate'] },
    ]);

    expect(denials).toEqual([
      { objectApiName: 'Contact', operation: 'update', deniedFields: [] },
      { objectApiName: 'Lead', operation: 'update', deniedFields: ['CreatedDate'] },
    ]);
  });
});

describe('crudFlsDenials', () => {
  it('says every refusal in one sentence under the code the panels word it by', () => {
    expect(
      crudFlsDenials([
        { objectApiName: 'Contact', operation: 'update', deniedFields: [] },
        { objectApiName: 'Lead', operation: 'insert', deniedFields: ['Email', 'Phone'] },
      ]),
    ).toBe(
      'CRUD_FLS_DENIED: nothing was written, as the connected user may not write all it would: ' +
        "User lacks 'update' permission on 'Contact'; fields [Email, Phone] of 'Lead' are not " +
        'createable.',
    );
  });
});

describe('flsViolation', () => {
  it('says the fields refused under the code the panels word it by', () => {
    expect(flsViolation('Account', ['Rating', 'Secret__c'], 'update')).toBe(
      "CRUD_FLS_DENIED: FLS violation on 'Account': fields [Rating, Secret__c] are not updateable.",
    );
    expect(flsViolation('Account', ['Rating'], 'insert')).toContain('are not createable');
  });
});
