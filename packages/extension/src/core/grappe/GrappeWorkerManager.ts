import type { GrappePartition, GrappeResult, GrappeWorkerStatus } from '@sandforge/shared';

/** Internal representation of a virtual worker */
interface Worker {
  id: number;
  active: boolean;
  currentGrappeId?: string;
  processedGrappes: number;
  queuedGrappes: number;
}

/**
 * Manages a virtual worker pool for grappe partition processing.
 * Workers are logical units that track assignment and completion of partitions.
 */
export class GrappeWorkerManager {
  private workers: Map<number, Worker> = new Map();

  /**
   * Create a pool of virtual workers.
   * Clears any existing workers and creates fresh ones.
   * @param count - Number of workers to create
   */
  createWorkers(count: number): void {
    this.workers.clear();
    for (let i = 0; i < count; i++) {
      this.workers.set(i, {
        id: i,
        active: false,
        processedGrappes: 0,
        queuedGrappes: 0,
      });
    }
  }

  /**
   * Assign a partition to the first available worker.
   * @param partition - The partition to assign
   * @returns The worker ID the partition was assigned to
   * @throws Error if no workers are available
   */
  assignPartition(partition: GrappePartition): number {
    for (const [workerId, worker] of this.workers) {
      if (!worker.active) {
        worker.active = true;
        worker.currentGrappeId = partition.id;
        worker.queuedGrappes++;
        return workerId;
      }
    }
    throw new Error(
      'No available workers to assign partition. All workers are busy — wait for a worker to complete or increase maxWorkers in Grappe settings.',
    );
  }

  /**
   * Release a worker back to the pool, marking it as inactive.
   * @param workerId - The ID of the worker to release
   * @throws Error if the worker does not exist
   */
  releaseWorker(workerId: number): void {
    const worker = this.workers.get(workerId);
    if (!worker) {
      throw new Error(`Worker ${workerId} does not exist`);
    }
    worker.active = false;
    worker.currentGrappeId = undefined;
    worker.processedGrappes++;
    if (worker.queuedGrappes > 0) {
      worker.queuedGrappes--;
    }
  }

  /**
   * Get the status of a specific worker.
   * @param workerId - The ID of the worker
   * @returns The worker status
   * @throws Error if the worker does not exist
   */
  getWorkerStatus(workerId: number): GrappeWorkerStatus {
    const worker = this.workers.get(workerId);
    if (!worker) {
      throw new Error(`Worker ${workerId} does not exist`);
    }
    return this.toWorkerStatus(worker);
  }

  /**
   * Get statuses for all workers in the pool.
   * @returns Array of worker status objects
   */
  getAllWorkerStatuses(): GrappeWorkerStatus[] {
    return Array.from(this.workers.values()).map((w) => this.toWorkerStatus(w));
  }

  /**
   * Get the count of workers currently not assigned to a partition.
   * @returns Number of available workers
   */
  getAvailableWorkerCount(): number {
    let count = 0;
    for (const worker of this.workers.values()) {
      if (!worker.active) {
        count++;
      }
    }
    return count;
  }

  /**
   * Process a partition on a specific worker using the provided processing function.
   * The worker is automatically released after processing completes (success or failure).
   * @param workerId - The worker to use for processing
   * @param partition - The partition to process
   * @param processFn - Async function that processes the partition's records
   * @returns The result of processing the partition
   */
  async processPartition(
    workerId: number,
    partition: GrappePartition,
    processFn: (records: string[]) => Promise<GrappeResult>,
  ): Promise<GrappeResult> {
    const worker = this.workers.get(workerId);
    if (!worker) {
      throw new Error(`Worker ${workerId} does not exist`);
    }

    try {
      const result = await processFn(partition.records);
      return result;
    } finally {
      this.releaseWorker(workerId);
    }
  }

  /**
   * Convert internal Worker to public GrappeWorkerStatus.
   */
  private toWorkerStatus(worker: Worker): GrappeWorkerStatus {
    return {
      workerId: worker.id,
      active: worker.active,
      currentGrappeId: worker.currentGrappeId,
      processedGrappes: worker.processedGrappes,
      queuedGrappes: worker.queuedGrappes,
    };
  }
}
