import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import { SyncHistoryPanel } from './SyncHistoryPanel';
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

// jsdom has no layout: the real virtualizer measures a zero-height container
// and renders no row. Every row is in view here.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; estimateSize: () => number }) => {
    const size = opts.estimateSize();
    const items = Array.from({ length: opts.count }, (_, index) => ({
      index,
      start: index * size,
      size,
    }));
    return { getVirtualItems: () => items, getTotalSize: () => opts.count * size };
  },
}));

/** Deliver a message from the extension host to the panel's window. */
function fromHost(data: Record<string, unknown>): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { timestamp: Date.now(), ...data } }));
  });
}

/**
 * The panel as SyncPage mounts it: the page owns the subscriptions, so a test
 * about what an incoming answer does has to mount them too.
 */
const PanelInPage: React.FC = () => {
  useSyncHistoryMessages();
  return <SyncHistoryPanel />;
};

const makeMockEntry = (
  id: string,
  status: 'success' | 'partial' | 'failure' = 'success',
): SyncHistoryEntry => ({
  id,
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
    configId: `cfg-${id}`,
    operationId: `op-${id}`,
    status,
    objectResults: [
      {
        objectApiName: 'Account',
        operation: 'insert',
        processed: 100,
        success: 98,
        failed: 2,
        skipped: 0,
        conflictCount: 0,
        errors: [],
      },
    ],
    totalProcessed: 100,
    totalSuccess: 98,
    totalFailed: 2,
    totalSkipped: 0,
    duration: 5000,
    timestamp: '2024-01-01T00:05:00Z',
  },
  startTime: '2024-01-01T00:00:00Z',
  endTime: '2024-01-01T00:05:00Z',
  triggeredBy: 'manual',
});

describe('SyncHistoryPanel', () => {
  beforeEach(() => {
    useSyncHistoryStore.setState({
      entries: [],
      selectedEntry: null,
      loading: false,
      error: null,
    });
  });

  it('should render the panel with test ID', () => {
    render(<SyncHistoryPanel />);
    expect(screen.getByTestId('sync-history-panel')).toBeDefined();
  });

  it('should show SkeletonTable when loading and no entries', () => {
    useSyncHistoryStore.setState({ loading: true, entries: [] });
    render(<SyncHistoryPanel />);
    expect(screen.getByTestId('sync-history-panel')).toBeDefined();
    // SkeletonTable renders skeleton rows
    const panel = screen.getByTestId('sync-history-panel');
    expect(panel.innerHTML).toContain('skeleton');
  });

  it('should show EmptyState when not loading and entries is empty', () => {
    useSyncHistoryStore.setState({ loading: false, entries: [] });
    render(<SyncHistoryPanel />);
    expect(screen.getByTestId('sync-history-panel')).toBeDefined();
  });

  it('says how long ago a run started in the interface language', async () => {
    // date-fns wrote "about 2 hours ago" beside French column headers.
    const startTime = new Date(Date.now() - 2 * 3_600_000).toISOString();
    useSyncHistoryStore.setState({
      entries: [{ ...makeMockEntry('h-1'), startTime }],
      loading: false,
    });
    i18n.addResourceBundle('fr', 'translation', fr);
    await act(async () => {
      await i18n.changeLanguage('fr');
    });
    try {
      render(<SyncHistoryPanel />);
      expect(screen.getByText('il y a 2 heures')).toBeDefined();
    } finally {
      await act(async () => {
        await i18n.changeLanguage('en');
      });
    }
  });

  it('lists a run a cancel stopped as cancelled, not as partial', () => {
    const cancelled = makeMockEntry('h-1', 'partial');
    cancelled.result = { ...cancelled.result, cancelled: true };
    useSyncHistoryStore.setState({ entries: [cancelled], loading: false });
    render(<SyncHistoryPanel />);

    const panel = screen.getByTestId('sync-history-panel');
    expect(panel.textContent).toContain('Cancelled');
    expect(panel.textContent).not.toContain('Partial');
  });

  it('lists a run whose stored start time is not a date, as unknown, with the rest', () => {
    // Formatting it threw "Invalid time value", and the history listed nothing.
    const unreadable = { ...makeMockEntry('h-1'), startTime: 'not a date' };
    useSyncHistoryStore.setState({ entries: [unreadable, makeMockEntry('h-2')], loading: false });
    render(<SyncHistoryPanel />);

    expect(screen.getByTitle('unknown').textContent).toBe('unknown');
    expect(screen.getAllByText('Account')).toHaveLength(2);
  });

  it('should render DataTable with entries when data exists', () => {
    const entries = [makeMockEntry('h-1'), makeMockEntry('h-2', 'failure')];
    useSyncHistoryStore.setState({ entries, loading: false });
    render(<SyncHistoryPanel />);
    // With data, the header and export buttons should render
    expect(screen.getByTestId('export-csv-btn')).toBeDefined();
    expect(screen.getByTestId('export-json-btn')).toBeDefined();
  });

  it('should call fetchHistory on mount', () => {
    const fetchHistorySpy = vi.fn();
    useSyncHistoryStore.setState({
      entries: [],
      loading: false,
      error: null,
      fetchHistory: fetchHistorySpy,
    });
    render(<SyncHistoryPanel />);
    expect(fetchHistorySpy).toHaveBeenCalled();
  });

  it('should render export CSV and JSON buttons when entries exist', () => {
    useSyncHistoryStore.setState({
      entries: [makeMockEntry('h-1')],
      loading: false,
    });
    render(<SyncHistoryPanel />);
    expect(screen.getByTestId('export-csv-btn')).toBeDefined();
    expect(screen.getByTestId('export-json-btn')).toBeDefined();
  });

  it('should render refresh button when entries exist', () => {
    useSyncHistoryStore.setState({
      entries: [makeMockEntry('h-1')],
      loading: false,
    });
    render(<SyncHistoryPanel />);
    expect(screen.getByTestId('refresh-btn')).toBeDefined();
  });

  it('names its icon-only refresh button', () => {
    useSyncHistoryStore.setState({ entries: [makeMockEntry('h-1')], loading: false });
    render(<SyncHistoryPanel />);
    expect(screen.getByRole('button', { name: 'Reload' })).toBe(screen.getByTestId('refresh-btn'));
  });

  it('fills the table when the extension answers the history request', () => {
    // The store's message handler had no caller: the request went out, the
    // answer arrived, and the panel stayed on its loading state.
    render(<PanelInPage />);

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            id: 'host-list',
            type: 'sync:history:list:response',
            timestamp: Date.now(),
            payload: { entries: [makeMockEntry('h-1'), makeMockEntry('h-2')] },
          },
        }),
      );
    });

    expect(useSyncHistoryStore.getState().entries).toHaveLength(2);
    expect(useSyncHistoryStore.getState().loading).toBe(false);
  });

  it('saves an exported history and says where the file went', () => {
    // The export's content and the save dialog's answer both arrive as host
    // messages: without the panel passing them on, the export never reached
    // the dialog and its outcome was never announced.
    useSyncHistoryStore.setState({ pendingSaveId: null });
    useNotificationStore.setState({ notifications: [] });
    render(<PanelInPage />);
    mockPostMessage.mockClear();

    fromHost({
      id: 'host-export',
      type: 'sync:history:export:response',
      payload: { data: 'id\n1', format: 'csv' },
    });

    const save = mockPostMessage.mock.calls
      .map((call) => (call[0] as { payload: { id: string; type: string } }).payload)
      .find((message) => message.type === 'file:save');
    expect(save).toBeDefined();

    fromHost({
      id: 'host-save',
      type: 'file:save:response',
      correlationId: save?.id,
      payload: { status: 'saved', path: '/home/user/sync-history.csv' },
    });

    const [notification] = useNotificationStore.getState().notifications;
    expect(notification?.level).toBe('success');
    expect(notification?.message).toContain('/home/user/sync-history.csv');
  });
});
