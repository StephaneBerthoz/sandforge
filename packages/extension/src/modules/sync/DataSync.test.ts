import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataSync } from './DataSync';
import type { DataSyncDeps, OperationOutcome } from './DataSync';
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

      expect(deps.upsert).toHaveBeenCalledWith('Account', 'External_Id__c', expect.any(Array), 200);
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
        fieldMappings: [{ sourceField: 'Name', targetField: 'Account_Name__c', type: 'rename' }],
      });
      const records = [{ Name: 'Acme' }];

      await dataSync.sync(config, records);

      expect(deps.insert).toHaveBeenCalledWith('Account', [{ Account_Name__c: 'Acme' }], 200);
    });

    it('should apply add-on fields', async () => {
      const config = createConfig({
        operation: 'insert',
        addOnFields: [{ fieldApiName: 'Source__c', value: 'Migration', overwriteExisting: false }],
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

      const result = await dataSync.sync(createConfig({ operation: 'insert' }), [
        { Name: 'A' },
        { Name: 'B' },
      ]);

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

      const result = await dataSync.sync(createConfig({ operation: 'insert' }), [
        { Name: 'A' },
        { Name: 'B' },
      ]);

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

      expect(deps.upsert).toHaveBeenCalledWith('Account', 'Id', expect.any(Array), 200);
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

      const result = await dataSync.sync(createConfig({ operation: 'insert' }), []);

      expect(result.processed).toBe(0);
      expect(result.success).toBe(0);
      expect(result.failed).toBe(0);
    });

    it('should set objectApiName and operation on result', async () => {
      const result = await dataSync.sync(
        createConfig({ objectApiName: 'Contact', operation: 'update' }),
        [{ Id: '003', LastName: 'Smith' }],
      );

      expect(result.objectApiName).toBe('Contact');
      expect(result.operation).toBe('update');
    });
  });
});

describe('DataSync — what the target will take', () => {
  it('sends only the fields the target accepts when no mapping says otherwise', async () => {
    // `SELECT FIELDS(ALL)` returns the audit fields, the compound address
    // fields and every formula the object carries. Sent, Salesforce refuses
    // the whole record — which is every record of every object.
    const insert = vi.fn().mockResolvedValue([{ id: '001', success: true, errors: [] }]);
    const sync = new DataSync(
      createDeps({
        insert,
        describeTargetFields: async () => ({
          creatable: new Set(['Name', 'BillingCity']),
          references: new Set(),
        }),
      }),
    );

    await sync.sync(createConfig({ operation: 'insert', externalIdField: undefined }), [
      {
        attributes: { type: 'Account' },
        Id: '001SOURCE',
        Name: 'Acme',
        BillingCity: 'Lyon',
        CreatedDate: '2026-01-01',
        SystemModstamp: '2026-01-01',
        BillingAddress: { city: 'Lyon' },
      },
    ]);

    expect(insert).toHaveBeenCalledTimes(1);
    expect(Object.keys(insert.mock.calls[0][1][0]).sort()).toEqual(['BillingCity', 'Name']);
  });

  it('keeps every field when nothing can describe the target', async () => {
    const insert = vi.fn().mockResolvedValue([{ id: '001', success: true, errors: [] }]);
    const sync = new DataSync(createDeps({ insert, describeTargetFields: undefined }));

    await sync.sync(createConfig({ operation: 'insert', externalIdField: undefined }), [
      { Name: 'Acme', CreatedDate: '2026-01-01' },
    ]);

    expect(Object.keys(insert.mock.calls[0][1][0]).sort()).toEqual(['CreatedDate', 'Name']);
  });

  it('carries on when the describe fails', async () => {
    const insert = vi.fn().mockResolvedValue([{ id: '001', success: true, errors: [] }]);
    const sync = new DataSync(
      createDeps({
        insert,
        describeTargetFields: async () => {
          throw new Error('no describe today');
        },
      }),
    );

    const result = await sync.sync(
      createConfig({ operation: 'insert', externalIdField: undefined }),
      [{ Name: 'Acme' }],
    );

    expect(result.success).toBe(1);
  });
});

describe('DataSync — a lookup the target does not have', () => {
  const crossRef = {
    id: '',
    success: false,
    errors: ['insufficient access rights on cross-reference id: 003AP00001VjQOS'],
  };

  function describeWithLookup() {
    return async () => ({
      creatable: new Set(['Name', 'ACC_ContactCle__c']),
      references: new Set(['ACC_ContactCle__c']),
    });
  }

  it('writes the record again without the lookup rather than losing it', async () => {
    const insert = vi
      .fn()
      .mockResolvedValueOnce([crossRef])
      .mockResolvedValueOnce([{ id: '001NEW', success: true, errors: [] }]);
    const sync = new DataSync(createDeps({ insert, describeTargetFields: describeWithLookup() }));

    const result = await sync.sync(
      createConfig({ operation: 'insert', externalIdField: undefined }),
      [{ Name: 'Acme', ACC_ContactCle__c: '003AP00001VjQOS' }],
    );

    expect(insert).toHaveBeenCalledTimes(2);
    // The second attempt carries the data and not the lookup.
    expect(Object.keys(insert.mock.calls[1][1][0])).toEqual(['Name']);
    expect(result.success).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('says which field it dropped', async () => {
    const insert = vi
      .fn()
      .mockResolvedValueOnce([crossRef])
      .mockResolvedValueOnce([{ id: '001NEW', success: true, errors: [] }]);
    const sync = new DataSync(createDeps({ insert, describeTargetFields: describeWithLookup() }));

    const result = await sync.sync(
      createConfig({ operation: 'insert', externalIdField: undefined }),
      [{ Name: 'Acme', ACC_ContactCle__c: '003AP00001VjQOS' }],
    );

    expect(result.errors.join(' ')).toContain('ACC_ContactCle__c');
  });

  it('does not try again for a failure that is not a cross-reference', async () => {
    const insert = vi
      .fn()
      .mockResolvedValue([{ id: '', success: false, errors: ['REQUIRED_FIELD_MISSING: Name'] }]);
    const sync = new DataSync(createDeps({ insert, describeTargetFields: describeWithLookup() }));

    const result = await sync.sync(
      createConfig({ operation: 'insert', externalIdField: undefined }),
      [{ Name: 'Acme', ACC_ContactCle__c: '003AP00001VjQOS' }],
    );

    expect(insert).toHaveBeenCalledTimes(1);
    expect(result.failed).toBe(1);
  });

  it('gives up after one retry', async () => {
    const insert = vi.fn().mockResolvedValue([crossRef]);
    const sync = new DataSync(createDeps({ insert, describeTargetFields: describeWithLookup() }));

    const result = await sync.sync(
      createConfig({ operation: 'insert', externalIdField: undefined }),
      [{ Name: 'Acme', ACC_ContactCle__c: '003AP00001VjQOS' }],
    );

    expect(insert).toHaveBeenCalledTimes(2);
    expect(result.failed).toBe(1);
  });

  it('leaves a record alone when it carries no lookup value', async () => {
    const insert = vi.fn().mockResolvedValue([crossRef]);
    const sync = new DataSync(createDeps({ insert, describeTargetFields: describeWithLookup() }));

    await sync.sync(createConfig({ operation: 'insert', externalIdField: undefined }), [
      { Name: 'Acme' },
    ]);

    // Nothing to strip means nothing to try again.
    expect(insert).toHaveBeenCalledTimes(1);
  });
});
