import type { UUID, ISODateString, OperationResult } from './common.types.js';

/** Execution pipeline status */
export type PipelineStatus =
  | 'idle'
  | 'pre_checking'
  | 'running'
  | 'paused'
  | 'waiting_user'
  | 'rolling_back'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'cancelled';

/** API mode selection */
export type ApiMode = 'rest' | 'bulk' | 'composite' | 'auto';

/** Error handling strategy */
export type ErrorHandlingStrategy = 'stop_on_first' | 'continue_and_report' | 'retry_failed';

/** Execution step status */
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'rolled_back';

/** A single step in the execution pipeline */
export interface ExecutionStep {
  id: UUID;
  name: string;
  objectApiName: string;
  operation: StepOperation;
  status: StepStatus;
  recordCount: number;
  processedCount: number;
  successCount: number;
  failureCount: number;
  startTime?: ISODateString;
  endTime?: ISODateString;
  error?: string;
  retryCount: number;
}

/** Step operation type */
export type StepOperation =
  | 'insert'
  | 'update'
  | 'upsert'
  | 'delete'
  | 'undelete'
  | 'query'
  | 'describe'
  | 'transform'
  | 'validate';

/** Pipeline execution options */
export interface PipelineOptions {
  apiMode: ApiMode;
  grappeMode: boolean;
  parallelism: number;
  batchSize: number;
  errorHandling: ErrorHandlingStrategy;
  enableRollback: boolean;
  dryRun: boolean;
  preScript?: string;
  postScript?: string;
  checkpoint: boolean;
}

/** Execution progress tracker */
export interface ExecutionProgress {
  totalSteps: number;
  completedSteps: number;
  currentStepIndex: number;
  totalRecords: number;
  processedRecords: number;
  successRecords: number;
  failedRecords: number;
  startTime: ISODateString;
  estimatedEndTime?: ISODateString;
  elapsedMs: number;
  recordsPerSecond: number;
}

/** Complete execution pipeline */
export interface ExecutionPipeline {
  id: UUID;
  status: PipelineStatus;
  steps: ExecutionStep[];
  options: PipelineOptions;
  progress: ExecutionProgress;
  result?: OperationResult;
}

/** Operation checkpoint for recovery */
export interface OperationCheckpoint {
  operationId: UUID;
  module: string;
  config: Record<string, unknown>;
  progress: {
    currentStep: number;
    processedObjects: string[];
    lastProcessedRecordId?: string;
    recordCounts: Record<string, number>;
  };
  timestamp: ISODateString;
  expiresAt: ISODateString;
}
