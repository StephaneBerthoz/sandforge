import type { MetricSample } from '@sandforge/shared';

import type { MonitorProbe, ProbePriority } from '../MonitorProbe.js';
import type { JobMonitor } from '../JobMonitor.js';

/**
 * Phase 03 Plan 03-03 — `JobMonitor` adapter.
 *
 * Cadence: **60 s**, priority `normal`.
 *
 * Emits 4 samples per run (`total`, `active`, `completed`, `failed`) so the
 * dashboard can render trend lines per category.
 */
export class JobProbe implements MonitorProbe {
  readonly id = 'monitor.jobs';
  readonly intervalMs = 60_000;
  readonly priority: ProbePriority = 'normal';

  constructor(private readonly monitor: JobMonitor) {}

  async run(orgId: string): Promise<MetricSample[]> {
    await this.monitor.fetch(orgId);
    const stats = this.monitor.getJobStats(orgId);
    const ts = new Date().toISOString();
    const base = { ts, orgId, unit: 'count' as const };
    return [
      { ...base, seriesId: `${this.id}.total`, value: stats.total },
      { ...base, seriesId: `${this.id}.active`, value: stats.active },
      { ...base, seriesId: `${this.id}.completed`, value: stats.completed },
      { ...base, seriesId: `${this.id}.failed`, value: stats.failed },
    ];
  }
}
