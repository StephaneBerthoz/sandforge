import { AI_CONFIG, AI_PROVIDER } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler, InboundRequest } from '../HandlerTypes.js';
import { buildResponse } from '../HandlerTypes.js';
import {
  validatePayload,
  aiChatPayloadSchema,
  aiConversationCreatePayloadSchema,
  aiConversationIdPayloadSchema,
  aiSaveKeyPayloadSchema,
} from '../../validatePayload.js';
import type { AIAssistant, Conversation } from '../../../modules/ai/AIAssistant.js';
import { extractErrorMessage } from '../../../core/common/extractErrorMessage.js';

/** Maximum number of messages per conversation before pruning. */
const MAX_MESSAGES_PER_CONVERSATION = 200;

/** ConfigStore key for the conversations index. */
const INDEX_KEY = 'ai:conversations:index';

/** ConfigStore category for all AI keys. */
const AI_CATEGORY = 'ai';

/**
 * SecretVault key for the unified Anthropic API key.
 * SecretVault prefixes keys with `sandforge.`, so this lands on
 * `sandforge.ai.anthropic.key` — the key AnthropicAdapter reads.
 */
const AI_API_KEY_SECRET = 'ai.anthropic.key';

/** Minimal conversation metadata stored in the index. */
interface ConversationIndexEntry {
  id: string;
  title: string;
  createdAt: string;
  messageCount: number;
}

/** Persisted conversation data stored per key. */
interface PersistedConversation {
  id: string;
  title: string;
  messages: Array<{
    id: string;
    role: string;
    content: string;
    timestamp: string;
    tokenCount?: number;
  }>;
  createdAt: string;
  updatedAt: string;
}

/** Message types handled by AIChatHandler. */
const AI_CHAT_TYPES = new Set([
  'ai:chat',
  'ai:conversation:create',
  'ai:conversation:load',
  'ai:conversation:delete',
  'ai:conversation:list',
  'ai:status',
  'ai:save-key',
]);

/**
 * Sub-handler for AI chat and conversation management messages.
 *
 * Handles chat exchanges, conversation CRUD, status queries,
 * and API key persistence. Conversations are persisted to ConfigStore
 * using per-conversation keys to avoid size limits.
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
  async handle(msg: InboundRequest): Promise<boolean> {
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
      case 'ai:conversation:list':
        this.handleConversationList(msg);
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

  /**
   * Build a ConfigStore key for a specific conversation.
   * @param conversationId - The conversation ID.
   */
  private conversationKey(conversationId: string): string {
    return `ai:conversation:${conversationId}`;
  }

  /**
   * Load the conversation index from ConfigStore.
   * @returns The array of index entries, or empty array if none.
   */
  private loadIndex(): ConversationIndexEntry[] {
    return this.deps.configStore.get<ConversationIndexEntry[]>(INDEX_KEY) ?? [];
  }

  /**
   * Save the conversation index to ConfigStore.
   * @param index - The index entries to persist.
   */
  private saveIndex(index: ConversationIndexEntry[]): void {
    this.deps.configStore.set(INDEX_KEY, index, AI_CATEGORY);
  }

  /**
   * Load a persisted conversation from ConfigStore.
   * @param conversationId - The conversation ID.
   * @returns The persisted conversation or undefined.
   */
  private loadConversation(conversationId: string): PersistedConversation | undefined {
    return this.deps.configStore.get<PersistedConversation>(this.conversationKey(conversationId));
  }

  /**
   * Save a conversation to ConfigStore and update the index entry.
   * @param conversation - The conversation data to persist.
   */
  private saveConversation(conversation: PersistedConversation): void {
    this.deps.configStore.set(this.conversationKey(conversation.id), conversation, AI_CATEGORY);
    this.updateIndexEntry(conversation);
  }

  /**
   * Update or insert a conversation entry in the index.
   * @param conversation - The conversation to sync in the index.
   */
  private updateIndexEntry(conversation: PersistedConversation): void {
    const index = this.loadIndex();
    const existing = index.findIndex((e) => e.id === conversation.id);
    const entry: ConversationIndexEntry = {
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
      messageCount: conversation.messages.length,
    };
    if (existing >= 0) {
      index[existing] = entry;
    } else {
      index.push(entry);
    }
    this.saveIndex(index);
  }

  /**
   * Prune messages if conversation exceeds the cap.
   * Keeps system messages at the start and the most recent messages.
   * @param messages - The message array to prune.
   * @returns The pruned message array.
   */
  private pruneMessages(
    messages: PersistedConversation['messages'],
  ): PersistedConversation['messages'] {
    if (messages.length <= MAX_MESSAGES_PER_CONVERSATION) {
      return messages;
    }
    const systemMessages = messages.filter((m) => m.role === 'system');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');
    const keepCount = MAX_MESSAGES_PER_CONVERSATION - systemMessages.length;
    return [...systemMessages, ...nonSystemMessages.slice(-keepCount)];
  }

  private async handleChat(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(aiChatPayloadSchema, msg, 'ai:error', this.deps);
    if (!parsed) return;
    const payload = parsed;

    if (!this.aiAssistant) {
      const errResponse = buildResponse(this.deps, msg, 'ai:error', {
        message: 'AI is not configured. Set your API key in Settings > AI.',
      });
      this.deps.broker.postToWebview(errResponse);
      return;
    }

    try {
      const aiResponse = await this.aiAssistant.chat(payload.conversationId, payload.message);

      // Persist conversation to ConfigStore after chat
      const conversation = this.aiAssistant.getConversation(payload.conversationId);
      if (conversation) {
        this.persistConversationFromMemory(conversation);
      }

      const chatResponse = buildResponse(this.deps, msg, 'ai:chat:response', {
        conversationId: payload.conversationId,
        message: {
          id: aiResponse.id,
          role: aiResponse.role,
          content: aiResponse.content,
          timestamp: aiResponse.timestamp,
          tokenCount: aiResponse.tokenCount,
        },
      });
      this.deps.broker.postToWebview(chatResponse);
      this.deps.log(`[TX] ai:chat:response`);
    } catch (err: unknown) {
      const message = extractErrorMessage(err);
      const errResponse = buildResponse(this.deps, msg, 'ai:error', { message });
      this.deps.broker.postToWebview(errResponse);
      this.deps.log(`[TX] ai:error: ${message}`);
    }
  }

  private handleConversationCreate(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(aiConversationCreatePayloadSchema, msg, 'ai:error', this.deps);
    if (!parsed) return;
    const payload = parsed;

    if (!this.aiAssistant) {
      const errResponse = buildResponse(this.deps, msg, 'ai:error', {
        message: 'AI is not configured. Set your API key in Settings > AI.',
      });
      this.deps.broker.postToWebview(errResponse);
      return;
    }

    const conversation = this.aiAssistant.createConversation(payload.title);

    // Persist new conversation to ConfigStore
    this.persistConversationFromMemory(conversation);

    const response = buildResponse(this.deps, msg, 'ai:conversation:created', {
      conversation: {
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
      },
    });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ai:conversation:created id=${conversation.id}`);
  }

  private handleConversationLoad(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(aiConversationIdPayloadSchema, msg, 'ai:error', this.deps);
    if (!parsed) return;
    const payload = parsed;

    // First try in-memory (if AI assistant is active)
    if (this.aiAssistant) {
      const memConversation = this.aiAssistant.getConversation(payload.conversationId);
      if (memConversation) {
        const response = buildResponse(this.deps, msg, 'ai:conversation:loaded', {
          conversation: {
            id: memConversation.id,
            title: memConversation.title,
            messages: memConversation.messages.map((m) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              timestamp: m.timestamp,
            })),
          },
        });
        this.deps.broker.postToWebview(response);
        this.deps.log(`[TX] ai:conversation:loaded id=${memConversation.id} (memory)`);
        return;
      }
    }

    // Fall back to ConfigStore
    const persisted = this.loadConversation(payload.conversationId);
    if (!persisted) {
      const errResponse = buildResponse(this.deps, msg, 'ai:error', {
        message: `Conversation ${payload.conversationId} not found.`,
      });
      this.deps.broker.postToWebview(errResponse);
      return;
    }

    const response = buildResponse(this.deps, msg, 'ai:conversation:loaded', {
      conversation: {
        id: persisted.id,
        title: persisted.title,
        messages: persisted.messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
        })),
      },
    });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ai:conversation:loaded id=${persisted.id} (store)`);
  }

  private handleConversationList(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const index = this.loadIndex();
    const response = buildResponse(this.deps, msg, 'ai:conversation:list:response', {
      conversations: index,
    });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ai:conversation:list:response count=${index.length}`);
  }

  private handleConversationDelete(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(aiConversationIdPayloadSchema, msg, 'ai:error', this.deps);
    if (!parsed) return;
    const payload = parsed;

    // Remove from in-memory if AI assistant is active
    if (this.aiAssistant) {
      this.aiAssistant.deleteConversation(payload.conversationId);
    }

    // Remove from ConfigStore
    this.deps.configStore.delete(this.conversationKey(payload.conversationId));

    // Update index
    const index = this.loadIndex().filter((e) => e.id !== payload.conversationId);
    this.saveIndex(index);

    const response = buildResponse(this.deps, msg, 'ai:conversation:deleted', {
      conversationId: payload.conversationId,
    });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ai:conversation:deleted id=${payload.conversationId}`);
  }

  private async handleStatus(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    await this.postStatus(msg);
  }

  /**
   * Emit the current AI availability on `ai:status:response`.
   * Shared by the `ai:status` query and the key-save flow, which pushes a
   * fresh status of its own (the webview tracks availability by message type,
   * not by correlation).
   *
   * @param request - The request the response is correlated to.
   */
  private async postStatus(request: InboundRequest): Promise<void> {
    const hasKey = await this.deps.secretVault.hasSecret(AI_API_KEY_SECRET);

    const response = buildResponse(this.deps, request, 'ai:status:response', {
      enabled: !!this.aiAssistant && hasKey,
      provider: this.aiAssistant ? AI_PROVIDER : 'none',
      model: this.aiAssistant ? AI_CONFIG.MODEL : '',
      usage: this.aiAssistant
        ? this.aiAssistant.getUsageStats()
        : { totalCalls: 0, totalOutputTokens: 0, averageLatencyMs: 0 },
    });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ai:status:response`);
  }

  /**
   * Turn the stored key into an actually usable assistant by flipping
   * `sandforge.ai.enabled`. It defaults to false and no control in the UI
   * ever wrote it, so a saved key alone left the AI stack uninitialised for
   * good — the key input was a dead end. The `sandforge.ai` config listener
   * re-runs the AI composition on this change.
   *
   * Failures never fail the save: the key IS stored, so answering
   * `success: false` would be a lie. They are logged instead.
   */
  private async enableAIFeature(): Promise<void> {
    if (!this.deps.services?.setSandforgeSetting) {
      this.deps.log('[WARN] ai:save-key: no settings backend — sandforge.ai.enabled left as-is.');
      return;
    }
    try {
      await this.deps.services.setSandforgeSetting('ai.enabled', true);
    } catch (err: unknown) {
      this.deps.log(`[ERR] ai:save-key: enabling sandforge.ai failed: ${extractErrorMessage(err)}`);
    }
  }

  private async handleSaveKey(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(aiSaveKeyPayloadSchema, msg, 'ai:error', this.deps);
    if (!parsed) return;
    const { apiKey } = parsed;
    try {
      await this.deps.secretVault.storeSecret(AI_API_KEY_SECRET, apiKey);
      await this.enableAIFeature();
      const response = buildResponse(this.deps, msg, 'ai:save-key:response', {
        success: true,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ai:save-key:response success`);
      // Refresh the availability flag the webview keeps in its store. The
      // re-init triggered by the setting above is asynchronous, so this
      // snapshot can still read "disabled" — the Settings tab re-probes once
      // the host has had time to wire the assistant.
      await this.postStatus(msg);
    } catch (err: unknown) {
      const message = extractErrorMessage(err);
      this.deps.log(`[ERR] ai:save-key: ${message}`);
      const response = buildResponse(this.deps, msg, 'ai:save-key:response', {
        success: false,
        error: message,
      });
      this.deps.broker.postToWebview(response);
    }
  }

  /**
   * Persist an in-memory Conversation to ConfigStore with message pruning.
   * @param conversation - The in-memory conversation from AIAssistant.
   */
  private persistConversationFromMemory(conversation: Conversation): void {
    const messages = conversation.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
      tokenCount: m.tokenCount,
    }));

    const persisted: PersistedConversation = {
      id: conversation.id,
      title: conversation.title,
      messages: this.pruneMessages(messages),
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    };

    this.saveConversation(persisted);
  }
}
