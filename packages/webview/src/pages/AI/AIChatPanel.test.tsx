import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

const mockPostMessage = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

import '../../i18n';
import en from '../../i18n/locales/en.json';
import { AIChatPanel } from './AIChatPanel';
import type { ChatMessageDisplay, ConversationSummary } from './AIChatPanel';

const conversations: ConversationSummary[] = [
  { id: 'conv-1', title: 'Seed Help', createdAt: '2025-01-01T00:00:00Z', messageCount: 3 },
  { id: 'conv-2', title: 'Sync Config', createdAt: '2025-01-02T00:00:00Z', messageCount: 1 },
];

const messages: ChatMessageDisplay[] = [
  {
    id: 'msg-1',
    role: 'user',
    content: 'How do I seed Account?',
    timestamp: '2025-01-01T00:00:00Z',
  },
  {
    id: 'msg-2',
    role: 'assistant',
    content: 'You can use the Seed wizard.',
    timestamp: '2025-01-01T00:00:01Z',
  },
];

describe('AIChatPanel', () => {
  it('should render the panel', () => {
    render(<AIChatPanel />);
    expect(screen.getByTestId('ai-chat-panel')).toBeDefined();
  });

  it('should show new conversation button', () => {
    render(<AIChatPanel />);
    expect(screen.getByTestId('new-conversation-btn')).toBeDefined();
  });

  it('should show no-conversations message when list is empty', () => {
    render(<AIChatPanel conversations={[]} />);
    expect(screen.getByTestId('no-conversations')).toBeDefined();
  });

  it('should render conversation list', () => {
    render(<AIChatPanel conversations={conversations} />);
    expect(screen.getByTestId('conversation-item-conv-1')).toBeDefined();
    expect(screen.getByTestId('conversation-item-conv-2')).toBeDefined();
  });

  it('should call onSelectConversation when clicking a conversation', () => {
    const onSelect = vi.fn();
    render(<AIChatPanel conversations={conversations} onSelectConversation={onSelect} />);
    fireEvent.click(screen.getByTestId('conversation-item-conv-1'));
    expect(onSelect).toHaveBeenCalledWith('conv-1');
  });

  it('deletes a conversation only once asked, naming it, the focus on Cancel', () => {
    // A bare "x" beside each title deleted at the first click, while "Delete
    // all" asked first.
    const onDelete = vi.fn();
    render(<AIChatPanel conversations={conversations} onDeleteConversation={onDelete} />);

    fireEvent.click(screen.getByTestId('delete-conversation-conv-1'));

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByTestId('delete-conversation-question-conv-1').textContent).toContain(
      'Delete the conversation “Seed Help”? It cannot be brought back.',
    );
    expect(document.activeElement).toBe(screen.getByTestId('delete-conversation-cancel-conv-1'));
    fireEvent.click(screen.getByTestId('delete-conversation-cancel-conv-1'));
    expect(screen.queryByTestId('delete-conversation-question-conv-1')).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByTestId('delete-conversation-conv-1'));

    fireEvent.click(screen.getByTestId('delete-conversation-conv-1'));
    fireEvent.click(screen.getByTestId('delete-conversation-confirm-conv-1'));
    expect(onDelete).toHaveBeenCalledWith('conv-1');
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('draws each delete as an icon named after its conversation', () => {
    render(<AIChatPanel conversations={conversations} />);
    const remove = screen.getByRole('button', { name: 'Delete “Sync Config”' });
    expect(remove).toBe(screen.getByTestId('delete-conversation-conv-2'));
    expect(remove.textContent).toBe('');
    expect(remove.querySelector('svg')).not.toBeNull();
  });

  it('shows under each title when the conversation was last written to', () => {
    vi.useFakeTimers({ now: new Date('2025-01-03T12:00:00Z'), toFake: ['Date'] });
    render(
      <AIChatPanel
        conversations={[
          { ...conversations[0], updatedAt: '2025-01-03T10:00:00Z' },
          // Kept before the time it was written to was recorded: its creation.
          conversations[1],
        ]}
      />,
    );
    expect(screen.getByTestId('conversation-when-conv-1').textContent).toBe('2 hours ago');
    expect(screen.getByTestId('conversation-when-conv-2').textContent).toBe('yesterday');
    expect(screen.getByTestId('conversation-item-conv-1').textContent).toBe('Seed Help2 hours ago');
    vi.useRealTimers();
  });

  it('names the conversation it makes as its button does', () => {
    // The button said "New Conversation", each conversation it made "New Chat".
    const onNew = vi.fn();
    render(<AIChatPanel onNewConversation={onNew} />);
    const button = screen.getByTestId('new-conversation-btn');
    fireEvent.click(button);
    expect(button.textContent).toBe('New conversation');
    expect(onNew).toHaveBeenCalledWith('New conversation');
  });

  it('says in its subtitle that it sees none of the orgs, and what to paste', () => {
    render(<AIChatPanel />);
    expect(screen.getByText(en.ai.subtitle)).toBeDefined();
    expect(en.ai.subtitle).toContain('It does not see your orgs');
    expect(screen.getByTestId('empty-state').textContent).toContain(
      'Paste the error, query or field names your question is about.',
    );
  });

  it('should show empty state when no active conversation', () => {
    render(<AIChatPanel />);
    expect(screen.getByText(/Select or create a conversation/i)).toBeDefined();
  });

  it('should show messages when conversation is active', () => {
    render(<AIChatPanel activeConversationId="conv-1" messages={messages} />);
    expect(screen.getByTestId('message-msg-1')).toBeDefined();
    expect(screen.getByTestId('message-msg-2')).toBeDefined();
  });

  it('should show user message bubble aligned right', () => {
    render(<AIChatPanel activeConversationId="conv-1" messages={messages} />);
    const userBubbles = screen.getAllByTestId('message-bubble-user');
    expect(userBubbles).toHaveLength(1);
    expect(userBubbles[0].textContent).toBe('How do I seed Account?');
  });

  it('should show assistant message bubble aligned left', () => {
    render(<AIChatPanel activeConversationId="conv-1" messages={messages} />);
    const assistantBubbles = screen.getAllByTestId('message-bubble-assistant');
    expect(assistantBubbles).toHaveLength(1);
    expect(assistantBubbles[0].textContent).toBe('You can use the Seed wizard.');
  });

  describe('an answer holding a ``` block', () => {
    const answer: ChatMessageDisplay = {
      id: 'msg-3',
      role: 'assistant',
      content:
        "Here's the SOQL:\n```sql\nSELECT Id, Name FROM Account\n```\nIt returns every **account**.",
      timestamp: '2025-01-01T00:00:02Z',
    };
    const writeText = vi.fn<(text: string) => Promise<void>>();

    afterEach(() => {
      vi.useRealTimers();
      writeText.mockReset();
    });

    it('shows the block as code, without its fences, between the text as written', () => {
      // The bubble printed the Markdown as it came: the query between two
      // literal "```sql" lines.
      render(<AIChatPanel activeConversationId="conv-1" messages={[answer]} />);
      const bubble = screen.getByTestId('message-bubble-assistant');

      const code = bubble.querySelector('pre > code');
      expect(code?.textContent).toBe('SELECT Id, Name FROM Account');
      expect(bubble.textContent).not.toContain('```');
      expect(bubble.textContent).toContain("Here's the SOQL:");
      // Text stays text: nothing is parsed into HTML, its markup included.
      expect(bubble.textContent).toContain('It returns every **account**.');
      expect(bubble.querySelector('strong, b')).toBeNull();
    });

    it('copies the code alone, and says it was copied', async () => {
      writeText.mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      });
      render(<AIChatPanel activeConversationId="conv-1" messages={[answer]} />);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
      });

      expect(writeText).toHaveBeenCalledWith('SELECT Id, Name FROM Account');
      expect(screen.getByTestId('answer-code-copy').textContent).toBe('Code copied');
      expect(screen.getByRole('status').textContent).toBe('Code copied');
    });

    it('claims no copy the host refused', async () => {
      writeText.mockRejectedValue(new Error('denied'));
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      });
      render(<AIChatPanel activeConversationId="conv-1" messages={[answer]} />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('answer-code-copy'));
      });

      expect(screen.getByTestId('answer-code-copy').textContent).toBe('Copy code');
    });

    it('leaves a question the user typed with fences as typed', () => {
      const question: ChatMessageDisplay = { ...answer, id: 'msg-4', role: 'user' };
      render(<AIChatPanel activeConversationId="conv-1" messages={[question]} />);
      const bubble = screen.getByTestId('message-bubble-user');
      expect(bubble.textContent).toBe(question.content);
      expect(bubble.querySelector('pre')).toBeNull();
    });
  });

  it('keeps the messages in a log that says each one added, the speaker named in words', () => {
    // No live region: a reply arrived silently. Told apart by alignment and colour alone.
    render(<AIChatPanel activeConversationId="conv-1" messages={messages} />);
    const log = screen.getByRole('log', { name: 'Conversation' });
    expect(log).toBe(screen.getByTestId('messages-container'));
    expect(log.getAttribute('aria-live')).toBe('polite');
    expect(log.getAttribute('aria-relevant')).toBe('additions');
    expect(screen.getByTestId('message-msg-1').textContent).toBe('You:How do I seed Account?');
    expect(screen.getByTestId('message-msg-2').textContent).toBe(
      'Assistant:You can use the Seed wizard.',
    );
  });

  it('draws the log afresh for another conversation, so its history is not read out', () => {
    const { rerender } = render(<AIChatPanel activeConversationId="conv-1" messages={messages} />);
    const first = screen.getByRole('log');
    rerender(<AIChatPanel activeConversationId="conv-2" messages={messages} />);
    expect(screen.getByRole('log')).not.toBe(first);
  });

  it('should show no-messages when conversation has no messages', () => {
    render(<AIChatPanel activeConversationId="conv-1" messages={[]} />);
    expect(screen.getByTestId('no-messages')).toBeDefined();
  });

  it('should show loading indicator', () => {
    render(<AIChatPanel activeConversationId="conv-1" isLoading />);
    expect(screen.getByTestId('loading-indicator')).toBeDefined();
  });

  it('should show input area when conversation is active', () => {
    render(<AIChatPanel activeConversationId="conv-1" />);
    expect(screen.getByTestId('chat-input')).toBeDefined();
    expect(screen.getByTestId('send-btn')).toBeDefined();
  });

  it('should call onSendMessage when send button clicked', () => {
    const onSend = vi.fn();
    render(<AIChatPanel activeConversationId="conv-1" onSendMessage={onSend} />);
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: 'Hello' } });
    fireEvent.click(screen.getByTestId('send-btn'));
    expect(onSend).toHaveBeenCalledWith('conv-1', 'Hello');
  });

  it('should clear input after sending', () => {
    const onSend = vi.fn();
    render(<AIChatPanel activeConversationId="conv-1" onSendMessage={onSend} />);
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Hello' } });
    fireEvent.click(screen.getByTestId('send-btn'));
    expect(input.value).toBe('');
  });

  it('should not send empty messages', () => {
    const onSend = vi.fn();
    render(<AIChatPanel activeConversationId="conv-1" onSendMessage={onSend} />);
    fireEvent.click(screen.getByTestId('send-btn'));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('should send on Enter key', () => {
    const onSend = vi.fn();
    render(<AIChatPanel activeConversationId="conv-1" onSendMessage={onSend} />);
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: 'Hello' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    expect(onSend).toHaveBeenCalledWith('conv-1', 'Hello');
  });

  it('should not send on Shift+Enter', () => {
    const onSend = vi.fn();
    render(<AIChatPanel activeConversationId="conv-1" onSendMessage={onSend} />);
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: 'Hello' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('should disable input and send button when loading', () => {
    render(<AIChatPanel activeConversationId="conv-1" isLoading />);
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    const sendBtn = screen.getByTestId('send-btn') as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
  });

  it('offers Stop in place of Send while the question here waits, and stops it', () => {
    const onCancel = vi.fn();
    render(<AIChatPanel activeConversationId="conv-1" isLoading onCancel={onCancel} />);

    expect(screen.queryByTestId('send-btn')).toBeNull();
    fireEvent.click(screen.getByTestId('stop-btn'));

    expect(screen.getByTestId('stop-btn').textContent).toBe('Stop');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('offers no Stop once nothing waits here, nor for a question of another conversation', () => {
    const { rerender } = render(<AIChatPanel activeConversationId="conv-1" onCancel={vi.fn()} />);
    expect(screen.queryByTestId('stop-btn')).toBeNull();
    expect(screen.getByTestId('send-btn')).toBeDefined();

    rerender(
      <AIChatPanel activeConversationId="conv-2" waitingElsewhere="Seed Help" onCancel={vi.fn()} />,
    );
    expect(screen.queryByTestId('stop-btn')).toBeNull();
  });

  // The page asks one question at a time: while one awaits its answer in
  // another conversation, the composer of this one sends nothing, Enter
  // included, and the thread says which conversation the wait is for.
  it('sends nothing while a question awaits its answer in another conversation', () => {
    const onSend = vi.fn();
    render(
      <AIChatPanel
        activeConversationId="conv-2"
        waitingElsewhere="Seed Help"
        onSendMessage={onSend}
        draft="Hello"
        onDraftChange={vi.fn()}
      />,
    );
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

    expect(onSend).not.toHaveBeenCalled();
    expect(input.disabled).toBe(true);
    expect((screen.getByTestId('send-btn') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('ai-waiting-elsewhere').textContent).toBe(
      'Waiting for the answer to your question in “Seed Help”.',
    );
    expect(screen.queryByTestId('loading-indicator')).toBeNull();
  });

  it('shows the token budget indicator once an ai:budget:state arrives', () => {
    render(<AIChatPanel />);
    expect(screen.queryByTestId('ai-token-budget-indicator')).toBeNull();

    fireEvent(
      window,
      new MessageEvent('message', {
        data: {
          id: 'budget-1',
          type: 'ai:budget:state',
          timestamp: Date.now(),
          payload: {
            sessionId: 'ai-session-1',
            used: { input: 40_000, output: 0, cacheRead: 0, cacheCreate: 0, total: 40_000 },
            budget: 50_000,
            percent: 80,
            state: 'warn',
          },
        },
      }),
    );

    const indicator = screen.getByTestId('ai-token-budget-indicator');
    expect(indicator.getAttribute('data-state')).toBe('warn');
    expect(screen.getByTestId('ai-token-budget-label').textContent).toBe('40000/50000');
  });

  const budgetSnapshot = {
    sessionId: 'ai-window',
    used: { input: 40_000, output: 0, cacheRead: 0, cacheCreate: 0, total: 40_000 },
    budget: 50_000,
    percent: 80,
    state: 'warn' as const,
  };

  function pushStatus(budget?: typeof budgetSnapshot): void {
    fireEvent(
      window,
      new MessageEvent('message', {
        data: {
          id: 'status-1',
          type: 'ai:status:response',
          timestamp: Date.now(),
          payload: { enabled: true, provider: 'anthropic', model: 'm', budget },
        },
      }),
    );
  }

  /** Types of the messages the panel posted to the host. */
  function sentTypes(): string[] {
    return mockPostMessage.mock.calls.map(
      ([envelope]) => (envelope as { payload?: { type?: string } }).payload?.type ?? '',
    );
  }

  // The gauge lived only in the panel's own state, so leaving the AI page and
  // coming back hid it until the next AI call.
  it('shows the gauge again after a remount, from the status the host answers with', () => {
    const first = render(<AIChatPanel />);
    pushStatus(budgetSnapshot);
    expect(screen.getByTestId('ai-token-budget-indicator')).toBeDefined();
    first.unmount();
    mockPostMessage.mockClear();

    render(<AIChatPanel />);

    expect(sentTypes()).toContain('ai:status');
    expect(screen.queryByTestId('ai-token-budget-indicator')).toBeNull();
    pushStatus(budgetSnapshot);
    expect(screen.getByTestId('ai-token-budget-label').textContent).toBe('40000/50000');
  });

  it('keeps the gauge when a status push carries no budget', () => {
    render(<AIChatPanel />);
    pushStatus(budgetSnapshot);

    pushStatus(undefined);

    expect(screen.getByTestId('ai-token-budget-indicator')).toBeDefined();
  });
});
