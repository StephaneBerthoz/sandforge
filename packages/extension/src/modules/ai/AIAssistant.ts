/** AI provider type. */
export type AIProviderType = 'anthropic' | 'openai' | 'custom' | 'none';

/**
 * AI model configuration.
 *
 * It holds no temperature: every model from Claude Opus 4.7 on, Claude Sonnet 5
 * among them, answers a non-default `temperature`, `top_p` or `top_k` with a
 * 400, and no request ever carried the one this held. Nor the API key: the
 * adapter reads it from secret storage, and the copy kept here went to every
 * call function, which never read it.
 */
export interface AIModelConfig {
  provider: AIProviderType;
  model: string;
  maxTokens: number;
  baseUrl?: string;
}

/** Chat message role. */
export type ChatRole = 'user' | 'assistant' | 'system';

/** Chat message. */
export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  timestamp: string;
  tokenCount?: number;
}

/** Conversation session. */
export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  context?: string;
  createdAt: string;
  updatedAt: string;
  totalTokens: number;
}

/** AI call result. */
export interface AICallResult {
  content: string;
  tokenCount: number;
  model: string;
  durationMs: number;
}

/** AI provider call function abstraction. */
export type AICallFn = (
  messages: Array<{ role: ChatRole; content: string }>,
  config: AIModelConfig,
) => Promise<AICallResult>;

/**
 * The messages a turn sends, its new question last: the last 20, opening on a
 * question. Ten exchanges and a new question opened the window on the first
 * answer, cut from the question it replied to, and a history whose first turn
 * is the assistant's is one the API may refuse.
 */
function historyToSend(messages: ChatMessage[]): ChatMessage[] {
  const recent = messages.slice(-20);
  const firstQuestion = recent.findIndex((m) => m.role === 'user');
  return firstQuestion > 0 ? recent.slice(firstQuestion) : recent;
}

/** Default system prompt for SandForge assistant. */
const SYSTEM_PROMPT = `You are SandForge AI Assistant, an expert in Salesforce data management.
You help users with:
- Seed data generation strategies and field configuration
- Sync configuration between Salesforce orgs
- Data quality analysis and recommendations
- Pipeline automation design
- GDPR compliance and data anonymization

Always provide concise, actionable answers. When suggesting configurations,
use the exact field API names and Salesforce conventions.
Format code and configurations clearly.`;

/**
 * AI Assistant service that manages conversations,
 * provider abstraction, and context-aware prompting
 * for SandForge operations.
 */
export class AIAssistant {
  private readonly conversations: Map<string, Conversation> = new Map();
  private readonly callFn: AICallFn;
  private readonly config: AIModelConfig;
  private conversationCounter = 0;

  constructor(callFn: AICallFn, config: AIModelConfig) {
    this.callFn = callFn;
    this.config = config;
  }

  /**
   * Create a new conversation.
   * @param title - Conversation title
   * @param context - Optional domain-specific context to inject
   * @returns The new conversation
   */
  createConversation(title: string, context?: string): Conversation {
    this.conversationCounter += 1;
    const id = `conv-${Date.now()}-${this.conversationCounter}`;
    const now = new Date().toISOString();

    const conversation: Conversation = {
      id,
      title,
      messages: [],
      context,
      createdAt: now,
      updatedAt: now,
      totalTokens: 0,
    };

    this.conversations.set(id, conversation);
    return conversation;
  }

  /**
   * Hold an already-existing conversation in memory, id and history intact.
   *
   * Conversations outlive this object: they are persisted by the caller and
   * this map starts empty on every VS Code restart, and again whenever an
   * `sandforge.ai.*` setting change rebuilds the assistant. Without a way
   * back in, a stored conversation could only be read, never continued —
   * `chat()` would reject its own id as unknown.
   *
   * @param conversation - The conversation to put back in memory.
   * @returns The conversation now held in memory.
   */
  restoreConversation(conversation: Conversation): Conversation {
    this.conversations.set(conversation.id, conversation);
    return conversation;
  }

  /**
   * Send a user message and get an AI response.
   *
   * The question joins the conversation with its answer, once the answer has
   * come. A question that got none — declined, cut off, empty, or a failed
   * call — is left out: kept, it went out again with the next question, and
   * the answer that came back replied to both.
   *
   * @param conversationId - The conversation to continue
   * @param userMessage - The user's message
   * @returns The AI response message
   */
  async chat(conversationId: string, userMessage: string): Promise<ChatMessage> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}-user`,
      role: 'user',
      content: userMessage,
      timestamp: new Date().toISOString(),
    };

    const apiMessages: Array<{ role: ChatRole; content: string }> = [
      { role: 'system', content: this.buildSystemPrompt(conversation.context) },
      ...historyToSend([...conversation.messages, userMsg]).map((msg) => ({
        role: msg.role,
        content: msg.content,
      })),
    ];

    // Call AI provider
    const result = await this.callFn(apiMessages, this.config);

    // Create assistant message
    const assistantMsg: ChatMessage = {
      id: `msg-${Date.now()}-assistant`,
      role: 'assistant',
      content: result.content,
      timestamp: new Date().toISOString(),
      tokenCount: result.tokenCount,
    };

    conversation.messages.push(userMsg, assistantMsg);
    conversation.totalTokens += result.tokenCount;
    conversation.updatedAt = new Date().toISOString();

    return assistantMsg;
  }

  /**
   * Get a specific conversation.
   * @param conversationId - The conversation ID
   * @returns The conversation or undefined
   */
  getConversation(conversationId: string): Conversation | undefined {
    return this.conversations.get(conversationId);
  }

  /**
   * List all conversations.
   * @returns Array of all conversations
   */
  listConversations(): Conversation[] {
    return Array.from(this.conversations.values());
  }

  /**
   * Delete a conversation.
   * @param conversationId - The conversation ID
   * @returns True if deleted
   */
  deleteConversation(conversationId: string): boolean {
    return this.conversations.delete(conversationId);
  }

  /**
   * Clear all conversations.
   */
  clearAll(): void {
    this.conversations.clear();
  }

  private buildSystemPrompt(context?: string): string {
    if (!context) return SYSTEM_PROMPT;
    return `${SYSTEM_PROMPT}\n\nCurrent context:\n${context}`;
  }
}
