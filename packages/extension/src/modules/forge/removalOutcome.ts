/**
 * How a removal of the records a run created ends, is recorded and is marked:
 * one reading for every module that takes a run back — a Forge clone, a
 * Frozen load — so the page and the audit trail say the same of both.
 */

import type {
  AuditObjectCounts,
  AuditOutcome,
  ForgeUndoMark,
  ForgeUndoObjectResult,
  ForgeUndoResult,
  ForgeUndoStatus,
} from '@sandforge/shared';

import { emptyCounts } from '../audit/auditTrail.js';

/** Records of a removal's objects left in the org: kept, or refused. */
function leftInOrg(object: ForgeUndoObjectResult): number {
  return object.keptChanged + object.keptDependents + object.refused;
}

/**
 * How a removal of a run's records ended. Nothing left in the org is a
 * success, whether the removal deleted the records or found them gone.
 */
export function removalStatus(
  objects: readonly ForgeUndoObjectResult[],
  cancelled: boolean,
): ForgeUndoStatus {
  if (cancelled) return 'cancelled';
  if (objects.every((o) => leftInOrg(o) === 0)) return 'success';
  return objects.some((o) => o.deleted > 0) ? 'partial' : 'failure';
}

/**
 * A removal in the audit trail's words. A removal stopped part way is partial
 * when it deleted something, and failed when it deleted nothing.
 */
export function removalAuditOutcome(
  result: Pick<ForgeUndoResult, 'status' | 'objects'>,
): AuditOutcome {
  if (result.status !== 'cancelled') return result.status;
  return result.objects.some((o) => o.deleted > 0) ? 'partial' : 'failure';
}

/** What a removal deleted and what the org refused, per object, for the audit trail. */
export function removalAuditObjects(
  objects: readonly ForgeUndoObjectResult[],
): AuditObjectCounts[] {
  return objects
    .filter((o) => o.deleted + o.refused > 0)
    .map((o) => ({ ...emptyCounts(o.objectApiName), deleted: o.deleted, failed: o.refused }));
}

/**
 * The removal as the run it took back keeps it — when, and how many records
 * went each way — so it is not offered twice.
 */
export function removalMark(
  result: Pick<ForgeUndoResult, 'objects' | 'finishedAt'>,
): ForgeUndoMark {
  const sum = (count: (o: ForgeUndoObjectResult) => number): number =>
    result.objects.reduce((total, o) => total + count(o), 0);
  return {
    removedAt: result.finishedAt,
    deleted: sum((o) => o.deleted),
    alreadyGone: sum((o) => o.alreadyGone),
    kept: sum((o) => o.keptChanged + o.keptDependents),
    refused: sum((o) => o.refused),
  };
}

/**
 * Whether a removal that ended so marks its run: once records went, or none
 * was left to go. One stopped part way, or that deleted nothing, is offered
 * again.
 */
export function removalMarks(status: ForgeUndoStatus): boolean {
  return status === 'success' || status === 'partial';
}
