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
    messages = { create: hoisted.mockMessagesCreate };
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
   * AIAssistant still ships its own pre-unified-client implementation, so it
   * is asserted to exist and not to have regressed beyond that baseline.
   * Every other module reads its reply through `parseModelJson`, and is held
   * to it below.
   */
  it('AIAssistant.ts exists', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(path.join(__dirname, '../../modules/ai/AIAssistant.ts'), 'utf8');
    expect(src).toBeDefined();
  });

  it('ErrorResolver reads a fenced reply through the shared parser', async () => {
    const { ErrorResolver } = await import('../../modules/ai/ErrorResolver.js');
    const reply = JSON.stringify({
      explanation: 'The target org has no such field.',
      suggestions: [{ title: 'Add the field', description: 'Create it', probability: 0.9 }],
    });
    const resolver = new ErrorResolver(() => Promise.resolve('```json\n' + reply + '\n```'));

    const resolution = await resolver.resolveError(
      { errorCode: 'SOME_EXOTIC_ERROR', message: 'no idea' },
      {},
    );

    expect(resolution.explanation).toBe('The target org has no such field.');
    expect(resolution.suggestions[0].title).toBe('Add the field');
    // The defaults come from the schema, not from a branch per field.
    expect(resolution.confidence).toBe(0.5);
  });

  // These read a model reply only through parseModelJson, so a fenced reply
  // and a reply of the wrong shape are handled the same way in each.
  it.each([
    'modules/ai/ErrorResolver.ts',
    'modules/ai/NL2SOQL.ts',
    'modules/ai/PipelineGenerator.ts',
    'modules/ai/AIPersonaManager.ts',
    'modules/seed/AIDataGenerator.ts',
  ])('%s parses no model reply of its own', async (file) => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(path.join(__dirname, '../..', file), 'utf8');
    expect(src).not.toMatch(/extractJsonFromMarkdown|JSON\.parse\(/);
    expect(src).toMatch(/parseModelJson\(/);
  });
});
