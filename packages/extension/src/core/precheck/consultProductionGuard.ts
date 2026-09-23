import type { GuardDecision } from '@sandforge/shared';

import type { OperationRequest, ProductionGuard, SafetyCheckResult } from './ProductionGuard.js';

/** The part of Production Guard a write path consults. */
export type ConsultedGuard = Pick<ProductionGuard, 'check' | 'confirmIfNeeded'> &
  Partial<Pick<ProductionGuard, 'canAskForConfirmation'>>;

/** What the guard said about one run: its check, and the decision it came to. */
export interface GuardVerdict {
  check: SafetyCheckResult;
  decision: GuardDecision;
}

/**
 * Consult Production Guard the way every write path does — check, ask for
 * confirmation when the check calls for it — and say what was decided, in the
 * words the audit trail records.
 *
 * Every write path used to take these steps inline and keep only what it
 * needed to stop or go on. What the guard decided was known for an instant
 * and then lost: a run that went ahead could not say whether a person had
 * confirmed it or whether nobody had been asked. The guard also kept a
 * session log of its checks, which nothing ever read: the decision is kept
 * with the run it concerns, in the audit trail.
 *
 * `confirmed` needs a person to have answered. A check that calls for a
 * confirmation on a host with no one to ask goes through as the guard lets it,
 * and is recorded as `allowed`.
 *
 * @param guard - The window's guard (or a test double of its steps).
 * @param request - The run as the guard is to judge it.
 * @returns The check, for the caller's messages, and the decision.
 */
export async function consultProductionGuard(
  guard: ConsultedGuard,
  request: OperationRequest,
): Promise<GuardVerdict> {
  const check = guard.check(request);
  if (!check.allowed) return { check, decision: 'refused' };
  const confirmed = await guard.confirmIfNeeded(check, request.orgTier);
  if (!confirmed) return { check, decision: 'declined' };
  const asked = check.requiresConfirmation && guard.canAskForConfirmation === true;
  return { check, decision: asked ? 'confirmed' : 'allowed' };
}

/**
 * A refusal outweighs a declined confirmation, which outweighs a confirmation,
 * which outweighs a plain pass: a run is summed up by the most that happened
 * to any of its batches.
 */
const DECISION_WEIGHT: Record<GuardDecision, number> = {
  allowed: 0,
  confirmed: 1,
  declined: 2,
  refused: 3,
};

/** The more telling of two decisions, for a run the guard judged batch by batch. */
export function strongerDecision(
  current: GuardDecision | undefined,
  next: GuardDecision,
): GuardDecision {
  if (current === undefined) return next;
  return DECISION_WEIGHT[next] > DECISION_WEIGHT[current] ? next : current;
}
