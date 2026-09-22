import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CompareOrchestrator } from './CompareOrchestrator';
import type { CompareDependencies } from './CompareOrchestrator';
import { DiffEngine } from './DiffEngine';
import type { CompareConfig, CompareItem, CompareSummary } from '@sandforge/shared';

const BUDGET = { components: 500, seconds: 90 };

function createMockDeps(): CompareDependencies {
  return {
    metadataCompare: {
      compare: vi.fn().mockResolvedValue([]),
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
    includeManaged: false,
    includeUnmanaged: true,
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

      expect(deps.metadataCompare.compare).toHaveBeenCalledWith('source-org', 'target-org', [
        'ApexClass',
        'Flow',
      ]);
    });

    it('counts a component left unread apart from the changes and the matches', async () => {
      vi.mocked(deps.metadataCompare.compare).mockResolvedValue([
        createItem('Added', 'added'),
        createItem('Edited', 'modified'),
        createItem('Same', 'unchanged'),
        createItem('Managed', 'not_compared', 'unreadable'),
        createItem('Late', 'not_compared', 'over_budget'),
      ]);

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
      vi.mocked(deps.metadataCompare.compare).mockResolvedValue([
        createItem('Edited', 'modified'),
        createItem('Same', 'unchanged'),
        createItem('Managed', 'not_compared', 'unreadable'),
        createItem('Broken', 'not_compared', 'read_failed'),
        createItem('Late', 'not_compared', 'over_budget'),
        createItem('Later', 'not_compared', 'over_budget'),
      ]);

      const result = await orchestrator.execute(createConfig());

      expect(result.content).toEqual({
        compared: 2,
        notCompared: { unreadable: 1, read_failed: 1, over_budget: 2 },
        budget: BUDGET,
      });
    });

    it('returns the diffs it was given, in order', async () => {
      const items = [createItem('B', 'modified'), createItem('A', 'unchanged')];
      vi.mocked(deps.metadataCompare.compare).mockResolvedValue(items);

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
