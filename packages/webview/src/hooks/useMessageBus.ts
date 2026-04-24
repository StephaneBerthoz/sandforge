import { useEffect, useCallback, useRef } from 'react';

import type { BaseMessage } from '@sandforge/shared';
import { PROTOCOL_VERSION } from '@sandforge/shared';

import { useVSCodeApi } from './useVSCodeApi';

/**
 * Hook that returns a stable callback for sending typed messages
 * to the extension host via the VSCode webview API.
 *
 * Plan 01-04: every outbound message is wrapped in a protocol envelope:
 *
 *   { protocolVersion, correlationId?, payload: message }
 *
 * The extension-host {@link MessageBroker} validates the envelope, strips it,
 * and dispatches `payload` to registered handlers. On version mismatch the
 * broker emits `bridge:protocol-mismatch` / `bridge:reload-banner` messages
 * that the webview reacts to via {@link ProtocolMismatchBanner}.
 */
export function useSendMessage(): (message: BaseMessage) => void {
  const api = useVSCodeApi();

  return useCallback(
    (message: BaseMessage) => {
      api.postMessage({
        protocolVersion: PROTOCOL_VERSION,
        correlationId: message.correlationId,
        payload: message,
      });
    },
    [api],
  );
}

/**
 * Hook that subscribes to messages of a specific type from the extension host.
 * The handler is kept in a ref so the effect does not re-subscribe on every render.
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
    function listener(event: MessageEvent): void {
      // SECURITY: Validate origin — only accept messages from the VSCode
      // webview host. In VSCode webviews the origin is 'vscode-webview://...'
      // or may be empty in some environments (e.g., tests).
      if (event.origin && !event.origin.startsWith('vscode-webview://')) {
        return;
      }
      const data = event.data as BaseMessage | undefined;
      if (data?.type === type) {
        handlerRef.current(data as T);
      }
    }

    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [type]);
}
