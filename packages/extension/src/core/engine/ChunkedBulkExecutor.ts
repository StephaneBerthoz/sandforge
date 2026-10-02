import type { StreamingExecutionResult } from '@sandforge/shared';
import { abortOpenJob, jobErrorOf, normalizeBulkJobResults } from './BulkApiExecutor.js';
import type { BulkApiExecutorDeps, BulkOperation, BulkRecordOutcome } from './BulkApiExecutor.js';
import type { BulkJobInfo, BulkJobStatus } from './BulkApiManager.js';
import { buildBulkCsv, type BulkCsv } from './bulkCsv.js';

/**
 * Result of a chunked bulk execution. Extends the shared streaming result
 * with per-input-record outcomes.
 */
export interface ChunkedExecutionResult extends StreamingExecutionResult {
  /**
   * Per-input-record outcomes in input order (real Salesforce IDs, honest
   * failure attribution). Absent from a job the cancel aborted.
   */
  outcomes?: BulkRecordOutcome[];
  /**
   * Ids of records the job wrote that no row could be matched to: in
   * `successIds`, on no outcome. Each row left without a result names them.
   */
  unmatchedIds?: string[];
}

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
  /**
   * The run's cancel. It aborts the job while the job is still open; once the
   * job is closed, Salesforce writes all of it, and it is awaited and counted.
   */
  signal?: AbortSignal;
}

/**
 * Executes a Bulk API 2.0 job for a large record set read in chunks.
 *
 * Opens a single Bulk API 2.0 job, reads the records chunk by chunk (default
 * 2000 each), looking at the run's cancel between two of them, uploads them
 * as one CSV, then closes the job and polls until completion. One upload:
 * jsforce refuses a second one to the same job ("Data can only be uploaded to
 * a job once"), and the chunks were uploaded one call each, so a write of
 * more than one chunk threw at its second, with nothing written. One CSV, too,
 * whose header names every field any of the records carries: see
 * `buildBulkCsv`.
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
   * @returns Aggregate execution result, with each record's outcome.
   */
  async executeChunked(
    deps: BulkApiExecutorDeps,
    objectName: string,
    operation: BulkOperation,
    recordChunks: AsyncIterable<Record<string, unknown>[]>,
    totalRecords: number,
    externalIdField?: string,
  ): Promise<ChunkedExecutionResult> {
    if (!deps.bulkManager.canStartNewJob()) {
      throw new Error('Maximum concurrent bulk jobs reached');
    }

    const job = deps.connection.bulk2.createJob({
      operation,
      object: objectName,
      ...(externalIdField ? { externalIdFieldName: externalIdField } : {}),
    });

    // Tracked under an id of our own when Salesforce has not assigned one yet
    // (jsforce fills `job.id` only once the job is open): the limiter's map is
    // window-lived, and two jobs keyed on the same millisecond overwrote each
    // other, undercounting the cap and crossing their record counts.
    const jobId = job.id ?? `bulk-${crypto.randomUUID()}`;
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
    try {
      await job.open();

      // Read phase: gather the chunks, then upload them in one CSV.
      const records: Record<string, unknown>[] = [];
      for await (const chunk of recordChunks) {
        if (this.signal?.aborted) break;
        for (const record of chunk) records.push(record);
        deps.onProgress?.(records.length, totalRecords);
      }
      let upload: BulkCsv | undefined;
      let uploadedRecords = 0;
      if (!this.signal?.aborted) {
        upload = buildBulkCsv(operation, records, externalIdField);
        await job.uploadData(upload.text);
        uploadedRecords = records.length;
      }

      /*
       * A cancel before the job is closed aborts it. Salesforce processes a
       * job's data only once the job is closed, and never an aborted one's.
       * The job used to be closed here instead, which hands its data over for
       * processing: every chunk uploaded before the cancel was written, and
       * reported as nothing. The upload is covered as well — a cancel that
       * came during it closed the job too.
       */
      if (this.signal?.aborted || upload === undefined) {
        await abortOpenJob(job);
        deps.bulkManager.updateJobState(jobId, 'Aborted');
        return this.buildAbortedResult(uploadedRecords);
      }

      await job.close();

      // Poll phase: wait for Salesforce to finish processing. A cancel no
      // longer stops the wait: the job is closed and Salesforce writes all of
      // it whatever happens here, so its results are read and counted like
      // those of any job. Returning early left them written and uncounted.
      let status = await job.check();
      while (status.state === 'InProgress' || status.state === 'UploadComplete') {
        deps.bulkManager.updateJobState(jobId, status.state);
        deps.onProgress?.(status.numberRecordsProcessed ?? 0, totalRecords);
        await new Promise((r) => setTimeout(r, this.pollIntervalMs));
        status = await job.check();
      }

      // Results phase: each result given the row it echoes. Both the legacy
      // flat shape (test doubles) and the real jsforce grouped shape are
      // normalized; IDs are the real Salesforce IDs (the old
      // `bulk-${jobId}-${i}` fallback fabricated them).
      const results = await job.getAllResults();
      const normalized = normalizeBulkJobResults(results, upload, jobErrorOf(status));
      const outcomes = normalized.outcomes;
      const successIds: string[] = [];
      const failureErrors: string[] = [];
      let successCount = normalized.unattributedSuccessIds.length;
      for (const outcome of outcomes) {
        if (outcome.success) {
          successCount++;
          if (outcome.id !== undefined) successIds.push(outcome.id);
        } else {
          failureErrors.push(outcome.error ?? 'Unknown error');
        }
      }
      successIds.push(...normalized.unattributedSuccessIds);
      failureErrors.push(...normalized.unattributedFailures);

      const finalState: BulkJobStatus = status.state === 'JobComplete' ? 'JobComplete' : 'Failed';
      deps.bulkManager.updateJobState(jobId, finalState);
      deps.bulkManager.updateJobCounts(
        jobId,
        status.numberRecordsProcessed ?? totalRecords,
        failureErrors.length,
      );

      return {
        totalRecords: uploadedRecords,
        successCount,
        failureCount: failureErrors.length,
        successIds,
        errors: failureErrors,
        aborted: false,
        outcomes,
        ...(normalized.unattributedSuccessIds.length > 0
          ? { unmatchedIds: normalized.unattributedSuccessIds }
          : {}),
      };
    } catch (err: unknown) {
      // The limiter counts this job until it reaches a terminal state, and it
      // outlives the run: a job that threw mid-flight has to free its slot,
      // or the window loses one Bulk API slot for good.
      deps.bulkManager.updateJobState(jobId, 'Failed');
      throw err;
    }
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

  /**
   * The result of a job the cancel aborted before it was closed: nothing
   * written, and the records uploaded to it discarded with it.
   */
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
