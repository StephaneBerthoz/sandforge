import type { UUID, ISODateString } from './common.types.js';

/** Grappe (cluster) partition strategy */
export type GrappePartitionStrategy =
  | 'round_robin'
  | 'by_record_type'
  | 'by_parent'
  | 'by_date_range'
  | 'by_hash'
  | 'by_volume'
  | 'dependency_aware';

/** Grappe partition status */
export type GrappeStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'retrying'
  | 'cancelled';

/** Back-pressure strategy */
export type BackPressureStrategy = 'pause' | 'throttle' | 'drop_priority';

/** Grappe isolation level for rollback granularity */
export type GrappeIsolationLevel = 'none' | 'per_object' | 'per_grappe';

/** Back-pressure configuration */
export interface BackPressureConfig {
  enabled: boolean;
  maxQueueDepth: number;
  highWaterMark: number;
  lowWaterMark: number;
  strategy: BackPressureStrategy;
  monitoringInterval: number;
}

/** Grappe mode configuration */
export interface GrappeConfig {
  enabled: boolean;
  autoActivateThreshold: number;
  maxWorkers: number;
  grappeSize: number;
  strategy: GrappePartitionStrategy;
  backPressure: BackPressureConfig;
  checkpointing: boolean;
  isolationLevel: GrappeIsolationLevel;
}

/** Progress tracker for a single grappe partition */
export interface GrappeProgress {
  processedRecords: number;
  totalRecords: number;
  successCount: number;
  failureCount: number;
  percentage: number;
  recordsPerSecond: number;
}

/** Checkpoint for grappe recovery */
export interface GrappeCheckpoint {
  grappeId: UUID;
  timestamp: ISODateString;
  processedRecords: number;
  lastProcessedId?: string;
  state: Record<string, unknown>;
  recoverable: boolean;
}

/** A single grappe partition */
export interface GrappePartition {
  id: UUID;
  index: number;
  totalPartitions: number;
  recordCount: number;
  records: string[];
  dependencies: string[];
  status: GrappeStatus;
  assignedWorker?: number;
  progress: GrappeProgress;
  checkpoint?: GrappeCheckpoint;
  startTime?: ISODateString;
  endTime?: ISODateString;
  retryCount: number;
}

/** Result for a single grappe partition */
export interface GrappeResult {
  grappeId: UUID;
  status: 'success' | 'partial' | 'failure';
  processedRecords: number;
  successCount: number;
  failureCount: number;
  errors: string[];
  duration: number;
}

/** Aggregated result for the entire grappe operation */
export interface AggregatedGrappeResult {
  operationId: UUID;
  totalPartitions: number;
  completedPartitions: number;
  failedPartitions: number;
  totalRecords: number;
  successRecords: number;
  failedRecords: number;
  duration: number;
  partitionResults: GrappeResult[];
}

/** Back-pressure level indicator */
export type BackPressureLevel = 'normal' | 'warning' | 'critical';

/** Worker status in the grappe */
export interface GrappeWorkerStatus {
  workerId: number;
  active: boolean;
  currentGrappeId?: UUID;
  processedGrappes: number;
  queuedGrappes: number;
}

/** Overall grappe operation status */
export interface GrappeOperationStatus {
  operationId: UUID;
  workers: GrappeWorkerStatus[];
  backPressureLevel: BackPressureLevel;
  apiUsagePercent: number;
  partitions: GrappePartition[];
  overallProgress: GrappeProgress;
  estimatedTimeRemaining?: number;
}
