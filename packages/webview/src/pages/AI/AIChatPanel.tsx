import React, { useCallback, useId, useState, useRef, useEffect } from 'react';
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
import { Icon } from '../../components/ui/Icon';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { Spinner } from '../../components/ui/Spinner';
import { useMessageListener, useSendMessage } from '../../hooks/useMessageBus';
import { buildMessage } from '../../bridge/messageHelpers';
import { AIProviderStatusBanner, type AIProviderState } from './components/AIProviderStatusBanner';
import { TokenBudgetIndicator, type TokenBudgetState } from './components/TokenBudgetIndicator';
import { ModuleHowTo } from '../../components/ui/ModuleHowTo';
import { formatRelativeTime, formatStoredDate } from '../../utils/formatters';
import { answerParts } from './answerParts';

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
  /** Stop waiting for the answer to the question this conversation asked. */
  onCancel?: () => void;
  onNewConversation?: (title: string) => void;
  onSelectConversation?: (conversationId: string) => void;
  onDeleteConversation?: (conversationId: string) => void;
  /** Delete every conversation kept on this machine, once asked to confirm. */
  onDeleteAllConversations?: () => void;
  /**
   * The composer's text, when the page keeps it: the page puts back a question
   * the host could not answer. Given with {@link onDraftChange}; left out, the
   * panel keeps the text itself.
   */
  draft?: string;
  onDraftChange?: (text: string) => void;
}

/**
 * The code of a ``` block of an answer, with a Copy that copies the code and
 * nothing else. Wrapped rather than scrolled: a block that scrolls sideways
 * is a region the keyboard cannot reach.
 */
const AnswerCode: React.FC<{ code: string }> = ({ code }) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );
  const copy = useCallback(() => {
    const clipboard: Clipboard | undefined = navigator.clipboard;
    if (!clipboard) return;
    void clipboard.writeText(code).then(
      () => {
        setCopied(true);
        if (resetTimer.current) clearTimeout(resetTimer.current);
        resetTimer.current = setTimeout(() => setCopied(false), 2000);
      },
      () => {
        // Refused by the host: no copy is claimed that never happened.
      },
    );
  }, [code]);
  return (
    <div className="flex flex-col gap-1" data-testid="answer-code">
      <div className="flex justify-end">
        <Button variant="secondary" size="sm" onClick={copy} data-testid="answer-code-copy">
          {copied ? t('ai.codeCopied') : t('ai.copyCode')}
        </Button>
      </div>
      <pre className="m-0 whitespace-pre-wrap break-words rounded-sm bg-(--sf-bg-input) p-2 font-mono text-xs text-(--sf-text-input)">
        {/* The colours of the field it sits on, not VS Code's own for a
            `code`: its preformat colour on its preformat background read
            4.3:1 under Dark+. */}
        <code className="bg-transparent text-inherit">{code}</code>
      </pre>
      <span role="status" className="sr-only">
        {copied ? t('ai.codeCopied') : ''}
      </span>
    </div>
  );
};

/**
 * An answer as plain text, its ``` blocks set apart as code. The bubble
 * printed the model's Markdown as it came, fences and all; no part of it is
 * ever turned into HTML.
 */
const AnswerContent: React.FC<{ content: string }> = ({ content }) => {
  const parts = answerParts(content);
  if (!parts.some((part) => part.kind === 'code')) {
    return <span className="whitespace-pre-wrap">{content}</span>;
  }
  return (
    <div className="flex flex-col gap-2">
      {parts.map((part, index) =>
        part.kind === 'code' ? (
          <AnswerCode key={index} code={part.code} />
        ) : (
          <p key={index} className="m-0 whitespace-pre-wrap break-words">
            {part.text}
          </p>
        ),
      )}
    </div>
  );
};

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
  onCancel,
  onNewConversation,
  onSelectConversation,
  onDeleteConversation,
  onDeleteAllConversations,
  draft,
  onDraftChange,
}) => {
  const { t } = useTranslation();
  /** Deleting every conversation cannot be taken back, so it asks first. */
  const [confirmingDeleteAll, setConfirmingDeleteAll] = useState(false);
  const deleteAllQuestionId = useId();
  /**
   * The conversation whose deletion is asked: a bare "x" beside each title
   * deleted it at the first click, while "Delete all" asked first.
   */
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const deleteQuestionId = useId();
  /** The asked deletion's Cancel, which takes the focus as the question opens. */
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirmingDelete !== null) cancelDeleteRef.current?.focus();
  }, [confirmingDelete]);
  /** Each conversation's delete button, which a cancelled question gives the focus back to. */
  const deleteButtons = useRef(new Map<string, HTMLButtonElement>());
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

  // The button and the conversation it makes bear one name, until the first
  // answer names the conversation after its question.
  const handleNewChat = () => {
    if (!onNewConversation) return;
    onNewConversation(t('ai.newConversation'));
  };

  return (
    <div
      className="flex flex-col h-full gap-(--sf-space-4) p-(--sf-space-4)"
      data-testid="ai-chat-panel"
    >
      {/* Said where it is always in view: the chat sees none of the orgs, and
          "AI-powered insights for your Salesforce operations" read as if it
          did. */}
      <PageHeader
        title={t('ai.title', 'AI Assistant')}
        subtitle={t('ai.subtitle')}
        icon="comment-discussion"
      />
      <ModuleHowTo module="ai" />
      {/* What leaves the machine and what stays on it, said where the
          conversations are: nothing on the page said either. */}
      <p className="text-xs text-text-secondary" data-testid="ai-privacy-note">
        {t('ai.privacyNote')}
      </p>

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
            {t('ai.newConversation')}
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
            {conversations.map((conv) => {
              const active = conv.id === activeConversationId;
              // When it was last written to, under its title: fifty
              // conversations kept, and nothing but a title to tell them by.
              const when = formatStoredDate(conv.updatedAt ?? conv.createdAt, (date) =>
                formatRelativeTime(date),
              );
              return (
                <React.Fragment key={conv.id}>
                  {/* Two buttons side by side rather than one div pretending to
                      be a button with a second div inside it pretending to be
                      another. A native button brings its own focus, its own
                      Enter and Space, and its own role — all of which were
                      being rebuilt here by hand, and none of which a screen
                      reader was being told about. */}
                  <div
                    className={`flex items-center justify-between w-full rounded transition-colors ${
                      active
                        ? 'bg-(--sf-bg-active) text-(--sf-text-active)'
                        : 'text-text-primary hover:bg-(--sf-bg-hover)'
                    }`}
                  >
                    <button
                      type="button"
                      className="flex-1 min-w-0 px-2 py-1.5 text-xs text-left"
                      onClick={() => onSelectConversation?.(conv.id)}
                      aria-current={active ? 'true' : undefined}
                      data-testid={`conversation-item-${conv.id}`}
                    >
                      <span className="block truncate">{conv.title}</span>
                      {when && (
                        // In the row's own colour: the secondary one read under
                        // 4.5:1 on the hover background of three themes.
                        <span
                          className="block truncate"
                          data-testid={`conversation-when-${conv.id}`}
                        >
                          {when}
                        </span>
                      )}
                    </button>
                    <button
                      ref={(button) => {
                        if (button) deleteButtons.current.set(conv.id, button);
                        else deleteButtons.current.delete(conv.id);
                      }}
                      type="button"
                      className="shrink-0 mr-1 px-1 py-1.5 text-xs"
                      onClick={() => setConfirmingDelete(conv.id)}
                      data-testid={`delete-conversation-${conv.id}`}
                      aria-label={t('ai.deleteConversation', { title: conv.title })}
                      title={t('ai.deleteConversation', { title: conv.title })}
                    >
                      <Icon name="trash" />
                    </button>
                  </div>
                  {confirmingDelete === conv.id && (
                    <div
                      className="flex flex-col gap-1 px-2 py-1"
                      data-testid={`delete-conversation-question-${conv.id}`}
                    >
                      <p id={deleteQuestionId} className="text-xs text-text-primary">
                        {t('ai.deleteConfirm', { title: conv.title })}
                      </p>
                      <div className="flex gap-2">
                        <Button
                          variant="danger"
                          size="sm"
                          aria-describedby={deleteQuestionId}
                          onClick={() => {
                            setConfirmingDelete(null);
                            onDeleteConversation?.(conv.id);
                          }}
                          data-testid={`delete-conversation-confirm-${conv.id}`}
                        >
                          {t('common.delete')}
                        </Button>
                        <Button
                          ref={cancelDeleteRef}
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            setConfirmingDelete(null);
                            deleteButtons.current.get(conv.id)?.focus();
                          }}
                          data-testid={`delete-conversation-cancel-${conv.id}`}
                        >
                          {t('common.cancel')}
                        </Button>
                      </div>
                    </div>
                  )}
                </React.Fragment>
              );
            })}
          </div>

          {onDeleteAllConversations && conversations.length > 0 && (
            <div className="flex flex-col gap-1" data-testid="delete-all-conversations">
              {confirmingDeleteAll ? (
                <>
                  <p id={deleteAllQuestionId} className="text-xs text-text-primary">
                    {t('ai.deleteAllConfirm', { count: conversations.length })}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="danger"
                      size="sm"
                      aria-describedby={deleteAllQuestionId}
                      onClick={() => {
                        setConfirmingDeleteAll(false);
                        onDeleteAllConversations();
                      }}
                      data-testid="delete-all-conversations-confirm"
                    >
                      {t('common.confirm')}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setConfirmingDeleteAll(false)}
                      data-testid="delete-all-conversations-cancel"
                    >
                      {t('common.cancel')}
                    </Button>
                  </div>
                </>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setConfirmingDeleteAll(true)}
                  data-testid="delete-all-conversations-btn"
                >
                  {t('ai.deleteAll')}
                </Button>
              )}
            </div>
          )}
        </div>

        {/* Chat area */}
        <div className="flex-1 flex flex-col min-h-0">
          {!activeConversationId ? (
            <EmptyState
              icon={<Icon name="comment-discussion" />}
              title={t('ai.selectOrCreate', 'Select or create a conversation')}
              description={t('ai.startDescription')}
              data-testid="chat-empty-state"
            />
          ) : (
            <>
              {/* Messages */}
              <Card className="flex-1 min-h-0 overflow-y-auto mb-(--sf-space-2)">
                <CardBody>
                  {/* A log: each reply is said as it arrives, whole (there is no
                      streaming). It arrived silently, the spinner going with
                      it. Drawn afresh for each conversation, so that opening
                      one does not read its whole history out. */}
                  <div
                    key={activeConversationId}
                    className="flex flex-col gap-(--sf-space-3)"
                    role="log"
                    aria-live="polite"
                    aria-relevant="additions"
                    aria-label={t('ai.conversationLog')}
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
                        {/* Who says it, in words: alignment and colour told it alone. */}
                        <span className="sr-only">
                          {msg.role === 'user' ? t('ai.speakerYou') : t('ai.speakerAssistant')}
                        </span>
                        <div
                          className={`max-w-[80%] px-3 py-2 rounded-lg text-sm ${
                            msg.role === 'user'
                              ? 'whitespace-pre-wrap bg-(--sf-button-bg) text-(--sf-button-fg)'
                              : 'min-w-0 bg-(--sf-bg-inactive-selection) text-text-primary'
                          }`}
                          data-testid={`message-bubble-${msg.role}`}
                        >
                          {msg.role === 'user' ? (
                            msg.content
                          ) : (
                            <AnswerContent content={msg.content} />
                          )}
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
                {/* While its question waits, the conversation can stop it: the
                    composer was locked under a spinner until the model
                    answered, with no way to give up on the question. */}
                {isLoading && onCancel ? (
                  <Button variant="secondary" size="sm" onClick={onCancel} data-testid="stop-btn">
                    {t('ai.stop')}
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleSend}
                    disabled={!inputValue.trim() || composerLocked}
                    data-testid="send-btn"
                  >
                    {t('ai.send', 'Send')}
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
