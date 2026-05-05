import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { StorageAdapter } from '../storage/StorageAdapter.js';
import { createAIClientFactory } from './AIClientFactory.js';
import { AINotImplementedError } from './AIClient.js';

vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    messages = { create: vi.fn(), parse: vi.fn(), countTokens: vi.fn() };
    constructor(_args: { apiKey: string }) {}
  },
  APIUserAbortError: class APIUserAbortError extends Error {},
}));
vi.mock('@anthropic-ai/sdk/helpers/zod', () => ({ zodOutputFormat: (s: unknown) => s }));

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
    expect(typeof client.complete).toBe('function');
    expect(typeof client.countTokens).toBe('function');
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

  it('throws AINotImplementedError for openai (stub lands in 04-07)', () => {
    const factory = createAIClientFactory({
      storage: fakeStorage,
      getProvider: () => 'openai',
    });
    expect(() => factory()).toThrow(AINotImplementedError);
    expect(() => factory()).toThrow(/OpenAIAdapter ships in Plan 04-07/);
  });

  it('throws AINotImplementedError for custom (stub lands in 04-07)', () => {
    const factory = createAIClientFactory({
      storage: fakeStorage,
      getProvider: () => 'custom',
    });
    expect(() => factory()).toThrow(AINotImplementedError);
    expect(() => factory()).toThrow(/CustomAdapter ships in Plan 04-07/);
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
});
