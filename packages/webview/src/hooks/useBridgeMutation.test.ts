import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import type { BaseMessage } from '@sandforge/shared';

/**
 * Mock the useVSCodeApi hook so tests do not depend on acquireVsCodeApi.
 */
const mockPostMessage = vi.fn();

vi.mock('./useVSCodeApi', () => ({
  useVSCodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

import { useBridgeMutation } from './useBridgeMutation';

/** Dispatch a simulated extension→webview message. */
function simulateResponse(type: string, payload: unknown): void {
  const message: BaseMessage & { payload: unknown } = {
    id: `resp-${Date.now()}`,
    type,
    timestamp: Date.now(),
    payload,
  };
  window.dispatchEvent(new MessageEvent('message', { data: message }));
}

describe('useBridgeMutation', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should not send a message on mount', () => {
    const { result } = renderHook(() =>
      useBridgeMutation<{ orgId: string; status: string }>('org:connect'),
    );

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('should send a message when mutate is called', () => {
    const { result } = renderHook(() =>
      useBridgeMutation<{ orgId: string; status: string }>('org:connect'),
    );

    act(() => {
      result.current.mutate({ orgId: '', authMethod: 'sfdx_import' });
    });

    expect(result.current.loading).toBe(true);
    expect(mockPostMessage).toHaveBeenCalledOnce();

    const sentMsg = mockPostMessage.mock.calls[0][0] as BaseMessage & {
      payload: { orgId: string; authMethod: string };
    };
    expect(sentMsg.type).toBe('org:connect');
    expect(sentMsg.payload).toEqual({ orgId: '', authMethod: 'sfdx_import' });
  });

  it('should populate data when a matching response arrives', () => {
    const { result } = renderHook(() =>
      useBridgeMutation<{ orgId: string; status: string }>('org:connect', {
        responseType: 'org:statusChanged',
      }),
    );

    act(() => {
      result.current.mutate({ orgId: '', authMethod: 'sfdx_import' });
    });

    act(() => {
      simulateResponse('org:statusChanged', { orgId: 'org-1', status: 'connected' });
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toEqual({ orgId: 'org-1', status: 'connected' });
    expect(result.current.error).toBeNull();
  });

  it('should ignore non-matching response types', () => {
    const { result } = renderHook(() =>
      useBridgeMutation<{ orgId: string; status: string }>('org:connect'),
    );

    act(() => {
      result.current.mutate({ orgId: '', authMethod: 'sfdx_import' });
    });

    act(() => {
      simulateResponse('settings:response', { settings: {} });
    });

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
  });

  it('should set error on timeout', () => {
    const { result } = renderHook(() =>
      useBridgeMutation<{ orgId: string; status: string }>('org:connect', {
        timeoutMs: 5000,
      }),
    );

    act(() => {
      result.current.mutate({ orgId: '', authMethod: 'sfdx_import' });
    });

    expect(result.current.loading).toBe(true);

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe(
      "Bridge mutation 'org:connect' timed out after 5000ms",
    );
    expect(result.current.data).toBeNull();
  });

  it('should support mutate without payload', () => {
    const { result } = renderHook(() =>
      useBridgeMutation<{ orgs: string[] }>('org:list'),
    );

    act(() => {
      result.current.mutate();
    });

    expect(mockPostMessage).toHaveBeenCalledOnce();
    const sentMsg = mockPostMessage.mock.calls[0][0] as BaseMessage;
    expect(sentMsg.type).toBe('org:list');
  });

  it('should reset state when reset is called', () => {
    const { result } = renderHook(() =>
      useBridgeMutation<{ orgId: string; status: string }>('org:connect', {
        responseType: 'org:statusChanged',
      }),
    );

    act(() => {
      result.current.mutate({ orgId: '', authMethod: 'sfdx_import' });
    });

    act(() => {
      simulateResponse('org:statusChanged', { orgId: 'org-1', status: 'connected' });
    });

    expect(result.current.data).not.toBeNull();

    act(() => {
      result.current.reset();
    });

    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('should clean up listener on unmount', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    const { result, unmount } = renderHook(() =>
      useBridgeMutation<{ orgId: string; status: string }>('org:connect'),
    );

    act(() => {
      result.current.mutate({ orgId: '', authMethod: 'sfdx_import' });
    });

    expect(addSpy).toHaveBeenCalledWith('message', expect.any(Function));

    unmount();

    expect(removeSpy).toHaveBeenCalledWith('message', expect.any(Function));

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('should cancel previous mutation when mutate is called again', () => {
    const { result } = renderHook(() =>
      useBridgeMutation<{ orgs: string[] }>('org:list'),
    );

    act(() => {
      result.current.mutate();
    });

    act(() => {
      result.current.mutate();
    });

    expect(mockPostMessage).toHaveBeenCalledTimes(2);

    // Only the second mutation should accept a response
    act(() => {
      simulateResponse('org:list:response', { orgs: ['org-2'] });
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toEqual({ orgs: ['org-2'] });
  });
});
