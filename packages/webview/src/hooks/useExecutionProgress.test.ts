import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { BulkExecutionProgress } from '@sandforge/shared';

const mockPostMessage = vi.fn();

vi.mock('./useVSCodeApi', () => ({
  useVSCodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

import { useExecutionProgress, MAX_TRACKED_EXECUTIONS } from './useExecutionProgress';

function dispatchProgress(progress: BulkExecutionProgress): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: {
        id: 'msg-' + Date.now(),
        type: 'execution:progress',
        timestamp: Date.now(),
        payload: progress,
      },
    }),
  );
}

function createProgress(executionId: string, overallPercent: number): BulkExecutionProgress {
  return {
    executionId,
    objects: [
      {
        objectName: 'Account',
        jobId: 'job-1',
        operation: 'insert',
        recordsProcessed: overallPercent,
        recordsFailed: 0,
        totalRecords: 100,
        state: overallPercent === 100 ? 'complete' : 'processing',
        startedAt: Date.now(),
      },
    ],
    overallPercent,
    elapsedMs: 5000,
  };
}

describe('useExecutionProgress', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return undefined for unknown executionId', () => {
    const { result } = renderHook(() => useExecutionProgress());
    expect(result.current.getProgress('unknown')).toBeUndefined();
  });

  it('should return empty activeExecutions initially', () => {
    const { result } = renderHook(() => useExecutionProgress());
    expect(result.current.activeExecutions).toEqual([]);
  });

  it('should track progress when execution:progress message arrives', () => {
    const { result } = renderHook(() => useExecutionProgress());

    act(() => {
      dispatchProgress(createProgress('exec-1', 50));
    });

    const progress = result.current.getProgress('exec-1');
    expect(progress).toBeDefined();
    expect(progress?.overallPercent).toBe(50);
    expect(result.current.activeExecutions).toContain('exec-1');
  });

  it('should update progress for existing execution', () => {
    const { result } = renderHook(() => useExecutionProgress());

    act(() => {
      dispatchProgress(createProgress('exec-1', 25));
    });

    act(() => {
      dispatchProgress(createProgress('exec-1', 75));
    });

    const progress = result.current.getProgress('exec-1');
    expect(progress?.overallPercent).toBe(75);
  });

  it('should track multiple executions independently', () => {
    const { result } = renderHook(() => useExecutionProgress());

    act(() => {
      dispatchProgress(createProgress('exec-1', 30));
    });

    act(() => {
      dispatchProgress(createProgress('exec-2', 60));
    });

    expect(result.current.getProgress('exec-1')?.overallPercent).toBe(30);
    expect(result.current.getProgress('exec-2')?.overallPercent).toBe(60);
    expect(result.current.activeExecutions).toHaveLength(2);
  });

  it('should evict the oldest execution once the map exceeds the cap', () => {
    const { result } = renderHook(() => useExecutionProgress());

    act(() => {
      for (let i = 0; i < MAX_TRACKED_EXECUTIONS + 1; i++) {
        dispatchProgress(createProgress(`exec-${String(i)}`, 50));
      }
    });

    expect(result.current.activeExecutions).toHaveLength(MAX_TRACKED_EXECUTIONS);
    expect(result.current.getProgress('exec-0')).toBeUndefined();
    expect(result.current.getProgress(`exec-${String(MAX_TRACKED_EXECUTIONS)}`)).toBeDefined();
  });

  it('should keep tracking while at least one object is still running', () => {
    const { result } = renderHook(() => useExecutionProgress());

    const mixed: BulkExecutionProgress = {
      executionId: 'exec-mixed',
      objects: [
        {
          objectName: 'Account',
          jobId: 'job-1',
          operation: 'insert',
          recordsProcessed: 100,
          recordsFailed: 0,
          totalRecords: 100,
          state: 'complete',
          startedAt: Date.now(),
        },
        {
          objectName: 'Contact',
          jobId: 'job-2',
          operation: 'insert',
          recordsProcessed: 10,
          recordsFailed: 0,
          totalRecords: 100,
          state: 'processing',
          startedAt: Date.now(),
        },
      ],
      overallPercent: 55,
      elapsedMs: 5000,
    };

    act(() => {
      dispatchProgress(mixed);
    });

    expect(result.current.getProgress('exec-mixed')).toBeDefined();
  });
});
