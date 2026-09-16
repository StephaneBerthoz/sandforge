import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LimitsSnapshot } from '@sandforge/shared';
import { TrendStorage } from './TrendStorage';
import { ConfigStore } from '../../core/storage/ConfigStore';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend';

function createSnapshot(
  orgId: string,
  timestamp: string,
  limits: Array<{ name: string; max: number; remaining: number; usedPercent: number }>,
): LimitsSnapshot {
  return { orgId, limits, timestamp };
}

function makeSimpleLimits(
  usedPercent: number,
): Array<{ name: string; max: number; remaining: number; usedPercent: number }> {
  return [
    {
      name: 'DailyApiRequests',
      max: 15000,
      remaining: Math.round(15000 * (1 - usedPercent / 100)),
      usedPercent,
    },
    { name: 'DataStorageMB', max: 5120, remaining: 3000, usedPercent: 41 },
  ];
}

describe('TrendStorage', () => {
  let configStore: ConfigStore;
  let storage: TrendStorage;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-24T12:00:00Z'));
    const backend = new InMemoryConfigStoreBackend();
    configStore = new ConfigStore(backend);
    configStore.initialize();
    storage = new TrendStorage(configStore);
  });

  afterEach(() => {
    // Restore real timers: leaked fake timers poison other test files that
    // share the same vitest worker (e.g. SeedOpsHandler's real-timeout test).
    vi.useRealTimers();
  });

  describe('record()', () => {
    it('should store a snapshot for an org', () => {
      const snapshot = createSnapshot('org-1', '2026-02-24T12:00:00Z', makeSimpleLimits(50));
      storage.record('org-1', snapshot);

      const history = storage.getHistory('org-1');
      expect(history).toHaveLength(1);
      expect(history[0].orgId).toBe('org-1');
    });

    it('should rate-limit saves to 1 per 15 minutes per org', () => {
      const snap1 = createSnapshot('org-1', '2026-02-24T12:00:00Z', makeSimpleLimits(50));
      const snap2 = createSnapshot('org-1', '2026-02-24T12:05:00Z', makeSimpleLimits(55));

      storage.record('org-1', snap1);
      vi.advanceTimersByTime(5 * 60 * 1000); // 5 minutes
      storage.record('org-1', snap2);

      const history = storage.getHistory('org-1');
      expect(history).toHaveLength(1);
    });

    it('should allow save after 15 minutes', () => {
      const snap1 = createSnapshot('org-1', '2026-02-24T12:00:00Z', makeSimpleLimits(50));
      storage.record('org-1', snap1);

      vi.advanceTimersByTime(15 * 60 * 1000); // 15 minutes
      const snap2 = createSnapshot('org-1', '2026-02-24T12:15:00Z', makeSimpleLimits(55));
      storage.record('org-1', snap2);

      const history = storage.getHistory('org-1');
      expect(history).toHaveLength(2);
    });

    it('should rate-limit per org independently', () => {
      const snap1 = createSnapshot('org-1', '2026-02-24T12:00:00Z', makeSimpleLimits(50));
      const snap2 = createSnapshot('org-2', '2026-02-24T12:00:00Z', makeSimpleLimits(60));

      storage.record('org-1', snap1);
      storage.record('org-2', snap2);

      expect(storage.getHistory('org-1')).toHaveLength(1);
      expect(storage.getHistory('org-2')).toHaveLength(1);
    });

    it('should auto-purge snapshots older than 7 days', () => {
      // Record an old snapshot at the beginning of the test
      const oldSnap = createSnapshot('org-1', '2026-02-15T12:00:00Z', makeSimpleLimits(30));
      // Manually set a snapshot via ConfigStore to simulate old data
      // (bypassing rate limiter by writing directly)
      const key = 'trend:org-1';
      configStore.set(key, [oldSnap], 'trends');

      // Now record a new snapshot 8 days later (rate limiter should allow)
      vi.setSystemTime(new Date('2026-02-23T12:00:00Z'));
      const newSnap = createSnapshot('org-1', '2026-02-23T12:00:00Z', makeSimpleLimits(50));
      storage.record('org-1', newSnap);

      const history = storage.getHistory('org-1', 30 * 24 * 60 * 60 * 1000); // 30 days window
      expect(history).toHaveLength(1);
      expect(history[0].timestamp).toBe('2026-02-23T12:00:00Z');
    });
  });

  describe('getHistory()', () => {
    it('should return empty array when no data exists', () => {
      const history = storage.getHistory('nonexistent');
      expect(history).toEqual([]);
    });

    it('should filter by period', () => {
      // Record 3 snapshots at different times
      vi.setSystemTime(new Date('2026-02-24T06:00:00Z'));
      storage.record(
        'org-1',
        createSnapshot('org-1', '2026-02-24T06:00:00Z', makeSimpleLimits(40)),
      );

      vi.advanceTimersByTime(15 * 60 * 1000);
      vi.setSystemTime(new Date('2026-02-24T10:00:00Z'));
      storage.record(
        'org-1',
        createSnapshot('org-1', '2026-02-24T10:00:00Z', makeSimpleLimits(50)),
      );

      vi.advanceTimersByTime(15 * 60 * 1000);
      vi.setSystemTime(new Date('2026-02-24T12:00:00Z'));
      storage.record(
        'org-1',
        createSnapshot('org-1', '2026-02-24T12:00:00Z', makeSimpleLimits(60)),
      );

      // Get only last 3 hours
      const recent = storage.getHistory('org-1', 3 * 60 * 60 * 1000);
      expect(recent).toHaveLength(2); // 10:00 and 12:00 are within 3h of 12:00

      // Get all 24h
      const allDay = storage.getHistory('org-1', 24 * 60 * 60 * 1000);
      expect(allDay).toHaveLength(3);
    });
  });

  describe('getTrendData()', () => {
    it('should return stable trend for single data point', () => {
      storage.record(
        'org-1',
        createSnapshot('org-1', '2026-02-24T12:00:00Z', makeSimpleLimits(50)),
      );

      const trend = storage.getTrendData('org-1', 'DailyApiRequests');
      expect(trend.limitName).toBe('DailyApiRequests');
      expect(trend.direction).toBe('stable');
      expect(trend.changePercent).toBe(0);
      expect(trend.predictedTimeToLimit).toBeUndefined();
      expect(trend.sparklineData).toHaveLength(1);
    });

    it('should return stable trend for no data', () => {
      const trend = storage.getTrendData('org-1', 'DailyApiRequests');
      expect(trend.direction).toBe('stable');
      expect(trend.sparklineData).toHaveLength(0);
    });

    it('should detect increasing trend', () => {
      vi.setSystemTime(new Date('2026-02-24T10:00:00Z'));
      storage.record(
        'org-1',
        createSnapshot('org-1', '2026-02-24T10:00:00Z', makeSimpleLimits(50)),
      );

      vi.advanceTimersByTime(15 * 60 * 1000);
      vi.setSystemTime(new Date('2026-02-24T10:15:00Z'));
      storage.record(
        'org-1',
        createSnapshot('org-1', '2026-02-24T10:15:00Z', makeSimpleLimits(60)),
      );

      vi.advanceTimersByTime(15 * 60 * 1000);
      vi.setSystemTime(new Date('2026-02-24T10:30:00Z'));
      storage.record(
        'org-1',
        createSnapshot('org-1', '2026-02-24T10:30:00Z', makeSimpleLimits(70)),
      );

      const trend = storage.getTrendData('org-1', 'DailyApiRequests');
      expect(trend.direction).toBe('up');
      expect(trend.changePercent).toBe(20);
      expect(trend.sparklineData).toEqual([50, 60, 70]);
      expect(trend.predictedTimeToLimit).toBeDefined();
      expect(trend.predictedTimeToLimit).toBeGreaterThan(0);
    });

    it('should detect decreasing trend', () => {
      vi.setSystemTime(new Date('2026-02-24T10:00:00Z'));
      storage.record(
        'org-1',
        createSnapshot('org-1', '2026-02-24T10:00:00Z', makeSimpleLimits(70)),
      );

      vi.advanceTimersByTime(15 * 60 * 1000);
      vi.setSystemTime(new Date('2026-02-24T10:15:00Z'));
      storage.record(
        'org-1',
        createSnapshot('org-1', '2026-02-24T10:15:00Z', makeSimpleLimits(55)),
      );

      const trend = storage.getTrendData('org-1', 'DailyApiRequests');
      expect(trend.direction).toBe('down');
      expect(trend.changePercent).toBe(-15);
      expect(trend.predictedTimeToLimit).toBeUndefined();
    });

    it('should detect stable trend for small changes', () => {
      vi.setSystemTime(new Date('2026-02-24T10:00:00Z'));
      storage.record(
        'org-1',
        createSnapshot('org-1', '2026-02-24T10:00:00Z', makeSimpleLimits(50)),
      );

      vi.advanceTimersByTime(15 * 60 * 1000);
      vi.setSystemTime(new Date('2026-02-24T10:15:00Z'));
      storage.record(
        'org-1',
        createSnapshot('org-1', '2026-02-24T10:15:00Z', makeSimpleLimits(51)),
      );

      const trend = storage.getTrendData('org-1', 'DailyApiRequests');
      expect(trend.direction).toBe('stable');
    });

    it('should return timestamps array with ISO strings matching snapshot timestamps', () => {
      vi.setSystemTime(new Date('2026-02-24T10:00:00Z'));
      storage.record(
        'org-1',
        createSnapshot('org-1', '2026-02-24T10:00:00Z', makeSimpleLimits(50)),
      );

      vi.advanceTimersByTime(15 * 60 * 1000);
      vi.setSystemTime(new Date('2026-02-24T10:15:00Z'));
      storage.record(
        'org-1',
        createSnapshot('org-1', '2026-02-24T10:15:00Z', makeSimpleLimits(60)),
      );

      const trend = storage.getTrendData('org-1', 'DailyApiRequests');
      expect(trend.timestamps).toEqual(['2026-02-24T10:00:00Z', '2026-02-24T10:15:00Z']);
      expect(trend.timestamps).toHaveLength(trend.sparklineData.length);
    });

    it('should return empty timestamps for no data', () => {
      const trend = storage.getTrendData('org-1', 'DailyApiRequests');
      expect(trend.timestamps).toEqual([]);
    });

    it('should return correct sparkline data for a specific limit', () => {
      vi.setSystemTime(new Date('2026-02-24T10:00:00Z'));
      storage.record(
        'org-1',
        createSnapshot('org-1', '2026-02-24T10:00:00Z', makeSimpleLimits(30)),
      );

      vi.advanceTimersByTime(15 * 60 * 1000);
      vi.setSystemTime(new Date('2026-02-24T10:15:00Z'));
      storage.record(
        'org-1',
        createSnapshot('org-1', '2026-02-24T10:15:00Z', makeSimpleLimits(45)),
      );

      // DataStorageMB is always 41% in makeSimpleLimits
      const storageTrend = storage.getTrendData('org-1', 'DataStorageMB');
      expect(storageTrend.sparklineData).toEqual([41, 41]);
      expect(storageTrend.direction).toBe('stable');
    });
  });

  describe('purge()', () => {
    it('should clear all data for an org', () => {
      storage.record(
        'org-1',
        createSnapshot('org-1', '2026-02-24T12:00:00Z', makeSimpleLimits(50)),
      );
      expect(storage.getHistory('org-1')).toHaveLength(1);

      storage.purge('org-1');
      expect(storage.getHistory('org-1')).toHaveLength(0);
    });

    it('should reset rate limiter for purged org', () => {
      storage.record(
        'org-1',
        createSnapshot('org-1', '2026-02-24T12:00:00Z', makeSimpleLimits(50)),
      );
      storage.purge('org-1');

      // Should be able to record immediately after purge
      storage.record(
        'org-1',
        createSnapshot('org-1', '2026-02-24T12:01:00Z', makeSimpleLimits(55)),
      );
      expect(storage.getHistory('org-1')).toHaveLength(1);
    });

    it('should not affect other orgs', () => {
      storage.record(
        'org-1',
        createSnapshot('org-1', '2026-02-24T12:00:00Z', makeSimpleLimits(50)),
      );
      storage.record(
        'org-2',
        createSnapshot('org-2', '2026-02-24T12:00:00Z', makeSimpleLimits(60)),
      );

      storage.purge('org-1');

      expect(storage.getHistory('org-1')).toHaveLength(0);
      expect(storage.getHistory('org-2')).toHaveLength(1);
    });
  });

  describe('a week of history', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const QUARTER_HOUR_MS = 15 * 60 * 1000;

    /**
     * A /limits response the size of a real org's: the six limits the
     * dashboard trends, among the fifty-odd others the endpoint returns.
     */
    function realSizeLimits(
      usedPercent: number,
    ): Array<{ name: string; max: number; remaining: number; usedPercent: number }> {
      const trended = [
        'DailyApiRequests',
        'DataStorageMB',
        'FileStorageMB',
        'DailySoqlQueries',
        'DailyDmlStatements',
        'DailyAsyncApexExecutions',
      ];
      const others = Array.from({ length: 47 }, (_, i) => `HourlyPublishedPlatformEvents${i}`);
      return [...trended, ...others].map((name, i) => ({
        name,
        max: 250_000 + i,
        remaining: 240_000 + i,
        usedPercent,
      }));
    }

    it('keeps seven days of snapshots of a real-size /limits response under the size cap', () => {
      const start = new Date('2026-02-17T12:00:00Z').getTime();
      const saves = 7 * 96;
      for (let i = 0; i < saves; i++) {
        const now = start + i * QUARTER_HOUR_MS;
        vi.setSystemTime(now);
        storage.record(
          'org-1',
          createSnapshot('org-1', new Date(now).toISOString(), realSizeLimits(10)),
        );
      }

      const history = storage.getHistory('org-1', 7 * DAY_MS);
      const spanMs =
        Date.parse(history[history.length - 1].timestamp) - Date.parse(history[0].timestamp);
      expect(spanMs).toBeGreaterThanOrEqual(7 * DAY_MS - 2 * QUARTER_HOUR_MS);
    });

    it('charts the week, judges direction on the last day, and reads the store once', () => {
      const now = Date.parse('2026-02-24T12:00:00Z');
      const at = (msAgo: number): string => new Date(now - msAgo).toISOString();
      configStore.set(
        'trend:org-1',
        [
          createSnapshot('org-1', at(6 * DAY_MS), makeSimpleLimits(90)),
          createSnapshot('org-1', at(3 * 60 * 60 * 1000), makeSimpleLimits(10)),
          createSnapshot('org-1', at(2 * 60 * 60 * 1000), makeSimpleLimits(20)),
        ],
        'trends',
      );
      const read = vi.spyOn(configStore, 'get');

      const trends = storage.recordAndGetTrends(
        'org-1',
        createSnapshot('org-1', at(0), makeSimpleLimits(30)),
        ['DailyApiRequests', 'DataStorageMB'],
      );

      expect(read).toHaveBeenCalledTimes(1);
      expect(trends.DailyApiRequests.timestamps).toEqual([
        at(6 * DAY_MS),
        at(3 * 60 * 60 * 1000),
        at(2 * 60 * 60 * 1000),
        at(0),
      ]);
      expect(trends.DailyApiRequests.sparklineData).toEqual([90, 10, 20, 30]);
      // A daily counter resets every day: a week-long delta (90 -> 30) would
      // call a climbing day "down". The verdict reads the last 24 hours only.
      expect(trends.DailyApiRequests.direction).toBe('up');
      expect(trends.DailyApiRequests.changePercent).toBe(20);
      expect(trends.DataStorageMB.sparklineData).toEqual([41, 41, 41, 41]);
    });

    it('stores only the limits it trends', () => {
      storage.record('org-1', createSnapshot('org-1', '2026-02-24T12:00:00Z', realSizeLimits(10)));

      const [stored] = storage.getHistory('org-1');
      expect(stored.limits.map((l) => l.name)).toEqual([
        'DailyApiRequests',
        'DataStorageMB',
        'FileStorageMB',
        'DailySoqlQueries',
        'DailyDmlStatements',
        'DailyAsyncApexExecutions',
      ]);
    });
  });

  describe('size limit', () => {
    it('drops the oldest snapshots once the history outgrows 500 KB, and keeps the newest', () => {
      // Only trended limits survive the narrowing, so a snapshot is made large
      // by repeating one of them: about 43 KB each, the cap is passed at the
      // twelfth save.
      const wideLimits = Array.from({ length: 600 }, (_, i) => ({
        name: 'DailyApiRequests',
        max: 15_000 + i,
        remaining: 5000,
        usedPercent: 50,
      }));

      const recorded = 30;
      let newest = '';
      for (let i = 0; i < recorded; i++) {
        vi.advanceTimersByTime(15 * 60 * 1000);
        newest = new Date(Date.now()).toISOString();
        storage.record('org-1', createSnapshot('org-1', newest, wideLimits));
      }

      const history = storage.getHistory('org-1', 7 * 24 * 60 * 60 * 1000);
      expect(history.length).toBeGreaterThan(0);
      expect(history.length).toBeLessThan(recorded);
      expect(new TextEncoder().encode(JSON.stringify(history)).length).toBeLessThanOrEqual(
        500 * 1024,
      );
      expect(history[history.length - 1].timestamp).toBe(newest);
    });
  });
});
