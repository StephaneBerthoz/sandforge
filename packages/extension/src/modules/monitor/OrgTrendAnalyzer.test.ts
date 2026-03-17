import { describe, it, expect, beforeEach } from 'vitest';
import { OrgTrendAnalyzer, calculateTrend } from './OrgTrendAnalyzer';
import type { TrendDataPoint } from './OrgTrendAnalyzer';
import type { LimitsTracker } from './LimitsTracker';
import type { JobMonitor } from './JobMonitor';
import type { LimitsSnapshot } from '@sandforge/shared';

function createSnapshot(
  orgId: string,
  limits: Array<{ name: string; usedPercent: number }>,
  timestamp: string
): LimitsSnapshot {
  return {
    orgId,
    limits: limits.map((l) => ({
      name: l.name,
      max: 100,
      remaining: 100 - l.usedPercent,
      usedPercent: l.usedPercent,
    })),
    timestamp,
  };
}

describe('OrgTrendAnalyzer', () => {
  let analyzer: OrgTrendAnalyzer;
  let mockLimitsTracker: LimitsTracker;
  let mockJobMonitor: JobMonitor;
  let historyStore: Map<string, LimitsSnapshot[]>;

  beforeEach(() => {
    historyStore = new Map();
    mockLimitsTracker = {
      getHistory: (orgId: string) => historyStore.get(orgId) ?? [],
    } as unknown as LimitsTracker;
    mockJobMonitor = {
      getJobStats: () => ({ total: 5, active: 2, completed: 2, failed: 1 }),
    } as unknown as JobMonitor;
    analyzer = new OrgTrendAnalyzer(mockLimitsTracker, mockJobMonitor);
  });

  describe('analyzeLimitTrend', () => {
    it('should return a trend analysis for a specific limit', () => {
      historyStore.set('org-1', [
        createSnapshot('org-1', [{ name: 'DailyApiRequests', usedPercent: 10 }], '2026-01-01T00:00:00Z'),
        createSnapshot('org-1', [{ name: 'DailyApiRequests', usedPercent: 20 }], '2026-01-01T01:00:00Z'),
        createSnapshot('org-1', [{ name: 'DailyApiRequests', usedPercent: 30 }], '2026-01-01T02:00:00Z'),
      ]);

      const result = analyzer.analyzeLimitTrend('org-1', 'DailyApiRequests');

      expect(result.metric).toBe('limit:DailyApiRequests');
      expect(result.orgId).toBe('org-1');
      expect(result.dataPoints).toHaveLength(3);
      expect(result.trend).toBe('increasing');
    });

    it('should detect a decreasing limit trend', () => {
      historyStore.set('org-1', [
        createSnapshot('org-1', [{ name: 'DailyApiRequests', usedPercent: 80 }], '2026-01-01T00:00:00Z'),
        createSnapshot('org-1', [{ name: 'DailyApiRequests', usedPercent: 60 }], '2026-01-01T01:00:00Z'),
        createSnapshot('org-1', [{ name: 'DailyApiRequests', usedPercent: 40 }], '2026-01-01T02:00:00Z'),
      ]);

      const result = analyzer.analyzeLimitTrend('org-1', 'DailyApiRequests');
      expect(result.trend).toBe('decreasing');
    });

    it('should detect a stable limit trend', () => {
      historyStore.set('org-1', [
        createSnapshot('org-1', [{ name: 'DailyApiRequests', usedPercent: 50 }], '2026-01-01T00:00:00Z'),
        createSnapshot('org-1', [{ name: 'DailyApiRequests', usedPercent: 50 }], '2026-01-01T01:00:00Z'),
        createSnapshot('org-1', [{ name: 'DailyApiRequests', usedPercent: 50 }], '2026-01-01T02:00:00Z'),
      ]);

      const result = analyzer.analyzeLimitTrend('org-1', 'DailyApiRequests');
      expect(result.trend).toBe('stable');
    });

    it('should return empty data points for a non-existent limit', () => {
      historyStore.set('org-1', [
        createSnapshot('org-1', [{ name: 'DailyApiRequests', usedPercent: 50 }], '2026-01-01T00:00:00Z'),
        createSnapshot('org-1', [{ name: 'DailyApiRequests', usedPercent: 60 }], '2026-01-01T01:00:00Z'),
      ]);

      const result = analyzer.analyzeLimitTrend('org-1', 'NonExistent');
      expect(result.dataPoints).toHaveLength(0);
    });

    it('should include a human-readable period string', () => {
      historyStore.set('org-1', [
        createSnapshot('org-1', [{ name: 'DailyApiRequests', usedPercent: 10 }], '2026-01-01T00:00:00Z'),
        createSnapshot('org-1', [{ name: 'DailyApiRequests', usedPercent: 20 }], '2026-01-01T02:00:00Z'),
      ]);

      const result = analyzer.analyzeLimitTrend('org-1', 'DailyApiRequests');
      expect(result.period).toBe('2h');
    });
  });

  describe('analyzeJobTrend', () => {
    it('should return a trend analysis for jobs', () => {
      const result = analyzer.analyzeJobTrend('org-1');

      expect(result.metric).toBe('jobs:active');
      expect(result.orgId).toBe('org-1');
      expect(result.dataPoints).toHaveLength(1);
    });

    it('should return stable trend with single data point', () => {
      const result = analyzer.analyzeJobTrend('org-1');
      expect(result.trend).toBe('stable');
    });
  });

  describe('getTopTrends', () => {
    it('should return empty array when no history exists', () => {
      expect(analyzer.getTopTrends('unknown')).toEqual([]);
    });

    it('should return trends sorted by absolute change percent', () => {
      historyStore.set('org-1', [
        createSnapshot('org-1', [
          { name: 'DailyApiRequests', usedPercent: 10 },
          { name: 'Storage', usedPercent: 50 },
        ], '2026-01-01T00:00:00Z'),
        createSnapshot('org-1', [
          { name: 'DailyApiRequests', usedPercent: 50 },
          { name: 'Storage', usedPercent: 55 },
        ], '2026-01-01T01:00:00Z'),
      ]);

      const trends = analyzer.getTopTrends('org-1');
      expect(trends.length).toBeGreaterThanOrEqual(2);
      expect(Math.abs(trends[0].changePercent)).toBeGreaterThanOrEqual(
        Math.abs(trends[1].changePercent)
      );
    });

    it('should include both limit trends and job trends', () => {
      historyStore.set('org-1', [
        createSnapshot('org-1', [{ name: 'DailyApiRequests', usedPercent: 10 }], '2026-01-01T00:00:00Z'),
        createSnapshot('org-1', [{ name: 'DailyApiRequests', usedPercent: 20 }], '2026-01-01T01:00:00Z'),
      ]);

      const trends = analyzer.getTopTrends('org-1');
      const metrics = trends.map((t) => t.metric);
      expect(metrics).toContain('limit:DailyApiRequests');
      expect(metrics).toContain('jobs:active');
    });
  });

  describe('calculateTrend', () => {
    it('should return stable with 0 change for insufficient data', () => {
      const result = calculateTrend([]);
      expect(result.trend).toBe('stable');
      expect(result.changePercent).toBe(0);
    });

    it('should return stable for a single point', () => {
      const result = calculateTrend([{ timestamp: '2026-01-01T00:00:00Z', value: 50 }]);
      expect(result.trend).toBe('stable');
    });

    it('should detect increasing trend', () => {
      const points: TrendDataPoint[] = [
        { timestamp: '2026-01-01T00:00:00Z', value: 10 },
        { timestamp: '2026-01-01T01:00:00Z', value: 20 },
        { timestamp: '2026-01-01T02:00:00Z', value: 30 },
      ];
      const result = calculateTrend(points);
      expect(result.trend).toBe('increasing');
      expect(result.changePercent).toBe(200);
    });

    it('should detect decreasing trend', () => {
      const points: TrendDataPoint[] = [
        { timestamp: '2026-01-01T00:00:00Z', value: 90 },
        { timestamp: '2026-01-01T01:00:00Z', value: 60 },
        { timestamp: '2026-01-01T02:00:00Z', value: 30 },
      ];
      const result = calculateTrend(points);
      expect(result.trend).toBe('decreasing');
      expect(result.changePercent).toBeCloseTo(-66.67, 1);
    });

    it('should handle zero start value', () => {
      const points: TrendDataPoint[] = [
        { timestamp: '2026-01-01T00:00:00Z', value: 0 },
        { timestamp: '2026-01-01T01:00:00Z', value: 10 },
      ];
      const result = calculateTrend(points);
      expect(result.changePercent).toBe(100);
    });
  });
});
