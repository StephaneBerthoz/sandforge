import type { MetricSample } from '@sandforge/shared';

import type { MetricBus } from './MetricBus.js';
import type { TimeSeriesStore } from './TimeSeriesStore.js';
import {
  windowOf,
  rollingMean,
  rollingStdDev,
  zScore,
  effectiveThreshold,
  isWarmedUp,
  DEFAULT_WINDOW_MS,
  DEFAULT_SIGMA_THRESHOLD,
} from './anomaly-math.js';

/**
 * Minimal logger surface — matches the structured pino-style `warn(meta, msg?)`
 * shape exported by `services.telemetry.getLogger?.()` and used by
 * {@link TimeSeriesStore} / {@link MonitorRegistry}. AnomalyEngine never
 * crashes on missing logger.
 */
export interface AnomalyLogger {
  warn(meta: Record<string, unknown>, msg?: string): void;
}

/**
 * Minimal telemetry surface — matches the `TelemetryAdapter.addBreadcrumb`
 * signature `(message, category?, level?)`. We accept the narrow subset so
 * tests can supply `{ addBreadcrumb: vi.fn() }` without recreating the full
 * adapter.
 */
export interface AnomalyTelemetry {
  addBreadcrumb(
    message: string,
    category?: string,
    level?: 'info' | 'warning' | 'error',
  ): void;
}

/** Constructor dependencies for {@link AnomalyEngine}. */
export interface AnomalyEngineDeps {
  /** Phase 03 Plan 03-01 typed bus — AnomalyEngine subscribes to `monitor:metric`. */
  metricBus: MetricBus;
  /** Phase 03 Plan 03-02 store — query-side source for the rolling 24h window. */
  timeSeriesStore: TimeSeriesStore;
  /** Optional structured logger. */
  logger?: AnomalyLogger;
  /** Optional telemetry breadcrumb sink (warmup-suppression diagnostics — P-03.3). */
  telemetry?: AnomalyTelemetry;
  /** Override the rolling window. Defaults to {@link DEFAULT_WINDOW_MS} (24h). */
  windowMs?: number;
  /** Override the public sigma threshold. Defaults to {@link DEFAULT_SIGMA_THRESHOLD} (3). */
  sigmaThreshold?: number;
  /** Override `Date.now` for testability. */
  now?: () => number;
}

/**
 * Phase 03 Plan 03-05 — anomaly event published on `monitor:anomaly:detected`.
 *
 * Mirrors {@link AnomalyDetectedEventSchema} from `@sandforge/shared` plus a
 * convenience `detectedAt` ISO timestamp consumed by the AlertEngine bridge
 * (Plan 03-05 task 03). The bus payload sent to {@link MetricBus.emit} is the
 * schema-conformant subset; `detectedAt` lives on the in-process return value.
 */
export interface AnomalyDetectedEvent {
  orgId: string;
  seriesId: string;
  value: number;
  mean: number;
  stdDev: number;
  zScore: number;
  /** Last 10 baseline samples in chronological order (RESEARCH §4 — AI narration). */
  recentContext: MetricSample[];
  /** ISO timestamp captured at detection. */
  detectedAt: string;
}

/** One hour in ms — the rate-limit window for warmup-suppression breadcrumbs (P-03.3). */
const SUPPRESSION_LOG_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Phase 03 Plan 03-05 — rolling 24h std-dev anomaly detector.
 *
 * # Responsibilities
 *
 * 1. Subscribe to `monitor:metric` on the {@link MetricBus} (in `start()`).
 * 2. For every sample, query the per-`(orgId, seriesId)` rolling window from
 *    {@link TimeSeriesStore}, build a baseline (excluding the just-recorded
 *    sample so the anomaly is OUTSIDE the baseline), and:
 *      - refuse to emit until the baseline is warmed up
 *        (≥ 30 samples AND ≥ 6h span — P-03.3),
 *      - widen the sigma threshold for low-n baselines
 *        (`baseSigma * (1 + 1/sqrt(n))` for n < 100 — P-03.3),
 *      - emit `monitor:anomaly:detected` only when |zScore| ≥ effectiveThreshold.
 * 3. Suppression telemetry: log a single Sentry breadcrumb per series per hour
 *    so warmup-suppression is observable but never spammy.
 *
 * # Non-responsibilities
 *
 * - Does NOT bridge anomalies into AlertEngine — Plan 03-05 task 03 ships
 *   `AlertEngine.submitAnomalyInstance(event)` and Plan 03-05 task 04 wires
 *   the `metricBus.subscribe('monitor:anomaly:detected', ...)` glue inside
 *   {@link MonitorOrchestrator}.
 * - Does NOT persist anomaly state — {@link TimeSeriesStore} is the source of
 *   truth; anomalies are derived per-emit.
 * - Does NOT add new {@link AlertDefinition}s — anomalies become synthetic
 *   {@link AlertInstance}s via the bridge (RESEARCH §2).
 */
export class AnomalyEngine {
  private readonly windowMs: number;
  private readonly sigmaThreshold: number;
  private readonly nowFn: () => number;
  /** (orgId, seriesId) -> last suppression-log timestamp. */
  private readonly suppressionLog = new Map<string, number>();
  /** Subscription teardown returned by {@link MetricBus.subscribe}. */
  private subscriberUnsub: (() => void) | undefined;

  constructor(private readonly deps: AnomalyEngineDeps) {
    this.windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS;
    this.sigmaThreshold = deps.sigmaThreshold ?? DEFAULT_SIGMA_THRESHOLD;
    this.nowFn = deps.now ?? (() => Date.now());
  }

  /**
   * Start subscribing to the bus. Idempotent: calling `start()` twice without
   * an intervening `dispose()` reuses the existing subscription.
   */
  start(): void {
    if (this.subscriberUnsub !== undefined) {
      return;
    }
    this.subscriberUnsub = this.deps.metricBus.subscribe('monitor:metric', (sample) => {
      this.evaluate(sample);
    });
  }

  /**
   * Public for tests — evaluate one sample. Returns the emitted event (also
   * published on the bus) or `null` if suppressed by warmup / threshold /
   * degenerate-stdDev.
   */
  evaluate(sample: MetricSample): AnomalyDetectedEvent | null {
    const now = this.nowFn();
    const recent = this.deps.timeSeriesStore.query(
      sample.orgId,
      sample.seriesId,
      now - this.windowMs,
      now,
    );
    const window = windowOf(recent, now, this.windowMs);
    // Exclude the just-recorded sample from the baseline — the anomaly should
    // be measured OUTSIDE the population it would otherwise drag.
    const baseline = window.length > 0 ? window.slice(0, window.length - 1) : window;
    const seriesKey = `${sample.orgId}:${sample.seriesId}`;

    if (!isWarmedUp(baseline)) {
      this.maybeLogSuppression(seriesKey, sample, baseline.length, now);
      return null;
    }

    const mean = rollingMean(baseline);
    const stdDev = rollingStdDev(baseline, mean);
    if (stdDev === 0) {
      // Constant series — better than spamming divide-by-zero anomalies.
      return null;
    }
    const z = zScore(sample.value, mean, stdDev);
    const threshold = effectiveThreshold(this.sigmaThreshold, baseline.length);

    if (Math.abs(z) < threshold) {
      return null;
    }

    const event: AnomalyDetectedEvent = {
      orgId: sample.orgId,
      seriesId: sample.seriesId,
      value: sample.value,
      mean,
      stdDev,
      zScore: z,
      recentContext: baseline.slice(-10),
      detectedAt: new Date(now).toISOString(),
    };

    // Bus payload conforms to AnomalyDetectedEventSchema in @sandforge/shared
    // (no `detectedAt` field — that one stays on the in-process return value).
    this.deps.metricBus.emit('monitor:anomaly:detected', {
      orgId: event.orgId,
      seriesId: event.seriesId,
      value: event.value,
      mean: event.mean,
      stdDev: event.stdDev,
      zScore: event.zScore,
      recentContext: event.recentContext,
    });

    return event;
  }

  /**
   * Tear down — unsubscribes from the bus and clears the suppression log.
   * Idempotent.
   */
  dispose(): void {
    this.subscriberUnsub?.();
    this.subscriberUnsub = undefined;
    this.suppressionLog.clear();
  }

  /**
   * Log a `anomaly-suppressed-warmup` breadcrumb at most once per hour per
   * series so the channel stays useful in long-lived dev sessions (P-03.3).
   */
  private maybeLogSuppression(
    seriesKey: string,
    sample: MetricSample,
    baselineLen: number,
    now: number,
  ): void {
    const last = this.suppressionLog.get(seriesKey) ?? 0;
    if (now - last < SUPPRESSION_LOG_INTERVAL_MS) {
      return;
    }
    this.suppressionLog.set(seriesKey, now);
    this.deps.telemetry?.addBreadcrumb(
      `anomaly-suppressed-warmup orgId=${sample.orgId} seriesId=${sample.seriesId} baselineLen=${baselineLen}`,
      'monitor',
      'info',
    );
    this.deps.logger?.warn(
      { orgId: sample.orgId, seriesId: sample.seriesId, baselineLen },
      'AnomalyEngine warmup suppression',
    );
  }
}
