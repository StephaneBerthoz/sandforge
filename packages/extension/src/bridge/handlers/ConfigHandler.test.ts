import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigHandler } from './ConfigHandler';
import type { HandlerDeps } from './HandlerTypes';
import type { BaseMessage } from '@sandforge/shared';
import type { ConfigStoreBackend, ConfigEntry } from '../../core/storage/ConfigStoreBackend';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { importedTemplatesFor } from '../../core/config/importedForgeTemplates.js';
import type { InboundRequest } from './HandlerTypes.js';
import { inboundRequest } from '../../test/mockFactories.js';

class InMemoryBackend implements ConfigStoreBackend {
  private data: Record<string, ConfigEntry> = {};
  getData(): Record<string, ConfigEntry> {
    return { ...this.data };
  }
  setData(data: Record<string, ConfigEntry>): void {
    this.data = { ...data };
  }
}

function createMockDeps(store: ConfigStore): HandlerDeps {
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: {} as HandlerDeps['orgManager'],
    orgRegistry: {} as HandlerDeps['orgRegistry'],
    configStore: store,
    secretVault: {} as HandlerDeps['secretVault'],
    authProvider: {} as HandlerDeps['authProvider'],
    sfdxBridge: {} as HandlerDeps['sfdxBridge'],
    nextId: vi.fn().mockReturnValue('test-id'),
  };
}

describe('ConfigHandler', () => {
  let handler: ConfigHandler;
  let deps: HandlerDeps;
  let store: ConfigStore;

  beforeEach(() => {
    store = new ConfigStore(new InMemoryBackend());
    store.initialize();
    deps = createMockDeps(store);
    handler = new ConfigHandler(deps);
  });

  it('returns false for unknown message types', async () => {
    const msg: InboundRequest = inboundRequest({
      id: '1',
      type: 'unknown:type',
      timestamp: Date.now(),
    });
    expect(await handler.handle(msg)).toBe(false);
  });

  it('handles config:export', async () => {
    store.set('sync:config:map-1', { source: 'Account' }, 'syncConfigs');

    const msg: InboundRequest & { payload: { categories: string[] } } = inboundRequest({
      id: '1',
      type: 'config:export',
      timestamp: Date.now(),
      payload: { categories: ['syncMappings'] },
    });

    expect(await handler.handle(msg)).toBe(true);
    expect(deps.broker.postToWebview).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'config:export:response' }),
    );

    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.payload.success).toBe(true);
    expect(response.payload.entriesExported).toBe(1);
    expect(response.correlationId).toBe('1');
  });

  it('handles config:import', async () => {
    const profile = {
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      categories: ['syncMappings'],
      data: {
        syncMappings: { 'sync:config:map-1': { source: 'Account' } },
      },
    };

    const msg: InboundRequest & {
      payload: { json: string; overwrite: boolean };
    } = inboundRequest({
      id: '1',
      type: 'config:import',
      timestamp: Date.now(),
      payload: { json: JSON.stringify(profile), overwrite: true },
    });

    expect(await handler.handle(msg)).toBe(true);
    expect(deps.broker.postToWebview).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'config:import:response' }),
    );

    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.payload.success).toBe(true);
    expect(response.payload.entriesImported).toBe(1);
    expect(response.correlationId).toBe('1');
  });

  it('handles config:categories', async () => {
    store.set('sync:m1', { a: 1 }, 'syncMappings');
    store.set('sync:m2', { b: 2 }, 'syncMappings');

    const msg: InboundRequest = inboundRequest({
      id: '1',
      type: 'config:categories',
      timestamp: Date.now(),
    });

    expect(await handler.handle(msg)).toBe(true);
    expect(deps.broker.postToWebview).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'config:categories:response' }),
    );

    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.correlationId).toBe('1');
  });

  it('handles config:validate with valid profile', async () => {
    const profile = {
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      categories: ['settings'],
      data: {},
    };

    const msg: InboundRequest & { payload: { json: string } } = inboundRequest({
      id: '1',
      type: 'config:validate',
      timestamp: Date.now(),
      payload: { json: JSON.stringify(profile) },
    });

    expect(await handler.handle(msg)).toBe(true);

    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.payload.valid).toBe(true);
    expect(response.correlationId).toBe('1');
  });

  it('handles config:validate with invalid JSON', async () => {
    const msg: InboundRequest & { payload: { json: string } } = inboundRequest({
      id: '1',
      type: 'config:validate',
      timestamp: Date.now(),
      payload: { json: 'not-json' },
    });

    expect(await handler.handle(msg)).toBe(true);

    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.payload.valid).toBe(false);
  });

  describe('payload validation', () => {
    it('rejects config:export with an unknown category (INVALID_PAYLOAD)', async () => {
      const msg = inboundRequest({
        id: 'bad-export',
        type: 'config:export',
        timestamp: Date.now(),
        payload: { categories: ['bogusCategory'] },
      } as unknown as BaseMessage);

      expect(await handler.handle(msg)).toBe(true);

      const errMsg = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(errMsg.type).toBe('config:error');
      expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
    });

    it('rejects config:export of the settings category, which no profile carries', async () => {
      const msg = inboundRequest({
        id: 'settings-export',
        type: 'config:export',
        timestamp: Date.now(),
        payload: { categories: ['settings'] },
      } as unknown as BaseMessage);

      expect(await handler.handle(msg)).toBe(true);

      const errMsg = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(errMsg.type).toBe('config:error');
      expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
    });

    it('rejects config:import without overwrite flag (INVALID_PAYLOAD)', async () => {
      const msg = inboundRequest({
        id: 'bad-import',
        type: 'config:import',
        timestamp: Date.now(),
        payload: { json: '{}' },
      } as unknown as BaseMessage);

      expect(await handler.handle(msg)).toBe(true);

      const errMsg = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(errMsg.type).toBe('config:error');
      expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
    });
  });

  describe('Forge templates, with a folder open', () => {
    let folder: string;

    beforeEach(async () => {
      folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sandforge-profile-'));
      await fs.mkdir(path.join(folder, '.sandforge'));
      await fs.writeFile(
        path.join(folder, '.sandforge', 'forge-templates.json'),
        JSON.stringify([
          { id: 'tpl-1', name: 'Account 360' },
          { id: 'tpl-2', name: 'Case Workflow' },
        ]),
      );
      // What a window with no folder open keeps in the store every window shares.
      store.set('forge:templates', [{ id: 'tpl-elsewhere', name: 'Elsewhere' }], 'forge');
      deps = {
        ...createMockDeps(store),
        services: { getWorkspaceFolders: () => [folder] } as unknown as HandlerDeps['services'],
      };
      handler = new ConfigHandler(deps);
    });

    afterEach(async () => {
      await fs.rm(folder, { recursive: true, force: true });
    });

    /** The payload of the one response the handler posted. */
    function answer<T>(): T {
      return (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0].payload as T;
    }

    it('exports the templates the folder’s file holds', async () => {
      await handler.handle(
        inboundRequest({
          id: '1',
          type: 'config:export',
          timestamp: Date.now(),
          payload: { categories: ['forgePlans'] },
        }),
      );

      const { json, entriesExported } = answer<{ json: string; entriesExported: number }>();
      const profile = JSON.parse(json) as {
        data: { forgePlans: { 'forge:templates': Array<{ id: string }> } };
      };
      expect(profile.data.forgePlans['forge:templates'].map((t) => t.id)).toEqual([
        'tpl-1',
        'tpl-2',
      ]);
      expect(entriesExported).toBe(2);
    });

    it('counts the templates the folder’s file holds', async () => {
      await handler.handle(
        inboundRequest({ id: '1', type: 'config:categories', timestamp: Date.now() }),
      );

      const { categories } = answer<{
        categories: Array<{ category: string; entryCount: number }>;
      }>();
      expect(categories.find((c) => c.category === 'forgePlans')?.entryCount).toBe(2);
    });

    it('leaves an imported template for the folder the window has open', async () => {
      const profile = {
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        categories: ['forgePlans'],
        data: { forgePlans: { 'forge:templates': [{ id: 'tpl-3', name: 'Lead to Opportunity' }] } },
      };

      await handler.handle(
        inboundRequest({
          id: '1',
          type: 'config:import',
          timestamp: Date.now(),
          payload: { json: JSON.stringify(profile), overwrite: false },
        }),
      );

      expect(answer<{ entriesImported: number }>().entriesImported).toBe(1);
      expect(importedTemplatesFor(store, folder)?.templates.map((t) => t.id)).toEqual(['tpl-3']);
    });
  });
});
