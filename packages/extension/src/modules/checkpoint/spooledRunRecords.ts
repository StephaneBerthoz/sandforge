/**
 * The ids a rewind sets out to act on, written to disk as they are found and
 * read back a page at a time: what it deletes, handed to the removal as the
 * paginated records it takes (`RunRecords`), and what it brings back and gives
 * back, read a chunk at a time.
 *
 * A rewind of an org whose testers loaded a million records deletes a million
 * records. Held in memory as a removal's plan, ids and keys and dates of each,
 * such a removal took some 650 MB more of the extension host than it held
 * before (`ForgeRunRemoval`'s `RunRecords`). Here each object's ids go to a
 * file of their own, one a line, and what stays in memory is one set of their
 * keys, which the removal asks whether a record is one of them: 15 bytes a
 * record and a slot, some 25 MB for a million.
 *
 * The set is exact. The keys a removal leaves are held elsewhere as two hashes
 * each (`HashedKeys`), and two keys whose hashes meet are taken there for one:
 * one record more set out to be taken again, which the org says is gone. Here
 * such a key would be a record of the org taken for one of the rewind's, and a
 * removal lets a record of its own go with its parent: one the checkpoint
 * holds would go with it. So a lookup ends on the key itself.
 *
 * A spool is written whole or not at all: each object's file is flushed to the
 * disk before the list of its objects and their counts is written, temp and
 * rename, and a spool read back whose files do not hold what that list says is
 * refused as damaged, never read in part for all of it.
 */

import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import * as z from 'zod';
import { sanitizeSoqlObjectName } from '@sandforge/shared';
import type { RunRecords } from '../forge/ForgeRunRemoval.js';
import { hashA } from '../forge/ForgeRunStore.js';
import {
  CHECKPOINT_FILE_MODE,
  CheckpointStoreError,
  makePrivateDir,
} from './OrgCheckpointStore.js';

/** Ids handed over a page at a time, as a run's journal hands its own to a removal. */
export const RUN_RECORDS_PAGE = 2_000;

/** The first fifteen characters of an id: the key the org knows a record by, whichever length it is written in. */
const KEY_LENGTH = 15;

/** A Salesforce id, of either length. */
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** Ids held before a file is appended to. */
const LINES_PER_WRITE = 2_000;

/** What a spool's list of its objects is named in its folder. */
const MANIFEST = 'spool.json';

/** The key of `id`, or undefined when it is no id. */
function keyOf(id: unknown): string | undefined {
  return typeof id === 'string' && RECORD_ID.test(id) ? id.slice(0, KEY_LENGTH) : undefined;
}

// ─── Keys ────────────────────────────────────────────────────────────────────

/**
 * Records by their key, exactly, each with a few flags: a key's hash says
 * where its search starts, and a slot is the key's only once the key it holds
 * compares equal, character by character. About 25 bytes a record.
 */
export class RecordKeySet {
  private bytes = Buffer.alloc(KEY_LENGTH * 1024);
  private flags = new Uint16Array(1024);
  /** Each slot holds a key's place plus one; 0 is free. */
  private slots = new Uint32Array(2048);
  private used = 0;

  /** Records held. */
  get size(): number {
    return this.used;
  }

  /** The place of `key`, or -1. */
  private find(key: string): number {
    const mask = this.slots.length - 1;
    for (let slot = hashA(key) & mask; ; slot = (slot + 1) & mask) {
      const at = this.slots[slot];
      if (at === 0) return -1;
      if (this.holds(at - 1, key)) return at - 1;
    }
  }

  private holds(place: number, key: string): boolean {
    const from = place * KEY_LENGTH;
    for (let i = 0; i < KEY_LENGTH; i++) {
      if (this.bytes[from + i] !== key.charCodeAt(i)) return false;
    }
    return true;
  }

  private keyAt(place: number): string {
    const from = place * KEY_LENGTH;
    return this.bytes.toString('latin1', from, from + KEY_LENGTH);
  }

  private place(place: number, key: string): void {
    const mask = this.slots.length - 1;
    let slot = hashA(key) & mask;
    while (this.slots[slot] !== 0) slot = (slot + 1) & mask;
    this.slots[slot] = place + 1;
  }

  /**
   * Hold `id`'s record, with `flags` set on it beside the ones it holds
   * already: whether it was not held before.
   *
   * @throws {RangeError} When `id` is no Salesforce id.
   */
  add(id: string, flags = 0): boolean {
    const key = keyOf(id);
    if (key === undefined) throw new RangeError(`Not a Salesforce id: ${String(id)}`);
    const held = this.find(key);
    if (held >= 0) {
      this.flags[held] |= flags;
      return false;
    }
    if ((this.used + 1) * 2 > this.slots.length) {
      const old = this.slots;
      this.slots = new Uint32Array(old.length * 2);
      for (const at of old) if (at !== 0) this.place(at - 1, this.keyAt(at - 1));
    }
    if ((this.used + 1) * KEY_LENGTH > this.bytes.length) {
      const grown = Buffer.alloc(this.bytes.length * 2);
      this.bytes.copy(grown);
      this.bytes = grown;
      const flags = new Uint16Array(this.flags.length * 2);
      flags.set(this.flags);
      this.flags = flags;
    }
    this.bytes.write(key, this.used * KEY_LENGTH, KEY_LENGTH, 'latin1');
    this.flags[this.used] = flags;
    this.place(this.used, key);
    this.used++;
    return true;
  }

  /** Whether `id`'s record is held, by its key: an id of either length, or the key itself. */
  has(id: unknown): boolean {
    const key = keyOf(id);
    return key !== undefined && this.find(key) >= 0;
  }

  /** Records held whose flags `test` takes. */
  count(test: (flags: number) => boolean): number {
    let found = 0;
    for (let at = 0; at < this.used; at++) if (test(this.flags[at])) found++;
    return found;
  }

  /** The flags of `id`'s record; 0 for one not held. */
  flagsOf(id: unknown): number {
    const key = keyOf(id);
    if (key === undefined) return 0;
    const at = this.find(key);
    return at < 0 ? 0 : this.flags[at];
  }
}

// ─── Spools ──────────────────────────────────────────────────────────────────

const manifestSchema = z.object({
  version: z.literal(1),
  objects: z.array(
    z.object({ objectApiName: z.string().min(1), count: z.number().int().nonnegative() }),
  ),
});

/** Where an object's ids are in a spool's folder. */
function idsFileOf(dir: string, objectApiName: string): string {
  return join(dir, `${sanitizeSoqlObjectName(objectApiName)}.ids`);
}

/**
 * Write `content` to `file` whole: into a file of its own beside it, flushed,
 * then renamed over it. A write stopped at any point leaves the file as it was.
 */
async function writeWhole(file: string, content: string): Promise<void> {
  const temp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  const handle = await open(temp, 'wx', CHECKPOINT_FILE_MODE);
  try {
    try {
      await handle.writeFile(content, 'utf8');
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

/** A file flushed to the disk, as the list that names it is about to be written. */
async function flushed(file: string): Promise<void> {
  const handle = await open(file, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Ids per object, written to a folder as they are found, each record once,
 * the objects in the order they were first given an id. What is read back
 * from it is the spool {@link finish} names.
 */
export class IdSpoolWriter {
  private readonly order: string[] = [];
  private readonly counts = new Map<string, number>();
  private readonly lines = new Map<string, string[]>();
  private readonly written = new Set<string>();
  /** The keys of the records written, which a removal asks of its records. */
  readonly keys = new RecordKeySet();
  private made = false;

  constructor(readonly dir: string) {}

  /**
   * Add a record of `objectApiName`: whether it was added, and not held
   * already under its key.
   *
   * @throws {RangeError} When `id` is no Salesforce id.
   */
  async add(objectApiName: string, id: string): Promise<boolean> {
    if (!this.keys.add(id)) return false;
    let held = this.lines.get(objectApiName);
    if (!held) {
      sanitizeSoqlObjectName(objectApiName);
      held = [];
      this.lines.set(objectApiName, held);
      this.order.push(objectApiName);
    }
    held.push(id);
    this.counts.set(objectApiName, (this.counts.get(objectApiName) ?? 0) + 1);
    if (held.length >= LINES_PER_WRITE) await this.flush(objectApiName);
    return true;
  }

  private async flush(objectApiName: string): Promise<void> {
    const held = this.lines.get(objectApiName) ?? [];
    if (!this.made) {
      await makePrivateDir(this.dir);
      this.made = true;
    }
    const first = !this.written.has(objectApiName);
    if (held.length === 0 && !first) return;
    await appendFile(idsFileOf(this.dir, objectApiName), held.map((id) => `${id}\n`).join(''), {
      encoding: 'utf8',
      mode: CHECKPOINT_FILE_MODE,
      flag: first ? 'w' : 'a',
    });
    this.written.add(objectApiName);
    this.lines.set(objectApiName, []);
  }

  /** Records added of each object, in the order the objects came. */
  get objects(): Array<{ objectApiName: string; count: number }> {
    return this.order.map((objectApiName) => ({
      objectApiName,
      count: this.counts.get(objectApiName) ?? 0,
    }));
  }

  /**
   * Write what is held, flush every file, then the list of the objects and
   * their counts: the spool, as it is read back.
   */
  async finish(): Promise<IdSpool> {
    if (!this.made) {
      await makePrivateDir(this.dir);
      this.made = true;
    }
    for (const objectApiName of this.order) {
      await this.flush(objectApiName);
      await flushed(idsFileOf(this.dir, objectApiName));
    }
    const objects = this.objects;
    await writeWhole(join(this.dir, MANIFEST), `${JSON.stringify({ version: 1, objects })}\n`);
    return new IdSpool(this.dir, objects);
  }
}

/** Ids per object, as a spool's folder holds them: read a page at a time, each time they are asked. */
export class IdSpool {
  constructor(
    readonly dir: string,
    readonly objects: ReadonlyArray<{ readonly objectApiName: string; readonly count: number }>,
  ) {}

  /** Records it holds, every object's. */
  get count(): number {
    return this.objects.reduce((sum, object) => sum + object.count, 0);
  }

  /**
   * The spool written to `dir`.
   *
   * @throws {CheckpointStoreError} `damaged`, when its list of objects is not
   *   there or does not read as one.
   */
  static async open(dir: string): Promise<IdSpool> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(dir, MANIFEST), 'utf8'));
    } catch {
      throw new CheckpointStoreError(
        'damaged',
        'The list of what a rewind sets out to do is not on this machine.',
      );
    }
    const parsed = manifestSchema.safeParse(raw);
    if (!parsed.success) {
      throw new CheckpointStoreError(
        'damaged',
        'The list of what a rewind sets out to do does not read as one.',
      );
    }
    for (const { objectApiName } of parsed.data.objects) sanitizeSoqlObjectName(objectApiName);
    return new IdSpool(dir, parsed.data.objects);
  }

  /**
   * The ids of `objectApiName`'s records, `size` at a time, read from its
   * file: the same pages each time it is asked. None for an object it does
   * not hold.
   *
   * @throws {CheckpointStoreError} `damaged`, when the file holds a line that
   *   is no id, or other than the count its list says: changed since it was
   *   written.
   */
  async *pages(objectApiName: string, size = RUN_RECORDS_PAGE): AsyncGenerator<string[]> {
    const object = this.objects.find((held) => held.objectApiName === objectApiName);
    if (!object || object.count === 0) return;
    const damaged = (): CheckpointStoreError =>
      new CheckpointStoreError(
        'damaged',
        `The ${objectApiName} records a rewind sets out to act on are not as they were written.`,
      );
    const per = Math.max(1, Math.floor(size));
    const stream = createReadStream(idsFileOf(this.dir, objectApiName), { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let read = 0;
    let page: string[] = [];
    try {
      for await (const line of lines) {
        if (line === '') continue;
        if (!RECORD_ID.test(line)) throw damaged();
        read++;
        page.push(line);
        if (page.length >= per) {
          yield page;
          page = [];
        }
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw damaged();
      throw err;
    } finally {
      lines.close();
      stream.destroy();
    }
    if (read !== object.count) throw damaged();
    if (page.length > 0) yield page;
  }
}

/**
 * The records a rewind deletes, as the removal takes them (`removeRunRecords`):
 * read from their spool a page at a time, and told by an exact set of their
 * keys.
 */
export class SpooledRunRecords implements RunRecords {
  private constructor(
    readonly spool: IdSpool,
    private readonly keys: RecordKeySet,
  ) {}

  /** The records `writer` wrote, with the keys it wrote them under: nothing read back. */
  static async of(writer: IdSpoolWriter): Promise<SpooledRunRecords> {
    return new SpooledRunRecords(await writer.finish(), writer.keys);
  }

  /**
   * The records spooled to `dir`, every page read once to hold their keys: a
   * removal resumed, or an undo, takes them up as they were written.
   *
   * @throws {CheckpointStoreError} `damaged`, when the spool is not as written.
   */
  static async open(dir: string): Promise<SpooledRunRecords> {
    const spool = await IdSpool.open(dir);
    const keys = new RecordKeySet();
    for (const { objectApiName } of spool.objects) {
      for await (const page of spool.pages(objectApiName)) {
        for (const id of page) keys.add(id);
      }
    }
    return new SpooledRunRecords(spool, keys);
  }

  get objects(): ReadonlyArray<{ readonly objectApiName: string; readonly count: number }> {
    return this.spool.objects;
  }

  pages(objectApiName: string): AsyncIterable<readonly string[]> {
    return this.spool.pages(objectApiName);
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }
}
