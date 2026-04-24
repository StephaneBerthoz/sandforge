import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { RetryStatus } from '@sandforge/shared';

const mockPostMessage = vi.fn();

vi.mock('./useVSCodeApi', () => ({
  useVSCodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

import { useRetryManager } from './useRetryManager';

function dispatchRetryStatus(status: RetryStatus): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: {
        id: 'msg-' + Date.now(),
        type: 'execution:retry-status',
        timestamp: Date.now(),
        payload: status,
      },
    }),
  );
}

function createRetryStatus(overrides?: Partial<RetryStatus>): RetryStatus {
  return {
    executionId: 'exec-1',
    objectName: 'Account',
    attemptNumber: 2,
    maxAttempts: 5,
    nextRetryAt: Date.now() + 10000,
    lastError: 'UNABLE_TO_LOCK_ROW',
    canRetry: true,
    canAbort: true,
    ...overrides,
  };
}

describe('useRetryManager', () => {
  afterEach(() => {
    mockPostMessage.mockClear();
    vi.restoreAllMocks();
  });

  it('should return empty array for unknown executionId', () => {
    const { result } = renderHook(() => useRetryManager());
    expect(result.current.getRetryStatuses('unknown')).toEqual([]);
  });

  it('should track retry status from messages', () => {
    const { result } = renderHook(() => useRetryManager());

    act(() => {
      dispatchRetryStatus(createRetryStatus());
    });

    const statuses = result.current.getRetryStatuses('exec-1');
    expect(statuses).toHaveLength(1);
    expect(statuses[0].objectName).toBe('Account');
    expect(statuses[0].attemptNumber).toBe(2);
  });

  it('should update existing retry status for the same object', () => {
    const { result } = renderHook(() => useRetryManager());

    act(() => {
      dispatchRetryStatus(createRetryStatus({ attemptNumber: 1 }));
    });

    act(() => {
      dispatchRetryStatus(createRetryStatus({ attemptNumber: 3 }));
    });

    const statuses = result.current.getRetryStatuses('exec-1');
    expect(statuses).toHaveLength(1);
    expect(statuses[0].attemptNumber).toBe(3);
  });

  it('should track multiple objects independently', () => {
    const { result } = renderHook(() => useRetryManager());

    act(() => {
      dispatchRetryStatus(createRetryStatus({ objectName: 'Account' }));
    });

    act(() => {
      dispatchRetryStatus(createRetryStatus({ objectName: 'Contact' }));
    });

    const statuses = result.current.getRetryStatuses('exec-1');
    expect(statuses).toHaveLength(2);
  });

  it('should send manual-retry message', () => {
    const { result } = renderHook(() => useRetryManager());

    act(() => {
      result.current.manualRetry('exec-1', 'Account');
    });

    expect(mockPostMessage).toHaveBeenCalledOnce();
    const envelope = mockPostMessage.mock.calls[0][0];
    const msg = envelope.payload;
    expect(msg.type).toBe('execution:manual-retry');
    expect(msg.payload.executionId).toBe('exec-1');
    expect(msg.payload.objectName).toBe('Account');
  });

  it('should send abort message', () => {
    const { result } = renderHook(() => useRetryManager());

    act(() => {
      result.current.abort('exec-1', 'Account');
    });

    expect(mockPostMessage).toHaveBeenCalledOnce();
    const envelope = mockPostMessage.mock.calls[0][0];
    const msg = envelope.payload;
    expect(msg.type).toBe('execution:abort');
    expect(msg.payload.executionId).toBe('exec-1');
    expect(msg.payload.objectName).toBe('Account');
  });

  it('should send abort message without objectName', () => {
    const { result } = renderHook(() => useRetryManager());

    act(() => {
      result.current.abort('exec-1');
    });

    const envelope = mockPostMessage.mock.calls[0][0];
    const msg = envelope.payload;
    expect(msg.type).toBe('execution:abort');
    expect(msg.payload.objectName).toBeUndefined();
  });

  it('should compute countdown correctly', () => {
    const { result } = renderHook(() => useRetryManager());

    const futureTime = Date.now() + 5000;
    const countdown = result.current.getCountdown(futureTime);
    expect(countdown).toBeGreaterThanOrEqual(4);
    expect(countdown).toBeLessThanOrEqual(6);
  });

  it('should return 0 for past times', () => {
    const { result } = renderHook(() => useRetryManager());

    const pastTime = Date.now() - 5000;
    const countdown = result.current.getCountdown(pastTime);
    expect(countdown).toBe(0);
  });
});
