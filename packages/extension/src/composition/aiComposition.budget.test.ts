import { describe, it, expect, vi, beforeEach } from 'vitest';

const host = vi.hoisted(() => ({
  showWarningMessage: vi.fn((..._args: unknown[]) =>
    Promise.resolve<string | undefined>(undefined),
  ),
  executeCommand: vi.fn((..._args: unknown[]) => Promise.resolve()),
  configListener: undefined as
    | ((event: { affectsConfiguration: (section: string) => boolean }) => void)
    | undefined,
  sdkCreate: vi.fn(),
}));

vi.mock('vscode', () => ({
  // The display language the error resolver asks the model to answer in.
  env: { language: 'en' },
  workspace: {
    onDidChangeConfiguration: vi.fn((listener: typeof host.configListener) => {
      host.configListener = listener;
      return { dispose: vi.fn() };
    }),
    getConfiguration: vi.fn(() => ({ get: vi.fn((_k: string, d: unknown) => d) })),
  },
  window: { showWarningMessage: host.showWarningMessage },
  commands: { executeCommand: host.executeCommand },
  l10n: {
    t: (message: string, ...args: Array<string | number | boolean>) =>
      message.replace(/\{(\d+)\}/g, (_m, index: string) => String(args[Number(index)])),
  },
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    messages = { create: host.sdkCreate };
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

import type { AIUsage } from '@sandforge/shared';
import { NL2SOQL } from '../modules/ai/NL2SOQL.js';
import { initAIComposition, registerAIConfigListener, wireBudgetReporting } from './aiComposition';
import type { AICompositionDeps } from './aiComposition';
import type { Services } from '../services.js';
import type { MessageBroker } from '../bridge/MessageBroker';
import type { StorageAdapter } from '../adapters/storage/StorageAdapter.js';
import { createAIClientFactory } from '../adapters/ai/AIClientFactory.js';
import { SessionBudget } from '../adapters/ai/tokenBudget/index.js';

/** Build an AIUsage whose four fields sum to `total` (all of it on input). */
function usage(total: number): AIUsage {
  return { input: total, output: 0, cacheRead: 0, cacheCreate: 0, total };
}

/** Let the fire-and-forget re-init the config listener starts run to its end. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('the AI token budget, as the user meets it', () => {
  const posted: Array<{ type: string; payload?: unknown }> = [];
  let budget: SessionBudget;
  let configuredBudget: number;
  let services: Services;
  let broker: MessageBroker;

  function makeDeps(): AICompositionDeps {
    return {
      services,
      secretVault: { getSecret: vi.fn(() => Promise.resolve('sk-test')) },
      handlers: { setAIAssistant: vi.fn(), setAIModules: vi.fn(), setRuleModules: vi.fn() },
      broker,
      log: vi.fn(),
    } as unknown as AICompositionDeps;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    posted.length = 0;
    host.configListener = undefined;
    configuredBudget = 10_000;
    budget = new SessionBudget({ sessionId: 'ai-window', budget: 10_000 });
    const storage = {
      getSecret: vi.fn(() => Promise.resolve('sk-test')),
    } as unknown as StorageAdapter;
    services = {
      isAIEnabled: () => true,
      getSandforgeSetting: <T>(_key: string, fallback: T): T => fallback,
      aiClient: createAIClientFactory({ storage, getProvider: () => 'anthropic', budget }),
      sessionBudget: budget,
      readTokenBudget: () => configuredBudget,
    } as unknown as Services;
    broker = {
      postToWebview: vi.fn((msg: { type: string; payload?: unknown }) => {
        posted.push(msg);
      }),
    } as unknown as MessageBroker;
  });

  it('warns once when the counter reaches 80%, wherever the user is', () => {
    wireBudgetReporting(services, broker);

    budget.increment(usage(8_000));
    budget.increment(usage(500));
    budget.increment(usage(500));

    expect(host.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(String(host.showWarningMessage.mock.calls[0][0])).toContain('8000/10000');
  });

  it('says once that AI requests are refused, however many are refused', () => {
    wireBudgetReporting(services, broker);

    budget.increment(usage(8_000));
    budget.increment(usage(2_000));
    budget.preflight(1);
    budget.preflight(1);

    expect(host.showWarningMessage).toHaveBeenCalledTimes(2);
    expect(String(host.showWarningMessage.mock.calls[1][0])).toContain('10000/10000');
  });

  it('opens the budget setting when the user picks the notice action', async () => {
    host.showWarningMessage.mockImplementationOnce((...args: unknown[]) =>
      Promise.resolve(args[1] as string),
    );
    wireBudgetReporting(services, broker);

    budget.increment(usage(8_000));
    await settle();

    expect(host.executeCommand).toHaveBeenCalledWith(
      'workbench.action.openSettings',
      'sandforge.ai.tokenBudgetMaxPerSession',
    );
  });

  it('keeps the gauge on the AI page live on every call', () => {
    wireBudgetReporting(services, broker);

    budget.increment(usage(1_000));
    budget.increment(usage(9_000));

    expect(posted.map((m) => m.type)).toEqual(['ai:budget:state', 'ai:budget:state']);
  });

  it('refuses an AI call made through the wired stack once the budget is spent', async () => {
    await initAIComposition(makeDeps());
    const aiProvider = vi.mocked(NL2SOQL).mock.calls[0][0];

    budget.increment(usage(10_000));

    await expect(aiProvider('all accounts')).rejects.toMatchObject({
      code: 'AI_BUDGET_EXCEEDED',
    });
    expect(host.sdkCreate).not.toHaveBeenCalled();
  });

  // Every sandforge.ai.* change rebuilds the stack. It used to start the
  // counter over, so toggling any AI setting was a way past the limit.
  it('keeps the count when an AI setting change rebuilds the stack', async () => {
    const deps = makeDeps();
    await initAIComposition(deps);
    registerAIConfigListener({ services, run: () => initAIComposition(deps), log: vi.fn() });
    const before = services.aiClient();
    budget.increment(usage(3_000));

    host.configListener?.({ affectsConfiguration: (s) => s === 'sandforge.ai' });
    await settle();

    expect(services.aiClient()).not.toBe(before);
    expect(services.aiClient().budget?.getState().used.total).toBe(3_000);
  });

  it('applies a new limit only when the budget setting itself changes', async () => {
    const deps = makeDeps();
    registerAIConfigListener({ services, run: () => initAIComposition(deps), log: vi.fn() });
    configuredBudget = 20_000;

    host.configListener?.({
      affectsConfiguration: (s) => s === 'sandforge.ai' || s === 'sandforge.ai.model',
    });
    await settle();
    expect(budget.getState().budget).toBe(10_000);

    host.configListener?.({
      affectsConfiguration: (s) =>
        s === 'sandforge.ai' || s === 'sandforge.ai.tokenBudgetMaxPerSession',
    });
    await settle();
    expect(budget.getState().budget).toBe(20_000);
  });
});
