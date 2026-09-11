/** AI provider type. */
export type AIProviderType = 'anthropic' | 'openai' | 'custom' | 'none';

/** AI model configuration. */
export interface AIModelConfig {
  provider: AIProviderType;
  model: string;
  apiKey: string;
  maxTokens: number;
  temperature: number;
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

/** Token usage stats. */
export interface TokenUsageStats {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCalls: number;
  averageLatencyMs: number;
}

/** AI provider call function abstraction. */
export type AICallFn = (
  messages: Array<{ role: ChatRole; content: string }>,
  config: AIModelConfig,
) => Promise<AICallResult>;

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
  private readonly stats: TokenUsageStats = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCalls: 0,
    averageLatencyMs: 0,
  };

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
   * @param conversationId - The conversation to continue
   * @param userMessage - The user's message
   * @returns The AI response message
   */
  async chat(conversationId: string, userMessage: string): Promise<ChatMessage> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    // Add user message
    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}-user`,
      role: 'user',
      content: userMessage,
      timestamp: new Date().toISOString(),
    };
    conversation.messages.push(userMsg);

    // Build message array for API call
    const apiMessages: Array<{ role: ChatRole; content: string }> = [
      { role: 'system', content: this.buildSystemPrompt(conversation.context) },
    ];

    // Add conversation history (trimmed to last 20 messages)
    const recentMessages = conversation.messages.slice(-20);
    for (const msg of recentMessages) {
      apiMessages.push({ role: msg.role, content: msg.content });
    }

    // Call AI provider
    const start = Date.now();
    const result = await this.callFn(apiMessages, this.config);
    const durationMs = Date.now() - start;

    // Create assistant message
    const assistantMsg: ChatMessage = {
      id: `msg-${Date.now()}-assistant`,
      role: 'assistant',
      content: result.content,
      timestamp: new Date().toISOString(),
      tokenCount: result.tokenCount,
    };

    conversation.messages.push(assistantMsg);
    conversation.totalTokens += result.tokenCount;
    conversation.updatedAt = new Date().toISOString();

    // Update stats
    this.stats.totalOutputTokens += result.tokenCount;
    this.stats.totalCalls += 1;
    this.stats.averageLatencyMs =
      (this.stats.averageLatencyMs * (this.stats.totalCalls - 1) + durationMs) /
      this.stats.totalCalls;

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
   * Get token usage statistics.
   * @returns Usage stats
   */
  getUsageStats(): TokenUsageStats {
    return { ...this.stats };
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
