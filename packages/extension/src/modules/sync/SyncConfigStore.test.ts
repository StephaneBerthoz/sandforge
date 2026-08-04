import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SyncConfigStore } from './SyncConfigStore';
import type { SyncConfig } from '@sandforge/shared';

/** Minimal in-memory ConfigStore mock. */
function createMockConfigStore() {
  const data: Record<string, { value: string; category: string }> = {};

  return {
    get: vi.fn(<T>(key: string): T | undefined => {
      const entry = data[key];
      if (!entry) return undefined;
      return JSON.parse(entry.value) as T;
    }),
    set: vi.fn(<T>(key: string, value: T, category: string): void => {
      data[key] = { value: JSON.stringify(value), category };
    }),
    delete: vi.fn((key: string): boolean => {
      if (!(key in data)) return false;
      delete data[key];
      return true;
    }),
    has: vi.fn((key: string): boolean => key in data),
    getKeysByPrefix: vi.fn((prefix: string): string[] =>
      Object.keys(data).filter((k) => k.startsWith(prefix)),
    ),
    getByCategory: vi.fn((category: string): Record<string, unknown> => {
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(data)) {
        if (entry.category === category) {
          result[key] = JSON.parse(entry.value);
        }
      }
      return result;
    }),
    getAllKeys: vi.fn((): string[] => Object.keys(data)),
    clearCategory: vi.fn(),
    clearAll: vi.fn(),
    initialize: vi.fn(),
  };
}

function createSyncConfig(overrides?: Partial<SyncConfig>): SyncConfig {
  return {
    id: 'cfg-1',
    name: 'Test Config',
    description: 'A test sync config',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    direction: 'source_to_target',
    mode: 'full',
    objects: [],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    dryRun: false,
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
    ...overrides,
  };
}

describe('SyncConfigStore', () => {
  let store: SyncConfigStore;
  let configStore: ReturnType<typeof createMockConfigStore>;

  beforeEach(() => {
    configStore = createMockConfigStore();
    store = new SyncConfigStore(configStore as never);
  });

  describe('save / load', () => {
    it('should round-trip save and load a config', () => {
      const config = createSyncConfig();
      store.save(config);
      const loaded = store.load('cfg-1');
      expect(loaded).toBeDefined();
      expect(loaded?.id).toBe('cfg-1');
      expect(loaded?.name).toBe('Test Config');
    });

    it('should store with the correct key prefix and category', () => {
      const config = createSyncConfig();
      store.save(config);
      expect(configStore.set).toHaveBeenCalledWith('sync:config:cfg-1', config, 'syncConfigs');
    });

    it('should return undefined for non-existent config', () => {
      expect(store.load('non-existent')).toBeUndefined();
    });

    it('should overwrite an existing config on save', () => {
      store.save(createSyncConfig());
      store.save(createSyncConfig({ name: 'Updated Config' }));
      const loaded = store.load('cfg-1');
      expect(loaded?.name).toBe('Updated Config');
    });
  });

  describe('list', () => {
    it('should return empty array when no configs exist', () => {
      expect(store.list()).toEqual([]);
    });

    it('should return all configs sorted by updatedAt descending', () => {
      store.save(createSyncConfig({ id: 'old', updatedAt: '2026-01-01T00:00:00Z' }));
      store.save(createSyncConfig({ id: 'new', updatedAt: '2026-03-01T00:00:00Z' }));
      store.save(createSyncConfig({ id: 'mid', updatedAt: '2026-02-01T00:00:00Z' }));

      const list = store.list();
      expect(list).toHaveLength(3);
      expect(list[0].id).toBe('new');
      expect(list[1].id).toBe('mid');
      expect(list[2].id).toBe('old');
    });
  });

  describe('delete', () => {
    it('should delete an existing config and return true', () => {
      store.save(createSyncConfig());
      expect(store.delete('cfg-1')).toBe(true);
      expect(store.load('cfg-1')).toBeUndefined();
    });

    it('should return false when deleting a non-existent config', () => {
      expect(store.delete('non-existent')).toBe(false);
    });
  });
});
