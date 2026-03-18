import { useState, useCallback, useRef, useEffect } from 'react';

import type { BaseMessage } from '@sandforge/shared';

/**
 * Options for the useMessageResponse hook.
 */
export interface UseMessageResponseOptions {
  /** The original request type, used in timeout error messages (e.g. `'org:list'`). */
  requestType: string;
  /** The message type to listen for (e.g. `'org:list:response'`). */
  responseType: string;
  /** Timeout in milliseconds before the request is considered failed. */
  timeoutMs: number;
  /** Label used in timeout error messages (e.g. `'query'` or `'mutation'`). */
  requestLabel: string;
}

/** Duration in milliseconds before the `timedOut` flag is set. */
const FEEDBACK_TIMEOUT_MS = 10_000;

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
  const { requestType, responseType, timeoutMs, requestLabel } = options;

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
            `Bridge ${requestLabel} '${requestType}' timed out after ${timeoutMs}ms`,
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

        // correlationId matching: if the response carries a correlationId,
        // it must match our request's messageId. If absent, fall back to
        // type-only matching for backward compatibility.
        if (eventData.correlationId && eventData.correlationId !== messageId) {
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

        const responsePayload = (eventData as BaseMessage & { payload: T })
          .payload;
        setData(responsePayload);
        setLoading(false);
        setTimedOut(false);
      }

      window.addEventListener('message', listener);

      return () => {
        clearTimeout(timer);
        if (feedbackTimerRef.current !== null) {
          clearTimeout(feedbackTimerRef.current);
          feedbackTimerRef.current = null;
        }
        window.removeEventListener('message', listener);
      };
    },
    [requestType, responseType, timeoutMs, requestLabel],
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
