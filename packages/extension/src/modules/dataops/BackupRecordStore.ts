import { createReadStream } from 'node:fs';
import { access, appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  };
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
    // Both segments are Salesforce API names / generated ids, but they reach
    // here from a message payload — keep them to a single path segment.
    const safe = `${operationId}__${objectApiName}`.replace(/[^A-Za-z0-9_-]/g, '_');
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
}
