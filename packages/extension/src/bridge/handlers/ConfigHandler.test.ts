import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigHandler } from './ConfigHandler';
import type { HandlerDeps } from './HandlerTypes';
import type { BaseMessage } from '@sandforge/shared';
import type { ConfigStoreBackend, ConfigEntry } from '../../core/storage/ConfigStoreBackend';
import { ConfigStore } from '../../core/storage/ConfigStore.js';

class InMemoryBackend implements ConfigStoreBackend {
  private data: Record<string, ConfigEntry> = {};
  getData(): Record<string, ConfigEntry> { return { ...this.data }; }
  setData(data: Record<string, ConfigEntry>): void { this.data = { ...data }; }
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
    const msg: BaseMessage = { id: '1', type: 'unknown:type', timestamp: Date.now() };
    expect(await handler.handle(msg)).toBe(false);
  });

  it('handles config:export', async () => {
    store.set('sync:mapping-1', { source: 'Account' }, 'syncMappings');

    const msg: BaseMessage & { payload: { categories: string[] } } = {
      id: '1', type: 'config:export', timestamp: Date.now(),
      payload: { categories: ['syncMappings'] },
    };

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
        syncMappings: { 'sync:mapping-1': { source: 'Account' } },
      },
    };

    const msg: BaseMessage & { payload: { json: string; overwrite: boolean } } = {
      id: '1', type: 'config:import', timestamp: Date.now(),
      payload: { json: JSON.stringify(profile), overwrite: true },
    };

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

    const msg: BaseMessage = { id: '1', type: 'config:categories', timestamp: Date.now() };

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

    const msg: BaseMessage & { payload: { json: string } } = {
      id: '1', type: 'config:validate', timestamp: Date.now(),
      payload: { json: JSON.stringify(profile) },
    };

    expect(await handler.handle(msg)).toBe(true);

    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.payload.valid).toBe(true);
    expect(response.correlationId).toBe('1');
  });

  it('handles config:validate with invalid JSON', async () => {
    const msg: BaseMessage & { payload: { json: string } } = {
      id: '1', type: 'config:validate', timestamp: Date.now(),
      payload: { json: 'not-json' },
    };

    expect(await handler.handle(msg)).toBe(true);

    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.payload.valid).toBe(false);
  });
});
