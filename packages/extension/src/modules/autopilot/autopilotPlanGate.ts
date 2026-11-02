/**
 * What the panel's review says of a plan against its target before Run, and
 * what the audit trail keeps of a fit.
 *
 * A plan of 64.5 MB for a sandbox with 22 MB left said nothing of it until
 * Run, and its refusal then carried no figure. The review reads `/limits`
 * once as the plan is made and says what a run would come to.
 *
 * Kept apart from `autopilotFit.ts`, which loads the scanner: the bridge reads
 * this on the activation path.
 */

import type { AuditFit, AutopilotFitReport, AutopilotPlanWriteGate } from '@sandforge/shared';
import type { ApiBudgetCheck, StorageCheck, WritePlan } from '../forge/ForgeRunGate.js';

/**
 * A plan against the target's storage and its API requests, as the run's gate
 * would judge them from the same `/limits`.
 *
 * @param plan - The records it writes (`autopilotWritePlan`).
 * @param check - Its storage against what the target has left.
 * @param api - Its requests against what the target has left of the day's.
 */
export function planWriteGateOf(
  plan: Pick<WritePlan, 'totalRows'>,
  check: StorageCheck,
  api: ApiBudgetCheck,
): AutopilotPlanWriteGate {
  return {
    records: plan.totalRows,
    estimateMB: check.estimateMB,
    verdict: check.verdict,
    ...(check.verdict === 'unread'
      ? { unread: check.unread }
      : { remainingMB: check.remainingMB, maxMB: check.maxMB }),
    ...(api.verdict === 'unread'
      ? {}
      : {
          apiRequests: {
            estimate: api.estimate,
            remaining: api.remaining,
            max: api.max,
            verdict: api.verdict,
          },
        }),
  };
}

/**
 * What the audit trail keeps of the fit a run's plan came from: the share or
 * that it was capped, the bound asked, the records the fitted run set out to
 * write and those the plan it was fitted from held. Counts, never ids.
 *
 * @param kept - The records of the fitted plan.
 * @param inSource - The records of the plan it was fitted from.
 */
export function autopilotAuditFitOf(
  report: Pick<AutopilotFitReport, 'mode' | 'share'>,
  kept: number,
  inSource: number,
): AuditFit {
  const { mode, share } = report;
  const capped = mode.all !== undefined || Object.keys(mode.caps ?? {}).length > 0;
  return {
    module: 'autopilot',
    ...(share !== undefined ? { share } : {}),
    ...(capped ? { capped: true as const } : {}),
    ...(mode.withinMB !== undefined ? { withinMB: mode.withinMB } : {}),
    kept,
    inSource,
  };
}
