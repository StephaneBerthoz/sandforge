import { useState, useCallback } from 'react';
import type { BaseMessage, BulkExecutionProgress } from '@sandforge/shared';
import { useMessageListener } from './useMessageBus';

/** Message shape for execution:progress events. */
interface ExecutionProgressMessage extends BaseMessage {
  type: 'execution:progress';
  payload: BulkExecutionProgress;
}

/**
 * Hook that subscribes to `execution:progress` messages and maintains
 * a map of active execution progress states.
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
        next.set(message.payload.executionId, message.payload);
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
