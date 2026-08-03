import { useEffect, useRef } from 'react';

import type { BaseMessage } from '@sandforge/shared';

/**
 * Listen for a handler-posted `<domain>:error` bridge channel and invoke
 * `onError` with the failure message.
 *
 * `useBridgeMutation` only awaits its `:response` channel; handlers report
 * payload/validation failures on a separate `:error` channel (posted via
 * `sendHandlerError`, without correlationId), which would otherwise surface
 * as a 30 s mutation timeout. This hook mirrors the origin-check + type-match
 * pattern of `useMessageResponse` so the mutation fails immediately with the
 * handler's message instead.
 *
 * @param errorType - The error channel to listen for (e.g. `'seed:clone:error'`).
 * @param onError - Called with the handler's error message. Latest-render
 *   closure is always used (ref-forwarded), so inline callbacks are safe.
 */
export function useBridgeErrorChannel(errorType: string, onError: (message: string) => void): void {
  const callbackRef = useRef(onError);
  callbackRef.current = onError;

  useEffect(() => {
    function listener(event: MessageEvent): void {
      // Same origin policy as useMessageResponse: only accept messages from
      // the VSCode webview host (origin may be empty in tests).
      if (event.origin && !event.origin.startsWith('vscode-webview://')) {
        return;
      }
      const data = event.data as (BaseMessage & { payload?: { message?: unknown } }) | undefined;
      if (!data || data.type !== errorType) {
        return;
      }
      const message =
        data.payload && typeof data.payload.message === 'string'
          ? data.payload.message
          : `Bridge error on ${errorType}`;
      callbackRef.current(message);
    }

    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [errorType]);
}
