import { describe, it, expect } from 'vitest';

import type {
  GrappeConfig,
  GrappePartition,
  AggregatedGrappeResult,
  BackPressureConfig,
  GrappeProgress,
  GrappeResult,
} from './grappe.types.js';

describe('GrappeConfig', () => {
  function createConfig(
    overrides: Partial<GrappeConfig> = {},
  ): GrappeConfig {
    const backPressure: BackPressureConfig = {
      enabled: true,
      maxQueueDepth: 100,
      highWaterMark: 80,
      lowWaterMark: 20,
      strategy: 'throttle',
      monitoringInterval: 5000,
    };

    return {
      enabled: true,
      autoActivateThreshold: 10000,
      maxWorkers: 4,
      grappeSize: 2500,
      strategy: 'round_robin',
      backPressure,
      checkpointing: true,
      isolationLevel: 'per_grappe',
      ...overrides,
    };
  }

  it('should create a config with all fields populated', () => {
    const config = createConfig();

    expect(config.enabled).toBe(true);
    expect(config.autoActivateThreshold).toBe(10000);
    expect(config.maxWorkers).toBe(4);
    expect(config.grappeSize).toBe(2500);
    expect(config.strategy).toBe('round_robin');
    expect(config.checkpointing).toBe(true);
    expect(config.isolationLevel).toBe('per_grappe');
  });

  it('should support back-pressure configuration', () => {
    const config = createConfig();

    expect(config.backPressure.enabled).toBe(true);
    expect(config.backPressure.maxQueueDepth).toBe(100);
    expect(config.backPressure.highWaterMark).toBe(80);
    expect(config.backPressure.lowWaterMark).toBe(20);
    expect(config.backPressure.strategy).toBe('throttle');
    expect(config.backPressure.monitoringInterval).toBe(5000);
  });

  it('should accept dependency_aware strategy with no isolation', () => {
    const config = createConfig({
      strategy: 'dependency_aware',
      isolationLevel: 'none',
      checkpointing: false,
    });

    expect(config.strategy).toBe('dependency_aware');
    expect(config.isolationLevel).toBe('none');
    expect(config.checkpointing).toBe(false);
  });
});

describe('GrappePartition', () => {
  function createPartition(
    overrides: Partial<GrappePartition> = {},
  ): GrappePartition {
    const progress: GrappeProgress = {
      processedRecords: 0,
      totalRecords: 2500,
      successCount: 0,
      failureCount: 0,
      percentage: 0,
      recordsPerSecond: 0,
    };

    return {
      id: 'grappe-part-001',
      index: 0,
      totalPartitions: 4,
      recordCount: 2500,
      records: ['001xx000001AAA', '001xx000001BBB', '001xx000001CCC'],
      dependencies: [],
      status: 'pending',
      progress,
      retryCount: 0,
      ...overrides,
    };
  }

  it('should create a pending partition with initial progress', () => {
    const partition = createPartition();

    expect(partition.id).toBe('grappe-part-001');
    expect(partition.index).toBe(0);
    expect(partition.totalPartitions).toBe(4);
    expect(partition.recordCount).toBe(2500);
    expect(partition.records).toHaveLength(3);
    expect(partition.dependencies).toEqual([]);
    expect(partition.status).toBe('pending');
    expect(partition.progress.percentage).toBe(0);
    expect(partition.assignedWorker).toBeUndefined();
    expect(partition.checkpoint).toBeUndefined();
  });

  it('should represent a running partition with an assigned worker', () => {
    const partition = createPartition({
      status: 'running',
      assignedWorker: 2,
      startTime: '2026-02-20T10:00:00.000Z',
      progress: {
        processedRecords: 1200,
        totalRecords: 2500,
        successCount: 1198,
        failureCount: 2,
        percentage: 48,
        recordsPerSecond: 150,
      },
    });

    expect(partition.status).toBe('running');
    expect(partition.assignedWorker).toBe(2);
    expect(partition.progress.processedRecords).toBe(1200);
    expect(partition.progress.percentage).toBe(48);
    expect(partition.startTime).toBeDefined();
    expect(partition.endTime).toBeUndefined();
  });

  it('should represent a completed partition with checkpoint and timing', () => {
    const partition = createPartition({
      status: 'completed',
      startTime: '2026-02-20T10:00:00.000Z',
      endTime: '2026-02-20T10:00:17.000Z',
      retryCount: 1,
      progress: {
        processedRecords: 2500,
        totalRecords: 2500,
        successCount: 2500,
        failureCount: 0,
        percentage: 100,
        recordsPerSecond: 147,
      },
      checkpoint: {
        grappeId: 'grappe-part-001',
        timestamp: '2026-02-20T10:00:10.000Z',
        processedRecords: 1500,
        lastProcessedId: '001xx000001ZZZ',
        state: { batchIndex: 6 },
        recoverable: true,
      },
    });

    expect(partition.status).toBe('completed');
    expect(partition.retryCount).toBe(1);
    expect(partition.progress.percentage).toBe(100);
    expect(partition.checkpoint).toBeDefined();
    expect(partition.checkpoint!.recoverable).toBe(true);
    expect(partition.checkpoint!.lastProcessedId).toBe('001xx000001ZZZ');
  });
});

describe('AggregatedGrappeResult', () => {
  it('should aggregate results from multiple partitions', () => {
    const partitionResults: GrappeResult[] = [
      {
        grappeId: 'grappe-001',
        status: 'success',
        processedRecords: 2500,
        successCount: 2500,
        failureCount: 0,
        errors: [],
        duration: 15000,
      },
      {
        grappeId: 'grappe-002',
        status: 'success',
        processedRecords: 2500,
        successCount: 2498,
        failureCount: 2,
        errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION on record index 45'],
        duration: 17000,
      },
      {
        grappeId: 'grappe-003',
        status: 'partial',
        processedRecords: 2500,
        successCount: 2400,
        failureCount: 100,
        errors: ['REQUEST_LIMIT_EXCEEDED'],
        duration: 20000,
      },
    ];

    const result: AggregatedGrappeResult = {
      operationId: 'op-uuid-001',
      totalPartitions: 3,
      completedPartitions: 2,
      failedPartitions: 0,
      totalRecords: 7500,
      successRecords: 7398,
      failedRecords: 102,
      duration: 20000,
      partitionResults,
    };

    expect(result.operationId).toBe('op-uuid-001');
    expect(result.totalPartitions).toBe(3);
    expect(result.completedPartitions).toBe(2);
    expect(result.failedPartitions).toBe(0);
    expect(result.successRecords + result.failedRecords).toBe(
      result.totalRecords,
    );
    expect(result.partitionResults).toHaveLength(3);
    expect(result.duration).toBe(20000);
  });

  it('should represent a fully successful operation with no failures', () => {
    const result: AggregatedGrappeResult = {
      operationId: 'op-uuid-002',
      totalPartitions: 1,
      completedPartitions: 1,
      failedPartitions: 0,
      totalRecords: 200,
      successRecords: 200,
      failedRecords: 0,
      duration: 3000,
      partitionResults: [
        {
          grappeId: 'grappe-single',
          status: 'success',
          processedRecords: 200,
          successCount: 200,
          failureCount: 0,
          errors: [],
          duration: 3000,
        },
      ],
    };

    expect(result.failedPartitions).toBe(0);
    expect(result.failedRecords).toBe(0);
    expect(result.successRecords).toBe(result.totalRecords);
    expect(result.partitionResults[0].errors).toEqual([]);
  });
});
