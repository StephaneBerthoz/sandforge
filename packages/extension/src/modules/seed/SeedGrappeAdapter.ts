import type {
  SeedTemplate,
  GrappePartition,
  GrappeResult,
  AggregatedGrappeResult,
  UUID,
} from '@sandforge/shared';

/** Function signature for generating unique IDs */
export type GenerateIdFn = () => UUID;

/** Default grappe (partition) size in records */
const DEFAULT_GRAPPE_SIZE = 2000;

/**
 * Adapts seed operations for grappe (parallel partitioned) mode.
 * Splits seed template objects into partitions that respect
 * insert order and dependency chains, then aggregates results.
 */
export class SeedGrappeAdapter {
  private readonly generateId: GenerateIdFn;
  private readonly grappeSize: number;

  constructor(generateId: GenerateIdFn, grappeSize?: number) {
    this.generateId = generateId;
    this.grappeSize = grappeSize ?? DEFAULT_GRAPPE_SIZE;
  }

  /**
   * Partition a seed template's objects into grappe partitions.
   * Each object is split into partitions of grappeSize, preserving
   * dependency ordering via partition dependencies.
   */
  partition(template: SeedTemplate): GrappePartition[] {
    const sortedObjects = sortByInsertOrder(template.objects);
    const partitions: GrappePartition[] = [];
    const objectPartitionIds = new Map<string, string[]>();

    for (const obj of sortedObjects) {
      const objectPartitions = splitObject(
        obj.objectApiName,
        obj.recordCount,
        this.grappeSize,
        this.generateId
      );

      const deps = extractDependencyPartitionIds(obj, objectPartitionIds);

      const partitionIds: string[] = [];
      let partitionIndex = partitions.length;

      for (const partition of objectPartitions) {
        const fullPartition: GrappePartition = {
          ...partition,
          index: partitionIndex,
          totalPartitions: 0,
          dependencies: deps,
          status: 'pending',
          progress: {
            processedRecords: 0,
            totalRecords: partition.recordCount,
            successCount: 0,
            failureCount: 0,
            percentage: 0,
            recordsPerSecond: 0,
          },
          retryCount: 0,
        };

        partitions.push(fullPartition);
        partitionIds.push(partition.id);
        partitionIndex++;
      }

      objectPartitionIds.set(obj.objectApiName, partitionIds);
    }

    for (const partition of partitions) {
      partition.totalPartitions = partitions.length;
    }

    return partitions;
  }

  /**
   * Aggregate results from all partition executions into a single result.
   */
  aggregateResults(partitionResults: GrappeResult[]): AggregatedGrappeResult {
    let successRecords = 0;
    let failedRecords = 0;
    let totalDuration = 0;
    let completedPartitions = 0;
    let failedPartitions = 0;

    for (const result of partitionResults) {
      successRecords += result.successCount;
      failedRecords += result.failureCount;
      totalDuration = Math.max(totalDuration, result.duration);

      if (result.status === 'success') {
        completedPartitions++;
      } else if (result.status === 'failure') {
        failedPartitions++;
      } else {
        completedPartitions++;
      }
    }

    return {
      operationId: this.generateId(),
      totalPartitions: partitionResults.length,
      completedPartitions,
      failedPartitions,
      totalRecords: successRecords + failedRecords,
      successRecords,
      failedRecords,
      duration: totalDuration,
      partitionResults,
    };
  }
}

/** Sort objects by insertOrder ascending */
function sortByInsertOrder(
  objects: SeedTemplate['objects']
): SeedTemplate['objects'] {
  return [...objects].sort((a, b) => a.insertOrder - b.insertOrder);
}

/** Split an object's records into multiple partitions */
function splitObject(
  objectApiName: string,
  recordCount: number,
  grappeSize: number,
  generateId: GenerateIdFn
): Array<{ id: string; recordCount: number; records: string[] }> {
  const partitions: Array<{ id: string; recordCount: number; records: string[] }> = [];
  let remaining = recordCount;

  while (remaining > 0) {
    const size = Math.min(remaining, grappeSize);
    partitions.push({
      id: generateId(),
      recordCount: size,
      records: generatePlaceholderRecordIds(objectApiName, size, recordCount - remaining),
    });
    remaining -= size;
  }

  return partitions;
}

/** Generate placeholder record identifiers for partition tracking */
function generatePlaceholderRecordIds(
  objectApiName: string,
  count: number,
  offset: number
): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(`${objectApiName}:${offset + i}`);
  }
  return ids;
}

/** Get partition IDs of dependency objects */
function extractDependencyPartitionIds(
  obj: SeedTemplate['objects'][number],
  objectPartitionIds: Map<string, string[]>
): string[] {
  const deps: string[] = [];

  for (const rule of obj.fieldRules) {
    if (rule.ruleType === 'reference' && rule.config.referenceObject) {
      const partitionIds = objectPartitionIds.get(rule.config.referenceObject);
      if (partitionIds) {
        deps.push(...partitionIds);
      }
    }
  }

  return [...new Set(deps)];
}
