import type { Connection } from 'jsforce';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncOrchestrator } from './SyncOrchestrator';
import { SyncRunFailure } from './SyncRunFailure';
import { WriteCancelledError } from './WriteCancelledError';
import { BulkDataWriter } from './BulkDataWriter';
import { BulkApiExecutor } from '../../core/engine/BulkApiExecutor';
import { BulkApiManager } from '../../core/engine/BulkApiManager';
import { DataSync, type OperationOutcome } from './DataSync';
import { targetWriteFieldsOf } from './targetWriteFields';
import { FieldMappingService } from './FieldMapping';
import { TransformPipeline } from './TransformPipeline';
import type { SyncGrappeEvent, SyncOrchestratorDeps } from './SyncOrchestrator';
import { DEFAULT_GRAPPE_CONFIG } from '@sandforge/shared';
import type { SyncConfig, SyncObjectConfig, SyncObjectResult } from '@sandforge/shared';

function createObjectConfig(overrides?: Partial<SyncObjectConfig>): SyncObjectConfig {
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

function createConfig(overrides?: Partial<SyncConfig>): SyncConfig {
  return {
    id: 'config-1',
    name: 'Test Sync',
    description: '',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    direction: 'source_to_target',
    mode: 'full',
    objects: [createObjectConfig()],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function createSuccessResult(objectName = 'Account'): SyncObjectResult {
  return {
    objectApiName: objectName,
    operation: 'upsert',
    processed: 1,
    success: 1,
    failed: 0,
    skipped: 0,
    conflictCount: 0,
    errors: [],
  };
}

function createMockDeps(): SyncOrchestratorDeps {
  return {
    dataSync: {
      sync: vi.fn().mockResolvedValue(createSuccessResult()),
    } as unknown as SyncOrchestratorDeps['dataSync'],
    metadataSync: {
      sync: vi.fn().mockResolvedValue(createSuccessResult('Metadata')),
    } as unknown as SyncOrchestratorDeps['metadataSync'],
    conflictResolver: {
      detectConflicts: vi.fn().mockReturnValue([]),
      resolve: vi.fn().mockReturnValue([]),
    } as unknown as SyncOrchestratorDeps['conflictResolver'],
    fieldMapping: {
      apply: vi.fn().mockImplementation((record: Record<string, unknown>) => ({ ...record })),
      applyAddOns: vi.fn().mockImplementation((record: Record<string, unknown>) => ({ ...record })),
    } as unknown as SyncOrchestratorDeps['fieldMapping'],
    transformPipeline: {
      transformRecord: vi
        .fn()
        .mockImplementation((record: Record<string, unknown>) => ({ ...record })),
    } as unknown as SyncOrchestratorDeps['transformPipeline'],
    incrementalTracker: {
      getLastSync: vi.fn().mockReturnValue(undefined),
      recordSync: vi.fn(),
      reset: vi.fn(),
    } as unknown as SyncOrchestratorDeps['incrementalTracker'],
    querySource: vi.fn().mockResolvedValue([{ Id: '001', Name: 'Acme' }]),
    queryTarget: vi.fn().mockResolvedValue([]),
  };
}

describe('SyncOrchestrator', () => {
  let deps: SyncOrchestratorDeps;
  let orchestrator: SyncOrchestrator;

  beforeEach(() => {
    deps = createMockDeps();
    orchestrator = new SyncOrchestrator(deps);
  });

  describe('execute', () => {
    it('should query source records for each object', async () => {
      await orchestrator.execute(createConfig());

      expect(deps.querySource).toHaveBeenCalledWith(
        'src-org',
        expect.objectContaining({
          objectApiName: 'Account',
        }),
      );
    });

    it('should apply field mappings to source records', async () => {
      await orchestrator.execute(createConfig());

      expect(deps.fieldMapping.apply).toHaveBeenCalled();
    });

    it('should apply transform pipeline to mapped records', async () => {
      await orchestrator.execute(createConfig());

      expect(deps.transformPipeline.transformRecord).toHaveBeenCalled();
    });

    it('should apply add-on fields', async () => {
      await orchestrator.execute(createConfig());

      expect(deps.fieldMapping.applyAddOns).toHaveBeenCalled();
    });

    it('should call dataSync.sync with the processed records', async () => {
      await orchestrator.execute(createConfig());

      expect(deps.dataSync.sync).toHaveBeenCalled();
    });

    it('should ignore script fields left in an old config', async () => {
      const config = {
        ...createConfig(),
        preScript: 'Database.delete([SELECT Id FROM Account]);',
        postScript: 'System.debug("post");',
      } as unknown as SyncConfig;

      const result = await orchestrator.execute(config);

      expect(result.status).toBe('success');
      expect(deps.dataSync.sync).toHaveBeenCalled();
    });

    it('should process objects in insertOrder', async () => {
      const config = createConfig({
        objects: [
          createObjectConfig({ objectApiName: 'Contact', insertOrder: 2 }),
          createObjectConfig({ objectApiName: 'Account', insertOrder: 1 }),
        ],
      });

      await orchestrator.execute(config);

      const calls = vi.mocked(deps.querySource).mock.calls;
      expect(calls[0][1].objectApiName).toBe('Account');
      expect(calls[1][1].objectApiName).toBe('Contact');
    });

    it('should record sync timestamps for each object', async () => {
      await orchestrator.execute(createConfig());

      expect(deps.incrementalTracker.recordSync).toHaveBeenCalledWith(
        'config-1',
        'Account',
        expect.any(String),
      );
    });

    it('should return success status when all objects sync successfully', async () => {
      const result = await orchestrator.execute(createConfig());

      expect(result.status).toBe('success');
      expect(result.configId).toBe('config-1');
    });

    it('should return partial status when some objects have failures', async () => {
      vi.mocked(deps.dataSync.sync).mockResolvedValue({
        objectApiName: 'Account',
        operation: 'upsert',
        processed: 2,
        success: 1,
        failed: 1,
        skipped: 0,
        conflictCount: 0,
        errors: ['Error on record 2'],
      });

      const result = await orchestrator.execute(createConfig());

      expect(result.status).toBe('partial');
    });

    it('should detect and resolve conflicts in bidirectional mode', async () => {
      const config = createConfig({ direction: 'bidirectional' });

      await orchestrator.execute(config);

      expect(deps.queryTarget).toHaveBeenCalled();
      expect(deps.conflictResolver.detectConflicts).toHaveBeenCalled();
    });

    it('should skip conflict detection for source_to_target direction', async () => {
      const config = createConfig({ direction: 'source_to_target' });

      await orchestrator.execute(config);

      expect(deps.conflictResolver.detectConflicts).not.toHaveBeenCalled();
    });

    it('should handle empty source records gracefully', async () => {
      vi.mocked(deps.querySource).mockResolvedValue([]);

      const result = await orchestrator.execute(createConfig());

      expect(result.totalProcessed).toBe(0);
      expect(deps.dataSync.sync).not.toHaveBeenCalled();
    });
  });

  describe('every run writes', () => {
    it('offers no simulated entry point that could report a run it never performed', () => {
      expect((orchestrator as unknown as Record<string, unknown>).dryRun).toBeUndefined();
    });

    it('reaches the writer on the only path there is', async () => {
      await orchestrator.execute(createConfig());

      expect(deps.dataSync.sync).toHaveBeenCalled();
    });
  });

  describe('grappe activation', () => {
    const twoObjects = (): SyncConfig =>
      createConfig({
        objects: [
          createObjectConfig({ objectApiName: 'Account', insertOrder: 1 }),
          createObjectConfig({ objectApiName: 'Contact', insertOrder: 2 }),
        ],
      });

    function withGrappe(countPerObject: () => Promise<number>): SyncGrappeEvent[] {
      const events: SyncGrappeEvent[] = [];
      deps.grappeConfig = {
        ...DEFAULT_GRAPPE_CONFIG,
        enabled: true,
        autoActivateThreshold: 10_000,
      };
      deps.onGrappeEvent = (event) => events.push(event);
      deps.countSource = vi.fn(countPerObject);
      orchestrator = new SyncOrchestrator(deps);
      return events;
    }

    it('stays sequential and silent below autoActivateThreshold', async () => {
      const events = withGrappe(async () => 50);

      const result = await orchestrator.execute(twoObjects());

      expect(deps.countSource).toHaveBeenCalledTimes(2);
      expect(events).toEqual([]);
      expect(deps.dataSync.sync).toHaveBeenCalledTimes(2);
      expect(result.status).toBe('success');
    });

    it('reports one partition per object at the threshold, under the run operationId', async () => {
      const events = withGrappe(async () => 5_000);

      const result = await orchestrator.execute(twoObjects());

      expect(events.map((event) => event.type)).toEqual([
        'grappe:started',
        'grappe:partitionProgress',
        'grappe:partitionProgress',
        'grappe:completed',
      ]);
      expect(events[0].payload).toMatchObject({
        operationId: result.operationId,
        totalPartitions: 2,
        totalRecords: 10_000,
      });
      expect(events[3].payload).toMatchObject({ operationId: result.operationId });
    });

    it('stays silent when the source counts cannot be read, and still writes', async () => {
      const events = withGrappe(async () => {
        throw new Error('INVALID_TYPE');
      });

      const result = await orchestrator.execute(twoObjects());

      expect(events).toEqual([]);
      expect(deps.dataSync.sync).toHaveBeenCalledTimes(2);
      expect(result.status).toBe('success');
    });

    it('counts nothing while grappe is off', async () => {
      deps.countSource = vi.fn(async () => 1_000_000);
      deps.onGrappeEvent = vi.fn();
      orchestrator = new SyncOrchestrator(deps);

      await orchestrator.execute(twoObjects());

      expect(deps.countSource).not.toHaveBeenCalled();
      expect(deps.onGrappeEvent).not.toHaveBeenCalled();
    });
  });
});

describe('a run that fails partway reports what it wrote', () => {
  it('carries the finished objects and the real duration on the failure', async () => {
    // The objects already written used to be discarded: a run that copied one
    // object and then failed on the next was stored as "failure, 0 objects,
    // 0 ms", indistinguishable from one that never started.
    const deps = createMockDeps();
    deps.querySource = vi
      .fn()
      .mockResolvedValueOnce([{ Name: 'Acme' }])
      .mockRejectedValueOnce(new Error('target session expired'));
    deps.dataSync = {
      sync: vi.fn().mockResolvedValue(createSuccessResult('Account')),
    } as unknown as SyncOrchestratorDeps['dataSync'];
    const orchestrator = new SyncOrchestrator(deps);

    const config = createConfig({
      objects: [
        createObjectConfig({ objectApiName: 'Account', insertOrder: 0 }),
        createObjectConfig({ objectApiName: 'Contact', insertOrder: 1 }),
      ],
    });

    const failure = await orchestrator.execute(config).then(
      () => undefined,
      (err: unknown) => err as SyncRunFailure,
    );

    expect(failure).toBeInstanceOf(SyncRunFailure);
    expect(failure?.message).toBe('target session expired');
    expect(failure?.result.status).toBe('failure');
    expect(failure?.result.objectResults.map((r) => r.objectApiName)).toEqual([
      'Account',
      'Contact',
    ]);
    // The object that failed carries the reason, and the one before it its counts.
    expect(failure?.result.objectResults[1].errors).toEqual(['target session expired']);
    expect(failure?.result.totalSuccess).toBe(1);
  });

  it('counts what an object wrote when the try again without a lookup fails', async () => {
    // The first write put one record in the org and was refused the other
    // for a lookup the target does not have; sending that one again failed
    // whole. Reported as "failed: 1" with the error, the object said nothing
    // of the record in the org, and the run stopped there.
    const write = vi
      .fn<(...args: unknown[]) => Promise<OperationOutcome[]>>()
      .mockResolvedValueOnce([
        { id: '001000000000001AAA', success: true, errors: [] },
        {
          success: false,
          errors: ['insufficient access rights on cross-reference id: 003000000000042AAA'],
        },
      ])
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValue([{ id: '003000000000001AAA', success: true, errors: [] }]);
    const deps = createMockDeps();
    deps.dataSync = new DataSync({
      insert: write,
      upsert: write,
      update: write,
      delete: write,
      describeTargetFields: async () => ({
        creatable: new Set(['Name', 'LastName', 'Key_Contact__c']),
        references: new Set(['Key_Contact__c']),
      }),
    });
    deps.querySource = vi
      .fn()
      .mockResolvedValueOnce([
        { Name: 'Acme' },
        { Name: 'Globex', Key_Contact__c: '003000000000042AAA' },
      ])
      .mockResolvedValueOnce([{ LastName: 'Doe' }]);

    const result = await new SyncOrchestrator(deps).execute(
      createConfig({
        objects: [
          createObjectConfig({ objectApiName: 'Account', operation: 'insert', insertOrder: 0 }),
          createObjectConfig({ objectApiName: 'Contact', operation: 'insert', insertOrder: 1 }),
        ],
      }),
    );

    expect(result.objectResults).toEqual([
      expect.objectContaining({
        objectApiName: 'Account',
        processed: 2,
        success: 1,
        failed: 1,
        errors: [
          'insufficient access rights on cross-reference id: 003000000000042AAA',
          '1 record(s) the target refused for a lookup it does not have could not be written ' +
            'again without Key_Contact__c: ECONNRESET',
        ],
      }),
      expect.objectContaining({ objectApiName: 'Contact', success: 1, failed: 0 }),
    ]);
    expect(result.totalSuccess).toBe(2);
  });
});

describe('a mapped sync writes each mapping once', () => {
  it('writes a renamed, a constant and a formula field with their values', async () => {
    // The orchestrator maps each record, then DataSync mapped it again by
    // source field name — on a record that already holds target names. The
    // second pass found nothing under `Legacy_Code__c`, `FIXED` or the
    // formula, and the three fields were written empty.
    const written: Array<Record<string, unknown>> = [];
    const insert = vi.fn(async (_object: string, records: Array<Record<string, unknown>>) => {
      written.push(...records);
      return records.map(() => ({ success: true, errors: [] }));
    });
    const deps: SyncOrchestratorDeps = {
      ...createMockDeps(),
      dataSync: new DataSync({ insert, upsert: vi.fn(), update: vi.fn(), delete: vi.fn() }),
      fieldMapping: new FieldMappingService(),
      transformPipeline: new TransformPipeline(),
      querySource: vi
        .fn()
        .mockResolvedValue([
          { Id: '003000000000001', FirstName: 'Ann', LastName: 'Lee', Legacy_Code__c: 'A1' },
        ]),
    };
    const config = createConfig({
      objects: [
        createObjectConfig({
          objectApiName: 'Contact',
          operation: 'insert',
          fieldMappings: [
            { sourceField: 'LastName', targetField: 'LastName', type: 'direct' },
            { sourceField: 'Legacy_Code__c', targetField: 'Code__c', type: 'rename' },
            { sourceField: 'FIXED', targetField: 'Source__c', type: 'constant' },
            { sourceField: '{FirstName} {LastName}', targetField: 'Full__c', type: 'formula' },
          ],
          addOnFields: [{ fieldApiName: 'Batch__c', value: 'nightly', overwriteExisting: true }],
        }),
      ],
    });

    const result = await new SyncOrchestrator(deps).execute(config);

    expect(result.status).toBe('success');
    expect(written).toEqual([
      {
        LastName: 'Lee',
        Code__c: 'A1',
        Source__c: 'FIXED',
        Full__c: 'Ann Lee',
        Batch__c: 'nightly',
      },
    ]);
  });
});

describe('a cancel stops the run before what it has not reached', () => {
  /** Account, then Contact, then Opportunity. */
  const threeObjects = (): SyncConfig =>
    createConfig({
      objects: [
        createObjectConfig({ objectApiName: 'Account', insertOrder: 0 }),
        createObjectConfig({ objectApiName: 'Contact', insertOrder: 1 }),
        createObjectConfig({ objectApiName: 'Opportunity', insertOrder: 2 }),
      ],
    });

  it('syncs no object after the cancel, and answers with the ones it reached', async () => {
    // Nothing but an upload of more than ten thousand records looked at the
    // cancel: the two objects after it were read and written all the same.
    const stop = new AbortController();
    const deps = createMockDeps();
    deps.signal = stop.signal;
    deps.dataSync = {
      sync: vi.fn(async (objectConfig: SyncObjectConfig) => {
        stop.abort();
        return createSuccessResult(objectConfig.objectApiName);
      }),
    } as unknown as SyncOrchestratorDeps['dataSync'];

    const result = await new SyncOrchestrator(deps).execute(threeObjects());

    expect(deps.querySource).toHaveBeenCalledTimes(1);
    expect(deps.dataSync.sync).toHaveBeenCalledTimes(1);
    expect(result.cancelled).toBe(true);
    expect(result.objectResults.map((r) => r.objectApiName)).toEqual(['Account']);
    expect(result.totalSuccess).toBe(1);
    // The object it reached succeeded, and the run is still not a success.
    expect(result.status).toBe('partial');
    expect(result.error).toBe('Cancelled before Contact, Opportunity were synced.');
    // Nothing is marked synced: the next run reads again what this one skipped.
    expect(deps.incrementalTracker.recordSync).not.toHaveBeenCalled();
  });

  it('writes nothing of an object the cancel came while it was being read', async () => {
    const stop = new AbortController();
    const deps = createMockDeps();
    deps.signal = stop.signal;
    deps.querySource = vi.fn(async () => {
      stop.abort();
      return [{ Id: '001', Name: 'Acme' }];
    });

    const result = await new SyncOrchestrator(deps).execute(createConfig());

    expect(deps.dataSync.sync).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      cancelled: true,
      status: 'partial',
      objectResults: [],
      totalProcessed: 0,
      error: 'Cancelled before Account was synced.',
    });
  });

  it('keeps the failure of a run whose every object it reached failed', async () => {
    const stop = new AbortController();
    const deps = createMockDeps();
    deps.signal = stop.signal;
    deps.dataSync = {
      sync: vi.fn(async () => {
        stop.abort();
        return { ...createSuccessResult('Account'), success: 0, failed: 1, errors: ['refused'] };
      }),
    } as unknown as SyncOrchestratorDeps['dataSync'];

    const result = await new SyncOrchestrator(deps).execute(threeObjects());

    expect(result).toMatchObject({ cancelled: true, status: 'failure', totalFailed: 1 });
  });

  it('ends cancelled when the cancel aborted the upload of its last object', async () => {
    // Answered as an empty list, the aborted upload read as an object with
    // nothing to write, and the run ended as a success.
    const deps = createMockDeps();
    deps.dataSync = {
      sync: vi.fn(async (objectConfig: SyncObjectConfig) => {
        if (objectConfig.objectApiName === 'Opportunity') {
          throw new WriteCancelledError('Opportunity');
        }
        return createSuccessResult(objectConfig.objectApiName);
      }),
    } as unknown as SyncOrchestratorDeps['dataSync'];

    const result = await new SyncOrchestrator(deps).execute(threeObjects());

    expect(result).toMatchObject({
      cancelled: true,
      status: 'partial',
      error: 'Cancelled before Opportunity was synced.',
    });
    expect(result.objectResults.map((r) => r.objectApiName)).toEqual(['Account', 'Contact']);
  });

  it('counts what an object wrote before the cancel stopped its write between two batches', async () => {
    // Those records stay in the org: a run that left them out said less was
    // written than was.
    const deps = createMockDeps();
    deps.dataSync = {
      sync: vi.fn(async (objectConfig: SyncObjectConfig) => {
        if (objectConfig.objectApiName === 'Contact') {
          throw new WriteCancelledError('Contact', [
            { id: '003000000000001AAA', success: true, errors: [], created: true },
            { id: '003000000000002AAA', success: true, errors: [], created: false },
            { success: false, errors: ['REQUIRED_FIELD_MISSING: LastName'] },
          ]);
        }
        return createSuccessResult(objectConfig.objectApiName);
      }),
    } as unknown as SyncOrchestratorDeps['dataSync'];

    const result = await new SyncOrchestrator(deps).execute(threeObjects());

    expect(result).toMatchObject({
      cancelled: true,
      status: 'partial',
      totalProcessed: 4,
      totalSuccess: 3,
      totalFailed: 1,
      error: 'Cancelled before Contact, Opportunity were synced.',
    });
    expect(result.objectResults[1]).toMatchObject({
      objectApiName: 'Contact',
      operation: 'upsert',
      processed: 3,
      success: 2,
      failed: 1,
      errors: ['REQUIRED_FIELD_MISSING: LastName'],
      upsertSplit: { created: 1, updated: 1 },
    });
  });

  it('says what the write set aside for the records it wrote before the cancel stopped it', async () => {
    // A record type closed to the running user is taken off the records and
    // said beside the outcomes. Built from the outcomes the cancel carried,
    // the object's result counted the record written without its type, and
    // said nothing of the type.
    const CUSTOMER = '012Fk00000RtAbCIAV';
    const PARTNER = '012Fk00000RtDeFIAV';
    const recordType = (developerName: string, recordTypeId: string, available: boolean) => ({
      active: true,
      available,
      defaultRecordTypeMapping: available,
      developerName,
      master: false,
      name: developerName,
      recordTypeId,
      urls: {},
    });
    const write = vi.fn(async (): Promise<OperationOutcome[]> => {
      throw new WriteCancelledError('Account', [
        { id: '001000000000001AAA', success: true, errors: [] },
      ]);
    });
    const deps = createMockDeps();
    deps.dataSync = new DataSync({
      insert: write,
      upsert: write,
      update: write,
      delete: write,
      describeTargetFields: async () =>
        targetWriteFieldsOf({
          fields: [
            { name: 'Name', createable: true, type: 'string' },
            { name: 'RecordTypeId', createable: true, type: 'reference' },
          ],
          recordTypeInfos: [
            recordType('Customer', CUSTOMER, true),
            recordType('Partner', PARTNER, false),
          ],
        }),
    });
    deps.querySource = vi.fn().mockResolvedValue([
      { Name: 'Acme', RecordTypeId: PARTNER },
      { Name: 'Initech', RecordTypeId: PARTNER },
    ]);

    const result = await new SyncOrchestrator(deps).execute(
      createConfig({ objects: [createObjectConfig({ operation: 'insert' })] }),
    );

    expect(result).toMatchObject({ cancelled: true, totalProcessed: 1, totalSuccess: 1 });
    expect(result.objectResults).toEqual([
      expect.objectContaining({
        objectApiName: 'Account',
        processed: 1,
        errors: [expect.stringMatching(/^1 Account record written without record type Partner/)],
      }),
    ]);
  });

  it('still fails, and says why, when an object fails while a cancel is pending', async () => {
    const stop = new AbortController();
    const deps = createMockDeps();
    deps.signal = stop.signal;
    deps.querySource = vi.fn(async () => {
      stop.abort();
      throw new Error('INVALID_SESSION_ID: Session expired or invalid');
    });

    const failure = await new SyncOrchestrator(deps).execute(threeObjects()).then(
      () => undefined,
      (err: unknown) => err as SyncRunFailure,
    );

    expect(failure).toBeInstanceOf(SyncRunFailure);
    expect(failure?.message).toBe('INVALID_SESSION_ID: Session expired or invalid');
    expect(failure?.result.cancelled).toBeUndefined();
  });

  it('tells the Grappe view the run is over', async () => {
    const stop = new AbortController();
    const events: SyncGrappeEvent[] = [];
    const deps = createMockDeps();
    deps.signal = stop.signal;
    deps.grappeConfig = { ...DEFAULT_GRAPPE_CONFIG, enabled: true, autoActivateThreshold: 1 };
    deps.countSource = vi.fn(async () => 5_000);
    deps.onGrappeEvent = (event) => events.push(event);
    deps.dataSync = {
      sync: vi.fn(async () => {
        stop.abort();
        return createSuccessResult('Account');
      }),
    } as unknown as SyncOrchestratorDeps['dataSync'];

    const result = await new SyncOrchestrator(deps).execute(threeObjects());

    expect(events.map((event) => event.type)).toEqual([
      'grappe:started',
      'grappe:partitionProgress',
      'grappe:completed',
    ]);
    expect(events[2].payload).toMatchObject({
      operationId: result.operationId,
      totalProcessed: 1,
      totalFailed: 0,
    });
  });
});

describe('a cancel that comes while the run waits on the target, before a write, sends none of it', () => {
  /** The target's refusal of a lookup that holds an id from the source org. */
  const CROSS_REFERENCE = 'insufficient access rights on cross-reference id: 003000000000042AAA';

  /**
   * The run's DataSync over the writer a sync writes through, handed the
   * run's cancel, to a target whose `create` answers each batch with
   * `answer`, and whose describe is `describe`.
   */
  function throughTheWriter(
    stop: AbortController,
    answer: (batch: Record<string, unknown>[]) => OperationOutcome[],
    describe: () => Promise<ReturnType<typeof targetWriteFieldsOf>>,
  ) {
    const create = vi.fn(async (batch: Record<string, unknown>[]) => answer(batch));
    const writer = new BulkDataWriter({
      connection: { sobject: () => ({ create }) } as unknown as Connection,
      bulkExecutor: new BulkApiExecutor(200),
      bulkManager: new BulkApiManager(),
      retryConfig: { maxRetries: 0, initialDelay: 0, jitter: false },
      signal: stop.signal,
      onProgress: () => undefined,
      log: () => undefined,
    });
    const deps = createMockDeps();
    deps.signal = stop.signal;
    deps.dataSync = new DataSync({
      insert: (objectName, records, batchSize) => writer.insert(objectName, records, batchSize),
      upsert: (objectName, key, records, batchSize) =>
        writer.upsert(objectName, key, records, batchSize),
      update: (objectName, records, batchSize) => writer.update(objectName, records, batchSize),
      delete: (objectName, ids, batchSize) => writer.delete(objectName, ids, batchSize),
      describeTargetFields: describe,
    });
    return { deps, create };
  }

  /** The target's Account: a name, and a lookup to a contact. */
  const account = async () =>
    targetWriteFieldsOf({
      fields: [
        { name: 'Name', createable: true, type: 'string' },
        { name: 'Key_Contact__c', createable: true, type: 'reference' },
      ],
    });

  const inserts = createConfig({ objects: [createObjectConfig({ operation: 'insert' })] });

  it('sends nothing of an object the cancel came while the target was described', async () => {
    // Looked at before the object's write, the cancel went unseen while the
    // target was described: the first batch went out, and a run cancelled on
    // its last object ended as a success.
    const stop = new AbortController();
    const { deps, create } = throughTheWriter(
      stop,
      (batch) => batch.map((_, i) => ({ id: `001NEW${i}`, success: true, errors: [] })),
      async () => {
        stop.abort();
        return account();
      },
    );

    const result = await new SyncOrchestrator(deps).execute(inserts);

    expect(create).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      cancelled: true,
      objectResults: [],
      totalProcessed: 0,
      error: 'Cancelled before Account was synced.',
    });
  });

  it('does not send again, without their lookup, the rows refused in the write the cancel came during', async () => {
    // The rows the target refused for a lookup it does not have go again
    // without it, in a write of their own: its first batch went out after the
    // cancel, and the run ended as a success.
    const stop = new AbortController();
    const { deps, create } = throughTheWriter(
      stop,
      (batch) => {
        stop.abort();
        return batch.map((row, i) =>
          row['Key_Contact__c']
            ? { id: '', success: false, errors: [CROSS_REFERENCE] }
            : { id: `001NEW${i}`, success: true, errors: [] },
        );
      },
      account,
    );
    deps.querySource = vi
      .fn()
      .mockResolvedValue([
        { Name: 'Acme', Key_Contact__c: '003000000000042AAA' },
        { Name: 'Globex' },
      ]);

    const result = await new SyncOrchestrator(deps).execute(inserts);

    expect(create).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      cancelled: true,
      status: 'partial',
      totalProcessed: 2,
      totalSuccess: 1,
      totalFailed: 1,
    });
    expect(result.objectResults).toEqual([
      expect.objectContaining({ objectApiName: 'Account', errors: [CROSS_REFERENCE] }),
    ]);
  });
});

describe("an email's task, which the platform fills in itself", () => {
  const TO_A_QUOTE = {
    Id: '02s000000000001AAA',
    Subject: 'The offer',
    RelatedToId: '0Q0000000000001AAA',
    ActivityId: '00T000000000001AAA',
  };
  const ON_A_CASE = {
    Id: '02s000000000002AAA',
    Subject: 'It is broken',
    ParentId: '500000000000001AAA',
    ActivityId: '00T000000000002AAA',
  };
  const RELATED_TO_A_CASE = {
    Id: '02s000000000003AAA',
    Subject: 'Still broken',
    RelatedToId: '500000000000001AAA',
    ActivityId: '00T000000000003AAA',
  };

  /** A run of emails whose writer keeps what each call was sent. */
  function emailRun(operation: SyncObjectConfig['operation']) {
    const sent: Array<Record<string, unknown>> = [];
    const write = vi.fn(async (_object: string, ...args: unknown[]) => {
      const records = args.find(Array.isArray) as Array<Record<string, unknown>>;
      sent.push(...records);
      return records.map(() => ({ success: true, errors: [] }));
    });
    const deps: SyncOrchestratorDeps = {
      ...createMockDeps(),
      dataSync: new DataSync({ insert: write, upsert: write, update: write, delete: write }),
      fieldMapping: new FieldMappingService(),
      transformPipeline: new TransformPipeline(),
      querySource: vi
        .fn()
        .mockResolvedValue([TO_A_QUOTE, ON_A_CASE, RELATED_TO_A_CASE].map((row) => ({ ...row }))),
    };
    const config = createConfig({
      objects: [createObjectConfig({ objectApiName: 'EmailMessage', operation })],
    });
    return { deps, config, sent };
  }

  it('creates an email that is not on a case without the task it names, and one on a case with it', async () => {
    // Sent with the task id read from the source, the email related to a
    // quote is refused: INSUFFICIENT_ACCESS_OR_READONLY, "you cannot modify
    // this field". The platform writes its task as it takes it.
    for (const operation of ['insert', 'upsert'] as const) {
      const { deps, config, sent } = emailRun(operation);

      const result = await new SyncOrchestrator(deps).execute(config);

      expect(sent.map((row) => [row['Subject'], row['ActivityId']])).toEqual([
        ['The offer', undefined],
        ['It is broken', ON_A_CASE.ActivityId],
        ['Still broken', RELATED_TO_A_CASE.ActivityId],
      ]);
      expect(result.status).toBe('success');
    }
  });

  it('leaves an update of an email to the target', async () => {
    // It creates no email, so the platform fills nothing in.
    const { deps, config, sent } = emailRun('update');

    await new SyncOrchestrator(deps).execute(config);

    expect(sent.map((row) => row['ActivityId'])).toEqual([
      TO_A_QUOTE.ActivityId,
      ON_A_CASE.ActivityId,
      RELATED_TO_A_CASE.ActivityId,
    ]);
  });
});

describe('a feed item the platform writes itself', () => {
  const POST = { Id: '0D5000000000001AAA', Type: 'TextPost', Body: 'Kick-off' };
  const CHANGE = { Id: '0D5000000000002AAA', Type: 'TrackedChange', Body: null };

  /** A run of feed items whose writer keeps what each call was sent. */
  function feedRun(operation: SyncObjectConfig['operation'], rows: Array<Record<string, unknown>>) {
    const sent: Array<Record<string, unknown>> = [];
    const write = vi.fn(async (_object: string, ...args: unknown[]) => {
      const records = args.find(Array.isArray) as Array<Record<string, unknown>>;
      sent.push(...records);
      return records.map(() => ({ success: true, errors: [] }));
    });
    const deps: SyncOrchestratorDeps = {
      ...createMockDeps(),
      dataSync: new DataSync({ insert: write, upsert: write, update: write, delete: write }),
      fieldMapping: new FieldMappingService(),
      transformPipeline: new TransformPipeline(),
      querySource: vi.fn().mockResolvedValue(rows.map((row) => ({ ...row }))),
    };
    const config = createConfig({
      objects: [createObjectConfig({ objectApiName: 'FeedItem', operation })],
    });
    return { deps, config, sent, write };
  }

  it('leaves out a tracked change, which the platform refuses from a copy, and says so', async () => {
    // Sent, the target refuses it: "Cannot directly insert FeedItem with type
    // TrackedChange".
    const { deps, config, sent } = feedRun('insert', [POST, CHANGE]);

    const result = await new SyncOrchestrator(deps).execute(config);

    expect(sent.map((row) => row['Type'])).toEqual(['TextPost']);
    expect(result.status).toBe('success');
    expect(result.objectResults[0]).toMatchObject({
      objectApiName: 'FeedItem',
      processed: 1,
      success: 1,
      failed: 0,
      skipped: 1,
      errors: ['1 tracked change left out: the platform writes them itself'],
    });
    expect(result.totalSkipped).toBe(1);
  });

  it('writes nothing of an object whose every row is one, and says so', async () => {
    const { deps, config, write } = feedRun('upsert', [CHANGE]);

    const result = await new SyncOrchestrator(deps).execute(config);

    expect(write).not.toHaveBeenCalled();
    expect(result.objectResults[0]).toMatchObject({
      processed: 0,
      success: 0,
      failed: 0,
      skipped: 1,
      errors: ['1 tracked change left out: the platform writes them itself'],
    });
  });

  it('leaves an update of a tracked change the target holds to the target', async () => {
    // It creates none: the target says whether it takes the change.
    const { deps, config, sent } = feedRun('update', [CHANGE]);

    const result = await new SyncOrchestrator(deps).execute(config);

    expect(sent.map((row) => row['Id'])).toEqual([CHANGE.Id]);
    expect(result.objectResults[0]).toMatchObject({ skipped: 0, errors: [] });
  });

  describe('on an object the run stopped on', () => {
    const LEFT_OUT = '1 tracked change left out: the platform writes them itself';
    /** A run of a post and a tracked change whose writer does what `write` does. */
    function stoppedRun(write: () => Promise<OperationOutcome[]>) {
      const run = feedRun('insert', [POST, CHANGE]);
      const writer = vi.fn(write);
      run.deps.dataSync = new DataSync({
        insert: writer,
        upsert: writer,
        update: writer,
        delete: writer,
      });
      return run;
    }

    it('counts the tracked change it left out when a cancel stopped the write between two batches', async () => {
      // Built from what the write had sent alone, the object's result dropped
      // the tracked change the read had left out, and the note saying why.
      const { deps, config } = stoppedRun(async () => {
        throw new WriteCancelledError('FeedItem', [
          { id: '0D5000000000901AAA', success: true, errors: [] },
        ]);
      });

      const result = await new SyncOrchestrator(deps).execute(config);

      expect(result).toMatchObject({ cancelled: true, totalProcessed: 1, totalSkipped: 1 });
      expect(result.objectResults).toEqual([
        expect.objectContaining({
          objectApiName: 'FeedItem',
          processed: 1,
          success: 1,
          skipped: 1,
          errors: [LEFT_OUT],
        }),
      ]);
    });

    it('counts the tracked change it left out when a cancel stopped the write before any record went', async () => {
      const { deps, config } = stoppedRun(async () => {
        throw new WriteCancelledError('FeedItem');
      });

      const result = await new SyncOrchestrator(deps).execute(config);

      expect(result).toMatchObject({
        cancelled: true,
        totalProcessed: 0,
        totalSkipped: 1,
        error: 'Cancelled before FeedItem was synced.',
      });
      expect(result.objectResults).toEqual([
        expect.objectContaining({ processed: 0, skipped: 1, errors: [LEFT_OUT] }),
      ]);
    });

    it('counts the tracked change it left out when the cancel came between the read and the write', async () => {
      const stop = new AbortController();
      const { deps, config, write } = feedRun('insert', [POST, CHANGE]);
      deps.signal = stop.signal;
      const read = deps.querySource;
      deps.querySource = vi.fn(async (org: string, object: SyncObjectConfig) => {
        stop.abort();
        return read(org, object);
      });

      const result = await new SyncOrchestrator(deps).execute(config);

      expect(write).not.toHaveBeenCalled();
      expect(result).toMatchObject({ cancelled: true, totalProcessed: 0, totalSkipped: 1 });
      expect(result.objectResults).toEqual([
        expect.objectContaining({ processed: 0, skipped: 1, errors: [LEFT_OUT] }),
      ]);
    });

    it('counts the tracked change it left out on an object whose write failed', async () => {
      const { deps, config } = stoppedRun(async () => {
        throw new Error('ECONNRESET');
      });

      const failure = await new SyncOrchestrator(deps).execute(config).then(
        () => undefined,
        (err: unknown) => err as SyncRunFailure,
      );

      expect(failure).toBeInstanceOf(SyncRunFailure);
      expect(failure?.result.totalSkipped).toBe(1);
      expect(failure?.result.objectResults).toEqual([
        expect.objectContaining({ failed: 1, skipped: 1, errors: ['ECONNRESET', LEFT_OUT] }),
      ]);
    });
  });
});
