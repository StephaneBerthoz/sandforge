import { AI_CONFIG, AI_PROVIDER, resolveAIModel } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler, InboundRequest } from '../HandlerTypes.js';
import { buildResponse } from '../HandlerTypes.js';
import {
  validatePayload,
  aiChatPayloadSchema,
  aiConversationCreatePayloadSchema,
  aiConversationIdPayloadSchema,
  aiSaveKeyPayloadSchema,
  aiSettingsPayloadSchema,
} from '../../validatePayload.js';
import type { AIAssistant, ChatRole, Conversation } from '../../../modules/ai/AIAssistant.js';
import { extractErrorMessage } from '../../../core/common/extractErrorMessage.js';
import { InFlightCalls } from './inFlightCalls.js';

/** Maximum number of messages per conversation before pruning. */
const MAX_MESSAGES_PER_CONVERSATION = 200;

/**
 * The most conversations kept, whole, in VS Code's global state: past it, the
 * one written to least recently goes. Only the messages of each were bounded,
 * and every conversation ever started stayed, AI off or the key gone.
 */
export const MAX_CONVERSATIONS = 50;

/** Read under the `sandforge` section, so without its prefix. */
const ENABLED_SETTING = 'ai.enabled';

/** Whether a failed run sends its error message for a fix suggestion. */
const ERROR_RESOLUTION_SETTING = 'ai.errorResolution';

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
  /** When it was last written to; absent from entries kept before it was recorded. */
  updatedAt?: string;
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
  'ai:chat:cancel',
  'ai:conversation:create',
  'ai:conversation:load',
  'ai:conversation:delete',
  'ai:conversation:delete-all',
  'ai:conversation:list',
  'ai:status',
  'ai:save-key',
  'ai:settings',
  'ai:remove-key',
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

  /**
   * The call each conversation's question waits on, so `ai:chat:cancel` can
   * stop it. The composer stayed locked under a spinner until the model
   * answered or the request timed out: there was no way to give up on a
   * question asked by mistake, or one the model was slow to answer.
   */
  private readonly asking = new InFlightCalls();

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {}

  /**
   * Inject the AI assistant service. Passing `undefined` takes it away — that
   * is how switching `sandforge.ai.enabled` off mid-session stops chat from
   * reaching a provider and flips `ai:status:response` back to disabled.
   */
  setAIAssistant(ai: AIAssistant | undefined): void {
    this.aiAssistant = ai;
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
      case 'ai:chat:cancel':
        this.handleChatCancel(msg);
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
      case 'ai:conversation:delete-all':
        this.handleConversationDeleteAll(msg);
        return true;
      case 'ai:status':
        await this.handleStatus(msg);
        return true;
      case 'ai:save-key':
        await this.handleSaveKey(msg);
        return true;
      case 'ai:settings':
        await this.handleSettings(msg);
        return true;
      case 'ai:remove-key':
        await this.handleRemoveKey(msg);
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
      updatedAt: conversation.updatedAt,
    };
    if (existing >= 0) {
      index[existing] = entry;
    } else {
      index.push(entry);
    }
    this.saveIndex(this.withinTheBound(index, conversation.id));
  }

  /**
   * The index held to {@link MAX_CONVERSATIONS}: past it, the conversations
   * written to least recently are deleted, whole, and left out. The one just
   * written is never among them.
   */
  private withinTheBound(
    index: ConversationIndexEntry[],
    written: string,
  ): ConversationIndexEntry[] {
    if (index.length <= MAX_CONVERSATIONS) return index;
    const lastWritten = (e: ConversationIndexEntry): string => e.updatedAt ?? e.createdAt;
    const dropped = new Set(
      [...index]
        .filter((e) => e.id !== written)
        .sort((a, b) => lastWritten(a).localeCompare(lastWritten(b)))
        .slice(0, index.length - MAX_CONVERSATIONS)
        .map((e) => e.id),
    );
    for (const id of dropped) this.forgetConversation(id);
    this.deps.log(
      `[INFO] ai: ${dropped.size} conversation(s) written to least recently deleted ` +
        `(${MAX_CONVERSATIONS} are kept).`,
    );
    return index.filter((e) => !dropped.has(e.id));
  }

  /** Delete one conversation, from the store and from the assistant, its question stopped. */
  private forgetConversation(conversationId: string): void {
    this.asking.abort(conversationId);
    this.aiAssistant?.deleteConversation(conversationId);
    this.deps.configStore.delete(this.conversationKey(conversationId));
  }

  /**
   * Delete every conversation kept and the index with them, those the index
   * no longer names included.
   *
   * @returns How many conversations there were.
   */
  private deleteAllConversations(): number {
    const prefix = this.conversationKey('');
    const ids = new Set(this.loadIndex().map((e) => e.id));
    for (const key of this.deps.configStore.getKeysByPrefix(prefix)) {
      ids.add(key.slice(prefix.length));
    }
    for (const id of ids) this.forgetConversation(id);
    this.saveIndex([]);
    return ids.size;
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

  /**
   * Narrow a persisted role string to the roles a conversation accepts.
   * @param role - The role read back from the store.
   */
  private isChatRole(role: string): role is ChatRole {
    return role === 'user' || role === 'assistant' || role === 'system';
  }

  /**
   * Rebuild an in-memory conversation from its persisted form, message order
   * preserved. Anything carrying an unknown role is dropped rather than sent
   * to the provider, which would reject the whole call.
   *
   * @param persisted - The conversation as stored in ConfigStore.
   */
  private toConversation(persisted: PersistedConversation): Conversation {
    const messages = persisted.messages
      .filter((m) => this.isChatRole(m.role))
      .map((m) => ({
        id: m.id,
        role: m.role as ChatRole,
        content: m.content,
        timestamp: m.timestamp,
        tokenCount: m.tokenCount,
      }));

    return {
      id: persisted.id,
      title: persisted.title,
      messages,
      createdAt: persisted.createdAt,
      updatedAt: persisted.updatedAt,
      totalTokens: messages.reduce((sum, m) => sum + (m.tokenCount ?? 0), 0),
    };
  }

  /**
   * Guarantee the assistant knows the conversation before it is chatted to.
   *
   * The assistant only ever learns about a conversation it created itself, and
   * its memory is wiped by a VS Code restart and by every `sandforge.ai.*`
   * setting change. ConfigStore is the durable side — a conversation is written
   * there on creation and after each exchange — so a miss is repaired from it.
   *
   * Done here rather than on `ai:conversation:load` because the webview can
   * hold on to a conversation id without ever reloading it: the chat is the
   * only point where in-memory state is actually required, and repairing it
   * there covers the load path too.
   *
   * @param conversationId - The conversation the webview wants to continue.
   */
  private restoreConversationIfNeeded(conversationId: string): void {
    const assistant = this.aiAssistant;
    if (!assistant || assistant.getConversation(conversationId)) return;

    const persisted = this.loadConversation(conversationId);
    if (!persisted) return;

    assistant.restoreConversation(this.toConversation(persisted));
    this.deps.log(`Restored conversation ${conversationId} from store.`);
  }

  private async handleChat(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(aiChatPayloadSchema, msg, 'ai:error', this.deps);
    if (!parsed) return;
    const payload = parsed;

    // The assistant asked holds the answer in its conversation. A
    // `sandforge.ai.*` change sets another, or none — aborting the calls in
    // flight as it does, which the handler does not count on. Read once the
    // answer came, the new one's copy of the conversation was stored, which
    // lacked the exchange, or nothing when it had none; and with no assistant
    // left, the answer was reported as an error of the handler's own.
    const assistant = this.aiAssistant;
    if (!assistant) {
      const errResponse = buildResponse(this.deps, msg, 'ai:error', {
        message: 'AI is not configured. Set your API key in Settings > AI.',
      });
      this.deps.broker.postToWebview(errResponse);
      return;
    }

    this.restoreConversationIfNeeded(payload.conversationId);

    // One per conversation, as the assistant asks one question at a time in
    // each: a second question there is refused before it is sent, and must
    // not take the place of the first's.
    const call = this.asking.begin(payload.conversationId);

    try {
      const aiResponse = await assistant.chat(payload.conversationId, payload.message, {
        signal: call.signal,
      });

      // Persist conversation to ConfigStore after chat
      const conversation = assistant.getConversation(payload.conversationId);
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
      // Stopped by the user: answered as such, not as a failure to show.
      if (call.signal.aborted) {
        const cancelled = buildResponse(this.deps, msg, 'ai:chat:response', {
          conversationId: payload.conversationId,
          code: 'CANCELLED',
        });
        this.deps.broker.postToWebview(cancelled);
        this.deps.log(`[TX] ai:chat:response cancelled`);
        return;
      }
      const message = extractErrorMessage(err);
      const errResponse = buildResponse(this.deps, msg, 'ai:error', { message });
      this.deps.broker.postToWebview(errResponse);
      this.deps.log(`[TX] ai:error: ${message}`);
    } finally {
      call.end();
    }
  }

  /**
   * Stop the question a conversation waits on. Its `ai:chat` request answers
   * for itself, with code `CANCELLED`; a conversation that waits on nothing
   * is left as it is.
   */
  private handleChatCancel(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(aiConversationIdPayloadSchema, msg, 'ai:error', this.deps);
    if (!parsed) return;
    this.asking.abort(parsed.conversationId);
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

  /** Delete every conversation kept on this machine, and say how many there were. */
  private handleConversationDeleteAll(msg: InboundRequest): void {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const count = this.deleteAllConversations();
    const response = buildResponse(this.deps, msg, 'ai:conversation:deleted-all', { count });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ai:conversation:deleted-all count=${count}`);
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
      // The model `sandforge.ai.model` names, which every AI call asks: the
      // Settings page shows it, and named the default after the user changed
      // it. Blank, the setting names none, and the calls ask the default.
      model: this.aiAssistant
        ? resolveAIModel(
            this.deps.services?.getSandforgeSetting?.<unknown>('ai.model', AI_CONFIG.MODEL),
          )
        : '',
      // One counter for every AI feature, kept for the whole window. The AI
      // page asks for it on mount so its gauge is filled before the next call.
      budget: this.aiAssistant ? this.deps.services?.sessionBudget?.getState() : undefined,
      // What the Settings page offers by: turn AI on or remove the key, and
      // whether a failed run sends its error message.
      hasKey,
      errorResolution:
        this.deps.services?.getSandforgeSetting?.<boolean>(ERROR_RESOLUTION_SETTING, true) ?? true,
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
    await this.writeSetting('ai:save-key', ENABLED_SETTING, true);
  }

  /**
   * Write one `sandforge.ai.*` setting, logging rather than throwing: what the
   * request was for is done, or said in the log, and the status that follows
   * says where AI stands.
   *
   * @returns Whether it was written.
   */
  private async writeSetting(context: string, key: string, value: boolean): Promise<boolean> {
    if (!this.deps.services?.setSandforgeSetting) {
      this.deps.log(`[WARN] ${context}: no settings backend — sandforge.${key} left as-is.`);
      return false;
    }
    try {
      await this.deps.services.setSandforgeSetting(key, value);
      return true;
    } catch (err: unknown) {
      this.deps.log(
        `[ERR] ${context}: writing sandforge.${key} failed: ${extractErrorMessage(err)}`,
      );
      return false;
    }
  }

  /**
   * Rebuild the AI stack so the key just stored is the one used. With
   * `sandforge.ai.enabled` already true, the write in {@link enableAIFeature}
   * raises no configuration event, and the adapter kept the SDK client built
   * with the previous key until a window reload — a wrong key, once saved,
   * could not be corrected. Like that step, a failure is logged and never
   * fails the save.
   */
  private async rebuildAIStack(context = 'ai:save-key'): Promise<void> {
    const reinitAI = this.deps.services?.reinitAI;
    if (!reinitAI) {
      this.deps.log(`[WARN] ${context}: no AI rebuild wired — the change applies after a reload.`);
      return;
    }
    try {
      await reinitAI();
    } catch (err: unknown) {
      this.deps.log(
        `[ERR] ${context}: rebuilding the AI stack failed: ${extractErrorMessage(err)}`,
      );
    }
  }

  private async handleSaveKey(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(aiSaveKeyPayloadSchema, msg, 'ai:error', this.deps);
    if (!parsed) return;
    const { apiKey, errorResolution } = parsed;
    try {
      const hadKey = await this.deps.secretVault.hasSecret(AI_API_KEY_SECRET);
      await this.deps.secretVault.storeSecret(AI_API_KEY_SECRET, apiKey);
      // A failed run sends its error message with nobody pressing anything, so
      // the first key saved does not turn that on by itself: the Settings page
      // asks, and with no answer nothing is sent. Saving a key turned it on
      // with AI, its setting defaulting to true, and nothing on the page said so.
      if (!hadKey || errorResolution !== undefined) {
        await this.writeSetting('ai:save-key', ERROR_RESOLUTION_SETTING, errorResolution === true);
      }
      await this.enableAIFeature();
      await this.rebuildAIStack();
      const response = buildResponse(this.deps, msg, 'ai:save-key:response', {
        success: true,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ai:save-key:response success`);
      // Refresh the availability flag the webview keeps in its store. The
      // rebuild above has finished, so this snapshot reports the assistant it
      // installed.
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
   * `ai:settings`: turn AI on or off, or the fix suggestions for failed runs,
   * from the Settings page, which had no control for either. The stack is
   * rebuilt before the status is sent, so the status says what the write did.
   */
  private async handleSettings(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(aiSettingsPayloadSchema, msg, 'ai:error', this.deps);
    if (!parsed) return;
    const writes: Array<[string, boolean]> = [];
    if (parsed.errorResolution !== undefined) {
      writes.push([ERROR_RESOLUTION_SETTING, parsed.errorResolution]);
    }
    if (parsed.enabled !== undefined) writes.push([ENABLED_SETTING, parsed.enabled]);
    let written = true;
    for (const [key, value] of writes) {
      if (!(await this.writeSetting('ai:settings', key, value))) written = false;
    }
    await this.rebuildAIStack('ai:settings');
    const response = buildResponse(this.deps, msg, 'ai:settings:response', {
      success: written,
      ...(written
        ? {}
        : { error: 'The setting could not be written: the SandForge log says why.' }),
    });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ai:settings:response success=${written}`);
    await this.postStatus(msg);
  }

  /**
   * `ai:remove-key`: take the key out of the secret vault, turn AI off and
   * delete the conversations kept on this machine. Nothing removed the key: a
   * user who stored one to try the chat could not take it back from the panel,
   * nor the conversations, which outlived it.
   */
  private async handleRemoveKey(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    try {
      await this.deps.secretVault.deleteSecret(AI_API_KEY_SECRET);
      // While the assistant is still there, so it lets go of them too.
      const conversationsDeleted = this.deleteAllConversations();
      await this.writeSetting('ai:remove-key', ENABLED_SETTING, false);
      // Taking the key away raises no configuration event: the stack is
      // rebuilt here, and finds no key.
      await this.rebuildAIStack('ai:remove-key');
      const response = buildResponse(this.deps, msg, 'ai:remove-key:response', {
        success: true,
        conversationsDeleted,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ai:remove-key:response conversations=${conversationsDeleted}`);
      await this.postStatus(msg);
    } catch (err: unknown) {
      const message = extractErrorMessage(err);
      this.deps.log(`[ERR] ai:remove-key: ${message}`);
      const response = buildResponse(this.deps, msg, 'ai:remove-key:response', {
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
