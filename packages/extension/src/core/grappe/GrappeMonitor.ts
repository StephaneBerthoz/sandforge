import type {
  BackPressureLevel,
  GrappeOperationStatus,
  GrappePartition,
  GrappeProgress,
  GrappeStatus,
  GrappeWorkerStatus,
} from '@sandforge/shared';

/** Event types emitted by the GrappeMonitor */
export type GrappeMonitorEventType =
  | 'partitionCompleted'
  | 'backPressureChanged'
  | 'operationCompleted';

/** Listener function for grappe monitor events */
export type GrappeMonitorListener = (data: GrappeMonitorEventData) => void;

/** Event data payload for monitor events */
export interface GrappeMonitorEventData {
  type: GrappeMonitorEventType;
  operationId: string;
  partitionId?: string;
  status?: GrappeStatus;
  backPressureLevel?: BackPressureLevel;
}

/**
 * Real-time monitoring of grappe operations.
 * Tracks partition statuses, progress updates, and emits events
 * for key lifecycle transitions.
 */
export class GrappeMonitor {
  private operationId: string | undefined;
  private partitionStatuses: Map<string, GrappeStatus> = new Map();
  private partitionProgress: Map<string, GrappeProgress> = new Map();
  private listeners: Map<GrappeMonitorEventType, Set<GrappeMonitorListener>> = new Map();
  private monitoring = false;

  /**
   * Start monitoring a grappe operation.
   * @param operationId - The UUID of the operation to monitor
   */
  startMonitoring(operationId: string): void {
    this.operationId = operationId;
    this.partitionStatuses.clear();
    this.partitionProgress.clear();
    this.monitoring = true;
  }

  /**
   * Stop monitoring the current operation.
   */
  stopMonitoring(): void {
    this.monitoring = false;
  }

  /**
   * Update the status of a specific partition.
   * Emits 'partitionCompleted' when a partition transitions to 'completed'.
   * @param partitionId - The UUID of the partition
   * @param status - The new status
   */
  updatePartitionStatus(partitionId: string, status: GrappeStatus): void {
    this.partitionStatuses.set(partitionId, status);

    if (status === 'completed' && this.operationId) {
      this.emit('partitionCompleted', {
        type: 'partitionCompleted',
        operationId: this.operationId,
        partitionId,
        status,
      });
    }
  }

  /**
   * Update the progress of a specific partition.
   * @param partitionId - The UUID of the partition
   * @param progress - The updated progress data
   */
  updateProgress(partitionId: string, progress: GrappeProgress): void {
    this.partitionProgress.set(partitionId, progress);
  }

  /**
   * Build a complete operation status snapshot.
   * @param partitions - All partitions in the operation
   * @param workers - All worker statuses
   * @param backPressureLevel - Current back-pressure level
   * @param apiUsage - Current API usage percentage
   * @returns A complete GrappeOperationStatus
   */
  getOperationStatus(
    partitions: GrappePartition[],
    workers: GrappeWorkerStatus[],
    backPressureLevel: BackPressureLevel,
    apiUsage: number,
  ): GrappeOperationStatus {
    const overallProgress = this.computeOverallProgress(partitions);
    const elapsedMs = this.getElapsedMs(partitions);

    return {
      operationId: this.operationId ?? '',
      workers,
      backPressureLevel,
      apiUsagePercent: apiUsage,
      partitions,
      overallProgress,
      estimatedTimeRemaining:
        overallProgress.percentage > 0
          ? this.getEstimatedTimeRemaining(overallProgress, elapsedMs)
          : undefined,
    };
  }

  /**
   * Estimate the remaining time for an operation based on current progress and elapsed time.
   * @param progress - Current overall progress
   * @param elapsedMs - Milliseconds elapsed since operation start
   * @returns Estimated milliseconds remaining, or 0 if already complete
   */
  getEstimatedTimeRemaining(progress: GrappeProgress, elapsedMs: number): number {
    if (progress.percentage >= 100) {
      return 0;
    }
    if (progress.percentage <= 0) {
      return 0;
    }

    const totalEstimated = (elapsedMs / progress.percentage) * 100;
    return Math.max(0, totalEstimated - elapsedMs);
  }

  /**
   * Register a listener for a specific event type.
   * @param event - The event type to listen for
   * @param listener - The callback function
   */
  on(event: GrappeMonitorEventType, listener: GrappeMonitorListener): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      listeners.add(listener);
    } else {
      this.listeners.set(event, new Set([listener]));
    }
  }

  /**
   * Remove a listener for a specific event type.
   * @param event - The event type
   * @param listener - The callback function to remove
   */
  off(event: GrappeMonitorEventType, listener: GrappeMonitorListener): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      listeners.delete(listener);
    }
  }

  /**
   * Emit an event to all registered listeners for a given event type.
   * @param event - The event type to emit
   * @param data - The event data payload
   */
  emit(event: GrappeMonitorEventType, data: GrappeMonitorEventData): void {
    if (!this.monitoring && event !== 'operationCompleted') {
      return;
    }

    const listeners = this.listeners.get(event);
    if (listeners) {
      for (const listener of listeners) {
        listener(data);
      }
    }
  }

  /**
   * Check if monitoring is currently active.
   * @returns True if monitoring is active
   */
  isMonitoring(): boolean {
    return this.monitoring;
  }

  /**
   * Compute aggregated progress from all partition progress data.
   */
  private computeOverallProgress(partitions: GrappePartition[]): GrappeProgress {
    let processedRecords = 0;
    let totalRecords = 0;
    let successCount = 0;
    let failureCount = 0;
    let totalRecordsPerSecond = 0;

    for (const partition of partitions) {
      const progress = this.partitionProgress.get(partition.id) ?? partition.progress;
      processedRecords += progress.processedRecords;
      totalRecords += progress.totalRecords;
      successCount += progress.successCount;
      failureCount += progress.failureCount;
      totalRecordsPerSecond += progress.recordsPerSecond;
    }

    const percentage = totalRecords > 0 ? (processedRecords / totalRecords) * 100 : 0;

    return {
      processedRecords,
      totalRecords,
      successCount,
      failureCount,
      percentage,
      recordsPerSecond: totalRecordsPerSecond,
    };
  }

  /**
   * Compute elapsed time from the earliest partition start time.
   */
  private getElapsedMs(partitions: GrappePartition[]): number {
    let earliest = Infinity;

    for (const partition of partitions) {
      if (partition.startTime) {
        const time = new Date(partition.startTime).getTime();
        if (time < earliest) {
          earliest = time;
        }
      }
    }

    if (earliest === Infinity) {
      return 0;
    }

    return Date.now() - earliest;
  }
}
