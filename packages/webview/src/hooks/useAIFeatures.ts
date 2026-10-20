/**
 * Hooks for AI features.
 * Thin wrappers around useBridgeMutation for type-safe AI feature access.
 */

import { useCallback, useMemo, useRef } from 'react';
import type {
  AISchemaAdviceResponse,
  AIAnomalyScanResponse,
  AIGeneratePipelineResponse,
} from '@sandforge/shared';

import { useBridgeMutation } from './useBridgeMutation';
import type { BridgeMutationState } from './useBridgeMutation';
import { useSendMessage } from './useMessageBus';
import { buildMessage } from '../bridge/messageHelpers';

/** A model-backed draft request, with the Stop the AI chat has. */
export interface StoppableAITool<T> extends BridgeMutationState<T> {
  /**
   * Stop the draft in flight: the extension aborts its call to the model
   * (`ai:tool:cancel`, answered `CANCELLED`), and the request is back to idle
   * at once — no error, and nothing of an answer that comes after is applied.
   * Does nothing while no draft is waiting.
   */
  stop: () => void;
}

/**
 * Give a model-backed request a Stop.
 *
 * A Forge root query drafted from a description and an Automation pipeline
 * draft each
 * wait on a provider, and a slow one held the page under a spinner until its
 * answer or its timeout, with no way to give up. The chat could be stopped;
 * these could not.
 */
export function useStoppableAITool<T>(mutation: BridgeMutationState<T>): StoppableAITool<T> {
  const send = useSendMessage();
  // Held in a ref so `stop` keeps its identity when the VS Code API wrapper
  // does not, as `mutate` does.
  const sendRef = useRef(send);
  sendRef.current = send;
  const { mutate, data, loading, error, errorCode, reset, requestId } = mutation;

  const stop = useCallback(() => {
    if (!loading || requestId === null) return;
    sendRef.current(buildMessage<{ requestId: string }>('ai:tool:cancel', { requestId }));
    reset();
  }, [loading, requestId, reset]);

  // One object per state change, as useBridgeMutation gives: field by field,
  // so it follows the request's state whatever object carried it.
  return useMemo(
    () => ({ mutate, data, loading, error, errorCode, reset, requestId, stop }),
    [mutate, data, loading, error, errorCode, reset, requestId, stop],
  );
}

/** Schema advice for an org — rule-based, no model call. */
export function useSchemaAdvice() {
  return useBridgeMutation<AISchemaAdviceResponse['payload']>('ai:schema-advice');
}

/** Anomaly scan over sampled records — rule-based, no model call. */
export function useAnomalyScan() {
  return useBridgeMutation<AIAnomalyScanResponse['payload']>('ai:anomaly-scan');
}

/** AI pipeline generation from description. */
export function usePipelineGenerator() {
  return useStoppableAITool(
    useBridgeMutation<AIGeneratePipelineResponse['payload']>('ai:generate-pipeline'),
  );
}
