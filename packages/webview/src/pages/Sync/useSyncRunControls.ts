import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExecutionAbortResponse, SyncRunControlAnswer } from '@sandforge/shared';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { useNotificationStore } from '../../stores/useNotificationStore';

/**
 * How long the page waits for the answer of a run it started. A paused run
 * waits on a person, for as long as that person takes; held to the two
 * minutes a run used to be given, a long or paused run lost its page — the
 * bar, its Pause and its Cancel — while it went on writing.
 */
export const SYNC_RUN_TIMEOUT_MS = 12 * 60 * 60 * 1000;

/** What the page can do with the run, or the simulation, it started. */
export interface SyncRunControls {
  /** Whether the extension said the run is held before its next object or batch. */
  paused: boolean;
  /** Whether a cancel was sent and the run has not answered yet. */
  cancelRequested: boolean;
  /** Whether a pause or a resume was sent and not answered yet. */
  pending: boolean;
  /** Hold the run before its next object or batch. */
  pause: () => void;
  /** Let a paused run go on. */
  resume: () => void;
  /** Stop the run, as Live Operations' Cancel does. */
  cancel: () => void;
}

/**
 * Pause, resume and cancel for the run `operationId` names — the id of the
 * request that started it, which the extension uses as the run's id.
 *
 * Cancel goes out on `execution:abort`, the channel Live Operations' Cancel
 * uses, so it means the same: the run stops before its next object or batch,
 * and what it wrote stays in the org. A run the extension cannot find, or one
 * already over, is refused, and the refusal is said rather than swallowed.
 */
export function useSyncRunControls(operationId: string | null): SyncRunControls {
  const { t } = useTranslation();
  const addNotification = useNotificationStore((s) => s.addNotification);
  const abortMutation = useBridgeMutation<ExecutionAbortResponse['payload']>('execution:abort', {
    responseType: 'execution:abort:response',
  });
  const pauseMutation = useBridgeMutation<SyncRunControlAnswer>('sync:pause');
  const resumeMutation = useBridgeMutation<SyncRunControlAnswer>('sync:resume');

  const [paused, setPaused] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);

  // Another run starts as nothing has been asked of it.
  useEffect(() => {
    setPaused(false);
    setCancelRequested(false);
  }, [operationId]);

  // Each answer is read once: the effects below run again whenever the page
  // re-renders with a new notifier, and a refusal said twice is noise.
  const answered = useRef<unknown>(null);

  const abortReply = abortMutation.data;
  const abortError = abortMutation.error;
  useEffect(() => {
    const reply = abortReply ?? abortError;
    if (!reply || answered.current === reply) return;
    answered.current = reply;
    if (abortError || !abortReply?.success) {
      setCancelRequested(false);
      addNotification({
        level: 'warning',
        category: 'sync',
        title: t('sync.runControls.cancelRefused'),
        message: t('sync.runControls.cancelRefusedDetail'),
      });
    }
  }, [abortReply, abortError, addNotification, t]);

  // A pause or a resume answers with whether the run is now held; a refusal
  // says the run is no longer there to hold.
  const controlReply = pauseMutation.data ?? resumeMutation.data;
  const controlError = pauseMutation.error ?? resumeMutation.error;
  useEffect(() => {
    const reply = controlReply ?? controlError;
    if (!reply || answered.current === reply) return;
    answered.current = reply;
    if (controlReply?.success) {
      if (controlReply.operationId === operationId) setPaused(controlReply.paused);
      return;
    }
    addNotification({
      level: 'warning',
      category: 'sync',
      title: t('sync.runControls.pauseRefused'),
      message: t('sync.runControls.pauseRefusedDetail'),
    });
  }, [controlReply, controlError, operationId, addNotification, t]);

  const pauseMutate = pauseMutation.mutate;
  const resetResume = resumeMutation.reset;
  const pause = useCallback(() => {
    if (!operationId) return;
    resetResume();
    pauseMutate({ operationId });
  }, [operationId, pauseMutate, resetResume]);

  const resumeMutate = resumeMutation.mutate;
  const resetPause = pauseMutation.reset;
  const resume = useCallback(() => {
    if (!operationId) return;
    resetPause();
    resumeMutate({ operationId });
  }, [operationId, resumeMutate, resetPause]);

  const abortMutate = abortMutation.mutate;
  const cancel = useCallback(() => {
    if (!operationId) return;
    setCancelRequested(true);
    abortMutate({ operationId });
  }, [operationId, abortMutate]);

  return {
    paused,
    cancelRequested,
    pending: pauseMutation.loading || resumeMutation.loading,
    pause,
    resume,
    cancel,
  };
}
