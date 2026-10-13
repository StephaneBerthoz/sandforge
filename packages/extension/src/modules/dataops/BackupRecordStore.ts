import { createReadStream } from 'node:fs';
import type { Dirent } from 'node:fs';
import {
  access,
  appendFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline';

/** File-system operations this store needs, injected so it stays testable. */
export interface BackupRecordStoreDeps {
  /** Directory the extension owns for persistent data (globalStorageUri). */
  storagePath: string;
  readFile: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, content: string) => Promise<void>;
  /** Add to the end of a file, creating it when it is not there. */
  appendFile: (filePath: string, content: string) => Promise<void>;
  /** Whether a file is there. */
  exists: (filePath: string) => Promise<boolean>;
  /** A file's lines, one at a time, without holding the file whole. */
  readLines: (filePath: string) => AsyncIterable<string>;
  mkdir: (dirPath: string) => Promise<void>;
  rm: (filePath: string) => Promise<void>;
  /** The files directly in a directory, each with when it was last written; none when it is not there. */
  listFiles: (dirPath: string) => Promise<StoredFile[]>;
}

/** A file of a directory, and when it was last written. */
export interface StoredFile {
  name: string;
  /** When the file was last written, in milliseconds since the epoch. */
  modifiedMs: number;
}

/** A record of a backup, as it was read from the org. */
export type BackupRecord = Record<string, unknown>;

/**
 * The file operations of a store over Node's file system: what the extension
 * gives it under its storage directory, and the CLI under the one it is told.
 *
 * @param storagePath - The directory backups go under, in `backups/`.
 */
export function nodeBackupFiles(storagePath: string): BackupRecordStoreDeps {
  return {
    storagePath,
    readFile: (filePath) => readFile(filePath, 'utf8'),
    writeFile: (filePath, content) => writeFile(filePath, content, 'utf8'),
    appendFile: (filePath, content) => appendFile(filePath, content, 'utf8'),
    exists: (filePath) =>
      access(filePath).then(
        () => true,
        () => false,
      ),
    readLines: (filePath) => linesOf(filePath),
    mkdir: async (dirPath) => {
      await mkdir(dirPath, { recursive: true });
    },
    rm: (filePath) => rm(filePath, { force: true }),
    listFiles: (dirPath) => filesIn(dirPath),
  };
}

/** The files directly in a directory, with when each was last written; none when it is not there. */
async function filesIn(dirPath: string): Promise<StoredFile[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const files: StoredFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    // Removed between the listing and now, by another window's retention:
    // there is nothing left to say about it.
    const info = await stat(path.join(dirPath, entry.name)).catch(() => undefined);
    if (info) files.push({ name: entry.name, modifiedMs: info.mtimeMs });
  }
  return files;
}

/** A file's lines, read a chunk at a time; the file is closed however the reading ends. */
async function* linesOf(filePath: string): AsyncGenerator<string> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) yield line;
  } finally {
    lines.close();
    stream.destroy();
  }
}

/**
 * A name as it goes into a file name: letters, digits, `_` and `-`, the rest
 * as `_`. Both parts of a file's name are Salesforce API names or generated
 * ids, but they reach the store from a message payload.
 */
function fileSegment(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** Whether a value read back is a record: an object, not an array or nothing. */
function isRecord(value: unknown): value is BackupRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Record payloads of a backup, stored as files rather than in globalState.
 *
 * dataops:backup used to write every object's full SOQL result set into
 * ConfigStore, which is backed by `context.globalState`. VSCode serializes that
 * memento in its entirety on every write, so a single backup put megabytes into
 * a blob that is then re-serialized by every unrelated `set()` — a settings
 * toggle, a saved template, an org refresh — and re-parsed at activation.
 *
 * Only the record payloads move. The backup meta stays in ConfigStore: it is
 * small, it is what the history list reads, and keeping it there means backups
 * written before this change are still listed. Readers fall back to ConfigStore
 * when no file exists, so nothing needs migrating.
 *
 * An object's records go one to a line (`<backup>__<object>.ndjson`), each
 * page added as the org answers it: a backup reads an object page after page,
 * up to a cap the user may set as high as a million rows, and holding an
 * object whole to write it as one array put every row of it in memory at
 * once. A backup taken before that holds one JSON array per object (`.json`),
 * and is read as it was written.
 */
export class BackupRecordStore {
  private readonly dir: string;

  /** @param deps - Injected storage path and file-system operations. */
  constructor(private readonly deps: BackupRecordStoreDeps) {
    this.dir = path.join(deps.storagePath, 'backups');
  }

  /** Absolute path of one object's records within a backup, in one form or the other. */
  private filePath(
    operationId: string,
    objectApiName: string,
    form: 'lines' | 'array' = 'lines',
  ): string {
    // Kept to a single path segment: see fileSegment.
    const safe = `${fileSegment(operationId)}__${fileSegment(objectApiName)}`;
    return path.join(this.dir, `${safe}.${form === 'lines' ? 'ndjson' : 'json'}`);
  }

  /** Start one object of a backup: an empty file its pages are added to. */
  async begin(operationId: string, objectApiName: string): Promise<void> {
    await this.deps.mkdir(this.dir).catch(() => undefined);
    await this.deps.writeFile(this.filePath(operationId, objectApiName), '');
  }

  /** Add a page of one object's records, one record to a line. */
  async append(
    operationId: string,
    objectApiName: string,
    records: readonly unknown[],
  ): Promise<void> {
    if (records.length === 0) return;
    const lines = records.map((record) => JSON.stringify(record)).join('\n');
    await this.deps.appendFile(this.filePath(operationId, objectApiName), `${lines}\n`);
  }

  /**
   * One object's records, `size` at a time, in either form a backup was
   * written in; null when no file holds them, as for a backup that predates
   * the store. Each pass over the answer reads the file again from its first
   * record, holding one batch.
   *
   * @throws While it is read, when a line holds no record: the file is not
   *   what the backup wrote, and a restore must not take it for what it was.
   */
  async batches(
    operationId: string,
    objectApiName: string,
    size: number,
  ): Promise<AsyncIterable<BackupRecord[]> | null> {
    const lines = this.filePath(operationId, objectApiName);
    if (await this.deps.exists(lines)) {
      return { [Symbol.asyncIterator]: () => this.readLineBatches(lines, objectApiName, size) };
    }
    const array = this.filePath(operationId, objectApiName, 'array');
    if (await this.deps.exists(array)) {
      return { [Symbol.asyncIterator]: () => this.readArrayBatches(array, objectApiName, size) };
    }
    return null;
  }

  /** The records of a file written one to a line, `size` at a time. */
  private async *readLineBatches(
    filePath: string,
    objectApiName: string,
    size: number,
  ): AsyncGenerator<BackupRecord[]> {
    let batch: BackupRecord[] = [];
    let lineNumber = 0;
    for await (const line of this.deps.readLines(filePath)) {
      lineNumber += 1;
      if (line.trim() === '') continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        record = undefined;
      }
      if (!isRecord(record)) {
        throw new Error(
          `The backup of ${objectApiName} is damaged at line ${lineNumber} of its file: ` +
            'it holds no record there.',
        );
      }
      batch.push(record);
      if (batch.length === size) {
        yield batch;
        batch = [];
      }
    }
    if (batch.length > 0) yield batch;
  }

  /** The records of a file written as one array, as backups were before, `size` at a time. */
  private async *readArrayBatches(
    filePath: string,
    objectApiName: string,
    size: number,
  ): AsyncGenerator<BackupRecord[]> {
    const parsed: unknown = JSON.parse(await this.deps.readFile(filePath));
    if (!Array.isArray(parsed) || !parsed.every(isRecord)) {
      throw new Error(`The backup of ${objectApiName} is damaged: its file holds no records.`);
    }
    for (let i = 0; i < parsed.length; i += size) yield parsed.slice(i, i + size);
  }

  /** Remove one object's records, in whichever form they were written. Missing files are not an error. */
  async delete(operationId: string, objectApiName: string): Promise<void> {
    await this.deps.rm(this.filePath(operationId, objectApiName)).catch(() => undefined);
    await this.deps.rm(this.filePath(operationId, objectApiName, 'array')).catch(() => undefined);
  }

  /**
   * Remove the record files of backups whose metadata was never saved: a
   * window that closed or crashed in the middle of a backup leaves the pages
   * it wrote, which no listing shows, no restore reads and no retention
   * removes, up to a million rows an object.
   *
   * A backup going on in another window has no metadata yet either, and the
   * storage is the same for every window of the machine. Its files are told
   * apart by age: the file of the object it reads gets a page every few
   * seconds, so a backup is removed only once the newest of its files has
   * not been written for `olderThanMs`. The files of one backup are taken
   * together, so an object it read whole hours ago is not removed while it
   * reads the next one. A backup's files share the name up to the first
   * `__`; an object name may hold more, an id the store writes holds none,
   * and an id that did would only gather more files under one age.
   *
   * @param keep - The backups whose files stay whatever their age: every one
   *   whose metadata is kept, and every one this window is writing.
   * @param olderThanMs - How long ago the newest file of a backup must have
   *   been written for its files to be removed.
   * @param now - The time now, in milliseconds since the epoch.
   * @returns The names of the files removed.
   */
  async sweep(keep: Iterable<string>, olderThanMs: number, now: number): Promise<string[]> {
    const kept = [...keep].map((operationId) => `${fileSegment(operationId)}__`);
    const backups = new Map<string, StoredFile[]>();
    for (const file of await this.deps.listFiles(this.dir)) {
      // Only the files a backup writes: anything else here is not this store's.
      if (!/\.(?:ndjson|json)$/.test(file.name)) continue;
      const cut = file.name.indexOf('__');
      if (cut <= 0) continue;
      if (kept.some((prefix) => file.name.startsWith(prefix))) continue;
      const backup = file.name.slice(0, cut);
      backups.set(backup, [...(backups.get(backup) ?? []), file]);
    }
    const removed: string[] = [];
    for (const files of backups.values()) {
      const newest = Math.max(...files.map((f) => f.modifiedMs));
      if (now - newest < olderThanMs) continue;
      for (const file of files) {
        // One file another process holds open is no reason to keep the rest.
        await this.deps.rm(path.join(this.dir, file.name)).then(
          () => removed.push(file.name),
          () => undefined,
        );
      }
    }
    return removed;
  }
}
