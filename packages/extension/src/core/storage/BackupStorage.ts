import { mkdir, readFile, writeFile, readdir, rm } from 'fs/promises';
import { join, resolve } from 'path';

/** Metadata describing a stored backup */
export interface BackupMeta {
  /** Unique operation identifier */
  operationId: string;
  /** Salesforce org identifier */
  orgId: string;
  /** Objects included in the backup with their record counts */
  objects: Array<{ objectApiName: string; recordCount: number }>;
  /** ISO 8601 timestamp of when the backup was created */
  timestamp: string;
  /** Total number of records across all objects */
  totalRecords: number;
}

/** Object info passed when saving a backup */
export interface BackupObjectInfo {
  /** Salesforce object API name */
  objectApiName: string;
  /** Number of records for this object */
  recordCount: number;
}

/**
 * Filesystem-based storage for backup data.
 * Stores backup metadata and per-object record files as JSON
 * in a dedicated `backups/` subdirectory under the extension's global storage path.
 *
 * This avoids the ~1MB limit of VSCode globalState (Memento).
 */
export class BackupStorage {
  private readonly backupsDir: string;

  /**
   * Creates a new BackupStorage instance.
   * @param storagePath - Base storage path (typically `context.globalStorageUri.fsPath`)
   */
  constructor(storagePath: string) {
    this.backupsDir = join(storagePath, 'backups');
  }

  /**
   * Saves a backup with its metadata and per-object record files.
   * Creates the backups directory if it does not already exist.
   * @param operationId - Unique identifier for the backup operation
   * @param orgId - Salesforce org identifier
   * @param objects - Array of objects with API names and record counts
   * @param records - Map of objectApiName to record arrays
   */
  async saveBackup(
    operationId: string,
    orgId: string,
    objects: BackupObjectInfo[],
    records: Map<string, Record<string, unknown>[]>,
  ): Promise<void> {
    await this.ensureDir();

    const meta: BackupMeta = {
      operationId,
      orgId,
      objects,
      timestamp: new Date().toISOString(),
      totalRecords: objects.reduce((sum, obj) => sum + obj.recordCount, 0),
    };

    await writeFile(this.metaPath(operationId), JSON.stringify(meta, null, 2), 'utf-8');

    const writePromises: Promise<void>[] = [];
    for (const [objectApiName, objectRecords] of records) {
      writePromises.push(
        writeFile(
          this.recordsPath(operationId, objectApiName),
          JSON.stringify(objectRecords, null, 2),
          'utf-8',
        ),
      );
    }

    await Promise.all(writePromises);
  }

  /**
   * Reads the metadata for a specific backup.
   * @param operationId - Unique identifier for the backup operation
   * @returns The backup metadata, or `undefined` if the backup does not exist
   */
  async getBackupMeta(operationId: string): Promise<BackupMeta | undefined> {
    try {
      const content = await readFile(this.metaPath(operationId), 'utf-8');
      return JSON.parse(content) as BackupMeta;
    } catch {
      return undefined;
    }
  }

  /**
   * Reads the records for a specific object within a backup.
   * @param operationId - Unique identifier for the backup operation
   * @param objectApiName - Salesforce object API name
   * @returns Array of records, or an empty array if the file does not exist
   */
  async getBackupRecords(
    operationId: string,
    objectApiName: string,
  ): Promise<Record<string, unknown>[]> {
    try {
      const content = await readFile(this.recordsPath(operationId, objectApiName), 'utf-8');
      return JSON.parse(content) as Record<string, unknown>[];
    } catch {
      return [];
    }
  }

  /**
   * Lists metadata for all stored backups, sorted by timestamp descending (newest first).
   * @returns Array of backup metadata entries
   */
  async listBackups(): Promise<BackupMeta[]> {
    try {
      const files = await readdir(this.backupsDir);
      const metaFiles = files.filter((f) => f.endsWith('.meta.json'));

      const readPromises = metaFiles.map(async (file) => {
        try {
          const content = await readFile(join(this.backupsDir, file), 'utf-8');
          return JSON.parse(content) as BackupMeta;
        } catch {
          return null;
        }
      });

      const results = await Promise.all(readPromises);
      return results
        .filter((meta): meta is BackupMeta => meta !== null)
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    } catch {
      return [];
    }
  }

  /**
   * Deletes a backup and all its associated record files.
   * @param operationId - Unique identifier for the backup operation to delete
   */
  async deleteBackup(operationId: string): Promise<void> {
    try {
      const files = await readdir(this.backupsDir);
      const safeId = this.safeName(operationId);
      const prefix = `backup-${safeId}.`;
      const matchingFiles = files.filter((f) => f.startsWith(prefix));

      await Promise.all(
        matchingFiles.map((file) => rm(join(this.backupsDir, file), { force: true })),
      );
    } catch {
      // Directory may not exist; nothing to delete
    }
  }

  /** Ensures the backups directory exists */
  private async ensureDir(): Promise<void> {
    await mkdir(this.backupsDir, { recursive: true });
  }

  /**
   * Sanitizes a user-provided identifier for safe use in file names.
   * Strips any character that is not alphanumeric, hyphen, or underscore.
   * @throws Error if the sanitized result is empty.
   */
  private safeName(input: string): string {
    const sanitized = input.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!sanitized) {
      throw new Error(`Invalid identifier for backup file name: "${input}"`);
    }
    return sanitized;
  }

  /**
   * Builds a file path inside the backups directory and verifies it
   * does not escape via path traversal.
   */
  private safePath(fileName: string): string {
    const target = resolve(this.backupsDir, fileName);
    if (!target.startsWith(resolve(this.backupsDir))) {
      throw new Error(`Path traversal detected: "${fileName}"`);
    }
    return target;
  }

  /** Returns the file path for a backup's metadata file */
  private metaPath(operationId: string): string {
    return this.safePath(`backup-${this.safeName(operationId)}.meta.json`);
  }

  /** Returns the file path for a backup's object record file */
  private recordsPath(operationId: string, objectApiName: string): string {
    return this.safePath(
      `backup-${this.safeName(operationId)}.${this.safeName(objectApiName)}.json`,
    );
  }
}
