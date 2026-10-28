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
 * deletes are gone; the records it deletes on their own before a record they
 * point at that it deletes too, each beside that record, which Undo couldn't
 * bring back once both went; the records it makes again, those the recycle bin
 * no longer gives back, by the Ids they had before each insert and by the Ids
 * the org gave them once it answered; and the records it sets out to delete,
 * then, once the removal answered, those it left. After a crash, what it set
 * out to delete stands, and the undo finds out which of them the recycle bin
 * holds; a record an insert made that a crash kept from being named is the
 * next rewind's to delete, made since and held by nothing. What
 * its removals left on records, and when they ran, is kept beside, for its
 * next pass.
 *
 * A rewind stopped part way is taken up again on its journal: a new journal
 * starts only once the checkpoint's last rewind has ended, or been undone, so
 * that the undo always reaches the org as it was before the first pass. Of a
 * record written over twice — a second pass, a resume — the values kept
 * first stand: each object's file of values is added to, never begun again.
 * Once a rewind has ended, the journals of the org's earlier rewinds, which
 * Undo no longer reaches, are deleted (`removeEarlierJournals`).
 *
 * Read back, the journal is three plans for its undo: what to bring back
 * from the recycle bin, what to give back its values, and what to send back
 * there — what it brought back, and what it made again. A record the rewind
 * brought back and then deleted again, or the
 * other way round, is where it was before: in none of them. The journal is
 * read a line at a time, never whole, and the plans are written to files of
 * their own, object by object (`spoolUndoPlans`): a rewind of a million
 * records journals a million ids.
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
import { open, readdir, rm, stat, truncate, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import * as z from 'zod';
import {
  checkpointIdSchema,
  checkpointOrganizationIdSchema,
  rewindIdSchema,
  sanitizeSoqlObjectName,
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
  latestRewindOf,
  makePrivateDir,
  newFolderId,
  rewindDirOf,
  type CheckpointFolder,
  type OrgCheckpointStore,
  type OrgLock,
} from './OrgCheckpointStore.js';
import type { RewoundObject } from './rewindEstimate.js';
import { IdSpool, IdSpoolWriter, RecordKeySet, SpooledRunRecords } from './spooledRunRecords.js';

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

/**
 * Ids of one object: about to come back, come back with a parent, about to be
 * written over. Of those that come back with a parent, `parents[i]` names the
 * record the rewind brings back that `ids[i]` hangs from, as deep as it
 * hangs: their undo sends them back to the bin with that record, never on
 * their own. A journal written before it named them has none.
 *
 * `carriers` marks the records a rewind brings back for a moment, then
 * deletes again — records the checkpoint does not hold, deleted since with
 * records it holds — and what comes back with them: of those, `parents[i]`
 * names the record `ids[i]` hangs from itself, a carrier or one that came
 * back with it. What the rewind gives back of them it moved off that record;
 * what it does not goes back to the bin with the carrier. A journal written
 * before carriers has none.
 */
const idsLineSchema = z.object({
  kind: z.enum(['bringingBack', 'withParent', 'givingBack']),
  objectApiName: objectSchema,
  ids: idsSchema,
  parents: idsSchema.optional(),
  carriers: z.literal(true).optional(),
  at: instantSchema,
});

/**
 * Records of one object the rewind is about to make again, by the Ids the
 * checkpoint holds them by: named before the insert goes.
 */
const recreatingLineSchema = z.object({
  kind: z.literal('recreating'),
  objectApiName: objectSchema,
  ids: idsSchema,
  at: instantSchema,
});

/**
 * Records of one object the rewind made again, by the Ids the org gave them,
 * `from[i]` the Id the checkpoint holds `ids[i]` by: its undo sends them to
 * the recycle bin.
 */
const recreatedLineSchema = z.object({
  kind: z.literal('recreated'),
  objectApiName: objectSchema,
  ids: idsSchema,
  from: idsSchema,
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

/**
 * Records of one object the rewind deletes on their own before a record they
 * point at that it deletes too, `parents[i]` beside `ids[i]`: once both went,
 * Salesforce keeps the record in the recycle bin for good. A record pointing
 * at two such records is named twice.
 */
const beforeParentLineSchema = z.object({
  kind: z.literal('beforeParent'),
  objectApiName: objectSchema,
  ids: idsSchema,
  parents: idsSchema,
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
  beforeParentLineSchema,
  recreatingLineSchema,
  recreatedLineSchema,
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
  'recreating',
  'recreated',
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
  /**
   * Of what it deleted, the records it deleted on their own before a record
   * they point at that went too — deleted by it, or taken along by a record
   * it deleted, as a removal never names such a record: Salesforce keeps them
   * in the recycle bin for good, and Undo cannot bring them back. Absent when
   * there is none.
   */
  deletedBeforeParent?: ObjectIds[];
  /**
   * Of what it brought back, the records that came back with a record it
   * brought back, each beside that record (`parents[i]` beside `ids[i]`), as
   * the journal named them. Absent when there is none, and from a journal
   * written before it named them.
   */
  withParents?: ParentedIds[];
  /**
   * Made again with new Ids, those the recycle bin no longer gave back, by
   * the Ids the org gave them. Absent when there is none.
   */
  recreated?: ObjectIds[];
  /**
   * Of what it brought back, the carriers: records it brought back for a
   * moment, with records of the checkpoint they took along, to delete them
   * again. Absent when there is none.
   */
  carriers?: ObjectIds[];
  /**
   * Of what it brought back, what came back with a carrier, each beside the
   * record it hangs from itself, a carrier or one that came back with it.
   * Absent when there is none.
   */
  carried?: ParentedIds[];
}

/** Records of one object, each beside the record they came back with. */
export interface ParentedIds extends ObjectIds {
  parents: string[];
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
   * the plan is refused. With `carriers`, each batch is named as carriers.
   */
  bringingBack(
    plan: readonly ObjectIds[],
    undelete: UndeleteCall,
    options?: { carriers?: boolean },
  ): UndeleteCall;
  /**
   * Records that come back, or came back, with a parent the rewind brings
   * back, `parents[i]` the record of the plan `ids[i]` hangs from: its undo
   * sends them back to the recycle bin with that record. Named before the
   * undelete that brings them — as the children of each parent the bin holds
   * — they are named even when the rewind stops between that undelete and a
   * read after it. Unnamed, they would hold their parent in the org: a
   * removal keeps a record that records older than it depend on. With
   * `carriers`, they come back with a carrier, and `parents[i]` is the record
   * `ids[i]` hangs from itself.
   */
  withParent(
    objectApiName: string,
    ids: readonly string[],
    parents?: readonly string[],
    options?: { carriers?: boolean },
  ): Promise<void>;
  /**
   * Records the rewind gives back once the records of `by` hanging from them
   * that it deletes are gone, named before anything of the pass is written:
   * their undo gives their values back before those records come back from
   * the bin — seen live, a price book cannot change while an opportunity has
   * products.
   */
  heldInPlace(objectApiName: string, by: readonly string[], ids: readonly string[]): Promise<void>;
  /**
   * Records the next removal deletes on their own before a record they point
   * at that the rewind deletes too, each beside that record, named before the
   * removal is handed them: the rewind's result says Undo couldn't bring back
   * those that went with that record, every pass and resume counted.
   */
  beforeParent(
    objectApiName: string,
    pairs: ReadonlyArray<{ id: string; parent: string }>,
  ): Promise<void>;
  /** Records of one object about to be made again, by the Ids the checkpoint holds them by, before the insert. */
  recreating(objectApiName: string, ids: readonly string[]): Promise<void>;
  /**
   * Records of one object an insert made again, each the Id the org gave it
   * beside the one the checkpoint holds it by: its undo sends them to the bin.
   */
  recreated(
    objectApiName: string,
    pairs: ReadonlyArray<{ from: string; id: string }>,
  ): Promise<void>;
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
  /** The journal as it stands on disk, what the rewind did held in memory. */
  read(): Promise<RewindJournalRead>;
  /** What the journal says beside the ids it names, as it stands on disk: small, whatever it holds. */
  facts(): Promise<RewindJournalFacts>;
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
    carriers = false,
  ): Promise<void> {
    for (const chunk of chunksOf(ids)) {
      await this.append({ kind, objectApiName, ids: chunk, ...(carriers ? { carriers } : {}) });
    }
  }

  bringingBack(
    plan: readonly ObjectIds[],
    undelete: UndeleteCall,
    options: { carriers?: boolean } = {},
  ): UndeleteCall {
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
      await this.appendIds('bringingBack', objectApiName, ids, options.carriers === true);
      return undelete(ids);
    };
  }

  async withParent(
    objectApiName: string,
    ids: readonly string[],
    parents?: readonly string[],
    options: { carriers?: boolean } = {},
  ): Promise<void> {
    const carriers = options.carriers === true;
    if (parents === undefined) {
      await this.appendIds('withParent', objectApiName, ids, carriers);
      return;
    }
    if (parents.length !== ids.length) {
      throw new Error('Each record that comes back with a parent is named beside that parent.');
    }
    for (let at = 0; at < ids.length; at += IDS_PER_LINE) {
      await this.append({
        kind: 'withParent',
        objectApiName,
        ids: ids.slice(at, at + IDS_PER_LINE),
        parents: parents.slice(at, at + IDS_PER_LINE),
        ...(carriers ? { carriers } : {}),
      });
    }
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

  async beforeParent(
    objectApiName: string,
    pairs: ReadonlyArray<{ id: string; parent: string }>,
  ): Promise<void> {
    for (let at = 0; at < pairs.length; at += IDS_PER_LINE) {
      const chunk = pairs.slice(at, at + IDS_PER_LINE);
      await this.append({
        kind: 'beforeParent',
        objectApiName,
        ids: chunk.map(({ id }) => id),
        parents: chunk.map(({ parent }) => parent),
      });
    }
  }

  async recreating(objectApiName: string, ids: readonly string[]): Promise<void> {
    for (const chunk of chunksOf(ids)) {
      await this.append({ kind: 'recreating', objectApiName, ids: chunk });
    }
  }

  async recreated(
    objectApiName: string,
    pairs: ReadonlyArray<{ from: string; id: string }>,
  ): Promise<void> {
    for (let at = 0; at < pairs.length; at += IDS_PER_LINE) {
      const chunk = pairs.slice(at, at + IDS_PER_LINE);
      await this.append({
        kind: 'recreated',
        objectApiName,
        ids: chunk.map(({ id }) => id),
        from: chunk.map(({ from }) => from),
      });
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
    return readJournalFile(join(this.dir, JOURNAL_FILE));
  }

  async facts(): Promise<RewindJournalFacts> {
    await this.queue;
    return readJournalFacts(join(this.dir, JOURNAL_FILE));
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

/**
 * What a journal's lines say, given one at a time as they are read from the
 * disk, never held together: a journal of a rewind of a million records is
 * five hundred lines of two thousand ids. A line a crash cut short, which no
 * write followed, is dropped: it is the last one, and no line break ends it.
 *
 * @returns How many lines were whole, and the bytes they take: past them, a
 *   line a crash cut short.
 * @throws {CheckpointStoreError} `damaged`, at the first line that does not
 *   read as the journal's.
 */
async function eachLine(
  file: string,
  visit: (line: Line) => void | Promise<void>,
): Promise<{ count: number; whole: number; size: number }> {
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
  let count = 0;
  let whole = 0;
  const take = async (text: string): Promise<void> => {
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
        `The rewind’s journal is damaged at line ${count + 1}: it is not used.`,
      );
    }
    pairedOrDamaged(line.data);
    count++;
    await visit(line.data);
  };
  const stream = createReadStream(file, { encoding: 'utf8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  /** The line read last, taken once the next one shows it was not the last. */
  let held: string | undefined;
  try {
    for await (const text of reader) {
      if (held !== undefined) await take(held);
      held = text;
    }
  } finally {
    reader.close();
    stream.destroy();
  }
  if (held !== undefined && endsWhole) await take(held);
  return { count, whole, size };
}

/** A line that names each of its records beside another record must name as many: damage otherwise. */
function pairedOrDamaged(line: Line): void {
  if (line.kind === 'recreated' && line.from.length !== line.ids.length) {
    throw new CheckpointStoreError(
      'damaged',
      'The rewind’s journal names records made again without the Ids they had.',
    );
  }
  if (line.kind === 'beforeParent' && line.parents.length !== line.ids.length) {
    throw new CheckpointStoreError(
      'damaged',
      'The rewind’s journal names records deleted before a parent without their parent.',
    );
  }
  if (
    (line.kind === 'withParent' || line.kind === 'bringingBack') &&
    line.parents !== undefined &&
    line.parents.length !== line.ids.length
  ) {
    throw new CheckpointStoreError(
      'damaged',
      'The rewind’s journal names records that came back with a parent without it.',
    );
  }
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

/**
 * What a journal says beside the ids it names: its head, its passes, when it
 * last wrote and went through, what its removals and its undos left. Small,
 * however many records the rewind wrote: what an undo reads before it plans
 * from the journal on disk (`spoolUndoPlans`).
 */
export type RewindJournalFacts = Omit<RewindJournalRead, 'did'>;

/** {@link RewindJournalFacts}, folded a line at a time, the first being the head. */
class FactsFold {
  /** The first line, as the journal holds it. */
  head?: HeadLine;
  /** The last step a removal was named under. */
  step = 0;
  private passes: RewindJournalRead['passes'] = [];
  private readonly rewindStates: SyncRunRemovalState[] = [];
  private readonly undoStates: SyncRunRemovalState[] = [];
  private readonly undos: RewindJournalRead['undos'] = [];
  private lastWrite = Number.NEGATIVE_INFINITY;
  private endedAt: string | undefined;

  line(line: Line): void {
    if (this.head === undefined) {
      if (line.kind !== 'head') {
        throw new CheckpointStoreError(
          'damaged',
          'The rewind’s journal does not begin with its head.',
        );
      }
      this.head = line;
      this.passes = [{ startedAt: line.startedAt, userId: line.userId }];
      return;
    }
    if (WRITE_LINES.has(line.kind)) this.lastWrite = Math.max(this.lastWrite, Date.parse(line.at));
    if ('step' in line) this.step = Math.max(this.step, line.step);
    switch (line.kind) {
      case 'head':
        throw new CheckpointStoreError('damaged', 'The rewind’s journal has two heads.');
      case 'resumed':
        this.passes.push({ startedAt: line.startedAt, userId: line.userId });
        break;
      case 'removal':
        this.rewindStates.push(stateOf(line.state));
        break;
      case 'end':
        this.endedAt = line.at;
        break;
      case 'undo':
        this.undoStates.push(stateOf(line.state));
        this.undos.push({ status: line.status, at: line.at });
        break;
      default:
        break;
    }
  }

  result(): RewindJournalFacts {
    const first = this.head;
    if (first === undefined) {
      throw new CheckpointStoreError(
        'damaged',
        'The rewind’s journal does not begin with its head.',
      );
    }
    return {
      head: {
        rewindId: first.rewindId,
        checkpointId: first.checkpointId,
        organizationId: first.organizationId,
        startedAt: first.startedAt,
        userId: first.userId,
        ...(first.automatedProcessUserId !== undefined
          ? { automatedProcessUserId: first.automatedProcessUserId }
          : {}),
        backup: first.backup,
      },
      passes: this.passes,
      ...(Number.isFinite(this.lastWrite)
        ? { lastWriteAt: new Date(this.lastWrite).toISOString() }
        : {}),
      ...(this.endedAt !== undefined ? { endedAt: this.endedAt } : {}),
      rewind: foldState(this.rewindStates),
      undo: foldState(this.undoStates),
      undos: this.undos,
    };
  }
}

/** What a journal says the rewind did, folded a line at a time, held in memory: see {@link RewindJournalDid}. */
class DidFold {
  private readonly broughtBack = new IdsByObject();
  private readonly recreated = new IdsByObject();
  private readonly carriers = new IdsByObject();
  /** What came back with a carrier, beside the record it hangs from, each once by its key. */
  private readonly carried = new Map<
    string,
    { objectApiName: string; id: string; parent: string }
  >();
  private readonly givenBack = new IdsByObject();
  private readonly held = new IdsByObject();
  /** Per object held in place, the objects whose records held it, in the order named. */
  private readonly heldBy = new Map<string, Set<string>>();
  /** Records deleted on their own before a record they point at, beside that record. */
  private readonly beforeParent: Array<{ objectApiName: string; id: string; parent: string }> = [];
  /** Records that came back with a parent, beside it, each once by its key. */
  private readonly withParents = new Map<
    string,
    { objectApiName: string; id: string; parent: string }
  >();
  /** Per step: what it set out to delete, what it left, and whether its removal answered. */
  private readonly steps = new Map<
    number,
    { deleting: IdsByObject; left: Set<string>; answered: boolean }
  >();

  private stepOf(step: number): { deleting: IdsByObject; left: Set<string>; answered: boolean } {
    let held = this.steps.get(step);
    if (!held) {
      held = { deleting: new IdsByObject(), left: new Set(), answered: false };
      this.steps.set(step, held);
    }
    return held;
  }

  line(line: Line): void {
    switch (line.kind) {
      case 'bringingBack':
      case 'withParent':
        this.broughtBack.add(line.objectApiName, line.ids);
        if (line.carriers === true && line.kind === 'bringingBack') {
          this.carriers.add(line.objectApiName, line.ids);
        }
        line.parents?.forEach((parent, at) => {
          const id = line.ids[at];
          const into = line.carriers === true ? this.carried : this.withParents;
          if (!into.has(recordKey(id))) {
            into.set(recordKey(id), { objectApiName: line.objectApiName, id, parent });
          }
        });
        break;
      case 'givingBack':
        this.givenBack.add(line.objectApiName, line.ids);
        break;
      case 'recreated':
        this.recreated.add(line.objectApiName, line.ids);
        break;
      case 'heldInPlace': {
        this.held.add(line.objectApiName, line.ids);
        const by = this.heldBy.get(line.objectApiName) ?? new Set<string>();
        for (const object of line.by) by.add(object);
        this.heldBy.set(line.objectApiName, by);
        break;
      }
      case 'beforeParent':
        line.ids.forEach((id, at) => {
          this.beforeParent.push({
            objectApiName: line.objectApiName,
            id,
            parent: line.parents[at],
          });
        });
        break;
      case 'deleting':
        this.stepOf(line.step).deleting.add(line.objectApiName, line.ids);
        break;
      case 'deleteLeft':
        for (const id of line.ids) this.stepOf(line.step).left.add(recordKey(id));
        break;
      case 'deleted':
        this.stepOf(line.step).answered = true;
        break;
      default:
        break;
    }
  }

  result(): RewindJournalDid {
    // What each removal deleted: what it set out to, less what it left once it
    // answered; all of it when it never did, the undo finding out which of
    // them the recycle bin holds.
    const deleted = new IdsByObject();
    for (const { deleting, left, answered } of this.steps.values()) {
      for (const { objectApiName, ids } of deleting.list((key) => !answered || !left.has(key))) {
        deleted.add(objectApiName, ids);
      }
    }
    const heldInPlace = this.held.list().map(({ objectApiName, ids }) => ({
      objectApiName,
      ids,
      by: [...(this.heldBy.get(objectApiName) ?? [])],
    }));
    // A record deleted before its parent stays in the bin for good once that
    // parent went too: deleted by a removal, or never handed to one — taken
    // along by a record it hangs from. One a removal kept leaves it to come
    // back.
    const gone = deleted.keys();
    const named = new Set([...this.steps.values()].flatMap(({ deleting }) => [...deleting.keys()]));
    const before = new IdsByObject();
    for (const { objectApiName, id, parent } of this.beforeParent) {
      const parentKey = recordKey(parent);
      if (gone.has(recordKey(id)) && (gone.has(parentKey) || !named.has(parentKey))) {
        before.add(objectApiName, [id]);
      }
    }
    const deletedBeforeParent = before.list();
    const parentedOf = (
      pairs: Iterable<{ objectApiName: string; id: string; parent: string }>,
    ): ParentedIds[] => {
      const parented = new Map<string, ParentedIds>();
      for (const { objectApiName, id, parent } of pairs) {
        const object = parented.get(objectApiName) ?? { objectApiName, ids: [], parents: [] };
        object.ids.push(id);
        object.parents.push(parent);
        parented.set(objectApiName, object);
      }
      return [...parented.values()];
    };
    const withParents = parentedOf(this.withParents.values());
    const carried = parentedOf(this.carried.values());
    const carriers = this.carriers.list();
    const recreated = this.recreated.list();
    return {
      broughtBack: this.broughtBack.list(),
      deleted: deleted.list(),
      givenBack: this.givenBack.list(),
      ...(heldInPlace.length > 0 ? { heldInPlace } : {}),
      ...(deletedBeforeParent.length > 0 ? { deletedBeforeParent } : {}),
      ...(withParents.length > 0 ? { withParents } : {}),
      ...(recreated.length > 0 ? { recreated } : {}),
      ...(carriers.length > 0 ? { carriers } : {}),
      ...(carried.length > 0 ? { carried } : {}),
    };
  }
}

/** A journal's file, read whole: what it says, and what the rewind did, held in memory. */
async function readJournalFile(file: string): Promise<RewindJournalRead> {
  const facts = new FactsFold();
  const did = new DidFold();
  try {
    await eachLine(file, (line) => {
      facts.line(line);
      did.line(line);
    });
  } catch (err: unknown) {
    if (err instanceof CheckpointStoreError) throw err;
    throw new CheckpointStoreError('notFound', 'No journal of this rewind is kept.');
  }
  return { ...facts.result(), did: did.result() };
}

/** A journal's file, read for what it says beside its ids, a line at a time. */
async function readJournalFacts(file: string): Promise<RewindJournalFacts> {
  const facts = new FactsFold();
  try {
    await eachLine(file, (line) => facts.line(line));
  } catch (err: unknown) {
    if (err instanceof CheckpointStoreError) throw err;
    throw new CheckpointStoreError('notFound', 'No journal of this rewind is kept.');
  }
  return facts.result();
}

/** Check that a journal is the one of the folder it was read from. */
function belongsTo(
  read: Pick<RewindJournalRead, 'head'>,
  folder: CheckpointFolder,
  rewindId: string,
): void {
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

/**
 * Read the journal of one rewind of a checkpoint: what it says, and what the
 * rewind did, held in memory. An undo plans from the journal on disk instead
 * (`spoolUndoPlans`).
 */
export async function readRewindJournal(
  folder: CheckpointFolder,
  rewindId: string,
): Promise<RewindJournalRead> {
  const kept = await keptJournal(folder, rewindId);
  if (!kept) throw new CheckpointStoreError('notFound', 'No journal of this rewind is kept.');
  return readJournalFile(kept.file);
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

/** A journal kept on disk, read a line at a time, before it is written to again. */
interface KeptJournal {
  dir: string;
  file: string;
  /** Its first line, as the journal holds it. */
  head: HeadLine;
  /** The last step a removal was named under. */
  step: number;
  /** Bytes of its whole lines: past them, a line a crash cut short. */
  whole: number;
  size: number;
  facts: RewindJournalFacts;
}

/**
 * The journal of one rewind of a checkpoint, read for what it says beside its
 * ids; undefined when it is not there or holds no line yet — a rewind stopped
 * before it wrote its head, which wrote nothing to the org.
 *
 * @throws {CheckpointStoreError} `damaged`, when it cannot be read or is another's.
 */
async function keptJournal(
  folder: CheckpointFolder,
  rewindId: string,
): Promise<KeptJournal | undefined> {
  const dir = rewindDirOf(folder, rewindId);
  const file = join(dir, JOURNAL_FILE);
  const fold = new FactsFold();
  let read: Awaited<ReturnType<typeof eachLine>>;
  try {
    read = await eachLine(file, (line) => fold.line(line));
  } catch (err: unknown) {
    if (err instanceof CheckpointStoreError) throw err;
    return undefined;
  }
  if (read.count === 0 || fold.head === undefined) return undefined;
  const facts = fold.result();
  belongsTo(facts, folder, rewindId);
  return { dir, file, head: fold.head, step: fold.step, whole: read.whole, size: read.size, facts };
}

/** Open a kept journal to add to it: what a crash cut short goes before the next line does. */
async function reopened(kept: KeptJournal, now: () => Date): Promise<JournalFile> {
  if (kept.whole < kept.size) await truncate(kept.file, kept.whole);
  return JournalFile.opened(kept.dir, kept.head, true, kept.step, now);
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
    if (kept.facts.endedAt !== undefined || kept.facts.undos.length > 0) continue;
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

/** The journal of an earlier rewind of an org, deleted once a later one ended. */
export interface EarlierJournalRemoved {
  checkpointId: string;
  /** The name of the checkpoint it rewound to. */
  name: string;
  rewindId: string;
}

/**
 * Delete the journals of an org's earlier rewinds, once a rewind of the org
 * has ended: Undo is offered for the org's last rewind alone
 * (`latestRewindOf`), and each journal holds, unencrypted, the values its
 * rewind wrote over. Kept until their checkpoint went, they built up, one per
 * rewind, in a pipeline that rewinds a checkpoint it keeps for good.
 *
 * Kept: the rewind that ended, the org's last rewind, which Undo reaches, and
 * a journal still open — a rewind stopped part way, which the next rewind of
 * its checkpoint takes up. So is a journal that cannot be read, which no
 * rewind starts over (`openRewindJournal`), a folder that holds no journal
 * yet, and what a damaged checkpoint holds, deleted with it. Run under the
 * org's lock, held for the rewind.
 *
 * @param ended - The rewind that ended, and the checkpoint it rewound to.
 * @returns Each journal deleted, to be named as the sweep names what it deletes.
 */
export async function removeEarlierJournals(
  store: Pick<OrgCheckpointStore, 'checkpointsOf'>,
  lock: OrgLock,
  ended: { checkpointId: string; rewindId: string },
): Promise<EarlierJournalRemoved[]> {
  const reads = await store.checkpointsOf(lock.organizationId);
  const latest = latestRewindOf(reads);
  const removed: EarlierJournalRemoved[] = [];
  // Ids are named by when the take began: named in that order.
  const byTake = [...reads].sort((a, b) =>
    a.folder.checkpointId < b.folder.checkpointId ? -1 : 1,
  );
  for (const { folder, checkpoint } of byTake) {
    if (checkpoint === undefined) continue;
    let rewindIds: string[];
    try {
      rewindIds = (await readdir(folder.rewindsDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && rewindIdSchema.safeParse(entry.name).success)
        .map((entry) => entry.name)
        .sort();
    } catch {
      continue;
    }
    const kept = (rewindId: string, of: { checkpointId: string; rewindId: string } | undefined) =>
      of?.checkpointId === folder.checkpointId && of.rewindId === rewindId;
    for (const rewindId of rewindIds) {
      if (kept(rewindId, ended) || kept(rewindId, latest)) continue;
      const journal = await keptJournal(folder, rewindId).catch(() => undefined);
      if (journal === undefined) continue;
      const open = journal.facts.endedAt === undefined && journal.facts.undos.length === 0;
      if (open) continue;
      await rm(rewindDirOf(folder, rewindId), { recursive: true, force: true });
      removed.push({ checkpointId: folder.checkpointId, name: checkpoint.name, rewindId });
    }
  }
  return removed;
}

// ─── The undo's plans ────────────────────────────────────────────────────────

/** A record and the record it goes with: see {@link ParentedSpool}. */
export interface Parented {
  id: string;
  parent: string;
}

/**
 * Records of each object, each beside the record it goes back to the bin
 * with, written to a folder, one pair a line, each record once: read back a
 * page at a time, and told by an exact set of their keys.
 */
export class ParentedSpool {
  private constructor(
    private readonly dir: string,
    readonly objects: ReadonlyArray<{ readonly objectApiName: string; readonly count: number }>,
    /** The keys of the records, never their parents'. */
    readonly keys: RecordKeySet,
  ) {}

  /** Records held, every object's. */
  get count(): number {
    return this.objects.reduce((sum, object) => sum + object.count, 0);
  }

  /** A spool written by `add` as `write` gives it pairs, in the order the objects come. */
  static async written(
    dir: string,
    write: (add: (objectApiName: string, pair: Parented) => Promise<void>) => Promise<void>,
  ): Promise<ParentedSpool> {
    await makePrivateDir(dir);
    const keys = new RecordKeySet();
    const counts = new Map<string, number>();
    const held = new Map<string, string[]>();
    const flush = async (objectApiName: string): Promise<void> => {
      const lines = held.get(objectApiName) ?? [];
      if (lines.length === 0) return;
      await appendSynced(pairsFileOf(dir, objectApiName), lines.join(''));
      held.set(objectApiName, []);
    };
    await write(async (objectApiName, { id, parent }) => {
      if (!keys.add(id)) return;
      counts.set(objectApiName, (counts.get(objectApiName) ?? 0) + 1);
      const lines = held.get(objectApiName) ?? [];
      lines.push(`${id} ${parent}\n`);
      held.set(objectApiName, lines);
      if (lines.length >= IDS_PER_LINE) await flush(objectApiName);
    });
    for (const objectApiName of counts.keys()) await flush(objectApiName);
    return new ParentedSpool(
      dir,
      [...counts].map(([objectApiName, count]) => ({ objectApiName, count })),
      keys,
    );
  }

  /** The pairs of `objectApiName`, `size` at a time, as written. */
  async *pages(objectApiName: string, size = IDS_PER_LINE): AsyncGenerator<Parented[]> {
    if (!this.objects.some((object) => object.objectApiName === objectApiName)) return;
    const stream = createReadStream(pairsFileOf(this.dir, objectApiName), { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let page: Parented[] = [];
    try {
      for await (const line of lines) {
        const [id, parent] = line.split(' ');
        if (id === undefined || parent === undefined) continue;
        page.push({ id, parent });
        if (page.length >= size) {
          yield page;
          page = [];
        }
      }
    } finally {
      lines.close();
      stream.destroy();
    }
    if (page.length > 0) yield page;
  }
}

/** Where a parented spool keeps the pairs of one object. */
function pairsFileOf(dir: string, objectApiName: string): string {
  return join(dir, `${sanitizeSoqlObjectName(objectApiName)}.pairs`);
}

/**
 * What an undo of the rewind a journal is of does, kept on disk, object by
 * object: see {@link spoolUndoPlans}. Each plan is read back a page at a
 * time; what stays in memory is a set of keys per plan, some 25 bytes a
 * record.
 */
export interface SpooledUndoPlans {
  /**
   * What the rewind brought back, which goes back to the recycle bin on its
   * own, and what it made again with new Ids, which goes there too: children
   * first.
   */
  remove: SpooledRunRecords;
  /** What the rewind deleted, which comes back from the recycle bin, parents first. */
  bringBack: IdSpool;
  /** What the rewind wrote over, given back the values it held before, kept in {@link backup}. */
  giveBack: IdSpool;
  /** The keys of {@link giveBack}'s records. */
  giveBackKeys: RecordKeySet;
  /** The backup the values from before are kept in. */
  backup: string;
  /**
   * Of {@link giveBack}, the records whose values records the rewind deleted
   * held in place, by key, and per object how many and the objects whose
   * records held them: given back before those records come back.
   */
  held: {
    keys: RecordKeySet;
    objects: Array<{ objectApiName: string; count: number; by: string[] }>;
  };
  /**
   * What the rewind brought back with a record of {@link remove}, each beside
   * that record: never sent to the bin on its own, it goes with that record.
   * Sent first, children first, it was deleted alone, and Salesforce keeps a
   * record deleted alone whose parent is deleted after it in the bin for
   * good: an opportunity's products could no longer come back with it.
   */
  goesWithParent: ParentedSpool;
  /**
   * Of {@link remove}, the records the rewind made again with new Ids, by
   * key, and per object how many: deleted again, never brought back.
   */
  remade: { keys: RecordKeySet; objects: Array<{ objectApiName: string; count: number }> };
  /**
   * The records the rewind brought back and deleted again, by key — a
   * carrier, what came back with a parent and went again — and what went
   * back to the bin with a carrier: in the recycle bin as they were before
   * the rewind, in none of the plans. A value from before that names one is
   * not given back: the org refuses a lookup to a record in the bin
   * (`ENTITY_IS_DELETED`, live).
   */
  compensated: Pick<RecordKeySet, 'has'>;
  /**
   * Of {@link remove}, the records that came back with a carrier and that
   * the rewind gave their checkpoint values back, which moved them off it, by
   * key, and per object how many: sent back to the bin on their own, as the
   * carrier stays there.
   */
  carriedAlone: { keys: RecordKeySet; objects: Array<{ objectApiName: string; count: number }> };
  /** Remove the plans' files. Once is enough. */
  dispose(): Promise<void>;
}

/**
 * The objects of a plan in the checkpoint's reading order, children first; an
 * object the checkpoint does not hold — a child outside it that came back with
 * its parent — first.
 */
function readingOrder(
  objects: ReadonlyArray<Pick<CheckpointObject, 'objectApiName' | 'readOrder'>>,
  parentsFirst: boolean,
): (
  spooled: Array<{ objectApiName: string; count: number }>,
) => Array<{ objectApiName: string; count: number }> {
  const order = new Map(objects.map((object) => [object.objectApiName, object.readOrder]));
  const rank = (objectApiName: string): number => order.get(objectApiName) ?? -1;
  return (spooled) =>
    [...spooled].sort((a, b) =>
      parentsFirst
        ? rank(b.objectApiName) - rank(a.objectApiName)
        : rank(a.objectApiName) - rank(b.objectApiName),
    );
}

/**
 * What an undo of the rewind a journal is of does, and in what order, written
 * to a folder of their own in the journal's, read from the journal a line at
 * a time — four reads of its file, none held whole:
 *
 * - `remove`: what the rewind brought back from the recycle bin, and what came
 *   back with it, and what it made again with new Ids, children first;
 * - `bringBack`: what it deleted, parents first — the undelete follows the
 *   order it is given, and a child the bin holds without its parent stays
 *   there;
 * - `giveBack`: what it wrote over, from the values kept before;
 * - `held`: of those, the records it gave back once the records hanging from
 *   them that it deleted were gone — values those records held in place, which
 *   the undo gives back before they come back;
 * - `goesWithParent`: of what came back with a record of `remove`, as the
 *   journal names it beside that record, what goes back to the bin with it,
 *   left out of `remove`: deleted on its own first, Salesforce would keep it
 *   in the bin for good once that record went after it.
 *
 * What came back with a carrier — a record the rewind brought back for a
 * moment and deleted again — is named beside the record it hangs from
 * itself. What of it the rewind did not give back went back to the bin with
 * the carrier, and is in none of the plans. What it gave back it moved off
 * the carrier: sent back to the bin on its own (`carriedAlone`), unless it
 * hangs from another such record, which it goes with.
 *
 * A record it brought back and deleted again — one that came back with its
 * parent and that a second pass deleted — is in the recycle bin as it was
 * before the rewind, and in neither of the first two: undeleted by the undo,
 * it would hold the parent the undo sends back to the bin. An undo that ended
 * part way left, of each plan, what it did not settle: the next one takes up
 * that alone.
 *
 * Held in memory, the plans of a rewind of a million records took some 700 MB
 * of the extension host: every id as a string in three maps, the journal's
 * lines whole beside them.
 *
 * @param objects - The checkpoint's objects, children first (`readOrder`).
 * @throws {CheckpointStoreError} `damaged`, when the journal does not read as one.
 */
export async function spoolUndoPlans(
  journalDir: string,
  facts: Pick<RewindJournalFacts, 'head' | 'undo'>,
  objects: ReadonlyArray<Pick<CheckpointObject, 'objectApiName' | 'readOrder'>>,
): Promise<SpooledUndoPlans> {
  const journalFile = join(journalDir, JOURNAL_FILE);
  // A folder of its own each time, in the journal's: an undo and a list's
  // count of it may read the plans at once.
  const dir = join(journalDir, `undo-${randomBytes(4).toString('hex')}`);
  const dispose = (): Promise<void> => rm(dir, { recursive: true, force: true });
  try {
    const leftOf = (left: readonly string[] | undefined): ((key: string) => boolean) => {
      if (left === undefined) return () => true;
      const keys = new RecordKeySet();
      for (const id of left) keys.add(id);
      return (key) => keys.has(key);
    };
    const removeLeft = leftOf(facts.undo.removalLeft);
    const undeleteLeft = leftOf(facts.undo.undeleteLeft);
    const restoreLeft = leftOf(facts.undo.restoreLeft);

    // What it brought back, what each removal left, and what was held in place.
    const brought = new RecordKeySet();
    const answered = new Set<number>();
    const leftByStep = new Map<number, RecordKeySet>();
    const heldKeys = new RecordKeySet();
    const heldBy = new Map<string, Set<string>>();
    const givenKeys = new RecordKeySet();
    /** What came back with a carrier, by key, beside the record it hangs from. */
    const carried = new Map<string, { objectApiName: string; id: string; parent: string }>();
    await eachLine(journalFile, (line) => {
      switch (line.kind) {
        case 'bringingBack':
        case 'withParent':
        case 'recreated':
          for (const id of line.ids) brought.add(id);
          if (line.kind === 'withParent' && line.carriers === true && line.parents) {
            line.ids.forEach((id, at) => {
              const parent = line.parents?.[at];
              if (parent !== undefined && !carried.has(recordKey(id))) {
                carried.set(recordKey(id), {
                  objectApiName: line.objectApiName,
                  id,
                  parent: recordKey(parent),
                });
              }
            });
          }
          break;
        case 'givingBack':
          for (const id of line.ids) givenKeys.add(id);
          break;
        case 'deleteLeft': {
          const left = leftByStep.get(line.step) ?? new RecordKeySet();
          for (const id of line.ids) left.add(id);
          leftByStep.set(line.step, left);
          break;
        }
        case 'deleted':
          answered.add(line.step);
          break;
        case 'heldInPlace': {
          for (const id of line.ids) heldKeys.add(id);
          const by = heldBy.get(line.objectApiName) ?? new Set<string>();
          for (const object of line.by) by.add(object);
          heldBy.set(line.objectApiName, by);
          break;
        }
        default:
          break;
      }
    });

    // What each removal deleted — what it set out to, less what it left once
    // it answered; all of it when it never did — and of it, what comes back.
    // Of what it deleted, only what it brought back too is held by its key:
    // what the plans of what goes back to the bin ask of it.
    const deleted = new RecordKeySet();
    const back = new IdSpoolWriter(join(dir, 'bringBack'));
    await eachLine(journalFile, async (line) => {
      if (line.kind !== 'deleting') return;
      const left = answered.has(line.step) ? leftByStep.get(line.step) : undefined;
      for (const id of line.ids) {
        if (left?.has(id) === true) continue;
        const key = recordKey(id);
        if (brought.has(key)) deleted.add(id);
        else if (undeleteLeft(key)) await back.add(line.objectApiName, id);
      }
    });
    // What came back with a carrier deleted again, and that the rewind did
    // not move off it, went back to the bin with it: as far down as it hangs.
    const compensated = new RecordKeySet();
    for (let grew = carried.size > 0; grew;) {
      grew = false;
      for (const { id, parent } of carried.values()) {
        if (compensated.has(id) || givenKeys.has(id)) continue;
        if (deleted.has(parent) || compensated.has(parent)) {
          compensated.add(id);
          grew = true;
        }
      }
    }
    const gone = (key: string): boolean => deleted.has(key) || compensated.has(key);
    const removing = (key: string): boolean => !gone(key) && removeLeft(key);

    // What came back with a record the undo sends back to the bin goes with
    // it; what came back with one it does not — deleted again since, or left
    // by an undo before — is sent on its own, as it always was.
    // Each record by the first line that names it beside a parent.
    const along = new RecordKeySet();
    const named = new RecordKeySet();
    await eachLine(journalFile, (line) => {
      if (line.kind !== 'withParent' || line.parents === undefined) return;
      line.ids.forEach((id, at) => {
        if (!named.add(id)) return;
        const parent = recordKey(line.parents?.[at] ?? '');
        if (removing(recordKey(id)) && brought.has(parent) && removing(parent)) along.add(id);
      });
    });
    // Of what came back with a carrier, what the rewind moved off it goes on
    // its own, unless it still hangs from a record of the plan.
    const carriedAlone = new RecordKeySet();
    const carriedCounts = new Map<string, number>();
    for (const { objectApiName, id, parent } of carried.values()) {
      if (!removing(recordKey(id)) || along.has(id) || !givenKeys.has(id)) continue;
      if (removing(parent) && carried.has(parent)) continue;
      carriedAlone.add(id);
      carriedCounts.set(objectApiName, (carriedCounts.get(objectApiName) ?? 0) + 1);
    }

    const remove = new IdSpoolWriter(join(dir, 'remove'));
    const given = new IdSpoolWriter(join(dir, 'giveBack'));
    const remade = new RecordKeySet();
    const remadeCounts = new Map<string, number>();
    const goesWithParent = await ParentedSpool.written(join(dir, 'goesWithParent'), async (add) => {
      await eachLine(journalFile, async (line) => {
        if (line.kind === 'givingBack') {
          for (const id of line.ids) {
            if (restoreLeft(recordKey(id))) await given.add(line.objectApiName, id);
          }
          return;
        }
        if (line.kind === 'recreated') {
          // Made by the rewind: deleted by its undo, as it was not there before.
          for (const id of line.ids) {
            if (!removing(recordKey(id)) || !(await remove.add(line.objectApiName, id))) continue;
            remade.add(id);
            remadeCounts.set(line.objectApiName, (remadeCounts.get(line.objectApiName) ?? 0) + 1);
          }
          return;
        }
        if (line.kind !== 'bringingBack' && line.kind !== 'withParent') return;
        for (const [at, id] of line.ids.entries()) {
          const key = recordKey(id);
          if (!removing(key)) continue;
          const parent = line.parents?.[at];
          if (along.has(key)) {
            // A parent that came back with a parent of its own goes with that
            // one: named beside the record of the plan it hangs from.
            if (parent !== undefined) await add(line.objectApiName, { id, parent });
          } else await remove.add(line.objectApiName, id);
        }
      });
    });
    const giveBack = await given.finish();
    const held = new RecordKeySet();
    const heldCounts = new Map<string, number>();
    for (const { objectApiName } of giveBack.objects) {
      for await (const page of giveBack.pages(objectApiName)) {
        for (const id of page) {
          if (!heldKeys.has(id)) continue;
          held.add(id);
          heldCounts.set(objectApiName, (heldCounts.get(objectApiName) ?? 0) + 1);
        }
      }
    }
    return {
      remove: await SpooledRunRecords.of(remove, readingOrder(objects, false)),
      bringBack: await back.finish(readingOrder(objects, true)),
      giveBack,
      giveBackKeys: given.keys,
      backup: facts.head.backup,
      held: {
        keys: held,
        objects: [...heldCounts].map(([objectApiName, count]) => ({
          objectApiName,
          count,
          by: [...(heldBy.get(objectApiName) ?? [])],
        })),
      },
      goesWithParent,
      remade: {
        keys: remade,
        objects: [...remadeCounts].map(([objectApiName, count]) => ({ objectApiName, count })),
      },
      compensated: { has: (id) => gone(recordKey(String(id))) },
      carriedAlone: {
        keys: carriedAlone,
        objects: [...carriedCounts].map(([objectApiName, count]) => ({ objectApiName, count })),
      },
      dispose,
    };
  } catch (err: unknown) {
    await dispose();
    throw err;
  }
}

/**
 * The undo's plans of the rewind `rewindId` of a checkpoint, written to a
 * folder of their own in the rewind's: see {@link spoolUndoPlans}. The
 * caller disposes of them once it is through.
 *
 * @throws {CheckpointStoreError} `notFound` when the journal is not kept,
 *   `damaged` when it cannot be read or is another's.
 */
export async function undoPlansOf(
  folder: CheckpointFolder,
  rewindId: string,
  objects: ReadonlyArray<Pick<CheckpointObject, 'objectApiName' | 'readOrder'>>,
): Promise<SpooledUndoPlans> {
  const kept = await keptJournal(folder, rewindId);
  if (!kept) throw new CheckpointStoreError('notFound', 'No journal of this rewind is kept.');
  return spoolUndoPlans(kept.dir, kept.facts, objects);
}

/** What an undo's plans take back, per object: what its estimate is made from (`undoEstimate`). */
export function rewoundObjects(plans: SpooledUndoPlans): RewoundObject[] {
  const byObject = new Map<string, RewoundObject>();
  const of = (objectApiName: string): RewoundObject => {
    let object = byObject.get(objectApiName);
    if (!object) {
      object = { objectApiName, deleted: 0, broughtBack: 0, givenBack: 0 };
      byObject.set(objectApiName, object);
    }
    return object;
  };
  for (const { objectApiName, count } of plans.bringBack.objects) {
    if (count > 0) of(objectApiName).deleted += count;
  }
  for (const { objectApiName, count } of plans.remove.objects) {
    if (count > 0) of(objectApiName).broughtBack += count;
  }
  for (const { objectApiName, count } of plans.giveBack.objects) {
    if (count > 0) of(objectApiName).givenBack += count;
  }
  for (const { objectApiName, count } of plans.held.objects) {
    const object = of(objectApiName);
    object.givenBackHeld = (object.givenBackHeld ?? 0) + count;
  }
  return [...byObject.values()];
}
