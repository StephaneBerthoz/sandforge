/**
 * AutopilotGrappeAdapter — Splits an object's records into OFFSET/LIMIT
 * partitions.
 *
 * Nothing on the autopilot path calls {@link AutopilotGrappeAdapter.partition}:
 * `AutopilotOrchestrator.executePlan` runs the plan unchanged and only brackets
 * it with `grappe:started` and `grappe:completed`. The partitioning here is
 * kept for the day a run walks its partitions, one after another, and reports
 * each one.
 */

import type { ApiName } from '@sandforge/shared';

/** A partition of autopilot work. */
export interface AutopilotPartition {
  /** Unique identifier for this partition. */
  readonly id: string;
  /** Object API name being partitioned. */
  readonly objectApiName: ApiName;
  /** SOQL OFFSET for this partition. */
  readonly offset: number;
  /** SOQL LIMIT for this partition. */
  readonly limit: number;
  /** Number of records in this partition. */
  readonly recordCount: number;
}

/** Splits large objects into partitions when the record count exceeds a threshold. */
export class AutopilotGrappeAdapter {
  private readonly threshold: number;
  private readonly partitionSize: number;

  /**
   * @param threshold - Record count above which Grappe mode is activated.
   * @param partitionSize - Maximum records per partition.
   */
  constructor(threshold: number = 5000, partitionSize: number = 2000) {
    this.threshold = threshold;
    this.partitionSize = partitionSize;
  }

  /**
   * Check if an object should use Grappe mode based on record count.
   * @param recordCount - Number of records for the object.
   * @returns True if the record count exceeds the threshold.
   */
  shouldUseGrappe(recordCount: number): boolean {
    return recordCount > this.threshold;
  }

  /**
   * Partition an object into consecutive chunks.
   * @param objectApiName - The Salesforce object API name.
   * @param recordCount - Total number of records for the object.
   * @returns Array of partitions covering all records with no gaps or overlaps.
   */
  partition(objectApiName: ApiName, recordCount: number): AutopilotPartition[] {
    if (recordCount <= this.partitionSize) {
      return [
        {
          id: `${objectApiName}-0`,
          objectApiName,
          offset: 0,
          limit: recordCount,
          recordCount,
        },
      ];
    }

    const partitions: AutopilotPartition[] = [];
    let offset = 0;
    let index = 0;

    while (offset < recordCount) {
      const limit = Math.min(this.partitionSize, recordCount - offset);
      partitions.push({
        id: `${objectApiName}-${index}`,
        objectApiName,
        offset,
        limit,
        recordCount: limit,
      });
      offset += limit;
      index++;
    }

    return partitions;
  }

  /**
   * Get the configured threshold.
   * @returns The record count threshold for Grappe activation.
   */
  getThreshold(): number {
    return this.threshold;
  }

  /**
   * Get the configured partition size.
   * @returns The maximum records per partition.
   */
  getPartitionSize(): number {
    return this.partitionSize;
  }
}
