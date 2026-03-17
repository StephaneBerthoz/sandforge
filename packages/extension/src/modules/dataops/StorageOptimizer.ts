import type { StorageRecommendation } from '@sandforge/shared';

/** Input statistics for a single Salesforce object */
export interface ObjectStats {
  objectApiName: string;
  recordCount: number;
  size: number;
}

/** Minimal stats for top consumer analysis */
export interface ObjectSizeStats {
  objectApiName: string;
  size: number;
}

/**
 * Analyzes Salesforce org storage usage and produces optimization
 * recommendations such as archiving, deleting, compressing, or
 * optimizing objects based on record count and size thresholds.
 */
export class StorageOptimizer {
  private static readonly LARGE_RECORD_THRESHOLD = 100000;
  private static readonly LARGE_SIZE_THRESHOLD = 50_000_000;
  private static readonly MEDIUM_RECORD_THRESHOLD = 10000;
  private static readonly SMALL_SIZE_THRESHOLD = 1_000_000;

  /**
   * Analyze all objects for an org and produce storage recommendations.
   * @param _orgId - The org identifier (used for context; analysis is based on objectStats)
   * @param objectStats - Array of per-object statistics
   * @returns Array of storage recommendations
   */
  analyze(
    _orgId: string,
    objectStats: ObjectStats[],
  ): StorageRecommendation[] {
    const recommendations: StorageRecommendation[] = [];

    for (const stat of objectStats) {
      const recommendation = this.classifyObject(stat);
      if (recommendation) {
        recommendations.push(recommendation);
      }
    }

    return recommendations;
  }

  /**
   * Get the top storage consumers sorted by size descending.
   * @param objectStats - Array of per-object size statistics
   * @param limit - Maximum number of results to return
   * @returns The top N objects by size
   */
  getTopConsumers(
    objectStats: ObjectSizeStats[],
    limit: number,
  ): ObjectSizeStats[] {
    return [...objectStats]
      .sort((a, b) => b.size - a.size)
      .slice(0, Math.max(0, limit));
  }

  /**
   * Estimate the total bytes that could be saved by applying all recommendations.
   * @param recommendations - The recommendations to aggregate
   * @returns Total estimated savings in bytes
   */
  estimateSavings(recommendations: StorageRecommendation[]): number {
    return recommendations.reduce(
      (total, rec) => total + rec.estimatedSaving,
      0,
    );
  }

  private classifyObject(stat: ObjectStats): StorageRecommendation | null {
    if (
      stat.recordCount > StorageOptimizer.LARGE_RECORD_THRESHOLD &&
      stat.size > StorageOptimizer.LARGE_SIZE_THRESHOLD
    ) {
      return {
        objectApiName: stat.objectApiName,
        currentRecords: stat.recordCount,
        currentSize: stat.size,
        recommendation: 'archive',
        estimatedSaving: Math.round(stat.size * 0.7),
        reason: 'High record count and large size — archiving old records recommended',
      };
    }

    if (stat.recordCount > StorageOptimizer.LARGE_RECORD_THRESHOLD) {
      return {
        objectApiName: stat.objectApiName,
        currentRecords: stat.recordCount,
        currentSize: stat.size,
        recommendation: 'delete',
        estimatedSaving: Math.round(stat.size * 0.5),
        reason: 'High record count — consider deleting obsolete records',
      };
    }

    if (stat.size > StorageOptimizer.LARGE_SIZE_THRESHOLD) {
      return {
        objectApiName: stat.objectApiName,
        currentRecords: stat.recordCount,
        currentSize: stat.size,
        recommendation: 'compress',
        estimatedSaving: Math.round(stat.size * 0.4),
        reason: 'Large object size — compression recommended',
      };
    }

    if (
      stat.recordCount > StorageOptimizer.MEDIUM_RECORD_THRESHOLD &&
      stat.size < StorageOptimizer.SMALL_SIZE_THRESHOLD
    ) {
      return {
        objectApiName: stat.objectApiName,
        currentRecords: stat.recordCount,
        currentSize: stat.size,
        recommendation: 'optimize',
        estimatedSaving: Math.round(stat.size * 0.2),
        reason: 'Many records but small size — index optimization recommended',
      };
    }

    return null;
  }
}
