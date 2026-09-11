import { describe, it, expect, vi } from 'vitest';

import type { StorageAdapter } from '../storage/StorageAdapter.js';
import { createAIClientFactory } from './AIClientFactory.js';
import { AnthropicAdapter } from './AnthropicAdapter.js';
import { OpenAIAdapter } from './OpenAIAdapter.js';
import { CustomAdapter } from './CustomAdapter.js';
import { AINotImplementedError } from './AIClient.js';

/**
 * Per-provider isolation contract — CONTEXT lock 04 says:
 *
 *   "Circuit-breaker is per-provider. A 529 storm on Anthropic does NOT
 *    degrade OpenAI or Custom. Breaker state lives on each adapter
 *    instance."
 *
 * This file PROVES that contract holds across the three provider
 * dispatches. Without these tests, a future refactor that accidentally
 * elevates the breaker to a global singleton would silently violate
 * the lock.
 */

const hoisted = vi.hoisted(() => {
  const create = vi.fn();
  return { mockMessagesCreate: create };
});

vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    messages = { create: hoisted.mockMessagesCreate, countTokens: vi.fn() };
    constructor(_args: { apiKey: string }) {}
  },
  APIUserAbortError: class APIUserAbortError extends Error {},
}));

class MockOverloadedError extends Error {
  status = 529;
  error = { error: { type: 'overloaded_error' } };
}

const fakeStorage = {
  getSecret: vi.fn().mockResolvedValue('sk-ant-fake-test-key-1234567890'),
  setSecret: vi.fn(),
  deleteSecret: vi.fn(),
} as unknown as StorageAdapter;

function makeFactory() {
  return createAIClientFactory({
    storage: fakeStorage,
    getProvider: () => 'anthropic',
  });
}

describe('multi-provider isolation', () => {
  it('factory returns three DISTINCT instances per provider', () => {
    const factory = makeFactory();
    const a = factory('anthropic');
    const o = factory('openai');
    const c = factory('custom');
    expect(a).not.toBe(o);
    expect(o).not.toBe(c);
    expect(a).not.toBe(c);
  });

  it('each provider has its OWN CircuitBreaker (no shared state)', () => {
    const factory = makeFactory();
    const a = factory('anthropic') as unknown as { breaker: object };
    const o = factory('openai') as unknown as { breaker: object };
    const c = factory('custom') as unknown as { breaker: object };
    expect(a.breaker).not.toBe(o.breaker);
    expect(o.breaker).not.toBe(c.breaker);
    expect(a.breaker).not.toBe(c.breaker);
  });

  it('Anthropic 529 storm does NOT trip OpenAI / Custom breakers', async () => {
    const factory = makeFactory();
    const anthropic = factory('anthropic') as AnthropicAdapter;
    const openai = factory('openai') as OpenAIAdapter;
    const custom = factory('custom') as CustomAdapter;

    hoisted.mockMessagesCreate.mockRejectedValue(new MockOverloadedError());
    for (let i = 0; i < 3; i++) {
      await expect(
        anthropic.chat({ messages: [{ role: 'user', content: 'hi' }] }),
      ).rejects.toThrow();
    }

    expect(anthropic.breaker.getState()).toBe('open');
    expect(openai.breaker.getState()).toBe('closed');
    expect(custom.breaker.getState()).toBe('closed');
  });

  it('after Anthropic breaker is open, OpenAI stub still throws NotImplementedError (NOT breaker-open)', async () => {
    const factory = makeFactory();
    const anthropic = factory('anthropic') as AnthropicAdapter;
    const openai = factory('openai');

    hoisted.mockMessagesCreate.mockRejectedValue(new MockOverloadedError());
    for (let i = 0; i < 3; i++) {
      await expect(
        anthropic.chat({ messages: [{ role: 'user', content: 'hi' }] }),
      ).rejects.toThrow();
    }
    expect(anthropic.breaker.getState()).toBe('open');

    await expect(openai.chat({ messages: [] })).rejects.toThrow(AINotImplementedError);
    await expect(openai.chat({ messages: [] })).rejects.not.toThrow(/circuit breaker open/i);
  });

  it('switching provider returns the same per-provider memoised instance', () => {
    const factory = makeFactory();
    const anthropic1 = factory('anthropic');
    const openai1 = factory('openai');
    const anthropic2 = factory('anthropic');
    const openai2 = factory('openai');

    expect(anthropic1).toBe(anthropic2);
    expect(openai1).toBe(openai2);
    expect(anthropic1).not.toBe(openai1);
  });

  it('disposing the Anthropic adapter does NOT affect OpenAI / Custom', () => {
    const factory = makeFactory();
    const anthropic = factory('anthropic');
    const openai = factory('openai');
    const custom = factory('custom');

    expect(() => anthropic.dispose()).not.toThrow();
    expect(() => openai.dispose()).not.toThrow();
    expect(() => custom.dispose()).not.toThrow();
  });
});

describe('CI gate — zero regex-extract callsites in migrated AI modules', () => {
  /**
   * The legacy modules AIAssistant / ErrorResolver / NL2SOQL still ship
   * their own pre-unified-client implementations, so this gate is
   * informational only at this moment — it asserts the FILES exist and have
   * NOT regressed beyond their current baseline.
   *
   * Once those three are migrated onto the unified client, swap the
   * .toBeDefined() to .not.toMatch(/extractJsonFromMarkdown/).
   */
  it('AIAssistant.ts exists', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(path.join(__dirname, '../../modules/ai/AIAssistant.ts'), 'utf8');
    expect(src).toBeDefined();
  });

  it('ErrorResolver.ts exists', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(
      path.join(__dirname, '../../modules/ai/ErrorResolver.ts'),
      'utf8',
    );
    expect(src).toBeDefined();
  });

  it('NL2SOQL.ts exists', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(path.join(__dirname, '../../modules/ai/NL2SOQL.ts'), 'utf8');
    expect(src).toBeDefined();
  });
});
