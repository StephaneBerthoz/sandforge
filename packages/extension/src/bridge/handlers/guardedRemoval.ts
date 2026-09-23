import type {
  AuditAction,
  AuditObjectCounts,
  GuardDecision,
  RemovalOutcome,
} from '@sandforge/shared';
import { orgTypeToGuardTier } from '@sandforge/shared';

import type { HandlerDeps } from './HandlerTypes.js';
import {
  PRODUCTION_GUARD_MISSING,
  sendOperationCompleted,
  sendOperationFailed,
  sendOperationProgress,
  sendOperationStarted,
} from './HandlerTypes.js';
import { consultProductionGuard } from '../../core/precheck/consultProductionGuard.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { emptyCounts, recordWriteRun } from '../../modules/audit/auditTrail.js';
import { removalOutcome } from '../../modules/dataops/RecordRemoval.js';
import type { WriteCounts } from '../../modules/dataops/RecordRemoval.js';

/** A write that overwrites or deletes records the user picked. */
export interface GuardedRemoval {
  orgId: string;
  /** What the guard is asked about: an update (an erasure in place) or a delete. */
  operation: 'update' | 'delete';
  /** The objects written, as the guard's confirmation names them. */
  objectNames: string[];
  /** Records the run writes. */
  recordCount: number;
  /** How the audit trail names the run. */
  action: AuditAction;
  /** What Live Operations shows while it runs. No value, no Id. */
  description: string;
  /** The request that asked for it, for the fix suggestion of a failure. */
  origin: string;
  /** The write itself; it reports each object as it is done. */
  run: (
    onObject: (objectApiName: string, counts: WriteCounts) => void,
  ) => Promise<Array<{ objectApiName: string; counts: WriteCounts }>>;
}

/** How a guarded run ended. */
export type GuardedRemovalResult =
  | {
      ran: true;
      operationId: string;
      /** What was written; when the run stopped half way, what it had written by then. */
      outcome: RemovalOutcome;
      guard?: GuardDecision;
      /** Why the run stopped half way, when it did. */
      error?: string;
    }
  | {
      ran: false;
      operationId: string;
      /** The guard's decision, when it was the guard that stopped the run. */
      guard?: 'refused' | 'declined';
      /** The code of a refusal made before the guard could judge the run. */
      code?: string;
      message: string;
    };

/** One object's counts in the audit trail's columns. */
function auditCounts(
  operation: GuardedRemoval['operation'],
  objectApiName: string,
  counts: WriteCounts,
): AuditObjectCounts {
  return operation === 'delete'
    ? { ...emptyCounts(objectApiName), deleted: counts.done, failed: counts.failed }
    : { ...emptyCounts(objectApiName), updated: counts.done, failed: counts.failed };
}

/**
 * Run a write that erases or deletes records the way every write path runs
 * one: Production Guard first — refused, or declined at its confirmation, and
 * nothing is written — then the run, announced to Live Operations, and its
 * entry in the audit trail with the guard's decision, whether it went through,
 * stopped, or failed half way.
 *
 * @param deps - The handler's dependencies.
 * @param removal - The run.
 * @returns What the run did — up to where it stopped, if it stopped — or why
 *   it did not start.
 */
export async function runGuardedRemoval(
  deps: HandlerDeps,
  removal: GuardedRemoval,
): Promise<GuardedRemovalResult> {
  const operationId = crypto.randomUUID();

  // No removal without a guard to pass, as on every other write path: with
  // none injected, this one deleted on, to a production org as readily as to
  // a scratch one.
  const productionGuard = deps.infraServices?.productionGuard;
  if (!productionGuard) {
    recordWriteRun(deps, {
      action: removal.action,
      module: 'dataops',
      operationId,
      orgId: removal.orgId,
      outcome: 'stopped',
      code: PRODUCTION_GUARD_MISSING.code,
    });
    return {
      ran: false,
      operationId,
      code: PRODUCTION_GUARD_MISSING.code,
      message: PRODUCTION_GUARD_MISSING.message,
    };
  }
  const org = deps.orgManager.getOrg(removal.orgId);
  const { check, decision } = await consultProductionGuard(productionGuard, {
    orgId: removal.orgId,
    orgTier: orgTypeToGuardTier(org?.orgType ?? ''),
    operation: removal.operation,
    objectName: removal.objectNames.join(', '),
    recordCount: removal.recordCount,
    module: 'dataops',
  });
  const guard: GuardDecision = decision;
  if (decision === 'refused' || decision === 'declined') {
    recordWriteRun(deps, {
      action: removal.action,
      module: 'dataops',
      operationId,
      orgId: removal.orgId,
      outcome: 'stopped',
      guard: decision,
    });
    return {
      ran: false,
      operationId,
      guard: decision,
      message:
        decision === 'refused'
          ? `Operation blocked by Production Guard: ${check.blockedReason ?? check.impactSummary}`
          : 'Operation cancelled by user (production confirmation declined).',
    };
  }

  sendOperationStarted(deps, operationId, 'dataops', removal.description);
  const done: Array<{ objectApiName: string; counts: WriteCounts }> = [];
  let written = 0;
  try {
    const results = await removal.run((objectApiName, counts) => {
      done.push({ objectApiName, counts });
      written += counts.done + counts.failed;
      sendOperationProgress(
        deps,
        operationId,
        Math.min(100, Math.round((written / Math.max(removal.recordCount, 1)) * 100)),
        written,
        removal.recordCount,
        `${objectApiName}: ${counts.done} done, ${counts.failed} refused`,
      );
    });
    const outcome = removalOutcome(results);
    recordWriteRun(deps, {
      action: removal.action,
      module: 'dataops',
      operationId,
      orgId: removal.orgId,
      outcome: outcome.status,
      ...(guard ? { guard } : {}),
      objects: results.map((r) => auditCounts(removal.operation, r.objectApiName, r.counts)),
    });
    sendOperationCompleted(deps, operationId, {
      status: outcome.status,
      done: outcome.done,
      failed: outcome.failed,
    });
    return { ran: true, operationId, outcome, ...(guard ? { guard } : {}) };
  } catch (err: unknown) {
    // Stopped half way: recorded as failed, with what it had written.
    const error = extractErrorMessage(err);
    recordWriteRun(deps, {
      action: removal.action,
      module: 'dataops',
      operationId,
      orgId: removal.orgId,
      outcome: 'failure',
      ...(guard ? { guard } : {}),
      objects: done.map((r) => auditCounts(removal.operation, r.objectApiName, r.counts)),
    });
    sendOperationFailed(deps, operationId, error, true, {
      context: {
        module: 'dataops',
        operation: removal.origin,
        objectName: removal.objectNames.join(', '),
      },
    });
    return {
      ran: true,
      operationId,
      outcome: { ...removalOutcome(done), status: 'failure' },
      ...(guard ? { guard } : {}),
      error,
    };
  }
}
