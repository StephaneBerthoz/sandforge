/**
 * What changed in an org since a checkpoint, record by record, and what a
 * rewind would do about each: read from the org now, writing nothing to it.
 * It is the preview a person confirms, the fresh read a rewind acts on, and
 * the read that verifies a rewind once it is done.
 *
 * No API gives a record's past values: field history tracked no field of
 * either org the checkpoint was probed on, and change events carry the new
 * values alone. So the snapshot is the past, and every change is told by
 * sets, one object at a time:
 *
 * - `S`, the records the snapshot holds, each with the stamp it was read
 *   with (`SnapshotIndex`), compared by the first fifteen characters of their
 *   ids;
 * - `B0`, the ids in the recycle bin when the take began, stamped before T0's
 *   second (`bin/<Object>.ids`): the bin's two halves split by that second
 *   exactly, by count and by id, asked live on 5,446 records;
 * - `L`, the live records stamped since five minutes before T0, and `D`, the
 *   records in the bin stamped since then, read whole (`readChanges`). A
 *   delete stamps the record and what it takes along with its second, an
 *   undelete with its own, and a stamp never moves in the bin: whatever was
 *   created, changed, deleted or brought back since is in one or the other;
 * - `n`, how many live records the object holds now.
 *
 * A record is told by `S` first, then by `B0`:
 *
 * - in `L` and `S`, stamped otherwise than the snapshot read it, is a
 *   candidate, and so is one the snapshot read stamped within the second
 *   before T0's or after: the org dates a write to its second, so a write in
 *   the second the record was read in leaves the stamp the snapshot holds. The
 *   values decide: a compared field that differs is given back; a stamp that
 *   moved over the same values (a roll-up recalculated, an edit undone) is a
 *   record touched, counted in the details; the same stamp over the same
 *   values is the record as the checkpoint holds it;
 * - in `L`, not in `S`, in `B0`: in the bin at the checkpoint and brought back
 *   since, deleted again by a rewind;
 * - in `L`, in neither, created at or after T0's second: created since,
 *   deleted by a rewind. Created before it: left and named. A load can set
 *   `CreatedDate` in the past, a transaction can commit late, and a rewind
 *   deletes nothing it cannot prove was created since;
 * - in `D` and `S`: deleted since, in the bin, brought back. One deleted in
 *   the second a parent the rewind brings back was deleted in, through a
 *   field whose parent's delete takes it along, went with that parent and
 *   comes back with it: it is never promised back on its own, since the org
 *   refuses one deleted so while its parent is in the bin. One deleted on its
 *   own comes back on its own — but not in an object Salesforce undeletes
 *   only with its parent (an opportunity's products, a campaign's members):
 *   such a record whose parent is not coming back cannot come back with its
 *   id at all, and is named so. Nor one whose parent that way, or a record it
 *   points at through a lookup that restricts that record's delete, was
 *   deleted after it — a parent the rewind brings back, created since, or in
 *   the bin at the checkpoint and brought back since: Salesforce keeps such a
 *   record in the bin for good (F41, and live for a contact deleted on its
 *   own before the account created since it was moved under);
 * - in `D` and `S`, deleted in the second a record the checkpoint does not
 *   hold was deleted in — created since, or in the bin at the checkpoint and
 *   brought back since — through a field whose parent's delete takes it
 *   along: Salesforce brings it back with that record only, and answers its
 *   own undelete "Entity is not in the recycle bin", the words it answers for
 *   a record emptied from the bin (seen live for a contact under an account
 *   created since). So that record, the top of what went in that second, is
 *   a carrier: brought back for a moment, its object one Salesforce undeletes
 *   on its own, then deleted again by the second pass with what came back
 *   with it. What it took along of the checkpoint comes back with it and is
 *   given its values back, its parent among them, and what it took along
 *   created since comes back and goes again. A carrier Salesforce does not
 *   undelete on its own, or stuck in the bin, leaves what it took along named;
 * - in `D` and `S`, deleted in the second its parent of an object the
 *   checkpoint does not hold was deleted in, through a field whose parent's
 *   delete takes it along: it comes back with that parent only, which the
 *   rewind does not read, and is named, never made again — the original
 *   would come back beside it the day someone brings that parent back. Such
 *   parents are read by id from the bin, the fields that name them told from
 *   their objects' describes: a checkpoint knows only the fields to parents
 *   it holds;
 * - in `L` and `S`, a lead converted since: Salesforce cannot unconvert it and
 *   refuses any update of it, so it is named, never given back. So is a
 *   contract activated since: Salesforce will not set an activated contract
 *   back to Draft;
 * - in `D`, in neither, created before T0's second: live at T0, gone before
 *   its object was read — deleted while the checkpoint was taken, brought back
 *   with the values it had when deleted, as the snapshot holds none. A record
 *   deleted in T0's own second, before T0, reads so too: brought back, never
 *   lost;
 * - in `D` and `B0`: in the bin at the checkpoint: nothing to rewind. In `D`
 *   alone, created since: created and deleted since, nothing to rewind —
 *   unless it went with a parent the rewind brings back: it comes back with
 *   that parent, and the rewind deletes it once more.
 *
 * What is left is what the snapshot holds and the org no longer does, live or
 * in the bin: `lost = |S| − (n − |L \ S|) − |D ∩ S|`, every live record the
 * snapshot does not hold having been stamped since. Only when it is above
 * zero is the object's every live id read, each marked against the snapshot's
 * index, with the ids of the bin read since (`GoneForGood`): what neither
 * marks is gone for good, and cannot come back with its id. An object whose
 * records the bin let go of without a stamp — whatever the org does with a
 * hard delete — is counted for that alone, even when nothing in it moved.
 *
 * A record gone for good, or that the bin keeps for good, is one a rewind
 * makes again, with the snapshot's values and a new Id (`toRecreate`) —
 * unless the snapshot holds no body of its object's files, which a record
 * made again would be without: those stay gone for good. A record made again
 * is held by its new Id from then on (`Recreated`), and its old Id, still in
 * the bin or purged since, is neither deleted since nor gone.
 *
 * Tasks and Events the org archives (closed tasks and past events older than
 * about a year) leave plain queries: each of their reads, the values' too,
 * goes through the recycle bin and keeps to the live records, so an activity
 * archived since is neither deleted nor gone.
 *
 * Beside the classes, a diff says:
 *
 * - what changed in the objects' fields since the take: each object is
 *   described again, asked whether it changed since a day before T0 — the
 *   take described it before T0 and kept no date of it — and what comes back
 *   is printed as the take printed it. A field deleted since, or hidden since
 *   by field-level security, is neither read nor compared, and is named: a
 *   read that names it is refused whole, and its object would read as one
 *   that could not be read. Which of the two it is, the describe does not
 *   say (`fieldsGoneOf`): a standard field cannot be deleted, so one gone is
 *   hidden, and of a custom one the Tooling API is asked. A field added
 *   since is left alone; one whose type changed is compared still, and
 *   named;
 * - the fields not compared: those its owner chose to stop comparing, and
 *   those gone since;
 * - a person account's contact as its account's: Salesforce neither deletes
 *   nor brings back such a contact on its own, so it is in no class of
 *   Contact, and its account, which alone is deleted, brought back or given
 *   its fields back, is compared whenever its contact moved;
 * - the lookups a deletion since cleared: the org empties a lookup that
 *   names a record it deletes, and restamped the child it did so on (asked
 *   live for a contact's `ReportsToId`), but no other lookup was asked. So the
 *   snapshot's rows of every object a deleted record's describe lists as its
 *   child are read for the lookups that name a record the rewind brings back,
 *   and their values compared whatever their stamps;
 * - who last changed the records to delete or give back, and who changed any
 *   of them in the hour before the read: a record two people changed names
 *   the last of them;
 * - the records outside the checkpoint that its deletions take along: those
 *   created at or after T1 under a record to delete, through a relationship
 *   the org deletes along, in an object a person works in. Those created
 *   before keep their parent, which the rewind's deletion leaves;
 * - the records to delete that go with a parent the rewind deletes too, in
 *   any object: made at or after T1, as the deletion takes along only such a
 *   record, they are never sent on their own and come back with that parent.
 *   Deleted alone first, a record whose parent is deleted after it stays in
 *   the bin for good;
 * - the records to delete that Undo couldn't bring back, each with why: in an
 *   object Salesforce undeletes only with its parent, one whose parent stays
 *   is deleted on its own, and stays in the bin (`onlyWithParent`); in any
 *   object, one deleted on its own before a record it points at that the
 *   rewind deletes next stays there for good (`deletedBeforeParent`) — a
 *   case whose account lookup restricts the account's delete, which the
 *   account cannot go before (seen live), or one the deletion would not take
 *   along with its parent: made while the checkpoint was taken, brought back
 *   since, changed in the second the read began in.
 *
 * Of a checkpoint that holds files, a file (`ContentDocument`) is told as any
 * record, but only when a link ties it to a record the checkpoint holds: as
 * it was then, for a file the checkpoint holds; as it is now, for one added
 * since. Any other file is counted and left (`fileLinksDiff.ts`), as are its
 * links; the links of the files acted on are told apart as sets, and the
 * files another user owns, which a user without Query All Files reads by
 * their ids alone, are read so. A checkpoint that holds no files — taken
 * before files were held, or by a scope that left them out — is told as it
 * was before: nothing of its files is read.
 *
 * An object any of whose reads failed is named "could not be read", never
 * taken for one that did not change: a rewind leaves it as it is.
 *
 * Read by a user without View All Data and Modify All Data, object by object
 * (`rewindAccess.ts`): an object the user no longer holds whole is not read,
 * and could not be read, with why; a record deleted since by another user,
 * whom the deleted row names its last modifier (F2), cannot come back — only
 * Modify All Data restores what someone else deleted (P-B3) — and is named
 * (`deletedByOther`), never brought back nor made again, with what went with
 * it in its second; of an object held through what it hangs from, a record
 * the snapshot holds that is neither live nor in what the bin shows the user,
 * or that Salesforce answered an earlier rewind is no longer in the bin, may
 * be another's deletion out of sight, and is named (`outOfReach`), never made
 * again. Of each object with records to delete, the objects its delete takes
 * records of along, through a lookup whose delete cascades, that the user is
 * not proven to see whole are named too (`RewindDiff.unseen`): no read counts
 * those records.
 *
 * The ids of each class are written to the preview's folder as they are told,
 * `<Object>.<class>.ndjson`, one `{"Id"}` line each and nothing held whole: a
 * rewind acts on what its preview confirmed that still differs, class by
 * class, by id. A line given back names the fields that differ, and of them
 * the lookups a deletion cleared.
 */

import { appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod';
import {
  sanitizeSoqlObjectName,
  type CheckpointObject,
  type OrgCheckpoint,
  type RewindDiff,
  type RewindDiffObject,
  type RewindDiffUnseen,
  type RewindFilesDiff,
  type RewindSchemaDrift,
} from '@sandforge/shared';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { ACCOUNT, CONTACT } from '../../core/common/platformRecords.js';
import { MAX_STATEMENT_URI_CHARS, readColumnsApart } from '../../core/common/wideRead.js';
import { idLists, RECORDS_PER_CALL, workedObjects } from '../dataops/RecordRemoval.js';
import { orgDateTime } from '../sync/SyncDelta.js';
import { sameValue } from '../sync/SyncRunRestore.js';
import {
  FILE_WITNESSES,
  PERSON_ACCOUNT_FLAG,
  checkpointDescribeSchema,
  comparedFields,
  ignoredFieldsOf,
  isPersonContact,
  readModeOf,
  type CheckpointDescribe,
} from './checkpointFields.js';
import {
  FILE_LINK_OBJECT,
  FILE_OBJECT,
  FILE_VERSION_OBJECT,
  customSettingKeyOf,
} from './checkpointScope.js';
import { fileLinkClassFileOf } from './checkpointFiles.js';
import { outsideOfFiles, readFileAnchors, tellFiles, type FileAnchors } from './fileLinksDiff.js';
import { fingerprintOf, schemaDrift, type ObjectFingerprint } from './checkpointFingerprint.js';
import { OrgReadStopped, type CompositeReader, type OrgRow } from './compositeQueries.js';
import {
  CHECKPOINT_FILE_MODE,
  binFileOf,
  makePrivateDir,
  previewDirOf,
  readFieldPrints,
  type CheckpointFolder,
} from './OrgCheckpointStore.js';
import {
  idScanRead,
  readChanges,
  readStreams,
  soqlInstant,
  spooledRows,
  streamRead,
  type ObjectChanges,
  type ObjectRead,
} from './orgStreams.js';
import { ORG_ACCESS, type ActAccess } from './rewindAccess.js';
import { GoneForGood, NotInBin, SNAPSHOT_CHUNK_IDS, SnapshotIndex } from './snapshotIndex.js';

/**
 * The classes a record is told into, each with its file in the preview's
 * folder:
 *
 * - `giveBack`: changed since, a compared field differs; its line names them,
 *   and of them, as `cleared`, the lookups a deletion since emptied;
 * - `touched`: stamped since over its checkpoint values;
 * - `createdSince`, `broughtBackSince`: to delete;
 * - `comesBackWithParent`: created since and deleted with a parent the rewind
 *   brings back: it comes back with it, and is deleted again;
 * - `unexplained`: live, not held, dated before the checkpoint: left, named;
 * - `inBin`, `withParent`, `deletedWhileTaken`: to bring back, on its own,
 *   with its parent, or with the values it had when deleted;
 * - `toRecreate`: deleted since and no longer in the bin, in it in an
 *   object Salesforce undeletes only with a parent that is not coming back,
 *   or in it where Salesforce keeps it for good (`stuckOf`), held by the
 *   snapshot: it cannot come back with its id, and is made again with a new
 *   one, the snapshot's values its own;
 * - `goneForGood`: the same, of an object whose files' bodies the snapshot
 *   does not hold, or not held by the snapshot — deleted while the
 *   checkpoint was taken — which nothing could make again: named;
 * - `convertedLead`: a lead converted since, which Salesforce cannot
 *   unconvert and refuses any update of: named, never given back;
 * - `activatedContract`: a contract activated since, which Salesforce will
 *   not set back to Draft: named, never given back;
 * - `carrier`: a record the checkpoint does not hold, deleted since with
 *   records it holds: brought back for a moment, with them, and deleted
 *   again by the second pass;
 * - `deletedWithCreatedParent`: deleted since with a record created since,
 *   which its parent's delete took it along with, that Salesforce does not
 *   undelete on its own: it brings it back with that record only, so it is
 *   named, never brought back;
 * - `deletedWithParentOutside`: deleted since with its parent, a record of an
 *   object the checkpoint does not hold: named, never brought back, never
 *   made again;
 * - `deletedByOther`, `outOfReach`: read object by object, deleted since by
 *   another user, or of an object held through what it hangs from and out of
 *   the user's sight: named, never brought back, never made again;
 * - `undoCannot`: of the records to delete, those Undo couldn't bring back,
 *   a line naming why when it is not `onlyWithParent`. Not a class of its
 *   own: each of its records is in a class to delete too;
 * - `outsideParents`: of the records to delete, those records outside the
 *   checkpoint created since T1 hang from, which their deletion takes along.
 *   Not a class of its own either: a rewind of picked objects keeps them
 *   unless the deletion of what hangs from them is accepted;
 *
 * and of a file (`ContentDocument`) of a checkpoint that holds files
 * (`fileLinksDiff.ts`):
 *
 * - `outsideAdded`: added since — created, or brought back from the bin —
 *   that no link ties to a record the checkpoint holds: left, never deleted;
 * - `outsideDeleted`: deleted since, that no link of the checkpoint tied to a
 *   record it holds: left where it is;
 * - `newFileVersion`: given a new version since, which no rewind takes back.
 *   Not a class of its own: each of its files is in another, or in none.
 */
export type RewindClass =
  | 'giveBack'
  | 'touched'
  | 'createdSince'
  | 'broughtBackSince'
  | 'comesBackWithParent'
  | 'unexplained'
  | 'inBin'
  | 'withParent'
  | 'deletedWhileTaken'
  | 'toRecreate'
  | 'goneForGood'
  | 'convertedLead'
  | 'activatedContract'
  | 'carrier'
  | 'deletedWithCreatedParent'
  | 'deletedWithParentOutside'
  | 'deletedByOther'
  | 'outOfReach'
  | 'undoCannot'
  | 'outsideParents'
  | 'outsideAdded'
  | 'outsideDeleted'
  | 'newFileVersion';

/** Every class, as the files of an object are named by. */
const REWIND_CLASSES: readonly RewindClass[] = [
  'giveBack',
  'touched',
  'createdSince',
  'broughtBackSince',
  'comesBackWithParent',
  'unexplained',
  'inBin',
  'withParent',
  'deletedWhileTaken',
  'toRecreate',
  'goneForGood',
  'convertedLead',
  'activatedContract',
  'carrier',
  'deletedWithCreatedParent',
  'deletedWithParentOutside',
  'deletedByOther',
  'outOfReach',
  'undoCannot',
  'outsideParents',
  'outsideAdded',
  'outsideDeleted',
  'newFileVersion',
];

/** Why a record deleted since stays in the bin with a parent the rewind does not bring back. */
type StrandedClass = 'deletedWithCreatedParent' | 'deletedWithParentOutside';

/** The object of a lead, and its flag a conversion sets for good. */
const LEAD = 'Lead';
const CONVERTED_FLAG = 'IsConverted';

/**
 * The object of a contract, the status its user sets, and the category the
 * org keeps of that status, which no one sets: `Activated` once the contract
 * is, for good.
 */
const CONTRACT = 'Contract';
const CONTRACT_STATUS = 'Status';
const STATUS_CATEGORY = 'StatusCode';
const ACTIVATED = 'Activated';

/** The classes of the records a rewind deletes in its first pass. */
const DELETED_FIRST = ['createdSince', 'broughtBackSince'] as const;

/** Where a preview keeps the ids of one class of one object. */
export function classFileOf(previewDir: string, objectApiName: string, cls: RewindClass): string {
  return join(previewDir, `${sanitizeSoqlObjectName(objectApiName)}.${cls}.ndjson`);
}

/** What a diff since a checkpoint reads from. */
export interface RewindDiffInput {
  /**
   * The checkpoint: with its files' block when it holds files — its rewind
   * acts on the files linked to its records alone, and on their links — and
   * the user it was taken as, whose Query All Files says what it could see.
   * Without that block, files are what a checkpoint of SandForge 1.69 made
   * of them: nothing it holds.
   */
  checkpoint: Pick<
    OrgCheckpoint,
    'checkpointId' | 'readFrom' | 'takenAt' | 'objects' | 'ignoredFields' | 'snapshotId'
  > &
    Partial<Pick<OrgCheckpoint, 'files'>> & {
      takenBy?: Pick<OrgCheckpoint['takenBy'], 'queryAllFiles'>;
    };
  /** The checkpoint's folder: its snapshot, index, bin and field prints. */
  folder: CheckpointFolder;
  /** The org, read through composites. */
  reader: CompositeReader;
  /**
   * The org's global describe, `conn.describeGlobal()`: which objects outside
   * the checkpoint a person works in, read once a deletion would take records
   * of one along.
   */
  describeGlobal: () => Promise<unknown>;
  /** Names the preview: its reads and classes go to `previews/<previewId>/`. */
  previewId: string;
  /** Tr: read on the org's clock just before the reads begin. */
  readAt: string;
  /** Stops the reads between two pages, two calls or two objects. */
  signal?: AbortSignal;
  /**
   * Whether the user reading now has Query All Files, when its guard read
   * it: without it, a file another user owns linked to no record the
   * checkpoint holds is not seen now either.
   */
  queryAllFiles?: boolean;
  /**
   * What the user reading now may read and write of each object, as the
   * act's guard read their permissions (`rewindAccess.ts`): everything, with
   * View All Data and Modify All Data, unless given.
   */
  access?: ActAccess;
}

/**
 * The grain the org dates a write to: a write in the second the snapshot read
 * a record in, after the read, leaves the stamp the snapshot holds.
 */
const ORG_DATE_GRAIN_MS = 1_000;

/**
 * How long before T0 a describe is asked whether its object changed since.
 * The take describes its objects before T0 — the scope, the counts and the
 * day's budget come first — and keeps no date of it: asked from T0, a field
 * deleted in between would answer "not modified". Asked from a day before,
 * such a change comes back, and one from before the take's describe comes
 * back too, as a describe that prints as the take printed it: a few more
 * bytes, never a change missed.
 */
const DESCRIBED_SINCE_MS = 24 * 60 * 60_000;

/** The hour before the read in which a person who changed a record is working in the org now. */
const ACTIVE_WINDOW_MS = 60 * 60_000;

/** Columns past which a read by id names fewer records per query, as a restore reads them. */
const WIDE_COLUMNS = 100;

/** Lines a class's file is written by at a time. */
const SPOOL_LINES = 2_000;

/** Who last changed a record, and when: read beside the stamps. */
const WHO_COLUMNS = ['LastModifiedById', 'LastModifiedDate'];

/** The key the org knows a record by: its id's first fifteen characters. */
function keyOf(id: unknown): string | undefined {
  return typeof id === 'string' && id.length >= 15 ? id.slice(0, 15) : undefined;
}

/** A date as the org gives it, `+0000` or `Z`, in milliseconds; NaN for anything else. */
function dateMs(value: unknown): number {
  const at = orgDateTime(value);
  return at === null ? Number.NaN : Date.parse(at);
}

/** Whether `objectApiName` is a file's, `ContentDocument`. */
function isFile(objectApiName: string): boolean {
  return objectApiName.toLowerCase() === FILE_OBJECT.toLowerCase();
}

/** Whether a field holds no value: a lookup the org cleared. */
function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

/** The snapshot's own spelling of a field, whatever the case it is asked in; none when it holds none. */
function heldField(fields: readonly string[], name: string): string | undefined {
  const wanted = name.toLowerCase();
  return fields.find((field) => field.toLowerCase() === wanted);
}

/**
 * Whether a rewind can make a record of `object` again from the snapshot: not
 * one of an object of files, whose body the snapshot leaves out
 * (`ContentVersion.VersionData`, `Attachment.Body`, `Document.Body`) — made
 * again, the record would hold no file.
 */
export function recreatable(object: Pick<CheckpointObject, 'leftOutFields'>): boolean {
  return !object.leftOutFields.some((field) => field.reason === 'base64');
}

/** The ids of one class of one object, written to the preview's folder as they are told. */
class ClassSpool {
  private lines: string[] = [];
  private written = false;
  count = 0;

  constructor(readonly file: string) {}

  async add(line: Record<string, unknown>): Promise<void> {
    this.lines.push(`${JSON.stringify(line)}\n`);
    this.count++;
    if (this.lines.length >= SPOOL_LINES) await this.flush();
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

  /** Remove what was written: an object that could not be read whole keeps no class. */
  async discard(): Promise<void> {
    this.lines = [];
    if (this.written) await rm(this.file, { force: true });
  }
}

/** Remove every class file of an object: one whose reads failed after it was told keeps none. */
async function discardClasses(previewDir: string, objectApiName: string): Promise<void> {
  await Promise.all(
    REWIND_CLASSES.map((cls) => rm(classFileOf(previewDir, objectApiName, cls), { force: true })),
  );
}

/**
 * A record of the snapshot whose values decide: the stamp the snapshot read
 * it with, the one the change read found — the same, for one no change read
 * found — and the lookups of its snapshot row that name a record deleted
 * since.
 */
interface Candidate {
  id: string;
  key: string;
  held: number;
  stamp: number;
  cleared?: readonly string[];
}

/** Who last changed the records of an object to delete or give back, and who did so lately. */
class People {
  private readonly counts = new Map<string, number>();
  readonly active = new Set<string>();

  constructor(private readonly activeFrom: number) {}

  /** Count the last modifier of `row`, as the org gives it: none for a row that names none. */
  add(row: OrgRow): void {
    const by = row.LastModifiedById;
    if (typeof by !== 'string' || by === '') return;
    this.counts.set(by, (this.counts.get(by) ?? 0) + 1);
    if (dateMs(row.LastModifiedDate) >= this.activeFrom) this.active.add(by);
  }

  /** How many each user last changed, by user Id, in Id order. */
  byUser(): Record<string, number> {
    return Object.fromEntries([...this.counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
}

/**
 * A record to delete, the parents it hangs from through a field whose
 * parent's delete takes it along, and the records it points at through a
 * lookup that restricts their delete: of an object Salesforce undeletes only
 * with its parent, every one; of any other, one that hangs from or points at
 * a record, which the rewind may delete next.
 */
interface PendingUndo {
  id: string;
  parents: string[];
  /** The records it points at through a lookup that restricts their delete, by key. */
  restricts: string[];
  /**
   * Whether the deletion takes it along with a parent it deletes, as it tells
   * one from a record that keeps its parent: created at or after T1, and not
   * changed in the second the read began in or since. One made while the
   * checkpoint was taken, or brought back since, keeps its parent: it is
   * deleted on its own.
   */
  goesAlong: boolean;
  /** Whether Salesforce undeletes it on its own. */
  undeletable: boolean;
}

/** One object told: its diff, who changed it, and what Undo may not bring back of it. */
interface Told {
  diff: RewindDiffObject;
  people: People;
  pending: PendingUndo[];
}

/** What one object's diff came to: what a rewind would do, or why it could not be read. */
type ObjectOutcome = { told: Told } | { unread: string };

/** What the org's describe says now of an object's fields since the take. */
interface FieldsNow {
  /** Absent when no field changed. */
  drift?: RewindSchemaDrift;
  /**
   * The fields deleted or hidden since, or that could not be told which, in
   * lower case: neither read nor compared.
   */
  gone: ReadonlySet<string>;
}

/**
 * A record deleted since that a rewind brings back: its object, the stamp its
 * delete left, the records it hangs from through a field whose parent's
 * delete takes it along, and those it points at through a lookup that
 * restricts their delete, by key.
 */
interface ToBringBack {
  objectApiName: string;
  /** Its id, as the read gave it. */
  id: string;
  stamp: number;
  parents: string[];
  restricts: string[];
  /** Who deleted it, by key: its last modifier in the bin (F2); none when the read named none. */
  by?: string;
}

/** What every object of a diff shares. */
interface DiffContext {
  input: RewindDiffInput;
  previewDir: string;
  /** T0's second, in milliseconds: what `CreatedDate` is compared with. */
  t0s: number;
  /** From when a person who last changed a record is working in the org now. */
  activeFrom: number;
  /** By key, every record deleted since that the rewind brings back. */
  back: ReadonlyMap<string, ToBringBack>;
  /**
   * By key, the records the rewind brings back for a moment, then deletes
   * again (`carriersOf`): the top of what went with records it holds. They
   * are in {@link back} too, with what went with them in their second.
   */
  carriers: ReadonlySet<string>;
  /**
   * By key, the records deleted since that stay in the bin with a parent the
   * rewind does not bring back, and why (`strandedOf`).
   */
  stranded: ReadonlyMap<string, StrandedClass>;
  /**
   * By key, the records deleted since that the bin holds and Salesforce will
   * not let out of it (`stuckOf`), and those it answered an earlier rewind are
   * no longer in it (`NotInBin`): gone for good, never to bring back.
   */
  stuck: ReadonlySet<string>;
  /** Of {@link stuck}, by key, those Salesforce answered an earlier rewind are no longer in the bin. */
  answeredGone: ReadonlySet<string>;
  /**
   * Read object by object, by key, the records deleted since by another user
   * than the one reading, and what went with them in their second
   * (`othersOf`): none with View All Data and Modify All Data.
   */
  others: ReadonlySet<string>;
  /** What the user reading may read and write of each object. */
  access: ActAccess;
  /** By object, the lookups of its snapshot rows that may name a record of {@link back}. */
  lookups: ReadonlyMap<string, readonly string[]>;
  /**
   * The accounts, by key, of the person contacts that moved since: their
   * fields are the account's, which is compared whatever its own stamp says.
   * The account's diff takes them out as it compares them.
   */
  personAccounts: Set<string>;
  /**
   * For a checkpoint that holds files, which file a rewind acts on: one a
   * link of the checkpoint tied to a record it holds, or, added since, one a
   * link ties to such a record now. Absent for one that holds none.
   */
  files?: FileAnchors;
}

/** The ids of an object in the recycle bin at T0, by key, read from its bin file once asked. */
function binAtCheckpoint(folder: CheckpointFolder, objectApiName: string) {
  let keys: Promise<Set<string>> | undefined;
  const read = async (): Promise<Set<string>> => {
    const held = new Set<string>();
    try {
      for await (const row of spooledRows(binFileOf(folder, objectApiName))) {
        const key = keyOf(row.Id);
        if (key !== undefined) held.add(key);
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      throw new Error(
        `The checkpoint’s list of what ${objectApiName} held in the recycle bin is not on this machine.`,
      );
    }
    return held;
  };
  return async (key: string): Promise<boolean> => (await (keys ??= read())).has(key);
}

/**
 * The values `ids` of `objectApiName` hold now, of `columns`, by key: read by
 * id, two hundred a statement, in column groups for an object too wide for
 * one, each row held to one write. Tasks and Events are read through the
 * recycle bin, kept to the live ones, so an archived one is found.
 *
 * @throws When a read could not be read whole: the values are not all there.
 */
async function valuesNow(
  reader: CompositeReader,
  object: CheckpointObject,
  columns: readonly string[],
  ids: readonly string[],
): Promise<Map<string, OrgRow>> {
  const name = sanitizeSoqlObjectName(object.objectApiName);
  const scanAll = object.readMode === 'scanAllLive';
  const live = scanAll ? ' AND IsDeleted = false' : '';
  const read = async (soql: string): Promise<OrgRow[]> => {
    const lane = reader.lane();
    const rows: OrgRow[] = [];
    try {
      const outcome = await streamRead(lane, { objectApiName: name, soql, scanAll }, (page) => {
        rows.push(...page);
      });
      if (!outcome.read) throw new Error(outcome.reason);
      return rows;
    } finally {
      lane.close();
    }
  };
  const perQuery = columns.length > WIDE_COLUMNS ? RECORDS_PER_CALL / 4 : RECORDS_PER_CALL;
  const now = new Map<string, OrgRow>();
  for (const list of idLists(ids, perQuery)) {
    const rows = await readColumnsApart(
      `SELECT ${columns.join(', ')} FROM ${name} WHERE Id IN (${list})${live}`,
      read,
      { stamp: 'SystemModstamp', ...(scanAll ? { idsWhere: 'IsDeleted = false' } : {}) },
    );
    for (const row of rows) {
      const key = keyOf(row.Id);
      if (key !== undefined) now.set(key, row);
    }
  }
  return now;
}

// ─── The fields gone from a describe ─────────────────────────────────────────

/**
 * A custom field's name: `__c`, a person account's `__pc` — the contact's
 * own field, as its account lists it — or the `__s` of a part of a compound
 * custom field, a location's latitude or an address's city. Any other is a
 * standard field, which no one deletes: only custom fields go to Deleted
 * Fields.
 */
const CUSTOM_FIELD = /__(?:c|pc|s)$/i;

/** A part of a compound custom field, `Site__Latitude__s`, and the field it is part of. */
const COMPOUND_PART = /^(.+)__[A-Za-z]+__s$/i;

/** A person account's field, `Region__pc`: the contact's `Region__c`. */
const PERSON_FIELD = /^(.+)__pc$/i;

/** A field's name as it may go between quotes in a statement. */
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Names one statement asks `FieldDefinition` for at most, whatever the URI
 * leaves room for: each answers one row at most, so the whole answer fits
 * the first page of a query, which is all a Tooling read here takes.
 */
const DEFINITIONS_PER_STATEMENT = 200;

/**
 * Where `FieldDefinition` lists a custom field: under its object and name;
 * a part of a compound field under the field it is part of, which is listed
 * where its parts are not; a person account's field under the contact.
 * Undefined for a standard field, and for a name no statement may quote.
 */
export function definitionOf(
  objectApiName: string,
  field: string,
): { entity: string; name: string } | undefined {
  if (!CUSTOM_FIELD.test(field) || !FIELD_NAME.test(field)) return undefined;
  const person = PERSON_FIELD.exec(field);
  if (person) return { entity: CONTACT, name: `${person[1]}__c` };
  const part = COMPOUND_PART.exec(field);
  if (part) return { entity: objectApiName, name: `${part[1]}__c` };
  return { entity: objectApiName, name: field };
}

/** How the fields gone from an object's describe since the take came out. */
export interface FieldsGone {
  /** Custom fields `FieldDefinition` no longer lists: deleted since. */
  removed: string[];
  /** Standard fields, and custom fields `FieldDefinition` still lists: hidden by field-level security. */
  hidden: string[];
  /** Custom fields whose read of `FieldDefinition` the org refused, with its answer. */
  uncertain?: { fields: string[]; reason?: string };
}

const fieldDefinitionsSchema = z.array(z.object({ QualifiedApiName: z.string() }).loose());

/**
 * The statements that ask `FieldDefinition` whether each of `names` of
 * `entity` is defined, each with the names it asks for, held to the URI's
 * budget and {@link DEFINITIONS_PER_STATEMENT}: one object a statement, as
 * the Tooling API was asked it live.
 */
function definitionStatements(
  entity: string,
  names: readonly string[],
): Array<{ soql: string; names: string[] }> {
  const head =
    'SELECT QualifiedApiName FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = ' +
    `'${sanitizeSoqlObjectName(entity)}' AND QualifiedApiName IN (`;
  const statementOf = (list: readonly string[]): string =>
    `${head}${list.map((name) => `'${name}'`).join(', ')})`;
  const statements: Array<{ soql: string; names: string[] }> = [];
  let list: string[] = [];
  for (const name of names) {
    const next = [...list, name];
    const full =
      next.length > DEFINITIONS_PER_STATEMENT ||
      encodeURIComponent(statementOf(next)).length > MAX_STATEMENT_URI_CHARS;
    if (list.length > 0 && full) {
      statements.push({ soql: statementOf(list), names: list });
      list = [name];
    } else {
      list = next;
    }
  }
  if (list.length > 0) statements.push({ soql: statementOf(list), names: list });
  return statements;
}

/** A name `FieldDefinition` is asked for, and the fields gone it answers for. */
interface AskedDefinition {
  name: string;
  fields: Array<{ objectApiName: string; field: string }>;
}

/**
 * Of the fields each object's describe no longer lists since the take,
 * which were deleted and which field-level security hides from the user.
 * The describe and every query of the data API leave out both alike, View
 * All Data and Modify All Data notwithstanding: a custom field no permission
 * granted was absent from an administrator's describe too. Asked live of a
 * Standard User with View Setup, the Tooling API's `FieldDefinition` listed
 * a standard field the user's profile hid and a custom field no permission
 * granted, and no longer listed that custom field once deleted, where the
 * data API's `FieldDefinition` and `EntityParticle` followed field-level
 * security as the describe does.
 *
 * So a standard field gone is hidden, with no request: no one deletes one.
 * A custom field is asked of `FieldDefinition` through the Tooling API, one
 * object a statement: listed, it is hidden; not listed, deleted since; a
 * read the org refuses leaves its fields uncertain, with the org's answer.
 * Nothing is refused for it, and every field gone is named in one of the
 * three.
 *
 * @param missing - By object, the fields its describe no longer lists.
 * @returns By object, how its fields came out; and the requests it sent.
 * @throws {OrgReadStopped} When the run was stopped.
 */
export async function fieldsGoneOf(
  reader: Pick<CompositeReader, 'tooling'>,
  missing: ReadonlyMap<string, readonly string[]>,
): Promise<{ gone: Map<string, FieldsGone>; requests: number }> {
  const gone = new Map<string, FieldsGone>();
  // By the object `FieldDefinition` is asked of, by name in lower case.
  const asked = new Map<string, Map<string, AskedDefinition>>();
  for (const [objectApiName, fields] of missing) {
    const told: FieldsGone = { removed: [], hidden: [] };
    gone.set(objectApiName, told);
    for (const field of fields) {
      const definition = definitionOf(objectApiName, field);
      if (definition === undefined) {
        told.hidden.push(field);
        continue;
      }
      const names = asked.get(definition.entity) ?? new Map<string, AskedDefinition>();
      asked.set(definition.entity, names);
      const key = definition.name.toLowerCase();
      const of = names.get(key) ?? { name: definition.name, fields: [] };
      names.set(key, of);
      of.fields.push({ objectApiName, field });
    }
  }
  let requests = 0;
  const uncertain = new Map<string, { fields: string[]; reasons: string[] }>();
  for (const [entity, names] of asked) {
    const listed = new Set<string>();
    const refused = new Map<string, string>();
    const statements = definitionStatements(
      entity,
      [...names.values()].map(({ name }) => name),
    );
    for (const statement of statements) {
      requests++;
      try {
        const page = await reader.tooling(statement.soql);
        if (!page.done) throw new Error('FieldDefinition answered more than one page');
        const rows = fieldDefinitionsSchema.safeParse(page.records);
        if (!rows.success) throw new Error('FieldDefinition answered rows with no field name');
        for (const row of rows.data) listed.add(row.QualifiedApiName.toLowerCase());
      } catch (err: unknown) {
        if (err instanceof OrgReadStopped) throw err;
        const reason = extractErrorMessage(err);
        for (const name of statement.names) refused.set(name.toLowerCase(), reason);
      }
    }
    for (const [key, { fields }] of names) {
      const reason = refused.get(key);
      for (const { objectApiName, field } of fields) {
        const told = gone.get(objectApiName);
        if (told === undefined) continue;
        if (reason !== undefined) {
          const held = uncertain.get(objectApiName) ?? { fields: [], reasons: [] };
          uncertain.set(objectApiName, held);
          held.fields.push(field);
          if (!held.reasons.includes(reason)) held.reasons.push(reason);
        } else if (listed.has(key)) {
          told.hidden.push(field);
        } else {
          told.removed.push(field);
        }
      }
    }
  }
  for (const [objectApiName, told] of gone) {
    told.removed.sort();
    told.hidden.sort();
    const held = uncertain.get(objectApiName);
    if (held !== undefined) {
      told.uncertain = {
        fields: held.fields.sort(),
        ...(held.reasons.length > 0 ? { reason: held.reasons.join('; ') } : {}),
      };
    }
  }
  return { gone, requests };
}

// ─── The objects' fields now ─────────────────────────────────────────────────

/**
 * Each of `objects` described again, asked whether it changed since a day
 * before T0, and what changed in its fields printed against the take's: see
 * the module's comment. Of the fields a describe no longer lists, those
 * deleted told from those hidden (`fieldsGoneOf`). An object whose describe
 * the org would not give, or whose prints this machine no longer holds,
 * could not be read.
 *
 * @param bodies - Filled with every describe the org answered in full.
 * @returns By object, its fields now; and the requests the fields gone took.
 * @throws {OrgReadStopped} When the run was stopped.
 */
async function fieldsNowOf(
  input: RewindDiffInput,
  objects: readonly CheckpointObject[],
  bodies: Map<string, CheckpointDescribe>,
): Promise<{ now: Map<string, FieldsNow | { unread: string }>; requests: number }> {
  const { checkpoint, folder, reader } = input;
  const since = new Date(Date.parse(checkpoint.readFrom) - DESCRIBED_SINCE_MS).toISOString();
  const answers = await Promise.allSettled(
    objects.map(({ objectApiName }) => reader.describe(objectApiName, since)),
  );
  let prints: Promise<Map<string, ObjectFingerprint>> | undefined;
  const now = new Map<string, FieldsNow | { unread: string }>();
  const drifts = new Map<string, ReturnType<typeof schemaDrift>>();
  for (const [at, answer] of answers.entries()) {
    const name = objects[at].objectApiName;
    if (answer.status === 'rejected') {
      if (answer.reason instanceof OrgReadStopped) throw answer.reason;
      now.set(name, {
        unread: `The org did not answer the describe of ${name}: ${extractErrorMessage(answer.reason)}`,
      });
      continue;
    }
    if ('notModified' in answer.value) {
      now.set(name, { gone: new Set() });
      continue;
    }
    const parsed = checkpointDescribeSchema.safeParse(answer.value.body);
    if (!parsed.success) {
      now.set(name, { unread: `The describe of ${name} does not read as one.` });
      continue;
    }
    bodies.set(name, parsed.data);
    try {
      const then = (await (prints ??= readFieldPrints(folder, checkpoint.objects))).get(name);
      if (then === undefined) throw new Error(`The checkpoint holds no field prints of ${name}.`);
      drifts.set(name, schemaDrift(then, fingerprintOf(parsed.data.fields)));
    } catch (err: unknown) {
      now.set(name, { unread: extractErrorMessage(err) });
    }
  }
  const missing = new Map(
    [...drifts]
      .filter(([, drift]) => drift.removed.length > 0)
      .map(([name, drift]) => [name, drift.removed]),
  );
  const told =
    missing.size > 0
      ? await fieldsGoneOf(reader, missing)
      : { gone: new Map<string, FieldsGone>(), requests: 0 };
  for (const [name, { removed, added, changed }] of drifts) {
    const gone = told.gone.get(name);
    now.set(name, {
      ...(removed.length + added.length + changed.length > 0
        ? {
            drift: {
              removed: gone?.removed ?? [],
              added,
              changed,
              ...(gone !== undefined && gone.hidden.length > 0 ? { hidden: gone.hidden } : {}),
              ...(gone?.uncertain !== undefined ? { uncertain: gone.uncertain } : {}),
            },
          }
        : {}),
      // Deleted, hidden or either: none of them is read, compared or written.
      gone: new Set(removed.map((field) => field.toLowerCase())),
    });
  }
  return { now, requests: told.requests };
}

/**
 * What the change reads of an object read beside the stamps: the fields whose
 * parent's delete takes a record along, which tell what comes back with a
 * parent, and those whose parent's delete a live record refuses, which tell
 * what a rewind deletes before a record it points at; on a contact of an org
 * with person accounts, the flag and the account, which tell a person
 * account's contact; of a custom setting, the owner of a hierarchy's row or
 * the name of a list's, which tell a row to bring back from one made since
 * that holds it now (`rewindPlan`); and who last changed each record, when.
 * Never a field gone since: a read that names one is refused whole.
 */
function changeReadFields(object: CheckpointObject, gone: ReadonlySet<string>): string[] {
  const fields = [...object.cascadeParents, ...(object.restrictParents ?? [])].filter(
    (field) => !gone.has(field.toLowerCase()),
  );
  if (object.customSetting !== undefined) {
    const key = heldField(object.fields, customSettingKeyOf(object.customSetting));
    if (key !== undefined && !gone.has(key.toLowerCase()) && !fields.includes(key)) {
      fields.push(key);
    }
  }
  // A file's latest version and size, which tell a new version since and
  // what bringing it back takes of the org's file storage.
  if (isFile(object.objectApiName)) {
    for (const witness of FILE_WITNESSES) {
      const field = heldField(object.fields, witness);
      if (field !== undefined && !gone.has(field.toLowerCase())) fields.push(field);
    }
  }
  const flag = heldField(object.fields, PERSON_ACCOUNT_FLAG);
  if (object.objectApiName === CONTACT && flag !== undefined) {
    const account = heldField(object.fields, 'AccountId');
    for (const field of [flag, account]) {
      if (field !== undefined && !gone.has(field.toLowerCase())) fields.push(field);
    }
  }
  return [...fields, ...WHO_COLUMNS];
}

// ─── What a rewind brings back, and the lookups that name it ─────────────────

/**
 * Every record deleted since that the rewind brings back, by key, with the
 * stamp its delete left: held by the snapshot, or deleted while the
 * checkpoint was taken. Read from the change reads of the bin, before any
 * object is told: an object is told before its parents, and what comes back
 * with a parent, or names one, is told by what the parent is.
 *
 * An object whose index or bin is not on this machine brings nothing back:
 * its own diff names why.
 *
 * Read beside them, from the same reads, the records the checkpoint does not
 * hold deleted since (`gone`), which a record held may have gone with:
 * created since, or in the bin at the checkpoint and brought back since.
 *
 * @throws {OrgReadStopped} When the run was stopped.
 */
async function toBringBackOf(
  context: Pick<DiffContext, 'input' | 't0s'>,
  objects: readonly CheckpointObject[],
  changes: ReadonlyMap<string, ObjectChanges>,
): Promise<{ back: Map<string, ToBringBack>; gone: Map<string, ToBringBack> }> {
  const { folder, checkpoint } = context.input;
  const back = new Map<string, ToBringBack>();
  const gone = new Map<string, ToBringBack>();
  for (const { objectApiName, cascadeParents, restrictParents = [] } of objects) {
    const changed = changes.get(objectApiName);
    if (!changed || 'unread' in changed || !changed.deleted || changed.deleted.rows === 0) continue;
    const found = new Map<string, ToBringBack>();
    const created = new Map<string, ToBringBack>();
    try {
      const index = await SnapshotIndex.read(folder, checkpoint.snapshotId, objectApiName);
      const inBinAtCheckpoint = binAtCheckpoint(folder, objectApiName);
      for await (const row of spooledRows(changed.deleted.file)) {
        const key = keyOf(row.Id);
        if (key === undefined) continue;
        const keysOf = (fields: readonly string[]): string[] =>
          fields
            .map((field) => keyOf(row[field]))
            .filter((parent): parent is string => parent !== undefined && parent !== key);
        const by = keyOf(row.LastModifiedById);
        const record = (): ToBringBack => ({
          objectApiName,
          id: String(row.Id),
          stamp: dateMs(row.SystemModstamp),
          parents: keysOf(cascadeParents),
          restricts: keysOf(restrictParents),
          ...(by !== undefined ? { by } : {}),
        });
        // Made again under a new Id: its old one stays in the bin, never
        // brought back over the record that stands for it.
        if (index.retired(row.Id)) continue;
        if (!index.has(row.Id)) {
          // In the bin at the checkpoint, brought back since and deleted
          // again: a record held may have gone with it.
          if (await inBinAtCheckpoint(key)) {
            created.set(key, record());
            continue;
          }
          if (dateMs(row.CreatedDate) >= context.t0s) created.set(key, record());
          if (!(dateMs(row.CreatedDate) < context.t0s)) continue;
        }
        found.set(key, record());
      }
    } catch (err: unknown) {
      if (err instanceof OrgReadStopped) throw err;
      continue;
    }
    for (const [key, record] of found) back.set(key, record);
    for (const [key, record] of created) gone.set(key, record);
  }
  return { back, gone };
}

/**
 * Of the records deleted since that a rewind would bring back, those
 * Salesforce keeps in the bin for good, by key, taken out of `back`: one
 * deleted on its own, then a record it hangs from through a field whose
 * parent's delete takes it along, or points at through a lookup that
 * restricts that record's delete, deleted after it — its stamp later — and
 * what was deleted with such a record, which comes back with it alone. Seen
 * live on a case deleted on its own, then its account, whose lookup
 * restricted the account's delete: the case still reads deleted in the bin,
 * and its undelete answers "Entity is not in the recycle bin", sent with its
 * account, after it or before it. A rewind would be refused it; it can no
 * longer come back with its id.
 *
 * Told of the parents whose stamp the reads hold: one the rewind brings back,
 * and one the checkpoint does not hold, deleted since (`gone`) — seen live
 * too for a contact deleted on its own, then the account created since it
 * had been moved under: the contact stayed deleted, its undelete refused,
 * before that account came back and after. Of `gone`, those stuck are said
 * too: what went with them is stuck with them. A parent outside the
 * checkpoint is told by its own read (`parentsOutsideOf`).
 */
function stuckOf(
  back: Map<string, ToBringBack>,
  gone: ReadonlyMap<string, ToBringBack>,
): Set<string> {
  const stampOf = (key: string): number | undefined => back.get(key)?.stamp ?? gone.get(key)?.stamp;
  const stuck = new Set<string>();
  for (const records of [back, gone]) {
    for (const [key, record] of records) {
      const after = [...record.parents, ...record.restricts].some(
        (parent) => (stampOf(parent) ?? 0) > record.stamp,
      );
      if (after) stuck.add(key);
    }
  }
  stuckWith(stuck, back, gone);
  return stuck;
}

/**
 * Add to `stuck` what went with a record of it in its second, as far down as
 * that goes — it stays with it in the bin — and take them all out of `back`.
 */
function stuckWith(
  stuck: Set<string>,
  back: Map<string, ToBringBack>,
  gone: ReadonlyMap<string, ToBringBack>,
): void {
  const stampOf = (key: string): number | undefined => back.get(key)?.stamp ?? gone.get(key)?.stamp;
  for (let grew = stuck.size > 0; grew;) {
    grew = false;
    for (const records of [back, gone]) {
      for (const [key, record] of records) {
        if (stuck.has(key)) continue;
        const withStuck = record.parents.some(
          (parent) => stuck.has(parent) && stampOf(parent) === record.stamp,
        );
        if (withStuck) {
          stuck.add(key);
          grew = true;
        }
      }
    }
  }
  for (const key of stuck) back.delete(key);
}

/**
 * Of the records deleted since that a rewind would bring back, read by
 * `userKey` object by object, those another user deleted, by key: the deleted
 * row names its deleter its last modifier (F2), and Salesforce refuses the
 * undelete of what someone else deleted to a user without Modify All Data,
 * Modify All on the object notwithstanding (P-B3:
 * `INSUFFICIENT_ACCESS_OR_READONLY`, while the user's own came back). A row
 * that names no one is taken for another's: never tried. What went with one
 * of them in its second went with that delete, and stays with it. None
 * without a user, read with View All Data and Modify All Data.
 */
function othersOf(
  back: ReadonlyMap<string, ToBringBack>,
  userKey: string | undefined,
): Set<string> {
  if (userKey === undefined) return new Set();
  const deleters = [...back].filter(([, record]) => record.by !== userKey).map(([key]) => key);
  return wentWith(deleters, back);
}

/**
 * `seeds`, and what of `records` went with one of them in its second through
 * a field whose parent's delete takes it along, as far down as that goes.
 */
function wentWith(seeds: Iterable<string>, records: ReadonlyMap<string, ToBringBack>): Set<string> {
  const went = new Set(seeds);
  for (let grew = went.size > 0; grew;) {
    grew = false;
    for (const [key, record] of records) {
      if (went.has(key)) continue;
      const along = record.parents.some(
        (parent) => went.has(parent) && records.get(parent)?.stamp === record.stamp,
      );
      if (along) {
        went.add(key);
        grew = true;
      }
    }
  }
  return went;
}

/**
 * The records the checkpoint does not hold that a rewind brings back for a
 * moment, by key, then deletes again: of what a record of `back` went with —
 * a parent of `gone`, deleted in its second through a field whose parent's
 * delete takes it along — the top, the first going up whose own such parent
 * did not go in that second. Salesforce brings a record deleted so back with
 * that parent only (P7, and live for a contact under an account created
 * since): the only way to bring it back with its id.
 *
 * A top of an object Salesforce undeletes only with its parent carries
 * nothing: what went with it stays, named (`strandedOf`). So does one stuck
 * in the bin, which `stuckOf` took out with what went with it. Nor is a
 * record a carrier whose second reaches a parent the rewind brings back:
 * that parent brings it back already.
 *
 * Each carrier, and what went with it between it and the records held — an
 * opportunity created since under an account created since, a task held
 * under that opportunity — is added to `back`: what went with them comes
 * back with them, as it does with any record brought back.
 */
function carriersOf(
  objects: readonly CheckpointObject[],
  back: Map<string, ToBringBack>,
  gone: ReadonlyMap<string, ToBringBack>,
): Set<string> {
  const undeletable = new Map(objects.map((object) => [object.objectApiName, object.undeletable]));
  const carriers = new Set<string>();
  const along = new Set<string>();
  /** The parent of `gone` a record went with in its second, if any. */
  const goneWith = (record: ToBringBack, seen: ReadonlySet<string>): string | undefined =>
    record.parents.find((parent) => !seen.has(parent) && gone.get(parent)?.stamp === record.stamp);
  const reachesBack = (record: ToBringBack): boolean =>
    record.parents.some((parent) => back.get(parent)?.stamp === record.stamp);
  for (const record of [...back.values()]) {
    if (reachesBack(record)) continue;
    const seen = new Set<string>();
    const chain: string[] = [];
    let at = goneWith(record, seen);
    let toBack = false;
    while (at !== undefined) {
      seen.add(at);
      chain.push(at);
      const above = gone.get(at);
      if (!above) break;
      if (reachesBack(above)) {
        toBack = true;
        break;
      }
      at = goneWith(above, seen);
    }
    const top = chain[chain.length - 1];
    if (top === undefined || toBack) continue;
    const held = gone.get(top);
    if (!held || undeletable.get(held.objectApiName) !== true) continue;
    carriers.add(top);
    for (const key of chain.slice(0, -1)) along.add(key);
  }
  for (const key of [...carriers, ...along]) {
    const record = gone.get(key);
    if (record) back.set(key, record);
  }
  return carriers;
}

/**
 * The records of `back` that stay in the bin with a parent the rewind does
 * not bring back, by key, and why, taken out of `back`: those that went with
 * a record of `gone` it brings back nothing with (`carriersOf`), those that
 * went with a parent outside the checkpoint (`outside`), and what went with
 * either of them in its second, as far down as that goes. Promised back, such
 * a record would stay in the bin: so would a record held under a contact
 * that went with an account created since.
 */
function strandedOf(
  back: Map<string, ToBringBack>,
  gone: ReadonlyMap<string, ToBringBack>,
  outside: ReadonlySet<string>,
): Map<string, StrandedClass> {
  const stranded = new Map<string, StrandedClass>();
  for (const [key, record] of back) {
    if (outside.has(key)) {
      stranded.set(key, 'deletedWithParentOutside');
      continue;
    }
    if (gone.has(key)) continue;
    const withGone = record.parents.some(
      (parent) => !back.has(parent) && gone.get(parent)?.stamp === record.stamp,
    );
    if (withGone) stranded.set(key, 'deletedWithCreatedParent');
  }
  for (let grew = stranded.size > 0; grew;) {
    grew = false;
    for (const [key, record] of back) {
      if (stranded.has(key)) continue;
      const parent = record.parents.find(
        (each) => stranded.has(each) && back.get(each)?.stamp === record.stamp,
      );
      const why = parent === undefined ? undefined : stranded.get(parent);
      if (why === undefined) continue;
      stranded.set(key, why);
      grew = true;
    }
  }
  for (const key of stranded.keys()) back.delete(key);
  return stranded;
}

/**
 * Of the records of `back` that went with no parent the reads hold — to
 * bring back on their own — those that went with a parent of an object the
 * checkpoint does not hold (`outside`), and those deleted on their own
 * before such a parent was (`stuck`), by key; and the requests it sent to
 * tell them.
 *
 * A checkpoint knows the fields of its objects whose parent's delete takes a
 * record along only for the parents it holds: of each object of such
 * records, its describe names the lookups to objects outside it, whose own
 * describes say which of them their delete takes the record along through.
 * The records' values of those lookups are read from the bin by id, then
 * the parents they name, by id too, with their stamps: a parent in the bin
 * stamped in the record's second took it along; stamped later, it left the
 * record in the bin for good (F41). A lookup to several objects outside the
 * checkpoint is told by each one's key prefix; one whose prefix none gives is
 * not read, and its record is brought back on its own, as one whose parent
 * lives — the undelete's answer then says. A read that fails leaves its
 * records so too.
 *
 * @throws {OrgReadStopped} When the run was stopped.
 */
async function parentsOutsideOf(
  input: RewindDiffInput,
  objects: readonly CheckpointObject[],
  back: ReadonlyMap<string, ToBringBack>,
  gone: ReadonlyMap<string, ToBringBack>,
  carriers: ReadonlySet<string>,
  relationsOf: (objectApiName: string) => Promise<CheckpointDescribe>,
): Promise<{ outside: Set<string>; stuck: Set<string>; requests: number }> {
  const outside = new Set<string>();
  const stuck = new Set<string>();
  const held = new Set(objects.map(({ objectApiName }) => objectApiName.toLowerCase()));
  const byName = new Map(objects.map((object) => [object.objectApiName, object]));
  // Records that went with no parent the reads hold: those whose second
  // reaches a parent of `back` or `gone` are told by it.
  const alone = new Map<string, ToBringBack[]>();
  for (const [key, record] of back) {
    if (gone.has(key) || carriers.has(key)) continue;
    const withKnown = record.parents.some(
      (parent) => (back.get(parent) ?? gone.get(parent))?.stamp === record.stamp,
    );
    if (withKnown) continue;
    alone.set(record.objectApiName, [...(alone.get(record.objectApiName) ?? []), record]);
  }
  if (alone.size === 0) return { outside, stuck, requests: 0 };
  const before = input.reader.calls();
  const described = async (name: string): Promise<CheckpointDescribe | undefined> => {
    try {
      return await relationsOf(name);
    } catch (err: unknown) {
      if (err instanceof OrgReadStopped) throw err;
      return undefined;
    }
  };

  for (const [objectApiName, records] of alone) {
    const object = byName.get(objectApiName);
    const own = await described(objectApiName);
    if (!object || !own) continue;
    const known = new Set(
      [...object.cascadeParents, ...(object.restrictParents ?? [])].map((field) =>
        field.toLowerCase(),
      ),
    );
    const lookups = own.fields.filter(
      (field) =>
        field.type === 'reference' &&
        !known.has(field.name.toLowerCase()) &&
        (field.referenceTo ?? []).some((target) => !held.has(target.toLowerCase())),
    );
    if (lookups.length === 0) continue;
    // Of those lookups, the ones whose parent's delete takes the record along,
    // each with the objects outside the checkpoint it does so from.
    const targets = [
      ...new Set(
        lookups.flatMap((field) =>
          (field.referenceTo ?? []).filter((target) => !held.has(target.toLowerCase())),
        ),
      ),
    ];
    const parents = await Promise.all(targets.map(described));
    const fromOf = new Map<string, Array<{ object: string; prefix?: string }>>();
    parents.forEach((parent, at) => {
      if (!parent) return;
      const prefix = (parent as { keyPrefix?: unknown }).keyPrefix;
      for (const relationship of parent.childRelationships ?? []) {
        if (relationship.cascadeDelete !== true) continue;
        if (relationship.childSObject.toLowerCase() !== objectApiName.toLowerCase()) continue;
        const field = lookups.find(
          (each) => each.name.toLowerCase() === relationship.field.toLowerCase(),
        );
        if (!field) continue;
        fromOf.set(field.name, [
          ...(fromOf.get(field.name) ?? []),
          { object: targets[at], ...(typeof prefix === 'string' ? { prefix } : {}) },
        ]);
      }
    });
    if (fromOf.size === 0) continue;
    const fields = [...fromOf.keys()].map(assertSoqlIdentifier);
    const name = sanitizeSoqlObjectName(objectApiName);
    const ids = records.map((record) => record.id);
    /** By the record's key, the parents its lookups name, each with its object. */
    const named = new Map<string, Array<{ object: string; id: string }>>();
    const readIds = idLists(ids).map((list): ObjectRead => ({
      objectApiName: name,
      soql: `SELECT Id, ${fields.join(', ')} FROM ${name} WHERE Id IN (${list}) AND IsDeleted = true`,
      scanAll: true,
    }));
    const valuesRead = await readStreams(
      input.reader,
      readIds,
      (_, rows) => {
        for (const row of rows) {
          const key = keyOf(row.Id);
          if (key === undefined) continue;
          for (const [field, from] of fromOf) {
            const value = row[field];
            if (typeof value !== 'string' || keyOf(value) === undefined) continue;
            const one =
              from.length === 1
                ? from[0]
                : from.find((each) => each.prefix !== undefined && value.startsWith(each.prefix));
            if (one) named.set(key, [...(named.get(key) ?? []), { object: one.object, id: value }]);
          }
        }
      },
      input.signal,
    );
    if (valuesRead.some((outcome) => !outcome.read)) continue;
    const byObject = new Map<string, string[]>();
    for (const list of named.values()) {
      for (const { object: parentObject, id } of list) {
        byObject.set(parentObject, [...(byObject.get(parentObject) ?? []), id]);
      }
    }
    const reads: Array<{ object: string; read: ObjectRead }> = [];
    for (const [parentObject, parentIds] of byObject) {
      const parentName = sanitizeSoqlObjectName(parentObject);
      for (const list of idLists([...new Set(parentIds)])) {
        reads.push({
          object: parentObject,
          read: {
            objectApiName: parentName,
            soql: `SELECT Id, IsDeleted, SystemModstamp FROM ${parentName} WHERE Id IN (${list})`,
            scanAll: true,
          },
        });
      }
    }
    /** By key, each parent's stamp in the bin; a live one is left out. */
    const deletedAt = new Map<string, number>();
    await readStreams(
      input.reader,
      reads.map(({ read }) => read),
      (_, rows) => {
        for (const row of rows) {
          const key = keyOf(row.Id);
          if (key !== undefined && row.IsDeleted === true) {
            deletedAt.set(key, dateMs(row.SystemModstamp));
          }
        }
      },
      input.signal,
    );
    for (const record of records) {
      const key = keyOf(record.id);
      if (key === undefined) continue;
      for (const { id } of named.get(key) ?? []) {
        const at = deletedAt.get(keyOf(id) ?? '');
        if (at === undefined) continue;
        if (at === record.stamp) outside.add(key);
        else if (at > record.stamp) stuck.add(key);
      }
    }
  }
  return { outside, stuck, requests: input.reader.calls() - before };
}

/**
 * Per object of the checkpoint, its compared lookups that a parent's describe
 * lists as one of its children: the fields whose snapshot value may name a
 * record of `back`. A parent the org will not describe could not be read: what
 * names it could not be told, and it brings nothing back.
 *
 * @throws {OrgReadStopped} When the run was stopped.
 */
async function lookupsOf(
  back: Map<string, ToBringBack>,
  compared: ReadonlyMap<string, readonly string[]>,
  relationsOf: (objectApiName: string) => Promise<CheckpointDescribe>,
  unread: Map<string, string>,
): Promise<Map<string, string[]>> {
  const parents = [...new Set([...back.values()].map(({ objectApiName }) => objectApiName))];
  const described = await Promise.allSettled(parents.map(relationsOf));
  const byLowerName = new Map([...compared.keys()].map((name) => [name.toLowerCase(), name]));
  const lookups = new Map<string, Set<string>>();
  for (const [at, answer] of described.entries()) {
    if (answer.status === 'rejected') {
      if (answer.reason instanceof OrgReadStopped) throw answer.reason;
      const parent = parents[at];
      unread.set(parent, extractErrorMessage(answer.reason));
      for (const [key, record] of back) if (record.objectApiName === parent) back.delete(key);
      continue;
    }
    for (const relationship of answer.value.childRelationships ?? []) {
      const child = byLowerName.get(relationship.childSObject.toLowerCase());
      if (child === undefined) continue;
      const field = heldField(compared.get(child) ?? [], relationship.field);
      if (field === undefined) continue;
      let fields = lookups.get(child);
      if (!fields) {
        fields = new Set();
        lookups.set(child, fields);
      }
      fields.add(field);
    }
  }
  return new Map([...lookups].map(([child, fields]) => [child, [...fields]]));
}

/**
 * The accounts, by key, of the person contacts the change reads found moved
 * since, read from the contacts' spooled read before any object is told: an
 * account and its person contact point at each other, so which of the two is
 * read first is the scope's choice, and the account's diff must know them
 * either way. An org without person accounts, or a contact read that failed,
 * names none: the contact's own diff names why.
 */
async function personAccountsOf(
  objects: readonly CheckpointObject[],
  changes: ReadonlyMap<string, ObjectChanges>,
): Promise<Set<string>> {
  const accounts = new Set<string>();
  const contact = objects.find(({ objectApiName }) => objectApiName === CONTACT);
  if (!contact || heldField(contact.fields, PERSON_ACCOUNT_FLAG) === undefined) return accounts;
  const changed = changes.get(CONTACT);
  if (!changed || 'unread' in changed || !changed.live) return accounts;
  try {
    for await (const row of spooledRows(changed.live.file)) {
      const account = keyOf(row.AccountId);
      if (account !== undefined && isPersonContact(CONTACT, row)) accounts.add(account);
    }
  } catch {
    return new Set();
  }
  return accounts;
}

// ─── One object ──────────────────────────────────────────────────────────────

/** The counts of one object, as the classes fill. */
interface Tally {
  fields: number;
  /** Records given back whose lookup a deletion since cleared. */
  cleared: number;
  /** Live records the snapshot does not hold: `|L \ S|`. */
  liveNotHeld: number;
  /** Records of the snapshot in the bin since: `|D ∩ S|`. */
  deletedHeld: number;
}

/**
 * Tell the records of one object into their classes: see the module's
 * comment.
 *
 * @throws {OrgReadStopped} When the run was stopped.
 */
async function diffObject(
  context: DiffContext,
  object: CheckpointObject,
  changes: ObjectChanges,
  fieldsNow: FieldsNow,
): Promise<ObjectOutcome> {
  if ('unread' in changes) return { unread: changes.unread };
  const { input, previewDir, t0s, back, carriers, stranded, stuck, others, personAccounts } =
    context;
  const { folder, reader, checkpoint, signal } = input;
  const objectApiName = object.objectApiName;
  // A file is acted on when a link ties it to a record the checkpoint holds:
  // as it was then, for a file the checkpoint holds; as it is now, for one
  // added since. Any other — a user's own, a library's — is counted, left.
  const anchors = isFile(objectApiName) ? context.files : undefined;
  const actedThen = (id: string): boolean => anchors === undefined || anchors.anchoredThen(id);
  const spools = new Map<RewindClass, ClassSpool>();
  const spool = (cls: RewindClass): ClassSpool => {
    let held = spools.get(cls);
    if (!held) {
      held = new ClassSpool(classFileOf(previewDir, objectApiName, cls));
      spools.set(cls, held);
    }
    return held;
  };
  const countOf = (cls: RewindClass): number => spools.get(cls)?.count ?? 0;
  const people = new People(context.activeFrom);
  const pending: PendingUndo[] = [];

  try {
    const index = await SnapshotIndex.read(folder, checkpoint.snapshotId, objectApiName);
    const inBinAtCheckpoint = binAtCheckpoint(folder, objectApiName);
    const { gone } = fieldsNow;
    const ignored = ignoredFieldsOf(objectApiName, checkpoint.ignoredFields);
    const values = comparedFields(objectApiName, object.fields, []);
    const leftAside = (field: string): boolean =>
      ignored.has(field.toLowerCase()) || gone.has(field.toLowerCase());
    const compared = values.filter((field) => !leftAside(field)).map(assertSoqlIdentifier);
    const notCompared = values.filter(leftAside);
    // A lead converted since: Salesforce cannot unconvert one, and refuses an
    // update of it (`CANNOT_UPDATE_CONVERTED_LEAD`), so it is named, never
    // given back. Told by its flag, which the snapshot keeps as a field the
    // user may set on a new lead, and read even when its owner stopped
    // comparing it.
    const converted = objectApiName === LEAD ? heldField(object.fields, CONVERTED_FLAG) : undefined;
    const convertedRead =
      converted !== undefined && !gone.has(converted.toLowerCase()) ? converted : undefined;
    // A contract activated since: Salesforce will not set an activated
    // contract back to Draft (FAILED_ACTIVATION, seen live), so it is named,
    // never given back. Told by the category the org keeps of its status,
    // which no one sets and the snapshot does not hold: activated now, under
    // another status than the one the checkpoint holds. Its status given back
    // is what the org refuses; a status its owner stopped comparing is never
    // given back, and the contract with it.
    const status =
      objectApiName === CONTRACT ? heldField(object.fields, CONTRACT_STATUS) : undefined;
    const activationRead = status !== undefined && compared.includes(status) ? status : undefined;
    const columns = [
      'Id',
      'SystemModstamp',
      ...WHO_COLUMNS,
      ...compared,
      ...(convertedRead !== undefined && !compared.includes(convertedRead) ? [convertedRead] : []),
      ...(activationRead !== undefined ? [STATUS_CATEGORY] : []),
    ];
    const cascade = object.cascadeParents.filter((field) => !gone.has(field.toLowerCase()));
    const restrict = (object.restrictParents ?? []).filter(
      (field) => !gone.has(field.toLowerCase()),
    );
    const holdsPersons =
      objectApiName === CONTACT && heldField(object.fields, PERSON_ACCOUNT_FLAG) !== undefined;
    const isPerson = (row: OrgRow): boolean => holdsPersons && isPersonContact(objectApiName, row);
    // A record the snapshot holds that cannot come back with its id is made
    // again, with a new one — but a file, whose body the snapshot does not
    // hold, which a record made again would be without.
    const lostAs: RewindClass = recreatable(object) ? 'toRecreate' : 'goneForGood';
    // Held through what it hangs from, read object by object: a record the
    // bin does not show, or that Salesforce said is no longer there, may be
    // another user's deletion out of sight, and is never made again.
    const outOfSightAs: RewindClass =
      context.access.heldAs(objectApiName) === 'parent' ? 'outOfReach' : lostAs;
    const sameSecondFrom = t0s - ORG_DATE_GRAIN_MS;
    const tally: Tally = { fields: 0, cleared: 0, liveNotHeld: 0, deletedHeld: 0 };
    const recordOf = (row: OrgRow): { id: string; key: string } => {
      const key = keyOf(row.Id);
      if (key === undefined) throw new Error(`${objectApiName} answered a record without its Id.`);
      return { id: String(row.Id), key };
    };
    const keysOf = (fields: readonly string[], row: OrgRow, key: string): string[] =>
      fields
        .map((field) => keyOf(row[field]))
        .filter((parent): parent is string => parent !== undefined && parent !== key);
    const parentsOf = (row: OrgRow, key: string): string[] => keysOf(cascade, row, key);
    // Deleted in the second a parent the rewind brings back was, through a
    // field whose parent's delete takes it along: it went with that parent —
    // one held, or a carrier, which the rewind brings back for a moment.
    const wentWithParent = (row: OrgRow, key: string): boolean => {
      const stamp = dateMs(row.SystemModstamp);
      return parentsOf(row, key).some((parent) => back.get(parent)?.stamp === stamp);
    };
    const t1 = Date.parse(checkpoint.takenAt);
    const unchangedUntil = Date.parse(input.readAt) - ORG_DATE_GRAIN_MS;
    const toDelete = (row: OrgRow, id: string, key: string, live: boolean): void => {
      people.add(row);
      const parents = parentsOf(row, key);
      const restricts = keysOf(restrict, row, key);
      const goesAlong =
        live && dateMs(row.CreatedDate) >= t1 && dateMs(row.LastModifiedDate) <= unchangedUntil;
      // Of an object that comes back on its own, only what hangs from or
      // points at a record is counted: it may go with that record, or be
      // deleted before it. The rest is sent, and Undo brings it back alone.
      if (object.undeletable && parents.length + restricts.length === 0) return;
      pending.push({ id, parents, restricts, goesAlong, undeletable: object.undeletable });
    };

    // The rows of the snapshot whose lookups name a record the rewind brings
    // back: compared whatever their stamps, for the org may empty a lookup
    // without stamping the record it empties it on.
    const suspects = new Map<string, { id: string; fields: string[] }>();
    const lookups = context.lookups.get(objectApiName) ?? [];
    if (lookups.length > 0 && index.size > 0) {
      // As the org names the records now: one made again by its new Id.
      for await (const row of index.records()) {
        if (isPerson(row)) continue;
        const key = keyOf(row.Id);
        if (key === undefined) continue;
        const named = lookups.filter((field) => {
          const parent = keyOf(row[field]);
          return parent !== undefined && back.has(parent);
        });
        if (named.length > 0) suspects.set(key, { id: String(row.Id), fields: named });
      }
    }

    // The candidates' values, a chunk of the snapshot at a time: its rows read
    // at their offsets, the org's read by id, each compared field by field.
    const decide = async (candidates: Candidate[]): Promise<void> => {
      if (candidates.length === 0) return;
      if (compared.length === 0) {
        // Nothing to compare: a stamp that moved is all there is to tell.
        for (const candidate of candidates) {
          if (candidate.stamp !== candidate.held) await spool('touched').add({ Id: candidate.id });
        }
        return;
      }
      const ids = candidates.map((candidate) => candidate.id);
      const kept = new Map<string, Record<string, unknown>>();
      const batches = await index
        .chunk(ids)
        .batches(checkpoint.snapshotId, objectApiName, RECORDS_PER_CALL);
      for await (const batch of batches ?? []) {
        for (const row of batch) {
          const key = keyOf(row.Id);
          if (key !== undefined) kept.set(key, row);
        }
      }
      if (signal?.aborted) throw new OrgReadStopped();
      const now = await valuesNow(reader, object, columns, ids);
      for (const candidate of candidates) {
        const current = now.get(candidate.key);
        // Deleted after the change reads: the next read finds it in the bin.
        if (!current) continue;
        const then = kept.get(candidate.key);
        if (!then) {
          throw new Error(
            `The checkpoint’s snapshot of ${objectApiName} does not hold record ${candidate.id}, ` +
              'which its index names.',
          );
        }
        if (
          convertedRead !== undefined &&
          then[convertedRead] !== true &&
          current[convertedRead] === true
        ) {
          await spool('convertedLead').add({ Id: candidate.id });
          continue;
        }
        if (
          activationRead !== undefined &&
          current[STATUS_CATEGORY] === ACTIVATED &&
          !sameValue(then[activationRead], current[activationRead])
        ) {
          await spool('activatedContract').add({ Id: candidate.id });
          continue;
        }
        const differ = compared.filter((field) => !sameValue(then[field], current[field]));
        if (differ.length > 0) {
          tally.fields += differ.length;
          const cleared = (candidate.cleared ?? []).filter(
            (field) => differ.includes(field) && isEmpty(current[field]),
          );
          if (cleared.length > 0) tally.cleared++;
          await spool('giveBack').add({
            Id: candidate.id,
            fields: differ,
            ...(cleared.length > 0 ? { cleared } : {}),
          });
          people.add(current);
        } else if (dateMs(current.SystemModstamp) !== candidate.held) {
          await spool('touched').add({ Id: candidate.id });
        }
      }
    };
    let candidates: Candidate[] = [];
    const consider = async (candidate: Candidate): Promise<void> => {
      candidates.push(candidate);
      if (candidates.length >= SNAPSHOT_CHUNK_IDS) {
        await decide(candidates);
        candidates = [];
      }
    };

    if (changes.live) {
      for await (const row of spooledRows(changes.live.file)) {
        const { id, key } = recordOf(row);
        const person = isPerson(row);
        const held = index.stampOf(id);
        if (held !== undefined) {
          if (person || !actedThen(id)) continue;
          const cleared = suspects.get(key)?.fields;
          if (cleared) suspects.delete(key);
          const ofPerson = objectApiName === ACCOUNT && personAccounts.delete(key);
          const stamp = dateMs(row.SystemModstamp);
          if (cleared || ofPerson || stamp !== held || held >= sameSecondFrom) {
            await consider({ id, key, held, stamp, ...(cleared ? { cleared } : {}) });
          }
          continue;
        }
        tally.liveNotHeld++;
        // Counted with its account, which alone is deleted.
        if (person) continue;
        const added: RewindClass | undefined = (await inBinAtCheckpoint(key))
          ? 'broughtBackSince'
          : dateMs(row.CreatedDate) >= t0s
            ? 'createdSince'
            : undefined;
        if (added === undefined) {
          await spool('unexplained').add({ Id: id });
        } else if (anchors !== undefined && !anchors.anchoredNow(id)) {
          // A file no record of the checkpoint links to: never deleted.
          await spool('outsideAdded').add({ Id: id });
        } else {
          await spool(added).add({ Id: id });
          toDelete(row, id, key, true);
        }
      }
    }
    // What the change reads did not find, compared all the same: a lookup
    // cleared without a stamp, and a person account whose contact moved.
    for (const [key, suspect] of suspects) {
      const held = index.stampOf(suspect.id);
      if (held !== undefined) {
        await consider({ id: suspect.id, key, held, stamp: held, cleared: suspect.fields });
      }
    }
    if (objectApiName === ACCOUNT) {
      for (const key of personAccounts) {
        const row = index.rowOf(key);
        if (row < 0) continue;
        personAccounts.delete(key);
        if (suspects.has(key)) continue;
        const id = index.idAt(row);
        const held = index.stampOf(id);
        if (held !== undefined) await consider({ id, key, held, stamp: held });
      }
    }
    await decide(candidates);

    if (changes.deleted) {
      for await (const row of spooledRows(changes.deleted.file)) {
        const { id, key } = recordOf(row);
        // Made again under a new Id, which stands for it now.
        if (index.retired(id)) continue;
        // Brought back with its account, which alone is sent.
        const person = isPerson(row);
        if (index.has(id)) {
          tally.deletedHeld++;
          if (person) continue;
          if (!actedThen(id)) {
            await spool('outsideDeleted').add({ Id: id });
            continue;
          }
          // Another user deleted it: it stays in the bin, never made again.
          const strandedAs = stranded.get(key);
          if (others.has(key)) await spool('deletedByOther').add({ Id: id });
          // Salesforce keeps it in the bin for good.
          else if (stuck.has(key)) {
            await spool(context.answeredGone.has(key) ? outOfSightAs : lostAs).add({ Id: id });
          }
          // It comes back with a parent the rewind does not bring back only.
          else if (strandedAs !== undefined) await spool(strandedAs).add({ Id: id });
          else if (wentWithParent(row, key)) await spool('withParent').add({ Id: id });
          else if (object.undeletable) await spool('inBin').add({ Id: id });
          // Salesforce brings it back with its parent only, and its parent
          // is not coming back.
          else await spool(lostAs).add({ Id: id });
          continue;
        }
        // Brought back for a moment, with what it took along of the
        // checkpoint, then deleted again.
        if (carriers.has(key) && !person) {
          await spool('carrier').add({ Id: id });
          continue;
        }
        if (person || (await inBinAtCheckpoint(key))) continue;
        // Live at T0 and gone before its object was read. One created since
        // and deleted since leaves nothing to rewind, unless it went with a
        // parent the rewind brings back: it comes back with it.
        if (dateMs(row.CreatedDate) < t0s) {
          const strandedAs = stranded.get(key);
          const as: RewindClass = !actedThen(id)
            ? 'outsideDeleted'
            : others.has(key)
              ? 'deletedByOther'
              : stuck.has(key)
                ? 'goneForGood'
                : (strandedAs ?? 'deletedWhileTaken');
          await spool(as).add({ Id: id });
        } else if (wentWithParent(row, key)) {
          await spool('comesBackWithParent').add({ Id: id });
          toDelete(row, id, key, false);
        }
      }
    }

    // What the snapshot holds that the org no longer does, live or in the bin.
    const count = changes.count;
    if (index.size > 0 && count === undefined) {
      throw new Error(`The org gave no count of the ${objectApiName} records it holds.`);
    }
    const lost = index.size - ((count ?? 0) - tally.liveNotHeld) - tally.deletedHeld;
    if (lost > 0) {
      const gone = new GoneForGood(index);
      if (changes.deleted) {
        for await (const row of spooledRows(changes.deleted.file)) gone.mark(row.Id);
      }
      const [scan] = await readStreams(
        reader,
        [idScanRead(objectApiName, object.readMode)],
        (_, rows) => {
          for (const row of rows) gone.mark(row.Id);
        },
        signal,
      );
      if (!scan.read) throw new Error(scan.reason);
      // A person account's contact goes with its account, which is named.
      let ids: string[] = [];
      const named = async (): Promise<void> => {
        const persons = new Set<string>();
        if (holdsPersons) {
          const batches = await index
            .chunk(ids)
            .batches(checkpoint.snapshotId, objectApiName, RECORDS_PER_CALL);
          for await (const batch of batches ?? []) {
            for (const row of batch) {
              const key = keyOf(row.Id);
              if (key !== undefined && isPerson(row)) persons.add(key);
            }
          }
        }
        for (const id of ids) {
          if (persons.has(id.slice(0, 15))) continue;
          await spool(actedThen(id) ? outOfSightAs : 'outsideDeleted').add({ Id: id });
        }
        ids = [];
      };
      for (const id of gone.ids()) {
        ids.push(id);
        if (ids.length >= SNAPSHOT_CHUNK_IDS) await named();
      }
      await named();
    }

    for (const held of spools.values()) await held.flush();
    const toRecreate = countOf('toRecreate');
    const goneForGood = countOf('goneForGood');
    const convertedSince = countOf('convertedLead');
    const activatedSince = countOf('activatedContract');
    const withCreatedParent = countOf('deletedWithCreatedParent');
    const withParentOutside = countOf('deletedWithParentOutside');
    const byOther = countOf('deletedByOther');
    const outOfReach = countOf('outOfReach');
    const carried = countOf('carrier');
    const diff: RewindDiffObject = {
      objectApiName,
      toDelete: {
        createdSince: countOf('createdSince'),
        broughtBackSince: countOf('broughtBackSince'),
        comesBackWithParent: countOf('comesBackWithParent'),
      },
      toGiveBack: {
        records: countOf('giveBack'),
        fields: tally.fields,
        clearedLookups: tally.cleared,
      },
      toBringBack: {
        inBin: countOf('inBin'),
        withParent: countOf('withParent'),
        deletedWhileTaken: countOf('deletedWhileTaken'),
        ...(carried > 0 ? { carriers: carried } : {}),
      },
      ...(toRecreate > 0 ? { toRecreate } : {}),
      cannotUndo: [
        ...(goneForGood > 0 ? [{ reason: 'goneForGood' as const, count: goneForGood }] : []),
        ...(convertedSince > 0
          ? [{ reason: 'convertedLead' as const, count: convertedSince }]
          : []),
        ...(activatedSince > 0
          ? [{ reason: 'activatedContract' as const, count: activatedSince }]
          : []),
        ...(withCreatedParent > 0
          ? [{ reason: 'deletedWithCreatedParent' as const, count: withCreatedParent }]
          : []),
        ...(withParentOutside > 0
          ? [{ reason: 'deletedWithParentOutside' as const, count: withParentOutside }]
          : []),
        ...(byOther > 0 ? [{ reason: 'deletedByOther' as const, count: byOther }] : []),
        ...(outOfReach > 0 ? [{ reason: 'outOfReach' as const, count: outOfReach }] : []),
      ],
      outside: [],
      touched: countOf('touched'),
      unexplained: countOf('unexplained'),
      lastChangedBy: people.byUser(),
      ...(fieldsNow.drift ? { schemaDrift: fieldsNow.drift } : {}),
      notCompared,
    };
    return { told: { diff, people, pending } };
  } catch (err: unknown) {
    for (const held of spools.values()) await held.discard();
    if (err instanceof OrgReadStopped) throw err;
    return { unread: extractErrorMessage(err) };
  }
}

// ─── After every object is told ──────────────────────────────────────────────

/** The ids of the classes of `told`'s object the first pass deletes, a chunk at a time. */
async function* deletedFirst(previewDir: string, told: Told): AsyncGenerator<string[]> {
  let chunk: string[] = [];
  for (const cls of DELETED_FIRST) {
    if (told.diff.toDelete[cls] === 0) continue;
    for await (const row of spooledRows(classFileOf(previewDir, told.diff.objectApiName, cls))) {
      if (typeof row.Id !== 'string') continue;
      chunk.push(row.Id);
      if (chunk.length >= SNAPSHOT_CHUNK_IDS) {
        yield chunk;
        chunk = [];
      }
    }
  }
  if (chunk.length > 0) yield chunk;
}

/**
 * The records outside the checkpoint that the deletion of `told`'s records to
 * delete takes along, per object: those created at or after T1 under them,
 * through a relationship the org deletes along, in an object a person works
 * in — the relationships the deletion's own check of dependents reads. The
 * records to delete they hang from are written to the preview's folder
 * (`outsideParents`): a rewind of picked objects keeps those unless what hangs
 * from them is accepted to go too.
 *
 * T1 is exact and the org dates to the second: a record created in T1's own
 * second may be from before it, and the deletion keeps it with its parent, so
 * the count starts at the next second.
 *
 * Read object by object, an object the user is not proven to see whole
 * (`ActAccess.unseenOf`) is not read: {@link unseenUnder} names it, and a read
 * would count only what the user sees, or be refused.
 *
 * @throws When the org would not describe the object, or read what hangs from it.
 */
async function outsideOf(
  context: DiffContext,
  told: Told,
  relationsOf: (objectApiName: string) => Promise<CheckpointDescribe>,
  worked: () => Promise<ReadonlyMap<string, string>>,
  inCheckpoint: ReadonlySet<string>,
): Promise<RewindDiffObject['outside']> {
  const { input, previewDir } = context;
  const objectApiName = told.diff.objectApiName;
  const described = await relationsOf(objectApiName);
  const cascades = (described.childRelationships ?? []).filter(
    (relationship) =>
      relationship.cascadeDelete === true &&
      !inCheckpoint.has(relationship.childSObject.toLowerCase()),
  );
  if (cascades.length === 0) return [];
  const workedIn = await worked();
  const workedUnder = cascades.filter((relationship) => workedIn.has(relationship.childSObject));
  if (workedUnder.length === 0) return [];
  // A Standard User given View All and Modify All on Account read the feed
  // items under the accounts to delete by their parent, and the org answered
  // "Implementation restriction: FeedItem requires a filter by Id": the
  // account could not be read. With View All Data, the org reads them so.
  const unseen = new Set(
    await context.access.unseenOf([
      ...new Set(workedUnder.map(({ childSObject }) => childSObject)),
    ]),
  );
  const relationships = workedUnder.filter(({ childSObject }) => !unseen.has(childSObject));
  if (relationships.length === 0) return [];

  const t1 = Date.parse(input.checkpoint.takenAt);
  if (!Number.isFinite(t1)) throw new Error(`Not a date: ${input.checkpoint.takenAt}`);
  const from = soqlInstant(Math.ceil(t1 / ORG_DATE_GRAIN_MS) * ORG_DATE_GRAIN_MS);
  const byObject = new Map<string, { records: Set<string>; parents: Set<string> }>();
  /** The records to delete that something counted hangs from, by key, as the child names each. */
  const parentIds = new Map<string, string>();
  // An object with no CreatedDate — a ContentDocumentLink — is read by its
  // stamp instead: a link is made and seldom changed, and one changed since
  // that it takes along is counted with those made since, never left out.
  const datedBy = new Map<string, 'CreatedDate' | 'SystemModstamp'>();
  for await (const ids of deletedFirst(previewDir, told)) {
    let pending = relationships;
    while (pending.length > 0) {
      const reads: Array<{ read: ObjectRead; child: string; field: string }> = [];
      for (const relationship of pending) {
        const child = sanitizeSoqlObjectName(relationship.childSObject);
        const field = assertSoqlIdentifier(relationship.field);
        const live = readModeOf(child) === 'scanAllLive';
        const dated = datedBy.get(child) ?? 'CreatedDate';
        for (const list of idLists(ids)) {
          reads.push({
            child,
            field,
            read: {
              objectApiName: child,
              soql:
                `SELECT Id, ${field} FROM ${child} WHERE ${field} IN (${list}) ` +
                `AND ${dated} >= ${from}${live ? ' AND IsDeleted = false' : ''}`,
              scanAll: live,
            },
          });
        }
      }
      const outcomes = await readStreams(
        input.reader,
        reads.map(({ read }) => read),
        (index, rows) => {
          const { child, field } = reads[index];
          let held = byObject.get(child);
          if (!held) {
            held = { records: new Set(), parents: new Set() };
            byObject.set(child, held);
          }
          for (const row of rows) {
            const record = keyOf(row.Id);
            const parent = keyOf(row[field]);
            if (record !== undefined) held.records.add(record);
            if (parent !== undefined) {
              held.parents.add(parent);
              parentIds.set(parent, String(row[field]));
            }
          }
        },
        input.signal,
      );
      const undated = new Set<string>();
      outcomes.forEach((outcome, index) => {
        if (outcome.read) return;
        const { child } = reads[index];
        if (!datedBy.has(child) && /No such column 'CreatedDate'/.test(outcome.reason)) {
          undated.add(child);
          return;
        }
        throw new Error(
          `The ${outcome.objectApiName} records its deletion would take along could not be read: ` +
            outcome.reason,
        );
      });
      for (const child of undated) datedBy.set(child, 'SystemModstamp');
      pending = pending.filter((relationship) =>
        undated.has(sanitizeSoqlObjectName(relationship.childSObject)),
      );
    }
  }
  if (parentIds.size > 0) {
    const spool = new ClassSpool(classFileOf(previewDir, objectApiName, 'outsideParents'));
    for (const id of parentIds.values()) await spool.add({ Id: id });
    await spool.flush();
  }
  return [...byObject]
    .filter(([, { records }]) => records.size > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([child, { records, parents }]) => ({
      objectApiName: child,
      count: records.size,
      parents: parents.size,
    }));
}

/**
 * Read object by object, what the delete of `told`'s records to delete takes
 * along out of the user's sight: the objects a person works in that hang
 * from them through a relationship the org deletes along, whatever the
 * checkpoint holds, that the user is not proven to see every record of
 * (`ActAccess.unseenOf`) — tasks and events always, which have no View All.
 * A delete takes along every record that hangs from it so, seen or not: a
 * private task of another user under an account created since goes with
 * it, uncounted: {@link outsideOf} does not read such an object, and the
 * deletion's own check of dependents reads what the user sees. None with
 * View All Data and Modify All Data.
 *
 * @throws When the org would not describe the object, or what hangs from it.
 */
async function unseenUnder(
  access: ActAccess,
  told: Told,
  relationsOf: (objectApiName: string) => Promise<CheckpointDescribe>,
  worked: () => Promise<ReadonlyMap<string, string>>,
): Promise<RewindDiffUnseen | undefined> {
  if (access.kind === 'org') return undefined;
  const { objectApiName, toDelete } = told.diff;
  const records = toDelete.createdSince + toDelete.broughtBackSince;
  if (records === 0) return undefined;
  const described = await relationsOf(objectApiName);
  const cascading = (described.childRelationships ?? [])
    .filter((relationship) => relationship.cascadeDelete === true)
    .map((relationship) => relationship.childSObject);
  if (cascading.length === 0) return undefined;
  const workedIn = await worked();
  const children = [...new Set(cascading.filter((child) => workedIn.has(child)))].sort();
  const out = children.length > 0 ? await access.unseenOf(children) : [];
  // Activities first, then the others in order: a line that names only the
  // first of twenty children named Asset and AssociatedLocation, and left
  // Task in its "+12" (G-B2).
  const ordered = [...out].sort(
    (a, b) => Number(!OUT_OF_SIGHT_FIRST.has(a)) - Number(!OUT_OF_SIGHT_FIRST.has(b)),
  );
  return ordered.length > 0 ? { objectApiName, children: ordered, records } : undefined;
}

/** What a delete takes along out of sight that is named first: tasks and events, which have no View All. */
const OUT_OF_SIGHT_FIRST: ReadonlySet<string> = new Set(['Event', 'Task']);

/**
 * Of the records to delete, per object, those that go with a parent the first
 * pass deletes too, never sent on their own; and those Undo couldn't bring
 * back, written to the preview's folder, with why (`RewindUndoCannotReason`):
 *
 * - one whose parent the first pass deletes too, which the deletion takes
 *   along, goes with it, and comes back with it;
 * - one the first pass deletes on its own before a record it points at that
 *   it deletes next stays in the bin for good: one whose lookup restricts that
 *   record's delete, which cannot go first — a case's account, live — and one
 *   the deletion would not take along with its parent — made while the
 *   checkpoint was taken, brought back since, changed in the second the read
 *   began in — which the rewind deletes first, or its parent would be kept;
 * - of an object Salesforce undeletes only with its parent, one whose parent
 *   stays is deleted on its own, and stays in the bin. So is one that comes
 *   back with its parent to be deleted again: it hangs from a record brought
 *   back, which the first pass never deletes.
 *
 * A line of the folder names its record, and why when it is not the first of
 * the reasons, `onlyWithParent`, as the diff's counts do.
 */
async function withParentOf(
  previewDir: string,
  told: readonly Told[],
): Promise<Pick<RewindDiff, 'undoCannot'> & Required<Pick<RewindDiff, 'withParentDeleted'>>> {
  const wanted = new Set(
    told.flatMap(({ pending }) =>
      pending.flatMap(({ parents, restricts }) => [...parents, ...restricts]),
    ),
  );
  const deleted = new Set<string>();
  if (wanted.size > 0) {
    for (const each of told) {
      for await (const ids of deletedFirst(previewDir, each)) {
        for (const id of ids) {
          const key = id.slice(0, 15);
          if (wanted.has(key)) deleted.add(key);
        }
      }
    }
  }
  const undoCannot: RewindDiff['undoCannot'] = [];
  const withParentDeleted: NonNullable<RewindDiff['withParentDeleted']> = [];
  for (const { diff, pending } of told) {
    const objectApiName = diff.objectApiName;
    const along = (record: PendingUndo): boolean =>
      record.goesAlong && record.parents.some((parent) => deleted.has(parent));
    const goes = pending.filter(along).length;
    if (goes > 0) withParentDeleted.push({ objectApiName, count: goes });
    const alone = pending.filter((record) => !along(record));
    const beforeParent = alone.filter((record) =>
      [...record.parents, ...record.restricts].some((parent) => deleted.has(parent)),
    );
    const before = new Set(beforeParent.map(({ id }) => id));
    const onlyWithParent = alone.filter((record) => !record.undeletable && !before.has(record.id));
    if (onlyWithParent.length + beforeParent.length === 0) continue;
    const spool = new ClassSpool(classFileOf(previewDir, objectApiName, 'undoCannot'));
    for (const { id } of onlyWithParent) await spool.add({ Id: id });
    for (const { id } of beforeParent) await spool.add({ Id: id, reason: 'deletedBeforeParent' });
    await spool.flush();
    if (onlyWithParent.length > 0) undoCannot.push({ objectApiName, count: onlyWithParent.length });
    if (beforeParent.length > 0) {
      undoCannot.push({ objectApiName, count: beforeParent.length, reason: 'deletedBeforeParent' });
    }
  }
  return { undoCannot, withParentDeleted };
}

/**
 * The names of the users `ids` name, by user Id: one read of `User` for every
 * two hundred. A name the org does not give is left out, and the page shows
 * the Id: who changed what is told by the Ids already.
 *
 * @throws {OrgReadStopped} When the run was stopped.
 */
async function userNamesOf(
  reader: CompositeReader,
  ids: readonly string[],
  signal: AbortSignal | undefined,
): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  if (ids.length === 0) return names;
  const reads = idLists([...ids].sort()).map((list): ObjectRead => ({
    objectApiName: 'User',
    soql: `SELECT Id, Name FROM User WHERE Id IN (${list})`,
    scanAll: false,
  }));
  await readStreams(
    reader,
    reads,
    (_, rows) => {
      for (const row of rows) {
        if (typeof row.Id === 'string' && typeof row.Name === 'string') names[row.Id] = row.Name;
      }
    },
    signal,
  );
  return names;
}

/** Whether a rewind has anything to do with an object, or to say of it. */
function differs(diff: RewindDiffObject): boolean {
  const { toDelete, toGiveBack, toBringBack } = diff;
  return (
    toDelete.createdSince +
      toDelete.broughtBackSince +
      toDelete.comesBackWithParent +
      toGiveBack.records +
      toBringBack.inBin +
      toBringBack.withParent +
      toBringBack.deletedWhileTaken +
      (toBringBack.carriers ?? 0) +
      (diff.toRecreate ?? 0) +
      diff.touched +
      diff.unexplained +
      diff.cannotUndo.reduce((sum, item) => sum + item.count, 0) >
      0 || diff.schemaDrift !== undefined
  );
}

// ─── Files ───────────────────────────────────────────────────────────────────

/** The describe of a file's link, asked beside the objects' own. */
async function describedLink(reader: CompositeReader): Promise<CheckpointDescribe> {
  const answer = await reader.describe(FILE_LINK_OBJECT);
  const parsed = checkpointDescribeSchema.safeParse('body' in answer ? answer.body : null);
  if (!parsed.success) throw new Error(`The org gave no describe of ${FILE_LINK_OBJECT}.`);
  return parsed.data;
}

/** Where the preview of `previewDir` spools each class of each object. */
function classFilesOf(previewDir: string): (objectApiName: string, cls: RewindClass) => string {
  return (objectApiName, cls) => classFileOf(previewDir, objectApiName, cls);
}

/**
 * Which file a rewind acts on (`readFileAnchors`), read before any object is
 * told; or why the links could not be read, which the files' object is named
 * unread for: a file whose links were not read is none a rewind can tell
 * anchored, and none it may delete. Nothing when the files' own change reads
 * failed: their diff names why.
 *
 * @throws {OrgReadStopped} When the run was stopped.
 */
async function fileAnchorsOf(
  input: RewindDiffInput,
  parts: {
    previewDir: string;
    ordered: readonly CheckpointObject[];
    changes: ReadonlyMap<string, ObjectChanges>;
    linkDescribe: Promise<CheckpointDescribe>;
    fileObject: CheckpointObject;
    unread: ReadonlyMap<string, string>;
  },
): Promise<{ anchors: FileAnchors } | { unread: string } | undefined> {
  const name = parts.fileObject.objectApiName;
  const changed = parts.changes.get(name);
  if (parts.unread.has(name) || changed === undefined || 'unread' in changed) return undefined;
  try {
    return {
      anchors: await readFileAnchors({
        reader: input.reader,
        folder: input.folder,
        previewDir: parts.previewDir,
        snapshotId: input.checkpoint.snapshotId,
        objects: parts.ordered,
        changes: parts.changes,
        linkDescribe: parts.linkDescribe,
        describeGlobal: input.describeGlobal,
        ...(input.signal ? { signal: input.signal } : {}),
      }),
    };
  } catch (err: unknown) {
    if (err instanceof OrgReadStopped) throw err;
    return {
      unread:
        'The links of its files to the records of the checkpoint could not be read: ' +
        extractErrorMessage(err),
    };
  }
}

/** Remove the classes of the links a preview wrote: its files could not be told whole. */
async function discardLinkClasses(previewDir: string): Promise<void> {
  await Promise.all(
    (['linkAdded', 'linkRemoved', 'linkChanged'] as const).map((cls) =>
      rm(fileLinkClassFileOf(previewDir, cls), { force: true }),
    ),
  );
}

/**
 * What a rewind does about the checkpoint's files once every object is told
 * (`tellFiles`): what it adds to the diff of `ContentDocument` — the files
 * another user owns to delete, to bring back or gone for good, the new
 * versions — and the diff's files. A read that fails names the files' object
 * unread, its classes and the links' removed: nothing of them is acted on.
 *
 * @throws {OrgReadStopped} When the run was stopped.
 */
async function filesOf(
  input: RewindDiffInput,
  parts: {
    anchors: FileAnchors;
    fileObject: CheckpointObject;
    changes: ReadonlyMap<string, ObjectChanges>;
    outcomes: Map<string, ObjectOutcome>;
    ordered: readonly CheckpointObject[];
    previewDir: string;
    t0s: number;
  },
): Promise<RewindFilesDiff | undefined> {
  const name = parts.fileObject.objectApiName;
  const outcome = parts.outcomes.get(name);
  const fileChanges = parts.changes.get(name);
  if (outcome === undefined || !('told' in outcome) || fileChanges === undefined) return undefined;
  const told = new Set(
    [...parts.outcomes]
      .filter(([, each]) => 'told' in each)
      .map(([objectApiName]) => objectApiName),
  );
  try {
    const result = await tellFiles({
      anchors: parts.anchors,
      reader: input.reader,
      folder: input.folder,
      snapshotId: input.checkpoint.snapshotId,
      t0s: parts.t0s,
      objects: parts.ordered,
      fileChanges,
      told,
      classFileOf: classFilesOf(parts.previewDir),
      previewDir: parts.previewDir,
      queryAllFiles:
        input.checkpoint.takenBy?.queryAllFiles === true && input.queryAllFiles !== false,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const { diff, people } = outcome.told;
    diff.toDelete.createdSince += result.createdSince;
    diff.toBringBack.deletedWhileTaken += result.deletedWhileTaken;
    for (const row of result.changedBy) people.add(row);
    diff.lastChangedBy = people.byUser();
    const goneForGood = result.goneForGood;
    const newVersions = result.newFileVersion;
    const lost = diff.cannotUndo.find((cannot) => cannot.reason === 'goneForGood');
    if (lost !== undefined) lost.count += goneForGood;
    else if (goneForGood > 0)
      diff.cannotUndo.unshift({ reason: 'goneForGood', count: goneForGood });
    diff.cannotUndo.push(
      ...(newVersions > 0 ? [{ reason: 'newFileVersion' as const, count: newVersions }] : []),
    );
    return result.files;
  } catch (err: unknown) {
    if (err instanceof OrgReadStopped) throw err;
    await discardClasses(parts.previewDir, name);
    await discardLinkClasses(parts.previewDir);
    parts.outcomes.set(name, { unread: extractErrorMessage(err) });
    return undefined;
  }
}

/**
 * Of the files the rewind deletes, those linked as well to something the
 * checkpoint does not hold, counted among what its deletion takes along
 * outside the checkpoint (`outsideOfFiles`), as the links that go with them.
 * A read that fails names the files' object unread, as one whose other reads
 * of what its deletion takes along failed.
 *
 * @throws {OrgReadStopped} When the run was stopped.
 */
async function filesOutsideOf(
  input: RewindDiffInput,
  parts: {
    anchors: FileAnchors;
    fileObject: CheckpointObject;
    outcomes: Map<string, ObjectOutcome>;
    previewDir: string;
  },
): Promise<void> {
  const name = parts.fileObject.objectApiName;
  const outcome = parts.outcomes.get(name);
  if (outcome === undefined || !('told' in outcome)) return;
  const { diff } = outcome.told;
  if (diff.toDelete.createdSince + diff.toDelete.broughtBackSince === 0) return;
  try {
    const { links, files } = await outsideOfFiles({
      anchors: parts.anchors,
      reader: input.reader,
      classFileOf: classFilesOf(parts.previewDir),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (links === 0) return;
    diff.outside = [
      ...diff.outside.filter(({ objectApiName }) => objectApiName !== FILE_LINK_OBJECT),
      { objectApiName: FILE_LINK_OBJECT, count: links, parents: files },
    ].sort((a, b) =>
      a.objectApiName < b.objectApiName ? -1 : a.objectApiName > b.objectApiName ? 1 : 0,
    );
  } catch (err: unknown) {
    if (err instanceof OrgReadStopped) throw err;
    await discardClasses(parts.previewDir, name);
    await discardLinkClasses(parts.previewDir);
    parts.outcomes.set(name, { unread: extractErrorMessage(err) });
  }
}

/**
 * What a rewind to a checkpoint would do, read from the org now: see the
 * module's comment. The objects are diffed in the checkpoint's reading order,
 * one at a time, each one's sets released before the next; what comes back
 * with a parent, what names a parent brought back, and a person account's
 * contact are read before any of them, and what its deletions take along and
 * Undo couldn't bring back once all of them are told.
 *
 * @throws {OrgReadStopped} When the run was stopped.
 * @throws When the checkpoint names no date it was taken from, or the read none it began at.
 */
export async function rewindDiff(input: RewindDiffInput): Promise<RewindDiff> {
  const { checkpoint, folder, reader, previewId, readAt, signal } = input;
  const t0 = Date.parse(checkpoint.readFrom);
  if (!Number.isFinite(t0)) throw new Error(`Not a date: ${checkpoint.readFrom}`);
  const tr = Date.parse(readAt);
  if (!Number.isFinite(tr)) throw new Error(`Not a date: ${readAt}`);
  if (signal?.aborted) throw new OrgReadStopped();
  const t0s = t0 - (((t0 % 1000) + 1000) % 1000);
  const previewDir = previewDirOf(folder, previewId);
  await makePrivateDir(previewDir);

  const ordered = [...checkpoint.objects].sort((a, b) => a.readOrder - b.readOrder);
  // An object its user no longer holds whole is not read at all.
  const access = input.access ?? ORG_ACCESS;
  const held = ordered.filter(({ objectApiName }) => !access.notHeld.has(objectApiName));
  const bodies = new Map<string, CheckpointDescribe>();
  // A checkpoint that holds files reads their links too: the describe of a
  // link, which names the objects a link may tie a file to, asked with the
  // objects' own so that it goes in the same call.
  const fileObject =
    checkpoint.files !== undefined
      ? held.find(({ objectApiName }) => isFile(objectApiName))
      : undefined;
  const linkDescribe = fileObject !== undefined ? describedLink(reader) : undefined;
  linkDescribe?.catch(() => undefined);
  const { now: fieldsNow, requests: fieldsRequests } = await fieldsNowOf(input, held, bodies);
  const unread = new Map<string, string>();
  const readable: Array<{ object: CheckpointObject; fields: FieldsNow }> = [];
  for (const object of ordered) {
    const notHeld = access.notHeld.get(object.objectApiName);
    if (notHeld !== undefined) {
      unread.set(object.objectApiName, notHeld);
      continue;
    }
    const now = fieldsNow.get(object.objectApiName);
    if (now === undefined || 'unread' in now) {
      unread.set(object.objectApiName, now?.unread ?? 'Its describe was not read.');
    } else {
      readable.push({ object, fields: now });
    }
  }

  const read = await readChanges(
    reader,
    readable.map(({ object, fields }) => ({
      objectApiName: object.objectApiName,
      readMode: object.readMode,
      held: object.records > 0,
      fields: changeReadFields(object, fields.gone),
    })),
    checkpoint.readFrom,
    previewDir,
    signal,
  );
  const changes = new Map(readable.map(({ object }, at) => [object.objectApiName, read[at]]));

  const asked = new Map<string, Promise<CheckpointDescribe>>();
  const relationsOf = (objectApiName: string): Promise<CheckpointDescribe> => {
    const body = bodies.get(objectApiName);
    if (body) return Promise.resolve(body);
    let describing = asked.get(objectApiName);
    if (!describing) {
      describing = (async () => {
        const answer = await reader.describe(objectApiName);
        const parsed = checkpointDescribeSchema.safeParse('body' in answer ? answer.body : null);
        if (!parsed.success) throw new Error(`The org gave no describe of ${objectApiName}.`);
        return parsed.data;
      })();
      asked.set(objectApiName, describing);
    }
    return describing;
  };

  const { back, gone } = await toBringBackOf({ input, t0s }, ordered, changes);
  // Told before anything leaves `back`, whose stamps tell what is stuck.
  const others = othersOf(back, access.userKey);
  const deleted = new Map([...gone, ...back]);
  const stuck = stuckOf(back, gone);
  // What the org answered an earlier rewind is no longer in the recycle bin,
  // though it still lists it there: no read tells it from what the bin holds
  // (P11), its answer did.
  const notInBin = await NotInBin.read(folder);
  for (const key of notInBin.keys()) if (back.has(key) || gone.has(key)) stuck.add(key);
  // Those, and what went with them, apart: of an object held through what
  // it hangs from, read object by object, they are out of reach.
  const answeredGone = wentWith(
    [...notInBin.keys()].filter((key) => deleted.has(key)),
    deleted,
  );
  stuckWith(stuck, back, gone);
  // What another user deleted stays in the bin, stuck or not, and brings
  // nothing back with it: no carrier is told for it.
  for (const key of others) {
    back.delete(key);
    stuck.delete(key);
  }
  const carriers = carriersOf(ordered, back, gone);
  const compared = new Map(
    readable.map(({ object, fields }) => [
      object.objectApiName,
      comparedFields(object.objectApiName, object.fields, checkpoint.ignoredFields).filter(
        (field) => !fields.gone.has(field.toLowerCase()),
      ),
    ]),
  );
  // The objects of what it brings back described, then what went with a
  // parent outside the checkpoint told: a snapshot row is compared for a
  // lookup naming only what still comes back once that is told.
  const lookups = await lookupsOf(back, compared, relationsOf, unread);
  const outsideOfCheckpoint = await parentsOutsideOf(
    input,
    readable.map(({ object }) => object),
    back,
    gone,
    carriers,
    relationsOf,
  );
  for (const key of outsideOfCheckpoint.stuck) stuck.add(key);
  stuckWith(stuck, back, gone);
  for (const key of [...carriers]) if (!back.has(key)) carriers.delete(key);
  const stranded = strandedOf(back, gone, outsideOfCheckpoint.outside);
  // Which file a rewind acts on, told before any object is: the links of the
  // checkpoint, and those of its records now.
  let filesRequests = 0;
  const filesSince = reader.calls();
  const anchored =
    fileObject !== undefined && linkDescribe !== undefined
      ? await fileAnchorsOf(input, {
          previewDir,
          ordered,
          changes,
          linkDescribe,
          fileObject,
          unread,
        })
      : undefined;
  filesRequests += reader.calls() - filesSince;
  const anchors = anchored !== undefined && 'anchors' in anchored ? anchored.anchors : undefined;

  const context: DiffContext = {
    input,
    previewDir,
    t0s,
    activeFrom: tr - ACTIVE_WINDOW_MS,
    back,
    carriers,
    stranded,
    stuck,
    answeredGone,
    others,
    access,
    lookups,
    personAccounts: await personAccountsOf(ordered, changes),
    ...(anchors !== undefined ? { files: anchors } : {}),
  };

  const outcomes = new Map<string, ObjectOutcome>();
  for (const { object, fields } of readable) {
    if (signal?.aborted) throw new OrgReadStopped();
    const early =
      unread.get(object.objectApiName) ??
      (anchored !== undefined && 'unread' in anchored && object === fileObject
        ? anchored.unread
        : undefined);
    const changed = changes.get(object.objectApiName);
    outcomes.set(
      object.objectApiName,
      early !== undefined || changed === undefined
        ? { unread: early ?? 'Its changes were not read.' }
        : await diffObject(context, object, changed, fields),
    );
  }

  // The files another user owns, the new versions, the links, the storage.
  let files: RewindFilesDiff | undefined;
  if (anchors !== undefined && fileObject !== undefined) {
    const since = reader.calls();
    files = await filesOf(input, {
      anchors,
      fileObject,
      changes,
      outcomes,
      ordered,
      previewDir,
      t0s,
    });
    filesRequests += reader.calls() - since;
  }

  // What its deletions take along outside the checkpoint: a file's links and
  // versions are held with it, by a checkpoint that holds files.
  const inCheckpoint = new Set(ordered.map(({ objectApiName }) => objectApiName.toLowerCase()));
  if (checkpoint.files !== undefined && fileObject !== undefined) {
    for (const held of [FILE_LINK_OBJECT, FILE_VERSION_OBJECT])
      inCheckpoint.add(held.toLowerCase());
  }
  let worked: Promise<ReadonlyMap<string, string>> | undefined;
  const workedNow = (): Promise<ReadonlyMap<string, string>> =>
    (worked ??= workedObjects({ describeGlobal: input.describeGlobal }));
  const unseen: RewindDiffUnseen[] = [];
  for (const [objectApiName, outcome] of outcomes) {
    if (!('told' in outcome)) continue;
    const { toDelete } = outcome.told.diff;
    if (toDelete.createdSince + toDelete.broughtBackSince === 0) continue;
    try {
      outcome.told.diff.outside = await outsideOf(
        context,
        outcome.told,
        relationsOf,
        workedNow,
        inCheckpoint,
      );
      const under = await unseenUnder(access, outcome.told, relationsOf, workedNow);
      if (under !== undefined) unseen.push(under);
    } catch (err: unknown) {
      if (err instanceof OrgReadStopped) throw err;
      await discardClasses(previewDir, objectApiName);
      outcomes.set(objectApiName, { unread: extractErrorMessage(err) });
    }
  }
  // And of the files it deletes, their links to anything else the
  // checkpoint does not hold: a library, a group, a record of another object.
  if (anchors !== undefined && fileObject !== undefined) {
    const since = reader.calls();
    await filesOutsideOf(input, { anchors, fileObject, outcomes, previewDir });
    filesRequests += reader.calls() - since;
    if (!('told' in (outcomes.get(fileObject.objectApiName) ?? { unread: '' }))) files = undefined;
  }

  const told = ordered.flatMap(({ objectApiName }) => {
    const outcome = outcomes.get(objectApiName);
    return outcome && 'told' in outcome ? [outcome.told] : [];
  });
  const { undoCannot, withParentDeleted } = await withParentOf(previewDir, told);
  // Of an object read whole: one whose files' reads failed since is not.
  const toldNames = new Set(told.map(({ diff }) => diff.objectApiName));
  const stillUnseen = unseen.filter(({ objectApiName }) => toldNames.has(objectApiName));
  const users = [...new Set(told.flatMap(({ diff }) => Object.keys(diff.lastChangedBy)))];
  const userNames = await userNamesOf(reader, users, signal);
  const active = new Set(told.flatMap(({ people }) => [...people.active]));

  return {
    checkpointId: checkpoint.checkpointId,
    previewId,
    readAt,
    objects: told.map(({ diff }) => diff).filter(differs),
    undoCannot,
    ...(withParentDeleted.length > 0 ? { withParentDeleted } : {}),
    ...(outsideOfCheckpoint.requests > 0
      ? { parentsOutsideRequests: outsideOfCheckpoint.requests }
      : {}),
    ...(fieldsRequests > 0 ? { fieldsRequests } : {}),
    ...(files !== undefined ? { files } : {}),
    ...(fileObject !== undefined ? { filesRequests } : {}),
    access: access.diffAccess(),
    ...(stillUnseen.length > 0 ? { unseen: stillUnseen } : {}),
    unread: ordered.flatMap(({ objectApiName }) => {
      const outcome = outcomes.get(objectApiName);
      const reason =
        outcome && 'unread' in outcome
          ? outcome.unread
          : outcome
            ? undefined
            : unread.get(objectApiName);
      return reason === undefined ? [] : [{ objectApiName, reason }];
    }),
    userNames,
    activeLastHour: [...active].sort(),
  };
}
