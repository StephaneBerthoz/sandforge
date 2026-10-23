/**
 * What one pass of a rewind sets out to do, record by record, made from two
 * diffs since the checkpoint and nothing else: the one the user confirmed —
 * or, for the second pass, the plan of the first — and the one read as the
 * pass begins. Nothing is read from the org: each diff's classes and spooled
 * reads are in its folder (`rewindDiff`), and the plan is written to a folder
 * of its own as it is made, so no plan of a large org is held whole.
 *
 * **Confirmed and still to do.** A record is acted on when the user confirmed
 * it, in a class, and the fresh diff finds it in that class still: a record
 * that no longer differs is skipped, and one that differs since the preview
 * is left, named, for another rewind to take — a busy org never keeps a
 * rewind going, and a rewind never does more than its user confirmed. A
 * record confirmed as one that comes back with its parent, to be deleted
 * again, is deleted once the fresh diff finds it back; one confirmed to be
 * brought back, and given its values once back, is given them when someone
 * brought it back since.
 *
 * **The second pass** acts on what is left of the first one's plan, and on
 * what the rewind's own users — the one it writes as, the org's Automated
 * Process — created or changed after Tr: what its automation did in answer.
 * What anyone else changed after Tr is left as they made it, and named. A
 * record whose last change after Tr is no later than what an earlier removal
 * of the rewind left on it (`removalStamps`) is the rewind's own doing,
 * whoever the org names its last modifier: an undelete moves the dates of
 * what it brings back.
 *
 * **What is deleted** is handed to the removal (`removeRunRecords`) spooled,
 * with its options: `runStartedAt` T1, the checkpoint's end, exact — a record
 * created before it that hangs from a record to delete existed at the
 * checkpoint or was read with it, and keeps its parent; `runEndedAt` one
 * second before Tr, and `includeChanged` false — the org dates a write to its
 * second, so a record dated in Tr's second may have changed after the rewind
 * began, and the give-back holds a record to the same rule. Out of it:
 *
 * - a record of an object Salesforce undeletes only with its parent (an
 *   opportunity's products), whose parent this pass deletes too, and which the
 *   removal takes along with it — created at or after T1, unchanged since Tr:
 *   it goes with its parent, and Undo brings it back with it. Sent on its own
 *   it would be deleted alone, and stay in the recycle bin when its parent
 *   comes back. One whose parent stays is deleted alone, and Undo couldn't
 *   bring it back: it is sent only once that was accepted, and left otherwise;
 * - in a checkpoint of picked objects, a record that records outside the
 *   checkpoint created since hang from, unless their deletion was accepted:
 *   the removal would take them along;
 * - a record that holds one left — left for any of these reasons, or for
 *   being new since the preview — through a field whose parent's delete takes
 *   it along: deleting it would take the record left along with it. Kept, for
 *   as far up as such records hang.
 *
 * **What is given back** — the records changed since, and the records brought
 * back, which come back with the values they had when deleted — is given back
 * before the deletions, so that a record moved under a parent created since
 * goes back to its own first. But a record that a record deleted by this pass
 * names through such a field holds values its child holds in place: seen
 * live, an opportunity's price book cannot change while it has products, and
 * its amount is theirs to add up. Given back first, those fields were refused.
 * Such a record is given back after the deletions; one that is itself the
 * child of a record this pass deletes is given back before them as well, and
 * again after. One whose children come back with it, to be deleted by the
 * second pass, is given back by the second pass, after them.
 *
 * **What is brought back** goes parents first: the checkpoint's reading order
 * is children first, and the undelete follows the order it is given.
 */

import { appendFile, readdir } from 'node:fs/promises';
import type {
  CheckpointObject,
  CheckpointTakenBy,
  ForgeRemovalSpan,
  OrgCheckpoint,
} from '@sandforge/shared';
import type { RunRemovalOptions } from '../forge/ForgeRunRemoval.js';
import { orgDateTime } from '../sync/SyncDelta.js';
import type { SyncRestoreInput } from '../sync/SyncRunRestore.js';
import { OrgReadStopped, type OrgRow } from './compositeQueries.js';
import { CHECKPOINT_FILE_MODE, makePrivateDir } from './OrgCheckpointStore.js';
import { deletedSpoolOf, liveSpoolOf, spooledRows } from './orgStreams.js';
import { classFileOf } from './rewindDiff.js';
import {
  IdSpoolWriter,
  RecordKeySet,
  SpooledRunRecords,
  type IdSpool,
} from './spooledRunRecords.js';

/** The grain the org dates a write to: its second, truncated. */
const ORG_DATE_GRAIN_MS = 1_000;

/** Ids a plan names of the records it left for one reason, beside how many there are. */
const LEFT_IDS_NAMED = 25;

/** Lines a plan's class file is written by at a time. */
const LINES_PER_WRITE = 2_000;

/** A Salesforce id, of either length. */
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** The classes of a diff a rewind acts on. */
type ActedClass =
  | 'createdSince'
  | 'broughtBackSince'
  | 'comesBackWithParent'
  | 'giveBack'
  | 'inBin'
  | 'withParent'
  | 'deletedWhileTaken';

const ACTED: readonly ActedClass[] = [
  'createdSince',
  'broughtBackSince',
  'comesBackWithParent',
  'giveBack',
  'inBin',
  'withParent',
  'deletedWhileTaken',
];

/** A class as a flag of the records confirmed in it. */
const CLASS_FLAG: Readonly<Record<ActedClass, number>> = {
  createdSince: 1,
  broughtBackSince: 2,
  comesBackWithParent: 4,
  giveBack: 8,
  inBin: 16,
  withParent: 32,
  deletedWhileTaken: 64,
};

/** Set on a record confirmed once the fresh diff found it where it was confirmed. */
const STILL_TO_DO = 1 << 15;

/**
 * For each class of the fresh diff, the classes a record was confirmed in
 * that it is acted on from. One confirmed to come back with its parent and go
 * again, found back, is a record created since: it goes. One confirmed to be
 * brought back, which comes back with the values it had when deleted and is
 * given its checkpoint values then, found back already — someone undeleted
 * it since the preview — is given them all the same.
 */
const CONFIRMED_AS: Readonly<Record<ActedClass, number>> = {
  createdSince: CLASS_FLAG.createdSince | CLASS_FLAG.comesBackWithParent,
  broughtBackSince: CLASS_FLAG.broughtBackSince,
  comesBackWithParent: CLASS_FLAG.comesBackWithParent,
  giveBack: CLASS_FLAG.giveBack | CLASS_FLAG.inBin | CLASS_FLAG.withParent,
  inBin: CLASS_FLAG.inBin,
  withParent: CLASS_FLAG.withParent,
  deletedWhileTaken: CLASS_FLAG.deletedWhileTaken,
};

/** The classes a pass deletes. */
const DELETED: ReadonlySet<ActedClass> = new Set(['createdSince', 'broughtBackSince']);

/**
 * Why a plan leaves a record that differs as it is:
 *
 * - `changedSincePreview`: the fresh diff finds it where the user did not
 *   confirm it — new since the preview, or for the second pass not in the
 *   first one's plan: another rewind takes it;
 * - `changedDuringRewind`: another user changed it after Tr: left as they
 *   made it;
 * - `outsideNotAccepted`: records outside the checkpoint created since hang
 *   from it, and their deletion was not accepted;
 * - `holdsLeft`: a record left hangs from it, which its deletion would take
 *   along;
 * - `noUndoNotAccepted`: it would be deleted on its own in an object
 *   Salesforce undeletes only with its parent, and that Undo couldn't bring it
 *   back was not accepted.
 */
export type RewindPlanLeftReason =
  | 'changedSincePreview'
  | 'changedDuringRewind'
  | 'outsideNotAccepted'
  | 'holdsLeft'
  | 'noUndoNotAccepted';

/** The reasons, each as a flag of the records left for it. */
const LEFT_FLAG: Readonly<Record<RewindPlanLeftReason, number>> = {
  changedSincePreview: 1,
  changedDuringRewind: 2,
  outsideNotAccepted: 4,
  holdsLeft: 8,
  noUndoNotAccepted: 16,
};

/** Records of one object a plan left for one reason. */
export interface RewindPlanLeft {
  objectApiName: string;
  reason: RewindPlanLeftReason;
  /** The user who changed them after Tr, for `changedDuringRewind`. */
  by?: string;
  count: number;
  /** The first of their ids: {@link count} says how many there are. */
  ids: string[];
}

/** What a plan sets out to do with one object, in counts. */
export interface RewindPlanObject {
  objectApiName: string;
  /** Records handed to the removal. */
  deleted: number;
  /** Records not sent: they go with their parent, which this pass deletes, and come back with it. */
  withParentDeleted: number;
  /** Of {@link deleted}, those Undo couldn't bring back: deleted on their own, as accepted. */
  undoCannot: number;
  /** Records the second pass deletes, once they have come back with their parent. */
  nextPassDeleted: number;
  /** Records brought back on their own. */
  broughtBack: number;
  /** Records expected back with their parent, sent nothing of their own. */
  backWithParent: number;
  /**
   * Records given back before the deletions; a record moved under a parent
   * this pass deletes is among them, and among those given back after too.
   */
  givenBackFirst: number;
  /** Records given back after the deletions, which held their values in place. */
  givenBackAfter: number;
  /** Records the second pass gives back, after the children it deletes. */
  givenBackNextPass: number;
  /** Records confirmed that no longer differ, or no longer as confirmed. */
  skipped: number;
}

/** What one pass of a rewind is made from. */
export interface RewindPlanInput {
  checkpoint: Pick<OrgCheckpoint, 'objects' | 'takenAt' | 'scope'>;
  /** The first pass, or the second, which acts on what the first left. */
  pass: 1 | 2;
  /**
   * What was confirmed, as a diff's folder holds it: the preview the user
   * confirmed (`previews/<previewId>/`) — the fresh diff's own folder, when
   * the command line rewinds from the diff it just showed — or, for the
   * second pass, the folder of the first one's plan.
   */
  confirmedDir: string;
  /** The folder of the diff read as this pass began: its classes and its spooled reads. */
  freshDir: string;
  /** Tr: when the rewind began reading, on the org's clock — the first pass's fresh diff. */
  readAt: string;
  /** The users whose writes are the rewind's own: see {@link rewindWriters}. */
  ownWriters: readonly string[];
  /** Records outside a checkpoint of picked objects may go with their parent. */
  acceptOutside: boolean;
  /** Records Undo couldn't bring back may be deleted. */
  acceptNoUndo: boolean;
  /** What earlier removals of the rewind left on records, by id: see `RunRemovalOptions.removalStamps`. */
  removalStamps?: Readonly<Record<string, string>>;
  /** When earlier removals of the rewind ran, and as whom: see `RunRemovalOptions.removalSpans`. */
  removalSpans?: readonly ForgeRemovalSpan[];
  /** Where the plan is written: a folder of its own, made when missing, empty when not. */
  dir: string;
  /** Stops it between two objects. */
  signal?: AbortSignal;
}

/** One pass of a rewind, as its bricks take it. */
export interface RewindPlan {
  pass: 1 | 2;
  /** Its folder: its classes, as the second pass reads what the first set out to do. */
  dir: string;
  /** What the removal deletes, children first as the checkpoint read them. */
  deletes: SpooledRunRecords;
  /** The removal's options, as `removeRunRecords` takes them. */
  removal: Required<Pick<RunRemovalOptions, 'runStartedAt' | 'runEndedAt' | 'includeChanged'>> &
    Pick<RunRemovalOptions, 'removalStamps' | 'removalSpans'>;
  /** What is brought back from the recycle bin, parents first. */
  bringBack: IdSpool;
  /** What is given its checkpoint values back, a chunk at a time. */
  giveBack: {
    beforeDeletes: IdSpool;
    afterDeletes: IdSpool;
    /** Per object given back after, the objects whose deletes its records waited for. */
    heldBy: Array<{ objectApiName: string; by: string[] }>;
  };
  /**
   * The give-back's options, as `restoreOverwrites` takes them; the stamps
   * are those known as the plan was made, to which the pass adds what its
   * undelete left.
   */
  restore: Required<Pick<SyncRestoreInput, 'changedAfter' | 'ownWriters' | 'includeChanged'>> &
    Pick<SyncRestoreInput, 'stamps'>;
  /** What it does with each object it does anything with, in the checkpoint's reading order. */
  objects: RewindPlanObject[];
  /** Records deleted that Undo couldn't bring back, per object. */
  undoCannot: Array<{ objectApiName: string; count: number }>;
  /** What it leaves that differs, per object and reason. */
  left: RewindPlanLeft[];
}

/**
 * The users whose writes are a rewind's own: the one it writes as, and the
 * org's Automated Process, whose writes answer its own. Where people sign in
 * as the user SandForge connects as, their changes cannot be told from it.
 */
export function rewindWriters(
  takenBy: Pick<CheckpointTakenBy, 'automatedProcessUserId'>,
  userId: string,
): string[] {
  return [userId, takenBy.automatedProcessUserId].filter(
    (id): id is string => typeof id === 'string' && id !== '',
  );
}

/**
 * Why the records of `objectApiName` given back after the deletions are said
 * to have waited, beside the org's words when one is still refused.
 */
export function heldInPlaceReason(objectApiName: string, by: readonly string[]): string {
  const children = by.length > 0 ? by.join(', ') : 'child';
  return (
    `${objectApiName}: given back once the ${children} records hanging from it that the rewind ` +
    'deletes were gone, as those records held some of its values in place'
  );
}

// ─── Reading and writing a diff's files ──────────────────────────────────────

/** A date as the org gives it, `+0000` or `Z`, in milliseconds; NaN for anything else. */
function dateMs(value: unknown): number {
  const at = orgDateTime(value);
  return at === null ? Number.NaN : Date.parse(at);
}

/** The id a line of a diff's file names. */
function idOf(row: OrgRow, file: string): string {
  const id = row.Id;
  if (typeof id !== 'string' || !RECORD_ID.test(id)) {
    throw new Error(`A line of ${file} names no record: the diff it was read from is not whole.`);
  }
  return id;
}

/** The rows of a diff's file, or none when it holds none: a class nobody fell into has no file. */
async function* rowsOf(file: string): AsyncGenerator<OrgRow> {
  try {
    for await (const row of spooledRows(file)) yield row;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** The lines of one class of one object, written to the plan's folder as the preview writes them. */
class ClassLines {
  private lines: string[] = [];
  private written = false;

  constructor(private readonly file: string) {}

  async add(line: OrgRow): Promise<void> {
    this.lines.push(`${JSON.stringify(line)}\n`);
    if (this.lines.length >= LINES_PER_WRITE) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.lines.length === 0) return;
    const text = this.lines.join('');
    this.lines = [];
    await appendFile(this.file, text, {
      encoding: 'utf8',
      mode: CHECKPOINT_FILE_MODE,
      flag: this.written ? 'a' : 'w',
    });
    this.written = true;
  }
}

/** The records of an object left for each reason, counted, the first of them named. */
class LeftTally {
  private readonly entries = new Map<string, RewindPlanLeft>();

  add(objectApiName: string, reason: RewindPlanLeftReason, id: string, by?: string): void {
    const at = `${objectApiName}\u0000${reason}\u0000${by ?? ''}`;
    let entry = this.entries.get(at);
    if (!entry) {
      entry = { objectApiName, reason, ...(by !== undefined ? { by } : {}), count: 0, ids: [] };
      this.entries.set(at, entry);
    }
    entry.count++;
    if (entry.ids.length < LEFT_IDS_NAMED) entry.ids.push(id);
  }

  all(order: ReadonlyMap<string, number>): RewindPlanLeft[] {
    return [...this.entries.values()].sort(
      (a, b) =>
        (order.get(a.objectApiName) ?? 0) - (order.get(b.objectApiName) ?? 0) ||
        (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0) ||
        ((a.by ?? '') < (b.by ?? '') ? -1 : (a.by ?? '') > (b.by ?? '') ? 1 : 0),
    );
  }
}

/** The counts of an object's plan, as they fill. */
function emptyCounts(objectApiName: string): RewindPlanObject {
  return {
    objectApiName,
    deleted: 0,
    withParentDeleted: 0,
    undoCannot: 0,
    nextPassDeleted: 0,
    broughtBack: 0,
    backWithParent: 0,
    givenBackFirst: 0,
    givenBackAfter: 0,
    givenBackNextPass: 0,
    skipped: 0,
  };
}

/** Whether a plan does anything with an object, or skips something of it. */
function planned(counts: RewindPlanObject): boolean {
  return Object.entries(counts).some(([key, value]) => key !== 'objectApiName' && value !== 0);
}

/**
 * Who changed records of an object after Tr, read from the fresh diff's
 * reads: the rewind's own users, or someone else, by index into `users`.
 */
interface ChangedAfter {
  own: RecordKeySet;
  /** Flags: the other user's place in `users`, plus one. */
  other: RecordKeySet;
}

// ─── The plan ────────────────────────────────────────────────────────────────

/**
 * Make one pass of a rewind: see the module's comment.
 *
 * @throws {OrgReadStopped} When it was stopped.
 * @throws When its folder is not empty, a date it is given is not one, or a
 *   diff's files are not whole.
 */
export async function rewindPlan(input: RewindPlanInput): Promise<RewindPlan> {
  const { checkpoint, pass, confirmedDir, freshDir, dir, signal } = input;
  const t1 = Date.parse(checkpoint.takenAt);
  if (!Number.isFinite(t1)) throw new Error(`Not a date: ${checkpoint.takenAt}`);
  const tr = Date.parse(input.readAt);
  if (!Number.isFinite(tr)) throw new Error(`Not a date: ${input.readAt}`);
  /** What the org dates no later than this was made before Tr. */
  const before = tr - ORG_DATE_GRAIN_MS;
  await makePrivateDir(dir);
  if ((await readdir(dir)).length > 0) {
    throw new Error(`A rewind's plan is written to a folder of its own: ${dir} is not empty.`);
  }
  const stopped = (): void => {
    if (signal?.aborted) throw new OrgReadStopped();
  };

  const objects = [...checkpoint.objects].sort((a, b) => a.readOrder - b.readOrder);
  const order = new Map(objects.map(({ objectApiName }, at) => [objectApiName, at]));
  const counts = new Map(
    objects.map(({ objectApiName }) => [objectApiName, emptyCounts(objectApiName)]),
  );
  const countsOf = (objectApiName: string): RewindPlanObject =>
    counts.get(objectApiName) ?? emptyCounts(objectApiName);
  const owners = new Set(input.ownWriters.map((id) => id.slice(0, 15)));
  const stampOf = new Map(
    Object.entries(input.removalStamps ?? {}).map(([id, at]) => [id.slice(0, 15), dateMs(at)]),
  );
  /** Whether a row's last change after Tr is the rewind's own: by its users, or no later than its stamp. */
  const ownChange = (row: OrgRow): boolean => isOwnChange(row, before, owners, stampOf);
  const cascadeOf = (object: CheckpointObject, row: OrgRow): string[] =>
    object.cascadeParents.flatMap((field) => {
      const parent = row[field];
      return typeof parent === 'string' && RECORD_ID.test(parent) ? [parent] : [];
    });
  const left = new LeftTally();

  /** Every record this pass would delete, before what it keeps out. */
  const toDelete = new RecordKeySet();
  /** Records kept out of the deletion, or left, each flagged with why. */
  const kept = new RecordKeySet();
  /** Records to come back with their parent, and be deleted by the second pass. */
  const comesBack = new RecordKeySet();
  const users: string[] = [];

  // ─── Confirmed ∩ fresh, class by class, an object at a time ───
  for (const object of objects) {
    stopped();
    const name = object.objectApiName;
    const tally = countsOf(name);
    const confirmed = new RecordKeySet();
    for (const cls of ACTED) {
      const file = classFileOf(confirmedDir, name, cls);
      for await (const row of rowsOf(file)) confirmed.add(idOf(row, file), CLASS_FLAG[cls]);
    }
    const after =
      pass === 2 ? await changedAfterOf(freshDir, name, before, owners, stampOf, users) : undefined;

    const lines = new Map<ActedClass, ClassLines>();
    const lineOf = (cls: ActedClass): ClassLines => {
      let held = lines.get(cls);
      if (!held) {
        held = new ClassLines(classFileOf(dir, name, cls));
        lines.set(cls, held);
      }
      return held;
    };
    for (const cls of ACTED) {
      const file = classFileOf(freshDir, name, cls);
      for await (const row of rowsOf(file)) {
        const id = idOf(row, file);
        const isConfirmed = (confirmed.flagsOf(id) & CONFIRMED_AS[cls]) !== 0;
        if (isConfirmed) confirmed.add(id, STILL_TO_DO);
        const other = after?.other.flagsOf(id) ?? 0;
        if (other > 0 || !(isConfirmed || after?.own.has(id) === true)) {
          const reason = other > 0 ? 'changedDuringRewind' : 'changedSincePreview';
          left.add(name, reason, id, other > 0 ? users[other - 1] : undefined);
          if (DELETED.has(cls)) kept.add(id, LEFT_FLAG[reason]);
          continue;
        }
        await lineOf(cls).add(cls === 'giveBack' ? row : { Id: id });
        if (DELETED.has(cls)) toDelete.add(id);
        else if (cls === 'comesBackWithParent') {
          comesBack.add(id);
          tally.nextPassDeleted++;
        } else if (cls === 'inBin' || cls === 'deletedWhileTaken') tally.broughtBack++;
        else if (cls === 'withParent') tally.backWithParent++;
        // What comes back from the bin comes back with the values it had
        // when deleted: given back once it is back.
        if (cls === 'inBin' || cls === 'withParent') await lineOf('giveBack').add({ Id: id });
      }
    }
    for (const held of lines.values()) await held.flush();
    tally.skipped = confirmed.count((flags) => (flags & STILL_TO_DO) === 0);
  }

  // ─── What is kept out of the deletion ───
  if (checkpoint.scope.mode === 'picked' && !input.acceptOutside) {
    for (const object of objects) {
      const file = classFileOf(freshDir, object.objectApiName, 'outsideParents');
      for await (const row of rowsOf(file)) {
        const id = idOf(row, file);
        if (!toDelete.has(id) || kept.has(id)) continue;
        kept.add(id, LEFT_FLAG.outsideNotAccepted);
        left.add(object.objectApiName, 'outsideNotAccepted', id);
      }
    }
  }
  // A record kept holds its parent, and that one its own, as far up as they go.
  const holding: Array<{ object: CheckpointObject; file: string }> = objects.map((object) => ({
    object,
    file: liveSpoolOf(freshDir, object.objectApiName),
  }));
  for (let grew = kept.size > 0; grew;) {
    stopped();
    grew = false;
    for (const { object, file } of holding) {
      for await (const row of rowsOf(file)) {
        if (!kept.has(row.Id)) continue;
        for (const parent of cascadeOf(object, row)) {
          if (!toDelete.has(parent) || kept.has(parent)) continue;
          kept.add(parent, LEFT_FLAG.holdsLeft);
          grew = true;
        }
      }
    }
  }
  for (const { object, file } of holding) {
    for await (const row of rowsOf(file)) {
      if (toDelete.has(row.Id) && kept.flagsOf(row.Id) === LEFT_FLAG.holdsLeft) {
        left.add(object.objectApiName, 'holdsLeft', idOf(row, file));
      }
    }
  }

  // ─── What goes with its parent, and what Undo couldn't bring back ───
  const goesAlong = new RecordKeySet();
  const deleted = (id: string): boolean => toDelete.has(id) && !kept.has(id);
  const parentsFirst = [...objects].reverse();
  for (const object of parentsFirst) {
    if (object.undeletable) continue;
    stopped();
    const name = object.objectApiName;
    const file = liveSpoolOf(freshDir, name);
    for await (const row of rowsOf(file)) {
      const id = typeof row.Id === 'string' ? row.Id : '';
      if (!deleted(id)) continue;
      // As the removal tells a record that goes with its parent from one
      // that keeps it: created since T1, unchanged since Tr.
      const along =
        cascadeOf(object, row).some(deleted) &&
        dateMs(row.CreatedDate) >= t1 &&
        dateMs(row.LastModifiedDate) <= before;
      if (along) {
        goesAlong.add(id);
        countsOf(name).withParentDeleted++;
      } else if (input.acceptNoUndo) {
        countsOf(name).undoCannot++;
      } else {
        kept.add(id, LEFT_FLAG.noUndoNotAccepted);
        left.add(name, 'noUndoNotAccepted', id);
      }
    }
  }

  // ─── What the removal is handed, and the records its deletes hold ───
  const writer = new IdSpoolWriter(`${dir}/deletes`);
  const stamps: Record<string, string> = {};
  /** The parents of what this pass deletes; flags: the deleting object's place, plus one. */
  const holdersNow = new RecordKeySet();
  let found = 0;
  for (const object of objects) {
    stopped();
    const name = object.objectApiName;
    const file = liveSpoolOf(freshDir, name);
    let sent = 0;
    for await (const row of rowsOf(file)) {
      const id = typeof row.Id === 'string' ? row.Id : '';
      if (!toDelete.has(id)) continue;
      found++;
      if (kept.has(id)) continue;
      for (const parent of cascadeOf(object, row)) {
        if (!holdersNow.has(parent)) holdersNow.add(parent, (order.get(name) ?? 0) + 1);
      }
      if (goesAlong.has(id)) continue;
      await writer.add(name, id);
      sent++;
      // What the rewind's own users changed after Tr is its own doing: the
      // removal is told, as it is told what an earlier removal left.
      if (pass === 2 && ownChange(row) && typeof row.LastModifiedDate === 'string') {
        stamps[id] = row.LastModifiedDate;
      }
    }
    countsOf(name).deleted = sent;
  }
  // Every record a class names to delete is in the reads it was told from:
  // one missing would be neither sent nor kept, and said nowhere.
  if (found !== toDelete.size) {
    throw new Error("The fresh diff's reads do not hold every record its classes name to delete.");
  }
  const deletes = await SpooledRunRecords.of(writer);

  // ─── The parents of what the second pass deletes ───
  const holdersNext = new RecordKeySet();
  if (pass === 1 && comesBack.size > 0) {
    for (const object of objects) {
      for await (const row of rowsOf(deletedSpoolOf(freshDir, object.objectApiName))) {
        if (!comesBack.has(row.Id)) continue;
        for (const parent of cascadeOf(object, row)) holdersNext.add(parent);
      }
    }
  }

  // ─── What is given back before the deletions, and after ───
  const first = new IdSpoolWriter(`${dir}/giveBackFirst`);
  const last = new IdSpoolWriter(`${dir}/giveBackAfter`);
  const heldBy: Array<{ objectApiName: string; by: string[] }> = [];
  for (const object of objects) {
    stopped();
    const name = object.objectApiName;
    const file = classFileOf(dir, name, 'giveBack');
    // A record that waits for its children, but is itself a child of a
    // record this pass deletes, is given back before as well, and again after.
    let waits = false;
    for await (const row of rowsOf(file)) {
      if (holdersNow.has(row.Id)) {
        waits = true;
        break;
      }
    }
    const childOfDeleted = new RecordKeySet();
    if (waits) {
      for await (const row of rowsOf(liveSpoolOf(freshDir, name))) {
        if (holdersNow.has(row.Id) && cascadeOf(object, row).some(deleted)) {
          childOfDeleted.add(String(row.Id));
        }
      }
    }
    const tally = countsOf(name);
    const by = new Set<string>();
    for await (const row of rowsOf(file)) {
      const id = idOf(row, file);
      const holder = holdersNow.flagsOf(id);
      const child = childOfDeleted.has(id);
      if (holder > 0) {
        await last.add(name, id);
        tally.givenBackAfter++;
        by.add(objects[holder - 1].objectApiName);
        if (!child) continue;
      } else if (!child && holdersNext.has(id)) {
        tally.givenBackNextPass++;
        continue;
      }
      await first.add(name, id);
      tally.givenBackFirst++;
    }
    if (by.size > 0) heldBy.push({ objectApiName: name, by: [...by] });
  }

  // ─── What is brought back, parents first ───
  const back = new IdSpoolWriter(`${dir}/bringBack`);
  for (const object of parentsFirst) {
    for (const cls of ['inBin', 'deletedWhileTaken'] as const) {
      const file = classFileOf(dir, object.objectApiName, cls);
      for await (const row of rowsOf(file)) await back.add(object.objectApiName, idOf(row, file));
    }
  }

  const removalStamps = { ...input.removalStamps, ...stamps };
  const hasStamps = Object.keys(removalStamps).length > 0;
  const planObjects = objects.map(({ objectApiName }) => countsOf(objectApiName)).filter(planned);
  return {
    pass,
    dir,
    deletes,
    removal: {
      runStartedAt: new Date(t1),
      runEndedAt: new Date(before),
      includeChanged: false,
      ...(hasStamps ? { removalStamps } : {}),
      ...(input.removalSpans && input.removalSpans.length > 0
        ? { removalSpans: [...input.removalSpans] }
        : {}),
    },
    bringBack: await back.finish(),
    giveBack: { beforeDeletes: await first.finish(), afterDeletes: await last.finish(), heldBy },
    restore: {
      changedAfter: input.readAt,
      ownWriters: [...input.ownWriters],
      includeChanged: false,
      ...(hasStamps ? { stamps: removalStamps } : {}),
    },
    objects: planObjects,
    undoCannot: planObjects
      .filter((object) => object.undoCannot > 0)
      .map(({ objectApiName, undoCannot }) => ({ objectApiName, count: undoCannot })),
    left: left.all(order),
  };
}

/**
 * Whether `row` was last changed after Tr — later than `before`, Tr's second
 * and on — by the rewind itself: as one of `owners`, or no later than what an
 * earlier removal of the rewind left on it.
 */
function isOwnChange(
  row: OrgRow,
  before: number,
  owners: ReadonlySet<string>,
  stampOf: ReadonlyMap<string, number>,
): boolean {
  const modified = dateMs(row.LastModifiedDate);
  if (!(modified > before)) return false;
  const id = typeof row.Id === 'string' ? row.Id : '';
  const by = typeof row.LastModifiedById === 'string' ? row.LastModifiedById : '';
  return modified <= (stampOf.get(id.slice(0, 15)) ?? Number.NaN) || owners.has(by.slice(0, 15));
}

/**
 * Who changed each record of an object after Tr, as the fresh diff read it,
 * live or deleted: the rewind's own users, or another, whose id is added to
 * `users`. A change no later than what an earlier removal of the rewind left
 * on the record is the rewind's own, whoever the org names.
 */
async function changedAfterOf(
  freshDir: string,
  objectApiName: string,
  before: number,
  owners: ReadonlySet<string>,
  stampOf: ReadonlyMap<string, number>,
  users: string[],
): Promise<ChangedAfter> {
  const changed: ChangedAfter = { own: new RecordKeySet(), other: new RecordKeySet() };
  for (const file of [
    liveSpoolOf(freshDir, objectApiName),
    deletedSpoolOf(freshDir, objectApiName),
  ]) {
    for await (const row of rowsOf(file)) {
      const modified = dateMs(row.LastModifiedDate);
      if (!(modified > before)) continue;
      const id = idOf(row, file);
      if (isOwnChange(row, before, owners, stampOf)) {
        changed.own.add(id);
        continue;
      }
      const by = typeof row.LastModifiedById === 'string' ? row.LastModifiedById : '';
      let at = users.indexOf(by);
      if (at < 0) {
        users.push(by);
        at = users.length - 1;
      }
      changed.other.add(id, at + 1);
    }
  }
  return changed;
}
