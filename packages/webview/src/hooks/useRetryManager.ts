import { useState, useCallback, useEffect, useRef } from 'react';
import type { BaseMessage, ExecutionRetryStatusMessage, RetryStatus } from '@sandforge/shared';
import { useMessageListener, useSendMessage } from './useMessageBus';

/**
 * Hook that manages retry state for failed operations.
 * Subscribes to `execution:retry-status` messages, provides manual retry
 * and abort actions, and computes countdown timers for pending retries.
 */
export function useRetryManager(): {
  getRetryStatuses: (executionId: string) => RetryStatus[];
  manualRetry: (executionId: string, objectName: string) => void;
  abort: (executionId: string, objectName?: string) => void;
  getCountdown: (nextRetryAt: number) => number;
} {
  const [statusMap, setStatusMap] = useState<Map<string, RetryStatus[]>>(() => new Map());
  const [now, setNow] = useState<number>(() => Date.now());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sendMessage = useSendMessage();

  // Update countdown timer every second when there are active retries
  useEffect(() => {
    const hasActiveRetries = Array.from(statusMap.values()).some((statuses) =>
      statuses.some((s) => s.nextRetryAt !== null && s.nextRetryAt > Date.now()),
    );

    if (hasActiveRetries && !timerRef.current) {
      timerRef.current = setInterval(() => {
        setNow(Date.now());
      }, 1000);
    } else if (!hasActiveRetries && timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [statusMap]);

  useMessageListener<ExecutionRetryStatusMessage>(
    'execution:retry-status',
    useCallback((message: ExecutionRetryStatusMessage) => {
      const status = message.payload;
      setStatusMap((prev) => {
        const next = new Map(prev);
        const existing = next.get(status.executionId) ?? [];
        const idx = existing.findIndex((s) => s.objectName === status.objectName);
        if (idx >= 0) {
          const updated = [...existing];
          updated[idx] = status;
          next.set(status.executionId, updated);
        } else {
          next.set(status.executionId, [...existing, status]);
        }
        return next;
      });
    }, []),
  );

  const getRetryStatuses = useCallback(
    (executionId: string): RetryStatus[] => {
      return statusMap.get(executionId) ?? [];
    },
    [statusMap],
  );

  const manualRetry = useCallback(
    (executionId: string, objectName: string): void => {
      sendMessage({
        id: crypto.randomUUID(),
        type: 'execution:manual-retry',
        timestamp: Date.now(),
        payload: { executionId, objectName },
      } as unknown as BaseMessage);
    },
    [sendMessage],
  );

  const abort = useCallback(
    (executionId: string, objectName?: string): void => {
      sendMessage({
        id: crypto.randomUUID(),
        type: 'execution:abort',
        timestamp: Date.now(),
        payload: { executionId, objectName },
      } as unknown as BaseMessage);
    },
    [sendMessage],
  );

  const getCountdown = useCallback(
    (nextRetryAt: number): number => {
      const diff = Math.max(0, Math.ceil((nextRetryAt - now) / 1000));
      return diff;
    },
    [now],
  );

  return { getRetryStatuses, manualRetry, abort, getCountdown };
}
