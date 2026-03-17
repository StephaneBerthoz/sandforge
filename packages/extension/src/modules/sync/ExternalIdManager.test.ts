import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExternalIdManager } from './ExternalIdManager';
import type { ExternalIdManagerDeps, FieldDescribe } from './ExternalIdManager';
import type { SyncObjectConfig } from '@sandforge/shared';

function createConfig(overrides?: Partial<SyncObjectConfig>): SyncObjectConfig {
  return {
    objectApiName: 'Account',
    operation: 'upsert',
    fieldMappings: [],
    transformRules: [],
    excludedFields: [],
    addOnFields: [],
    batchSize: 200,
    insertOrder: 1,
    ...overrides,
  };
}

function createField(overrides?: Partial<FieldDescribe>): FieldDescribe {
  return {
    name: 'External_Id__c',
    type: 'string',
    externalId: true,
    unique: true,
    idLookup: true,
    ...overrides,
  };
}

function createDeps(fields: FieldDescribe[] = []): ExternalIdManagerDeps {
  return {
    describe: vi.fn().mockResolvedValue(fields),
  };
}

describe('ExternalIdManager', () => {
  let deps: ExternalIdManagerDeps;
  let manager: ExternalIdManager;

  beforeEach(() => {
    deps = createDeps();
    manager = new ExternalIdManager(deps);
  });

  describe('resolveExternalId', () => {
    it('should return configured externalIdField when set', () => {
      const config = createConfig({ externalIdField: 'External_Id__c' });
      expect(manager.resolveExternalId(config)).toBe('External_Id__c');
    });

    it('should return Id when externalIdField is not set', () => {
      const config = createConfig({ externalIdField: undefined });
      expect(manager.resolveExternalId(config)).toBe('Id');
    });

    it('should return Id when externalIdField is empty string', () => {
      const config = createConfig({ externalIdField: '' });
      expect(manager.resolveExternalId(config)).toBe('Id');
    });

    it('should handle custom external ID field names', () => {
      const config = createConfig({ externalIdField: 'Legacy_Id__c' });
      expect(manager.resolveExternalId(config)).toBe('Legacy_Id__c');
    });
  });

  describe('ensureExternalId', () => {
    it('should return true for Id field without querying', async () => {
      const result = await manager.ensureExternalId('org-1', 'Account', 'Id');

      expect(result).toBe(true);
      expect(deps.describe).not.toHaveBeenCalled();
    });

    it('should return true when field exists and is an external ID', async () => {
      deps = createDeps([createField({ name: 'External_Id__c', externalId: true })]);
      manager = new ExternalIdManager(deps);

      const result = await manager.ensureExternalId('org-1', 'Account', 'External_Id__c');

      expect(result).toBe(true);
    });

    it('should return true when field has idLookup even without externalId flag', async () => {
      deps = createDeps([
        createField({ name: 'Email', externalId: false, idLookup: true }),
      ]);
      manager = new ExternalIdManager(deps);

      const result = await manager.ensureExternalId('org-1', 'Contact', 'Email');

      expect(result).toBe(true);
    });

    it('should return false when field does not exist', async () => {
      deps = createDeps([createField({ name: 'Other_Field__c' })]);
      manager = new ExternalIdManager(deps);

      const result = await manager.ensureExternalId('org-1', 'Account', 'Missing__c');

      expect(result).toBe(false);
    });

    it('should return false when field exists but is not external ID or idLookup', async () => {
      deps = createDeps([
        createField({ name: 'Name', externalId: false, idLookup: false }),
      ]);
      manager = new ExternalIdManager(deps);

      const result = await manager.ensureExternalId('org-1', 'Account', 'Name');

      expect(result).toBe(false);
    });

    it('should call describe with correct org and object', async () => {
      deps = createDeps([createField()]);
      manager = new ExternalIdManager(deps);

      await manager.ensureExternalId('org-1', 'Contact', 'External_Id__c');

      expect(deps.describe).toHaveBeenCalledWith('org-1', 'Contact');
    });

    it('should handle empty fields list', async () => {
      deps = createDeps([]);
      manager = new ExternalIdManager(deps);

      const result = await manager.ensureExternalId('org-1', 'Account', 'Field__c');

      expect(result).toBe(false);
    });

    it('should match field name exactly', async () => {
      deps = createDeps([
        createField({ name: 'External_Id__c', externalId: true }),
        createField({ name: 'external_id__c', externalId: true }),
      ]);
      manager = new ExternalIdManager(deps);

      const result = await manager.ensureExternalId('org-1', 'Account', 'External_Id__c');

      expect(result).toBe(true);
    });

    it('should handle multiple fields and find the correct one', async () => {
      deps = createDeps([
        createField({ name: 'Name', externalId: false, idLookup: false }),
        createField({ name: 'Industry', externalId: false, idLookup: false }),
        createField({ name: 'ExtId__c', externalId: true, idLookup: true }),
      ]);
      manager = new ExternalIdManager(deps);

      const result = await manager.ensureExternalId('org-1', 'Account', 'ExtId__c');

      expect(result).toBe(true);
    });
  });
});
