import { useState } from 'react';
import type { BaseMessage, RunCheckpointInfo } from '@sandforge/shared';
import { runCheckpointOf } from '../utils/runCheckpoint';
import { useMessageListener } from './useMessageBus';

/**
 * What became of the checkpoint a run took first, as the error that stopped
 * it says: deleted, for a run stopped before its first write — its mute
 * refused once the take was through —, or kept, for one that failed after it
 * wrote. A run that ends has it in its result; one that stops answers on its
 * error channel, and `useMessageResponse` hands on the words alone.
 *
 * @param errorType - The channel the run's request answers errors on.
 * @param requestId - The request that started the run; null before one.
 * @returns The checkpoint its error named; undefined before it, for a run
 *   that took none, and once another request goes.
 */
export function useStoppedRunCheckpoint(
  errorType: string,
  requestId: string | null,
): RunCheckpointInfo | undefined {
  const [stopped, setStopped] = useState<{
    requestId: string;
    checkpoint: RunCheckpointInfo;
  } | null>(null);
  useMessageListener<BaseMessage & { payload?: { checkpoint?: unknown } }>(errorType, (message) => {
    if (requestId === null || message.correlationId !== requestId) return;
    const checkpoint = runCheckpointOf(message.payload?.checkpoint);
    if (checkpoint) setStopped({ requestId, checkpoint });
  });
  return stopped !== null && stopped.requestId === requestId ? stopped.checkpoint : undefined;
}
