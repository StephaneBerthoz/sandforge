import type { MetricSample } from '@sandforge/shared';

import type { MonitorProbe, ProbePriority } from '../MonitorProbe.js';
import { HealthCheck } from '../HealthCheck.js';

/**
 * Phase 03 Plan 03-03 — `HealthCheck` adapter.
 *
 * Cadence: **60 s**, priority `critical` — the health score gates the
 * "everything is OK" pill on every panel; never paused by visibility.
 *
 * Emits 5 samples per run:
 *  - `monitor.health.score` — overall 0..100 (single scalar)
 *  - `monitor.health.apiLimitsStatus` — 0 (ok) / 1 (warning) / 2 (critical)
 *  - `monitor.health.storageStatus` — same encoding
 *  - `monitor.health.activeJobs` — count proxy
 *  - `monitor.health.recentErrors` — count proxy
 */
export class HealthProbe implements MonitorProbe {
  readonly id = 'monitor.health';
  readonly intervalMs = 60_000;
  readonly priority: ProbePriority = 'critical';

  constructor(private readonly healthCheck: HealthCheck) {}

  async run(orgId: string): Promise<MetricSample[]> {
    const status = await this.healthCheck.computeHealth(orgId);
    const ts = status.lastChecked || new Date().toISOString();
    // Convert to a 0..100 score using the same logic as MonitorOrchestrator.
    let score = 100;
    if (status.apiLimitsStatus === 'warning') score -= 15;
    if (status.apiLimitsStatus === 'critical') score -= 35;
    if (status.storageStatus === 'warning') score -= 10;
    if (status.storageStatus === 'critical') score -= 25;
    score -= Math.min(status.activeJobs * 2, 15);
    score -= Math.min(status.recentErrors * 3, 25);
    score = Math.max(0, Math.min(100, score));
    const encodeStatus = (s: 'ok' | 'warning' | 'critical'): number =>
      s === 'critical' ? 2 : s === 'warning' ? 1 : 0;
    return [
      { ts, orgId, seriesId: `${this.id}.score`, value: score, unit: 'percent' },
      {
        ts,
        orgId,
        seriesId: `${this.id}.apiLimitsStatus`,
        value: encodeStatus(status.apiLimitsStatus),
        unit: 'level',
      },
      {
        ts,
        orgId,
        seriesId: `${this.id}.storageStatus`,
        value: encodeStatus(status.storageStatus),
        unit: 'level',
      },
      {
        ts,
        orgId,
        seriesId: `${this.id}.activeJobs`,
        value: status.activeJobs,
        unit: 'count',
      },
      {
        ts,
        orgId,
        seriesId: `${this.id}.recentErrors`,
        value: status.recentErrors,
        unit: 'count',
      },
    ];
  }
}
