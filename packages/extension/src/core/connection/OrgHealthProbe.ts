/** Health status of an org */
export type OrgHealthStatus = 'healthy' | 'degraded' | 'unreachable' | 'unknown';

/** Health information for an org */
export interface OrgHealth {
  orgId: string;
  status: OrgHealthStatus;
  latencyMs: number;
  lastCheckAt: string;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
}

/** Event types emitted by the health probe */
export type HealthEventType = 'statusChanged' | 'checkCompleted' | 'checkFailed';

/** Health probe event */
export interface HealthEvent {
  type: HealthEventType;
  orgId: string;
  health: OrgHealth;
  previousStatus?: OrgHealthStatus;
}

/** Listener for health events */
export type HealthEventListener = (event: HealthEvent) => void;

/** Function that performs the actual health check (e.g., calling limits API) */
export type HealthCheckExecutor = (orgId: string) => Promise<{ latencyMs: number }>;

/**
 * Periodically probes Salesforce orgs to check connectivity.
 * Emits events on status changes and tracks latency and failure counts.
 */
export class OrgHealthProbe {
  private static readonly DEFAULT_INTERVAL = 60_000;
  private static readonly DEGRADED_THRESHOLD = 3;

  private healthMap: Map<string, OrgHealth> = new Map();
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private listeners: Set<HealthEventListener> = new Set();
  private executor: HealthCheckExecutor | undefined;

  /** Set the health check executor */
  setExecutor(executor: HealthCheckExecutor): void {
    this.executor = executor;
  }

  /** Start probing an org at the given interval */
  start(orgId: string, interval: number = OrgHealthProbe.DEFAULT_INTERVAL): void {
    this.stop(orgId);

    if (!this.healthMap.has(orgId)) {
      this.healthMap.set(orgId, {
        orgId,
        status: 'unknown',
        latencyMs: 0,
        lastCheckAt: new Date().toISOString(),
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
      });
    }

    const timer = setInterval(() => {
      void this.check(orgId);
    }, interval);

    this.timers.set(orgId, timer);

    // Perform an immediate check
    void this.check(orgId);
  }

  /** Stop probing an org */
  stop(orgId: string): void {
    const timer = this.timers.get(orgId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(orgId);
    }
  }

  /** Get the health of an org */
  getHealth(orgId: string): OrgHealth {
    return (
      this.healthMap.get(orgId) ?? {
        orgId,
        status: 'unknown',
        latencyMs: 0,
        lastCheckAt: new Date().toISOString(),
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
      }
    );
  }

  /** Check if an org is currently being probed */
  isProbing(orgId: string): boolean {
    return this.timers.has(orgId);
  }

  /** Register an event listener */
  onEvent(listener: HealthEventListener): void {
    this.listeners.add(listener);
  }

  /** Remove an event listener */
  offEvent(listener: HealthEventListener): void {
    this.listeners.delete(listener);
  }

  /** Perform a single health check for an org */
  async check(orgId: string): Promise<OrgHealth> {
    let health = this.healthMap.get(orgId);
    if (!health) {
      health = {
        orgId,
        status: 'unknown',
        latencyMs: 0,
        lastCheckAt: new Date().toISOString(),
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
      };
      this.healthMap.set(orgId, health);
    }

    const previousStatus = health.status;

    if (!this.executor) {
      health.status = 'unknown';
      health.lastCheckAt = new Date().toISOString();
      return health;
    }

    try {
      const result = await this.executor(orgId);
      health.latencyMs = result.latencyMs;
      health.lastCheckAt = new Date().toISOString();
      health.consecutiveFailures = 0;
      health.consecutiveSuccesses++;
      health.status = 'healthy';

      this.emit({
        type: 'checkCompleted',
        orgId,
        health: { ...health },
      });
    } catch {
      health.lastCheckAt = new Date().toISOString();
      health.consecutiveFailures++;
      health.consecutiveSuccesses = 0;

      if (health.consecutiveFailures >= OrgHealthProbe.DEGRADED_THRESHOLD) {
        health.status = 'unreachable';
      } else {
        health.status = 'degraded';
      }

      this.emit({
        type: 'checkFailed',
        orgId,
        health: { ...health },
      });
    }

    if (health.status !== previousStatus) {
      this.emit({
        type: 'statusChanged',
        orgId,
        health: { ...health },
        previousStatus,
      });
    }

    return { ...health };
  }

  /** Stop all probes and clean up */
  dispose(): void {
    for (const [orgId] of this.timers) {
      this.stop(orgId);
    }
    this.listeners.clear();
    this.healthMap.clear();
  }

  private emit(event: HealthEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
