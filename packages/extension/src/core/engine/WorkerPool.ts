/** A task to be executed by the worker pool */
export interface WorkerTask {
  id: string;
  name: string;
  execute: () => Promise<unknown>;
}

/** Status of the worker pool */
export interface PoolStatus {
  maxWorkers: number;
  activeWorkers: number;
  idleWorkers: number;
  queuedTasks: number;
  completedTasks: number;
  failedTasks: number;
  isShutdown: boolean;
}

/** Internal worker slot */
interface WorkerSlot {
  id: number;
  busy: boolean;
}

/**
 * Promise-based concurrency pool for CPU-intensive tasks.
 *
 * In the VSCode extension context, actual worker_threads are not used.
 * Instead, this manages concurrent Promise execution with a configurable
 * concurrency limit to avoid overwhelming the event loop.
 */
export class WorkerPool {
  private readonly maxWorkers: number;
  private workers: WorkerSlot[];
  private taskQueue: Array<{
    task: WorkerTask;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }> = [];
  private completedCount = 0;
  private failedCount = 0;
  private isShutdown = false;

  constructor(maxWorkers: number = 4) {
    this.maxWorkers = Math.max(1, maxWorkers);
    this.workers = Array.from({ length: this.maxWorkers }, (_, i) => ({
      id: i,
      busy: false,
    }));
  }

  /** Execute a task, queuing it if all workers are busy */
  async execute<T>(task: WorkerTask): Promise<T> {
    if (this.isShutdown) {
      throw new Error(
        'Worker pool is shut down and cannot accept new tasks. Create a new WorkerPool instance to continue.',
      );
    }

    const idleWorker = this.workers.find((w) => !w.busy);

    if (idleWorker) {
      return this.runOnWorker<T>(idleWorker, task);
    }

    // Queue the task and wait for a worker to become available
    return new Promise<T>((resolve, reject) => {
      this.taskQueue.push({
        task,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
    });
  }

  /** Get the current pool status */
  getStatus(): PoolStatus {
    const activeWorkers = this.workers.filter((w) => w.busy).length;
    return {
      maxWorkers: this.maxWorkers,
      activeWorkers,
      idleWorkers: this.maxWorkers - activeWorkers,
      queuedTasks: this.taskQueue.length,
      completedTasks: this.completedCount,
      failedTasks: this.failedCount,
      isShutdown: this.isShutdown,
    };
  }

  /** Shutdown the pool, waiting for active tasks to complete */
  async shutdown(): Promise<void> {
    this.isShutdown = true;

    // Reject all queued tasks
    for (const queued of this.taskQueue) {
      queued.reject(new Error('Worker pool is shutting down'));
    }
    this.taskQueue = [];

    // Wait for active workers to finish
    await this.waitForIdle();
  }

  /** Check if the pool has been shut down */
  get shutdown_status(): boolean {
    return this.isShutdown;
  }

  /** Get the number of active workers */
  get activeCount(): number {
    return this.workers.filter((w) => w.busy).length;
  }

  /** Get the number of queued tasks */
  get queuedCount(): number {
    return this.taskQueue.length;
  }

  /** Run a task on a specific worker slot */
  private async runOnWorker<T>(worker: WorkerSlot, task: WorkerTask): Promise<T> {
    worker.busy = true;

    try {
      const result = await task.execute();
      this.completedCount++;
      return result as T;
    } catch (err) {
      this.failedCount++;
      throw err;
    } finally {
      worker.busy = false;
      this.processNextTask();
    }
  }

  /** Process the next queued task if a worker is available */
  private processNextTask(): void {
    if (this.taskQueue.length === 0) return;

    const idleWorker = this.workers.find((w) => !w.busy);
    if (!idleWorker) return;

    const queued = this.taskQueue.shift();
    if (!queued) return;

    this.runOnWorker(idleWorker, queued.task).then(queued.resolve).catch(queued.reject);
  }

  /** Wait until all workers are idle */
  private async waitForIdle(): Promise<void> {
    while (this.workers.some((w) => w.busy)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
