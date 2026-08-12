import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useOperationProgress, MAX_TRACKED_OPERATIONS } from './useOperationProgress';

/** Deliver an `operation:progress` the way the extension host posts it. */
function emit(payload: {
  operationId: string;
  percentage: number;
  processedRecords?: number;
  totalRecords?: number;
  currentStep?: string;
}): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'operation:progress',
          id: `evt-${payload.operationId}-${payload.percentage}`,
          timestamp: Date.now(),
          payload: {
            processedRecords: 0,
            totalRecords: 0,
            currentStep: '',
            ...payload,
          },
        },
        origin: '',
      }),
    );
  });
}

describe('useOperationProgress', () => {
  it('starts empty', () => {
    const { result } = renderHook(() => useOperationProgress());
    expect(result.current.latest).toBeNull();
  });

  it('surfaces the live figures the extension emits', () => {
    // Fifteen handlers emit this channel and nothing consumed it, which is why
    // Seed rendered a bar pinned at 50 % and Sync one pinned at 0 %.
    const { result } = renderHook(() => useOperationProgress());

    emit({
      operationId: 'op-1',
      percentage: 42,
      processedRecords: 1200,
      totalRecords: 5000,
      currentStep: 'Bulk insert Contact',
    });

    expect(result.current.latest).toMatchObject({
      operationId: 'op-1',
      percentage: 42,
      processedRecords: 1200,
      totalRecords: 5000,
      currentStep: 'Bulk insert Contact',
    });
    expect(result.current.getProgress('op-1')?.percentage).toBe(42);
  });

  it('keeps the most recent value per operation', () => {
    const { result } = renderHook(() => useOperationProgress());

    emit({ operationId: 'op-1', percentage: 10 });
    emit({ operationId: 'op-1', percentage: 90 });

    expect(result.current.getProgress('op-1')?.percentage).toBe(90);
    expect(result.current.latest?.percentage).toBe(90);
  });

  it('tracks operations independently', () => {
    const { result } = renderHook(() => useOperationProgress());

    emit({ operationId: 'op-1', percentage: 10 });
    emit({ operationId: 'op-2', percentage: 70 });

    expect(result.current.getProgress('op-1')?.percentage).toBe(10);
    expect(result.current.getProgress('op-2')?.percentage).toBe(70);
    expect(result.current.latest?.operationId).toBe('op-2');
  });

  it('evicts the oldest entry past the cap', () => {
    // Terminal entries are retained so a finished run keeps its final numbers,
    // so without a bound the map grows for the whole session.
    const { result } = renderHook(() => useOperationProgress());

    for (let i = 0; i <= MAX_TRACKED_OPERATIONS; i++) {
      emit({ operationId: `op-${i}`, percentage: i });
    }

    expect(result.current.getProgress('op-0')).toBeUndefined();
    expect(result.current.getProgress(`op-${MAX_TRACKED_OPERATIONS}`)).toBeDefined();
  });

  it('ignores a malformed payload rather than tracking a bogus entry', () => {
    const { result } = renderHook(() => useOperationProgress());

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'operation:progress', id: 'evt-bad', timestamp: Date.now(), payload: {} },
          origin: '',
        }),
      );
    });

    expect(result.current.latest).toBeNull();
  });
});
