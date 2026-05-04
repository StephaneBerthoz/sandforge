import { describe, it, expect, vi } from 'vitest';
import { PerformanceCheck } from './PerformanceCheck';
import type { FetchPerformanceMetricsFn, PerformanceMetrics } from './PerformanceCheck';
import type { PreCheckConfig } from '@sandforge/shared';

function createConfig(overrides?: Partial<PreCheckConfig>): PreCheckConfig {
  return {
    categories: ['performance'],
    skipWarnings: false,
    autoFix: false,
    targetOrgId: 'org-001',
    module: 'sync',
    operationConfig: {},
    ...overrides,
  };
}

function createMetrics(overrides?: Partial<PerformanceMetrics>): PerformanceMetrics {
  return {
    avgResponseTimeMs: 100,
    recordCount: 5000,
    objectCount: 2,
    hasComplexTriggers: false,
    networkLatencyMs: 50,
    ...overrides,
  };
}

describe('PerformanceCheck', () => {
  describe('check', () => {
    it('should return 4 performance items', async () => {
      const fetchFn: FetchPerformanceMetricsFn = vi.fn().mockResolvedValue(createMetrics());
      const checker = new PerformanceCheck(fetchFn);
      const items = await checker.check(createConfig());

      expect(items).toHaveLength(4);
    });

    it('should include estimated duration item', async () => {
      const fetchFn: FetchPerformanceMetricsFn = vi.fn().mockResolvedValue(createMetrics());
      const checker = new PerformanceCheck(fetchFn);
      const items = await checker.check(createConfig());

      const durationItem = items.find((i) => i.name === 'Estimated Duration');
      expect(durationItem).toBeDefined();
      expect(durationItem?.category).toBe('performance');
    });

    it('should info for short duration', async () => {
      const fetchFn: FetchPerformanceMetricsFn = vi
        .fn()
        .mockResolvedValue(
          createMetrics({ recordCount: 100, avgResponseTimeMs: 50, networkLatencyMs: 10 }),
        );

      const checker = new PerformanceCheck(fetchFn);
      const items = await checker.check(createConfig({ operationConfig: { batchSize: 200 } }));
      const durationItem = items.find((i) => i.name === 'Estimated Duration');

      expect(durationItem?.severity).toBe('info');
      expect(durationItem?.passed).toBe(true);
    });

    it('should warn for duration over 15 minutes', async () => {
      const fetchFn: FetchPerformanceMetricsFn = vi
        .fn()
        .mockResolvedValue(
          createMetrics({ recordCount: 700_000, avgResponseTimeMs: 200, networkLatencyMs: 100 }),
        );

      const checker = new PerformanceCheck(fetchFn);
      const items = await checker.check(createConfig({ operationConfig: { batchSize: 200 } }));
      const durationItem = items.find((i) => i.name === 'Estimated Duration');

      expect(durationItem?.severity).toBe('warning');
    });

    it('should error for duration over 60 minutes', async () => {
      const fetchFn: FetchPerformanceMetricsFn = vi.fn().mockResolvedValue(
        createMetrics({
          recordCount: 500_000,
          avgResponseTimeMs: 500,
          networkLatencyMs: 200,
          hasComplexTriggers: true,
        }),
      );

      const checker = new PerformanceCheck(fetchFn);
      const items = await checker.check(createConfig({ operationConfig: { batchSize: 200 } }));
      const durationItem = items.find((i) => i.name === 'Estimated Duration');

      expect(durationItem?.severity).toBe('error');
      expect(durationItem?.passed).toBe(false);
    });

    it('should include batch size recommendation', async () => {
      const fetchFn: FetchPerformanceMetricsFn = vi.fn().mockResolvedValue(createMetrics());
      const checker = new PerformanceCheck(fetchFn);
      const items = await checker.check(createConfig());

      const batchItem = items.find((i) => i.name === 'Batch Size');
      expect(batchItem).toBeDefined();
    });

    it('should recommend smaller batch for complex triggers', async () => {
      const fetchFn: FetchPerformanceMetricsFn = vi
        .fn()
        .mockResolvedValue(createMetrics({ hasComplexTriggers: true }));

      const checker = new PerformanceCheck(fetchFn);
      const items = await checker.check(createConfig({ operationConfig: { batchSize: 5000 } }));
      const batchItem = items.find((i) => i.name === 'Batch Size');

      expect(batchItem?.severity).toBe('warning');
    });

    it('should recommend grappe mode for large datasets', async () => {
      const fetchFn: FetchPerformanceMetricsFn = vi
        .fn()
        .mockResolvedValue(createMetrics({ recordCount: 50_000 }));

      const checker = new PerformanceCheck(fetchFn);
      const items = await checker.check(createConfig());
      const grappeItem = items.find((i) => i.name === 'Grappe Mode Recommendation');

      expect(grappeItem?.severity).toBe('warning');
      expect(grappeItem?.message).toContain('50000');
    });

    it('should not recommend grappe for small datasets', async () => {
      const fetchFn: FetchPerformanceMetricsFn = vi
        .fn()
        .mockResolvedValue(createMetrics({ recordCount: 500 }));

      const checker = new PerformanceCheck(fetchFn);
      const items = await checker.check(createConfig());
      const grappeItem = items.find((i) => i.name === 'Grappe Mode Recommendation');

      expect(grappeItem?.severity).toBe('info');
    });

    it('should include parallel workers recommendation', async () => {
      const fetchFn: FetchPerformanceMetricsFn = vi
        .fn()
        .mockResolvedValue(createMetrics({ recordCount: 40_000 }));

      const checker = new PerformanceCheck(fetchFn);
      const items = await checker.check(createConfig());
      const workersItem = items.find((i) => i.name === 'Parallel Workers');

      expect(workersItem).toBeDefined();
      expect(workersItem?.message).toContain('8');
    });

    it('should set all items to category performance', async () => {
      const fetchFn: FetchPerformanceMetricsFn = vi.fn().mockResolvedValue(createMetrics());
      const checker = new PerformanceCheck(fetchFn);
      const items = await checker.check(createConfig());

      for (const item of items) {
        expect(item.category).toBe('performance');
      }
    });

    it('should call fetchMetrics with correct parameters', async () => {
      const fetchFn: FetchPerformanceMetricsFn = vi.fn().mockResolvedValue(createMetrics());
      const config = createConfig({
        targetOrgId: 'org-perf',
        operationConfig: { batchSize: 500 },
      });

      const checker = new PerformanceCheck(fetchFn);
      await checker.check(config);

      expect(fetchFn).toHaveBeenCalledWith('org-perf', { batchSize: 500 });
    });

    it('should generate unique IDs for each item', async () => {
      const fetchFn: FetchPerformanceMetricsFn = vi.fn().mockResolvedValue(createMetrics());
      const checker = new PerformanceCheck(fetchFn);
      const items = await checker.check(createConfig());

      const ids = new Set(items.map((i) => i.id));
      expect(ids.size).toBe(items.length);
    });
  });

  describe('estimatePerformance', () => {
    it('should return complete estimations object', () => {
      const fetchFn: FetchPerformanceMetricsFn = vi.fn();
      const checker = new PerformanceCheck(fetchFn);
      const estimations = checker.estimatePerformance(createConfig(), createMetrics());

      expect(estimations).toHaveProperty('duration');
      expect(estimations).toHaveProperty('apiCalls');
      expect(estimations).toHaveProperty('dataStorageImpact');
      expect(estimations).toHaveProperty('fileStorageImpact');
      expect(estimations).toHaveProperty('bulkJobs');
      expect(estimations).toHaveProperty('grappeRecommendation');
    });

    it('should recommend grappe for large record counts', () => {
      const fetchFn: FetchPerformanceMetricsFn = vi.fn();
      const checker = new PerformanceCheck(fetchFn);
      const estimations = checker.estimatePerformance(
        createConfig(),
        createMetrics({ recordCount: 50_000 }),
      );

      expect(estimations.grappeRecommendation).toBe(true);
      expect(estimations.optimalGrappeConfig).toBeDefined();
      expect(estimations.optimalGrappeConfig?.enabled).toBe(true);
    });

    it('should not recommend grappe for small record counts', () => {
      const fetchFn: FetchPerformanceMetricsFn = vi.fn();
      const checker = new PerformanceCheck(fetchFn);
      const estimations = checker.estimatePerformance(
        createConfig(),
        createMetrics({ recordCount: 500 }),
      );

      expect(estimations.grappeRecommendation).toBe(false);
      expect(estimations.optimalGrappeConfig).toBeUndefined();
    });

    it('should increase duration for complex triggers', () => {
      const fetchFn: FetchPerformanceMetricsFn = vi.fn();
      const checker = new PerformanceCheck(fetchFn);

      const simple = checker.estimatePerformance(
        createConfig(),
        createMetrics({ hasComplexTriggers: false }),
      );
      const complex = checker.estimatePerformance(
        createConfig(),
        createMetrics({ hasComplexTriggers: true }),
      );

      expect(complex.duration).toBeGreaterThan(simple.duration);
    });

    it('should use dependency_aware strategy for many objects', () => {
      const fetchFn: FetchPerformanceMetricsFn = vi.fn();
      const checker = new PerformanceCheck(fetchFn);
      const estimations = checker.estimatePerformance(
        createConfig(),
        createMetrics({ recordCount: 20_000, objectCount: 5 }),
      );

      expect(estimations.optimalGrappeConfig?.strategy).toBe('dependency_aware');
    });

    it('should use round_robin strategy for few objects', () => {
      const fetchFn: FetchPerformanceMetricsFn = vi.fn();
      const checker = new PerformanceCheck(fetchFn);
      const estimations = checker.estimatePerformance(
        createConfig(),
        createMetrics({ recordCount: 20_000, objectCount: 2 }),
      );

      expect(estimations.optimalGrappeConfig?.strategy).toBe('round_robin');
    });

    it('should enable checkpointing for very large datasets', () => {
      const fetchFn: FetchPerformanceMetricsFn = vi.fn();
      const checker = new PerformanceCheck(fetchFn);
      const estimations = checker.estimatePerformance(
        createConfig(),
        createMetrics({ recordCount: 100_000 }),
      );

      expect(estimations.optimalGrappeConfig?.checkpointing).toBe(true);
    });

    it('should cap max workers at 8', () => {
      const fetchFn: FetchPerformanceMetricsFn = vi.fn();
      const checker = new PerformanceCheck(fetchFn);
      const estimations = checker.estimatePerformance(
        createConfig(),
        createMetrics({ recordCount: 1_000_000 }),
      );

      expect(estimations.optimalGrappeConfig?.maxWorkers).toBeLessThanOrEqual(8);
    });
  });
});
