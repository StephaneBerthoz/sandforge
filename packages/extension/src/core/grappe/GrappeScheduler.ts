import type { GrappePartition } from '@sandforge/shared';

/**
 * Schedules grappe partition execution respecting inter-partition dependencies.
 * Produces execution waves where all partitions in a wave can run in parallel,
 * and each wave completes before the next begins.
 */
export class GrappeScheduler {
  /**
   * Organize partitions into sequential execution waves.
   * Partitions with no unresolved dependencies are placed in the earliest possible wave.
   * @param partitions - All partitions to schedule
   * @returns Array of waves, each wave containing partitions that can execute in parallel
   */
  schedule(partitions: GrappePartition[]): GrappePartition[][] {
    if (partitions.length === 0) {
      return [];
    }

    const waves: GrappePartition[][] = [];
    const completed = new Set<string>();
    const remaining = new Set(partitions.map((p) => p.id));
    const partitionMap = new Map(partitions.map((p) => [p.id, p]));

    while (remaining.size > 0) {
      const wave: GrappePartition[] = [];

      for (const id of remaining) {
        const partition = partitionMap.get(id);
        if (partition && this.canExecute(partition, completed)) {
          wave.push(partition);
        }
      }

      if (wave.length === 0) {
        const leftover: GrappePartition[] = [];
        for (const id of remaining) {
          const partition = partitionMap.get(id);
          if (partition) {
            leftover.push(partition);
          }
        }
        waves.push(leftover);
        break;
      }

      for (const partition of wave) {
        completed.add(partition.id);
        remaining.delete(partition.id);
      }

      waves.push(wave);
    }

    return waves;
  }

  /**
   * Get the next batch of partitions that can execute given currently completed partitions.
   * @param partitions - All partitions in the operation
   * @param completed - Set of partition IDs that have already completed
   * @returns Partitions ready for execution
   */
  getNextBatch(
    partitions: GrappePartition[],
    completed: Set<string>
  ): GrappePartition[] {
    return partitions.filter(
      (p) =>
        p.status === 'pending' &&
        !completed.has(p.id) &&
        this.canExecute(p, completed)
    );
  }

  /**
   * Determine whether a partition can execute given the set of completed partition IDs.
   * A partition can execute if all its dependencies are in the completed set.
   * @param partition - The partition to check
   * @param completed - Set of completed partition IDs
   * @returns True if the partition's dependencies are satisfied
   */
  canExecute(
    partition: GrappePartition,
    completed: Set<string>
  ): boolean {
    if (partition.dependencies.length === 0) {
      return true;
    }
    return partition.dependencies.every((dep) => completed.has(dep));
  }

  /**
   * Reorder partitions by priority: those with no dependencies first,
   * then by fewest dependencies, then by smallest record count.
   * @param partitions - Partitions to reorder
   * @returns New array sorted by priority
   */
  reorderByPriority(partitions: GrappePartition[]): GrappePartition[] {
    return [...partitions].sort((a, b) => {
      const depDiff = a.dependencies.length - b.dependencies.length;
      if (depDiff !== 0) {
        return depDiff;
      }
      return a.recordCount - b.recordCount;
    });
  }
}
