import type {
  AuditLogEntry,
  DataOpsEmptyCounted,
  DataOpsEmptyLeftOut,
  DataOpsEmptyLeftOutReason,
  DataOpsEmptyPreview,
  DataOpsEmptyRefusal,
} from '@sandforge/shared';

/**
 * What the Cleanup tab's emptying reads from the answers it gets: which
 * refusal a box of the preview lifts, what a count says, and what the audit
 * trail holds of the org's emptyings. No words here: the components say them.
 */

/** The boxes of a preview that lift a refusal it names, once ticked. */
export type EmptyBox = 'acceptNoUndo' | 'acceptEmails' | 'acceptPeopleActive';

/** Which boxes are ticked. */
export type EmptyBoxes = Readonly<Record<EmptyBox, boolean>>;

/** Nothing ticked: where every preview starts. */
export const NO_BOXES: EmptyBoxes = {
  acceptNoUndo: false,
  acceptEmails: false,
  acceptPeopleActive: false,
};

/**
 * What lifts each refusal a preview may name that the page can lift: what
 * fires, which the preview lists and the confirmation accepts by being
 * answered after it (`confirm`); the emails an org delivers, by their box;
 * the records no undo brings back, by theirs; the work of the people at work
 * in the org, by the box that names each of them. Any other refusal — a run
 * of this machine writing to the org, the last emptying left open, too few
 * requests or Bulk API batches left today, more emails than the org has
 * left, a mute or a checkpoint refused, a delete for good without its
 * permission — holds the emptying whatever is ticked.
 */
export const LIFTED_BY: Readonly<Record<string, EmptyBox | 'confirm'>> = {
  AUTOMATION_NOT_ACCEPTED: 'confirm',
  EMAILS_NOT_ACCEPTED: 'acceptEmails',
  NO_UNDO: 'acceptNoUndo',
  PEOPLE_ACTIVE: 'acceptPeopleActive',
};

/** The refusals that still hold the emptying, with `boxes` ticked. */
export function holdingRefusals(
  refusals: readonly DataOpsEmptyRefusal[],
  boxes: EmptyBoxes,
): DataOpsEmptyRefusal[] {
  return refusals.filter((refusal) => {
    const lifted = LIFTED_BY[refusal.code];
    if (lifted === undefined) return true;
    if (lifted === 'confirm') return false;
    return !boxes[lifted];
  });
}

/** Whether a preview names a refusal `box` lifts: the box is offered only then. */
export function asksBox(refusals: readonly DataOpsEmptyRefusal[], box: EmptyBox): boolean {
  return refusals.some((refusal) => LIFTED_BY[refusal.code] === box);
}

/** How a count reads: a number, a bound, or none with the org's words. */
export type CountShown =
  { kind: 'exact' | 'atMost' | 'atLeast'; records: number } | { kind: 'unread'; reason: string };

/** What `counted` says, as the page shows it. */
export function countShown(counted: DataOpsEmptyCounted): CountShown {
  if (counted.records === undefined) return { kind: 'unread', reason: counted.unread ?? '' };
  if (counted.atMost) return { kind: 'atMost', records: counted.records };
  if (counted.atLeast) return { kind: 'atLeast', records: counted.records };
  return { kind: 'exact', records: counted.records };
}

/** Whether `counted` holds records, or may: a table the org would not count is never an empty one. */
export function holdsRecords(counted: DataOpsEmptyCounted): boolean {
  return counted.records === undefined || counted.records > 0;
}

/**
 * The emptying's size, as its button and its confirmation say it: the
 * records it deletes and the objects they belong to, and whether objects the
 * org would not count leave the sum short.
 */
export function emptySize(preview: Pick<DataOpsEmptyPreview, 'total'>): {
  records: number;
  objects: number;
  atLeast: boolean;
} {
  return {
    records: preview.total.records,
    objects: preview.total.objects,
    atLeast: preview.total.uncounted.length > 0,
  };
}

/** The objects a scope leaves out, by reason, each list in the order given. */
export function leftOutByReason(
  leftOut: readonly DataOpsEmptyLeftOut[],
): Array<{ reason: DataOpsEmptyLeftOutReason; objects: DataOpsEmptyLeftOut[] }> {
  const groups = new Map<DataOpsEmptyLeftOutReason, DataOpsEmptyLeftOut[]>();
  for (const out of leftOut) {
    const group = groups.get(out.reason);
    if (group) group.push(out);
    else groups.set(out.reason, [out]);
  }
  return [...groups].map(([reason, objects]) => ({ reason, objects }));
}

/**
 * The objects that cannot be picked: those the whole-org rule leaves out,
 * and none it holds. A custom setting, a file or a package's object is a
 * candidate a pick asks for, not one left out.
 */
export function notPickable(
  leftOut: readonly DataOpsEmptyLeftOut[],
  candidates: readonly string[],
): DataOpsEmptyLeftOut[] {
  const held = new Set(candidates.map((name) => name.toLowerCase()));
  return leftOut.filter((out) => !held.has(out.objectApiName.toLowerCase()));
}

/** Which act of an emptying an audit entry records. */
export type EmptyAct = 'run' | 'undo';

/** One emptying or undo of the org, as the audit trail of this machine holds it. */
export interface EmptyHistoryEntry {
  id: string;
  act: EmptyAct;
  at: string;
  outcome: string;
  /** The records it deleted, or brought back. */
  records: number;
  /** The records the org refused. */
  refused: number;
  runId?: string;
  hard: boolean;
  mode?: string;
  /** The code it was refused with, when it was. */
  code?: string;
}

/**
 * Which act of an emptying an audit entry records, or undefined for any other
 * entry: an undo under its own action, `empty_undo`; a run under
 * `cleanup_delete`, its details saying an emptying (`empty`). An undo was
 * recorded under `cleanup_delete` too before it had its action, its details
 * saying so: those entries are read as they were written.
 */
function actOf(entry: AuditLogEntry): EmptyAct | undefined {
  if (entry.action === 'empty_undo') return 'undo';
  if (entry.action !== 'cleanup_delete') return undefined;
  const act = entry.details.empty;
  return act === 'run' || act === 'undo' ? act : undefined;
}

/**
 * The org's emptyings and undos the audit trail holds, the latest first,
 * among the entries of DataOps. A run counts what it deleted, an undo what it
 * brought back (`created`).
 */
export function emptyHistoryOf(entries: readonly AuditLogEntry[]): EmptyHistoryEntry[] {
  const history: EmptyHistoryEntry[] = [];
  for (const entry of entries) {
    const act = actOf(entry);
    if (act === undefined) continue;
    const details = entry.details;
    const objects = entry.objects ?? [];
    const records = objects.reduce(
      (sum, object) => sum + (act === 'run' ? object.deleted : object.created),
      0,
    );
    const refused = objects.reduce((sum, object) => sum + object.failed, 0);
    const runId = typeof details.runId === 'string' ? details.runId : undefined;
    const code = typeof details.code === 'string' ? details.code : undefined;
    history.push({
      id: entry.id,
      act,
      at: entry.timestamp,
      outcome: entry.outcome ?? 'success',
      records,
      refused,
      ...(runId !== undefined ? { runId } : {}),
      hard: details.hard === true || details.deleteMode === 'hard',
      ...(typeof details.mode === 'string' ? { mode: details.mode } : {}),
      ...(code !== undefined ? { code } : {}),
    });
  }
  return history.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/**
 * The run the org's Undo reaches, as the history says it: the last emptying
 * that deleted something, when no undo of it came after, and it did not
 * delete for good. The extension answers for it in the end — a run whose
 * journal is gone is refused there, with why.
 */
export function undoableRun(history: readonly EmptyHistoryEntry[]): EmptyHistoryEntry | undefined {
  const lastRun = history.find((entry) => entry.act === 'run' && entry.runId !== undefined);
  if (!lastRun || lastRun.hard || lastRun.records === 0) return undefined;
  const undone = history.some(
    (entry) =>
      entry.act === 'undo' &&
      entry.runId === lastRun.runId &&
      (entry.outcome === 'success' || entry.outcome === 'partial'),
  );
  return undone ? undefined : lastRun;
}
