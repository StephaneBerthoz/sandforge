import type { MetricSample } from '@sandforge/shared';

import type { MonitorProbe, ProbePriority } from '../MonitorProbe.js';
import type { UserSessionMonitor } from '../UserSessionMonitor.js';

/**
 * Phase 03 Plan 03-03 — `UserSessionMonitor` adapter.
 *
 * Cadence: **300 s** (5 min), priority `low` — session counts are
 * informational and can pause when the WebView is hidden.
 *
 * Emits 2 samples: `sessionCount` (raw active sessions) and `userCount`
 * (distinct users — a session may have multiple per user).
 */
export class UserSessionProbe implements MonitorProbe {
  readonly id = 'monitor.sessions';
  readonly intervalMs = 300_000;
  readonly priority: ProbePriority = 'low';

  constructor(private readonly monitor: UserSessionMonitor) {}

  async run(orgId: string): Promise<MetricSample[]> {
    const sessions = await this.monitor.fetch(orgId);
    const userCount = this.monitor.getActiveUserCount(orgId);
    const ts = new Date().toISOString();
    const base = { ts, orgId, unit: 'count' as const };
    return [
      { ...base, seriesId: `${this.id}.sessionCount`, value: sessions.length },
      { ...base, seriesId: `${this.id}.userCount`, value: userCount },
    ];
  }
}
