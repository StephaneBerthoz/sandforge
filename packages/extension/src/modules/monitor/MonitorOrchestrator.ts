import type { OrgHealthStatus } from '@sandforge/shared';
import type { LimitsTracker } from './LimitsTracker';
import type { JobMonitor } from './JobMonitor';
import type { ErrorLogMonitor } from './ErrorLogMonitor';
import type { DeploymentTracker } from './DeploymentTracker';
import type { UserSessionMonitor } from './UserSessionMonitor';
import type { AlertEngine } from './AlertEngine';
import type { HealthCheck } from './HealthCheck';
import type { ApexLogAnalyzer } from './ApexLogAnalyzer.js';
import type { SandboxRefreshTracker } from './SandboxRefreshTracker.js';
import type { GovernanceEngine } from './GovernanceEngine.js';
import type { CoreServices } from '../../services.js';
import { MetricBus, type MetricBusBridge } from './MetricBus.js';
import { TimeSeriesStore } from './TimeSeriesStore.js';
import { MonitorRegistry } from './MonitorRegistry.js';
import { AnomalyEngine, type AnomalyDetectedEvent } from './AnomalyEngine.js';
import { LimitsProbe } from './probes/LimitsProbe.js';
import { JobProbe } from './probes/JobProbe.js';
import { ApexLogProbe } from './probes/ApexLogProbe.js';
import { SandboxRefreshProbe } from './probes/SandboxRefreshProbe.js';
import { ErrorLogProbe } from './probes/ErrorLogProbe.js';
import { UserSessionProbe } from './probes/UserSessionProbe.js';
import { HealthProbe } from './probes/HealthProbe.js';
import {
  GovernanceProbe,
  type GovernanceProbeContext,
} from './probes/GovernanceProbe.js';

/** Events emitted by the MonitorOrchestrator */
export type MonitorEvent = 'started' | 'stopped' | 'healthUpdated' | 'error';

/** Handler function for monitor events */
export type MonitorEventHandler = (event: MonitorEvent, data: unknown) => void;

/** Dependencies required by the MonitorOrchestrator */
export interface MonitorDependencies {
  limitsTracker: LimitsTracker;
  jobMonitor: JobMonitor;
  errorLogMonitor: ErrorLogMonitor;
  deploymentTracker: DeploymentTracker;
  userSessionMonitor: UserSessionMonitor;
  alertEngine: AlertEngine;
  healthCheck: HealthCheck;
  /**
   * Phase 03 Plan 03-03 — optional trackers wrapped as probes by the
   * {@link MonitorRegistry}. Optional to preserve backward compatibility
   * with existing tests that supply a minimal deps shape; when omitted, the
   * matching probe is simply not registered.
   */
  apexLogAnalyzer?: ApexLogAnalyzer;
  sandboxRefreshTracker?: SandboxRefreshTracker;
  governanceEngine?: GovernanceEngine;
  /**
   * Source of governance inputs (active policy + live metrics) — required
   * for the {@link GovernanceProbe} to emit samples. When absent, the probe
   * still registers but each `run()` returns an empty array (no-op).
   */
  governanceContext?: GovernanceProbeContext;
  /**
   * Injected cross-cutting adapters (telemetry, storage, salesforce, fs).
   * Provided by the composition root (`services.ts`). Optional to preserve
   * backward compatibility with tests that pass a narrow deps shape.
   */
  services?: CoreServices;
  /**
   * Optional bridge facade for the {@link MetricBus} (Phase 03 Plan 03-01).
   *
   * When provided, MetricBus forwards `monitor:metric*` envelopes to the
   * webview through this bridge. When absent (extension-only / test
   * environments), MetricBus runs in process-local mode: subscribers still
   * receive events but nothing crosses the WebView boundary.
   *
   * Per RESEARCH §2 ("CoreServices DI contract") MetricBus itself is NOT
   * added to `Services` — it is owned by MonitorOrchestrator and exposed as
   * a public readonly singleton field.
   */
  bridge?: MetricBusBridge;
  /**
   * Persist Monitor time-series data to disk. Mirrors the
   * `sandforge.monitor.persistTimeSeries` VS Code setting. Default off.
   * Producer (extension.ts / handlers) reads the setting and passes it in.
   */
  persistTimeSeries?: boolean;
}

/**
 * Central orchestrator that coordinates all monitoring sub-services.
 * Manages the lifecycle of monitoring for each org and aggregates
 * health status from all trackers.
 */
export class MonitorOrchestrator {
  private readonly deps: MonitorDependencies;
  private readonly activeOrgs: Set<string> = new Set();
  private readonly handlers: Map<MonitorEvent, Set<MonitorEventHandler>> = new Map();
  private readonly healthCache: Map<string, OrgHealthStatus> = new Map();

  /**
   * MetricBus singleton — Phase 03 Plan 03-01 substrate.
   *
   * Trackers (Plan 03-03) and downstream Wave 2 modules
   * (Drift v2 / AnomalyEngine / fleet overview) publish typed events
   * through `monitorOrchestrator.metricBus.emit(...)`. Panels subscribe via
   * `monitorOrchestrator.metricBus.subscribe(...)`. The bus is NOT in the
   * global `Services` object per RESEARCH §2 — Wave 2 plans access it
   * through this orchestrator field.
   */
  public readonly metricBus: MetricBus;

  /**
   * Per-(orgId, seriesId) ring-buffered MetricSample store — Phase 03 Plan
   * 03-02 substrate. Plan 03-03 subscribes it to the MetricBus through the
   * {@link MonitorRegistry} so probes funnel directly into time-series storage.
   *
   * Persistence is opt-in via the `sandforge.monitor.persistTimeSeries`
   * setting (default off). When on AND `services.configStore` is present,
   * the store flushes every 5 min and rehydrates on `start()`.
   */
  public readonly timeSeriesStore: TimeSeriesStore;

  /**
   * Phase 03 Plan 03-03 — single-tick scheduler driving every registered
   * {@link MonitorProbe} across every active org. The registry subscribes
   * the {@link timeSeriesStore} to the {@link metricBus} so probe samples
   * land in the per-series ring buffer automatically.
   */
  public readonly registry: MonitorRegistry;

  /**
   * Phase 03 Plan 03-05 — rolling 24h std-dev anomaly detector. Subscribes
   * to {@link metricBus} `monitor:metric` on `start()`; on each sample,
   * queries the per-series baseline from {@link timeSeriesStore} and emits
   * `monitor:anomaly:detected` when the signal crosses the warmup-aware
   * effective threshold. The orchestrator separately bridges those events
   * into {@link AlertEngine.submitAnomalyInstance} so anomalies surface in
   * the existing AlertsPanel without polluting the definition store.
   */
  public readonly anomalyEngine: AnomalyEngine;

  /** Unsubscribe handle for the anomaly→AlertEngine bridge subscription. */
  private anomalyBridgeUnsub: (() => void) | undefined;

  constructor(deps: MonitorDependencies) {
    this.deps = deps;
    this.metricBus = new MetricBus({
      bridge: deps.bridge,
      // services?.telemetry exposes a logger-shaped surface; fall back to
      // undefined when running in tests with a narrow deps shape — the bus
      // tolerates a missing logger and silently swallows validation errors.
      logger: undefined,
    });
    this.timeSeriesStore = new TimeSeriesStore({
      configStore: deps.services?.configStore,
      logger: deps.services?.telemetry?.getLogger?.(),
      persist: deps.persistTimeSeries ?? false,
    });
    this.registry = new MonitorRegistry({
      metricBus: this.metricBus,
      timeSeriesStore: this.timeSeriesStore,
      logger: deps.services?.telemetry?.getLogger?.(),
    });
    this.anomalyEngine = new AnomalyEngine({
      metricBus: this.metricBus,
      timeSeriesStore: this.timeSeriesStore,
      logger: deps.services?.telemetry?.getLogger?.(),
      telemetry: deps.services?.telemetry,
    });
    this.registerProbes();
  }

  /**
   * Register every available probe on the {@link MonitorRegistry}. Probes
   * whose tracker dependency is absent (optional fields on
   * {@link MonitorDependencies}) are silently skipped — the registry tolerates
   * a partial probe set and Wave 2 plans add the remaining wiring.
   */
  private registerProbes(): void {
    this.registry.register(new LimitsProbe(this.deps.limitsTracker));
    this.registry.register(new JobProbe(this.deps.jobMonitor));
    this.registry.register(new ErrorLogProbe(this.deps.errorLogMonitor));
    this.registry.register(new UserSessionProbe(this.deps.userSessionMonitor));
    this.registry.register(new HealthProbe(this.deps.healthCheck));
    if (this.deps.apexLogAnalyzer) {
      this.registry.register(new ApexLogProbe(this.deps.apexLogAnalyzer));
    }
    if (this.deps.sandboxRefreshTracker) {
      this.registry.register(new SandboxRefreshProbe(this.deps.sandboxRefreshTracker));
    }
    if (this.deps.governanceEngine) {
      const ctx: GovernanceProbeContext =
        this.deps.governanceContext ?? {
          getPolicy: () => undefined,
          getMetrics: () => ({}),
        };
      this.registry.register(new GovernanceProbe(this.deps.governanceEngine, ctx));
    }
  }

  /** Start monitoring all services for the given org */
  async start(orgId: string): Promise<void> {
    if (this.activeOrgs.has(orgId)) {
      return;
    }

    // P-03.10: rehydrate the time-series store BEFORE any probe.fetch() so
    // record() never races with the on-disk replay. No-op when persist is off.
    await this.timeSeriesStore.rehydrate();

    // Phase 03 Plan 03-05 — bring up the AnomalyEngine subscription AFTER
    // rehydrate (so the baseline is hot) and BEFORE registry.startOrg() (so
    // the very first probe sample can already be evaluated against any
    // warmed-up replay). Both steps are idempotent for re-entrant start()s.
    this.anomalyEngine.start();
    if (!this.anomalyBridgeUnsub) {
      this.anomalyBridgeUnsub = this.metricBus.subscribe(
        'monitor:anomaly:detected',
        (payload) => {
          // Re-construct the in-process AnomalyDetectedEvent shape — the bus
          // payload carries every field except `detectedAt` (RESEARCH §4),
          // which we synthesize here for the AlertInstance triggeredAt.
          const event: AnomalyDetectedEvent = {
            ...payload,
            detectedAt: new Date().toISOString(),
          };
          this.deps.alertEngine.submitAnomalyInstance(event);
        },
      );
    }

    this.activeOrgs.add(orgId);

    await Promise.all([
      this.deps.limitsTracker.fetch(orgId),
      this.deps.jobMonitor.fetch(orgId),
      this.deps.errorLogMonitor.fetch(orgId),
      this.deps.deploymentTracker.fetch(orgId),
      this.deps.userSessionMonitor.fetch(orgId),
    ]);

    const health = await this.deps.healthCheck.computeHealth(orgId);
    this.healthCache.set(orgId, health);

    // Hand off to the registry for periodic ticks. The registry honors the
    // single-tick scheduler + per-probe in-flight gate (P-03.6).
    this.registry.startOrg(orgId);

    this.emit('started', { orgId });
  }

  /** Stop monitoring all services for the given org */
  stop(orgId: string): void {
    if (!this.activeOrgs.has(orgId)) {
      return;
    }

    this.activeOrgs.delete(orgId);
    this.healthCache.delete(orgId);
    this.registry.stopOrg(orgId);
    this.emit('stopped', { orgId });
  }

  /**
   * Forward a webview-side `document.visibilitychange` event into the
   * {@link MonitorRegistry} so low-priority probes pause and the tick rate
   * falls to 30 s while the panel is hidden (audit M1, P-03.7).
   *
   * Plan 03-07 owns the bridge handler that calls this. For Plan 03-03 the
   * method is exposed so unit tests can drive it directly.
   */
  setVisibility(hidden: boolean): void {
    this.registry.setVisibility(hidden);
  }

  /**
   * Tear down the orchestrator — disposes the {@link MonitorRegistry} and
   * {@link AnomalyEngine} BEFORE the {@link MetricBus} (both depend on bus
   * subscriptions) and the {@link TimeSeriesStore}. Idempotent.
   */
  dispose(): void {
    this.registry.dispose();
    this.anomalyBridgeUnsub?.();
    this.anomalyBridgeUnsub = undefined;
    this.anomalyEngine.dispose();
    this.metricBus.dispose();
    // Best-effort final flush before tearing down. Errors are swallowed by
    // TimeSeriesStore.flush itself (P-03.10) so we don't need a try/catch.
    void this.timeSeriesStore.flush().finally(() => {
      this.timeSeriesStore.dispose();
    });
    this.activeOrgs.clear();
    this.healthCache.clear();
    this.handlers.clear();
  }

  /** Get aggregated health status for an org */
  getHealthStatus(orgId: string): OrgHealthStatus {
    const cached = this.healthCache.get(orgId);
    if (cached) {
      return cached;
    }

    return {
      orgId,
      overall: 'healthy',
      apiLimitsStatus: 'ok',
      storageStatus: 'ok',
      activeJobs: 0,
      recentErrors: 0,
      lastChecked: new Date().toISOString(),
    };
  }

  /** Compute a 0-100 health score for the org based on all signals */
  getHealthScore(orgId: string): number {
    const status = this.getHealthStatus(orgId);

    let score = 100;

    switch (status.apiLimitsStatus) {
      case 'warning':
        score -= 15;
        break;
      case 'critical':
        score -= 35;
        break;
    }

    switch (status.storageStatus) {
      case 'warning':
        score -= 10;
        break;
      case 'critical':
        score -= 25;
        break;
    }

    score -= Math.min(status.activeJobs * 2, 15);
    score -= Math.min(status.recentErrors * 3, 25);

    return Math.max(0, Math.min(100, score));
  }

  /** Check if monitoring is active for an org */
  isActive(orgId: string): boolean {
    return this.activeOrgs.has(orgId);
  }

  /** Register an event handler */
  on(event: MonitorEvent, handler: MonitorEventHandler): void {
    let eventHandlers = this.handlers.get(event);
    if (!eventHandlers) {
      eventHandlers = new Set();
      this.handlers.set(event, eventHandlers);
    }
    eventHandlers.add(handler);
  }

  /** Unregister an event handler */
  off(event: MonitorEvent, handler: MonitorEventHandler): void {
    const eventHandlers = this.handlers.get(event);
    if (eventHandlers) {
      eventHandlers.delete(handler);
    }
  }

  private emit(event: MonitorEvent, data: unknown): void {
    const eventHandlers = this.handlers.get(event);
    if (eventHandlers) {
      for (const handler of eventHandlers) {
        handler(event, data);
      }
    }
  }
}
