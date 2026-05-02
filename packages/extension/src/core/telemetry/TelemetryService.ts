import { z } from 'zod';

// ── Telemetry Event Zod Schema ────────────────────────────

/** Schema for a telemetry event */
export const telemetryEventSchema = z.object({
  eventName: z.string().min(1),
  module: z.enum(['seed', 'sync', 'monitor', 'compare', 'dataops', 'automation', 'migration', 'plugins']),
  action: z.string().min(1),
  properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().default({}),
  duration: z.number().nonnegative().optional(),
  recordCount: z.number().int().nonnegative().optional(),
  errorType: z.string().optional(),
  success: z.boolean(),
  timestamp: z.string().min(1),
});

/** Inferred telemetry event type */
export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;

/** Module name type for telemetry */
export type TelemetryModule = TelemetryEvent['module'];

// ── Telemetry Summary ─────────────────────────────────────

/** Summary of telemetry data for a time period */
export interface TelemetrySummary {
  totalEvents: number;
  eventsByModule: Record<string, number>;
  eventsByAction: Record<string, number>;
  errorCount: number;
  errorsByType: Record<string, number>;
  averageDuration: number;
  totalRecordsProcessed: number;
  periodStart: string;
  periodEnd: string;
}

// ── Telemetry batch ───────────────────────────────────────

/** A batch of telemetry events ready for sending */
export interface TelemetryBatch {
  events: TelemetryEvent[];
  batchId: string;
  createdAt: string;
  extensionVersion: string;
}

// ── Storage interface ─────────────────────────────────────

/** Interface for persisting telemetry state */
export interface TelemetryStorage {
  getEnabled(): Promise<boolean>;
  setEnabled(enabled: boolean): Promise<void>;
  getEvents(): Promise<TelemetryEvent[]>;
  appendEvent(event: TelemetryEvent): Promise<void>;
  clearEvents(): Promise<void>;
}

/** Interface for sending telemetry batches */
export interface TelemetrySender {
  send(batch: TelemetryBatch): Promise<boolean>;
}

// ── TelemetryService ──────────────────────────────────────

/**
 * Anonymous, opt-in telemetry service for SandForge.
 *
 * Collects usage metrics without personal data:
 * - Modules used (seed, sync, compare, etc.)
 * - Operation sizes (record counts)
 * - Error types (classification only, no messages)
 * - Operation durations
 *
 * NO personal data, org identifiers, record content, or
 * Salesforce credentials are ever collected.
 *
 * Events are stored locally and batch-sent periodically.
 * Users must explicitly opt in before any data is collected.
 */
export class TelemetryService {
  private readonly storage: TelemetryStorage;
  private readonly sender: TelemetrySender;
  private readonly extensionVersion: string;
  private readonly batchSize: number;
  private enabled: boolean;
  private eventBuffer: TelemetryEvent[];

  constructor(
    storage: TelemetryStorage,
    sender: TelemetrySender,
    extensionVersion: string,
    batchSize: number = 50
  ) {
    this.storage = storage;
    this.sender = sender;
    this.extensionVersion = extensionVersion;
    this.batchSize = batchSize;
    this.enabled = false;
    this.eventBuffer = [];
  }

  /**
   * Initialize the telemetry service by loading the opt-in state.
   * Must be called before tracking events.
   */
  async initialize(): Promise<void> {
    this.enabled = await this.storage.getEnabled();
    if (this.enabled) {
      this.eventBuffer = await this.storage.getEvents();
    }
  }

  /**
   * Track a telemetry event. The event is validated and stored locally.
   * If telemetry is disabled, the event is silently dropped.
   * @param event - The telemetry event to record
   */
  async trackEvent(event: TelemetryEvent): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const validated = telemetryEventSchema.parse(event);
    this.eventBuffer.push(validated);
    await this.storage.appendEvent(validated);

    if (this.eventBuffer.length >= this.batchSize) {
      await this.flush();
    }
  }

  /**
   * Check whether telemetry collection is currently enabled.
   * @returns True if the user has opted in
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Set the telemetry opt-in state.
   * @param enabled - True to opt in, false to opt out
   */
  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    await this.storage.setEnabled(enabled);

    if (!enabled) {
      this.eventBuffer = [];
      await this.storage.clearEvents();
    }
  }

  /**
   * Flush all buffered events by sending them as a batch.
   * On success, clears the buffer and storage.
   * On failure, events remain in the buffer for the next flush.
   * @returns True if the batch was sent successfully
   */
  async flush(): Promise<boolean> {
    if (this.eventBuffer.length === 0) {
      return true;
    }

    const batch: TelemetryBatch = {
      events: [...this.eventBuffer],
      batchId: generateBatchId(),
      createdAt: new Date().toISOString(),
      extensionVersion: this.extensionVersion,
    };

    const success = await this.sender.send(batch);

    if (success) {
      this.eventBuffer = [];
      await this.storage.clearEvents();
    }

    return success;
  }

  /**
   * Get a summary of all stored telemetry events.
   * Useful for displaying usage statistics to the user.
   * @returns Aggregated telemetry summary
   */
  getSummary(): TelemetrySummary {
    const events = this.eventBuffer;
    const eventsByModule: Record<string, number> = {};
    const eventsByAction: Record<string, number> = {};
    const errorsByType: Record<string, number> = {};
    let errorCount = 0;
    let totalDuration = 0;
    let durationCount = 0;
    let totalRecords = 0;

    for (const event of events) {
      eventsByModule[event.module] = (eventsByModule[event.module] ?? 0) + 1;
      eventsByAction[event.action] = (eventsByAction[event.action] ?? 0) + 1;

      if (!event.success) {
        errorCount++;
        if (event.errorType) {
          errorsByType[event.errorType] = (errorsByType[event.errorType] ?? 0) + 1;
        }
      }

      if (event.duration !== undefined) {
        totalDuration += event.duration;
        durationCount++;
      }

      if (event.recordCount !== undefined) {
        totalRecords += event.recordCount;
      }
    }

    const timestamps = events.map((e) => e.timestamp).sort();

    return {
      totalEvents: events.length,
      eventsByModule,
      eventsByAction,
      errorCount,
      errorsByType,
      averageDuration: durationCount > 0 ? totalDuration / durationCount : 0,
      totalRecordsProcessed: totalRecords,
      periodStart: timestamps[0] ?? '',
      periodEnd: timestamps[timestamps.length - 1] ?? '',
    };
  }

  /**
   * Get the current number of buffered events.
   * @returns Number of events in the buffer
   */
  getBufferSize(): number {
    return this.eventBuffer.length;
  }
}

/**
 * Generate a unique batch identifier (RFC4122 v4 via platform crypto).
 * @returns Batch ID string
 */
function generateBatchId(): string {
  return globalThis.crypto.randomUUID();
}
