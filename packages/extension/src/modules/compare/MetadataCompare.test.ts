import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MetadataCompare } from './MetadataCompare';
import type { FetchMetadataFn } from './MetadataCompare';
import { DiffEngine } from './DiffEngine';
import type { MetadataComponentType } from '@sandforge/shared';

describe('MetadataCompare', () => {
  let metadataCompare: MetadataCompare;
  let fetchMetadata: FetchMetadataFn;
  let diffEngine: DiffEngine;

  beforeEach(() => {
    diffEngine = new DiffEngine();
    fetchMetadata = vi
      .fn<Parameters<FetchMetadataFn>, ReturnType<FetchMetadataFn>>()
      .mockResolvedValue(new Map());
    metadataCompare = new MetadataCompare(fetchMetadata, diffEngine);
  });

  describe('compare', () => {
    it('should fetch metadata from both orgs for each type', async () => {
      const types: MetadataComponentType[] = ['ApexClass', 'Flow'];

      await metadataCompare.compare('org-1', 'org-2', types);

      expect(fetchMetadata).toHaveBeenCalledWith('org-1', 'ApexClass');
      expect(fetchMetadata).toHaveBeenCalledWith('org-2', 'ApexClass');
      expect(fetchMetadata).toHaveBeenCalledWith('org-1', 'Flow');
      expect(fetchMetadata).toHaveBeenCalledWith('org-2', 'Flow');
      expect(fetchMetadata).toHaveBeenCalledTimes(4);
    });

    it('should detect added components in target', async () => {
      vi.mocked(fetchMetadata).mockImplementation(async (orgId) => {
        if (orgId === 'org-1') {
          return new Map();
        }
        return new Map([['MyClass', 'public class MyClass {}']]);
      });

      const items = await metadataCompare.compare('org-1', 'org-2', ['ApexClass']);

      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('added');
      expect(items[0].fullName).toBe('MyClass');
    });

    it('should detect removed components missing from target', async () => {
      vi.mocked(fetchMetadata).mockImplementation(async (orgId) => {
        if (orgId === 'org-1') {
          return new Map([['OldClass', 'code']]);
        }
        return new Map();
      });

      const items = await metadataCompare.compare('org-1', 'org-2', ['ApexClass']);

      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('removed');
    });

    it('should detect modified components', async () => {
      vi.mocked(fetchMetadata).mockImplementation(async (orgId) => {
        if (orgId === 'org-1') {
          return new Map([['MyClass', 'v1']]);
        }
        return new Map([['MyClass', 'v2']]);
      });

      const items = await metadataCompare.compare('org-1', 'org-2', ['ApexClass']);

      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('modified');
    });

    it('should detect unchanged components', async () => {
      vi.mocked(fetchMetadata).mockImplementation(async () => {
        return new Map([['MyClass', 'same']]);
      });

      const items = await metadataCompare.compare('org-1', 'org-2', ['ApexClass']);

      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('unchanged');
    });

    it('should aggregate results across multiple component types', async () => {
      vi.mocked(fetchMetadata).mockImplementation(async (orgId, componentType) => {
        if (componentType === 'ApexClass') {
          return new Map([['ClassA', orgId === 'org-1' ? 'v1' : 'v2']]);
        }
        return new Map([['FlowA', 'same']]);
      });

      const items = await metadataCompare.compare('org-1', 'org-2', ['ApexClass', 'Flow']);

      expect(items).toHaveLength(2);
      expect(items[0].componentType).toBe('ApexClass');
      expect(items[0].status).toBe('modified');
      expect(items[1].componentType).toBe('Flow');
      expect(items[1].status).toBe('unchanged');
    });

    it('should return empty array when no types are provided', async () => {
      const items = await metadataCompare.compare('org-1', 'org-2', []);

      expect(items).toEqual([]);
      expect(fetchMetadata).not.toHaveBeenCalled();
    });

    it('should return empty array when both orgs have no metadata', async () => {
      const items = await metadataCompare.compare('org-1', 'org-2', ['ApexClass']);

      expect(items).toEqual([]);
    });

    it('should set correct component type on diff items', async () => {
      vi.mocked(fetchMetadata).mockImplementation(async (orgId) => {
        if (orgId === 'org-1') {
          return new Map([['Layout1', 'v1']]);
        }
        return new Map([['Layout1', 'v2']]);
      });

      const items = await metadataCompare.compare('org-1', 'org-2', ['Layout']);

      expect(items[0].componentType).toBe('Layout');
    });

    it('should handle fetch failures by propagating the error', async () => {
      vi.mocked(fetchMetadata).mockRejectedValue(new Error('Connection failed'));

      await expect(metadataCompare.compare('org-1', 'org-2', ['ApexClass'])).rejects.toThrow(
        'Connection failed',
      );
    });

    it('should handle large numbers of components', async () => {
      const largeMap = new Map<string, string>();
      for (let i = 0; i < 500; i++) {
        largeMap.set(`Class${i}`, `body-${i}`);
      }
      vi.mocked(fetchMetadata).mockResolvedValue(largeMap);

      const items = await metadataCompare.compare('org-1', 'org-2', ['ApexClass']);

      expect(items).toHaveLength(500);
      expect(items.every((item) => item.status === 'unchanged')).toBe(true);
    });
  });
});
