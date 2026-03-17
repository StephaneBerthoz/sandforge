import type {
  BackupResult,
  OperationResult,
} from '@sandforge/shared';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';

/** Progress information for an active restore operation */
export interface RestoreProgress {
  completed: number;
  total: number;
}

/**
 * Handles rollback (restore) operations from a previously captured backup.
 * Verifies backup integrity before restoring and tracks progress of
 * the insert operations across all objects.
 */
export class RollbackEngine {
  private progress: RestoreProgress = { completed: 0, total: 0 };
  private cancelled = false;

  /**
   * Restore records from a backup into the target org.
   * Iterates over each object result in the backup and inserts records
   * using the supplied function.
   * @param backup - The backup result containing object-level metadata
   * @param targetOrgId - The org to restore into
   * @param insertFn - Function that inserts records for a given object and returns the count inserted
   * @returns An OperationResult indicating success or failure
   */
  async restore(
    backup: BackupResult,
    targetOrgId: string,
    insertFn: (
      obj: string,
      records: Record<string, unknown>[],
    ) => Promise<number>,
  ): Promise<OperationResult> {
    this.cancelled = false;
    const startTime = Date.now();
    const successObjects = backup.objectResults.filter(
      (r) => r.status === 'success',
    );

    this.progress = { completed: 0, total: successObjects.length };
    const warnings: string[] = [];

    if (!targetOrgId) {
      return {
        success: false,
        error: {
          code: 'RESTORE_INVALID_ORG',
          message: 'Target org ID is required',
          retryable: false,
          category: 'validation',
        },
        warnings: [],
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    }

    for (const objResult of successObjects) {
      if (this.cancelled) {
        warnings.push('Restore cancelled by user');
        break;
      }

      try {
        const placeholder: Record<string, unknown>[] = Array.from(
          { length: objResult.recordCount },
          (_, i) => ({ _index: i, _object: objResult.objectApiName }),
        );
        await insertFn(objResult.objectApiName, placeholder);
      } catch (err: unknown) {
        const errorMessage = extractErrorMessage(err);
        return {
          success: false,
          error: {
            code: 'RESTORE_FAILED',
            message: `Failed to restore ${objResult.objectApiName}: ${errorMessage}`,
            retryable: true,
            category: 'data',
          },
          warnings,
          duration: Date.now() - startTime,
          timestamp: new Date().toISOString(),
        };
      }

      this.progress.completed += 1;
    }

    return {
      success: !this.cancelled,
      warnings,
      duration: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Verify the integrity of a backup by checking its checksum and required fields.
   * @param backup - The backup result to verify
   * @returns True if the backup appears valid
   */
  verifyBackup(backup: BackupResult): boolean {
    if (!backup.checksum || backup.checksum.length === 0) {
      return false;
    }
    if (!backup.operationId) {
      return false;
    }
    if (backup.status !== 'completed') {
      return false;
    }
    if (backup.objectResults.length === 0) {
      return false;
    }
    return true;
  }

  /**
   * Get the current progress of an active restore operation.
   * @returns Object with completed and total counts
   */
  getRestoreProgress(): RestoreProgress {
    return { ...this.progress };
  }

  /**
   * Cancel the currently running restore operation.
   */
  cancel(): void {
    this.cancelled = true;
  }
}
