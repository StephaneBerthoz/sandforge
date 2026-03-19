import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SettingsHandler } from './SettingsHandler';
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

function createMsg(type: string, payload: Record<string, unknown> = {}): BaseMessage & { payload: Record<string, unknown> } {
  return { id: 'req-42', type, timestamp: Date.now(), payload };
}

describe('SettingsHandler', () => {
  let handler: SettingsHandler;
  let deps: HandlerDeps;
  let store: ConfigStore;

  beforeEach(() => {
    store = new ConfigStore(new InMemoryBackend());
    store.initialize();
    deps = createMockDeps(store);
    handler = new SettingsHandler(deps);
  });

  it('returns false for unknown message types', async () => {
    expect(await handler.handle(createMsg('unknown:type'))).toBe(false);
  });

  it('handles settings:get with correlationId', async () => {
    store.set('theme', 'dark', 'settings');

    const result = await handler.handle(createMsg('settings:get'));
    expect(result).toBe(true);

    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.type).toBe('settings:response');
    expect(response.correlationId).toBe('req-42');
  });

  it('handles settings:update with correlationId', async () => {
    const result = await handler.handle(createMsg('settings:update', { key: 'lang', value: 'fr' }));
    expect(result).toBe(true);

    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.type).toBe('settings:response');
    expect(response.correlationId).toBe('req-42');
  });

  it('handles plugins:list with correlationId', async () => {
    const result = await handler.handle(createMsg('plugins:list'));
    expect(result).toBe(true);

    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.type).toBe('plugins:list:response');
    expect(response.correlationId).toBe('req-42');
    expect(response.payload.success).toBe(true);
  });

  it('handles plugins:unload with correlationId', async () => {
    const result = await handler.handle(createMsg('plugins:unload', { pluginName: 'test-plugin' }));
    expect(result).toBe(true);

    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.type).toBe('plugins:unload:response');
    expect(response.correlationId).toBe('req-42');
    expect(response.payload.success).toBe(true);
  });

  it('handles telemetry:status with correlationId', async () => {
    const result = await handler.handle(createMsg('telemetry:status'));
    expect(result).toBe(true);

    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.type).toBe('telemetry:status:response');
    expect(response.correlationId).toBe('req-42');
    expect(response.payload.enabled).toBe(false);
  });

  it('handles telemetry:toggle with correlationId', async () => {
    const result = await handler.handle(createMsg('telemetry:toggle', { enabled: true }));
    expect(result).toBe(true);

    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.type).toBe('telemetry:toggle:response');
    expect(response.correlationId).toBe('req-42');
    expect(response.payload.enabled).toBe(true);
  });

  it('handles connectivity:status with correlationId', async () => {
    const result = await handler.handle(createMsg('connectivity:status'));
    expect(result).toBe(true);

    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.type).toBe('connectivity:status:response');
    expect(response.correlationId).toBe('req-42');
    expect(response.payload.online).toBe(true);
  });

  it('handles onboarding:complete without error', async () => {
    const result = await handler.handle(createMsg('onboarding:complete'));
    expect(result).toBe(true);
  });

  it('handles onboarding:reset without error', async () => {
    const result = await handler.handle(createMsg('onboarding:reset'));
    expect(result).toBe(true);
  });
});
