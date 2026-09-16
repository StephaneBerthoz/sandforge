import type { BaseMessage } from './base.messages.js';
import type { BackgroundOperationStatus, RetryStatus } from '../execution.types.js';

/** Operation lifecycle messages */
/** Notification that an operation has started executing */
export interface OperationStarted extends BaseMessage {
  type: 'operation:started';
  payload: { operationId: string; module: string; description: string };
}

/** Progress update for a running operation */
export interface OperationProgress extends BaseMessage {
  type: 'operation:progress';
  payload: {
    operationId: string;
    percentage: number;
    processedRecords: number;
    totalRecords: number;
    currentStep: string;
  };
}

/**
 * Notification that an operation completed successfully.
 *
 * NOTE: `result` is intentionally a loose bag — each module posts its own
 * summary shape (e.g. `{ totalRecords }` for seed, `{ status }` for forge,
 * `{ objectCount }` for preflight) and no named shared type covers them all.
 */
export interface OperationCompleted extends BaseMessage {
  type: 'operation:completed';
  payload: { operationId: string; result: Record<string, unknown> };
}

/** Notification that an operation has failed */
export interface OperationFailed extends BaseMessage {
  type: 'operation:failed';
  payload: {
    operationId: string;
    error: string;
    retryable: boolean;
    /**
     * Stable identifier for the kind of failure, when the emitting handler
     * knows one (e.g. `PRODUCTION_CONFIRMATION_DECLINED`). `error` stays the
     * English text the logs need; a page that shows the failure to the user
     * translates the code instead of the text.
     */
    code?: string;
  };
}

/** Grappe messages */
/** Notification that a grappe (parallel partition) operation has started */
export interface GrappeStarted extends BaseMessage {
  type: 'grappe:started';
  payload: { operationId: string; totalPartitions: number; totalRecords: number };
}

/** Progress update for a single grappe partition */
export interface GrappePartitionProgress extends BaseMessage {
  type: 'grappe:partitionProgress';
  payload: { grappeId: string; percentage: number; processedRecords: number };
}

/** Notification that a grappe operation has completed */
export interface GrappeCompleted extends BaseMessage {
  type: 'grappe:completed';
  payload: { operationId: string; totalProcessed: number; totalFailed: number };
}

// ─── Execution Progress Messages ─────────────────────────────────────────────

/** Retry status update for a failed object operation. */
export interface ExecutionRetryStatusMessage extends BaseMessage {
  type: 'execution:retry-status';
  payload: RetryStatus;
}

/** Request to abort an execution or a single object (WebView -> Extension). */
export interface ExecutionAbortRequest extends BaseMessage {
  type: 'execution:abort';
  payload: { executionId: string; objectName?: string };
}

/**
 * Response for `execution:abort` — `operationId` is set on success, `error` on
 * failure, and `status` when the run had already ended and was left as it ended.
 */
export interface ExecutionAbortResponse extends BaseMessage {
  type: 'execution:abort:response';
  payload: {
    success: boolean;
    operationId?: string;
    error?: string;
    status?: BackgroundOperationStatus;
  };
}

/** Error response for execution operations (emitted via sendHandlerError). */
export interface ExecutionErrorResponse extends BaseMessage {
  type: 'execution:error';
  payload: { message: string; code: string; retryable: boolean };
}
