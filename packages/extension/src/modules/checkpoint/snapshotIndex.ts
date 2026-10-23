/**
 * The index of a checkpoint's snapshot: for each object, where each of its
 * records is in the file of its values, and the `SystemModstamp` it was read
 * with.
 *
 * A preview tells what changed since the checkpoint by sets: a record stamped
 * since that the snapshot holds was changed, one it does not hold was created
 * or brought back, one it holds that the org no longer does was deleted. Made
 * from the values themselves, those sets would parse every row of the
 * snapshot at each preview, up to 500,000 rows of hundreds of fields for one
 * object. The take goes through each object's file once, as it is on disk,
 * and keeps of each row the first fifteen characters of its id, its stamp,
 * and the offset and length of its line: 35 bytes, whatever the row holds.
 * A preview makes its sets from that alone, one object at a time.
 *
 * The set is exact. The records a removal leaves are held as two hashes of
 * their id each (`HashedKeys`), and two ids whose hashes meet are taken there
 * for one: one record more set out to be deleted, which the org says is
 * gone. Here such ids would be a record taken for another — changed for
 * unchanged, deleted for created — so a lookup always ends on the id itself.
 * The index and a table of its rows by id, under half full, take about 45
 * bytes a row: some 22 MB for an object of 500,000 records, released with it.
 *
 * What was deleted since and is no longer in the recycle bin is told by a
 * scan of the org's live ids and the bin's ids read since, each marked one bit
 * a row against the index (`GoneForGood`): a row of the snapshot neither
 * marks is gone for good.
 *
 * A rewind gives an object's values back a chunk of records at a time, each
 * chunk read from the snapshot just before its writes (`SnapshotIndex.chunk`):
 * its rows are read at their offsets, never the whole file, and each line is
 * checked to be the record, as read, that the index says is there. A file
 * changed since the take would otherwise give one record's values to another.
 *
 * A record the recycle bin no longer gave back, which a rewind made again
 * from its row, lives under a new Id: the checkpoint keeps the pair beside
 * the index (`Recreated`), never rewriting the snapshot, and an index read
 * names the record by the Id it has now — held, stamped and read under it,
 * its row's lookups that named a record made again pointing at that record's
 * new Id — and holds the Id it had no more. Read so, a later preview finds
 * the record made again where the checkpoint has it, never as one created
 * since to delete, and its old Id, still in the bin or purged, never as one
 * to bring back or make again.
 */

import { randomBytes } from 'node:crypto';
import { open, readFile, rename, rm, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as z from 'zod';
import { canonicalRecordId } from '../../core/common/existingRecordMatch.js';
import type { BackupRecord } from '../dataops/BackupRecordStore.js';
import { hashA } from '../forge/ForgeRunStore.js';
import { orgDateTime } from '../sync/SyncDelta.js';
import type { BackupReader } from '../sync/SyncRunRestore.js';
import {
  CHECKPOINT_FILE_MODE,
  CheckpointStoreError,
  indexFileOf,
  recreatedFileOf,
  type CheckpointFolder,
} from './OrgCheckpointStore.js';

/**
 * The most records a chunk of the snapshot reads: a give-back holds a chunk's
 * values from the snapshot, the org's values and its updates at once, so a
 * rewind of 300,000 changed records holds 2,000 of each, never every one.
 */
export const SNAPSHOT_CHUNK_IDS = 2_000;

/** What an index file starts with: the kind of file it is, and the version of its rows. */
const INDEX_HEAD = Buffer.from('SFCKIDX1', 'latin1');
/** The first fifteen characters of a record's id, one byte each. */
const KEY_BYTES = 15;
/** Where a row's stamp is in it: milliseconds since the epoch, a little-endian double. */
const STAMP_AT = KEY_BYTES;
/** Where the offset of its line in the snapshot file is: bytes, a little-endian double. */
const OFFSET_AT = STAMP_AT + 8;
/** Where the length of its line is: bytes, a little-endian 32-bit integer. */
const LENGTH_AT = OFFSET_AT + 8;
/** Bytes a row of the snapshot takes in its index. */
const ROW_BYTES = LENGTH_AT + 4;

/** Bytes read from a snapshot file at a time while it is indexed. */
const SCAN_BYTES = 1 << 20;

/** A Salesforce id, of either length. */
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
/** The key a row is held by: the first fifteen characters of its id. */
const ROW_KEY = /^[A-Za-z0-9]{15}$/;
/** An object's API name, as the snapshot's files are named by. */
const OBJECT_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** The bytes an index of `rows` rows takes on disk: what a take's estimate counts for it. */
export function snapshotIndexBytes(rows: number): number {
  return INDEX_HEAD.length + rows * ROW_BYTES;
}

// ─── Where the snapshot is ───────────────────────────────────────────────────

/** A name as the DataOps store puts it into a file's name: letters, digits, `_` and `-`, the rest as `_`. */
function backupSegment(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * The file of an object's values in a checkpoint's snapshot: where the DataOps
 * store bound to the checkpoint's folder writes them
 * (`BackupRecordStore`, `backups/<snapshot>__<Object>.ndjson`).
 *
 * @throws {CheckpointStoreError} `invalid`, when `objectApiName` is not an API name.
 */
export function snapshotFileOf(
  folder: CheckpointFolder,
  snapshotId: string,
  objectApiName: string,
): string {
  if (!OBJECT_NAME.test(objectApiName) || objectApiName.length > 80) {
    throw new CheckpointStoreError('invalid', 'Not a Salesforce API name');
  }
  return join(
    folder.dir,
    'backups',
    `${backupSegment(snapshotId)}__${backupSegment(objectApiName)}.ndjson`,
  );
}

// ─── The rows of an index ────────────────────────────────────────────────────

/** The rows of an index, in the order of the snapshot's lines, as the index file holds them. */
class IndexRows {
  private bytes: Buffer;
  size: number;

  /** @param bytes - The rows of an index file, read; none for an index being written. */
  constructor(bytes?: Buffer) {
    this.bytes = bytes ?? Buffer.alloc(ROW_BYTES * 1024);
    this.size = bytes ? bytes.length / ROW_BYTES : 0;
  }

  /** Add a row; its place. */
  push(key: string, stamp: number, offset: number, length: number): number {
    const at = this.size * ROW_BYTES;
    if (at + ROW_BYTES > this.bytes.length) {
      const grown = Buffer.alloc(Math.max(this.bytes.length * 2, ROW_BYTES * 1024));
      this.bytes.copy(grown, 0, 0, at);
      this.bytes = grown;
    }
    this.bytes.write(key, at, KEY_BYTES, 'latin1');
    this.bytes.writeDoubleLE(stamp, at + STAMP_AT);
    this.bytes.writeDoubleLE(offset, at + OFFSET_AT);
    this.bytes.writeUInt32LE(length, at + LENGTH_AT);
    return this.size++;
  }

  keyAt(row: number): string {
    const at = row * ROW_BYTES;
    return this.bytes.toString('latin1', at, at + KEY_BYTES);
  }

  /** Whether row `row` is held by `key`, compared character by character. */
  holds(row: number, key: string): boolean {
    const at = row * ROW_BYTES;
    for (let i = 0; i < KEY_BYTES; i++) {
      if (this.bytes[at + i] !== key.charCodeAt(i)) return false;
    }
    return true;
  }

  stampAt(row: number): number {
    return this.bytes.readDoubleLE(row * ROW_BYTES + STAMP_AT);
  }

  offsetAt(row: number): number {
    return this.bytes.readDoubleLE(row * ROW_BYTES + OFFSET_AT);
  }

  lengthAt(row: number): number {
    return this.bytes.readUInt32LE(row * ROW_BYTES + LENGTH_AT);
  }

  /** Whether row `row` is one an index writes: a key, a date, a place in a file. */
  wellFormed(row: number): boolean {
    const stamp = this.stampAt(row);
    const offset = this.offsetAt(row);
    return (
      ROW_KEY.test(this.keyAt(row)) &&
      Number.isFinite(stamp) &&
      Number.isSafeInteger(offset) &&
      offset >= 0 &&
      this.lengthAt(row) > 0
    );
  }

  /** The rows, as the index file holds them after its head. */
  written(): Buffer {
    return this.bytes.subarray(0, this.size * ROW_BYTES);
  }
}

/**
 * The rows of an index by their key, exactly: a slot holds a row's place, a
 * key's hash says where its search starts, and a row is the key's only once
 * its own key compares equal, character by character.
 */
class RowsByKey {
  private slots: Uint32Array;
  private used = 0;

  constructor(
    private readonly rows: IndexRows,
    expected: number,
  ) {
    let capacity = 1024;
    while (capacity < expected * 2) capacity *= 2;
    this.slots = new Uint32Array(capacity);
  }

  /** The row held by `key`, or -1. */
  find(key: string): number {
    const mask = this.slots.length - 1;
    for (let slot = hashA(key) & mask; ; slot = (slot + 1) & mask) {
      const at = this.slots[slot];
      if (at === 0) return -1;
      if (this.rows.holds(at - 1, key)) return at - 1;
    }
  }

  /** Take row `row` in, by its key; the row held by that key already, or -1 when there was none. */
  add(row: number): number {
    const key = this.rows.keyAt(row);
    const held = this.find(key);
    if (held >= 0) return held;
    if ((this.used + 1) * 2 > this.slots.length) this.grow();
    this.place(row, key);
    this.used++;
    return -1;
  }

  private place(row: number, key: string): void {
    const mask = this.slots.length - 1;
    let slot = hashA(key) & mask;
    while (this.slots[slot] !== 0) slot = (slot + 1) & mask;
    this.slots[slot] = row + 1;
  }

  private grow(): void {
    const old = this.slots;
    this.slots = new Uint32Array(old.length * 2);
    for (const at of old) {
      if (at !== 0) this.place(at - 1, this.rows.keyAt(at - 1));
    }
  }
}

// ─── Reading the snapshot's lines ────────────────────────────────────────────

/** A line of a snapshot file: its number, where it starts, its bytes, and what it says. */
interface SnapshotLine {
  number: number;
  offset: number;
  length: number;
  text: string;
}

/** A snapshot's file, opened to read; refused as damaged when it is not on this machine. */
async function openSnapshot(file: string, objectApiName: string): Promise<FileHandle> {
  try {
    return await open(file, 'r');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    throw new CheckpointStoreError(
      'damaged',
      `The checkpoint’s snapshot of ${objectApiName} is not on this machine.`,
    );
  }
}

/**
 * Every line of a snapshot file that holds something, read a chunk at a time,
 * with where it starts in bytes: a value outside ASCII takes more bytes than
 * characters, and an offset in characters would point into another line.
 */
async function* snapshotLines(file: string, objectApiName: string): AsyncGenerator<SnapshotLine> {
  const handle = await openSnapshot(file, objectApiName);
  try {
    const chunk = Buffer.alloc(SCAN_BYTES);
    let rest = Buffer.alloc(0);
    let restAt = 0;
    let position = 0;
    let number = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, SCAN_BYTES, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const bytes =
        rest.length > 0
          ? Buffer.concat([rest, chunk.subarray(0, bytesRead)])
          : chunk.subarray(0, bytesRead);
      let start = 0;
      for (let newline = bytes.indexOf(10); newline >= 0; newline = bytes.indexOf(10, start)) {
        number++;
        if (newline > start) {
          yield {
            number,
            offset: restAt + start,
            length: newline - start,
            text: bytes.toString('utf8', start, newline),
          };
        }
        start = newline + 1;
      }
      // Copied: the chunk is read into again.
      rest = Buffer.from(bytes.subarray(start));
      restAt += start;
    }
    if (rest.length > 0) {
      yield {
        number: number + 1,
        offset: restAt,
        length: rest.length,
        text: rest.toString('utf8'),
      };
    }
  } finally {
    await handle.close();
  }
}

/** A stamp as the org gives it, `+0000` or `Z`, in milliseconds; NaN for anything else. */
function stampMs(value: unknown): number {
  const at = orgDateTime(value);
  return at === null ? Number.NaN : Date.parse(at);
}

/** The record a line holds, or undefined when it holds none. */
function recordOf(text: string): BackupRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as BackupRecord)
    : undefined;
}

// ─── Writing the index ───────────────────────────────────────────────────────

/** What indexing an object's snapshot wrote. */
export interface SnapshotIndexWritten {
  /** Rows of the snapshot, one per record. */
  rows: number;
  /** Bytes of the index file. */
  bytes: number;
}

/** Write a file whole, its owner's alone: through a file beside it, renamed over it once flushed. */
async function writeWhole(file: string, content: Buffer): Promise<void> {
  const temp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  const handle = await open(temp, 'wx', CHECKPOINT_FILE_MODE);
  try {
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } catch (err: unknown) {
    await rm(temp, { force: true });
    throw err;
  }
}

/**
 * Index the snapshot of an object once the take has read it whole:
 * `index/<Object>.idx` in the checkpoint's folder, one row per line of its
 * values, written whole or not at all.
 *
 * @throws {CheckpointStoreError} `damaged`, when a line holds no record, a
 *   record without its Id or its `SystemModstamp`, or a record a line before
 *   it holds already: a snapshot a rewind could not tell its records apart
 *   in is not kept, and the take fails.
 */
export async function writeSnapshotIndex(
  folder: CheckpointFolder,
  snapshotId: string,
  objectApiName: string,
): Promise<SnapshotIndexWritten> {
  const file = snapshotFileOf(folder, snapshotId, objectApiName);
  const target = indexFileOf(folder, objectApiName);
  const rows = new IndexRows();
  const byKey = new RowsByKey(rows, 0);
  const damaged = (line: number, what: string): CheckpointStoreError =>
    new CheckpointStoreError(
      'damaged',
      `The snapshot of ${objectApiName} holds ${what} at line ${line} of its file: it cannot be indexed.`,
    );
  for await (const line of snapshotLines(file, objectApiName)) {
    const record = recordOf(line.text);
    if (!record) throw damaged(line.number, 'no record');
    const id = record.Id;
    if (typeof id !== 'string' || !RECORD_ID.test(id)) {
      throw damaged(line.number, 'a record without its Id');
    }
    const stamp = stampMs(record.SystemModstamp);
    if (!Number.isFinite(stamp)) {
      throw damaged(line.number, `record ${id} without its SystemModstamp`);
    }
    const row = rows.push(id.slice(0, KEY_BYTES), stamp, line.offset, line.length);
    if (byKey.add(row) >= 0) throw damaged(line.number, `record ${id} a second time`);
  }
  const content = Buffer.concat([INDEX_HEAD, rows.written()]);
  await writeWhole(target, content);
  return { rows: rows.size, bytes: content.length };
}

// ─── Records made again ──────────────────────────────────────────────────────

/** A record of a snapshot a rewind made again: its object, the Id it had, the Id it has now. */
export interface RecreatedPair {
  objectApiName: string;
  from: string;
  to: string;
}

const recreatedLineSchema = z.object({
  objectApiName: z.string().regex(OBJECT_NAME).max(80),
  from: z.string().regex(RECORD_ID),
  to: z.string().regex(RECORD_ID),
});

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
 * The records of a checkpoint's snapshot a rewind made again, each Id it had
 * paired with the Id it has now, every object together: an Id names one
 * record of one object, whatever the object. A record made again twice —
 * made again, then purged from the bin once more — has its latest Id.
 *
 * Read whole from the checkpoint's folder, a line a pair, and added to as a
 * rewind makes records, each line flushed before the rewind goes on: the
 * pairs of a rewind of thousands of records made again are a few hundred
 * kilobytes.
 */
export class Recreated {
  private constructor(
    /** By the key the snapshot holds a record by, the Id it has now. */
    private readonly current: ReadonlyMap<string, string>,
    /** By the key of the Id a record made again has now, the key the snapshot holds it by. */
    private readonly original: ReadonlyMap<string, string>,
  ) {}

  /** No record made again. */
  static readonly none = new Recreated(new Map(), new Map());

  /** Pairs as given, the later of two of one record standing. */
  static of(pairs: Iterable<Pick<RecreatedPair, 'from' | 'to'>>): Recreated {
    const current = new Map<string, string>();
    for (const { from, to } of pairs) current.set(from.slice(0, KEY_BYTES), to);
    const original = new Map<string, string>();
    for (const [from, to] of current) original.set(to.slice(0, KEY_BYTES), from);
    return new Recreated(current, original);
  }

  /**
   * The pairs a checkpoint's folder keeps: none when it keeps none. A last
   * line no line break ends was being written as a process stopped: its
   * record is not known to have been made, and the line is left out.
   *
   * @throws {CheckpointStoreError} `damaged`, at any other line that is not a
   *   pair: a record taken for another would be deleted, or made a second time.
   */
  static async read(folder: CheckpointFolder): Promise<Recreated> {
    let text: string;
    try {
      text = await readFile(recreatedFileOf(folder), 'utf8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return Recreated.none;
      throw err;
    }
    const whole = text.split('\n').slice(0, -1);
    const pairs: RecreatedPair[] = [];
    for (const [at, line] of whole.entries()) {
      if (line === '') continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        value = undefined;
      }
      const pair = recreatedLineSchema.safeParse(value);
      if (!pair.success) {
        throw new CheckpointStoreError(
          'damaged',
          `The checkpoint’s list of the records a rewind made again is damaged at line ${at + 1}.`,
        );
      }
      pairs.push(pair.data);
    }
    return Recreated.of(pairs);
  }

  /**
   * Add pairs to a checkpoint's folder, flushed to the disk before it
   * answers, its owner's alone to read.
   */
  static async add(folder: CheckpointFolder, pairs: readonly RecreatedPair[]): Promise<void> {
    if (pairs.length === 0) return;
    const file = recreatedFileOf(folder);
    const text = pairs
      .map(({ objectApiName, from, to }) => `${JSON.stringify({ objectApiName, from, to })}\n`)
      .join('');
    const handle = await open(file, 'a', CHECKPOINT_FILE_MODE);
    let made = false;
    try {
      made = (await handle.stat()).size === 0;
      await handle.appendFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (made) await syncFolder(dirname(file));
  }

  /** Whether no record was made again. */
  get empty(): boolean {
    return this.current.size === 0;
  }

  /** The Id the record the snapshot holds by `key` has now, or undefined when it was not made again. */
  currentOf(key: string): string | undefined {
    return this.current.get(key);
  }

  /** The key the snapshot holds the record by whose Id is now `key`, or undefined. */
  originalOf(key: string): string | undefined {
    return this.original.get(key);
  }

  /** Whether `id` is an Id the snapshot holds a record by that lives under another now. */
  retired(id: unknown): boolean {
    return typeof id === 'string' && RECORD_ID.test(id) && this.current.has(id.slice(0, KEY_BYTES));
  }

  /** `value` as a lookup names the record now: the new Id of a record made again, else as it is. */
  remapped(value: unknown): unknown {
    if (typeof value !== 'string' || !RECORD_ID.test(value)) return value;
    return this.current.get(value.slice(0, KEY_BYTES)) ?? value;
  }

  /** A row of the snapshot as the org knows its record now: its Id and its lookups. */
  rowAsNow(record: BackupRecord): BackupRecord {
    if (this.empty) return record;
    const now: Record<string, unknown> = { ...record };
    for (const [field, value] of Object.entries(record)) {
      if (field === 'attributes') continue;
      const remapped = this.remapped(value);
      if (remapped !== value) now[field] = remapped;
    }
    return now as BackupRecord;
  }
}

// ─── Reading the index ───────────────────────────────────────────────────────

/**
 * The index of one object's snapshot, read: `S`, the records the snapshot
 * holds, each by the first fifteen characters of its id with the stamp it was
 * read with; and the chunks a rewind reads their values back by.
 */
export class SnapshotIndex {
  private constructor(
    readonly objectApiName: string,
    private readonly snapshotId: string,
    private readonly snapshotFile: string,
    private readonly rows: IndexRows,
    private readonly byKey: RowsByKey,
    /** The records a rewind made again, every object's: see {@link Recreated}. */
    readonly recreated: Recreated,
  ) {}

  /**
   * The index of `objectApiName` in a checkpoint's folder, whose values are in
   * the snapshot `snapshotId`.
   *
   * The records a rewind made again are named by their Ids now, as the
   * checkpoint's folder pairs them (`Recreated`), unless `recreated` is given.
   *
   * @throws {CheckpointStoreError} `damaged`, when it is not there, is not an
   *   index, or holds a record twice: a preview never reads part of an object
   *   for all of it.
   */
  static async read(
    folder: CheckpointFolder,
    snapshotId: string,
    objectApiName: string,
    recreated?: Recreated,
  ): Promise<SnapshotIndex> {
    const file = indexFileOf(folder, objectApiName);
    const snapshotFile = snapshotFileOf(folder, snapshotId, objectApiName);
    const damaged = (why: string): CheckpointStoreError =>
      new CheckpointStoreError('damaged', `The checkpoint’s index of ${objectApiName} ${why}.`);
    let bytes: Buffer;
    try {
      bytes = await readFile(file);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw damaged('is not on this machine');
      throw err;
    }
    const head = INDEX_HEAD.length;
    if (
      bytes.length < head ||
      !bytes.subarray(0, head).equals(INDEX_HEAD) ||
      (bytes.length - head) % ROW_BYTES !== 0
    ) {
      throw damaged('is not an index of its snapshot');
    }
    const rows = new IndexRows(bytes.subarray(head));
    const byKey = new RowsByKey(rows, rows.size);
    for (let row = 0; row < rows.size; row++) {
      if (!rows.wellFormed(row)) throw damaged(`is damaged at row ${row + 1}`);
      if (byKey.add(row) >= 0) throw damaged(`holds record ${rows.keyAt(row)} twice`);
    }
    return new SnapshotIndex(
      objectApiName,
      snapshotId,
      snapshotFile,
      rows,
      byKey,
      recreated ?? (await Recreated.read(folder)),
    );
  }

  /** Records the snapshot holds: `|S|`. */
  get size(): number {
    return this.rows.size;
  }

  /**
   * The row of the record `id`, of either length, in the snapshot's order; -1
   * when it holds none. A record made again is held by its Id now, never by
   * the one it had.
   */
  rowOf(id: unknown): number {
    if (typeof id !== 'string' || !RECORD_ID.test(id)) return -1;
    const key = id.slice(0, KEY_BYTES);
    const original = this.recreated.originalOf(key);
    if (original !== undefined) return this.byKey.find(original);
    if (this.recreated.retired(id)) return -1;
    return this.byKey.find(key);
  }

  /**
   * Whether `id` is one the snapshot holds a record by that a rewind made
   * again, under another Id now: neither held, nor a record to bring back.
   */
  retired(id: unknown): boolean {
    return this.recreated.retired(id) && this.byKey.find(String(id).slice(0, KEY_BYTES)) >= 0;
  }

  /** The Id the snapshot holds the record now named `id` by: the one it had before it was made again. */
  snapshotIdOf(id: string): string {
    const row = this.rowOf(id);
    if (row < 0) return id;
    const key = this.rows.keyAt(row);
    return canonicalRecordId(key) ?? key;
  }

  /** Whether the snapshot holds the record `id`: `id ∈ S`. */
  has(id: unknown): boolean {
    return this.rowOf(id) >= 0;
  }

  /**
   * The `SystemModstamp` the snapshot read the record `id` with, in
   * milliseconds since the epoch; undefined when it holds no such record.
   */
  stampOf(id: unknown): number | undefined {
    const row = this.rowOf(id);
    return row < 0 ? undefined : this.rows.stampAt(row);
  }

  /** The id of the record at row `row`, in its 18-character form: its Id now, for one made again. */
  idAt(row: number): string {
    const key = this.rows.keyAt(row);
    return this.recreated.currentOf(key) ?? canonicalRecordId(key) ?? key;
  }

  /**
   * A reader of the snapshot's values of `ids` alone, for the give-back of one
   * chunk (`restoreOverwrites`): it answers for this object of this snapshot
   * only, and reads each record the snapshot holds at its line's offset, in
   * the file's order, when it is gone through. An id the snapshot does not
   * hold is left out, as one whose values were not kept. A record made again
   * is read under its Id now, its lookups that named a record made again
   * naming that record's new Id.
   *
   * @throws {RangeError} For more than {@link SNAPSHOT_CHUNK_IDS} ids.
   */
  chunk(ids: readonly string[]): BackupReader {
    if (ids.length > SNAPSHOT_CHUNK_IDS) {
      throw new RangeError(
        `A chunk of the snapshot reads ${SNAPSHOT_CHUNK_IDS} records at most; ${ids.length} were asked.`,
      );
    }
    const wanted = new Set<number>();
    for (const id of ids) {
      const row = this.rowOf(id);
      if (row >= 0) wanted.add(row);
    }
    const rows = [...wanted].sort((a, b) => this.rows.offsetAt(a) - this.rows.offsetAt(b));
    return {
      batches: async (operationId, objectApiName, size) => {
        if (operationId !== this.snapshotId || objectApiName !== this.objectApiName) return null;
        const per = size >= 1 ? Math.floor(size) : 1;
        return { [Symbol.asyncIterator]: () => this.rowsAt(rows, per) };
      },
    };
  }

  /**
   * The records at `rows`, `size` at a time, each read at its offset.
   *
   * @throws {CheckpointStoreError} `damaged`, when a line is not the record,
   *   as read, that the index says is there.
   */
  private async *rowsAt(rows: readonly number[], size: number): AsyncGenerator<BackupRecord[]> {
    if (rows.length === 0) return;
    const handle = await openSnapshot(this.snapshotFile, this.objectApiName);
    try {
      let buffer = Buffer.alloc(0);
      let batch: BackupRecord[] = [];
      for (const row of rows) {
        const length = this.rows.lengthAt(row);
        const offset = this.rows.offsetAt(row);
        if (buffer.length < length) buffer = Buffer.alloc(Math.max(length, buffer.length * 2));
        let got = 0;
        while (got < length) {
          const { bytesRead } = await handle.read(buffer, got, length - got, offset + got);
          if (bytesRead === 0) break;
          got += bytesRead;
        }
        const record = got === length ? recordOf(buffer.toString('utf8', 0, length)) : undefined;
        if (!record || !this.isRowOf(row, record)) {
          throw new CheckpointStoreError(
            'damaged',
            `The checkpoint’s snapshot of ${this.objectApiName} does not hold record ` +
              `${this.idAt(row)} where its index says: the file changed since the checkpoint was taken.`,
          );
        }
        batch.push(this.recreated.rowAsNow(record));
        if (batch.length === size) {
          yield batch;
          batch = [];
        }
      }
      if (batch.length > 0) yield batch;
    } finally {
      await handle.close();
    }
  }

  /** Whether `record` is the record of row `row` as the take read it: its id, and its stamp. */
  private isRowOf(row: number, record: BackupRecord): boolean {
    const id = record.Id;
    return (
      typeof id === 'string' &&
      RECORD_ID.test(id) &&
      this.rows.holds(row, id.slice(0, KEY_BYTES)) &&
      stampMs(record.SystemModstamp) === this.rows.stampAt(row)
    );
  }
}

// ─── Gone for good ───────────────────────────────────────────────────────────

/**
 * The records of a snapshot the org still holds, live or in its recycle bin,
 * one bit a row of the index: what a scan of its live ids and the read of its
 * bin since mark. The rows left unmarked are the records gone for good, which
 * cannot come back with their Id.
 */
export class GoneForGood {
  private readonly marked: Uint8Array;
  private found = 0;

  constructor(private readonly index: SnapshotIndex) {
    this.marked = new Uint8Array(Math.ceil(index.size / 8));
  }

  /** Mark the record `id` as still in the org; whether the snapshot holds it. */
  mark(id: unknown): boolean {
    const row = this.index.rowOf(id);
    if (row < 0) return false;
    const bit = 1 << (row & 7);
    const at = row >>> 3;
    if ((this.marked[at] & bit) === 0) {
      this.marked[at] |= bit;
      this.found++;
    }
    return true;
  }

  /** Records of the snapshot not marked. */
  get count(): number {
    return this.index.size - this.found;
  }

  /** The ids of the records not marked, in the snapshot's order, each in its 18-character form. */
  *ids(): Generator<string> {
    for (let row = 0; row < this.index.size; row++) {
      if ((this.marked[row >>> 3] & (1 << (row & 7))) === 0) yield this.index.idAt(row);
    }
  }
}
