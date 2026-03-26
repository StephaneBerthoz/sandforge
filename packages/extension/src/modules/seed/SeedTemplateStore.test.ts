import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SeedTemplateStore } from './SeedTemplateStore';
import type { SeedTemplate } from '@sandforge/shared';

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

function createSeedTemplate(overrides?: Partial<SeedTemplate>): SeedTemplate {
  return {
    id: 'tpl-1',
    name: 'Test Template',
    description: 'A test seed template',
    version: 1,
    strategy: 'faker',
    objects: [],
    tags: ['test'],
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
    ...overrides,
  };
}

describe('SeedTemplateStore', () => {
  let store: SeedTemplateStore;
  let configStore: ReturnType<typeof createMockConfigStore>;

  beforeEach(() => {
    configStore = createMockConfigStore();
    store = new SeedTemplateStore(configStore as never);
  });

  describe('save / load', () => {
    it('should round-trip save and load a template', () => {
      const template = createSeedTemplate();
      store.save(template);
      const loaded = store.load('tpl-1');
      expect(loaded).toBeDefined();
      expect(loaded?.id).toBe('tpl-1');
      expect(loaded?.name).toBe('Test Template');
    });

    it('should store with the correct key prefix and category', () => {
      const template = createSeedTemplate();
      store.save(template);
      expect(configStore.set).toHaveBeenCalledWith(
        'seed:template:tpl-1',
        template,
        'seedTemplates',
      );
    });

    it('should return undefined for non-existent template', () => {
      expect(store.load('non-existent')).toBeUndefined();
    });

    it('should overwrite an existing template on save', () => {
      store.save(createSeedTemplate());
      store.save(createSeedTemplate({ name: 'Updated Template' }));
      const loaded = store.load('tpl-1');
      expect(loaded?.name).toBe('Updated Template');
    });
  });

  describe('list', () => {
    it('should return empty array when no templates exist', () => {
      expect(store.list()).toEqual([]);
    });

    it('should return all templates sorted by updatedAt descending', () => {
      store.save(createSeedTemplate({ id: 'old', updatedAt: '2026-01-01T00:00:00Z' }));
      store.save(createSeedTemplate({ id: 'new', updatedAt: '2026-03-01T00:00:00Z' }));
      store.save(createSeedTemplate({ id: 'mid', updatedAt: '2026-02-01T00:00:00Z' }));

      const list = store.list();
      expect(list).toHaveLength(3);
      expect(list[0].id).toBe('new');
      expect(list[1].id).toBe('mid');
      expect(list[2].id).toBe('old');
    });
  });

  describe('delete', () => {
    it('should delete an existing template and return true', () => {
      store.save(createSeedTemplate());
      expect(store.delete('tpl-1')).toBe(true);
      expect(store.load('tpl-1')).toBeUndefined();
    });

    it('should return false when deleting a non-existent template', () => {
      expect(store.delete('non-existent')).toBe(false);
    });
  });
});
