import type { BaseMessage } from '@sandforge/shared';
import { AI_CONFIG, AI_PROVIDER } from '@sandforge/shared';
import type { AISaveKeyRequest } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler } from '../HandlerTypes.js';
import type { AIAssistant } from '../../../modules/ai/AIAssistant.js';
import { extractErrorMessage } from '../../../core/common/extractErrorMessage.js';

/** Message types handled by AIChatHandler. */
export const AI_CHAT_TYPES = new Set([
  'ai:chat',
  'ai:conversation:create',
  'ai:conversation:load',
  'ai:conversation:delete',
  'ai:status',
  'ai:save-key',
]);

/**
 * Sub-handler for AI chat and conversation management messages.
 *
 * Handles chat exchanges, conversation CRUD, status queries,
 * and API key persistence.
 */
export class AIChatHandler implements DomainHandler {
  private aiAssistant?: AIAssistant;

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {}

  /** Inject AI assistant service. */
  setAIAssistant(ai: AIAssistant): void {
    this.aiAssistant = ai;
  }

  /** Get the current AI assistant instance (for sub-handlers that need it). */
  getAIAssistant(): AIAssistant | undefined {
    return this.aiAssistant;
  }

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: BaseMessage): Promise<boolean> {
    if (!AI_CHAT_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'ai:chat':
        await this.handleChat(msg);
        return true;
      case 'ai:conversation:create':
        this.handleConversationCreate(msg);
        return true;
      case 'ai:conversation:load':
        this.handleConversationLoad(msg);
        return true;
      case 'ai:conversation:delete':
        this.handleConversationDelete(msg);
        return true;
      case 'ai:status':
        await this.handleStatus(msg);
        return true;
      case 'ai:save-key':
        await this.handleSaveKey(msg);
        return true;
      default:
        return false;
    }
  }

  private async handleChat(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = (msg as BaseMessage & { payload: { conversationId: string; message: string } }).payload;

    if (!this.aiAssistant) {
      const errMsg: BaseMessage & { payload: { message: string } } = {
        id: this.deps.nextId(),
        type: 'ai:error',
        timestamp: Date.now(),
        payload: { message: 'AI is not configured. Set your API key in Settings > AI.' },
      };
      this.deps.broker.postToWebview(errMsg);
      return;
    }

    try {
      const response = await this.aiAssistant.chat(payload.conversationId, payload.message);
      const chatResponse: BaseMessage & { payload: Record<string, unknown> } = {
        id: this.deps.nextId(),
        type: 'ai:chat:response',
        timestamp: Date.now(),
        payload: {
          conversationId: payload.conversationId,
          message: {
            id: response.id,
            role: response.role,
            content: response.content,
            timestamp: response.timestamp,
            tokenCount: response.tokenCount,
          },
        },
      };
      this.deps.broker.postToWebview(chatResponse);
      this.deps.log(`[TX] ai:chat:response`);
    } catch (err: unknown) {
      const message = extractErrorMessage(err);
      const errMsg: BaseMessage & { payload: { message: string } } = {
        id: this.deps.nextId(),
        type: 'ai:error',
        timestamp: Date.now(),
        payload: { message },
      };
      this.deps.broker.postToWebview(errMsg);
      this.deps.log(`[TX] ai:error: ${message}`);
    }
  }

  private handleConversationCreate(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = (msg as BaseMessage & { payload: { title: string } }).payload;

    if (!this.aiAssistant) {
      const errMsg: BaseMessage & { payload: { message: string } } = {
        id: this.deps.nextId(),
        type: 'ai:error',
        timestamp: Date.now(),
        payload: { message: 'AI is not configured. Set your API key in Settings > AI.' },
      };
      this.deps.broker.postToWebview(errMsg);
      return;
    }

    const conversation = this.aiAssistant.createConversation(payload.title);
    const response: BaseMessage & { payload: Record<string, unknown> } = {
      id: this.deps.nextId(),
      type: 'ai:conversation:created',
      timestamp: Date.now(),
      payload: {
        conversation: {
          id: conversation.id,
          title: conversation.title,
          createdAt: conversation.createdAt,
        },
      },
    };
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ai:conversation:created id=${conversation.id}`);
  }

  private handleConversationLoad(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = (msg as BaseMessage & { payload: { conversationId: string } }).payload;

    if (!this.aiAssistant) {
      const errMsg: BaseMessage & { payload: { message: string } } = {
        id: this.deps.nextId(),
        type: 'ai:error',
        timestamp: Date.now(),
        payload: { message: 'AI is not configured.' },
      };
      this.deps.broker.postToWebview(errMsg);
      return;
    }

    const conversation = this.aiAssistant.getConversation(payload.conversationId);
    if (!conversation) {
      const errMsg: BaseMessage & { payload: { message: string } } = {
        id: this.deps.nextId(),
        type: 'ai:error',
        timestamp: Date.now(),
        payload: { message: `Conversation ${payload.conversationId} not found.` },
      };
      this.deps.broker.postToWebview(errMsg);
      return;
    }

    const response: BaseMessage & { payload: Record<string, unknown> } = {
      id: this.deps.nextId(),
      type: 'ai:conversation:loaded',
      timestamp: Date.now(),
      payload: {
        conversation: {
          id: conversation.id,
          title: conversation.title,
          messages: conversation.messages.map(m => ({
            id: m.id,
            role: m.role,
            content: m.content,
            timestamp: m.timestamp,
          })),
        },
      },
    };
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ai:conversation:loaded id=${conversation.id}`);
  }

  private handleConversationDelete(msg: BaseMessage): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = (msg as BaseMessage & { payload: { conversationId: string } }).payload;

    if (!this.aiAssistant) {
      return;
    }

    this.aiAssistant.deleteConversation(payload.conversationId);
  }

  private async handleStatus(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);

    const hasKey = await this.deps.secretVault.hasSecret('ai-api-key');

    const response: BaseMessage & { payload: Record<string, unknown> } = {
      id: this.deps.nextId(),
      type: 'ai:status:response',
      timestamp: Date.now(),
      payload: {
        enabled: !!this.aiAssistant && hasKey,
        provider: this.aiAssistant ? AI_PROVIDER : 'none',
        model: this.aiAssistant ? AI_CONFIG.MODEL : '',
        usage: this.aiAssistant
          ? this.aiAssistant.getUsageStats()
          : { totalCalls: 0, totalOutputTokens: 0, averageLatencyMs: 0 },
      },
    };
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ai:status:response`);
  }

  private async handleSaveKey(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const { apiKey } = (msg as AISaveKeyRequest).payload;
    try {
      await this.deps.secretVault.storeSecret('ai-api-key', apiKey);
      const response: BaseMessage & { payload: Record<string, unknown> } = {
        type: 'ai:save-key:response', id: this.deps.nextId(), timestamp: Date.now(),
        payload: { success: true },
      };
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ai:save-key:response success`);
    } catch (err: unknown) {
      const message = extractErrorMessage(err);
      this.deps.log(`[ERR] ai:save-key: ${message}`);
      const response: BaseMessage & { payload: Record<string, unknown> } = {
        type: 'ai:save-key:response', id: this.deps.nextId(), timestamp: Date.now(),
        payload: { success: false, error: message },
      };
      this.deps.broker.postToWebview(response);
    }
  }
}
