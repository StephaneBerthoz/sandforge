import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useFrozenStore } from '../../stores/useFrozenStore';
import { useFrozenMutation } from './useFrozenBridge';

const mockPostMessage = vi.fn();
const api = {
  postMessage: (...args: unknown[]) => mockPostMessage(...args),
  getState: () => undefined,
  setState: () => undefined,
};

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => api,
  getVscodeApi: () => api,
}));

/** Deliver a `frozen:load:error` correlated to `correlationId`. */
function loadError(correlationId: string): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: 'host-err',
          type: 'frozen:load:error',
          timestamp: Date.now(),
          correlationId,
          payload: { message: 'Load failed', code: 'LOAD_ERROR', retryable: false },
        },
      }),
    );
  });
}

describe('useFrozenMutation', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    useFrozenStore.setState({ lastError: null });
  });

  it('ignores an error answering a request it did not send', () => {
    // Every panel receives every error. This listener used to take any
    // frozen:load:error, so another panel's failed load cancelled this one.
    const { result } = renderHook(() => useFrozenMutation<{ ok: boolean }>('frozen:load'));
    act(() => {
      result.current.mutate({ datasetPath: '/data/set' });
    });

    loadError('wv-another-panel');

    expect(useFrozenStore.getState().lastError).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it('records the error answering its own request and stops waiting', () => {
    const { result } = renderHook(() => useFrozenMutation<{ ok: boolean }>('frozen:load'));
    act(() => {
      result.current.mutate({ datasetPath: '/data/set' });
    });
    const sent = mockPostMessage.mock.calls[0][0] as { payload: { id: string } };

    loadError(sent.payload.id);

    expect(useFrozenStore.getState().lastError).toEqual({
      source: 'frozen:load',
      message: 'Load failed',
      code: 'LOAD_ERROR',
      retryable: false,
    });
    expect(result.current.loading).toBe(false);
  });
});
