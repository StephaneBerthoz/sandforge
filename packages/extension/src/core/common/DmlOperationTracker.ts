/**
 * Tracks DML operations by operationId to prevent duplicate submissions.
 * Uses a time-based expiration to avoid unbounded memory growth.
 */
export interface TrackedOperation {
  /** Unique identifier for the operation */
  operationId: string;
  /** Object API name targeted by the operation */
  objectApiName: string;
  /** DML type: insert, update, upsert, or delete */
  dmlType: 'insert' | 'update' | 'upsert' | 'delete';
  /** Number of records in the operation */
  recordCount: number;
  /** ISO timestamp when the operation was registered */
  registeredAt: string;
  /** Current status of the operation */
  status: 'pending' | 'completed' | 'failed';
}

/** Default TTL for tracked operations: 1 hour in milliseconds */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

/** Maximum number of tracked operations before pruning */
const MAX_TRACKED_OPERATIONS = 10_000;

/**
 * Prevents duplicate DML submissions by tracking operationIds.
 * Each operation is identified by a unique operationId and can only
 * be executed once. Stale entries are pruned automatically.
 */
export class DmlOperationTracker {
  private readonly operations = new Map<string, TrackedOperation>();
  private readonly ttlMs: number;
  private readonly nowFn: () => number;

  /**
   * @param ttlMs - Time-to-live for tracked operations in milliseconds (default: 1 hour)
   * @param nowFn - Function returning current time in ms (default: Date.now)
   */
  constructor(ttlMs: number = DEFAULT_TTL_MS, nowFn: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.nowFn = nowFn;
  }

  /**
   * Check whether an operation has already been registered.
   * @param operationId - The unique operation identifier
   * @returns true if the operation was already registered and is not expired
   */
  isDuplicate(operationId: string): boolean {
    this.pruneExpired();
    return this.operations.has(operationId);
  }

  /**
   * Register a new DML operation. Throws if the operationId is already tracked.
   * @param operationId - Unique identifier for the operation
   * @param objectApiName - Salesforce object API name
   * @param dmlType - Type of DML operation
   * @param recordCount - Number of records to process
   * @returns The tracked operation entry
   */
  register(
    operationId: string,
    objectApiName: string,
    dmlType: TrackedOperation['dmlType'],
    recordCount: number
  ): TrackedOperation {
    this.pruneExpired();

    if (this.operations.has(operationId)) {
      throw new Error(`Duplicate DML operation detected: ${operationId}`);
    }

    const entry: TrackedOperation = {
      operationId,
      objectApiName,
      dmlType,
      recordCount,
      registeredAt: new Date(this.nowFn()).toISOString(),
      status: 'pending',
    };

    this.operations.set(operationId, entry);
    return entry;
  }

  /**
   * Mark an operation as completed.
   * @param operationId - The operation to mark as completed
   */
  markCompleted(operationId: string): void {
    const entry = this.operations.get(operationId);
    if (entry) {
      entry.status = 'completed';
    }
  }

  /**
   * Mark an operation as failed.
   * @param operationId - The operation to mark as failed
   */
  markFailed(operationId: string): void {
    const entry = this.operations.get(operationId);
    if (entry) {
      entry.status = 'failed';
    }
  }

  /**
   * Get a tracked operation by its ID.
   * @param operationId - The operation identifier
   * @returns The tracked operation or undefined if not found
   */
  get(operationId: string): TrackedOperation | undefined {
    return this.operations.get(operationId);
  }

  /** Get the number of currently tracked operations. */
  get size(): number {
    return this.operations.size;
  }

  /** Remove all tracked operations. */
  clear(): void {
    this.operations.clear();
  }

  /** Remove expired entries based on TTL and cap the total size. */
  private pruneExpired(): void {
    const cutoff = this.nowFn() - this.ttlMs;

    for (const [id, entry] of this.operations) {
      const registeredTime = new Date(entry.registeredAt).getTime();
      if (registeredTime < cutoff) {
        this.operations.delete(id);
      }
    }

    // Cap the total size by removing oldest entries
    if (this.operations.size > MAX_TRACKED_OPERATIONS) {
      const entries = Array.from(this.operations.entries());
      const toRemove = entries.length - MAX_TRACKED_OPERATIONS;
      for (let i = 0; i < toRemove; i++) {
        this.operations.delete(entries[i][0]);
      }
    }
  }
}
