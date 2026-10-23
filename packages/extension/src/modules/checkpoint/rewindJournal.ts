/**
 * The journal of a rewind: what it is about to write, on disk before it
 * writes it, so that its undo can take it back. It replaces a safety
 * checkpoint taken before every rewind, which a rewind resumed after a stop
 * would have taken again, of an org already half rewound, and which could not
 * have brought back the records Salesforce undeletes only with their parent.
 *
 * One rewind keeps one journal, in `rewinds/<rewindId>/` of its checkpoint's
 * folder, its owner's alone to read:
 *
 * ```
 * journal.ndjson   one line per step, each flushed to the disk before the write it names
 * backups/         the values its give-back writes over, as the DataOps store keeps a backup
 * before.json      what the store says of those values, each opening of the journal apart
 * ```
 *
 * It names, before each write: the ids of each batch it brings back from the
 * recycle bin, and the children that come back with a parent; the records of
 * each update of its give-back, once the values they hold are kept
 * (`storeOverwriteBackup`, which a Sync run keeps what it writes over with),
 * and of them those it gives back once the records hanging from them that it
 * deletes are gone; and the records it sets out to delete, then, once the
 * removal answered, those it left. After a crash, what it set out to delete
 * stands, and the undo finds out which of them the recycle bin holds. What
 * its removals left on records, and when they ran, is kept beside, for its
 * next pass.
 *
 * A rewind stopped part way is taken up again on its journal: a new journal
 * starts only once the checkpoint's last rewind has ended, or been undone, so
 * that the undo always reaches the org as it was before the first pass. Of a
 * record written over twice — a second pass, a resume — the values kept
 * first stand: each object's file of values is added to, never begun again.
 *
 * Read back, the journal is three plans for its undo: what to bring back
 * from the recycle bin, what to give back its values, and what to send back
 * there. A record the rewind brought back and then deleted again, or the
 * other way round, is where it was before: in none of them.
 *
 * The org's lock is held whenever a journal is written (`OrgCheckpointStore.lock`):
 * one rewind or undo of an org at a time is the journal's only writer. A line
 * a crash cut short, which no write followed, is dropped as the journal is
 * opened again; any other line that does not read as the journal's is
 * damage, and the journal is not used.
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { open, readdir, stat, truncate, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import * as z from 'zod';
import {
  checkpointIdSchema,
  checkpointOrganizationIdSchema,
  rewindIdSchema,
  type CheckpointObject,
  type ForgeRunObjectRecords,
  type ForgeUndoStatus,
} from '@sandforge/shared';
import { BackupRecordStore, nodeBackupFiles } from '../dataops/BackupRecordStore.js';
import { isRunRecords, type RunRecords, type RunRemovalOutcome } from '../forge/ForgeRunRemoval.js';
import { readRemovalState, type SyncRunRemovalState } from '../sync/SyncRunCreations.js';
import type { BackupReader } from '../sync/SyncRunRestore.js';
import type { UndeleteCall } from '../sync/SyncRunUndelete.js';
import {
  overwriteBackupIdOf,
  storeOverwriteBackup,
  type BackupMetaStore,
  type BackupRecordFiles,
  type OverwriteBackup,
} from '../sync/syncOverwrites.js';
import {
  CHECKPOINT_FILE_MODE,
  CheckpointStoreError,
  makePrivateDir,
  newFolderId,
  rewindDirOf,
  type CheckpointFolder,
  type OrgLock,
} from './OrgCheckpointStore.js';
import type { RewoundObject } from './rewindEstimate.js';

/** The file of a journal's lines, in its folder. */
const JOURNAL_FILE = 'journal.ndjson';

/** The file of what the store says of the values kept, in its folder. */
const BEFORE_FILE = 'before.json';

/**
 * Ids one line names at most: a line of a few tens of kilobytes, whatever
 * the plan holds, and a million ids in some five hundred lines.
 */
export const IDS_PER_LINE = 2_000;

// ─── Lines ───────────────────────────────────────────────────────────────────

const idSchema = z.string().regex(/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/, 'Not a record id');
const userIdSchema = z.string().regex(/^005[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/, 'Not a User Id');
const objectSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'Not an API name')
  .max(80);
const instantSchema = z.iso.datetime({ offset: true });
const idsSchema = z.array(idSchema).min(1).max(IDS_PER_LINE);
const stepSchema = z.number().int().positive();

/** The first line: the rewind, its checkpoint, its org, when it began and as whom. */
const headLineSchema = z.object({
  kind: z.literal('head'),
  version: z.literal(1),
  rewindId: rewindIdSchema,
  checkpointId: checkpointIdSchema,
  organizationId: checkpointOrganizationIdSchema,
  /** Tr of the first pass, on the org's clock. */
  startedAt: instantSchema,
  userId: userIdSchema,
  automatedProcessUserId: userIdSchema.optional(),
  /** The backup the values it writes over are kept in. */
  backup: z.string().min(1).max(200),
  at: instantSchema,
});

/** A pass taken up again on the journal: its own Tr, and the user it writes as. */
const resumedLineSchema = z.object({
  kind: z.literal('resumed'),
  startedAt: instantSchema,
  userId: userIdSchema,
  at: instantSchema,
});

/** Ids of one object: about to come back, come back with a parent, about to be written over. */
const idsLineSchema = z.object({
  kind: z.enum(['bringingBack', 'withParent', 'givingBack']),
  objectApiName: objectSchema,
  ids: idsSchema,
  at: instantSchema,
});

/** Ids of one object a removal set out to delete, or left, in the step it was journaled as. */
const stepIdsLineSchema = z.object({
  kind: z.enum(['deleting', 'deleteLeft']),
  step: stepSchema,
  objectApiName: objectSchema,
  ids: idsSchema,
  at: instantSchema,
});

/**
 * Records of one object the rewind gives back once the records of `by`
 * hanging from them that it deletes are gone: values those records held in
 * place. Their undo gives those values back before the records of `by` come
 * back.
 */
const heldLineSchema = z.object({
  kind: z.literal('heldInPlace'),
  objectApiName: objectSchema,
  by: z.array(objectSchema).min(1).max(100),
  ids: idsSchema,
  at: instantSchema,
});

/** A removal answered: what it left of the step is named before this line. */
const deletedLineSchema = z.object({
  kind: z.literal('deleted'),
  step: stepSchema,
  at: instantSchema,
});

/** What the rewind's removals left on records, and when they ran: `SyncRunRemovalState`'s shape. */
const removalLineSchema = z.object({
  kind: z.literal('removal'),
  state: z.unknown(),
  at: instantSchema,
});

/** A write answered, said once it has. */
const wroteLineSchema = z.object({ kind: z.literal('wrote'), at: instantSchema });

/** The rewind went through. */
const endLineSchema = z.object({ kind: z.literal('end'), at: instantSchema });

/** An undo of the rewind ended: what it left for the next, and how it ended. */
const undoLineSchema = z.object({
  kind: z.literal('undo'),
  state: z.unknown(),
  status: z.enum(['success', 'partial', 'failure', 'cancelled']),
  at: instantSchema,
});

const lineSchema = z.discriminatedUnion('kind', [
  headLineSchema,
  resumedLineSchema,
  idsLineSchema,
  heldLineSchema,
  stepIdsLineSchema,
  deletedLineSchema,
  removalLineSchema,
  wroteLineSchema,
  endLineSchema,
  undoLineSchema,
]);

type Line = z.infer<typeof lineSchema>;
type HeadLine = z.infer<typeof headLineSchema>;

/**
 * Lines that name a write about to go or one just answered: the latest of
 * them is when the rewind last wrote, give or take the time a call takes to
 * reach the org. A pass taken up again writes nothing by being taken up, and
 * its line says nothing of when the rewind wrote: a colleague's change between
 * a stop and the resume would read as the rewind's own.
 */
const WRITE_LINES: ReadonlySet<Line['kind']> = new Set([
  'bringingBack',
  'withParent',
  'givingBack',
  'deleting',
  'deleteLeft',
  'deleted',
  'removal',
  'wrote',
]);

// ─── What a journal says ─────────────────────────────────────────────────────

/** Ids of one object. */
export interface ObjectIds {
  objectApiName: string;
  ids: string[];
}

/** The rewind a journal is of. */
export interface RewindJournalHead {
  rewindId: string;
  checkpointId: string;
  organizationId: string;
  /** Tr of its first pass, on the org's clock. */
  startedAt: string;
  /** The user it wrote as in its first pass. */
  userId: string;
  automatedProcessUserId?: string;
  /** The backup its values from before are kept in, in the journal's folder. */
  backup: string;
}

/** What the rewind did, per object, in the order the journal first names each. */
export interface RewindJournalDid {
  /** Brought back from the recycle bin, or come back with a parent it brought back. */
  broughtBack: ObjectIds[];
  /** Deleted: what each removal set out to delete less what it left, or all of it when it never answered. */
  deleted: ObjectIds[];
  /** Written over by its give-back, their values from before kept in {@link RewindJournalHead.backup}. */
  givenBack: ObjectIds[];
  /**
   * Of what it gave back, the records given back once the records of `by`
   * hanging from them that it deleted were gone. Absent when there is none.
   */
  heldInPlace?: HeldIds[];
}

/** Records of one object that held values in place, and the objects whose records held them. */
export interface HeldIds extends ObjectIds {
  by: string[];
}

/** A journal, read back. */
export interface RewindJournalRead {
  head: RewindJournalHead;
  /** Each pass, the first one included: its Tr on the org's clock, and the user it wrote as. */
  passes: Array<{ startedAt: string; userId: string }>;
  did: RewindJournalDid;
  /**
   * When the rewind last wrote, by this machine's clock, as its lines date
   * it; absent when it wrote nothing.
   */
  lastWriteAt?: string;
  /** When it went through, by this machine's clock; absent from one stopped part way. */
  endedAt?: string;
  /** What its removals left on records, and when they ran: for its next pass. */
  rewind: SyncRunRemovalState;
  /** What its undos did, for the next one: absent fields until one did each. */
  undo: SyncRunRemovalState;
  /** Each undo that ended, and how. */
  undos: Array<{ status: ForgeUndoStatus; at: string }>;
}

/** What an undo of a rewind does, from its journal: see {@link undoPlans}. */
export interface RewindUndoPlans {
  /** What the rewind brought back, which goes back to the recycle bin. */
  remove: ObjectIds[];
  /** What the rewind deleted, which comes back from the recycle bin, parents first. */
  bringBack: ObjectIds[];
  /** What the rewind wrote over, given back the values it held before. */
  giveBack: Array<ObjectIds & { backup: string }>;
  /**
   * Of {@link giveBack}, the records whose values records of `by` the rewind
   * deleted held in place: given back before those records come back.
   * Absent when there is none.
   */
  held?: HeldIds[];
}

// ─── Writing ─────────────────────────────────────────────────────────────────

/** A journal open for writing. */
export interface RewindJournal {
  readonly rewindId: string;
  /** Its folder. */
  readonly dir: string;
  /** The backup its values from before are kept in. */
  readonly backup: string;
  /** Whether it was taken up again: a rewind stopped part way, resumed. */
  readonly resumed: boolean;
  /**
   * Keep what an update of the give-back is about to write over, then name its
   * records, both on disk before it goes (`SyncRestoreInput.keep`). Throws
   * when either could not be done: the update is then not sent.
   */
  readonly keep: OverwriteBackup['keep'];
  /** The values from before, read as a restore reads a backup. */
  readonly values: BackupReader;
  /**
   * `undelete`, each batch's ids named first: of the object `plan` holds them
   * under. A batch that could not be named is not sent; one of no object of
   * the plan is refused.
   */
  bringingBack(plan: readonly ObjectIds[], undelete: UndeleteCall): UndeleteCall;
  /**
   * Records that come back, or came back, with a parent the rewind brings
   * back: its undo sends them back to the recycle bin with it. Named before
   * the undelete that brings them — as the children of each parent the bin
   * holds — they are named even when the rewind stops between that undelete
   * and a read after it. Unnamed, they would hold their parent in the org: a
   * removal keeps a record that records older than it depend on.
   */
  withParent(objectApiName: string, ids: readonly string[]): Promise<void>;
  /**
   * Records the rewind gives back once the records of `by` hanging from them
   * that it deletes are gone, named before anything of the pass is written:
   * their undo gives their values back before those records come back from
   * the bin — seen live, a price book cannot change while an opportunity has
   * products.
   */
  heldInPlace(objectApiName: string, by: readonly string[], ids: readonly string[]): Promise<void>;
  /** Name what a removal sets out to delete, before it is handed the plan. */
  deleting(plan: readonly ForgeRunObjectRecords[] | RunRecords): Promise<void>;
  /** The removal of the last {@link deleting} answered: name what it left. */
  deleted(outcome: Pick<RunRemovalOutcome, 'left'>): Promise<void>;
  /** What a removal left on records, and when it ran: `removalStamps`, `removalSpans`. */
  removal(change: Pick<SyncRunRemovalState, 'removalStamps' | 'removalSpans'>): Promise<void>;
  /** A write answered: the latest time the rewind wrote moves to now. */
  wrote(): Promise<void>;
  /** The rewind went through: the next rewind of the checkpoint starts a journal of its own. */
  end(): Promise<void>;
  /** An undo ended: what it did, for the next one, and how it ended. */
  undone(change: SyncRunRemovalState, status: ForgeUndoStatus): Promise<void>;
  /** The journal as it stands on disk. */
  read(): Promise<RewindJournalRead>;
  /** Let the journal's files go. Once is enough. */
  close(): Promise<void>;
}

/** What a rewind opens its journal with. */
export interface OpenRewindJournalInput {
  folder: CheckpointFolder;
  /** The lock of the checkpoint's org, held for the rewind. */
  lock: OrgLock;
  /** Tr: when this pass read the org, on the org's clock. */
  startedAt: string;
  /** The user the rewind writes as. */
  userId: string;
  /** The org's Automated Process user, whose writes answer the rewind's. */
  automatedProcessUserId?: string;
  /** This machine's clock: what the lines are dated by. */
  now?: () => Date;
}

/** Fsync a folder, so a file made in it is there after a crash. Some systems do not let a folder be. */
async function syncFolder(dir: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(dir, 'r');
    await handle.sync();
  } catch {
    // Windows does not open a folder to flush it; its file system journals the entry itself.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Add `content` to the end of a file, made its owner's alone, and flush it to
 * the disk before answering: what the store keeps of a record's values is
 * there when the update over them goes.
 */
async function appendSynced(file: string, content: string): Promise<void> {
  const handle = await open(file, 'a', CHECKPOINT_FILE_MODE);
  try {
    await handle.appendFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Write a file whole, its owner's alone: a file of its own beside it, flushed,
 * renamed over it. Synchronous, as the store's metadata is written.
 */
function writeWholeSync(file: string, content: string): void {
  const temp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  const bytes = Buffer.from(content, 'utf8');
  const fd = openSync(temp, 'wx', CHECKPOINT_FILE_MODE);
  try {
    for (let written = 0; written < bytes.length;) {
      written += writeSync(fd, bytes, written, bytes.length - written);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
}

/**
 * Where `storeOverwriteBackup` says what it keeps: `before.json`, each opening
 * of the journal its own entry, so a journal taken up again does not have its
 * second opening's counts stand for both.
 */
function beforeMetaOf(file: string): BackupMetaStore {
  let openings: unknown[] = [];
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { openings?: unknown };
    if (Array.isArray(raw.openings)) openings = raw.openings;
  } catch {
    // None yet, or not one this journal wrote: it starts again from this opening.
  }
  const at = openings.length;
  return {
    set: (_key, value) => {
      openings[at] = value;
      writeWholeSync(file, `${JSON.stringify({ version: 1, openings })}\n`);
    },
  };
}

/** A record by its first fifteen characters. */
function recordKey(id: string): string {
  return id.slice(0, 15);
}

/** `ids` in lines of {@link IDS_PER_LINE} at most. */
function chunksOf(ids: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let at = 0; at < ids.length; at += IDS_PER_LINE)
    chunks.push(ids.slice(at, at + IDS_PER_LINE));
  return chunks;
}

/** The pages of a plan's objects, in its order, whether held in memory or read a page at a time. */
async function* pagesOf(
  plan: readonly ForgeRunObjectRecords[] | RunRecords,
): AsyncGenerator<ObjectIds> {
  if (!isRunRecords(plan)) {
    for (const { objectApiName, ids } of plan) {
      if (ids.length > 0) yield { objectApiName, ids: [...ids] };
    }
    return;
  }
  for (const { objectApiName } of plan.objects) {
    for await (const page of plan.pages(objectApiName)) {
      if (page.length > 0) yield { objectApiName, ids: [...page] };
    }
  }
}

/** See the module's comment. */
class JournalFile implements RewindJournal {
  readonly keep: OverwriteBackup['keep'];
  readonly values: BackupReader;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  /** The step of the removal named last and not answered yet. */
  private openStep: number | undefined;
  private readonly kept: OverwriteBackup & { close(): void };

  readonly rewindId: string;
  readonly backup: string;

  private constructor(
    head: HeadLine,
    readonly dir: string,
    readonly resumed: boolean,
    private readonly handle: FileHandle,
    private step: number,
    private readonly now: () => Date,
  ) {
    this.rewindId = head.rewindId;
    this.backup = head.backup;
    const newFiles = new Set<string>();
    const store = new BackupRecordStore({
      ...nodeBackupFiles(dir),
      appendFile: async (file, content) => {
        await appendSynced(file, content);
        // The first values of an object this opening: its file may be new,
        // and its folder's entry is flushed too.
        if (!newFiles.has(file)) {
          newFiles.add(file);
          await syncFolder(dirname(file));
        }
      },
    });
    const files: BackupRecordFiles = {
      // Never begun again: a pass taken up again, or a second pass, adds to
      // what the first kept, whose values are the ones from before the rewind.
      begin: () => makePrivateDir(join(dir, 'backups')),
      append: (operationId, objectApiName, records) =>
        store.append(operationId, objectApiName, records),
    };
    this.kept = storeOverwriteBackup({
      runId: head.rewindId,
      orgId: head.organizationId,
      organizationId: head.organizationId,
      files,
      meta: beforeMetaOf(join(dir, BEFORE_FILE)),
      now,
    });
    if (this.kept.id !== head.backup) {
      throw new CheckpointStoreError(
        'damaged',
        'The rewind’s journal names another backup of its values than the one they are kept in.',
      );
    }
    this.values = store;
    this.keep = async (objectApiName, records) => {
      await this.kept.keep(objectApiName, records);
      const ids = records.flatMap((record) => (typeof record.Id === 'string' ? [record.Id] : []));
      for (const chunk of chunksOf(ids)) {
        await this.append({ kind: 'givingBack', objectApiName, ids: chunk });
      }
    };
  }

  /** A journal opened for writing, its lines read up to now. */
  static async opened(
    dir: string,
    head: HeadLine,
    resumed: boolean,
    step: number,
    now: () => Date,
  ): Promise<JournalFile> {
    const handle = await open(join(dir, JOURNAL_FILE), 'a', CHECKPOINT_FILE_MODE);
    try {
      return new JournalFile(head, dir, resumed, handle, step, now);
    } catch (err: unknown) {
      await handle.close();
      throw err;
    }
  }

  /** Add a line, flushed to the disk before it answers; lines go one after the other. */
  append(line: Record<string, unknown>): Promise<void> {
    if (this.closed) return Promise.reject(new Error('The rewind’s journal is closed.'));
    const text = `${JSON.stringify({ ...line, at: this.now().toISOString() })}\n`;
    const written = this.queue.then(async () => {
      await this.handle.appendFile(text, 'utf8');
      await this.handle.sync();
    });
    this.queue = written.catch(() => undefined);
    return written;
  }

  private async appendIds(
    kind: 'bringingBack' | 'withParent',
    objectApiName: string,
    ids: readonly string[],
  ): Promise<void> {
    for (const chunk of chunksOf(ids)) await this.append({ kind, objectApiName, ids: chunk });
  }

  bringingBack(plan: readonly ObjectIds[], undelete: UndeleteCall): UndeleteCall {
    // A batch is of one object, in the order the plan gives: its object is
    // told by its ids' prefix, which is one object's.
    const objectOf = new Map<string, string>();
    for (const { objectApiName, ids } of plan) {
      const [first] = ids;
      if (first !== undefined) objectOf.set(first.slice(0, 3), objectApiName);
    }
    return async (ids) => {
      const objects = new Set(ids.map((id) => objectOf.get(id.slice(0, 3))));
      const [objectApiName] = [...objects];
      if (objects.size !== 1 || objectApiName === undefined) {
        throw new Error('These records are not of the plan the journal names: none was sent.');
      }
      await this.appendIds('bringingBack', objectApiName, ids);
      return undelete(ids);
    };
  }

  async withParent(objectApiName: string, ids: readonly string[]): Promise<void> {
    await this.appendIds('withParent', objectApiName, ids);
  }

  async heldInPlace(
    objectApiName: string,
    by: readonly string[],
    ids: readonly string[],
  ): Promise<void> {
    if (by.length === 0) return;
    for (const chunk of chunksOf(ids)) {
      await this.append({ kind: 'heldInPlace', objectApiName, by: [...by], ids: chunk });
    }
  }

  async deleting(plan: readonly ForgeRunObjectRecords[] | RunRecords): Promise<void> {
    const step = ++this.step;
    this.openStep = step;
    for await (const { objectApiName, ids } of pagesOf(plan)) {
      for (const chunk of chunksOf(ids)) {
        await this.append({ kind: 'deleting', step, objectApiName, ids: chunk });
      }
    }
  }

  async deleted(outcome: Pick<RunRemovalOutcome, 'left'>): Promise<void> {
    const step = this.openStep;
    if (step === undefined) throw new Error('No removal was named to the journal before it.');
    for await (const { objectApiName, ids } of outcome.left()) {
      for (const chunk of chunksOf(ids)) {
        await this.append({ kind: 'deleteLeft', step, objectApiName, ids: chunk });
      }
    }
    await this.append({ kind: 'deleted', step });
    this.openStep = undefined;
  }

  async removal(
    change: Pick<SyncRunRemovalState, 'removalStamps' | 'removalSpans'>,
  ): Promise<void> {
    const state = {
      ...(change.removalStamps && Object.keys(change.removalStamps).length > 0
        ? { removalStamps: change.removalStamps }
        : {}),
      ...(change.removalSpans && change.removalSpans.length > 0
        ? { removalSpans: change.removalSpans }
        : {}),
    };
    if (Object.keys(state).length === 0) return;
    await this.append({ kind: 'removal', state: { version: 1, ...state } });
  }

  async wrote(): Promise<void> {
    await this.append({ kind: 'wrote' });
  }

  async end(): Promise<void> {
    await this.append({ kind: 'end' });
  }

  async undone(change: SyncRunRemovalState, status: ForgeUndoStatus): Promise<void> {
    await this.append({ kind: 'undo', state: { version: 1, ...change }, status });
  }

  async read(): Promise<RewindJournalRead> {
    await this.queue;
    return readJournalDir(this.dir);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.kept.close();
    } catch {
      // What the store says of the values kept is information; the values are on disk.
    }
    await this.queue;
    await this.handle.close();
  }
}

// ─── Reading ─────────────────────────────────────────────────────────────────

/** A journal's lines, those a crash cut short dropped, and how many bytes the whole ones take. */
async function linesOf(file: string): Promise<{ lines: Line[]; whole: number; size: number }> {
  const size = (await stat(file)).size;
  // A line is whole when a line break ends it: the last one, without, was
  // being written when the process stopped, and nothing it names was sent.
  let endsWhole = size === 0;
  if (size > 0) {
    const handle = await open(file, 'r');
    try {
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      endsWhole = last[0] === 0x0a;
    } finally {
      await handle.close();
    }
  }
  const raw: string[] = [];
  const stream = createReadStream(file, { encoding: 'utf8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) raw.push(line);
  } finally {
    reader.close();
    stream.destroy();
  }
  if (!endsWhole) raw.pop();
  let whole = 0;
  const lines: Line[] = [];
  raw.forEach((text, at) => {
    whole += Buffer.byteLength(text, 'utf8') + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const line = lineSchema.safeParse(parsed);
    if (!line.success) {
      throw new CheckpointStoreError(
        'damaged',
        `The rewind’s journal is damaged at line ${at + 1}: it is not used.`,
      );
    }
    lines.push(line.data);
  });
  return { lines, whole, size };
}

/** Ids of each object, each record once by its key, in the order the lines first name each. */
class IdsByObject {
  private readonly byObject = new Map<string, Map<string, string>>();

  add(objectApiName: string, ids: readonly string[]): void {
    const object = this.byObject.get(objectApiName) ?? new Map<string, string>();
    for (const id of ids) if (!object.has(recordKey(id))) object.set(recordKey(id), id);
    this.byObject.set(objectApiName, object);
  }

  list(keep: (key: string) => boolean = () => true): ObjectIds[] {
    return [...this.byObject].flatMap(([objectApiName, ids]) => {
      const kept = [...ids].filter(([key]) => keep(key)).map(([, id]) => id);
      return kept.length > 0 ? [{ objectApiName, ids: kept }] : [];
    });
  }

  keys(): Set<string> {
    return new Set([...this.byObject.values()].flatMap((ids) => [...ids.keys()]));
  }
}

/** What the removal lines of a journal hold, folded: stamps merged, spans in turn, the rest the latest. */
function foldState(states: readonly SyncRunRemovalState[]): SyncRunRemovalState {
  let folded: SyncRunRemovalState = {};
  for (const state of states) {
    folded = {
      ...folded,
      ...state,
      ...(state.removalStamps || folded.removalStamps
        ? { removalStamps: { ...folded.removalStamps, ...state.removalStamps } }
        : {}),
      ...(state.removalSpans || folded.removalSpans
        ? { removalSpans: [...(folded.removalSpans ?? []), ...(state.removalSpans ?? [])] }
        : {}),
    };
  }
  return folded;
}

/** A state a line holds, or damage. */
function stateOf(raw: unknown): SyncRunRemovalState {
  const state = readRemovalState(raw);
  if (state === undefined) {
    throw new CheckpointStoreError('damaged', 'The rewind’s journal holds a state it cannot read.');
  }
  return state;
}

/** What `lines` say, the first being the head. */
function journalOf(lines: readonly Line[]): RewindJournalRead {
  const [first] = lines;
  if (first?.kind !== 'head') {
    throw new CheckpointStoreError('damaged', 'The rewind’s journal does not begin with its head.');
  }
  const head: RewindJournalHead = {
    rewindId: first.rewindId,
    checkpointId: first.checkpointId,
    organizationId: first.organizationId,
    startedAt: first.startedAt,
    userId: first.userId,
    ...(first.automatedProcessUserId !== undefined
      ? { automatedProcessUserId: first.automatedProcessUserId }
      : {}),
    backup: first.backup,
  };
  const passes = [{ startedAt: head.startedAt, userId: head.userId }];
  const broughtBack = new IdsByObject();
  const givenBack = new IdsByObject();
  const held = new IdsByObject();
  /** Per object held in place, the objects whose records held it, in the order named. */
  const heldBy = new Map<string, Set<string>>();
  /** Per step: what it set out to delete, what it left, and whether its removal answered. */
  const steps = new Map<number, { deleting: IdsByObject; left: Set<string>; answered: boolean }>();
  const stepOf = (
    step: number,
  ): { deleting: IdsByObject; left: Set<string>; answered: boolean } => {
    let held = steps.get(step);
    if (!held) {
      held = { deleting: new IdsByObject(), left: new Set(), answered: false };
      steps.set(step, held);
    }
    return held;
  };
  const rewindStates: SyncRunRemovalState[] = [];
  const undoStates: SyncRunRemovalState[] = [];
  const undos: RewindJournalRead['undos'] = [];
  let lastWrite = Number.NEGATIVE_INFINITY;
  let endedAt: string | undefined;
  for (const line of lines.slice(1)) {
    if (WRITE_LINES.has(line.kind)) lastWrite = Math.max(lastWrite, Date.parse(line.at));
    switch (line.kind) {
      case 'head':
        throw new CheckpointStoreError('damaged', 'The rewind’s journal has two heads.');
      case 'resumed':
        passes.push({ startedAt: line.startedAt, userId: line.userId });
        break;
      case 'bringingBack':
      case 'withParent':
        broughtBack.add(line.objectApiName, line.ids);
        break;
      case 'givingBack':
        givenBack.add(line.objectApiName, line.ids);
        break;
      case 'heldInPlace': {
        held.add(line.objectApiName, line.ids);
        const by = heldBy.get(line.objectApiName) ?? new Set<string>();
        for (const object of line.by) by.add(object);
        heldBy.set(line.objectApiName, by);
        break;
      }
      case 'deleting':
        stepOf(line.step).deleting.add(line.objectApiName, line.ids);
        break;
      case 'deleteLeft':
        for (const id of line.ids) stepOf(line.step).left.add(recordKey(id));
        break;
      case 'deleted':
        stepOf(line.step).answered = true;
        break;
      case 'removal':
        rewindStates.push(stateOf(line.state));
        break;
      case 'wrote':
        break;
      case 'end':
        endedAt = line.at;
        break;
      case 'undo':
        undoStates.push(stateOf(line.state));
        undos.push({ status: line.status, at: line.at });
        break;
    }
  }
  // What each removal deleted: what it set out to, less what it left once it
  // answered; all of it when it never did, the undo finding out which of
  // them the recycle bin holds.
  const deleted = new IdsByObject();
  for (const { deleting, left, answered } of steps.values()) {
    for (const { objectApiName, ids } of deleting.list((key) => !answered || !left.has(key))) {
      deleted.add(objectApiName, ids);
    }
  }
  const heldInPlace = held.list().map(({ objectApiName, ids }) => ({
    objectApiName,
    ids,
    by: [...(heldBy.get(objectApiName) ?? [])],
  }));
  return {
    head,
    passes,
    did: {
      broughtBack: broughtBack.list(),
      deleted: deleted.list(),
      givenBack: givenBack.list(),
      ...(heldInPlace.length > 0 ? { heldInPlace } : {}),
    },
    ...(Number.isFinite(lastWrite) ? { lastWriteAt: new Date(lastWrite).toISOString() } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    rewind: foldState(rewindStates),
    undo: foldState(undoStates),
    undos,
  };
}

/** A journal's folder, read back. */
async function readJournalDir(dir: string): Promise<RewindJournalRead> {
  let read: Awaited<ReturnType<typeof linesOf>>;
  try {
    read = await linesOf(join(dir, JOURNAL_FILE));
  } catch (err: unknown) {
    if (err instanceof CheckpointStoreError) throw err;
    throw new CheckpointStoreError('notFound', 'No journal of this rewind is kept.');
  }
  return journalOf(read.lines);
}

/** Check that a journal is the one of the folder it was read from. */
function belongsTo(read: RewindJournalRead, folder: CheckpointFolder, rewindId: string): void {
  if (
    read.head.rewindId !== rewindId ||
    read.head.checkpointId !== folder.checkpointId ||
    read.head.organizationId.slice(0, 15) !== folder.organizationId.slice(0, 15)
  ) {
    throw new CheckpointStoreError(
      'damaged',
      'The rewind’s journal names another rewind, checkpoint or org than its folder.',
    );
  }
}

/** Read the journal of one rewind of a checkpoint. */
export async function readRewindJournal(
  folder: CheckpointFolder,
  rewindId: string,
): Promise<RewindJournalRead> {
  const kept = await keptJournal(folder, rewindId);
  if (!kept) throw new CheckpointStoreError('notFound', 'No journal of this rewind is kept.');
  return kept.journal;
}

/** The lock's org must be the folder's: the journal is written under it alone. */
function heldFor(lock: OrgLock, folder: CheckpointFolder): void {
  if (lock.organizationId.slice(0, 15) !== folder.organizationId.slice(0, 15)) {
    throw new CheckpointStoreError(
      'invalid',
      'A rewind’s journal is written under its org’s lock.',
    );
  }
}

/** A journal kept on disk, read whole, before it is written to again. */
interface KeptJournal {
  dir: string;
  file: string;
  lines: Line[];
  /** Bytes of its whole lines: past them, a line a crash cut short. */
  whole: number;
  size: number;
  journal: RewindJournalRead;
}

/**
 * The journal of one rewind of a checkpoint, read; undefined when it is not
 * there or holds no line yet — a rewind stopped before it wrote its head,
 * which wrote nothing to the org.
 *
 * @throws {CheckpointStoreError} `damaged`, when it cannot be read or is another's.
 */
async function keptJournal(
  folder: CheckpointFolder,
  rewindId: string,
): Promise<KeptJournal | undefined> {
  const dir = rewindDirOf(folder, rewindId);
  const file = join(dir, JOURNAL_FILE);
  let read: Awaited<ReturnType<typeof linesOf>>;
  try {
    read = await linesOf(file);
  } catch (err: unknown) {
    if (err instanceof CheckpointStoreError) throw err;
    return undefined;
  }
  if (read.lines.length === 0) return undefined;
  const journal = journalOf(read.lines);
  belongsTo(journal, folder, rewindId);
  return { dir, file, ...read, journal };
}

/** Open a kept journal to add to it: what a crash cut short goes before the next line does. */
async function reopened(kept: KeptJournal, now: () => Date): Promise<JournalFile> {
  if (kept.whole < kept.size) await truncate(kept.file, kept.whole);
  const step = kept.lines.reduce(
    (most, line) => ('step' in line ? Math.max(most, line.step) : most),
    0,
  );
  return JournalFile.opened(kept.dir, kept.lines[0] as HeadLine, true, step, now);
}

/** Where an id says when its rewind began, to the second: `rw-20261022-141102`. */
const BEGAN_LENGTH = 'rw-20261022-141102'.length;

/**
 * The ids of the checkpoint's latest rewinds: those that began in the last
 * second a rewind of it began in, newest first as far as their names tell.
 * Ids are named by when the rewind began, to the second; two in one second
 * are told apart by reading them.
 */
async function latestRewindIdsOf(folder: CheckpointFolder): Promise<string[]> {
  let ids: string[];
  try {
    ids = (await readdir(folder.rewindsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && rewindIdSchema.safeParse(entry.name).success)
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
  const [newest] = ids;
  return newest === undefined
    ? []
    : ids.filter((rewindId) => rewindId.slice(0, BEGAN_LENGTH) === newest.slice(0, BEGAN_LENGTH));
}

/**
 * Open the journal a rewind of a checkpoint writes before it writes: the
 * journal of its last rewind when that one stopped part way — it never went
 * through and was never undone — taken up again, or a new one. See the
 * module's comment.
 *
 * @throws {CheckpointStoreError} `damaged`, when the last rewind's journal
 *   cannot be read: a rewind stopped part way whose journal is lost would have
 *   its undo reach the org half rewound, so no rewind starts over it.
 */
export async function openRewindJournal(input: OpenRewindJournalInput): Promise<RewindJournal> {
  const { folder } = input;
  heldFor(input.lock, folder);
  const now = input.now ?? (() => new Date());
  /** The folder of a rewind stopped before it wrote its head: used as it is. */
  let blank: string | undefined;
  for (const latest of await latestRewindIdsOf(folder)) {
    const kept = await keptJournal(folder, latest);
    if (!kept) {
      blank ??= latest;
      continue;
    }
    if (kept.journal.endedAt !== undefined || kept.journal.undos.length > 0) continue;
    const opened = await reopened(kept, now);
    try {
      await opened.append({ kind: 'resumed', startedAt: input.startedAt, userId: input.userId });
    } catch (err: unknown) {
      await opened.close();
      throw err;
    }
    return opened;
  }

  const rewindId = blank ?? newFolderId('rw', now());
  const dir = rewindDirOf(folder, rewindId);
  await makePrivateDir(dir);
  await makePrivateDir(join(dir, 'backups'));
  await truncate(join(dir, JOURNAL_FILE), 0).catch(() => undefined);
  const head = headLineSchema.safeParse({
    kind: 'head',
    version: 1,
    rewindId,
    checkpointId: folder.checkpointId,
    organizationId: folder.organizationId,
    startedAt: input.startedAt,
    userId: input.userId,
    ...(input.automatedProcessUserId !== undefined
      ? { automatedProcessUserId: input.automatedProcessUserId }
      : {}),
    backup: overwriteBackupIdOf(rewindId),
    at: now().toISOString(),
  });
  if (!head.success) {
    throw new CheckpointStoreError('invalid', `Not a rewind to journal: ${head.error.message}`);
  }
  const opened = await JournalFile.opened(dir, head.data, false, 0, now);
  try {
    await opened.append(head.data);
    await syncFolder(dir);
    await syncFolder(folder.rewindsDir);
  } catch (err: unknown) {
    await opened.close();
    throw err;
  }
  return opened;
}

/**
 * Open the journal of a rewind for its undo, which adds what it did to it.
 *
 * @throws {CheckpointStoreError} `notFound` when it is not kept, `damaged`
 *   when it cannot be read or is another's.
 */
export async function reopenRewindJournal(
  folder: CheckpointFolder,
  rewindId: string,
  lock: OrgLock,
  now: () => Date = () => new Date(),
): Promise<RewindJournal> {
  heldFor(lock, folder);
  const kept = await keptJournal(folder, rewindId);
  if (!kept) throw new CheckpointStoreError('notFound', 'No journal of this rewind is kept.');
  return reopened(kept, now);
}

// ─── The undo's plans ────────────────────────────────────────────────────────

/**
 * What an undo of the rewind a journal is of does, and in what order:
 *
 * - `remove`: what the rewind brought back from the recycle bin, and what came
 *   back with it, children first;
 * - `bringBack`: what it deleted, parents first — the undelete follows the
 *   order it is given, and a child the bin holds without its parent stays
 *   there;
 * - `giveBack`: what it wrote over, from the values kept before;
 * - `held`: of those, the records it gave back once the records hanging from
 *   them that it deleted were gone — values those records held in place, which
 *   the undo gives back before they come back.
 *
 * A record it brought back and deleted again — one that came back with its
 * parent and that a second pass deleted — is in the recycle bin as it was
 * before the rewind, and in neither of the first two: undeleted by the undo,
 * it would hold the parent the undo sends back to the bin. An undo that ended
 * part way left, of each plan, what it did not settle: the next one takes up
 * that alone.
 *
 * @param objects - The checkpoint's objects, children first (`readOrder`):
 *   an object the checkpoint does not hold — a child outside it that came
 *   back with its parent — goes first of what goes back to the bin, and last
 *   of what comes back.
 */
export function undoPlans(
  read: Pick<RewindJournalRead, 'head' | 'did' | 'undo'>,
  objects: ReadonlyArray<Pick<CheckpointObject, 'objectApiName' | 'readOrder'>> = [],
): RewindUndoPlans {
  const broughtBack = new IdsByObject();
  for (const { objectApiName, ids } of read.did.broughtBack) broughtBack.add(objectApiName, ids);
  const deleted = new IdsByObject();
  for (const { objectApiName, ids } of read.did.deleted) deleted.add(objectApiName, ids);
  const deletedKeys = deleted.keys();
  const broughtKeys = broughtBack.keys();
  const leftOf = (left: readonly string[] | undefined): ((key: string) => boolean) => {
    if (left === undefined) return () => true;
    const keys = new Set(left.map(recordKey));
    return (key) => keys.has(key);
  };
  const removeLeft = leftOf(read.undo.removalLeft);
  const undeleteLeft = leftOf(read.undo.undeleteLeft);
  const restoreLeft = leftOf(read.undo.restoreLeft);

  const order = new Map(objects.map((object) => [object.objectApiName, object.readOrder]));
  const childrenFirst = (a: ObjectIds, b: ObjectIds): number =>
    (order.get(a.objectApiName) ?? -1) - (order.get(b.objectApiName) ?? -1);
  const remove = broughtBack
    .list((key) => !deletedKeys.has(key) && removeLeft(key))
    .sort(childrenFirst);
  const bringBack = deleted
    .list((key) => !broughtKeys.has(key) && undeleteLeft(key))
    .sort((a, b) => childrenFirst(b, a));
  const giveBack = read.did.givenBack.flatMap(({ objectApiName, ids }) => {
    const kept = ids.filter((id) => restoreLeft(recordKey(id)));
    return kept.length > 0 ? [{ objectApiName, ids: kept, backup: read.head.backup }] : [];
  });
  const givingBack = new Set(giveBack.flatMap(({ ids }) => ids.map(recordKey)));
  const held = (read.did.heldInPlace ?? []).flatMap(({ objectApiName, ids, by }) => {
    const kept = ids.filter((id) => givingBack.has(recordKey(id)));
    return kept.length > 0 ? [{ objectApiName, ids: kept, by: [...by] }] : [];
  });
  return { remove, bringBack, giveBack, ...(held.length > 0 ? { held } : {}) };
}

/** What an undo's plans take back, per object: what its estimate is made from (`undoEstimate`). */
export function rewoundObjects(plans: RewindUndoPlans): RewoundObject[] {
  const byObject = new Map<string, RewoundObject>();
  const of = (objectApiName: string): RewoundObject => {
    let object = byObject.get(objectApiName);
    if (!object) {
      object = { objectApiName, deleted: 0, broughtBack: 0, givenBack: 0 };
      byObject.set(objectApiName, object);
    }
    return object;
  };
  for (const { objectApiName, ids } of plans.bringBack) of(objectApiName).deleted += ids.length;
  for (const { objectApiName, ids } of plans.remove) of(objectApiName).broughtBack += ids.length;
  for (const { objectApiName, ids } of plans.giveBack) of(objectApiName).givenBack += ids.length;
  for (const { objectApiName, ids } of plans.held ?? []) {
    const object = of(objectApiName);
    object.givenBackHeld = (object.givenBackHeld ?? 0) + ids.length;
  }
  return [...byObject.values()];
}
