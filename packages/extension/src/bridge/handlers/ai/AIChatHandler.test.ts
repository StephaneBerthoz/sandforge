import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIChatHandler } from './AIChatHandler.js';
import type { HandlerDeps, InboundRequest } from '../HandlerTypes.js';
import type { BaseMessage } from '@sandforge/shared';
import { inboundRequest } from '../../../test/mockFactories.js';

vi.mock('../../../core/common/extractErrorMessage.js', () => ({
  extractErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

/** In-memory store for ConfigStore mock. */
type StoreData = Record<string, { value: string; category: string }>;

function createMockConfigStore(): HandlerDeps['configStore'] & {
  _data: StoreData;
} {
  const data: StoreData = {};
  return {
    _data: data,
    get: vi.fn(<T>(key: string): T | undefined => {
      const entry = data[key];
      if (!entry) return undefined;
      return JSON.parse(entry.value) as T;
    }),
    set: vi.fn(<T>(key: string, value: T, category: string = 'general') => {
      data[key] = { value: JSON.stringify(value), category };
    }),
    delete: vi.fn((key: string): boolean => {
      if (!(key in data)) return false;
      delete data[key];
      return true;
    }),
    has: vi.fn((key: string) => key in data),
    getByCategory: vi.fn(),
    getAllKeys: vi.fn(() => Object.keys(data)),
    getKeysByPrefix: vi.fn((prefix: string) =>
      Object.keys(data).filter((k) => k.startsWith(prefix)),
    ),
    clearCategory: vi.fn(),
    clearAll: vi.fn(),
    initialize: vi.fn(),
  } as unknown as HandlerDeps['configStore'] & { _data: StoreData };
}

function createMockDeps(): HandlerDeps {
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as unknown as HandlerDeps['stateSync'],
    orgManager: {} as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore: createMockConfigStore(),
    secretVault: {
      hasSecret: vi.fn().mockResolvedValue(false),
      storeSecret: vi.fn().mockResolvedValue(undefined),
    } as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
    nextId: vi.fn().mockReturnValue('test-id'),
  };
}

function createMsg(
  type: string,
  payload: Record<string, unknown> = {},
): InboundRequest & { payload: Record<string, unknown> } {
  return inboundRequest({ id: 'msg-1', type, timestamp: Date.now(), payload });
}

function createMockAssistant(
  overrides: Record<string, unknown> = {},
): Parameters<AIChatHandler['setAIAssistant']>[0] {
  return {
    chat: vi.fn().mockResolvedValue({
      id: 'resp-1',
      role: 'assistant',
      content: 'Hello!',
      timestamp: new Date().toISOString(),
      tokenCount: 10,
    }),
    createConversation: vi.fn().mockReturnValue({
      id: 'conv-1',
      title: 'Test',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
      totalTokens: 0,
    }),
    getConversation: vi.fn().mockReturnValue(undefined),
    listConversations: vi.fn().mockReturnValue([]),
    deleteConversation: vi.fn().mockReturnValue(true),
    getUsageStats: vi.fn().mockReturnValue({
      totalCalls: 0,
      totalOutputTokens: 0,
      averageLatencyMs: 0,
      totalInputTokens: 0,
    }),
    ...overrides,
  } as unknown as Parameters<AIChatHandler['setAIAssistant']>[0];
}

describe('AIChatHandler', () => {
  let handler: AIChatHandler;
  let deps: HandlerDeps;

  beforeEach(() => {
    deps = createMockDeps();
    handler = new AIChatHandler(deps);
  });

  it('returns false for unrelated message types', async () => {
    const result = await handler.handle(createMsg('org:list'));
    expect(result).toBe(false);
  });

  describe('ai:chat', () => {
    it('sends error when aiAssistant is not set', async () => {
      const result = await handler.handle(
        createMsg('ai:chat', { conversationId: 'c1', message: 'hello' }),
      );
      expect(result).toBe(true);
      expect(deps.broker.postToWebview).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ai:error' }),
      );
    });

    it('sends chat response with correlationId', async () => {
      const conv = {
        id: 'conv-1',
        title: 'Test',
        messages: [
          {
            id: 'm1',
            role: 'user',
            content: 'hi',
            timestamp: new Date().toISOString(),
          },
          {
            id: 'resp-1',
            role: 'assistant',
            content: 'Hello!',
            timestamp: new Date().toISOString(),
            tokenCount: 10,
          },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        totalTokens: 10,
      };
      const mockAssistant = createMockAssistant({
        getConversation: vi.fn().mockReturnValue(conv),
      });
      handler.setAIAssistant(mockAssistant);

      const msg = createMsg('ai:chat', {
        conversationId: 'conv-1',
        message: 'hi',
      });
      await handler.handle(msg);

      expect(deps.broker.postToWebview).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ai:chat:response',
          correlationId: 'msg-1',
        }),
      );
    });

    it('persists conversation to ConfigStore after chat', async () => {
      const conv = {
        id: 'conv-1',
        title: 'Test',
        messages: [
          {
            id: 'm1',
            role: 'user',
            content: 'hi',
            timestamp: new Date().toISOString(),
          },
          {
            id: 'resp-1',
            role: 'assistant',
            content: 'Hello!',
            timestamp: new Date().toISOString(),
            tokenCount: 10,
          },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        totalTokens: 10,
      };
      const mockAssistant = createMockAssistant({
        getConversation: vi.fn().mockReturnValue(conv),
      });
      handler.setAIAssistant(mockAssistant);

      await handler.handle(createMsg('ai:chat', { conversationId: 'conv-1', message: 'hi' }));

      // Should have saved both the conversation and the index
      expect(deps.configStore.set).toHaveBeenCalledWith(
        'ai:conversation:conv-1',
        expect.objectContaining({ id: 'conv-1', title: 'Test' }),
        'ai',
      );
      expect(deps.configStore.set).toHaveBeenCalledWith(
        'ai:conversations:index',
        expect.arrayContaining([expect.objectContaining({ id: 'conv-1' })]),
        'ai',
      );
    });
  });

  describe('ai:conversation:create', () => {
    it('persists new conversation to ConfigStore', async () => {
      const mockAssistant = createMockAssistant();
      handler.setAIAssistant(mockAssistant);

      await handler.handle(createMsg('ai:conversation:create', { title: 'New Chat' }));

      expect(deps.broker.postToWebview).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ai:conversation:created',
          correlationId: 'msg-1',
        }),
      );
      expect(deps.configStore.set).toHaveBeenCalledWith(
        'ai:conversation:conv-1',
        expect.objectContaining({ id: 'conv-1' }),
        'ai',
      );
    });

    it('sends error when aiAssistant is not set', async () => {
      await handler.handle(createMsg('ai:conversation:create', { title: 'Test' }));
      expect(deps.broker.postToWebview).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ai:error' }),
      );
    });
  });

  describe('ai:conversation:list', () => {
    it('returns conversations from ConfigStore index', async () => {
      const index = [
        {
          id: 'conv-1',
          title: 'Chat 1',
          createdAt: '2025-01-01T00:00:00Z',
          messageCount: 5,
        },
        {
          id: 'conv-2',
          title: 'Chat 2',
          createdAt: '2025-01-02T00:00:00Z',
          messageCount: 3,
        },
      ];
      deps.configStore.set('ai:conversations:index', index, 'ai');

      await handler.handle(createMsg('ai:conversation:list'));

      expect(deps.broker.postToWebview).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ai:conversation:list:response',
          correlationId: 'msg-1',
          payload: expect.objectContaining({ conversations: index }),
        }),
      );
    });

    it('returns empty array when no conversations exist', async () => {
      await handler.handle(createMsg('ai:conversation:list'));

      expect(deps.broker.postToWebview).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ai:conversation:list:response',
          payload: expect.objectContaining({ conversations: [] }),
        }),
      );
    });
  });

  describe('ai:conversation:load', () => {
    it('loads from memory when AI assistant is active', async () => {
      const conv = {
        id: 'conv-1',
        title: 'Test',
        messages: [
          {
            id: 'm1',
            role: 'user',
            content: 'hi',
            timestamp: new Date().toISOString(),
          },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        totalTokens: 0,
      };
      const mockAssistant = createMockAssistant({
        getConversation: vi.fn().mockReturnValue(conv),
      });
      handler.setAIAssistant(mockAssistant);

      await handler.handle(createMsg('ai:conversation:load', { conversationId: 'conv-1' }));

      expect(deps.broker.postToWebview).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ai:conversation:loaded',
          correlationId: 'msg-1',
        }),
      );
    });

    it('falls back to ConfigStore when not in memory', async () => {
      const persisted = {
        id: 'conv-old',
        title: 'Old Chat',
        messages: [
          {
            id: 'm1',
            role: 'user',
            content: 'old message',
            timestamp: '2025-01-01T00:00:00Z',
          },
        ],
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:00Z',
      };
      deps.configStore.set('ai:conversation:conv-old', persisted, 'ai');

      const mockAssistant = createMockAssistant({
        getConversation: vi.fn().mockReturnValue(undefined),
      });
      handler.setAIAssistant(mockAssistant);

      await handler.handle(createMsg('ai:conversation:load', { conversationId: 'conv-old' }));

      expect(deps.broker.postToWebview).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ai:conversation:loaded',
          correlationId: 'msg-1',
          payload: expect.objectContaining({
            conversation: expect.objectContaining({ id: 'conv-old' }),
          }),
        }),
      );
    });

    it('sends error when conversation not found anywhere', async () => {
      const mockAssistant = createMockAssistant({
        getConversation: vi.fn().mockReturnValue(undefined),
      });
      handler.setAIAssistant(mockAssistant);

      await handler.handle(createMsg('ai:conversation:load', { conversationId: 'missing' }));

      expect(deps.broker.postToWebview).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ai:error' }),
      );
    });
  });

  describe('ai:conversation:delete', () => {
    it('removes from ConfigStore and updates index', async () => {
      // Pre-populate ConfigStore
      const index = [
        {
          id: 'conv-1',
          title: 'Chat 1',
          createdAt: '2025-01-01',
          messageCount: 2,
        },
        {
          id: 'conv-2',
          title: 'Chat 2',
          createdAt: '2025-01-02',
          messageCount: 1,
        },
      ];
      deps.configStore.set('ai:conversations:index', index, 'ai');
      deps.configStore.set(
        'ai:conversation:conv-1',
        {
          id: 'conv-1',
          title: 'Chat 1',
          messages: [],
          createdAt: '2025-01-01',
          updatedAt: '2025-01-01',
        },
        'ai',
      );

      const mockAssistant = createMockAssistant();
      handler.setAIAssistant(mockAssistant);

      await handler.handle(createMsg('ai:conversation:delete', { conversationId: 'conv-1' }));

      // Should have deleted the conversation key
      expect(deps.configStore.delete).toHaveBeenCalledWith('ai:conversation:conv-1');

      // Index should be updated without conv-1
      const updatedIndex = deps.configStore.get<Array<{ id: string }>>('ai:conversations:index');
      expect(updatedIndex).toHaveLength(1);
      expect(updatedIndex?.[0]?.id).toBe('conv-2');

      // Should send deleted response with correlationId
      expect(deps.broker.postToWebview).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ai:conversation:deleted',
          correlationId: 'msg-1',
          payload: expect.objectContaining({ conversationId: 'conv-1' }),
        }),
      );
    });

    it('also deletes from in-memory AI assistant', async () => {
      const mockAssistant = createMockAssistant();
      handler.setAIAssistant(mockAssistant);

      await handler.handle(createMsg('ai:conversation:delete', { conversationId: 'c1' }));
      expect(mockAssistant.deleteConversation).toHaveBeenCalledWith('c1');
    });
  });

  describe('message cap enforcement', () => {
    it('prunes messages exceeding 200 cap on save', async () => {
      // Create a conversation with 210 messages
      const messages = Array.from({ length: 210 }, (_, i) => ({
        id: `m-${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}`,
        timestamp: new Date().toISOString(),
      }));
      const conv = {
        id: 'conv-big',
        title: 'Big Chat',
        messages,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        totalTokens: 0,
      };
      const mockAssistant = createMockAssistant({
        chat: vi.fn().mockResolvedValue({
          id: 'resp-new',
          role: 'assistant',
          content: 'Reply',
          timestamp: new Date().toISOString(),
          tokenCount: 5,
        }),
        getConversation: vi.fn().mockReturnValue(conv),
      });
      handler.setAIAssistant(mockAssistant);

      await handler.handle(createMsg('ai:chat', { conversationId: 'conv-big', message: 'test' }));

      // The saved conversation should have at most 200 messages
      const savedConv = deps.configStore.get<{
        messages: Array<{ id: string }>;
      }>('ai:conversation:conv-big');
      expect(savedConv).toBeDefined();
      expect(savedConv!.messages.length).toBeLessThanOrEqual(200);
    });
  });

  describe('correlationId propagation', () => {
    it('all responses include correlationId matching request id', async () => {
      const mockAssistant = createMockAssistant();
      handler.setAIAssistant(mockAssistant);

      // Test ai:conversation:create
      const createMsg1 = inboundRequest({
        id: 'req-create',
        type: 'ai:conversation:create',
        timestamp: Date.now(),
        payload: { title: 'T' },
      } as BaseMessage & { payload: Record<string, unknown> });
      await handler.handle(createMsg1);
      expect(deps.broker.postToWebview).toHaveBeenCalledWith(
        expect.objectContaining({ correlationId: 'req-create' }),
      );

      // Test ai:status
      const statusMsg = inboundRequest({
        id: 'req-status',
        type: 'ai:status',
        timestamp: Date.now(),
        payload: {},
      } as BaseMessage & { payload: Record<string, unknown> });
      await handler.handle(statusMsg);
      expect(deps.broker.postToWebview).toHaveBeenCalledWith(
        expect.objectContaining({ correlationId: 'req-status' }),
      );

      // Test ai:conversation:list
      const listMsg = inboundRequest({
        id: 'req-list',
        type: 'ai:conversation:list',
        timestamp: Date.now(),
        payload: {},
      } as BaseMessage & { payload: Record<string, unknown> });
      await handler.handle(listMsg);
      expect(deps.broker.postToWebview).toHaveBeenCalledWith(
        expect.objectContaining({ correlationId: 'req-list' }),
      );
    });
  });

  describe('ai:status', () => {
    it('returns status with correlationId', async () => {
      const result = await handler.handle(createMsg('ai:status'));
      expect(result).toBe(true);
      expect(deps.broker.postToWebview).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ai:status:response',
          correlationId: 'msg-1',
        }),
      );
    });
  });

  describe('ai:save-key', () => {
    it('saves key and responds with success and correlationId', async () => {
      const result = await handler.handle(
        inboundRequest(
          createMsg('ai:save-key', {
            apiKey: 'sk-test',
          }) as unknown as BaseMessage,
        ),
      );
      expect(result).toBe(true);
      expect(deps.secretVault.storeSecret).toHaveBeenCalledWith('ai.anthropic.key', 'sk-test');
      expect(deps.broker.postToWebview).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ai:save-key:response',
          correlationId: 'msg-1',
          payload: expect.objectContaining({ success: true }),
        }),
      );
    });

    it('turns AI on by writing sandforge.ai.enabled after the key is stored', async () => {
      const setSandforgeSetting = vi.fn().mockResolvedValue(undefined);
      deps.services = {
        setSandforgeSetting,
      } as unknown as HandlerDeps['services'];

      await handler.handle(createMsg('ai:save-key', { apiKey: 'sk-test' }));

      expect(setSandforgeSetting).toHaveBeenCalledWith('ai.enabled', true);
    });

    it('does not enable AI when the key could not be stored', async () => {
      const setSandforgeSetting = vi.fn().mockResolvedValue(undefined);
      deps.services = {
        setSandforgeSetting,
      } as unknown as HandlerDeps['services'];
      (deps.secretVault.storeSecret as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('keychain locked'),
      );

      await handler.handle(createMsg('ai:save-key', { apiKey: 'sk-test' }));

      expect(setSandforgeSetting).not.toHaveBeenCalled();
      expect(deps.broker.postToWebview).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ai:save-key:response',
          payload: expect.objectContaining({ success: false }),
        }),
      );
    });

    it('still reports success when the settings backend cannot enable AI', async () => {
      deps.services = {
        setSandforgeSetting: vi.fn().mockRejectedValue(new Error('config write refused')),
      } as unknown as HandlerDeps['services'];

      await handler.handle(createMsg('ai:save-key', { apiKey: 'sk-test' }));

      expect(deps.broker.postToWebview).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ai:save-key:response',
          payload: expect.objectContaining({ success: true }),
        }),
      );
    });

    it('still reports success when no settings backend is injected at all', async () => {
      await handler.handle(createMsg('ai:save-key', { apiKey: 'sk-test' }));

      expect(deps.broker.postToWebview).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ai:save-key:response',
          payload: expect.objectContaining({ success: true }),
        }),
      );
    });

    it('pushes a fresh ai:status:response so the webview flips without a reload', async () => {
      deps.services = {
        setSandforgeSetting: vi.fn().mockResolvedValue(undefined),
      } as unknown as HandlerDeps['services'];
      (deps.secretVault.hasSecret as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      handler.setAIAssistant(createMockAssistant());

      await handler.handle(createMsg('ai:save-key', { apiKey: 'sk-test' }));

      expect(deps.broker.postToWebview).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ai:status:response',
          payload: expect.objectContaining({ enabled: true }),
        }),
      );
    });
  });

  it('exposes getAIAssistant for other sub-handlers', () => {
    expect(handler.getAIAssistant()).toBeUndefined();
    const mockAssistant = {} as Parameters<typeof handler.setAIAssistant>[0];
    handler.setAIAssistant(mockAssistant);
    expect(handler.getAIAssistant()).toBe(mockAssistant);
  });

  describe('payload validation', () => {
    it('rejects ai:chat without conversationId (INVALID_PAYLOAD)', async () => {
      const result = await handler.handle(createMsg('ai:chat', { message: 'hi' }));
      expect(result).toBe(true);

      const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(response.type).toBe('ai:error');
      expect(response.payload.code).toBe('INVALID_PAYLOAD');
    });

    it('rejects ai:save-key without apiKey (INVALID_PAYLOAD)', async () => {
      const result = await handler.handle(createMsg('ai:save-key', {}));
      expect(result).toBe(true);

      const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(response.type).toBe('ai:error');
      expect(response.payload.code).toBe('INVALID_PAYLOAD');
      expect(deps.secretVault.storeSecret).not.toHaveBeenCalled();
    });

    it('rejects ai:conversation:delete with a non-string conversationId', async () => {
      const result = await handler.handle(
        createMsg('ai:conversation:delete', { conversationId: 7 }),
      );
      expect(result).toBe(true);

      const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(response.type).toBe('ai:error');
      expect(response.payload.code).toBe('INVALID_PAYLOAD');
    });
  });
});
