import type { OrgHealthStatus } from '@sandforge/shared';

/** A single health signal contributing to overall org health */
export interface HealthSignal {
  name: string;
  status: 'ok' | 'warning' | 'critical';
  score: number;
  message: string;
}

/** Function that produces a health signal for an org */
export type HealthSignalProvider = (orgId: string) => Promise<HealthSignal>;

/** Score thresholds for health status classification */
const HEALTHY_THRESHOLD = 80;
const DEGRADED_THRESHOLD = 50;

/**
 * Computes overall org health by aggregating multiple health signal providers.
 * Each provider contributes a score (0-100) and status, which are combined
 * into a weighted average for the final health assessment.
 */
export class HealthCheck {
  private readonly providers: HealthSignalProvider[];

  constructor(providers: HealthSignalProvider[]) {
    this.providers = providers;
  }

  /** Aggregate all health signals into an OrgHealthStatus */
  async computeHealth(orgId: string): Promise<OrgHealthStatus> {
    const signals = await Promise.all(this.providers.map((provider) => provider(orgId)));

    const score = HealthCheck.computeScore(signals);
    const overall = HealthCheck.statusFromScore(score);

    const apiSignal = signals.find((s) => s.name === 'apiLimits');
    const storageSignal = signals.find((s) => s.name === 'storage');
    const jobsSignal = signals.find((s) => s.name === 'activeJobs');
    const errorsSignal = signals.find((s) => s.name === 'recentErrors');

    return {
      orgId,
      overall,
      apiLimitsStatus: apiSignal?.status ?? 'ok',
      storageStatus: storageSignal?.status ?? 'ok',
      activeJobs: jobsSignal ? Math.round(100 - jobsSignal.score) : 0,
      recentErrors: errorsSignal ? Math.round(100 - errorsSignal.score) : 0,
      lastChecked: new Date().toISOString(),
    };
  }

  /** Compute a weighted average score from health signals (0-100) */
  static computeScore(signals: HealthSignal[]): number {
    if (signals.length === 0) {
      return 100;
    }
    const total = signals.reduce((sum, s) => sum + s.score, 0);
    return Math.round(total / signals.length);
  }

  /** Map a numeric score to a health status label */
  static statusFromScore(score: number): 'healthy' | 'degraded' | 'critical' {
    if (score >= HEALTHY_THRESHOLD) {
      return 'healthy';
    }
    if (score >= DEGRADED_THRESHOLD) {
      return 'degraded';
    }
    return 'critical';
  }
}
