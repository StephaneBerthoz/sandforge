import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import '../../i18n';
import { useSyncHistoryMessages } from './useSyncHistoryMessages';
import { useSyncHistoryStore } from '../../stores/useSyncHistoryStore';
import { useNotificationStore } from '../../stores/useNotificationStore';
import type { SyncHistoryEntry } from '@sandforge/shared';

const { mockPostMessage } = vi.hoisted(() => ({ mockPostMessage: vi.fn() }));

vi.mock('../../hooks/useVSCodeApi', () => {
  const api = {
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  };
  return { useVSCodeApi: () => api, getVscodeApi: () => api };
});

/** Deliver a message from the extension host. */
function fromHost(data: Record<string, unknown>): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { timestamp: Date.now(), ...data } }));
  });
}

const entry: SyncHistoryEntry = {
  id: 'h-1',
  configSnapshot: {
    id: 'cfg-1',
    name: 'Test Config',
    description: 'Test sync config',
    sourceOrgId: 'org-1',
    targetOrgId: 'org-2',
    direction: 'source_to_target',
    mode: 'full',
    conflictStrategy: 'source_wins',
    objects: [],
    enableRollback: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  },
  result: {
    configId: 'cfg-1',
    operationId: 'op-1',
    status: 'success',
    objectResults: [],
    totalProcessed: 1,
    totalSuccess: 1,
    totalFailed: 0,
    totalSkipped: 0,
    duration: 1000,
    timestamp: '2024-01-01T00:05:00Z',
  },
  startTime: '2024-01-01T00:00:00Z',
  endTime: '2024-01-01T00:05:00Z',
  triggeredBy: 'manual',
};

describe('useSyncHistoryMessages', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    useSyncHistoryStore.setState({
      entries: [],
      selectedEntry: null,
      loading: false,
      error: null,
      pendingSaveId: null,
    });
    useNotificationStore.setState({ notifications: [] });
  });

  it('fills the table from the list answer', () => {
    renderHook(() => useSyncHistoryMessages());

    fromHost({ id: 'm-1', type: 'sync:history:list:response', payload: { entries: [entry] } });

    expect(useSyncHistoryStore.getState().entries).toHaveLength(1);
    expect(useSyncHistoryStore.getState().loading).toBe(false);
  });

  it('selects the entry the detail answer carries', () => {
    renderHook(() => useSyncHistoryMessages());

    fromHost({ id: 'm-2', type: 'sync:history:detail:response', payload: { entry } });

    expect(useSyncHistoryStore.getState().selectedEntry?.id).toBe('h-1');
  });

  it('opens the save dialog with the exported content', () => {
    renderHook(() => useSyncHistoryMessages());

    fromHost({
      id: 'm-3',
      type: 'sync:history:export:response',
      payload: { data: 'id\n1', format: 'csv' },
    });

    const save = mockPostMessage.mock.calls
      .map((call) => (call[0] as { payload: { id: string; type: string } }).payload)
      .find((message) => message.type === 'file:save');
    expect(save?.id).toBe(useSyncHistoryStore.getState().pendingSaveId);
  });

  it('says where the saved export went', () => {
    renderHook(() => useSyncHistoryMessages());
    useSyncHistoryStore.setState({ pendingSaveId: 'save-1' });

    fromHost({
      id: 'm-4',
      type: 'file:save:response',
      correlationId: 'save-1',
      payload: { status: 'saved', path: '/home/user/sync-history.csv' },
    });

    const [notification] = useNotificationStore.getState().notifications;
    expect(notification?.message).toContain('/home/user/sync-history.csv');
  });

  it('shows the error the history channel reports', () => {
    renderHook(() => useSyncHistoryMessages());

    fromHost({ id: 'm-5', type: 'sync:history:error', payload: { message: 'no history file' } });

    expect(useSyncHistoryStore.getState().error).toBe('no history file');
    expect(useSyncHistoryStore.getState().loading).toBe(false);
  });
});
