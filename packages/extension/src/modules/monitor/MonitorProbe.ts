import type { MetricSample } from '@sandforge/shared';

/**
 * Probe priority — drives visibility-gated polling (audit M1, P-03.7).
 *
 *  - `critical` runs even when the WebView is hidden.
 *  - `normal` runs at the slower hidden tick rate when hidden.
 *  - `low` is paused entirely when hidden.
 */
export type ProbePriority = 'critical' | 'normal' | 'low';

/**
 * Phase 03 Plan 03-03 contract — every monitoring probe implements this
 * interface and gets dispatched by {@link MonitorRegistry} at its declared
 * cadence.
 *
 * Probe wrappers are thin shells around the existing Monitor trackers
 * (LimitsTracker, JobMonitor, …) — the tracker's public `fetch()` API is
 * preserved verbatim and the probe only translates its result into one or
 * more {@link MetricSample} entries published on the {@link MetricBus}.
 */
export interface MonitorProbe {
  /** Stable, unique probe identifier — used as `MetricSample.seriesId` prefix. */
  readonly id: string;
  /** Polling cadence in milliseconds. Must be ≥ {@link MIN_PROBE_INTERVAL_MS}. */
  readonly intervalMs: number;
  /** Visibility-gating priority — see {@link ProbePriority}. */
  readonly priority: ProbePriority;
  /**
   * Returns one or more samples for this run. Implementations MAY throw — the
   * registry catches the error, logs it, and reschedules the next run.
   */
  run(orgId: string): Promise<MetricSample[]>;
}

/** Floor on probe cadence — guards accidental tight loops. */
export const MIN_PROBE_INTERVAL_MS = 5_000;

/** Hard timeout per `probe.run()` invocation (P-03.6). */
export const PROBE_HARD_TIMEOUT_MS = 30_000;
