import { useEffect } from 'react';

import type {
  FrozenControlReport,
  FrozenLoadProgress,
  FrozenVerifyVerdict,
} from '@sandforge/shared';

import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import type { BridgeMutationState } from '../../hooks/useBridgeMutation';
import { useMessageListener } from '../../hooks/useMessageBus';
import type { BaseMessage } from '@sandforge/shared';
import { useFrozenStore } from '../../stores/useFrozenStore';

/** Error payload shape of the `frozen:*:error` channels. */
interface FrozenErrorPayload {
  message: string;
  code: string;
  retryable: boolean;
}

/**
 * Bridge mutation bound to a `frozen:*` request type. Extends
 * `useBridgeMutation` with a listener on the `{requestType}:error` channel:
 * handler errors (`{message, code, retryable}`) surface in `error` and
 * release the loading state instead of waiting for the timeout.
 */
export function useFrozenMutation<T>(
  requestType: string,
  options?: { responseType?: string; timeoutMs?: number },
): BridgeMutationState<T> {
  const mutation = useBridgeMutation<T>(requestType, options);
  const setLastError = useFrozenStore((s) => s.setLastError);

  useMessageListener(`${requestType}:error`, (msg: BaseMessage) => {
    const payload = (msg as BaseMessage & { payload?: FrozenErrorPayload }).payload;
    setLastError({
      source: requestType,
      message: payload?.message ?? 'Unknown error',
      code: payload?.code ?? 'UNKNOWN',
      retryable: payload?.retryable ?? false,
    });
    mutation.reset();
  });

  return mutation;
}

/**
 * Subscribe the Frozen store to the push channels emitted by the extension
 * handler: load/verify progress, the 4-point control result, and the
 * post-load verdict (chained after a load or standalone).
 */
export function useFrozenPushChannels(): void {
  const appendProgress = useFrozenStore((s) => s.appendProgress);
  const setControlReport = useFrozenStore((s) => s.setControlReport);
  const setVerdict = useFrozenStore((s) => s.setVerdict);

  useMessageListener('frozen:load:progress', (msg: BaseMessage) => {
    const payload = (msg as BaseMessage & { payload?: FrozenLoadProgress }).payload;
    if (payload) appendProgress(payload);
  });

  useMessageListener('frozen:control:result', (msg: BaseMessage) => {
    const payload = (msg as BaseMessage & { payload?: { report?: FrozenControlReport } }).payload;
    if (payload?.report) setControlReport(payload.report);
  });

  useMessageListener('frozen:verify:result', (msg: BaseMessage) => {
    const payload = (msg as BaseMessage & { payload?: { verdict?: FrozenVerifyVerdict } }).payload;
    if (payload?.verdict) setVerdict(payload.verdict);
  });

  // Mount-only hook — listeners self-manage via refs.
  useEffect(() => undefined, []);
}
