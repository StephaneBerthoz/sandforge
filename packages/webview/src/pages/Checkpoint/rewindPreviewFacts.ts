import type {
  CheckpointObject,
  ForgeRemovalSteps,
  ForgeUndoObjectResult,
  ForgeUndoStatus,
  RewindCannotUndoReason,
  RewindDiff,
  RewindDiffObject,
  RewindResidual,
  RewindResidualReason,
  RewindResult,
  RewindStatus,
} from '@sandforge/shared';

/*
 * What the preview of a rewind says, read off the diff the extension sends,
 * and what its result says, read off the result. Every number is the
 * extension's own, told per object and class: these add an object's classes
 * into the preview's columns and its objects into its three numbers, group
 * what a rewind left by why, and count nothing the extension did not.
 */

/**
 * Days a rewind can be undone after it ends: its journal is kept as long as
 * the recycle bin keeps what it deleted (the store's `RECYCLE_BIN_DAYS`).
 */
export const REWIND_UNDO_DAYS = 15;

/** One object of the preview's table: what a rewind deletes, gives back, brings back and cannot undo. */
export interface RewindRow {
  objectApiName: string;
  /** Created since, brought back since, and what comes back with a parent to go again. */
  toDelete: number;
  /** Records given their checkpoint values back. */
  toGiveBack: number;
  /** On their own, with a parent, and those deleted while the checkpoint was taken. */
  toBringBack: number;
  /** Deleted since and no longer in the recycle bin: made again, with new Ids. */
  toRecreate: number;
  /** What a rewind cannot take back, every reason together. */
  cannotUndo: number;
}

/** An object's row of the preview's table. */
export function rowOf(object: RewindDiffObject): RewindRow {
  const { toDelete, toGiveBack, toBringBack } = object;
  return {
    objectApiName: object.objectApiName,
    toDelete: toDelete.createdSince + toDelete.broughtBackSince + toDelete.comesBackWithParent,
    toGiveBack: toGiveBack.records,
    toBringBack: toBringBack.inBin + toBringBack.withParent + toBringBack.deletedWhileTaken,
    toRecreate: object.toRecreate ?? 0,
    cannotUndo: object.cannotUndo.reduce((sum, item) => sum + item.count, 0),
  };
}

/**
 * The preview's three numbers — records to delete, to give back and to bring
 * back — and the records to make again with new Ids, every object together.
 */
export function rewindTotals(
  diff: Pick<RewindDiff, 'objects'>,
): Pick<RewindRow, 'toDelete' | 'toGiveBack' | 'toBringBack' | 'toRecreate'> {
  return diff.objects.map(rowOf).reduce(
    (sum, row) => ({
      toDelete: sum.toDelete + row.toDelete,
      toGiveBack: sum.toGiveBack + row.toGiveBack,
      toBringBack: sum.toBringBack + row.toBringBack,
      toRecreate: sum.toRecreate + row.toRecreate,
    }),
    { toDelete: 0, toGiveBack: 0, toBringBack: 0, toRecreate: 0 },
  );
}

/**
 * Records of an object the checkpoint does not hold that a rewind brings back
 * for a moment, then deletes again: deleted since with records it holds,
 * which their delete took along, and which Salesforce gives back with them
 * only. In none of the preview's numbers — before the rewind and after it,
 * they are in the recycle bin — but written twice, so their automation runs.
 */
export function carriersOf(object: Pick<RewindDiffObject, 'toBringBack'>): number {
  return object.toBringBack.carriers ?? 0;
}

/** The records a rewind brings back for a moment, then deletes again, every object together. */
export function carriersTotal(diff: Pick<RewindDiff, 'objects'>): number {
  return diff.objects.reduce((sum, object) => sum + carriersOf(object), 0);
}

/**
 * Whether a rewind would write anything: delete, give back, bring back or
 * make again one record at least, or bring one back for a moment.
 */
export function rewindWrites(diff: Pick<RewindDiff, 'objects'>): boolean {
  const totals = rewindTotals(diff);
  return (
    totals.toDelete + totals.toGiveBack + totals.toBringBack + totals.toRecreate > 0 ||
    carriersTotal(diff) > 0
  );
}

/** The records a rewind makes again with new Ids, object by object: those the recycle bin no longer gives back. */
export function recreateLines(
  diff: Pick<RewindDiff, 'objects'>,
): Array<{ objectApiName: string; count: number }> {
  return diff.objects
    .map((object) => ({ objectApiName: object.objectApiName, count: object.toRecreate ?? 0 }))
    .filter((line) => line.count > 0);
}

/**
 * Whether the org holds the checkpoint's state among the objects and fields
 * it holds: nothing to write, nothing a rewind cannot take back, nothing it
 * leaves unexplained, no field deleted since, and every object read. A record
 * touched since that holds its checkpoint values, and a field added since,
 * whose values a rewind leaves alone, do not make it differ.
 */
export function heldAsItWas(diff: Pick<RewindDiff, 'objects' | 'unread'>): boolean {
  return (
    diff.unread.length === 0 &&
    !rewindWrites(diff) &&
    diff.objects.every(
      (object) =>
        object.unexplained === 0 &&
        object.cannotUndo.every((item) => item.count === 0) &&
        (object.schemaDrift?.removed.length ?? 0) === 0,
    )
  );
}

/** One user who last changed records a rewind deletes or gives back, and how many. */
export interface LastChanger {
  userId: string;
  /** Their name, when the org gave it. */
  name?: string;
  count: number;
}

/**
 * Who last changed the records a rewind deletes or gives back, every object
 * together, the most first: the names the diff read for their Ids.
 */
export function lastChangers(diff: Pick<RewindDiff, 'objects' | 'userNames'>): LastChanger[] {
  const counts = new Map<string, number>();
  for (const object of diff.objects) {
    for (const [userId, count] of Object.entries(object.lastChangedBy)) {
      counts.set(userId, (counts.get(userId) ?? 0) + count);
    }
  }
  return [...counts]
    .filter(([, count]) => count > 0)
    .map(([userId, count]) => {
      const name = diff.userNames[userId];
      return name ? { userId, name, count } : { userId, count };
    })
    .sort((a, b) => b.count - a.count || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
}

/** What a rewind cannot take back for one reason, every object together, and the objects it is of. */
export interface CannotUndoLine {
  reason: RewindCannotUndoReason;
  count: number;
  objects: string[];
}

/** The order the preview names what a rewind cannot take back in. */
const CANNOT_UNDO_ORDER: readonly RewindCannotUndoReason[] = [
  'goneForGood',
  'deletedWithCreatedParent',
  'deletedWithParentOutside',
  'convertedLead',
  'activatedContract',
];

/** What a rewind cannot take back, by reason, for the reasons that apply. */
export function cannotUndoLines(diff: Pick<RewindDiff, 'objects'>): CannotUndoLine[] {
  return CANNOT_UNDO_ORDER.flatMap((reason) => {
    const of = diff.objects.flatMap((object) =>
      object.cannotUndo
        .filter((item) => item.reason === reason && item.count > 0)
        .map((item) => ({ objectApiName: object.objectApiName, count: item.count })),
    );
    if (of.length === 0) return [];
    return [
      {
        reason,
        count: of.reduce((sum, item) => sum + item.count, 0),
        objects: of.map((item) => item.objectApiName),
      },
    ];
  });
}

/** Records outside the checkpoint a rewind's deletions take along, under the records of one of its objects. */
export interface OutsideLine {
  /** The checkpoint's object whose records to delete they hang from. */
  objectApiName: string;
  /** The object outside the checkpoint they are of. */
  outside: string;
  count: number;
  /** The records of {@link objectApiName} they hang from. */
  parents: number;
}

/** What a rewind's deletions take along outside the checkpoint, object by object. */
export function outsideLines(diff: Pick<RewindDiff, 'objects'>): OutsideLine[] {
  return diff.objects.flatMap((object) =>
    object.outside
      .filter((item) => item.count > 0)
      .map((item) => ({
        objectApiName: object.objectApiName,
        outside: item.objectApiName,
        count: item.count,
        parents: item.parents,
      })),
  );
}

/**
 * The objects each step of a rewind writes, in the order it writes them: it
 * brings back from the recycle bin, makes again what the bin no longer gives
 * back, gives back values, then deletes. What the org runs as it writes is
 * read for these. An object whose records come back for a moment, to be
 * deleted again (`carriersOf`), is brought back and deleted, as the rewind
 * itself lists it: its automation runs on both.
 */
export function rewindSteps(diff: Pick<RewindDiff, 'objects'>): ForgeRemovalSteps {
  const rows = diff.objects.map((object) => ({ ...rowOf(object), carriers: carriersOf(object) }));
  return {
    bringBack: rows
      .filter((row) => row.toBringBack + row.carriers > 0)
      .map((row) => row.objectApiName),
    recreate: rows.filter((row) => row.toRecreate > 0).map((row) => row.objectApiName),
    giveBack: rows.filter((row) => row.toGiveBack > 0).map((row) => row.objectApiName),
    delete: rows.filter((row) => row.toDelete + row.carriers > 0).map((row) => row.objectApiName),
  };
}

// ─── What a rewind, or its undo, did ─────────────────────────────────────────

/**
 * The phases of a rewind as its run lists them, in the order it runs them:
 * it brings back from the recycle bin, makes again what the bin no longer
 * gives back, gives back values, deletes children first, then reads the org
 * again.
 */
export type RewindPhase = 'bringBack' | 'recreate' | 'giveBack' | 'delete' | 'check';

/** One phase of a rewind under way, and the records of the confirmed preview it acts on. */
export interface RewindPhaseLine {
  phase: RewindPhase;
  /** Records of the preview it acts on; 0 for the check. */
  count: number;
}

/**
 * The phases a rewind of `diff` runs, with what each acts on. A phase the
 * preview the user confirmed gave nothing to is not listed; the check that
 * reads the org again always is.
 */
export function rewindPhases(diff: Pick<RewindDiff, 'objects'>): RewindPhaseLine[] {
  const totals = rewindTotals(diff);
  const acting: RewindPhaseLine[] = [
    { phase: 'bringBack', count: totals.toBringBack },
    { phase: 'recreate', count: totals.toRecreate },
    { phase: 'giveBack', count: totals.toGiveBack },
    { phase: 'delete', count: totals.toDelete },
  ];
  return [...acting.filter((line) => line.count > 0), { phase: 'check', count: 0 }];
}

/** The order a result names what still differs in: what the user can act on first. */
const RESIDUAL_RANK: Readonly<Record<RewindResidualReason, number>> = {
  automation: 0,
  changedDuringRewind: 1,
  changedSincePreview: 2,
  notInBin: 3,
  refused: 4,
  kept: 5,
  goneForGood: 6,
};

/** Every reason, in the order the result tells them: one missing from the rank fails to compile. */
const RESIDUAL_ORDER = (Object.keys(RESIDUAL_RANK) as RewindResidualReason[]).sort(
  (a, b) => RESIDUAL_RANK[a] - RESIDUAL_RANK[b],
);

/**
 * Of what an undo sent to the recycle bin, the records the rewind had made
 * again: per object, as many of those it deleted as were made again and are
 * no longer in the org — the others went with a record it deleted.
 */
export function remadeDeleted(result: Pick<RewindResult, 'deleted' | 'remade'>): number {
  return (result.remade ?? []).reduce((total, made) => {
    const deleted = result.deleted
      .filter((object) => object.objectApiName === made.objectApiName)
      .reduce((sum, object) => sum + object.deleted, 0);
    return total + Math.min(deleted, made.count);
  }, 0);
}

/** Records still differing once a rewind read the org again, every reason and object together. */
export function residualTotal(result: Pick<RewindResult, 'residual'>): number {
  return result.residual.reduce((sum, residual) => sum + residual.count, 0);
}

/** What still differs for one reason, every object of it, and how many in all. */
export interface ResidualGroup {
  reason: RewindResidualReason;
  total: number;
  residuals: RewindResidual[];
}

/** What still differs once a rewind read the org again, by reason, only the reasons that apply. */
export function residualGroups(result: Pick<RewindResult, 'residual'>): ResidualGroup[] {
  return RESIDUAL_ORDER.flatMap((reason) => {
    const residuals = result.residual.filter(
      (residual) => residual.reason === reason && residual.count > 0,
    );
    if (residuals.length === 0) return [];
    const total = residuals.reduce((sum, residual) => sum + residual.count, 0);
    return [{ reason, total, residuals }];
  });
}

/**
 * Who changed records during the rewind, which it left as they made them,
 * every object together, the most first: by the names the preview read, by
 * Id for one it did not name.
 */
export function changedDuringRewind(
  result: Pick<RewindResult, 'residual'>,
  userNames: Readonly<Record<string, string>>,
): LastChanger[] {
  const counts = new Map<string, number>();
  for (const residual of result.residual) {
    if (residual.reason !== 'changedDuringRewind' || residual.count === 0) continue;
    const userId = residual.by ?? '';
    counts.set(userId, (counts.get(userId) ?? 0) + residual.count);
  }
  return [...counts]
    .map(([userId, count]) => {
      const name = userNames[userId];
      return name ? { userId, name, count } : { userId, count };
    })
    .sort((a, b) => b.count - a.count || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
}

/**
 * The objects whose records the org's automation set again on save once the
 * rewind had given them back: the fields to stop comparing are theirs.
 */
export function automationObjects(result: Pick<RewindResult, 'residual'>): string[] {
  return [
    ...new Set(
      result.residual
        .filter((residual) => residual.reason === 'automation' && residual.count > 0)
        .map((residual) => residual.objectApiName),
    ),
  ];
}

/**
 * How the deletions of a rewind or an undo ended, from what each object left:
 * a stopped run says so, one that left nothing succeeded, one that deleted
 * some and left others is partial, and one that left them all failed. The
 * whole run's status cannot say it: a rewind is partial for a value its
 * automation set again while every record created since went.
 */
export function deletedStatus(
  deleted: readonly ForgeUndoObjectResult[],
  status: RewindStatus,
): ForgeUndoStatus {
  if (status === 'cancelled') return 'cancelled';
  const left = deleted.reduce(
    (sum, object) =>
      sum + object.keptChanged + object.keptDependents + object.refused + (object.notVisible ?? 0),
    0,
  );
  if (left === 0) return 'success';
  const gone = deleted.reduce((sum, object) => sum + object.deleted + object.alreadyGone, 0);
  return gone > 0 ? 'partial' : 'failure';
}

/**
 * Records an undo left as someone changed them since the rewind: those it
 * would have sent back to the recycle bin, and those it would have given back
 * their values from before the rewind.
 */
export function keptChangedSinceRewind(result: Pick<RewindResult, 'deleted' | 'restored'>): number {
  return (
    result.deleted.reduce((sum, object) => sum + object.keptChanged, 0) +
    result.restored.reduce((sum, object) => sum + object.keptChanged, 0)
  );
}

/**
 * The columns of a snapshot no rewind compares: the stamps every row holds
 * and the flag of a person account (`SNAPSHOT_STAMPS` and
 * `PERSON_ACCOUNT_FLAG` in the extension's checkpointFields), which nobody
 * writes, and which a choice of fields to stop comparing would offer for
 * nothing.
 */
const NEVER_COMPARED: ReadonlySet<string> = new Set([
  'id',
  'systemmodstamp',
  'createddate',
  'createdbyid',
  'lastmodifieddate',
  'lastmodifiedbyid',
  'ispersonaccount',
]);

/** The fields of an object of a checkpoint its owner may stop comparing, as `Object.Field`. */
export function comparableFields(
  object: Pick<CheckpointObject, 'objectApiName' | 'fields'>,
): string[] {
  return object.fields
    .filter((field) => !NEVER_COMPARED.has(field.toLowerCase()))
    .map((field) => `${object.objectApiName}.${field}`);
}

/** Whether `field`, `Object.Field`, is one of `ignored` as the extension reads them: whatever the case. */
export function isIgnored(field: string, ignored: readonly string[]): boolean {
  const name = field.toLowerCase();
  return ignored.some((entry) => entry.toLowerCase() === name);
}

/**
 * The whole list of fields a checkpoint stops comparing once a choice among
 * `shown` is saved: those it already left out among the others, as they
 * were, then the fields of `shown` now ticked — `checkpoint:ignore-fields`
 * replaces the list the checkpoint held.
 */
export function ignoredAfter(
  ignored: readonly string[],
  shown: readonly string[],
  ticked: ReadonlySet<string>,
): string[] {
  const kept = ignored.filter((entry) => !isIgnored(entry, shown));
  return [...kept, ...shown.filter((field) => ticked.has(field))];
}
