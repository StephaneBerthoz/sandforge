import type {
  ConflictStrategy,
  FieldResolution,
  RealTimeEventOutcome,
  RealTimeSyncMetrics,
} from '@sandforge/shared';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { CdcSubscription, type SubscribeOutcome } from './CdcSubscription.js';
import { isOwnWrite, type ChangeEvent } from './changeEvent.js';
import type { CometdTransport } from './cometdTransport.js';
import type { EventResult, HeldChange, RealtimeApplier, Resolution } from './RealtimeApplier.js';
import type { ReplayStore } from './ReplayStore.js';

/** One change as the feed shows it. */
export interface FeedEvent {
  replayId: number;
  objectApiName: string;
  changeType: string;
  recordIds: string[];
  commitTimestamp: string;
  changedFields: Record<string, unknown>;
  commitUser: string;
  transactionKey: string;
  applied: boolean;
  outcome: RealTimeEventOutcome;
  error?: string;
}

/** What a session asks of the writer of one object. */
export type ChangeApplier = Pick<RealtimeApplier, 'apply' | 'resolve'>;

/** Where a session is. */
export type SessionState = 'connecting' | 'syncing' | 'error' | 'disconnected';

/** What the page is told of a session. */
export interface SessionSnapshot {
  status: SessionState;
  sessionId: string;
  watchedObjects: string[];
  refused: Array<{ objectApiName: string; reason: string }>;
  notes: string[];
  error?: string;
}

/** Where a session's news goes. */
export interface RealtimeSink {
  /** Changes processed in one flush, oldest first. */
  events(batch: FeedEvent[]): void;
  /** A change held for a decision. */
  conflict(change: HeldChange): void;
  /** The session changed state on its own: it lost its connection, got it back, or gave up. */
  status(snapshot: SessionSnapshot): void;
}

/** What a session is started with. */
export interface RealtimeSessionConfig {
  sessionId: string;
  /** Objects whose change events are received. */
  watchedObjects: string[];
  /** Watched objects whose changes are written to the target, by API name. */
  appliers: ReadonlyMap<string, ChangeApplier>;
  /** Longest a received change waits before it is processed. */
  flushIntervalMs: number;
  /** Most changes processed together. */
  maxBatchSize: number;
}

/** Dependencies of a {@link RealtimeSession}. */
export interface RealtimeSessionDeps {
  /** A new CometD connection to the source org, with credentials fresh enough to use. */
  openTransport: () => Promise<CometdTransport>;
  /** Resume points of the source org's channels. */
  replayStore: Pick<ReplayStore, 'get' | 'save'>;
  sink: RealtimeSink;
  log: (message: string) => void;
  now?: () => number;
}

/**
 * Pauses between attempts to reconnect a session whose connection the org
 * closed for good — an access token that expired under a long session is the
 * usual cause, and a new connection carries a fresh one.
 */
const RECONNECT_DELAYS_MS = [2_000, 10_000, 30_000];

/** How far back the per-minute rate looks. */
const RATE_WINDOW_MS = 60_000;

/**
 * One real-time session: the source org's change events for the watched
 * objects, written to the target for the objects the user applies.
 *
 * Changes are processed in batches, in the order the org sent them. After each
 * batch the replay id of its last change is stored per channel, so a session
 * started later on the same org resumes right after it — what was received but
 * not yet processed when a session stops is replayed, not lost.
 */
export class RealtimeSession {
  private state: SessionState = 'disconnected';
  private subscription: CdcSubscription | undefined;
  private watched: string[] = [];
  private refused: Array<{ objectApiName: string; reason: string }> = [];
  private notes: string[] = [];
  private error: string | undefined;
  private stopped = false;

  private buffer: ChangeEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> = Promise.resolve();

  private readonly held = new Map<string, { change: HeldChange; applier: ChangeApplier }>();

  private startedAt = 0;
  private lastEventAt: number | undefined;
  private received = 0;
  private applied = 0;
  private failed = 0;
  private lagTotal = 0;
  private lagCount = 0;
  private currentLag = 0;
  private recentReceipts: number[] = [];

  /**
   * @param config - Id, objects, appliers and batching.
   * @param deps - Connection, resume points, sink and log.
   */
  constructor(
    private readonly config: RealtimeSessionConfig,
    private readonly deps: RealtimeSessionDeps,
  ) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The session's id. */
  get sessionId(): string {
    return this.config.sessionId;
  }

  /** Whether the session is receiving, or trying to. */
  get running(): boolean {
    return this.state === 'syncing' || this.state === 'connecting';
  }

  /**
   * Subscribe to every watched object.
   *
   * @returns What the org accepted and refused. With nothing accepted the
   *   session ends in `error`.
   */
  async start(): Promise<SubscribeOutcome> {
    this.state = 'connecting';
    this.startedAt = this.now();
    let outcome: SubscribeOutcome;
    try {
      outcome = await this.open(this.config.watchedObjects);
    } catch (err: unknown) {
      this.state = 'error';
      this.error = extractErrorMessage(err);
      throw err;
    }
    this.watched = outcome.subscribed;
    this.refused = outcome.refused;
    this.notes = outcome.notes;
    if (outcome.subscribed.length === 0) {
      this.state = 'error';
      this.error = 'The source org refused a subscription to every watched object.';
      this.closeSubscription();
    } else {
      this.state = 'syncing';
    }
    return outcome;
  }

  /**
   * Close the subscription. A batch being written is finished and its resume
   * point stored; what was received and not yet processed is replayed by the
   * next session.
   *
   * @returns How many held changes were dropped undecided.
   */
  async stop(): Promise<number> {
    this.stopped = true;
    this.state = 'disconnected';
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.closeSubscription();
    this.buffer = [];
    await this.flushing;
    const dropped = this.held.size;
    this.held.clear();
    return dropped;
  }

  /** Where the session is, for the page. */
  snapshot(): SessionSnapshot {
    return {
      status: this.state,
      sessionId: this.config.sessionId,
      watchedObjects: this.watched,
      refused: this.refused,
      notes: this.notes,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /** What the session has done so far. */
  metrics(): RealTimeSyncMetrics {
    const now = this.now();
    this.recentReceipts = this.recentReceipts.filter((at) => now - at < RATE_WINDOW_MS);
    const settled = this.applied + this.failed;
    return {
      eventsReceived: this.received,
      eventsApplied: this.applied,
      eventsFailed: this.failed,
      eventsPerMinute: this.recentReceipts.length,
      averageLagMs: this.lagCount > 0 ? this.lagTotal / this.lagCount : 0,
      currentLagMs: this.currentLag,
      errorRate: settled > 0 ? (this.failed / settled) * 100 : 0,
      startedAt: new Date(this.startedAt).toISOString(),
      ...(this.lastEventAt !== undefined
        ? { lastEventAt: new Date(this.lastEventAt).toISOString() }
        : {}),
    };
  }

  /**
   * Decide a change held for a decision.
   *
   * @param conflictId - The id the Conflicts tab knows it by.
   * @param resolution - The strategy picked, or `manual` with per-field picks.
   * @param fieldResolutions - The picks of a `manual` resolution.
   */
  async resolveConflict(
    conflictId: string,
    resolution: ConflictStrategy,
    fieldResolutions?: Record<string, FieldResolution>,
  ): Promise<Resolution> {
    const entry = this.held.get(conflictId);
    if (!entry) {
      return {
        success: false,
        resolvedValues: {},
        error:
          'This change is no longer held: the session that held it has stopped, or it was ' +
          'already decided.',
      };
    }
    const result = await entry.applier.resolve(entry.change, resolution, fieldResolutions);
    if (result.success) this.held.delete(conflictId);
    return result;
  }

  private closeSubscription(): void {
    this.subscription?.close();
    this.subscription = undefined;
  }

  private async open(objects: readonly string[]): Promise<SubscribeOutcome> {
    const transport = await this.deps.openTransport();
    transport.onDown((reason) => {
      void this.reconnect(reason);
    });
    this.subscription = new CdcSubscription({
      transport,
      replayStore: this.deps.replayStore,
      onEvent: (event) => this.receive(event),
      onUnreadable: (channel, reason) => this.deps.log(`[WARN] realtime ${channel}: ${reason}`),
    });
    return this.subscription.open(objects);
  }

  /** A connection the org closed for good is reopened, from the stored resume points. */
  private async reconnect(reason: string): Promise<void> {
    if (this.stopped || this.state !== 'syncing') return;
    this.state = 'connecting';
    this.error = `The connection to the source org was closed (${reason}); reconnecting.`;
    this.deps.sink.status(this.snapshot());
    this.closeSubscription();
    // What was received and not processed is replayed by the new subscription.
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    await this.flushing;
    this.buffer = [];

    for (const delay of RECONNECT_DELAYS_MS) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (this.stopped) return;
      try {
        const outcome = await this.open(this.watched);
        if (outcome.subscribed.length > 0) {
          this.watched = outcome.subscribed;
          this.notes = [...this.notes, ...outcome.notes];
          this.state = 'syncing';
          this.error = undefined;
          this.deps.sink.status(this.snapshot());
          return;
        }
        this.closeSubscription();
      } catch (err: unknown) {
        this.deps.log(`[WARN] realtime reconnect failed: ${extractErrorMessage(err)}`);
      }
    }
    if (this.stopped) return;
    this.state = 'error';
    this.error = `The connection to the source org was closed (${reason}) and could not be reopened.`;
    this.deps.sink.status(this.snapshot());
  }

  private receive(event: ChangeEvent): void {
    if (this.stopped) return;
    const now = this.now();
    this.received++;
    this.lastEventAt = now;
    this.recentReceipts.push(now);
    this.buffer.push(event);
    this.scheduleFlush(
      this.buffer.length >= this.config.maxBatchSize ? 0 : this.config.flushIntervalMs,
    );
  }

  private scheduleFlush(delayMs: number): void {
    if (this.flushTimer !== undefined) {
      if (delayMs > 0) return;
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flushing = this.flushing.then(() => this.flush());
    }, delayMs);
  }

  private async flush(): Promise<void> {
    while (this.buffer.length > 0 && !this.stopped) {
      const batch = this.buffer.splice(0, this.config.maxBatchSize);
      try {
        await this.process(batch);
      } catch (err: unknown) {
        this.deps.log(`[ERR] realtime batch: ${extractErrorMessage(err)}`);
      }
    }
  }

  private async process(batch: ChangeEvent[]): Promise<void> {
    const results: EventResult[] = batch.map(() => ({ outcome: 'watched' }));
    const byObject = new Map<string, number[]>();
    batch.forEach((event, index) => {
      if (isOwnWrite(event)) {
        results[index] = { outcome: 'own-write' };
      } else if (this.config.appliers.has(event.objectApiName)) {
        byObject.set(event.objectApiName, [...(byObject.get(event.objectApiName) ?? []), index]);
      }
    });

    for (const [objectApiName, indexes] of byObject) {
      const applier = this.config.appliers.get(objectApiName);
      if (!applier) continue;
      try {
        const { results: applied, held } = await applier.apply(indexes.map((i) => batch[i]));
        applied.forEach((result, j) => {
          results[indexes[j]] = result;
        });
        for (const change of held) {
          this.held.set(change.conflictId, { change, applier });
          this.deps.sink.conflict(change);
        }
      } catch (err: unknown) {
        const error = extractErrorMessage(err);
        for (const index of indexes) results[index] = { outcome: 'failed', error };
      }
    }

    const processedAt = this.now();
    const positions = new Map<string, number>();
    batch.forEach((event, index) => {
      const result = results[index];
      if (result.outcome === 'applied') this.applied++;
      if (result.outcome === 'failed') this.failed++;
      const lag = Math.max(0, processedAt - event.commitTimestamp);
      this.lagTotal += lag;
      this.lagCount++;
      this.currentLag = lag;
      positions.set(event.channel, Math.max(positions.get(event.channel) ?? 0, event.replayId));
    });

    this.deps.sink.events(batch.map((event, index) => feedEvent(event, results[index])));
    this.deps.replayStore.save(positions);
  }
}

/** A change as the feed shows it. */
function feedEvent(event: ChangeEvent, result: EventResult): FeedEvent {
  const changedFields: Record<string, unknown> = {};
  for (const name of event.changedFieldNames) {
    if (name in event.values) changedFields[name] = event.values[name];
  }
  return {
    replayId: event.replayId,
    objectApiName: event.objectApiName,
    changeType: event.changeType,
    recordIds: event.recordIds,
    commitTimestamp: new Date(event.commitTimestamp).toISOString(),
    // A creation lists no changed field: everything it carries is new.
    changedFields: event.changedFieldNames.length > 0 ? changedFields : { ...event.values },
    commitUser: event.commitUser,
    transactionKey: event.transactionKey,
    applied: result.outcome === 'applied',
    outcome: result.outcome,
    ...(result.error ? { error: result.error } : {}),
  };
}
