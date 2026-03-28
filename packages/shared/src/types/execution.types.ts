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
  /** Number of chunks processed so far (streaming mode only). */
  chunksProcessed?: number;
  /** Total number of chunks to process (streaming mode only). */
  totalChunks?: number;
}

/** Result of processing a single chunk within a streaming pipeline. */
export interface StreamingChunkResult {
  /** Number of records successfully processed in this chunk. */
  successCount: number;
  /** Number of records that failed in this chunk. */
  failureCount: number;
  /** Record IDs created by this chunk (for reference linking). */
  successIds: string[];
  /** Error messages from this chunk. */
  errors: string[];
}

/** Aggregate result of a streaming execution across all chunks. */
export interface StreamingExecutionResult {
  /** Total records submitted. */
  totalRecords: number;
  /** Total successfully processed. */
  successCount: number;
  /** Total failed. */
  failureCount: number;
  /** All created record IDs (accumulated across chunks). */
  successIds: string[];
  /** All error messages. */
  errors: string[];
  /** Whether execution was aborted. */
  aborted: boolean;
}

/** Status of a background operation. */
export type BackgroundOperationStatus = 'running' | 'completed' | 'failed' | 'aborted';

/** Metadata for an active or recently completed background operation. */
export interface ActiveOperation {
  /** Unique operation identifier. */
  operationId: string;
  /** Module that initiated the operation (sync, seed, clone). */
  module: string;
  /** Human-readable description. */
  description: string;
  /** Current status. */
  status: BackgroundOperationStatus;
  /** Overall progress percentage (0-100). */
  progressPercent: number;
  /** Timestamp (ms) when the operation started. */
  startedAt: number;
  /** Timestamp (ms) when the operation completed (if finished). */
  completedAt?: number;
  /** Summary of result (e.g., "45,230 records processed"). */
  resultSummary?: string;
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
