import type {
  AuditAction,
  AuditObjectCounts,
  GuardDecision,
  RemovalOutcome,
} from '@sandforge/shared';
import { guardTierOf } from '@sandforge/shared';

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
import { RUN_CANCELLED } from '../../modules/forge/forgeAudit.js';
import type { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import { listLive } from './liveRun.js';

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
  /**
   * The write itself; it reports each object as it is done, and stops before
   * its next call once `signal` is aborted, with what it wrote by then.
   */
  run: (
    onObject: (objectApiName: string, counts: WriteCounts) => void,
    signal: AbortSignal,
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
      /** Why the run stopped half way, when it did: an error, or a cancel. */
      error?: string;
      /** Set when a cancel stopped it: `error` then says what it did before. */
      cancelled?: true;
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
 * nothing is written — then the run, listed in the registry and in Live
 * Operations, whose Cancel stops it before its next call, and its entry in
 * the audit trail with the guard's decision, whether it went through, was
 * cancelled, stopped, or failed half way. It was announced and listed
 * nowhere: nothing could stop a delete once it had started.
 *
 * @param deps - The handler's dependencies.
 * @param removal - The run.
 * @param tracker - The Monitor's Live Operations, where the run is listed.
 * @returns What the run did — up to where it stopped, if it stopped — or why
 *   it did not start.
 */
export async function runGuardedRemoval(
  deps: HandlerDeps,
  removal: GuardedRemoval,
  tracker?: LiveOperationTracker,
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
    orgTier: guardTierOf(org),
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
          : 'Operation cancelled by user (confirmation declined).',
    };
  }

  sendOperationStarted(deps, operationId, 'dataops', removal.description);
  const stop = new AbortController();
  let settle: (err?: unknown) => void = () => {};
  const tracked = new Promise<void>((resolve, reject) => {
    settle = (err) => (err === undefined ? resolve() : reject(err));
  });
  // The registry attaches its own handlers; this keeps a host with none from
  // an unhandled rejection.
  tracked.catch(() => {});
  deps.infraServices?.backgroundRegistry?.register(
    operationId,
    'dataops',
    removal.description,
    tracked,
    stop,
  );
  const live = listLive(tracker, operationId, 'dataops', removal.description, removal.recordCount);
  const done: Array<{ objectApiName: string; counts: WriteCounts }> = [];
  let written = 0;
  try {
    const results = await removal.run((objectApiName, counts) => {
      done.push({ objectApiName, counts });
      written += counts.done + counts.failed;
      const percentage = Math.min(
        100,
        Math.round((written / Math.max(removal.recordCount, 1)) * 100),
      );
      const step = `${objectApiName}: ${counts.done} done, ${counts.failed} refused`;
      sendOperationProgress(deps, operationId, percentage, written, removal.recordCount, step);
      live.progress(percentage, written, removal.recordCount, step);
    }, stop.signal);
    const outcome = removalOutcome(results);
    const cancelled = stop.signal.aborted;
    recordWriteRun(deps, {
      action: removal.action,
      module: 'dataops',
      operationId,
      orgId: removal.orgId,
      // Stopped by the user: cancelled once it wrote or had a record refused,
      // stopped under the code of a run cancelled before it wrote otherwise.
      ...(cancelled
        ? outcome.done + outcome.failed > 0
          ? { outcome: 'cancelled' as const }
          : { outcome: 'stopped' as const, code: RUN_CANCELLED }
        : { outcome: outcome.status }),
      ...(guard ? { guard } : {}),
      objects: results.map((r) => auditCounts(removal.operation, r.objectApiName, r.counts)),
    });
    if (cancelled) {
      // Aborted in the registry already when the cancel came through it.
      deps.infraServices?.backgroundRegistry?.abort(operationId);
      sendOperationCompleted(deps, operationId, {
        aborted: true,
        done: outcome.done,
        failed: outcome.failed,
      });
      live.cancel();
      settle();
      return {
        ran: true,
        operationId,
        outcome,
        ...(guard ? { guard } : {}),
        cancelled: true,
        error:
          `Cancelled: ${outcome.done} record(s) ${removal.operation === 'delete' ? 'deleted' : 'overwritten'} ` +
          'before the cancel; the rest were left as they are.',
      };
    }
    sendOperationCompleted(deps, operationId, {
      status: outcome.status,
      done: outcome.done,
      failed: outcome.failed,
    });
    if (outcome.status === 'failure') {
      const refused = `The org refused the ${outcome.failed} record(s)`;
      live.fail(refused);
      settle(new Error(refused));
    } else {
      live.complete();
      settle();
    }
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
    live.fail(error);
    settle(err);
    return {
      ran: true,
      operationId,
      outcome: { ...removalOutcome(done), status: 'failure' },
      ...(guard ? { guard } : {}),
      error,
    };
  }
}
