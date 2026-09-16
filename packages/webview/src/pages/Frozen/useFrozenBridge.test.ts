import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useFrozenStore } from '../../stores/useFrozenStore';
import { useFrozenMutation, useFrozenPushChannels } from './useFrozenBridge';
import type { BridgeMutationState } from '../../hooks/useBridgeMutation';

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

/** Deliver a host message of `type` carrying `correlationId`. */
function push(type: string, correlationId: string, payload: unknown): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { id: `host-${type}`, type, timestamp: Date.now(), correlationId, payload },
      }),
    );
  });
}

const PROGRESS = { phase: 'load', status: 'started', progress: 10, message: 'Loading Account' };
const VERDICT = {
  status: 'passed',
  checks: [],
  attempts: 1,
  measuredAt: '2026-02-24T10:00:00.000Z',
};
const CONTROL_REPORT = {
  passed: true,
  checks: [],
  author: 'me',
  checkedAt: '2026-02-24T10:00:00Z',
};

/** The Frozen panel: one load mutation plus the push-channel subscriptions. */
function renderPanel(): ReturnType<typeof renderHook<BridgeMutationState<{ ok: boolean }>, void>> {
  return renderHook(() => {
    const load = useFrozenMutation<{ ok: boolean }>('frozen:load', {
      responseType: 'frozen:load:response',
    });
    useFrozenPushChannels();
    return load;
  });
}

/** Start a load and return the request id the panel sent. */
function startLoad(result: { current: BridgeMutationState<{ ok: boolean }> }): string {
  act(() => {
    result.current.mutate({ datasetPath: '/data/set' });
  });
  const sent = mockPostMessage.mock.calls.at(-1)?.[0] as { payload: { id: string } };
  return sent.payload.id;
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

describe('useFrozenPushChannels', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    useFrozenStore.setState({
      progress: [],
      controlReport: null,
      verdict: null,
      lastError: null,
      activeRequestIds: new Set<string>(),
      lastRequestIdByType: {},
    });
  });

  it('ignores progress, a control result and a verdict answering another panel', () => {
    const { result } = renderPanel();
    startLoad(result);

    push('frozen:load:progress', 'wv-another-panel', PROGRESS);
    push('frozen:control:result', 'wv-another-panel', { report: CONTROL_REPORT });
    push('frozen:verify:result', 'wv-another-panel', { verdict: VERDICT });

    expect(useFrozenStore.getState().progress).toEqual([]);
    expect(useFrozenStore.getState().controlReport).toBeNull();
    expect(useFrozenStore.getState().verdict).toBeNull();
  });

  it('applies the same messages when they answer its own request', () => {
    const { result } = renderPanel();
    const requestId = startLoad(result);

    push('frozen:load:progress', requestId, PROGRESS);
    push('frozen:control:result', requestId, { report: CONTROL_REPORT });

    expect(useFrozenStore.getState().progress).toEqual([PROGRESS]);
    expect(useFrozenStore.getState().controlReport).toEqual(CONTROL_REPORT);
  });

  it('keeps reading the chain the load answer opens: the verification runs after it', () => {
    const { result } = renderPanel();
    const requestId = startLoad(result);

    push('frozen:load:response', requestId, { ok: true });
    push('frozen:load:progress', requestId, PROGRESS);
    push('frozen:verify:result', requestId, { verdict: VERDICT });

    expect(useFrozenStore.getState().progress).toEqual([PROGRESS]);
    expect(useFrozenStore.getState().verdict).toEqual(VERDICT);
  });

  it('stops reading that chain once the panel has been reset', () => {
    const { result } = renderPanel();
    const requestId = startLoad(result);

    act(() => {
      result.current.reset();
    });

    push('frozen:load:progress', requestId, PROGRESS);
    push('frozen:verify:result', requestId, { verdict: VERDICT });

    expect(useFrozenStore.getState().progress).toEqual([]);
    expect(useFrozenStore.getState().verdict).toBeNull();
  });

  it('stops reading that chain once the verdict has closed it', () => {
    const { result } = renderPanel();
    const requestId = startLoad(result);

    push('frozen:verify:result', requestId, { verdict: VERDICT });
    push('frozen:load:progress', requestId, PROGRESS);

    expect(useFrozenStore.getState().verdict).toEqual(VERDICT);
    expect(useFrozenStore.getState().progress).toEqual([]);
  });

  it('stops reading that chain once its verification has failed', () => {
    const { result } = renderPanel();
    const requestId = startLoad(result);

    push('frozen:verify:error', requestId, {
      message: 'Verify failed',
      code: 'VERIFY_ERROR',
      retryable: false,
    });
    push('frozen:load:progress', requestId, PROGRESS);

    expect(useFrozenStore.getState().activeRequestIds.has(requestId)).toBe(false);
    expect(useFrozenStore.getState().progress).toEqual([]);
  });

  it('keeps reading a running chain when only the tab that sent it goes away', () => {
    // Switching between the Extract and Load tabs unmounts the tab, not the
    // page; the load and its verification carry on and must still be shown.
    renderHook(() => useFrozenPushChannels());
    const tab = renderHook(() =>
      useFrozenMutation<{ ok: boolean }>('frozen:load', { responseType: 'frozen:load:response' }),
    );
    const requestId = startLoad(tab.result);

    tab.unmount();
    push('frozen:load:progress', requestId, PROGRESS);
    push('frozen:verify:result', requestId, { verdict: VERDICT });

    expect(useFrozenStore.getState().progress).toEqual([PROGRESS]);
    expect(useFrozenStore.getState().verdict).toEqual(VERDICT);
  });

  it('forgets every request and its progress when the Frozen page goes away', () => {
    const page = renderHook(() => useFrozenPushChannels());
    const tab = renderHook(() =>
      useFrozenMutation<{ ok: boolean }>('frozen:load', { responseType: 'frozen:load:response' }),
    );
    const requestId = startLoad(tab.result);
    push('frozen:load:progress', requestId, PROGRESS);

    page.unmount();

    expect(useFrozenStore.getState().activeRequestIds.size).toBe(0);
    expect(useFrozenStore.getState().progress).toEqual([]);
  });

  it('stops reading the earlier run once the same panel sends again', () => {
    const { result } = renderPanel();
    const first = startLoad(result);
    const second = startLoad(result);

    push('frozen:load:progress', first, PROGRESS);

    expect(useFrozenStore.getState().activeRequestIds.has(first)).toBe(false);
    expect(useFrozenStore.getState().activeRequestIds.has(second)).toBe(true);
    expect(useFrozenStore.getState().progress).toEqual([]);
  });

  it('stops reading the earlier run when a remounted tab sends the same request again', () => {
    // Switching tabs remounts the Load tab with a new mutation, which knows
    // nothing of the load the earlier mount sent.
    renderHook(() => useFrozenPushChannels());
    const loadTab = () =>
      renderHook(() =>
        useFrozenMutation<{ ok: boolean }>('frozen:load', { responseType: 'frozen:load:response' }),
      );
    const firstTab = loadTab();
    const first = startLoad(firstTab.result);
    firstTab.unmount();
    const secondTab = loadTab();
    const second = startLoad(secondTab.result);

    expect(useFrozenStore.getState().activeRequestIds.has(first)).toBe(false);
    expect(useFrozenStore.getState().activeRequestIds.has(second)).toBe(true);
    push('frozen:load:progress', first, PROGRESS);
    push('frozen:verify:result', first, { verdict: VERDICT });

    expect(useFrozenStore.getState().progress).toEqual([]);
    expect(useFrozenStore.getState().verdict).toBeNull();
  });

  it('keeps reading a request of another type when a tab sends', () => {
    renderHook(() => useFrozenPushChannels());
    const verify = renderHook(() =>
      useFrozenMutation<{ ok: boolean }>('frozen:verify', {
        responseType: 'frozen:verify:response',
      }),
    );
    const verifyId = startLoad(verify.result);
    const load = renderHook(() =>
      useFrozenMutation<{ ok: boolean }>('frozen:load', { responseType: 'frozen:load:response' }),
    );
    startLoad(load.result);

    push('frozen:load:progress', verifyId, PROGRESS);

    expect(useFrozenStore.getState().progress).toEqual([PROGRESS]);
  });

  it('remembers at most the last twenty requests', () => {
    const ids = Array.from({ length: 25 }, (_, i) => `wv-request-${i}`);
    for (const id of ids) {
      // Distinct request types, so no send replaces an earlier one.
      useFrozenStore.getState().replaceActiveRequestId(`frozen:type-${id}`, id);
    }

    const kept = useFrozenStore.getState().activeRequestIds;
    expect(kept.size).toBe(20);
    expect(kept.has(ids[24])).toBe(true);
    expect(kept.has(ids[4])).toBe(false);
  });
});
