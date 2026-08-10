import type { ActiveOperation, BackgroundOperationStatus } from '@sandforge/shared';

/** Internal representation of a registered background operation. */
export interface RegisteredOperation {
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
  /** Controller for aborting the operation. */
  abortController: AbortController;
  /** Whether the user has been notified via a native VSCode notification. */
  notifiedNatively: boolean;
}

/** Event types emitted by the registry during operation lifecycle. */
export type OperationEventType = 'started' | 'progress' | 'completed' | 'failed' | 'aborted';

/** Listener callback for operation lifecycle events. */
export type OperationEventListener = (
  operationId: string,
  type: OperationEventType,
  operation: RegisteredOperation,
) => void;

/**
 * Manages background operations that run detached from the webview lifecycle.
 *
 * Tracks status, progress, and abort controllers for all running operations.
 * Emits lifecycle events so consumers (e.g. WebviewStateSync, notification system)
 * can react to state changes without polling.
 *
 * Completed operations are retained (up to maxCompleted) for display in the UI.
 */
export class BackgroundOperationRegistry {
  private operations = new Map<string, RegisteredOperation>();
  private listeners = new Set<OperationEventListener>();
  private maxCompleted = 50;

  /**
   * Register a new background operation.
   *
   * The promise is monitored for completion/failure. The operation is stored
   * with status 'running' and events are emitted on state transitions.
   *
   * @param operationId - Unique identifier for this operation
   * @param module - Module that initiated the operation (sync, seed, clone)
   * @param description - Human-readable description
   * @param promise - The operation promise to monitor
   * @param abortController - Controller for cancelling the operation
   * @returns The registered operation metadata
   */
  register(
    operationId: string,
    module: string,
    description: string,
    promise: Promise<unknown>,
    abortController: AbortController,
  ): RegisteredOperation {
    const operation: RegisteredOperation = {
      operationId,
      module,
      description,
      status: 'running',
      progressPercent: 0,
      startedAt: Date.now(),
      abortController,
      notifiedNatively: false,
    };

    this.operations.set(operationId, operation);
    this.emit(operationId, 'started', operation);

    promise
      .then((result) => {
        // A resolved promise is not necessarily a success: SyncOpsHandler's
        // executeSync settles failures as a result object carrying
        // status:'failure' (so scheduled runs persist lastResult='failure'
        // without rejecting the monitored promise). Surface those as failed,
        // not completed.
        if (
          typeof result === 'object' &&
          result !== null &&
          (result as { status?: unknown }).status === 'failure'
        ) {
          this.markFailed(operationId, new Error('Operation finished with a failure status.'));
          return;
        }
        this.markCompleted(operationId);
      })
      .catch((error: unknown) => {
        this.markFailed(operationId, error);
      });

    return operation;
  }

  /**
   * Update the progress of a running operation.
   *
   * @param operationId - Operation to update
   * @param percent - New progress percentage (0-100)
   * @param summary - Optional result summary text
   */
  updateProgress(operationId: string, percent: number, summary?: string): void {
    const operation = this.operations.get(operationId);
    if (!operation) {
      return;
    }
    operation.progressPercent = percent;
    if (summary !== undefined) {
      operation.resultSummary = summary;
    }
    this.emit(operationId, 'progress', operation);
  }

  /**
   * Abort a running operation.
   *
   * Triggers the AbortController and sets the status to 'aborted'.
   *
   * @param operationId - Operation to abort
   */
  abort(operationId: string): void {
    const operation = this.operations.get(operationId);
    if (!operation) {
      return;
    }
    operation.abortController.abort();
    operation.status = 'aborted';
    operation.completedAt = Date.now();
    this.emit(operationId, 'aborted', operation);
  }

  /**
   * Mark an operation as having been notified via a native VSCode notification.
   * Prevents duplicate notifications.
   *
   * @param operationId - Operation to mark
   */
  markNotifiedNatively(operationId: string): void {
    const operation = this.operations.get(operationId);
    if (operation) {
      operation.notifiedNatively = true;
    }
  }

  /**
   * Get all operations mapped to the ActiveOperation shape for webview consumption.
   * Sorted by startedAt descending (newest first).
   */
  getActiveOperations(): ActiveOperation[] {
    return [...this.operations.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((op) => ({
        operationId: op.operationId,
        module: op.module,
        description: op.description,
        status: op.status,
        progressPercent: op.progressPercent,
        startedAt: op.startedAt,
        completedAt: op.completedAt,
        resultSummary: op.resultSummary,
      }));
  }

  /**
   * Get all currently running operations.
   */
  getRunning(): RegisteredOperation[] {
    return [...this.operations.values()].filter((op) => op.status === 'running');
  }

  /**
   * Check if an operation exists in the registry.
   *
   * @param operationId - Operation to check
   */
  has(operationId: string): boolean {
    return this.operations.has(operationId);
  }

  /**
   * Get a registered operation by its ID.
   *
   * @param operationId - Operation to retrieve
   */
  get(operationId: string): RegisteredOperation | undefined {
    return this.operations.get(operationId);
  }

  /**
   * Subscribe to operation lifecycle events.
   *
   * @param listener - Callback for events
   * @returns Unsubscribe function
   */
  onEvent(listener: OperationEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Clear all operations and listeners.
   */
  dispose(): void {
    this.operations.clear();
    this.listeners.clear();
  }

  /**
   * Mark an operation as completed.
   * Evicts oldest completed operations when maxCompleted is exceeded.
   */
  private markCompleted(operationId: string, resultSummary?: string): void {
    const operation = this.operations.get(operationId);
    if (!operation || operation.status !== 'running') {
      return;
    }
    operation.status = 'completed';
    operation.completedAt = Date.now();
    operation.progressPercent = 100;
    if (resultSummary !== undefined) {
      operation.resultSummary = resultSummary;
    }
    this.emit(operationId, 'completed', operation);
    this.evictOldCompleted();
  }

  /**
   * Mark an operation as failed.
   */
  private markFailed(operationId: string, error: unknown): void {
    const operation = this.operations.get(operationId);
    if (!operation || operation.status !== 'running') {
      return;
    }
    operation.status = 'failed';
    operation.completedAt = Date.now();
    operation.resultSummary = error instanceof Error ? error.message : String(error);
    this.emit(operationId, 'failed', operation);
  }

  /**
   * Emit an event to all listeners.
   */
  private emit(
    operationId: string,
    type: OperationEventType,
    operation: RegisteredOperation,
  ): void {
    for (const listener of this.listeners) {
      listener(operationId, type, operation);
    }
  }

  /**
   * Evict the oldest completed operations when the count exceeds maxCompleted.
   */
  private evictOldCompleted(): void {
    const completed = [...this.operations.values()]
      .filter((op) => op.status !== 'running')
      .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));

    while (completed.length > this.maxCompleted) {
      const oldest = completed.shift();
      if (oldest) {
        this.operations.delete(oldest.operationId);
      }
    }
  }
}
