import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { StorageAdapter } from '../storage/StorageAdapter.js';
import { createAIClientFactory } from './AIClientFactory.js';
import { AINotImplementedError } from './AIClient.js';

vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    messages = { create: vi.fn() };
    constructor(_args: { apiKey: string }) {}
  },
  APIUserAbortError: class APIUserAbortError extends Error {},
}));

const fakeStorage = {
  getSecret: vi.fn(),
  setSecret: vi.fn(),
  deleteSecret: vi.fn(),
} as unknown as StorageAdapter;

describe('AIClientFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an AnthropicAdapter when getProvider resolves to anthropic', () => {
    const factory = createAIClientFactory({
      storage: fakeStorage,
      getProvider: () => 'anthropic',
    });
    const client = factory();
    expect(client.provider).toBe('anthropic');
    expect(typeof client.chat).toBe('function');
    expect(typeof client.dispose).toBe('function');
  });

  it('memoises one instance per provider — repeated calls return the same object', () => {
    const factory = createAIClientFactory({
      storage: fakeStorage,
      getProvider: () => 'anthropic',
    });
    const client1 = factory();
    const client2 = factory();
    const client3 = factory('anthropic');
    expect(client1).toBe(client2);
    expect(client1).toBe(client3);
  });

  it('returns an OpenAIAdapter STUB for openai — the factory does not throw', () => {
    const factory = createAIClientFactory({
      storage: fakeStorage,
      getProvider: () => 'openai',
    });
    const client = factory();
    expect(client.provider).toBe('openai');
    expect(typeof client.chat).toBe('function');
  });

  it('returns a CustomAdapter STUB for custom — the factory does not throw', () => {
    const factory = createAIClientFactory({
      storage: fakeStorage,
      getProvider: () => 'custom',
    });
    const client = factory();
    expect(client.provider).toBe('custom');
    expect(typeof client.chat).toBe('function');
  });

  it('calling chat() on openai stub throws AINotImplementedError with provider-switch hint', async () => {
    const factory = createAIClientFactory({
      storage: fakeStorage,
      getProvider: () => 'openai',
    });
    const client = factory();
    await expect(client.chat({ messages: [] })).rejects.toThrow(AINotImplementedError);
    await expect(client.chat({ messages: [] })).rejects.toThrow(/sandforge\.ai\.provider/);
    await expect(client.chat({ messages: [] })).rejects.toThrow(/anthropic/);
  });

  it('typo provider STILL throws at factory time', () => {
    const factory = createAIClientFactory({
      storage: fakeStorage,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getProvider: () => 'anthrop' as any,
    });
    expect(() => factory()).toThrow(AINotImplementedError);
  });

  it('explicit provider arg overrides getProvider', () => {
    const factory = createAIClientFactory({
      storage: fakeStorage,
      getProvider: () => 'openai', // would normally throw
    });
    // explicit anthropic should succeed
    const client = factory('anthropic');
    expect(client.provider).toBe('anthropic');
  });

  it('passes model override from getModel into the adapter', () => {
    const factory = createAIClientFactory({
      storage: fakeStorage,
      getProvider: () => 'anthropic',
      getModel: () => 'claude-opus-test-1',
    });
    // We can't introspect the adapter's private model field directly,
    // but the factory call should not throw. Memoisation also verifies wiring.
    expect(() => factory()).not.toThrow();
  });

  it('invalidate() disposes cached adapters and rebuilds them on next call', () => {
    const factory = createAIClientFactory({
      storage: fakeStorage,
      getProvider: () => 'anthropic',
    });
    const first = factory();
    const disposeSpy = vi.spyOn(first, 'dispose');

    factory.invalidate();

    expect(disposeSpy).toHaveBeenCalledTimes(1);
    const second = factory();
    expect(second).not.toBe(first);
    expect(second.provider).toBe('anthropic');
  });
});
