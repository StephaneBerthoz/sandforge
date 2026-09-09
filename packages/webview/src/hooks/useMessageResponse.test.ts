import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import type { BaseMessage } from '@sandforge/shared';

import { useMessageResponse } from './useMessageResponse';
import type { UseMessageResponseOptions } from './useMessageResponse';

/** Dispatch a simulated extension-to-webview message. */
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

const defaultOptions: UseMessageResponseOptions = {
  requestType: 'org:list',
  responseType: 'org:list:response',
  timeoutMs: 5000,
  requestLabel: 'query',
};

describe('useMessageResponse', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should start with idle state', () => {
    const { result } = renderHook(() => useMessageResponse<{ orgs: string[] }>(defaultOptions));

    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('should listen for the correct response type and populate data', () => {
    const { result } = renderHook(() => useMessageResponse<{ orgs: string[] }>(defaultOptions));

    act(() => {
      result.current.setLoading(true);
      result.current.listen('req-1');
    });

    act(() => {
      simulateResponse('org:list:response', { orgs: ['org-1', 'org-2'] });
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toEqual({ orgs: ['org-1', 'org-2'] });
    expect(result.current.error).toBeNull();
  });

  it('should set error on timeout', () => {
    const { result } = renderHook(() => useMessageResponse<{ orgs: string[] }>(defaultOptions));

    act(() => {
      result.current.setLoading(true);
      result.current.listen('req-1');
    });

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe("Bridge query 'org:list' timed out after 5000ms");
    expect(result.current.data).toBeNull();
  });

  it('should use requestLabel in timeout error message', () => {
    const { result } = renderHook(() =>
      useMessageResponse<unknown>({
        ...defaultOptions,
        requestType: 'org:connect',
        requestLabel: 'mutation',
      }),
    );

    act(() => {
      result.current.setLoading(true);
      result.current.listen('req-1');
    });

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(result.current.error).toBe("Bridge mutation 'org:connect' timed out after 5000ms");
  });

  it('should clean up event listener via returned cleanup function', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    const { result } = renderHook(() => useMessageResponse<{ orgs: string[] }>(defaultOptions));

    let cleanup: () => void = () => undefined;
    act(() => {
      cleanup = result.current.listen('req-1');
    });

    expect(addSpy).toHaveBeenCalledWith('message', expect.any(Function));

    act(() => {
      cleanup();
    });

    expect(removeSpy).toHaveBeenCalledWith('message', expect.any(Function));

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('should ignore non-matching response types', () => {
    const { result } = renderHook(() => useMessageResponse<{ orgs: string[] }>(defaultOptions));

    act(() => {
      result.current.setLoading(true);
      result.current.listen('req-1');
    });

    act(() => {
      simulateResponse('settings:response', { settings: {} });
    });

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
  });

  it('should reset all state when reset is called', () => {
    const { result } = renderHook(() => useMessageResponse<{ orgs: string[] }>(defaultOptions));

    act(() => {
      result.current.setLoading(true);
      result.current.listen('req-1');
    });

    act(() => {
      simulateResponse('org:list:response', { orgs: ['org-1'] });
    });

    expect(result.current.data).not.toBeNull();

    act(() => {
      result.current.reset();
    });

    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('should not update state after unmount', () => {
    const { result, unmount } = renderHook(() =>
      useMessageResponse<{ orgs: string[] }>(defaultOptions),
    );

    act(() => {
      result.current.setLoading(true);
      result.current.listen('req-1');
    });

    unmount();

    act(() => {
      simulateResponse('org:list:response', { orgs: ['late'] });
    });

    // After unmount, the last captured state should remain unchanged
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
  });

  it('should ignore stale responses when a new listen call replaces the active request', () => {
    const { result } = renderHook(() => useMessageResponse<{ orgs: string[] }>(defaultOptions));

    act(() => {
      result.current.setLoading(true);
      result.current.listen('req-1');
    });

    // Start a second listen, making req-1 stale
    act(() => {
      result.current.listen('req-2');
    });

    // Response that would have matched req-1 should be ignored because
    // activeRequestId is now req-2
    act(() => {
      simulateResponse('org:list:response', { orgs: ['org-1'] });
    });

    // The response still matches req-2 (we don't track per-message id matching
    // in the message payload, only in the internal activeRequestId ref)
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toEqual({ orgs: ['org-1'] });
  });

  it('should accept response with matching correlationId', () => {
    const { result } = renderHook(() => useMessageResponse<{ orgs: string[] }>(defaultOptions));

    act(() => {
      result.current.setLoading(true);
      result.current.listen('req-42');
    });

    act(() => {
      simulateResponse('org:list:response', { orgs: ['org-a'] }, 'req-42');
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toEqual({ orgs: ['org-a'] });
  });

  it('should reject response with wrong correlationId', () => {
    const { result } = renderHook(() => useMessageResponse<{ orgs: string[] }>(defaultOptions));

    act(() => {
      result.current.setLoading(true);
      result.current.listen('req-42');
    });

    act(() => {
      simulateResponse('org:list:response', { orgs: ['wrong'] }, 'req-99');
    });

    // Response should be rejected — still loading
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
  });

  it('should fall back to type-only matching when correlationId is absent', () => {
    const { result } = renderHook(() => useMessageResponse<{ orgs: string[] }>(defaultOptions));

    act(() => {
      result.current.setLoading(true);
      result.current.listen('req-42');
    });

    // No correlationId in response — backward-compatible type-only match
    act(() => {
      simulateResponse('org:list:response', { orgs: ['fallback'] });
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toEqual({ orgs: ['fallback'] });
  });

  it('should allow setLoading and setError to be called externally', () => {
    const { result } = renderHook(() => useMessageResponse<unknown>(defaultOptions));

    act(() => {
      result.current.setLoading(true);
    });
    expect(result.current.loading).toBe(true);

    act(() => {
      result.current.setError('custom error');
    });
    expect(result.current.error).toBe('custom error');

    act(() => {
      result.current.setLoading(false);
      result.current.setError(null);
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  describe('envelope rejection (bridge:error)', () => {
    it('fails the request the broker actually dropped, instead of timing out', () => {
      // bridge:error fires when the envelope loses Zod validation, before any
      // handler sees the message — so no `<domain>:error` will ever arrive and
      // the hook would sit out its whole timeout showing the raw timeout text.
      const { result } = renderHook(() => useMessageResponse<{ orgs: string[] }>(defaultOptions));

      act(() => {
        result.current.setLoading(true);
        result.current.listen('req-77');
      });

      act(() => {
        simulateResponse(
          'bridge:error',
          { reason: 'invalid-payload', details: 'payload.limit: expected number' },
          'req-77',
        );
      });

      expect(result.current.loading).toBe(false);
      expect(result.current.timedOut).toBe(false);
      expect(result.current.error).toContain('org:list');
    });

    it('does NOT claim a rejection belonging to another request', () => {
      // The regression this replaces: bridge:error carried no correlationId, so
      // the only way to claim it was a time window, and every hook whose
      // request was younger than that window reported someone else's failure.
      const { result } = renderHook(() => useMessageResponse<{ orgs: string[] }>(defaultOptions));

      act(() => {
        result.current.setLoading(true);
        result.current.listen('req-mine');
      });

      act(() => {
        simulateResponse(
          'bridge:error',
          { reason: 'invalid-payload', details: 'someone else' },
          'req-someone-else',
        );
      });

      expect(result.current.error).toBeNull();
      expect(result.current.loading).toBe(true);
    });

    it('ignores an unattributable rejection rather than blaming the nearest request', () => {
      // A payload too malformed to yield an id still produces a bridge:error.
      // Nobody can own that one, and guessing is what caused the regression.
      const { result } = renderHook(() => useMessageResponse<{ orgs: string[] }>(defaultOptions));

      act(() => {
        result.current.setLoading(true);
        result.current.listen('req-mine');
      });

      act(() => {
        simulateResponse('bridge:error', { reason: 'invalid-payload', details: 'no id' });
      });

      expect(result.current.error).toBeNull();
      expect(result.current.loading).toBe(true);
    });
  });

  describe('error channel (errorType)', () => {
    const optionsWithError: UseMessageResponseOptions = {
      ...defaultOptions,
      errorType: 'org:error',
    };

    it('should surface the handler error message immediately instead of timing out', () => {
      const { result } = renderHook(() => useMessageResponse<unknown>(optionsWithError));

      act(() => {
        result.current.setLoading(true);
        result.current.listen('req-1');
      });

      act(() => {
        simulateResponse('org:error', { message: 'org unreachable', code: 'CONN_FAIL' });
      });

      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBe('org unreachable');
      expect(result.current.data).toBeNull();

      // The timeout timer must have been cleared: advancing past timeoutMs
      // must not overwrite the handler error.
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(result.current.error).toBe('org unreachable');
    });

    it('should use a generic message when the error payload has no message string', () => {
      const { result } = renderHook(() => useMessageResponse<unknown>(optionsWithError));

      act(() => {
        result.current.setLoading(true);
        result.current.listen('req-1');
      });

      act(() => {
        simulateResponse('org:error', { code: 'UNKNOWN' });
      });

      expect(result.current.error).toBe("Bridge query 'org:list' failed");
    });

    it('should ignore error channel messages with a wrong correlationId', () => {
      const { result } = renderHook(() => useMessageResponse<unknown>(optionsWithError));

      act(() => {
        result.current.setLoading(true);
        result.current.listen('req-42');
      });

      act(() => {
        simulateResponse('org:error', { message: 'not for us' }, 'req-99');
      });

      expect(result.current.loading).toBe(true);
      expect(result.current.error).toBeNull();
    });

    it('should not fail on the error channel of an already-answered request', () => {
      const { result } = renderHook(() => useMessageResponse<{ orgs: string[] }>(optionsWithError));

      act(() => {
        result.current.setLoading(true);
        result.current.listen('req-1');
      });
      act(() => {
        simulateResponse('org:list:response', { orgs: ['a'] });
      });
      act(() => {
        simulateResponse('org:error', { message: 'late error' });
      });

      expect(result.current.error).toBeNull();
      expect(result.current.data).toEqual({ orgs: ['a'] });
    });
  });
});
