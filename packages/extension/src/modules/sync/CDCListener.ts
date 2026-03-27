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
    callback: (message: Record<string, unknown>) => void
  ) => StreamingSubscription;
  disconnect: () => void;
}

/** Factory function that creates a StreamingClient from an org connection */
export type StreamingClientFactory = (orgId: string) => Promise<StreamingClient>;

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
}

/**
 * Listens to Salesforce Change Data Capture events via the Streaming API.
 * Connects to `/data/ChangeEvents` (or per-object channels), parses incoming
 * CDC events, and emits typed events to registered handlers.
 * Supports automatic reconnection with exponential backoff.
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

  constructor(config: CDCListenerConfig, clientFactory: StreamingClientFactory) {
    this.config = config;
    this.clientFactory = clientFactory;
    this.lastReplayId = config.initialReplayId;
  }

  /**
   * Register a handler for CDC events.
   * The handler is called for each parsed and validated CDC event.
   */
  onEvent(handler: CDCEventHandler): void {
    this.eventHandlers.push(handler);
  }

  /**
   * Register a handler for connection state changes.
   * Called with `true` when connected, `false` when disconnected.
   */
  onConnection(handler: CDCConnectionHandler): void {
    this.connectionHandlers.push(handler);
  }

  /**
   * Register a handler for errors.
   * Called when a non-recoverable error occurs or when parsing fails.
   */
  onError(handler: CDCErrorHandler): void {
    this.errorHandlers.push(handler);
  }

  /**
   * Start listening for CDC events.
   * Connects to the Streaming API and subscribes to the configured channels.
   */
  async start(): Promise<void> {
    this.stopped = false;
    this.reconnectAttempts = 0;
    await this.connect();
  }

  /**
   * Stop listening for CDC events.
   * Cancels all subscriptions, disconnects, and clears reconnect timers.
   */
  stop(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    this.cancelSubscriptions();
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
    this.setConnected(false);
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
      const subscription = this.client.subscribe(
        channel,
        this.lastReplayId,
        (message) => this.handleMessage(message)
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

    return this.config.watchedObjects.map(
      (objectName) => buildCdcChannel(objectName)
    );
  }

  private handleMessage(message: Record<string, unknown>): void {
    try {
      const payload = message.payload ?? message;
      const parsed = this.parseEvent(payload as Record<string, unknown>);
      if (parsed) {
        this.lastReplayId = parsed.replayId;
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

  private scheduleReconnect(): void {
    if (this.stopped) {
      return;
    }

    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.emitError(
        new Error(`Max reconnect attempts (${this.config.maxReconnectAttempts}) reached`)
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
    const exponentialDelay =
      this.config.baseReconnectDelayMs * Math.pow(2, this.reconnectAttempts);
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
