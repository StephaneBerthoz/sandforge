/**
 * A checkpoint as a file that leaves this machine, `.sfcheckpoint`, for a
 * teammate who rewinds the same shared org from theirs — a team's sandbox, a
 * training org, a CI org — and that file kept again as a checkpoint on their
 * machine.
 *
 * The file is never unencrypted: it holds the records' values as the org held
 * them, personal data among them, and it travels, by mail, a drive or a chat,
 * where "readable by its owner alone" no longer holds. Its first line is a
 * header left unencrypted (`CheckpointArchiveHeader`): what it holds, the org it is
 * of and the formats that made it, so that an import into another org, into a
 * production org, or by a user who could not see what it holds, is refused
 * before a key is asked or a byte decrypted. It names neither the checkpoint,
 * whose name may carry a client's, nor a user, nor an alias. Then the blocks,
 * each encrypted with AES-256-GCM:
 *
 * ```
 * {"format":"sandforge-checkpoint",…}\n | block 0 | block 1 | … | block n, the last
 * block i: chunkBytes bytes of ciphertext, fewer in the last | its 16-byte tag
 * ```
 *
 * The blocks are the STREAM construction (Hoang, Reyhanitabar, Rogaway and
 * Vizár, 2015): each block's nonce is the file's random prefix then the
 * block's index, and each block authenticates the sha256 of the header, its
 * index and whether it is the last. A byte changed anywhere, a block removed,
 * put in another place or cut off at the end, and a header changed, refuse
 * the file at the block they reach: a file cut after a whole block ends on a
 * block that was not encrypted as the last.
 *
 * Decrypted and inflated (gzip, one stream), the blocks hold the checkpoint's
 * files one after the other, each a line naming its path, its bytes and its
 * sha256, then its bytes as they are on disk — a compressed snapshot stays
 * the members it is, inflated by no one — and a last line counting them:
 *
 * ```
 * {"path":"backups/…__Account.ndjson.gz","bytes":5120,"sha256":"…"}\n <its 5120 bytes>
 * …
 * {"end":true,"files":12}\n
 * ```
 *
 * The files are those the store lists (`exportedFilesOf`), the paths an
 * import writes back those it allows: never an object's index, which the
 * import makes again from the values and holds to what the checkpoint counts,
 * as a take does; never a preview's reads nor a rewind's journal, whose Undo
 * stays with the machine that rewound. `checkpoint.json` leaves without what
 * is this machine's alone — the alias the org has here, where the take ran,
 * the last rewind, how long it is kept and what it takes here — which the
 * import sets for its own.
 *
 * The key is drawn at random, 256 bits shown once as 52 letters and digits in
 * groups of four, and kept nowhere: a phrase a person chooses is weak against
 * a file anyone may copy, and a key drawn so needs no stretching. Each file's
 * block key is drawn from it by HKDF-SHA256 over the file's own random salt,
 * so one key given to many exports — a CI step's, from its secrets — still
 * encrypts each under another, and no nonce is used twice under one block
 * key. A check value drawn the same way tells a wrong key before a block is
 * read.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  type Hash,
} from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, rename, rm, statfs, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import * as z from 'zod';
import {
  checkpointArchiveHeaderSchema,
  checkpointArchiveVersionsSchema,
  orgCheckpointSchema,
  type CheckpointArchiveHeader,
  type CheckpointRefusal,
  type CheckpointTakenOn,
  type OrgCheckpoint,
} from '@sandforge/shared';
import {
  CHECKPOINT_FILE_MODE,
  CHECKPOINT_FILE_PATH,
  CheckpointStoreError,
  expiresAtFor,
  exportedFileIn,
  exportedFilesOf,
  isExportedPath,
  makePrivateDir,
  organizationKey,
  readFieldPrints,
  type CheckpointFolder,
  type ExportedFile,
  type OrgCheckpointStore,
} from './OrgCheckpointStore.js';
import { snapshotIndexBytes, writeSnapshotIndex } from './snapshotIndex.js';

// ─── Figures ─────────────────────────────────────────────────────────────────

/** What the file of an exported checkpoint is named with. */
export const ARCHIVE_EXTENSION = '.sfcheckpoint';

/**
 * Bytes of compressed entries a block holds, the last one fewer: a block is
 * held whole in memory as it is encrypted or decrypted, and each costs 16
 * bytes of tag, so a mebibyte keeps both small.
 */
export const ARCHIVE_CHUNK_BYTES = 1024 * 1024;

/** The formats of `checkpoint.json` this SandForge imports: its own, and the older ones it reads. */
const CHECKPOINT_FORMATS_READ: ReadonlySet<number> = new Set([1]);

/** The layouts of the file itself this SandForge reads. */
const FORMAT_VERSIONS_READ: ReadonlySet<number> = new Set([1]);

/** Bytes of the key a person is given. */
const KEY_BYTES = 32;

/** Bytes of GCM's tag, which ends each block. */
const TAG_BYTES = 16;

/** Bytes a header takes at most, its line break among them: it says a few numbers and names. */
const HEADER_MAX_BYTES = 4096;

/** Bytes the line of an entry takes at most: a path the store allows is short. */
const ENTRY_LINE_MAX_BYTES = 1024;

/**
 * Bytes `checkpoint.json` takes at most, which an import reads whole before it
 * writes it again: ten thousand objects of hundreds of fields each.
 */
const CHECKPOINT_FILE_MAX_BYTES = 64 * 1024 * 1024;

/** The most blocks a file holds: their index is four bytes of the nonce. */
const MAX_BLOCKS = 2 ** 32;

/** What each key drawn from a person's key is for: distinct, so neither tells the other. */
const BLOCK_KEY_INFO = 'sandforge-checkpoint/1 block key';
const KEY_CHECK_INFO = 'sandforge-checkpoint/1 key check';

/** The letters and digits a key is shown in: RFC 4648's base32, which has no 0, 1, 8 or 9 to misread. */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Letters a key is shown in: 256 bits, five a letter. */
const KEY_LETTERS = Math.ceil((KEY_BYTES * 8) / 5);

/** The org's own words: that nothing came onto this machine. */
const NOTHING_IMPORTED = 'Nothing was imported.';

// ─── The key ─────────────────────────────────────────────────────────────────

/** A new key for an export: 256 random bits, shown once and kept nowhere. */
export function newArchiveKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** A key as a person is shown it: 52 letters and digits, in groups of four. */
export function archiveKeyText(key: Buffer): string {
  if (key.length !== KEY_BYTES) throw new RangeError('Not a key of a checkpoint file');
  let letters = '';
  let value = 0;
  let bits = 0;
  for (const byte of key) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      letters += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) letters += BASE32[(value << (5 - bits)) & 31];
  return (letters.match(/.{1,4}/g) ?? []).join('-');
}

/**
 * A key as a person gives it back, its groups and their dashes or spaces as
 * shown or not, its letters of either case; undefined for anything else.
 */
export function parseArchiveKey(text: string): Buffer | undefined {
  const letters = text.replace(/[\s-]/g, '').toUpperCase();
  if (letters.length !== KEY_LETTERS || !/^[A-Z2-7]+$/.test(letters)) return undefined;
  const key = Buffer.alloc(KEY_BYTES);
  let value = 0;
  let bits = 0;
  let at = 0;
  for (const letter of letters) {
    value = ((value << 5) | BASE32.indexOf(letter)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      key[at++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  // The last letter's spare bits are none of the key's: set, they are a letter mistyped.
  if ((value & ((1 << bits) - 1)) !== 0) return undefined;
  return key;
}

/** A key drawn from the person's key and the file's salt, for one purpose. */
function drawn(key: Buffer, salt: Buffer, info: string, bytes: number): Buffer {
  return Buffer.from(hkdfSync('sha256', key, salt, info, bytes));
}

// ─── The blocks ──────────────────────────────────────────────────────────────

/** The nonce of block `index`: the file's prefix, then the index. */
function nonceOf(prefix: Buffer, index: number): Buffer {
  const nonce = Buffer.alloc(12);
  prefix.copy(nonce, 0);
  nonce.writeUInt32BE(index, 8);
  return nonce;
}

/** What block `index` authenticates beside its bytes: the header, where it is, and whether it ends the file. */
function associatedOf(headerHash: Buffer, index: number, last: boolean): Buffer {
  const data = Buffer.alloc(32 + 4 + 1);
  headerHash.copy(data, 0);
  data.writeUInt32BE(index, 32);
  data[36] = last ? 1 : 0;
  return data;
}

/** How a file's blocks are sealed and opened: its block key, its prefix, its header's hash. */
interface BlockKeys {
  blockKey: Buffer;
  prefix: Buffer;
  headerHash: Buffer;
}

/** Block `index` encrypted: its ciphertext, then its tag. */
function sealed(keys: BlockKeys, index: number, last: boolean, plain: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-gcm', keys.blockKey, nonceOf(keys.prefix, index), {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(associatedOf(keys.headerHash, index, last));
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

/**
 * Block `index` decrypted, once its tag says it is the block sealed there,
 * in that place, last or not, under that header; undefined when it does not.
 */
function opened(keys: BlockKeys, index: number, last: boolean, block: Buffer): Buffer | undefined {
  const decipher = createDecipheriv('aes-256-gcm', keys.blockKey, nonceOf(keys.prefix, index), {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(associatedOf(keys.headerHash, index, last));
  decipher.setAuthTag(block.subarray(block.length - TAG_BYTES));
  try {
    const plain = decipher.update(block.subarray(0, block.length - TAG_BYTES));
    // The tag is checked here: until it is, the bytes above are no one's.
    return Buffer.concat([plain, decipher.final()]);
  } catch {
    return undefined;
  }
}

// ─── Refusals ────────────────────────────────────────────────────────────────

/** A refusal of an import, said once the file or its key showed why: nothing is kept. */
class ImportRefused extends Error {
  constructor(readonly refusal: CheckpointRefusal) {
    super(refusal.message);
    this.name = 'ImportRefused';
  }
}

/** The refusal of a file changed or damaged since it was exported, `why` saying what was found. */
function damaged(why: string): ImportRefused {
  return new ImportRefused({
    code: 'IMPORT_DAMAGED',
    message: `This checkpoint file ${why}: it was changed or damaged after it was exported. ${NOTHING_IMPORTED}`,
  });
}

/** An export that could not be written, its words said as they are. */
export class CheckpointExportError extends Error {
  constructor(
    readonly code: 'EXPORT_EXISTS' | 'EXPORT_CHANGED',
    message: string,
  ) {
    super(message);
    this.name = 'CheckpointExportError';
  }
}

// ─── Exporting ───────────────────────────────────────────────────────────────

/**
 * `checkpoint.json` as it leaves the machine: without the alias the org has
 * here, where the take ran, the last rewind, how long it is kept, what it
 * takes here and where it came from, all of which the import sets.
 */
export function portableCheckpointOf(checkpoint: OrgCheckpoint): Record<string, unknown> {
  return {
    ...withoutKeys(checkpoint, MACHINE_KEYS),
    org: withoutKeys(checkpoint.org, ORG_MACHINE_KEYS),
  };
}

/** What `checkpoint.json` holds of this machine alone, which neither leaves it nor comes in. */
const MACHINE_KEYS: readonly string[] = [
  'lastRewind',
  'takenOn',
  'expiresAt',
  'bytes',
  'importedFrom',
];

/** What it holds of the org that is this machine's alone: the alias it has here. */
const ORG_MACHINE_KEYS: readonly string[] = ['alias'];

/** An object's own keys and values, but those named. */
function withoutKeys(value: object, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

/** A file an export carries, with what its line says of it. */
interface Entry {
  path: string;
  bytes: number;
  sha256: string;
  /** Its bytes, when held: `checkpoint.json`. */
  content?: Buffer;
  /** Where it is, when read from the disk. */
  file?: string;
}

/** The first `bytes` bytes of a file, read as they are, a piece at a time; none for an empty one. */
async function* bytesOf(file: string, bytes: number): AsyncGenerator<Buffer> {
  if (bytes === 0) return;
  let read = 0;
  for await (const chunk of createReadStream(file, { start: 0, end: bytes - 1 })) {
    const piece = chunk as Buffer;
    read += piece.length;
    yield piece;
  }
  if (read !== bytes) {
    throw new CheckpointExportError(
      'EXPORT_CHANGED',
      `${basename(file)} of the checkpoint shrank while it was exported: export it again.`,
    );
  }
}

/** The sha256 of the first `bytes` bytes of a file. */
async function sha256Of(file: string, bytes: number): Promise<string> {
  const hash = createHash('sha256');
  for await (const piece of bytesOf(file, bytes)) hash.update(piece);
  return hash.digest('hex');
}

/** What an export is asked. */
export interface ArchiveExportRequest {
  folder: CheckpointFolder;
  /** What its `checkpoint.json` holds: read and checked, ready. */
  checkpoint: OrgCheckpoint;
  /** Where the file is written; refused when something is there already. */
  out: string;
  key: Buffer;
  /** This SandForge's version, as its package names it. */
  sandforgeVersion: string;
  /** Bytes of compressed entries a block holds: {@link ARCHIVE_CHUNK_BYTES} unless a test asks for fewer. */
  chunkBytes?: number;
}

/** What an export wrote. */
export interface ArchiveExported {
  header: CheckpointArchiveHeader;
  /** Bytes of the file written. */
  bytes: number;
  /** Its sha256, hex: what the import records it came from. */
  sha256: string;
}

/**
 * Write a checkpoint of this machine into a `.sfcheckpoint` file, encrypted
 * under `key`. The org is not contacted. The file is written beside `out`,
 * its owner's alone, flushed, then renamed to it: an export stopped part way
 * leaves no file under that name.
 *
 * Each file of the checkpoint is read twice, once for its sha256 and once
 * for its bytes, as far as it was long when listed: the values never change
 * once taken, and the lines a rewind adds to the records it made again come
 * after those carried. One that changed between the two reads fails the
 * export.
 *
 * @throws {CheckpointExportError} `EXPORT_EXISTS`, when something is at
 *   `out`; `EXPORT_CHANGED`, when a file of the checkpoint changed as it was
 *   read.
 */
export async function exportCheckpointArchive(
  request: ArchiveExportRequest,
): Promise<ArchiveExported> {
  const { folder, checkpoint, out, key } = request;
  const chunkBytes = request.chunkBytes ?? ARCHIVE_CHUNK_BYTES;
  if (await lstat(out).catch(() => undefined)) {
    throw new CheckpointExportError(
      'EXPORT_EXISTS',
      `${out} is there already: name another file, or move that one away first.`,
    );
  }
  const portable = Buffer.from(`${JSON.stringify(portableCheckpointOf(checkpoint))}\n`, 'utf8');
  const entries: Entry[] = [
    {
      path: CHECKPOINT_FILE_PATH,
      bytes: portable.length,
      sha256: createHash('sha256').update(portable).digest('hex'),
      content: portable,
    },
  ];
  for (const listed of await exportedFilesOf(folder)) {
    if (listed.path === CHECKPOINT_FILE_PATH) continue;
    entries.push({ ...listed, sha256: await sha256Of(listed.file, listed.bytes) });
  }

  const salt = randomBytes(32);
  const prefix = randomBytes(8);
  const header: CheckpointArchiveHeader = {
    format: 'sandforge-checkpoint',
    formatVersion: 1,
    checkpointFormat: 1,
    sandforgeVersion: request.sandforgeVersion,
    organizationId: organizationKey(checkpoint.org.organizationId),
    orgTier: checkpoint.org.tier,
    checkpointId: checkpoint.checkpointId,
    takenAt: checkpoint.takenAt,
    records: recordsOf(checkpoint),
    objects: checkpoint.objects.length,
    files: entries.length,
    bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
    cipher: 'aes-256-gcm',
    kdf: 'hkdf-sha256',
    salt: salt.toString('hex'),
    noncePrefix: prefix.toString('hex'),
    keyCheck: drawn(key, salt, KEY_CHECK_INFO, 16).toString('hex'),
    chunkBytes,
  };
  const line = Buffer.from(`${JSON.stringify(checkpointArchiveHeaderSchema.parse(header))}\n`);
  const keys: BlockKeys = {
    blockKey: drawn(key, salt, BLOCK_KEY_INFO, 32),
    prefix,
    headerHash: createHash('sha256').update(line).digest(),
  };

  const temp = join(
    dirname(out),
    `.${basename(out)}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`,
  );
  const fileHash = createHash('sha256');
  let written = 0;
  const handle = await open(temp, 'wx', CHECKPOINT_FILE_MODE);
  try {
    try {
      const write = async (bytes: Buffer): Promise<void> => {
        fileHash.update(bytes);
        written += bytes.length;
        await writeAll(handle, bytes);
      };
      await write(line);
      await pipeline(
        Readable.from(plainEntries(entries)),
        createGzip({ level: 6 }),
        async (compressed: AsyncIterable<Buffer>) => {
          await writeBlocks(compressed, chunkBytes, keys, write);
        },
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (await lstat(out).catch(() => undefined)) {
      throw new CheckpointExportError(
        'EXPORT_EXISTS',
        `${out} appeared while the checkpoint was exported: name another file.`,
      );
    }
    await rename(temp, out);
  } catch (err: unknown) {
    await rm(temp, { force: true });
    throw err;
  }
  return { header, bytes: written, sha256: fileHash.digest('hex') };
}

/** Write all of `bytes` where an open file is: a write may take fewer than it is given. */
async function writeAll(handle: FileHandle, bytes: Buffer): Promise<void> {
  for (let at = 0; at < bytes.length;) {
    const { bytesWritten } = await handle.write(bytes, at, bytes.length - at);
    at += bytesWritten;
  }
}

/** Records a checkpoint holds, every object together. */
function recordsOf(checkpoint: Pick<OrgCheckpoint, 'objects'>): number {
  return checkpoint.objects.reduce((total, object) => total + object.records, 0);
}

/**
 * The entries as the blocks hold them before they are compressed: each
 * one's line then its bytes, then the line that counts them. A file read
 * again for its bytes that is not what its sha256 said fails the export.
 */
async function* plainEntries(entries: readonly Entry[]): AsyncGenerator<Buffer> {
  for (const entry of entries) {
    const { path, bytes, sha256 } = entry;
    yield Buffer.from(`${JSON.stringify({ path, bytes, sha256 })}\n`, 'utf8');
    if (entry.content !== undefined) {
      yield entry.content;
      continue;
    }
    const hash = createHash('sha256');
    for await (const piece of bytesOf(entry.file ?? '', bytes)) {
      hash.update(piece);
      yield piece;
    }
    if (hash.digest('hex') !== sha256) {
      throw new CheckpointExportError(
        'EXPORT_CHANGED',
        `${path} of the checkpoint changed while it was exported: export it again.`,
      );
    }
  }
  yield Buffer.from(`${JSON.stringify({ end: true, files: entries.length })}\n`, 'utf8');
}

/**
 * The compressed entries as blocks of `chunkBytes`, each sealed and written
 * in turn: a block is held until the next one comes, since only the last one
 * is sealed as the last.
 */
async function writeBlocks(
  compressed: AsyncIterable<Buffer>,
  chunkBytes: number,
  keys: BlockKeys,
  write: (bytes: Buffer) => Promise<void>,
): Promise<void> {
  let index = 0;
  let pending: Buffer | undefined;
  let gathered: Buffer[] = [];
  let gatheredBytes = 0;
  const sealPending = async (last: boolean): Promise<void> => {
    if (pending === undefined) return;
    if (index >= MAX_BLOCKS) throw new RangeError('The checkpoint is too large for one file');
    await write(sealed(keys, index, last, pending));
    index++;
    pending = undefined;
  };
  for await (const chunk of compressed) {
    gathered.push(chunk);
    gatheredBytes += chunk.length;
    while (gatheredBytes >= chunkBytes) {
      const all = Buffer.concat(gathered);
      await sealPending(false);
      pending = all.subarray(0, chunkBytes);
      gathered = [all.subarray(chunkBytes)];
      gatheredBytes = all.length - chunkBytes;
    }
  }
  if (gatheredBytes > 0) {
    await sealPending(false);
    pending = Buffer.concat(gathered);
  }
  await sealPending(true);
}

// ─── Reading the header ──────────────────────────────────────────────────────

/** A `.sfcheckpoint` file's header, read, and where its blocks start. */
export interface ArchiveRead {
  header: CheckpointArchiveHeader;
  /** Bytes the header's line takes, its line break among them: where the first block starts. */
  headerBytes: number;
  /** The sha256 of that line, which each block authenticates. */
  headerHash: Buffer;
  /** Bytes of the file when it was read. */
  size: number;
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

/** The refusal of a file that is no checkpoint file a SandForge wrote. */
function notAnArchive(why: string): { refusal: CheckpointRefusal } {
  return {
    refusal: {
      code: 'IMPORT_NOT_ARCHIVE',
      message: `This is not a checkpoint file SandForge exported: ${why}. ${NOTHING_IMPORTED}`,
    },
  };
}

/**
 * Read a `.sfcheckpoint` file's header, its first line, and nothing more:
 * what the file holds and of which org, said before any key is asked. A
 * file a newer SandForge made is told as such, whatever else its line holds.
 */
export async function readArchiveHeader(
  file: string,
): Promise<{ read: ArchiveRead } | { refusal: CheckpointRefusal }> {
  let handle: FileHandle;
  try {
    handle = await open(file, 'r');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    return notAnArchive(code === 'ENOENT' ? 'there is no such file' : 'it cannot be read');
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return notAnArchive('it is not a file');
    const head = await readAt(handle, 0, Math.min(info.size, HEADER_MAX_BYTES));
    const end = head.indexOf(10);
    if (end < 0) return notAnArchive('it does not start with a checkpoint file’s header');
    const line = head.subarray(0, end + 1);
    let raw: unknown;
    try {
      raw = JSON.parse(line.toString('utf8'));
    } catch {
      return notAnArchive('it does not start with a checkpoint file’s header');
    }
    const versions = checkpointArchiveVersionsSchema.safeParse(raw);
    if (!versions.success) {
      return notAnArchive('it does not start with a checkpoint file’s header');
    }
    const { formatVersion, checkpointFormat, sandforgeVersion } = versions.data;
    if (
      !FORMAT_VERSIONS_READ.has(formatVersion) ||
      !CHECKPOINT_FORMATS_READ.has(checkpointFormat)
    ) {
      return {
        refusal: {
          code: 'IMPORT_VERSION',
          message:
            `This file was made by SandForge ${sandforgeVersion}, with checkpoint format ` +
            `${checkpointFormat} in file format ${formatVersion}, which this SandForge does not ` +
            `read: update SandForge, then import it. ${NOTHING_IMPORTED}`,
        },
      };
    }
    const header = checkpointArchiveHeaderSchema.safeParse(raw);
    if (!header.success) return notAnArchive('its header does not read');
    return {
      read: {
        header: header.data,
        headerBytes: line.length,
        headerHash: createHash('sha256').update(line).digest(),
        size: info.size,
      },
    };
  } finally {
    await handle.close();
  }
}

// ─── Importing ───────────────────────────────────────────────────────────────

/** What an import is asked, once the org has answered that it is the file's, and not refused it. */
export interface ArchiveImportRequest {
  store: OrgCheckpointStore;
  file: string;
  /** The header as it was read, and checked against the org: the file must still hold it. */
  read: ArchiveRead;
  key: Buffer;
  /** The alias the org has on this machine, which the checkpoint is listed under. */
  alias?: string;
  /** Days it is kept here; 0 keeps it until it is deleted. */
  keepDays: number;
  /** This machine and process, as the checkpoint names where it is kept. */
  takenOn: CheckpointTakenOn;
  now?: Date;
  /** Bytes the store's disk has free; read from the system unless a test says. */
  freeBytes?: (dir: string) => Promise<number | undefined>;
}

/** How an import ended: the checkpoint kept, one kept already the same, or the refusal. */
export type ArchiveImported =
  | { imported: true; outcome: 'imported' | 'alreadyKept'; checkpoint: OrgCheckpoint }
  | { imported: false; refusal: CheckpointRefusal };

/** Bytes free on the disk `dir` is on, for this user; undefined where the system will not say. */
async function systemFreeBytes(dir: string): Promise<number | undefined> {
  try {
    const info = await statfs(dir);
    return Number(info.bavail) * Number(info.bsize);
  } catch {
    return undefined;
  }
}

/**
 * Keep on this machine the checkpoint a `.sfcheckpoint` file holds, decrypted
 * with `key`, as the store keeps any: in its org's folder, under its own id,
 * its index made again from its values and held to what it counts, its owner's
 * alone. The org is not read here: the caller has had it answer that it is
 * the file's org, no production org, and that its user sees all data, before
 * this is called.
 *
 * In order, each refusal saying why, nothing kept but on success:
 * 1. the file still holds the header the org was asked about;
 * 2. the key is the file's, by its check value, before a block is read;
 * 3. a checkpoint of its id kept here already is the same, by the sha256 of
 *    each file — `alreadyKept` — or the import is refused;
 * 4. the disk has room for its files and their index;
 * 5. each block decrypts and each file is what its line says, written into a
 *    folder of its own beside the org's checkpoints, a path the store does
 *    not allow refused; `checkpoint.json` parses, and is the header's;
 * 6. each object's index is made again, its rows the records it counts, and
 *    the field prints are the objects';
 * 7. the folder is renamed to the checkpoint's id.
 */
export async function importCheckpointArchive(
  request: ArchiveImportRequest,
): Promise<ArchiveImported> {
  try {
    return await importOrRefuse(request);
  } catch (err: unknown) {
    if (err instanceof ImportRefused) return { imported: false, refusal: err.refusal };
    if (err instanceof CheckpointStoreError && err.code === 'damaged') {
      return {
        imported: false,
        refusal: { code: 'IMPORT_DAMAGED', message: `${err.message} ${NOTHING_IMPORTED}` },
      };
    }
    throw err;
  }
}

async function importOrRefuse(request: ArchiveImportRequest): Promise<ArchiveImported> {
  const { store, file, key } = request;
  const now = request.now ?? new Date();
  const again = await readArchiveHeader(file);
  if ('refusal' in again) return { imported: false, refusal: again.refusal };
  if (!again.read.headerHash.equals(request.read.headerHash)) {
    throw damaged('changed since its header was read');
  }
  const read = again.read;
  const { header } = read;
  const salt = Buffer.from(header.salt, 'hex');
  if (!timingSafeEqual(drawn(key, salt, KEY_CHECK_INFO, 16), Buffer.from(header.keyCheck, 'hex'))) {
    return {
      imported: false,
      refusal: {
        code: 'IMPORT_KEY',
        message: `This key is not the one the file was exported with. ${NOTHING_IMPORTED}`,
      },
    };
  }
  const keys: BlockKeys = {
    blockKey: drawn(key, salt, BLOCK_KEY_INFO, 32),
    prefix: Buffer.from(header.noncePrefix, 'hex'),
    headerHash: read.headerHash,
  };

  const kept = await store.read(header.checkpointId);
  if (kept !== undefined) return keptAlready(kept, file, read, keys);

  const free = await (request.freeBytes ?? systemFreeBytes)(store.root);
  const needed = header.bytes + snapshotIndexBytes(header.records, 2) + header.objects * 8;
  if (free !== undefined && free < needed) {
    return {
      imported: false,
      refusal: {
        code: 'IMPORT_DISK',
        message:
          `The checkpoint takes about ${megabytes(needed)} on this machine, and its disk has ` +
          `${megabytes(free)} free: make room, then import it. ${NOTHING_IMPORTED}`,
      },
    };
  }

  const done = await store.importInto(
    header.organizationId,
    header.checkpointId,
    async (staging) => {
      const unpacked = await unpack(file, read, keys, staging.dir);
      const checkpoint = importedCheckpointOf(unpacked, read, {
        ...(request.alias !== undefined ? { alias: request.alias } : {}),
        keepDays: request.keepDays,
        takenOn: request.takenOn,
        now,
      });
      await makePrivateDir(staging.indexDir);
      for (const object of checkpoint.objects) {
        const index = await writeSnapshotIndex(
          staging,
          checkpoint.snapshotId,
          object.objectApiName,
        );
        if (index.rows !== object.records) {
          throw damaged(
            `holds ${index.rows} records of ${object.objectApiName} where its checkpoint counts ` +
              `${object.records}`,
          );
        }
      }
      await readFieldPrints(staging, checkpoint.objects);
      return checkpoint;
    },
  );
  if (done.outcome === 'imported') {
    return { imported: true, outcome: 'imported', checkpoint: done.checkpoint };
  }
  // Another import of the file, in another window, kept it first.
  const keptMeanwhile = await store.read(header.checkpointId);
  if (keptMeanwhile === undefined) throw damaged('could not be kept');
  return keptAlready(keptMeanwhile, file, read, keys);
}

/** Megabytes, as a refusal says them. */
function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A checkpoint of the file's id kept here already: the same when it is of
 * the same org and each file the file holds but `checkpoint.json` has the
 * sha256 of the one kept, with no file kept the file does not hold. The file
 * is decrypted to tell, its files written nowhere.
 */
async function keptAlready(
  kept: { folder: CheckpointFolder; checkpoint?: OrgCheckpoint },
  file: string,
  read: ArchiveRead,
  keys: BlockKeys,
): Promise<ArchiveImported> {
  const refused = (why: string): ArchiveImported => ({
    imported: false,
    refusal: {
      code: 'IMPORT_KEPT_OTHER',
      message:
        `A checkpoint ${read.header.checkpointId} is kept on this machine already, ${why}: ` +
        `delete it first to import this file. ${NOTHING_IMPORTED}`,
    },
  });
  if (kept.folder.organizationId !== organizationKey(read.header.organizationId)) {
    return refused('of another org');
  }
  if (kept.checkpoint === undefined) return refused('damaged');
  const differs = refused('and differs from this one');
  const unpacked = await unpack(file, read, keys);
  const carried = new Map(
    unpacked.hashes.filter(([path]) => path !== CHECKPOINT_FILE_PATH).map(([p, h]) => [p, h]),
  );
  const held = (await exportedFilesOf(kept.folder)).filter(
    (listed: ExportedFile) => listed.path !== CHECKPOINT_FILE_PATH,
  );
  if (held.length !== carried.size) return differs;
  for (const listed of held) {
    if (carried.get(listed.path) !== (await sha256Of(listed.file, listed.bytes))) return differs;
  }
  return { imported: true, outcome: 'alreadyKept', checkpoint: kept.checkpoint };
}

/** What a file's blocks held, read: its `checkpoint.json`, each file's sha256, and the file's own. */
interface Unpacked {
  portable: Buffer;
  /** Each file's path and sha256, in the order the file holds them. */
  hashes: Array<[string, string]>;
  /** The sha256 of the whole file. */
  sha256: string;
}

/** A line of an entry, as the blocks hold it. */
const entryLineSchema = z.strictObject({
  path: z.string().min(1).max(300),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

/** The line that ends the entries. */
const endLineSchema = z.strictObject({ end: z.literal(true), files: z.number().int().positive() });

/**
 * Decrypt a file's blocks, inflate them and read its entries: each file
 * written into `into`, its owner's alone, or into nothing when only its
 * sha256 is wanted; `checkpoint.json` held. Each block is read where its
 * index says, its tag checked before its bytes are used.
 */
async function unpack(
  file: string,
  read: ArchiveRead,
  keys: BlockKeys,
  into?: string,
): Promise<Unpacked> {
  const handle = await open(file, 'r');
  const fileHash = createHash('sha256');
  try {
    const parser = new EntryParser(read.header, into);
    try {
      await pipeline(
        Readable.from(openedBlocks(handle, read, keys, fileHash)),
        createGunzip(),
        async (inflated: AsyncIterable<Buffer>) => {
          for await (const chunk of inflated) await parser.take(chunk);
        },
      );
    } catch (err: unknown) {
      // zlib's own codes: the blocks decrypted, and what they hold is no gzip stream.
      if (String((err as NodeJS.ErrnoException).code ?? '').startsWith('Z_')) {
        throw damaged('does not inflate');
      }
      throw err;
    } finally {
      await parser.close();
    }
    const unpacked = parser.ended();
    return { ...unpacked, sha256: fileHash.digest('hex') };
  } finally {
    await handle.close();
  }
}

/**
 * A file's blocks, each decrypted once its tag says it is the block sealed in
 * its place: the last block is the one the file ends on, and must have been
 * sealed as the last. The bytes read, the header's among them, go into
 * `fileHash`, in the file's order.
 */
async function* openedBlocks(
  handle: FileHandle,
  read: ArchiveRead,
  keys: BlockKeys,
  fileHash: Hash,
): AsyncGenerator<Buffer> {
  fileHash.update(await readAt(handle, 0, read.headerBytes));
  const sealedBytes = read.header.chunkBytes + TAG_BYTES;
  const body = read.size - read.headerBytes;
  if (body <= 0) throw damaged('holds nothing after its header');
  const count = Math.ceil(body / sealedBytes);
  const lastBytes = body - (count - 1) * sealedBytes;
  if (lastBytes <= TAG_BYTES) throw damaged('ends inside a block');
  if (count > MAX_BLOCKS) throw damaged('holds more blocks than a file can');
  for (let index = 0; index < count; index++) {
    const last = index === count - 1;
    const length = last ? lastBytes : sealedBytes;
    const block = await readAt(handle, read.headerBytes + index * sealedBytes, length);
    if (block.length < length) throw damaged('is cut short');
    fileHash.update(block);
    const plain = opened(keys, index, last, block);
    if (plain === undefined) {
      throw damaged(`holds a block, the ${ordinal(index + 1)} of ${count}, that does not decrypt`);
    }
    yield plain;
  }
}

/** 1st, 2nd, 3rd, 4th… */
function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

/**
 * Reads the inflated entries as they come: a line, then the bytes it names,
 * written as they come, never held whole but `checkpoint.json`; each path on
 * the store's list, once; the bytes and the files no more than the header
 * says, and the last line counting them all.
 */
class EntryParser {
  private line: Buffer[] = [];
  private lineBytes = 0;
  /** The entry whose bytes are being read, and what is left of them. */
  private current?: {
    path: string;
    left: number;
    sha256: string;
    hash: Hash;
    handle?: FileHandle;
    held?: Buffer[];
  };
  private readonly seen = new Set<string>();
  private readonly hashes: Array<[string, string]> = [];
  private portable?: Buffer;
  private bytes = 0;
  private end = false;

  constructor(
    private readonly header: CheckpointArchiveHeader,
    private readonly into: string | undefined,
  ) {}

  /** Read a piece of the inflated entries. */
  async take(chunk: Buffer): Promise<void> {
    let at = 0;
    while (at < chunk.length) {
      if (this.end) throw damaged('holds bytes after its last entry');
      const current = this.current;
      if (current !== undefined) {
        const piece = chunk.subarray(at, at + Math.min(current.left, chunk.length - at));
        at += piece.length;
        current.left -= piece.length;
        current.hash.update(piece);
        if (current.handle !== undefined) await writeAll(current.handle, piece);
        current.held?.push(Buffer.from(piece));
        if (current.left === 0) await this.endEntry();
        continue;
      }
      const newline = chunk.indexOf(10, at);
      const stop = newline < 0 ? chunk.length : newline;
      this.lineBytes += stop - at;
      if (this.lineBytes > ENTRY_LINE_MAX_BYTES)
        throw damaged('holds a line too long for an entry');
      this.line.push(chunk.subarray(at, stop));
      at = stop;
      if (newline < 0) continue;
      at++;
      const text = Buffer.concat(this.line).toString('utf8');
      this.line = [];
      this.lineBytes = 0;
      await this.startEntry(text);
    }
  }

  /** An entry's line read: its bytes come next, or the entries end. */
  private async startEntry(text: string): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw damaged('holds an entry that does not read');
    }
    const end = endLineSchema.safeParse(raw);
    if (end.success) {
      if (end.data.files !== this.hashes.length || end.data.files !== this.header.files) {
        throw damaged('counts other files than it holds');
      }
      this.end = true;
      return;
    }
    const entry = entryLineSchema.safeParse(raw);
    if (!entry.success) throw damaged('holds an entry that does not read');
    const { path, bytes, sha256 } = entry.data;
    if (!isExportedPath(path)) {
      throw damaged(`names a file no checkpoint holds, ${JSON.stringify(path)}`);
    }
    if (this.seen.has(path)) throw damaged(`holds ${path} twice`);
    this.seen.add(path);
    this.bytes += bytes;
    if (this.bytes > this.header.bytes || this.seen.size > this.header.files) {
      throw damaged('holds more than its header says');
    }
    const isCheckpointFile = path === CHECKPOINT_FILE_PATH;
    if (isCheckpointFile && bytes > CHECKPOINT_FILE_MAX_BYTES) {
      throw damaged('holds a checkpoint.json larger than any checkpoint’s');
    }
    let handle: FileHandle | undefined;
    if (!isCheckpointFile && this.into !== undefined) {
      const target = exportedFileIn(this.into, path);
      await makePrivateDir(dirname(target));
      handle = await open(target, 'wx', CHECKPOINT_FILE_MODE);
    }
    this.current = {
      path,
      left: bytes,
      sha256,
      hash: createHash('sha256'),
      ...(handle !== undefined ? { handle } : {}),
      ...(isCheckpointFile ? { held: [] } : {}),
    };
    if (bytes === 0) await this.endEntry();
  }

  /** An entry's bytes read: its file flushed and closed, its sha256 the one its line said. */
  private async endEntry(): Promise<void> {
    const current = this.current;
    if (current === undefined) return;
    this.current = undefined;
    if (current.handle !== undefined) {
      try {
        await current.handle.sync();
      } finally {
        await current.handle.close();
      }
    }
    if (current.hash.digest('hex') !== current.sha256) {
      throw damaged(`holds ${current.path} with other bytes than its sha256 says`);
    }
    if (current.held !== undefined) this.portable = Buffer.concat(current.held);
    this.hashes.push([current.path, current.sha256]);
  }

  /** The file of the entry under way, closed: one an error stopped. */
  async close(): Promise<void> {
    await this.current?.handle?.close().catch(() => undefined);
  }

  /** What the entries held, once they have ended as the last line says. */
  ended(): Omit<Unpacked, 'sha256'> {
    if (!this.end || this.current !== undefined) throw damaged('is cut short');
    if (this.bytes !== this.header.bytes) throw damaged('holds other bytes than its header says');
    if (this.portable === undefined) throw damaged('holds no checkpoint.json');
    return { portable: this.portable, hashes: this.hashes };
  }
}

/** What an import sets of the checkpoint for this machine. */
interface ImportedHere {
  alias?: string;
  keepDays: number;
  takenOn: CheckpointTakenOn;
  now: Date;
}

/**
 * The checkpoint a file held, as this machine keeps it: what it says of the
 * org, the take and the objects, with this machine's alias, where it is kept,
 * how long, and where it came from — whatever the file says of those — and
 * no last rewind. It must parse, be ready, and be the checkpoint the header
 * names, of its org, with its records and objects.
 */
function importedCheckpointOf(
  unpacked: Omit<Unpacked, 'sha256'> & { sha256: string },
  read: ArchiveRead,
  here: ImportedHere,
): OrgCheckpoint {
  let raw: unknown;
  try {
    raw = JSON.parse(unpacked.portable.toString('utf8'));
  } catch {
    throw damaged('holds a checkpoint.json that does not read');
  }
  if (!isRecord(raw) || !isRecord(raw.org)) {
    throw damaged('holds a checkpoint.json that does not read');
  }
  const parsed = orgCheckpointSchema.safeParse({
    ...withoutKeys(raw, MACHINE_KEYS),
    org: {
      ...withoutKeys(raw.org, ORG_MACHINE_KEYS),
      ...(here.alias !== undefined ? { alias: here.alias } : {}),
    },
    takenOn: here.takenOn,
    expiresAt: expiresAtFor(here.now, here.keepDays),
    bytes: 0,
    importedFrom: {
      at: here.now.toISOString(),
      sandforgeVersion: read.header.sandforgeVersion,
      sha256: unpacked.sha256,
    },
  });
  if (!parsed.success) throw damaged('holds a checkpoint.json that does not parse');
  const checkpoint = parsed.data;
  const { header } = read;
  if (
    checkpoint.checkpointId !== header.checkpointId ||
    organizationKey(checkpoint.org.organizationId) !== organizationKey(header.organizationId) ||
    checkpoint.takenAt !== header.takenAt ||
    checkpoint.status !== 'ready' ||
    recordsOf(checkpoint) !== header.records ||
    checkpoint.objects.length !== header.objects
  ) {
    throw damaged('holds another checkpoint than its header says');
  }
  return checkpoint;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
