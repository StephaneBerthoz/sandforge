import type {
  AggregatedGrappeResult,
  GrappePartition,
  GrappeProgress,
  GrappeResult,
  UUID,
} from '@sandforge/shared';

/**
 * Aggregates results from multiple grappe partition executions.
 * Tracks partial results and computes overall progress and summaries.
 */
export class GrappeAggregator {
  private results: GrappeResult[] = [];
  private startTime: number = Date.now();

  /**
   * Add a single partition result to the aggregation.
   * @param result - The result from a completed partition
   */
  addResult(result: GrappeResult): void {
    this.results.push(result);
  }

  /**
   * Aggregate all collected results into a single AggregatedGrappeResult.
   * @param operationId - The UUID of the overall operation
   * @returns The aggregated result containing all partition outcomes
   */
  aggregate(operationId: UUID): AggregatedGrappeResult {
    const completedPartitions = this.results.filter(
      (r) => r.status === 'success' || r.status === 'partial'
    ).length;
    const failedPartitions = this.results.filter(
      (r) => r.status === 'failure'
    ).length;

    let totalRecords = 0;
    let successRecords = 0;
    let failedRecords = 0;
    let totalDuration = 0;

    for (const result of this.results) {
      totalRecords += result.processedRecords;
      successRecords += result.successCount;
      failedRecords += result.failureCount;
      totalDuration = Math.max(totalDuration, result.duration);
    }

    const elapsed = Date.now() - this.startTime;
    const duration = totalDuration > 0 ? totalDuration : elapsed;

    return {
      operationId,
      totalPartitions: this.results.length,
      completedPartitions,
      failedPartitions,
      totalRecords,
      successRecords,
      failedRecords,
      duration,
      partitionResults: [...this.results],
    };
  }

  /**
   * Get a copy of all results collected so far.
   * Useful for monitoring progress before final aggregation.
   * @returns Array of partition results
   */
  getPartialResults(): GrappeResult[] {
    return [...this.results];
  }

  /**
   * Compute overall progress across all partitions.
   * @param partitions - All partitions in the operation
   * @returns Aggregated progress summary
   */
  getOverallProgress(partitions: GrappePartition[]): GrappeProgress {
    let processedRecords = 0;
    let totalRecords = 0;
    let successCount = 0;
    let failureCount = 0;
    let totalRecordsPerSecond = 0;

    for (const partition of partitions) {
      processedRecords += partition.progress.processedRecords;
      totalRecords += partition.progress.totalRecords;
      successCount += partition.progress.successCount;
      failureCount += partition.progress.failureCount;
      totalRecordsPerSecond += partition.progress.recordsPerSecond;
    }

    const percentage =
      totalRecords > 0 ? (processedRecords / totalRecords) * 100 : 0;

    return {
      processedRecords,
      totalRecords,
      successCount,
      failureCount,
      percentage,
      recordsPerSecond: totalRecordsPerSecond,
    };
  }

  /**
   * Reset the aggregator, clearing all collected results.
   */
  reset(): void {
    this.results = [];
    this.startTime = Date.now();
  }
}
