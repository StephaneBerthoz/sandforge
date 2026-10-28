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
 * again, is deleted once the fresh diff finds it back, and so is a carrier —
 * a record the checkpoint does not hold, brought back for a moment with the
 * records of it that its delete took along; one confirmed to be brought back,
 * and given its values once back, is given them when someone brought it back
 * since.
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
 * - a record whose parent this pass deletes too, and which the removal takes
 *   along with it — created at or after T1, unchanged since Tr: it goes with
 *   its parent, and Undo brings it back with it. Sent on its own it would be
 *   deleted alone, children going first, and a record deleted alone whose
 *   parent is deleted after it stays in the recycle bin for good: its
 *   undelete answers that it is not there, with its parent, after it or
 *   before it (a case under an account, live). Of an object Salesforce
 *   undeletes only with its parent (an opportunity's products), one whose
 *   parent stays is deleted alone, and Undo couldn't bring it back: it is
 *   sent only once that was accepted, and left otherwise. So is one, of any
 *   object, sent alone before a record it points at that this pass deletes
 *   too: one the removal would not take along with its parent — made while
 *   the checkpoint was taken, brought back since — and one whose lookup
 *   restricts that record's delete, which the org refuses while it lives (a
 *   case's account, live). Each such record is said beside that record
 *   (`beforeParent`), for the journal;
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
 *
 * **A row of a custom setting** is brought back, and given its values, only
 * once no live row holds its key: a hierarchy's owner — the org, a profile, a
 * user — or a list's name. Salesforce refuses the undelete of a hierarchy's
 * row whose owner another row holds (`DUPLICATE_VALUE`), but takes a list's
 * row back over another of the same name, and the list then holds two rows
 * of one name (P-C2), of which Apex reads one. So a row whose key a live row
 * made, changed or brought back since holds — read from the fresh diff, as
 * the row came to the bin and as that row is now — waits: this pass deletes
 * that row, or gives it its own key back, and the second brings the row
 * back, the key free; the rewind deletes the duplicate first rather than
 * give the live row the checkpoint's values, so the row keeps its Id and a
 * fresh preview finds nothing to rewind. A row still waiting after the
 * second pass is left in the bin, named (`keyTaken`), the row holding its
 * key left as someone made it. A row made again is not held back: the org
 * refuses an insert of a key taken, for both kinds (`DUPLICATE_VALUE`, and
 * `FIELD_INTEGRITY_EXCEPTION` for a list), and the second pass makes it.
 *
 * **What is made again** — records the recycle bin no longer gives back,
 * which come back with new Ids — goes parents first too, once what is brought
 * back is back: a record made again names its parent by the Id the parent has
 * then. It is made only once that its Ids are new was accepted, and left
 * otherwise (`recreateNotAccepted`).
 *
 * **The links between files and records**, of a checkpoint that holds files,
 * are told apart by the diffs (`fileLinksDiff`), each by its file and its
 * record — a link inserted again has a new Id — and planned as records are:
 * one confirmed that the fresh diff finds in the same class is acted on, one
 * it finds otherwise is left (`changedSincePreview`). A link added since is
 * removed, one of the checkpoint removed since inserted again, one whose
 * sharing changed given it back; never one whose file or record this pass
 * deletes, which goes with it. The second pass inserts again too a link the
 * first expected back with a file or a record it brought back or made again,
 * which the org did not bring back with it. A file a checkpoint of picked
 * objects keeps for what it is shared with outside it has its links to the
 * records it holds removed (`unlinkFrom`), the file left where it is. A
 * checkpoint taken before files were held has no link to plan.
 */

import { appendFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  sanitizeSoqlObjectName,
  type CheckpointObject,
  type CheckpointTakenBy,
  type ForgeRemovalSpan,
  type OrgCheckpoint,
} from '@sandforge/shared';
import type { RunRemovalOptions } from '../forge/ForgeRunRemoval.js';
import { orgDateTime } from '../sync/SyncDelta.js';
import type { SyncRestoreInput } from '../sync/SyncRunRestore.js';
import { OrgReadStopped, type OrgRow } from './compositeQueries.js';
import {
  fileLinkChangedLineSchema,
  fileLinkClassFileOf,
  fileLinkLineSchema,
  type FileLinkClass,
} from './checkpointFiles.js';
import { FILE_LINK_OBJECT, FILE_OBJECT, customSettingKeyOf } from './checkpointScope.js';
import { CHECKPOINT_FILE_MODE, makePrivateDir } from './OrgCheckpointStore.js';
import { deletedSpoolOf, liveSpoolOf, spooledRows } from './orgStreams.js';
import { classFileOf } from './rewindDiff.js';
import type { Recreated } from './snapshotIndex.js';
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
  | 'deletedWhileTaken'
  | 'toRecreate'
  | 'carrier';

const ACTED: readonly ActedClass[] = [
  'createdSince',
  'broughtBackSince',
  'comesBackWithParent',
  'giveBack',
  'inBin',
  'withParent',
  'deletedWhileTaken',
  'toRecreate',
  'carrier',
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
  toRecreate: 128,
  carrier: 256,
};

/** Set on a record confirmed once the fresh diff found it where it was confirmed. */
const STILL_TO_DO = 1 << 15;

/**
 * For each class of the fresh diff, the classes a record was confirmed in
 * that it is acted on from. One confirmed to come back with its parent and go
 * again, found back, is a record created since: it goes. So is a carrier
 * found back, brought back for a moment by the first pass, or by a rewind
 * stopped before its second: created since, or in the recycle bin at the
 * checkpoint and brought back since. One confirmed to be brought back, which
 * comes back with the values it had when deleted and is given its checkpoint
 * values then, found back already — someone undeleted it since the preview —
 * is given them all the same.
 */
const CONFIRMED_AS: Readonly<Record<ActedClass, number>> = {
  createdSince: CLASS_FLAG.createdSince | CLASS_FLAG.comesBackWithParent | CLASS_FLAG.carrier,
  broughtBackSince: CLASS_FLAG.broughtBackSince | CLASS_FLAG.carrier,
  comesBackWithParent: CLASS_FLAG.comesBackWithParent,
  giveBack: CLASS_FLAG.giveBack | CLASS_FLAG.inBin | CLASS_FLAG.withParent,
  inBin: CLASS_FLAG.inBin,
  withParent: CLASS_FLAG.withParent,
  deletedWhileTaken: CLASS_FLAG.deletedWhileTaken,
  toRecreate: CLASS_FLAG.toRecreate,
  carrier: CLASS_FLAG.carrier,
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
 *   back was not accepted;
 * - `beforeParentNotAccepted`: it would be deleted on its own before a record
 *   it points at that the pass deletes next, which leaves it in the recycle
 *   bin for good, and that Undo couldn't bring it back was not accepted;
 * - `recreateNotAccepted`: the recycle bin no longer gives it back, it would
 *   be made again with a new Id, and that its Id is new was not accepted;
 * - `keyTaken`: a row of a custom setting to bring back, whose owner or name
 *   a live row made, changed or brought back since holds: brought back by the
 *   next pass, once that row is gone, and left in the bin by the last.
 */
export type RewindPlanLeftReason =
  | 'changedSincePreview'
  | 'changedDuringRewind'
  | 'outsideNotAccepted'
  | 'holdsLeft'
  | 'noUndoNotAccepted'
  | 'beforeParentNotAccepted'
  | 'recreateNotAccepted'
  | 'keyTaken';

/** The reasons, each as a flag of the records left for it. */
const LEFT_FLAG: Readonly<Record<RewindPlanLeftReason, number>> = {
  changedSincePreview: 1,
  changedDuringRewind: 2,
  outsideNotAccepted: 4,
  holdsLeft: 8,
  noUndoNotAccepted: 16,
  beforeParentNotAccepted: 32,
  recreateNotAccepted: 64,
  keyTaken: 128,
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
  /**
   * Records the second pass deletes, once they have come back with their
   * parent, or brought back for a moment as carriers.
   */
  nextPassDeleted: number;
  /**
   * Records the checkpoint does not hold brought back for a moment, with the
   * records of it they took along, and deleted again by the second pass:
   * among {@link nextPassDeleted}. Absent when there is none.
   */
  carriers?: number;
  /** Records brought back on their own. */
  broughtBack: number;
  /** Records expected back with their parent, sent nothing of their own. */
  backWithParent: number;
  /** Records the recycle bin no longer gives back, made again with new Ids. */
  recreated: number;
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
  /**
   * Rows of a custom setting not brought back, a live row holding their
   * owner or name: the next pass brings them back once it is gone. Absent
   * when there is none.
   */
  keyTaken?: number;
}

/** What one pass of a rewind is made from. */
export interface RewindPlanInput {
  checkpoint: Pick<OrgCheckpoint, 'objects' | 'takenAt' | 'scope' | 'files'>;
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
  /** Records the recycle bin no longer gives back may be made again, with new Ids. */
  acceptRecreate: boolean;
  /** What earlier removals of the rewind left on records, by id: see `RunRemovalOptions.removalStamps`. */
  removalStamps?: Readonly<Record<string, string>>;
  /** When earlier removals of the rewind ran, and as whom: see `RunRemovalOptions.removalSpans`. */
  removalSpans?: readonly ForgeRemovalSpan[];
  /**
   * The records made again so far, by the keys the checkpoint holds them by:
   * a link of one, which the diff names by its new Id, is one the first pass
   * expected back with it.
   */
  recreated?: Pick<Recreated, 'originalOf'>;
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
  /**
   * Of {@link bringBack}, the carriers: brought back for a moment with what
   * they took along, then deleted again by the second pass.
   */
  carriers: RecordKeySet;
  /**
   * The records the removal is not handed as they go with a parent it
   * deletes: told so as it reads what hangs from that parent
   * (`RunRemovalOptions.goesWithParent`), whose dates may be those an
   * earlier write of the rewind left.
   */
  goesAlong: RecordKeySet;
  /** What is made again with new Ids, parents first, by the Ids the records had. */
  recreate: IdSpool;
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
  /**
   * Of those, per object, the records it deletes on their own before a record
   * they point at that it deletes too: a file of one line a record, its id
   * and the ids of those records (`parents`), which the journal names.
   */
  beforeParent: Array<{ objectApiName: string; count: number; file: string }>;
  /** What it leaves that differs, per object and reason. */
  left: RewindPlanLeft[];
  /** What it does to the links between files and records: see {@link RewindPlanLinks}. */
  links: RewindPlanLinks;
}

/** Links of one class a pass writes, in a file of the plan's folder, one a line. */
export interface PlannedLinks {
  file: string;
  count: number;
}

/**
 * What a pass does to the links between files and records, each class's
 * lines written to the plan's folder as the diff writes them
 * (`fileLinkClassFileOf`), so a second pass reads them as what the first set
 * out to do.
 */
export interface RewindPlanLinks {
  /** Links added since between a file and a record that both stay: removed. */
  unlink: PlannedLinks;
  /** Links of the checkpoint removed since: inserted again, each under a new Id. */
  relink: PlannedLinks;
  /** Links whose sharing changed since: given the checkpoint's back. */
  share: PlannedLinks;
  /**
   * Files kept for what they are shared with outside a checkpoint of picked
   * objects, whose deletion was not accepted: their links to the records the
   * checkpoint holds are removed, the files left.
   */
  unlinkFrom: IdSpool;
}

/** The classes of links a pass acts on, and the plan's name for each. */
const LINK_CLASSES: ReadonlyArray<{ cls: FileLinkClass; as: 'unlink' | 'relink' | 'share' }> = [
  { cls: 'linkAdded', as: 'unlink' },
  { cls: 'linkRemoved', as: 'relink' },
  { cls: 'linkChanged', as: 'share' },
];

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

/** Where a plan names the records it deletes before a record they point at, of one object. */
function beforeParentFileOf(dir: string, objectApiName: string): string {
  return join(dir, `${sanitizeSoqlObjectName(objectApiName)}.beforeParent.ndjson`);
}

/** The lines of one class of one object, written to the plan's folder as the preview writes them. */
class ClassLines {
  private lines: string[] = [];
  private written = false;

  constructor(readonly file: string) {}

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

/**
 * A custom setting's key, as its rows are told apart by it: an owner by its
 * id's first fifteen characters, a name as it is, case and all.
 */
function settingKeyOf(field: string, value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  return field === 'SetupOwnerId' && RECORD_ID.test(value) ? value.slice(0, 15) : value;
}

/**
 * The rows of a custom setting a pass does not bring back, by id: those to
 * bring back, of `classes` in the plan's folder, whose key — as the row came
 * to the recycle bin, which the undelete brings it back with — a live row
 * holds that the fresh diff read stamped since. A row live and unchanged
 * since the checkpoint holds the key it held then, beside the row to bring
 * back: the checkpoint held both, as they are put back.
 */
async function keyTakenOf(
  object: CheckpointObject,
  freshDir: string,
  dir: string,
  classes: readonly ActedClass[],
): Promise<RecordKeySet> {
  const waiting = new RecordKeySet();
  if (object.customSetting === undefined) return waiting;
  const wanted = customSettingKeyOf(object.customSetting).toLowerCase();
  const field = object.fields.find((name) => name.toLowerCase() === wanted);
  if (field === undefined) return waiting;
  const back = new RecordKeySet();
  for (const cls of classes) {
    const file = classFileOf(dir, object.objectApiName, cls);
    for await (const row of rowsOf(file)) back.add(idOf(row, file));
  }
  if (back.size === 0) return waiting;
  const taken = new Set<string>();
  for await (const row of rowsOf(liveSpoolOf(freshDir, object.objectApiName))) {
    const key = settingKeyOf(field, row[field]);
    if (key !== undefined) taken.add(key);
  }
  if (taken.size === 0) return waiting;
  for await (const row of rowsOf(deletedSpoolOf(freshDir, object.objectApiName))) {
    if (typeof row.Id !== 'string' || !back.has(row.Id)) continue;
    const key = settingKeyOf(field, row[field]);
    if (key !== undefined && taken.has(key)) waiting.add(row.Id);
  }
  return waiting;
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
    recreated: 0,
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

// ─── The links between files and records ─────────────────────────────────────

/** A link by its two ends, as the diffs tell it: a link inserted again has a new Id. */
function linkKeyOf(row: { ContentDocumentId: string; LinkedEntityId: string }): string {
  return `${row.ContentDocumentId.slice(0, 15)}:${row.LinkedEntityId.slice(0, 15)}`;
}

/** A line of a diff's links, read as its class writes it, or the diff is not whole. */
function linkLineOf(
  row: OrgRow,
  cls: FileLinkClass,
  file: string,
): { Id: string; ContentDocumentId: string; LinkedEntityId: string } {
  const schema = cls === 'linkChanged' ? fileLinkChangedLineSchema : fileLinkLineSchema;
  const parsed = schema.safeParse(row);
  if (!parsed.success) {
    throw new Error(`A line of ${file} names no link: the diff it was read from is not whole.`);
  }
  return parsed.data;
}

/** What a pass plans of links is made from. */
interface LinksInput {
  confirmedDir: string;
  freshDir: string;
  dir: string;
  pass: 1 | 2;
  /** Whether this pass deletes a record, a file among them: its links go with it. */
  deleted: (id: string) => boolean;
  /**
   * For the second pass, what the first brought back or made again, by the
   * Ids the reads named it by then or the record made again has now: its
   * links were expected with it.
   */
  earlier: (id: string) => boolean;
  left: LeftTally;
}

/** The links of a plan that writes none. */
function noLinks(dir: string): Pick<RewindPlanLinks, 'unlink' | 'relink' | 'share'> {
  return {
    unlink: { file: fileLinkClassFileOf(dir, 'linkAdded'), count: 0 },
    relink: { file: fileLinkClassFileOf(dir, 'linkRemoved'), count: 0 },
    share: { file: fileLinkClassFileOf(dir, 'linkChanged'), count: 0 },
  };
}

/** Plan each class of links: see the module's comment. */
async function planLinks(
  input: LinksInput,
): Promise<Pick<RewindPlanLinks, 'unlink' | 'relink' | 'share'>> {
  const planned: Partial<Record<'unlink' | 'relink' | 'share', PlannedLinks>> = {};
  for (const { cls, as } of LINK_CLASSES) {
    const confirmed = new Set<string>();
    const confirmedFile = fileLinkClassFileOf(input.confirmedDir, cls);
    for await (const row of rowsOf(confirmedFile)) {
      confirmed.add(linkKeyOf(linkLineOf(row, cls, confirmedFile)));
    }
    const file = fileLinkClassFileOf(input.freshDir, cls);
    const lines = new ClassLines(fileLinkClassFileOf(input.dir, cls));
    let count = 0;
    for await (const row of rowsOf(file)) {
      const link = linkLineOf(row, cls, file);
      // Gone with its file, or its record: nothing of it to write.
      if (input.deleted(link.ContentDocumentId) || input.deleted(link.LinkedEntityId)) continue;
      const expected =
        input.pass === 2 &&
        cls === 'linkRemoved' &&
        (input.earlier(link.ContentDocumentId) || input.earlier(link.LinkedEntityId));
      if (!confirmed.has(linkKeyOf(link)) && !expected) {
        input.left.add(FILE_LINK_OBJECT, 'changedSincePreview', link.Id);
        continue;
      }
      await lines.add(row);
      count++;
    }
    await lines.flush();
    planned[as] = { file: lines.file, count };
  }
  const none = noLinks(input.dir);
  return {
    unlink: planned.unlink ?? none.unlink,
    relink: planned.relink ?? none.relink,
    share: planned.share ?? none.share,
  };
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
  const idsIn = (fields: readonly string[], row: OrgRow): string[] =>
    fields.flatMap((field) => {
      const parent = row[field];
      return typeof parent === 'string' && RECORD_ID.test(parent) ? [parent] : [];
    });
  const cascadeOf = (object: CheckpointObject, row: OrgRow): string[] =>
    idsIn(object.cascadeParents, row);
  /** The records `row` points at through a lookup that restricts their delete. */
  const restrictOf = (object: CheckpointObject, row: OrgRow): string[] =>
    idsIn(object.restrictParents ?? [], row);
  const left = new LeftTally();

  /** Every record this pass would delete, before what it keeps out. */
  const toDelete = new RecordKeySet();
  /** Records kept out of the deletion, or left, each flagged with why. */
  const kept = new RecordKeySet();
  /** Records to come back with their parent, and be deleted by the second pass. */
  const comesBack = new RecordKeySet();
  /** Records brought back for a moment as carriers, deleted again by the second pass. */
  const carriers = new RecordKeySet();
  /** Records to delete that were confirmed as carriers: brought back for a moment, by this rewind. */
  const carried = new RecordKeySet();
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
        if (isConfirmed && DELETED.has(cls) && (confirmed.flagsOf(id) & CLASS_FLAG.carrier) !== 0) {
          carried.add(id);
        }
        const other = after?.other.flagsOf(id) ?? 0;
        if (other > 0 || !(isConfirmed || after?.own.has(id) === true)) {
          const reason = other > 0 ? 'changedDuringRewind' : 'changedSincePreview';
          left.add(name, reason, id, other > 0 ? users[other - 1] : undefined);
          if (DELETED.has(cls)) kept.add(id, LEFT_FLAG[reason]);
          continue;
        }
        // A record made again gets a new Id: made only once that was accepted.
        if (cls === 'toRecreate' && !input.acceptRecreate) {
          left.add(name, 'recreateNotAccepted', id);
          continue;
        }
        await lineOf(cls).add(cls === 'giveBack' ? row : { Id: id });
        if (DELETED.has(cls)) toDelete.add(id);
        else if (cls === 'comesBackWithParent') {
          comesBack.add(id);
          tally.nextPassDeleted++;
        } else if (cls === 'carrier') {
          comesBack.add(id);
          carriers.add(id);
          tally.carriers = (tally.carriers ?? 0) + 1;
          tally.nextPassDeleted++;
        } else if (cls === 'inBin' || cls === 'deletedWhileTaken') tally.broughtBack++;
        else if (cls === 'withParent') tally.backWithParent++;
        else if (cls === 'toRecreate') tally.recreated++;
        // What comes back from the bin comes back with the values it had
        // when deleted: given back once it is back.
        if (cls === 'inBin' || cls === 'withParent') await lineOf('giveBack').add({ Id: id });
      }
    }
    for (const held of lines.values()) await held.flush();
    tally.skipped = confirmed.count((flags) => (flags & STILL_TO_DO) === 0);
  }

  // ─── What is kept out of the deletion ───
  // A carrier brought back for a moment came back with what hangs from it
  // outside the checkpoint, in the recycle bin before the rewind: it goes
  // back there with it.
  if (checkpoint.scope.mode === 'picked' && !input.acceptOutside) {
    for (const object of objects) {
      const file = classFileOf(freshDir, object.objectApiName, 'outsideParents');
      for await (const row of rowsOf(file)) {
        const id = idOf(row, file);
        if (!toDelete.has(id) || kept.has(id) || carried.has(id)) continue;
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
  const beforeParent: RewindPlan['beforeParent'] = [];
  for (const object of parentsFirst) {
    stopped();
    const name = object.objectApiName;
    const file = liveSpoolOf(freshDir, name);
    const pointing = new ClassLines(beforeParentFileOf(dir, name));
    let sentBefore = 0;
    for await (const row of rowsOf(file)) {
      const id = typeof row.Id === 'string' ? row.Id : '';
      if (!deleted(id)) continue;
      // As the removal tells a record that goes with its parent from one
      // that keeps it: created since T1, unchanged since Tr — or last changed
      // by a write of the rewind, which left the date it holds: a record
      // that came back with a carrier the first pass brought back is dated by
      // that undelete, and goes back to the bin with it. Sent on its own
      // before it, Salesforce would keep it in the bin for good.
      const modified = dateMs(row.LastModifiedDate);
      const along =
        cascadeOf(object, row).some(deleted) &&
        dateMs(row.CreatedDate) >= t1 &&
        (modified <= before || modified <= (stampOf.get(id.slice(0, 15)) ?? Number.NaN));
      if (along) {
        goesAlong.add(id);
        countsOf(name).withParentDeleted++;
        continue;
      }
      // Of an object Salesforce undeletes on its own, a record deleted alone
      // comes back alone — unless a record it points at that this pass
      // deletes goes after it, and the org then keeps it in the bin for
      // good. One made while the checkpoint was taken, or brought back
      // since, is such a record: the removal would keep its parent for it,
      // so it cannot go with it. So is one whose lookup restricts that
      // record's delete: the org refuses the record's delete while it lives.
      const parents = [...cascadeOf(object, row), ...restrictOf(object, row)].filter(deleted);
      if (object.undeletable && parents.length === 0) continue;
      const reason = parents.length > 0 ? 'beforeParentNotAccepted' : 'noUndoNotAccepted';
      if (input.acceptNoUndo) {
        countsOf(name).undoCannot++;
        if (parents.length > 0) {
          await pointing.add({ Id: id, parents });
          sentBefore++;
        }
      } else {
        kept.add(id, LEFT_FLAG[reason]);
        left.add(name, reason, id);
      }
    }
    await pointing.flush();
    if (sentBefore > 0) {
      beforeParent.push({ objectApiName: name, count: sentBefore, file: pointing.file });
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

  // ─── The rows of custom settings whose key a live row holds ───
  const waiting = new Map<string, RecordKeySet>();
  for (const object of objects) {
    const held = await keyTakenOf(object, freshDir, dir, ['inBin', 'deletedWhileTaken']);
    if (held.size === 0) continue;
    waiting.set(object.objectApiName, held);
    const tally = countsOf(object.objectApiName);
    tally.broughtBack -= held.size;
    tally.keyTaken = held.size;
    for (const cls of ['inBin', 'deletedWhileTaken'] as const) {
      const file = classFileOf(dir, object.objectApiName, cls);
      for await (const row of rowsOf(file)) {
        const id = idOf(row, file);
        if (held.has(id)) left.add(object.objectApiName, 'keyTaken', id);
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
    const keyTaken = waiting.get(name);
    for await (const row of rowsOf(file)) {
      const id = idOf(row, file);
      // Still in the bin: given its values by the pass that brings it back.
      if (keyTaken?.has(id) === true) continue;
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

  // ─── What is brought back, and made again, parents first ───
  const back = new IdSpoolWriter(`${dir}/bringBack`);
  const made = new IdSpoolWriter(`${dir}/recreate`);
  for (const object of parentsFirst) {
    const keyTaken = waiting.get(object.objectApiName);
    for (const cls of ['carrier', 'inBin', 'deletedWhileTaken'] as const) {
      const file = classFileOf(dir, object.objectApiName, cls);
      for await (const row of rowsOf(file)) {
        const id = idOf(row, file);
        if (keyTaken?.has(id) !== true) await back.add(object.objectApiName, id);
      }
    }
    const file = classFileOf(dir, object.objectApiName, 'toRecreate');
    for await (const row of rowsOf(file)) await made.add(object.objectApiName, idOf(row, file));
  }

  // ─── The links between files and records ───
  // What the first pass brought back or made again: a link of it that the
  // org did not bring back with it is inserted again by the second.
  const earlier = new RecordKeySet();
  if (pass === 2) {
    for (const object of objects) {
      for (const cls of [
        'inBin',
        'withParent',
        'deletedWhileTaken',
        'carrier',
        'toRecreate',
      ] as const) {
        const file = classFileOf(confirmedDir, object.objectApiName, cls);
        for await (const row of rowsOf(file)) earlier.add(idOf(row, file));
      }
    }
  }
  // A checkpoint taken before files were held rewinds as it did then: no
  // link is written on its own, whatever its folders hold.
  const linked =
    checkpoint.files === undefined
      ? noLinks(dir)
      : await planLinks({
          confirmedDir,
          freshDir,
          dir,
          pass,
          deleted: (id) => RECORD_ID.test(id) && deleted(id),
          earlier: (id) =>
            RECORD_ID.test(id) &&
            (earlier.has(id) || earlier.has(input.recreated?.originalOf(id.slice(0, 15)) ?? id)),
          left,
        });
  // A file kept for what it is shared with outside the checkpoint: its links
  // to the records the checkpoint holds go, and the file stays.
  const unlinkFrom = new IdSpoolWriter(`${dir}/unlinkFrom`);
  for (const cls of DELETED) {
    const file = classFileOf(dir, FILE_OBJECT, cls);
    for await (const row of rowsOf(file)) {
      const id = idOf(row, file);
      if ((kept.flagsOf(id) & LEFT_FLAG.outsideNotAccepted) !== 0) {
        await unlinkFrom.add(FILE_OBJECT, id);
      }
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
    carriers,
    goesAlong,
    recreate: await made.finish(),
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
    // Children first, as the removal deletes them.
    beforeParent: beforeParent.reverse(),
    left: left.all(order),
    links: { ...linked, unlinkFrom: await unlinkFrom.finish() },
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
