import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigProfileManager } from './ConfigProfileManager';
import type { ConfigProfile } from './ConfigProfileManager';
import { ConfigStore } from '../storage/ConfigStore.js';
import type { ConfigStoreBackend, ConfigEntry } from '../storage/ConfigStoreBackend';

/** In-memory backend for testing. */
class InMemoryBackend implements ConfigStoreBackend {
  private data: Record<string, ConfigEntry> = {};
  getData(): Record<string, ConfigEntry> {
    return { ...this.data };
  }
  setData(data: Record<string, ConfigEntry>): void {
    this.data = { ...data };
  }
}

describe('ConfigProfileManager', () => {
  let store: ConfigStore;
  let manager: ConfigProfileManager;

  beforeEach(() => {
    store = new ConfigStore(new InMemoryBackend());
    store.initialize();
    manager = new ConfigProfileManager(store);
  });

  describe('exportProfile', () => {
    it('exports selected categories', () => {
      store.set('sync:mapping-1', { source: 'Account', target: 'Account' }, 'syncMappings');
      store.set('sync:mapping-2', { source: 'Contact', target: 'Contact' }, 'syncMappings');
      store.set('pipeline:pipe-1', { name: 'Nightly Backup' }, 'pipelines');

      const result = manager.exportProfile(['syncMappings', 'pipelines']);
      expect(result.success).toBe(true);
      expect(result.categoriesExported).toBe(2);
      expect(result.entriesExported).toBe(3);
      expect(result.json).toBeDefined();

      const parsed = JSON.parse(result.json!) as ConfigProfile;
      expect(parsed.version).toBe('1.0.0');
      expect(parsed.categories).toEqual(['syncMappings', 'pipelines']);
    });

    it('exports empty categories without error', () => {
      const result = manager.exportProfile(['settings']);
      expect(result.success).toBe(true);
      expect(result.entriesExported).toBe(0);
    });

    it('includes exportedBy when provided', () => {
      const result = manager.exportProfile(['settings'], 'alice@example.com');
      const parsed = JSON.parse(result.json!) as ConfigProfile;
      expect(parsed.exportedBy).toBe('alice@example.com');
    });
  });

  describe('importProfile', () => {
    it('imports a valid profile', () => {
      const profile: ConfigProfile = {
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        categories: ['syncMappings'],
        data: {
          syncMappings: {
            'sync:mapping-1': { source: 'Account', target: 'Account' },
          },
        },
      };

      const result = manager.importProfile(JSON.stringify(profile));
      expect(result.success).toBe(true);
      expect(result.categoriesImported).toBe(1);
      expect(result.entriesImported).toBe(1);

      const value = store.get<{ source: string }>('sync:mapping-1');
      expect(value?.source).toBe('Account');
    });

    it('rejects invalid JSON', () => {
      const result = manager.importProfile('not-json');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('rejects invalid profile structure', () => {
      const result = manager.importProfile(JSON.stringify({ foo: 'bar' }));
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid profile format');
    });

    it('skips existing keys when overwrite is false', () => {
      store.set('sync:mapping-1', { source: 'Original' }, 'syncMappings');

      const profile: ConfigProfile = {
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        categories: ['syncMappings'],
        data: {
          syncMappings: {
            'sync:mapping-1': { source: 'Imported' },
          },
        },
      };

      const result = manager.importProfile(JSON.stringify(profile), false);
      expect(result.success).toBe(true);
      expect(result.entriesImported).toBe(0);
      expect(result.warnings).toHaveLength(1);

      const value = store.get<{ source: string }>('sync:mapping-1');
      expect(value?.source).toBe('Original');
    });

    it('overwrites existing keys when overwrite is true', () => {
      store.set('sync:mapping-1', { source: 'Original' }, 'syncMappings');

      const profile: ConfigProfile = {
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        categories: ['syncMappings'],
        data: {
          syncMappings: {
            'sync:mapping-1': { source: 'Imported' },
          },
        },
      };

      const result = manager.importProfile(JSON.stringify(profile), true);
      expect(result.success).toBe(true);
      expect(result.entriesImported).toBe(1);

      const value = store.get<{ source: string }>('sync:mapping-1');
      expect(value?.source).toBe('Imported');
    });

    it('warns about empty categories', () => {
      const profile: ConfigProfile = {
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        categories: ['syncMappings'],
        data: {},
      };

      const result = manager.importProfile(JSON.stringify(profile));
      expect(result.success).toBe(true);
      expect(result.warnings).toHaveLength(1);
    });
  });

  describe('validateProfile', () => {
    it('validates a correct profile', () => {
      const profile: ConfigProfile = {
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        categories: ['settings'],
        data: {},
      };
      const result = manager.validateProfile(JSON.stringify(profile));
      expect(result.valid).toBe(true);
      expect(result.categories).toEqual(['settings']);
    });

    it('rejects invalid JSON', () => {
      const result = manager.validateProfile('{broken');
      expect(result.valid).toBe(false);
    });

    it('rejects missing required fields', () => {
      const result = manager.validateProfile(JSON.stringify({ version: '1.0.0' }));
      expect(result.valid).toBe(false);
    });
  });

  describe('listCategories', () => {
    it('returns all categories with counts', () => {
      store.set('sync:mapping-1', { a: 1 }, 'syncMappings');
      store.set('sync:mapping-2', { b: 2 }, 'syncMappings');
      store.set('pipeline:pipe-1', { c: 3 }, 'pipelines');

      const categories = manager.listCategories();
      expect(categories).toHaveLength(5);

      const syncCat = categories.find((c) => c.category === 'syncMappings');
      expect(syncCat?.entryCount).toBe(2);

      const pipelineCat = categories.find((c) => c.category === 'pipelines');
      expect(pipelineCat?.entryCount).toBe(1);
    });
  });

  describe('round-trip', () => {
    it('exports and imports correctly', () => {
      store.set('sync:mapping-1', { source: 'Account' }, 'syncMappings');
      store.set('forge:plan-1', { name: 'Clone Accounts' }, 'forgePlans');

      const exportResult = manager.exportProfile(['syncMappings', 'forgePlans']);
      expect(exportResult.success).toBe(true);

      // Clear the store
      store.clearAll();
      store.initialize();

      // Import
      const importResult = manager.importProfile(exportResult.json!);
      expect(importResult.success).toBe(true);
      expect(importResult.entriesImported).toBe(2);

      expect(store.get('sync:mapping-1')).toEqual({ source: 'Account' });
      expect(store.get('forge:plan-1')).toEqual({ name: 'Clone Accounts' });
    });
  });
});
