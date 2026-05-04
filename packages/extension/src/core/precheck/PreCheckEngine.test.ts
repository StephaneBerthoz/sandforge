import { describe, it, expect, vi } from 'vitest';
import { PreCheckEngine } from './PreCheckEngine';
import type {
  PreCheckEngineDeps,
  CategoryChecker,
  SecurityCategoryChecker,
  PerformanceCategoryChecker,
} from './PreCheckEngine';
import type { PreCheckConfig, PreCheckItem, PreCheckEstimations } from '@sandforge/shared';

function createConfig(overrides?: Partial<PreCheckConfig>): PreCheckConfig {
  return {
    categories: [
      'permissions',
      'api_limits',
      'storage',
      'schema',
      'data_integrity',
      'org_status',
      'compatibility',
      'security',
      'performance',
    ],
    skipWarnings: false,
    autoFix: false,
    targetOrgId: 'org-001',
    module: 'sync',
    operationConfig: {},
    ...overrides,
  };
}

function createPassingItem(overrides?: Partial<PreCheckItem>): PreCheckItem {
  return {
    id: `item-${Math.random().toString(36).slice(2)}`,
    category: 'permissions',
    name: 'Test Check',
    description: 'A passing check',
    severity: 'info',
    passed: true,
    message: 'Check passed',
    autoFixable: false,
    ...overrides,
  };
}

function createFailingItem(overrides?: Partial<PreCheckItem>): PreCheckItem {
  return {
    id: `item-${Math.random().toString(36).slice(2)}`,
    category: 'permissions',
    name: 'Failing Check',
    description: 'A failing check',
    severity: 'error',
    passed: false,
    message: 'Check failed',
    autoFixable: false,
    ...overrides,
  };
}

function createEstimations(overrides?: Partial<PreCheckEstimations>): PreCheckEstimations {
  return {
    duration: 30_000,
    apiCalls: 50,
    dataStorageImpact: 10,
    fileStorageImpact: 0,
    bulkJobs: 1,
    grappeRecommendation: false,
    ...overrides,
  };
}

function createMockChecker(items: PreCheckItem[] = []): CategoryChecker {
  return { check: vi.fn().mockResolvedValue(items) };
}

function createMockSecurityChecker(
  items: PreCheckItem[] = [],
  confirmations: {
    title: string;
    description: string;
    severity: 'warning' | 'error';
    requiresTypedConfirmation: boolean;
    confirmationText?: string;
  }[] = [],
): SecurityCategoryChecker {
  return {
    check: vi.fn().mockResolvedValue({ items, confirmations }),
  };
}

function createMockPerformanceChecker(
  items: PreCheckItem[] = [],
  estimations?: PreCheckEstimations,
): PerformanceCategoryChecker {
  return {
    check: vi.fn().mockResolvedValue(items),
    estimatePerformance: vi.fn().mockReturnValue(estimations ?? createEstimations()),
  };
}

function createDeps(overrides?: Partial<PreCheckEngineDeps>): PreCheckEngineDeps {
  return {
    permissionCheck: createMockChecker(),
    apiLimitCheck: createMockChecker(),
    storageCheck: createMockChecker(),
    schemaCheck: createMockChecker(),
    dataIntegrityCheck: createMockChecker(),
    orgStatusCheck: createMockChecker(),
    compatibilityCheck: createMockChecker(),
    securityCheck: createMockSecurityChecker(),
    performanceCheck: createMockPerformanceChecker(),
    fetchPerformanceMetrics: vi.fn().mockResolvedValue({
      avgResponseTimeMs: 100,
      recordCount: 1000,
      objectCount: 2,
      hasComplexTriggers: false,
      networkLatencyMs: 50,
    }),
    ...overrides,
  };
}

describe('PreCheckEngine', () => {
  describe('run', () => {
    it('should return a complete PreCheckResult', async () => {
      const engine = new PreCheckEngine(createDeps());
      const result = await engine.run(createConfig());

      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('score');
      expect(result).toHaveProperty('checks');
      expect(result).toHaveProperty('estimations');
      expect(result).toHaveProperty('canProceed');
      expect(result).toHaveProperty('requiresConfirmation');
      expect(result).toHaveProperty('autoFixable');
    });

    it('should return pass status when all checks pass', async () => {
      const deps = createDeps({
        permissionCheck: createMockChecker([createPassingItem()]),
        apiLimitCheck: createMockChecker([createPassingItem()]),
      });

      const engine = new PreCheckEngine(deps);
      const result = await engine.run(createConfig());

      expect(result.status).toBe('pass');
      expect(result.canProceed).toBe(true);
      expect(result.score).toBe(100);
    });

    it('should return fail status when a blocker exists', async () => {
      const deps = createDeps({
        permissionCheck: createMockChecker([createFailingItem({ severity: 'blocker' })]),
      });

      const engine = new PreCheckEngine(deps);
      const result = await engine.run(createConfig());

      expect(result.status).toBe('fail');
      expect(result.canProceed).toBe(false);
    });

    it('should return warning status when errors but no blockers', async () => {
      const deps = createDeps({
        permissionCheck: createMockChecker([createFailingItem({ severity: 'error' })]),
      });

      const engine = new PreCheckEngine(deps);
      const result = await engine.run(createConfig());

      expect(result.status).toBe('warning');
      expect(result.canProceed).toBe(true);
    });

    it('should return warning status for warning severity failures', async () => {
      const deps = createDeps({
        permissionCheck: createMockChecker([createFailingItem({ severity: 'warning' })]),
      });

      const engine = new PreCheckEngine(deps);
      const result = await engine.run(createConfig());

      expect(result.status).toBe('warning');
    });

    it('should deduct 30 points for each blocker', async () => {
      const deps = createDeps({
        permissionCheck: createMockChecker([createFailingItem({ severity: 'blocker' })]),
      });

      const engine = new PreCheckEngine(deps);
      const result = await engine.run(createConfig());

      expect(result.score).toBe(70);
    });

    it('should deduct 15 points for each error', async () => {
      const deps = createDeps({
        permissionCheck: createMockChecker([createFailingItem({ severity: 'error' })]),
      });

      const engine = new PreCheckEngine(deps);
      const result = await engine.run(createConfig());

      expect(result.score).toBe(85);
    });

    it('should deduct 5 points for each warning', async () => {
      const deps = createDeps({
        permissionCheck: createMockChecker([createFailingItem({ severity: 'warning' })]),
      });

      const engine = new PreCheckEngine(deps);
      const result = await engine.run(createConfig());

      expect(result.score).toBe(95);
    });

    it('should not deduct points for info severity', async () => {
      const deps = createDeps({
        permissionCheck: createMockChecker([createFailingItem({ severity: 'info' })]),
      });

      const engine = new PreCheckEngine(deps);
      const result = await engine.run(createConfig());

      expect(result.score).toBe(100);
    });

    it('should clamp score to minimum 0', async () => {
      const deps = createDeps({
        permissionCheck: createMockChecker([
          createFailingItem({ severity: 'blocker' }),
          createFailingItem({ severity: 'blocker' }),
          createFailingItem({ severity: 'blocker' }),
          createFailingItem({ severity: 'blocker' }),
        ]),
      });

      const engine = new PreCheckEngine(deps);
      const result = await engine.run(createConfig());

      expect(result.score).toBe(0);
    });

    it('should collect all checks from all categories', async () => {
      const deps = createDeps({
        permissionCheck: createMockChecker([createPassingItem(), createPassingItem()]),
        apiLimitCheck: createMockChecker([createPassingItem()]),
        storageCheck: createMockChecker([createPassingItem()]),
      });

      const engine = new PreCheckEngine(deps);
      const result = await engine.run(createConfig());

      expect(result.checks.length).toBeGreaterThanOrEqual(4);
    });

    it('should collect confirmations from security check', async () => {
      const deps = createDeps({
        securityCheck: createMockSecurityChecker(
          [createPassingItem({ category: 'security' })],
          [
            {
              title: 'Production Guard',
              description: 'Confirm production operation',
              severity: 'warning',
              requiresTypedConfirmation: false,
            },
          ],
        ),
      });

      const engine = new PreCheckEngine(deps);
      const result = await engine.run(createConfig());

      expect(result.requiresConfirmation).toHaveLength(1);
      expect(result.requiresConfirmation[0].title).toBe('Production Guard');
    });

    it('should collect autoFixable items', async () => {
      const deps = createDeps({
        schemaCheck: createMockChecker([
          createFailingItem({
            category: 'schema',
            autoFixable: true,
            fixDescription: 'Auto-map fields',
          }),
        ]),
      });

      const engine = new PreCheckEngine(deps);
      const result = await engine.run(createConfig());

      expect(result.autoFixable).toHaveLength(1);
      expect(result.autoFixable[0].autoFixable).toBe(true);
    });

    it('should not include passing autoFixable items in autoFixable list', async () => {
      const deps = createDeps({
        schemaCheck: createMockChecker([createPassingItem({ autoFixable: true })]),
      });

      const engine = new PreCheckEngine(deps);
      const result = await engine.run(createConfig());

      expect(result.autoFixable).toHaveLength(0);
    });

    it('should include estimations in result', async () => {
      const estimations = createEstimations({ duration: 60_000, apiCalls: 100 });
      const deps = createDeps({
        performanceCheck: createMockPerformanceChecker([], estimations),
      });

      const engine = new PreCheckEngine(deps);
      const result = await engine.run(createConfig());

      expect(result.estimations.duration).toBe(60_000);
      expect(result.estimations.apiCalls).toBe(100);
    });

    it('should only run configured categories', async () => {
      const deps = createDeps();
      const config = createConfig({ categories: ['permissions', 'storage'] });

      const engine = new PreCheckEngine(deps);
      await engine.run(config);

      expect(deps.permissionCheck.check).toHaveBeenCalled();
      expect(deps.storageCheck.check).toHaveBeenCalled();
      expect(deps.apiLimitCheck.check).not.toHaveBeenCalled();
      expect(deps.schemaCheck.check).not.toHaveBeenCalled();
    });

    it('should skip connectivity category gracefully', async () => {
      const deps = createDeps();
      const config = createConfig({ categories: ['connectivity'] });

      const engine = new PreCheckEngine(deps);
      const result = await engine.run(config);

      expect(result.status).toBe('pass');
    });

    it('should handle multiple severity types in score calculation', async () => {
      const deps = createDeps({
        permissionCheck: createMockChecker([
          createFailingItem({ severity: 'blocker' }),
          createFailingItem({ severity: 'error' }),
          createFailingItem({ severity: 'warning' }),
        ]),
      });

      const engine = new PreCheckEngine(deps);
      const result = await engine.run(createConfig());

      expect(result.score).toBe(100 - 30 - 15 - 5);
      expect(result.status).toBe('fail');
    });
  });

  describe('runCategory', () => {
    it('should run a single category and return items', async () => {
      const deps = createDeps({
        permissionCheck: createMockChecker([createPassingItem({ category: 'permissions' })]),
      });

      const engine = new PreCheckEngine(deps);
      const items = await engine.runCategory('permissions', createConfig());

      expect(items).toHaveLength(1);
      expect(deps.permissionCheck.check).toHaveBeenCalled();
    });

    it('should run security category and return items only', async () => {
      const deps = createDeps({
        securityCheck: createMockSecurityChecker(
          [createPassingItem({ category: 'security' })],
          [
            {
              title: 'Test',
              description: 'Test',
              severity: 'warning',
              requiresTypedConfirmation: false,
            },
          ],
        ),
      });

      const engine = new PreCheckEngine(deps);
      const items = await engine.runCategory('security', createConfig());

      expect(items).toHaveLength(1);
    });

    it('should run performance category', async () => {
      const deps = createDeps({
        performanceCheck: createMockPerformanceChecker([
          createPassingItem({ category: 'performance' }),
        ]),
      });

      const engine = new PreCheckEngine(deps);
      const items = await engine.runCategory('performance', createConfig());

      expect(items).toHaveLength(1);
    });

    it('should return empty array for connectivity category', async () => {
      const deps = createDeps();
      const engine = new PreCheckEngine(deps);
      const items = await engine.runCategory('connectivity', createConfig());

      expect(items).toEqual([]);
    });

    it('should not call other checkers when running a single category', async () => {
      const deps = createDeps();
      const engine = new PreCheckEngine(deps);
      await engine.runCategory('permissions', createConfig());

      expect(deps.permissionCheck.check).toHaveBeenCalled();
      expect(deps.apiLimitCheck.check).not.toHaveBeenCalled();
      expect(deps.storageCheck.check).not.toHaveBeenCalled();
    });
  });
});
