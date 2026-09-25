import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import {
  AIAssistant,
  type AICallFn,
  type AIModelConfig,
  type AICallResult,
  type ChatMessage,
  type ChatRole,
} from './AIAssistant';

const mockConfig: AIModelConfig = {
  provider: 'anthropic',
  model: 'claude-3-sonnet',
  maxTokens: 1024,
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

  // The ids were made of the clock alone: two exchanges in one millisecond
  // stored four messages under two ids, and the page keys each bubble by it.
  it('gives each message of exchanges made in the same millisecond an id of its own', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_750_000_000_000);
    try {
      const conv = assistant.createConversation('Same millisecond');
      await assistant.chat(conv.id, 'Q1');
      await assistant.chat(conv.id, 'Q2');

      const ids = assistant.getConversation(conv.id)?.messages.map((m) => m.id) ?? [];
      expect(ids).toHaveLength(4);
      expect(new Set(ids).size).toBe(4);
      expect(ids[0]).toMatch(/^msg-.+-user$/);
      expect(ids[1]).toMatch(/^msg-.+-assistant$/);
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
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

  // --- What a turn sends ---

  /** The turns of the `call`-th request, without the system prompt. */
  function turnsSent(call: number): Array<{ role: ChatRole; content: string }> {
    return mockCallFn.mock.calls[call][0].filter((m) => m.role !== 'system');
  }

  // A question the model declined stayed in the conversation: the next turn
  // sent it again with the new one, and the answer replied to both.
  it('keeps a question that got no answer out of the conversation and out of the next turn', async () => {
    const conv = assistant.createConversation('Declined');
    mockCallFn.mockRejectedValueOnce(new Error('The model declined to answer this request.'));

    await expect(assistant.chat(conv.id, 'first')).rejects.toThrow('declined');
    expect(assistant.getConversation(conv.id)?.messages).toEqual([]);
    await assistant.chat(conv.id, 'second');

    expect(turnsSent(1)).toEqual([{ role: 'user', content: 'second' }]);
    const kept = assistant.getConversation(conv.id);
    expect(kept?.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'second'],
      ['assistant', 'AI response content'],
    ]);
    expect(kept?.totalTokens).toBe(42);
  });

  // Ten exchanges and a new question make 21 messages: the last 20 opened on
  // the answer to the first question, which the request no longer carried.
  it('starts the history it sends on a question, never on an answer cut from its question', async () => {
    const messages: ChatMessage[] = Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `${i % 2 === 0 ? 'question' : 'answer'} ${Math.floor(i / 2)}`,
      timestamp: '2025-01-01T10:00:00Z',
    }));
    assistant.restoreConversation({
      id: 'conv-long',
      title: 'Ten exchanges',
      messages,
      createdAt: '2025-01-01T10:00:00Z',
      updatedAt: '2025-01-01T10:00:00Z',
      totalTokens: 0,
    });

    await assistant.chat('conv-long', 'question 10');

    const sent = turnsSent(0);
    expect(sent[0]).toEqual({ role: 'user', content: 'question 1' });
    expect(sent).toHaveLength(19);
    expect(sent.at(-1)).toEqual({ role: 'user', content: 'question 10' });
  });

  // --- One question at a time per conversation ---

  describe('a question asked while another waits for its answer', () => {
    const REFUSAL = 'An earlier question in this conversation is still waiting for its answer.';

    /** Calls to the model that answer only when the test says so, in the order they were made. */
    function heldCalls(): Array<(content: string) => void> {
      const answers: Array<(content: string) => void> = [];
      mockCallFn.mockImplementation(
        () =>
          new Promise<AICallResult>((resolve) => {
            answers.push((content) => resolve({ ...mockResult, content }));
          }),
      );
      return answers;
    }

    // A panel closed and opened again while a question waited sent the next
    // one beside it: each went out with a history that lacked the other, and
    // the two exchanges were kept in the order their answers came.
    it('is refused in the same conversation, and neither sent nor kept', async () => {
      const answers = heldCalls();
      const conv = assistant.createConversation('Seed help');

      const first = assistant.chat(conv.id, 'first');
      const second = assistant.chat(conv.id, 'second');
      answers.forEach((answer, i) => answer(`answer ${String(i + 1)}`));

      await expect(second).rejects.toThrow(REFUSAL);
      await expect(first).resolves.toMatchObject({ content: 'answer 1' });
      expect(mockCallFn).toHaveBeenCalledTimes(1);
      expect(assistant.getConversation(conv.id)?.messages.map((m) => [m.role, m.content])).toEqual([
        ['user', 'first'],
        ['assistant', 'answer 1'],
      ]);
    });

    it('is refused in the words the host gives it', async () => {
      const answers = heldCalls();
      const worded = new AIAssistant(mockCallFn, mockConfig, {
        questionPendingMessage: () => 'Une question précédente attend encore sa réponse.',
      });
      const conv = worded.createConversation('Aide');

      const first = worded.chat(conv.id, 'première');
      const second = worded.chat(conv.id, 'seconde');
      answers.forEach((answer) => answer('réponse'));

      await expect(second).rejects.toThrow('Une question précédente attend encore sa réponse.');
      await first;
    });

    it('goes out once the answer has come, with that exchange in its history', async () => {
      const answers = heldCalls();
      const conv = assistant.createConversation('Seed help');
      const first = assistant.chat(conv.id, 'first');
      answers[0]('answer 1');
      await first;

      const second = assistant.chat(conv.id, 'second');
      answers[1]('answer 2');

      await expect(second).resolves.toMatchObject({ content: 'answer 2' });
      expect(turnsSent(1)).toEqual([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer 1' },
        { role: 'user', content: 'second' },
      ]);
    });

    it('goes out once the question before got no answer', async () => {
      mockCallFn.mockRejectedValueOnce(new Error('The model declined to answer this request.'));
      const conv = assistant.createConversation('Declined');

      await expect(assistant.chat(conv.id, 'declined')).rejects.toThrow('declined');

      await expect(assistant.chat(conv.id, 'asked again')).resolves.toMatchObject({
        role: 'assistant',
      });
    });

    it('waits beside a question of another conversation, as before', async () => {
      const answers = heldCalls();
      const seed = assistant.createConversation('Seed');
      const sync = assistant.createConversation('Sync');

      const inSeed = assistant.chat(seed.id, 'how do I seed accounts?');
      const inSync = assistant.chat(sync.id, 'how do I sync contacts?');
      answers[1]('sync answer');
      answers[0]('seed answer');

      await expect(inSeed).resolves.toMatchObject({ content: 'seed answer' });
      await expect(inSync).resolves.toMatchObject({ content: 'sync answer' });
      expect(mockCallFn).toHaveBeenCalledTimes(2);
    });
  });
});
