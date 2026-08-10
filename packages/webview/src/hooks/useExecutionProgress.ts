import { useState, useCallback } from 'react';
import type { BulkExecutionProgress, ExecutionProgressMessage } from '@sandforge/shared';
import { useMessageListener } from './useMessageBus';

/**
 * Upper bound of tracked executions. Terminal entries are kept (consumers
 * display the final state of an execution), so without a bound the map grew
 * by one entry per execution for the whole session lifetime. The Map keeps
 * insertion order, so the oldest execution is evicted first.
 */
export const MAX_TRACKED_EXECUTIONS = 20;

/**
 * Hook that subscribes to `execution:progress` messages and maintains
 * a bounded map of execution progress states (see MAX_TRACKED_EXECUTIONS).
 *
 * @returns Progress getter and list of active execution IDs.
 */
export function useExecutionProgress(): {
  getProgress: (executionId: string) => BulkExecutionProgress | undefined;
  activeExecutions: string[];
} {
  const [progressMap, setProgressMap] = useState<Map<string, BulkExecutionProgress>>(
    () => new Map(),
  );

  useMessageListener<ExecutionProgressMessage>(
    'execution:progress',
    useCallback((message: ExecutionProgressMessage) => {
      setProgressMap((prev) => {
        const next = new Map(prev);
        // delete+set re-inserts at the end, refreshing recency for an
        // already-tracked execution.
        next.delete(message.payload.executionId);
        next.set(message.payload.executionId, message.payload);
        while (next.size > MAX_TRACKED_EXECUTIONS) {
          const oldest = next.keys().next().value;
          if (oldest === undefined) break;
          next.delete(oldest);
        }
        return next;
      });
    }, []),
  );

  const getProgress = useCallback(
    (executionId: string): BulkExecutionProgress | undefined => {
      return progressMap.get(executionId);
    },
    [progressMap],
  );

  const activeExecutions = Array.from(progressMap.keys());

  return { getProgress, activeExecutions };
}
