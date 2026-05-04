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
}

/** A single record failure from a bulk job */
export interface BulkRecordFailure {
  /** Zero-based index of the failed record in the input array */
  recordIndex: number;
  /** Error description from Salesforce */
  error: string;
}

/** Supported bulk operations */
export type BulkOperation = 'insert' | 'update' | 'upsert' | 'delete' | 'hardDelete';

/**
 * Represents a jsforce Bulk API 2.0 job handle.
 * This interface abstracts jsforce internals for testability.
 */
export interface BulkJobHandle {
  id?: string;
  open: () => Promise<void>;
  uploadData: (records: Record<string, unknown>[]) => Promise<void>;
  close: () => Promise<void>;
  check: () => Promise<BulkJobCheckResult>;
  getAllResults: () => Promise<BulkJobRecordResult[]>;
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
    };
    deps.bulkManager.registerJob(jobInfo);

    await job.open();
    await job.uploadData(records);
    await job.close();

    let status = await job.check();
    while (status.state === 'InProgress' || status.state === 'UploadComplete') {
      deps.bulkManager.updateJobState(jobId, status.state);
      deps.onProgress?.(status.numberRecordsProcessed ?? 0, records.length);
      await new Promise((r) => setTimeout(r, 5000));
      status = await job.check();
    }

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

    const finalState: BulkJobStatus = status.state === 'JobComplete' ? 'JobComplete' : 'Failed';
    deps.bulkManager.updateJobState(jobId, finalState);
    deps.bulkManager.updateJobCounts(
      jobId,
      status.numberRecordsProcessed ?? records.length,
      failures.length,
    );

    return {
      totalRecords: records.length,
      successCount: records.length - failures.length,
      failureCount: failures.length,
      failures,
      jobId,
      usedBulkApi: true,
      successIds,
    };
  }
}
