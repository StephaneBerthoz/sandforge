import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataSync } from './DataSync';
import type { DataSyncDeps, OperationOutcome } from './DataSync';
import type { TargetFieldDescriptor } from './FieldTypeValidator';
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
    externalIdField: 'External_Id__c',
    ...overrides,
  };
}

function createDeps(overrides?: Partial<DataSyncDeps>): DataSyncDeps {
  const successOutcome: OperationOutcome = { id: '001', success: true, errors: [] };
  return {
    upsert: vi.fn().mockResolvedValue([successOutcome]),
    insert: vi.fn().mockResolvedValue([successOutcome]),
    update: vi.fn().mockResolvedValue([successOutcome]),
    delete: vi.fn().mockResolvedValue([successOutcome]),
    ...overrides,
  };
}

describe('DataSync', () => {
  let deps: DataSyncDeps;
  let dataSync: DataSync;

  beforeEach(() => {
    deps = createDeps();
    dataSync = new DataSync(deps);
  });

  describe('sync', () => {
    it('should call upsert for upsert operation', async () => {
      const config = createConfig({ operation: 'upsert' });
      const records = [{ Name: 'Acme', External_Id__c: 'EXT-001' }];

      await dataSync.sync(config, records);

      expect(deps.upsert).toHaveBeenCalledWith(
        'Account',
        'External_Id__c',
        expect.any(Array),
        200
      );
    });

    it('should call insert for insert operation', async () => {
      const config = createConfig({ operation: 'insert' });
      const records = [{ Name: 'Acme' }];

      await dataSync.sync(config, records);

      expect(deps.insert).toHaveBeenCalledWith('Account', expect.any(Array), 200);
    });

    it('should call update for update operation', async () => {
      const config = createConfig({ operation: 'update' });
      const records = [{ Id: '001', Name: 'Acme' }];

      await dataSync.sync(config, records);

      expect(deps.update).toHaveBeenCalledWith('Account', expect.any(Array), 200);
    });

    it('should call delete with record IDs for delete operation', async () => {
      const config = createConfig({ operation: 'delete' });
      const records = [{ Id: '001' }, { Id: '002' }];

      await dataSync.sync(config, records);

      expect(deps.delete).toHaveBeenCalledWith('Account', ['001', '002'], 200);
    });

    it('should apply field mappings before writing', async () => {
      const config = createConfig({
        operation: 'insert',
        fieldMappings: [
          { sourceField: 'Name', targetField: 'Account_Name__c', type: 'rename' },
        ],
      });
      const records = [{ Name: 'Acme' }];

      await dataSync.sync(config, records);

      expect(deps.insert).toHaveBeenCalledWith(
        'Account',
        [{ Account_Name__c: 'Acme' }],
        200
      );
    });

    it('should apply add-on fields', async () => {
      const config = createConfig({
        operation: 'insert',
        addOnFields: [
          { fieldApiName: 'Source__c', value: 'Migration', overwriteExisting: false },
        ],
      });
      const records = [{ Name: 'Acme' }];

      await dataSync.sync(config, records);

      const calledRecords = vi.mocked(deps.insert).mock.calls[0][1];
      expect(calledRecords[0]).toHaveProperty('Source__c', 'Migration');
    });

    it('should return success count from outcomes', async () => {
      const outcomes: OperationOutcome[] = [
        { id: '001', success: true, errors: [] },
        { id: '002', success: true, errors: [] },
      ];
      deps = createDeps({ insert: vi.fn().mockResolvedValue(outcomes) });
      dataSync = new DataSync(deps);

      const result = await dataSync.sync(
        createConfig({ operation: 'insert' }),
        [{ Name: 'A' }, { Name: 'B' }]
      );

      expect(result.success).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.processed).toBe(2);
    });

    it('should return failure count and errors from outcomes', async () => {
      const outcomes: OperationOutcome[] = [
        { id: '001', success: true, errors: [] },
        { success: false, errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION'] },
      ];
      deps = createDeps({ insert: vi.fn().mockResolvedValue(outcomes) });
      dataSync = new DataSync(deps);

      const result = await dataSync.sync(
        createConfig({ operation: 'insert' }),
        [{ Name: 'A' }, { Name: 'B' }]
      );

      expect(result.success).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.errors).toContain('FIELD_CUSTOM_VALIDATION_EXCEPTION');
    });

    it('should exclude fields with exclude mapping type', async () => {
      const config = createConfig({
        operation: 'insert',
        fieldMappings: [
          { sourceField: 'Name', targetField: 'Name', type: 'direct' },
          { sourceField: 'Secret', targetField: 'Secret', type: 'exclude' },
        ],
      });
      const records = [{ Name: 'Acme', Secret: 'hidden' }];

      await dataSync.sync(config, records);

      const calledRecords = vi.mocked(deps.insert).mock.calls[0][1];
      expect(calledRecords[0]).not.toHaveProperty('Secret');
    });

    it('should use Id as default external ID field for upsert when none specified', async () => {
      const config = createConfig({ operation: 'upsert', externalIdField: undefined });
      const records = [{ Name: 'Acme' }];

      await dataSync.sync(config, records);

      expect(deps.upsert).toHaveBeenCalledWith(
        'Account',
        'Id',
        expect.any(Array),
        200
      );
    });

    it('should pass through all records when no mappings defined', async () => {
      const config = createConfig({ operation: 'insert' });
      const records = [{ Name: 'Acme', Industry: 'Tech' }];

      await dataSync.sync(config, records);

      const calledRecords = vi.mocked(deps.insert).mock.calls[0][1];
      expect(calledRecords[0]).toEqual({ Name: 'Acme', Industry: 'Tech' });
    });

    it('should handle empty records array', async () => {
      deps = createDeps({ insert: vi.fn().mockResolvedValue([]) });
      dataSync = new DataSync(deps);

      const result = await dataSync.sync(
        createConfig({ operation: 'insert' }),
        []
      );

      expect(result.processed).toBe(0);
      expect(result.success).toBe(0);
      expect(result.failed).toBe(0);
    });

    it('should set objectApiName and operation on result', async () => {
      const result = await dataSync.sync(
        createConfig({ objectApiName: 'Contact', operation: 'update' }),
        [{ Id: '003', LastName: 'Smith' }]
      );

      expect(result.objectApiName).toBe('Contact');
      expect(result.operation).toBe('update');
    });
  });

  describe('field type validation', () => {
    it('should validate records against target field descriptors when provided', async () => {
      const targetFields: TargetFieldDescriptor[] = [
        { apiName: 'Name', type: 'string', maxLength: 5, required: true },
      ];
      deps = createDeps({ targetFieldDescriptors: targetFields });
      dataSync = new DataSync(deps);

      const result = await dataSync.sync(
        createConfig({ operation: 'insert' }),
        [{ Name: 'TooLongName' }]
      );

      expect(result.failed).toBe(1);
      expect(result.success).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('max length');
      // CRUD function should NOT have been called
      expect(deps.insert).not.toHaveBeenCalled();
    });

    it('should pass validation when records match target descriptors', async () => {
      const targetFields: TargetFieldDescriptor[] = [
        { apiName: 'Name', type: 'string', maxLength: 255 },
      ];
      deps = createDeps({ targetFieldDescriptors: targetFields });
      dataSync = new DataSync(deps);

      const result = await dataSync.sync(
        createConfig({ operation: 'insert' }),
        [{ Name: 'Acme' }]
      );

      expect(result.success).toBe(1);
      expect(result.failed).toBe(0);
      expect(deps.insert).toHaveBeenCalled();
    });

    it('should skip validation when no target descriptors provided', async () => {
      deps = createDeps();
      dataSync = new DataSync(deps);

      const result = await dataSync.sync(
        createConfig({ operation: 'insert' }),
        [{ Name: 'Acme' }]
      );

      expect(result.success).toBe(1);
      expect(deps.insert).toHaveBeenCalled();
    });

    it('should catch required field validation errors', async () => {
      const targetFields: TargetFieldDescriptor[] = [
        { apiName: 'Name', type: 'string', required: true },
      ];
      deps = createDeps({ targetFieldDescriptors: targetFields });
      dataSync = new DataSync(deps);

      const result = await dataSync.sync(
        createConfig({ operation: 'insert' }),
        [{ Name: '' }]
      );

      expect(result.failed).toBe(1);
      expect(result.errors[0]).toContain('Required field');
      expect(deps.insert).not.toHaveBeenCalled();
    });

    it('should validate boolean type mismatch', async () => {
      const targetFields: TargetFieldDescriptor[] = [
        { apiName: 'IsActive', type: 'boolean' },
      ];
      deps = createDeps({ targetFieldDescriptors: targetFields });
      dataSync = new DataSync(deps);

      const result = await dataSync.sync(
        createConfig({ operation: 'insert' }),
        [{ IsActive: 'yes' }]
      );

      expect(result.failed).toBe(1);
      expect(result.errors[0]).toContain('boolean');
      expect(deps.insert).not.toHaveBeenCalled();
    });
  });
});
