import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionBudget } from '../adapters/ai/tokenBudget/SessionBudget.js';
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
import { AIHandler } from '../bridge/handlers/AIHandler.js';
import type { HandlerDeps, InboundRequest } from '../bridge/handlers/HandlerTypes.js';
import { getJsforceConnection } from '../core/connection/ConnectionHelper.js';
import { queryWithFieldsFallback } from '../core/common/soqlQueryHelper.js';
import { inboundRequest } from '../test/mockFactories.js';

const mockGetConn = vi.mocked(getJsforceConnection);
const mockQuery = vi.mocked(queryWithFieldsFallback);

/** Minimal in-memory ConfigStore. */
function createConfigStore(): HandlerDeps['configStore'] {
  const data = new Map<string, unknown>();
  return {
    get: vi.fn((key: string) => data.get(key)),
    set: vi.fn((key: string, value: unknown) => {
      data.set(key, value);
    }),
    delete: vi.fn((key: string) => data.delete(key)),
    has: vi.fn((key: string) => data.has(key)),
  } as unknown as HandlerDeps['configStore'];
}

/**
 * Unchecking `sandforge.ai.enabled` re-runs the composition. From that moment
 * nothing may reach the model, the webview must be told, and re-checking it
 * must restore everything without a window reload.
 */
describe('initAIComposition — turning AI off mid-session', () => {
  const posted: Array<BaseMessage & { payload: Record<string, unknown> }> = [];
  const toWebview: Array<BaseMessage & { payload: Record<string, unknown> }> = [];
  /** Every provider call would land here. */
  const chat = vi.fn(() =>
    Promise.resolve({
      text: 'SELECT Id FROM Account',
      usage: { input: 1, output: 2, cacheRead: 0, cacheCreate: 0, total: 3 },
      model: 'test-model',
      stopReason: 'end_turn',
    }),
  );
  /** The last model-backed modules the composition injected, if any. */
  let lastModules: Parameters<AIHandler['setAIModules']>[0];

  const aiClientFactory = Object.assign(
    vi.fn(() => ({ chat, breakerEvents: undefined })),
    { invalidate: vi.fn() },
  );

  let aiHandler: AIHandler;
  let aiEnabled = true;

  function handlerDeps(): HandlerDeps {
    return {
      log: vi.fn(),
      broker: {
        postToWebview: vi.fn((msg: BaseMessage & { payload: Record<string, unknown> }) => {
          posted.push(msg);
        }),
      },
      configStore: createConfigStore(),
      secretVault: { hasSecret: vi.fn(() => Promise.resolve(true)) },
      orgManager: { getOrg: vi.fn(() => undefined) },
      orgRegistry: {},
      nextId: vi.fn(() => 'resp-1'),
    } as unknown as HandlerDeps;
  }

  function makeDeps(): AICompositionDeps {
    return {
      services: {
        isAIEnabled: () => aiEnabled,
        aiClient: aiClientFactory,
        telemetry: { getLogger: () => ({}) },
        // The composition attaches a session budget before wiring the
        // assistant: a real one, so nothing here depends on its internals.
        createSessionBudget: (sessionId: string, broker?: { send: (m: unknown) => void }) =>
          new SessionBudget({ sessionId, budget: 50_000, broker }),
      },
      secretVault: { getSecret: vi.fn(() => Promise.resolve('sk-test')) },
      handlers: {
        setAIAssistant: (assistant: Parameters<AIHandler['setAIAssistant']>[0]) => {
          aiHandler.setAIAssistant(assistant);
        },
        setAIModules: (modules: Parameters<AIHandler['setAIModules']>[0]) => {
          lastModules = modules;
          aiHandler.setAIModules(modules);
        },
        setRuleModules: (modules: Parameters<AIHandler['setRuleModules']>[0]) => {
          aiHandler.setRuleModules(modules);
        },
      },
      broker: {
        postToWebview: vi.fn((msg: BaseMessage & { payload: Record<string, unknown> }) => {
          toWebview.push(msg);
        }),
      },
      log: vi.fn(),
    } as unknown as AICompositionDeps;
  }

  function request(type: string, payload: Record<string, unknown>): InboundRequest {
    return inboundRequest({ id: 'msg-1', type, timestamp: Date.now(), payload });
  }

  function lastOf(type: string): (BaseMessage & { payload: Record<string, unknown> }) | undefined {
    return posted.filter((m) => m.type === type).pop();
  }

  /** Open a conversation through the handler and send one chat message. */
  async function sendChat(): Promise<void> {
    await aiHandler.handle(request('ai:conversation:create', { title: 'T' }));
    const created = lastOf('ai:conversation:created');
    const conversationId =
      (created?.payload.conversation as { id: string } | undefined)?.id ?? 'conv-missing';
    await aiHandler.handle(request('ai:chat', { conversationId, message: 'hello' }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    posted.length = 0;
    toWebview.length = 0;
    aiEnabled = true;
    aiHandler = new AIHandler(handlerDeps());
    mockGetConn.mockResolvedValue({
      describe: vi.fn().mockResolvedValue({
        name: 'Account',
        label: 'Account',
        custom: false,
        fields: [{ name: 'Legacy_Code', label: 'Legacy Code', type: 'string', custom: true }],
      }),
      describeGlobal: vi.fn().mockResolvedValue({ sobjects: [{ name: 'Account', label: 'Acc' }] }),
    } as never);
    mockQuery.mockResolvedValue([{ Id: '001', Name: 'Acme' }]);
  });

  it('stops ai:chat from reaching the model once AI is turned off', async () => {
    await initAIComposition(makeDeps());
    await sendChat();
    expect(chat).toHaveBeenCalledTimes(1);

    aiEnabled = false;
    await initAIComposition(makeDeps());

    chat.mockClear();
    posted.length = 0;
    await sendChat();

    expect(chat).not.toHaveBeenCalled();
    expect(lastOf('ai:error')?.payload.message).toContain('not configured');
  });

  it('stops ai:nl2soql from reaching the model once AI is turned off', async () => {
    await initAIComposition(makeDeps());
    await aiHandler.handle(request('ai:nl2soql', { query: 'all accounts', orgId: 'org-1' }));
    expect(chat).toHaveBeenCalled();

    aiEnabled = false;
    await initAIComposition(makeDeps());

    chat.mockClear();
    posted.length = 0;
    await aiHandler.handle(request('ai:nl2soql', { query: 'all accounts', orgId: 'org-1' }));

    expect(chat).not.toHaveBeenCalled();
    expect(lastOf('ai:nl2soql:response')?.payload.success).toBe(false);
  });

  /**
   * A failed operation is explained where it is raised, from the modules the
   * composition injects — no webview request carries it. Taking the modules
   * away is therefore what stops the model being asked about a failure.
   */
  it('takes the error resolver away once AI is turned off', async () => {
    await initAIComposition(makeDeps());
    expect(lastModules?.errorResolver).toBeDefined();

    aiEnabled = false;
    await initAIComposition(makeDeps());

    expect(lastModules).toBeUndefined();
  });

  it('answers ai:status with enabled:false once AI is turned off', async () => {
    await initAIComposition(makeDeps());
    aiEnabled = false;
    await initAIComposition(makeDeps());

    posted.length = 0;
    await aiHandler.handle(request('ai:status', {}));

    expect(lastOf('ai:status:response')?.payload.enabled).toBe(false);
  });

  it('tells the webview without waiting for a request', async () => {
    await initAIComposition(makeDeps());
    toWebview.length = 0;

    aiEnabled = false;
    await initAIComposition(makeDeps());

    const status = toWebview.filter((m) => m.type === 'ai:status:response').pop();
    expect(status?.payload.enabled).toBe(false);
  });

  it('restores chat when AI is turned back on, with no reload', async () => {
    await initAIComposition(makeDeps());
    aiEnabled = false;
    await initAIComposition(makeDeps());

    aiEnabled = true;
    toWebview.length = 0;
    await initAIComposition(makeDeps());

    chat.mockClear();
    await sendChat();

    expect(chat).toHaveBeenCalledTimes(1);
    expect(toWebview.filter((m) => m.type === 'ai:status:response').pop()?.payload.enabled).toBe(
      true,
    );
  });

  it('keeps the rule-based analysis answering in both states', async () => {
    await initAIComposition(makeDeps());
    aiEnabled = false;
    await initAIComposition(makeDeps());

    chat.mockClear();
    await aiHandler.handle(request('ai:schema-advice', { orgId: 'org-1' }));
    await aiHandler.handle(request('ai:anomaly-scan', { orgId: 'org-1', objectName: 'Account' }));

    expect(lastOf('ai:schema-advice:response')?.payload.success).toBe(true);
    expect(lastOf('ai:anomaly-scan:response')?.payload.success).toBe(true);
    expect(chat).not.toHaveBeenCalled();
  });
});
