/**
 * The index of a compressed snapshot (`SFCKIDX2`) and its reads, beside the
 * plain one a checkpoint taken before the compression holds
 * (`snapshotIndex.test.ts`): the same records found at the same ids, a
 * member inflated once for every row in it and never the whole file, and a
 * file changed since the take refused, each way it can change, with why.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fc from 'fast-check';
import { canonicalRecordId } from '../../core/common/existingRecordMatch.js';
import {
  BackupRecordStore,
  nodeBackupFiles,
  type BackupRecord,
} from '../dataops/BackupRecordStore.js';
import {
  CheckpointStoreError,
  defaultCheckpointLocksDir,
  indexFileOf,
  openCheckpointStore,
  type CheckpointFolder,
} from './OrgCheckpointStore.js';
import {
  SNAPSHOT_MEMBER_BYTES,
  compressedSnapshotFiles,
  memberHeadOf,
  readMember,
} from './compressedSnapshotFiles.js';
import {
  SnapshotIndex,
  compressedSnapshotFileOf,
  snapshotFileOf,
  snapshotIndexBytes,
  writeSnapshotIndex,
} from './snapshotIndex.js';

// The members a read inflates, counted: the real reader, watched.
vi.mock('./compressedSnapshotFiles.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./compressedSnapshotFiles.js')>();
  return { ...actual, readMember: vi.fn(actual.readMember) };
});

const ORG = '00Dxx0000001234EAA';
const CHECKPOINT = 'ck-20261022-140512-a1b2';
const SNAPSHOT = 'op-1792700000000';
const STAMP = '2026-10-22T14:05:12.000+0000';

/** The id of the `n`-th Account of a test, 18 characters. */
function accountId(n: number): string {
  const id = canonicalRecordId(`001xx${String(n).padStart(10, '0')}`);
  if (!id) throw new Error(`Not an id: ${n}`);
  return id;
}

/** A row as the DataOps snapshot keeps it. */
function rowOf(n: number, values: Record<string, unknown> = {}): BackupRecord {
  const id = accountId(n);
  return {
    attributes: { type: 'Account', url: `/services/data/v66.0/sobjects/Account/${id}` },
    Id: id,
    SystemModstamp: STAMP,
    Name: `Account ${n}`,
    ...values,
  };
}

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.mocked(readMember).mockClear();
});

/** A checkpoint's folder, made by the store, as a take makes it. */
async function folderOf(): Promise<CheckpointFolder> {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-snapshot-v2-'));
  made.push(dir);
  const opened = openCheckpointStore({
    root: join(dir, 'checkpoints'),
    locksDir: defaultCheckpointLocksDir(join(dir, 'home')),
  });
  if (!('store' in opened)) throw new Error(`refused: ${opened.refusal.reason}`);
  return opened.store.create(ORG, CHECKPOINT);
}

/** Snapshot `rows` as the take does, compressed, in pages of `page`, then index and read it. */
async function indexed(
  folder: CheckpointFolder,
  rows: readonly BackupRecord[],
  page = 2_000,
): Promise<SnapshotIndex> {
  const store = new BackupRecordStore(compressedSnapshotFiles(nodeBackupFiles(folder.dir)));
  await store.begin(SNAPSHOT, 'Account');
  for (let at = 0; at < rows.length; at += page) {
    await store.append(SNAPSHOT, 'Account', rows.slice(at, at + page));
  }
  await writeSnapshotIndex(folder, SNAPSHOT, 'Account');
  return SnapshotIndex.read(folder, SNAPSHOT, 'Account');
}

/** What a chunk of `ids` gives, every batch together. */
async function chunkOf(index: SnapshotIndex, ids: readonly string[]): Promise<BackupRecord[]> {
  const batches = await index.chunk(ids).batches(SNAPSHOT, 'Account', 50);
  const got: BackupRecord[] = [];
  for await (const batch of batches ?? []) got.push(...batch);
  return got;
}

/** Every record `records()` gives, in its order. */
async function recordsOf(index: SnapshotIndex): Promise<BackupRecord[]> {
  const got: BackupRecord[] = [];
  for await (const record of index.records()) got.push(record);
  return got;
}

/** The members of a compressed file, by their headers. */
function membersIn(bytes: Buffer): Array<{ at: number; total: number }> {
  const members: Array<{ at: number; total: number }> = [];
  for (let at = 0; at < bytes.length;) {
    const head = memberHeadOf(bytes.subarray(at));
    if (!head) throw new Error(`no member at ${at}`);
    members.push({ at, total: head.total });
    at += head.total;
  }
  return members;
}

/** What a promise rejects with. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err: unknown) {
    return err;
  }
  throw new Error('It did not reject');
}

/** A text of any characters, astral and combining ones among them, sometimes longer than a member. */
const anyText = fc.oneof(
  { weight: 8, arbitrary: fc.string({ unit: 'binary', maxLength: 60 }) },
  {
    weight: 1,
    arbitrary: fc
      .integer({ min: SNAPSHOT_MEMBER_BYTES / 4, max: SNAPSHOT_MEMBER_BYTES })
      .map((length) => 'Ω𝄞é'.repeat(length).slice(0, length * 2)),
  },
);

describe('the index of a compressed snapshot', () => {
  it('gives back, by any of their ids, exactly the records it was given, and every one of them in its order, whatever their values and pages', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ note: anyText, size: fc.integer({ min: 0, max: 3 }) }), {
          minLength: 0,
          maxLength: 400,
        }),
        fc.integer({ min: 1, max: 150 }),
        fc.array(fc.nat(), { maxLength: 40 }),
        async (values, page, picks) => {
          const folder = await folderOf();
          const rows = values.map(({ note, size }, n) =>
            rowOf(n, { Description: note, Employees: size }),
          );

          const index = await indexed(folder, rows, page);

          expect([index.format, index.size]).toEqual([2, rows.length]);
          expect(statSync(indexFileOf(folder, 'Account')).size).toBe(
            snapshotIndexBytes(rows.length, 2),
          );
          const wanted = [...new Set(picks.map((pick) => pick % Math.max(1, rows.length)))]
            .filter((n) => n < rows.length)
            .sort((a, b) => a - b);
          expect(await chunkOf(index, [...wanted].reverse().map(accountId))).toEqual(
            wanted.map((n) => rows[n]),
          );
          expect(await recordsOf(index)).toEqual(rows);
          // An id the snapshot does not hold is left out.
          expect(await chunkOf(index, [accountId(rows.length + 1)])).toEqual([]);
        },
      ),
      { numRuns: 40, seed: 4402, endOnFailure: true },
    );
  }, 120_000);

  it('finds each of 5,000 records in its own member and line, an object of no record as an empty index of an empty file', async () => {
    const folder = await folderOf();
    const rows = Array.from({ length: 5_000 }, (_, n) =>
      rowOf(n, { Description: `n${n}`.repeat(40) }),
    );

    const index = await indexed(folder, rows);

    const spread = [0, 1, 999, 1_000, 2_500, 4_999];
    expect(await chunkOf(index, spread.map(accountId))).toEqual(spread.map((n) => rows[n]));
    expect((await recordsOf(index)).length).toBe(5_000);

    const empty = await folderOf();
    const none = await indexed(empty, []);
    expect([none.format, none.size]).toEqual([2, 0]);
    expect(statSync(compressedSnapshotFileOf(empty, SNAPSHOT, 'Account')).size).toBe(0);
    expect(await recordsOf(none)).toEqual([]);
    expect(await chunkOf(none, [accountId(1)])).toEqual([]);
  });

  it('inflates for a chunk the members its records are in, each once, and for every record each member once, never the file whole', async () => {
    const folder = await folderOf();
    const rows = Array.from({ length: 3_000 }, (_, n) =>
      rowOf(n, { Description: `x${n}`.repeat(60) }),
    );
    const index = await indexed(folder, rows);
    const members = membersIn(readFileSync(compressedSnapshotFileOf(folder, SNAPSHOT, 'Account')));
    expect(members.length).toBeGreaterThan(10);
    vi.mocked(readMember).mockClear();

    await chunkOf(index, [accountId(7), accountId(3), accountId(5)]);

    expect(vi.mocked(readMember)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(readMember).mock.calls[0].slice(1, 3)).toEqual([0, members[0].total]);

    vi.mocked(readMember).mockClear();
    await recordsOf(index);
    expect(vi.mocked(readMember).mock.calls.map((call) => call[1])).toEqual(
      members.map(({ at }) => at),
    );
  });
});

describe('a compressed snapshot changed since the take', () => {
  /** A snapshot of 1,500 records of several members, indexed; its file and its members. */
  async function taken(): Promise<{
    folder: CheckpointFolder;
    index: SnapshotIndex;
    file: string;
    bytes: Buffer;
    members: Array<{ at: number; total: number }>;
    rows: BackupRecord[];
  }> {
    const folder = await folderOf();
    const rows = Array.from({ length: 1_500 }, (_, n) =>
      rowOf(n, { Description: `value ${n} `.repeat(n % 5 === 0 ? 30 : 8) }),
    );
    const index = await indexed(folder, rows, 500);
    const file = compressedSnapshotFileOf(folder, SNAPSHOT, 'Account');
    const bytes = readFileSync(file);
    return { folder, index, file, bytes, members: membersIn(bytes), rows };
  }

  /** The id of a record whose line is in the member that starts at byte `at`. */
  async function idIn(t: Awaited<ReturnType<typeof taken>>, member: number): Promise<string> {
    vi.mocked(readMember).mockClear();
    for (const row of t.rows) {
      vi.mocked(readMember).mockClear();
      await chunkOf(t.index, [String(row.Id)]);
      if (vi.mocked(readMember).mock.calls[0]?.[1] === t.members[member].at) return String(row.Id);
    }
    throw new Error(`no record in member ${member}`);
  }

  it('refuses a byte changed in a member, in a record’s values where the id and the stamp are the same, by the member’s CRC', async () => {
    const t = await taken();
    const id = await idIn(t, 1);
    const changed = Buffer.from(t.bytes);
    // A byte of the member's deflated lines, past its header.
    changed[t.members[1].at + 60] ^= 0x01;
    writeFileSync(t.file, changed);

    const err = await rejection(chunkOf(t.index, [id]));

    expect(err).toBeInstanceOf(CheckpointStoreError);
    expect(err).toMatchObject({
      code: 'damaged',
      message: `The checkpoint’s snapshot of Account holds a block that does not inflate at byte ${t.members[1].at}: the file changed since the checkpoint was taken.`,
    });
    await expect(recordsOf(t.index)).rejects.toMatchObject({ code: 'damaged' });
  });

  it('refuses two members swapped, each not where its index says, by the header of the member found there', async () => {
    const t = await taken();
    const [first, second] = t.members;
    expect(first.total).not.toBe(second.total);
    const swapped = Buffer.concat([
      t.bytes.subarray(second.at, second.at + second.total),
      t.bytes.subarray(first.at, first.at + first.total),
      t.bytes.subarray(second.at + second.total),
    ]);
    writeFileSync(t.file, swapped);

    const err = await rejection(chunkOf(t.index, [accountId(0)]));

    expect(err).toMatchObject({
      code: 'damaged',
      message:
        'The checkpoint’s snapshot of Account holds another block than its index says at byte 0: ' +
        'the file changed since the checkpoint was taken.',
    });
  });

  it('refuses a file cut short, and one a member was added to, by the bytes its index says it takes, whichever record is read', async () => {
    const t = await taken();
    const cut = t.bytes.subarray(0, t.bytes.length - 7);
    writeFileSync(t.file, cut);

    await expect(chunkOf(t.index, [accountId(0)])).rejects.toMatchObject({
      code: 'damaged',
      message: `The checkpoint’s snapshot of Account takes ${cut.length} bytes where its index says ${t.bytes.length}: the file changed since the checkpoint was taken.`,
    });

    const added = Buffer.concat([t.bytes, t.bytes.subarray(0, t.members[0].total)]);
    writeFileSync(t.file, added);

    await expect(chunkOf(t.index, [accountId(0)])).rejects.toMatchObject({
      code: 'damaged',
      message: expect.stringContaining(`takes ${added.length} bytes where its index says`),
    });
    await expect(recordsOf(t.index)).rejects.toMatchObject({ code: 'damaged' });
  });

  it('refuses at the take a file whose members do not reach its end, or whose block does not inflate, saying it cannot be indexed', async () => {
    const t = await taken();
    writeFileSync(t.file, t.bytes.subarray(0, t.bytes.length - 3));

    await expect(writeSnapshotIndex(t.folder, SNAPSHOT, 'Account')).rejects.toMatchObject({
      code: 'damaged',
      message: expect.stringMatching(
        /^The snapshot of Account is cut short: its block at byte \d+ ends past the file's end: it cannot be indexed\.$/,
      ),
    });

    const changed = Buffer.from(t.bytes);
    changed[t.members[2].at + 50] ^= 0x01;
    writeFileSync(t.file, changed);
    await expect(writeSnapshotIndex(t.folder, SNAPSHOT, 'Account')).rejects.toMatchObject({
      code: 'damaged',
      message: `The snapshot of Account holds a block that does not inflate at byte ${t.members[2].at}: it cannot be indexed.`,
    });
  });
});

describe('the plain snapshot a checkpoint taken before the compression holds', () => {
  /** Snapshot `rows` plain, as SandForge 1.69 did, then index and read it. */
  async function plain(
    folder: CheckpointFolder,
    rows: readonly BackupRecord[],
  ): Promise<SnapshotIndex> {
    const store = new BackupRecordStore(nodeBackupFiles(folder.dir));
    await store.begin(SNAPSHOT, 'Account');
    await store.append(SNAPSHOT, 'Account', rows);
    await writeSnapshotIndex(folder, SNAPSHOT, 'Account');
    return SnapshotIndex.read(folder, SNAPSHOT, 'Account');
  }

  it('is indexed and read in the first form, every record in its order, by its index’s first bytes', async () => {
    const folder = await folderOf();
    const rows = Array.from({ length: 1_200 }, (_, n) =>
      rowOf(n, { Description: 'é'.repeat(n % 9) }),
    );

    const index = await plain(folder, rows);

    expect(readFileSync(indexFileOf(folder, 'Account')).toString('latin1', 0, 8)).toBe('SFCKIDX1');
    expect([index.format, index.size]).toEqual([1, 1_200]);
    expect(await recordsOf(index)).toEqual(rows);
    expect(await chunkOf(index, [accountId(1_199), accountId(3)])).toEqual([rows[3], rows[1_199]]);
  });

  it('refuses read in order a line added to it, or one fewer, or another record, as one changed since the take', async () => {
    const folder = await folderOf();
    const rows = Array.from({ length: 20 }, (_, n) => rowOf(n));
    const index = await plain(folder, rows);
    const file = snapshotFileOf(folder, SNAPSHOT, 'Account');
    const text = readFileSync(file, 'utf8');

    writeFileSync(file, `${text}${JSON.stringify(rowOf(99))}\n`);
    await expect(recordsOf(index)).rejects.toMatchObject({
      code: 'damaged',
      message: expect.stringContaining('holds more records than its index'),
    });

    writeFileSync(file, text.split('\n').slice(0, 19).join('\n'));
    await expect(recordsOf(index)).rejects.toMatchObject({
      code: 'damaged',
      message: expect.stringContaining(
        `does not hold record ${accountId(19)} where its index says`,
      ),
    });

    const lines = text.split('\n');
    [lines[2], lines[3]] = [lines[3], lines[2]];
    writeFileSync(file, lines.join('\n'));
    await expect(recordsOf(index)).rejects.toMatchObject({
      code: 'damaged',
      message: expect.stringContaining(`does not hold record ${accountId(2)} where its index says`),
    });
  });

  it('says an index of neither form is no index of its snapshot', async () => {
    const folder = await folderOf();
    await plain(folder, [rowOf(1)]);
    const file = indexFileOf(folder, 'Account');
    const bytes = readFileSync(file);
    bytes.write('SFCKIDX3', 0, 'latin1');
    writeFileSync(file, bytes);

    await expect(SnapshotIndex.read(folder, SNAPSHOT, 'Account')).rejects.toMatchObject({
      code: 'damaged',
      message: 'The checkpoint’s index of Account is not an index of its snapshot.',
    });
  });
});
