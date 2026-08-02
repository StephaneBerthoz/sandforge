import type { BaseMessage } from './base.messages.js';
import type { BulkExecutionProgress, RetryStatus } from '../execution.types.js';

/** Operation control messages */
/** Request to cancel a running operation */
export interface CancelOperationRequest extends BaseMessage {
  type: 'operation:cancel';
  payload: { operationId: string };
}

/** Request to pause a running operation */
export interface PauseOperationRequest extends BaseMessage {
  type: 'operation:pause';
  payload: { operationId: string };
}

/** Request to resume a paused operation */
export interface ResumeOperationRequest extends BaseMessage {
  type: 'operation:resume';
  payload: { operationId: string };
}

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
  payload: { operationId: string; error: string; retryable: boolean };
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

/** Back-pressure signal indicating API usage levels */
export interface GrappeBackPressure extends BaseMessage {
  type: 'grappe:backPressure';
  payload: { level: 'normal' | 'warning' | 'critical'; apiPercent: number };
}

/** Notification that a grappe operation has completed */
export interface GrappeCompleted extends BaseMessage {
  type: 'grappe:completed';
  payload: { operationId: string; totalProcessed: number; totalFailed: number };
}

// ─── Execution Progress Messages ─────────────────────────────────────────────

/** Execution progress update with per-object Bulk API 2.0 job status. */
export interface ExecutionProgressMessage extends BaseMessage {
  type: 'execution:progress';
  payload: BulkExecutionProgress;
}

/** Retry status update for a failed object operation. */
export interface ExecutionRetryStatusMessage extends BaseMessage {
  type: 'execution:retry-status';
  payload: RetryStatus;
}

/** Request to manually retry a failed object operation (WebView -> Extension). */
export interface ExecutionManualRetryRequest extends BaseMessage {
  type: 'execution:manual-retry';
  payload: { executionId: string; objectName: string };
}

/** Request to abort an execution or a single object (WebView -> Extension). */
export interface ExecutionAbortRequest extends BaseMessage {
  type: 'execution:abort';
  payload: { executionId: string; objectName?: string };
}

/** Request the status of a single background operation (WebView -> Extension). */
export interface ExecutionStatusRequest extends BaseMessage {
  type: 'execution:status';
  payload: { operationId: string };
}

/** Request the list of active background operations (WebView -> Extension, no payload). */
export interface ExecutionListRequest extends BaseMessage {
  type: 'execution:list';
}
