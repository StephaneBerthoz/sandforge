import type {
  SyncConfig,
  GrappePartition,
  GrappeResult,
  AggregatedGrappeResult,
} from '@sandforge/shared';

/**
 * Adapts sync operations for grappe (cluster) mode processing.
 * Partitions large datasets into smaller chunks for parallel processing
 * and aggregates results from individual partitions.
 */
export class SyncGrappeAdapter {
  /**
   * Partition records into grappe chunks based on the sync configuration.
   * Each partition contains a subset of records for a specific object,
   * sized according to the batch size in the object config.
   */
  partition(
    config: SyncConfig,
    records: Map<string, Record<string, unknown>[]>
  ): GrappePartition[] {
    const partitions: GrappePartition[] = [];
    let globalIndex = 0;

    for (const objectConfig of config.objects) {
      const objectRecords = records.get(objectConfig.objectApiName);
      if (!objectRecords || objectRecords.length === 0) {
        continue;
      }

      const chunkSize = objectConfig.batchSize > 0 ? objectConfig.batchSize : 200;
      const chunks = splitIntoChunks(objectRecords, chunkSize);

      for (const chunk of chunks) {
        const recordIds = chunk
          .map((r) => String(r.Id ?? ''))
          .filter((id) => id.length > 0);

        partitions.push({
          id: `partition-${globalIndex}`,
          index: globalIndex,
          totalPartitions: 0,
          recordCount: chunk.length,
          records: recordIds,
          dependencies: buildDependencies(objectConfig.insertOrder, partitions),
          status: 'pending',
          progress: {
            processedRecords: 0,
            totalRecords: chunk.length,
            successCount: 0,
            failureCount: 0,
            percentage: 0,
            recordsPerSecond: 0,
          },
          retryCount: 0,
        });

        globalIndex++;
      }
    }

    for (const partition of partitions) {
      partition.totalPartitions = partitions.length;
    }

    return partitions;
  }

  /**
   * Aggregate results from individual grappe partitions into a single result.
   * Computes totals for records processed, succeeded, and failed.
   */
  aggregateResults(partitionResults: GrappeResult[]): AggregatedGrappeResult {
    let totalRecords = 0;
    let successRecords = 0;
    let failedRecords = 0;
    let totalDuration = 0;
    let completedPartitions = 0;
    let failedPartitions = 0;

    for (const result of partitionResults) {
      totalRecords += result.processedRecords;
      successRecords += result.successCount;
      failedRecords += result.failureCount;
      totalDuration = Math.max(totalDuration, result.duration);

      if (result.status === 'success' || result.status === 'partial') {
        completedPartitions++;
      }
      if (result.status === 'failure') {
        failedPartitions++;
      }
    }

    return {
      operationId: `grappe-op-${Date.now()}`,
      totalPartitions: partitionResults.length,
      completedPartitions,
      failedPartitions,
      totalRecords,
      successRecords,
      failedRecords,
      duration: totalDuration,
      partitionResults,
    };
  }
}

/**
 * Split an array into chunks of the specified size.
 */
function splitIntoChunks<T>(items: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Build partition dependency list based on insert order.
 * Partitions for objects with lower insert order are dependencies.
 */
function buildDependencies(
  insertOrder: number,
  existingPartitions: GrappePartition[]
): string[] {
  if (insertOrder <= 1) {
    return [];
  }

  return existingPartitions
    .filter((p) => p.index < existingPartitions.length)
    .map((p) => p.id)
    .slice(-1);
}
