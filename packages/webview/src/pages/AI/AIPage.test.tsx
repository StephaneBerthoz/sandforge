import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import '../../i18n';
import { AIPage } from './AIPage';
import { useAppStore } from '../../stores/useAppStore';

/** Captured bus: lets a test push a host message to the listener under test. */
const bus = vi.hoisted(() => {
  let counter = 0;
  return {
    send: vi.fn(),
    listeners: new Map<string, (msg: unknown) => void>(),
    nextId: () => ++counter,
  };
});

// Mock useSendMessage to avoid side effects
vi.mock('../../hooks/useMessageBus', () => ({
  useSendMessage: () => bus.send,
  useMessageListener: (type: string, handler: (msg: unknown) => void) => {
    bus.listeners.set(type, handler);
  },
}));

/** Deliver a host message to the component's listener for that type. */
function emit(type: string, payload: unknown, correlationId?: string): void {
  const handler = bus.listeners.get(type);
  if (!handler) throw new Error(`no listener registered for ${type}`);
  act(() => handler({ id: 'm', type, timestamp: Date.now(), payload, correlationId }));
}

/** The id of the request the page sent last — what its answer will name. */
function lastSentId(): string {
  const calls = bus.send.mock.calls;
  if (!calls.length) throw new Error('the page sent nothing');
  return (calls[calls.length - 1][0] as { id: string }).id;
}

vi.mock('../../bridge/messageHelpers', () => ({
  buildMessage: vi.fn((type: string, payload: unknown) => ({
    id: `wv-${bus.nextId()}`,
    type,
    payload,
  })),
}));

/** Payloads of the requests of `type` the page sent, oldest first. */
function sentOfType(type: string): unknown[] {
  return bus.send.mock.calls
    .map(([msg]) => msg as { type: string; payload: unknown })
    .filter((msg) => msg.type === type)
    .map((msg) => msg.payload);
}

/** Ask `question` in the conversation open, and return the id of the chat request. */
function ask(question: string): string {
  fireEvent.change(screen.getByTestId('chat-input'), { target: { value: question } });
  fireEvent.click(screen.getByTestId('send-btn'));
  return lastSentId();
}

function openConversation(): void {
  emit('ai:conversation:created', {
    conversation: { id: 'conv-1', title: 'T', createdAt: '2025-01-01T00:00:00Z' },
  });
}

const composer = (): HTMLTextAreaElement => screen.getByTestId('chat-input');
const bubbles = (role: string): Array<string | null> =>
  screen.queryAllByTestId(`message-bubble-${role}`).map((bubble) => bubble.textContent);

/** The conversation list, as the host answers it. */
function listConversations(): void {
  emit('ai:conversation:list:response', {
    conversations: [
      { id: 'conv-1', title: 'Cases', createdAt: '2025-01-01T00:00:00Z', messageCount: 0 },
      { id: 'conv-2', title: 'Leads', createdAt: '2025-01-02T00:00:00Z', messageCount: 2 },
    ],
  });
}

/** Open `id` from the list, and answer its load with `messages`. */
function open(id: string, messages: unknown[] = []): void {
  fireEvent.click(screen.getByTestId(`conversation-item-${id}`));
  emit('ai:conversation:loaded', { conversation: { id, title: id, messages } });
}

const LEADS = [
  { id: 'l1', role: 'user', content: 'where do leads go', timestamp: '2025-01-02' },
  { id: 'l2', role: 'assistant', content: 'Lead', timestamp: '2025-01-02' },
];

/** The host's answer in `conversationId`. */
function answer(conversationId: string, content: string): unknown {
  return {
    conversationId,
    message: { id: `a-${content}`, role: 'assistant', content, timestamp: '2025-01-03' },
  };
}

describe('AIPage', () => {
  beforeEach(() => {
    bus.send.mockClear();
    bus.listeners.clear();
    useAppStore.setState({ aiAvailable: false });
  });

  describe('when AI is not configured', () => {
    it('should show not-configured guidance', () => {
      render(<AIPage />);
      expect(screen.getByTestId('ai-not-configured')).toBeDefined();
    });

    it('should show guidance title', () => {
      render(<AIPage />);
      expect(screen.getByText(/AI Assistant Not Configured/i)).toBeDefined();
    });

    it('should show guidance description', () => {
      render(<AIPage />);
      expect(screen.getByText(/configure your API key in Settings/i)).toBeDefined();
    });

    it('should show a button to navigate to settings', () => {
      render(<AIPage />);
      const button = screen.getByTestId('empty-action-button');
      expect(button).toBeDefined();
      expect(button.textContent).toMatch(/Go to Settings/i);
    });

    it('should navigate to settings when button is clicked', () => {
      const navigateSpy = vi.fn();
      useAppStore.setState({ aiAvailable: false, navigate: navigateSpy });
      render(<AIPage />);
      const button = screen.getByTestId('empty-action-button');
      fireEvent.click(button);
      expect(navigateSpy).toHaveBeenCalledWith('settings');
    });

    it('should not show the chat panel', () => {
      render(<AIPage />);
      expect(screen.queryByTestId('ai-chat-panel')).toBeNull();
    });
  });

  describe('when AI is configured', () => {
    beforeEach(() => {
      useAppStore.setState({ aiAvailable: true });
    });

    it('should render the AI chat panel', () => {
      render(<AIPage />);
      expect(screen.getByTestId('ai-chat-panel')).toBeDefined();
    });

    it('should show new conversation button', () => {
      render(<AIPage />);
      expect(screen.getByTestId('new-conversation-btn')).toBeDefined();
    });

    it('should show empty conversations initially', () => {
      render(<AIPage />);
      expect(screen.getByTestId('no-conversations')).toBeDefined();
    });

    it('should show empty state when no conversation selected', () => {
      render(<AIPage />);
      expect(screen.getByText(/Select or create a conversation/i)).toBeDefined();
    });

    it('should not show the not-configured guidance', () => {
      render(<AIPage />);
      expect(screen.queryByTestId('ai-not-configured')).toBeNull();
    });
  });

  describe('when the host reports an error', () => {
    beforeEach(() => {
      useAppStore.setState({ aiAvailable: true });
    });

    it('should show the error message sent by the host', () => {
      render(<AIPage />);

      emit('ai:error', { message: 'Conversation conv-old not found' }, lastSentId());

      expect(screen.getByTestId('ai-error-banner').textContent).toContain(
        'Conversation conv-old not found',
      );
    });

    it('should fall back to a translated message when the host sends none', () => {
      render(<AIPage />);

      emit('ai:error', {}, lastSentId());

      expect(screen.getByTestId('ai-error-banner').textContent).toMatch(/Unexpected AI error/i);
    });

    it('should let the user dismiss the error', () => {
      render(<AIPage />);
      emit('ai:error', { message: 'AI provider unreachable' }, lastSentId());

      fireEvent.click(screen.getByLabelText(/dismiss/i));

      expect(screen.queryByTestId('ai-error-banner')).toBeNull();
    });

    it('should clear the error when a new conversation is opened', () => {
      render(<AIPage />);
      emit('ai:error', { message: 'AI provider unreachable' }, lastSentId());

      fireEvent.click(screen.getByTestId('new-conversation-btn'));

      expect(screen.queryByTestId('ai-error-banner')).toBeNull();
    });

    it('clears the error when the user sends a message', () => {
      render(<AIPage />);
      emit('ai:conversation:created', {
        conversation: { id: 'conv-1', title: 'T', createdAt: '2025-01-01T00:00:00Z' },
      });
      emit('ai:error', { message: 'AI provider unreachable' }, lastSentId());
      expect(screen.getByTestId('ai-error-banner')).toBeDefined();

      fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'again' } });
      fireEvent.click(screen.getByTestId('send-btn'));

      expect(screen.queryByTestId('ai-error-banner')).toBeNull();
    });

    it('clears the error when the user opens another conversation', () => {
      render(<AIPage />);
      emit('ai:conversation:list:response', {
        conversations: [
          { id: 'conv-1', title: 'First', createdAt: '2025-01-01T00:00:00Z', messageCount: 2 },
          { id: 'conv-2', title: 'Second', createdAt: '2025-01-02T00:00:00Z', messageCount: 0 },
        ],
      });
      emit('ai:error', { message: 'Conversation conv-old not found' }, lastSentId());
      expect(screen.getByTestId('ai-error-banner')).toBeDefined();

      fireEvent.click(screen.getByTestId('conversation-item-conv-2'));

      expect(screen.queryByTestId('ai-error-banner')).toBeNull();
    });

    /**
     * `ai:error` answers every AI channel and the host sends it to every open
     * panel: a schema advice that failed in Compare must not surface here.
     */
    it('ignores an error that answers a request another page sent', () => {
      render(<AIPage />);

      emit('ai:error', { message: 'Schema advice failed' }, 'wv-from-another-panel');

      expect(screen.queryByTestId('ai-error-banner')).toBeNull();
    });

    it('ignores an error that names no request', () => {
      render(<AIPage />);

      emit('ai:error', { message: 'AI provider unreachable' });

      expect(screen.queryByTestId('ai-error-banner')).toBeNull();
    });

    it('should stop the loading indicator', () => {
      render(<AIPage />);
      emit('ai:conversation:created', {
        conversation: { id: 'conv-1', title: 'T', createdAt: '2025-01-01T00:00:00Z' },
      });
      fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'hello' } });
      fireEvent.click(screen.getByTestId('send-btn'));
      expect(screen.getByTestId('loading-indicator')).toBeDefined();

      emit('ai:error', { message: 'AI provider unreachable' }, lastSentId());

      expect(screen.queryByTestId('loading-indicator')).toBeNull();
    });
  });

  // The host keeps a question that got no answer out of the conversation and
  // out of the next turn. Left in the thread, it read as part of what the next
  // answer replied to, and a reload made it vanish.
  describe('a question the host could not answer', () => {
    beforeEach(() => {
      useAppStore.setState({ aiAvailable: true });
    });

    it('leaves the thread and goes back to the composer, with the reason shown', () => {
      render(<AIPage />);
      openConversation();
      const chat = ask('which object holds cases');
      expect(bubbles('user')).toEqual(['which object holds cases']);

      emit('ai:error', { message: 'The model declined to answer this request.' }, chat);

      expect(bubbles('user')).toEqual([]);
      expect(composer().value).toBe('which object holds cases');
      expect(screen.getByTestId('ai-error-banner').textContent).toContain('declined');
    });

    it('takes nothing else from the thread', () => {
      render(<AIPage />);
      openConversation();
      emit('ai:conversation:loaded', {
        conversation: {
          id: 'conv-1',
          title: 'T',
          messages: [
            { id: 'h1', role: 'user', content: 'first', timestamp: '2025-01-01' },
            { id: 'h2', role: 'assistant', content: 'answer', timestamp: '2025-01-01' },
          ],
        },
      });
      const second = ask('second');

      emit('ai:error', { message: 'AI provider circuit breaker open.' }, second);

      expect(bubbles('user')).toEqual(['first']);
      expect(bubbles('assistant')).toEqual(['answer']);
      expect(composer().value).toBe('second');
    });

    it('stays in the thread when the error answers another request of the page', () => {
      render(<AIPage />);
      const list = lastSentId(); // the conversation list, asked for on mount
      openConversation();
      ask('which object holds cases');

      emit('ai:error', { message: 'The conversation list could not be read.' }, list);

      expect(bubbles('user')).toEqual(['which object holds cases']);
      expect(composer().value).toBe('');
    });
  });

  // An answer went to whatever thread was open when it came: asked in one
  // conversation and answered while another was open, it joined the other.
  describe('an answer that comes while another conversation is open', () => {
    beforeEach(() => {
      useAppStore.setState({ aiAvailable: true });
    });

    /** Ask in Cases, then open Leads while the question waits. */
    function askInCasesThenOpenLeads(): string {
      render(<AIPage />);
      listConversations();
      open('conv-1');
      const chat = ask('which object holds cases');
      open('conv-2', LEADS);
      return chat;
    }

    it('stays out of the thread open, which says where it went', () => {
      const chat = askInCasesThenOpenLeads();

      emit('ai:chat:response', answer('conv-1', 'Case'), chat);

      expect(bubbles('user')).toEqual(['where do leads go']);
      expect(bubbles('assistant')).toEqual(['Lead']);
      expect(screen.getByTestId('ai-answered-elsewhere').textContent).toContain('Cases');
      expect(composer().disabled).toBe(false);
    });

    it('opens the conversation it names, and the notice goes', () => {
      const chat = askInCasesThenOpenLeads();
      emit('ai:chat:response', answer('conv-1', 'Case'), chat);
      bus.send.mockClear();

      fireEvent.click(screen.getByTestId('ai-answered-elsewhere-open'));

      expect(sentOfType('ai:conversation:load')).toEqual([{ conversationId: 'conv-1' }]);
      expect(screen.queryByTestId('ai-answered-elsewhere')).toBeNull();
    });

    it('leaves the conversation open where it is when the notice is dismissed', () => {
      const chat = askInCasesThenOpenLeads();
      emit('ai:chat:response', answer('conv-1', 'Case'), chat);
      bus.send.mockClear();

      fireEvent.click(
        within(screen.getByTestId('ai-answered-elsewhere')).getByRole('button', {
          name: /dismiss/i,
        }),
      );

      expect(screen.queryByTestId('ai-answered-elsewhere')).toBeNull();
      expect(sentOfType('ai:conversation:load')).toEqual([]);
      expect(bubbles('assistant')).toEqual(['Lead']);
    });

    it('takes the notice away with the conversation it names, once deleted', () => {
      const chat = askInCasesThenOpenLeads();
      emit('ai:chat:response', answer('conv-1', 'Case'), chat);

      fireEvent.click(screen.getByTestId('delete-conversation-conv-1'));

      expect(screen.queryByTestId('ai-answered-elsewhere')).toBeNull();
    });

    // The host keeps a question out of the conversation until its answer comes:
    // reopened in the meantime, the thread lost it, and the answer came alone.
    it('comes after its question in its own conversation, reopened while it was awaited', () => {
      const chat = askInCasesThenOpenLeads();
      open('conv-1', []);
      expect(bubbles('user')).toEqual(['which object holds cases']);
      expect(screen.getByTestId('loading-indicator')).toBeDefined();

      emit('ai:chat:response', answer('conv-1', 'Case'), chat);

      expect(bubbles('user')).toEqual(['which object holds cases']);
      expect(bubbles('assistant')).toEqual(['Case']);
      expect(screen.queryByTestId('ai-answered-elsewhere')).toBeNull();
    });

    it('comes after its question when it arrives before the thread reopened for it has loaded', () => {
      const chat = askInCasesThenOpenLeads();
      fireEvent.click(screen.getByTestId('conversation-item-conv-1'));

      emit('ai:chat:response', answer('conv-1', 'Case'), chat);

      expect(bubbles('user')).toEqual(['which object holds cases']);
      expect(bubbles('assistant')).toEqual(['Case']);
    });

    // Put back in the composer open, the question was one Send away from
    // being asked in a conversation it was never part of.
    it('when it is an error, gives the question back in its own conversation only', () => {
      const chat = askInCasesThenOpenLeads();

      emit('ai:error', { message: 'The model declined to answer this request.' }, chat);

      expect(composer().value).toBe('');
      expect(screen.getByTestId('ai-error-banner').textContent).toContain('Cases');
      expect(screen.getByTestId('ai-error-banner').textContent).toContain('declined');
      open('conv-1', []);
      expect(composer().value).toBe('which object holds cases');
      expect(bubbles('user')).toEqual([]);
    });

    it('names no conversation the user deleted while it was awaited', () => {
      const chat = askInCasesThenOpenLeads();
      fireEvent.click(screen.getByTestId('delete-conversation-conv-1'));

      emit('ai:chat:response', answer('conv-1', 'Case'), chat);

      expect(screen.queryByTestId('ai-answered-elsewhere')).toBeNull();
      expect(bubbles('assistant')).toEqual(['Lead']);
      expect(composer().disabled).toBe(false);
    });
  });

  // Any error for one of the page's requests ended the wait of the question
  // in flight: the composer unlocked, and a second question could go out
  // beside the first.
  describe('a question awaiting its answer', () => {
    beforeEach(() => {
      useAppStore.setState({ aiAvailable: true });
    });

    it('keeps waiting when another request of the page fails', () => {
      render(<AIPage />);
      const list = lastSentId(); // the conversation list, asked for on mount
      openConversation();
      const chat = ask('which object holds cases');

      emit('ai:error', { message: 'The conversation list could not be read.' }, list);

      expect(screen.getByTestId('ai-error-banner').textContent).toContain('could not be read');
      expect(screen.getByTestId('loading-indicator')).toBeDefined();
      expect(composer().disabled).toBe(true);

      emit('ai:chat:response', answer('conv-1', 'Case'), chat);

      expect(screen.queryByTestId('loading-indicator')).toBeNull();
      expect(composer().disabled).toBe(false);
      expect(bubbles('assistant')).toEqual(['Case']);
    });

    it('keeps waiting when an answer comes to a request it did not send', () => {
      render(<AIPage />);
      openConversation();
      ask('which object holds cases');

      emit('ai:chat:response', answer('conv-1', 'stray'), 'wv-from-another-panel');

      expect(bubbles('assistant')).toEqual([]);
      expect(screen.getByTestId('loading-indicator')).toBeDefined();
      expect(composer().disabled).toBe(true);
    });

    it('keeps the composer of another conversation locked, and says which one waits', () => {
      render(<AIPage />);
      listConversations();
      open('conv-1');
      ask('which object holds cases');
      fireEvent.click(screen.getByTestId('conversation-item-conv-2'));

      emit('ai:error', { message: 'Conversation conv-2 not found.' }, lastSentId());

      expect(composer().disabled).toBe(true);
      expect((screen.getByTestId('send-btn') as HTMLButtonElement).disabled).toBe(true);
      expect(screen.queryByTestId('loading-indicator')).toBeNull();
      expect(screen.getByTestId('ai-waiting-elsewhere').textContent).toContain('Cases');
    });
  });

  // The id of a question's bubble was the clock's millisecond: two made in
  // the same one shared a React key.
  it('gives two questions asked in the same millisecond ids of their own', () => {
    useAppStore.setState({ aiAvailable: true });
    vi.spyOn(Date, 'now').mockReturnValue(1_750_000_000_000);
    try {
      render(<AIPage />);
      openConversation();
      const first = ask('first');
      emit('ai:chat:response', answer('conv-1', 'one'), first);
      ask('second');

      const rows = screen
        .getAllByTestId('message-bubble-user')
        .map((bubble) => bubble.parentElement?.getAttribute('data-testid'));
      expect(rows).toHaveLength(2);
      expect(new Set(rows).size).toBe(2);
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
  });
});
