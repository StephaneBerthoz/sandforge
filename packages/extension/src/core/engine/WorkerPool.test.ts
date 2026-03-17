import { describe, it, expect, beforeEach } from 'vitest';
import { WorkerPool } from './WorkerPool';
import type { WorkerTask } from './WorkerPool';

function createTask(id: string, result: unknown = 'done', delayMs: number = 0): WorkerTask {
  return {
    id,
    name: `Task ${id}`,
    execute: () =>
      new Promise((resolve) => {
        if (delayMs > 0) {
          setTimeout(() => resolve(result), delayMs);
        } else {
          resolve(result);
        }
      }),
  };
}

function createFailingTask(id: string, error: string = 'Task failed'): WorkerTask {
  return {
    id,
    name: `Failing Task ${id}`,
    execute: () => Promise.reject(new Error(error)),
  };
}

describe('WorkerPool', () => {
  let pool: WorkerPool;

  beforeEach(() => {
    pool = new WorkerPool(2);
  });

  describe('constructor', () => {
    it('should create a pool with the specified max workers', () => {
      const status = pool.getStatus();
      expect(status.maxWorkers).toBe(2);
      expect(status.idleWorkers).toBe(2);
      expect(status.activeWorkers).toBe(0);
    });

    it('should default to 4 workers', () => {
      const defaultPool = new WorkerPool();
      expect(defaultPool.getStatus().maxWorkers).toBe(4);
    });

    it('should enforce minimum of 1 worker', () => {
      const minPool = new WorkerPool(0);
      expect(minPool.getStatus().maxWorkers).toBe(1);
    });
  });

  describe('execute', () => {
    it('should execute a task and return the result', async () => {
      const result = await pool.execute<string>(createTask('t1', 'hello'));
      expect(result).toBe('hello');
    });

    it('should track completed tasks', async () => {
      await pool.execute(createTask('t1'));
      await pool.execute(createTask('t2'));

      const status = pool.getStatus();
      expect(status.completedTasks).toBe(2);
    });

    it('should track failed tasks', async () => {
      await expect(pool.execute(createFailingTask('t1'))).rejects.toThrow('Task failed');

      const status = pool.getStatus();
      expect(status.failedTasks).toBe(1);
    });

    it('should queue tasks when all workers are busy', async () => {
      const results: string[] = [];

      const p1 = pool.execute<string>(createTask('t1', 'r1', 50));
      const p2 = pool.execute<string>(createTask('t2', 'r2', 50));
      const p3 = pool.execute<string>(createTask('t3', 'r3', 10));

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      results.push(r1, r2, r3);

      expect(results).toContain('r1');
      expect(results).toContain('r2');
      expect(results).toContain('r3');
      expect(pool.getStatus().completedTasks).toBe(3);
    });

    it('should reject when pool is shut down', async () => {
      await pool.shutdown();

      await expect(pool.execute(createTask('t1'))).rejects.toThrow('shut down');
    });
  });

  describe('getStatus', () => {
    it('should return correct initial status', () => {
      const status = pool.getStatus();

      expect(status.maxWorkers).toBe(2);
      expect(status.activeWorkers).toBe(0);
      expect(status.idleWorkers).toBe(2);
      expect(status.queuedTasks).toBe(0);
      expect(status.completedTasks).toBe(0);
      expect(status.failedTasks).toBe(0);
      expect(status.isShutdown).toBe(false);
    });

    it('should reflect shutdown state', async () => {
      await pool.shutdown();
      expect(pool.getStatus().isShutdown).toBe(true);
    });
  });

  describe('shutdown', () => {
    it('should mark pool as shut down', async () => {
      await pool.shutdown();
      expect(pool.getStatus().isShutdown).toBe(true);
    });

    it('should reject queued tasks on shutdown', async () => {
      // Fill workers
      const p1 = pool.execute(createTask('t1', 'r1', 100));
      const p2 = pool.execute(createTask('t2', 'r2', 100));

      // Queue a task
      const p3 = pool.execute(createTask('t3', 'r3', 10));

      // Shutdown immediately
      const shutdownPromise = pool.shutdown();

      await expect(p3).rejects.toThrow('shutting down');
      await shutdownPromise;

      // Active tasks should still complete
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBe('r1');
      expect(r2).toBe('r2');
    });
  });

  describe('activeCount', () => {
    it('should return 0 when no tasks are running', () => {
      expect(pool.activeCount).toBe(0);
    });
  });

  describe('queuedCount', () => {
    it('should return 0 when no tasks are queued', () => {
      expect(pool.queuedCount).toBe(0);
    });
  });

  describe('concurrency', () => {
    it('should respect max workers limit', async () => {
      const singlePool = new WorkerPool(1);
      const order: string[] = [];

      const p1 = singlePool.execute<string>({
        id: 't1',
        name: 'Task 1',
        execute: async () => {
          order.push('start-1');
          await new Promise((r) => setTimeout(r, 30));
          order.push('end-1');
          return 'r1';
        },
      });

      const p2 = singlePool.execute<string>({
        id: 't2',
        name: 'Task 2',
        execute: async () => {
          order.push('start-2');
          await new Promise((r) => setTimeout(r, 10));
          order.push('end-2');
          return 'r2';
        },
      });

      await Promise.all([p1, p2]);

      // With 1 worker, task 2 should start after task 1 ends
      expect(order.indexOf('start-2')).toBeGreaterThan(order.indexOf('end-1'));
    });
  });
});
