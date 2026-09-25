import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useSendMessage, useMessageListener } from '../../hooks/useMessageBus';
import { buildMessage } from '../../bridge/messageHelpers';
import { AIChatPanel } from './AIChatPanel';
import type { ChatMessageDisplay, ConversationSummary } from './AIChatPanel';
import { EmptyState } from '../../components/ui/EmptyState';
import { PageHeader } from '../../components/ui/PageHeader';
import { useAppStore } from '../../stores/useAppStore';
import type {
  AIConversationCreatedResponse,
  AIConversationListResponse,
  BaseMessage,
} from '@sandforge/shared';

/**
 * A question awaiting its answer: the request carrying it, the conversation it
 * was asked in and that conversation's title, and its bubble in the thread.
 */
interface PendingQuestion {
  requestId: string;
  conversationId: string;
  title: string;
  message: ChatMessageDisplay;
}

/** Main AI page — manages conversations and messages via extension bus. */
export const AIPage: React.FC = () => {
  const { t } = useTranslation();
  const sendMessage = useSendMessage();
  const aiAvailable = useAppStore((s) => s.aiAvailable);
  const navigate = useAppStore((s) => s.navigate);

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | undefined>();
  const [messages, setMessages] = useState<ChatMessageDisplay[]>([]);
  const [localIdCounter, setLocalIdCounter] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [draft, setDraft] = useState('');

  /**
   * The question awaiting its answer: one at a time, whichever conversation is
   * open, and only its own answer or error ends the wait. Any error for another
   * request of the page ended it, and a second question could go out beside
   * the first. The ref is what the listeners read, between two renders; the
   * state mirrors it for what the page shows.
   */
  const pendingQuestion = useRef<PendingQuestion | undefined>(undefined);
  const [waiting, setWaiting] = useState<PendingQuestion | undefined>();
  const setPending = useCallback((question: PendingQuestion | undefined) => {
    pendingQuestion.current = question;
    setWaiting(question);
  }, []);

  /** The conversation a question was answered in while another was open. */
  const [answeredElsewhere, setAnsweredElsewhere] = useState<
    { conversationId: string; title: string } | undefined
  >();

  /**
   * A question that got no answer while another conversation was open: the
   * composer gets it back once its own conversation is open again.
   */
  const returnedQuestion = useRef<{ conversationId: string; text: string } | undefined>(undefined);

  /**
   * Ids of the requests this page sent, so a shared answer can be matched to
   * one of them. Capped: only a recent request can still be answered.
   */
  const ownRequests = useRef<Set<string>>(new Set());
  const send = useCallback(
    (msg: BaseMessage) => {
      ownRequests.current.add(msg.id);
      if (ownRequests.current.size > 32) {
        const oldest = ownRequests.current.values().next().value;
        if (oldest !== undefined) ownRequests.current.delete(oldest);
      }
      sendMessage(msg);
    },
    [sendMessage],
  );

  // Load persisted conversation list on mount when AI is available
  useEffect(() => {
    if (aiAvailable) {
      send(buildMessage('ai:conversation:list', {}));
    }
  }, [aiAvailable, send]);

  // Listen for conversation list response
  useMessageListener<AIConversationListResponse>('ai:conversation:list:response', (msg) => {
    setConversations(msg.payload.conversations);
  });

  // An answer belongs to the conversation its question was asked in. It went to
  // whatever thread was open when it came: asked in one conversation and
  // answered while another was open, it joined the other.
  useMessageListener<
    BaseMessage & { payload: { conversationId: string; message: ChatMessageDisplay } }
  >('ai:chat:response', (msg) => {
    const question = pendingQuestion.current;
    if (!question || msg.correlationId !== question.requestId) return;
    setPending(undefined);
    if (question.conversationId === activeConversationId) {
      // The host keeps a question out of its conversation until the answer
      // comes, so a thread opened again in the meantime was loaded without it.
      setMessages((prev) => [
        ...(prev.includes(question.message) ? prev : [...prev, question.message]),
        msg.payload.message,
      ]);
      return;
    }
    // The answer is kept with its conversation, which the host has stored:
    // the thread open says where it went, unless the user deleted that one.
    if (conversations.some((c) => c.id === question.conversationId)) {
      setAnsweredElsewhere({ conversationId: question.conversationId, title: question.title });
    }
  });

  useMessageListener<AIConversationCreatedResponse>('ai:conversation:created', (msg) => {
    // The confirmation carries no count: a conversation just created holds no message.
    const conv: ConversationSummary = { ...msg.payload.conversation, messageCount: 0 };
    setConversations((prev) => {
      // Replace the optimistic local entry if it exists
      const withoutLocal = prev.filter((c) => !c.id.startsWith('local-conv-'));
      return [...withoutLocal, conv];
    });
    setActiveConversationId(conv.id);
    setMessages([]);
  });

  // An AI failure used to only switch the spinner off, so a refused request
  // looked exactly like one that answered nothing — show what the host said.
  //
  // `ai:error` answers every AI channel — schema advice, anomaly scan, NL2SOQL,
  // pipeline drafts — and the host sends it to every open panel. Only an error
  // that names a request this page sent is this page's to show.
  useMessageListener<BaseMessage & { payload?: { message?: string } }>('ai:error', (msg) => {
    if (!msg.correlationId || !ownRequests.current.delete(msg.correlationId)) return;
    const reason = msg.payload?.message || t('ai.error.unknown', 'Unexpected AI error.');
    const failed = pendingQuestion.current;
    // Another request of the page failed: the question keeps waiting for its own.
    if (failed?.requestId !== msg.correlationId) {
      setErrorMessage(reason);
      return;
    }
    setPending(undefined);
    // A question that got no answer is not part of the conversation: the host
    // leaves it out of the next turn and of the history a reload shows. Left
    // in the thread, it read as part of what the next answer replied to. The
    // composer gets it back, to ask again or reword as the error says.
    if (failed.conversationId === activeConversationId) {
      setErrorMessage(reason);
      setMessages((prev) => prev.filter((m) => m !== failed.message));
      setDraft((current) => current || failed.message.content);
      return;
    }
    // Put back in the composer open, it was one Send away from being asked in a
    // conversation it was never part of: its own conversation's composer gets
    // it, once that one is open again.
    setErrorMessage(t('ai.failedIn', { title: failed.title, reason }));
    returnedQuestion.current = {
      conversationId: failed.conversationId,
      text: failed.message.content,
    };
  });

  useMessageListener<
    BaseMessage & {
      payload: { conversation: { id: string; title: string; messages: ChatMessageDisplay[] } };
    }
  >('ai:conversation:loaded', (msg) => {
    const { conversation } = msg.payload;
    // The host keeps a question out of its conversation until the answer
    // comes: opened again in the meantime, the thread showed the wait without
    // the question it waits on.
    const question = pendingQuestion.current;
    setMessages(
      question?.conversationId === conversation.id
        ? [...conversation.messages, question.message]
        : conversation.messages,
    );
  });

  const handleSendMessage = useCallback(
    (conversationId: string, message: string) => {
      const request = buildMessage<{ conversationId: string; message: string }>('ai:chat', {
        conversationId,
        message,
      });
      const userMsg: ChatMessageDisplay = {
        // The request's id, which no other request has. The clock's millisecond
        // was the id, and two questions asked in the same one shared a React key.
        id: `local-msg-${request.id}`,
        role: 'user',
        content: message,
        timestamp: new Date().toISOString(),
      };
      setPending({
        requestId: request.id,
        conversationId,
        title: conversations.find((c) => c.id === conversationId)?.title ?? '',
        message: userMsg,
      });
      setMessages((prev) => [...prev, userMsg]);
      setErrorMessage(undefined);
      send(request);
    },
    [conversations, send, setPending],
  );

  const handleNewConversation = useCallback(
    (title: string) => {
      const nextId = localIdCounter + 1;
      setLocalIdCounter(nextId);
      const localConv: ConversationSummary = {
        id: `local-conv-${Date.now()}-${nextId}`,
        title,
        createdAt: new Date().toISOString(),
        messageCount: 0,
      };
      setConversations((prev) => [...prev, localConv]);
      setActiveConversationId(localConv.id);
      setMessages([]);
      setErrorMessage(undefined);
      send(buildMessage<{ title: string }>('ai:conversation:create', { title }));
    },
    [localIdCounter, send],
  );

  const handleSelectConversation = useCallback(
    (conversationId: string) => {
      setActiveConversationId(conversationId);
      setMessages([]);
      setErrorMessage(undefined);
      setAnsweredElsewhere((notice) =>
        notice?.conversationId === conversationId ? undefined : notice,
      );
      const returned = returnedQuestion.current;
      if (returned?.conversationId === conversationId) {
        returnedQuestion.current = undefined;
        setDraft((current) => current || returned.text);
      }
      send(buildMessage<{ conversationId: string }>('ai:conversation:load', { conversationId }));
    },
    [send],
  );

  const handleDeleteConversation = useCallback(
    (conversationId: string) => {
      setConversations((prev) => prev.filter((c) => c.id !== conversationId));
      if (activeConversationId === conversationId) {
        setActiveConversationId(undefined);
        setMessages([]);
      }
      setAnsweredElsewhere((notice) =>
        notice?.conversationId === conversationId ? undefined : notice,
      );
      send(buildMessage<{ conversationId: string }>('ai:conversation:delete', { conversationId }));
    },
    [activeConversationId, send],
  );

  // Show guidance when AI is not configured
  if (!aiAvailable) {
    return (
      <div className="flex flex-col h-full p-(--sf-space-4)" data-testid="ai-not-configured">
        <PageHeader
          title={t('ai.title', 'AI Assistant')}
          subtitle={t('ai.subtitle', 'Get AI-powered insights for your Salesforce operations')}
          icon="comment-discussion"
        />
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            icon={
              <svg width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true">
                <circle
                  cx="24"
                  cy="24"
                  r="20"
                  stroke="var(--sf-text-secondary)"
                  strokeWidth="1.5"
                  strokeDasharray="4 4"
                />
                <path
                  d="M24 14l2 6h6l-5 4 2 6-5-4-5 4 2-6-5-4h6l2-6z"
                  fill="var(--sf-text-secondary)"
                  fillOpacity="0.3"
                />
              </svg>
            }
            title={t('ai.notConfigured.title', 'AI Assistant Not Configured')}
            description={t(
              'ai.notConfigured.description',
              'To use AI features, configure your API key in Settings.',
            )}
            actionLabel={t('ai.notConfigured.configureButton', 'Go to Settings')}
            onAction={() => navigate('settings')}
          />
        </div>
      </div>
    );
  }

  const waitingHere = waiting !== undefined && waiting.conversationId === activeConversationId;

  return (
    <AIChatPanel
      conversations={conversations}
      activeConversationId={activeConversationId}
      messages={messages}
      isLoading={waitingHere}
      waitingElsewhere={waiting && !waitingHere ? waiting.title : undefined}
      answeredElsewhere={answeredElsewhere}
      onDismissAnsweredElsewhere={() => setAnsweredElsewhere(undefined)}
      errorMessage={errorMessage}
      onDismissError={() => setErrorMessage(undefined)}
      onSendMessage={handleSendMessage}
      onNewConversation={handleNewConversation}
      onSelectConversation={handleSelectConversation}
      onDeleteConversation={handleDeleteConversation}
      draft={draft}
      onDraftChange={setDraft}
    />
  );
};
