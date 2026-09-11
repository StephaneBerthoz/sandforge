import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BaseMessage } from '@sandforge/shared';

vi.mock('vscode', () => ({
  workspace: {
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
    getConfiguration: vi.fn(() => ({ get: vi.fn((_k: string, d: unknown) => d) })),
  },
}));

vi.mock('../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

vi.mock('../core/common/soqlQueryHelper.js', () => ({
  queryWithFieldsFallback: vi.fn(),
}));

import { initAIComposition } from './aiComposition';
import type { AICompositionDeps } from './aiComposition';
import { AIAnalysisHandler } from '../bridge/handlers/ai/AIAnalysisHandler.js';
import type { HandlerDeps, InboundRequest } from '../bridge/handlers/HandlerTypes.js';
import { getJsforceConnection } from '../core/connection/ConnectionHelper.js';
import { queryWithFieldsFallback } from '../core/common/soqlQueryHelper.js';
import { inboundRequest } from '../test/mockFactories.js';

const mockGetConn = vi.mocked(getJsforceConnection);
const mockQuery = vi.mocked(queryWithFieldsFallback);

/**
 * Schema advice and the anomaly scan are pure rule engines: no provider, no
 * key, no network. They must answer with AI off and with no key stored, and
 * they must never reach a model.
 */
describe('initAIComposition — rule-based analysis is not gated on AI', () => {
  const posted: Array<BaseMessage & { payload: Record<string, unknown> }> = [];
  let analysisHandler: AIAnalysisHandler;
  /** Every provider call would land here. */
  const chat = vi.fn();
  const aiClientFactory = Object.assign(
    vi.fn(() => ({ chat, breakerEvents: undefined })),
    { invalidate: vi.fn() },
  );

  function handlerDeps(): HandlerDeps {
    return {
      log: vi.fn(),
      broker: {
        postToWebview: vi.fn((msg: BaseMessage & { payload: Record<string, unknown> }) => {
          posted.push(msg);
        }),
      },
      orgManager: {},
      orgRegistry: {},
      nextId: vi.fn(() => 'resp-1'),
    } as unknown as HandlerDeps;
  }

  function makeDeps(overrides?: { aiEnabled?: boolean; hasKey?: boolean }): AICompositionDeps {
    const aiEnabled = overrides?.aiEnabled ?? false;
    const hasKey = overrides?.hasKey ?? false;
    return {
      services: {
        isAIEnabled: () => aiEnabled,
        aiClient: aiClientFactory,
        telemetry: { getLogger: () => ({}) },
      },
      secretVault: { getSecret: vi.fn(() => Promise.resolve(hasKey ? 'sk-test' : undefined)) },
      handlers: {
        setAIAssistant: vi.fn(),
        setAIModules: vi.fn(),
        setRuleModules: vi.fn((modules: Parameters<AIAnalysisHandler['setRuleModules']>[0]) => {
          analysisHandler.setRuleModules(modules);
        }),
      },
      broker: { postToWebview: vi.fn() },
      log: vi.fn(),
    } as unknown as AICompositionDeps;
  }

  function request(type: string, payload: Record<string, unknown>): InboundRequest {
    return inboundRequest({ id: 'msg-1', type, timestamp: Date.now(), payload });
  }

  function lastOf(type: string): (BaseMessage & { payload: Record<string, unknown> }) | undefined {
    return posted.filter((m) => m.type === type).pop();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    posted.length = 0;
    analysisHandler = new AIAnalysisHandler(handlerDeps());
    mockGetConn.mockResolvedValue({
      describe: vi.fn().mockResolvedValue({
        name: 'Account',
        label: 'Account',
        custom: false,
        fields: [{ name: 'Legacy_Code', label: 'Legacy Code', type: 'string', custom: true }],
      }),
    } as never);
    mockQuery.mockResolvedValue([
      { Id: '001', Name: 'Acme', Email: 'a@b.c' },
      { Id: '002', Name: 'Acme', Email: 'a@b.c' },
    ]);
  });

  it('answers ai:schema-advice when AI is disabled, without calling a provider', async () => {
    await initAIComposition(makeDeps({ aiEnabled: false }));

    await analysisHandler.handle(request('ai:schema-advice', { orgId: 'org-1' }));

    const response = lastOf('ai:schema-advice:response');
    expect(response?.payload.success).toBe(true);
    expect(chat).not.toHaveBeenCalled();
    expect(aiClientFactory).not.toHaveBeenCalled();
  });

  it('answers ai:anomaly-scan when AI is disabled, without calling a provider', async () => {
    await initAIComposition(makeDeps({ aiEnabled: false }));

    await analysisHandler.handle(
      request('ai:anomaly-scan', { orgId: 'org-1', objectName: 'Account' }),
    );

    const response = lastOf('ai:anomaly-scan:response');
    expect(response?.payload.success).toBe(true);
    expect(chat).not.toHaveBeenCalled();
    expect(aiClientFactory).not.toHaveBeenCalled();
  });

  it('answers both when AI is enabled but no API key is stored', async () => {
    await initAIComposition(makeDeps({ aiEnabled: true, hasKey: false }));

    await analysisHandler.handle(request('ai:schema-advice', { orgId: 'org-1' }));
    await analysisHandler.handle(
      request('ai:anomaly-scan', { orgId: 'org-1', objectName: 'Account' }),
    );

    expect(lastOf('ai:schema-advice:response')?.payload.success).toBe(true);
    expect(lastOf('ai:anomaly-scan:response')?.payload.success).toBe(true);
    expect(chat).not.toHaveBeenCalled();
  });

  it('reports real findings rather than an empty shell', async () => {
    await initAIComposition(makeDeps({ aiEnabled: false }));

    await analysisHandler.handle(request('ai:schema-advice', { orgId: 'org-1' }));

    const advice = lastOf('ai:schema-advice:response')?.payload.advice as {
      issues: Array<{ message: string }>;
    };
    // `Legacy_Code` is custom and lacks the `__c` suffix.
    expect(advice.issues.length).toBeGreaterThan(0);
    expect(advice.issues[0].message).toContain('__c');
  });
});
