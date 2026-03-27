import type { BulkExecutionProgress, ObjectProgress } from '@sandforge/shared';
import type { BulkApiManager, BulkJobInfo, BulkJobStatus } from './BulkApiManager.js';

/** Descriptor for a job to track within an execution. */
export interface TrackedJob {
  /** Bulk API 2.0 job ID. */
  jobId: string;
  /** Salesforce object API name. */
  objectName: string;
  /** Total records submitted to the job. */
  totalRecords: number;
}

/** Map Bulk API status to ObjectProgress state. */
function mapState(status: BulkJobStatus): ObjectProgress['state'] {
  switch (status) {
    case 'UploadComplete':
      return 'queued';
    case 'InProgress':
      return 'processing';
    case 'JobComplete':
      return 'complete';
    case 'Failed':
      return 'failed';
    case 'Aborted':
      return 'aborted';
    default:
      return 'queued';
  }
}

/** Whether a Bulk API status is terminal. */
function isTerminal(status: BulkJobStatus): boolean {
  return status === 'JobComplete' || status === 'Failed' || status === 'Aborted';
}

/** Internal state for a tracked execution. */
interface ExecutionState {
  jobs: TrackedJob[];
  startedAt: number;
  intervalId: ReturnType<typeof setInterval>;
}

/**
 * Polls Bulk API 2.0 job status via BulkApiManager and emits
 * aggregated per-object progress events.
 */
export class BulkJobProgressTracker {
  private readonly executions = new Map<string, ExecutionState>();
  private readonly callbacks = new Set<(progress: BulkExecutionProgress) => void>();
  private readonly pollIntervalMs: number;
  private readonly bulkApiManager: BulkApiManager;

  /**
   * @param bulkApiManager - The BulkApiManager instance to poll job status from.
   * @param pollIntervalMs - Polling interval in milliseconds (default 3000).
   */
  constructor(bulkApiManager: BulkApiManager, pollIntervalMs: number = 3000) {
    this.bulkApiManager = bulkApiManager;
    this.pollIntervalMs = pollIntervalMs;
  }

  /**
   * Begin tracking progress for an execution.
   *
   * @param executionId - Unique execution identifier.
   * @param jobs - Array of jobs to track.
   */
  startTracking(executionId: string, jobs: TrackedJob[]): void {
    // Stop any existing tracking for this execution
    this.stopTracking(executionId);

    const startedAt = Date.now();
    const intervalId = setInterval(() => {
      this.poll(executionId);
    }, this.pollIntervalMs);

    this.executions.set(executionId, { jobs, startedAt, intervalId });

    // Emit an initial progress snapshot immediately
    this.poll(executionId);
  }

  /**
   * Stop tracking progress for an execution.
   *
   * @param executionId - Execution to stop tracking.
   */
  stopTracking(executionId: string): void {
    const state = this.executions.get(executionId);
    if (state) {
      clearInterval(state.intervalId);
      this.executions.delete(executionId);
    }
  }

  /**
   * Subscribe to progress updates.
   *
   * @param callback - Invoked with aggregated progress on each poll.
   * @returns Unsubscribe function.
   */
  onProgress(callback: (progress: BulkExecutionProgress) => void): () => void {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }

  /** Clear all intervals and state. */
  dispose(): void {
    for (const [, state] of this.executions) {
      clearInterval(state.intervalId);
    }
    this.executions.clear();
    this.callbacks.clear();
  }

  /** Poll job statuses and emit progress. */
  private poll(executionId: string): void {
    const state = this.executions.get(executionId);
    if (!state) return;

    const objects: ObjectProgress[] = state.jobs.map((tracked) => {
      const job: BulkJobInfo | undefined = this.bulkApiManager.getJob(tracked.jobId);
      if (!job) {
        return {
          objectName: tracked.objectName,
          jobId: tracked.jobId,
          operation: 'unknown',
          recordsProcessed: 0,
          recordsFailed: 0,
          totalRecords: tracked.totalRecords,
          state: 'queued' as const,
          startedAt: state.startedAt,
        };
      }
      return {
        objectName: tracked.objectName,
        jobId: tracked.jobId,
        operation: job.operation,
        recordsProcessed: job.numberRecordsProcessed,
        recordsFailed: job.numberRecordsFailed,
        totalRecords: tracked.totalRecords,
        state: mapState(job.state),
        startedAt: state.startedAt,
      };
    });

    const overallPercent = this.computeOverallPercent(objects);
    const elapsedMs = Date.now() - state.startedAt;

    const progress: BulkExecutionProgress = {
      executionId,
      objects,
      overallPercent,
      elapsedMs,
    };

    for (const cb of this.callbacks) {
      cb(progress);
    }

    // Auto-stop when all jobs are terminal
    const allTerminal = state.jobs.every((tracked) => {
      const job = this.bulkApiManager.getJob(tracked.jobId);
      return job ? isTerminal(job.state) : false;
    });
    if (allTerminal) {
      this.stopTracking(executionId);
    }
  }

  /** Compute weighted average percentage based on totalRecords. */
  private computeOverallPercent(objects: ObjectProgress[]): number {
    const totalRecords = objects.reduce((sum, o) => sum + o.totalRecords, 0);
    if (totalRecords === 0) return 0;
    const totalProcessed = objects.reduce((sum, o) => sum + o.recordsProcessed, 0);
    return Math.round((totalProcessed / totalRecords) * 100);
  }
}
