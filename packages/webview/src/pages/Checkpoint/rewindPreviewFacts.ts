import type {
  ForgeRemovalSteps,
  RewindCannotUndoReason,
  RewindDiff,
  RewindDiffObject,
} from '@sandforge/shared';

/*
 * What the preview of a rewind says, read off the diff the extension sends.
 * Every number is the diff's own, told per object and class: these add an
 * object's classes into the preview's columns and its objects into its three
 * numbers, and count nothing the diff did not.
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
    cannotUndo: object.cannotUndo.reduce((sum, item) => sum + item.count, 0),
  };
}

/** The preview's three numbers: records to delete, to give back and to bring back, every object together. */
export function rewindTotals(
  diff: Pick<RewindDiff, 'objects'>,
): Pick<RewindRow, 'toDelete' | 'toGiveBack' | 'toBringBack'> {
  return diff.objects.map(rowOf).reduce(
    (sum, row) => ({
      toDelete: sum.toDelete + row.toDelete,
      toGiveBack: sum.toGiveBack + row.toGiveBack,
      toBringBack: sum.toBringBack + row.toBringBack,
    }),
    { toDelete: 0, toGiveBack: 0, toBringBack: 0 },
  );
}

/** Whether a rewind would write anything: delete, give back or bring back one record at least. */
export function rewindWrites(diff: Pick<RewindDiff, 'objects'>): boolean {
  const totals = rewindTotals(diff);
  return totals.toDelete + totals.toGiveBack + totals.toBringBack > 0;
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
 * brings back from the recycle bin, gives back values, then deletes. What
 * the org runs as it writes is read for these.
 */
export function rewindSteps(diff: Pick<RewindDiff, 'objects'>): ForgeRemovalSteps {
  const rows = diff.objects.map(rowOf);
  return {
    bringBack: rows.filter((row) => row.toBringBack > 0).map((row) => row.objectApiName),
    giveBack: rows.filter((row) => row.toGiveBack > 0).map((row) => row.objectApiName),
    delete: rows.filter((row) => row.toDelete > 0).map((row) => row.objectApiName),
  };
}
