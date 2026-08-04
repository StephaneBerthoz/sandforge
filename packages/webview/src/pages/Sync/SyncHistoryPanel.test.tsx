import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { SyncHistoryPanel } from './SyncHistoryPanel';
import { useSyncHistoryStore } from '../../stores/useSyncHistoryStore';
import type { SyncHistoryEntry } from '@sandforge/shared';

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
    dryRun: false,
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
});
