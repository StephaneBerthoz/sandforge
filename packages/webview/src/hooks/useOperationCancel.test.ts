import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import type { BaseMessage } from '@sandforge/shared';
import { useNotificationStore } from '../stores/useNotificationStore';

const mockPostMessage = vi.fn();

vi.mock('./useVSCodeApi', () => ({
  useVSCodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

import { useOperationCancel } from './useOperationCancel';

const REFUSED = { title: 'Could not stop it', message: 'It is no longer in progress.' };

/** The `execution:abort` requests sent so far. */
function aborts(): Array<BaseMessage & { payload?: unknown }> {
  return mockPostMessage.mock.calls
    .map((call) => (call[0] as { payload: BaseMessage & { payload?: unknown } }).payload)
    .filter((message) => message.type === 'execution:abort');
}

/** Answer the last abort as the extension does: correlated to its id. */
function answerAbort(payload: unknown): void {
  const last = aborts().at(-1);
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: `resp-${Date.now()}`,
          type: 'execution:abort:response',
          timestamp: Date.now(),
          correlationId: last?.id,
          payload,
        },
      }),
    );
  });
}

describe('useOperationCancel', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    useNotificationStore.setState({ notifications: [] });
  });

  it('sends nothing while no run is named', () => {
    const { result } = renderHook(() => useOperationCancel(null, REFUSED));

    act(() => result.current.cancel());

    expect(aborts()).toEqual([]);
    expect(result.current.requested).toBe(false);
  });

  it('stops the run by the id of the request that started it, and says it asked', () => {
    const { result } = renderHook(() => useOperationCancel('run-1', REFUSED));

    act(() => result.current.cancel());

    expect(aborts().map((m) => m.payload)).toEqual([{ operationId: 'run-1' }]);
    expect(result.current.requested).toBe(true);
    answerAbort({ success: true, operationId: 'run-1' });
    expect(result.current.requested).toBe(true);
    expect(useNotificationStore.getState().notifications).toEqual([]);
  });

  it('says a refused cancel once, and offers Cancel again', () => {
    const { result } = renderHook(() => useOperationCancel('run-1', REFUSED));

    act(() => result.current.cancel());
    answerAbort({ success: false, error: 'Operation not found' });

    expect(result.current.requested).toBe(false);
    expect(useNotificationStore.getState().notifications).toEqual([
      expect.objectContaining({ level: 'warning', ...REFUSED }),
    ]);
  });

  it('starts another run with nothing asked of it', () => {
    const { result, rerender } = renderHook(({ id }) => useOperationCancel(id, REFUSED), {
      initialProps: { id: 'run-1' as string | null },
    });
    act(() => result.current.cancel());
    expect(result.current.requested).toBe(true);

    rerender({ id: 'run-2' });

    expect(result.current.requested).toBe(false);
  });
});
