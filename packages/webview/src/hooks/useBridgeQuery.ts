import { useEffect, useCallback, useRef, useMemo } from 'react';

import { useSendMessage } from './useMessageBus';
import { useMessageResponse } from './useMessageResponse';
import { buildMessage } from '../bridge/messageHelpers';

/** Default timeout for bridge queries (30 seconds). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** State returned by the useBridgeQuery hook. */
export interface BridgeQueryState<T> {
  /** Response data, or null if not yet received. */
  data: T | null;
  /** Whether the query is currently in flight. */
  loading: boolean;
  /** Error message if the query failed or timed out. */
  error: string | null;
  /** Manually re-send the query. */
  refetch: () => void;
}

/**
 * Hook that wraps the send+listen pattern into a request/response cycle.
 *
 * Sends a message of `requestType` on mount and listens for a response
 * on `{requestType}:response` (or a custom `responseType`).
 * Tracks loading, error, and data states. Supports manual refetch and
 * configurable timeout.
 *
 * @param requestType - The message type to send (e.g. `'org:list'`).
 * @param payload - Optional payload to attach to the request message.
 * @param options - Optional configuration (responseType override, timeout, skip).
 */
export function useBridgeQuery<T>(
  requestType: string,
  payload?: Record<string, unknown>,
  options?: {
    /** Override the response type to listen for. Defaults to `{requestType}:response`. */
    responseType?: string;
    /** Timeout in milliseconds. Defaults to 30 000. */
    timeoutMs?: number;
    /** When true, skip the automatic query on mount. */
    skip?: boolean;
  },
): BridgeQueryState<T> {
  const sendMessage = useSendMessage();
  const responseType = options?.responseType ?? `${requestType}:response`;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const skip = options?.skip ?? false;

  const { listen, data, loading, error, setLoading, setError } = useMessageResponse<T>({
    requestType,
    responseType,
    timeoutMs,
    requestLabel: 'query',
  });

  // Stabilise sendMessage in a ref so it never triggers re-execution of the
  // query effect.  The underlying function identity may change when the
  // VSCode API mock (or real API) returns a new wrapper object each render.
  const sendRef = useRef(sendMessage);
  sendRef.current = sendMessage;

  // Memoise payload by value so that callers passing an inline object literal
  // don't cause unnecessary re-executions.
  const payloadKey = useMemo(
    () => (payload !== undefined ? JSON.stringify(payload) : ''),
    [payload],
  );

  const execute = useCallback(() => {
    setLoading(true);
    setError(null);

    const currentPayload = payloadKey
      ? (JSON.parse(payloadKey) as Record<string, unknown>)
      : undefined;

    const msg =
      currentPayload !== undefined
        ? buildMessage<Record<string, unknown>>(requestType, currentPayload)
        : buildMessage(requestType);

    sendRef.current(msg);

    return listen(msg.id);
  }, [requestType, payloadKey, listen, setLoading, setError]);

  // Store the cleanup function from execute
  const cleanupRef = useRef<(() => void) | null>(null);

  // Auto-execute on mount (unless skip is true)
  useEffect(() => {
    if (skip) {
      return;
    }
    cleanupRef.current?.();
    const cleanup = execute();
    cleanupRef.current = cleanup ?? null;
    return () => {
      cleanup?.();
      cleanupRef.current = null;
    };
  }, [execute, skip]);

  const refetch = useCallback(() => {
    cleanupRef.current?.();
    const cleanup = execute();
    cleanupRef.current = cleanup ?? null;
  }, [execute]);

  return { data, loading, error, refetch };
}
