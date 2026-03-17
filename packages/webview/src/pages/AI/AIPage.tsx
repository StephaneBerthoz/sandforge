import React, { useState, useCallback } from 'react';
import { useSendMessage, useMessageListener } from '../../hooks/useMessageBus';
import { buildMessage } from '../../bridge/messageHelpers';
import { AIChatPanel } from './AIChatPanel';
import type { ChatMessageDisplay, ConversationSummary } from './AIChatPanel';
import type { BaseMessage } from '@sandforge/shared';

/** Main AI page — manages conversations and messages via extension bus. */
export const AIPage: React.FC = () => {
  const sendMessage = useSendMessage();

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | undefined>();
  const [messages, setMessages] = useState<ChatMessageDisplay[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [localIdCounter, setLocalIdCounter] = useState(0);

  // Listen for AI responses
  useMessageListener<BaseMessage & { payload: { conversationId: string; message: ChatMessageDisplay } }>(
    'ai:chat:response',
    (msg) => {
      setMessages((prev) => [...prev, msg.payload.message]);
      setIsLoading(false);
    },
  );

  useMessageListener<BaseMessage & { payload: { conversation: ConversationSummary } }>(
    'ai:conversation:created',
    (msg) => {
      const conv = msg.payload.conversation;
      setConversations((prev) => [...prev, conv]);
      setActiveConversationId(conv.id);
      setMessages([]);
    },
  );

  useMessageListener<BaseMessage & { payload: { message: string } }>(
    'ai:error',
    () => {
      setIsLoading(false);
    },
  );

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
      sendMessage(
        buildMessage<{ conversationId: string; message: string }>('ai:chat', {
          conversationId,
          message,
        }),
      );
    },
    [sendMessage],
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
      sendMessage(
        buildMessage<{ title: string }>('ai:conversation:create', { title }),
      );
    },
    [localIdCounter, sendMessage],
  );

  const handleSelectConversation = useCallback(
    (conversationId: string) => {
      setActiveConversationId(conversationId);
      setMessages([]);
      sendMessage(
        buildMessage<{ conversationId: string }>('ai:conversation:load', { conversationId }),
      );
    },
    [sendMessage],
  );

  const handleDeleteConversation = useCallback(
    (conversationId: string) => {
      setConversations((prev) => prev.filter((c) => c.id !== conversationId));
      if (activeConversationId === conversationId) {
        setActiveConversationId(undefined);
        setMessages([]);
      }
      sendMessage(
        buildMessage<{ conversationId: string }>('ai:conversation:delete', { conversationId }),
      );
    },
    [activeConversationId, sendMessage],
  );

  return (
    <AIChatPanel
      conversations={conversations}
      activeConversationId={activeConversationId}
      messages={messages}
      isLoading={isLoading}
      onSendMessage={handleSendMessage}
      onNewConversation={handleNewConversation}
      onSelectConversation={handleSelectConversation}
      onDeleteConversation={handleDeleteConversation}
    />
  );
};
