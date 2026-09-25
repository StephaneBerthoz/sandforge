import { describe, it, expect, vi, beforeEach } from 'vitest';

const sdk = vi.hoisted(() => ({ create: vi.fn(), constructed: vi.fn() }));

vi.mock('vscode', () => ({
  // The display language the error resolver asks the model to answer in.
  env: { language: 'en' },
  workspace: {
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
    getConfiguration: vi.fn(() => ({ get: vi.fn((_k: string, d: unknown) => d) })),
  },
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    messages = { create: sdk.create };
    constructor(args: { apiKey: string }) {
      sdk.constructed(args);
    }
  },
  APIUserAbortError: class APIUserAbortError extends Error {},
}));

// The composition dynamically imports the whole AI stack — stub every module.
vi.mock('../modules/ai/AIAssistant.js', () => ({ AIAssistant: vi.fn() }));
vi.mock('../modules/ai/NL2SOQL.js', () => ({ NL2SOQL: vi.fn() }));
vi.mock('../modules/ai/ErrorResolver.js', () => ({ ErrorResolver: vi.fn() }));
vi.mock('../modules/ai/PipelineGenerator.js', () => ({ PipelineGenerator: vi.fn() }));
vi.mock('../modules/ai/AnomalyDetector.js', () => ({ AnomalyDetector: vi.fn() }));
vi.mock('../modules/ai/SchemaAdvisor.js', () => ({ SchemaAdvisor: vi.fn() }));

import { AnomalyDetector } from '../modules/ai/AnomalyDetector.js';
import { initAIComposition, createAIReinit } from './aiComposition';
import type { AICompositionDeps } from './aiComposition';
import type { BreakerStateChangeEvent } from '../adapters/ai/AIClient';
import type { Services } from '../services.js';
import type { StorageAdapter } from '../adapters/storage/StorageAdapter.js';
import { createAIClientFactory } from '../adapters/ai/AIClientFactory.js';
import { AIChatHandler } from '../bridge/handlers/ai/AIChatHandler.js';
import type { HandlerDeps } from '../bridge/handlers/HandlerTypes.js';
import { inboundRequest } from '../test/mockFactories.js';

describe('initAIComposition — ai:provider:status forwarding', () => {
  const posted: Array<Record<string, unknown>> = [];
  let stateChangeListener: ((event: BreakerStateChangeEvent) => void) | undefined;

  const fakeClient = {
    chat: vi.fn(),
    breakerEvents: {
      on: vi.fn((event: string, listener: (e: BreakerStateChangeEvent) => void) => {
        if (event === 'state-change') stateChangeListener = listener;
      }),
    },
  };

  function makeDeps(overrides?: {
    aiEnabled?: boolean;
    hasKey?: boolean;
    provider?: string;
    model?: string;
  }): AICompositionDeps {
    const aiEnabled = overrides?.aiEnabled ?? true;
    const hasKey = overrides?.hasKey ?? true;
    const configured: Record<string, unknown> = {
      ...(overrides?.provider !== undefined ? { 'ai.provider': overrides.provider } : {}),
      ...(overrides?.model !== undefined ? { 'ai.model': overrides.model } : {}),
    };
    return {
      services: {
        isAIEnabled: () => aiEnabled,
        getSandforgeSetting: <T>(key: string, fallback: T): T =>
          key in configured ? (configured[key] as T) : fallback,
        aiClient: () => fakeClient,
        telemetry: { getLogger: () => ({}) },
      },
      secretVault: {
        getSecret: vi.fn(() => Promise.resolve(hasKey ? 'sk-test' : undefined)),
      },
      handlers: {
        setAIAssistant: vi.fn(),
        setAIModules: vi.fn(),
        setRuleModules: vi.fn(),
      },
      broker: {
        postToWebview: vi.fn((msg: Record<string, unknown>) => {
          posted.push(msg);
        }),
      },
      log: vi.fn(),
    } as unknown as AICompositionDeps;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    posted.length = 0;
    stateChangeListener = undefined;
  });

  /** Types of every message posted to the webview, in order. */
  const postedTypes = (): unknown[] => posted.map((m) => m.type);

  it('forwards breaker state-change events as ai:provider:status', async () => {
    await initAIComposition(makeDeps());

    // Every message counts, not only the one under test: a stray post from
    // init would reach every open panel.
    expect(postedTypes()).toEqual(['ai:status:response']);
    expect(posted[0].payload).toMatchObject({ enabled: true, provider: 'anthropic' });
    expect(stateChangeListener).toBeDefined();
    stateChangeListener!({
      state: 'open',
      cooldownEndsAt: '2026-08-11T12:00:00Z',
      lastErrorVerdict: { kind: 'overloaded', userMessageKey: 'ai.error.overloaded' },
    } as BreakerStateChangeEvent);

    expect(postedTypes()).toEqual(['ai:status:response', 'ai:provider:status']);
    const payload = posted[1].payload as Record<string, unknown>;
    expect(payload.provider).toBe('anthropic');
    expect(payload.state).toBe('open');
    expect(payload.cooldownEndsAt).toBe('2026-08-11T12:00:00Z');
    expect(payload.lastErrorKind).toBe('overloaded');
    expect(payload.userMessageKey).toBe('ai.error.overloaded');
  });

  // The Settings page shows this model next to the status. It named the
  // default whatever sandforge.ai.model said.
  it('announces the model sandforge.ai.model names, and the default when it names none', async () => {
    await initAIComposition(makeDeps({ model: 'claude-opus-4-8' }));
    await initAIComposition(makeDeps());

    expect(posted.map((m) => (m.payload as { model: string }).model)).toEqual([
      'claude-opus-4-8',
      'claude-sonnet-5',
    ]);
  });

  it('subscribes nothing when AI is disabled', async () => {
    await initAIComposition(makeDeps({ aiEnabled: false }));
    expect(stateChangeListener).toBeUndefined();
    expect(postedTypes()).toEqual(['ai:status:response']);
    expect(posted[0].payload).toMatchObject({ enabled: false, provider: 'none' });
  });

  it('subscribes nothing when no API key is stored', async () => {
    await initAIComposition(makeDeps({ hasKey: false }));
    expect(stateChangeListener).toBeUndefined();
    expect(postedTypes()).toEqual(['ai:status:response']);
    expect(posted[0].payload).toMatchObject({ enabled: false, provider: 'none' });
  });

  // The openai and custom adapters throw on every call. A settings.json that
  // still names one used to get AI reported as available, then fail each use.
  it.each(['openai', 'custom'])(
    'keeps AI off and says so when the provider setting names %s',
    async (provider) => {
      const deps = makeDeps({ provider });

      await initAIComposition(deps);

      expect(deps.handlers.setAIAssistant).toHaveBeenCalledWith(undefined);
      expect(deps.handlers.setAIModules).toHaveBeenCalledWith(undefined);
      expect(deps.handlers.setAIModules).not.toHaveBeenCalledWith(expect.anything());
      expect(postedTypes()).toEqual(['ai:status:response']);
      expect(posted[0].payload).toMatchObject({ enabled: false, provider: 'none' });
      expect(stateChangeListener).toBeUndefined();
    },
  );

  it('still wires the AI stack when a rule-based module fails to load', async () => {
    vi.mocked(AnomalyDetector).mockImplementationOnce(() => {
      throw new Error('rule module failed');
    });
    const deps = makeDeps();

    await initAIComposition(deps);

    expect(deps.handlers.setAIModules).toHaveBeenCalledWith(
      expect.objectContaining({ nl2soql: expect.anything() }),
    );
    expect(postedTypes()).toEqual(['ai:status:response']);
    expect(posted[0].payload).toMatchObject({ enabled: true });
  });
});

describe('saving a different API key while AI is already on', () => {
  it('builds the next SDK client with the new key, without a reload', async () => {
    const secrets = new Map<string, string>([['ai.anthropic.key', 'sk-old']]);
    // AnthropicAdapter reads through StorageAdapter, which keeps the
    // `sandforge.` prefix SecretVault adds on write.
    const storage = {
      getSecret: vi.fn((key: string) =>
        Promise.resolve(secrets.get(key.replace(/^sandforge\./, ''))),
      ),
    } as unknown as StorageAdapter;
    const services = {
      isAIEnabled: () => true,
      getSandforgeSetting: <T>(_key: string, fallback: T): T => fallback,
      aiClient: createAIClientFactory({ storage, getProvider: () => 'anthropic' }),
    } as unknown as Services;
    const deps = {
      services,
      secretVault: { getSecret: (key: string) => Promise.resolve(secrets.get(key)) },
      handlers: { setAIAssistant: vi.fn(), setAIModules: vi.fn(), setRuleModules: vi.fn() },
      broker: { postToWebview: vi.fn() },
      log: vi.fn(),
    } as unknown as AICompositionDeps;
    services.reinitAI = createAIReinit({
      services,
      run: () => initAIComposition(deps),
      log: vi.fn(),
    });
    sdk.create.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'm',
      stop_reason: 'end_turn',
    });
    await initAIComposition(deps);
    await services.aiClient().chat({ messages: [{ role: 'user', content: 'hi' }] });

    // No settings backend: sandforge.ai.enabled is already true, so writing it
    // again raises no configuration event to rebuild anything.
    const handler = new AIChatHandler({
      log: vi.fn(),
      broker: { postToWebview: vi.fn() },
      secretVault: {
        storeSecret: vi.fn((key: string, value: string) => {
          secrets.set(key, value);
          return Promise.resolve();
        }),
        hasSecret: vi.fn(() => Promise.resolve(true)),
      },
      services,
      nextId: () => 'resp-1',
    } as unknown as HandlerDeps);
    await handler.handle(
      inboundRequest({
        id: 'save-1',
        type: 'ai:save-key',
        timestamp: Date.now(),
        payload: { apiKey: 'sk-new' },
      }),
    );
    await services.aiClient().chat({ messages: [{ role: 'user', content: 'hi' }] });

    expect(sdk.constructed.mock.calls.map(([args]) => (args as { apiKey: string }).apiKey)).toEqual(
      ['sk-old', 'sk-new'],
    );
  });
});
