import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  BackupRecordStore,
  nodeBackupFiles,
  type BackupRecord,
} from '../dataops/BackupRecordStore.js';
import {
  MEMBER_HEAD_BYTES,
  SNAPSHOT_MEMBER_BYTES,
  blocksOf,
  compressedFileOf,
  compressedSnapshotFiles,
  linesIn,
  memberHeadOf,
  membersOf,
  readMember,
  snapshotMember,
  type Damaged,
} from './compressedSnapshotFiles.js';

const POSIX = process.platform !== 'win32';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A folder of its own, as a checkpoint's is. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-compressed-'));
  made.push(dir);
  return dir;
}

/** The DataOps store over a folder, its files compressed as a take writes a snapshot. */
function storeIn(dir: string): BackupRecordStore {
  return new BackupRecordStore(compressedSnapshotFiles(nodeBackupFiles(dir)));
}

/** The file the store keeps an object of an operation in, compressed. */
const fileOf = (dir: string, object = 'Contact'): string =>
  compressedFileOf(join(dir, 'backups', `op-1__${object}.ndjson`));

/** A Contact's row as the org answers it, with a value of `size` characters. */
function contactOf(n: number, size = 40): BackupRecord {
  return {
    attributes: { type: 'Contact', url: `/services/data/v66.0/sobjects/Contact/003xx${n}` },
    Id: `003xx${String(n).padStart(13, '0')}`,
    SystemModstamp: '2026-10-22T14:05:12.000+0000',
    LastName: `Contact ${n}`,
    Description: 'é—ü'.repeat(Math.ceil(size / 3)).slice(0, size),
  };
}

/** The lines the store writes for `rows`, one record to a line. */
const ndjsonOf = (rows: readonly BackupRecord[]): string =>
  rows.map((row) => `${JSON.stringify(row)}\n`).join('');

/** The members of a file as its headers chain them, without inflating any. */
function headsOf(bytes: Buffer): Array<{ at: number; total: number; raw: number }> {
  const heads: Array<{ at: number; total: number; raw: number }> = [];
  for (let at = 0; at < bytes.length;) {
    const head = memberHeadOf(bytes.subarray(at));
    if (!head) throw new Error(`no member at ${at}`);
    heads.push({ at, ...head });
    at += head.total;
  }
  return heads;
}

const damaged: Damaged = (why) => new Error(`damaged: ${why}`);

describe('a member', () => {
  it('is gzip’s own with an SF subfield in its header that says its length and its lines’, which gzip and any reader of it skip', async () => {
    const lines = Buffer.from('{"Id":"a"}\n{"Id":"b"}\n');

    const member = await snapshotMember(lines);

    expect(member.subarray(0, 4)).toEqual(Buffer.from([0x1f, 0x8b, 8, 0x04]));
    expect(member.readUInt16LE(10)).toBe(12);
    expect(member.toString('latin1', 12, 14)).toBe('SF');
    expect(member.readUInt16LE(14)).toBe(8);
    expect(memberHeadOf(member)).toEqual({ total: member.length, raw: lines.length });
    expect(gunzipSync(member)).toEqual(lines);
    // The deflated stream and its trailer are gzip's, untouched: the CRC and
    // the length it ends with cover the lines alone.
    const plain = gzipSync(lines);
    expect(member.subarray(MEMBER_HEAD_BYTES)).toEqual(plain.subarray(10));
  });

  it('is not taken for one of its members when its header carries no SF subfield, or another', () => {
    const lines = Buffer.from('{"Id":"a"}\n');
    const plain = gzipSync(lines);
    const other = Buffer.from(plain);

    expect(memberHeadOf(plain)).toBeUndefined();
    expect(memberHeadOf(Buffer.alloc(0))).toBeUndefined();
    other[3] = 0x04;
    expect(memberHeadOf(other)).toBeUndefined();
  });

  it('splits lines into blocks of 64 KiB at most at their line breaks, a longer line in a block of its own', () => {
    const line = (n: number, size: number): string => `${String(n).padEnd(size - 1, 'x')}\n`;
    const short = Array.from({ length: 300 }, (_, n) => line(n, 500)).join('');
    const long = line(9, SNAPSHOT_MEMBER_BYTES * 3);
    const bytes = Buffer.from(short + long + short + 'last line, no break');

    const blocks = blocksOf(bytes);

    expect(Buffer.concat(blocks)).toEqual(bytes);
    for (const block of blocks) {
      const lines = [...linesIn(block)];
      expect(block.length <= SNAPSHOT_MEMBER_BYTES || lines.length === 1).toBe(true);
      expect(block[block.length - 1] === 10 || block.toString().endsWith('no break')).toBe(true);
    }
    expect(blocks.filter((block) => block.length > SNAPSHOT_MEMBER_BYTES)).toEqual([
      Buffer.from(long),
    ]);
    // 131 lines of 500 bytes fill a block of 65,500: the next one does not fit.
    expect(blocks[0].length).toBe(131 * 500);
  });
});

describe('compressedSnapshotFiles', () => {
  it('writes an object’s lines as a gzip file any tool inflates, members of whole lines chained by their headers to the file’s end', async () => {
    const dir = scratch();
    const store = storeIn(dir);
    const rows = Array.from({ length: 2_500 }, (_, n) => contactOf(n, n % 7 === 0 ? 400 : 40));

    await store.begin('op-1', 'Contact');
    for (let at = 0; at < rows.length; at += 1_000) {
      await store.append('op-1', 'Contact', rows.slice(at, at + 1_000));
    }

    const bytes = readFileSync(fileOf(dir));
    expect(gunzipSync(bytes).toString('utf8')).toBe(ndjsonOf(rows));
    const heads = headsOf(bytes);
    expect(heads.length).toBeGreaterThan(3);
    expect(heads.reduce((sum, head) => sum + head.total, 0)).toBe(bytes.length);
    for (const head of heads) {
      const member = bytes.subarray(head.at, head.at + head.total);
      const lines = gunzipSync(member);
      expect(lines.length).toBe(head.raw);
      expect(lines.length).toBeLessThanOrEqual(SNAPSHOT_MEMBER_BYTES);
      expect(lines[lines.length - 1]).toBe(10);
    }
    // No plain file was ever written beside it.
    expect(readdirSync(join(dir, 'backups'))).toEqual(['op-1__Contact.ndjson.gz']);
    if (POSIX) expect(statSync(fileOf(dir)).mode & 0o777).toBe(0o600);
    // Far smaller than the lines it holds.
    expect(bytes.length).toBeLessThan(Buffer.byteLength(ndjsonOf(rows)) / 4);
  });

  it('makes an empty file for an object begun and never added to, which holds no member to inflate', async () => {
    const dir = scratch();
    const store = storeIn(dir);

    await store.begin('op-1', 'Contact');

    expect(statSync(fileOf(dir)).size).toBe(0);
    const handle = await open(fileOf(dir), 'r');
    try {
      const members = [];
      for await (const member of membersOf(handle, 0, damaged)) members.push(member);
      expect(members).toEqual([]);
    } finally {
      await handle.close();
    }
    const read = await store.batches('op-1', 'Contact', 10);
    const batches = [];
    for await (const batch of read ?? []) batches.push(batch);
    expect(batches).toEqual([]);
  });

  it('adds the pages asked together in the order they were asked, whichever deflates first', async () => {
    const dir = scratch();
    const files = compressedSnapshotFiles(nodeBackupFiles(dir));
    const file = join(dir, 'op-1__Contact.ndjson');
    const big = ndjsonOf(Array.from({ length: 800 }, (_, n) => contactOf(n, 600)));
    const small = ndjsonOf([contactOf(900)]);

    await files.writeFile(file, '');
    await Promise.all([files.appendFile(file, big), files.appendFile(file, small)]);

    expect(gunzipSync(readFileSync(compressedFileOf(file))).toString('utf8')).toBe(big + small);
  });

  it('refuses to add to a file once one of its pages failed, until it is made anew', async () => {
    const dir = scratch();
    const files = compressedSnapshotFiles(nodeBackupFiles(dir));
    // Its folder is not there: the first page cannot be written.
    const file = join(dir, 'missing', 'op-1__Contact.ndjson');

    await expect(files.appendFile(file, ndjsonOf([contactOf(1)]))).rejects.toThrow();
    // The folder is there now, but the file has lost a page.
    await files.mkdir(join(dir, 'missing'));
    await expect(files.appendFile(file, ndjsonOf([contactOf(2)]))).rejects.toThrow();

    await files.writeFile(file, '');
    await files.appendFile(file, ndjsonOf([contactOf(3)]));
    expect(gunzipSync(readFileSync(compressedFileOf(file))).toString('utf8')).toBe(
      ndjsonOf([contactOf(3)]),
    );
  });

  it('answers for the compressed file when the store asks whether its lines are there, removes it, and reads its lines back inflated', async () => {
    const dir = scratch();
    const store = storeIn(dir);
    const rows = Array.from({ length: 300 }, (_, n) => contactOf(n, 300));

    expect(await store.batches('op-1', 'Contact', 100)).toBeNull();
    await store.begin('op-1', 'Contact');
    await store.append('op-1', 'Contact', rows);

    const read = await store.batches('op-1', 'Contact', 100);
    const got: BackupRecord[] = [];
    for await (const batch of read ?? []) got.push(...batch);
    expect(got).toEqual(rows);

    await store.delete('op-1', 'Contact');
    expect(readdirSync(join(dir, 'backups'))).toEqual([]);
    expect(await store.batches('op-1', 'Contact', 100)).toBeNull();
  });

  it('leaves every other file to the plain dependencies, as a backup writes it', async () => {
    const dir = scratch();
    const files = compressedSnapshotFiles(nodeBackupFiles(dir));
    const file = join(dir, 'op-1__Contact.json');

    await files.writeFile(file, '[{"Id":"a"}]');

    expect(readFileSync(file, 'utf8')).toBe('[{"Id":"a"}]');
    expect(await files.exists(file)).toBe(true);
    await files.rm(file);
    expect(await files.exists(file)).toBe(false);
  });
});

describe('reading members', () => {
  /** A file of members of `rows`, a page at a time, as the store writes one; its bytes. */
  async function written(dir: string, rows: readonly BackupRecord[]): Promise<Buffer> {
    const store = storeIn(dir);
    await store.begin('op-1', 'Contact');
    for (let at = 0; at < rows.length; at += 400) {
      await store.append('op-1', 'Contact', rows.slice(at, at + 400));
    }
    return readFileSync(fileOf(dir));
  }

  it('goes through a file from header to header, each member inflated alone, and reads one where its header says', async () => {
    const dir = scratch();
    const rows = Array.from({ length: 1_200 }, (_, n) => contactOf(n, 200));
    const bytes = await written(dir, rows);
    const handle = await open(fileOf(dir), 'r');
    try {
      const found = [];
      for await (const member of membersOf(handle, bytes.length, damaged)) found.push(member);
      expect(found.map(({ at, total }) => ({ at, total }))).toEqual(
        headsOf(bytes).map(({ at, total }) => ({ at, total })),
      );
      expect(Buffer.concat(found.map((member) => member.lines)).toString()).toBe(ndjsonOf(rows));

      const third = found[2];
      expect(await readMember(handle, third.at, third.total, damaged)).toEqual(third.lines);
    } finally {
      await handle.close();
    }
  });

  it('refuses a member cut short, one another member’s header names, one a byte of which changed, and a file that ends inside a member', async () => {
    const dir = scratch();
    const bytes = await written(
      dir,
      Array.from({ length: 1_200 }, (_, n) => contactOf(n, 200)),
    );
    const [first, second] = headsOf(bytes);
    const flipped = Buffer.from(bytes);
    flipped[second.at + MEMBER_HEAD_BYTES + 40] ^= 0x10;
    const file = fileOf(dir);

    const handle = await open(file, 'r');
    try {
      await expect(readMember(handle, first.at, first.total + 1, damaged)).rejects.toThrow(
        /holds another block than its index says at byte 0/,
      );
      await expect(readMember(handle, second.at + 1, second.total, damaged)).rejects.toThrow(
        /holds no block where its index says/,
      );
      await expect(readMember(handle, bytes.length - 10, 40, damaged)).rejects.toThrow(
        /is cut short/,
      );
    } finally {
      await handle.close();
    }

    writeFileSync(file, flipped);
    const changed = await open(file, 'r');
    try {
      await expect(readMember(changed, second.at, second.total, damaged)).rejects.toThrow(
        /holds a block that does not inflate at byte/,
      );
    } finally {
      await changed.close();
    }

    writeFileSync(file, bytes.subarray(0, bytes.length - 5));
    const cut = await open(file, 'r');
    try {
      await expect(async () => {
        for await (const member of membersOf(cut, bytes.length - 5, damaged)) void member;
      }).rejects.toThrow(/is cut short: its block at byte \d+ ends past the file's end/);
    } finally {
      await cut.close();
    }
  });
});
