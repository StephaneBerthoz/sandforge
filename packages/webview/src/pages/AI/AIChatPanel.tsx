import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../components/ui/PageHeader';
import { Button } from '../../components/ui/Button';
import { Card, CardBody } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { Spinner } from '../../components/ui/Spinner';

/** Chat message for display. */
export interface ChatMessageDisplay {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

/** Conversation summary for the list. */
export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

/** Props for the AIChatPanel component. */
export interface AIChatPanelProps {
  conversations?: ConversationSummary[];
  activeConversationId?: string;
  messages?: ChatMessageDisplay[];
  isLoading?: boolean;
  onSendMessage?: (conversationId: string, message: string) => void;
  onNewConversation?: (title: string) => void;
  onSelectConversation?: (conversationId: string) => void;
  onDeleteConversation?: (conversationId: string) => void;
}

/** AI Chat panel with conversation management and message display. */
export const AIChatPanel: React.FC<AIChatPanelProps> = ({
  conversations = [],
  activeConversationId,
  messages = [],
  isLoading = false,
  onSendMessage,
  onNewConversation,
  onSelectConversation,
  onDeleteConversation,
}) => {
  const { t } = useTranslation();
  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof messagesEndRef.current?.scrollIntoView === 'function') {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  const handleSend = () => {
    if (!inputValue.trim() || !activeConversationId || !onSendMessage) return;
    onSendMessage(activeConversationId, inputValue.trim());
    setInputValue('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleNewChat = () => {
    if (!onNewConversation) return;
    onNewConversation(t('ai.newChat', 'New Chat'));
  };

  return (
    <div className="flex flex-col h-full gap-[var(--sf-space-4)] p-[var(--sf-space-4)]" data-testid="ai-chat-panel">
      <PageHeader
        title={t('ai.title', 'AI Assistant')}
        subtitle={t('ai.subtitle', 'Get AI-powered insights for your Salesforce operations')}
        icon="comment-discussion"
      />

      <div className="flex flex-1 gap-[var(--sf-space-4)] min-h-0">
        {/* Conversation sidebar */}
        <div
          className="w-56 shrink-0 flex flex-col gap-[var(--sf-space-2)]"
          data-testid="conversation-sidebar"
        >
          <Button
            variant="primary"
            size="sm"
            onClick={handleNewChat}
            data-testid="new-conversation-btn"
          >
            {t('ai.newConversation', 'New Conversation')}
          </Button>

          <div className="flex-1 overflow-y-auto flex flex-col gap-1" data-testid="conversation-list" aria-label={t('ai.conversations', 'Conversations')}>
            {conversations.length === 0 && (
              <p
                className="text-xs text-[var(--vscode-descriptionForeground,#868686)] px-2 py-4 text-center"
                data-testid="no-conversations"
              >
                {t('ai.noConversations', 'No conversations yet')}
              </p>
            )}
            {conversations.map((conv) => (
              <div
                key={conv.id}
                tabIndex={0}
                className={`flex items-center justify-between w-full px-2 py-1.5 text-xs rounded text-left transition-colors ${
                  conv.id === activeConversationId
                    ? 'bg-[var(--vscode-list-activeSelectionBackground,#094771)] text-[var(--vscode-list-activeSelectionForeground,#fff)]'
                    : 'text-[var(--vscode-editor-foreground,#d4d4d4)] hover:bg-[var(--vscode-list-hoverBackground,#2a2d2e)]'
                }`}
                onClick={() => onSelectConversation?.(conv.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectConversation?.(conv.id);
                  }
                }}
                data-testid={`conversation-item-${conv.id}`}
              >
                <span className="truncate flex-1">{conv.title}</span>
                <span
                  className="shrink-0 ml-1 cursor-pointer opacity-60 hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteConversation?.(conv.id);
                  }}
                  data-testid={`delete-conversation-${conv.id}`}
                  tabIndex={0}
                  aria-label={t('common.delete', 'Delete')}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onDeleteConversation?.(conv.id); } }}
                >
                  x
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Chat area */}
        <div className="flex-1 flex flex-col min-h-0">
          {!activeConversationId ? (
            <EmptyState
              icon="comment-discussion"
              title={t('ai.selectOrCreate', 'Select or create a conversation')}
              description={t('ai.startDescription', 'Start a new conversation to get AI-powered help')}
              data-testid="chat-empty-state"
            />
          ) : (
            <>
              {/* Messages */}
              <Card className="flex-1 min-h-0 overflow-y-auto mb-[var(--sf-space-2)]">
                <CardBody>
                  <div className="flex flex-col gap-[var(--sf-space-3)]" data-testid="messages-container">
                    {messages.length === 0 && (
                      <p
                        className="text-sm text-[var(--vscode-descriptionForeground,#868686)] text-center py-8"
                        data-testid="no-messages"
                      >
                        {t('ai.noMessages', 'Send a message to start the conversation')}
                      </p>
                    )}
                    {messages.map((msg) => (
                      <div
                        key={msg.id}
                        className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                        data-testid={`message-${msg.id}`}
                      >
                        <div
                          className={`max-w-[80%] px-3 py-2 rounded-lg text-sm whitespace-pre-wrap ${
                            msg.role === 'user'
                              ? 'bg-[var(--vscode-button-background,#0e639c)] text-[var(--vscode-button-foreground,#fff)]'
                              : 'bg-[var(--vscode-editor-inactiveSelectionBackground,#3a3d41)] text-[var(--vscode-editor-foreground,#d4d4d4)]'
                          }`}
                          data-testid={`message-bubble-${msg.role}`}
                        >
                          {msg.content}
                        </div>
                      </div>
                    ))}
                    {isLoading && (
                      <div className="flex justify-start" data-testid="loading-indicator">
                        <div className="px-3 py-2">
                          <Spinner size="sm" />
                        </div>
                      </div>
                    )}
                    <div ref={messagesEndRef} />
                  </div>
                </CardBody>
              </Card>

              {/* Input area */}
              <div className="flex gap-[var(--sf-space-2)]" data-testid="chat-input-area">
                <textarea
                  className="flex-1 px-3 py-2 text-sm rounded border resize-none
                    bg-[var(--vscode-input-background,#3c3c3c)]
                    text-[var(--vscode-input-foreground,#ccc)]
                    border-[var(--vscode-input-border,#3c3c3c)]
                    focus:border-[var(--vscode-focusBorder,#007fd4)] outline-none"
                  rows={2}
                  placeholder={t('ai.placeholder', 'Type a message... (Enter to send, Shift+Enter for new line)')}
                  aria-label={t('ai.placeholder', 'Type a message... (Enter to send, Shift+Enter for new line)')}
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  data-testid="chat-input"
                  disabled={isLoading}
                />
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleSend}
                  disabled={!inputValue.trim() || isLoading}
                  data-testid="send-btn"
                >
                  {t('ai.send', 'Send')}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
