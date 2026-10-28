/**
 * Where an org's checkpoints are kept on this machine, how their files are
 * written, how long they are kept, and the lock that keeps two takes,
 * rewinds or undos of one org apart.
 *
 * One store serves the panel and the command line: a checkpoint taken in the
 * editor is rewound by a CI step, and the other way round. It is the
 * `checkpoints/` folder of the one `SANDFORGE_JOURNAL_DIR` names, or of
 * `.sandforge` in the home directory, with one folder per Organization Id and
 * one per checkpoint inside it:
 *
 * ```
 * <store>/<organizationId>/<checkpointId>/
 *   checkpoint.json        what the checkpoint holds, written last
 *   fingerprints.json.gz   each object's field prints, written before it
 *   snapshots.json         the snapshot's DataOps metadata
 *   backups/               the values, one gzip file of NDJSON lines per object
 *   index/<Object>.idx     where each row of an object's values is
 *   bin/<Object>.ids       the ids in the recycle bin when the take began
 *   files/                 the links of its files to its records, and each
 *                          file's latest version and size (`checkpointFiles.ts`)
 *   previews/<previewId>/  one preview's spooled reads, kept a day
 *   rewinds/<rewindId>/    one rewind's journal, kept while it can be undone
 * ```
 *
 * The values, the prints and the files' annex are compressed
 * (`compressedSnapshotFiles.ts`): a snapshot is most of what a checkpoint of
 * a busy org takes on disk, and its lines repeat every field's name. A checkpoint taken before holds them
 * plain — `fingerprints.json` and `.ndjson` files — and is read as it was
 * written, never converted. `checkpoint.json` stays plain: every listing
 * reads it.
 *
 * A checkpoint holds the records' values as the org held them, personal data
 * among them, in clear — compressed is not encrypted, and `zcat` reads them —
 * so every folder is made readable by its owner alone and every file
 * likewise, and a store another user owns is refused, since that user could
 * read the snapshots and replace them before a rewind writes them back.
 * Deleting a checkpoint deletes its folder, the Undo of its rewinds with it.
 *
 * `checkpoint.json` is parsed on every read, and a file that does not parse,
 * or that names another checkpoint or another org than its folder, is listed
 * as damaged and never used: a rewind plans its deletions from what the file
 * says the snapshot holds. It is written last and whole, through a file
 * beside it renamed over it, so a take or a change stopped part way leaves
 * the file as it was, or no file, never half of one.
 *
 * The lock of an org is not in the store: two stores — the default one and
 * one a command line names — would otherwise take two locks of one org, and
 * a rewind from each would write to it at once. It is one file per
 * Organization Id in `.sandforge/locks` of the home directory, whatever store
 * is used, naming the process that holds it, and it is taken over once that
 * process is gone.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import * as z from 'zod';
import {
  checkpointIdSchema,
  checkpointOrganizationIdSchema,
  orgCheckpointSchema,
  previewIdSchema,
  rewindIdSchema,
  type CheckpointListEntry,
  type CheckpointInvalidReason,
  type OrgCheckpoint,
} from '@sandforge/shared';
import { canonicalRecordId } from '../../core/common/existingRecordMatch.js';
import type { RunWriterChecks } from '../sync/runWriter.js';
import { objectFingerprintSchema, type ObjectFingerprint } from './checkpointFingerprint.js';
import {
  linkedLockKind,
  lockHolderShape,
  type LinkedLockOptions,
  type LockSelf,
} from './linkedLock.js';

/** What a folder of the store is made with: its owner alone lists and reads it. */
export const CHECKPOINT_DIR_MODE = 0o700;

/** What a file of the store is made with: its owner alone reads it. */
export const CHECKPOINT_FILE_MODE = 0o600;

/** Days a checkpoint is kept when its take names none. */
export const DEFAULT_KEEP_DAYS = 30;

/** Days before a checkpoint expires that the list warns of it, with [Keep]. */
export const EXPIRY_WARNING_DAYS = 3;

/**
 * Days the recycle bin keeps what is deleted: a record deleted longer ago
 * than this can no longer come back with its Id.
 */
export const RECYCLE_BIN_DAYS = 15;

/** How long a preview's spooled reads are kept: the rewind it was for runs within the day. */
export const PREVIEW_KEEP_MS = 24 * 60 * 60_000;

const DAY_MS = 24 * 60 * 60_000;

const gzipped = promisify(gzip);
const gunzipped = promisify(gunzip);

/** The file a checkpoint is described by, in its folder. */
const CHECKPOINT_FILE = 'checkpoint.json';

/** The file its objects' field prints are kept in, in its folder: a gzip of the JSON whole. */
const FINGERPRINTS_FILE = 'fingerprints.json.gz';

/** The file a checkpoint taken before the compression keeps its field prints in, plain. */
const PLAIN_FINGERPRINTS_FILE = 'fingerprints.json';

/** The file its snapshot's DataOps metadata is kept in, in its folder. */
const SNAPSHOTS_FILE = 'snapshots.json';

/** An object's API name, as the index and bin files of one are named by. */
const OBJECT_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

// ─── Where things are ────────────────────────────────────────────────────────

/**
 * The store when nothing names another: `checkpoints/` in the folder
 * `SANDFORGE_JOURNAL_DIR` names, the command lines' own, or in `.sandforge` in
 * the home directory.
 */
export function defaultCheckpointStoreRoot(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env['SANDFORGE_JOURNAL_DIR'];
  const home =
    dir !== undefined && dir.trim() !== '' ? resolve(dir) : join(homedir(), '.sandforge');
  return join(home, 'checkpoints');
}

/**
 * Where the locks of every org are, whatever store is used and whatever
 * `SANDFORGE_JOURNAL_DIR` says: one place per user of the machine.
 */
export function defaultCheckpointLocksDir(home: string = homedir()): string {
  return join(home, '.sandforge', 'locks');
}

/**
 * The name an org's folder and lock file go by: its Organization Id in the
 * 18-character form, whichever form it was given in. The two forms of one org
 * would otherwise be two folders and two locks, and the 15-character form is
 * read apart by case alone, which the file systems of Windows and macOS do
 * not tell apart.
 *
 * @throws {CheckpointStoreError} `invalid`, when it is not an Organization Id.
 */
export function organizationKey(organizationId: string): string {
  const key = checkpointOrganizationIdSchema.safeParse(organizationId).success
    ? canonicalRecordId(organizationId.slice(0, 15))
    : undefined;
  if (key === undefined) throw new CheckpointStoreError('invalid', 'Not an Organization Id');
  return key;
}

/** Whether a folder's name is an org's, as {@link organizationKey} names it. */
function isOrganizationKey(name: string): boolean {
  return (
    name.length === 18 &&
    checkpointOrganizationIdSchema.safeParse(name).success &&
    canonicalRecordId(name.slice(0, 15)) === name
  );
}

/** A checkpoint's folder, and where each of its parts is in it. */
export interface CheckpointFolder {
  /** The org it is filed under, as {@link organizationKey} names it. */
  organizationId: string;
  checkpointId: string;
  dir: string;
  checkpointFile: string;
  /** Where a take writes its objects' field prints, compressed. */
  fingerprintsFile: string;
  /** Where a take before the compression wrote them, plain: read when the other is not there. */
  plainFingerprintsFile: string;
  /** What a DataOps handler bound to {@link dir} keeps of the snapshot. */
  snapshotsFile: string;
  indexDir: string;
  binDir: string;
  /** What it holds of the org's files: absent from a checkpoint that holds none. */
  filesDir: string;
  previewsDir: string;
  rewindsDir: string;
}

function folderAt(root: string, organizationKey: string, checkpointId: string): CheckpointFolder {
  const dir = join(root, organizationKey, checkpointId);
  return {
    organizationId: organizationKey,
    checkpointId,
    dir,
    checkpointFile: join(dir, CHECKPOINT_FILE),
    fingerprintsFile: join(dir, FINGERPRINTS_FILE),
    plainFingerprintsFile: join(dir, PLAIN_FINGERPRINTS_FILE),
    snapshotsFile: join(dir, SNAPSHOTS_FILE),
    indexDir: join(dir, 'index'),
    binDir: join(dir, 'bin'),
    filesDir: join(dir, 'files'),
    previewsDir: join(dir, 'previews'),
    rewindsDir: join(dir, 'rewinds'),
  };
}

/** An object's name, checked before it becomes part of a path. */
function objectSegment(objectApiName: string): string {
  if (!OBJECT_NAME.test(objectApiName) || objectApiName.length > 80) {
    throw new CheckpointStoreError('invalid', 'Not a Salesforce API name');
  }
  return objectApiName;
}

/** Where the index of an object's snapshot rows is. */
export function indexFileOf(folder: CheckpointFolder, objectApiName: string): string {
  return join(folder.indexDir, `${objectSegment(objectApiName)}.idx`);
}

/**
 * Where a checkpoint keeps the records of its snapshot a rewind made again,
 * each under the new Id the org gave it: the snapshot holds them by the Ids
 * they had, and every read of it names them by the Ids they have now.
 */
export function recreatedFileOf(folder: CheckpointFolder): string {
  return join(folder.indexDir, 'recreated.ndjson');
}

/** Where the ids of an object that were in the recycle bin when the take began are. */
export function binFileOf(folder: CheckpointFolder, objectApiName: string): string {
  return join(folder.binDir, `${objectSegment(objectApiName)}.ids`);
}

/**
 * Where a checkpoint keeps each file it holds, a line each: its latest
 * version and size. Named plain, as the DataOps store names a file of lines:
 * written and read through `compressedSnapshotFiles`, it is kept as
 * `documents.ndjson.gz`.
 */
export function filesDocumentsFileOf(folder: Pick<CheckpointFolder, 'filesDir'>): string {
  return join(folder.filesDir, 'documents.ndjson');
}

/**
 * Where a checkpoint keeps the links between its files and its records, a
 * line each, kept as `links.ndjson.gz` as {@link filesDocumentsFileOf} is.
 */
export function filesLinksFileOf(folder: Pick<CheckpointFolder, 'filesDir'>): string {
  return join(folder.filesDir, 'links.ndjson');
}

/** Where one preview's spooled reads are. */
export function previewDirOf(folder: CheckpointFolder, previewId: string): string {
  return join(folder.previewsDir, parsedId(previewIdSchema, previewId));
}

/** Where one rewind's journal is. */
export function rewindDirOf(folder: CheckpointFolder, rewindId: string): string {
  return join(folder.rewindsDir, parsedId(rewindIdSchema, rewindId));
}

/** An id of the one shape its folder is named by, or a refusal: it is about to become a path. */
function parsedId(schema: z.ZodType<string>, id: string): string {
  const parsed = schema.safeParse(id);
  if (!parsed.success) throw new CheckpointStoreError('invalid', 'Not an id of this store');
  return parsed.data;
}

/** Make a folder of the store, and its missing parents, its owner's alone. */
export async function makePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: CHECKPOINT_DIR_MODE });
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * A new id for a checkpoint (`ck`), a preview (`pv`) or a rewind (`rw`):
 * `ck-20261022-140512-a1b2`, from this machine's clock in UTC and four random
 * characters. Ids of one kind sort in the order they were made, which is the
 * order the list shows them in, damaged ones included.
 */
export function newFolderId(prefix: 'ck' | 'pv' | 'rw', now: Date = new Date()): string {
  const iso = now.toISOString();
  const day = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}`;
  const time = `${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
  const tail = Array.from(randomBytes(4), (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join(
    '',
  );
  return `${prefix}-${day}-${time}-${tail}`;
}

// ─── How long a checkpoint is kept ───────────────────────────────────────────

/**
 * When a checkpoint kept `keepDays` from `from` expires: null for 0, which
 * keeps it until its owner deletes it. The date is written into the
 * checkpoint, so the panel and the command line delete it on the same day
 * whatever either is set to.
 */
export function expiresAtFor(from: Date, keepDays: number): string | null {
  if (!Number.isInteger(keepDays) || keepDays < 0) {
    throw new RangeError(`Not a number of days: ${keepDays}`);
  }
  return keepDays === 0 ? null : new Date(from.getTime() + keepDays * DAY_MS).toISOString();
}

/** Whether a checkpoint's date has come: it is deleted at the next sweep. */
export function isExpired(checkpoint: Pick<OrgCheckpoint, 'expiresAt'>, now: number): boolean {
  return checkpoint.expiresAt !== null && Date.parse(checkpoint.expiresAt) <= now;
}

/** Whether a checkpoint expires within {@link EXPIRY_WARNING_DAYS}, and has not yet. */
export function expiresSoon(checkpoint: Pick<OrgCheckpoint, 'expiresAt'>, now: number): boolean {
  if (checkpoint.expiresAt === null) return false;
  const at = Date.parse(checkpoint.expiresAt);
  return at > now && at - now <= EXPIRY_WARNING_DAYS * DAY_MS;
}

/**
 * The date before which records deleted since the checkpoint can no longer
 * come back with their Id, once the checkpoint is older than the recycle
 * bin's {@link RECYCLE_BIN_DAYS}; undefined while the bin still holds all of
 * them (sooner if it fills, which no date says).
 */
export function binReachSince(
  checkpoint: Pick<OrgCheckpoint, 'readFrom'>,
  now: number,
): string | undefined {
  const reach = now - RECYCLE_BIN_DAYS * DAY_MS;
  return Date.parse(checkpoint.readFrom) < reach ? new Date(reach).toISOString() : undefined;
}

/**
 * Whether the scratch org a checkpoint is of has expired. The command line's
 * date is a day, which the org lives through whole; an instant is when it
 * goes.
 */
export function scratchOrgExpired(
  org: Pick<OrgCheckpoint['org'], 'scratchExpiresAt'>,
  now: number,
): boolean {
  const expires = org.scratchExpiresAt;
  if (expires === undefined) return false;
  const at = Date.parse(expires);
  if (!Number.isFinite(at)) return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(expires) ? at + DAY_MS <= now : at <= now;
}

// ─── The store ───────────────────────────────────────────────────────────────

/** Why the store refused, or failed, what it was asked. */
export type CheckpointStoreErrorCode =
  /** No checkpoint of that id is kept. */
  | 'notFound'
  /** Its file does not parse, or names another checkpoint or org than its folder. */
  | 'damaged'
  /** A checkpoint of that id is kept already. */
  | 'exists'
  /** An id, a name or a checkpoint that is not what it should be. */
  | 'invalid';

export class CheckpointStoreError extends Error {
  constructor(
    readonly code: CheckpointStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CheckpointStoreError';
  }
}

/** Why a store's folder, or the folder of the locks, cannot be used. */
export interface CheckpointStoreRefusal {
  reason: 'notAFolder' | 'otherOwner' | 'cannotMake';
  path: string;
  /** What the system said, when it could not be made. */
  detail?: string;
}

/** What a store is opened with. */
export interface CheckpointStoreOptions {
  /** The store's folder: {@link defaultCheckpointStoreRoot} unless one is named. */
  root: string;
  /** The folder of the locks: {@link defaultCheckpointLocksDir} unless a test names another. */
  locksDir?: string;
  /** The user this process runs as; undefined where the system has none, as on Windows. */
  uid?: () => number | undefined;
  /** Moves a written file over the one it replaces; a test makes it fail. */
  rename?: (from: string, to: string) => Promise<void>;
  /** This process, as the locks it takes name it; a test names another. */
  lockSelf?: OrgLockSelf;
  /** What the lock reads of the machine to tell a live holder from a gone one. */
  lockChecks?: RunWriterChecks;
}

/** A checkpoint's folder, with what its file holds when it parses. */
export interface CheckpointRead {
  folder: CheckpointFolder;
  /** Absent when the file is not there, does not parse, or names another checkpoint or org. */
  checkpoint?: OrgCheckpoint;
}

/** What {@link OrgCheckpointStore.list} lists, and as of when. */
export interface CheckpointListOptions {
  /** One org's checkpoints; every org's without it. */
  organizationId?: string;
  now?: Date;
  /**
   * When the sandbox an Organization Id was is known to have been refreshed:
   * its checkpoints are of the org before the refresh, and can only be
   * deleted.
   */
  refreshedAt?: (organizationId: string) => string | undefined;
}

/** How a delete ended. */
export type CheckpointDeleteOutcome =
  | { outcome: 'deleted'; checkpoint?: OrgCheckpoint }
  | { outcome: 'notFound' }
  /** A take, a rewind or an undo of its org runs: deleting would pull its files from under it. */
  | { outcome: 'busy'; holder: OrgLockHolder };

/** A checkpoint the sweep deleted on its date, as it is named. */
export interface CheckpointExpired {
  organizationId: string;
  checkpointId: string;
  name: string;
  alias?: string;
  takenAt: string;
  expiresAt: string;
  /** Until when its last rewind could still have been undone: that Undo went with it. */
  undoUntil?: string;
}

/** A rewind's journal the sweep deleted once Undo could no longer bring anything back. */
export interface RewindJournalExpired {
  organizationId: string;
  checkpointId: string;
  name: string;
  rewindId: string;
  undoUntil: string;
}

/** What a sweep deleted, and the orgs it left for a run of theirs to end. */
export interface CheckpointSweep {
  checkpoints: CheckpointExpired[];
  journals: RewindJournalExpired[];
  /** Previews whose day had passed. */
  previews: number;
  /** Orgs a take, a rewind or an undo was running on: swept next time. */
  skipped: string[];
}

/** `fingerprints.json`: each object's field prints, by its API name. */
const fingerprintsFileSchema = z.object({
  version: z.literal(1),
  objects: z.record(z.string().regex(OBJECT_NAME).max(80), objectFingerprintSchema),
});

/**
 * The field prints of a checkpoint's objects, by object, read from its
 * folder and checked against what its file says of each object's whole
 * print: the store's {@link OrgCheckpointStore.readFingerprints}, for a
 * reader that holds the folder and the objects alone, as a preview does.
 * The compressed file is inflated whole, a few hundred kilobytes for an org
 * of a thousand objects; a checkpoint taken before the compression has the
 * plain one alone.
 *
 * @throws {CheckpointStoreError} `damaged`, when they are not there, do not
 *   inflate or parse, or one of `objects` has none or another: what changed
 *   in the org's fields since could not be told.
 */
export async function readFieldPrints(
  folder: Pick<CheckpointFolder, 'fingerprintsFile' | 'plainFingerprintsFile'>,
  objects: ReadonlyArray<Pick<OrgCheckpoint['objects'][number], 'objectApiName' | 'fingerprint'>>,
): Promise<Map<string, ObjectFingerprint>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fieldPrintsText(folder));
  } catch {
    throw new CheckpointStoreError('damaged', 'The checkpoint’s field prints cannot be read');
  }
  const file = fingerprintsFileSchema.safeParse(raw);
  if (!file.success) {
    throw new CheckpointStoreError('damaged', 'The checkpoint’s field prints do not parse');
  }
  const prints = new Map(Object.entries(file.data.objects));
  for (const object of objects) {
    if (prints.get(object.objectApiName)?.digest !== object.fingerprint) {
      throw new CheckpointStoreError(
        'damaged',
        `The field prints of ${object.objectApiName} are not the checkpoint’s`,
      );
    }
  }
  return prints;
}

/**
 * Field prints as `fingerprints.json.gz` holds them, their JSON compressed
 * whole: what a take writes, and what its estimate measures before it reads
 * a record.
 *
 * @throws {CheckpointStoreError} `invalid`, when they are not field prints.
 */
export async function compressedFieldPrints(
  prints: Readonly<Record<string, ObjectFingerprint>>,
): Promise<Buffer> {
  const file = fingerprintsFileSchema.safeParse({ version: 1, objects: prints });
  if (!file.success) {
    throw new CheckpointStoreError('invalid', `Not field prints: ${file.error.message}`);
  }
  return gzipped(`${JSON.stringify(file.data)}\n`);
}

/** The text of a checkpoint's field prints: the compressed file inflated, or else the plain one. */
async function fieldPrintsText(
  folder: Pick<CheckpointFolder, 'fingerprintsFile' | 'plainFingerprintsFile'>,
): Promise<string> {
  let compressed: Buffer;
  try {
    compressed = await readFile(folder.fingerprintsFile);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return readFile(folder.plainFingerprintsFile, 'utf8');
  }
  return (await gunzipped(compressed)).toString('utf8');
}

/**
 * Open the store at `options.root`: make its folder and the folder of the
 * locks, their owner's alone when new, and refuse either when another user
 * owns it. Where the system gives files no owner, as on Windows, the folders
 * are protected by the user profile they are in.
 */
export function openCheckpointStore(
  options: CheckpointStoreOptions,
): { store: OrgCheckpointStore } | { refusal: CheckpointStoreRefusal } {
  const uid = options.uid ?? (() => process.getuid?.());
  const locksDir = options.locksDir ?? defaultCheckpointLocksDir();
  for (const dir of [options.root, locksDir]) {
    const refusal = openFolder(dir, uid);
    if (refusal !== undefined) return { refusal };
  }
  return { store: new OrgCheckpointStore({ ...options, locksDir }) };
}

function openFolder(
  dir: string,
  uid: () => number | undefined,
): CheckpointStoreRefusal | undefined {
  try {
    const there = statSync(dir, { throwIfNoEntry: false });
    if (there !== undefined && !there.isDirectory()) return { reason: 'notAFolder', path: dir };
    mkdirSync(dir, { recursive: true, mode: CHECKPOINT_DIR_MODE });
    const me = uid();
    if (me !== undefined && statSync(dir).uid !== me) return { reason: 'otherOwner', path: dir };
    return undefined;
  } catch (err: unknown) {
    return { reason: 'cannotMake', path: dir, detail: messageOf(err) };
  }
}

/**
 * An org's checkpoints on this machine. Open one with {@link openCheckpointStore},
 * which checks its folders first.
 */
export class OrgCheckpointStore {
  readonly root: string;
  readonly locksDir: string;
  private readonly renameFile: (from: string, to: string) => Promise<void>;
  private readonly lockOptions: OrgLockOptions;
  /** The changes of each checkpoint under way in this process, one after the other. */
  private readonly changes = new Map<string, Promise<unknown>>();

  constructor(options: CheckpointStoreOptions & { locksDir: string }) {
    this.root = options.root;
    this.locksDir = options.locksDir;
    this.renameFile = options.rename ?? ((from, to) => rename(from, to));
    this.lockOptions = {
      ...(options.lockSelf ? { self: options.lockSelf } : {}),
      ...(options.lockChecks ? { checks: options.lockChecks } : {}),
    };
  }

  /** Where a checkpoint of an org is, whether it is kept or not. */
  folderOf(organizationId: string, checkpointId: string): CheckpointFolder {
    return folderAt(
      this.root,
      organizationKey(organizationId),
      parsedId(checkpointIdSchema, checkpointId),
    );
  }

  /**
   * Make the folder of a new checkpoint, with its `index/` and `bin/`, its
   * owner's alone.
   *
   * @throws {CheckpointStoreError} `exists`, when a checkpoint of that id is kept already.
   */
  async create(organizationId: string, checkpointId: string): Promise<CheckpointFolder> {
    const folder = this.folderOf(organizationId, checkpointId);
    await makePrivateDir(join(this.root, folder.organizationId));
    try {
      await mkdir(folder.dir, { mode: CHECKPOINT_DIR_MODE });
    } catch (err: unknown) {
      if (codeOf(err) === 'EEXIST') {
        throw new CheckpointStoreError('exists', `A checkpoint ${checkpointId} is kept already`);
      }
      throw err;
    }
    await mkdir(folder.indexDir, { mode: CHECKPOINT_DIR_MODE });
    await mkdir(folder.binDir, { mode: CHECKPOINT_DIR_MODE });
    return folder;
  }

  /**
   * Write a checkpoint's file, whole. It is checked first, so the store never
   * writes what it would list as damaged, and its folder must be there: a
   * file written into a folder deleted meanwhile would stand for a snapshot
   * that is gone.
   *
   * @throws {CheckpointStoreError} `invalid`, when the checkpoint does not parse.
   */
  async write(checkpoint: OrgCheckpoint): Promise<void> {
    const parsed = orgCheckpointSchema.safeParse(checkpoint);
    if (!parsed.success) {
      throw new CheckpointStoreError('invalid', `Not a checkpoint: ${parsed.error.message}`);
    }
    const folder = this.folderOf(parsed.data.org.organizationId, parsed.data.checkpointId);
    await this.writeWhole(folder.checkpointFile, `${JSON.stringify(parsed.data, null, 2)}\n`);
  }

  /**
   * Write the field prints of a checkpoint's objects, by object: before its
   * `checkpoint.json`, which names each object's whole print, so that a
   * checkpoint listed as ready always has them. Compressed whole: a print is
   * a field's name and a hash, and an org of a thousand objects of dozens of
   * fields each has the prints of tens of thousands.
   */
  async writeFingerprints(
    folder: CheckpointFolder,
    prints: Readonly<Record<string, ObjectFingerprint>>,
  ): Promise<void> {
    await this.writeWhole(folder.fingerprintsFile, await compressedFieldPrints(prints));
  }

  /**
   * The field prints of a checkpoint's objects, by object, checked against
   * what its file says of each object's whole print.
   *
   * @throws {CheckpointStoreError} `damaged`, when they are not there, do not
   *   parse, or one of its objects has none or another: what changed in the
   *   org's fields since could not be told.
   */
  async readFingerprints(
    folder: CheckpointFolder,
    checkpoint: OrgCheckpoint,
  ): Promise<Map<string, ObjectFingerprint>> {
    return readFieldPrints(folder, checkpoint.objects);
  }

  /**
   * The checkpoints kept of one org, damaged or not, read from this machine
   * alone: what a rewind that ended reads, under the org's lock, for the
   * journals of the org's earlier rewinds (`removeEarlierJournals`).
   */
  async checkpointsOf(organizationId: string): Promise<CheckpointRead[]> {
    return this.readsOf(organizationKey(organizationId));
  }

  /** A kept checkpoint, damaged or not; undefined when none of that id is kept. */
  async read(checkpointId: string): Promise<CheckpointRead | undefined> {
    const id = parsedId(checkpointIdSchema, checkpointId);
    for (const org of await this.organizationKeys()) {
      const folder = folderAt(this.root, org, id);
      if (await isFolder(folder.dir)) return readFolder(folder);
    }
    return undefined;
  }

  /**
   * Change a kept checkpoint: read afresh, changed, checked and written whole.
   * The changes of one checkpoint in this process run one after the other, so
   * a rename does not write over the end of a rewind.
   *
   * @throws {CheckpointStoreError} `notFound`, `damaged`, or `invalid` when the
   *   change does not parse or moves it to another id or org.
   */
  async update(
    checkpointId: string,
    change: (checkpoint: OrgCheckpoint) => OrgCheckpoint,
  ): Promise<OrgCheckpoint> {
    const work = async (): Promise<OrgCheckpoint> => {
      const read = await this.read(checkpointId);
      if (read === undefined) {
        throw new CheckpointStoreError('notFound', `No checkpoint ${checkpointId} is kept`);
      }
      if (read.checkpoint === undefined) {
        throw new CheckpointStoreError('damaged', `The checkpoint ${checkpointId} is damaged`);
      }
      const next = change(structuredClone(read.checkpoint));
      if (
        next.checkpointId !== read.folder.checkpointId ||
        organizationKeyOrNone(next.org.organizationId) !== read.folder.organizationId
      ) {
        throw new CheckpointStoreError('invalid', 'A change never moves a checkpoint');
      }
      await this.write(next);
      return orgCheckpointSchema.parse(next);
    };
    const before = this.changes.get(checkpointId) ?? Promise.resolve();
    const done = before.then(work, work);
    const settled = done.catch(() => undefined);
    this.changes.set(checkpointId, settled);
    void settled.then(() => {
      if (this.changes.get(checkpointId) === settled) this.changes.delete(checkpointId);
    });
    return done;
  }

  /**
   * Keep a checkpoint until its owner deletes it, or give it back an expiry
   * date: {@link DEFAULT_KEEP_DAYS} from now, not from its take, which would
   * delete a baseline kept for months at the next sweep.
   */
  keep(checkpointId: string, keep: boolean, now: Date = new Date()): Promise<OrgCheckpoint> {
    return this.update(checkpointId, (checkpoint) => ({
      ...checkpoint,
      expiresAt: keep ? null : expiresAtFor(now, DEFAULT_KEEP_DAYS),
    }));
  }

  /**
   * The checkpoints kept, newest first, read from this machine alone, without
   * contacting any org: each with whether it can be previewed and rewound to,
   * and why not, the warning of its expiry, how far back the recycle bin
   * still reaches, and the Undo of the org's latest rewind when it was made
   * to it. A damaged one is listed, by its folder, so it can be deleted.
   */
  async list(options: CheckpointListOptions = {}): Promise<CheckpointListEntry[]> {
    const now = (options.now ?? new Date()).getTime();
    const only =
      options.organizationId !== undefined ? organizationKey(options.organizationId) : undefined;
    const entries: CheckpointListEntry[] = [];
    for (const org of await this.organizationKeys(only)) {
      const reads = await this.readsOf(org);
      const latest = latestRewindOf(reads);
      for (const read of reads) {
        entries.push(await entryOf(read, now, latest, options.refreshedAt));
      }
    }
    // Ids are named by when the take began, so they sort damaged checkpoints,
    // which no file dates, among the others.
    return entries.sort((a, b) => compareText(b.checkpointId, a.checkpointId));
  }

  /**
   * Delete a checkpoint from this machine, with the Undo of its rewinds. The
   * org is not touched. Refused while a take, a rewind or an undo of its org
   * runs, whose files would go from under it.
   */
  async delete(checkpointId: string): Promise<CheckpointDeleteOutcome> {
    const read = await this.read(checkpointId);
    if (read === undefined) return { outcome: 'notFound' };
    const taken = this.lock(read.folder.organizationId, 'delete', read.folder.checkpointId);
    if ('busy' in taken) return { outcome: 'busy', holder: taken.busy };
    try {
      await rm(read.folder.dir, { recursive: true, force: true });
    } finally {
      taken.lock.release();
    }
    return read.checkpoint
      ? { outcome: 'deleted', checkpoint: read.checkpoint }
      : { outcome: 'deleted' };
  }

  /**
   * Delete what has had its day: checkpoints past their `expiresAt`, the
   * journal of a rewind once Undo can no longer bring anything back, and
   * previews older than a day. Run when the panel activates and as any
   * command line verb starts; what it deletes is named.
   *
   * An org a take, a rewind or an undo runs on is left as it is, and swept
   * next time. Each checkpoint is read again once its org is locked, so a
   * checkpoint kept meanwhile is not deleted on the date it no longer has.
   */
  async sweep(now: Date = new Date()): Promise<CheckpointSweep> {
    const at = now.getTime();
    const swept: CheckpointSweep = { checkpoints: [], journals: [], previews: 0, skipped: [] };
    for (const org of await this.organizationKeys()) {
      const due = await dueOf(await this.readsOf(org), at);
      if (due.length === 0) continue;
      const taken = this.lock(org, 'sweep');
      if ('busy' in taken) {
        swept.skipped.push(org);
        continue;
      }
      try {
        for (const folder of due) await sweepOne(await readFolder(folder), at, swept);
      } finally {
        taken.lock.release();
      }
    }
    return swept;
  }

  /** Take the lock of an org for a take, a rewind, an undo, or the store's own deletions. */
  lock(organizationId: string, operation: OrgLockOperation, checkpointId?: string): OrgLockOutcome {
    return acquireOrgLock(
      this.locksDir,
      organizationId,
      { operation, ...(checkpointId !== undefined ? { checkpointId } : {}) },
      this.lockOptions,
    );
  }

  /** Who holds the lock of an org, alive; undefined when nobody does. */
  heldBy(organizationId: string): OrgLockHolder | undefined {
    return orgLockHolder(this.locksDir, organizationId, this.lockOptions);
  }

  /** The orgs the store keeps checkpoints of, or the one named when it does. */
  private async organizationKeys(only?: string): Promise<string[]> {
    const names = await foldersIn(this.root);
    return names.filter((name) => isOrganizationKey(name) && (only === undefined || name === only));
  }

  /** An org's checkpoints, read. */
  private async readsOf(org: string): Promise<CheckpointRead[]> {
    const ids = (await foldersIn(join(this.root, org))).filter(
      (name) => checkpointIdSchema.safeParse(name).success,
    );
    const reads: CheckpointRead[] = [];
    for (const id of ids) reads.push(await readFolder(folderAt(this.root, org, id)));
    return reads;
  }

  /**
   * Write a file whole: into a file of its own beside it, made for this write
   * alone and its owner's, flushed to the disk, then renamed over it. A write
   * stopped at any point leaves the file as it was.
   */
  private async writeWhole(file: string, content: string | Buffer): Promise<void> {
    const temp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
    const handle = await open(temp, 'wx', CHECKPOINT_FILE_MODE);
    try {
      try {
        await handle.writeFile(content, typeof content === 'string' ? 'utf8' : undefined);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.renameFile(temp, file);
    } catch (err: unknown) {
      await rm(temp, { force: true });
      throw err;
    }
  }
}

/** A checkpoint's folder, read: its file when it parses and is the folder's own. */
async function readFolder(folder: CheckpointFolder): Promise<CheckpointRead> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(folder.checkpointFile, 'utf8'));
  } catch {
    return { folder };
  }
  const parsed = orgCheckpointSchema.safeParse(raw);
  if (!parsed.success) return { folder };
  // A file copied from another checkpoint's folder, or another org's, would
  // have the rewind plan against a snapshot that is not the one it describes.
  if (
    parsed.data.checkpointId !== folder.checkpointId ||
    organizationKeyOrNone(parsed.data.org.organizationId) !== folder.organizationId
  ) {
    return { folder };
  }
  return { folder, checkpoint: parsed.data };
}

/** The org's latest rewind, by id: Undo is offered for it alone. */
export function latestRewindOf(
  reads: readonly CheckpointRead[],
): { checkpointId: string; rewindId: string } | undefined {
  let latest: { checkpointId: string; rewindId: string } | undefined;
  for (const { folder, checkpoint } of reads) {
    const rewindId = checkpoint?.lastRewind?.rewindId;
    if (rewindId !== undefined && (latest === undefined || rewindId > latest.rewindId)) {
      latest = { checkpointId: folder.checkpointId, rewindId };
    }
  }
  return latest;
}

/** Why a checkpoint that parses cannot be previewed nor rewound to, if it cannot. */
function invalidReasonOf(
  checkpoint: OrgCheckpoint,
  organizationId: string,
  now: number,
  refreshedAt: CheckpointListOptions['refreshedAt'],
): { why: CheckpointInvalidReason; refreshedAt?: string } | undefined {
  if (checkpoint.status === 'taking') return { why: 'taking' };
  if (checkpoint.status === 'failed') return { why: 'failed' };
  const refreshed = refreshedAt?.(organizationId);
  if (refreshed !== undefined) return { why: 'refreshed', refreshedAt: refreshed };
  if (scratchOrgExpired(checkpoint.org, now)) return { why: 'scratchExpired' };
  return undefined;
}

/** A checkpoint as the list shows it. */
async function entryOf(
  { folder, checkpoint }: CheckpointRead,
  now: number,
  latest: { checkpointId: string; rewindId: string } | undefined,
  refreshedAt: CheckpointListOptions['refreshedAt'],
): Promise<CheckpointListEntry> {
  const base = { checkpointId: folder.checkpointId, organizationId: folder.organizationId };
  if (checkpoint === undefined) return { ...base, valid: false, why: 'damaged' };
  const invalid = invalidReasonOf(checkpoint, folder.organizationId, now, refreshedAt);
  if (invalid !== undefined) {
    return {
      ...base,
      checkpoint,
      valid: false,
      why: invalid.why,
      ...(invalid.refreshedAt !== undefined ? { refreshedAt: invalid.refreshedAt } : {}),
    };
  }
  const entry: CheckpointListEntry = { ...base, checkpoint, valid: true };
  if (expiresSoon(checkpoint, now)) entry.expiresSoon = true;
  const since = binReachSince(checkpoint, now);
  if (since !== undefined) entry.binReachSince = since;
  const rewind = checkpoint.lastRewind;
  if (
    rewind !== undefined &&
    latest?.checkpointId === folder.checkpointId &&
    rewind.undoUntil !== undefined &&
    rewind.undoneAt === undefined &&
    Date.parse(rewind.undoUntil) > now &&
    (await isFolder(rewindDirOf(folder, rewind.rewindId)))
  ) {
    entry.undo = { rewindId: rewind.rewindId, until: rewind.undoUntil };
  }
  return entry;
}

/** The checkpoints of an org with something the sweep deletes. */
async function dueOf(reads: readonly CheckpointRead[], now: number): Promise<CheckpointFolder[]> {
  const due: CheckpointFolder[] = [];
  for (const { folder, checkpoint } of reads) {
    if (checkpoint === undefined) continue;
    if (
      isExpired(checkpoint, now) ||
      (await journalDue(folder, checkpoint, now)) ||
      (await oldPreviewsOf(folder, now)).length > 0
    ) {
      due.push(folder);
    }
  }
  return due;
}

/** Whether a checkpoint's last rewind can no longer be undone, and its journal is still kept. */
async function journalDue(
  folder: CheckpointFolder,
  checkpoint: OrgCheckpoint,
  now: number,
): Promise<boolean> {
  const until = checkpoint.lastRewind?.undoUntil;
  return (
    checkpoint.lastRewind !== undefined &&
    until !== undefined &&
    Date.parse(until) <= now &&
    (await isFolder(rewindDirOf(folder, checkpoint.lastRewind.rewindId)))
  );
}

/** A checkpoint's previews whose day has passed, by when their folder was last written. */
async function oldPreviewsOf(folder: CheckpointFolder, now: number): Promise<string[]> {
  const old: string[] = [];
  for (const name of await foldersIn(folder.previewsDir)) {
    if (!previewIdSchema.safeParse(name).success) continue;
    const dir = join(folder.previewsDir, name);
    const info = await stat(dir).catch(() => undefined);
    if (info !== undefined && info.mtimeMs + PREVIEW_KEEP_MS <= now) old.push(dir);
  }
  return old;
}

/** Sweep one checkpoint, read again under its org's lock. */
async function sweepOne(read: CheckpointRead, now: number, swept: CheckpointSweep): Promise<void> {
  const { folder, checkpoint } = read;
  if (checkpoint === undefined) return;
  if (checkpoint.expiresAt !== null && isExpired(checkpoint, now)) {
    await rm(folder.dir, { recursive: true, force: true });
    const until = checkpoint.lastRewind?.undoUntil;
    const undoOpen =
      until !== undefined &&
      checkpoint.lastRewind?.undoneAt === undefined &&
      Date.parse(until) > now;
    swept.checkpoints.push({
      organizationId: folder.organizationId,
      checkpointId: folder.checkpointId,
      name: checkpoint.name,
      ...(checkpoint.org.alias !== undefined ? { alias: checkpoint.org.alias } : {}),
      takenAt: checkpoint.takenAt,
      expiresAt: checkpoint.expiresAt,
      ...(undoOpen ? { undoUntil: until } : {}),
    });
    return;
  }
  const rewind = checkpoint.lastRewind;
  if (rewind?.undoUntil !== undefined && (await journalDue(folder, checkpoint, now))) {
    await rm(rewindDirOf(folder, rewind.rewindId), { recursive: true, force: true });
    swept.journals.push({
      organizationId: folder.organizationId,
      checkpointId: folder.checkpointId,
      name: checkpoint.name,
      rewindId: rewind.rewindId,
      undoUntil: rewind.undoUntil,
    });
  }
  for (const dir of await oldPreviewsOf(folder, now)) {
    await rm(dir, { recursive: true, force: true });
    swept.previews += 1;
  }
}

// ─── The lock of an org ──────────────────────────────────────────────────────

/** What holds an org's lock: a take, a rewind, an undo, or the store deleting checkpoints. */
export type OrgLockOperation = 'take' | 'rewind' | 'undo' | 'delete' | 'sweep';

/** An org's lock file, as it is written and read back. */
const lockFileSchema = z.object({
  ...lockHolderShape,
  operation: z.enum(['take', 'rewind', 'undo', 'delete', 'sweep']),
  checkpointId: checkpointIdSchema.optional(),
});

type LockFile = z.infer<typeof lockFileSchema>;

/** Who holds an org's lock, as a refusal names it. */
export type OrgLockHolder = Omit<LockFile, 'version' | 'token'>;

/** A process that takes locks: its machine, its id, and when it started. */
export type OrgLockSelf = LockSelf;

/** Who an org's lock is taken by, and how a holder is told alive from gone. */
export type OrgLockOptions = LinkedLockOptions;

/** An org's lock, held until it is released. */
export interface OrgLock {
  readonly organizationId: string;
  /** Let the lock go; once is enough, and again does nothing. */
  release(): void;
}

/** The lock, or who holds it. */
export type OrgLockOutcome = { lock: OrgLock } | { busy: OrgLockHolder };

/** The locks of orgs, on the link-file mechanism of `linkedLock.ts`. */
const ORG_LOCKS = linkedLockKind((content) => {
  const parsed = lockFileSchema.safeParse(content);
  return parsed.success ? parsed.data : undefined;
});

/** Where an org's lock is. */
export function orgLockFileOf(locksDir: string, organizationId: string): string {
  return join(locksDir, `${organizationKey(organizationId)}.lock`);
}

/**
 * Take the lock of an org: made by linking a file written whole, so it exists
 * once, for the one process whose link succeeds, and is never read half
 * written. A lock whose holder is gone — its process ended, or started before
 * the machine did, or it was taken longer ago than a run lasts — is taken
 * over; one whose holder is alive is said, and nothing is taken.
 */
export function acquireOrgLock(
  locksDir: string,
  organizationId: string,
  request: { operation: OrgLockOperation; checkpointId?: string },
  options: OrgLockOptions = {},
): OrgLockOutcome {
  const org = organizationKey(organizationId);
  const checkpointId =
    request.checkpointId !== undefined
      ? parsedId(checkpointIdSchema, request.checkpointId)
      : undefined;
  const outcome = ORG_LOCKS.acquire(
    join(locksDir, `${org}.lock`),
    (head) => ({
      ...head,
      operation: request.operation,
      ...(checkpointId !== undefined ? { checkpointId } : {}),
    }),
    options,
  );
  if ('busy' in outcome) return { busy: holderOf(outcome.busy) };
  return { lock: { organizationId: org, release: outcome.lock.release } };
}

/** Who holds the lock of an org, alive; undefined when nobody does. */
export function orgLockHolder(
  locksDir: string,
  organizationId: string,
  options: OrgLockOptions = {},
): OrgLockHolder | undefined {
  const holder = ORG_LOCKS.holder(orgLockFileOf(locksDir, organizationId), options);
  return holder !== undefined ? holderOf(holder) : undefined;
}

function holderOf({ version: _version, token: _token, ...holder }: LockFile): OrgLockHolder {
  return holder;
}

// ─── Small helpers ───────────────────────────────────────────────────────────

/** The folders directly in a folder; none when it is not there. */
async function foldersIn(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (err: unknown) {
    if (codeOf(err) === 'ENOENT' || codeOf(err) === 'ENOTDIR') return [];
    throw err;
  }
}

async function isFolder(dir: string): Promise<boolean> {
  const info = await stat(dir).catch(() => undefined);
  return info?.isDirectory() === true;
}

/** {@link organizationKey}, or undefined for what is not an Organization Id. */
function organizationKeyOrNone(organizationId: string): string | undefined {
  try {
    return organizationKey(organizationId);
  } catch {
    return undefined;
  }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function codeOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
