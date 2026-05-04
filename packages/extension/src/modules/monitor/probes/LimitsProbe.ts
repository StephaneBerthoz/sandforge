import type { MetricSample } from '@sandforge/shared';

import type { MonitorProbe, ProbePriority } from '../MonitorProbe.js';
import type { LimitsTracker } from '../LimitsTracker.js';

/**
 * Phase 03 Plan 03-03 — `LimitsTracker` adapter.
 *
 * Cadence: **30 s**, priority `critical` (limits drive every alert pipeline).
 *
 * Emits one {@link MetricSample} per limit found in the tracker's snapshot.
 * The tracker's `fetch(orgId)` body is preserved verbatim.
 */
export class LimitsProbe implements MonitorProbe {
  readonly id = 'monitor.limits';
  readonly intervalMs = 30_000;
  readonly priority: ProbePriority = 'critical';

  constructor(private readonly tracker: LimitsTracker) {}

  async run(orgId: string): Promise<MetricSample[]> {
    const snapshot = await this.tracker.fetch(orgId);
    const ts = snapshot.timestamp || new Date().toISOString();
    return snapshot.limits.map((limit) => ({
      ts,
      orgId,
      seriesId: `${this.id}.${limit.name}`,
      value: limit.usedPercent,
      unit: 'percent',
    }));
  }
}
