import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import '../../i18n';
import { useSyncRunControls, SYNC_RUN_TIMEOUT_MS } from './useSyncRunControls';

const posted = vi.hoisted(() => ({ messages: [] as Array<Record<string, unknown>> }));
const notified = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));

const vscodeApi = vi.hoisted(() => ({
  postMessage: (envelope: { payload: Record<string, unknown> }) => {
    posted.messages.push(envelope.payload);
  },
  getState: () => undefined,
  setState: () => undefined,
}));

vi.mock('../../hooks/useVSCodeApi', () => ({
  getVscodeApi: () => vscodeApi,
  useVSCodeApi: () => vscodeApi,
}));

vi.mock('../../stores/useNotificationStore', () => ({
  useNotificationStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      addNotification: (n: Record<string, unknown>) => {
        notified.calls.push(n);
        return 'n';
      },
    }),
}));

/** The last request of `type` the page sent. */
function sent(type: string): Record<string, unknown> {
  const message = [...posted.messages].reverse().find((m) => m.type === type);
  if (!message) throw new Error(`no ${type} was sent`);
  return message;
}

/** The host answers the request `to`. */
function answer(type: string, to: Record<string, unknown>, payload: Record<string, unknown>) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: `host-${String(to.id)}`,
          type,
          timestamp: Date.now(),
          correlationId: to.id,
          payload,
        },
      }),
    );
  });
}

describe('useSyncRunControls', () => {
  beforeEach(() => {
    posted.messages = [];
    notified.calls = [];
  });

  it('cancels on the channel Live Operations cancels on, naming its own run', () => {
    const { result } = renderHook(() => useSyncRunControls('wv-run-1'));

    act(() => result.current.cancel());

    expect(sent('execution:abort').payload).toEqual({ operationId: 'wv-run-1' });
    expect(result.current.cancelRequested).toBe(true);
  });

  it('says so when the extension refuses the cancel, and offers it again', () => {
    const { result } = renderHook(() => useSyncRunControls('wv-run-1'));

    act(() => result.current.cancel());
    answer('execution:abort:response', sent('execution:abort'), {
      success: false,
      error: 'Operation already finished',
    });

    expect(result.current.cancelRequested).toBe(false);
    expect(notified.calls).toEqual([
      expect.objectContaining({ level: 'warning', title: 'Could not cancel the run' }),
    ]);
  });

  it('is paused only once the extension says the run is held, and resumed the same way', () => {
    const { result } = renderHook(() => useSyncRunControls('wv-run-1'));

    act(() => result.current.pause());
    expect(sent('sync:pause').payload).toEqual({ operationId: 'wv-run-1' });
    expect(result.current.paused).toBe(false);
    expect(result.current.pending).toBe(true);

    answer('sync:pause:response', sent('sync:pause'), {
      success: true,
      operationId: 'wv-run-1',
      paused: true,
    });
    expect(result.current.paused).toBe(true);
    expect(result.current.pending).toBe(false);

    act(() => result.current.resume());
    answer('sync:resume:response', sent('sync:resume'), {
      success: true,
      operationId: 'wv-run-1',
      paused: false,
    });
    expect(result.current.paused).toBe(false);
  });

  it('says a pause was refused for a run that is no longer there, and stays unpaused', () => {
    const { result } = renderHook(() => useSyncRunControls('wv-run-1'));

    act(() => result.current.pause());
    answer('sync:pause:response', sent('sync:pause'), {
      success: false,
      operationId: 'wv-run-1',
      paused: false,
      error: 'No sync with this id is running',
    });

    expect(result.current.paused).toBe(false);
    expect(notified.calls).toEqual([
      expect.objectContaining({ title: 'Could not pause or resume the run' }),
    ]);
  });

  it('starts another run as nothing has been asked of it', () => {
    const { result, rerender } = renderHook(({ id }) => useSyncRunControls(id), {
      initialProps: { id: 'wv-run-1' as string | null },
    });
    act(() => result.current.pause());
    answer('sync:pause:response', sent('sync:pause'), {
      success: true,
      operationId: 'wv-run-1',
      paused: true,
    });
    expect(result.current.paused).toBe(true);

    rerender({ id: 'wv-run-2' });
    expect(result.current.paused).toBe(false);
    expect(result.current.cancelRequested).toBe(false);
  });

  it('sends nothing when there is no run to name', () => {
    const { result } = renderHook(() => useSyncRunControls(null));

    act(() => {
      result.current.pause();
      result.current.cancel();
    });

    expect(posted.messages).toEqual([]);
  });

  it('waits on a run for longer than a person may keep it paused through a working day', () => {
    expect(SYNC_RUN_TIMEOUT_MS).toBeGreaterThanOrEqual(8 * 60 * 60 * 1000);
  });
});
