import type { OperationResult } from '@sandforge/shared';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';

/**
 * Manages Salesforce recycle bin operations: listing deleted records,
 * undeleting them, or permanently purging them.
 */
export class RecycleBinManager {
  /**
   * Get deleted records for a given object from the recycle bin.
   * @param orgId - The org identifier
   * @param objectApiName - The Salesforce object API name
   * @param queryFn - Function that queries deleted records
   * @returns Array of deleted record objects
   */
  async getDeletedRecords(
    orgId: string,
    objectApiName: string,
    queryFn: (q: string) => Promise<Record<string, unknown>[]>,
  ): Promise<Record<string, unknown>[]> {
    if (!orgId || !objectApiName) {
      return [];
    }
    const query = `SELECT Id, Name, IsDeleted FROM ${assertSoqlIdentifier(objectApiName)} WHERE IsDeleted = true ALL ROWS`;
    return queryFn(query);
  }

  /**
   * Undelete (restore) records from the recycle bin.
   * @param recordIds - The IDs of records to restore
   * @param undeleteFn - Function that restores records by ID and returns count restored
   * @returns OperationResult with the count of restored records
   */
  async undelete(
    recordIds: string[],
    undeleteFn: (ids: string[]) => Promise<number>,
  ): Promise<OperationResult<{ restoredCount: number }>> {
    const startTime = Date.now();

    if (recordIds.length === 0) {
      return {
        success: true,
        data: { restoredCount: 0 },
        warnings: ['No record IDs provided'],
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    }

    try {
      const restoredCount = await undeleteFn(recordIds);
      return {
        success: true,
        data: { restoredCount },
        warnings: [],
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    } catch (err: unknown) {
      const errorMessage = extractErrorMessage(err);
      return {
        success: false,
        error: {
          code: 'UNDELETE_FAILED',
          message: errorMessage,
          retryable: true,
          category: 'data',
        },
        warnings: [],
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Permanently purge records from the recycle bin.
   * @param recordIds - The IDs of records to permanently delete
   * @param purgeFn - Function that purges records by ID and returns count purged
   * @returns OperationResult with the count of purged records
   */
  async purge(
    recordIds: string[],
    purgeFn: (ids: string[]) => Promise<number>,
  ): Promise<OperationResult<{ purgedCount: number }>> {
    const startTime = Date.now();

    if (recordIds.length === 0) {
      return {
        success: true,
        data: { purgedCount: 0 },
        warnings: ['No record IDs provided'],
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    }

    try {
      const purgedCount = await purgeFn(recordIds);
      return {
        success: true,
        data: { purgedCount },
        warnings: [],
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    } catch (err: unknown) {
      const errorMessage = extractErrorMessage(err);
      return {
        success: false,
        error: {
          code: 'PURGE_FAILED',
          message: errorMessage,
          retryable: true,
          category: 'data',
        },
        warnings: [],
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    }
  }
}
