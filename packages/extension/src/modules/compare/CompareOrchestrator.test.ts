import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CompareOrchestrator } from './CompareOrchestrator';
import type { CompareDependencies } from './CompareOrchestrator';
import { DiffEngine } from './DiffEngine';
import type { CompareConfig, CompareItem, CompareSummary } from '@sandforge/shared';

const BUDGET = { components: 500, seconds: 90 };

function createMockDeps(): CompareDependencies {
  return {
    metadataCompare: {
      compare: vi.fn().mockResolvedValue({ items: [], managedLeftOut: 0 }),
      budget: BUDGET,
    } as unknown as CompareDependencies['metadataCompare'],
    diffEngine: new DiffEngine(),
  };
}

function createConfig(overrides?: Partial<CompareConfig>): CompareConfig {
  return {
    id: 'config-1',
    name: 'Test Compare',
    sourceOrgId: 'source-org',
    targetOrgId: 'target-org',
    mode: 'metadata',
    componentTypes: ['ApexClass'],
    includeManaged: true,
    createdAt: '2026-02-20T00:00:00Z',
    ...overrides,
  };
}

function createItem(
  fullName: string,
  status: CompareItem['status'],
  notComparedReason?: CompareItem['notComparedReason'],
): CompareItem {
  return {
    componentType: 'ApexClass',
    fullName,
    status,
    ...(notComparedReason ? { notComparedReason } : {}),
    severity: DiffEngine.determineSeverity(status, 'ApexClass'),
    deployable: DiffEngine.isDeployable(status),
  };
}

describe('CompareOrchestrator', () => {
  let orchestrator: CompareOrchestrator;
  let deps: CompareDependencies;

  beforeEach(() => {
    deps = createMockDeps();
    orchestrator = new CompareOrchestrator(deps);
  });

  describe('execute', () => {
    it('compares the configured types between the two orgs', async () => {
      await orchestrator.execute(createConfig({ componentTypes: ['ApexClass', 'Flow'] }));

      expect(deps.metadataCompare.compare).toHaveBeenCalledWith(
        'source-org',
        'target-org',
        ['ApexClass', 'Flow'],
        { includeManaged: true },
      );
    });

    it('asks the listing to leave out what a managed package installed when the config says so', async () => {
      await orchestrator.execute(createConfig({ includeManaged: false }));

      expect(deps.metadataCompare.compare).toHaveBeenCalledWith(
        'source-org',
        'target-org',
        ['ApexClass'],
        { includeManaged: false },
      );
    });

    it('says how many components a managed package installed were left out', async () => {
      vi.mocked(deps.metadataCompare.compare).mockResolvedValue({
        items: [createItem('Same', 'unchanged')],
        managedLeftOut: 8,
      });

      const result = await orchestrator.execute(createConfig({ includeManaged: false }));

      expect(result.content.managedLeftOut).toBe(8);
      // They are in no other count: neither compared, nor not compared.
      expect(result.content.compared).toBe(1);
      expect(result.summary.notCompared).toBe(0);
      expect(result.summary.totalItems).toBe(1);
    });

    it('counts a component left unread apart from the changes and the matches', async () => {
      vi.mocked(deps.metadataCompare.compare).mockResolvedValue({
        items: [
          createItem('Added', 'added'),
          createItem('Edited', 'modified'),
          createItem('Same', 'unchanged'),
          createItem('Managed', 'not_compared', 'unreadable'),
          createItem('Late', 'not_compared', 'over_budget'),
        ],
        managedLeftOut: 0,
      });

      const result = await orchestrator.execute(createConfig());

      expect(result.summary).toEqual({
        totalItems: 5,
        added: 1,
        removed: 0,
        modified: 1,
        unchanged: 1,
        notCompared: 2,
        byType: { ApexClass: { added: 1, removed: 0, modified: 1 } },
      } satisfies CompareSummary);
    });

    it('says how many components were compared by content, how many were not and why, and within what budget', async () => {
      vi.mocked(deps.metadataCompare.compare).mockResolvedValue({
        items: [
          createItem('Edited', 'modified'),
          createItem('Same', 'unchanged'),
          createItem('Managed', 'not_compared', 'unreadable'),
          createItem('Broken', 'not_compared', 'read_failed'),
          createItem('Late', 'not_compared', 'over_budget'),
          createItem('Later', 'not_compared', 'over_budget'),
        ],
        managedLeftOut: 0,
      });

      const result = await orchestrator.execute(createConfig());

      expect(result.content).toEqual({
        compared: 2,
        notCompared: { unreadable: 1, read_failed: 1, over_budget: 2 },
        budget: BUDGET,
      });
    });

    it('returns the diffs it was given, in order', async () => {
      const items = [createItem('B', 'modified'), createItem('A', 'unchanged')];
      vi.mocked(deps.metadataCompare.compare).mockResolvedValue({ items, managedLeftOut: 0 });

      const result = await orchestrator.execute(createConfig());

      expect(result.diffs).toEqual(items);
    });

    it('should include correct configId in result', async () => {
      const config = createConfig({ id: 'my-config' });
      const result = await orchestrator.execute(config);

      expect(result.configId).toBe('my-config');
    });

    it('reports the metadata mode it ran', async () => {
      const result = await orchestrator.execute(createConfig());

      expect(result.mode).toBe('metadata');
    });

    it('should include a valid timestamp', async () => {
      const config = createConfig();
      const result = await orchestrator.execute(config);

      expect(result.timestamp).toBeDefined();
      expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
    });

    it('should include a non-negative duration', async () => {
      const config = createConfig();
      const result = await orchestrator.execute(config);

      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should store the result for later retrieval', async () => {
      const config = createConfig({ id: 'stored-config' });
      const result = await orchestrator.execute(config);

      expect(orchestrator.getLastResult('stored-config')).toBe(result);
    });

    it('should overwrite previous result for the same configId', async () => {
      const config = createConfig({ id: 'rerun-config' });
      await orchestrator.execute(config);
      const secondResult = await orchestrator.execute(config);

      expect(orchestrator.getLastResult('rerun-config')).toBe(secondResult);
    });
  });

  describe('getLastResult', () => {
    it('should return undefined for unknown config IDs', () => {
      expect(orchestrator.getLastResult('unknown')).toBeUndefined();
    });

    it('should return the stored result after execute', async () => {
      const config = createConfig({ id: 'test-id' });
      const result = await orchestrator.execute(config);

      expect(orchestrator.getLastResult('test-id')).toBe(result);
    });

    it('should maintain results for multiple configs', async () => {
      const config1 = createConfig({ id: 'config-1' });
      const config2 = createConfig({ id: 'config-2' });

      const result1 = await orchestrator.execute(config1);
      const result2 = await orchestrator.execute(config2);

      expect(orchestrator.getLastResult('config-1')).toBe(result1);
      expect(orchestrator.getLastResult('config-2')).toBe(result2);
    });
  });
});
