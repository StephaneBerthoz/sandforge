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
 *   deleted after it: Salesforce keeps such a record in the bin for good;
 * - in `L` and `S`, a lead converted since: Salesforce cannot unconvert it and
 *   refuses any update of it, so it is named, never given back;
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
 *   that could not be read. A field added since is left alone; one whose
 *   type changed is compared still, and named;
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
 * An object any of whose reads failed is named "could not be read", never
 * taken for one that did not change: a rewind leaves it as it is.
 *
 * The ids of each class are written to the preview's folder as they are told,
 * `<Object>.<class>.ndjson`, one `{"Id"}` line each and nothing held whole: a
 * rewind acts on what its preview confirmed that still differs, class by
 * class, by id. A line given back names the fields that differ, and of them
 * the lookups a deletion cleared.
 */

import { appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  sanitizeSoqlObjectName,
  type CheckpointObject,
  type OrgCheckpoint,
  type RewindDiff,
  type RewindDiffObject,
  type RewindSchemaDrift,
} from '@sandforge/shared';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { ACCOUNT, CONTACT } from '../../core/common/platformRecords.js';
import { readColumnsApart } from '../../core/common/wideRead.js';
import { idLists, RECORDS_PER_CALL, workedObjects } from '../dataops/RecordRemoval.js';
import { orgDateTime } from '../sync/SyncDelta.js';
import { sameValue } from '../sync/SyncRunRestore.js';
import {
  PERSON_ACCOUNT_FLAG,
  checkpointDescribeSchema,
  comparedFields,
  ignoredFieldsOf,
  isPersonContact,
  readModeOf,
  type CheckpointDescribe,
} from './checkpointFields.js';
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
import { GoneForGood, SNAPSHOT_CHUNK_IDS, SnapshotIndex, snapshotFileOf } from './snapshotIndex.js';

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
 * - `goneForGood`: deleted since and no longer in the bin, in it in an
 *   object Salesforce undeletes only with a parent that is not coming back,
 *   or in it where Salesforce keeps it for good (`stuckOf`): named, it cannot
 *   come back with its id;
 * - `convertedLead`: a lead converted since, which Salesforce cannot
 *   unconvert and refuses any update of: named, never given back;
 * - `undoCannot`: of the records to delete, those Undo couldn't bring back,
 *   a line naming why when it is not `onlyWithParent`. Not a class of its
 *   own: each of its records is in a class to delete too;
 * - `outsideParents`: of the records to delete, those records outside the
 *   checkpoint created since T1 hang from, which their deletion takes along.
 *   Not a class of its own either: a rewind of picked objects keeps them
 *   unless the deletion of what hangs from them is accepted.
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
  | 'goneForGood'
  | 'convertedLead'
  | 'undoCannot'
  | 'outsideParents';

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
  'goneForGood',
  'convertedLead',
  'undoCannot',
  'outsideParents',
];

/** The object of a lead, and its flag a conversion sets for good. */
const LEAD = 'Lead';
const CONVERTED_FLAG = 'IsConverted';

/** The classes of the records a rewind deletes in its first pass. */
const DELETED_FIRST = ['createdSince', 'broughtBackSince'] as const;

/** Where a preview keeps the ids of one class of one object. */
export function classFileOf(previewDir: string, objectApiName: string, cls: RewindClass): string {
  return join(previewDir, `${sanitizeSoqlObjectName(objectApiName)}.${cls}.ndjson`);
}

/** What a diff since a checkpoint reads from. */
export interface RewindDiffInput {
  checkpoint: Pick<
    OrgCheckpoint,
    'checkpointId' | 'readFrom' | 'takenAt' | 'objects' | 'ignoredFields' | 'snapshotId'
  >;
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

/** Whether a field holds no value: a lookup the org cleared. */
function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

/** The snapshot's own spelling of a field, whatever the case it is asked in; none when it holds none. */
function heldField(fields: readonly string[], name: string): string | undefined {
  const wanted = name.toLowerCase();
  return fields.find((field) => field.toLowerCase() === wanted);
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
  /** The fields deleted or hidden since, in lower case: neither read nor compared. */
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
  stamp: number;
  parents: string[];
  restricts: string[];
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
   * By key, the records deleted since that the bin holds and Salesforce will
   * not let out of it (`stuckOf`): gone for good, never to bring back.
   */
  stuck: ReadonlySet<string>;
  /** By object, the lookups of its snapshot rows that may name a record of {@link back}. */
  lookups: ReadonlyMap<string, readonly string[]>;
  /**
   * The accounts, by key, of the person contacts that moved since: their
   * fields are the account's, which is compared whatever its own stamp says.
   * The account's diff takes them out as it compares them.
   */
  personAccounts: Set<string>;
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

// ─── The objects' fields now ─────────────────────────────────────────────────

/**
 * Each of `objects` described again, asked whether it changed since a day
 * before T0, and what changed in its fields printed against the take's: see
 * the module's comment. An object whose describe the org would not give, or
 * whose prints this machine no longer holds, could not be read.
 *
 * @param bodies - Filled with every describe the org answered in full.
 * @throws {OrgReadStopped} When the run was stopped.
 */
async function fieldsNowOf(
  input: RewindDiffInput,
  objects: readonly CheckpointObject[],
  bodies: Map<string, CheckpointDescribe>,
): Promise<Map<string, FieldsNow | { unread: string }>> {
  const { checkpoint, folder, reader } = input;
  const since = new Date(Date.parse(checkpoint.readFrom) - DESCRIBED_SINCE_MS).toISOString();
  const answers = await Promise.allSettled(
    objects.map(({ objectApiName }) => reader.describe(objectApiName, since)),
  );
  let prints: Promise<Map<string, ObjectFingerprint>> | undefined;
  const now = new Map<string, FieldsNow | { unread: string }>();
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
      const { removed, added, changed } = schemaDrift(then, fingerprintOf(parsed.data.fields));
      now.set(name, {
        ...(removed.length + added.length + changed.length > 0
          ? { drift: { removed, added, changed } }
          : {}),
        gone: new Set(removed.map((field) => field.toLowerCase())),
      });
    } catch (err: unknown) {
      now.set(name, { unread: extractErrorMessage(err) });
    }
  }
  return now;
}

/**
 * What the change reads of an object read beside the stamps: the fields whose
 * parent's delete takes a record along, which tell what comes back with a
 * parent, and those whose parent's delete a live record refuses, which tell
 * what a rewind deletes before a record it points at; on a contact of an org
 * with person accounts, the flag and the account, which tell a person
 * account's contact; and who last changed each record, when. Never a field
 * gone since: a read that names one is refused whole.
 */
function changeReadFields(object: CheckpointObject, gone: ReadonlySet<string>): string[] {
  const fields = [...object.cascadeParents, ...(object.restrictParents ?? [])].filter(
    (field) => !gone.has(field.toLowerCase()),
  );
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
 * @throws {OrgReadStopped} When the run was stopped.
 */
async function toBringBackOf(
  context: Pick<DiffContext, 'input' | 't0s'>,
  objects: readonly CheckpointObject[],
  changes: ReadonlyMap<string, ObjectChanges>,
): Promise<Map<string, ToBringBack>> {
  const { folder, checkpoint } = context.input;
  const back = new Map<string, ToBringBack>();
  for (const { objectApiName, cascadeParents, restrictParents = [] } of objects) {
    const changed = changes.get(objectApiName);
    if (!changed || 'unread' in changed || !changed.deleted || changed.deleted.rows === 0) continue;
    const found = new Map<string, ToBringBack>();
    try {
      const index = await SnapshotIndex.read(folder, checkpoint.snapshotId, objectApiName);
      const inBinAtCheckpoint = binAtCheckpoint(folder, objectApiName);
      for await (const row of spooledRows(changed.deleted.file)) {
        const key = keyOf(row.Id);
        if (key === undefined) continue;
        if (!index.has(row.Id)) {
          if (await inBinAtCheckpoint(key)) continue;
          if (!(dateMs(row.CreatedDate) < context.t0s)) continue;
        }
        const keysOf = (fields: readonly string[]): string[] =>
          fields
            .map((field) => keyOf(row[field]))
            .filter((parent): parent is string => parent !== undefined && parent !== key);
        found.set(key, {
          objectApiName,
          stamp: dateMs(row.SystemModstamp),
          parents: keysOf(cascadeParents),
          restricts: keysOf(restrictParents),
        });
      }
    } catch (err: unknown) {
      if (err instanceof OrgReadStopped) throw err;
      continue;
    }
    for (const [key, record] of found) back.set(key, record);
  }
  return back;
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
 * Told only of a parent the rewind brings back, the one whose stamp the read
 * holds: one outside the checkpoint, or brought back and deleted again since,
 * leaves its child to bring back, and the org's refusal named.
 */
function stuckOf(back: Map<string, ToBringBack>): Set<string> {
  const stuck = new Set<string>();
  for (const [key, record] of back) {
    const after = [...record.parents, ...record.restricts].some(
      (parent) => (back.get(parent)?.stamp ?? 0) > record.stamp,
    );
    if (after) stuck.add(key);
  }
  // What went with a record stuck in the bin, in its second, stays with it.
  for (let grew = stuck.size > 0; grew;) {
    grew = false;
    for (const [key, record] of back) {
      if (stuck.has(key)) continue;
      const withStuck = record.parents.some(
        (parent) => stuck.has(parent) && back.get(parent)?.stamp === record.stamp,
      );
      if (withStuck) {
        stuck.add(key);
        grew = true;
      }
    }
  }
  for (const key of stuck) back.delete(key);
  return stuck;
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
  const { input, previewDir, t0s, back, stuck, personAccounts } = context;
  const { folder, reader, checkpoint, signal } = input;
  const objectApiName = object.objectApiName;
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
    const columns = [
      'Id',
      'SystemModstamp',
      ...WHO_COLUMNS,
      ...compared,
      ...(convertedRead !== undefined && !compared.includes(convertedRead) ? [convertedRead] : []),
    ];
    const cascade = object.cascadeParents.filter((field) => !gone.has(field.toLowerCase()));
    const restrict = (object.restrictParents ?? []).filter(
      (field) => !gone.has(field.toLowerCase()),
    );
    const holdsPersons =
      objectApiName === CONTACT && heldField(object.fields, PERSON_ACCOUNT_FLAG) !== undefined;
    const isPerson = (row: OrgRow): boolean => holdsPersons && isPersonContact(objectApiName, row);
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
    // field whose parent's delete takes it along: it went with that parent.
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
      const file = snapshotFileOf(folder, checkpoint.snapshotId, objectApiName);
      for await (const row of spooledRows(file)) {
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
          if (person) continue;
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
        if (await inBinAtCheckpoint(key)) {
          await spool('broughtBackSince').add({ Id: id });
          toDelete(row, id, key, true);
        } else if (dateMs(row.CreatedDate) >= t0s) {
          await spool('createdSince').add({ Id: id });
          toDelete(row, id, key, true);
        } else {
          await spool('unexplained').add({ Id: id });
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
        // Brought back with its account, which alone is sent.
        const person = isPerson(row);
        if (index.has(id)) {
          tally.deletedHeld++;
          if (person) continue;
          // Salesforce keeps it in the bin for good.
          if (stuck.has(key)) await spool('goneForGood').add({ Id: id });
          else if (wentWithParent(row, key)) await spool('withParent').add({ Id: id });
          else if (object.undeletable) await spool('inBin').add({ Id: id });
          // Salesforce brings it back with its parent only, and its parent
          // is not coming back.
          else await spool('goneForGood').add({ Id: id });
          continue;
        }
        if (person || (await inBinAtCheckpoint(key))) continue;
        // Live at T0 and gone before its object was read. One created since
        // and deleted since leaves nothing to rewind, unless it went with a
        // parent the rewind brings back: it comes back with it.
        if (dateMs(row.CreatedDate) < t0s) {
          await spool(stuck.has(key) ? 'goneForGood' : 'deletedWhileTaken').add({ Id: id });
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
          if (!persons.has(id.slice(0, 15))) await spool('goneForGood').add({ Id: id });
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
    const goneForGood = countOf('goneForGood');
    const convertedSince = countOf('convertedLead');
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
      },
      cannotUndo: [
        ...(goneForGood > 0 ? [{ reason: 'goneForGood' as const, count: goneForGood }] : []),
        ...(convertedSince > 0
          ? [{ reason: 'convertedLead' as const, count: convertedSince }]
          : []),
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
  const relationships = cascades.filter((relationship) => workedIn.has(relationship.childSObject));
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
      diff.touched +
      diff.unexplained +
      diff.cannotUndo.reduce((sum, item) => sum + item.count, 0) >
      0 || diff.schemaDrift !== undefined
  );
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
  const bodies = new Map<string, CheckpointDescribe>();
  const fieldsNow = await fieldsNowOf(input, ordered, bodies);
  const unread = new Map<string, string>();
  const readable: Array<{ object: CheckpointObject; fields: FieldsNow }> = [];
  for (const object of ordered) {
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

  const back = await toBringBackOf({ input, t0s }, ordered, changes);
  const stuck = stuckOf(back);
  const compared = new Map(
    readable.map(({ object, fields }) => [
      object.objectApiName,
      comparedFields(object.objectApiName, object.fields, checkpoint.ignoredFields).filter(
        (field) => !fields.gone.has(field.toLowerCase()),
      ),
    ]),
  );
  const lookups = await lookupsOf(back, compared, relationsOf, unread);
  const context: DiffContext = {
    input,
    previewDir,
    t0s,
    activeFrom: tr - ACTIVE_WINDOW_MS,
    back,
    stuck,
    lookups,
    personAccounts: await personAccountsOf(ordered, changes),
  };

  const outcomes = new Map<string, ObjectOutcome>();
  for (const { object, fields } of readable) {
    if (signal?.aborted) throw new OrgReadStopped();
    const early = unread.get(object.objectApiName);
    const changed = changes.get(object.objectApiName);
    outcomes.set(
      object.objectApiName,
      early !== undefined || changed === undefined
        ? { unread: early ?? 'Its changes were not read.' }
        : await diffObject(context, object, changed, fields),
    );
  }

  // What its deletions take along outside the checkpoint.
  const inCheckpoint = new Set(ordered.map(({ objectApiName }) => objectApiName.toLowerCase()));
  let worked: Promise<ReadonlyMap<string, string>> | undefined;
  const workedNow = (): Promise<ReadonlyMap<string, string>> =>
    (worked ??= workedObjects({ describeGlobal: input.describeGlobal }));
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
    } catch (err: unknown) {
      if (err instanceof OrgReadStopped) throw err;
      await discardClasses(previewDir, objectApiName);
      outcomes.set(objectApiName, { unread: extractErrorMessage(err) });
    }
  }

  const told = ordered.flatMap(({ objectApiName }) => {
    const outcome = outcomes.get(objectApiName);
    return outcome && 'told' in outcome ? [outcome.told] : [];
  });
  const { undoCannot, withParentDeleted } = await withParentOf(previewDir, told);
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
