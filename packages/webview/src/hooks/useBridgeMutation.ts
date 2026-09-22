import { useCallback, useRef, useEffect, useMemo, useState } from 'react';

import { useSendMessage } from './useMessageBus';
import { useMessageResponse } from './useMessageResponse';
import { buildMessage } from '../bridge/messageHelpers';

/** Default timeout for bridge mutations (30 seconds). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** State returned by the useBridgeMutation hook. */
export interface BridgeMutationState<T> {
  /** Trigger the mutation with the given payload. */
  mutate: (payload?: Record<string, unknown>) => void;
  /** Response data, or null if not yet received. */
  data: T | null;
  /** Whether the mutation is currently in flight. */
  loading: boolean;
  /** Error message if the mutation failed or timed out. */
  error: string | null;
  /** Reset the mutation state back to idle. */
  reset: () => void;
  /**
   * Id of the request the last `mutate` sent, or null before the first one and
   * after `reset`. Handlers that run in the background use it as the
   * operationId of the run they start, so a page matches `operation:*` events
   * to its own run instead of whichever run reported last.
   */
  requestId: string | null;
}

/**
 * Hook for write operations that send a message and wait for a response.
 *
 * Unlike `useBridgeQuery`, this hook does **not** fire on mount.
 * Instead, call `mutate(payload)` to send the message and listen
 * for the response.
 *
 * @param requestType - The message type to send (e.g. `'org:connect'`).
 * @param options - Optional configuration (responseType override, timeout).
 */
export function useBridgeMutation<T>(
  requestType: string,
  options?: {
    /** Override the response type to listen for. Defaults to `{requestType}:response`. */
    responseType?: string;
    /** Timeout in milliseconds. Defaults to 30 000. */
    timeoutMs?: number;
    /**
     * Error channel to listen for. Defaults to `<domain>:error` derived
     * from the request type (the convention used by bridge handlers).
     */
    errorType?: string;
  },
): BridgeMutationState<T> {
  const sendMessage = useSendMessage();
  const responseType = options?.responseType ?? `${requestType}:response`;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const errorType = options?.errorType ?? `${requestType.split(':')[0]}:error`;

  const {
    listen,
    data,
    loading,
    error,
    setLoading,
    setError,
    reset: resetResponse,
  } = useMessageResponse<T>({
    requestType,
    responseType,
    timeoutMs,
    errorType,
  });

  const [requestId, setRequestId] = useState<string | null>(null);

  // Held in a ref so `mutate` keeps its identity when the VS Code API wrapper
  // does not (same reason as in useBridgeQuery); otherwise the memoised result
  // below would still change on every render.
  const sendRef = useRef(sendMessage);
  sendRef.current = sendMessage;

  // Store cleanup function for the current listener
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, []);

  const mutate = useCallback(
    (payload?: Record<string, unknown>) => {
      // Clean up any previous in-flight mutation
      cleanupRef.current?.();

      // Clear the PREVIOUS result too, not just the previous error. `data`
      // used to survive a new attempt, and the error channel never touches it,
      // so a run that succeeded followed by one that failed left both set: the
      // page rendered its failure banner directly above the earlier run's
      // "Complete — 118 succeeded". The user read a success for a run that
      // had just failed.
      resetResponse();
      setLoading(true);
      setError(null);

      const msg =
        payload !== undefined
          ? buildMessage<Record<string, unknown>>(requestType, payload)
          : buildMessage(requestType);

      setRequestId(msg.id);
      sendRef.current(msg);

      const cleanup = listen(msg.id);
      cleanupRef.current = cleanup;
    },
    [requestType, listen, setLoading, setError, resetResponse],
  );

  const reset = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    setRequestId(null);
    resetResponse();
  }, [resetResponse]);

  // One object per state change, not per render: pages pass the mutation to
  // memoised components as a prop, and a fresh object each render re-rendered
  // them every time.
  return useMemo(
    () => ({ mutate, data, loading, error, reset, requestId }),
    [mutate, data, loading, error, reset, requestId],
  );
}
