import type {
  RealTimeSyncConfig,
  RealTimeSyncStatus,
  RealTimeSyncMetrics,
  CDCEvent,
  CDCConflict,
} from '@sandforge/shared';
import type { CDCListener } from './CDCListener';
import type { CDCReplicator } from './CDCReplicator';

/** Callback for status changes in the real-time sync session */
export type StatusChangeHandler = (status: RealTimeSyncStatus) => void;

/** Callback for incoming CDC events (for UI feed) */
export type EventFeedHandler = (event: CDCEvent, applied: boolean, error?: string) => void;

/** Callback for conflict detection */
export type ConflictFeedHandler = (conflict: CDCConflict) => void;

/** Dependencies required by the RealTimeSyncOrchestrator */
export interface RealTimeSyncOrchestratorDeps {
  createListener: (config: RealTimeSyncConfig) => CDCListener;
  createReplicator: (config: RealTimeSyncConfig) => CDCReplicator;
}

/** Maximum number of recent events tracked for apply result correlation */
const MAX_RECENT_EVENTS = 1000;

/**
 * Orchestrates real-time CDC sync sessions between a source and target org.
 * Manages the lifecycle of CDCListener and CDCReplicator, tracks metrics,
 * provides status updates, and persists session configuration.
 */
export class RealTimeSyncOrchestrator {
  private readonly deps: RealTimeSyncOrchestratorDeps;
  private listener: CDCListener | null = null;
  private replicator: CDCReplicator | null = null;
  private config: RealTimeSyncConfig | null = null;
  private status: RealTimeSyncStatus = 'disconnected';
  private statusHandlers: StatusChangeHandler[] = [];
  private eventFeedHandlers: EventFeedHandler[] = [];
  private conflictFeedHandlers: ConflictFeedHandler[] = [];
  private eventsReceived = 0;
  private startedAt: string | null = null;
  private lastEventAt: string | null = null;
  private minuteEventCounts: number[] = [];
  private minuteTimer: ReturnType<typeof setInterval> | null = null;
  private currentMinuteCount = 0;
  private recentEvents: Map<number, CDCEvent> = new Map();

  constructor(deps: RealTimeSyncOrchestratorDeps) {
    this.deps = deps;
  }

  /**
   * Register a handler for sync status changes.
   * Called whenever the session transitions between states.
   * @returns An unsubscribe function that removes the handler.
   */
  onStatusChange(handler: StatusChangeHandler): () => void {
    this.statusHandlers.push(handler);
    return () => {
      const idx = this.statusHandlers.indexOf(handler);
      if (idx >= 0) {
        this.statusHandlers.splice(idx, 1);
      }
    };
  }

  /**
   * Register a handler for the live event feed.
   * Called for each CDC event received, with apply status.
   * @returns An unsubscribe function that removes the handler.
   */
  onEventFeed(handler: EventFeedHandler): () => void {
    this.eventFeedHandlers.push(handler);
    return () => {
      const idx = this.eventFeedHandlers.indexOf(handler);
      if (idx >= 0) {
        this.eventFeedHandlers.splice(idx, 1);
      }
    };
  }

  /**
   * Register a handler for conflict notifications.
   * Called when a replication conflict is detected.
   * @returns An unsubscribe function that removes the handler.
   */
  onConflictDetected(handler: ConflictFeedHandler): () => void {
    this.conflictFeedHandlers.push(handler);
    return () => {
      const idx = this.conflictFeedHandlers.indexOf(handler);
      if (idx >= 0) {
        this.conflictFeedHandlers.splice(idx, 1);
      }
    };
  }

  /**
   * Start a new real-time sync session with the given configuration.
   * Creates and wires the CDCListener and CDCReplicator.
   */
  async start(config: RealTimeSyncConfig): Promise<void> {
    if (this.status !== 'disconnected' && this.status !== 'error') {
      return;
    }

    this.config = config;
    this.resetMetrics();
    this.setStatus('connecting');

    this.listener = this.deps.createListener(config);
    this.replicator = this.deps.createReplicator(config);

    // Wire conflict feed: forward CDCReplicator conflicts to registered handlers
    this.replicator.setOnConflict((conflict) => {
      this.emitConflict(conflict);
    });

    // Wire listener events to replicator
    this.listener.onEvent((event) => {
      this.eventsReceived++;
      this.currentMinuteCount++;
      this.lastEventAt = new Date().toISOString();
      this.replicator?.receive(event);
      // Emit with applied=false initially -- replicator will confirm later
      this.emitEventFeed(event, false);
      // Track event for apply result correlation
      this.recentEvents.set(event.replayId, event);
      if (this.recentEvents.size > MAX_RECENT_EVENTS) {
        const firstKey = this.recentEvents.keys().next().value;
        if (firstKey !== undefined) {
          this.recentEvents.delete(firstKey);
        }
      }
    });

    this.listener.onConnection((connected) => {
      if (connected) {
        this.setStatus('syncing');
      } else if (!this.isStopped()) {
        this.setStatus('error');
      }
    });

    this.listener.onError((error) => {
      this.emitEventFeed(
        {
          replayId: -1,
          objectApiName: '',
          changeType: 'UPDATE',
          recordIds: [],
          changedFields: {},
          commitTimestamp: new Date().toISOString(),
          commitUser: '',
          transactionKey: '',
        },
        false,
        error.message,
      );
    });

    // Start minute counter
    this.minuteTimer = setInterval(() => {
      this.minuteEventCounts.push(this.currentMinuteCount);
      if (this.minuteEventCounts.length > 60) {
        this.minuteEventCounts = this.minuteEventCounts.slice(-60);
      }
      this.currentMinuteCount = 0;
    }, 60_000);

    this.replicator.start();

    try {
      await this.listener.start();
      this.startedAt = new Date().toISOString();
    } catch {
      this.setStatus('error');
    }
  }

  /**
   * Stop the current real-time sync session.
   * Shuts down both the listener and replicator gracefully.
   * Clears all handler arrays to prevent memory leaks.
   */
  async stop(): Promise<void> {
    if (this.minuteTimer) {
      clearInterval(this.minuteTimer);
      this.minuteTimer = null;
    }

    this.listener?.stop();

    if (this.replicator) {
      await this.replicator.stop();
    }

    this.listener = null;
    this.replicator = null;
    this.recentEvents.clear();
    this.setStatus('disconnected');
    this.statusHandlers = [];
    this.eventFeedHandlers = [];
    this.conflictFeedHandlers = [];
  }

  /**
   * Pause the current sync session.
   * The listener remains connected but events are not processed.
   */
  pause(): void {
    if (this.status === 'syncing') {
      this.setStatus('paused');
    }
  }

  /**
   * Resume a paused sync session.
   */
  resume(): void {
    if (this.status === 'paused') {
      this.setStatus('syncing');
    }
  }

  /** Get the current session status. */
  getStatus(): RealTimeSyncStatus {
    return this.status;
  }

  /** Get the current session configuration, if active. */
  getConfig(): RealTimeSyncConfig | null {
    return this.config;
  }

  /** Get the current session ID, if active. */
  getSessionId(): string | null {
    return this.config?.sessionId ?? null;
  }

  /**
   * Get current sync metrics.
   * Returns a snapshot of all tracked metrics for the active session.
   */
  getMetrics(): RealTimeSyncMetrics {
    const applied = this.replicator?.getTotalApplied() ?? 0;
    const failed = this.replicator?.getTotalFailed() ?? 0;
    const total = applied + failed;

    return {
      eventsReceived: this.eventsReceived,
      eventsApplied: applied,
      eventsFailed: failed,
      eventsPerMinute: this.calculateEventsPerMinute(),
      averageLagMs: this.replicator?.getAverageLagMs() ?? 0,
      currentLagMs: this.replicator?.getCurrentLagMs() ?? 0,
      errorRate: total > 0 ? Math.round((failed / total) * 100) : 0,
      startedAt: this.startedAt ?? new Date().toISOString(),
      lastEventAt: this.lastEventAt ?? undefined,
    };
  }

  /** Get the list of watched objects for the current session. */
  getWatchedObjects(): string[] {
    return this.config?.watchedObjects ?? [];
  }

  /**
   * Handle replicator apply result -- called by replicator's onApplyResult callback.
   * Emits an updated event feed entry with the final applied status.
   */
  handleApplyResult(replayId: number, success: boolean, error?: string): void {
    const event = this.recentEvents.get(replayId);
    if (event) {
      this.emitEventFeed(event, success, error);
    }
  }

  private isStopped(): boolean {
    return this.status === 'disconnected';
  }

  private setStatus(newStatus: RealTimeSyncStatus): void {
    if (this.status === newStatus) {
      return;
    }
    this.status = newStatus;
    for (const handler of this.statusHandlers) {
      handler(newStatus);
    }
  }

  private emitEventFeed(event: CDCEvent, applied: boolean, error?: string): void {
    for (const handler of this.eventFeedHandlers) {
      handler(event, applied, error);
    }
  }

  private emitConflict(conflict: CDCConflict): void {
    for (const handler of this.conflictFeedHandlers) {
      handler(conflict);
    }
  }

  private resetMetrics(): void {
    this.eventsReceived = 0;
    this.startedAt = null;
    this.lastEventAt = null;
    this.minuteEventCounts = [];
    this.currentMinuteCount = 0;
    this.recentEvents.clear();
  }

  private calculateEventsPerMinute(): number {
    if (this.minuteEventCounts.length === 0) {
      return this.currentMinuteCount;
    }

    let total = this.currentMinuteCount;
    for (const count of this.minuteEventCounts) {
      total += count;
    }
    return Math.round(total / (this.minuteEventCounts.length + 1));
  }
}
