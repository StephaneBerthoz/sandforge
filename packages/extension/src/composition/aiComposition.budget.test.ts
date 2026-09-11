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
vi.mock('../modules/ai/PipelineGenerator.js', () => ({ PipelineGenerator: vi.fn() }));
vi.mock('../modules/ai/AnomalyDetector.js', () => ({ AnomalyDetector: vi.fn() }));
vi.mock('../modules/ai/SchemaAdvisor.js', () => ({ SchemaAdvisor: vi.fn() }));

import type { AIUsage } from '@sandforge/shared';
import { initAIComposition } from './aiComposition';
import type { AICompositionDeps } from './aiComposition';
import { SessionBudget, type BudgetBroker } from '../adapters/ai/tokenBudget/index.js';

/** Build an AIUsage whose four fields sum to `total` (all of it on input). */
function usage(total: number): AIUsage {
  return { input: total, output: 0, cacheRead: 0, cacheCreate: 0, total };
}

describe('initAIComposition — session token budget wiring', () => {
  const posted: Array<{ type: string; payload?: unknown }> = [];
  const fakeClient: { chat: unknown; breakerEvents: unknown; budget?: SessionBudget } = {
    chat: vi.fn(),
    breakerEvents: { on: vi.fn() },
  };
  const createSessionBudget = vi.fn(
    (sessionId: string, broker?: BudgetBroker) =>
      new SessionBudget({ sessionId, budget: 10_000, broker }),
  );

  function makeDeps(): AICompositionDeps {
    return {
      services: {
        isAIEnabled: () => true,
        aiClient: () => fakeClient,
        telemetry: { getLogger: () => ({}) },
        createSessionBudget,
      },
      secretVault: { getSecret: vi.fn(() => Promise.resolve('sk-test')) },
      handlers: { setAIAssistant: vi.fn(), setAIModules: vi.fn() },
      broker: {
        postToWebview: vi.fn((msg: { type: string; payload?: unknown }) => {
          posted.push(msg);
        }),
      },
      log: vi.fn(),
    } as unknown as AICompositionDeps;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    posted.length = 0;
    fakeClient.budget = undefined;
  });

  it('attaches a SessionBudget built from the tokenBudgetMaxPerSession setting', async () => {
    await initAIComposition(makeDeps());

    expect(createSessionBudget).toHaveBeenCalledTimes(1);
    expect(fakeClient.budget).toBeInstanceOf(SessionBudget);
    expect(fakeClient.budget?.getState().budget).toBe(10_000);
  });

  it('soft-warns at 80%: the budget state reaches the webview as ai:budget:state/warn', async () => {
    await initAIComposition(makeDeps());

    fakeClient.budget?.increment(usage(8_000));

    const states = posted.filter((m) => m.type === 'ai:budget:state');
    expect(states).toHaveLength(1);
    expect((states[0].payload as { state: string; percent: number }).state).toBe('warn');
    expect((states[0].payload as { percent: number }).percent).toBe(80);
    expect(posted.filter((m) => m.type === 'ai:budget:warn')).toHaveLength(1);
  });

  it('hard-refuses at 100%: preflight rejects and ai:budget:exceeded reaches the webview', async () => {
    await initAIComposition(makeDeps());

    fakeClient.budget?.increment(usage(10_000));
    const verdict = fakeClient.budget?.preflight(1);

    expect(verdict?.allowed).toBe(false);
    const exceeded = posted.filter((m) => m.type === 'ai:budget:exceeded');
    expect(exceeded.length).toBeGreaterThanOrEqual(1);
    expect((exceeded.at(-1)?.payload as { settingsKey: string }).settingsKey).toBe(
      'sandforge.ai.tokenBudgetMaxPerSession',
    );
  });

  it('skips budget creation when AI is disabled', async () => {
    const deps = makeDeps();
    (deps.services as unknown as { isAIEnabled: () => boolean }).isAIEnabled = () => false;

    await initAIComposition(deps);

    expect(createSessionBudget).not.toHaveBeenCalled();
    expect(fakeClient.budget).toBeUndefined();
  });
});
