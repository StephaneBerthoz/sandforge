import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LimitsTracker } from './LimitsTracker';
import type { RawSalesforceLimits, QueryLimitsFn } from './LimitsTracker';

function createMockLimits(
  overrides?: Partial<Record<string, { Max: number; Remaining: number }>>,
): RawSalesforceLimits {
  return {
    DailyApiRequests: { Max: 15000, Remaining: 14000 },
    DailyBulkApiRequests: { Max: 10000, Remaining: 9500 },
    ConcurrentAsyncGetReportInstances: { Max: 200, Remaining: 200 },
    ...overrides,
  };
}

describe('LimitsTracker', () => {
  let tracker: LimitsTracker;
  let queryLimits: QueryLimitsFn;

  beforeEach(() => {
    queryLimits = vi
      .fn<Parameters<QueryLimitsFn>, ReturnType<QueryLimitsFn>>()
      .mockResolvedValue(createMockLimits());
    tracker = new LimitsTracker(queryLimits);
  });

  describe('fetch', () => {
    it('should fetch limits and return a snapshot', async () => {
      const snapshot = await tracker.fetch('org-1');

      expect(snapshot.orgId).toBe('org-1');
      expect(snapshot.limits).toHaveLength(3);
      expect(snapshot.timestamp).toBeDefined();
    });

    it('should call the queryLimits function with the correct orgId', async () => {
      await tracker.fetch('org-2');

      expect(queryLimits).toHaveBeenCalledWith('org-2');
    });

    it('should convert raw limits to ApiLimit format', async () => {
      const snapshot = await tracker.fetch('org-1');
      const dailyApi = snapshot.limits.find((l) => l.name === 'DailyApiRequests');

      expect(dailyApi).toBeDefined();
      expect(dailyApi!.max).toBe(15000);
      expect(dailyApi!.remaining).toBe(14000);
      expect(dailyApi!.usedPercent).toBeCloseTo(6.67, 1);
    });

    it('should handle limits with zero max gracefully', async () => {
      vi.mocked(queryLimits).mockResolvedValue({
        ZeroLimit: { Max: 0, Remaining: 0 },
      });

      const snapshot = await tracker.fetch('org-1');
      const zeroLimit = snapshot.limits.find((l) => l.name === 'ZeroLimit');

      expect(zeroLimit).toBeDefined();
      expect(zeroLimit!.usedPercent).toBe(0);
    });

    it('should cache the latest snapshot', async () => {
      await tracker.fetch('org-1');
      const cached = tracker.getSnapshot('org-1');

      expect(cached).toBeDefined();
      expect(cached!.orgId).toBe('org-1');
    });
  });

  describe('getSnapshot', () => {
    it('should return undefined for an org that has not been fetched', () => {
      const result = tracker.getSnapshot('unknown-org');
      expect(result).toBeUndefined();
    });

    it('should return the latest snapshot after a fetch', async () => {
      await tracker.fetch('org-1');
      const snapshot = tracker.getSnapshot('org-1');

      expect(snapshot).toBeDefined();
      expect(snapshot!.limits).toHaveLength(3);
    });
  });

  describe('getCriticalLimits', () => {
    it('should return limits above the threshold percentage', async () => {
      vi.mocked(queryLimits).mockResolvedValue({
        HighUsage: { Max: 100, Remaining: 5 },
        LowUsage: { Max: 100, Remaining: 90 },
      });

      await tracker.fetch('org-1');
      const critical = tracker.getCriticalLimits('org-1', 90);

      expect(critical).toHaveLength(1);
      expect(critical[0].name).toBe('HighUsage');
    });

    it('should return an empty array if no limits exceed threshold', async () => {
      await tracker.fetch('org-1');
      const critical = tracker.getCriticalLimits('org-1', 99);

      expect(critical).toEqual([]);
    });

    it('should return an empty array for an unknown org', () => {
      const critical = tracker.getCriticalLimits('unknown', 50);
      expect(critical).toEqual([]);
    });

    it('should include limits at exactly the threshold', async () => {
      vi.mocked(queryLimits).mockResolvedValue({
        ExactLimit: { Max: 100, Remaining: 50 },
      });

      await tracker.fetch('org-1');
      const critical = tracker.getCriticalLimits('org-1', 50);

      expect(critical).toHaveLength(1);
    });
  });

  describe('getHistory', () => {
    it('should return an empty array for an org with no history', () => {
      expect(tracker.getHistory('unknown')).toEqual([]);
    });

    it('should accumulate snapshots over multiple fetches', async () => {
      await tracker.fetch('org-1');
      await tracker.fetch('org-1');
      await tracker.fetch('org-1');

      expect(tracker.getHistory('org-1')).toHaveLength(3);
    });

    it('should not exceed 100 historical snapshots', async () => {
      for (let i = 0; i < 110; i++) {
        await tracker.fetch('org-1');
      }

      expect(tracker.getHistory('org-1')).toHaveLength(100);
    });

    it('should keep separate histories per org', async () => {
      await tracker.fetch('org-1');
      await tracker.fetch('org-2');
      await tracker.fetch('org-1');

      expect(tracker.getHistory('org-1')).toHaveLength(2);
      expect(tracker.getHistory('org-2')).toHaveLength(1);
    });
  });
});
