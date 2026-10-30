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
  RewindSelectionAct,
  RewindSelectionPlan,
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
 * The links between files and records a rewind writes: those added since it
 * removes, those removed since it puts back, those whose sharing it gives
 * back. None for a checkpoint that holds no files.
 */
export function linkWrites(diff: Partial<Pick<RewindDiff, 'files'>>): number {
  const files = diff.files;
  return files === undefined ? 0 : files.unlink + files.relink + files.updateLinks;
}

/**
 * Whether a rewind would write anything: delete, give back, bring back or
 * make again one record at least, or bring one back for a moment, or write a
 * link between a file and a record — which the rewind does on its own, a link
 * added since to a file and a record that both stay being all that differs.
 */
export function rewindWrites(
  diff: Pick<RewindDiff, 'objects'> & Partial<Pick<RewindDiff, 'files'>>,
): boolean {
  const totals = rewindTotals(diff);
  return (
    totals.toDelete + totals.toGiveBack + totals.toBringBack + totals.toRecreate > 0 ||
    carriersTotal(diff) > 0 ||
    linkWrites(diff) > 0
  );
}

/** The object a Salesforce File is a record of, as a checkpoint that holds files holds it. */
export const FILE_OBJECT = 'ContentDocument';

/** The link between a file and a record, which a checkpoint holds with its file. */
export const FILE_LINK_OBJECT = 'ContentDocumentLink';

/**
 * The files a rewind brings back from the recycle bin, which take file
 * storage again once back: the records of {@link FILE_OBJECT} it brings back.
 */
export function filesBroughtBack(diff: Pick<RewindDiff, 'objects'>): number {
  const files = diff.objects.find((object) => object.objectApiName === FILE_OBJECT);
  return files === undefined ? 0 : rowOf(files).toBringBack;
}

/**
 * The files a rewind leaves as they are, as no record of the checkpoint links
 * to them: added since, kept; deleted since, left in the recycle bin.
 */
export function filesLeft(diff: Partial<Pick<RewindDiff, 'files'>>): number {
  const files = diff.files;
  return files === undefined ? 0 : files.outsideAdded + files.outsideDeleted;
}

/** The records a rewind makes again with new Ids, object by object: those the recycle bin no longer gives back. */
export function recreateLines(
  diff: Pick<RewindDiff, 'objects'>,
): Array<{ objectApiName: string; count: number }> {
  return diff.objects
    .map((object) => ({ objectApiName: object.objectApiName, count: object.toRecreate ?? 0 }))
    .filter((line) => line.count > 0);
}

/** The fields of an object gone from what the org shows since: deleted, hidden, or either. */
function fieldsGone(object: Pick<RewindDiff['objects'][number], 'schemaDrift'>): number {
  const drift = object.schemaDrift;
  if (drift === undefined) return 0;
  return drift.removed.length + (drift.hidden?.length ?? 0) + (drift.uncertain?.fields.length ?? 0);
}

/**
 * Whether the org holds the checkpoint's state among the objects and fields
 * it holds: nothing to write, nothing a rewind cannot take back, nothing it
 * leaves unexplained, no field deleted or hidden since — a hidden field is
 * not compared, so whether it holds its values is not known —, every object
 * read, and no file added or deleted since that no record of the checkpoint
 * links to, which a rewind leaves as it is. A record touched since that
 * holds its checkpoint values, and a field added since, whose values a
 * rewind leaves alone, do not make it differ.
 */
export function heldAsItWas(
  diff: Pick<RewindDiff, 'objects' | 'unread'> & Partial<Pick<RewindDiff, 'files'>>,
): boolean {
  return (
    diff.unread.length === 0 &&
    !rewindWrites(diff) &&
    filesLeft(diff) === 0 &&
    diff.objects.every(
      (object) =>
        object.unexplained === 0 &&
        object.cannotUndo.every((item) => item.count === 0) &&
        fieldsGone(object) === 0,
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
  'deletedByOther',
  'outOfReach',
  'convertedLead',
  'activatedContract',
  'newFileVersion',
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
 * Read object by object, the objects whose records a rewind's deletions take
 * along out of its user's sight (`RewindDiff.unseen`), each once, in the
 * order the diff first names them: what its typed confirmation says goes
 * with what it deletes, uncounted. None for a diff read with View All Data
 * and Modify All Data, or before they were told.
 */
export function unseenChildren(diff: Partial<Pick<RewindDiff, 'unseen'>>): string[] {
  return [...new Set((diff.unseen ?? []).flatMap((line) => line.children))];
}

/**
 * The objects each step of a rewind writes, in the order it writes them: it
 * brings back from the recycle bin, makes again what the bin no longer gives
 * back, gives back values, then deletes. What the org runs as it writes is
 * read for these. An object whose records come back for a moment, to be
 * deleted again (`carriersOf`), is brought back and deleted, as the rewind
 * itself lists it: its automation runs on both. A link between a file and a
 * record it removes is a delete of {@link FILE_LINK_OBJECT}, one it puts back
 * an insert, one it gives its sharing back an update, as the rewind lists
 * them: a trigger on links — a file attached updates its case — runs on each.
 */
export function rewindSteps(
  diff: Pick<RewindDiff, 'objects'> & Partial<Pick<RewindDiff, 'files'>>,
): ForgeRemovalSteps {
  const rows = diff.objects.map((object) => ({ ...rowOf(object), carriers: carriersOf(object) }));
  const links = diff.files;
  const linked = (step: string[], writes: number): string[] =>
    writes > 0 ? [...step, FILE_LINK_OBJECT] : step;
  return {
    bringBack: rows
      .filter((row) => row.toBringBack + row.carriers > 0)
      .map((row) => row.objectApiName),
    recreate: linked(
      rows.filter((row) => row.toRecreate > 0).map((row) => row.objectApiName),
      links?.relink ?? 0,
    ),
    giveBack: linked(
      rows.filter((row) => row.toGiveBack > 0).map((row) => row.objectApiName),
      links?.updateLinks ?? 0,
    ),
    delete: linked(
      rows.filter((row) => row.toDelete + row.carriers > 0).map((row) => row.objectApiName),
      links?.unlink ?? 0,
    ),
  };
}

// ─── A rewind of some objects ────────────────────────────────────────────────

/**
 * The diff of the objects `picked` alone, as the extension counts a rewind of
 * them before their plan is made (`diffOfPicked` of its rewindPlan): their
 * objects, what Undo couldn't bring back of them, what they take along out
 * of sight, and the links between files and records only when the files are
 * among them.
 */
export function pickedDiff(diff: RewindDiff, picked: readonly string[]): RewindDiff {
  const names = new Set(picked);
  const of = <E extends { objectApiName: string }>(entries: readonly E[]): E[] =>
    entries.filter((entry) => names.has(entry.objectApiName));
  const { files, ...rest } = diff;
  return {
    ...rest,
    objects: of(diff.objects),
    undoCannot: of(diff.undoCannot),
    unread: of(diff.unread),
    ...(diff.withParentDeleted ? { withParentDeleted: of(diff.withParentDeleted) } : {}),
    ...(diff.unseen ? { unseen: of(diff.unseen) } : {}),
    ...(files !== undefined && names.has(FILE_OBJECT) ? { files } : {}),
  };
}

/**
 * The diff a rewind limited to the objects of `plan` is counted by, as the
 * command line counts it (`selectionDiff` of sandforge-checkpoint): the
 * objects picked and those not picked the plan writes to, each with the
 * plan's numbers in place of the diff's, and what Undo couldn't bring back as
 * the plan says it. A class the plan acts on whole keeps what the diff says
 * of it — the field values to give back, the records that come back with a
 * parent — and one it acts on in part says only the plan's number, as the
 * diff's details would count what the plan leaves. Of an object not picked,
 * the records made since that come back with a record the rewind brings back
 * are all it deletes, and nothing else of it is said: who changed it, what it
 * cannot undo, its fields, are of a rewind that leaves it as it is.
 */
export function selectionDiff(diff: RewindDiff, plan: RewindSelectionPlan): RewindDiff {
  const picked = new Set(plan.objects);
  const actOf = new Map(plan.acts.map((act) => [act.objectApiName, act]));
  const base = pickedDiff(diff, plan.objects);
  return {
    ...base,
    objects: diff.objects
      .filter((object) => picked.has(object.objectApiName) || actOf.has(object.objectApiName))
      .map((object): RewindDiffObject => {
        const act = actOf.get(object.objectApiName);
        const row = rowOf(object);
        const deletes = act?.toDelete ?? 0;
        const gives = act?.toGiveBack ?? 0;
        const brings = act?.toBringBack ?? 0;
        if (!picked.has(object.objectApiName)) {
          return {
            objectApiName: object.objectApiName,
            toDelete: { createdSince: deletes, broughtBackSince: 0, comesBackWithParent: 0 },
            toGiveBack: { records: gives, fields: 0, clearedLookups: 0 },
            toBringBack: { inBin: brings, withParent: 0, deletedWhileTaken: 0 },
            toRecreate: act?.toRecreate ?? 0,
            cannotUndo: [],
            outside: [],
            touched: 0,
            unexplained: 0,
            lastChangedBy: {},
            notCompared: object.notCompared,
          };
        }
        return {
          ...object,
          toDelete:
            deletes === row.toDelete
              ? object.toDelete
              : { createdSince: deletes, broughtBackSince: 0, comesBackWithParent: 0 },
          toGiveBack:
            gives === row.toGiveBack
              ? object.toGiveBack
              : { records: gives, fields: 0, clearedLookups: 0 },
          toBringBack:
            brings === row.toBringBack
              ? object.toBringBack
              : {
                  inBin: brings,
                  withParent: 0,
                  deletedWhileTaken: 0,
                  ...(object.toBringBack.carriers !== undefined
                    ? { carriers: object.toBringBack.carriers }
                    : {}),
                },
          toRecreate: act?.toRecreate ?? 0,
        };
      }),
    undoCannot: [...plan.undoCannot],
  };
}

/**
 * Of the objects not picked, those a rewind limited to the plan's objects
 * deletes records of: made since, they come back with a record it brings
 * back, and leaving them would make a state that never existed.
 */
export function deletedAgain(plan: Pick<RewindSelectionPlan, 'acts'>): RewindSelectionAct[] {
  return plan.acts.filter((act) => !act.picked && act.toDelete > 0);
}

/**
 * Whether a rewind limited to the plan's objects deletes records of them: a
 * record of an object not picked that looks up one has that lookup emptied
 * by Salesforce, and is dated that second.
 */
export function deletesPicked(plan: Pick<RewindSelectionPlan, 'acts'>): boolean {
  return plan.acts.some((act) => act.picked && act.toDelete > 0);
}

/**
 * The objects a rewind limited to some of a checkpoint's objects left as they
 * are that still differ, and their records that do: none when it rewound
 * every object, or when the others match the checkpoint too.
 */
export function notRewound(result: Pick<RewindResult, 'scope'>): {
  objects: string[];
  records: number;
} {
  return result.scope?.notRewound ?? { objects: [], records: 0 };
}

// ─── What a rewind, or its undo, did ─────────────────────────────────────────

/**
 * The phases of a rewind as its run lists them, in the order it runs them:
 * it brings back from the recycle bin, makes again what the bin no longer
 * gives back, gives back values, writes the links between files and records
 * — those it puts back once both their ends are back, the others with them —
 * deletes children first, then reads the org again.
 */
export type RewindPhase = 'bringBack' | 'recreate' | 'giveBack' | 'links' | 'delete' | 'check';

/** One phase of a rewind under way, and the records of the confirmed preview it acts on. */
export interface RewindPhaseLine {
  phase: RewindPhase;
  /** Records of the preview it acts on — links, for the links; 0 for the check. */
  count: number;
}

/**
 * The phases a rewind of `diff` runs, with what each acts on. A phase the
 * preview the user confirmed gave nothing to is not listed; the check that
 * reads the org again always is.
 */
export function rewindPhases(
  diff: Pick<RewindDiff, 'objects'> & Partial<Pick<RewindDiff, 'files'>>,
): RewindPhaseLine[] {
  const totals = rewindTotals(diff);
  const acting: RewindPhaseLine[] = [
    { phase: 'bringBack', count: totals.toBringBack },
    { phase: 'recreate', count: totals.toRecreate },
    { phase: 'giveBack', count: totals.toGiveBack },
    { phase: 'links', count: linkWrites(diff) },
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
