import { describe, it, expect, beforeEach } from 'vitest';
import { GrappeAggregator } from './GrappeAggregator';
import type { GrappePartition, GrappeProgress, GrappeResult } from '@sandforge/shared';

function createResult(overrides: Partial<GrappeResult> = {}): GrappeResult {
  return {
    grappeId: 'partition-001',
    status: 'success',
    processedRecords: 10,
    successCount: 10,
    failureCount: 0,
    errors: [],
    duration: 200,
    ...overrides,
  };
}

function createPartition(overrides: Partial<GrappePartition> = {}): GrappePartition {
  const progress: GrappeProgress = {
    processedRecords: 5,
    totalRecords: 10,
    successCount: 5,
    failureCount: 0,
    percentage: 50,
    recordsPerSecond: 100,
  };

  return {
    id: 'p-001',
    index: 0,
    totalPartitions: 1,
    recordCount: 10,
    records: [],
    dependencies: [],
    status: 'running',
    progress,
    retryCount: 0,
    ...overrides,
  };
}

describe('GrappeAggregator', () => {
  let aggregator: GrappeAggregator;

  beforeEach(() => {
    aggregator = new GrappeAggregator();
  });

  describe('addResult', () => {
    it('should store results for later aggregation', () => {
      aggregator.addResult(createResult());
      aggregator.addResult(createResult({ grappeId: 'p2' }));

      expect(aggregator.getPartialResults()).toHaveLength(2);
    });
  });

  describe('aggregate', () => {
    it('should aggregate multiple successful results', () => {
      aggregator.addResult(createResult({ processedRecords: 10, successCount: 10, duration: 100 }));
      aggregator.addResult(
        createResult({
          grappeId: 'p2',
          processedRecords: 5,
          successCount: 5,
          duration: 200,
        }),
      );

      const result = aggregator.aggregate('op-001');

      expect(result.operationId).toBe('op-001');
      expect(result.totalPartitions).toBe(2);
      expect(result.completedPartitions).toBe(2);
      expect(result.failedPartitions).toBe(0);
      expect(result.totalRecords).toBe(15);
      expect(result.successRecords).toBe(15);
      expect(result.failedRecords).toBe(0);
      expect(result.duration).toBe(200);
    });

    it('should count failed partitions correctly', () => {
      aggregator.addResult(createResult({ status: 'success' }));
      aggregator.addResult(
        createResult({
          grappeId: 'p2',
          status: 'failure',
          failureCount: 5,
          successCount: 0,
        }),
      );

      const result = aggregator.aggregate('op-002');

      expect(result.completedPartitions).toBe(1);
      expect(result.failedPartitions).toBe(1);
      expect(result.failedRecords).toBe(5);
    });

    it('should count partial results as completed', () => {
      aggregator.addResult(createResult({ status: 'partial', successCount: 7, failureCount: 3 }));

      const result = aggregator.aggregate('op-003');

      expect(result.completedPartitions).toBe(1);
      expect(result.failedPartitions).toBe(0);
    });

    it('should return a copy of partition results', () => {
      aggregator.addResult(createResult());
      const result = aggregator.aggregate('op-004');

      expect(result.partitionResults).toHaveLength(1);
      result.partitionResults.push(createResult());
      expect(aggregator.getPartialResults()).toHaveLength(1);
    });

    it('should handle empty results', () => {
      const result = aggregator.aggregate('op-005');

      expect(result.totalPartitions).toBe(0);
      expect(result.totalRecords).toBe(0);
    });
  });

  describe('getPartialResults', () => {
    it('should return a copy of results so far', () => {
      aggregator.addResult(createResult());
      const partial = aggregator.getPartialResults();

      partial.push(createResult());
      expect(aggregator.getPartialResults()).toHaveLength(1);
    });
  });

  describe('getOverallProgress', () => {
    it('should aggregate progress from all partitions', () => {
      const partitions = [
        createPartition({
          progress: {
            processedRecords: 5,
            totalRecords: 10,
            successCount: 5,
            failureCount: 0,
            percentage: 50,
            recordsPerSecond: 100,
          },
        }),
        createPartition({
          id: 'p-002',
          progress: {
            processedRecords: 8,
            totalRecords: 10,
            successCount: 7,
            failureCount: 1,
            percentage: 80,
            recordsPerSecond: 150,
          },
        }),
      ];

      const progress = aggregator.getOverallProgress(partitions);

      expect(progress.processedRecords).toBe(13);
      expect(progress.totalRecords).toBe(20);
      expect(progress.successCount).toBe(12);
      expect(progress.failureCount).toBe(1);
      expect(progress.percentage).toBe(65);
      expect(progress.recordsPerSecond).toBe(250);
    });

    it('should return zero percentage for empty partitions', () => {
      const progress = aggregator.getOverallProgress([]);

      expect(progress.percentage).toBe(0);
      expect(progress.processedRecords).toBe(0);
    });
  });

  describe('reset', () => {
    it('should clear all accumulated results', () => {
      aggregator.addResult(createResult());
      aggregator.addResult(createResult());

      aggregator.reset();

      expect(aggregator.getPartialResults()).toHaveLength(0);
    });

    it('should produce clean aggregation after reset', () => {
      aggregator.addResult(createResult({ processedRecords: 100 }));
      aggregator.reset();
      aggregator.addResult(createResult({ processedRecords: 5 }));

      const result = aggregator.aggregate('op-reset');
      expect(result.totalRecords).toBe(5);
    });
  });
});
