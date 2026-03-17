/** Status of a queued operation */
export type QueuedOperationStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';

/** An operation in the queue */
export interface QueuedOperation {
  id: string;
  name: string;
  status: QueuedOperationStatus;
  priority: number;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

/** Queue status summary */
export interface QueueStatus {
  totalQueued: number;
  totalProcessing: number;
  totalCompleted: number;
  totalFailed: number;
  totalCancelled: number;
  maxSize: number;
}

/** Internal queue entry with priority */
interface QueueEntry {
  operation: QueuedOperation;
  priority: number;
  insertOrder: number;
}

/**
 * Priority queue for managing data operations.
 * Lower priority numbers are dequeued first (0 = highest priority).
 * Supports configurable max queue size.
 */
export class QueueManager {
  private queue: QueueEntry[] = [];
  private completed: QueuedOperation[] = [];
  private readonly maxSize: number;
  private insertCounter = 0;

  constructor(maxSize: number = 100) {
    this.maxSize = Math.max(1, maxSize);
  }

  /** Enqueue an operation with optional priority (default 5) */
  enqueue(operation: QueuedOperation, priority: number = 5): string {
    if (this.queue.length >= this.maxSize) {
      throw new Error(`Queue is full (max ${this.maxSize})`);
    }

    const clampedPriority = Math.max(0, Math.min(10, priority));
    const entry: QueueEntry = {
      operation: { ...operation, status: 'queued', priority: clampedPriority },
      priority: clampedPriority,
      insertOrder: this.insertCounter++,
    };

    this.queue.push(entry);
    this.sortQueue();

    return operation.id;
  }

  /** Dequeue the highest-priority operation */
  dequeue(): QueuedOperation | null {
    if (this.queue.length === 0) return null;

    const entry = this.queue.shift();
    if (!entry) return null;

    entry.operation.status = 'processing';
    return entry.operation;
  }

  /** Peek at the highest-priority operation without removing it */
  peek(): QueuedOperation | null {
    if (this.queue.length === 0) return null;
    return this.queue[0].operation;
  }

  /** Cancel a queued operation by ID */
  cancel(operationId: string): boolean {
    const index = this.queue.findIndex((e) => e.operation.id === operationId);
    if (index === -1) return false;

    const entry = this.queue[index];
    entry.operation.status = 'cancelled';
    this.completed.push(entry.operation);
    this.queue.splice(index, 1);
    return true;
  }

  /** Mark an operation as completed */
  markCompleted(operationId: string): void {
    const op: QueuedOperation = {
      id: operationId,
      name: '',
      status: 'completed',
      priority: 0,
      createdAt: new Date().toISOString(),
    };
    this.completed.push(op);
  }

  /** Mark an operation as failed */
  markFailed(operationId: string): void {
    const op: QueuedOperation = {
      id: operationId,
      name: '',
      status: 'failed',
      priority: 0,
      createdAt: new Date().toISOString(),
    };
    this.completed.push(op);
  }

  /** Get the current queue status */
  getStatus(): QueueStatus {
    return {
      totalQueued: this.queue.length,
      totalProcessing: 0,
      totalCompleted: this.completed.filter((o) => o.status === 'completed').length,
      totalFailed: this.completed.filter((o) => o.status === 'failed').length,
      totalCancelled: this.completed.filter((o) => o.status === 'cancelled').length,
      maxSize: this.maxSize,
    };
  }

  /** Get the number of items in the queue */
  get size(): number {
    return this.queue.length;
  }

  /** Check if the queue is empty */
  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /** Check if the queue is full */
  isFull(): boolean {
    return this.queue.length >= this.maxSize;
  }

  /** Clear all queued operations */
  clear(): void {
    this.queue = [];
  }

  /** Clear completed/failed/cancelled history */
  clearHistory(): void {
    this.completed = [];
  }

  /** Sort queue by priority (ascending), then by insert order (FIFO) */
  private sortQueue(): void {
    this.queue.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.insertOrder - b.insertOrder;
    });
  }
}
