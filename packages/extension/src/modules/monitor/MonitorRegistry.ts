import type { MetricSample } from '@sandforge/shared';

import type { MetricBus } from './MetricBus.js';
import type { TimeSeriesStore } from './TimeSeriesStore.js';
import type { MonitorProbe } from './MonitorProbe.js';
import { PROBE_HARD_TIMEOUT_MS } from './MonitorProbe.js';

/** Minimal logger surface — matches MetricBusLogger / pino shape. */
export interface MonitorRegistryLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** Minimal telemetry surface — only what the registry uses. */
export interface MonitorRegistryTelemetry {
  addBreadcrumb(meta: { category: string; message: string; data?: Record<string, unknown> }): void;
}

/** Construction-time deps. */
export interface MonitorRegistryDeps {
  metricBus: MetricBus;
  timeSeriesStore: TimeSeriesStore;
  logger?: MonitorRegistryLogger;
  telemetry?: MonitorRegistryTelemetry;
  /** Override Date.now for testability. */
  now?: () => number;
  /** Hard timeout per probe.run() in ms — default {@link PROBE_HARD_TIMEOUT_MS}. */
  hardTimeoutMs?: number;
}

/** Visibility-gated tick rate when `document.hidden` (P-03.6). */
const HIDDEN_TICK_MS = 30_000;
/** Floor on the active tick interval. */
const TICK_FLOOR_MS = 1_000;
/** Ceiling on the active tick interval. */
const TICK_CEIL_MS = 10_000;

/**
 * Phase 03 Plan 03-03 — single-tick scheduler driving every registered probe
 * across every active org.
 *
 * Why one timer? RESEARCH §1 / §2: collapsing N timers (one per tracker) into
 * a single `setInterval` mirrors what `OperationScheduler` already does, makes
 * the disposable surface trivial, and keeps the scheduler observable through
 * one breakpoint.
 *
 * Pitfalls mitigated (RESEARCH §3 P-03.6):
 *  - **In-flight gate** — per-(orgId, probeId) `Map<key, Promise>` prevents a
 *    slow run from spawning duplicate dispatches when its interval elapses.
 *  - **Drift accounting** — `nextRunAt = lastFinishedAt + intervalMs` (NOT
 *    lastStartedAt). A 4 s probe with 10 s cadence runs at t=4 → next at t=14.
 *  - **Hard timeout** — `Promise.race([probe.run(), timeout(30 s)])`. Hung
 *    probes get killed + logged + breadcrumbed.
 *  - **Visibility gating** (audit M1, P-03.7) — `setVisibility(true)` slows
 *    the tick to 30 s and skips `priority: 'low'` probes entirely.
 *
 * The registry also bridges `MetricBus` → `TimeSeriesStore`: every emit on
 * `monitor:metric` is mirrored into the per-(orgId, seriesId) ring buffer.
 */
export class MonitorRegistry {
  private readonly probes = new Map<string, MonitorProbe>();
  private readonly activeOrgs = new Set<string>();
  /** Key = `${orgId}${probeId}` (US separator). */
  private readonly nextRunAt = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private currentTickRateMs = 0;
  private documentHidden = false;
  private disposed = false;
  /** Unsubscribe handle for the MetricBus → store bridge. */
  private readonly unsubscribeBusToStore: () => void;
  private readonly logger: MonitorRegistryLogger | undefined;
  private readonly telemetry: MonitorRegistryTelemetry | undefined;
  private readonly nowFn: () => number;
  private readonly hardTimeoutMs: number;
  private readonly bus: MetricBus;

  constructor(deps: MonitorRegistryDeps) {
    this.bus = deps.metricBus;
    this.logger = deps.logger;
    this.telemetry = deps.telemetry;
    this.nowFn = deps.now ?? (() => Date.now());
    this.hardTimeoutMs = deps.hardTimeoutMs ?? PROBE_HARD_TIMEOUT_MS;
    // Bridge: MetricBus → TimeSeriesStore. Every sample fanned out by the bus
    // is funneled into the per-series ring buffer (decoupled per Plan 03-02).
    this.unsubscribeBusToStore = deps.metricBus.subscribe('monitor:metric', (sample) => {
      try {
        deps.timeSeriesStore.record(sample);
      } catch (err) {
        this.logger?.warn('MonitorRegistry timeSeriesStore.record threw', {
          error: err instanceof Error ? err.message : String(err),
          orgId: sample.orgId,
          seriesId: sample.seriesId,
        });
      }
    });
  }

  /**
   * Register a probe. The first registration also (re)computes the tick rate
   * and starts the scheduler timer if any orgs are already active.
   */
  register(probe: MonitorProbe): void {
    if (this.disposed) return;
    this.probes.set(probe.id, probe);
    this.refreshTickTimer();
  }

  /** Unregister a probe by id. Drops in-flight tracking + nextRunAt entries. */
  unregister(probeId: string): void {
    this.probes.delete(probeId);
    for (const key of [...this.nextRunAt.keys()]) {
      if (key.endsWith(`${probeId}`)) {
        this.nextRunAt.delete(key);
      }
    }
    for (const key of [...this.inFlight.keys()]) {
      if (key.endsWith(`${probeId}`)) {
        this.inFlight.delete(key);
      }
    }
    this.refreshTickTimer();
  }

  /**
   * Activate an org. From the next tick onwards, every registered probe will
   * be dispatched for this orgId at its declared cadence.
   */
  startOrg(orgId: string): void {
    if (this.disposed) return;
    this.activeOrgs.add(orgId);
    // Seed nextRunAt to "now" so the first tick fires immediately for this org.
    const now = this.nowFn();
    for (const probe of this.probes.values()) {
      const key = this.partitionKey(orgId, probe.id);
      if (!this.nextRunAt.has(key)) {
        this.nextRunAt.set(key, now);
      }
    }
    this.refreshTickTimer();
  }

  /** Deactivate an org. Drops nextRunAt + inFlight entries for that org. */
  stopOrg(orgId: string): void {
    this.activeOrgs.delete(orgId);
    const prefix = `${orgId}`;
    for (const key of [...this.nextRunAt.keys()]) {
      if (key.startsWith(prefix)) this.nextRunAt.delete(key);
    }
    for (const key of [...this.inFlight.keys()]) {
      if (key.startsWith(prefix)) this.inFlight.delete(key);
    }
    if (this.activeOrgs.size === 0) {
      this.stopTickTimer();
    }
  }

  /**
   * Set the visibility hint (audit M1, P-03.7). When `true`, the tick rate
   * falls to {@link HIDDEN_TICK_MS} and `priority: 'low'` probes are skipped
   * entirely. Calling with `false` restores the normal cadence.
   */
  setVisibility(hidden: boolean): void {
    if (this.documentHidden === hidden) return;
    this.documentHidden = hidden;
    this.refreshTickTimer();
  }

  /** Stats snapshot — used by tests + diagnostics. */
  getStats(): {
    probeCount: number;
    activeOrgCount: number;
    inFlightCount: number;
    documentHidden: boolean;
    tickRateMs: number;
  } {
    return {
      probeCount: this.probes.size,
      activeOrgCount: this.activeOrgs.size,
      inFlightCount: this.inFlight.size,
      documentHidden: this.documentHidden,
      tickRateMs: this.currentTickRateMs,
    };
  }

  /**
   * Tear down — clears the tick timer + drops every in-flight tracking entry
   * + unsubscribes the MetricBus → TimeSeriesStore bridge. Idempotent.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopTickTimer();
    this.activeOrgs.clear();
    this.nextRunAt.clear();
    this.inFlight.clear();
    this.probes.clear();
    this.unsubscribeBusToStore();
  }

  // ─── internals ────────────────────────────────────────────────

  private refreshTickTimer(): void {
    if (this.disposed) return;
    if (this.activeOrgs.size === 0 || this.probes.size === 0) {
      this.stopTickTimer();
      return;
    }
    const desired = this.computeTickRate();
    if (this.tickTimer && desired === this.currentTickRateMs) return;
    this.stopTickTimer();
    this.currentTickRateMs = desired;
    this.tickTimer = setInterval(() => {
      this.tick();
    }, desired);
  }

  private stopTickTimer(): void {
    if (this.tickTimer !== undefined) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
    this.currentTickRateMs = 0;
  }

  private computeTickRate(): number {
    if (this.documentHidden) return HIDDEN_TICK_MS;
    let minInterval = Number.POSITIVE_INFINITY;
    for (const p of this.probes.values()) {
      if (p.intervalMs < minInterval) minInterval = p.intervalMs;
    }
    if (!Number.isFinite(minInterval)) return TICK_FLOOR_MS;
    return Math.max(TICK_FLOOR_MS, Math.min(TICK_CEIL_MS, Math.floor(minInterval / 4)));
  }

  private tick(): void {
    if (this.disposed) return;
    const now = this.nowFn();
    for (const orgId of this.activeOrgs) {
      for (const probe of this.probes.values()) {
        // Visibility gate (audit M1, P-03.7).
        if (this.documentHidden && probe.priority === 'low') continue;
        const key = this.partitionKey(orgId, probe.id);
        if (this.inFlight.has(key)) continue; // P-03.6 in-flight gate
        const due = this.nextRunAt.get(key) ?? 0;
        if (now < due) continue;
        this.dispatch(probe, orgId, key);
      }
    }
  }

  private dispatch(probe: MonitorProbe, orgId: string, key: string): void {
    const promise = (async (): Promise<void> => {
      try {
        const samples = await this.runWithTimeout(probe, orgId);
        for (const s of samples) {
          this.bus.emit('monitor:metric', s);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger?.warn(`MonitorRegistry probe ${probe.id} failed for ${orgId}`, {
          probeId: probe.id,
          orgId,
          error: message,
        });
        this.telemetry?.addBreadcrumb({
          category: 'monitor',
          message: 'probe-failed',
          data: { probeId: probe.id, orgId, error: message },
        });
      } finally {
        // Drift accounting (P-03.6) — reschedule based on finish time, not
        // start time, so a slow run never compounds into a backlog of dispatches.
        const finishedAt = this.nowFn();
        this.nextRunAt.set(key, finishedAt + probe.intervalMs);
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, promise);
  }

  private runWithTimeout(probe: MonitorProbe, orgId: string): Promise<MetricSample[]> {
    return new Promise<MetricSample[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Probe ${probe.id} timed out after ${this.hardTimeoutMs}ms`));
      }, this.hardTimeoutMs);
      probe.run(orgId).then(
        (samples) => {
          clearTimeout(timer);
          resolve(samples);
        },
        (err) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  private partitionKey(orgId: string, probeId: string): string {
    return `${orgId}${probeId}`;
  }
}
