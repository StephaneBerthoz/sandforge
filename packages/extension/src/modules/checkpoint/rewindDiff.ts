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
 * - in `D` and `S`: deleted since, in the bin, brought back — by a rewind of
 *   its own, or with its parent for an object Salesforce undeletes only so;
 * - in `D`, in neither, created before T0's second: live at T0, gone before
 *   its object was read — deleted while the checkpoint was taken, brought back
 *   with the values it had when deleted, as the snapshot holds none. A record
 *   deleted in T0's own second, before T0, reads so too: brought back, never
 *   lost;
 * - in `D` and `B0`: in the bin at the checkpoint; in `D` alone, created
 *   since: created and deleted since. Neither is anything to rewind.
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
 * An object any of whose reads failed is named "could not be read", never
 * taken for one that did not change: a rewind leaves it as it is.
 *
 * The ids of each class are written to the preview's folder as they are told,
 * `<Object>.<class>.ndjson`, one `{"Id"}` line each and nothing held whole: a
 * rewind acts on what its preview confirmed that still differs, class by
 * class, by id.
 */

import { appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  sanitizeSoqlObjectName,
  type CheckpointObject,
  type OrgCheckpoint,
  type RewindDiff,
  type RewindDiffObject,
} from '@sandforge/shared';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { readColumnsApart } from '../../core/common/wideRead.js';
import { idLists, RECORDS_PER_CALL } from '../dataops/RecordRemoval.js';
import { orgDateTime } from '../sync/SyncDelta.js';
import { sameValue } from '../sync/SyncRunRestore.js';
import { comparedFields } from './checkpointFields.js';
import { OrgReadStopped, type CompositeReader, type OrgRow } from './compositeQueries.js';
import {
  CHECKPOINT_FILE_MODE,
  binFileOf,
  makePrivateDir,
  previewDirOf,
  type CheckpointFolder,
} from './OrgCheckpointStore.js';
import {
  idScanRead,
  readChanges,
  readStreams,
  spooledRows,
  streamRead,
  type ObjectChanges,
} from './orgStreams.js';
import { GoneForGood, SNAPSHOT_CHUNK_IDS, SnapshotIndex } from './snapshotIndex.js';

/**
 * The classes a record is told into, each with its file in the preview's
 * folder:
 *
 * - `giveBack`: changed since, a compared field differs; its line names them;
 * - `touched`: stamped since over its checkpoint values;
 * - `createdSince`, `broughtBackSince`: to delete;
 * - `unexplained`: live, not held, dated before the checkpoint: left, named;
 * - `inBin`, `withParent`, `deletedWhileTaken`: to bring back, on its own,
 *   with its parent, or with the values it had when deleted;
 * - `goneForGood`: deleted since and no longer in the bin: named.
 */
export type RewindClass =
  | 'giveBack'
  | 'touched'
  | 'createdSince'
  | 'broughtBackSince'
  | 'unexplained'
  | 'inBin'
  | 'withParent'
  | 'deletedWhileTaken'
  | 'goneForGood';

/** Where a preview keeps the ids of one class of one object. */
export function classFileOf(previewDir: string, objectApiName: string, cls: RewindClass): string {
  return join(previewDir, `${sanitizeSoqlObjectName(objectApiName)}.${cls}.ndjson`);
}

/** What a diff since a checkpoint reads from. */
export interface RewindDiffInput {
  checkpoint: Pick<
    OrgCheckpoint,
    'checkpointId' | 'readFrom' | 'objects' | 'ignoredFields' | 'snapshotId'
  >;
  /** The checkpoint's folder: its snapshot, index and bin files. */
  folder: CheckpointFolder;
  /** The org, read through composites. */
  reader: CompositeReader;
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

/** Columns past which a read by id names fewer records per query, as a restore reads them. */
const WIDE_COLUMNS = 100;

/** Lines a class's file is written by at a time. */
const SPOOL_LINES = 2_000;

/** The key the org knows a record by: its id's first fifteen characters. */
function keyOf(id: unknown): string | undefined {
  return typeof id === 'string' && id.length >= 15 ? id.slice(0, 15) : undefined;
}

/** A date as the org gives it, `+0000` or `Z`, in milliseconds; NaN for anything else. */
function dateMs(value: unknown): number {
  const at = orgDateTime(value);
  return at === null ? Number.NaN : Date.parse(at);
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

/**
 * A record of `L` the snapshot holds whose values decide: the stamp the
 * snapshot read it with, and the one the change read found.
 */
interface Candidate {
  id: string;
  key: string;
  held: number;
  stamp: number;
}

/** What one object's diff came to: what a rewind would do, or why it could not be read. */
type ObjectOutcome = { diff: RewindDiffObject } | { unread: string };

/** What every object of a diff shares. */
interface DiffContext {
  input: RewindDiffInput;
  previewDir: string;
  /** T0's second, in milliseconds: what `CreatedDate` is compared with. */
  t0s: number;
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

/** The counts of one object, as the classes fill. */
interface Tally {
  fields: number;
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
): Promise<ObjectOutcome> {
  if ('unread' in changes) return { unread: changes.unread };
  const { input, previewDir, t0s } = context;
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

  try {
    const index = await SnapshotIndex.read(folder, checkpoint.snapshotId, objectApiName);
    const inBinAtCheckpoint = binAtCheckpoint(folder, objectApiName);
    const compared = comparedFields(objectApiName, object.fields, checkpoint.ignoredFields).map(
      assertSoqlIdentifier,
    );
    const columns = ['Id', 'SystemModstamp', ...compared];
    const sameSecondFrom = t0s - ORG_DATE_GRAIN_MS;
    const tally: Tally = { fields: 0, liveNotHeld: 0, deletedHeld: 0 };
    const recordOf = (row: OrgRow): { id: string; key: string } => {
      const key = keyOf(row.Id);
      if (key === undefined) throw new Error(`${objectApiName} answered a record without its Id.`);
      return { id: String(row.Id), key };
    };

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
        const differ = compared.filter((field) => !sameValue(then[field], current[field]));
        if (differ.length > 0) {
          tally.fields += differ.length;
          await spool('giveBack').add({ Id: candidate.id, fields: differ });
        } else if (dateMs(current.SystemModstamp) !== candidate.held) {
          await spool('touched').add({ Id: candidate.id });
        }
      }
    };

    if (changes.live) {
      let candidates: Candidate[] = [];
      for await (const row of spooledRows(changes.live.file)) {
        const { id, key } = recordOf(row);
        const held = index.stampOf(id);
        if (held !== undefined) {
          const stamp = dateMs(row.SystemModstamp);
          if (stamp !== held || held >= sameSecondFrom) {
            candidates.push({ id, key, held, stamp });
            if (candidates.length >= SNAPSHOT_CHUNK_IDS) {
              await decide(candidates);
              candidates = [];
            }
          }
          continue;
        }
        tally.liveNotHeld++;
        if (await inBinAtCheckpoint(key)) await spool('broughtBackSince').add({ Id: id });
        else if (dateMs(row.CreatedDate) >= t0s) await spool('createdSince').add({ Id: id });
        else await spool('unexplained').add({ Id: id });
      }
      await decide(candidates);
    }

    if (changes.deleted) {
      for await (const row of spooledRows(changes.deleted.file)) {
        const { id, key } = recordOf(row);
        if (index.has(id)) {
          tally.deletedHeld++;
          await spool(object.undeletable ? 'inBin' : 'withParent').add({ Id: id });
          continue;
        }
        if (await inBinAtCheckpoint(key)) continue;
        // Live at T0 and gone before its object was read; one created since and
        // deleted since leaves nothing to rewind.
        if (dateMs(row.CreatedDate) < t0s) await spool('deletedWhileTaken').add({ Id: id });
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
      for (const id of gone.ids()) await spool('goneForGood').add({ Id: id });
    }

    for (const held of spools.values()) await held.flush();
    const goneForGood = countOf('goneForGood');
    const diff: RewindDiffObject = {
      objectApiName,
      toDelete: {
        createdSince: countOf('createdSince'),
        broughtBackSince: countOf('broughtBackSince'),
        comesBackWithParent: 0,
      },
      toGiveBack: { records: countOf('giveBack'), fields: tally.fields, clearedLookups: 0 },
      toBringBack: {
        inBin: countOf('inBin'),
        withParent: countOf('withParent'),
        deletedWhileTaken: countOf('deletedWhileTaken'),
      },
      cannotUndo: goneForGood > 0 ? [{ reason: 'goneForGood', count: goneForGood }] : [],
      outside: [],
      touched: countOf('touched'),
      unexplained: countOf('unexplained'),
      lastChangedBy: {},
      notCompared: [],
    };
    return { diff };
  } catch (err: unknown) {
    for (const held of spools.values()) await held.discard();
    if (err instanceof OrgReadStopped) throw err;
    return { unread: extractErrorMessage(err) };
  }
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
    0
  );
}

/**
 * What a rewind to a checkpoint would do, read from the org now: see the
 * module's comment. The objects are diffed in the checkpoint's reading order,
 * one at a time, each one's sets released before the next.
 *
 * @throws {OrgReadStopped} When the run was stopped.
 * @throws When the checkpoint names no date it was taken from.
 */
export async function rewindDiff(input: RewindDiffInput): Promise<RewindDiff> {
  const { checkpoint, folder, reader, previewId, readAt, signal } = input;
  const t0 = Date.parse(checkpoint.readFrom);
  if (!Number.isFinite(t0)) throw new Error(`Not a date: ${checkpoint.readFrom}`);
  const t0s = t0 - (((t0 % 1000) + 1000) % 1000);
  const previewDir = previewDirOf(folder, previewId);
  await makePrivateDir(previewDir);

  const ordered = [...checkpoint.objects].sort((a, b) => a.readOrder - b.readOrder);
  const changes = await readChanges(
    reader,
    ordered.map(({ objectApiName, readMode, records }) => ({
      objectApiName,
      readMode,
      held: records > 0,
    })),
    checkpoint.readFrom,
    previewDir,
    signal,
  );

  const context: DiffContext = { input, previewDir, t0s };
  const objects: RewindDiffObject[] = [];
  const unread: RewindDiff['unread'] = [];
  for (const [at, object] of ordered.entries()) {
    if (signal?.aborted) throw new OrgReadStopped();
    const outcome = await diffObject(context, object, changes[at]);
    if ('unread' in outcome) {
      unread.push({ objectApiName: object.objectApiName, reason: outcome.unread });
    } else if (differs(outcome.diff)) {
      objects.push(outcome.diff);
    }
  }
  return {
    checkpointId: checkpoint.checkpointId,
    previewId,
    readAt,
    objects,
    undoCannot: [],
    unread,
    userNames: {},
    activeLastHour: [],
  };
}
