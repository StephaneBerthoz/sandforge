import type { MetricSample } from '@sandforge/shared';

import type { MonitorProbe, ProbePriority } from '../MonitorProbe.js';
import type { ErrorLogMonitor } from '../ErrorLogMonitor.js';

/**
 * Phase 03 Plan 03-03 — `ErrorLogMonitor` adapter.
 *
 * Cadence: **60 s**, priority `normal` — recent errors drive the alert tray
 * but are not part of the critical hot path.
 *
 * Emits one `total` sample plus one sample per `errorType` bucket so the
 * dashboard can break errors down by category.
 */
export class ErrorLogProbe implements MonitorProbe {
  readonly id = 'monitor.errors';
  readonly intervalMs = 60_000;
  readonly priority: ProbePriority = 'normal';

  constructor(private readonly monitor: ErrorLogMonitor) {}

  async run(orgId: string): Promise<MetricSample[]> {
    const errors = await this.monitor.fetch(orgId);
    const ts = new Date().toISOString();
    const samples: MetricSample[] = [
      { ts, orgId, seriesId: `${this.id}.total`, value: errors.length, unit: 'count' },
    ];
    const grouped = this.monitor.getErrorsByType(orgId);
    for (const [errorType, count] of grouped) {
      samples.push({
        ts,
        orgId,
        seriesId: `${this.id}.byType.${errorType}`,
        value: count,
        unit: 'count',
      });
    }
    return samples;
  }
}
