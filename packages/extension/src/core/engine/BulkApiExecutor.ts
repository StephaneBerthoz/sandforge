import { BulkApiManager, type BulkJobInfo, type BulkJobStatus } from './BulkApiManager.js';
import { SF_LIMITS } from '@sandforge/shared';

/** Result of a bulk API execution */
export interface BulkExecutionResult {
  /** Total number of records submitted */
  totalRecords: number;
  /** Number of successfully processed records */
  successCount: number;
  /** Number of failed records */
  failureCount: number;
  /** Details of individual record failures */
  failures: BulkRecordFailure[];
  /** Salesforce Bulk API job ID */
  jobId: string;
  /** Whether Bulk API 2.0 was used (vs REST) */
  usedBulkApi: boolean;
  /** Real Salesforce record IDs for successfully processed records */
  successIds: string[];
  /**
   * Per-input-record outcomes, aligned with the input order (one entry per
   * submitted record). IDs are the real Salesforce IDs returned by the job —
   * never fabricated.
   */
  outcomes: BulkRecordOutcome[];
  /**
   * Set when the run's cancel aborted the job before it was closed:
   * Salesforce processed none of its records, and `outcomes` is empty.
   */
  aborted?: boolean;
}

/** A single record failure from a bulk job */
export interface BulkRecordFailure {
  /** Zero-based index of the failed record in the input array (-1 when the failure could not be attributed) */
  recordIndex: number;
  /** Error description from Salesforce */
  error: string;
}

/** Outcome of a single input record after a bulk job. */
export interface BulkRecordOutcome {
  /** Zero-based index of the record in the input array. */
  recordIndex: number;
  /** Real Salesforce record ID on success (absent when the backend omitted it — never fabricated). */
  id?: string;
  /** Whether this record was processed successfully. */
  success: boolean;
  /** Error message on failure. */
  error?: string;
  /**
   * For an upsert, whether the job created the record (true) or updated one
   * (false), from its `sf__Created` column. Absent when the row does not say.
   */
  created?: boolean;
}

/**
 * Real jsforce Bulk API 2.0 ingest result shape, as returned by
 * `JobV2.getAllResults()`. Every row echoes the uploaded record columns
 * plus `sf__Id` / `sf__Error` — that echo is what allows honest
 * result-to-record attribution.
 */
export interface JsforceIngestJobResults {
  successfulResults?: Array<Record<string, unknown>>;
  failedResults?: Array<Record<string, unknown>>;
  unprocessedRecords?: Array<Record<string, unknown>> | string;
}

/** Normalized view of a bulk job's results (see normalizeBulkJobResults). */
export interface NormalizedBulkResults {
  /** Exactly `records.length` entries, in input order. */
  outcomes: BulkRecordOutcome[];
  /** Real IDs of success rows that could not be attributed to an input record. */
  unattributedSuccessIds: string[];
  /** Errors of failure rows that could not be attributed to an input record. */
  unattributedFailures: string[];
}

/**
 * Build a content-correlation key for a record. Bulk API 2.0 result rows
 * round-trip through CSV, so every value is normalized with String() on both
 * sides (null/undefined collapse to the empty string, matching CSV output).
 */
function correlationKey(record: Record<string, unknown>): string {
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const value = record[key];
    if (value === null || value === undefined) {
      parts.push(`${key}=`);
    } else if (typeof value === 'object') {
      parts.push(`${key}=${JSON.stringify(value)}`);
    } else {
      parts.push(`${key}=${String(value)}`);
    }
  }
  return parts.join('');
}

/**
 * Remove Bulk API 2.0 metadata keys (`sf__Id`, `sf__Created`, `sf__Error`)
 * from a result row so only the original uploaded columns remain for
 * content correlation.
 */
function stripBulkMetadataKeys(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith('sf__')) continue;
    out[key] = value;
  }
  return out;
}

/**
 * The `sf__Created` column of a successful row: what an upsert did with the
 * record. A result read as CSV holds it as text.
 */
function createdFlag(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}

/**
 * Normalize bulk job results into per-input-record outcomes.
 *
 * Two input shapes are supported:
 *  - the legacy flat `BulkJobRecordResult[]` (test doubles), treated as
 *    already input-ordered;
 *  - the real jsforce `{ successfulResults, failedResults, unprocessedRecords }`
 *    shape, whose rows are correlated back to input records by content
 *    (Salesforce does NOT guarantee result ordering relative to the upload).
 *
 * Records that no result row claims are failed-closed with an explicit
 * "No result returned" error instead of being silently assumed successful —
 * the previous "first successCount records succeeded" assumption mixed up
 * successes and failures whenever a job had partial errors.
 *
 * @param rawResults - Raw value returned by `job.getAllResults()`.
 * @param records - The input records submitted to the job.
 */
export function normalizeBulkJobResults(
  rawResults: BulkJobRecordResult[] | JsforceIngestJobResults,
  records: Record<string, unknown>[],
): NormalizedBulkResults {
  const outcomes: BulkRecordOutcome[] = [];
  const unattributedSuccessIds: string[] = [];
  const unattributedFailures: string[] = [];
  const claimed = new Array<boolean>(records.length).fill(false);

  const claim = (id: string | undefined, recordIndex: number, created?: boolean): void => {
    if (recordIndex >= 0 && recordIndex < records.length && !claimed[recordIndex]) {
      claimed[recordIndex] = true;
      outcomes.push({
        recordIndex,
        id,
        success: true,
        ...(created !== undefined ? { created } : {}),
      });
    } else if (id !== undefined) {
      unattributedSuccessIds.push(id);
    }
  };
  const claimFailure = (error: string, recordIndex: number): void => {
    if (recordIndex >= 0 && recordIndex < records.length && !claimed[recordIndex]) {
      claimed[recordIndex] = true;
      outcomes.push({ recordIndex, success: false, error });
    } else {
      unattributedFailures.push(error);
    }
  };

  if (Array.isArray(rawResults)) {
    // Legacy flat shape: rows are already input-ordered.
    rawResults.forEach((row, i) => {
      if (row.success) {
        claim(row.id, i);
      } else {
        claimFailure(row.errors?.join(', ') ?? 'Unknown error', i);
      }
    });
  } else {
    // Real jsforce shape: correlate result rows to input records by content.
    const indexByKey = new Map<string, number[]>();
    records.forEach((record, i) => {
      const key = correlationKey(record);
      const queue = indexByKey.get(key);
      if (queue) {
        queue.push(i);
      } else {
        indexByKey.set(key, [i]);
      }
    });
    const takeIndex = (row: Record<string, unknown>): number => {
      const queue = indexByKey.get(correlationKey(stripBulkMetadataKeys(row)));
      return queue && queue.length > 0 ? queue.shift()! : -1;
    };

    for (const row of rawResults.successfulResults ?? []) {
      claim(
        typeof row['sf__Id'] === 'string' ? (row['sf__Id'] as string) : undefined,
        takeIndex(row),
        createdFlag(row['sf__Created']),
      );
    }
    for (const row of rawResults.failedResults ?? []) {
      const error =
        typeof row['sf__Error'] === 'string' && row['sf__Error'].length > 0
          ? (row['sf__Error'] as string)
          : 'Unknown error';
      claimFailure(error, takeIndex(row));
    }
    const unprocessed = rawResults.unprocessedRecords;
    if (Array.isArray(unprocessed)) {
      for (const row of unprocessed) {
        claimFailure('Record not processed by Bulk API job', takeIndex(row));
      }
    }
  }

  // Any input record that no result row claimed got no outcome at all —
  // fail closed instead of assuming success.
  records.forEach((_record, i) => {
    if (!claimed[i]) {
      claimFailure('No result returned by Bulk API job', i);
    }
  });

  outcomes.sort((a, b) => a.recordIndex - b.recordIndex);
  return { outcomes, unattributedSuccessIds, unattributedFailures };
}

/** Supported bulk operations */
export type BulkOperation = 'insert' | 'update' | 'upsert' | 'delete' | 'hardDelete';

/**
 * Represents a jsforce Bulk API 2.0 job handle.
 * This interface abstracts jsforce internals for testability.
 *
 * Note on `getAllResults`: real jsforce returns the grouped
 * {@link JsforceIngestJobResults} shape; test doubles return the flat
 * input-ordered `BulkJobRecordResult[]`. {@link normalizeBulkJobResults}
 * accepts both.
 */
export interface BulkJobHandle {
  id?: string;
  open: () => Promise<void>;
  uploadData: (records: Record<string, unknown>[]) => Promise<void>;
  /** Mark the upload complete (`UploadComplete`): Salesforce then processes the job's data. */
  close: () => Promise<void>;
  /** Mark the job `Aborted`: Salesforce processes none of its data. */
  abort: () => Promise<void>;
  check: () => Promise<BulkJobCheckResult>;
  getAllResults: () => Promise<BulkJobRecordResult[] | JsforceIngestJobResults>;
}

/** Result of checking a bulk job status */
export interface BulkJobCheckResult {
  state: BulkJobStatus;
  numberRecordsProcessed?: number;
}

/** Individual record result from bulk job */
export interface BulkJobRecordResult {
  /** Whether this individual record was processed successfully */
  success: boolean;
  /** Salesforce record ID (present on success for insert/upsert operations) */
  id?: string;
  /** Error messages for failed records */
  errors?: string[];
}

/** Connection abstraction for creating Bulk API 2.0 jobs */
export interface BulkApiConnection {
  bulk2: {
    createJob: (opts: {
      operation: BulkOperation;
      object: string;
      externalIdFieldName?: string;
    }) => BulkJobHandle;
  };
}

/** Dependencies required by BulkApiExecutor */
export interface BulkApiExecutorDeps {
  /** jsforce connection (abstracted for testability) */
  connection: BulkApiConnection;
  /** BulkApiManager for job tracking */
  bulkManager: BulkApiManager;
  /** Optional progress callback (processed, total) */
  onProgress?: (processed: number, total: number) => void;
  /**
   * The run's cancel. It aborts the job while the job is still open; once the
   * job is closed, Salesforce writes all of it, and it is awaited and counted.
   */
  signal?: AbortSignal;
}

/**
 * Abort a job that was never closed. A failed abort leaves it open, and an
 * open job is never processed either: nothing of it is written, so the
 * failure is not the run's.
 */
export async function abortOpenJob(job: BulkJobHandle): Promise<void> {
  try {
    await job.abort();
  } catch {
    // Left open, the job is never processed.
  }
}

/**
 * Selects between REST API and Bulk API 2.0 based on record count
 * and executes bulk operations via jsforce with BulkApiManager tracking.
 */
export class BulkApiExecutor {
  private readonly threshold: number;

  constructor(threshold: number = SF_LIMITS.REST_API_BATCH_SIZE) {
    this.threshold = threshold;
  }

  /** Determine whether Bulk API should be used for the given record count */
  shouldUseBulkApi(recordCount: number): boolean {
    return recordCount > this.threshold;
  }

  /** Get the configured threshold for switching to Bulk API */
  getThreshold(): number {
    return this.threshold;
  }

  /**
   * Execute a DML operation via Bulk API 2.0.
   * Creates a job, uploads data, polls until completion, and returns results.
   * The job is tracked via BulkApiManager throughout its lifecycle.
   *
   * @param deps - Connection, manager, and progress callback
   * @param objectName - Salesforce object API name
   * @param operation - DML operation type
   * @param records - Records to process
   * @param externalIdField - External ID field for upsert operations
   */
  async executeBulk(
    deps: BulkApiExecutorDeps,
    objectName: string,
    operation: BulkOperation,
    records: Record<string, unknown>[],
    externalIdField?: string,
  ): Promise<BulkExecutionResult> {
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
    };
    deps.bulkManager.registerJob(jobInfo);
    try {
      await job.open();

      /*
       * A cancel before the job is closed aborts it, as the streaming upload
       * does. Salesforce processes a job's data only once the job is closed,
       * and never an aborted one's. The job used to be closed whatever the run
       * said: a cancel that came during the upload of up to ten thousand
       * records had every one of them written. Once closed, the job is awaited
       * and counted like any other.
       */
      let uploaded = 0;
      if (!deps.signal?.aborted) {
        await job.uploadData(records);
        uploaded = records.length;
      }
      if (deps.signal?.aborted) {
        await abortOpenJob(job);
        deps.bulkManager.updateJobState(jobId, 'Aborted');
        return {
          totalRecords: uploaded,
          successCount: 0,
          failureCount: 0,
          failures: [],
          jobId,
          usedBulkApi: true,
          successIds: [],
          outcomes: [],
          aborted: true,
        };
      }
      await job.close();

      let status = await job.check();
      while (status.state === 'InProgress' || status.state === 'UploadComplete') {
        deps.bulkManager.updateJobState(jobId, status.state);
        deps.onProgress?.(status.numberRecordsProcessed ?? 0, records.length);
        await new Promise((r) => setTimeout(r, 5000));
        status = await job.check();
      }

      const results = await job.getAllResults();
      const normalized = normalizeBulkJobResults(results, records);

      const failures: BulkRecordFailure[] = normalized.outcomes
        .filter((o) => !o.success)
        .map((o) => ({ recordIndex: o.recordIndex, error: o.error ?? 'Unknown error' }));
      for (const error of normalized.unattributedFailures) {
        failures.push({ recordIndex: -1, error });
      }

      // Real IDs only — the previous `bulk-${jobId}-${i}` fallback fabricated
      // IDs that downstream consumers (remap tables, history) treated as real.
      const successIds = normalized.outcomes
        .filter((o) => o.success && o.id !== undefined)
        .map((o) => o.id as string)
        .concat(normalized.unattributedSuccessIds);
      const successCount =
        normalized.outcomes.filter((o) => o.success).length +
        normalized.unattributedSuccessIds.length;

      const finalState: BulkJobStatus = status.state === 'JobComplete' ? 'JobComplete' : 'Failed';
      deps.bulkManager.updateJobState(jobId, finalState);
      deps.bulkManager.updateJobCounts(
        jobId,
        status.numberRecordsProcessed ?? records.length,
        failures.length,
      );

      return {
        totalRecords: records.length,
        successCount,
        failureCount: failures.length,
        failures,
        jobId,
        usedBulkApi: true,
        successIds,
        outcomes: normalized.outcomes,
      };
    } catch (err: unknown) {
      // The limiter counts this job until it reaches a terminal state, and it
      // outlives the run: a job that threw mid-flight has to free its slot,
      // or the window loses one Bulk API slot for good.
      deps.bulkManager.updateJobState(jobId, 'Failed');
      throw err;
    }
  }
}
