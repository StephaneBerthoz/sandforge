import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, within } from '@testing-library/react';
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

  it('marks a run a rewind took back in a word in the table, and in full in its detail', () => {
    const entry = makeMockEntry('h-rw');
    const before = {
      ...makeMockEntry('h-before'),
      startTime: '2023-12-31T20:00:00Z',
      endTime: '2023-12-31T20:05:00Z',
    };
    useSyncHistoryStore.setState({
      entries: [entry, before],
      selectedEntry: entry,
      loading: false,
    });
    mockPostMessage.mockClear();
    render(<SyncHistoryPanel />);

    const request = mockPostMessage.mock.calls
      .map((call) => (call[0] as { payload: { id: string; type: string } }).payload)
      .find((message) => message.type === 'checkpoint:rewinds');
    expect(request).toBeDefined();
    fromHost({
      id: 'resp-rewinds',
      type: 'checkpoint:rewinds:response',
      correlationId: request?.id,
      payload: {
        rewinds: [
          {
            kind: 'rewind',
            rewindId: 'rw-20240101-020000-aaaa',
            checkpointId: 'ck-20231231-230000-aaaa',
            checkpointName: 'Before UAT',
            organizationId: '00D000000000001AAA',
            mode: 'everything',
            objects: ['Account'],
            readFrom: '2023-12-31T23:00:00.000Z',
            takenAt: '2023-12-31T23:05:00.000Z',
            startedAt: '2024-01-01T02:00:00.000Z',
            endedAt: '2024-01-01T02:10:00.000Z',
            status: 'success',
            totals: { deleted: 98, restored: 0, undeleted: 0, recreated: 0 },
            orgIds: ['org-2'],
          },
        ],
      },
    });

    expect(screen.getByTestId('sync-history-rewound-h-rw').textContent).toBe('Rewound');
    expect(screen.queryByTestId('sync-history-rewound-h-before')).toBeNull();
    expect(screen.getByTestId('sync-history-detail-rewound').textContent).toContain(
      'to “Before UAT”',
    );
  });

  it('should render DataTable with entries when data exists', () => {
    const entries = [makeMockEntry('h-1'), makeMockEntry('h-2', 'failure')];
    useSyncHistoryStore.setState({ entries, loading: false });
    render(<SyncHistoryPanel />);
    // With data, the header and export buttons should render
    expect(screen.getByTestId('export-csv-btn')).toBeDefined();
    expect(screen.getByTestId('export-json-btn')).toBeDefined();
  });

  it('lists every run of the page in the table that holds the header, not in a virtualized one', () => {
    // Virtualized, the rows sat in a second table under the header's and each
    // packed its cells into the left third, under Date and Objects.
    const entries = Array.from({ length: 30 }, (_, i) => makeMockEntry(`h-${i}`));
    useSyncHistoryStore.setState({ entries, loading: false });
    render(<SyncHistoryPanel />);

    expect(screen.queryByTestId('virtual-scroll-container')).toBeNull();
    const table = screen.getByRole('grid');
    expect(within(table).getAllByRole('columnheader')).toHaveLength(6);
    // The first page, 25 runs, every one a row of the header's table.
    const rows = screen.getAllByTestId(/^table-row-/);
    expect(rows).toHaveLength(25);
    for (const row of rows) {
      expect(row.closest('table')).toBe(table);
      expect(row.style.position).toBe('');
    }
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
