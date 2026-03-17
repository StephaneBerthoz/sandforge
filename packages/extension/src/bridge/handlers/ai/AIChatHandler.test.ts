import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIChatHandler } from './AIChatHandler.js';
import type { HandlerDeps } from '../HandlerTypes.js';
import type { BaseMessage } from '@sandforge/shared';

vi.mock('../../../core/common/extractErrorMessage.js', () => ({
  extractErrorMessage: (err: unknown) => err instanceof Error ? err.message : String(err),
}));

function createMockDeps(): HandlerDeps {
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as unknown as HandlerDeps['stateSync'],
    orgManager: {} as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore: {} as unknown as HandlerDeps['configStore'],
    secretVault: {
      hasSecret: vi.fn().mockResolvedValue(false),
      storeSecret: vi.fn().mockResolvedValue(undefined),
    } as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
    nextId: vi.fn().mockReturnValue('test-id'),
  };
}

function createMsg(type: string, payload: Record<string, unknown> = {}): BaseMessage & { payload: Record<string, unknown> } {
  return { id: 'msg-1', type, timestamp: Date.now(), payload };
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

  it('handles ai:chat without aiAssistant by sending error', async () => {
    const result = await handler.handle(createMsg('ai:chat', { conversationId: 'c1', message: 'hello' }));
    expect(result).toBe(true);
    expect(deps.broker.postToWebview).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ai:error' }),
    );
  });

  it('handles ai:chat with aiAssistant', async () => {
    const mockAssistant = {
      chat: vi.fn().mockResolvedValue({
        id: 'resp-1', role: 'assistant', content: 'Hello!', timestamp: Date.now(), tokenCount: 10,
      }),
    };
    handler.setAIAssistant(mockAssistant as unknown as Parameters<typeof handler.setAIAssistant>[0]);

    const result = await handler.handle(createMsg('ai:chat', { conversationId: 'c1', message: 'hi' }));
    expect(result).toBe(true);
    expect(deps.broker.postToWebview).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ai:chat:response' }),
    );
  });

  it('handles ai:conversation:create', async () => {
    const mockAssistant = {
      createConversation: vi.fn().mockReturnValue({ id: 'conv-1', title: 'Test', createdAt: Date.now() }),
    };
    handler.setAIAssistant(mockAssistant as unknown as Parameters<typeof handler.setAIAssistant>[0]);

    const result = await handler.handle(createMsg('ai:conversation:create', { title: 'Test' }));
    expect(result).toBe(true);
    expect(deps.broker.postToWebview).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ai:conversation:created' }),
    );
  });

  it('handles ai:conversation:load with not found', async () => {
    const mockAssistant = { getConversation: vi.fn().mockReturnValue(undefined) };
    handler.setAIAssistant(mockAssistant as unknown as Parameters<typeof handler.setAIAssistant>[0]);

    const result = await handler.handle(createMsg('ai:conversation:load', { conversationId: 'missing' }));
    expect(result).toBe(true);
    expect(deps.broker.postToWebview).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ai:error' }),
    );
  });

  it('handles ai:conversation:delete', async () => {
    const mockAssistant = { deleteConversation: vi.fn() };
    handler.setAIAssistant(mockAssistant as unknown as Parameters<typeof handler.setAIAssistant>[0]);

    const result = await handler.handle(createMsg('ai:conversation:delete', { conversationId: 'c1' }));
    expect(result).toBe(true);
    expect(mockAssistant.deleteConversation).toHaveBeenCalledWith('c1');
  });

  it('handles ai:status', async () => {
    const result = await handler.handle(createMsg('ai:status'));
    expect(result).toBe(true);
    expect(deps.broker.postToWebview).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ai:status:response' }),
    );
  });

  it('handles ai:save-key success', async () => {
    const result = await handler.handle(createMsg('ai:save-key', { apiKey: 'sk-test' }) as unknown as BaseMessage);
    expect(result).toBe(true);
    expect(deps.secretVault.storeSecret).toHaveBeenCalledWith('ai-api-key', 'sk-test');
    expect(deps.broker.postToWebview).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ai:save-key:response',
        payload: expect.objectContaining({ success: true }),
      }),
    );
  });

  it('exposes getAIAssistant for other sub-handlers', () => {
    expect(handler.getAIAssistant()).toBeUndefined();
    const mockAssistant = {} as Parameters<typeof handler.setAIAssistant>[0];
    handler.setAIAssistant(mockAssistant);
    expect(handler.getAIAssistant()).toBe(mockAssistant);
  });
});
