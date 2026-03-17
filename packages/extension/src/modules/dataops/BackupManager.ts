import type {
  BackupConfig,
  BackupResult,
  BackupStatus,
  BackupObjectResult,
} from '@sandforge/shared';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';

/**
 * Manages backup operations for Salesforce org data.
 * Tracks active and completed backups, validates configurations,
 * and orchestrates per-object data extraction.
 */
export class BackupManager {
  private readonly operations: Map<string, BackupResult> = new Map();
  private operationCounter = 0;

  /**
   * Create a backup based on the provided configuration.
   * Iterates over each configured object, queries records via the supplied function,
   * and aggregates results into a single BackupResult.
   * @param config - Backup configuration describing objects and options
   * @param queryFn - Function that fetches records for a given object API name
   * @returns The completed BackupResult
   */
  async createBackup(
    config: BackupConfig,
    queryFn: (obj: string) => Promise<Record<string, unknown>[]>,
  ): Promise<BackupResult> {
    const operationId = this.generateOperationId();
    const startTime = new Date().toISOString();

    const result: BackupResult = {
      configId: config.id,
      operationId,
      status: 'running',
      objectResults: [],
      totalRecords: 0,
      totalSize: 0,
      filePath: '',
      checksum: '',
      startTime,
      endTime: '',
      duration: 0,
    };

    this.operations.set(operationId, result);

    const objectResults: BackupObjectResult[] = [];
    let totalRecords = 0;
    let totalSize = 0;
    let allSucceeded = true;

    for (const objectApiName of config.objects) {
      try {
        const records = await queryFn(objectApiName);
        const size = this.estimateRecordSize(records);

        objectResults.push({
          objectApiName,
          recordCount: records.length,
          size,
          status: 'success',
        });

        totalRecords += records.length;
        totalSize += size;
      } catch (err: unknown) {
        const errorMessage = extractErrorMessage(err);
        objectResults.push({
          objectApiName,
          recordCount: 0,
          size: 0,
          status: 'failure',
          error: errorMessage,
        });
        allSucceeded = false;
      }
    }

    const endTime = new Date().toISOString();
    const duration =
      new Date(endTime).getTime() - new Date(startTime).getTime();

    const completed: BackupResult = {
      configId: config.id,
      operationId,
      status: allSucceeded ? 'completed' : 'failed',
      objectResults,
      totalRecords,
      totalSize,
      filePath: this.buildFilePath(config.name, operationId),
      checksum: this.computeChecksum(totalRecords, totalSize),
      startTime,
      endTime,
      duration,
    };

    this.operations.set(operationId, completed);
    return completed;
  }

  /**
   * Get the current status of a backup operation.
   * @param operationId - The unique operation identifier
   * @returns The status of the backup, or 'pending' if not found
   */
  getBackupStatus(operationId: string): BackupStatus {
    const op = this.operations.get(operationId);
    return op ? op.status : 'pending';
  }

  /**
   * List all tracked backup results.
   * @returns Array of all backup results
   */
  listBackups(): BackupResult[] {
    return Array.from(this.operations.values());
  }

  /**
   * Delete a backup from the tracked operations.
   * @param operationId - The unique operation identifier
   * @returns True if the backup was found and deleted, false otherwise
   */
  deleteBackup(operationId: string): boolean {
    return this.operations.delete(operationId);
  }

  /**
   * Validate a backup configuration and return any validation errors.
   * @param config - The backup configuration to validate
   * @returns Array of validation error messages; empty if valid
   */
  validateConfig(config: BackupConfig): string[] {
    const errors: string[] = [];

    if (!config.id) {
      errors.push('Backup config must have an id');
    }
    if (!config.name || config.name.trim().length === 0) {
      errors.push('Backup config must have a name');
    }
    if (!config.orgId) {
      errors.push('Backup config must have an orgId');
    }
    if (!config.objects || config.objects.length === 0) {
      errors.push('Backup config must include at least one object');
    }
    if (config.retentionDays <= 0) {
      errors.push('Retention days must be greater than zero');
    }
    if (config.schedule?.enabled && !config.schedule.cron) {
      errors.push('Scheduled backup must have a cron expression');
    }

    return errors;
  }

  private generateOperationId(): string {
    this.operationCounter += 1;
    return `backup-op-${Date.now()}-${this.operationCounter}`;
  }

  private estimateRecordSize(records: Record<string, unknown>[]): number {
    return records.reduce((acc, record) => {
      return acc + JSON.stringify(record).length;
    }, 0);
  }

  private buildFilePath(name: string, operationId: string): string {
    const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `backups/${sanitized}/${operationId}.json`;
  }

  private computeChecksum(totalRecords: number, totalSize: number): string {
    const raw = `${totalRecords}:${totalSize}:${Date.now()}`;
    let hash = 0;
    for (let i = 0; i < raw.length; i++) {
      const char = raw.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
  }
}
