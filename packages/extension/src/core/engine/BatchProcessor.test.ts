import { describe, it, expect } from 'vitest';
import { BatchProcessor } from './BatchProcessor';
import type { BatchResult } from './BatchProcessor';

function createSuccessResult(batchIndex: number, count: number): BatchResult {
  return {
    batchIndex,
    totalRecords: count,
    successCount: count,
    failureCount: 0,
    errors: [],
  };
}

describe('BatchProcessor', () => {
  describe('constructor', () => {
    it('should default to batch size of 200', () => {
      const processor = new BatchProcessor();
      expect(processor.getBatchSize()).toBe(200);
    });

    it('should clamp batch size to minimum of 1', () => {
      const processor = new BatchProcessor(0);
      expect(processor.getBatchSize()).toBe(1);
    });

    it('should clamp batch size to maximum of 10000', () => {
      const processor = new BatchProcessor(50_000);
      expect(processor.getBatchSize()).toBe(10_000);
    });

    it('should accept a valid batch size', () => {
      const processor = new BatchProcessor(500);
      expect(processor.getBatchSize()).toBe(500);
    });

    it('should default concurrency to 3', () => {
      const processor = new BatchProcessor();
      expect(processor.getDefaultConcurrency()).toBe(3);
    });

    it('should accept a custom concurrency', () => {
      const processor = new BatchProcessor(200, 5);
      expect(processor.getDefaultConcurrency()).toBe(5);
    });

    it('should clamp concurrency to minimum of 1', () => {
      const processor = new BatchProcessor(200, 0);
      expect(processor.getDefaultConcurrency()).toBe(1);
    });

    it('should clamp concurrency to maximum of 20', () => {
      const processor = new BatchProcessor(200, 50);
      expect(processor.getDefaultConcurrency()).toBe(20);
    });
  });

  describe('createBatches', () => {
    it('should return an empty array for empty input', () => {
      const processor = new BatchProcessor(10);
      expect(processor.createBatches([])).toEqual([]);
    });

    it('should create a single batch when records fit', () => {
      const processor = new BatchProcessor(10);
      const records = [1, 2, 3, 4, 5];
      const batches = processor.createBatches(records);

      expect(batches).toHaveLength(1);
      expect(batches[0]).toEqual([1, 2, 3, 4, 5]);
    });

    it('should split records into multiple batches', () => {
      const processor = new BatchProcessor(3);
      const records = [1, 2, 3, 4, 5, 6, 7];
      const batches = processor.createBatches(records);

      expect(batches).toHaveLength(3);
      expect(batches[0]).toEqual([1, 2, 3]);
      expect(batches[1]).toEqual([4, 5, 6]);
      expect(batches[2]).toEqual([7]);
    });

    it('should handle exact batch size boundary', () => {
      const processor = new BatchProcessor(3);
      const records = [1, 2, 3, 4, 5, 6];
      const batches = processor.createBatches(records);

      expect(batches).toHaveLength(2);
      expect(batches[0]).toEqual([1, 2, 3]);
      expect(batches[1]).toEqual([4, 5, 6]);
    });

    it('should handle a single record', () => {
      const processor = new BatchProcessor(10);
      const batches = processor.createBatches(['one']);

      expect(batches).toHaveLength(1);
      expect(batches[0]).toEqual(['one']);
    });
  });

  describe('processSequential', () => {
    it('should process all batches in order', async () => {
      const processor = new BatchProcessor(2);
      const callOrder: number[] = [];

      const results = await processor.processSequential([1, 2, 3, 4, 5], async (batch, index) => {
        callOrder.push(index);
        return createSuccessResult(index, batch.length);
      });

      expect(results).toHaveLength(3);
      expect(callOrder).toEqual([0, 1, 2]);
    });

    it('should return results for each batch', async () => {
      const processor = new BatchProcessor(2);

      const results = await processor.processSequential([1, 2, 3], async (batch, index) =>
        createSuccessResult(index, batch.length),
      );

      expect(results[0].totalRecords).toBe(2);
      expect(results[1].totalRecords).toBe(1);
    });

    it('should handle empty input', async () => {
      const processor = new BatchProcessor(10);

      const results = await processor.processSequential([], async (batch, index) =>
        createSuccessResult(index, batch.length),
      );

      expect(results).toEqual([]);
    });
  });

  describe('processParallel', () => {
    it('should process all batches', async () => {
      const processor = new BatchProcessor(2);

      const results = await processor.processParallel(
        [1, 2, 3, 4],
        async (batch, index) => createSuccessResult(index, batch.length),
        2,
      );

      expect(results).toHaveLength(2);
      expect(results[0].batchIndex).toBe(0);
      expect(results[1].batchIndex).toBe(1);
    });

    it('should respect concurrency limit', async () => {
      const processor = new BatchProcessor(1);
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      const results = await processor.processParallel(
        [1, 2, 3, 4, 5],
        async (batch, index) => {
          currentConcurrent++;
          maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
          await new Promise((resolve) => setTimeout(resolve, 10));
          currentConcurrent--;
          return createSuccessResult(index, batch.length);
        },
        2,
      );

      expect(results).toHaveLength(5);
      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });

    it('should handle empty input', async () => {
      const processor = new BatchProcessor(10);

      const results = await processor.processParallel(
        [],
        async (batch, index) => createSuccessResult(index, batch.length),
        3,
      );

      expect(results).toEqual([]);
    });

    it('should handle processor exceptions gracefully in parallel mode', async () => {
      const processor = new BatchProcessor(2);

      const results = await processor.processParallel(
        [1, 2, 3, 4],
        async (batch, batchIndex) => {
          if (batchIndex === 0) throw new Error('Simulated failure');
          return createSuccessResult(batchIndex, batch.length);
        },
        2,
      );

      expect(results).toHaveLength(2);
      // First batch should have error info
      expect(results[0].failureCount).toBe(2);
      expect(results[0].successCount).toBe(0);
      expect(results[0].errors).toContain('Simulated failure');
      // Second batch should succeed
      expect(results[1].successCount).toBe(2);
      expect(results[1].failureCount).toBe(0);
    });

    it('should default concurrency to 3', async () => {
      const processor = new BatchProcessor(1);
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      await processor.processParallel([1, 2, 3, 4, 5, 6], async (batch, index) => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise((resolve) => setTimeout(resolve, 10));
        currentConcurrent--;
        return createSuccessResult(index, batch.length);
      });

      expect(maxConcurrent).toBeLessThanOrEqual(3);
    });

    it('should use constructor default concurrency when no argument is passed', async () => {
      const processor = new BatchProcessor(1, 2);
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      await processor.processParallel([1, 2, 3, 4, 5, 6], async (batch, index) => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise((resolve) => setTimeout(resolve, 10));
        currentConcurrent--;
        return createSuccessResult(index, batch.length);
      });

      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });
  });

  describe('calculateBatchCount', () => {
    it('should return correct count for exact fit', () => {
      const processor = new BatchProcessor(100);
      expect(processor.calculateBatchCount(300)).toBe(3);
    });

    it('should round up for partial batches', () => {
      const processor = new BatchProcessor(100);
      expect(processor.calculateBatchCount(250)).toBe(3);
    });

    it('should return 1 for a single record', () => {
      const processor = new BatchProcessor(100);
      expect(processor.calculateBatchCount(1)).toBe(1);
    });

    it('should return 0 for zero records', () => {
      const processor = new BatchProcessor(100);
      expect(processor.calculateBatchCount(0)).toBe(0);
    });
  });
});
