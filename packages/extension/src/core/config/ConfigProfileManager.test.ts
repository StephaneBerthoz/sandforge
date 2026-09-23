import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigProfileManager } from './ConfigProfileManager';
import type { ConfigProfile } from './ConfigProfileManager';
import { ConfigStore } from '../storage/ConfigStore.js';
import type { ConfigStoreBackend, ConfigEntry } from '../storage/ConfigStoreBackend';
import { SyncConfigStore } from '../../modules/sync/SyncConfigStore.js';
import type { SyncConfig } from '@sandforge/shared';

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

/** A sync mapping as Sync saves it. */
function syncConfig(id: string): SyncConfig {
  return {
    id,
    name: `Mapping ${id}`,
    description: '',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    direction: 'source_to_target',
    mode: 'full',
    objects: [],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
  };
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
      store.set('sync:config:map-1', { source: 'Account', target: 'Account' }, 'syncConfigs');
      store.set('sync:config:map-2', { source: 'Contact', target: 'Contact' }, 'syncConfigs');
      store.set('pipeline:saved:pipe-1', { name: 'Nightly Backup' }, 'pipelines');

      const result = manager.exportProfile(['syncMappings', 'pipelines']);
      expect(result.success).toBe(true);
      expect(result.categoriesExported).toBe(2);
      expect(result.entriesExported).toBe(3);
      expect(result.json).toBeDefined();

      const parsed = JSON.parse(result.json!) as ConfigProfile;
      expect(parsed.version).toBe('1.0.0');
      expect(parsed.categories).toEqual(['syncMappings', 'pipelines']);
    });

    it('exports the saved pipelines, and not the history of their runs', () => {
      // Where AutomationHandler keeps each: a saved pipeline, and one run of it.
      store.set('pipeline:saved:pipe-1', { id: 'pipe-1', name: 'Nightly Backup' }, 'pipelines');
      store.set(
        'pipeline:history:run-1',
        { runId: 'run-1', pipelineId: 'pipe-1', status: 'completed' },
        'pipeline-history',
      );

      const result = manager.exportProfile(['pipelines']);

      expect(result.entriesExported).toBe(1);
      const parsed = JSON.parse(result.json!) as ConfigProfile;
      expect(parsed.data.pipelines).toEqual({
        'pipeline:saved:pipe-1': { id: 'pipe-1', name: 'Nightly Backup' },
      });
    });

    it('exports the saved sync mappings, and not the history of the syncs run', () => {
      // Where SyncConfigStore and SyncHistoryStore keep each.
      new SyncConfigStore(store).save(syncConfig('map-1'));
      store.set('sync:history:all', [{ id: 'run-1', status: 'success' }], 'syncHistory');

      const result = manager.exportProfile(['syncMappings']);

      expect(result.entriesExported).toBe(1);
      const parsed = JSON.parse(result.json!) as ConfigProfile;
      expect(Object.keys(parsed.data.syncMappings as object)).toEqual(['sync:config:map-1']);
    });

    it('exports the saved Forge plans, and not the history of the clones run', () => {
      // Where ForgeHandler keeps each.
      store.set('forge:templates', [{ id: 'tpl-1', name: 'Account 360' }], 'forge');
      store.set('forge:history', [{ forgeId: 'forge-1', status: 'success' }], 'forge');

      const result = manager.exportProfile(['forgePlans']);

      expect(result.entriesExported).toBe(1);
      const parsed = JSON.parse(result.json!) as ConfigProfile;
      expect(parsed.data.forgePlans).toEqual({
        'forge:templates': [{ id: 'tpl-1', name: 'Account 360' }],
      });
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
            'sync:config:map-1': { source: 'Account', target: 'Account' },
          },
        },
      };

      const result = manager.importProfile(JSON.stringify(profile));
      expect(result.success).toBe(true);
      expect(result.categoriesImported).toBe(1);
      expect(result.entriesImported).toBe(1);

      const value = store.get<{ source: string }>('sync:config:map-1');
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
      store.set('sync:config:map-1', { source: 'Original' }, 'syncConfigs');

      const profile: ConfigProfile = {
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        categories: ['syncMappings'],
        data: {
          syncMappings: {
            'sync:config:map-1': { source: 'Imported' },
          },
        },
      };

      const result = manager.importProfile(JSON.stringify(profile), false);
      expect(result.success).toBe(true);
      expect(result.entriesImported).toBe(0);
      expect(result.warnings).toHaveLength(1);

      const value = store.get<{ source: string }>('sync:config:map-1');
      expect(value?.source).toBe('Original');
    });

    it('overwrites existing keys when overwrite is true', () => {
      store.set('sync:config:map-1', { source: 'Original' }, 'syncConfigs');

      const profile: ConfigProfile = {
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        categories: ['syncMappings'],
        data: {
          syncMappings: {
            'sync:config:map-1': { source: 'Imported' },
          },
        },
      };

      const result = manager.importProfile(JSON.stringify(profile), true);
      expect(result.success).toBe(true);
      expect(result.entriesImported).toBe(1);

      const value = store.get<{ source: string }>('sync:config:map-1');
      expect(value?.source).toBe('Imported');
    });

    it('imports a sync mapping where Sync lists it, and not the sync history an older profile carried', () => {
      const profile: ConfigProfile = {
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        categories: ['syncMappings'],
        data: {
          syncMappings: {
            'sync:config:map-1': syncConfig('map-1'),
            'sync:history:all': [{ id: 'run-1', status: 'success' }],
          },
        },
      };

      const result = manager.importProfile(JSON.stringify(profile));

      expect(result.entriesImported).toBe(1);
      expect(new SyncConfigStore(store).list().map((c) => c.id)).toEqual(['map-1']);
      expect(store.has('sync:history:all')).toBe(false);
      expect(result.warnings).toEqual([expect.stringContaining('"sync:history:all"')]);
    });

    it('imports the saved pipelines a profile carries, and not the run history an older one also carried', () => {
      // Written back under the category the saved pipelines are listed from,
      // each run came back as a pipeline.
      const profile: ConfigProfile = {
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        categories: ['pipelines'],
        data: {
          pipelines: {
            'pipeline:saved:pipe-1': { id: 'pipe-1', name: 'Nightly Backup' },
            'pipeline:history:run-1': { runId: 'run-1', pipelineId: 'pipe-1' },
          },
        },
      };

      const result = manager.importProfile(JSON.stringify(profile));

      expect(result.success).toBe(true);
      expect(result.entriesImported).toBe(1);
      expect(store.getByCategory('pipelines')).toEqual({
        'pipeline:saved:pipe-1': { id: 'pipe-1', name: 'Nightly Backup' },
      });
      expect(store.has('pipeline:history:run-1')).toBe(false);
      expect(result.warnings).toEqual([expect.stringContaining('"pipeline:history:run-1"')]);
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
      store.set('sync:config:map-1', { a: 1 }, 'syncConfigs');
      store.set('sync:config:map-2', { b: 2 }, 'syncConfigs');
      store.set('pipeline:saved:pipe-1', { c: 3 }, 'pipelines');
      store.set('pipeline:history:run-1', { d: 4 }, 'pipeline-history');

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
      store.set('sync:config:map-1', { source: 'Account' }, 'syncConfigs');
      store.set('forge:templates', [{ id: 'tpl-1', name: 'Clone Accounts' }], 'forge');

      const exportResult = manager.exportProfile(['syncMappings', 'forgePlans']);
      expect(exportResult.success).toBe(true);

      // Clear the store
      store.clearAll();
      store.initialize();

      // Import
      const importResult = manager.importProfile(exportResult.json!);
      expect(importResult.success).toBe(true);
      expect(importResult.entriesImported).toBe(2);

      expect(store.get('sync:config:map-1')).toEqual({ source: 'Account' });
      expect(store.get('forge:templates')).toEqual([{ id: 'tpl-1', name: 'Clone Accounts' }]);
    });
  });
});
