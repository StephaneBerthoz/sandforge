import type { MetricSample } from '@sandforge/shared';

import type { MonitorProbe, ProbePriority } from '../MonitorProbe.js';
import type {
  GovernanceEngine,
  GovernancePolicy,
  MetricValues,
} from '../GovernanceEngine.js';

/**
 * Source of governance inputs — supplies the active policy (if any) and the
 * metric values to evaluate against. Implementation lives outside this probe
 * so the wiring stays decoupled (per RESEARCH §2 — orchestrators wire,
 * probes adapt).
 */
export interface GovernanceProbeContext {
  /** Returns the active policy for the org, or `undefined` to skip evaluation. */
  getPolicy(orgId: string): GovernancePolicy | undefined;
  /** Returns the live metric inputs (e.g. snapshots from other trackers). */
  getMetrics(orgId: string): Promise<MetricValues> | MetricValues;
}

/**
 * Phase 03 Plan 03-03 — `GovernanceEngine` adapter.
 *
 * Cadence: **300 s** (5 min), priority `normal`.
 *
 * Emits 2 samples per evaluated policy:
 *  - `monitor.governance.complianceScore` — 0..100
 *  - `monitor.governance.violations` — count of non-passing rules
 *
 * If no policy is registered for the org (default state), no samples are
 * emitted — the registry treats an empty array as a successful no-op.
 */
export class GovernanceProbe implements MonitorProbe {
  readonly id = 'monitor.governance';
  readonly intervalMs = 300_000;
  readonly priority: ProbePriority = 'normal';

  constructor(
    private readonly engine: GovernanceEngine,
    private readonly context: GovernanceProbeContext,
  ) {}

  async run(orgId: string): Promise<MetricSample[]> {
    const policy = this.context.getPolicy(orgId);
    if (!policy) return [];
    const metrics = await this.context.getMetrics(orgId);
    const result = this.engine.evaluatePolicy(policy, metrics);
    const violations = result.ruleResults.filter((r) => r.status !== 'pass').length;
    const ts = result.evaluatedAt;
    return [
      {
        ts,
        orgId,
        seriesId: `${this.id}.complianceScore`,
        value: result.complianceScore,
        unit: 'percent',
      },
      {
        ts,
        orgId,
        seriesId: `${this.id}.violations`,
        value: violations,
        unit: 'count',
      },
    ];
  }
}
