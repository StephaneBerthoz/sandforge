/**
 * How a removal of the records a run created ends, is recorded and is marked:
 * one reading for every module that takes a run back — a Forge clone, a
 * Frozen load — so the page and the audit trail say the same of both.
 */

import type {
  AuditObjectCounts,
  AuditOutcome,
  ForgeRemovalSpan,
  ForgeUndoMark,
  ForgeSweepResult,
  ForgeUndoObjectResult,
  ForgeUndoResult,
  ForgeUndoStatus,
} from '@sandforge/shared';

import { emptyCounts } from '../audit/auditTrail.js';
import type { RemovalPreviewObject } from './ForgeRunRemoval.js';

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
 * How a removal ended once its sweep is counted: the sweep was asked of it, and
 * a removal that took the run's records with its sweep refused, failed or
 * stopped short is no success. Its exit code said so, and its status did not:
 * a script reading `.result.status`, and the panel's first line, read a success
 * with the records of the sweep still in the org. A removal that left records
 * of its own ends as it ended; a sweep that kept what came late or is tied to
 * nothing did what it was asked, and stays a success (`ForgeSweepResult.left`).
 */
export function removalStatusWithSweep(
  status: ForgeUndoStatus,
  sweep: Pick<ForgeSweepResult, 'status'> | undefined,
): ForgeUndoStatus {
  if (status !== 'success' || !sweep || sweep.status === 'success') return status;
  return sweep.status === 'cancelled' ? 'cancelled' : 'partial';
}

/**
 * A removal in the audit trail's words: as it ended, a removal the user
 * stopped part way included, which is recorded as cancelled with what it
 * deleted by then. It was recorded as partial when it had deleted something,
 * and as failed when it had not: the trail read a stop as the org's refusal.
 */
export function removalAuditOutcome(result: Pick<ForgeUndoResult, 'status'>): AuditOutcome {
  return result.status;
}

/**
 * What a removal deleted and what the org refused, per object, for the audit
 * trail, and what a stop kept it from reaching, as records it never sent: an
 * entry of a removal stopped part way named the contacts it deleted, and not
 * the account it never got to.
 */
export function removalAuditObjects(
  objects: readonly ForgeUndoObjectResult[],
): AuditObjectCounts[] {
  return objects
    .filter((o) => o.deleted + o.refused + (o.notReached ?? 0) > 0)
    .map((o) => ({
      ...emptyCounts(o.objectApiName),
      deleted: o.deleted,
      failed: o.refused,
      ...((o.notReached ?? 0) > 0 ? { notSent: o.notReached } : {}),
    }));
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
 * A removal that took every record the run created again (`again`) — an
 * undo of a checkpoint's rewind brought back what a removal had found gone —
 * counts them all once more: its counts stand alone, and it marks the run
 * even when it took none, every one kept as changed since or refused, so the
 * run is offered for those, and no longer said to have nothing left. Stopped
 * before it took any, it leaves the run as it found it.
 *
 * The lines the platform copied as the run wrote under a quote it synced
 * (`ForgeUndoObjectResult.platformCopies`) are records the removal took like
 * the run's own, and counted with them; `planned`, the run's records, does
 * not hold them, and what a cancel kept it from reaching is told against both.
 *
 * @param planned - How many records the removal set out to take.
 * @param earlier - The mark the removals before this one left on the run.
 * @param again - Whether it set out to take every record the run created.
 * @returns Nothing when the removal took no record: it leaves the run, and
 *   its mark, as it found them.
 */
export function removalMark(
  result: Pick<ForgeUndoResult, 'status' | 'objects' | 'finishedAt'>,
  planned: number,
  earlier?: ForgeUndoMark,
  again = false,
): ForgeUndoMark | undefined {
  const sum = (count: (o: ForgeUndoObjectResult) => number): number =>
    result.objects.reduce((total, o) => total + count(o), 0);
  const deleted = sum((o) => o.deleted);
  const alreadyGone = sum((o) => o.alreadyGone);
  const kept = sum((o) => o.keptChanged + o.keptDependents);
  const refused = sum((o) => o.refused);
  // Not seen is not gone: the run stays offered for them, to a user who sees them.
  const notVisible = sum((o) => o.notVisible ?? 0);
  if (deleted + alreadyGone === 0) {
    if (!again || result.status === 'cancelled' || kept + refused + notVisible === 0) {
      return undefined;
    }
  }
  const before = again ? undefined : earlier;
  const copies = sum((o) => o.platformCopies ?? 0);
  // A removal that ended settled every record it set out to take; one
  // cancelled left the rest where they were.
  const notReached =
    result.status === 'cancelled'
      ? Math.max(0, planned + copies - deleted - alreadyGone - kept - refused - notVisible)
      : 0;
  return {
    removedAt: result.finishedAt,
    deleted: (before?.deleted ?? 0) + deleted,
    alreadyGone: (before?.alreadyGone ?? 0) + alreadyGone,
    kept,
    refused,
    ...(notReached > 0 ? { notReached } : {}),
    ...(notVisible > 0 ? { notVisible } : {}),
  };
}

/** The removal spans of every list, each once, in the order they ran. */
export function spansOf(
  ...lists: ReadonlyArray<readonly ForgeRemovalSpan[] | undefined>
): ForgeRemovalSpan[] {
  const seen = new Set<string>();
  const spans: ForgeRemovalSpan[] = [];
  for (const span of lists.flatMap((list) => list ?? [])) {
    const key = `${span.first}|${span.last}|${span.userId.slice(0, 15)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    spans.push(span);
  }
  return spans.sort((a, b) => Date.parse(a.first) - Date.parse(b.first));
}

/** How many reasons an object's result says at most, as a removal says them. */
const REASONS_KEPT = 5;

/** `a` and `b` as one list, each once, `limit` at most. */
function bothOf(a: readonly string[], b: readonly string[], limit = Infinity): string[] {
  return [...new Set([...a, ...b])].slice(0, limit);
}

/** `a` plus `b`, absent when both are. */
function sumOf(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}

/**
 * The results of removals of several parts of a run made one after the
 * other, object by object, as one removal says them: an object two of them
 * took records of is counted once, with both counts, in the order the
 * removals first named it.
 */
export function mergedUndoObjects(
  ...lists: ReadonlyArray<readonly ForgeUndoObjectResult[]>
): ForgeUndoObjectResult[] {
  const merged = new Map<string, ForgeUndoObjectResult>();
  for (const object of lists.flat()) {
    const was = merged.get(object.objectApiName);
    if (!was) {
      merged.set(object.objectApiName, { ...object });
      continue;
    }
    const optional = {
      notVisible: sumOf(was.notVisible, object.notVisible),
      notReached: sumOf(was.notReached, object.notReached),
      heldByAutomation: sumOf(was.heldByAutomation, object.heldByAutomation),
      platformCopies: sumOf(was.platformCopies, object.platformCopies),
    };
    const holders = bothOf(was.automationHolders ?? [], object.automationHolders ?? []);
    const files =
      was.filesLeft || object.filesLeft
        ? {
            count: (was.filesLeft?.count ?? 0) + (object.filesLeft?.count ?? 0),
            names: bothOf(was.filesLeft?.names ?? [], object.filesLeft?.names ?? [], REASONS_KEPT),
          }
        : undefined;
    merged.set(object.objectApiName, {
      objectApiName: object.objectApiName,
      planned: was.planned + object.planned,
      deleted: was.deleted + object.deleted,
      alreadyGone: was.alreadyGone + object.alreadyGone,
      keptChanged: was.keptChanged + object.keptChanged,
      keptDependents: was.keptDependents + object.keptDependents,
      refused: was.refused + object.refused,
      ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
      heldBy: bothOf(was.heldBy, object.heldBy),
      ...(holders.length > 0 ? { automationHolders: holders } : {}),
      unchecked: bothOf(was.unchecked, object.unchecked),
      reasons: bothOf(was.reasons, object.reasons, REASONS_KEPT),
      ...(files ? { filesLeft: files } : {}),
    });
  }
  return [...merged.values()];
}

/** What the previews of several parts of a run say, object by object, as one preview says it. */
export function mergedPreviewObjects(
  ...lists: ReadonlyArray<readonly RemovalPreviewObject[]>
): RemovalPreviewObject[] {
  const merged = new Map<string, RemovalPreviewObject>();
  for (const object of lists.flat()) {
    const was = merged.get(object.objectApiName);
    if (!was) {
      merged.set(object.objectApiName, { ...object, changedBy: { ...object.changedBy } });
      continue;
    }
    const changedBy = { ...was.changedBy };
    for (const [user, count] of Object.entries(object.changedBy)) {
      changedBy[user] = (changedBy[user] ?? 0) + count;
    }
    const copies = sumOf(was.platformCopies, object.platformCopies);
    merged.set(object.objectApiName, {
      objectApiName: object.objectApiName,
      planned: was.planned + object.planned,
      toDelete: was.toDelete + object.toDelete,
      alreadyGone: was.alreadyGone + object.alreadyGone,
      changedSince: was.changedSince + object.changedSince,
      keptChanged: was.keptChanged + object.keptChanged,
      changedBy,
      undeletable: was.undeletable + object.undeletable,
      notVisible: was.notVisible + object.notVisible,
      unread: was.unread + object.unread,
      ...(copies !== undefined ? { platformCopies: copies } : {}),
      reasons: bothOf(was.reasons, object.reasons, REASONS_KEPT),
    });
  }
  return [...merged.values()];
}
