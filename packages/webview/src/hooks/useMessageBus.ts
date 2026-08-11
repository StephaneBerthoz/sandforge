import { useEffect, useCallback, useRef } from 'react';

import type { BaseMessage } from '@sandforge/shared';

import { postEnvelopedMessage } from '../bridge/sendBridgeMessage';
import { useVSCodeApi } from './useVSCodeApi';

/**
 * Hook that returns a stable callback for sending typed messages
 * to the extension host via the VSCode webview API.
 *
 * Plan 01-04: every outbound message is wrapped in a protocol envelope:
 *
 *   { protocolVersion, correlationId?, payload: message }
 *
 * The envelope is built by {@link postEnvelopedMessage}, the single source of
 * truth shared with the non-hook `sendBridgeMessage` sender used by Zustand
 * stores. The extension-host {@link MessageBroker} validates the envelope,
 * strips it, and dispatches `payload` to registered handlers. On version
 * mismatch the broker emits `bridge:protocol-mismatch` /
 * `bridge:reload-banner` messages that the webview reacts to via
 * {@link ProtocolMismatchBanner}.
 */
export function useSendMessage(): (message: BaseMessage) => void {
  const api = useVSCodeApi();

  return useCallback(
    (message: BaseMessage) => {
      postEnvelopedMessage(message, api);
    },
    [api],
  );
}

/* ------------------------------------------------------------------------ */
/* Shared window message dispatcher                                          */
/* ------------------------------------------------------------------------ */

type DispatcherHandler = (message: BaseMessage) => void;

/** Registry of subscribed handlers, keyed by message type. */
const handlerRegistry = new Map<string, Set<DispatcherHandler>>();

/** Number of active subscriptions; the window listener is attached lazily. */
let activeSubscriptions = 0;

/**
 * Single `window` message listener shared by every {@link useMessageListener}
 * subscriber. Validates the origin and the envelope shape once per incoming
 * message, then dispatches to the handlers registered for `data.type`.
 *
 * Previously each hook call installed its own window listener, so every
 * inbound message was re-parsed by dozens of listeners.
 */
function dispatchMessage(event: MessageEvent): void {
  // SECURITY: Validate origin — only accept messages from the VSCode
  // webview host. In VSCode webviews the origin is 'vscode-webview://...'
  // or may be empty in some environments (e.g., tests).
  if (event.origin && !event.origin.startsWith('vscode-webview://')) {
    return;
  }
  const data = event.data as BaseMessage | undefined;
  if (!data || typeof data.type !== 'string') {
    return;
  }
  const handlers = handlerRegistry.get(data.type);
  if (!handlers) {
    return;
  }
  // Iterate over a copy so a handler unsubscribing mid-dispatch is safe, and
  // isolate handler errors the way separate window listeners would be.
  for (const handler of [...handlers]) {
    try {
      handler(data);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[useMessageBus] handler for '${data.type}' threw`, error);
    }
  }
}

/**
 * Subscribe `handler` to a message type on the shared dispatcher.
 * Attaches the single window listener on first subscription and detaches it
 * when the last subscription is removed. Returns the unsubscribe function.
 */
function subscribe(type: string, handler: DispatcherHandler): () => void {
  if (typeof window === 'undefined') {
    return () => undefined;
  }
  let handlers = handlerRegistry.get(type);
  if (!handlers) {
    handlers = new Set();
    handlerRegistry.set(type, handlers);
  }
  handlers.add(handler);
  if (activeSubscriptions === 0) {
    window.addEventListener('message', dispatchMessage);
  }
  activeSubscriptions += 1;

  return () => {
    const current = handlerRegistry.get(type);
    if (!current?.has(handler)) {
      return; // already unsubscribed
    }
    current.delete(handler);
    if (current.size === 0) {
      handlerRegistry.delete(type);
    }
    activeSubscriptions -= 1;
    if (activeSubscriptions === 0) {
      window.removeEventListener('message', dispatchMessage);
    }
  };
}

/**
 * Hook that subscribes to messages of a specific type from the extension host.
 * The handler is kept in a ref so the effect does not re-subscribe on every render.
 *
 * All subscribers share a single `window` message listener (see
 * {@link dispatchMessage}); the public API is unchanged.
 *
 * @param type - The message type string to filter on.
 * @param handler - Callback invoked when a matching message arrives.
 */
export function useMessageListener<T extends BaseMessage>(
  type: string,
  handler: (message: T) => void,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const subscription: DispatcherHandler = (message) => {
      handlerRef.current(message as T);
    };
    return subscribe(type, subscription);
  }, [type]);
}
