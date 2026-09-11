import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { AIAssistant, type AICallFn, type AIModelConfig, type AICallResult } from './AIAssistant';

const mockConfig: AIModelConfig = {
  provider: 'anthropic',
  model: 'claude-3-sonnet',
  apiKey: 'test-key',
  maxTokens: 1024,
  temperature: 0.7,
};

const mockResult: AICallResult = {
  content: 'AI response content',
  tokenCount: 42,
  model: 'claude-3-sonnet',
  durationMs: 200,
};

describe('AIAssistant', () => {
  let mockCallFn: Mock<AICallFn>;
  let assistant: AIAssistant;

  beforeEach(() => {
    mockCallFn = vi.fn<AICallFn>().mockResolvedValue(mockResult);
    assistant = new AIAssistant(mockCallFn, mockConfig);
  });

  // --- Conversation management ---

  it('should create a new conversation', () => {
    const conv = assistant.createConversation('Test Chat');
    expect(conv.id).toMatch(/^conv-/);
    expect(conv.title).toBe('Test Chat');
    expect(conv.messages).toEqual([]);
    expect(conv.totalTokens).toBe(0);
    expect(conv.createdAt).toBeDefined();
  });

  it('should create conversation with context', () => {
    const conv = assistant.createConversation('Seed Help', 'Seeding Account records');
    expect(conv.context).toBe('Seeding Account records');
  });

  it('should generate unique conversation IDs', () => {
    const a = assistant.createConversation('A');
    const b = assistant.createConversation('B');
    expect(a.id).not.toBe(b.id);
  });

  it('should list conversations', () => {
    assistant.createConversation('First');
    assistant.createConversation('Second');
    const list = assistant.listConversations();
    expect(list).toHaveLength(2);
    expect(list[0].title).toBe('First');
    expect(list[1].title).toBe('Second');
  });

  it('should get conversation by ID', () => {
    const conv = assistant.createConversation('Find Me');
    const found = assistant.getConversation(conv.id);
    expect(found).toBeDefined();
    expect(found?.title).toBe('Find Me');
  });

  it('should return undefined for unknown conversation', () => {
    expect(assistant.getConversation('does-not-exist')).toBeUndefined();
  });

  it('should delete a conversation', () => {
    const conv = assistant.createConversation('To Delete');
    expect(assistant.deleteConversation(conv.id)).toBe(true);
    expect(assistant.getConversation(conv.id)).toBeUndefined();
  });

  it('should return false when deleting non-existent conversation', () => {
    expect(assistant.deleteConversation('nope')).toBe(false);
  });

  it('should chat on a conversation it never created but was handed back', async () => {
    assistant.restoreConversation({
      id: 'conv-from-storage',
      title: 'Yesterday',
      messages: [
        { id: 'm1', role: 'user', content: 'first', timestamp: '2025-01-01T10:00:00Z' },
        {
          id: 'm2',
          role: 'assistant',
          content: 'answer',
          timestamp: '2025-01-01T10:00:01Z',
          tokenCount: 7,
        },
      ],
      createdAt: '2025-01-01T10:00:00Z',
      updatedAt: '2025-01-01T10:00:01Z',
      totalTokens: 7,
    });

    await assistant.chat('conv-from-storage', 'second');

    const sent = mockCallFn.mock.calls[0][0].filter((m) => m.role !== 'system');
    expect(sent).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'second' },
    ]);
    expect(assistant.getConversation('conv-from-storage')?.totalTokens).toBe(49);
  });

  it('should clear all conversations', () => {
    assistant.createConversation('A');
    assistant.createConversation('B');
    assistant.clearAll();
    expect(assistant.listConversations()).toHaveLength(0);
  });

  // --- Chat ---

  it('should send a chat message and get a response', async () => {
    const conv = assistant.createConversation('Chat Test');
    const response = await assistant.chat(conv.id, 'Hello AI');

    expect(response.role).toBe('assistant');
    expect(response.content).toBe('AI response content');
    expect(response.tokenCount).toBe(42);
    expect(response.id).toMatch(/^msg-.*-assistant$/);
  });

  it('should add user and assistant messages to conversation', async () => {
    const conv = assistant.createConversation('History Test');
    await assistant.chat(conv.id, 'First question');

    const updated = assistant.getConversation(conv.id);
    expect(updated?.messages).toHaveLength(2);
    expect(updated?.messages[0].role).toBe('user');
    expect(updated?.messages[0].content).toBe('First question');
    expect(updated?.messages[1].role).toBe('assistant');
  });

  it('should track total tokens in conversation', async () => {
    const conv = assistant.createConversation('Token Test');
    await assistant.chat(conv.id, 'Q1');
    await assistant.chat(conv.id, 'Q2');

    const updated = assistant.getConversation(conv.id);
    expect(updated?.totalTokens).toBe(84);
  });

  it('should pass system prompt and messages to callFn', async () => {
    const conv = assistant.createConversation('Prompt Test');
    await assistant.chat(conv.id, 'Tell me about Account');

    expect(mockCallFn).toHaveBeenCalledTimes(1);
    const args = mockCallFn.mock.calls[0];
    const messages = args[0];
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('SandForge AI Assistant');
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toBe('Tell me about Account');
  });

  it('should inject context into system prompt', async () => {
    const conv = assistant.createConversation('Context Test', 'Working with Contact object');
    await assistant.chat(conv.id, 'Help me');

    const messages = mockCallFn.mock.calls[0][0];
    expect(messages[0].content).toContain('Working with Contact object');
  });

  it('should throw for unknown conversation ID', async () => {
    await expect(assistant.chat('invalid-id', 'Hello')).rejects.toThrow(
      'Conversation invalid-id not found',
    );
  });

  it('should pass config to callFn', async () => {
    const conv = assistant.createConversation('Config Test');
    await assistant.chat(conv.id, 'Hi');

    const passedConfig = mockCallFn.mock.calls[0][1];
    expect(passedConfig).toEqual(mockConfig);
  });

  // --- Complete ---

  it('should perform a one-shot completion', async () => {
    const result = await assistant.complete('Generate 10 Account names');
    expect(result).toBe('AI response content');
    expect(mockCallFn).toHaveBeenCalledTimes(1);
  });

  it('should use default system prompt for complete', async () => {
    await assistant.complete('Question');
    const messages = mockCallFn.mock.calls[0][0];
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('SandForge AI Assistant');
  });

  it('should use custom system context for complete', async () => {
    await assistant.complete('Question', 'Custom context only');
    const messages = mockCallFn.mock.calls[0][0];
    expect(messages[0].content).toBe('Custom context only');
  });

  // --- Domain-specific methods ---

  it('should generate field rule suggestions', async () => {
    const fields = [
      { apiName: 'Name', type: 'string', label: 'Account Name', required: true },
      { apiName: 'Industry', type: 'picklist', label: 'Industry', required: false },
    ];

    const result = await assistant.suggestFieldRules('Account', fields);
    expect(result).toBe('AI response content');

    const messages = mockCallFn.mock.calls[0][0];
    const userPrompt = messages[1].content;
    expect(userPrompt).toContain('Account');
    expect(userPrompt).toContain('Name (string, required)');
    expect(userPrompt).toContain('Industry (picklist, optional)');
    expect(userPrompt).toContain('JSON');
  });

  it('should analyze sync configuration', async () => {
    const result = await assistant.analyzeSyncConfig(
      'Source: Prod, Target: Sandbox, Objects: Account, Contact',
    );
    expect(result).toBe('AI response content');

    const messages = mockCallFn.mock.calls[0][0];
    expect(messages[1].content).toContain('Source: Prod');
    expect(messages[1].content).toContain('Conflict resolution');
  });

  // --- Usage stats ---

  it('should track usage statistics', async () => {
    const conv = assistant.createConversation('Stats Test');
    await assistant.chat(conv.id, 'Q1');
    await assistant.complete('Q2');

    const stats = assistant.getUsageStats();
    expect(stats.totalCalls).toBe(2);
    expect(stats.totalOutputTokens).toBe(84);
    expect(stats.averageLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('should return initial empty stats', () => {
    const stats = assistant.getUsageStats();
    expect(stats.totalCalls).toBe(0);
    expect(stats.totalOutputTokens).toBe(0);
    expect(stats.totalInputTokens).toBe(0);
    expect(stats.averageLatencyMs).toBe(0);
  });

  it('should return a copy of stats', () => {
    const stats = assistant.getUsageStats();
    stats.totalCalls = 999;
    expect(assistant.getUsageStats().totalCalls).toBe(0);
  });
});
