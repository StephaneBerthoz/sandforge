import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SettingsHandler } from './SettingsHandler';
import type { HandlerDeps } from './HandlerTypes';
import type { BaseMessage } from '@sandforge/shared';
import type { ConfigStoreBackend, ConfigEntry } from '../../core/storage/ConfigStoreBackend';
import { ConfigStore } from '../../core/storage/ConfigStore.js';

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

function createMsg(
  type: string,
  payload: Record<string, unknown> = {},
): BaseMessage & { payload: Record<string, unknown> } {
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

  it('no longer exposes the plugins:* surface', async () => {
    // plugins:load dynamic-imported an arbitrary filesystem path supplied over
    // the bridge, validated only as a 1-1000 char string — an arbitrary module
    // load reachable by any message, for a feature with no UI caller, whose
    // list returned a hardcoded empty array and whose unload did nothing.
    expect(await handler.handle(createMsg('plugins:list'))).toBe(false);
    expect(await handler.handle(createMsg('plugins:load', { pluginPath: '/tmp/evil.js' }))).toBe(
      false,
    );
    expect(await handler.handle(createMsg('plugins:unload', { pluginName: 'x' }))).toBe(false);
    expect(deps.broker.postToWebview).not.toHaveBeenCalled();
  });

  it('handles telemetry:status with correlationId', async () => {
    const result = await handler.handle(createMsg('telemetry:status'));
    expect(result).toBe(true);

    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.type).toBe('telemetry:status:response');
    expect(response.correlationId).toBe('req-42');
    expect(response.payload.enabled).toBe(false);
  });

  it('telemetry:status reports the real setting value and emitted event count', async () => {
    deps.services = {
      getSandforgeSetting: (key: string, fallback: unknown) =>
        key === 'telemetry' ? true : fallback,
      telemetry: { getTelemetryEventCount: () => 7 },
    } as unknown as NonNullable<HandlerDeps['services']>;

    await handler.handle(createMsg('telemetry:status'));

    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.payload.enabled).toBe(true);
    expect(response.payload.eventCount).toBe(7);
    expect(response.payload.bufferSize).toBe(0);
  });

  it('telemetry:toggle persists the setting and responds with the persisted value', async () => {
    const setSandforgeSetting = vi.fn().mockResolvedValue(undefined);
    let current = false;
    deps.services = {
      setSandforgeSetting,
      getSandforgeSetting: () => current,
    } as unknown as NonNullable<HandlerDeps['services']>;
    setSandforgeSetting.mockImplementation(async () => {
      current = true;
    });

    const result = await handler.handle(createMsg('telemetry:toggle', { enabled: true }));
    expect(result).toBe(true);

    expect(setSandforgeSetting).toHaveBeenCalledWith('telemetry', true);
    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.type).toBe('telemetry:toggle:response');
    expect(response.correlationId).toBe('req-42');
    expect(response.payload.success).toBe(true);
    expect(response.payload.enabled).toBe(true);
  });

  it('telemetry:toggle answers honestly when the settings backend is unavailable', async () => {
    const result = await handler.handle(createMsg('telemetry:toggle', { enabled: true }));
    expect(result).toBe(true);

    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.type).toBe('telemetry:toggle:response');
    expect(response.correlationId).toBe('req-42');
    expect(response.payload.success).toBe(false);
    expect(response.payload.enabled).toBe(false);
    expect(response.payload.error).toContain('not persisted');
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

  describe('payload validation', () => {
    it('rejects settings:update without key (INVALID_PAYLOAD)', async () => {
      const result = await handler.handle(createMsg('settings:update', { value: 'fr' }));
      expect(result).toBe(true);

      const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(response.type).toBe('settings:error');
      expect(response.payload.code).toBe('INVALID_PAYLOAD');
    });

    it('rejects telemetry:toggle with a non-boolean enabled (INVALID_PAYLOAD)', async () => {
      const result = await handler.handle(createMsg('telemetry:toggle', { enabled: 'yes' }));
      expect(result).toBe(true);

      const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(response.type).toBe('settings:error');
      expect(response.payload.code).toBe('INVALID_PAYLOAD');
    });
  });
});
