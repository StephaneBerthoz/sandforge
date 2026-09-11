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

import { NL2SOQL } from '../modules/ai/NL2SOQL.js';
import { initAIComposition } from './aiComposition';
import type { AICompositionDeps } from './aiComposition';
import type { AIProvider } from '../modules/ai/types.js';
import { SessionBudget, type BudgetBroker } from '../adapters/ai/tokenBudget/index.js';

/**
 * The Tier 2 modules pass their spotlight system prompt as the second
 * argument of AIProvider. That prompt is one of the two prompt-injection
 * defences, so it is only real if the composition forwards it to the client —
 * the previous single-argument closure dropped it silently.
 */
describe('initAIComposition — aiProvider forwards the system prompt', () => {
  type ChatOpts = { messages: Array<{ role: string; content: string }>; system?: string };
  const chat = vi.fn((_opts: ChatOpts) => Promise.resolve({ text: '{}' }));
  const fakeClient = { chat, breakerEvents: undefined };

  function makeDeps(): AICompositionDeps {
    return {
      services: {
        isAIEnabled: () => true,
        aiClient: () => fakeClient,
        telemetry: { getLogger: () => ({}) },
        createSessionBudget: (sessionId: string, budgetBroker?: BudgetBroker) =>
          new SessionBudget({ sessionId, budget: 50_000, broker: budgetBroker }),
      },
      secretVault: { getSecret: vi.fn(() => Promise.resolve('sk-test')) },
      handlers: {
        setAIAssistant: vi.fn(),
        setAIModules: vi.fn(),
        setRuleModules: vi.fn(),
      },
      broker: { postToWebview: vi.fn() },
      log: vi.fn(),
    } as unknown as AICompositionDeps;
  }

  /** Recover the closure the composition handed to the Tier 2 constructors. */
  async function captureProvider(): Promise<AIProvider> {
    await initAIComposition(makeDeps());
    const ctor = vi.mocked(NL2SOQL);
    expect(ctor).toHaveBeenCalledTimes(1);
    return ctor.mock.calls[0][0];
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes `system` through to aiClient.chat', async () => {
    const aiProvider = await captureProvider();

    await aiProvider('prompt body', 'SPOTLIGHT SYSTEM PROMPT');

    expect(chat).toHaveBeenCalledTimes(1);
    const opts = chat.mock.calls[0][0];
    expect(opts.system).toBe('SPOTLIGHT SYSTEM PROMPT');
    expect(opts.messages).toEqual([{ role: 'user', content: 'prompt body' }]);
  });

  it('leaves `system` undefined for callers that do not supply one', async () => {
    const aiProvider = await captureProvider();

    await aiProvider('prompt body');

    const opts = chat.mock.calls[0][0];
    expect(opts.system).toBeUndefined();
  });
});
