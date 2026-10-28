import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalRecordId } from '../../core/common/existingRecordMatch.js';
import {
  BackupRecordStore,
  nodeBackupFiles,
  type BackupRecord,
} from '../dataops/BackupRecordStore.js';
import { hashA } from '../forge/ForgeRunStore.js';
import { restoreOverwrites } from '../sync/SyncRunRestore.js';
import { MemoryRemovalOrg, orgStamp } from '../../test/memoryRemovalOrg.js';
import { MemoryRestoreOrg } from '../../test/memoryRestoreOrg.js';
import { compositeReader } from './compositeQueries.js';
import { deletedRead, idScanRead, readStreams } from './orgStreams.js';
import {
  CheckpointStoreError,
  defaultCheckpointLocksDir,
  indexFileOf,
  notInBinFileOf,
  openCheckpointStore,
  recreatedFileOf,
  type CheckpointFolder,
} from './OrgCheckpointStore.js';
import {
  GoneForGood,
  NotInBin,
  Recreated,
  SNAPSHOT_CHUNK_IDS,
  SnapshotIndex,
  snapshotFileOf,
  snapshotIndexBytes,
  writeSnapshotIndex,
} from './snapshotIndex.js';

/** Whether the system gives files permission bits the store can rely on. */
const POSIX = process.platform !== 'win32';

const ORG = '00Dxx0000001234EAA';
const CHECKPOINT = 'ck-20261022-140512-a1b2';
/** The snapshot's DataOps operation id, as the checkpoint names it. */
const SNAPSHOT = 'op-1792700000000';

/** A stamp as the org writes one, to the second, `+0000`. */
const STAMP = '2026-10-22T14:05:12.000+0000';
const STAMP_MS = Date.parse('2026-10-22T14:05:12.000Z');

/** An id in its 18-character form, from its first fifteen characters. */
function id18(key: string): string {
  const id = canonicalRecordId(key);
  if (!id) throw new Error(`Not an id: ${key}`);
  return id;
}

/** The id of the `n`-th Account of a test, 18 characters. */
const accountId = (n: number): string => id18(`001xx${String(n).padStart(10, '0')}`);

/** A row as the DataOps snapshot keeps it: the org's `attributes`, the stamps, the values. */
function rowOf(id: string, values: Record<string, unknown> = {}, stamp = STAMP): BackupRecord {
  return {
    attributes: { type: 'Account', url: `/services/data/v66.0/sobjects/Account/${id}` },
    Id: id,
    SystemModstamp: stamp,
    CreatedDate: '2026-10-01T09:00:00.000+0000',
    ...values,
  };
}

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A checkpoint's folder, made by the store, as a take makes it. */
async function folderOf(): Promise<CheckpointFolder> {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-snapshot-index-'));
  made.push(dir);
  const opened = openCheckpointStore({
    root: join(dir, 'checkpoints'),
    locksDir: defaultCheckpointLocksDir(join(dir, 'home')),
  });
  if (!('store' in opened)) throw new Error(`refused: ${opened.refusal.reason}`);
  return opened.store.create(ORG, CHECKPOINT);
}

/** The DataOps store bound to a checkpoint's folder, as the take's own handler holds it. */
const valuesOf = (folder: CheckpointFolder): BackupRecordStore =>
  new BackupRecordStore(nodeBackupFiles(folder.dir));

/** Snapshot `rows` of an object into a checkpoint's folder, as the take reads them, a page at a time. */
async function snapshot(folder: CheckpointFolder, rows: readonly BackupRecord[]): Promise<void> {
  const store = valuesOf(folder);
  await store.begin(SNAPSHOT, 'Account');
  for (let at = 0; at < rows.length; at += 2_000) {
    await store.append(SNAPSHOT, 'Account', rows.slice(at, at + 2_000));
  }
}

/** Snapshot and index `rows`, then read the index back. */
async function indexed(
  folder: CheckpointFolder,
  rows: readonly BackupRecord[],
): Promise<SnapshotIndex> {
  await snapshot(folder, rows);
  await writeSnapshotIndex(folder, SNAPSHOT, 'Account');
  return SnapshotIndex.read(folder, SNAPSHOT, 'Account');
}

/** Every batch a reader gives of a chunk, as a restore goes through them. */
async function batchesOf(
  index: SnapshotIndex,
  ids: readonly string[],
  size: number,
): Promise<BackupRecord[][]> {
  const batches = await index.chunk(ids).batches(SNAPSHOT, 'Account', size);
  if (!batches) throw new Error('The chunk answered for no snapshot');
  const got: BackupRecord[][] = [];
  for await (const batch of batches) got.push(batch);
  return got;
}

/** Change the lines of an object's snapshot file in place, each line keeping its length. */
function rewriteLines(folder: CheckpointFolder, change: (lines: string[]) => string[]): void {
  const file = snapshotFileOf(folder, SNAPSHOT, 'Account');
  const before = readFileSync(file, 'utf8');
  const lines = change(before.split('\n'));
  const after = lines.join('\n');
  expect(Buffer.byteLength(after)).toBe(Buffer.byteLength(before));
  writeFileSync(file, after);
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

describe('snapshotFileOf', () => {
  it('names the file the DataOps store bound to the checkpoint’s folder writes an object’s values to, whatever the snapshot id holds', async () => {
    const folder = await folderOf();
    await valuesOf(folder).begin('op:1/a b', 'Account');
    await valuesOf(folder).append('op:1/a b', 'Account', [rowOf(accountId(1))]);

    const file = snapshotFileOf(folder, 'op:1/a b', 'Account');

    expect(file).toBe(join(folder.dir, 'backups', 'op_1_a_b__Account.ndjson'));
    expect(JSON.parse(readFileSync(file, 'utf8')).Id).toBe(accountId(1));
  });

  it('refuses a name that is not an object’s API name, before it becomes part of a path', async () => {
    const folder = await folderOf();
    for (const name of ['../Account', 'Account/x', '', '1Account']) {
      expect(() => snapshotFileOf(folder, SNAPSHOT, name)).toThrow(CheckpointStoreError);
    }
  });
});

describe('writeSnapshotIndex and SnapshotIndex.read', () => {
  it('keeps of each row of the snapshot its id, its stamp and where its line is, 35 bytes a row, in a file its owner alone reads', async () => {
    const folder = await folderOf();
    const rows = [
      rowOf(accountId(1), { Name: 'First' }),
      rowOf(accountId(2), { Name: 'Second' }, '2026-10-22T14:06:00.000+0000'),
      rowOf(accountId(3), { Name: 'Third' }, '2026-10-22T14:07:30.000Z'),
    ];
    await snapshot(folder, rows);

    const written = await writeSnapshotIndex(folder, SNAPSHOT, 'Account');

    expect(written).toEqual({ rows: 3, bytes: snapshotIndexBytes(3, 1) });
    expect(snapshotIndexBytes(3, 1)).toBe(8 + 3 * 35);
    const file = indexFileOf(folder, 'Account');
    expect(statSync(file).size).toBe(written.bytes);
    if (POSIX) expect(statSync(file).mode & 0o777).toBe(0o600);
    // Written through a file beside it, renamed over it: nothing else is left.
    expect(readdirSync(folder.indexDir)).toEqual(['Account.idx']);

    const index = await SnapshotIndex.read(folder, SNAPSHOT, 'Account');
    expect(index.size).toBe(3);
    expect(index.stampOf(accountId(1))).toBe(STAMP_MS);
    expect(index.stampOf(accountId(2))).toBe(Date.parse('2026-10-22T14:06:00.000Z'));
    expect(index.stampOf(accountId(3))).toBe(Date.parse('2026-10-22T14:07:30.000Z'));
    // Held by the first fifteen characters: either length of an id finds it.
    expect(index.stampOf(accountId(2).slice(0, 15))).toBe(Date.parse('2026-10-22T14:06:00.000Z'));
    expect([1, 2, 3].map((n) => index.rowOf(accountId(n)))).toEqual([0, 1, 2]);
    expect([0, 1, 2].map((row) => index.idAt(row))).toEqual([1, 2, 3].map(accountId));
    expect(index.has(accountId(3))).toBe(true);
    expect(index.has(accountId(4))).toBe(false);
    expect(index.stampOf(accountId(4))).toBeUndefined();
    for (const notAnId of [undefined, null, 42, '', 'not an id', `${accountId(1)}X`]) {
      expect(index.rowOf(notAnId)).toBe(-1);
    }
  });

  it('tells apart two ids whose hashes meet, and two that differ by the case of one letter, each with its own stamp', async () => {
    // A table that compared hashes, as the records a removal leaves are
    // held, would take each pair for one record.
    const meet = ['001xx00000133zx', '001xx000001epad'].map(id18);
    expect(hashA(meet[0].slice(0, 15))).toBe(hashA(meet[1].slice(0, 15)));
    const cased = ['001xx00000Abcde', '001xx00000abcde'].map(id18);
    const folder = await folderOf();
    const index = await indexed(folder, [
      rowOf(meet[0], {}, '2026-10-22T10:00:00.000+0000'),
      rowOf(cased[0], {}, '2026-10-22T11:00:00.000+0000'),
      rowOf(meet[1], {}, '2026-10-22T12:00:00.000+0000'),
      rowOf(cased[1], {}, '2026-10-22T13:00:00.000+0000'),
    ]);

    expect(index.size).toBe(4);
    expect([...meet, ...cased].map((id) => new Date(index.stampOf(id) ?? 0).toISOString())).toEqual(
      [
        '2026-10-22T10:00:00.000Z',
        '2026-10-22T12:00:00.000Z',
        '2026-10-22T11:00:00.000Z',
        '2026-10-22T13:00:00.000Z',
      ],
    );
    const gone = new GoneForGood(index);
    gone.mark(meet[0]);
    gone.mark(cased[1]);
    expect([...gone.ids()]).toEqual([cased[0], meet[1]]);
  });

  it('finds each of 60,000 records with its own stamp and its own line, and none it does not hold', async () => {
    const folder = await folderOf();
    const base = Date.parse('2026-10-01T00:00:00.000Z');
    const rows = Array.from({ length: 60_000 }, (_, n) =>
      rowOf(accountId(n), { Name: `Account ${n}` }, orgStamp(base + n * 1000)),
    );

    const index = await indexed(folder, rows);

    expect(index.size).toBe(60_000);
    for (let n = 0; n < 60_000; n++) {
      if (index.stampOf(accountId(n)) !== base + n * 1000) {
        throw new Error(`Account ${n} was not found with its own stamp`);
      }
    }
    expect(index.has(accountId(60_000))).toBe(false);
    expect(statSync(indexFileOf(folder, 'Account')).size).toBe(snapshotIndexBytes(60_000, 1));
    // The file is read a megabyte at a time: rows on either side of each
    // boundary are read back at their own offsets.
    const spread = [0, 5_999, 6_000, 30_000, 59_999];
    expect(await batchesOf(index, spread.map(accountId), 200)).toEqual([
      spread.map((n) => rows[n]),
    ]);
  });

  it('reads back whole a line longer than 64 KB and than a read of the file, as a wide object’s long text fields make one', async () => {
    const folder = await folderOf();
    const rows = [
      rowOf(accountId(1), { Name: 'Short' }),
      rowOf(accountId(2), { Name: 'Wide', Description: 'é'.repeat(700_000) }),
      rowOf(accountId(3), { Name: 'After' }),
    ];

    const index = await indexed(folder, rows);

    expect(Buffer.byteLength(JSON.stringify(rows[1]))).toBeGreaterThan(1 << 20);
    expect(await batchesOf(index, [1, 2, 3].map(accountId), 200)).toEqual([rows]);
  });

  it('indexes an object that holds no record, whose chunks read nothing', async () => {
    const folder = await folderOf();
    const index = await indexed(folder, []);

    expect(index.size).toBe(0);
    expect(await batchesOf(index, [accountId(1)], 200)).toEqual([]);
    expect(new GoneForGood(index).count).toBe(0);
  });

  it('refuses to index a snapshot it could not tell its records apart in, and leaves no index of it', async () => {
    const cases: Array<{ lines: string[]; says: RegExp }> = [
      {
        lines: [JSON.stringify(rowOf(accountId(1))), '{"Id": '],
        says: /holds no record at line 2/,
      },
      { lines: [JSON.stringify([accountId(1)])], says: /holds no record at line 1/ },
      {
        lines: [JSON.stringify({ ...rowOf(accountId(1)), Id: undefined })],
        says: /a record without its Id at line 1/,
      },
      {
        lines: [
          JSON.stringify(rowOf(accountId(1))),
          JSON.stringify({ ...rowOf(accountId(2)), SystemModstamp: null }),
        ],
        says: new RegExp(`record ${accountId(2)} without its SystemModstamp at line 2`),
      },
      {
        lines: [
          JSON.stringify(rowOf(accountId(1))),
          JSON.stringify(rowOf(accountId(2))),
          JSON.stringify(rowOf(accountId(1).slice(0, 15), { Name: 'again' })),
        ],
        says: new RegExp(`record ${accountId(1).slice(0, 15)} a second time at line 3`),
      },
    ];
    for (const { lines, says } of cases) {
      const folder = await folderOf();
      await valuesOf(folder).begin(SNAPSHOT, 'Account');
      await appendFile(snapshotFileOf(folder, SNAPSHOT, 'Account'), `${lines.join('\n')}\n`);

      const err = await rejection(writeSnapshotIndex(folder, SNAPSHOT, 'Account'));

      expect(err).toBeInstanceOf(CheckpointStoreError);
      expect((err as CheckpointStoreError).code).toBe('damaged');
      expect((err as Error).message).toMatch(says);
      expect(readdirSync(folder.indexDir)).toEqual([]);
    }
  });

  it('refuses to index an object whose snapshot is not on this machine', async () => {
    const folder = await folderOf();

    const err = await rejection(writeSnapshotIndex(folder, SNAPSHOT, 'Account'));

    expect(err).toBeInstanceOf(CheckpointStoreError);
    expect((err as Error).message).toMatch(/snapshot of Account is not on this machine/);
  });

  it('refuses an index that is not there, is not an index, is cut short or holds a record twice', async () => {
    const folder = await folderOf();
    const missing = await rejection(SnapshotIndex.read(folder, SNAPSHOT, 'Account'));
    expect(missing).toBeInstanceOf(CheckpointStoreError);
    expect((missing as Error).message).toMatch(/index of Account is not on this machine/);

    await snapshot(folder, [rowOf(accountId(1)), rowOf(accountId(2))]);
    await writeSnapshotIndex(folder, SNAPSHOT, 'Account');
    const file = indexFileOf(folder, 'Account');
    const good = readFileSync(file);
    const row = good.subarray(8, 8 + 35);
    const variants: Array<{ bytes: Buffer; says: RegExp }> = [
      {
        bytes: Buffer.concat([Buffer.from('NOTANIDX'), good.subarray(8)]),
        says: /is not an index/,
      },
      { bytes: good.subarray(0, good.length - 1), says: /is not an index/ },
      { bytes: Buffer.concat([good, row]), says: /holds record 001xx0000000001 twice/ },
      {
        bytes: Buffer.concat([good, Buffer.from(row).fill(0x21, 0, 1)]),
        says: /is damaged at row 3/,
      },
    ];
    for (const { bytes, says } of variants) {
      writeFileSync(file, bytes);
      const err = await rejection(SnapshotIndex.read(folder, SNAPSHOT, 'Account'));
      expect(err).toBeInstanceOf(CheckpointStoreError);
      expect((err as CheckpointStoreError).code).toBe('damaged');
      expect((err as Error).message).toMatch(says);
    }
  });
});

describe('SnapshotIndex.chunk', () => {
  /** Ten Accounts, some of whose values take more bytes than characters. */
  const tenRows = (): BackupRecord[] =>
    Array.from({ length: 10 }, (_, n) =>
      rowOf(accountId(n + 1), {
        Name: ['Café Œuvre', '日本支社', 'Plain', 'Ünïcödé 🚀', 'Ålesund'][n % 5],
        Description: 'é'.repeat(n * 7),
        NumberOfEmployees: n,
      }),
    );

  it('reads the rows of its ids alone, at their offsets, in the file’s order, a batch at a time, as often as it is gone through', async () => {
    const folder = await folderOf();
    const rows = tenRows();
    const index = await indexed(folder, rows);

    const ids = [
      accountId(8),
      accountId(3),
      accountId(3),
      accountId(42),
      accountId(10).slice(0, 15),
    ];
    const reader = index.chunk(ids);
    const batches = await reader.batches(SNAPSHOT, 'Account', 2);
    if (!batches) throw new Error('The chunk answered for no snapshot');
    const passes: BackupRecord[][][] = [];
    for (let pass = 0; pass < 2; pass++) {
      const got: BackupRecord[][] = [];
      for await (const batch of batches) got.push(batch);
      passes.push(got);
    }

    expect(passes[0]).toEqual([[rows[2], rows[7]], [rows[9]]]);
    expect(passes[1]).toEqual(passes[0]);
  });

  it('never reads a line of the snapshot outside its chunk', async () => {
    const folder = await folderOf();
    const rows = tenRows();
    const index = await indexed(folder, rows);
    // Lines 4 and 6 no longer hold a record: a read of the whole file fails
    // on them, a read of the chunk never reaches them.
    rewriteLines(folder, (lines) =>
      lines.map((line, at) => (at === 3 || at === 5 ? 'x'.repeat(Buffer.byteLength(line)) : line)),
    );
    const whole = await valuesOf(folder).batches(SNAPSHOT, 'Account', 200);
    const wholeRead = (async () => {
      let read = 0;
      for await (const batch of whole ?? []) read += batch.length;
      return read;
    })();
    expect(String(await rejection(wholeRead))).toMatch(/damaged at line 4/);

    expect(await batchesOf(index, [accountId(1), accountId(5), accountId(10)], 200)).toEqual([
      [rows[0], rows[4], rows[9]],
    ]);
  });

  it('answers for its own object of its own snapshot only', async () => {
    const folder = await folderOf();
    const index = await indexed(folder, tenRows());
    const reader = index.chunk([accountId(1)]);

    expect(await reader.batches('op-another', 'Account', 200)).toBeNull();
    expect(await reader.batches(SNAPSHOT, 'Contact', 200)).toBeNull();
    expect(await reader.batches(SNAPSHOT, 'Account', 200)).not.toBeNull();
  });

  it('reads 2,000 records at most, so that a give-back never holds an object whole', async () => {
    expect(SNAPSHOT_CHUNK_IDS).toBe(2_000);
    const folder = await folderOf();
    const index = await indexed(folder, tenRows());
    const ids = Array.from({ length: SNAPSHOT_CHUNK_IDS + 1 }, (_, n) => accountId(n));

    expect(() => index.chunk(ids)).toThrow(RangeError);
    expect(() => index.chunk(ids.slice(0, SNAPSHOT_CHUNK_IDS))).not.toThrow();
  });

  it('refuses a line that is no longer the record the index says, as it was read', async () => {
    const folder = await folderOf();
    // Lines of one length each, so that a line swapped for another, or a
    // stamp moved by a second, leaves every offset where it was.
    const rows = Array.from({ length: 4 }, (_, n) =>
      rowOf(accountId(n + 1), { Name: `Account ${n}` }),
    );
    const index = await indexed(folder, rows);

    rewriteLines(folder, (lines) => [lines[0], lines[2], lines[1], ...lines.slice(3)]);
    const swapped = await rejection(batchesOf(index, [accountId(2)], 200));
    expect(swapped).toBeInstanceOf(CheckpointStoreError);
    expect((swapped as Error).message).toMatch(
      new RegExp(`does not hold record ${accountId(2)} where its index says`),
    );

    rewriteLines(folder, (lines) => [lines[0], lines[2], lines[1], ...lines.slice(3)]);
    rewriteLines(folder, (lines) =>
      lines.map((line, at) => (at === 3 ? line.replace('14:05:12.000', '14:05:13.000') : line)),
    );
    expect(await batchesOf(index, [accountId(1), accountId(2), accountId(3)], 200)).toEqual([
      rows.slice(0, 3),
    ]);
    expect(await rejection(batchesOf(index, [accountId(4)], 200))).toBeInstanceOf(
      CheckpointStoreError,
    );
  });

  it('gives a chunk of records their snapshot values back through the restore a Sync run’s removal makes, and writes nothing over one that holds them', async () => {
    let clock = Date.parse('2026-10-22T14:00:00.000Z');
    const org = new MemoryRestoreOrg({}, { now: () => clock });
    org.add('Account', { Id: accountId(1), Name: 'Kept as it was' });
    org.add('Account', { Id: accountId(2), Name: 'At the checkpoint' });
    const folder = await folderOf();
    const page = await org.query('SELECT Id, SystemModstamp, Name FROM Account');
    const index = await indexed(folder, page.records as BackupRecord[]);
    clock += 60_000;
    org.edit('Account', accountId(2), { Name: 'Changed since' });

    const outcome = await restoreOverwrites({
      org,
      plan: [{ objectApiName: 'Account', backup: SNAPSHOT, ids: [accountId(1), accountId(2)] }],
      backups: index.chunk([accountId(1), accountId(2)]),
      includeChanged: true,
    });

    expect(outcome.objects[0]).toMatchObject({ planned: 2, restored: 2, notKept: 0, refused: 0 });
    expect(org.updates).toHaveLength(1);
    expect(org.updates[0].records).toHaveLength(1);
    expect(org.updates[0].records[0]).toMatchObject({
      Id: accountId(2),
      Name: 'At the checkpoint',
    });
    expect(org.all('Account').map((row) => row.Name)).toEqual([
      'Kept as it was',
      'At the checkpoint',
    ]);
  });

  it('writes nothing from a chunk whose snapshot no longer matches its index: its records are not kept, and the restore says why', async () => {
    let clock = Date.parse('2026-10-22T14:00:00.000Z');
    const org = new MemoryRestoreOrg({}, { now: () => clock });
    org.add('Account', { Id: accountId(1), Name: 'Account 1' });
    org.add('Account', { Id: accountId(2), Name: 'Account 2' });
    const folder = await folderOf();
    const page = await org.query('SELECT Id, SystemModstamp, Name FROM Account');
    const index = await indexed(folder, page.records as BackupRecord[]);
    clock += 60_000;
    org.edit('Account', accountId(1), { Name: 'Account X' });
    rewriteLines(folder, (lines) => [lines[1], lines[0], ...lines.slice(2)]);

    const outcome = await restoreOverwrites({
      org,
      plan: [{ objectApiName: 'Account', backup: SNAPSHOT, ids: [accountId(1), accountId(2)] }],
      backups: index.chunk([accountId(1), accountId(2)]),
      includeChanged: true,
    });

    expect(outcome.wrote).toBe(false);
    expect(org.updates).toEqual([]);
    expect(outcome.objects[0]).toMatchObject({ planned: 2, restored: 0, notKept: 2 });
    expect(outcome.objects[0].reasons.join(' ')).toMatch(
      /file changed since the checkpoint was taken/,
    );
  });
});

describe('records a rewind made again, under new Ids', () => {
  const [kept, made, parent] = [accountId(1), accountId(2), accountId(3)];
  const madeNow = accountId(92);
  const parentNow = accountId(93);

  it('holds a record made again by its Id now, its stamp and row the snapshot’s, and the Id it had no more', async () => {
    const folder = await folderOf();
    await indexed(folder, [
      rowOf(kept, { Name: 'Kept' }),
      rowOf(made, { Name: 'Made again', ParentId: parent }),
      rowOf(parent, { Name: 'Parent' }),
    ]);
    await Recreated.add(folder, [
      { objectApiName: 'Account', from: made, to: madeNow },
      { objectApiName: 'Account', from: parent, to: parentNow },
    ]);

    const index = await SnapshotIndex.read(folder, SNAPSHOT, 'Account');

    expect(index.size).toBe(3);
    expect(index.has(madeNow)).toBe(true);
    expect(index.has(madeNow.slice(0, 15))).toBe(true);
    expect(index.stampOf(madeNow)).toBe(STAMP_MS);
    expect(index.has(made)).toBe(false);
    expect(index.retired(made)).toBe(true);
    expect(index.retired(kept)).toBe(false);
    expect(index.retired(madeNow)).toBe(false);
    expect(index.idAt(index.rowOf(madeNow))).toBe(madeNow);
    expect(index.snapshotIdOf(madeNow)).toBe(made);
    // Read under its Id now, its lookup naming the new Id of the record it named.
    const [batch] = await batchesOf(index, [madeNow], 10);
    expect(batch).toEqual([
      { ...rowOf(made, { Name: 'Made again', ParentId: parentNow }), Id: madeNow },
    ]);
  });

  it('names a record made again twice by its latest Id', async () => {
    const folder = await folderOf();
    await indexed(folder, [rowOf(made)]);
    await Recreated.add(folder, [{ objectApiName: 'Account', from: made, to: madeNow }]);
    await Recreated.add(folder, [{ objectApiName: 'Account', from: made, to: parentNow }]);

    const index = await SnapshotIndex.read(folder, SNAPSHOT, 'Account');

    expect(index.has(parentNow)).toBe(true);
    expect(index.has(madeNow)).toBe(false);
    expect(index.idAt(0)).toBe(parentNow);
  });

  it('marks gone for good by its Id now: a record made again that the org holds is not gone', async () => {
    const folder = await folderOf();
    await indexed(folder, [rowOf(kept), rowOf(made)]);
    await Recreated.add(folder, [{ objectApiName: 'Account', from: made, to: madeNow }]);
    const index = await SnapshotIndex.read(folder, SNAPSHOT, 'Account');
    const gone = new GoneForGood(index);

    gone.mark(madeNow);

    expect([...gone.ids()]).toEqual([kept]);
  });

  it('keeps the pairs in a file of its owner’s alone, drops a last line a crash cut short, and refuses one that is no pair as damaged', async () => {
    const folder = await folderOf();
    await indexed(folder, [rowOf(made)]);
    await Recreated.add(folder, [{ objectApiName: 'Account', from: made, to: madeNow }]);
    const file = recreatedFileOf(folder);
    if (POSIX) expect(statSync(file).mode & 0o777).toBe(0o600);

    await appendFile(file, '{"objectApiName":"Account","from":"001');
    expect((await Recreated.read(folder)).currentOf(made.slice(0, 15))).toBe(madeNow);

    writeFileSync(file, 'not a pair\n');
    expect(await rejection(Recreated.read(folder))).toMatchObject({ code: 'damaged' });
  });

  it('reads none when no record was made again', async () => {
    const folder = await folderOf();
    const none = await Recreated.read(folder);

    expect(none.empty).toBe(true);
    expect(none.remapped(made)).toBe(made);
  });
});

describe('records the org answered are no longer in the recycle bin', () => {
  it('keeps them by key, every object together, in a file of its owner’s alone, and reads none when none was refused', async () => {
    const folder = await folderOf();
    expect([...(await NotInBin.read(folder)).keys()]).toEqual([]);

    await NotInBin.add(folder, 'ContentDocument', ['069xx0000000009AAA']);
    await NotInBin.add(folder, 'Account', [accountId(4), accountId(5)]);
    await NotInBin.add(folder, 'Account', []);

    const held = await NotInBin.read(folder);
    expect([...held.keys()]).toEqual([
      '069xx0000000009',
      accountId(4).slice(0, 15),
      accountId(5).slice(0, 15),
    ]);
    expect(held.has('069xx0000000009AAA')).toBe(true);
    expect(held.has(accountId(4).slice(0, 15))).toBe(true);
    expect(held.has(accountId(6))).toBe(false);
    if (POSIX) expect(statSync(notInBinFileOf(folder)).mode & 0o777).toBe(0o600);
  });

  it('leaves out a line a crash cut short, or one that names no record, and reads the others', async () => {
    const folder = await folderOf();
    await NotInBin.add(folder, 'Account', [accountId(4)]);
    const file = notInBinFileOf(folder);
    await appendFile(file, 'not a line\n{"objectApiName":"Account","id":"not an id"}\n');
    await appendFile(file, '{"objectApiName":"Account","id":"001');

    expect([...(await NotInBin.read(folder)).keys()]).toEqual([accountId(4).slice(0, 15)]);
  });
});

describe('GoneForGood', () => {
  it('names the records of the snapshot that neither the org’s live ids nor its recycle bin since hold, in the snapshot’s order', async () => {
    let clock = Date.parse('2026-10-22T09:00:00.000Z');
    const org = new MemoryRemovalOrg({}, { now: () => clock });
    for (let n = 1; n <= 5; n++) org.add('Account', { Id: accountId(n), Name: `Account ${n}` });
    const folder = await folderOf();
    const page = await org.query('SELECT Id, SystemModstamp, Name FROM Account');
    const index = await indexed(folder, page.records as BackupRecord[]);
    const t0 = orgStamp(clock);
    clock += 60_000;
    org.trash('Account', accountId(2));
    org.trash('Account', accountId(3));
    org.purge(accountId(3));
    org.trash('Account', accountId(5));
    org.purge(accountId(5));
    org.add('Account', { Id: accountId(6), Name: 'Made since' });

    const gone = new GoneForGood(index);
    const notHeld: string[] = [];
    const outcomes = await readStreams(
      compositeReader(org),
      [idScanRead('Account', 'query'), deletedRead('Account', t0)],
      (_, rows) => {
        for (const row of rows) if (!gone.mark(row.Id)) notHeld.push(String(row.Id));
      },
    );

    expect(outcomes.every((outcome) => outcome.read)).toBe(true);
    expect([...gone.ids()]).toEqual([accountId(3), accountId(5)]);
    expect(gone.count).toBe(2);
    expect(notHeld).toEqual([accountId(6)]);
  });

  it('counts a record once however often it is marked, and marks nothing the snapshot does not hold', async () => {
    const folder = await folderOf();
    const index = await indexed(folder, [
      rowOf(accountId(1)),
      rowOf(accountId(2)),
      rowOf(accountId(3)),
    ]);
    const gone = new GoneForGood(index);

    expect(gone.mark(accountId(2))).toBe(true);
    expect(gone.mark(accountId(2).slice(0, 15))).toBe(true);
    expect(gone.mark(accountId(9))).toBe(false);
    expect(gone.mark(undefined)).toBe(false);

    expect(gone.count).toBe(2);
    expect([...gone.ids()]).toEqual([accountId(1), accountId(3)]);
  });

  it('holds one bit a row: nine rows across two bytes, each found apart', async () => {
    const folder = await folderOf();
    const index = await indexed(
      folder,
      Array.from({ length: 9 }, (_, n) => rowOf(accountId(n))),
    );
    const gone = new GoneForGood(index);
    for (const n of [0, 7, 8]) gone.mark(accountId(n));

    expect([...gone.ids()]).toEqual([1, 2, 3, 4, 5, 6].map(accountId));
    expect(gone.count).toBe(6);
  });
});
