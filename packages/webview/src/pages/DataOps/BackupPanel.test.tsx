import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { BackupPanel } from './BackupPanel';
import type { BackupSummary } from '@sandforge/shared';

const backups: BackupSummary[] = [
  {
    operationId: 'op-1',
    orgId: 'org-1',
    timestamp: '2026-01-01T00:00:00Z',
    status: 'completed',
    objectResults: [{ objectApiName: 'Account', recordCount: 100 }],
    totalRecords: 100,
    totalSize: 5000,
  },
  {
    operationId: 'op-2',
    orgId: 'org-1',
    timestamp: '2026-01-01T00:00:30Z',
    status: 'failed',
    objectResults: [],
    totalRecords: 0,
    totalSize: 0,
  },
];

describe('BackupPanel', () => {
  it('should render the panel', () => {
    render(<BackupPanel />);
    expect(screen.getByTestId('backup-panel')).toBeDefined();
  });

  it('should show empty state when no backups', () => {
    render(<BackupPanel />);
    expect(screen.getByText('No backups available')).toBeDefined();
  });

  it('should show backup cards', () => {
    render(<BackupPanel backups={backups} />);
    expect(screen.getByTestId('backup-op-1')).toBeDefined();
    expect(screen.getByTestId('backup-op-2')).toBeDefined();
  });

  it('should show backup status badges', () => {
    render(<BackupPanel backups={backups} />);
    expect(screen.getByText('completed')).toBeDefined();
    expect(screen.getByText('failed')).toBeDefined();
  });

  it('should call onCreate when create button clicked', () => {
    const onCreate = vi.fn();
    render(<BackupPanel onCreate={onCreate} />);
    fireEvent.click(screen.getByTestId('create-backup-btn'));
    expect(onCreate).toHaveBeenCalled();
  });

  it('should call onDelete when delete button clicked', () => {
    const onDelete = vi.fn();
    render(<BackupPanel backups={backups} onDelete={onDelete} />);
    fireEvent.click(screen.getByTestId('delete-backup-op-1'));
    expect(onDelete).toHaveBeenCalledWith('op-1');
  });

  it('should identify each backup by when it was taken', () => {
    // The size row was removed: a backup records its object record counts and
    // its timestamp, never a byte size, so the panel had been formatting a
    // value that only ever arrived as 0 from the store.
    render(<BackupPanel backups={backups} />);
    expect(screen.getByTestId('backup-op-1')).toBeDefined();
    expect(screen.getByTestId('backup-op-2')).toBeDefined();
  });
});
