import type { MetricSample } from '@sandforge/shared';

import type { MonitorProbe, ProbePriority } from '../MonitorProbe.js';
import type { SandboxRefreshTracker } from '../SandboxRefreshTracker.js';

/**
 * Phase 03 Plan 03-03 — `SandboxRefreshTracker` adapter.
 *
 * Cadence: **600 s** (10 min), priority `low` — sandbox refreshes are rare
 * events that can pause when the WebView is hidden.
 *
 * Emits 2 samples: `total` (count of all events) and `inProgress` (count of
 * Pending/Processing). Useful for the dashboard to surface "refresh active"
 * banners.
 */
export class SandboxRefreshProbe implements MonitorProbe {
  readonly id = 'monitor.sandbox';
  readonly intervalMs = 600_000;
  readonly priority: ProbePriority = 'low';

  constructor(private readonly tracker: SandboxRefreshTracker) {}

  async run(orgId: string): Promise<MetricSample[]> {
    const events = await this.tracker.fetch(orgId);
    const inProgress = this.tracker.isRefreshInProgress(orgId) ? 1 : 0;
    const ts = new Date().toISOString();
    const base = { ts, orgId, unit: 'count' as const };
    return [
      { ...base, seriesId: `${this.id}.total`, value: events.length },
      { ...base, seriesId: `${this.id}.inProgress`, value: inProgress },
    ];
  }
}
