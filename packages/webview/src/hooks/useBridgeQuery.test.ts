import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import type { BaseMessage } from '@sandforge/shared';

/**
 * Mock the useVSCodeApi hook so tests do not depend on acquireVsCodeApi.
 * Return a **stable** object so that useSendMessage's useCallback dependency
 * does not change identity between renders.
 */
const mockPostMessage = vi.fn();

const stableApi = {
  postMessage: (...args: unknown[]) => mockPostMessage(...args),
  getState: () => undefined,
  setState: () => undefined,
};

vi.mock('./useVSCodeApi', () => ({
  useVSCodeApi: () => stableApi,
}));

import { useBridgeQuery } from './useBridgeQuery';

/** Dispatch a simulated extension→webview message. */
function simulateResponse(type: string, payload: unknown, correlationId?: string): void {
  const message: BaseMessage & { payload: unknown } = {
    id: `resp-${Date.now()}`,
    type,
    timestamp: Date.now(),
    payload,
  };
  if (correlationId) {
    message.correlationId = correlationId;
  }
  window.dispatchEvent(new MessageEvent('message', { data: message }));
}

/** The id of the last request sent — what a handler correlates its reply to. */
function lastRequestId(): string {
  const calls = mockPostMessage.mock.calls;
  const envelope = calls[calls.length - 1][0] as { payload: BaseMessage };
  return envelope.payload.id;
}

/** Answer the request in flight the way a handler does: correlated to its id. */
function replyToLastRequest(type: string, payload: unknown): void {
  simulateResponse(type, payload, lastRequestId());
}

describe('useBridgeQuery', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should send a message on mount and set loading to true', () => {
    const { result } = renderHook(() => useBridgeQuery<{ orgs: string[] }>('org:list'));

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
    expect(mockPostMessage).toHaveBeenCalledOnce();

    // Outbound messages are wrapped in an envelope — unwrap payload.
    const envelope = mockPostMessage.mock.calls[0][0] as { payload: BaseMessage };
    expect(envelope.payload.type).toBe('org:list');
  });

  it('should populate data when a matching response arrives', () => {
    const { result } = renderHook(() => useBridgeQuery<{ orgs: string[] }>('org:list'));

    act(() => {
      replyToLastRequest('org:list:response', { orgs: ['org-1', 'org-2'] });
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toEqual({ orgs: ['org-1', 'org-2'] });
    expect(result.current.error).toBeNull();
  });

  it('should ignore non-matching response types', () => {
    const { result } = renderHook(() => useBridgeQuery<{ orgs: string[] }>('org:list'));

    act(() => {
      simulateResponse('settings:response', { settings: {} });
    });

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
  });

  it('should set error on timeout', () => {
    const { result } = renderHook(() =>
      useBridgeQuery<{ orgs: string[] }>('org:list', undefined, {
        timeoutMs: 5000,
      }),
    );

    expect(result.current.loading).toBe(true);

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe("Bridge query 'org:list' timed out after 5000ms");
    expect(result.current.data).toBeNull();
  });

  it('should support manual refetch', () => {
    const { result } = renderHook(() => useBridgeQuery<{ orgs: string[] }>('org:list'));

    // First response
    act(() => {
      replyToLastRequest('org:list:response', { orgs: ['org-1'] });
    });

    expect(result.current.data).toEqual({ orgs: ['org-1'] });
    expect(mockPostMessage).toHaveBeenCalledTimes(1);

    // Refetch
    act(() => {
      result.current.refetch();
    });

    expect(result.current.loading).toBe(true);
    expect(mockPostMessage).toHaveBeenCalledTimes(2);

    // Second response
    act(() => {
      replyToLastRequest('org:list:response', { orgs: ['org-1', 'org-2'] });
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toEqual({ orgs: ['org-1', 'org-2'] });
  });

  it('should skip automatic query when skip option is true', () => {
    const { result } = renderHook(() =>
      useBridgeQuery<{ orgs: string[] }>('org:list', undefined, {
        skip: true,
      }),
    );

    expect(result.current.loading).toBe(false);
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('should allow refetch even when initially skipped', () => {
    const { result } = renderHook(() =>
      useBridgeQuery<{ orgs: string[] }>('org:list', undefined, {
        skip: true,
      }),
    );

    act(() => {
      result.current.refetch();
    });

    expect(result.current.loading).toBe(true);
    expect(mockPostMessage).toHaveBeenCalledOnce();

    act(() => {
      replyToLastRequest('org:list:response', { orgs: ['org-1'] });
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toEqual({ orgs: ['org-1'] });
  });

  it('should use custom responseType when provided', () => {
    const { result } = renderHook(() =>
      useBridgeQuery<{ orgId: string; status: string }>('org:connect', undefined, {
        responseType: 'org:statusChanged',
      }),
    );

    act(() => {
      replyToLastRequest('org:statusChanged', { orgId: 'org-1', status: 'connected' });
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toEqual({ orgId: 'org-1', status: 'connected' });
  });

  it('should send payload when provided', () => {
    renderHook(() => useBridgeQuery<{ orgs: string[] }>('org:list', { filter: 'sandbox' }));

    const envelope = mockPostMessage.mock.calls[0][0] as {
      payload: BaseMessage & {
        payload: { filter: string };
      };
    };
    const sentMsg = envelope.payload;
    expect(sentMsg.type).toBe('org:list');
    expect(sentMsg.payload).toEqual({ filter: 'sandbox' });
  });

  it('should clean up listener on unmount', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    const { unmount } = renderHook(() => useBridgeQuery<{ orgs: string[] }>('org:list'));

    expect(addSpy).toHaveBeenCalledWith('message', expect.any(Function));

    unmount();

    expect(removeSpy).toHaveBeenCalledWith('message', expect.any(Function));

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('returns the same object across a rerender that changes nothing', () => {
    const { result, rerender } = renderHook(() => useBridgeQuery<{ orgs: string[] }>('org:list'));

    const first = result.current;
    rerender();

    expect(result.current).toBe(first);
  });

  it('ignores an uncorrelated push of the response type by default', () => {
    const { result } = renderHook(() => useBridgeQuery<{ enabled: boolean }>('ai:status'));

    act(() => {
      simulateResponse('ai:status:response', { enabled: false });
    });

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
  });

  it('takes the same push once the query opts in', () => {
    // The option reaches the listener: an uncorrelated message of the response
    // type answers a query that asks for it.
    const { result } = renderHook(() =>
      useBridgeQuery<{ orgs: string[] }>('org:list', undefined, { acceptUncorrelated: true }),
    );

    act(() => {
      simulateResponse('org:list:response', { orgs: ['org-9'] });
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toEqual({ orgs: ['org-9'] });
  });

  it('should not update state after unmount', () => {
    const { result, unmount } = renderHook(() => useBridgeQuery<{ orgs: string[] }>('org:list'));

    unmount();

    // Simulate a late response — should not throw or update
    act(() => {
      simulateResponse('org:list:response', { orgs: ['late'] });
    });

    // After unmount, the last captured state should still show loading
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
  });
});
