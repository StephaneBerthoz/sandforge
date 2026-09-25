import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
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

    const composer = (): string => (screen.getByTestId('chat-input') as HTMLTextAreaElement).value;
    const bubbles = (role: string): Array<string | null> =>
      screen.queryAllByTestId(`message-bubble-${role}`).map((bubble) => bubble.textContent);

    it('leaves the thread and goes back to the composer, with the reason shown', () => {
      render(<AIPage />);
      openConversation();
      const chat = ask('which object holds cases');
      expect(bubbles('user')).toEqual(['which object holds cases']);

      emit('ai:error', { message: 'The model declined to answer this request.' }, chat);

      expect(bubbles('user')).toEqual([]);
      expect(composer()).toBe('which object holds cases');
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
      expect(composer()).toBe('second');
    });

    it('stays in the thread when the error answers another request of the page', () => {
      render(<AIPage />);
      const list = lastSentId(); // the conversation list, asked for on mount
      openConversation();
      ask('which object holds cases');

      emit('ai:error', { message: 'The conversation list could not be read.' }, list);

      expect(bubbles('user')).toEqual(['which object holds cases']);
      expect(composer()).toBe('');
    });
  });
});
