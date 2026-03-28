import type { StreamingExecutionResult } from '@sandforge/shared';
import type {
  BulkApiExecutorDeps,
  BulkOperation,
  BulkJobHandle,
  BulkRecordFailure,
} from './BulkApiExecutor.js';
import type { BulkJobInfo, BulkJobStatus } from './BulkApiManager.js';

/** Default number of records per upload chunk. */
const DEFAULT_CHUNK_SIZE = 2000;

/** Default polling interval in milliseconds. */
const DEFAULT_POLL_INTERVAL_MS = 5000;

/** Configuration for the chunked bulk executor. */
export interface ChunkedBulkConfig {
  /** Records per upload chunk (default 2000). */
  chunkSize: number;
  /** Polling interval in ms (default 5000). */
  pollIntervalMs: number;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

/**
 * Executes a Bulk API 2.0 job with chunked uploads.
 *
 * Opens a single Bulk API 2.0 job, uploads records in multiple batches
 * (default 2000 records each) via successive `uploadData()` calls, then
 * closes the job and polls until completion. This avoids loading all records
 * into memory at once.
 */
export class ChunkedBulkExecutor {
  private readonly chunkSize: number;
  private readonly pollIntervalMs: number;
  private readonly signal?: AbortSignal;

  constructor(config: Partial<ChunkedBulkConfig> = {}) {
    this.chunkSize = config.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.signal = config.signal;
  }

  /**
   * Execute a chunked Bulk API 2.0 operation.
   *
   * @param deps - Connection, BulkApiManager, and progress callback.
   * @param objectName - Salesforce object API name.
   * @param operation - DML operation type.
   * @param recordChunks - Async iterable yielding arrays of records.
   * @param totalRecords - Total number of records (for progress calculation).
   * @param externalIdField - External ID field for upsert operations.
   * @returns Aggregate execution result.
   */
  async executeChunked(
    deps: BulkApiExecutorDeps,
    objectName: string,
    operation: BulkOperation,
    recordChunks: AsyncIterable<Record<string, unknown>[]>,
    totalRecords: number,
    externalIdField?: string,
  ): Promise<StreamingExecutionResult> {
    if (!deps.bulkManager.canStartNewJob()) {
      throw new Error('Maximum concurrent bulk jobs reached');
    }

    const job = deps.connection.bulk2.createJob({
      operation,
      object: objectName,
      ...(externalIdField ? { externalIdFieldName: externalIdField } : {}),
    });

    const jobId = job.id ?? `bulk-${Date.now()}`;
    const jobInfo: BulkJobInfo = {
      id: jobId,
      operation,
      object: objectName,
      state: 'UploadComplete',
      numberRecordsProcessed: 0,
      numberRecordsFailed: 0,
      totalProcessingTime: 0,
      createdDate: new Date().toISOString(),
      totalRecords,
    };
    deps.bulkManager.registerJob(jobInfo);

    await job.open();

    // Upload phase: stream chunks into the open job
    let uploadedRecords = 0;
    for await (const chunk of recordChunks) {
      if (this.signal?.aborted) {
        await this.closeJobSafely(job);
        deps.bulkManager.updateJobState(jobId, 'Aborted');
        return this.buildAbortedResult(uploadedRecords);
      }

      await job.uploadData(chunk);
      uploadedRecords += chunk.length;
      deps.onProgress?.(uploadedRecords, totalRecords);
    }

    await job.close();

    // Poll phase: wait for Salesforce to finish processing
    let status = await job.check();
    while (status.state === 'InProgress' || status.state === 'UploadComplete') {
      if (this.signal?.aborted) {
        deps.bulkManager.updateJobState(jobId, 'Aborted');
        return this.buildAbortedResult(uploadedRecords);
      }

      deps.bulkManager.updateJobState(jobId, status.state);
      deps.onProgress?.(
        status.numberRecordsProcessed ?? 0,
        totalRecords,
      );
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      status = await job.check();
    }

    // Results phase: parse job results
    const results = await job.getAllResults();
    const failures: BulkRecordFailure[] = [];
    const successIds: string[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.success) {
        successIds.push(r.id ?? `bulk-${jobId}-${i}`);
      } else {
        failures.push({
          recordIndex: i,
          error: r.errors?.join(', ') ?? 'Unknown error',
        });
      }
    }

    const finalState: BulkJobStatus =
      status.state === 'JobComplete' ? 'JobComplete' : 'Failed';
    deps.bulkManager.updateJobState(jobId, finalState);
    deps.bulkManager.updateJobCounts(
      jobId,
      status.numberRecordsProcessed ?? totalRecords,
      failures.length,
    );

    return {
      totalRecords: uploadedRecords,
      successCount: uploadedRecords - failures.length,
      failureCount: failures.length,
      successIds,
      errors: failures.map((f) => f.error),
      aborted: false,
    };
  }

  /**
   * Create an async generator that yields chunks from a flat array.
   *
   * Useful when callers have all records in memory but want to use
   * the chunked upload API to limit per-call memory usage.
   *
   * @param records - Full array of records.
   * @param chunkSize - Number of records per chunk (defaults to instance chunkSize).
   */
  async *createChunkGenerator(
    records: Record<string, unknown>[],
    chunkSize?: number,
  ): AsyncGenerator<Record<string, unknown>[]> {
    const size = chunkSize ?? this.chunkSize;
    for (let i = 0; i < records.length; i += size) {
      yield records.slice(i, i + size);
    }
  }

  /** Safely close a job, swallowing errors if the job is already closed. */
  private async closeJobSafely(job: BulkJobHandle): Promise<void> {
    try {
      await job.close();
    } catch {
      // Job may already be closed or in an invalid state -- ignore.
    }
  }

  /** Build a StreamingExecutionResult for an aborted execution. */
  private buildAbortedResult(uploadedRecords: number): StreamingExecutionResult {
    return {
      totalRecords: uploadedRecords,
      successCount: 0,
      failureCount: 0,
      successIds: [],
      errors: [],
      aborted: true,
    };
  }
}
