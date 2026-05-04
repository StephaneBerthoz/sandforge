import type { MetricSample } from '@sandforge/shared';

import type { MonitorProbe, ProbePriority } from '../MonitorProbe.js';
import type { ApexLogAnalyzer, ApexLogIssue } from '../ApexLogAnalyzer.js';

/**
 * Phase 03 Plan 03-03 — `ApexLogAnalyzer` adapter.
 *
 * Cadence: **120 s** (2 min), priority `low` — Apex log scans are
 * informational and pause when the WebView is hidden.
 *
 * Emits 3 samples: total `errorCount`, `warningCount`, and `infoCount` across
 * the cached analyses for this org.
 */
export class ApexLogProbe implements MonitorProbe {
  readonly id = 'monitor.apex';
  readonly intervalMs = 120_000;
  readonly priority: ProbePriority = 'low';

  constructor(private readonly analyzer: ApexLogAnalyzer) {}

  async run(orgId: string): Promise<MetricSample[]> {
    const analyses = await this.analyzer.fetchAndAnalyze(orgId);
    let errors = 0;
    let warnings = 0;
    let infos = 0;
    for (const analysis of analyses) {
      for (const issue of analysis.issues as ApexLogIssue[]) {
        if (issue.severity === 'critical') errors++;
        else if (issue.severity === 'warning') warnings++;
        else infos++;
      }
    }
    const ts = new Date().toISOString();
    const base = { ts, orgId, unit: 'count' as const };
    return [
      { ...base, seriesId: `${this.id}.errorCount`, value: errors },
      { ...base, seriesId: `${this.id}.warningCount`, value: warnings },
      { ...base, seriesId: `${this.id}.infoCount`, value: infos },
    ];
  }
}
