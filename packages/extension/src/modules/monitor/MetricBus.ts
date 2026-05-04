import {
  type MetricEventTypeMap,
  MetricEventSchemaByType,
  type MetricSample,
  assertNever,
} from '@sandforge/shared';

import { TypedEventEmitter } from '../../core/common/TypedEventEmitter.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';

/**
 * Minimal logger surface MetricBus needs (matches the existing
 * `logger.warn(msg, meta)` shape exported by `packages/extension/src/logger.ts`
 * AND the `services.telemetry.logger` shape from the Phase 01 adapters).
 */
export interface MetricBusLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Minimal bridge surface MetricBus needs to forward batched samples and
 * high-priority events to the WebView. Kept narrow so unit tests can
 * supply `{ send: vi.fn() }` without recreating the full MessageBroker.
 */
export interface MetricBusBridge {
  /**
   * Send an enveloped message to the webview. The MetricBus calls this with
   * the matching `monitor:*` envelope shape registered in
   * `packages/shared/src/bridge/messageSchemas.ts`.
   */
  send(message: { type: keyof MetricEventTypeMap; payload: unknown }): void;
}

/** Construction-time options for {@link MetricBus}. */
export interface MetricBusOptions {
  /** Bridge facade for forwarding batched samples + high-priority events. */
  bridge?: MetricBusBridge;
  /** Logger for Zod validation failures (does NOT crash the bus). */
  logger?: MetricBusLogger;
  /**
   * Coalescing window in ms. Defaults to 250 ms — see RESEARCH P-03.9
   * (event-flood mitigation). Pass `0` to disable coalescing entirely
   * (every `monitor:metric` emit forwards immediately — for tests).
   */
  coalesceWindowMs?: number;
}

/** Default coalescing window — see RESEARCH P-03.9. */
export const DEFAULT_COALESCE_WINDOW_MS = 250;

/**
 * Phase 03 Plan 03-01 — typed metric event bus.
 *
 * # Responsibilities
 *
 * 1. **In-process pub/sub** — extends `TypedEventEmitter<MetricEventTypeMap>`,
 *    inheriting listener-isolation (a throwing subscriber does not crash its
 *    siblings) and the canonical `on(type, listener) -> unsubscribe` contract.
 * 2. **Zod validation at the emit boundary** — every emit consults
 *    `MetricEventSchemaByType[type]` and rejects invalid payloads with a
 *    `logger.warn` call. The bus MUST NOT throw — a probe must keep running
 *    even if it accidentally emits a malformed sample.
 * 3. **Coalesced bridge forwarding** — `monitor:metric` emits are batched
 *    into `monitor:metrics:batch` envelopes over a 250 ms window before
 *    being posted across the WebView bridge (P-03.9).
 * 4. **High-priority bypass** — `monitor:drift:detected`,
 *    `monitor:anomaly:detected`, and `monitor:fleet:summary` events forward
 *    to the bridge synchronously (no coalescing) because they drive UI
 *    surfaces (alerts, banners) that should not feel delayed.
 *
 * # Non-responsibilities
 *
 * - Does NOT validate inbound messages from the webview — that is the
 *   broker's job (already covered by Phase 01 + the new Plan 03-01-task-02
 *   schema entries).
 * - Does NOT persist events — `TimeSeriesStore` (Plan 03-02) owns persistence.
 * - Does NOT subscribe to AlertEngine — Plan 03-05 wires the bridge between
 *   anomaly events and `AlertInstance` synthesis.
 *
 * # Why subclass `TypedEventEmitter` rather than wrap it?
 *
 * `TypedEventEmitter.emit()` is `protected`; consumers cannot fire events on
 * an instance from the outside — only subclasses can. This is by design: it
 * keeps `emit` ownership with the publisher, not random callers. MetricBus
 * exposes its own public {@link emit} that adds Zod validation + coalescing
 * + bridge forwarding before delegating to the protected base.
 */
export class MetricBus extends TypedEventEmitter<MetricEventTypeMap> {
  private readonly bridge: MetricBusBridge | undefined;
  private readonly logger: MetricBusLogger | undefined;
  private readonly coalesceWindowMs: number;

  /** Pending samples awaiting a flush — populated by `monitor:metric` emits. */
  private pendingSamples: MetricSample[] = [];
  /** Active coalesce timer; `undefined` when no flush is scheduled. */
  private coalesceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: MetricBusOptions = {}) {
    super();
    this.bridge = options.bridge;
    this.logger = options.logger;
    this.coalesceWindowMs = options.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS;
  }

  /**
   * Emit a typed metric event.
   *
   * - Zod-validates the payload via `MetricEventSchemaByType[type]`. On
   *   failure, logs via `logger.warn` and returns `false` — the bus never
   *   throws.
   * - On success, fans out to every subscriber, then routes to bridge:
   *     - `monitor:metric` -> coalescing buffer (flushed after the window).
   *     - high-priority events -> bridge.send synchronously.
   *
   * @returns `true` when the event was validated + dispatched, `false` when
   *   validation failed.
   */
  override emit<K extends keyof MetricEventTypeMap>(
    type: K,
    payload: MetricEventTypeMap[K],
  ): boolean {
    const schema = MetricEventSchemaByType[type];
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      this.logger?.warn('MetricBus rejected invalid payload', {
        type: String(type),
        issues: parsed.error.issues.map(
          (issue: { path: (string | number)[]; code: string; message: string }) => ({
            path: issue.path,
            code: issue.code,
            message: issue.message,
          }),
        ),
      });
      return false;
    }

    // Fan out to in-process subscribers first (cheapest path).
    super.emit(type, payload);

    // Then route to bridge with the right cadence.
    this.routeToBridge(type, payload);
    return true;
  }

  /**
   * Subscribe to a typed event. Returns an unsubscribe function — same
   * contract as the inherited `TypedEventEmitter.on`.
   */
  subscribe<K extends keyof MetricEventTypeMap>(
    type: K,
    handler: (payload: MetricEventTypeMap[K]) => void,
  ): () => void {
    return this.on(type, handler);
  }

  /**
   * Tear down — removes every subscriber AND clears any pending coalesce
   * timer (so a delayed flush does not fire after the bus is disposed).
   */
  dispose(): void {
    if (this.coalesceTimer !== undefined) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = undefined;
    }
    this.pendingSamples = [];
    this.removeAllListeners();
  }

  /**
   * Internal — picks the right bridge cadence per event type.
   *
   * The exhaustive switch + `assertNever(type)` is the P-03.8 mitigation:
   * adding a new {@link MetricEventTypeMap} key without handling it here
   * fails the TypeScript build.
   */
  private routeToBridge<K extends keyof MetricEventTypeMap>(
    type: K,
    payload: MetricEventTypeMap[K],
  ): void {
    if (!this.bridge) {
      return;
    }

    switch (type) {
      case 'monitor:metric': {
        // Coalesce — accumulate the sample; schedule a flush if not already.
        this.pendingSamples.push(payload as MetricSample);
        if (this.coalesceWindowMs <= 0) {
          // Coalescing disabled — flush synchronously.
          this.flushBatch();
          return;
        }
        if (this.coalesceTimer === undefined) {
          this.coalesceTimer = setTimeout(() => this.flushBatch(), this.coalesceWindowMs);
        }
        return;
      }
      case 'monitor:metrics:batch': {
        // Already batched by an upstream caller — forward as-is.
        this.bridge.send({ type, payload });
        return;
      }
      case 'monitor:drift:detected':
      case 'monitor:anomaly:detected':
      case 'monitor:fleet:summary': {
        // High-priority — forward synchronously, no coalescing.
        this.bridge.send({ type, payload });
        return;
      }
      default: {
        // Compile-time exhaustiveness guard (P-03.8) — adding a new
        // discriminant without a case here fails the TypeScript build.
        return assertNever(type as never);
      }
    }
  }

  /**
   * Flush the pending sample buffer as a single `monitor:metrics:batch`
   * envelope on the bridge. Called by the coalesce timer.
   */
  private flushBatch(): void {
    this.coalesceTimer = undefined;
    if (this.pendingSamples.length === 0 || !this.bridge) {
      return;
    }
    const samples = this.pendingSamples;
    this.pendingSamples = [];
    try {
      this.bridge.send({
        type: 'monitor:metrics:batch',
        payload: { samples },
      });
    } catch (err) {
      // Bridge.send shouldn't throw, but a misconfigured bridge mock might.
      // Log and continue — never crash the bus.
      this.logger?.warn('MetricBus bridge.send threw on batch flush', {
        error: extractErrorMessage(err),
        sampleCount: samples.length,
      });
    }
  }
}
