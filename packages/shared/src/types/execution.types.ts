/**
 * Types for execution progress tracking and error recovery.
 *
 * Used by the BulkJobProgressTracker (extension) and the
 * ObjectProgressPanel / ErrorRecoveryPanel (webview) to communicate
 * real-time per-object progress and retry state via the message bus.
 */

/** Per-object progress state during a bulk execution. */
export interface ObjectProgress {
  /** Salesforce object API name (e.g. "Account"). */
  objectName: string;
  /** Bulk API 2.0 job ID. */
  jobId: string;
  /** DML operation being performed. */
  operation: string;
  /** Number of records processed so far. */
  recordsProcessed: number;
  /** Number of records that failed. */
  recordsFailed: number;
  /** Total records to process. */
  totalRecords: number;
  /** Current job state. */
  state: 'queued' | 'processing' | 'complete' | 'failed' | 'aborted';
  /** Timestamp (ms) when the job started. */
  startedAt: number;
  /** Estimated time remaining in milliseconds, if computable. */
  estimatedCompletionMs?: number;
}

/** Aggregate execution progress across all objects. */
export interface BulkExecutionProgress {
  /** Unique execution identifier. */
  executionId: string;
  /** Per-object progress array. */
  objects: ObjectProgress[];
  /** Weighted overall percentage (0-100). */
  overallPercent: number;
  /** Elapsed time since execution start in milliseconds. */
  elapsedMs: number;
}

/** Retry status for a single object within an execution. */
export interface RetryStatus {
  /** Execution identifier. */
  executionId: string;
  /** Salesforce object API name. */
  objectName: string;
  /** Current attempt number (1-based). */
  attemptNumber: number;
  /** Maximum attempts allowed. */
  maxAttempts: number;
  /** Timestamp (ms) of next retry, or null if exhausted/manual only. */
  nextRetryAt: number | null;
  /** Last error message. */
  lastError: string;
  /** Whether a retry can be triggered. */
  canRetry: boolean;
  /** Whether the operation can be aborted. */
  canAbort: boolean;
}
