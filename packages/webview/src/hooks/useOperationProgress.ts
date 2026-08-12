import { useState, useCallback } from 'react';

import { useMessageListener } from './useMessageBus';
import type { BaseMessage } from '@sandforge/shared';

/**
 * Upper bound of tracked operations, mirroring MAX_TRACKED_EXECUTIONS in
 * useExecutionProgress: terminal entries are kept so a finished run still shows
 * its final numbers, which without a bound grows by one entry per run for the
 * whole session. The Map keeps insertion order, so the oldest is evicted first.
 */
export const MAX_TRACKED_OPERATIONS = 20;

/** Payload of an `operation:progress` message, as HandlerTypes emits it. */
export interface OperationProgress {
  operationId: string;
  percentage: number;
  processedRecords: number;
  totalRecords: number;
  currentStep: string;
}

type OperationProgressMessage = BaseMessage & { payload: OperationProgress };

/**
 * Subscribe to `operation:progress`, the channel fifteen extension handlers
 * already emit on — Seed, Sync, DataOps, Clone, CSV and Automation.
 *
 * Nothing consumed it. Seed rendered a bar pinned at 50 % with a "0.0s" timer
 * and per-object rows frozen at 0, and Sync rendered 0 % for the whole run, so
 * a healthy multi-minute bulk load was indistinguishable from a hung one.
 *
 * `latest` exists because the mutation hooks do not surface the id of the
 * request they sent, so a page cannot yet correlate by operationId. Only one
 * run is startable per page at a time, so the most recent event is the right
 * one; `getProgress` is there for callers that do know their id.
 */
export function useOperationProgress(): {
  latest: OperationProgress | null;
  getProgress: (operationId: string) => OperationProgress | undefined;
} {
  const [progressMap, setProgressMap] = useState<Map<string, OperationProgress>>(() => new Map());
  const [latest, setLatest] = useState<OperationProgress | null>(null);

  useMessageListener<OperationProgressMessage>(
    'operation:progress',
    useCallback((message: OperationProgressMessage) => {
      const progress = message.payload;
      if (!progress || typeof progress.operationId !== 'string') return;

      setLatest(progress);
      setProgressMap((prev) => {
        const next = new Map(prev);
        // delete+set re-inserts at the end, refreshing recency.
        next.delete(progress.operationId);
        next.set(progress.operationId, progress);
        while (next.size > MAX_TRACKED_OPERATIONS) {
          const oldest = next.keys().next().value;
          if (oldest === undefined) break;
          next.delete(oldest);
        }
        return next;
      });
    }, []),
  );

  const getProgress = useCallback(
    (operationId: string): OperationProgress | undefined => progressMap.get(operationId),
    [progressMap],
  );

  return { latest, getProgress };
}
