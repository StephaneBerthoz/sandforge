import { describe, it, expect, beforeEach } from 'vitest';
import { GovernorLimitPredictor } from './GovernorLimitPredictor';
import type { LimitsTracker } from './LimitsTracker';
import type { LimitsSnapshot } from '@sandforge/shared';

function createSnapshot(
  orgId: string,
  limitName: string,
  usedPercent: number,
  timestamp: string,
): LimitsSnapshot {
  return {
    orgId,
    limits: [
      {
        name: limitName,
        max: 100,
        remaining: 100 - usedPercent,
        usedPercent,
      },
    ],
    timestamp,
  };
}

function createMultiLimitSnapshot(
  orgId: string,
  limits: Array<{ name: string; usedPercent: number }>,
  timestamp: string,
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

describe('GovernorLimitPredictor', () => {
  let predictor: GovernorLimitPredictor;
  let mockTracker: LimitsTracker;
  let historyStore: Map<string, LimitsSnapshot[]>;

  beforeEach(() => {
    historyStore = new Map();
    mockTracker = {
      getHistory: (orgId: string) => historyStore.get(orgId) ?? [],
    } as unknown as LimitsTracker;
    predictor = new GovernorLimitPredictor(mockTracker);
  });

  describe('predict', () => {
    it('should return empty predictions when insufficient history', () => {
      historyStore.set('org-1', [
        createSnapshot('org-1', 'DailyApiRequests', 10, '2026-01-01T00:00:00Z'),
      ]);

      const predictions = predictor.predict('org-1');
      expect(predictions).toEqual([]);
    });

    it('should return predictions for all tracked limits', () => {
      historyStore.set('org-1', [
        createMultiLimitSnapshot(
          'org-1',
          [
            { name: 'DailyApiRequests', usedPercent: 10 },
            { name: 'DailyBulkApiRequests', usedPercent: 5 },
          ],
          '2026-01-01T00:00:00Z',
        ),
        createMultiLimitSnapshot(
          'org-1',
          [
            { name: 'DailyApiRequests', usedPercent: 20 },
            { name: 'DailyBulkApiRequests', usedPercent: 8 },
          ],
          '2026-01-01T01:00:00Z',
        ),
      ]);

      const predictions = predictor.predict('org-1');
      expect(predictions).toHaveLength(2);
    });

    it('should return empty for an unknown org', () => {
      expect(predictor.predict('unknown')).toEqual([]);
    });
  });

  describe('predictLimit', () => {
    it('should detect an increasing trend', () => {
      const snapshots = [
        createSnapshot('org-1', 'DailyApiRequests', 10, '2026-01-01T00:00:00Z'),
        createSnapshot('org-1', 'DailyApiRequests', 20, '2026-01-01T01:00:00Z'),
        createSnapshot('org-1', 'DailyApiRequests', 30, '2026-01-01T02:00:00Z'),
        createSnapshot('org-1', 'DailyApiRequests', 40, '2026-01-01T03:00:00Z'),
      ];

      const prediction = predictor.predictLimit(snapshots, 'DailyApiRequests');

      expect(prediction.trend).toBe('increasing');
      expect(prediction.currentPercent).toBe(40);
      expect(prediction.predictedPercent).toBeGreaterThan(40);
    });

    it('should detect a decreasing trend', () => {
      const snapshots = [
        createSnapshot('org-1', 'DailyApiRequests', 80, '2026-01-01T00:00:00Z'),
        createSnapshot('org-1', 'DailyApiRequests', 60, '2026-01-01T01:00:00Z'),
        createSnapshot('org-1', 'DailyApiRequests', 40, '2026-01-01T02:00:00Z'),
        createSnapshot('org-1', 'DailyApiRequests', 20, '2026-01-01T03:00:00Z'),
      ];

      const prediction = predictor.predictLimit(snapshots, 'DailyApiRequests');

      expect(prediction.trend).toBe('decreasing');
      expect(prediction.predictedPercent).toBeLessThan(20);
    });

    it('should detect a stable trend', () => {
      const snapshots = [
        createSnapshot('org-1', 'DailyApiRequests', 50, '2026-01-01T00:00:00Z'),
        createSnapshot('org-1', 'DailyApiRequests', 50, '2026-01-01T01:00:00Z'),
        createSnapshot('org-1', 'DailyApiRequests', 50, '2026-01-01T02:00:00Z'),
      ];

      const prediction = predictor.predictLimit(snapshots, 'DailyApiRequests');

      expect(prediction.trend).toBe('stable');
    });

    it('should predict time to exhaustion for increasing trends', () => {
      const snapshots = [
        createSnapshot('org-1', 'DailyApiRequests', 70, '2026-01-01T00:00:00Z'),
        createSnapshot('org-1', 'DailyApiRequests', 80, '2026-01-01T01:00:00Z'),
        createSnapshot('org-1', 'DailyApiRequests', 90, '2026-01-01T02:00:00Z'),
      ];

      const prediction = predictor.predictLimit(snapshots, 'DailyApiRequests');

      expect(prediction.predictedTimeToExhaustion).toBeDefined();
      expect(prediction.predictedTimeToExhaustion!).toBeGreaterThan(0);
    });

    it('should not predict exhaustion for decreasing trends', () => {
      const snapshots = [
        createSnapshot('org-1', 'DailyApiRequests', 50, '2026-01-01T00:00:00Z'),
        createSnapshot('org-1', 'DailyApiRequests', 40, '2026-01-01T01:00:00Z'),
        createSnapshot('org-1', 'DailyApiRequests', 30, '2026-01-01T02:00:00Z'),
      ];

      const prediction = predictor.predictLimit(snapshots, 'DailyApiRequests');

      expect(prediction.predictedTimeToExhaustion).toBeUndefined();
    });

    it('should clamp predicted percent between 0 and 100', () => {
      const snapshots = [
        createSnapshot('org-1', 'DailyApiRequests', 95, '2026-01-01T00:00:00Z'),
        createSnapshot('org-1', 'DailyApiRequests', 98, '2026-01-01T01:00:00Z'),
        createSnapshot('org-1', 'DailyApiRequests', 99, '2026-01-01T02:00:00Z'),
      ];

      const prediction = predictor.predictLimit(snapshots, 'DailyApiRequests');

      expect(prediction.predictedPercent).toBeLessThanOrEqual(100);
      expect(prediction.predictedPercent).toBeGreaterThanOrEqual(0);
    });

    it('should return stable with zero confidence for insufficient data', () => {
      const snapshots = [createSnapshot('org-1', 'DailyApiRequests', 50, '2026-01-01T00:00:00Z')];

      const prediction = predictor.predictLimit(snapshots, 'DailyApiRequests');

      expect(prediction.trend).toBe('stable');
      expect(prediction.confidence).toBe(0);
    });

    it('should handle a limit not present in snapshots', () => {
      const snapshots = [
        createSnapshot('org-1', 'DailyApiRequests', 50, '2026-01-01T00:00:00Z'),
        createSnapshot('org-1', 'DailyApiRequests', 60, '2026-01-01T01:00:00Z'),
      ];

      const prediction = predictor.predictLimit(snapshots, 'NonExistent');

      expect(prediction.limitName).toBe('NonExistent');
      expect(prediction.trend).toBe('stable');
      expect(prediction.confidence).toBe(0);
    });

    it('should have confidence between 0 and 1', () => {
      const snapshots = [
        createSnapshot('org-1', 'DailyApiRequests', 10, '2026-01-01T00:00:00Z'),
        createSnapshot('org-1', 'DailyApiRequests', 20, '2026-01-01T01:00:00Z'),
        createSnapshot('org-1', 'DailyApiRequests', 30, '2026-01-01T02:00:00Z'),
      ];

      const prediction = predictor.predictLimit(snapshots, 'DailyApiRequests');

      expect(prediction.confidence).toBeGreaterThanOrEqual(0);
      expect(prediction.confidence).toBeLessThanOrEqual(1);
    });
  });
});
