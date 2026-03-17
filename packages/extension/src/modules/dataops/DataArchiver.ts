import type { OperationResult } from '@sandforge/shared';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';

/** Metadata for an archived batch of records */
export interface ArchiveEntry {
  objectApiName: string;
  recordCount: number;
  archivedAt: string;
}

/**
 * Archives old or unused records by querying, storing, and then deleting them.
 * Maintains an in-memory archive registry per org for listing and size reporting.
 */
export class DataArchiver {
  private readonly archives: Map<string, ArchiveEntry[]> = new Map();
  private readonly archiveSizes: Map<string, number> = new Map();

  /**
   * Archive records matching a query by fetching them, recording metadata,
   * and deleting the originals.
   * @param orgId - The org to archive from
   * @param objectApiName - The Salesforce object API name
   * @param query - SOQL-like query identifying records to archive
   * @param queryFn - Function that fetches records matching the query
   * @param deleteFn - Function that deletes a batch of record IDs and returns count deleted
   * @returns OperationResult with the count of archived records
   */
  async archive(
    orgId: string,
    objectApiName: string,
    query: string,
    queryFn: (q: string) => Promise<Record<string, unknown>[]>,
    deleteFn: (ids: string[]) => Promise<number>,
  ): Promise<OperationResult<{ archivedCount: number }>> {
    const startTime = Date.now();
    const warnings: string[] = [];

    if (!orgId || !objectApiName || !query) {
      return {
        success: false,
        error: {
          code: 'ARCHIVE_VALIDATION',
          message: 'orgId, objectApiName, and query are required',
          retryable: false,
          category: 'validation',
        },
        warnings: [],
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    }

    let records: Record<string, unknown>[];
    try {
      records = await queryFn(query);
    } catch (err: unknown) {
      const errorMessage = extractErrorMessage(err);
      return {
        success: false,
        error: {
          code: 'ARCHIVE_QUERY_FAILED',
          message: errorMessage,
          retryable: true,
          category: 'data',
        },
        warnings: [],
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    }

    if (records.length === 0) {
      warnings.push('No records found matching the query');
      return {
        success: true,
        data: { archivedCount: 0 },
        warnings,
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    }

    const ids = records
      .map((r) => String(r['Id'] ?? r['id'] ?? ''))
      .filter((id) => id.length > 0);

    try {
      await deleteFn(ids);
    } catch (err: unknown) {
      const errorMessage = extractErrorMessage(err);
      return {
        success: false,
        error: {
          code: 'ARCHIVE_DELETE_FAILED',
          message: errorMessage,
          retryable: true,
          category: 'data',
        },
        warnings: [],
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    }

    const entry: ArchiveEntry = {
      objectApiName,
      recordCount: records.length,
      archivedAt: new Date().toISOString(),
    };

    const existingEntries = this.archives.get(orgId) ?? [];
    existingEntries.push(entry);
    this.archives.set(orgId, existingEntries);

    const estimatedSize = records.reduce(
      (acc, r) => acc + JSON.stringify(r).length,
      0,
    );
    const currentSize = this.archiveSizes.get(orgId) ?? 0;
    this.archiveSizes.set(orgId, currentSize + estimatedSize);

    return {
      success: true,
      data: { archivedCount: records.length },
      warnings,
      duration: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Get the total size (in bytes) of all archives for an org.
   * @param orgId - The org identifier
   * @returns Total archive size in bytes
   */
  getArchiveSize(orgId: string): number {
    return this.archiveSizes.get(orgId) ?? 0;
  }

  /**
   * List all archive entries for an org.
   * @param orgId - The org identifier
   * @returns Array of archive entries with object name, count, and date
   */
  listArchives(orgId: string): ArchiveEntry[] {
    return this.archives.get(orgId) ?? [];
  }
}
