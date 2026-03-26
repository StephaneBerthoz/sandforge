import type { QuickSyncPreview, QuickSyncObjectPreview } from '@sandforge/shared';

/** Record count result for a single object from COUNT() query. */
export interface RecordCountResult {
  /** Salesforce object API name. */
  objectApiName: string;
  /** Number of records. */
  count: number;
}

/** Default batch size for API call estimation. */
const DEFAULT_BATCH_SIZE = 200;

/** Rough estimate of seconds per API call batch. */
const SECONDS_PER_API_CALL = 2;

/**
 * Estimates Quick Sync execution costs: record counts, API calls, and duration.
 *
 * Used by the Quick Sync preview screen (QSYNC-05) to show the user
 * what will happen before they confirm execution.
 */
export class QuickSyncPreviewEstimator {
  /**
   * Estimate preview data for Quick Sync.
   *
   * @param recordCounts - Record counts per object (from COUNT() queries).
   * @param parentObjects - Set of object names that are auto-detected parents.
   * @param batchSize - Batch size for API call estimation (default 200).
   * @returns Full preview including per-object details and totals.
   */
  estimate(
    recordCounts: RecordCountResult[],
    parentObjects: Set<string> = new Set(),
    batchSize: number = DEFAULT_BATCH_SIZE,
  ): QuickSyncPreview {
    const effectiveBatchSize = batchSize > 0 ? batchSize : DEFAULT_BATCH_SIZE;

    const objects: QuickSyncObjectPreview[] = recordCounts.map((rc) => ({
      objectApiName: rc.objectApiName,
      recordCount: rc.count,
      estimatedApiCalls: rc.count > 0 ? Math.ceil(rc.count / effectiveBatchSize) : 0,
      isParentDependency: parentObjects.has(rc.objectApiName),
    }));

    const totalRecords = objects.reduce((sum, o) => sum + o.recordCount, 0);
    const totalApiCalls = objects.reduce((sum, o) => sum + o.estimatedApiCalls, 0);
    const estimatedDurationSec = totalApiCalls * SECONDS_PER_API_CALL;

    return {
      objects,
      totalRecords,
      totalApiCalls,
      estimatedDurationSec,
    };
  }
}
