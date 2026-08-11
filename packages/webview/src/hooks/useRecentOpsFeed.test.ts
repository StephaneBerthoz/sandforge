import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mockPostMessage = vi.fn();

vi.mock('./useVSCodeApi', () => ({
  useVSCodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

import { useRecentOpsFeed } from './useRecentOpsFeed';
import { useRecentOpsStore } from '../stores/useRecentOpsStore';

/** Dispatch an extension -> webview message on the shared window dispatcher. */
function dispatchMessage(type: string, payload: Record<string, unknown>): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { id: `msg-${Date.now()}`, type, timestamp: Date.now(), payload },
    }),
  );
}

describe('useRecentOpsFeed', () => {
  beforeEach(() => {
    useRecentOpsStore.getState().clearOps();
  });

  it('adds a running op on operation:started', () => {
    renderHook(() => useRecentOpsFeed());

    act(() => {
      dispatchMessage('operation:started', {
        operationId: 'op-1',
        module: 'seed',
        description: 'Seeding Accounts',
      });
    });

    const ops = useRecentOpsStore.getState().ops;
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      id: 'op-1',
      type: 'seed',
      label: 'Seeding Accounts',
      status: 'running',
    });
  });

  it('maps the frozen module to its own category', () => {
    renderHook(() => useRecentOpsFeed());

    act(() => {
      dispatchMessage('operation:started', {
        operationId: 'op-frozen',
        module: 'frozen',
        description: 'Extracting dataset',
      });
    });

    expect(useRecentOpsStore.getState().ops[0]?.type).toBe('frozen');
  });

  it('maps the grappe module to its own category', () => {
    renderHook(() => useRecentOpsFeed());

    act(() => {
      dispatchMessage('operation:started', {
        operationId: 'op-grappe',
        module: 'grappe',
        description: 'Clustering records',
      });
    });

    expect(useRecentOpsStore.getState().ops[0]?.type).toBe('grappe');
  });

  it('marks the op as success on operation:completed and keeps the label', () => {
    renderHook(() => useRecentOpsFeed());

    act(() => {
      dispatchMessage('operation:started', {
        operationId: 'op-2',
        module: 'sync',
        description: 'Syncing Contacts',
      });
    });
    act(() => {
      dispatchMessage('operation:completed', {
        operationId: 'op-2',
        result: { totalProcessed: 1200 },
      });
    });

    const op = useRecentOpsStore.getState().ops[0];
    expect(op?.status).toBe('success');
    expect(op?.label).toBe('Syncing Contacts');
    expect(op?.recordCount).toBe(1200);
  });

  it('marks the op as failed on operation:failed', () => {
    renderHook(() => useRecentOpsFeed());

    act(() => {
      dispatchMessage('operation:started', {
        operationId: 'op-3',
        module: 'forge',
        description: 'Executing forge operation',
      });
    });
    act(() => {
      dispatchMessage('operation:failed', {
        operationId: 'op-3',
        error: 'boom',
        retryable: false,
      });
    });

    expect(useRecentOpsStore.getState().ops[0]?.status).toBe('failed');
  });

  it('updates in place when operation:started repeats for the same id', () => {
    renderHook(() => useRecentOpsFeed());

    act(() => {
      dispatchMessage('operation:started', {
        operationId: 'op-4',
        module: 'seed',
        description: 'First attempt',
      });
    });
    act(() => {
      dispatchMessage('operation:started', {
        operationId: 'op-4',
        module: 'seed',
        description: 'Retry',
      });
    });

    const ops = useRecentOpsStore.getState().ops;
    expect(ops).toHaveLength(1);
    expect(ops[0]?.label).toBe('Retry');
  });

  it('ignores terminal events for unknown operations', () => {
    renderHook(() => useRecentOpsFeed());

    act(() => {
      dispatchMessage('operation:completed', { operationId: 'ghost', result: {} });
    });

    expect(useRecentOpsStore.getState().ops).toHaveLength(0);
  });
});
