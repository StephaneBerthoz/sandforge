import type {
  GrappeConfig,
  GrappePartition,
  GrappePartitionStrategy,
  GrappeProgress,
} from '@sandforge/shared';

/**
 * Generate a RFC4122 v4 UUID for partition IDs via the platform crypto primitive.
 */
export function generateId(): string {
  return globalThis.crypto.randomUUID();
}

/** Record metadata used by strategy-aware partitioning */
export interface RecordMetadata {
  id: string;
  recordTypeId?: string;
  parentId?: string;
  createdDate?: string;
  dependencies?: string[];
}

/**
 * Splits records into GrappePartition instances using configurable strategies.
 * Supports 7 partition strategies: round_robin, by_record_type, by_parent,
 * by_date_range, by_hash, by_volume, and dependency_aware.
 */
export class GrappePartitioner {
  /**
   * Record metadata resolver used by strategy-aware partitioning.
   * Maps record IDs to their metadata for grouping decisions.
   */
  private metadataMap: Map<string, RecordMetadata> = new Map();

  /**
   * Set metadata for records so strategy-aware partitioning can group them.
   * @param metadata - Array of record metadata entries
   */
  setMetadata(metadata: RecordMetadata[]): void {
    this.metadataMap.clear();
    for (const entry of metadata) {
      this.metadataMap.set(entry.id, entry);
    }
  }

  /**
   * Partition records into GrappePartition instances based on the configured strategy.
   * @param records - Array of record IDs to partition
   * @param config - Grappe configuration with strategy and sizing
   * @returns Array of GrappePartition instances
   */
  partition(records: string[], config: GrappeConfig): GrappePartition[] {
    if (records.length === 0) {
      return [];
    }

    const strategy = this.selectStrategy(config);

    switch (strategy) {
      case 'round_robin':
        return this.partitionRoundRobin(records, config);
      case 'by_record_type':
        return this.partitionByRecordType(records, config);
      case 'by_parent':
        return this.partitionByParent(records, config);
      case 'by_date_range':
        return this.partitionByDateRange(records, config);
      case 'by_hash':
        return this.partitionByHash(records, config);
      case 'by_volume':
        return this.partitionByVolume(records, config);
      case 'dependency_aware':
        return this.partitionDependencyAware(records, config);
    }
  }

  /**
   * Select the best partition strategy based on configuration.
   * Returns the explicitly configured strategy.
   * @param config - Grappe configuration
   * @returns The selected partition strategy
   */
  selectStrategy(config: GrappeConfig): GrappePartitionStrategy {
    return config.strategy;
  }

  /**
   * Calculate the number of partitions needed for a given record count and grappe size.
   * @param totalRecords - Total number of records to partition
   * @param grappeSize - Maximum records per partition
   * @returns Number of partitions needed (minimum 1 if records > 0)
   */
  getPartitionCount(totalRecords: number, grappeSize: number): number {
    if (totalRecords <= 0) {
      return 0;
    }
    return Math.ceil(totalRecords / grappeSize);
  }

  /**
   * Build a GrappePartition with default progress and status.
   */
  private buildPartition(
    index: number,
    totalPartitions: number,
    records: string[],
    dependencies: string[] = []
  ): GrappePartition {
    const progress: GrappeProgress = {
      processedRecords: 0,
      totalRecords: records.length,
      successCount: 0,
      failureCount: 0,
      percentage: 0,
      recordsPerSecond: 0,
    };

    return {
      id: generateId(),
      index,
      totalPartitions,
      recordCount: records.length,
      records,
      dependencies,
      status: 'pending',
      progress,
      retryCount: 0,
    };
  }

  /**
   * Round-robin: distribute records evenly across N partitions.
   */
  private partitionRoundRobin(
    records: string[],
    config: GrappeConfig
  ): GrappePartition[] {
    const partitionCount = this.getPartitionCount(
      records.length,
      config.grappeSize
    );
    const buckets: string[][] = Array.from(
      { length: partitionCount },
      () => []
    );

    for (let i = 0; i < records.length; i++) {
      buckets[i % partitionCount].push(records[i]);
    }

    return buckets.map((bucket, index) =>
      this.buildPartition(index, partitionCount, bucket)
    );
  }

  /**
   * By record type: group records sharing the same RecordTypeId.
   */
  private partitionByRecordType(
    records: string[],
    _config: GrappeConfig
  ): GrappePartition[] {
    const groups = new Map<string, string[]>();

    for (const recordId of records) {
      const meta = this.metadataMap.get(recordId);
      const key = meta?.recordTypeId ?? '__default__';
      const group = groups.get(key);
      if (group) {
        group.push(recordId);
      } else {
        groups.set(key, [recordId]);
      }
    }

    const entries = Array.from(groups.values());
    return entries.map((group, index) =>
      this.buildPartition(index, entries.length, group)
    );
  }

  /**
   * By parent: group records sharing the same parent reference.
   */
  private partitionByParent(
    records: string[],
    _config: GrappeConfig
  ): GrappePartition[] {
    const groups = new Map<string, string[]>();

    for (const recordId of records) {
      const meta = this.metadataMap.get(recordId);
      const key = meta?.parentId ?? '__orphan__';
      const group = groups.get(key);
      if (group) {
        group.push(recordId);
      } else {
        groups.set(key, [recordId]);
      }
    }

    const entries = Array.from(groups.values());
    return entries.map((group, index) =>
      this.buildPartition(index, entries.length, group)
    );
  }

  /**
   * By date range: split records into partitions based on CreatedDate ranges.
   */
  private partitionByDateRange(
    records: string[],
    config: GrappeConfig
  ): GrappePartition[] {
    const partitionCount = this.getPartitionCount(
      records.length,
      config.grappeSize
    );

    const datedRecords = records
      .map((id) => ({
        id,
        date: this.metadataMap.get(id)?.createdDate ?? '1970-01-01T00:00:00Z',
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const chunkSize = Math.ceil(datedRecords.length / partitionCount);
    const partitions: GrappePartition[] = [];

    for (let i = 0; i < partitionCount; i++) {
      const start = i * chunkSize;
      const chunk = datedRecords.slice(start, start + chunkSize);
      if (chunk.length > 0) {
        partitions.push(
          this.buildPartition(
            i,
            partitionCount,
            chunk.map((r) => r.id)
          )
        );
      }
    }

    return partitions;
  }

  /**
   * By hash: hash-based distribution for even spread.
   * Uses a simple string hash function to distribute records deterministically.
   */
  private partitionByHash(
    records: string[],
    config: GrappeConfig
  ): GrappePartition[] {
    const partitionCount = this.getPartitionCount(
      records.length,
      config.grappeSize
    );
    const buckets: string[][] = Array.from(
      { length: partitionCount },
      () => []
    );

    for (const recordId of records) {
      const hash = this.simpleHash(recordId);
      const bucketIndex = Math.abs(hash) % partitionCount;
      buckets[bucketIndex].push(recordId);
    }

    return buckets
      .filter((bucket) => bucket.length > 0)
      .map((bucket, index) =>
        this.buildPartition(index, partitionCount, bucket)
      );
  }

  /**
   * By volume: split records to keep each partition under grappeSize.
   */
  private partitionByVolume(
    records: string[],
    config: GrappeConfig
  ): GrappePartition[] {
    const partitions: GrappePartition[] = [];
    const totalPartitions = this.getPartitionCount(
      records.length,
      config.grappeSize
    );

    for (let i = 0; i < records.length; i += config.grappeSize) {
      const chunk = records.slice(i, i + config.grappeSize);
      partitions.push(
        this.buildPartition(partitions.length, totalPartitions, chunk)
      );
    }

    return partitions;
  }

  /**
   * Dependency-aware: respect record dependencies so children come after parents.
   * Records with dependencies are placed in later partitions than their dependencies.
   */
  private partitionDependencyAware(
    records: string[],
    config: GrappeConfig
  ): GrappePartition[] {
    const recordSet = new Set(records);
    const visited = new Set<string>();
    const waves: string[][] = [];

    const remaining = new Set(records);

    while (remaining.size > 0) {
      const wave: string[] = [];

      for (const recordId of remaining) {
        const meta = this.metadataMap.get(recordId);
        const deps = meta?.dependencies ?? [];

        const depsResolved = deps.every(
          (dep) => !recordSet.has(dep) || visited.has(dep)
        );

        if (depsResolved) {
          wave.push(recordId);
        }
      }

      if (wave.length === 0) {
        const leftover = Array.from(remaining);
        wave.push(...leftover);
        remaining.clear();
      } else {
        for (const id of wave) {
          visited.add(id);
          remaining.delete(id);
        }
      }

      waves.push(wave);
    }

    const allRecordsOrdered = waves.flat();
    const totalPartitions = this.getPartitionCount(
      allRecordsOrdered.length,
      config.grappeSize
    );
    const partitions: GrappePartition[] = [];

    for (let i = 0; i < allRecordsOrdered.length; i += config.grappeSize) {
      const chunk = allRecordsOrdered.slice(i, i + config.grappeSize);
      const deps: string[] = [];

      for (const recordId of chunk) {
        const meta = this.metadataMap.get(recordId);
        if (meta?.dependencies) {
          for (const dep of meta.dependencies) {
            if (recordSet.has(dep) && !chunk.includes(dep)) {
              deps.push(dep);
            }
          }
        }
      }

      const uniqueDeps = Array.from(new Set(deps));
      partitions.push(
        this.buildPartition(
          partitions.length,
          totalPartitions,
          chunk,
          uniqueDeps
        )
      );
    }

    return partitions;
  }

  /**
   * Simple deterministic hash for a string.
   * @param str - Input string to hash
   * @returns Numeric hash value
   */
  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0;
    }
    return hash;
  }
}
