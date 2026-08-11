import type { ConfigStore } from '../storage/ConfigStore';
import { logger } from '../../logger.js';
import { extractErrorMessage } from '../common/extractErrorMessage.js';

/** Online/offline status */
export type ConnectivityStatus = 'online' | 'offline' | 'degraded';

/** A queued operation pending execution when connectivity is restored */
export interface QueuedOperation {
  id: string;
  type: string;
  orgId: string;
  payload: Record<string, unknown>;
  queuedAt: string;
  retryCount: number;
}

/** Event types emitted by OfflineManager */
export type OfflineEventType =
  | 'statusChanged'
  | 'operationQueued'
  | 'operationExecuted'
  | 'operationFailed'
  | 'queueDrained';

/** Offline manager event */
export interface OfflineEvent {
  type: OfflineEventType;
  status?: ConnectivityStatus;
  previousStatus?: ConnectivityStatus;
  operation?: QueuedOperation;
}

/** Listener for offline events */
export type OfflineEventListener = (event: OfflineEvent) => void;

/** Function that executes a queued operation */
export type OperationExecutor = (operation: QueuedOperation) => Promise<void>;

/** Progress callback for queue drain */
export type DrainProgressCallback = (processed: number, total: number) => void;

/**
 * Manages offline mode for SandForge.
 * Detects connectivity loss via periodic health probes,
 * queues operations while offline, and replays them FIFO on reconnection.
 */
export class OfflineManager {
  private static readonly CATEGORY = 'offline-queue';
  private static readonly MAX_QUEUE_SIZE = 50;
  private static readonly PROBE_INTERVAL = 30_000;
  /**
   * Debounce before an enqueue-while-online triggers a drain. Batches burst
   * enqueues into a single drain.
   */
  private static readonly DRAIN_DEBOUNCE_MS = 1_000;

  private readonly store: ConfigStore;
  private readonly maxQueueSize: number;
  private status: ConnectivityStatus = 'online';
  private queue: QueuedOperation[] = [];
  private probeTimer: ReturnType<typeof setInterval> | undefined;
  private drainTimer: ReturnType<typeof setTimeout> | undefined;
  private probeExecutor: (() => Promise<boolean>) | undefined;
  private operationExecutor: OperationExecutor | undefined;
  private readonly listeners: Set<OfflineEventListener> = new Set();
  private draining = false;

  constructor(store: ConfigStore, maxQueueSize: number = OfflineManager.MAX_QUEUE_SIZE) {
    this.store = store;
    this.maxQueueSize = maxQueueSize;
    this.loadQueue();
  }

  /** Set the probe executor that checks connectivity (returns true if online) */
  setProbeExecutor(executor: () => Promise<boolean>): void {
    this.probeExecutor = executor;
  }

  /** Set the executor for replaying queued operations */
  setOperationExecutor(executor: OperationExecutor): void {
    this.operationExecutor = executor;
  }

  /** Start periodic connectivity probing */
  startProbing(intervalMs: number = OfflineManager.PROBE_INTERVAL): void {
    this.stopProbing();
    this.probeTimer = setInterval(() => {
      void this.checkConnectivity();
    }, intervalMs);
  }

  /** Stop periodic connectivity probing */
  stopProbing(): void {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = undefined;
    }
  }

  /** Manually check connectivity */
  async checkConnectivity(): Promise<ConnectivityStatus> {
    if (!this.probeExecutor) {
      return this.status;
    }

    const previousStatus = this.status;

    try {
      const isOnline = await this.probeExecutor();
      this.status = isOnline ? 'online' : 'offline';
    } catch {
      this.status = 'offline';
    }

    if (this.status !== previousStatus) {
      this.emit({ type: 'statusChanged', status: this.status, previousStatus });

      // Auto-drain queue when coming back online
      if (this.status === 'online' && previousStatus === 'offline') {
        void this.drainQueue();
      }
    }

    return this.status;
  }

  /** Get current connectivity status */
  getStatus(): ConnectivityStatus {
    return this.status;
  }

  /** Check if currently offline */
  isOffline(): boolean {
    return this.status === 'offline';
  }

  /** Manually set status (useful for testing or manual override) */
  setStatus(status: ConnectivityStatus): void {
    const previousStatus = this.status;
    this.status = status;

    if (status !== previousStatus) {
      this.emit({ type: 'statusChanged', status, previousStatus });

      if (status === 'online' && previousStatus === 'offline') {
        void this.drainQueue();
      }
    }
  }

  /** Queue an operation for later execution */
  enqueue(operation: Omit<QueuedOperation, 'queuedAt' | 'retryCount'>): boolean {
    if (this.queue.length >= this.maxQueueSize) {
      return false;
    }

    const queued: QueuedOperation = {
      ...operation,
      queuedAt: new Date().toISOString(),
      retryCount: 0,
    };

    this.queue.push(queued);
    this.persistQueue();
    this.emit({ type: 'operationQueued', operation: queued });

    // An operation queued while the probe still reports 'online' (e.g. a
    // manual sync whose org is unreachable) would otherwise sit parked until
    // the next offline→online transition that may never come. Failed replays
    // are NOT re-queued (see the `triggeredBy` guard in SyncOpsHandler), so
    // this drain cannot hot-loop.
    if (this.status === 'online') {
      this.scheduleDrain();
    }
    return true;
  }

  /** Get the current queue */
  getQueue(): ReadonlyArray<QueuedOperation> {
    return [...this.queue];
  }

  /** Get the queue size */
  getQueueSize(): number {
    return this.queue.length;
  }

  /** Clear the entire queue */
  clearQueue(): void {
    this.queue = [];
    this.persistQueue();
  }

  /** Remove a specific operation from the queue */
  removeFromQueue(operationId: string): boolean {
    const index = this.queue.findIndex((op) => op.id === operationId);
    if (index === -1) {
      return false;
    }
    this.queue.splice(index, 1);
    this.persistQueue();
    return true;
  }

  /** Check if the queue is draining */
  isDraining(): boolean {
    return this.draining;
  }

  /**
   * Drain the queue by executing all pending operations FIFO.
   * Calls progressCallback with (processed, total) for each operation.
   */
  async drainQueue(
    progressCallback?: DrainProgressCallback,
  ): Promise<{ executed: number; failed: number }> {
    if (this.draining || this.queue.length === 0 || !this.operationExecutor) {
      return { executed: 0, failed: 0 };
    }

    this.draining = true;
    let executed = 0;
    let failed = 0;
    const total = this.queue.length;

    while (this.queue.length > 0) {
      const operation = this.queue[0];

      try {
        await this.operationExecutor(operation);
        this.queue.shift();
        executed++;
        this.emit({ type: 'operationExecuted', operation });
      } catch {
        this.queue.shift();
        failed++;
        this.emit({ type: 'operationFailed', operation });
      }

      this.persistQueue();

      if (progressCallback) {
        progressCallback(executed + failed, total);
      }
    }

    this.draining = false;
    this.emit({ type: 'queueDrained' });
    return { executed, failed };
  }

  /** Register an event listener */
  onEvent(listener: OfflineEventListener): void {
    this.listeners.add(listener);
  }

  /** Remove an event listener */
  offEvent(listener: OfflineEventListener): void {
    this.listeners.delete(listener);
  }

  /** Dispose timers and clean up */
  dispose(): void {
    this.stopProbing();
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = undefined;
    }
    this.listeners.clear();
  }

  private loadQueue(): void {
    const stored = this.store.get<QueuedOperation[]>('offline:queue');
    if (!stored || !Array.isArray(stored)) {
      return;
    }
    // Drop malformed entries (hand-edited or corrupted storage) instead of
    // letting them crash the drain loop later.
    this.queue = stored.filter((entry): entry is QueuedOperation => {
      if (!OfflineManager.isValidQueuedOperation(entry)) {
        logger.warn('OfflineManager: dropped malformed queued operation from storage', {
          entry: JSON.stringify(entry),
        });
        return false;
      }
      return true;
    });
  }

  /** Light shape check for persisted queue entries; backfills missing metadata. */
  private static isValidQueuedOperation(entry: unknown): entry is QueuedOperation {
    if (typeof entry !== 'object' || entry === null) {
      return false;
    }
    const candidate = entry as Partial<QueuedOperation>;
    if (
      typeof candidate.id !== 'string' ||
      typeof candidate.type !== 'string' ||
      typeof candidate.orgId !== 'string' ||
      typeof candidate.payload !== 'object' ||
      candidate.payload === null
    ) {
      return false;
    }
    if (typeof candidate.queuedAt !== 'string') {
      candidate.queuedAt = new Date().toISOString();
    }
    if (typeof candidate.retryCount !== 'number') {
      candidate.retryCount = 0;
    }
    return true;
  }

  private persistQueue(): void {
    this.store.set('offline:queue', this.queue, OfflineManager.CATEGORY);
  }

  /**
   * Debounced drain trigger. `drainQueue` itself is reentrancy-safe (the
   * `draining` flag serializes concurrent calls), so the timer only needs to
   * collapse multiple enqueues into one drain.
   */
  private scheduleDrain(): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
    }
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      void this.drainQueue();
    }, OfflineManager.DRAIN_DEBOUNCE_MS);
  }

  private emit(event: OfflineEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        logger.warn('OfflineManager listener threw', {
          error: extractErrorMessage(err),
        });
      }
    }
  }
}
