import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigCompare } from './ConfigCompare';
import type { FetchConfigFn } from './ConfigCompare';
import { DiffEngine } from './DiffEngine';

describe('ConfigCompare', () => {
  let configCompare: ConfigCompare;
  let fetchConfig: FetchConfigFn;
  let diffEngine: DiffEngine;

  beforeEach(() => {
    diffEngine = new DiffEngine();
    fetchConfig = vi.fn<FetchConfigFn>().mockResolvedValue(new Map());
    configCompare = new ConfigCompare(fetchConfig, diffEngine);
  });

  describe('compare', () => {
    it('should fetch config from both orgs', async () => {
      await configCompare.compare('org-1', 'org-2');

      expect(fetchConfig).toHaveBeenCalledWith('org-1');
      expect(fetchConfig).toHaveBeenCalledWith('org-2');
      expect(fetchConfig).toHaveBeenCalledTimes(2);
    });

    it('should detect added configuration in target', async () => {
      vi.mocked(fetchConfig).mockImplementation(async (orgId) => {
        if (orgId === 'org-1') {
          return new Map();
        }
        return new Map([['Feature.Enabled', 'true']]);
      });

      const items = await configCompare.compare('org-1', 'org-2');

      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('added');
      expect(items[0].fullName).toBe('Feature.Enabled');
    });

    it('should detect removed configuration from target', async () => {
      vi.mocked(fetchConfig).mockImplementation(async (orgId) => {
        if (orgId === 'org-1') {
          return new Map([['OldSetting', 'value']]);
        }
        return new Map();
      });

      const items = await configCompare.compare('org-1', 'org-2');

      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('removed');
    });

    it('should detect modified configuration values', async () => {
      vi.mocked(fetchConfig).mockImplementation(async (orgId) => {
        if (orgId === 'org-1') {
          return new Map([['BatchSize', '100']]);
        }
        return new Map([['BatchSize', '200']]);
      });

      const items = await configCompare.compare('org-1', 'org-2');

      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('modified');
      expect(items[0].sourceValue).toBe('100');
      expect(items[0].targetValue).toBe('200');
    });

    it('should detect unchanged configuration', async () => {
      vi.mocked(fetchConfig).mockImplementation(async () => {
        return new Map([['Setting', 'same']]);
      });

      const items = await configCompare.compare('org-1', 'org-2');

      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('unchanged');
    });

    it('should return empty array when both orgs have no config', async () => {
      const items = await configCompare.compare('org-1', 'org-2');
      expect(items).toEqual([]);
    });

    it('should handle multiple configuration entries', async () => {
      vi.mocked(fetchConfig).mockImplementation(async (orgId) => {
        if (orgId === 'org-1') {
          return new Map([
            ['Setting1', 'a'],
            ['Setting2', 'b'],
            ['Setting3', 'c'],
          ]);
        }
        return new Map([
          ['Setting1', 'a'],
          ['Setting2', 'x'],
          ['Setting4', 'd'],
        ]);
      });

      const items = await configCompare.compare('org-1', 'org-2');

      expect(items).toHaveLength(4);
      const byName = new Map(items.map((i) => [i.fullName, i]));
      expect(byName.get('Setting1')?.status).toBe('unchanged');
      expect(byName.get('Setting2')?.status).toBe('modified');
      expect(byName.get('Setting3')?.status).toBe('removed');
      expect(byName.get('Setting4')?.status).toBe('added');
    });

    it('should use CustomSetting as the component type', async () => {
      vi.mocked(fetchConfig).mockImplementation(async (orgId) => {
        if (orgId === 'org-1') {
          return new Map([['Cfg', 'v1']]);
        }
        return new Map([['Cfg', 'v2']]);
      });

      const items = await configCompare.compare('org-1', 'org-2');

      expect(items[0].componentType).toBe('CustomSetting');
    });

    it('should handle fetch failures by propagating the error', async () => {
      vi.mocked(fetchConfig).mockRejectedValue(new Error('Timeout'));

      await expect(
        configCompare.compare('org-1', 'org-2')
      ).rejects.toThrow('Timeout');
    });

    it('should fetch both orgs in parallel', async () => {
      const callOrder: string[] = [];
      vi.mocked(fetchConfig).mockImplementation(async (orgId) => {
        callOrder.push(`start-${orgId}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        callOrder.push(`end-${orgId}`);
        return new Map();
      });

      await configCompare.compare('org-1', 'org-2');

      expect(callOrder[0]).toBe('start-org-1');
      expect(callOrder[1]).toBe('start-org-2');
    });
  });
});
