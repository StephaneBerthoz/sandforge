import { describe, it, expect } from 'vitest';
import type { LimitsSnapshot } from '@sandforge/shared';
import {
  extractSparklineData,
  extractTimestamps,
  computeTrendDirection,
  computePredictedTimeToLimit,
  computeTrendData,
} from './trendUtils';

function makeSnapshot(
  orgId: string,
  timestamp: string,
  limits: Array<{ name: string; max: number; remaining: number; usedPercent: number }>,
): LimitsSnapshot {
  return { orgId, limits, timestamp };
}

function makeLimits(
  name: string,
  usedPercent: number,
): Array<{ name: string; max: number; remaining: number; usedPercent: number }> {
  return [{ name, max: 15000, remaining: Math.round(15000 * (1 - usedPercent / 100)), usedPercent }];
}

describe('trendUtils', () => {
  describe('extractSparklineData', () => {
    it('should extract usedPercent values for the given limit name', () => {
      const snapshots = [
        makeSnapshot('org-1', '2026-01-01T00:00:00Z', makeLimits('DailyApiRequests', 10)),
        makeSnapshot('org-1', '2026-01-01T01:00:00Z', makeLimits('DailyApiRequests', 20)),
        makeSnapshot('org-1', '2026-01-01T02:00:00Z', makeLimits('DailyApiRequests', 30)),
      ];
      expect(extractSparklineData(snapshots, 'DailyApiRequests')).toEqual([10, 20, 30]);
    });

    it('should return empty array when limit name is not found', () => {
      const snapshots = [
        makeSnapshot('org-1', '2026-01-01T00:00:00Z', makeLimits('DataStorageMB', 50)),
      ];
      expect(extractSparklineData(snapshots, 'DailyApiRequests')).toEqual([]);
    });

    it('should return empty array for empty snapshots', () => {
      expect(extractSparklineData([], 'DailyApiRequests')).toEqual([]);
    });
  });

  describe('extractTimestamps', () => {
    it('should return ISO timestamps for matching snapshots', () => {
      const snapshots = [
        makeSnapshot('org-1', '2026-01-01T00:00:00Z', makeLimits('DailyApiRequests', 10)),
        makeSnapshot('org-1', '2026-01-01T01:00:00Z', makeLimits('DailyApiRequests', 20)),
        makeSnapshot('org-1', '2026-01-01T02:00:00Z', makeLimits('DailyApiRequests', 30)),
      ];
      expect(extractTimestamps(snapshots, 'DailyApiRequests')).toEqual([
        '2026-01-01T00:00:00Z',
        '2026-01-01T01:00:00Z',
        '2026-01-01T02:00:00Z',
      ]);
    });

    it('should return empty array when limit name is not found', () => {
      const snapshots = [
        makeSnapshot('org-1', '2026-01-01T00:00:00Z', makeLimits('DataStorageMB', 50)),
      ];
      expect(extractTimestamps(snapshots, 'DailyApiRequests')).toEqual([]);
    });

    it('should return empty array for empty snapshots', () => {
      expect(extractTimestamps([], 'DailyApiRequests')).toEqual([]);
    });

    it('should be parallel to extractSparklineData', () => {
      const snapshots = [
        makeSnapshot('org-1', '2026-01-01T00:00:00Z', makeLimits('DailyApiRequests', 10)),
        makeSnapshot('org-1', '2026-01-01T01:00:00Z', makeLimits('DailyApiRequests', 20)),
      ];
      const sparkline = extractSparklineData(snapshots, 'DailyApiRequests');
      const timestamps = extractTimestamps(snapshots, 'DailyApiRequests');
      expect(timestamps).toHaveLength(sparkline.length);
    });
  });

  describe('computeTrendDirection', () => {
    it('should return stable with 0 change for fewer than 2 data points', () => {
      expect(computeTrendDirection([])).toEqual({ direction: 'stable', changePercent: 0 });
      expect(computeTrendDirection([50])).toEqual({ direction: 'stable', changePercent: 0 });
    });

    it('should return stable when change is within threshold', () => {
      expect(computeTrendDirection([50, 51])).toEqual({ direction: 'stable', changePercent: 1 });
      expect(computeTrendDirection([50, 48])).toEqual({ direction: 'stable', changePercent: -2 });
    });

    it('should return up when change exceeds threshold positively', () => {
      const result = computeTrendDirection([10, 20]);
      expect(result.direction).toBe('up');
      expect(result.changePercent).toBe(10);
    });

    it('should return down when change exceeds threshold negatively', () => {
      const result = computeTrendDirection([20, 10]);
      expect(result.direction).toBe('down');
      expect(result.changePercent).toBe(-10);
    });

    it('should use first and last values only', () => {
      const result = computeTrendDirection([10, 50, 80, 25]);
      expect(result.direction).toBe('up');
      expect(result.changePercent).toBe(15);
    });
  });

  describe('computePredictedTimeToLimit', () => {
    it('should return undefined when last value is >= 100', () => {
      const snapshots = [
        makeSnapshot('org-1', '2026-01-01T00:00:00Z', []),
        makeSnapshot('org-1', '2026-01-01T01:00:00Z', []),
      ];
      expect(computePredictedTimeToLimit(snapshots, 10, 100)).toBeUndefined();
    });

    it('should return undefined when fewer than 2 snapshots', () => {
      const snapshots = [makeSnapshot('org-1', '2026-01-01T00:00:00Z', [])];
      expect(computePredictedTimeToLimit(snapshots, 10, 50)).toBeUndefined();
    });

    it('should return undefined when time span is zero', () => {
      const snapshots = [
        makeSnapshot('org-1', '2026-01-01T00:00:00Z', []),
        makeSnapshot('org-1', '2026-01-01T00:00:00Z', []),
      ];
      expect(computePredictedTimeToLimit(snapshots, 10, 50)).toBeUndefined();
    });

    it('should return undefined when rate is not positive', () => {
      const snapshots = [
        makeSnapshot('org-1', '2026-01-01T00:00:00Z', []),
        makeSnapshot('org-1', '2026-01-01T01:00:00Z', []),
      ];
      expect(computePredictedTimeToLimit(snapshots, -5, 50)).toBeUndefined();
    });

    it('should compute predicted hours to 100%', () => {
      const snapshots = [
        makeSnapshot('org-1', '2026-01-01T00:00:00Z', []),
        makeSnapshot('org-1', '2026-01-01T01:00:00Z', []),
      ];
      // 10% change over 1 hour, at 50% now => 50% remaining => 5 hours
      const result = computePredictedTimeToLimit(snapshots, 10, 50);
      expect(result).toBe(5);
    });
  });

  describe('computeTrendData', () => {
    it('should return stable trend for insufficient data points', () => {
      const snapshots = [
        makeSnapshot('org-1', '2026-01-01T00:00:00Z', makeLimits('DailyApiRequests', 50)),
      ];
      const result = computeTrendData({ limitName: 'DailyApiRequests', snapshots });
      expect(result).toEqual({
        limitName: 'DailyApiRequests',
        direction: 'stable',
        changePercent: 0,
        predictedTimeToLimit: undefined,
        sparklineData: [50],
        timestamps: ['2026-01-01T00:00:00Z'],
      });
    });

    it('should compute trend without prediction by default', () => {
      const snapshots = [
        makeSnapshot('org-1', '2026-01-01T00:00:00Z', makeLimits('DailyApiRequests', 10)),
        makeSnapshot('org-1', '2026-01-01T01:00:00Z', makeLimits('DailyApiRequests', 30)),
      ];
      const result = computeTrendData({ limitName: 'DailyApiRequests', snapshots });
      expect(result.direction).toBe('up');
      expect(result.changePercent).toBe(20);
      expect(result.predictedTimeToLimit).toBeUndefined();
    });

    it('should compute trend with prediction when predictTime is true', () => {
      const snapshots = [
        makeSnapshot('org-1', '2026-01-01T00:00:00Z', makeLimits('DailyApiRequests', 10)),
        makeSnapshot('org-1', '2026-01-01T01:00:00Z', makeLimits('DailyApiRequests', 30)),
      ];
      const result = computeTrendData({ limitName: 'DailyApiRequests', snapshots, predictTime: true });
      expect(result.direction).toBe('up');
      expect(result.changePercent).toBe(20);
      expect(result.predictedTimeToLimit).toBeDefined();
      // 20% change over 1 hour, at 30% => 70% remaining => 3.5 hours
      expect(result.predictedTimeToLimit).toBe(3.5);
    });

    it('should return timestamps array parallel to sparklineData', () => {
      const snapshots = [
        makeSnapshot('org-1', '2026-01-01T00:00:00Z', makeLimits('DailyApiRequests', 10)),
        makeSnapshot('org-1', '2026-01-01T01:00:00Z', makeLimits('DailyApiRequests', 30)),
      ];
      const result = computeTrendData({ limitName: 'DailyApiRequests', snapshots });
      expect(result.timestamps).toEqual(['2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z']);
      expect(result.timestamps).toHaveLength(result.sparklineData.length);
    });

    it('should not predict time for down trends even with predictTime true', () => {
      const snapshots = [
        makeSnapshot('org-1', '2026-01-01T00:00:00Z', makeLimits('DailyApiRequests', 80)),
        makeSnapshot('org-1', '2026-01-01T01:00:00Z', makeLimits('DailyApiRequests', 50)),
      ];
      const result = computeTrendData({ limitName: 'DailyApiRequests', snapshots, predictTime: true });
      expect(result.direction).toBe('down');
      expect(result.predictedTimeToLimit).toBeUndefined();
    });
  });
});
