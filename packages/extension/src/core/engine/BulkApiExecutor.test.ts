import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BulkApiExecutor } from './BulkApiExecutor';
import type {
  BulkApiConnection,
  BulkApiExecutorDeps,
  BulkJobHandle,
  BulkJobCheckResult,
  BulkJobRecordResult,
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
      expect(job.uploadData).toHaveBeenCalledWith(records);
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
        checkResults: [
          { state: 'JobComplete', numberRecordsProcessed: 3 },
        ],
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
      expect(result.failures).toEqual([
        { recordIndex: 1, error: 'REQUIRED_FIELD_MISSING' },
      ]);
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
        checkResults: [
          { state: 'JobComplete', numberRecordsProcessed: 1 },
        ],
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
        checkResults: [
          { state: 'JobComplete', numberRecordsProcessed: 2 },
        ],
        allResults: [
          { success: true },
          { success: false, errors: ['ERROR'] },
        ],
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
        checkResults: [
          { state: 'JobComplete', numberRecordsProcessed: 3 },
        ],
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

      expect(result.successIds).toEqual([
        '001xx000001AAA',
        '001xx000001BBB',
        '001xx000001CCC',
      ]);
      expect(result.successIds).toHaveLength(result.successCount);
    });

    it('should fall back to bulk-{jobId}-{i} when id is undefined in results', async () => {
      const job = createMockJob({
        checkResults: [
          { state: 'JobComplete', numberRecordsProcessed: 2 },
        ],
        allResults: [
          { success: true },
          { success: true },
        ],
      });
      const connection = createMockConnection(job);
      const deps = createDeps(connection);
      const executor = new BulkApiExecutor();

      const records = [{ Name: 'A' }, { Name: 'B' }];
      const promise = executor.executeBulk(deps, 'Account', 'insert', records);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.successIds).toEqual([
        'bulk-test-job-123-0',
        'bulk-test-job-123-1',
      ]);
      expect(result.successIds).toHaveLength(result.successCount);
    });

    it('should have successIds length matching successCount', async () => {
      const job = createMockJob({
        checkResults: [
          { state: 'JobComplete', numberRecordsProcessed: 3 },
        ],
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
  });
});
