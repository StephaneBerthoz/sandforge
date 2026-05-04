import { describe, it, expect, vi } from 'vitest';
import { ApiLimitCheck } from './ApiLimitCheck';
import type { FetchLimitsFn, ApiLimitData } from './ApiLimitCheck';
import type { PreCheckConfig } from '@sandforge/shared';

function createConfig(overrides?: Partial<PreCheckConfig>): PreCheckConfig {
  return {
    categories: ['api_limits'],
    skipWarnings: false,
    autoFix: false,
    targetOrgId: 'org-001',
    module: 'sync',
    operationConfig: {},
    ...overrides,
  };
}

function createLimitData(overrides?: Partial<ApiLimitData>): ApiLimitData {
  return {
    dailyApiRequests: { current: 1000, max: 100_000 },
    concurrentApiRequests: { current: 2, max: 25 },
    bulkApiJobSlots: { current: 1, max: 100 },
    ...overrides,
  };
}

describe('ApiLimitCheck', () => {
  describe('check', () => {
    it('should return 3 items for daily, concurrent, and bulk checks', async () => {
      const fetchFn: FetchLimitsFn = vi.fn().mockResolvedValue(createLimitData());
      const checker = new ApiLimitCheck(fetchFn);
      const items = await checker.check(createConfig());

      expect(items).toHaveLength(3);
    });

    it('should pass daily API check when quota is sufficient', async () => {
      const fetchFn: FetchLimitsFn = vi
        .fn()
        .mockResolvedValue(createLimitData({ dailyApiRequests: { current: 1000, max: 100_000 } }));

      const checker = new ApiLimitCheck(fetchFn);
      const items = await checker.check(createConfig());
      const dailyItem = items.find((i) => i.name === 'Daily API Requests');

      expect(dailyItem?.passed).toBe(true);
      expect(dailyItem?.severity).toBe('info');
    });

    it('should blocker when daily API quota is below 10%', async () => {
      const fetchFn: FetchLimitsFn = vi
        .fn()
        .mockResolvedValue(
          createLimitData({ dailyApiRequests: { current: 95_000, max: 100_000 } }),
        );

      const checker = new ApiLimitCheck(fetchFn);
      const items = await checker.check(createConfig());
      const dailyItem = items.find((i) => i.name === 'Daily API Requests');

      expect(dailyItem?.severity).toBe('blocker');
    });

    it('should error when daily API quota is below 20%', async () => {
      const fetchFn: FetchLimitsFn = vi
        .fn()
        .mockResolvedValue(
          createLimitData({ dailyApiRequests: { current: 85_000, max: 100_000 } }),
        );

      const checker = new ApiLimitCheck(fetchFn);
      const items = await checker.check(createConfig());
      const dailyItem = items.find((i) => i.name === 'Daily API Requests');

      expect(dailyItem?.severity).toBe('error');
    });

    it('should warn when daily API quota is below 40%', async () => {
      const fetchFn: FetchLimitsFn = vi
        .fn()
        .mockResolvedValue(
          createLimitData({ dailyApiRequests: { current: 65_000, max: 100_000 } }),
        );

      const checker = new ApiLimitCheck(fetchFn);
      const items = await checker.check(createConfig());
      const dailyItem = items.find((i) => i.name === 'Daily API Requests');

      expect(dailyItem?.severity).toBe('warning');
    });

    it('should blocker when estimated exceeds remaining quota', async () => {
      const fetchFn: FetchLimitsFn = vi
        .fn()
        .mockResolvedValue(
          createLimitData({ dailyApiRequests: { current: 99_998, max: 100_000 } }),
        );

      const config = createConfig({
        operationConfig: { recordCount: 10_000, batchSize: 200 },
      });

      const checker = new ApiLimitCheck(fetchFn);
      const items = await checker.check(config);
      const dailyItem = items.find((i) => i.name === 'Daily API Requests');

      expect(dailyItem?.passed).toBe(false);
      expect(dailyItem?.severity).toBe('blocker');
    });

    it('should estimate API calls based on record count and batch size', async () => {
      const fetchFn: FetchLimitsFn = vi
        .fn()
        .mockResolvedValue(createLimitData({ dailyApiRequests: { current: 0, max: 100_000 } }));

      const config = createConfig({
        operationConfig: { recordCount: 1000, batchSize: 200 },
      });

      const checker = new ApiLimitCheck(fetchFn);
      const items = await checker.check(config);
      const dailyItem = items.find((i) => i.name === 'Daily API Requests');

      expect(dailyItem?.message).toContain('~10');
    });

    it('should check concurrent API request slots', async () => {
      const fetchFn: FetchLimitsFn = vi
        .fn()
        .mockResolvedValue(createLimitData({ concurrentApiRequests: { current: 25, max: 25 } }));

      const checker = new ApiLimitCheck(fetchFn);
      const items = await checker.check(createConfig());
      const concurrentItem = items.find((i) => i.name === 'Concurrent API Requests');

      expect(concurrentItem?.passed).toBe(false);
    });

    it('should pass concurrent check when slots are available', async () => {
      const fetchFn: FetchLimitsFn = vi
        .fn()
        .mockResolvedValue(createLimitData({ concurrentApiRequests: { current: 5, max: 25 } }));

      const checker = new ApiLimitCheck(fetchFn);
      const items = await checker.check(createConfig());
      const concurrentItem = items.find((i) => i.name === 'Concurrent API Requests');

      expect(concurrentItem?.passed).toBe(true);
    });

    it('should check Bulk API job slots', async () => {
      const fetchFn: FetchLimitsFn = vi
        .fn()
        .mockResolvedValue(createLimitData({ bulkApiJobSlots: { current: 100, max: 100 } }));

      const checker = new ApiLimitCheck(fetchFn);
      const items = await checker.check(createConfig());
      const bulkItem = items.find((i) => i.name === 'Bulk API Job Slots');

      expect(bulkItem?.passed).toBe(false);
    });

    it('should set all items to category api_limits', async () => {
      const fetchFn: FetchLimitsFn = vi.fn().mockResolvedValue(createLimitData());
      const checker = new ApiLimitCheck(fetchFn);
      const items = await checker.check(createConfig());

      for (const item of items) {
        expect(item.category).toBe('api_limits');
      }
    });

    it('should include ApiLimitCheckDetail in details', async () => {
      const fetchFn: FetchLimitsFn = vi.fn().mockResolvedValue(createLimitData());
      const checker = new ApiLimitCheck(fetchFn);
      const items = await checker.check(createConfig());
      const dailyItem = items.find((i) => i.name === 'Daily API Requests');

      expect(dailyItem?.details).toHaveProperty('limitName', 'DailyApiRequests');
      expect(dailyItem?.details).toHaveProperty('current');
      expect(dailyItem?.details).toHaveProperty('max');
      expect(dailyItem?.details).toHaveProperty('estimated');
      expect(dailyItem?.details).toHaveProperty('sufficient');
    });

    it('should call fetchLimits with correct orgId', async () => {
      const fetchFn: FetchLimitsFn = vi.fn().mockResolvedValue(createLimitData());
      const checker = new ApiLimitCheck(fetchFn);
      await checker.check(createConfig({ targetOrgId: 'org-xyz' }));

      expect(fetchFn).toHaveBeenCalledWith('org-xyz');
    });

    it('should use default 10 estimated calls when no recordCount', async () => {
      const fetchFn: FetchLimitsFn = vi
        .fn()
        .mockResolvedValue(createLimitData({ dailyApiRequests: { current: 0, max: 100_000 } }));

      const checker = new ApiLimitCheck(fetchFn);
      const items = await checker.check(createConfig({ operationConfig: {} }));
      const dailyItem = items.find((i) => i.name === 'Daily API Requests');

      expect(dailyItem?.message).toContain('~10');
    });

    it('should mark all items as not autoFixable', async () => {
      const fetchFn: FetchLimitsFn = vi.fn().mockResolvedValue(createLimitData());
      const checker = new ApiLimitCheck(fetchFn);
      const items = await checker.check(createConfig());

      for (const item of items) {
        expect(item.autoFixable).toBe(false);
      }
    });

    it('should handle edge case where max is 0', async () => {
      const fetchFn: FetchLimitsFn = vi.fn().mockResolvedValue(
        createLimitData({
          dailyApiRequests: { current: 0, max: 0 },
          concurrentApiRequests: { current: 0, max: 0 },
          bulkApiJobSlots: { current: 0, max: 0 },
        }),
      );

      const checker = new ApiLimitCheck(fetchFn);
      const items = await checker.check(createConfig());

      expect(items).toHaveLength(3);
    });
  });
});
