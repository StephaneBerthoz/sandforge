import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GrappeWorkerManager } from './GrappeWorkerManager';
import type { GrappePartition, GrappeResult } from '@sandforge/shared';

function createPartition(overrides: Partial<GrappePartition> = {}): GrappePartition {
  return {
    id: 'partition-001',
    index: 0,
    totalPartitions: 1,
    recordCount: 3,
    records: ['r1', 'r2', 'r3'],
    dependencies: [],
    status: 'pending',
    progress: {
      processedRecords: 0,
      totalRecords: 3,
      successCount: 0,
      failureCount: 0,
      percentage: 0,
      recordsPerSecond: 0,
    },
    retryCount: 0,
    ...overrides,
  };
}

function createResult(overrides: Partial<GrappeResult> = {}): GrappeResult {
  return {
    grappeId: 'partition-001',
    status: 'success',
    processedRecords: 3,
    successCount: 3,
    failureCount: 0,
    errors: [],
    duration: 100,
    ...overrides,
  };
}

describe('GrappeWorkerManager', () => {
  let manager: GrappeWorkerManager;

  beforeEach(() => {
    manager = new GrappeWorkerManager();
  });

  describe('createWorkers', () => {
    it('should create the specified number of workers', () => {
      manager.createWorkers(3);
      const statuses = manager.getAllWorkerStatuses();
      expect(statuses).toHaveLength(3);
    });

    it('should clear existing workers when called again', () => {
      manager.createWorkers(5);
      manager.createWorkers(2);
      expect(manager.getAllWorkerStatuses()).toHaveLength(2);
    });

    it('should create workers that are initially inactive', () => {
      manager.createWorkers(2);
      const statuses = manager.getAllWorkerStatuses();
      expect(statuses.every((s) => !s.active)).toBe(true);
    });
  });

  describe('assignPartition', () => {
    it('should assign a partition to the first available worker', () => {
      manager.createWorkers(3);
      const partition = createPartition();
      const workerId = manager.assignPartition(partition);

      expect(workerId).toBe(0);
      expect(manager.getWorkerStatus(0).active).toBe(true);
      expect(manager.getWorkerStatus(0).currentGrappeId).toBe('partition-001');
    });

    it('should assign to the next available worker when first is busy', () => {
      manager.createWorkers(3);
      manager.assignPartition(createPartition({ id: 'p1' }));
      const workerId = manager.assignPartition(createPartition({ id: 'p2' }));

      expect(workerId).toBe(1);
    });

    it('should throw when no workers are available', () => {
      manager.createWorkers(1);
      manager.assignPartition(createPartition());

      expect(() => manager.assignPartition(createPartition({ id: 'p2' }))).toThrow(
        'No available workers to assign partition',
      );
    });
  });

  describe('releaseWorker', () => {
    it('should mark the worker as inactive and increment processedGrappes', () => {
      manager.createWorkers(2);
      manager.assignPartition(createPartition());
      manager.releaseWorker(0);

      const status = manager.getWorkerStatus(0);
      expect(status.active).toBe(false);
      expect(status.processedGrappes).toBe(1);
      expect(status.currentGrappeId).toBeUndefined();
    });

    it('should throw for a non-existent worker', () => {
      manager.createWorkers(1);
      expect(() => manager.releaseWorker(99)).toThrow('Worker 99 does not exist');
    });
  });

  describe('getWorkerStatus', () => {
    it('should return the correct status for a worker', () => {
      manager.createWorkers(1);
      const status = manager.getWorkerStatus(0);

      expect(status.workerId).toBe(0);
      expect(status.active).toBe(false);
      expect(status.processedGrappes).toBe(0);
    });

    it('should throw for a non-existent worker', () => {
      manager.createWorkers(1);
      expect(() => manager.getWorkerStatus(5)).toThrow('Worker 5 does not exist');
    });
  });

  describe('getAvailableWorkerCount', () => {
    it('should return total workers when none are assigned', () => {
      manager.createWorkers(4);
      expect(manager.getAvailableWorkerCount()).toBe(4);
    });

    it('should decrease when workers are assigned', () => {
      manager.createWorkers(3);
      manager.assignPartition(createPartition());
      expect(manager.getAvailableWorkerCount()).toBe(2);
    });

    it('should increase when workers are released', () => {
      manager.createWorkers(2);
      manager.assignPartition(createPartition());
      manager.releaseWorker(0);
      expect(manager.getAvailableWorkerCount()).toBe(2);
    });
  });

  describe('processPartition', () => {
    it('should call the process function with the partition records', async () => {
      manager.createWorkers(1);
      const partition = createPartition({ records: ['x', 'y'] });
      manager.assignPartition(partition);

      const processFn = vi.fn<(records: string[]) => Promise<GrappeResult>>();
      processFn.mockResolvedValue(createResult());

      await manager.processPartition(0, partition, processFn);

      expect(processFn).toHaveBeenCalledWith(['x', 'y']);
    });

    it('should release the worker after successful processing', async () => {
      manager.createWorkers(1);
      const partition = createPartition();
      manager.assignPartition(partition);

      const processFn = vi.fn<(records: string[]) => Promise<GrappeResult>>();
      processFn.mockResolvedValue(createResult());

      await manager.processPartition(0, partition, processFn);

      expect(manager.getWorkerStatus(0).active).toBe(false);
    });

    it('should release the worker even if processing fails', async () => {
      manager.createWorkers(1);
      const partition = createPartition();
      manager.assignPartition(partition);

      const processFn = vi.fn<(records: string[]) => Promise<GrappeResult>>();
      processFn.mockRejectedValue(new Error('Processing failed'));

      await expect(manager.processPartition(0, partition, processFn)).rejects.toThrow(
        'Processing failed',
      );

      expect(manager.getWorkerStatus(0).active).toBe(false);
    });

    it('should throw for a non-existent worker', async () => {
      manager.createWorkers(1);
      const partition = createPartition();
      const processFn = vi.fn<(records: string[]) => Promise<GrappeResult>>();

      await expect(manager.processPartition(99, partition, processFn)).rejects.toThrow(
        'Worker 99 does not exist',
      );
    });
  });
});
