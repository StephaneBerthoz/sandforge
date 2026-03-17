import type { ConfigStore } from '../storage/ConfigStore';

/** Status of an operation checkpoint */
export type CheckpointStatus = 'in_progress' | 'completed' | 'failed' | 'cancelled';

/** Checkpoint data for crash recovery */
export interface OperationCheckpoint {
  operationId: string;
  status: CheckpointStatus;
  objectName: string;
  totalRecords: number;
  processedRecords: number;
  successCount: number;
  failureCount: number;
  lastProcessedId?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

/** Stored checkpoint entry with expiration */
interface StoredCheckpoint {
  checkpoint: OperationCheckpoint;
  expiresAt: number;
}

/** Provider function that returns the current state for auto-save */
export type CheckpointStateProvider = () => OperationCheckpoint;

/** Event types emitted by CheckpointManager */
export type CheckpointEventType = 'saved' | 'restored' | 'expired' | 'recoveryAvailable';

/** Checkpoint event */
export interface CheckpointEvent {
  type: CheckpointEventType;
  operationId: string;
  checkpoint?: OperationCheckpoint;
}

/** Listener for checkpoint events */
export type CheckpointEventListener = (event: CheckpointEvent) => void;

/**
 * Saves and restores operation state for crash recovery.
 * Supports auto-save at configurable intervals and recovery prompts.
 * Checkpoints are persisted in ConfigStore and auto-cleaned after expiration.
 */
export class CheckpointManager {
  private static readonly CATEGORY = 'checkpoints';
  private static readonly KEY_PREFIX = 'checkpoint:';
  private static readonly DEFAULT_AUTO_SAVE_INTERVAL = 30_000;

  private readonly store: ConfigStore;
  private readonly retentionMs: number;
  private readonly autoSaveTimers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private readonly listeners: Set<CheckpointEventListener> = new Set();

  constructor(store: ConfigStore, retentionMs: number = 24 * 60 * 60 * 1000) {
    this.store = store;
    this.retentionMs = retentionMs;
  }

  /** Save a checkpoint for an operation */
  save(operationId: string, state: OperationCheckpoint): void {
    const key = CheckpointManager.KEY_PREFIX + operationId;
    const stored: StoredCheckpoint = {
      checkpoint: { ...state, updatedAt: new Date().toISOString() },
      expiresAt: Date.now() + this.retentionMs,
    };
    this.store.set(key, stored, CheckpointManager.CATEGORY);
    this.emit({ type: 'saved', operationId, checkpoint: stored.checkpoint });
  }

  /** Restore a checkpoint for an operation, or null if not found / expired */
  restore(operationId: string): OperationCheckpoint | null {
    const key = CheckpointManager.KEY_PREFIX + operationId;
    const stored = this.store.get<StoredCheckpoint>(key);
    if (!stored) {
      return null;
    }
    if (Date.now() > stored.expiresAt) {
      this.store.delete(key);
      return null;
    }
    this.emit({ type: 'restored', operationId, checkpoint: stored.checkpoint });
    return stored.checkpoint;
  }

  /** Alias for restore — load a checkpoint for an operation */
  load(operationId: string): OperationCheckpoint | null {
    return this.restore(operationId);
  }

  /** List all non-expired checkpoints */
  list(): OperationCheckpoint[] {
    const entries = this.store.getByCategory(CheckpointManager.CATEGORY);
    const now = Date.now();
    const result: OperationCheckpoint[] = [];

    for (const value of Object.values(entries)) {
      const stored = value as StoredCheckpoint;
      if (now <= stored.expiresAt) {
        result.push(stored.checkpoint);
      }
    }

    return result;
  }

  /** List all checkpoints including expired ones */
  listAll(): OperationCheckpoint[] {
    const entries = this.store.getByCategory(CheckpointManager.CATEGORY);
    const result: OperationCheckpoint[] = [];

    for (const value of Object.values(entries)) {
      const stored = value as StoredCheckpoint;
      result.push(stored.checkpoint);
    }

    return result;
  }

  /** Get all expired checkpoints */
  getExpired(): OperationCheckpoint[] {
    const entries = this.store.getByCategory(CheckpointManager.CATEGORY);
    const now = Date.now();
    const result: OperationCheckpoint[] = [];

    for (const value of Object.values(entries)) {
      const stored = value as StoredCheckpoint;
      if (now > stored.expiresAt) {
        result.push(stored.checkpoint);
      }
    }

    return result;
  }

  /** Delete a checkpoint for an operation */
  delete(operationId: string): boolean {
    const key = CheckpointManager.KEY_PREFIX + operationId;
    return this.store.delete(key);
  }

  /** Alias for delete — clear a checkpoint for an operation */
  clear(operationId: string): boolean {
    return this.delete(operationId);
  }

  /** Check if a checkpoint exists and is not expired */
  has(operationId: string): boolean {
    const key = CheckpointManager.KEY_PREFIX + operationId;
    const stored = this.store.get<StoredCheckpoint>(key);
    if (!stored) {
      return false;
    }
    return Date.now() <= stored.expiresAt;
  }

  /** Alias for has — check if a checkpoint exists */
  hasCheckpoint(operationId: string): boolean {
    return this.has(operationId);
  }

  /** Remove all expired checkpoints, returns count of removed entries */
  cleanup(): number {
    const entries = this.store.getByCategory(CheckpointManager.CATEGORY);
    const now = Date.now();
    let removed = 0;

    for (const [key, value] of Object.entries(entries)) {
      const stored = value as StoredCheckpoint;
      if (now > stored.expiresAt) {
        this.store.delete(key);
        this.emit({ type: 'expired', operationId: stored.checkpoint.operationId });
        removed++;
      }
    }

    return removed;
  }

  /** Clear all checkpoints */
  clearAll(): number {
    return this.store.clearCategory(CheckpointManager.CATEGORY);
  }

  /**
   * Start auto-saving an operation's state at a configurable interval.
   * The stateProvider is called each interval to get the current state.
   */
  startAutoSave(
    operationId: string,
    stateProvider: CheckpointStateProvider,
    intervalMs: number = CheckpointManager.DEFAULT_AUTO_SAVE_INTERVAL
  ): void {
    this.stopAutoSave(operationId);

    // Save immediately
    this.save(operationId, stateProvider());

    const timer = setInterval(() => {
      this.save(operationId, stateProvider());
    }, intervalMs);

    this.autoSaveTimers.set(operationId, timer);
  }

  /** Stop auto-saving an operation's state */
  stopAutoSave(operationId: string): void {
    const timer = this.autoSaveTimers.get(operationId);
    if (timer) {
      clearInterval(timer);
      this.autoSaveTimers.delete(operationId);
    }
  }

  /** Check if auto-save is active for an operation */
  isAutoSaveActive(operationId: string): boolean {
    return this.autoSaveTimers.has(operationId);
  }

  /**
   * Check for recoverable checkpoints at startup.
   * Returns in-progress checkpoints that can be resumed.
   */
  getRecoverableCheckpoints(): OperationCheckpoint[] {
    return this.list().filter((cp) => cp.status === 'in_progress');
  }

  /** Register an event listener */
  onEvent(listener: CheckpointEventListener): void {
    this.listeners.add(listener);
  }

  /** Remove an event listener */
  offEvent(listener: CheckpointEventListener): void {
    this.listeners.delete(listener);
  }

  /** Dispose all timers and clean up */
  dispose(): void {
    for (const [operationId] of this.autoSaveTimers) {
      this.stopAutoSave(operationId);
    }
    this.listeners.clear();
  }

  private emit(event: CheckpointEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
