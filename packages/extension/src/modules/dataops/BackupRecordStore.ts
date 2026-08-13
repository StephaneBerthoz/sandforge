import * as path from 'node:path';

/** File-system operations this store needs, injected so it stays testable. */
export interface BackupRecordStoreDeps {
  /** Directory the extension owns for persistent data (globalStorageUri). */
  storagePath: string;
  readFile: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, content: string) => Promise<void>;
  mkdir: (dirPath: string) => Promise<void>;
  rm: (filePath: string) => Promise<void>;
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
 */
export class BackupRecordStore {
  private readonly dir: string;

  /** @param deps - Injected storage path and file-system operations. */
  constructor(private readonly deps: BackupRecordStoreDeps) {
    this.dir = path.join(deps.storagePath, 'backups');
  }

  /** Absolute path of one object's records within a backup. */
  private filePath(operationId: string, objectApiName: string): string {
    // Both segments are Salesforce API names / generated ids, but they reach
    // here from a message payload — keep them to a single path segment.
    const safe = `${operationId}__${objectApiName}`.replace(/[^A-Za-z0-9_-]/g, '_');
    return path.join(this.dir, `${safe}.json`);
  }

  /** Persist one object's records. */
  async save(operationId: string, objectApiName: string, records: unknown[]): Promise<void> {
    await this.deps.mkdir(this.dir).catch(() => undefined);
    await this.deps.writeFile(this.filePath(operationId, objectApiName), JSON.stringify(records));
  }

  /** Read one object's records, or null when this backup predates the store. */
  async read(operationId: string, objectApiName: string): Promise<unknown[] | null> {
    try {
      const content = await this.deps.readFile(this.filePath(operationId, objectApiName));
      return JSON.parse(content) as unknown[];
    } catch {
      return null;
    }
  }

  /** Remove one object's records. Missing files are not an error. */
  async delete(operationId: string, objectApiName: string): Promise<void> {
    await this.deps.rm(this.filePath(operationId, objectApiName)).catch(() => undefined);
  }
}
