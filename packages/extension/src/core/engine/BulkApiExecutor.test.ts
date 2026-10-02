import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BulkApiExecutor } from './BulkApiExecutor';
import type {
  BulkApiConnection,
  BulkApiExecutorDeps,
  BulkExecutionResult,
  BulkJobHandle,
  BulkJobCheckResult,
  BulkJobRecordResult,
  JsforceIngestJobResults,
} from './BulkApiExecutor';
import { BulkApiManager } from './BulkApiManager';

function createMockJob(overrides?: {
  checkResults?: BulkJobCheckResult[];
  allResults?: BulkJobRecordResult[];
}): BulkJobHandle {
  const checkResults = overrides?.checkResults ?? [
    { state: 'InProgress' as const, numberRecordsProcessed: 0 },
    { state: 'JobComplete' as const, numberRecordsProcessed: 3 },
  ];
  const allResults = overrides?.allResults ?? [
    { success: true },
    { success: true },
    { success: true },
  ];

  let checkCallCount = 0;

  return {
    id: 'test-job-123',
    open: vi.fn().mockResolvedValue(undefined),
    uploadData: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    check: vi.fn().mockImplementation(async (): Promise<BulkJobCheckResult> => {
      const result = checkResults[Math.min(checkCallCount, checkResults.length - 1)];
      checkCallCount++;
      return result;
    }),
    getAllResults: vi.fn().mockResolvedValue(allResults),
  };
}

function createMockConnection(job: BulkJobHandle): BulkApiConnection {
  return {
    bulk2: {
      createJob: vi.fn().mockReturnValue(job),
    },
  };
}

function createDeps(
  connection: BulkApiConnection,
  manager?: BulkApiManager,
  onProgress?: (processed: number, total: number) => void,
): BulkApiExecutorDeps {
  return {
    connection,
    bulkManager: manager ?? new BulkApiManager(5),
    onProgress,
  };
}

describe('BulkApiExecutor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('shouldUseBulkApi', () => {
    it('should return false for record count at or below threshold', () => {
      const executor = new BulkApiExecutor(200);

      expect(executor.shouldUseBulkApi(200)).toBe(false);
      expect(executor.shouldUseBulkApi(100)).toBe(false);
      expect(executor.shouldUseBulkApi(1)).toBe(false);
    });

    it('should return true for record count above threshold', () => {
      const executor = new BulkApiExecutor(200);

      expect(executor.shouldUseBulkApi(201)).toBe(true);
      expect(executor.shouldUseBulkApi(1000)).toBe(true);
    });

    it('should use SF_LIMITS.REST_API_BATCH_SIZE as default threshold', () => {
      const executor = new BulkApiExecutor();

      expect(executor.shouldUseBulkApi(200)).toBe(false);
      expect(executor.shouldUseBulkApi(201)).toBe(true);
    });
  });

  describe('getThreshold', () => {
    it('should return the configured threshold', () => {
      const executor = new BulkApiExecutor(500);
      expect(executor.getThreshold()).toBe(500);
    });
  });

  describe('executeBulk', () => {
    it('should register job with BulkApiManager', async () => {
      const job = createMockJob();
      const connection = createMockConnection(job);
      const manager = new BulkApiManager(5);
      const deps = createDeps(connection, manager);
      const executor = new BulkApiExecutor();

      const records = [{ Name: 'A' }, { Name: 'B' }, { Name: 'C' }];

      const promise = executor.executeBulk(deps, 'Account', 'insert', records);
      await vi.runAllTimersAsync();
      await promise;

      expect(manager.getJob('test-job-123')).toBeDefined();
    });

    it('should call open, uploadData, close in order', async () => {
      const job = createMockJob();
      const connection = createMockConnection(job);
      const deps = createDeps(connection);
      const executor = new BulkApiExecutor();

      const records = [{ Name: 'Test' }];

      const promise = executor.executeBulk(deps, 'Account', 'insert', records);
      await vi.runAllTimersAsync();
      await promise;

      expect(job.open).toHaveBeenCalledTimes(1);
      expect(job.uploadData).toHaveBeenCalledWith('Name\nTest\n');
      expect(job.close).toHaveBeenCalledTimes(1);
    });

    it('should poll until JobComplete', async () => {
      const job = createMockJob({
        checkResults: [
          { state: 'UploadComplete', numberRecordsProcessed: 0 },
          { state: 'InProgress', numberRecordsProcessed: 1 },
          { state: 'InProgress', numberRecordsProcessed: 2 },
          { state: 'JobComplete', numberRecordsProcessed: 3 },
        ],
      });
      const connection = createMockConnection(job);
      const deps = createDeps(connection);
      const executor = new BulkApiExecutor();

      const records = [{ Name: 'A' }, { Name: 'B' }, { Name: 'C' }];

      const promise = executor.executeBulk(deps, 'Account', 'insert', records);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(job.check).toHaveBeenCalledTimes(4);
      expect(result.successCount).toBe(3);
      expect(result.failureCount).toBe(0);
    });

    it('should return correct success and failure counts', async () => {
      const job = createMockJob({
        checkResults: [{ state: 'JobComplete', numberRecordsProcessed: 3 }],
        allResults: [
          { success: true },
          { success: false, errors: ['REQUIRED_FIELD_MISSING'] },
          { success: true },
        ],
      });
      const connection = createMockConnection(job);
      const deps = createDeps(connection);
      const executor = new BulkApiExecutor();

      const records = [{ Name: 'A' }, { Name: 'B' }, { Name: 'C' }];

      const promise = executor.executeBulk(deps, 'Account', 'insert', records);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.totalRecords).toBe(3);
      expect(result.successCount).toBe(2);
      expect(result.failureCount).toBe(1);
      expect(result.failures).toEqual([{ recordIndex: 1, error: 'REQUIRED_FIELD_MISSING' }]);
      expect(result.usedBulkApi).toBe(true);
      expect(result.jobId).toBe('test-job-123');
    });

    it('should throw when max concurrent jobs reached', async () => {
      const job = createMockJob();
      const connection = createMockConnection(job);
      const manager = new BulkApiManager(1);
      manager.registerJob({
        id: 'existing',
        operation: 'insert',
        object: 'Account',
        state: 'InProgress',
        numberRecordsProcessed: 0,
        numberRecordsFailed: 0,
        totalProcessingTime: 0,
        createdDate: new Date().toISOString(),
      });
      const deps = createDeps(connection, manager);
      const executor = new BulkApiExecutor();

      await expect(
        executor.executeBulk(deps, 'Account', 'insert', [{ Name: 'A' }]),
      ).rejects.toThrow('Maximum concurrent bulk jobs reached');
    });

    it('frees the job slot when the job throws mid-flight', async () => {
      const job = createMockJob();
      job.uploadData = vi.fn().mockRejectedValue(new Error('connection reset'));
      const connection = createMockConnection(job);
      // The limiter outlives the run, so a job that never reaches a terminal
      // state would hold its slot for the life of the window.
      const manager = new BulkApiManager(1);
      const deps = createDeps(connection, manager);
      const executor = new BulkApiExecutor();

      await expect(
        executor.executeBulk(deps, 'Account', 'insert', [{ Name: 'A' }]),
      ).rejects.toThrow('connection reset');

      expect(manager.canStartNewJob()).toBe(true);
    });

    it('tracks two jobs opened in the same millisecond separately', async () => {
      const manager = new BulkApiManager(2);
      const executor = new BulkApiExecutor();
      const run = (): Promise<unknown> => {
        // jsforce leaves `id` undefined until the job is opened, so both jobs
        // reach the limiter without a Salesforce id of their own.
        const job = createMockJob({
          checkResults: [{ state: 'JobComplete', numberRecordsProcessed: 1 }],
          allResults: [{ success: true, id: '001xx0000001' }],
        });
        job.id = undefined;
        return executor.executeBulk(
          createDeps(createMockConnection(job), manager),
          'Account',
          'insert',
          [{ Name: 'A' }],
        );
      };

      const first = run();
      const second = run();
      expect(manager.getActiveJobs()).toHaveLength(2);
      await Promise.all([first, second]);
    });

    it('should call onProgress during polling', async () => {
      const onProgress = vi.fn();
      const job = createMockJob({
        checkResults: [
          { state: 'InProgress', numberRecordsProcessed: 1 },
          { state: 'JobComplete', numberRecordsProcessed: 3 },
        ],
      });
      const connection = createMockConnection(job);
      const deps = createDeps(connection, undefined, onProgress);
      const executor = new BulkApiExecutor();

      const records = [{ Name: 'A' }, { Name: 'B' }, { Name: 'C' }];

      const promise = executor.executeBulk(deps, 'Account', 'insert', records);
      await vi.runAllTimersAsync();
      await promise;

      expect(onProgress).toHaveBeenCalledWith(1, 3);
    });

    it('should pass externalIdField for upsert operations', async () => {
      const job = createMockJob({
        checkResults: [{ state: 'JobComplete', numberRecordsProcessed: 1 }],
      });
      const connection = createMockConnection(job);
      const deps = createDeps(connection);
      const executor = new BulkApiExecutor();

      const promise = executor.executeBulk(
        deps,
        'Account',
        'upsert',
        [{ External_Id__c: '123', Name: 'Test' }],
        'External_Id__c',
      );
      await vi.runAllTimersAsync();
      await promise;

      expect(connection.bulk2.createJob).toHaveBeenCalledWith({
        operation: 'upsert',
        object: 'Account',
        externalIdFieldName: 'External_Id__c',
      });
    });

    it('should update BulkApiManager with final state', async () => {
      const job = createMockJob({
        checkResults: [{ state: 'JobComplete', numberRecordsProcessed: 2 }],
        allResults: [{ success: true }, { success: false, errors: ['ERROR'] }],
      });
      const connection = createMockConnection(job);
      const manager = new BulkApiManager(5);
      const deps = createDeps(connection, manager);
      const executor = new BulkApiExecutor();

      const promise = executor.executeBulk(deps, 'Account', 'insert', [
        { Name: 'A' },
        { Name: 'B' },
      ]);
      await vi.runAllTimersAsync();
      await promise;

      const trackedJob = manager.getJob('test-job-123');
      expect(trackedJob?.state).toBe('JobComplete');
      expect(trackedJob?.numberRecordsProcessed).toBe(2);
      expect(trackedJob?.numberRecordsFailed).toBe(1);
    });

    it('should return real IDs from getAllResults when records have id field', async () => {
      const job = createMockJob({
        checkResults: [{ state: 'JobComplete', numberRecordsProcessed: 3 }],
        allResults: [
          { success: true, id: '001xx000001AAA' },
          { success: true, id: '001xx000001BBB' },
          { success: true, id: '001xx000001CCC' },
        ],
      });
      const connection = createMockConnection(job);
      const deps = createDeps(connection);
      const executor = new BulkApiExecutor();

      const records = [{ Name: 'A' }, { Name: 'B' }, { Name: 'C' }];
      const promise = executor.executeBulk(deps, 'Account', 'insert', records);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.successIds).toEqual(['001xx000001AAA', '001xx000001BBB', '001xx000001CCC']);
      expect(result.successIds).toHaveLength(result.successCount);
    });

    it('should NOT fabricate IDs when the backend omits them', async () => {
      const job = createMockJob({
        checkResults: [{ state: 'JobComplete', numberRecordsProcessed: 2 }],
        allResults: [{ success: true }, { success: true }],
      });
      const connection = createMockConnection(job);
      const deps = createDeps(connection);
      const executor = new BulkApiExecutor();

      const records = [{ Name: 'A' }, { Name: 'B' }];
      const promise = executor.executeBulk(deps, 'Account', 'insert', records);
      await vi.runAllTimersAsync();
      const result = await promise;

      // Honest contract: successCount reflects the rows, but successIds only
      // ever contains real Salesforce IDs — never fabricated bulk-* placeholders.
      expect(result.successCount).toBe(2);
      expect(result.successIds).toEqual([]);
      expect(result.outcomes).toEqual([
        { recordIndex: 0, id: undefined, success: true },
        { recordIndex: 1, id: undefined, success: true },
      ]);
    });

    it('should have successIds length matching successCount', async () => {
      const job = createMockJob({
        checkResults: [{ state: 'JobComplete', numberRecordsProcessed: 3 }],
        allResults: [
          { success: true, id: '001xx000001AAA' },
          { success: false, errors: ['ERR'] },
          { success: true, id: '001xx000001CCC' },
        ],
      });
      const connection = createMockConnection(job);
      const deps = createDeps(connection);
      const executor = new BulkApiExecutor();

      const records = [{ Name: 'A' }, { Name: 'B' }, { Name: 'C' }];
      const promise = executor.executeBulk(deps, 'Account', 'insert', records);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.successCount).toBe(2);
      expect(result.successIds).toHaveLength(2);
      expect(result.successIds).toEqual(['001xx000001AAA', '001xx000001CCC']);
    });

    it('should fail closed for input records with no result row', async () => {
      const job = createMockJob({
        checkResults: [{ state: 'JobComplete', numberRecordsProcessed: 1 }],
        allResults: [{ success: true, id: '001xx000001AAA' }],
      });
      const connection = createMockConnection(job);
      const deps = createDeps(connection);
      const executor = new BulkApiExecutor();

      const records = [{ Name: 'A' }, { Name: 'B' }];
      const promise = executor.executeBulk(deps, 'Account', 'insert', records);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.successCount).toBe(1);
      expect(result.failureCount).toBe(1);
      expect(result.outcomes[1]).toEqual({
        recordIndex: 1,
        success: false,
        error: 'No result returned by Bulk API job',
      });
    });

    it('should correlate real jsforce grouped results to input records by content', async () => {
      const job = createMockJob({
        checkResults: [{ state: 'JobComplete', numberRecordsProcessed: 3 }],
      });
      // Real jsforce shape — note the success/failure split and the fact that
      // result order does NOT match input order.
      (job.getAllResults as ReturnType<typeof vi.fn>).mockResolvedValue({
        successfulResults: [
          { sf__Id: '001xx000001CCC', sf__Created: 'true', Name: 'C' },
          { sf__Id: '001xx000001AAA', sf__Created: 'true', Name: 'A' },
        ],
        failedResults: [{ sf__Error: 'REQUIRED_FIELD_MISSING: X', sf__Id: '', Name: 'B' }],
        unprocessedRecords: [],
      });
      const connection = createMockConnection(job);
      const deps = createDeps(connection);
      const executor = new BulkApiExecutor();

      const records = [{ Name: 'A' }, { Name: 'B' }, { Name: 'C' }];
      const promise = executor.executeBulk(deps, 'Account', 'insert', records);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.successCount).toBe(2);
      expect(result.failureCount).toBe(1);
      expect(result.outcomes).toEqual([
        { recordIndex: 0, id: '001xx000001AAA', success: true, created: true },
        { recordIndex: 1, success: false, error: 'REQUIRED_FIELD_MISSING: X' },
        { recordIndex: 2, id: '001xx000001CCC', success: true, created: true },
      ]);
      expect(result.failures).toEqual([{ recordIndex: 1, error: 'REQUIRED_FIELD_MISSING: X' }]);
      expect(result.successIds).toEqual(['001xx000001AAA', '001xx000001CCC']);
    });

    it("keeps what an upsert did with each record, from the job's sf__Created column", async () => {
      // The column was stripped with the other job columns, so an upsert
      // could not say which records it created and which it updated.
      const job = createMockJob({
        checkResults: [{ state: 'JobComplete', numberRecordsProcessed: 2 }],
      });
      (job.getAllResults as ReturnType<typeof vi.fn>).mockResolvedValue({
        successfulResults: [
          { sf__Id: '001xx000001BBB', sf__Created: 'false', Ext__c: 'B' },
          { sf__Id: '001xx000001AAA', sf__Created: 'true', Ext__c: 'A' },
        ],
        failedResults: [],
        unprocessedRecords: [],
      });
      const deps = createDeps(createMockConnection(job));

      const promise = new BulkApiExecutor().executeBulk(
        deps,
        'Account',
        'upsert',
        [{ Ext__c: 'A' }, { Ext__c: 'B' }],
        'Ext__c',
      );
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.outcomes.map((o) => o.created)).toEqual([true, false]);
    });
  });

  describe('a write whose rows carry different fields', () => {
    /** Run one job whose check and results are given, and answer its result. */
    async function run(
      operation: 'insert' | 'update' | 'upsert',
      records: Record<string, unknown>[],
      results: JsforceIngestJobResults,
      options: { check?: BulkJobCheckResult; externalIdField?: string } = {},
    ): Promise<{ job: BulkJobHandle; result: BulkExecutionResult }> {
      const job = createMockJob({
        checkResults: [options.check ?? { state: 'JobComplete', numberRecordsProcessed: 0 }],
      });
      (job.getAllResults as ReturnType<typeof vi.fn>).mockResolvedValue(results);
      const promise = new BulkApiExecutor().executeBulk(
        createDeps(createMockConnection(job)),
        'Product2',
        operation,
        records,
        options.externalIdField,
      );
      await vi.runAllTimersAsync();
      return { job, result: await promise };
    }

    /** The rows a Frozen load writes: every empty value left out. */
    const rows = [
      { Name: 'Row 0', Unit__c: 'EACH' },
      { Name: 'Row 1' },
      { Name: 'Row 2', Unit__c: 'BOX', Description: 'kept' },
    ];

    it('uploads one CSV whose header names every field any row carries', async () => {
      // Handed the records, jsforce wrote the header from the first one: the
      // third row's description was dropped, and the target created the row
      // without it.
      const { job } = await run('insert', rows, { successfulResults: [] });

      expect(job.uploadData).toHaveBeenCalledTimes(1);
      expect(job.uploadData).toHaveBeenCalledWith(
        'Name,Unit__c,Description\nRow 0,EACH,\nRow 1,,\nRow 2,BOX,kept\n',
      );
    });

    it("finds each row's result whatever fields it carries, the results echoing every column", async () => {
      // Matched on the fields each record carried, a row with fewer or more
      // than the header matched none of the rows the results echo: 249 of 250
      // came back "No result returned", though the target held every one.
      const { result } = await run('insert', rows, {
        successfulResults: [
          {
            sf__Id: '01t000000000003AAA',
            sf__Created: 'true',
            Name: 'Row 2',
            Unit__c: 'BOX',
            Description: 'kept',
          },
          {
            sf__Id: '01t000000000001AAA',
            sf__Created: 'true',
            Name: 'Row 0',
            Unit__c: 'EACH',
            Description: '',
          },
          {
            sf__Id: '01t000000000002AAA',
            sf__Created: 'true',
            Name: 'Row 1',
            Unit__c: '',
            Description: '',
          },
        ],
        failedResults: [],
        unprocessedRecords: [],
      });

      expect(result.outcomes.map((o) => [o.success, o.id])).toEqual([
        [true, '01t000000000001AAA'],
        [true, '01t000000000002AAA'],
        [true, '01t000000000003AAA'],
      ]);
      expect(result.failureCount).toBe(0);
    });

    it('finds a row whose number, checkbox or date the results write back in another form', async () => {
      const { result } = await run(
        'insert',
        [
          { Name: 'A', Quantity__c: 3, Active__c: true, Since__c: '2026-10-02T10:00:00Z' },
          { Name: 'B', Quantity__c: 1.5 },
        ],
        {
          successfulResults: [
            {
              sf__Id: '01t000000000002AAA',
              sf__Created: 'true',
              Name: 'B',
              Quantity__c: '1.5',
              Active__c: '',
              Since__c: '',
            },
          ],
          failedResults: [
            {
              sf__Id: '',
              sf__Error: 'FIELD_CUSTOM_VALIDATION_EXCEPTION:Not today:Since__c --',
              Name: 'A',
              Quantity__c: '3.0',
              Active__c: 'true',
              Since__c: '2026-10-02T10:00:00.000Z',
            },
          ],
        },
      );

      expect(result.outcomes).toEqual([
        {
          recordIndex: 0,
          success: false,
          error: 'FIELD_CUSTOM_VALIDATION_EXCEPTION:Not today:Since__c --',
        },
        { recordIndex: 1, id: '01t000000000002AAA', success: true, created: true },
      ]);
    });

    it('finds an updated row by its Id, whatever the results write back of its other cells', async () => {
      const { result } = await run(
        'update',
        [
          { Id: '01t000000000001AAA', Description: null, Opens__c: '10:00' },
          { Id: '01t000000000002AAA', Phone: '0102' },
        ],
        {
          successfulResults: [
            {
              sf__Id: '01t000000000002AAA',
              sf__Created: 'false',
              Id: '01t000000000002AAA',
              Description: '',
              Opens__c: '',
              Phone: '0102',
            },
            {
              sf__Id: '01t000000000001AAA',
              sf__Created: 'false',
              Id: '01t000000000001AAA',
              Description: '',
              Opens__c: '10:00:00.000Z',
              Phone: '',
            },
          ],
        },
      );

      expect(result.outcomes.map((o) => [o.success, o.id])).toEqual([
        [true, '01t000000000001AAA'],
        [true, '01t000000000002AAA'],
      ]);
    });

    it('finds an upserted row by its external id, whatever the results write back of its other cells', async () => {
      const { result } = await run(
        'upsert',
        [
          { Code__c: 7, Opens__c: '10:00' },
          { Code__c: 8, Phone: '0102' },
        ],
        {
          successfulResults: [
            {
              sf__Id: '01t000000000008AAA',
              sf__Created: 'true',
              Code__c: '8.0',
              Opens__c: '',
              Phone: '0102',
            },
            {
              sf__Id: '01t000000000007AAA',
              sf__Created: 'false',
              Code__c: '7.0',
              Opens__c: '10:00:00.000Z',
              Phone: '',
            },
          ],
        },
        { externalIdField: 'Code__c' },
      );

      expect(result.outcomes.map((o) => [o.id, o.created])).toEqual([
        ['01t000000000007AAA', false],
        ['01t000000000008AAA', true],
      ]);
    });

    it('says a row got no result, and names the records the job wrote that no row was matched to', async () => {
      // Dropped, their ids were never mapped and never removable: the target
      // held the records, and nothing said where.
      const { result } = await run('insert', [{ Name: 'A' }, { Name: 'B' }], {
        successfulResults: [
          { sf__Id: '01t000000000001AAA', sf__Created: 'true', Name: 'A' },
          { sf__Id: '01t000000000009AAA', sf__Created: 'true', Name: 'B as echoed otherwise' },
        ],
      });

      expect(result.outcomes[0]).toEqual({
        recordIndex: 0,
        id: '01t000000000001AAA',
        success: true,
        created: true,
      });
      expect(result.outcomes[1]).toEqual({
        recordIndex: 1,
        success: false,
        error:
          'No result returned by Bulk API job; the job wrote 1 record(s) no row was matched to: 01t000000000009AAA',
      });
      expect(result.unmatchedIds).toEqual(['01t000000000009AAA']);
      expect(result.successIds).toContain('01t000000000009AAA');
    });

    it('says why on every row a failed job left without a result', async () => {
      // One row naming a field the target lacks puts it in the header, and
      // the target refuses the whole job.
      const { result } = await run(
        'insert',
        [{ Name: 'A' }, { Name: 'B', Nope__c: 'x' }],
        {
          successfulResults: [],
          failedResults: [],
          unprocessedRecords: [{ Name: 'A', Nope__c: '' }],
        },
        {
          check: {
            state: 'Failed',
            numberRecordsProcessed: 0,
            errorMessage: 'InvalidBatch : Field name not found : Nope__c',
          },
        },
      );

      expect(result.outcomes.map((o) => o.error)).toEqual([
        'Record not processed by Bulk API job (InvalidBatch : Field name not found : Nope__c)',
        'No result returned by Bulk API job (InvalidBatch : Field name not found : Nope__c)',
      ]);
    });
  });

  describe('a cancel', () => {
    const records = [{ Name: 'A' }, { Name: 'B' }, { Name: 'C' }];

    it('aborts the job while it is still open, so Salesforce writes none of it', async () => {
      // The job used to be closed whatever the run said: a cancel during the
      // upload had every record of it written.
      const stop = new AbortController();
      const job = createMockJob();
      job.uploadData = vi.fn(async () => stop.abort());
      const manager = new BulkApiManager(1);
      const deps = { ...createDeps(createMockConnection(job), manager), signal: stop.signal };

      const promise = new BulkApiExecutor().executeBulk(deps, 'Account', 'insert', records);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(job.abort).toHaveBeenCalledTimes(1);
      expect(job.close).not.toHaveBeenCalled();
      expect(job.check).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        aborted: true,
        totalRecords: 3,
        successCount: 0,
        failureCount: 0,
        successIds: [],
        outcomes: [],
      });
      expect(manager.getJob('test-job-123')?.state).toBe('Aborted');
      expect(manager.canStartNewJob()).toBe(true);
    });

    it('uploads nothing to a job the cancel came before', async () => {
      const stop = new AbortController();
      stop.abort();
      const job = createMockJob();
      const deps = { ...createDeps(createMockConnection(job)), signal: stop.signal };

      const promise = new BulkApiExecutor().executeBulk(deps, 'Account', 'insert', records);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(job.uploadData).not.toHaveBeenCalled();
      expect(job.abort).toHaveBeenCalledTimes(1);
      expect(job.close).not.toHaveBeenCalled();
      expect(result).toMatchObject({ aborted: true, totalRecords: 0 });
    });

    it('still writes nothing when the abort itself is refused: a job never closed is never processed', async () => {
      const stop = new AbortController();
      const job = createMockJob();
      job.uploadData = vi.fn(async () => stop.abort());
      job.abort = vi.fn().mockRejectedValue(new Error('INVALIDJOBSTATE'));
      const manager = new BulkApiManager(1);
      const deps = { ...createDeps(createMockConnection(job), manager), signal: stop.signal };

      const promise = new BulkApiExecutor().executeBulk(deps, 'Account', 'insert', records);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(job.close).not.toHaveBeenCalled();
      expect(result.aborted).toBe(true);
      expect(manager.canStartNewJob()).toBe(true);
    });

    it('waits for a job already closed and counts what it wrote', async () => {
      // Closed, the job is written in full whatever happens next: it is read
      // back like any other rather than left written and uncounted.
      const stop = new AbortController();
      const job = createMockJob({
        checkResults: [
          { state: 'InProgress', numberRecordsProcessed: 1 },
          { state: 'JobComplete', numberRecordsProcessed: 3 },
        ],
      });
      job.close = vi.fn(async () => stop.abort());
      const deps = { ...createDeps(createMockConnection(job)), signal: stop.signal };

      const promise = new BulkApiExecutor().executeBulk(deps, 'Account', 'insert', records);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(job.abort).not.toHaveBeenCalled();
      expect(result.aborted).toBeUndefined();
      expect(result.successCount).toBe(3);
    });
  });
});
