import { useEffect, useRef } from 'react';
// The i18next singleton, as useMessageResponse reads it: hook tests mock react-i18next.
import i18n from 'i18next';

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
import { useOrgStore } from '../../stores/useOrgStore';
import { muteRefusalWords } from '../../utils/muteRefusal';
import { frozenErrorWords } from './frozenErrorWords';
import type { FrozenErrorPayload } from './frozenErrorWords';

/**
 * Bridge mutation bound to a `frozen:*` request type. Extends
 * `useBridgeMutation` with a listener on the `{requestType}:error` channel:
 * handler errors (`{message, code, retryable}`) surface in `error` and
 * release the loading state instead of waiting for the timeout.
 *
 * Only an error correlated to this mutation's own request counts. Every panel
 * receives every error, and taking them by type let another panel's failed
 * request cancel this one.
 */
export function useFrozenMutation<T>(
  requestType: string,
  options?: { responseType?: string; timeoutMs?: number; runOutlivesWait?: boolean },
): BridgeMutationState<T> {
  const mutation = useBridgeMutation<T>(requestType, options);
  const setLastError = useFrozenStore((s) => s.setLastError);
  const replaceActiveRequestId = useFrozenStore((s) => s.replaceActiveRequestId);
  const removeActiveRequestId = useFrozenStore((s) => s.removeActiveRequestId);
  const orgs = useOrgStore((s) => s.orgs);

  /*
   * The push channels carry no request of their own, only the correlationId of
   * the request that started the work, so the panel has to say which requests
   * are its own. The id stays registered past the response: a load answers
   * first and only then runs the verification, which reports as more
   * `frozen:load:progress` and ends on the verdict. Dropping the id on the
   * response would throw that verdict away.
   *
   * Nothing is dropped when the tab unmounts: switching between the Extract
   * and Load tabs unmounts the tab while its run carries on, and the page
   * clears the set when it goes away.
   */
  const registeredId = useRef<string | null>(null);
  const { requestId } = mutation;
  useEffect(() => {
    // A new send or a reset abandons the earlier run: the tab cleared its
    // progress before sending again, so late events from it would be misread
    // as the new run's. The store drops the earlier send of the same type even
    // when another mount of the tab made it; this mount only knows its own
    // for a reset.
    if (registeredId.current !== null && registeredId.current !== requestId) {
      removeActiveRequestId(registeredId.current);
      registeredId.current = null;
    }
    if (requestId !== null) {
      registeredId.current = requestId;
      replaceActiveRequestId(requestType, requestId);
    }
  }, [requestId, requestType, replaceActiveRequestId, removeActiveRequestId]);

  useMessageListener(`${requestType}:error`, (msg: BaseMessage) => {
    if (mutation.requestId === null || msg.correlationId !== mutation.requestId) return;
    const payload = (
      msg as BaseMessage & { payload?: FrozenErrorPayload & { retryable?: boolean } }
    ).payload;
    // A load asked to mute that could not be, and the refusals a first run
    // meets — nothing saved, no rules file, the source as the target — are
    // said in the interface language: the host words them in English.
    const translate = (key: string, options?: Record<string, unknown>): string =>
      i18n.t(key, options);
    const aliasOf = (orgId: string): string => orgs.find((org) => org.id === orgId)?.alias ?? orgId;
    const words = i18n.isInitialized
      ? (muteRefusalWords(payload?.code, payload?.message, translate) ??
        frozenErrorWords(payload, translate, aliasOf))
      : undefined;
    setLastError({
      source: requestType,
      message: words ?? payload?.message ?? 'Unknown error',
      code: payload?.code ?? 'UNKNOWN',
      retryable: payload?.retryable ?? false,
    });
    mutation.reset();
  });

  return mutation;
}

/**
 * True when `msg` answers a request this panel sent. Read from the store at
 * delivery time rather than captured: the listener is kept in a ref and would
 * otherwise test the set as it stood when the panel mounted.
 */
function isOwnRequest(msg: BaseMessage): boolean {
  const { correlationId } = msg;
  if (typeof correlationId !== 'string') return false;
  return useFrozenStore.getState().activeRequestIds.has(correlationId);
}

/**
 * Subscribe the Frozen store to the push channels emitted by the extension
 * handler: load/verify progress, the 4-point control result, and the
 * post-load verdict (chained after a load or standalone).
 *
 * Every panel receives every push message, so each one is taken only when its
 * correlationId names a request this panel sent.
 */
export function useFrozenPushChannels(): void {
  const appendProgress = useFrozenStore((s) => s.appendProgress);
  const setControlReport = useFrozenStore((s) => s.setControlReport);
  const setVerdict = useFrozenStore((s) => s.setVerdict);
  const removeActiveRequestId = useFrozenStore((s) => s.removeActiveRequestId);

  useMessageListener('frozen:load:progress', (msg: BaseMessage) => {
    if (!isOwnRequest(msg)) return;
    const payload = (msg as BaseMessage & { payload?: FrozenLoadProgress }).payload;
    if (payload) appendProgress(payload);
  });

  useMessageListener('frozen:control:result', (msg: BaseMessage) => {
    if (!isOwnRequest(msg)) return;
    const payload = (msg as BaseMessage & { payload?: { report?: FrozenControlReport } }).payload;
    if (payload?.report) setControlReport(payload.report);
  });

  useMessageListener('frozen:verify:result', (msg: BaseMessage) => {
    if (!isOwnRequest(msg)) return;
    const payload = (msg as BaseMessage & { payload?: { verdict?: FrozenVerifyVerdict } }).payload;
    if (payload?.verdict) setVerdict(payload.verdict);
    // The verdict ends the chain the request opened, here and after a load.
    if (msg.correlationId) removeActiveRequestId(msg.correlationId);
  });

  useMessageListener('frozen:verify:error', (msg: BaseMessage) => {
    if (msg.correlationId) removeActiveRequestId(msg.correlationId);
  });

  // The page going away ends every run it was showing: nothing is left to
  // read the ids, and progress kept past it would show a run that never ends.
  const clearActiveRequestIds = useFrozenStore((s) => s.clearActiveRequestIds);
  const clearProgress = useFrozenStore((s) => s.clearProgress);
  useEffect(
    () => () => {
      clearActiveRequestIds();
      clearProgress();
    },
    [clearActiveRequestIds, clearProgress],
  );
}
