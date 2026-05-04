import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CompareOrchestrator } from './CompareOrchestrator';
import type { CompareDependencies } from './CompareOrchestrator';
import type { CompareConfig, CompareItem, CompareSummary } from '@sandforge/shared';

function createMockDeps(): CompareDependencies {
  return {
    metadataCompare: {
      compare: vi.fn().mockResolvedValue([]),
    } as unknown as CompareDependencies['metadataCompare'],
    configCompare: {
      compare: vi.fn().mockResolvedValue([]),
    } as unknown as CompareDependencies['configCompare'],
    permissionCompare: {
      compare: vi.fn().mockResolvedValue([]),
    } as unknown as CompareDependencies['permissionCompare'],
    dataCompare: {
      compare: vi.fn().mockResolvedValue([]),
    } as unknown as CompareDependencies['dataCompare'],
    diffEngine: {
      computeSummary: vi.fn().mockReturnValue({
        totalItems: 0,
        added: 0,
        removed: 0,
        modified: 0,
        unchanged: 0,
        byType: {},
      } satisfies CompareSummary),
    } as unknown as CompareDependencies['diffEngine'],
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

function createItem(fullName: string, status: CompareItem['status'] = 'modified'): CompareItem {
  return {
    componentType: 'ApexClass',
    fullName,
    status,
    severity: 'info',
    deployable: status !== 'unchanged',
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
    it('should call metadataCompare for metadata mode', async () => {
      const config = createConfig({ mode: 'metadata' });
      await orchestrator.execute(config);

      expect(deps.metadataCompare.compare).toHaveBeenCalledWith('source-org', 'target-org', [
        'ApexClass',
      ]);
    });

    it('should call configCompare for config mode', async () => {
      const config = createConfig({ mode: 'config' });
      await orchestrator.execute(config);

      expect(deps.configCompare.compare).toHaveBeenCalledWith('source-org', 'target-org');
    });

    it('should call permissionCompare for permissions mode', async () => {
      const config = createConfig({ mode: 'permissions' });
      await orchestrator.execute(config);

      expect(deps.permissionCompare.compare).toHaveBeenCalledWith('source-org', 'target-org');
    });

    it('should call dataCompare for data mode with objectFilter', async () => {
      const config = createConfig({
        mode: 'data',
        objectFilter: ['Account', 'Contact'],
      });
      await orchestrator.execute(config);

      expect(deps.dataCompare.compare).toHaveBeenCalledWith(
        'source-org',
        'target-org',
        'Account',
        'Id',
      );
      expect(deps.dataCompare.compare).toHaveBeenCalledWith(
        'source-org',
        'target-org',
        'Contact',
        'Id',
      );
    });

    it('should not call dataCompare for data mode without objectFilter', async () => {
      const config = createConfig({ mode: 'data' });
      await orchestrator.execute(config);

      expect(deps.dataCompare.compare).not.toHaveBeenCalled();
    });

    it('should call all comparators for full mode', async () => {
      const config = createConfig({
        mode: 'full',
        objectFilter: ['Account'],
      });
      await orchestrator.execute(config);

      expect(deps.metadataCompare.compare).toHaveBeenCalled();
      expect(deps.configCompare.compare).toHaveBeenCalled();
      expect(deps.permissionCompare.compare).toHaveBeenCalled();
      expect(deps.dataCompare.compare).toHaveBeenCalled();
    });

    it('should not call metadata comparator for config mode', async () => {
      const config = createConfig({ mode: 'config' });
      await orchestrator.execute(config);

      expect(deps.metadataCompare.compare).not.toHaveBeenCalled();
    });

    it('should aggregate diffs from all sub-services', async () => {
      vi.mocked(deps.metadataCompare.compare).mockResolvedValue([createItem('ClassA')]);
      vi.mocked(deps.configCompare.compare).mockResolvedValue([createItem('Setting1')]);

      const config = createConfig({ mode: 'full' });
      await orchestrator.execute(config);

      expect(deps.diffEngine.computeSummary).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ fullName: 'ClassA' }),
          expect.objectContaining({ fullName: 'Setting1' }),
        ]),
      );
    });

    it('should compute summary using the diff engine', async () => {
      const mockSummary: CompareSummary = {
        totalItems: 2,
        added: 1,
        removed: 0,
        modified: 1,
        unchanged: 0,
        byType: { ApexClass: { added: 1, removed: 0, modified: 1 } },
      };
      vi.mocked(deps.diffEngine.computeSummary).mockReturnValue(mockSummary);

      const config = createConfig();
      const result = await orchestrator.execute(config);

      expect(result.summary).toBe(mockSummary);
    });

    it('should include correct configId in result', async () => {
      const config = createConfig({ id: 'my-config' });
      const result = await orchestrator.execute(config);

      expect(result.configId).toBe('my-config');
    });

    it('should include the mode in result', async () => {
      const config = createConfig({ mode: 'permissions' });
      const result = await orchestrator.execute(config);

      expect(result.mode).toBe('permissions');
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
