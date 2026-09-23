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
  const results: BulkJobRecordResult[] = opts?.results ?? [];

  return {
    id: 'job-chunked-001',
    open: vi.fn().mockResolvedValue(undefined),
    uploadData: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
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
    const results: BulkJobRecordResult[] = Array.from({ length: totalRecords }, (_, i) => ({
      success: true,
      id: `001xx${String(i).padStart(7, '0')}`,
    }));
    const job = createMockJob({ pollCount: 1, results });
    const deps = createMockDeps(job);

    const chunks = [generateRecords(2000), generateRecords(2000), generateRecords(2000)];

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

  describe('a cancel', () => {
    /** An executor the controller cancels. */
    function cancellable(controller: AbortController): ChunkedBulkExecutor {
      return new ChunkedBulkExecutor({
        chunkSize: 2000,
        pollIntervalMs: 0,
        signal: controller.signal,
      });
    }

    it('aborts the job still open, and never closes it, so none of it is written', async () => {
      // The job used to be closed here: closing hands its data to Salesforce
      // for processing, so the chunk uploaded before the cancel was written,
      // and the run reported nothing written.
      const controller = new AbortController();
      const job = createMockJob();
      const deps = createMockDeps(job);
      let uploadCalls = 0;
      vi.mocked(job.uploadData).mockImplementation(async () => {
        uploadCalls++;
        if (uploadCalls === 1) controller.abort();
      });

      const result = await cancellable(controller).executeChunked(
        deps,
        'Account',
        'insert',
        toAsyncIterable([generateRecords(2000), generateRecords(2000), generateRecords(2000)]),
        6000,
      );

      expect(uploadCalls).toBe(1);
      expect(job.abort).toHaveBeenCalledTimes(1);
      expect(job.close).not.toHaveBeenCalled();
      expect(job.check).not.toHaveBeenCalled();
      expect(result).toMatchObject({ aborted: true, successCount: 0, successIds: [] });
      expect(deps.bulkManager.getJob('job-chunked-001')?.state).toBe('Aborted');
    });

    it('aborts the job when the cancel comes while its last chunk is uploaded', async () => {
      const controller = new AbortController();
      const job = createMockJob();
      const deps = createMockDeps(job);
      vi.mocked(job.uploadData).mockImplementation(async () => {
        controller.abort();
      });

      const result = await cancellable(controller).executeChunked(
        deps,
        'Account',
        'insert',
        toAsyncIterable([generateRecords(2000)]),
        2000,
      );

      expect(job.abort).toHaveBeenCalledTimes(1);
      expect(job.close).not.toHaveBeenCalled();
      expect(result.aborted).toBe(true);
    });

    it('leaves the job open, and still writes nothing, when the abort itself fails', async () => {
      const controller = new AbortController();
      controller.abort();
      const job = createMockJob();
      vi.mocked(job.abort).mockRejectedValue(new Error('socket hang up'));
      const deps = createMockDeps(job);

      const result = await cancellable(controller).executeChunked(
        deps,
        'Account',
        'insert',
        toAsyncIterable([generateRecords(10)]),
        10,
      );

      expect(job.close).not.toHaveBeenCalled();
      expect(result.aborted).toBe(true);
      // The limiter's slot is freed all the same.
      expect(deps.bulkManager.canStartNewJob()).toBe(true);
    });

    it('awaits a job already closed, and counts what Salesforce wrote of it', async () => {
      // A closed job is written whatever the run does: returning at the
      // cancel left its records written and counted as nothing.
      const controller = new AbortController();
      const results: BulkJobRecordResult[] = [
        { success: true, id: '001xx0000001' },
        { success: false, errors: ['DUPLICATE_VALUE'] },
      ];
      const job = createMockJob({ pollCount: 2, results });
      const check = vi.mocked(job.check).getMockImplementation();
      vi.mocked(job.check).mockImplementation(async () => {
        controller.abort();
        return check!();
      });
      const deps = createMockDeps(job);

      const result = await cancellable(controller).executeChunked(
        deps,
        'Account',
        'insert',
        toAsyncIterable([generateRecords(2)]),
        2,
      );

      expect(job.abort).not.toHaveBeenCalled();
      expect(job.getAllResults).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        aborted: false,
        successCount: 1,
        failureCount: 1,
        successIds: ['001xx0000001'],
      });
      expect(deps.bulkManager.getJob('job-chunked-001')?.state).toBe('JobComplete');
    });
  });

  it('should report upload progress after each chunk', async () => {
    const totalRecords = 4000;
    const results: BulkJobRecordResult[] = Array.from({ length: totalRecords }, (_, i) => ({
      success: true,
      id: `001xx${String(i).padStart(7, '0')}`,
    }));
    const job = createMockJob({ pollCount: 0, results });
    const deps = createMockDeps(job);

    const chunks = [generateRecords(2000), generateRecords(2000)];

    await executor.executeChunked(deps, 'Account', 'insert', toAsyncIterable(chunks), totalRecords);

    const progressFn = deps.onProgress as ReturnType<typeof vi.fn>;
    // Upload phase progress calls: 2000/4000, then 4000/4000
    const uploadProgressCalls = progressFn.mock.calls.filter(
      ([processed]: number[]) => processed === 2000 || processed === 4000,
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

  it('frees the job slot when a chunk upload throws mid-flight', async () => {
    const job = createMockJob();
    job.uploadData = vi.fn().mockRejectedValue(new Error('connection reset'));
    const connection: BulkApiConnection = {
      bulk2: { createJob: vi.fn().mockReturnValue(job) },
    };
    // The limiter outlives the run, so a job that never reaches a terminal
    // state would hold its slot for the life of the window.
    const manager = new BulkApiManager(1);

    await expect(
      executor.executeChunked(
        { connection, bulkManager: manager },
        'Account',
        'insert',
        toAsyncIterable([generateRecords(10)]),
        10,
      ),
    ).rejects.toThrow('connection reset');

    expect(manager.canStartNewJob()).toBe(true);
  });

  it('tracks two jobs opened in the same millisecond separately', async () => {
    const manager = new BulkApiManager(2);
    const run = (): Promise<unknown> => {
      // jsforce leaves `id` undefined until the job is opened, so both jobs
      // reach the limiter without a Salesforce id of their own.
      const job = createMockJob();
      job.id = undefined;
      const connection: BulkApiConnection = {
        bulk2: { createJob: vi.fn().mockReturnValue(job) },
      };
      return executor.executeChunked(
        { connection, bulkManager: manager },
        'Account',
        'insert',
        toAsyncIterable([generateRecords(10)]),
        10,
      );
    };

    /* The clock is held still so that two jobs opened without an id of their
       own are indistinguishable by time: keying them by the clock would give
       both the same key and lose one, whatever the machine's timing. Only
       `Date.now` is frozen — the executor polls on a timer and would never
       settle under fake timers. */
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    try {
      const first = run();
      const second = run();
      expect(manager.getActiveJobs()).toHaveLength(2);
      await Promise.all([first, second]);
    } finally {
      now.mockRestore();
    }
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
