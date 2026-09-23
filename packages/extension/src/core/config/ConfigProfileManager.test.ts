import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigProfileManager } from './ConfigProfileManager';
import type { ConfigProfile, ForgeTemplateWorkspace } from './ConfigProfileManager';
import { importedTemplatesFor } from './importedForgeTemplates.js';
import { ConfigStore } from '../storage/ConfigStore.js';
import type { ConfigStoreBackend, ConfigEntry } from '../storage/ConfigStoreBackend';
import { SyncConfigStore } from '../../modules/sync/SyncConfigStore.js';
import type { ForgeTemplate, SyncConfig } from '@sandforge/shared';

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

/** A Forge template, down to what a profile matches and a test reads: its id and name. */
function template(id: string, name = `Recipe ${id}`): ForgeTemplate {
  return { id, name } as ForgeTemplate;
}

/** A workspace at `folder` whose `.sandforge/forge-templates.json` holds `inFile`. */
function workspaceHolding(inFile: ForgeTemplate[], folder = '/ws'): ForgeTemplateWorkspace {
  return { folder, readTemplates: async () => inFile };
}

/** A profile carrying `templates` as its Forge plans, as an export writes it. */
function forgeProfile(templates: unknown[]): string {
  return JSON.stringify({
    version: '1.0.0',
    exportedAt: '2026-09-01T00:00:00.000Z',
    categories: ['forgePlans'],
    data: { forgePlans: { 'forge:templates': templates } },
  } satisfies ConfigProfile);
}

/** The Forge templates a profile exported by `manager` carries, as `id:name`. */
async function exportedTemplates(manager: ConfigProfileManager): Promise<string[]> {
  const exported = JSON.parse((await manager.exportProfile(['forgePlans'])).json!) as ConfigProfile;
  const plans = exported.data.forgePlans as { 'forge:templates'?: ForgeTemplate[] };
  return (plans['forge:templates'] ?? []).map((t) => `${t.id}:${t.name}`);
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
    it('exports selected categories', async () => {
      store.set('sync:config:map-1', { source: 'Account', target: 'Account' }, 'syncConfigs');
      store.set('sync:config:map-2', { source: 'Contact', target: 'Contact' }, 'syncConfigs');
      store.set('pipeline:saved:pipe-1', { name: 'Nightly Backup' }, 'pipelines');

      const result = await manager.exportProfile(['syncMappings', 'pipelines']);
      expect(result.success).toBe(true);
      expect(result.categoriesExported).toBe(2);
      expect(result.entriesExported).toBe(3);
      expect(result.json).toBeDefined();

      const parsed = JSON.parse(result.json!) as ConfigProfile;
      expect(parsed.version).toBe('1.0.0');
      expect(parsed.categories).toEqual(['syncMappings', 'pipelines']);
    });

    it('exports the saved pipelines, and not the history of their runs', async () => {
      // Where AutomationHandler keeps each: a saved pipeline, and one run of it.
      store.set('pipeline:saved:pipe-1', { id: 'pipe-1', name: 'Nightly Backup' }, 'pipelines');
      store.set(
        'pipeline:history:run-1',
        { runId: 'run-1', pipelineId: 'pipe-1', status: 'completed' },
        'pipeline-history',
      );

      const result = await manager.exportProfile(['pipelines']);

      expect(result.entriesExported).toBe(1);
      const parsed = JSON.parse(result.json!) as ConfigProfile;
      expect(parsed.data.pipelines).toEqual({
        'pipeline:saved:pipe-1': { id: 'pipe-1', name: 'Nightly Backup' },
      });
    });

    it('exports the saved sync mappings, and not the history of the syncs run', async () => {
      // Where SyncConfigStore and SyncHistoryStore keep each.
      new SyncConfigStore(store).save(syncConfig('map-1'));
      store.set('sync:history:all', [{ id: 'run-1', status: 'success' }], 'syncHistory');

      const result = await manager.exportProfile(['syncMappings']);

      expect(result.entriesExported).toBe(1);
      const parsed = JSON.parse(result.json!) as ConfigProfile;
      expect(Object.keys(parsed.data.syncMappings as object)).toEqual(['sync:config:map-1']);
    });

    it('exports the saved Forge plans, and not the history of the clones run', async () => {
      // Where ForgeHandler keeps each in a window with no folder open.
      store.set('forge:templates', [{ id: 'tpl-1', name: 'Account 360' }], 'forge');
      store.set('forge:history', [{ forgeId: 'forge-1', status: 'success' }], 'forge');

      const result = await manager.exportProfile(['forgePlans']);

      expect(result.entriesExported).toBe(1);
      const parsed = JSON.parse(result.json!) as ConfigProfile;
      expect(parsed.data.forgePlans).toEqual({
        'forge:templates': [{ id: 'tpl-1', name: 'Account 360' }],
      });
    });

    it('exports empty categories without error', async () => {
      const result = await manager.exportProfile(['anonymizationTemplates']);
      expect(result.success).toBe(true);
      expect(result.entriesExported).toBe(0);
    });

    it('includes exportedBy when provided', async () => {
      const result = await manager.exportProfile(['pipelines'], 'alice@example.com');
      const parsed = JSON.parse(result.json!) as ConfigProfile;
      expect(parsed.exportedBy).toBe('alice@example.com');
    });
  });

  describe('importProfile', () => {
    it('imports a valid profile', async () => {
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

      const result = await manager.importProfile(JSON.stringify(profile));
      expect(result.success).toBe(true);
      expect(result.categoriesImported).toBe(1);
      expect(result.entriesImported).toBe(1);

      const value = store.get<{ source: string }>('sync:config:map-1');
      expect(value?.source).toBe('Account');
    });

    it('rejects invalid JSON', async () => {
      const result = await manager.importProfile('not-json');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('rejects invalid profile structure', async () => {
      const result = await manager.importProfile(JSON.stringify({ foo: 'bar' }));
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid profile format');
    });

    it('skips existing keys when overwrite is false', async () => {
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

      const result = await manager.importProfile(JSON.stringify(profile), false);
      expect(result.success).toBe(true);
      expect(result.entriesImported).toBe(0);
      expect(result.warnings).toHaveLength(1);

      const value = store.get<{ source: string }>('sync:config:map-1');
      expect(value?.source).toBe('Original');
    });

    it('overwrites existing keys when overwrite is true', async () => {
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

      const result = await manager.importProfile(JSON.stringify(profile), true);
      expect(result.success).toBe(true);
      expect(result.entriesImported).toBe(1);

      const value = store.get<{ source: string }>('sync:config:map-1');
      expect(value?.source).toBe('Imported');
    });

    it('imports a sync mapping where Sync lists it, and not the sync history an older profile carried', async () => {
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

      const result = await manager.importProfile(JSON.stringify(profile));

      expect(result.entriesImported).toBe(1);
      expect(new SyncConfigStore(store).list().map((c) => c.id)).toEqual(['map-1']);
      expect(store.has('sync:history:all')).toBe(false);
      expect(result.warnings).toEqual([expect.stringContaining('"sync:history:all"')]);
    });

    it('imports the saved pipelines a profile carries, and not the run history an older one also carried', async () => {
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

      const result = await manager.importProfile(JSON.stringify(profile));

      expect(result.success).toBe(true);
      expect(result.entriesImported).toBe(1);
      expect(store.getByCategory('pipelines')).toEqual({
        'pipeline:saved:pipe-1': { id: 'pipe-1', name: 'Nightly Backup' },
      });
      expect(store.has('pipeline:history:run-1')).toBe(false);
      expect(result.warnings).toEqual([expect.stringContaining('"pipeline:history:run-1"')]);
    });

    it('warns about empty categories', async () => {
      const profile: ConfigProfile = {
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        categories: ['syncMappings'],
        data: {},
      };

      const result = await manager.importProfile(JSON.stringify(profile));
      expect(result.success).toBe(true);
      expect(result.warnings).toHaveLength(1);
    });

    it('reads a profile that lists the settings category, and imports the rest of it', async () => {
      // What 1.36 exported by default: every category selected, settings empty.
      const profile: ConfigProfile = {
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        categories: ['syncMappings', 'settings'],
        data: {
          syncMappings: { 'sync:config:map-1': syncConfig('map-1') },
          settings: {},
        },
      };

      const result = await manager.importProfile(JSON.stringify(profile));

      expect(result.success).toBe(true);
      expect(result.categoriesImported).toBe(1);
      expect(result.entriesImported).toBe(1);
      expect(result.warnings).toEqual([]);
      expect(new SyncConfigStore(store).list().map((c) => c.id)).toEqual(['map-1']);
    });
  });

  describe('Forge templates in a window with a folder open', () => {
    it('exports the templates the workspace file holds, not those the ConfigStore keeps', async () => {
      // The export read the ConfigStore's `forge:templates`, which every window
      // wrote its list to: it carried whichever project had saved last.
      store.set('forge:templates', [template('elsewhere')], 'forge');
      manager = new ConfigProfileManager(store, workspaceHolding([template('a'), template('b')]));

      const result = await manager.exportProfile(['forgePlans']);

      expect(result.entriesExported).toBe(2);
      expect(await exportedTemplates(manager)).toEqual(['a:Recipe a', 'b:Recipe b']);
    });

    it('without overwrite, brings in the templates the workspace does not hold, and skips those it does', async () => {
      // The ConfigStore holds `forge:templates` as soon as a window with no
      // folder open saved a template: the import skipped that key whole, and
      // brought in nothing.
      store.set('forge:templates', [template('shared', 'saved here')], 'forge');
      manager = new ConfigProfileManager(
        store,
        workspaceHolding([template('shared', 'kept from the file'), template('a')]),
      );

      const result = await manager.importProfile(
        forgeProfile([template('shared', 'from the profile'), template('b')]),
        false,
      );

      expect(result.entriesImported).toBe(1);
      expect(result.warnings).toEqual([
        'Forge template "from the profile" already exists, skipped.',
      ]);
      expect(await exportedTemplates(manager)).toEqual([
        'shared:kept from the file',
        'a:Recipe a',
        'b:Recipe b',
      ]);
    });

    it('with overwrite, brings in every template, one the workspace holds replacing its own', async () => {
      manager = new ConfigProfileManager(
        store,
        workspaceHolding([template('shared', 'kept from the file'), template('a')]),
      );

      const result = await manager.importProfile(
        forgeProfile([template('shared', 'from the profile'), template('b')]),
        true,
      );

      expect(result.entriesImported).toBe(2);
      expect(result.warnings).toEqual([]);
      expect(await exportedTemplates(manager)).toEqual([
        'shared:from the profile',
        'a:Recipe a',
        'b:Recipe b',
      ]);
    });

    it('leaves the templates for the folder the import was made in, and the ConfigStore copy as it was', async () => {
      store.set('forge:templates', [template('elsewhere')], 'forge');
      manager = new ConfigProfileManager(store, workspaceHolding([], '/ws'));

      await manager.importProfile(forgeProfile([template('b')]));

      expect(importedTemplatesFor(store, '/ws')?.templates.map((t) => t.id)).toEqual(['b']);
      expect(importedTemplatesFor(store, '/other')).toBeUndefined();
      expect(store.get('forge:templates')).toEqual([template('elsewhere')]);
    });

    it('weighs a second import against the templates the first left for the workspace', async () => {
      // Forge has not listed the workspace in between: the first import's
      // templates are still waiting, and the workspace holds them all the same.
      manager = new ConfigProfileManager(store, workspaceHolding([]));
      await manager.importProfile(forgeProfile([template('b', 'first')]));

      const again = await manager.importProfile(forgeProfile([template('b', 'second')]), false);
      expect(again.entriesImported).toBe(0);
      expect(again.warnings).toEqual(['Forge template "second" already exists, skipped.']);

      await manager.importProfile(forgeProfile([template('b', 'third')]), true);
      expect(await exportedTemplates(manager)).toEqual(['b:third']);
    });

    it('skips, with a warning each, what in the category is not a template', async () => {
      manager = new ConfigProfileManager(store, workspaceHolding([]));
      const profile = JSON.stringify({
        version: '1.0.0',
        exportedAt: '2026-09-01T00:00:00.000Z',
        categories: ['forgePlans'],
        data: {
          forgePlans: {
            'forge:templates': [null, { name: 'no id' }, template('b'), template('b', 'again')],
            'forge:history': [{ forgeId: 'run-1' }],
          },
        },
      });

      const result = await manager.importProfile(profile);

      expect(result.entriesImported).toBe(1);
      expect(result.warnings).toEqual([
        'An entry of "forge:templates" has no id, skipped.',
        'An entry of "forge:templates" has no id, skipped.',
        expect.stringContaining('"forge:history"'),
      ]);
      expect(await exportedTemplates(manager)).toEqual(['b:Recipe b']);
    });

    it('counts the templates the workspace holds as the category’s entries', async () => {
      // It counted the ConfigStore keys the category exported: one at most,
      // and none for a workspace whose templates came from its repository.
      manager = new ConfigProfileManager(
        store,
        workspaceHolding([template('a'), template('b'), template('c')]),
      );

      const categories = await manager.listCategories();

      expect(categories.find((c) => c.category === 'forgePlans')?.entryCount).toBe(3);
    });
  });

  describe('Forge templates in a window with no folder open', () => {
    it('adds the imported templates to the ConfigStore list rather than replacing it', async () => {
      store.set('forge:templates', [template('a')], 'forge');

      const result = await manager.importProfile(forgeProfile([template('b')]), true);

      expect(result.entriesImported).toBe(1);
      expect(await exportedTemplates(manager)).toEqual(['a:Recipe a', 'b:Recipe b']);
    });

    it('without overwrite, keeps the ConfigStore’s template on an id both hold, and adds the rest', async () => {
      store.set('forge:templates', [template('shared', 'saved here'), template('a')], 'forge');

      const result = await manager.importProfile(
        forgeProfile([template('shared', 'from the profile'), template('b')]),
        false,
      );

      expect(result.entriesImported).toBe(1);
      expect(result.warnings).toEqual([
        'Forge template "from the profile" already exists, skipped.',
      ]);
      expect(await exportedTemplates(manager)).toEqual([
        'shared:saved here',
        'a:Recipe a',
        'b:Recipe b',
      ]);
    });

    it('with overwrite, replaces the ConfigStore’s template of an id both hold', async () => {
      store.set('forge:templates', [template('shared', 'saved here'), template('a')], 'forge');

      await manager.importProfile(
        forgeProfile([template('shared', 'from the profile'), template('b')]),
        true,
      );

      expect(await exportedTemplates(manager)).toEqual([
        'shared:from the profile',
        'a:Recipe a',
        'b:Recipe b',
      ]);
    });
  });

  describe('validateProfile', () => {
    it('validates a correct profile', () => {
      const profile: ConfigProfile = {
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        categories: ['pipelines'],
        data: {},
      };
      const result = manager.validateProfile(JSON.stringify(profile));
      expect(result.valid).toBe(true);
      expect(result.categories).toEqual(['pipelines']);
    });

    it('validates a profile that lists the settings category, naming only what it imports', () => {
      const profile: ConfigProfile = {
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        categories: ['forgePlans', 'settings'],
        data: {},
      };
      const result = manager.validateProfile(JSON.stringify(profile));
      expect(result.valid).toBe(true);
      expect(result.categories).toEqual(['forgePlans']);
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
    it('returns all categories with counts', async () => {
      store.set('sync:config:map-1', { a: 1 }, 'syncConfigs');
      store.set('sync:config:map-2', { b: 2 }, 'syncConfigs');
      store.set('pipeline:saved:pipe-1', { c: 3 }, 'pipelines');
      store.set('pipeline:history:run-1', { d: 4 }, 'pipeline-history');

      const categories = await manager.listCategories();
      expect(categories).toHaveLength(4);

      const syncCat = categories.find((c) => c.category === 'syncMappings');
      expect(syncCat?.entryCount).toBe(2);

      const pipelineCat = categories.find((c) => c.category === 'pipelines');
      expect(pipelineCat?.entryCount).toBe(1);
    });

    it('offers no settings category: the settings are VS Code settings, which a profile does not carry', async () => {
      // It exported the keys under a `settings:` prefix, and nothing writes
      // any: the category was always empty.
      expect((await manager.listCategories()).map((c) => c.category)).toEqual([
        'syncMappings',
        'forgePlans',
        'pipelines',
        'anonymizationTemplates',
      ]);
    });
  });

  describe('round-trip', () => {
    it('exports and imports correctly', async () => {
      store.set('sync:config:map-1', { source: 'Account' }, 'syncConfigs');
      store.set('forge:templates', [{ id: 'tpl-1', name: 'Clone Accounts' }], 'forge');

      const exportResult = await manager.exportProfile(['syncMappings', 'forgePlans']);
      expect(exportResult.success).toBe(true);

      // Clear the store
      store.clearAll();
      store.initialize();

      // Import
      const importResult = await manager.importProfile(exportResult.json!);
      expect(importResult.success).toBe(true);
      expect(importResult.entriesImported).toBe(2);

      expect(store.get('sync:config:map-1')).toEqual({ source: 'Account' });
      expect(store.get('forge:templates')).toEqual([{ id: 'tpl-1', name: 'Clone Accounts' }]);
    });
  });
});
