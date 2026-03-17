import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PerformanceTracker } from './PerformanceTracker';

describe('PerformanceTracker', () => {
  let tracker: PerformanceTracker;

  beforeEach(() => {
    tracker = new PerformanceTracker();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('start', () => {
    it('should register a new active operation', () => {
      tracker.start('op-1', 'Sync');
      const metrics = tracker.getMetrics('op-1');

      expect(metrics).toBeDefined();
      expect(metrics?.operationId).toBe('op-1');
      expect(metrics?.module).toBe('Sync');
      expect(metrics?.totalRecords).toBe(0);
      expect(metrics?.apiCalls).toBe(0);
    });

    it('should track startTime', () => {
      const now = Date.now();
      tracker.start('op-2', 'Seed');
      const metrics = tracker.getMetrics('op-2');

      expect(metrics?.startTime).toBe(now);
    });
  });

  describe('update', () => {
    it('should accumulate records and API calls', () => {
      tracker.start('op-1', 'Sync');
      tracker.update('op-1', 100, 2);
      tracker.update('op-1', 50, 1);

      const metrics = tracker.getMetrics('op-1');

      expect(metrics?.totalRecords).toBe(150);
      expect(metrics?.apiCalls).toBe(3);
    });

    it('should do nothing for an unknown operation', () => {
      tracker.update('nonexistent', 100, 1);

      expect(tracker.getMetrics('nonexistent')).toBeUndefined();
    });
  });

  describe('complete', () => {
    it('should finalize metrics with duration and throughput', () => {
      tracker.start('op-1', 'Sync');
      tracker.update('op-1', 1000, 5);

      vi.advanceTimersByTime(2000);
      const result = tracker.complete('op-1');

      expect(result).toBeDefined();
      expect(result?.durationMs).toBe(2000);
      expect(result?.endTime).toBeDefined();
      expect(result?.recordsPerSecond).toBe(500);
    });

    it('should remove the operation from active tracking', () => {
      tracker.start('op-1', 'Sync');
      tracker.complete('op-1');

      expect(tracker.getAllActive()).toHaveLength(0);
    });

    it('should return undefined for an unknown operation', () => {
      expect(tracker.complete('nonexistent')).toBeUndefined();
    });

    it('should handle zero-duration operations without division errors', () => {
      tracker.start('op-1', 'Sync');
      tracker.update('op-1', 100, 1);
      const result = tracker.complete('op-1');

      expect(result?.recordsPerSecond).toBe(0);
    });

    it('should store completed metrics in history', () => {
      tracker.start('op-1', 'Sync');
      tracker.update('op-1', 500, 3);
      vi.advanceTimersByTime(1000);
      tracker.complete('op-1');

      const history = tracker.getHistory('Sync');

      expect(history).toBeDefined();
      expect(history?.sampleCount).toBe(1);
      expect(history?.averageDurationMs).toBe(1000);
    });
  });

  describe('getMetrics', () => {
    it('should return active operation metrics', () => {
      tracker.start('op-1', 'Sync');
      tracker.update('op-1', 50, 1);

      const metrics = tracker.getMetrics('op-1');

      expect(metrics?.totalRecords).toBe(50);
    });

    it('should return completed operation metrics from history', () => {
      tracker.start('op-1', 'Sync');
      tracker.update('op-1', 200, 2);
      vi.advanceTimersByTime(500);
      tracker.complete('op-1');

      const metrics = tracker.getMetrics('op-1');

      expect(metrics).toBeDefined();
      expect(metrics?.durationMs).toBe(500);
    });

    it('should return undefined for a never-tracked operation', () => {
      expect(tracker.getMetrics('ghost')).toBeUndefined();
    });

    it('should return a copy, not a reference to internal state', () => {
      tracker.start('op-1', 'Sync');
      const m1 = tracker.getMetrics('op-1');
      const m2 = tracker.getMetrics('op-1');

      expect(m1).toEqual(m2);
      expect(m1).not.toBe(m2);
    });
  });

  describe('getHistory', () => {
    it('should return undefined for a module with no history', () => {
      expect(tracker.getHistory('Unknown')).toBeUndefined();
    });

    it('should aggregate metrics across multiple completions', () => {
      tracker.start('op-1', 'Sync');
      tracker.update('op-1', 1000, 5);
      vi.advanceTimersByTime(1000);
      tracker.complete('op-1');

      tracker.start('op-2', 'Sync');
      tracker.update('op-2', 2000, 10);
      vi.advanceTimersByTime(2000);
      tracker.complete('op-2');

      const history = tracker.getHistory('Sync');

      expect(history?.sampleCount).toBe(2);
      expect(history?.averageDurationMs).toBe(1500);
      // op-1: 1000 rec/sec, op-2: 1000 rec/sec => avg 1000
      expect(history?.averageRecordsPerSec).toBe(1000);
    });
  });

  describe('detectDegradation', () => {
    it('should return false when no history exists', () => {
      tracker.start('op-1', 'Sync');
      tracker.update('op-1', 100, 1);
      vi.advanceTimersByTime(100);

      expect(tracker.detectDegradation('op-1')).toBe(false);
    });

    it('should return false for unknown operations', () => {
      expect(tracker.detectDegradation('nonexistent')).toBe(false);
    });

    it('should return true when throughput drops below 80% of historical average', () => {
      // Build history: 1000 records/sec average
      tracker.start('h1', 'Sync');
      tracker.update('h1', 1000, 5);
      vi.advanceTimersByTime(1000);
      tracker.complete('h1');

      // Current operation performing at ~200 records/sec (below 80% of 1000)
      tracker.start('current', 'Sync');
      tracker.update('current', 200, 2);
      vi.advanceTimersByTime(1000);

      expect(tracker.detectDegradation('current')).toBe(true);
    });

    it('should return false when throughput is within acceptable range', () => {
      // Build history: 1000 records/sec average
      tracker.start('h1', 'Sync');
      tracker.update('h1', 1000, 5);
      vi.advanceTimersByTime(1000);
      tracker.complete('h1');

      // Current operation performing at ~900 records/sec (above 80% of 1000)
      tracker.start('current', 'Sync');
      tracker.update('current', 900, 4);
      vi.advanceTimersByTime(1000);

      expect(tracker.detectDegradation('current')).toBe(false);
    });

    it('should return false when no records have been processed yet', () => {
      tracker.start('op-1', 'Sync');
      vi.advanceTimersByTime(1000);

      expect(tracker.detectDegradation('op-1')).toBe(false);
    });
  });

  describe('getAllActive', () => {
    it('should return all active operations', () => {
      tracker.start('op-1', 'Sync');
      tracker.start('op-2', 'Seed');

      const active = tracker.getAllActive();

      expect(active).toHaveLength(2);
      expect(active.map((m) => m.operationId).sort()).toEqual(['op-1', 'op-2']);
    });

    it('should return an empty array when no operations are active', () => {
      expect(tracker.getAllActive()).toEqual([]);
    });

    it('should not include completed operations', () => {
      tracker.start('op-1', 'Sync');
      tracker.complete('op-1');

      expect(tracker.getAllActive()).toHaveLength(0);
    });
  });

  describe('dispose', () => {
    it('should clear all active operations and history', () => {
      tracker.start('op-1', 'Sync');
      tracker.update('op-1', 100, 1);
      vi.advanceTimersByTime(100);
      tracker.complete('op-1');

      tracker.start('op-2', 'Seed');

      tracker.dispose();

      expect(tracker.getAllActive()).toEqual([]);
      expect(tracker.getHistory('Sync')).toBeUndefined();
      expect(tracker.getMetrics('op-1')).toBeUndefined();
      expect(tracker.getMetrics('op-2')).toBeUndefined();
    });
  });
});
