import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => ({
  workspace: {
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
    getConfiguration: vi.fn(() => ({ get: vi.fn((_k: string, d: unknown) => d) })),
  },
}));

// The composition dynamically imports the whole AI stack — stub every module.
vi.mock('../modules/ai/AIAssistant.js', () => ({ AIAssistant: vi.fn() }));
vi.mock('../modules/ai/NL2SOQL.js', () => ({ NL2SOQL: vi.fn() }));
vi.mock('../modules/ai/ErrorResolver.js', () => ({ ErrorResolver: vi.fn() }));
vi.mock('../modules/ai/SmartSuggestions.js', () => ({ SmartSuggestions: vi.fn() }));
vi.mock('../modules/ai/PipelineGenerator.js', () => ({ PipelineGenerator: vi.fn() }));
vi.mock('../modules/ai/AnomalyDetector.js', () => ({ AnomalyDetector: vi.fn() }));
vi.mock('../modules/ai/AIPersonaManager.js', () => ({ AIPersonaManager: vi.fn() }));
vi.mock('../modules/ai/SchemaAdvisor.js', () => ({ SchemaAdvisor: vi.fn() }));
vi.mock('../bridge/handlers/ai/AIDiagnoseHandler.js', () => ({ AIDiagnoseHandler: vi.fn() }));

import { initAIComposition } from './aiComposition';
import type { AICompositionDeps } from './aiComposition';
import type { BreakerStateChangeEvent } from '../adapters/ai/AIClient';

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

  function makeDeps(overrides?: { aiEnabled?: boolean; hasKey?: boolean }): AICompositionDeps {
    const aiEnabled = overrides?.aiEnabled ?? true;
    const hasKey = overrides?.hasKey ?? true;
    return {
      services: {
        isAIEnabled: () => aiEnabled,
        aiClient: () => fakeClient,
        telemetry: { getLogger: () => ({}) },
      },
      secretVault: {
        getSecret: vi.fn(() => Promise.resolve(hasKey ? 'sk-test' : undefined)),
      },
      handlers: {
        setAIAssistant: vi.fn(),
        setAIModules: vi.fn(),
        setAIDiagnoseHandler: vi.fn(),
      },
      broker: {
        postToWebview: vi.fn((msg: Record<string, unknown>) => {
          posted.push(msg);
        }),
      },
      orgRegistry: {},
      orgManager: {},
      log: vi.fn(),
    } as unknown as AICompositionDeps;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    posted.length = 0;
    stateChangeListener = undefined;
  });

  it('forwards breaker state-change events as ai:provider:status', async () => {
    await initAIComposition(makeDeps());

    expect(stateChangeListener).toBeDefined();
    stateChangeListener!({
      state: 'open',
      cooldownEndsAt: '2026-08-11T12:00:00Z',
      lastErrorVerdict: { kind: 'overloaded', userMessageKey: 'ai.error.overloaded' },
    } as BreakerStateChangeEvent);

    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe('ai:provider:status');
    const payload = posted[0].payload as Record<string, unknown>;
    expect(payload.provider).toBe('anthropic');
    expect(payload.state).toBe('open');
    expect(payload.cooldownEndsAt).toBe('2026-08-11T12:00:00Z');
    expect(payload.lastErrorKind).toBe('overloaded');
    expect(payload.userMessageKey).toBe('ai.error.overloaded');
  });

  it('subscribes nothing when AI is disabled', async () => {
    await initAIComposition(makeDeps({ aiEnabled: false }));
    expect(stateChangeListener).toBeUndefined();
    expect(posted).toHaveLength(0);
  });

  it('subscribes nothing when no API key is stored', async () => {
    await initAIComposition(makeDeps({ hasKey: false }));
    expect(stateChangeListener).toBeUndefined();
  });
});
