import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { SyncHistoryDetail } from './SyncHistoryDetail';
import { useSyncHistoryStore } from '../../stores/useSyncHistoryStore';
import type { SyncHistoryEntry } from '@sandforge/shared';

const makeMockEntry = (): SyncHistoryEntry => ({
  id: 'h-1',
  configSnapshot: {
    id: 'cfg-1',
    name: 'My Sync Config',
    description: 'Test sync config',
    sourceOrgId: 'org-1',
    targetOrgId: 'org-2',
    direction: 'source_to_target',
    mode: 'full',
    conflictStrategy: 'source_wins',
    objects: [
      {
        objectApiName: 'Account',
        operation: 'insert',
        fieldMappings: [{ sourceField: 'Name', targetField: 'Name', type: 'direct' }],
        transformRules: [],
        excludedFields: [],
        addOnFields: [],
        batchSize: 200,
        insertOrder: 0,
      },
    ],
    enableRollback: false,
    dryRun: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  },
  result: {
    configId: 'cfg-1',
    operationId: 'op-1',
    status: 'partial',
    objectResults: [
      {
        objectApiName: 'Account',
        operation: 'insert',
        processed: 100,
        success: 90,
        failed: 8,
        skipped: 2,
        conflictCount: 0,
        errors: ['Row 55: duplicate value', 'Row 72: required field missing'],
      },
      {
        objectApiName: 'Contact',
        operation: 'upsert',
        processed: 50,
        success: 50,
        failed: 0,
        skipped: 0,
        conflictCount: 0,
        errors: [],
      },
    ],
    totalProcessed: 150,
    totalSuccess: 140,
    totalFailed: 8,
    totalSkipped: 2,
    duration: 12000,
    timestamp: '2024-01-01T00:12:00Z',
  },
  startTime: '2024-01-01T00:00:00Z',
  endTime: '2024-01-01T00:12:00Z',
  triggeredBy: 'manual',
});

describe('SyncHistoryDetail', () => {
  beforeEach(() => {
    useSyncHistoryStore.setState({
      entries: [],
      selectedEntry: null,
      loading: false,
      error: null,
    });
  });

  it('should render nothing when no entry is selected', () => {
    const { container } = render(<SyncHistoryDetail />);
    expect(container.innerHTML).toBe('');
  });

  it('should render entry summary with status and total counts', () => {
    useSyncHistoryStore.setState({ selectedEntry: makeMockEntry() });
    render(<SyncHistoryDetail />);
    expect(screen.getByTestId('sync-history-detail')).toBeDefined();
    // Check summary counts
    expect(screen.getByText('150')).toBeDefined(); // totalProcessed
    expect(screen.getByText('140')).toBeDefined(); // totalSuccess
    expect(screen.getByText('8')).toBeDefined(); // totalFailed
  });

  it('should render per-object result rows', () => {
    useSyncHistoryStore.setState({ selectedEntry: makeMockEntry() });
    render(<SyncHistoryDetail />);
    expect(screen.getByTestId('object-result-Account')).toBeDefined();
    expect(screen.getByTestId('object-result-Contact')).toBeDefined();
  });

  it('should render error messages for objects with errors', () => {
    useSyncHistoryStore.setState({ selectedEntry: makeMockEntry() });
    render(<SyncHistoryDetail />);
    expect(screen.getByText('Row 55: duplicate value')).toBeDefined();
    expect(screen.getByText('Row 72: required field missing')).toBeDefined();
  });

  it('should call rerun with correct entryId when Run Again is clicked', () => {
    const rerunSpy = vi.fn();
    useSyncHistoryStore.setState({ selectedEntry: makeMockEntry(), rerun: rerunSpy });
    render(<SyncHistoryDetail />);
    fireEvent.click(screen.getByTestId('rerun-btn'));
    expect(rerunSpy).toHaveBeenCalledWith('h-1');
  });

  it('should call clearSelection when close button is clicked', () => {
    const clearSelectionSpy = vi.fn();
    useSyncHistoryStore.setState({
      selectedEntry: makeMockEntry(),
      clearSelection: clearSelectionSpy,
    });
    render(<SyncHistoryDetail />);
    fireEvent.click(screen.getByTestId('detail-close-btn'));
    expect(clearSelectionSpy).toHaveBeenCalled();
  });
});
