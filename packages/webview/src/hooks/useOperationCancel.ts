import { useCallback, useEffect, useRef, useState } from 'react';

import type { ExecutionAbortResponse } from '@sandforge/shared';

import { useNotificationStore } from '../stores/useNotificationStore';
import { useBridgeMutation } from './useBridgeMutation';

/** What a Cancel the extension refused says, in the panel's words. */
export interface OperationCancelRefusal {
  title: string;
  message: string;
}

/** The Cancel of a run the page started. */
export interface OperationCancel {
  /** Cancel was sent and not refused: the run stops before its next call to the org. */
  requested: boolean;
  /** Send the cancel; nothing while no run is named. */
  cancel: () => void;
}

/**
 * Cancel a run the page started — a Frozen load, a Frozen load's removal, a
 * Sync run's removal — which the extension runs under the id of the request
 * that started it: sent on `execution:abort`, as Live Operations' Cancel is,
 * it stops the run before its next call to the org. A cancel the extension
 * refuses — the run over already, or not found — is said, and Cancel is
 * offered again while the run goes on; each answer is read once. Another run
 * starts with nothing asked of it.
 *
 * @param requestId - The id of the request that started the run; null while none runs.
 * @param refused - What a refused cancel says.
 */
export function useOperationCancel(
  requestId: string | null,
  refused: OperationCancelRefusal,
): OperationCancel {
  const abortMutation = useBridgeMutation<ExecutionAbortResponse['payload']>('execution:abort', {
    responseType: 'execution:abort:response',
  });
  const addNotification = useNotificationStore((s) => s.addNotification);
  const [requested, setRequested] = useState(false);
  useEffect(() => {
    setRequested(false);
  }, [requestId]);

  // Only the answer to a cancel this Cancel sent: a load's and its removal's
  // are two Cancels on one page.
  const sent = useRef(false);
  const answered = useRef<unknown>(null);
  const reply = abortMutation.data;
  const error = abortMutation.error;
  const { title, message } = refused;
  useEffect(() => {
    const answer = reply ?? error;
    if (!sent.current || !answer || answered.current === answer) return;
    answered.current = answer;
    if (error || !reply?.success) {
      setRequested(false);
      addNotification({ level: 'warning', title, message });
    }
  }, [reply, error, addNotification, title, message]);

  const { mutate } = abortMutation;
  const cancel = useCallback(() => {
    if (!requestId) return;
    sent.current = true;
    setRequested(true);
    mutate({ operationId: requestId });
  }, [requestId, mutate]);

  return { requested, cancel };
}
