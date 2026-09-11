import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useSendMessage, useMessageListener } from '../../hooks/useMessageBus';
import { buildMessage } from '../../bridge/messageHelpers';
import { AIChatPanel } from './AIChatPanel';
import type { ChatMessageDisplay, ConversationSummary } from './AIChatPanel';
import { EmptyState } from '../../components/ui/EmptyState';
import { PageHeader } from '../../components/ui/PageHeader';
import { useAppStore } from '../../stores/useAppStore';
import type { BaseMessage } from '@sandforge/shared';

/** Main AI page — manages conversations and messages via extension bus. */
export const AIPage: React.FC = () => {
  const { t } = useTranslation();
  const sendMessage = useSendMessage();
  const aiAvailable = useAppStore((s) => s.aiAvailable);
  const navigate = useAppStore((s) => s.navigate);

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | undefined>();
  const [messages, setMessages] = useState<ChatMessageDisplay[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [localIdCounter, setLocalIdCounter] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();

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
  useMessageListener<BaseMessage & { payload: { conversations: ConversationSummary[] } }>(
    'ai:conversation:list:response',
    (msg) => {
      setConversations(msg.payload.conversations);
    },
  );

  // Listen for AI responses
  useMessageListener<
    BaseMessage & { payload: { conversationId: string; message: ChatMessageDisplay } }
  >('ai:chat:response', (msg) => {
    setMessages((prev) => [...prev, msg.payload.message]);
    setIsLoading(false);
  });

  useMessageListener<BaseMessage & { payload: { conversation: ConversationSummary } }>(
    'ai:conversation:created',
    (msg) => {
      const conv = msg.payload.conversation;
      setConversations((prev) => {
        // Replace the optimistic local entry if it exists
        const withoutLocal = prev.filter((c) => !c.id.startsWith('local-conv-'));
        return [...withoutLocal, conv];
      });
      setActiveConversationId(conv.id);
      setMessages([]);
    },
  );

  // An AI failure used to only switch the spinner off, so a refused request
  // looked exactly like one that answered nothing — show what the host said.
  //
  // `ai:error` answers every AI channel — schema advice, anomaly scan, NL2SOQL,
  // pipeline drafts — and the host sends it to every open panel. Only an error
  // that names a request this page sent is this page's to show.
  useMessageListener<BaseMessage & { payload?: { message?: string } }>('ai:error', (msg) => {
    if (!msg.correlationId || !ownRequests.current.delete(msg.correlationId)) return;
    setIsLoading(false);
    setErrorMessage(msg.payload?.message || t('ai.error.unknown', 'Unexpected AI error.'));
  });

  // Listen for conversation loaded with messages
  useMessageListener<
    BaseMessage & {
      payload: { conversation: { id: string; title: string; messages: ChatMessageDisplay[] } };
    }
  >('ai:conversation:loaded', (msg) => {
    setMessages(msg.payload.conversation.messages);
  });

  const handleSendMessage = useCallback(
    (conversationId: string, message: string) => {
      const userMsg: ChatMessageDisplay = {
        id: `local-msg-${Date.now()}`,
        role: 'user',
        content: message,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setIsLoading(true);
      setErrorMessage(undefined);
      send(
        buildMessage<{ conversationId: string; message: string }>('ai:chat', {
          conversationId,
          message,
        }),
      );
    },
    [send],
  );

  const handleNewConversation = useCallback(
    (title: string) => {
      const nextId = localIdCounter + 1;
      setLocalIdCounter(nextId);
      const localConv: ConversationSummary = {
        id: `local-conv-${Date.now()}-${nextId}`,
        title,
        updatedAt: new Date().toISOString(),
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
      send(buildMessage<{ conversationId: string }>('ai:conversation:delete', { conversationId }));
    },
    [activeConversationId, send],
  );

  // Show guidance when AI is not configured
  if (!aiAvailable) {
    return (
      <div className="flex flex-col h-full p-[var(--sf-space-4)]" data-testid="ai-not-configured">
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

  return (
    <AIChatPanel
      conversations={conversations}
      activeConversationId={activeConversationId}
      messages={messages}
      isLoading={isLoading}
      errorMessage={errorMessage}
      onDismissError={() => setErrorMessage(undefined)}
      onSendMessage={handleSendMessage}
      onNewConversation={handleNewConversation}
      onSelectConversation={handleSelectConversation}
      onDeleteConversation={handleDeleteConversation}
    />
  );
};
