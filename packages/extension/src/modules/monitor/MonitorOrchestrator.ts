import type { OrgHealthStatus } from '@sandforge/shared';
import type { LimitsTracker } from './LimitsTracker';
import type { JobMonitor } from './JobMonitor';
import type { ErrorLogMonitor } from './ErrorLogMonitor';
import type { DeploymentTracker } from './DeploymentTracker';
import type { UserSessionMonitor } from './UserSessionMonitor';
import type { AlertEngine } from './AlertEngine';
import type { HealthCheck } from './HealthCheck';
import type { CoreServices } from '../../services.js';
import { MetricBus, type MetricBusBridge } from './MetricBus.js';

/** Events emitted by the MonitorOrchestrator */
export type MonitorEvent =
  | 'started'
  | 'stopped'
  | 'healthUpdated'
  | 'error';

/** Handler function for monitor events */
export type MonitorEventHandler = (
  event: MonitorEvent,
  data: unknown
) => void;

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

  constructor(deps: MonitorDependencies) {
    this.deps = deps;
    this.metricBus = new MetricBus({
      bridge: deps.bridge,
      // services?.telemetry exposes a logger-shaped surface; fall back to
      // undefined when running in tests with a narrow deps shape — the bus
      // tolerates a missing logger and silently swallows validation errors.
      logger: undefined,
    });
  }

  /** Start monitoring all services for the given org */
  async start(orgId: string): Promise<void> {
    if (this.activeOrgs.has(orgId)) {
      return;
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

    this.emit('started', { orgId });
  }

  /** Stop monitoring all services for the given org */
  stop(orgId: string): void {
    if (!this.activeOrgs.has(orgId)) {
      return;
    }

    this.activeOrgs.delete(orgId);
    this.healthCache.delete(orgId);
    this.emit('stopped', { orgId });
  }

  /**
   * Tear down the orchestrator — releases the {@link MetricBus} (clears
   * pending coalesce timer + every subscriber). Intentionally idempotent:
   * calling twice is safe.
   */
  dispose(): void {
    this.metricBus.dispose();
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
