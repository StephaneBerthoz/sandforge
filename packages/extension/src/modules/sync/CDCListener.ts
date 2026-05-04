import type { CDCEvent, CDCChangeType, ApiName } from '@sandforge/shared';
import { buildCdcChannel } from '@sandforge/shared';
import { z } from 'zod';

/** Zod schema for validating raw CDC event payloads from the Streaming API */
const CDCPayloadSchema = z.object({
  ChangeEventHeader: z.object({
    entityName: z.string(),
    changeType: z.enum(['CREATE', 'UPDATE', 'DELETE', 'UNDELETE']),
    recordIds: z.array(z.string()),
    commitTimestamp: z.number(),
    commitUser: z.string(),
    transactionKey: z.string(),
    changeOrigin: z.string().optional(),
    changedFields: z.array(z.string()).optional(),
  }),
});

/** Raw CDC payload shape from Salesforce */
type RawCDCPayload = z.infer<typeof CDCPayloadSchema> & Record<string, unknown>;

/** Callback for CDC events */
export type CDCEventHandler = (event: CDCEvent) => void;

/** Callback for connection state changes */
export type CDCConnectionHandler = (connected: boolean) => void;

/** Callback for errors */
export type CDCErrorHandler = (error: Error) => void;

/** jsforce Streaming subscription — minimal interface for decoupling */
export interface StreamingSubscription {
  cancel: () => void;
}

/** jsforce Streaming client — minimal interface for decoupling */
export interface StreamingClient {
  subscribe: (
    channel: string,
    replayId: number,
    callback: (message: Record<string, unknown>) => void,
  ) => StreamingSubscription;
  disconnect: () => void;
}

/** Factory function that creates a StreamingClient from an org connection */
export type StreamingClientFactory = (orgId: string) => Promise<StreamingClient>;

/**
 * Interface for persisting and loading replay IDs to/from durable storage.
 * Enables CDC subscriptions to resume from the last known position across restarts.
 */
export interface ReplayIdPersister {
  /** Load the last saved replay ID for a given org and object */
  load(orgId: string, objectName: string): Promise<number>;
  /** Save a replay ID for a given org and object */
  save(orgId: string, objectName: string, replayId: number): Promise<void>;
}

/** Watchdog silence threshold in milliseconds (4 minutes) */
const WATCHDOG_SILENCE_THRESHOLD_MS = 240_000;

/** Watchdog check interval in milliseconds (1 minute) */
const WATCHDOG_CHECK_INTERVAL_MS = 60_000;

/** Configuration for the CDC listener */
export interface CDCListenerConfig {
  /** Source org identifier */
  orgId: string;
  /** Objects to subscribe to (empty = subscribe to all via /data/ChangeEvents) */
  watchedObjects: ApiName[];
  /** Starting replay ID (-1 = tip, -2 = all available) */
  initialReplayId: number;
  /** Maximum reconnect attempts before giving up */
  maxReconnectAttempts: number;
  /** Base delay for exponential backoff in milliseconds */
  baseReconnectDelayMs: number;
  /** Optional persister for replay ID persistence to globalState */
  replayIdPersister?: ReplayIdPersister;
}

/**
 * Listens to Salesforce Change Data Capture events via the Streaming API.
 * Connects to `/data/ChangeEvents` (or per-object channels), parses incoming
 * CDC events, and emits typed events to registered handlers.
 * Supports automatic reconnection with exponential backoff, replay ID
 * persistence, and a watchdog timer for stale CometD connections.
 */
export class CDCListener {
  private readonly config: CDCListenerConfig;
  private readonly clientFactory: StreamingClientFactory;
  private client: StreamingClient | null = null;
  private subscriptions: StreamingSubscription[] = [];
  private eventHandlers: CDCEventHandler[] = [];
  private connectionHandlers: CDCConnectionHandler[] = [];
  private errorHandlers: CDCErrorHandler[] = [];
  private connected = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastReplayId: number;
  private stopped = false;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastActivityTime = Date.now();

  constructor(config: CDCListenerConfig, clientFactory: StreamingClientFactory) {
    this.config = config;
    this.clientFactory = clientFactory;
    this.lastReplayId = config.initialReplayId;
  }

  /**
   * Register a handler for CDC events.
   * The handler is called for each parsed and validated CDC event.
   * @returns An unsubscribe function that removes the handler.
   */
  onEvent(handler: CDCEventHandler): () => void {
    this.eventHandlers.push(handler);
    return () => {
      const idx = this.eventHandlers.indexOf(handler);
      if (idx >= 0) {
        this.eventHandlers.splice(idx, 1);
      }
    };
  }

  /**
   * Register a handler for connection state changes.
   * Called with `true` when connected, `false` when disconnected.
   * @returns An unsubscribe function that removes the handler.
   */
  onConnection(handler: CDCConnectionHandler): () => void {
    this.connectionHandlers.push(handler);
    return () => {
      const idx = this.connectionHandlers.indexOf(handler);
      if (idx >= 0) {
        this.connectionHandlers.splice(idx, 1);
      }
    };
  }

  /**
   * Register a handler for errors.
   * Called when a non-recoverable error occurs or when parsing fails.
   * @returns An unsubscribe function that removes the handler.
   */
  onError(handler: CDCErrorHandler): () => void {
    this.errorHandlers.push(handler);
    return () => {
      const idx = this.errorHandlers.indexOf(handler);
      if (idx >= 0) {
        this.errorHandlers.splice(idx, 1);
      }
    };
  }

  /**
   * Start listening for CDC events.
   * Connects to the Streaming API and subscribes to the configured channels.
   * If a replay ID persister is configured, loads the last known replay IDs.
   */
  async start(): Promise<void> {
    this.stopped = false;
    this.reconnectAttempts = 0;

    // Load persisted replay IDs if persister is configured
    if (this.config.replayIdPersister && this.config.watchedObjects.length > 0) {
      await this.loadPersistedReplayId();
    }

    await this.connect();
  }

  /**
   * Stop listening for CDC events.
   * Cancels all subscriptions, disconnects, clears timers, and clears handlers.
   */
  stop(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    this.clearWatchdogTimer();
    this.cancelSubscriptions();
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
    this.setConnected(false);
    this.eventHandlers = [];
    this.connectionHandlers = [];
    this.errorHandlers = [];
  }

  /** Whether the listener is currently connected to the Streaming API. */
  isConnected(): boolean {
    return this.connected;
  }

  /** The last replay ID received, for resuming subscriptions. */
  getLastReplayId(): number {
    return this.lastReplayId;
  }

  /** The current reconnect attempt count. */
  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  private async connect(): Promise<void> {
    try {
      this.client = await this.clientFactory(this.config.orgId);
      this.subscribeToChannels();
      this.setConnected(true);
      this.reconnectAttempts = 0;
      this.lastActivityTime = Date.now();
      this.startWatchdog();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emitError(error);
      this.scheduleReconnect();
    }
  }

  private subscribeToChannels(): void {
    if (!this.client) {
      return;
    }

    const channels = this.buildChannels();

    for (const channel of channels) {
      const subscription = this.client.subscribe(channel, this.lastReplayId, (message) =>
        this.handleMessage(message),
      );
      this.subscriptions.push(subscription);
    }
  }

  /**
   * Build the list of Streaming API channels to subscribe to.
   * Uses per-object channels when specific objects are configured,
   * otherwise subscribes to the global `/data/ChangeEvents` channel.
   */
  private buildChannels(): string[] {
    if (this.config.watchedObjects.length === 0) {
      return ['/data/ChangeEvents'];
    }

    return this.config.watchedObjects.map((objectName) => buildCdcChannel(objectName));
  }

  private handleMessage(message: Record<string, unknown>): void {
    this.lastActivityTime = Date.now();

    try {
      const payload = message.payload ?? message;
      const parsed = this.parseEvent(payload as Record<string, unknown>);
      if (parsed) {
        this.lastReplayId = parsed.replayId;
        this.persistReplayId(parsed.objectApiName, parsed.replayId);
        this.emitEvent(parsed);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emitError(error);
    }
  }

  /**
   * Parse a raw CDC payload into a typed CDCEvent.
   * Validates the payload structure using Zod before extracting fields.
   */
  parseEvent(raw: Record<string, unknown>): CDCEvent | null {
    const result = CDCPayloadSchema.safeParse(raw);
    if (!result.success) {
      this.emitError(new Error(`Invalid CDC payload: ${result.error.message}`));
      return null;
    }

    const rawTyped = raw as RawCDCPayload;
    const header = result.data.ChangeEventHeader;

    const changedFields: Record<string, unknown> = {};
    const headerChangedFields = header.changedFields ?? [];
    for (const fieldName of headerChangedFields) {
      if (fieldName in rawTyped && fieldName !== 'ChangeEventHeader') {
        changedFields[fieldName] = rawTyped[fieldName];
      }
    }

    // Also capture top-level fields that are not the header
    for (const [key, value] of Object.entries(rawTyped)) {
      if (key !== 'ChangeEventHeader' && !(key in changedFields)) {
        changedFields[key] = value;
      }
    }

    return {
      replayId: typeof raw.replayId === 'number' ? raw.replayId : this.lastReplayId + 1,
      objectApiName: header.entityName,
      changeType: header.changeType as CDCChangeType,
      recordIds: header.recordIds,
      changedFields,
      commitTimestamp: new Date(header.commitTimestamp).toISOString(),
      commitUser: header.commitUser,
      transactionKey: header.transactionKey,
    };
  }

  /**
   * Load persisted replay IDs and use the minimum as the starting replay ID.
   * Falls back to the configured initial replay ID on error.
   */
  private async loadPersistedReplayId(): Promise<void> {
    const persister = this.config.replayIdPersister;
    if (!persister) {
      return;
    }

    try {
      const replayIds: number[] = [];
      for (const objectName of this.config.watchedObjects) {
        const replayId = await persister.load(this.config.orgId, objectName);
        if (replayId > 0) {
          replayIds.push(replayId);
        }
      }
      if (replayIds.length > 0) {
        this.lastReplayId = Math.min(...replayIds);
      }
    } catch {
      // Fall back to configured initial replay ID on load failure
      this.emitError(new Error('Failed to load persisted replay IDs, using initial value'));
    }
  }

  /**
   * Persist the replay ID for a given object (fire and forget).
   */
  private persistReplayId(objectName: string, replayId: number): void {
    const persister = this.config.replayIdPersister;
    if (!persister) {
      return;
    }
    persister.save(this.config.orgId, objectName, replayId).catch(() => {
      // Silently ignore save errors -- replay IDs are best-effort
    });
  }

  /**
   * Start the watchdog timer that force-reconnects after a silence threshold.
   * Checks every 60 seconds if the last activity was more than 240 seconds ago.
   */
  private startWatchdog(): void {
    this.clearWatchdogTimer();
    this.watchdogTimer = setInterval(() => {
      const silenceMs = Date.now() - this.lastActivityTime;
      if (silenceMs > WATCHDOG_SILENCE_THRESHOLD_MS) {
        this.emitError(
          new Error(
            `Watchdog: no activity for ${Math.round(silenceMs / 1000)}s, forcing reconnect`,
          ),
        );
        this.forceReconnect();
      }
    }, WATCHDOG_CHECK_INTERVAL_MS);
  }

  /**
   * Force a reconnection by cancelling current subscriptions,
   * disconnecting, and connecting again.
   */
  private forceReconnect(): void {
    this.cancelSubscriptions();
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
    this.setConnected(false);
    this.lastActivityTime = Date.now();
    void this.connect();
  }

  private clearWatchdogTimer(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) {
      return;
    }

    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.emitError(
        new Error(`Max reconnect attempts (${this.config.maxReconnectAttempts}) reached`),
      );
      return;
    }

    const delay = this.calculateBackoffDelay();
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      void this.connect();
    }, delay);
  }

  /**
   * Calculate exponential backoff delay with jitter.
   * Caps at 30 seconds to avoid excessively long waits.
   */
  private calculateBackoffDelay(): number {
    const exponentialDelay = this.config.baseReconnectDelayMs * Math.pow(2, this.reconnectAttempts);
    const cappedDelay = Math.min(exponentialDelay, 30_000);
    const jitter = Math.random() * 0.3 * cappedDelay;
    return cappedDelay + jitter;
  }

  private cancelSubscriptions(): void {
    for (const sub of this.subscriptions) {
      sub.cancel();
    }
    this.subscriptions = [];
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setConnected(value: boolean): void {
    this.connected = value;
    for (const handler of this.connectionHandlers) {
      handler(value);
    }
  }

  private emitEvent(event: CDCEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }

  private emitError(error: Error): void {
    for (const handler of this.errorHandlers) {
      handler(error);
    }
  }
}
