import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataSync, MAX_RESULT_REFUSALS_PER_OBJECT, buildObjectResult } from './DataSync';
import { targetWriteFieldsOf } from './targetWriteFields';
import type { DataSyncDeps, OperationOutcome } from './DataSync';
import { WriteCancelledError } from './WriteCancelledError';
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

    it('splits the records of an upsert into created and updated, as the org said', async () => {
      const outcomes: OperationOutcome[] = [
        { id: '001', success: true, errors: [], created: true },
        { id: '002', success: true, errors: [], created: false },
        { id: '003', success: true, errors: [], created: false },
        { success: false, errors: ['DUPLICATE_VALUE'] },
      ];
      deps = createDeps({ upsert: vi.fn().mockResolvedValue(outcomes) });
      dataSync = new DataSync(deps);

      const result = await dataSync.sync(createConfig({ operation: 'upsert' }), [
        { Name: 'A' },
        { Name: 'B' },
        { Name: 'C' },
        { Name: 'D' },
      ]);

      expect(result.upsertSplit).toEqual({ created: 1, updated: 2 });
      expect(result.success).toBe(3);
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

  // `Id` is never creatable, and a describe says so. Filtering on the
  // creatable fields alone sent an update or an upsert on `Id` without the id
  // that addresses it, and handed a delete no id at all: nothing was deleted
  // and the run reported nothing processed.
  it.each([
    ['update', undefined],
    ['upsert', 'Id'],
  ] as const)('keeps the Id a %s is addressed by', async (operation, externalIdField) => {
    const write = vi.fn().mockResolvedValue([{ id: '001SOURCE', success: true, errors: [] }]);
    const sync = new DataSync(
      createDeps({
        update: write,
        upsert: vi.fn((_object, _key, records) => write(_object, records)),
        describeTargetFields: async () => ({
          creatable: new Set(['Name']),
          references: new Set(),
        }),
      }),
    );

    await sync.sync(createConfig({ operation, externalIdField }), [
      { Id: '001SOURCE', Name: 'Acme', CreatedDate: '2026-01-01' },
    ]);

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][1]).toEqual([{ Id: '001SOURCE', Name: 'Acme' }]);
  });

  it('deletes the records it was given when the target is described', async () => {
    const del = vi.fn().mockResolvedValue([{ id: '001SOURCE', success: true, errors: [] }]);
    const sync = new DataSync(
      createDeps({
        delete: del,
        describeTargetFields: async () => ({
          creatable: new Set(['Name']),
          references: new Set(),
        }),
      }),
    );

    const result = await sync.sync(createConfig({ operation: 'delete' }), [{ Id: '001SOURCE' }]);

    expect(del).toHaveBeenCalledWith('Account', ['001SOURCE'], 200);
    expect(result.success).toBe(1);
  });

  it('keeps every field when nothing can describe the target', async () => {
    const insert = vi.fn().mockResolvedValue([{ id: '001', success: true, errors: [] }]);
    const sync = new DataSync(createDeps({ insert, describeTargetFields: undefined }));

    await sync.sync(createConfig({ operation: 'insert', externalIdField: undefined }), [
      { Name: 'Acme', CreatedDate: '2026-01-01' },
    ]);

    expect(Object.keys(insert.mock.calls[0][1][0]).sort()).toEqual(['CreatedDate', 'Name']);
  });

  // A describe that failed was read as "could not say": every row went as it
  // was read, every field of it, and the target refused each one.
  it('sends nothing, and refuses every record, when the target would not describe the object', async () => {
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
      [{ Name: 'Acme' }, { Name: 'Globex' }],
    );

    expect(insert).not.toHaveBeenCalled();
    expect(result.failed).toBe(2);
    expect(result.errors[0]).toContain(
      'The target org did not describe Account (no describe today), so what it takes could ' +
        'not be told and none of its records were sent.',
    );
  });

  it('sends nothing of an object the target has not, or that the user it writes as cannot see', async () => {
    const insert = vi.fn();
    const sync = new DataSync(
      createDeps({
        insert,
        describeTargetFields: async () => {
          throw Object.assign(new Error('The requested resource does not exist'), {
            errorCode: 'NOT_FOUND',
          });
        },
      }),
    );

    const result = await sync.sync(
      createConfig({
        objectApiName: 'Invoice__c',
        operation: 'insert',
        externalIdField: undefined,
      }),
      [{ Name: 'Invoice 0001' }],
    );

    expect(insert).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
    expect(result.errors[0]).toContain(
      'Object is not in the target org, or the user the run writes as cannot see it: Invoice__c.',
    );
  });

  it.each([
    ['insert', { objectCreateable: false, objectUpdateable: true }, 'not createable'],
    ['upsert', { objectCreateable: false, objectUpdateable: true }, 'not createable'],
    ['update', { objectCreateable: true, objectUpdateable: false }, 'not updateable'],
    ['upsert', { objectCreateable: true, objectUpdateable: false }, 'not updateable'],
  ] as const)(
    'sends nothing of an %s the user it writes as may not make (%o)',
    async (operation, access, said) => {
      const write = vi.fn();
      const sync = new DataSync(
        createDeps({
          insert: write,
          update: write,
          upsert: write,
          describeTargetFields: async () => ({
            creatable: new Set(['Subject']),
            references: new Set(),
            ...access,
          }),
        }),
      );

      const result = await sync.sync(
        createConfig({ objectApiName: 'Case', operation, externalIdField: 'Id' }),
        [{ Id: '500000000000001', Subject: 'Help' }],
      );

      expect(write).not.toHaveBeenCalled();
      expect(result.failed).toBe(1);
      expect(result.errors[0]).toContain(`Object is ${said} on target org`);
    },
  );
});

describe('DataSync — a lookup the target does not have', () => {
  const crossRef = {
    id: '',
    success: false,
    errors: ['insufficient access rights on cross-reference id: 003000000000042AAA'],
  };

  function describeWithLookup() {
    return async () => ({
      creatable: new Set(['Name', 'Key_Contact__c']),
      references: new Set(['Key_Contact__c']),
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
      [{ Name: 'Acme', Key_Contact__c: '003000000000042AAA' }],
    );

    expect(insert).toHaveBeenCalledTimes(2);
    // The second attempt carries the data and not the lookup.
    expect(Object.keys(insert.mock.calls[1][1][0])).toEqual(['Name']);
    expect(result.success).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('says which field it dropped, apart from the refusals: the record was written', async () => {
    const insert = vi
      .fn()
      .mockResolvedValueOnce([crossRef])
      .mockResolvedValueOnce([{ id: '001NEW', success: true, errors: [] }]);
    const sync = new DataSync(createDeps({ insert, describeTargetFields: describeWithLookup() }));

    const result = await sync.sync(
      createConfig({ operation: 'insert', externalIdField: undefined }),
      [{ Name: 'Acme', Key_Contact__c: '003000000000042AAA' }],
    );

    expect(result.lookupsLeftOut).toEqual([
      { records: 1, fields: ['Key_Contact__c'], reason: 'notInTarget' },
    ]);
    // Among the errors, the results listed it in red as a refused record.
    expect(result.errors).toEqual([]);
  });

  it.each([
    [
      'as a Developer Edition words it, without the hyphen',
      'INVALID_CROSS_REFERENCE_KEY: invalid cross reference id',
    ],
    [
      'by its code alone, in a French org',
      'INVALID_CROSS_REFERENCE_KEY: ID de référence croisée non valide',
    ],
    [
      'in French words, without a code',
      "droits d'accès insuffisants sur l'ID de référence croisée",
    ],
  ])(
    'writes the record again without the lookup when the refusal comes %s',
    async (_how, message) => {
      const insert = vi
        .fn()
        .mockResolvedValueOnce([{ id: '', success: false, errors: [message] }])
        .mockResolvedValueOnce([{ id: '001NEW', success: true, errors: [] }]);
      const sync = new DataSync(createDeps({ insert, describeTargetFields: describeWithLookup() }));

      const result = await sync.sync(
        createConfig({ operation: 'insert', externalIdField: undefined }),
        [{ Name: 'Acme', Key_Contact__c: '003000000000042AAA' }],
      );

      expect(insert).toHaveBeenCalledTimes(2);
      expect(Object.keys(insert.mock.calls[1][1][0])).toEqual(['Name']);
      expect(result.success).toBe(1);
    },
  );

  it('does not try again for a failure that is not a cross-reference', async () => {
    const insert = vi
      .fn()
      .mockResolvedValue([{ id: '', success: false, errors: ['REQUIRED_FIELD_MISSING: Name'] }]);
    const sync = new DataSync(createDeps({ insert, describeTargetFields: describeWithLookup() }));

    const result = await sync.sync(
      createConfig({ operation: 'insert', externalIdField: undefined }),
      [{ Name: 'Acme', Key_Contact__c: '003000000000042AAA' }],
    );

    expect(insert).toHaveBeenCalledTimes(1);
    expect(result.failed).toBe(1);
  });

  it('gives up after one retry', async () => {
    const insert = vi.fn().mockResolvedValue([crossRef]);
    const sync = new DataSync(createDeps({ insert, describeTargetFields: describeWithLookup() }));

    const result = await sync.sync(
      createConfig({ operation: 'insert', externalIdField: undefined }),
      [{ Name: 'Acme', Key_Contact__c: '003000000000042AAA' }],
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

  it('keeps what the first write wrote when the second try fails', async () => {
    // The second try only sends again rows the first refused. Failed whole —
    // the connection dropped — it was thrown on, and the object was reported
    // as one failure: the record the first write had put in the org was
    // counted nowhere.
    const insert = vi
      .fn()
      .mockResolvedValueOnce([crossRef, { id: '001KEPT', success: true, errors: [] }])
      .mockRejectedValueOnce(new Error('ECONNRESET'));
    const sync = new DataSync(createDeps({ insert, describeTargetFields: describeWithLookup() }));

    const result = await sync.sync(
      createConfig({ operation: 'insert', externalIdField: undefined }),
      [{ Name: 'Acme', Key_Contact__c: '003000000000042AAA' }, { Name: 'Globex' }],
    );

    expect(insert).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ processed: 2, success: 1, failed: 1 });
    expect(result.errors).toEqual([
      crossRef.errors[0],
      '1 record(s) the target refused for a lookup it does not have could not be written ' +
        'again without Key_Contact__c: ECONNRESET',
    ]);
  });

  it('answers each record as the first write left it when the second try fails', async () => {
    // Real-time replication reads the outcomes to say which change reached
    // the target: thrown on, the error left it none, the change written among
    // them.
    const insert = vi
      .fn()
      .mockResolvedValueOnce([crossRef, { id: '001KEPT', success: true, errors: [] }])
      .mockRejectedValueOnce(new Error('ECONNRESET'));
    const sync = new DataSync(createDeps({ insert, describeTargetFields: describeWithLookup() }));

    const { outcomes } = await sync.write(
      createConfig({ operation: 'insert', externalIdField: undefined }),
      [{ Name: 'Acme', Key_Contact__c: '003000000000042AAA' }, { Name: 'Globex' }],
    );

    expect(outcomes).toEqual([crossRef, { id: '001KEPT', success: true, errors: [] }]);
  });

  it('tells the run every record the write sent when the cancel stops the second try', async () => {
    // What the stopped retry names is the rows it tried again: passed on as
    // it was, the run counted those alone, not the record the first write
    // had already written.
    const insert = vi
      .fn()
      .mockResolvedValueOnce([crossRef, { id: '001KEPT', success: true, errors: [] }, crossRef])
      .mockRejectedValueOnce(
        new WriteCancelledError('Account', [{ id: '001AGAIN', success: true, errors: [] }]),
      );
    const sync = new DataSync(createDeps({ insert, describeTargetFields: describeWithLookup() }));

    const stopped = await sync
      .sync(createConfig({ operation: 'insert', externalIdField: undefined }), [
        { Name: 'Acme', Key_Contact__c: '003000000000042AAA' },
        { Name: 'Globex' },
        { Name: 'Initech', Key_Contact__c: '003000000000043AAA' },
      ])
      .then(
        () => undefined,
        (err: unknown) => err,
      );

    expect(stopped).toBeInstanceOf(WriteCancelledError);
    expect((stopped as WriteCancelledError).written).toEqual([
      { id: '001AGAIN', success: true, errors: [] },
      { id: '001KEPT', success: true, errors: [] },
      crossRef,
    ]);
  });

  it('says which field it dropped for the records it wrote again before a cancel stopped the second try', async () => {
    // Thrown on with the outcomes alone, the record written without its
    // lookup went into the org and nothing said which field it had lost.
    const insert = vi
      .fn()
      .mockResolvedValueOnce([crossRef, crossRef])
      .mockRejectedValueOnce(
        new WriteCancelledError('Account', [{ id: '001AGAIN', success: true, errors: [] }]),
      );
    const sync = new DataSync(createDeps({ insert, describeTargetFields: describeWithLookup() }));

    const stopped = await sync
      .sync(createConfig({ operation: 'insert', externalIdField: undefined }), [
        { Name: 'Acme', Key_Contact__c: '003000000000042AAA' },
        { Name: 'Initech', Key_Contact__c: '003000000000043AAA' },
      ])
      .then(
        () => undefined,
        (err: unknown) => err,
      );

    expect(stopped).toBeInstanceOf(WriteCancelledError);
    expect((stopped as WriteCancelledError).notes).toEqual([]);
    expect((stopped as WriteCancelledError).lookupsLeftOut).toEqual([
      { records: 1, fields: ['Key_Contact__c'], reason: 'notInTarget' },
    ]);
  });
});

describe('DataSync — a record type the running user cannot use', () => {
  /** Fake record type ids of the target org. */
  const CUSTOMER = '012Fk00000RtAbCIAV';
  const PARTNER = '012Fk00000RtDeFIAV';

  /** The target's Account, as the running user sees it: Partner exists and is closed to them. */
  function describeWithRecordTypes() {
    return async () =>
      targetWriteFieldsOf({
        fields: [
          { name: 'Name', createable: true, type: 'string' },
          { name: 'RecordTypeId', createable: true, type: 'reference' },
        ],
        recordTypeInfos: [
          {
            active: true,
            available: true,
            defaultRecordTypeMapping: true,
            developerName: 'Customer',
            master: false,
            name: 'Customer',
            recordTypeId: CUSTOMER,
            urls: {},
          },
          {
            active: true,
            available: false,
            defaultRecordTypeMapping: false,
            developerName: 'Partner',
            master: false,
            name: 'Partner',
            recordTypeId: PARTNER,
            urls: {},
          },
        ],
      });
  }

  /** An insert that writes every record it is given. */
  function writesAll() {
    return vi
      .fn()
      .mockImplementation(async (_o: string, records: unknown[]) =>
        records.map((_, i) => ({ id: `001NEW${i}`, success: true, errors: [] })),
      );
  }

  /** What the result says of the two Partner accounts it held back. */
  const HELD_TWO =
    'RECORD_TYPE_UNAVAILABLE: 2 Account records use record type Partner, which the running ' +
    'user cannot use in the target org. Give the running user access to record type Partner ' +
    'on Account, or map it to one they have. Held back, not sent.';

  it('holds back the records of a closed record type, as Forge holds them, and writes the others', async () => {
    // Written without it, an account took the running user's default record
    // type — a business account's for a person account — and nothing but
    // the record said so.
    const insert = writesAll();
    const sync = new DataSync(
      createDeps({ insert, describeTargetFields: describeWithRecordTypes() }),
    );

    const { outcomes, notes } = await sync.write(
      createConfig({ operation: 'insert', externalIdField: undefined }),
      [
        { Name: 'Acme', RecordTypeId: PARTNER },
        { Name: 'Globex', RecordTypeId: CUSTOMER },
        { Name: 'Initech', RecordTypeId: PARTNER },
      ],
    );

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0][1]).toEqual([{ Name: 'Globex', RecordTypeId: CUSTOMER }]);
    expect(outcomes.map((o) => [o.success, o.heldBack === true])).toEqual([
      [false, true],
      [true, false],
      [false, true],
    ]);
    expect(outcomes[0].errors[0]).toMatch(/^RECORD_TYPE_UNAVAILABLE: record type Partner/);
    expect(notes).toEqual([HELD_TWO]);
  });

  it('counts the records held back as failed, and says why once, with how many', async () => {
    const insert = writesAll();
    const sync = new DataSync(
      createDeps({ insert, describeTargetFields: describeWithRecordTypes() }),
    );

    const result = await sync.sync(
      createConfig({ operation: 'insert', externalIdField: undefined }),
      [
        { Name: 'Acme', RecordTypeId: PARTNER },
        { Name: 'Initech', RecordTypeId: PARTNER },
      ],
    );

    expect(insert).not.toHaveBeenCalled();
    expect(result).toMatchObject({ processed: 2, success: 0, failed: 2 });
    expect(result.errors).toEqual([HELD_TWO]);
  });

  it('says what it held back with the records written before a cancel stopped the write', async () => {
    // A cancel between two batches stops the write after the records before
    // it went in. Thrown on with those alone, the run would have counted them
    // and never said which records it had kept back.
    const insert = vi
      .fn()
      .mockRejectedValue(
        new WriteCancelledError('Account', [{ id: '001NEW0', success: true, errors: [] }]),
      );
    const sync = new DataSync(
      createDeps({ insert, describeTargetFields: describeWithRecordTypes() }),
    );

    const stopped = await sync
      .sync(createConfig({ operation: 'insert', externalIdField: undefined }), [
        { Name: 'Acme', RecordTypeId: PARTNER },
        { Name: 'Globex', RecordTypeId: CUSTOMER },
        { Name: 'Hooli', RecordTypeId: CUSTOMER },
      ])
      .then(
        () => undefined,
        (err: unknown) => err,
      );

    expect(stopped).toBeInstanceOf(WriteCancelledError);
    // Acme was held, Globex written, Hooli never reached.
    expect((stopped as WriteCancelledError).written.map((o) => o.success)).toEqual([false, true]);
    expect((stopped as WriteCancelledError).notes).toEqual([
      expect.stringMatching(/^RECORD_TYPE_UNAVAILABLE: 1 Account record uses record type Partner/),
    ]);
  });

  it('keeps what it held back said, and the lookup it dropped, when a cancel stops the second try', async () => {
    const insert = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: '',
          success: false,
          errors: ['insufficient access rights on cross-reference id: 003000000000042AAA'],
        },
      ])
      .mockRejectedValueOnce(
        new WriteCancelledError('Account', [{ id: '001NEW0', success: true, errors: [] }]),
      );
    const sync = new DataSync(
      createDeps({
        insert,
        describeTargetFields: async () => ({
          ...(await describeWithRecordTypes()()),
          creatable: new Set(['Name', 'RecordTypeId', 'Key_Contact__c']),
          references: new Set(['RecordTypeId', 'Key_Contact__c']),
        }),
      }),
    );

    const stopped = await sync
      .sync(createConfig({ operation: 'insert', externalIdField: undefined }), [
        { Name: 'Acme', RecordTypeId: PARTNER },
        { Name: 'Globex', RecordTypeId: CUSTOMER, Key_Contact__c: '003000000000042AAA' },
      ])
      .then(
        () => undefined,
        (err: unknown) => err,
      );

    expect(stopped).toBeInstanceOf(WriteCancelledError);
    expect((stopped as WriteCancelledError).written.map((o) => o.id ?? '')).toEqual([
      '',
      '001NEW0',
    ]);
    // The record type the user may use went with the row tried again: only
    // the lookup the target does not have was dropped.
    expect(insert.mock.calls[1][1]).toEqual([{ Name: 'Globex', RecordTypeId: CUSTOMER }]);
    expect((stopped as WriteCancelledError).notes).toEqual([
      expect.stringMatching(/^RECORD_TYPE_UNAVAILABLE: 1 Account record uses record type Partner/),
    ]);
    expect((stopped as WriteCancelledError).lookupsLeftOut).toEqual([
      { records: 1, fields: ['Key_Contact__c'], reason: 'notInTarget' },
    ]);
  });

  it('keeps what it held back said when the second try fails', async () => {
    const insert = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: '',
          success: false,
          errors: ['insufficient access rights on cross-reference id: 003000000000042AAA'],
        },
      ])
      .mockRejectedValueOnce(new Error('REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.'));
    const sync = new DataSync(
      createDeps({
        insert,
        describeTargetFields: async () => ({
          ...(await describeWithRecordTypes()()),
          creatable: new Set(['Name', 'RecordTypeId', 'Key_Contact__c']),
          references: new Set(['Key_Contact__c']),
        }),
      }),
    );

    const result = await sync.sync(
      createConfig({ operation: 'insert', externalIdField: undefined }),
      [
        { Name: 'Acme', RecordTypeId: PARTNER },
        { Name: 'Globex', RecordTypeId: CUSTOMER, Key_Contact__c: '003000000000042AAA' },
      ],
    );

    expect(result).toMatchObject({ processed: 2, success: 0, failed: 2 });
    expect(result.errors).toEqual([
      'insufficient access rights on cross-reference id: 003000000000042AAA',
      expect.stringMatching(/^RECORD_TYPE_UNAVAILABLE: 1 Account record uses record type Partner/),
      '1 record(s) the target refused for a lookup it does not have could not be written ' +
        'again without Key_Contact__c: REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.',
    ]);
  });

  it('sends the record type as it is when the running user may use it', async () => {
    const insert = vi.fn().mockResolvedValue([{ id: '001NEW0', success: true, errors: [] }]);
    const sync = new DataSync(
      createDeps({ insert, describeTargetFields: describeWithRecordTypes() }),
    );

    const result = await sync.sync(
      createConfig({ operation: 'insert', externalIdField: undefined }),
      [{ Name: 'Globex', RecordTypeId: CUSTOMER }],
    );

    expect(insert.mock.calls[0][1]).toEqual([{ Name: 'Globex', RecordTypeId: CUSTOMER }]);
    expect(result.errors).toEqual([]);
  });
});

describe('buildObjectResult', () => {
  /** A record refused by the same validation rule. */
  const refused = (): OperationOutcome => ({
    success: false,
    errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: Phone must be written +33. [Phone]'],
  });

  it('keeps the refusals of the first thousand records refused and counts the others', () => {
    // A rule refusing every record of a large object posted one line per
    // record, uncapped, into the page and into the run's history.
    const outcomes = Array.from({ length: MAX_RESULT_REFUSALS_PER_OBJECT + 250 }, refused);

    const result = buildObjectResult('Contact', 'insert', outcomes, ['A note of the run.']);

    expect(result.failed).toBe(MAX_RESULT_REFUSALS_PER_OBJECT + 250);
    expect(result.errors).toHaveLength(MAX_RESULT_REFUSALS_PER_OBJECT + 1);
    expect(result.errors.at(-1)).toBe('A note of the run.');
    expect(result.refusalsDropped).toBe(250);
  });

  it('says nothing was left out when every refusal fits', () => {
    const result = buildObjectResult('Contact', 'insert', [refused(), refused()]);

    expect(result.errors).toHaveLength(2);
    expect(result).not.toHaveProperty('refusalsDropped');
  });
});
