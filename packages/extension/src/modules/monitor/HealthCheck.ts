import type { OrgHealthStatus } from '@sandforge/shared';

/** A single health signal contributing to overall org health */
export interface HealthSignal {
  name: string;
  /**
   * `unknown` when the signal could not be read. It used to answer `ok` with
   * a full score, so an org the monitor could not read at all came out
   * "healthy, 100".
   */
  status: 'ok' | 'warning' | 'critical' | 'unknown';
  score: number;
  message: string;
  /** Rows the signal counted (failed jobs, error logs); absent when it read none. */
  count?: number;
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
    const overall = score === null ? 'unknown' : HealthCheck.statusFromScore(score);

    const apiSignal = signals.find((s) => s.name === 'apiLimits');
    const storageSignal = signals.find((s) => s.name === 'storage');
    const jobsSignal = signals.find((s) => s.name === 'activeJobs');
    const errorsSignal = signals.find((s) => s.name === 'recentErrors');

    return {
      orgId,
      overall,
      apiLimitsStatus: apiSignal?.status ?? 'unknown',
      storageStatus: storageSignal?.status ?? 'unknown',
      // The counts the signals read, not the points they cost: the panel
      // labels them as jobs and logs, and showed a score gap instead. None
      // read is not zero found.
      failedJobs: jobsSignal?.status === 'unknown' ? null : (jobsSignal?.count ?? null),
      recentErrorLogs: errorsSignal?.status === 'unknown' ? null : (errorsSignal?.count ?? null),
      lastChecked: new Date().toISOString(),
    };
  }

  /**
   * Average score (0-100) of the signals that were read, or `null` when none
   * was: a signal that could not be read says nothing about the org.
   */
  static computeScore(signals: HealthSignal[]): number | null {
    const read = signals.filter((s) => s.status !== 'unknown');
    if (read.length === 0) {
      return null;
    }
    const total = read.reduce((sum, s) => sum + s.score, 0);
    return Math.round(total / read.length);
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
