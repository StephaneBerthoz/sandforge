import { useState, useCallback, useRef, useEffect } from 'react';
// The i18next singleton rather than `../i18n`: that module initialises it for
// React once at boot, and every hook-level test that mocks react-i18next would
// otherwise have to provide its initialiser.
import i18n from 'i18next';

import type { BaseMessage } from '@sandforge/shared';

/**
 * Options for the useMessageResponse hook.
 */
export interface UseMessageResponseOptions {
  /** The original request type, named in the error messages (e.g. `'org:list'`). */
  requestType: string;
  /** The message type to listen for (e.g. `'org:list:response'`). */
  responseType: string;
  /** Timeout in milliseconds before the request is considered failed. */
  timeoutMs: number;
  /**
   * Optional error channel to listen for (e.g. `'monitor:error'`). When a
   * handler rejects a request it replies on this channel instead of the
   * success channel; without a listener the user only saw the 30 s timeout.
   */
  errorType?: string;
  /**
   * Whether a message of the response type carrying no correlationId is taken
   * as the answer (default `false`). Every handler reply is correlated
   * (`buildResponse` takes a typed origin), so an uncorrelated message of a
   * response type is a host broadcast with no request behind it — and taken
   * as the answer, one landing between a request and its reply closed the
   * request and the real reply was then dropped: `ai:status:response` is
   * pushed to the panels whenever the AI wiring changes. Set it to `true` only
   * where a caller wants such a push to stand in for its answer.
   */
  acceptUncorrelated?: boolean;
}

/** Duration in milliseconds before the `timedOut` flag is set. */
const FEEDBACK_TIMEOUT_MS = 10_000;

/**
 * A request's failure, in the interface language. These are the fallback of
 * every query and mutation in the panel, and read as developer text in English
 * whatever the language: "Bridge query 'reports:list' timed out after 30000ms".
 * Before i18next is initialised — a hook mounted alone in a test — the key is
 * returned, as `t` does for a missing one.
 */
function requestError(
  key: 'bridge.timedOut' | 'bridge.failed' | 'bridge.rejected',
  options: { request: string; seconds?: number },
): string {
  return i18n.isInitialized ? i18n.t(key, options) : key;
}

/**
 * Return value of the useMessageResponse hook.
 */
export interface MessageResponseHandler<T> {
  /** Start listening for a response to the given message ID. Returns a cleanup function. */
  listen: (messageId: string) => () => void;
  /** Response data, or null if not yet received. */
  data: T | null;
  /** Whether a response is currently being awaited. */
  loading: boolean;
  /** Error message if the request timed out. */
  error: string | null;
  /** Whether the response has been waiting longer than 10 seconds without a reply. */
  timedOut: boolean;
  /** Manually set the loading state. */
  setLoading: (loading: boolean) => void;
  /** Manually set the error state. */
  setError: (error: string | null) => void;
  /** Reset all state (data, loading, error, timedOut) back to idle. */
  reset: () => void;
}

/**
 * Shared hook that encapsulates the listen-for-response pattern used by
 * both `useBridgeQuery` and `useBridgeMutation`.
 *
 * Manages:
 * - `mountedRef` tracking to prevent state updates after unmount
 * - `activeRequestId` tracking to ignore stale responses
 * - `setTimeout` for configurable timeout
 * - `window.addEventListener('message', ...)` with response-type matching
 * - Cleanup of timer and event listener
 *
 * @param options - Configuration for request type, response type, timeout and label.
 */
export function useMessageResponse<T>(
  options: UseMessageResponseOptions,
): MessageResponseHandler<T> {
  const { requestType, responseType, timeoutMs, errorType, acceptUncorrelated = false } = options;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);

  const mountedRef = useRef(true);
  const activeRequestId = useRef<string | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (feedbackTimerRef.current !== null) {
        clearTimeout(feedbackTimerRef.current);
      }
    };
  }, []);

  const listen = useCallback(
    (messageId: string): (() => void) => {
      activeRequestId.current = messageId;
      setTimedOut(false);

      // Start feedback timer — sets timedOut after 10s if still waiting
      if (feedbackTimerRef.current !== null) {
        clearTimeout(feedbackTimerRef.current);
      }
      feedbackTimerRef.current = setTimeout(() => {
        if (mountedRef.current && activeRequestId.current === messageId) {
          setTimedOut(true);
        }
      }, FEEDBACK_TIMEOUT_MS);

      const timer = setTimeout(() => {
        if (mountedRef.current && activeRequestId.current === messageId) {
          setLoading(false);
          setError(
            requestError('bridge.timedOut', {
              request: requestType,
              seconds: Math.round(timeoutMs / 1000),
            }),
          );
          activeRequestId.current = null;
        }
      }, timeoutMs);

      function listener(event: MessageEvent): void {
        // SECURITY: Validate origin — only accept messages from the VSCode
        // webview host. In VSCode webviews the origin is 'vscode-webview://...'
        // or may be empty in some environments (e.g., tests).
        if (event.origin && !event.origin.startsWith('vscode-webview://')) {
          return;
        }
        const eventData = event.data as BaseMessage | undefined;
        if (!eventData || eventData.type !== responseType) {
          return;
        }

        // A response carrying a correlationId must carry ours. One carrying
        // none is a broadcast, not our answer, and is only accepted when the
        // caller asked for the pushes: handler responses are always correlated
        // (`buildResponse` takes a typed origin), while some messages of a
        // response type are pushed with no request behind them —
        // `ai:status:response` whenever the AI wiring changes.
        if (eventData.correlationId ? eventData.correlationId !== messageId : !acceptUncorrelated) {
          return;
        }

        if (!mountedRef.current || activeRequestId.current !== messageId) {
          return;
        }

        clearTimeout(timer);
        if (feedbackTimerRef.current !== null) {
          clearTimeout(feedbackTimerRef.current);
          feedbackTimerRef.current = null;
        }
        activeRequestId.current = null;

        const responsePayload = (eventData as BaseMessage & { payload: T }).payload;
        setData(responsePayload);
        setLoading(false);
        // Clears any provisional error claimed off the uncorrelated error
        // channel (see below): this request's own answer is the last word.
        setError(null);
        setTimedOut(false);
      }

      window.addEventListener('message', listener);

      // Error channel: handlers reply on `<domain>:error` when the request
      // fails server-side. Same origin and correlation rules as the success
      // channel; without this the user only saw the generic timeout.
      let removeErrorListener: (() => void) | undefined;
      if (errorType) {
        const errorListener = (event: MessageEvent): void => {
          if (event.origin && !event.origin.startsWith('vscode-webview://')) {
            return;
          }
          const eventData = event.data as
            | (BaseMessage & { payload?: { message?: unknown } })
            | undefined;
          if (!eventData || eventData.type !== errorType) {
            return;
          }
          // An error names the request it answers, or it is not ours. Handler
          // errors are correlated at the source — `sendHandlerError` takes a
          // typed origin — so one without a correlationId cannot be attributed,
          // and claiming it is how a long sync showed another request's failure.
          if (eventData.correlationId !== messageId) {
            return;
          }
          if (!mountedRef.current || activeRequestId.current !== messageId) {
            return;
          }

          clearTimeout(timer);
          if (feedbackTimerRef.current !== null) {
            clearTimeout(feedbackTimerRef.current);
            feedbackTimerRef.current = null;
          }
          activeRequestId.current = null;

          const payloadMessage = eventData.payload?.message;
          setError(
            typeof payloadMessage === 'string'
              ? payloadMessage
              : requestError('bridge.failed', { request: requestType }),
          );
          setLoading(false);
          setTimedOut(false);
        };
        window.addEventListener('message', errorListener);
        removeErrorListener = () => window.removeEventListener('message', errorListener);
      }

      // Envelope-level rejection: the broker dropped the message before any
      // handler saw it, so no `<domain>:error` will ever arrive and the request
      // would otherwise sit out its full timeout and show the raw timeout
      // string. Matched on correlationId ONLY — bridge:error is a broadcast,
      // and any rule that claims it by timing gives every concurrent hook the
      // wrong verdict.
      const bridgeErrorListener = (event: MessageEvent): void => {
        if (event.origin && !event.origin.startsWith('vscode-webview://')) {
          return;
        }
        const eventData = event.data as
          | (BaseMessage & { payload?: { reason?: unknown } })
          | undefined;
        if (!eventData || eventData.type !== 'bridge:error') {
          return;
        }
        if (eventData.correlationId !== messageId) {
          return;
        }
        if (!mountedRef.current || activeRequestId.current !== messageId) {
          return;
        }

        clearTimeout(timer);
        if (feedbackTimerRef.current !== null) {
          clearTimeout(feedbackTimerRef.current);
          feedbackTimerRef.current = null;
        }
        activeRequestId.current = null;

        setError(requestError('bridge.rejected', { request: requestType }));
        setLoading(false);
        setTimedOut(false);
      };
      window.addEventListener('message', bridgeErrorListener);

      return () => {
        clearTimeout(timer);
        if (feedbackTimerRef.current !== null) {
          clearTimeout(feedbackTimerRef.current);
          feedbackTimerRef.current = null;
        }
        window.removeEventListener('message', listener);
        window.removeEventListener('message', bridgeErrorListener);
        removeErrorListener?.();
      };
    },
    [requestType, responseType, timeoutMs, errorType, acceptUncorrelated],
  );

  const reset = useCallback(() => {
    activeRequestId.current = null;
    if (feedbackTimerRef.current !== null) {
      clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = null;
    }
    setData(null);
    setLoading(false);
    setError(null);
    setTimedOut(false);
  }, []);

  return { listen, data, loading, error, timedOut, setLoading, setError, reset };
}
