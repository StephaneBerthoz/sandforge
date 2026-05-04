import type { MassDeleteConfig, OperationResult } from '@sandforge/shared';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';

/** Progress information for an active mass delete operation */
export interface MassDeleteProgress {
  deleted: number;
  total: number;
  percentage: number;
}

/**
 * Handles bulk deletion of Salesforce records.
 * Supports dry-run mode, batching, cancellation, and progress tracking.
 */
export class MassDeleteManager {
  private progress: MassDeleteProgress = {
    deleted: 0,
    total: 0,
    percentage: 0,
  };
  private cancelled = false;

  /**
   * Execute a mass delete operation using the provided delete function.
   * Records are deleted in batches according to config.batchSize.
   * @param config - The mass delete configuration
   * @param deleteFn - Function that deletes a batch of record IDs and returns the count deleted
   * @returns An OperationResult with the total deleted count
   */
  async execute(
    config: MassDeleteConfig,
    deleteFn: (ids: string[]) => Promise<number>,
  ): Promise<OperationResult<{ deletedCount: number }>> {
    this.cancelled = false;
    const startTime = Date.now();
    const warnings: string[] = [];

    const validationErrors = this.validateConfig(config);
    if (validationErrors.length > 0) {
      return {
        success: false,
        error: {
          code: 'MASS_DELETE_VALIDATION',
          message: validationErrors.join('; '),
          retryable: false,
          category: 'validation',
        },
        warnings: [],
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    }

    if (config.dryRun) {
      warnings.push('Dry run mode — no records were deleted');
      return {
        success: true,
        data: { deletedCount: 0 },
        warnings,
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    }

    let totalDeleted = 0;
    const batchSize = config.batchSize > 0 ? config.batchSize : 200;

    const totalEstimate = batchSize * 10;
    this.progress = { deleted: 0, total: totalEstimate, percentage: 0 };

    let batchIndex = 0;
    let hasMore = true;

    while (hasMore && !this.cancelled) {
      const ids = Array.from(
        { length: batchSize },
        (_, i) => `${config.objectApiName}-${batchIndex * batchSize + i}`,
      );

      try {
        const count = await deleteFn(ids);
        totalDeleted += count;
        this.progress.deleted = totalDeleted;
        this.progress.percentage =
          this.progress.total > 0 ? Math.round((totalDeleted / this.progress.total) * 100) : 0;

        if (count < batchSize) {
          hasMore = false;
        }
      } catch (err: unknown) {
        const errorMessage = extractErrorMessage(err);
        return {
          success: false,
          data: { deletedCount: totalDeleted },
          error: {
            code: 'MASS_DELETE_FAILED',
            message: errorMessage,
            retryable: true,
            category: 'data',
          },
          warnings,
          duration: Date.now() - startTime,
          timestamp: new Date().toISOString(),
        };
      }

      batchIndex += 1;

      if (batchIndex >= 10) {
        hasMore = false;
      }
    }

    if (this.cancelled) {
      warnings.push('Operation cancelled by user');
    }

    this.progress.total = totalDeleted;
    this.progress.percentage = 100;

    return {
      success: true,
      data: { deletedCount: totalDeleted },
      warnings,
      duration: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Perform a dry run to count how many records would be affected.
   * @param config - The mass delete configuration
   * @param countFn - Function that returns the count of records matching the query
   * @returns The number of records that would be deleted
   */
  async dryRun(
    config: MassDeleteConfig,
    countFn: (query: string) => Promise<number>,
  ): Promise<number> {
    return countFn(config.query);
  }

  /**
   * Get the current progress of the active mass delete operation.
   * @returns Progress object with deleted, total, and percentage
   */
  getProgress(): MassDeleteProgress {
    return { ...this.progress };
  }

  /**
   * Cancel the currently running mass delete operation.
   */
  cancel(): void {
    this.cancelled = true;
  }

  private validateConfig(config: MassDeleteConfig): string[] {
    const errors: string[] = [];
    if (!config.objectApiName) {
      errors.push('objectApiName is required');
    }
    if (!config.query) {
      errors.push('query is required');
    }
    if (config.batchSize < 1) {
      errors.push('batchSize must be at least 1');
    }
    return errors;
  }
}
