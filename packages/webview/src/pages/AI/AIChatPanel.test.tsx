import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { AIChatPanel } from './AIChatPanel';
import type { ChatMessageDisplay, ConversationSummary } from './AIChatPanel';

const conversations: ConversationSummary[] = [
  { id: 'conv-1', title: 'Seed Help', updatedAt: '2025-01-01T00:00:00Z', messageCount: 3 },
  { id: 'conv-2', title: 'Sync Config', updatedAt: '2025-01-02T00:00:00Z', messageCount: 1 },
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

  it('should call onDeleteConversation when clicking delete', () => {
    const onDelete = vi.fn();
    render(<AIChatPanel conversations={conversations} onDeleteConversation={onDelete} />);
    fireEvent.click(screen.getByTestId('delete-conversation-conv-1'));
    expect(onDelete).toHaveBeenCalledWith('conv-1');
  });

  it('should call onNewConversation when clicking new button', () => {
    const onNew = vi.fn();
    render(<AIChatPanel onNewConversation={onNew} />);
    fireEvent.click(screen.getByTestId('new-conversation-btn'));
    expect(onNew).toHaveBeenCalled();
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
});
