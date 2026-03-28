import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChunkedBulkExecutor } from './ChunkedBulkExecutor.js';
import type {
  BulkApiConnection,
  BulkApiExecutorDeps,
  BulkJobHandle,
  BulkJobRecordResult,
} from './BulkApiExecutor.js';
import { BulkApiManager } from './BulkApiManager.js';

/** Helper: create an async generator from arrays. */
async function* toAsyncIterable(
  batches: Record<string, unknown>[][],
): AsyncGenerator<Record<string, unknown>[]> {
  for (const batch of batches) {
    yield batch;
  }
}

/** Helper: generate N records. */
function generateRecords(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({ Name: `Record_${i}` }));
}

/** Helper: create a mock BulkJobHandle. */
function createMockJob(opts?: {
  pollCount?: number;
  results?: BulkJobRecordResult[];
}): BulkJobHandle {
  const pollCount = opts?.pollCount ?? 1;
  let pollCalls = 0;
  const results: BulkJobRecordResult[] =
    opts?.results ?? [];

  return {
    id: 'job-chunked-001',
    open: vi.fn().mockResolvedValue(undefined),
    uploadData: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    check: vi.fn().mockImplementation(async () => {
      pollCalls++;
      if (pollCalls <= pollCount) {
        return { state: 'InProgress', numberRecordsProcessed: 0 };
      }
      return {
        state: 'JobComplete',
        numberRecordsProcessed: results.length,
      };
    }),
    getAllResults: vi.fn().mockResolvedValue(results),
  };
}

/** Helper: create mock deps. */
function createMockDeps(job: BulkJobHandle): BulkApiExecutorDeps {
  const manager = new BulkApiManager(5);
  const connection: BulkApiConnection = {
    bulk2: {
      createJob: vi.fn().mockReturnValue(job),
    },
  };
  return {
    connection,
    bulkManager: manager,
    onProgress: vi.fn(),
  };
}

describe('ChunkedBulkExecutor', () => {
  let executor: ChunkedBulkExecutor;

  beforeEach(() => {
    executor = new ChunkedBulkExecutor({
      chunkSize: 2000,
      pollIntervalMs: 0,
    });
  });

  it('should open one job, upload 3 chunks, close, poll, and return results', async () => {
    const totalRecords = 6000;
    const results: BulkJobRecordResult[] = Array.from(
      { length: totalRecords },
      (_, i) => ({
        success: true,
        id: `001xx${String(i).padStart(7, '0')}`,
      }),
    );
    const job = createMockJob({ pollCount: 1, results });
    const deps = createMockDeps(job);

    const chunks = [
      generateRecords(2000),
      generateRecords(2000),
      generateRecords(2000),
    ];

    const result = await executor.executeChunked(
      deps,
      'Account',
      'insert',
      toAsyncIterable(chunks),
      totalRecords,
    );

    expect(result.aborted).toBe(false);
    expect(result.totalRecords).toBe(6000);
    expect(result.successCount).toBe(6000);
    expect(result.failureCount).toBe(0);
    expect(result.successIds).toHaveLength(6000);

    expect(job.open).toHaveBeenCalledTimes(1);
    expect(job.uploadData).toHaveBeenCalledTimes(3);
    expect(job.close).toHaveBeenCalledTimes(1);
    expect(job.getAllResults).toHaveBeenCalledTimes(1);
  });

  it('should respect canStartNewJob() gate', async () => {
    const job = createMockJob();
    const deps = createMockDeps(job);

    // Fill up concurrent jobs to the limit
    for (let i = 0; i < 5; i++) {
      deps.bulkManager.registerJob({
        id: `existing-${i}`,
        operation: 'insert',
        object: 'Account',
        state: 'InProgress',
        numberRecordsProcessed: 0,
        numberRecordsFailed: 0,
        totalProcessingTime: 0,
        createdDate: new Date().toISOString(),
      });
    }

    await expect(
      executor.executeChunked(
        deps,
        'Account',
        'insert',
        toAsyncIterable([generateRecords(100)]),
        100,
      ),
    ).rejects.toThrow('Maximum concurrent bulk jobs reached');
  });

  it('should abort during upload phase and return aborted: true', async () => {
    const controller = new AbortController();
    const abortExecutor = new ChunkedBulkExecutor({
      chunkSize: 2000,
      pollIntervalMs: 0,
      signal: controller.signal,
    });

    const job = createMockJob();
    const deps = createMockDeps(job);

    let uploadCalls = 0;
    (job.uploadData as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      uploadCalls++;
      if (uploadCalls === 1) {
        controller.abort();
      }
    });

    const chunks = [
      generateRecords(2000),
      generateRecords(2000),
      generateRecords(2000),
    ];

    const result = await abortExecutor.executeChunked(
      deps,
      'Account',
      'insert',
      toAsyncIterable(chunks),
      6000,
    );

    expect(result.aborted).toBe(true);
    expect(result.totalRecords).toBe(2000);
    expect(uploadCalls).toBe(1);
    expect(job.close).toHaveBeenCalledTimes(1);
  });

  it('should abort during poll phase and return aborted: true', async () => {
    const controller = new AbortController();
    const abortExecutor = new ChunkedBulkExecutor({
      chunkSize: 2000,
      pollIntervalMs: 0,
      signal: controller.signal,
    });

    let checkCalls = 0;
    const job = createMockJob();
    (job.check as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      checkCalls++;
      if (checkCalls === 1) {
        controller.abort();
      }
      return { state: 'InProgress', numberRecordsProcessed: 0 };
    });
    const deps = createMockDeps(job);

    const chunks = [generateRecords(2000)];
    const result = await abortExecutor.executeChunked(
      deps,
      'Account',
      'insert',
      toAsyncIterable(chunks),
      2000,
    );

    expect(result.aborted).toBe(true);
  });

  it('should report upload progress after each chunk', async () => {
    const totalRecords = 4000;
    const results: BulkJobRecordResult[] = Array.from(
      { length: totalRecords },
      (_, i) => ({
        success: true,
        id: `001xx${String(i).padStart(7, '0')}`,
      }),
    );
    const job = createMockJob({ pollCount: 0, results });
    const deps = createMockDeps(job);

    const chunks = [generateRecords(2000), generateRecords(2000)];

    await executor.executeChunked(
      deps,
      'Account',
      'insert',
      toAsyncIterable(chunks),
      totalRecords,
    );

    const progressFn = deps.onProgress as ReturnType<typeof vi.fn>;
    // Upload phase progress calls: 2000/4000, then 4000/4000
    const uploadProgressCalls = progressFn.mock.calls.filter(
      ([processed]: [number, number]) => processed === 2000 || processed === 4000,
    );
    expect(uploadProgressCalls.length).toBeGreaterThanOrEqual(2);
    expect(uploadProgressCalls[0]).toEqual([2000, 4000]);
    expect(uploadProgressCalls[1]).toEqual([4000, 4000]);
  });

  it('should handle job results with failures', async () => {
    const results: BulkJobRecordResult[] = [
      { success: true, id: '001xx0000001' },
      { success: false, errors: ['DUPLICATE_VALUE'] },
      { success: true, id: '001xx0000003' },
      { success: false, errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION'] },
    ];
    const job = createMockJob({ pollCount: 0, results });
    const deps = createMockDeps(job);

    const result = await executor.executeChunked(
      deps,
      'Contact',
      'insert',
      toAsyncIterable([generateRecords(4)]),
      4,
    );

    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(2);
    expect(result.successIds).toEqual(['001xx0000001', '001xx0000003']);
    expect(result.errors).toContain('DUPLICATE_VALUE');
    expect(result.errors).toContain('FIELD_CUSTOM_VALIDATION_EXCEPTION');
  });

  describe('createChunkGenerator', () => {
    it('should yield correct chunk sizes', async () => {
      const records = generateRecords(5500);
      const chunks: Record<string, unknown>[][] = [];

      for await (const chunk of executor.createChunkGenerator(records)) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toHaveLength(2000);
      expect(chunks[1]).toHaveLength(2000);
      expect(chunks[2]).toHaveLength(1500);
    });

    it('should yield a single chunk for small arrays', async () => {
      const records = generateRecords(500);
      const chunks: Record<string, unknown>[][] = [];

      for await (const chunk of executor.createChunkGenerator(records)) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toHaveLength(500);
    });

    it('should yield nothing for empty arrays', async () => {
      const chunks: Record<string, unknown>[][] = [];

      for await (const chunk of executor.createChunkGenerator([])) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(0);
    });

    it('should respect custom chunk size', async () => {
      const records = generateRecords(1000);
      const chunks: Record<string, unknown>[][] = [];

      for await (const chunk of executor.createChunkGenerator(records, 300)) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(4);
      expect(chunks[0]).toHaveLength(300);
      expect(chunks[3]).toHaveLength(100);
    });
  });
});
