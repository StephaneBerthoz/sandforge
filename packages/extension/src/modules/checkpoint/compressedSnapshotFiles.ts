/**
 * The values of a checkpoint's snapshot, kept compressed on this machine.
 *
 * An object's file is a series of gzip members (RFC 1952 §2.2), each holding
 * whole lines of its NDJSON, {@link SNAPSHOT_MEMBER_BYTES} of them at most: a
 * line longer than that is a member of its own. The file stays a gzip file
 * any tool reads — `zcat` gives back the lines as the org's records were
 * read — and each member says in its own header how many bytes it takes and
 * how many its lines are, in a subfield `SF` of the header's extra field
 * (§2.3.1.1):
 *
 * ```
 * 1f 8b 08 04 <mtime> <xfl> <os> | 0c 00 | 'S' 'F' 08 00 | total u32 LE | raw u32 LE | deflate… | CRC32 | ISIZE
 * ```
 *
 * Read so, a file is gone through from header to header without inflating a
 * member, and a reader the index tells where a record's member starts
 * inflates that member alone. Each member carries the CRC32 of its lines: a
 * byte changed in a record's values is found, where the plain file told only
 * a changed id or stamp. The CRC and the length gzip ends a member with cover
 * its lines alone, so the header is rewritten without counting either again.
 *
 * Bounded so, a member costs about 0.4 ms to inflate and holds some ninety
 * records of a few hundred fields; larger blocks gain a tenth at most (65
 * bytes a synthetic row at 256 KiB, 70 at 64 KiB) and make a give-back of
 * scattered records inflate more to read each. BGZF, the same idea in
 * genomics, caps a member at 64 KiB compressed, which one record holding
 * long text areas outgrows.
 *
 * The take writes the files through the DataOps store as any backup is
 * written, page after page as the org answers, and these dependencies put
 * each page down compressed as it comes: the raw snapshot is never on disk,
 * not even one object of it. DataOps' own backups are written plain through
 * the store's own dependencies, and read as they always were.
 */

import { createReadStream } from 'node:fs';
import { appendFile, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import { createGunzip, gunzip, gzip } from 'node:zlib';
import type { BackupRecordStoreDeps } from '../dataops/BackupRecordStore.js';
import { CHECKPOINT_FILE_MODE } from './OrgCheckpointStore.js';

const gzipped = promisify(gzip);
const gunzipped = promisify(gunzip);

/** Bytes of lines a member holds at most: one longer line is a member of its own. */
export const SNAPSHOT_MEMBER_BYTES = 64 * 1024;

/** What a compressed file's name adds to the plain one's. */
const COMPRESSED_SUFFIX = '.gz';

/** The deflate level members are made with: zlib's default, the balance `gzip` itself keeps. */
const GZIP_LEVEL = 6;

/** The bytes of gzip's fixed header: magic, method, flags, time, extra flags, system. */
const GZIP_HEAD_BYTES = 10;
/** The flag of a header that carries an extra field. */
const FEXTRA = 0x04;
/** The two bytes that name the subfield, `SF`. */
const SUBFIELD_ID = Buffer.from('SF', 'latin1');
/** The bytes of the subfield's data: the member's length, then its lines'. */
const SUBFIELD_DATA_BYTES = 8;
/** The bytes of the extra field: its length, the subfield's id and length, its data. */
const EXTRA_BYTES = 2 + 2 + 2 + SUBFIELD_DATA_BYTES;

/** Bytes of a member's header, the `SF` subfield in it. */
export const MEMBER_HEAD_BYTES = GZIP_HEAD_BYTES + EXTRA_BYTES;

/**
 * Bytes a member takes at least: its header, the two bytes of an empty
 * deflate stream, and the CRC32 and length gzip ends it with.
 */
export const MEMBER_MIN_BYTES = MEMBER_HEAD_BYTES + 2 + 8;

/** The compressed file of a snapshot's plain one: `<snapshot>__<Object>.ndjson.gz`. */
export function compressedFileOf(file: string): string {
  return `${file}${COMPRESSED_SUFFIX}`;
}

// ─── A member ────────────────────────────────────────────────────────────────

/** What a member's `SF` subfield says of it. */
export interface MemberHead {
  /** Bytes the member takes in its file, its header among them. */
  total: number;
  /** Bytes of the lines it holds, inflated. */
  raw: number;
}

/**
 * Lines as one member: gzip's own, its header rewritten to carry the `SF`
 * subfield. Deflated on libuv's pool, off the thread the extension runs on.
 *
 * @throws When zlib made a header with flags of its own, which it never does.
 */
export async function snapshotMember(lines: Buffer): Promise<Buffer> {
  const deflated = await gzipped(lines, { level: GZIP_LEVEL });
  if (deflated[3] !== 0) throw new Error('zlib wrote a gzip header with flags set');
  const head = Buffer.from(deflated.subarray(0, GZIP_HEAD_BYTES));
  head[3] = FEXTRA;
  const extra = Buffer.alloc(EXTRA_BYTES);
  extra.writeUInt16LE(EXTRA_BYTES - 2, 0);
  SUBFIELD_ID.copy(extra, 2);
  extra.writeUInt16LE(SUBFIELD_DATA_BYTES, 4);
  extra.writeUInt32LE(deflated.length + EXTRA_BYTES, 6);
  extra.writeUInt32LE(lines.length, 10);
  return Buffer.concat([head, extra, deflated.subarray(GZIP_HEAD_BYTES)]);
}

/**
 * What the header at the start of `bytes` says of its member: undefined when
 * it is no header these files' members start with — another kind of gzip
 * header, or none.
 */
export function memberHeadOf(bytes: Buffer): MemberHead | undefined {
  if (bytes.length < MEMBER_HEAD_BYTES) return undefined;
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 8 || bytes[3] !== FEXTRA) {
    return undefined;
  }
  if (bytes.readUInt16LE(GZIP_HEAD_BYTES) !== EXTRA_BYTES - 2) return undefined;
  if (!bytes.subarray(GZIP_HEAD_BYTES + 2, GZIP_HEAD_BYTES + 4).equals(SUBFIELD_ID)) {
    return undefined;
  }
  if (bytes.readUInt16LE(GZIP_HEAD_BYTES + 4) !== SUBFIELD_DATA_BYTES) return undefined;
  const total = bytes.readUInt32LE(GZIP_HEAD_BYTES + 6);
  const raw = bytes.readUInt32LE(GZIP_HEAD_BYTES + 10);
  return total >= MEMBER_MIN_BYTES && raw > 0 ? { total, raw } : undefined;
}

/**
 * Bytes as blocks of whole lines, {@link SNAPSHOT_MEMBER_BYTES} at most each
 * but for a longer line, which is a block of its own; the last block holds
 * what follows the last line break, when something does.
 */
export function blocksOf(bytes: Buffer, most: number = SNAPSHOT_MEMBER_BYTES): Buffer[] {
  const blocks: Buffer[] = [];
  let start = 0;
  let end = 0;
  while (end < bytes.length) {
    const newline = bytes.indexOf(10, end);
    const next = newline < 0 ? bytes.length : newline + 1;
    if (next - start > most && end > start) {
      blocks.push(bytes.subarray(start, end));
      start = end;
    }
    end = next;
    if (end - start >= most) {
      blocks.push(bytes.subarray(start, end));
      start = end;
    }
  }
  if (end > start) blocks.push(bytes.subarray(start, end));
  return blocks;
}

/** Text as the members of its blocks, one after the other, as a file holds them. */
async function membersOfText(content: string): Promise<Buffer> {
  const blocks = blocksOf(Buffer.from(content, 'utf8'));
  return Buffer.concat(await Promise.all(blocks.map((block) => snapshotMember(block))));
}

// ─── Writing ─────────────────────────────────────────────────────────────────

/** Whether a path is one of the files the DataOps store writes an object's records to, one a line. */
function isLinesFile(filePath: string): boolean {
  return filePath.endsWith('.ndjson');
}

/**
 * The DataOps store's dependencies for a checkpoint's snapshot: the file of
 * an object's lines, `<snapshot>__<Object>.ndjson`, is kept as
 * `<snapshot>__<Object>.ndjson.gz`, each page the store adds put down as
 * members of whole lines as it comes; every other file goes through `plain`
 * as it would have.
 *
 * - `writeFile` makes the compressed file anew: empty, or the content's
 *   members;
 * - `appendFile` adds the page's members at its end;
 * - `exists` and `rm` answer for the compressed file;
 * - `readLines` gives its lines back, inflated as they are read, never the
 *   file whole.
 *
 * The additions to one file are made one after the other, in the order they
 * were asked: a page is deflated before it is written, and the next page,
 * deflated sooner, would otherwise land before it. One that fails fails the
 * ones asked after it, until the file is made anew: a file missing a page
 * takes no more.
 *
 * @param plain - What the store would go through for a backup:
 *   `nodeBackupFiles(<checkpoint's folder>)`.
 */
export function compressedSnapshotFiles(plain: BackupRecordStoreDeps): BackupRecordStoreDeps {
  const turns = new Map<string, Promise<void>>();
  const inTurn = (
    file: string,
    work: (previous: Promise<void>) => Promise<void>,
  ): Promise<void> => {
    const next = work(turns.get(file) ?? Promise.resolve());
    turns.set(file, next);
    void next.then(
      () => {
        if (turns.get(file) === next) turns.delete(file);
      },
      () => undefined,
    );
    return next;
  };
  return {
    ...plain,
    writeFile: (filePath, content) => {
      if (!isLinesFile(filePath)) return plain.writeFile(filePath, content);
      const file = compressedFileOf(filePath);
      return inTurn(file, (previous) =>
        previous
          .catch(() => undefined)
          .then(async () => {
            const members = content === '' ? Buffer.alloc(0) : await membersOfText(content);
            await writeFile(file, members, { mode: CHECKPOINT_FILE_MODE });
          }),
      );
    },
    appendFile: (filePath, content) => {
      if (!isLinesFile(filePath)) return plain.appendFile(filePath, content);
      const file = compressedFileOf(filePath);
      return inTurn(file, (previous) =>
        previous.then(async () => {
          if (content === '') return;
          await appendFile(file, await membersOfText(content), { mode: CHECKPOINT_FILE_MODE });
        }),
      );
    },
    exists: (filePath) =>
      plain.exists(isLinesFile(filePath) ? compressedFileOf(filePath) : filePath),
    rm: (filePath) => plain.rm(isLinesFile(filePath) ? compressedFileOf(filePath) : filePath),
    readLines: (filePath) =>
      isLinesFile(filePath) ? inflatedLines(compressedFileOf(filePath)) : plain.readLines(filePath),
  };
}

/**
 * The lines of a compressed file, inflated as they are read; none for an
 * empty file, which holds no member to inflate (and which zlib refuses).
 */
async function* inflatedLines(file: string): AsyncGenerator<string> {
  if ((await stat(file)).size === 0) return;
  const source = createReadStream(file);
  const inflate = createGunzip();
  const onSourceError = (err: Error): void => {
    inflate.destroy(err);
  };
  source.on('error', onSourceError);
  source.pipe(inflate);
  const decoder = new StringDecoder('utf8');
  let rest = '';
  try {
    for await (const chunk of inflate as AsyncIterable<Buffer>) {
      const lines = (rest + decoder.write(chunk)).split('\n');
      rest = lines.pop() ?? '';
      yield* lines;
    }
    rest += decoder.end();
    if (rest !== '') yield rest;
  } finally {
    source.off('error', onSourceError);
    source.destroy();
    inflate.destroy();
  }
}

// ─── Reading ─────────────────────────────────────────────────────────────────

/** An error that says how a snapshot's file is damaged, `why` naming what was found. */
export type Damaged = (why: string) => Error;

/** A member of a file, read and inflated: where it starts, the bytes it takes, its lines. */
export interface ReadMember {
  at: number;
  total: number;
  lines: Buffer;
}

/** Bytes `length` of an open file from `at`; fewer only where the file ends first. */
async function readAt(handle: FileHandle, at: number, length: number): Promise<Buffer> {
  const bytes = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const { bytesRead } = await handle.read(bytes, got, length - got, at + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return got === length ? bytes : bytes.subarray(0, got);
}

/**
 * The lines of a member, inflated: as many bytes as its header says, the
 * CRC32 and length gzip ends it with checked by zlib.
 *
 * @throws What `damaged` makes, when it does not inflate or holds other than its header says.
 */
async function inflateMember(
  bytes: Buffer,
  head: MemberHead,
  at: number,
  damaged: Damaged,
): Promise<Buffer> {
  let lines: Buffer;
  try {
    lines = await gunzipped(bytes, { maxOutputLength: head.raw });
  } catch {
    throw damaged(`holds a block that does not inflate at byte ${at}`);
  }
  if (lines.length !== head.raw) {
    throw damaged(`holds a block at byte ${at} that inflates to other than its header says`);
  }
  return lines;
}

/**
 * The member an index says starts at byte `at` of an open file and takes
 * `total` bytes, read and inflated: its header must say it is that member.
 *
 * @throws What `damaged` makes, when the file is cut short there, holds no
 *   member there or another, or the member does not inflate.
 */
export async function readMember(
  handle: FileHandle,
  at: number,
  total: number,
  damaged: Damaged,
): Promise<Buffer> {
  const bytes = await readAt(handle, at, total);
  if (bytes.length < total) throw damaged(`is cut short at byte ${at + bytes.length}`);
  const head = memberHeadOf(bytes);
  if (head === undefined) throw damaged(`holds no block where its index says, at byte ${at}`);
  if (head.total !== total) {
    throw damaged(`holds another block than its index says at byte ${at}`);
  }
  return inflateMember(bytes, head, at, damaged);
}

/**
 * Every member of an open file of `size` bytes, in its order, each read and
 * inflated alone: found from header to header, each `SF` subfield saying
 * where the next one starts. Their lengths must add up to the file's.
 *
 * @throws What `damaged` makes, when a member's header is not one, a member
 *   ends past the file's end, or a member does not inflate.
 */
export async function* membersOf(
  handle: FileHandle,
  size: number,
  damaged: Damaged,
): AsyncGenerator<ReadMember> {
  for (let at = 0; at < size;) {
    const head = memberHeadOf(await readAt(handle, at, Math.min(MEMBER_HEAD_BYTES, size - at)));
    if (head === undefined) throw damaged(`holds no block at byte ${at}`);
    if (head.total > size - at) {
      throw damaged(`is cut short: its block at byte ${at} ends past the file's end`);
    }
    const bytes = await readAt(handle, at, head.total);
    yield { at, total: head.total, lines: await inflateMember(bytes, head, at, damaged) };
    at += head.total;
  }
}

/** A line of a block: where it starts in the block, and its bytes without its line break. */
export interface BlockLine {
  at: number;
  length: number;
}

/** Every line of a block, an empty one among them, each where it starts. */
export function* linesIn(block: Buffer): Generator<BlockLine> {
  let start = 0;
  while (start < block.length) {
    const newline = block.indexOf(10, start);
    const end = newline < 0 ? block.length : newline;
    yield { at: start, length: end - start };
    start = end + 1;
  }
}
