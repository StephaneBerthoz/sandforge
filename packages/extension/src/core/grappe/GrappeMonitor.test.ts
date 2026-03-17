import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GrappeMonitor } from './GrappeMonitor';
import type { GrappeMonitorListener } from './GrappeMonitor';
import type {
  GrappePartition,
  GrappeProgress,
  GrappeWorkerStatus,
} from '@sandforge/shared';

function createPartition(
  overrides: Partial<GrappePartition> = {}
): GrappePartition {
  const progress: GrappeProgress = {
    processedRecords: 0,
    totalRecords: 10,
    successCount: 0,
    failureCount: 0,
    percentage: 0,
    recordsPerSecond: 0,
  };

  return {
    id: 'p-001',
    index: 0,
    totalPartitions: 1,
    recordCount: 10,
    records: [],
    dependencies: [],
    status: 'pending',
    progress,
    retryCount: 0,
    ...overrides,
  };
}

function createWorkerStatus(
  overrides: Partial<GrappeWorkerStatus> = {}
): GrappeWorkerStatus {
  return {
    workerId: 0,
    active: false,
    processedGrappes: 0,
    queuedGrappes: 0,
    ...overrides,
  };
}

describe('GrappeMonitor', () => {
  let monitor: GrappeMonitor;

  beforeEach(() => {
    monitor = new GrappeMonitor();
  });

  describe('startMonitoring / stopMonitoring', () => {
    it('should start and stop monitoring', () => {
      monitor.startMonitoring('op-001');
      expect(monitor.isMonitoring()).toBe(true);

      monitor.stopMonitoring();
      expect(monitor.isMonitoring()).toBe(false);
    });
  });

  describe('updatePartitionStatus', () => {
    it('should emit partitionCompleted when status is completed', () => {
      monitor.startMonitoring('op-001');
      const listener = vi.fn<GrappeMonitorListener>();
      monitor.on('partitionCompleted', listener);

      monitor.updatePartitionStatus('p-001', 'completed');

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'partitionCompleted',
          operationId: 'op-001',
          partitionId: 'p-001',
          status: 'completed',
        })
      );
    });

    it('should not emit partitionCompleted for non-completed statuses', () => {
      monitor.startMonitoring('op-001');
      const listener = vi.fn<GrappeMonitorListener>();
      monitor.on('partitionCompleted', listener);

      monitor.updatePartitionStatus('p-001', 'running');

      expect(listener).not.toHaveBeenCalled();
    });

    it('should not emit events when monitoring is stopped', () => {
      monitor.startMonitoring('op-001');
      monitor.stopMonitoring();

      const listener = vi.fn<GrappeMonitorListener>();
      monitor.on('partitionCompleted', listener);

      monitor.updatePartitionStatus('p-001', 'completed');

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('updateProgress', () => {
    it('should store progress data that is reflected in operation status', () => {
      monitor.startMonitoring('op-001');

      const progress: GrappeProgress = {
        processedRecords: 5,
        totalRecords: 10,
        successCount: 5,
        failureCount: 0,
        percentage: 50,
        recordsPerSecond: 200,
      };

      monitor.updateProgress('p-001', progress);

      const partition = createPartition({ id: 'p-001' });
      const status = monitor.getOperationStatus(
        [partition],
        [createWorkerStatus()],
        'normal',
        10
      );

      expect(status.overallProgress.processedRecords).toBe(5);
      expect(status.overallProgress.percentage).toBe(50);
    });
  });

  describe('getOperationStatus', () => {
    it('should build a complete operation status', () => {
      monitor.startMonitoring('op-001');

      const partitions = [createPartition()];
      const workers = [createWorkerStatus({ active: true })];

      const status = monitor.getOperationStatus(
        partitions,
        workers,
        'warning',
        45
      );

      expect(status.operationId).toBe('op-001');
      expect(status.workers).toHaveLength(1);
      expect(status.backPressureLevel).toBe('warning');
      expect(status.apiUsagePercent).toBe(45);
      expect(status.partitions).toHaveLength(1);
    });

    it('should include estimated time remaining when progress > 0', () => {
      monitor.startMonitoring('op-001');

      const now = new Date();
      const fiveSecondsAgo = new Date(now.getTime() - 5000).toISOString();

      const partition = createPartition({
        startTime: fiveSecondsAgo,
        progress: {
          processedRecords: 5,
          totalRecords: 10,
          successCount: 5,
          failureCount: 0,
          percentage: 50,
          recordsPerSecond: 1,
        },
      });

      const status = monitor.getOperationStatus(
        [partition],
        [createWorkerStatus()],
        'normal',
        10
      );

      expect(status.estimatedTimeRemaining).toBeGreaterThan(0);
    });
  });

  describe('getEstimatedTimeRemaining', () => {
    it('should return 0 when percentage is 100', () => {
      const progress: GrappeProgress = {
        processedRecords: 10,
        totalRecords: 10,
        successCount: 10,
        failureCount: 0,
        percentage: 100,
        recordsPerSecond: 5,
      };

      expect(monitor.getEstimatedTimeRemaining(progress, 5000)).toBe(0);
    });

    it('should return 0 when percentage is 0', () => {
      const progress: GrappeProgress = {
        processedRecords: 0,
        totalRecords: 10,
        successCount: 0,
        failureCount: 0,
        percentage: 0,
        recordsPerSecond: 0,
      };

      expect(monitor.getEstimatedTimeRemaining(progress, 0)).toBe(0);
    });

    it('should estimate remaining time based on progress and elapsed', () => {
      const progress: GrappeProgress = {
        processedRecords: 5,
        totalRecords: 10,
        successCount: 5,
        failureCount: 0,
        percentage: 50,
        recordsPerSecond: 1,
      };

      const remaining = monitor.getEstimatedTimeRemaining(progress, 5000);
      expect(remaining).toBe(5000);
    });
  });

  describe('on / off', () => {
    it('should register and call listeners', () => {
      monitor.startMonitoring('op-001');
      const listener = vi.fn<GrappeMonitorListener>();
      monitor.on('partitionCompleted', listener);

      monitor.updatePartitionStatus('p-001', 'completed');

      expect(listener).toHaveBeenCalledOnce();
    });

    it('should stop calling removed listeners', () => {
      monitor.startMonitoring('op-001');
      const listener = vi.fn<GrappeMonitorListener>();
      monitor.on('partitionCompleted', listener);
      monitor.off('partitionCompleted', listener);

      monitor.updatePartitionStatus('p-001', 'completed');

      expect(listener).not.toHaveBeenCalled();
    });

    it('should support multiple listeners on the same event', () => {
      monitor.startMonitoring('op-001');
      const listener1 = vi.fn<GrappeMonitorListener>();
      const listener2 = vi.fn<GrappeMonitorListener>();
      monitor.on('partitionCompleted', listener1);
      monitor.on('partitionCompleted', listener2);

      monitor.updatePartitionStatus('p-001', 'completed');

      expect(listener1).toHaveBeenCalledOnce();
      expect(listener2).toHaveBeenCalledOnce();
    });
  });
});
