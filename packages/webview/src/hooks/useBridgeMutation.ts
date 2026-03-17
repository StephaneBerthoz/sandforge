import { useCallback, useRef, useEffect } from 'react';

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
  },
): BridgeMutationState<T> {
  const sendMessage = useSendMessage();
  const responseType = options?.responseType ?? `${requestType}:response`;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const { listen, data, loading, error, setLoading, setError, reset: resetResponse } =
    useMessageResponse<T>({
      requestType,
      responseType,
      timeoutMs,
      requestLabel: 'mutation',
    });

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

      setLoading(true);
      setError(null);

      const msg = payload !== undefined
        ? buildMessage<Record<string, unknown>>(requestType, payload)
        : buildMessage(requestType);

      sendMessage(msg);

      const cleanup = listen(msg.id);
      cleanupRef.current = cleanup;
    },
    [requestType, sendMessage, listen, setLoading, setError],
  );

  const reset = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    resetResponse();
  }, [resetResponse]);

  return { mutate, data, loading, error, reset };
}
