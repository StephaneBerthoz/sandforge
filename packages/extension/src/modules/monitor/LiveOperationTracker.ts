/**
 * Tracks live operations across all modules and provides real-time
 * progress snapshots for the webview dashboard.
 *
 * Each operation is identified by a unique operationId and carries
 * module, description, progress, throughput, and timing data.
 */

/** Snapshot of a single running operation. */
export interface LiveOperation {
  /** Unique operation identifier. */
  operationId: string;
  /** Module that owns this operation (e.g. 'seed', 'sync', 'dataops'). */
  module: string;
  /** Human-readable description (e.g. 'Syncing Account'). */
  description: string;
  /** Current status of the operation. */
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  /** Progress percentage (0-100). */
  percentage: number;
  /** Number of records processed so far. */
  processedRecords: number;
  /** Total expected records (0 if unknown). */
  totalRecords: number;
  /** Current step label. */
  currentStep: string;
  /** ISO timestamp when the operation started. */
  startedAt: string;
  /** Elapsed time in milliseconds. */
  elapsedMs: number;
  /** Records processed per second (throughput). */
  recordsPerSecond: number;
  /** Optional error message if failed. */
  error?: string;
}

/** Callback invoked when the operation list changes. */
export type OperationChangeHandler = (operations: LiveOperation[]) => void;

/**
 * In-memory tracker for live operations.
 * Provides registration, progress updates, completion, and snapshot retrieval.
 */
export class LiveOperationTracker {
  private readonly operations: Map<string, LiveOperation> = new Map();
  private readonly changeHandlers: Set<OperationChangeHandler> = new Set();
  private readonly cleanupTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  /**
   * Register a new operation and mark it as running.
   * @param operationId - Unique ID for the operation.
   * @param module - Module name (e.g. 'sync', 'seed').
   * @param description - Short description of what the operation does.
   * @param totalRecords - Expected total records (0 if unknown).
   */
  register(operationId: string, module: string, description: string, totalRecords: number = 0): void {
    const op: LiveOperation = {
      operationId,
      module,
      description,
      status: 'running',
      percentage: 0,
      processedRecords: 0,
      totalRecords,
      currentStep: description,
      startedAt: new Date().toISOString(),
      elapsedMs: 0,
      recordsPerSecond: 0,
    };
    this.operations.set(operationId, op);
    this.notifyChange();
  }

  /**
   * Update progress for an existing operation.
   * @param operationId - ID of the operation to update.
   * @param percentage - Current progress percentage.
   * @param processedRecords - Records processed so far.
   * @param totalRecords - Total expected records.
   * @param currentStep - Label of the current step.
   */
  updateProgress(
    operationId: string,
    percentage: number,
    processedRecords: number,
    totalRecords: number,
    currentStep: string,
  ): void {
    const op = this.operations.get(operationId);
    if (!op) return;

    const elapsedMs = Date.now() - new Date(op.startedAt).getTime();
    const elapsedSec = elapsedMs / 1000;
    const recordsPerSecond = elapsedSec > 0 ? Math.round(processedRecords / elapsedSec) : 0;

    op.percentage = Math.min(100, Math.max(0, percentage));
    op.processedRecords = processedRecords;
    op.totalRecords = totalRecords;
    op.currentStep = currentStep;
    op.elapsedMs = elapsedMs;
    op.recordsPerSecond = recordsPerSecond;
    this.notifyChange();
  }

  /**
   * Mark an operation as completed.
   * @param operationId - ID of the operation.
   */
  complete(operationId: string): void {
    const op = this.operations.get(operationId);
    if (!op) return;

    op.status = 'completed';
    op.percentage = 100;
    op.elapsedMs = Date.now() - new Date(op.startedAt).getTime();
    this.notifyChange();

    // Auto-remove completed operations after 30 seconds
    this.scheduleRemoval(operationId, 30_000);
  }

  /**
   * Mark an operation as failed.
   * @param operationId - ID of the operation.
   * @param error - Error message.
   */
  fail(operationId: string, error: string): void {
    const op = this.operations.get(operationId);
    if (!op) return;

    op.status = 'failed';
    op.error = error;
    op.elapsedMs = Date.now() - new Date(op.startedAt).getTime();
    this.notifyChange();

    // Auto-remove failed operations after 60 seconds
    this.scheduleRemoval(operationId, 60_000);
  }

  /**
   * Mark an operation as paused.
   * @param operationId - ID of the operation.
   */
  pause(operationId: string): void {
    const op = this.operations.get(operationId);
    if (!op) return;

    op.status = 'paused';
    this.notifyChange();
  }

  /**
   * Resume a paused operation.
   * @param operationId - ID of the operation.
   */
  resume(operationId: string): void {
    const op = this.operations.get(operationId);
    if (!op) return;

    op.status = 'running';
    this.notifyChange();
  }

  /**
   * Cancel an operation.
   * @param operationId - ID of the operation.
   */
  cancel(operationId: string): void {
    const op = this.operations.get(operationId);
    if (!op) return;

    op.status = 'cancelled';
    op.elapsedMs = Date.now() - new Date(op.startedAt).getTime();
    this.notifyChange();

    this.scheduleRemoval(operationId, 30_000);
  }

  /**
   * Get a snapshot of all currently tracked operations.
   * @returns Array of live operation snapshots.
   */
  getAll(): LiveOperation[] {
    return Array.from(this.operations.values());
  }

  /**
   * Get a snapshot of only running or paused operations.
   * @returns Array of active operation snapshots.
   */
  getActive(): LiveOperation[] {
    return this.getAll().filter((op) => op.status === 'running' || op.status === 'paused');
  }

  /**
   * Get a single operation by ID.
   * @param operationId - The operation to look up.
   * @returns The operation snapshot or undefined.
   */
  get(operationId: string): LiveOperation | undefined {
    return this.operations.get(operationId);
  }

  /**
   * Register a handler to be called whenever operations change.
   * @param handler - Callback function.
   */
  onChange(handler: OperationChangeHandler): void {
    this.changeHandlers.add(handler);
  }

  /**
   * Unregister a change handler.
   * @param handler - The handler to remove.
   */
  offChange(handler: OperationChangeHandler): void {
    this.changeHandlers.delete(handler);
  }

  /** Get the count of currently active operations. */
  get activeCount(): number {
    return this.getActive().length;
  }

  /**
   * Dispose all pending cleanup timers and clear tracked operations.
   * Call this when the tracker is no longer needed to avoid leaks.
   */
  dispose(): void {
    for (const timer of this.cleanupTimers.values()) {
      clearTimeout(timer);
    }
    this.cleanupTimers.clear();
    this.operations.clear();
    this.changeHandlers.clear();
  }

  /**
   * Schedule removal of an operation after a delay.
   * Cancels any existing timer for the same operationId before scheduling.
   */
  private scheduleRemoval(operationId: string, delayMs: number): void {
    const existingTimer = this.cleanupTimers.get(operationId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    const timer = setTimeout(() => {
      this.operations.delete(operationId);
      this.cleanupTimers.delete(operationId);
      this.notifyChange();
    }, delayMs);
    this.cleanupTimers.set(operationId, timer);
  }

  private notifyChange(): void {
    const snapshot = this.getAll();
    for (const handler of this.changeHandlers) {
      handler(snapshot);
    }
  }
}
