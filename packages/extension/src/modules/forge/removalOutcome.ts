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

/**
 * Records of a removal's objects that may be left in the org: kept, refused,
 * or out of the sight of the user it ran as — never taken for removed.
 */
function leftInOrg(object: ForgeUndoObjectResult): number {
  return object.keptChanged + object.keptDependents + object.refused + (object.notVisible ?? 0);
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
 * went each way — so that it is not offered twice once it left none of them,
 * and is offered for what it left otherwise.
 *
 * A removal of what an earlier one left adds what it deleted, or found gone,
 * to what the earlier ones took, and says what it kept, had refused, and did
 * not reach: the run's line then counts the run's records, and not the few
 * taken last.
 *
 * Every removal that took records marks the run, whether it ended or was
 * cancelled. Only one that ended used to: cancelled between two others, a
 * removal's deletes were in no count, and the line undercounted what went.
 * What a cancel kept it from reaching is counted too, so the run stays
 * offered for those (`removalTookAll`).
 *
 * @param planned - How many records the removal set out to take.
 * @param earlier - The mark the removals before this one left on the run.
 * @returns Nothing when the removal took no record: it leaves the run, and
 *   its mark, as it found them.
 */
export function removalMark(
  result: Pick<ForgeUndoResult, 'status' | 'objects' | 'finishedAt'>,
  planned: number,
  earlier?: ForgeUndoMark,
): ForgeUndoMark | undefined {
  const sum = (count: (o: ForgeUndoObjectResult) => number): number =>
    result.objects.reduce((total, o) => total + count(o), 0);
  const deleted = sum((o) => o.deleted);
  const alreadyGone = sum((o) => o.alreadyGone);
  if (deleted + alreadyGone === 0) return undefined;
  const kept = sum((o) => o.keptChanged + o.keptDependents);
  const refused = sum((o) => o.refused);
  // Not seen is not gone: the run stays offered for them, to a user who sees them.
  const notVisible = sum((o) => o.notVisible ?? 0);
  // A removal that ended settled every record it set out to take; one
  // cancelled left the rest where they were.
  const notReached =
    result.status === 'cancelled'
      ? Math.max(0, planned - deleted - alreadyGone - kept - refused - notVisible)
      : 0;
  return {
    removedAt: result.finishedAt,
    deleted: (earlier?.deleted ?? 0) + deleted,
    alreadyGone: (earlier?.alreadyGone ?? 0) + alreadyGone,
    kept,
    refused,
    ...(notReached > 0 ? { notReached } : {}),
    ...(notVisible > 0 ? { notVisible } : {}),
  };
}
