import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AIProviderStatusMessage,
  AIBudgetStateMessage,
  AIConversationListResponse,
  AIStatusResponse,
} from '@sandforge/shared';
import { PageHeader } from '../../components/ui/PageHeader';
import { Button } from '../../components/ui/Button';
import { Card, CardBody } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { Spinner } from '../../components/ui/Spinner';
import { useMessageListener, useSendMessage } from '../../hooks/useMessageBus';
import { buildMessage } from '../../bridge/messageHelpers';
import { AIProviderStatusBanner, type AIProviderState } from './components/AIProviderStatusBanner';
import { TokenBudgetIndicator, type TokenBudgetState } from './components/TokenBudgetIndicator';

/** Chat message for display. */
export interface ChatMessageDisplay {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

/** Conversation summary for the list: one entry of the host's persisted index. */
export type ConversationSummary = AIConversationListResponse['payload']['conversations'][number];

/** Props for the AIChatPanel component. */
export interface AIChatPanelProps {
  conversations?: ConversationSummary[];
  activeConversationId?: string;
  messages?: ChatMessageDisplay[];
  /** The conversation open awaits the answer to its question. */
  isLoading?: boolean;
  /**
   * The title of another conversation whose question awaits its answer. The
   * page asks one question at a time, so the composer stays locked here, and
   * the thread says which conversation the wait is for.
   */
  waitingElsewhere?: string;
  /** A conversation whose question was answered while this one was open. */
  answeredElsewhere?: { conversationId: string; title: string };
  onDismissAnsweredElsewhere?: () => void;
  /** Last failure reported by the host, shown until dismissed or superseded. */
  errorMessage?: string;
  onDismissError?: () => void;
  onSendMessage?: (conversationId: string, message: string) => void;
  onNewConversation?: (title: string) => void;
  onSelectConversation?: (conversationId: string) => void;
  onDeleteConversation?: (conversationId: string) => void;
  /**
   * The composer's text, when the page keeps it: the page puts back a question
   * the host could not answer. Given with {@link onDraftChange}; left out, the
   * panel keeps the text itself.
   */
  draft?: string;
  onDraftChange?: (text: string) => void;
}

/** AI Chat panel with conversation management and message display. */
export const AIChatPanel: React.FC<AIChatPanelProps> = ({
  conversations = [],
  activeConversationId,
  messages = [],
  isLoading = false,
  waitingElsewhere,
  answeredElsewhere,
  onDismissAnsweredElsewhere,
  errorMessage,
  onDismissError,
  onSendMessage,
  onNewConversation,
  onSelectConversation,
  onDeleteConversation,
  draft,
  onDraftChange,
}) => {
  const { t } = useTranslation();
  const [ownDraft, setOwnDraft] = useState('');
  const inputValue = draft ?? ownDraft;
  const setInputValue = onDraftChange ?? setOwnDraft;
  const composerLocked = isLoading || waitingElsewhere !== undefined;
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [providerStatus, setProviderStatus] = useState<{
    provider: 'anthropic' | 'openai' | 'custom';
    state: AIProviderState;
    cooldownEndsAt?: string;
    userMessageKey?: string;
  } | null>(null);

  useMessageListener<AIProviderStatusMessage>('ai:provider:status', (msg) => {
    setProviderStatus(msg.payload);
  });

  const sendMessage = useSendMessage();
  const [budgetState, setBudgetState] = useState<TokenBudgetState | null>(null);
  useMessageListener<AIBudgetStateMessage>('ai:budget:state', (msg) => setBudgetState(msg.payload));
  // The budget outlives this panel. Ask the host for it on mount rather than
  // wait for the next AI call to push it; a status without one changes nothing.
  useMessageListener<AIStatusResponse>('ai:status:response', (msg) => {
    if (msg.payload.budget) setBudgetState(msg.payload.budget);
  });
  useEffect(() => {
    sendMessage(buildMessage('ai:status'));
  }, [sendMessage]);

  useEffect(() => {
    if (typeof messagesEndRef.current?.scrollIntoView === 'function') {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  const handleSend = () => {
    if (composerLocked || !inputValue.trim() || !activeConversationId || !onSendMessage) return;
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
    <div
      className="flex flex-col h-full gap-(--sf-space-4) p-(--sf-space-4)"
      data-testid="ai-chat-panel"
    >
      <PageHeader
        title={t('ai.title', 'AI Assistant')}
        subtitle={t('ai.subtitle', 'Get AI-powered insights for your Salesforce operations')}
        icon="comment-discussion"
      />

      {budgetState && (
        <div className="flex justify-end">
          <TokenBudgetIndicator state={budgetState} />
        </div>
      )}

      {providerStatus && (
        <AIProviderStatusBanner
          provider={providerStatus.provider}
          state={providerStatus.state}
          cooldownEndsAt={providerStatus.cooldownEndsAt}
          userMessageKey={providerStatus.userMessageKey}
        />
      )}

      {errorMessage && (
        <ErrorBanner
          message={errorMessage}
          onDismiss={onDismissError}
          data-testid="ai-error-banner"
        />
      )}

      {answeredElsewhere && (
        <div
          role="status"
          className="flex items-center gap-2 px-3 py-2 text-sm border-l-4 border-(--sf-accent) bg-status-info/10 text-text-primary"
          data-testid="ai-answered-elsewhere"
        >
          <span className="flex-1 min-w-0">
            {t('ai.answeredIn', { title: answeredElsewhere.title })}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onSelectConversation?.(answeredElsewhere.conversationId)}
            data-testid="ai-answered-elsewhere-open"
          >
            {t('ai.openConversation')}
          </Button>
          {onDismissAnsweredElsewhere && (
            <button
              type="button"
              className="shrink-0 px-1"
              onClick={onDismissAnsweredElsewhere}
              aria-label={t('common.dismiss', 'Dismiss')}
            >
              {'\u2715'}
            </button>
          )}
        </div>
      )}

      <div className="flex flex-1 gap-(--sf-space-4) min-h-0">
        {/* Conversation sidebar */}
        <div
          className="w-56 shrink-0 flex flex-col gap-(--sf-space-2)"
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

          <div
            className="flex-1 overflow-y-auto flex flex-col gap-1"
            data-testid="conversation-list"
            aria-label={t('ai.conversations', 'Conversations')}
          >
            {conversations.length === 0 && (
              <p
                className="text-xs text-text-secondary px-2 py-4 text-center"
                data-testid="no-conversations"
              >
                {t('ai.noConversations', 'No conversations yet')}
              </p>
            )}
            {conversations.map((conv) => (
              // Two buttons side by side rather than one div pretending to
              // be a button with a second div inside it pretending to be
              // another. A native button brings its own focus, its own
              // Enter and Space, and its own role — all of which were being
              // rebuilt here by hand, and none of which a screen reader was
              // being told about.
              <div
                key={conv.id}
                className={`flex items-center justify-between w-full rounded transition-colors ${
                  conv.id === activeConversationId
                    ? 'bg-(--sf-bg-active) text-(--sf-text-active)'
                    : 'text-text-primary hover:bg-(--sf-bg-hover)'
                }`}
              >
                <button
                  type="button"
                  className="truncate flex-1 min-w-0 px-2 py-1.5 text-xs text-left"
                  onClick={() => onSelectConversation?.(conv.id)}
                  aria-current={conv.id === activeConversationId ? 'true' : undefined}
                  data-testid={`conversation-item-${conv.id}`}
                >
                  {conv.title}
                </button>
                <button
                  type="button"
                  className="shrink-0 mr-1 px-1 py-1.5 text-xs"
                  onClick={() => onDeleteConversation?.(conv.id)}
                  data-testid={`delete-conversation-${conv.id}`}
                  aria-label={t('common.delete', 'Delete')}
                >
                  x
                </button>
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
              description={t(
                'ai.startDescription',
                'Start a new conversation to get AI-powered help',
              )}
              data-testid="chat-empty-state"
            />
          ) : (
            <>
              {/* Messages */}
              <Card className="flex-1 min-h-0 overflow-y-auto mb-(--sf-space-2)">
                <CardBody>
                  <div
                    className="flex flex-col gap-(--sf-space-3)"
                    data-testid="messages-container"
                  >
                    {messages.length === 0 && (
                      <p
                        className="text-sm text-text-secondary text-center py-8"
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
                              ? 'bg-(--sf-button-bg) text-(--sf-button-fg)'
                              : 'bg-(--sf-bg-inactive-selection) text-text-primary'
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
                    {waitingElsewhere !== undefined && (
                      <p
                        className="text-xs text-text-secondary text-center py-2"
                        role="status"
                        data-testid="ai-waiting-elsewhere"
                      >
                        {t('ai.waitingIn', { title: waitingElsewhere })}
                      </p>
                    )}
                    <div ref={messagesEndRef} />
                  </div>
                </CardBody>
              </Card>

              {/* Input area */}
              <div className="flex gap-(--sf-space-2)" data-testid="chat-input-area">
                <textarea
                  className="flex-1 px-3 py-2 text-sm rounded border resize-none
                    bg-(--sf-bg-input)
                    text-(--sf-text-input)
                    border-(--sf-border-input)
                    focus:border-(--sf-accent) outline-hidden"
                  rows={2}
                  placeholder={t(
                    'ai.placeholder',
                    'Type a message... (Enter to send, Shift+Enter for new line)',
                  )}
                  aria-label={t(
                    'ai.placeholder',
                    'Type a message... (Enter to send, Shift+Enter for new line)',
                  )}
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  data-testid="chat-input"
                  disabled={composerLocked}
                />
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleSend}
                  disabled={!inputValue.trim() || composerLocked}
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
