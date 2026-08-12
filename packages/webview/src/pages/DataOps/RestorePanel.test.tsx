import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { RestorePanel } from './RestorePanel';
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

describe('RestorePanel', () => {
  it('should render the panel', () => {
    render(<RestorePanel />);
    expect(screen.getByTestId('restore-panel')).toBeDefined();
  });

  it('should show empty state when no backups', () => {
    render(<RestorePanel />);
    expect(screen.getByText('Select a backup to restore')).toBeDefined();
  });

  it('should show completed backups', () => {
    render(<RestorePanel backups={backups} />);
    expect(screen.getByTestId('restore-backup-op-1')).toBeDefined();
  });

  it('should call onSelectBackup when clicked', () => {
    const onSelect = vi.fn();
    render(<RestorePanel backups={backups} onSelectBackup={onSelect} />);
    const wrapper = screen.getByTestId('restore-backup-op-1');
    fireEvent.click(wrapper.querySelector('[role="button"]')!);
    expect(onSelect).toHaveBeenCalledWith('op-1');
  });

  it('should show selected badge and restore button', () => {
    render(<RestorePanel backups={backups} selectedBackupId="op-1" onRestore={vi.fn()} />);
    expect(screen.getByText('Selected')).toBeDefined();
    expect(screen.getByTestId('restore-btn-op-1')).toBeDefined();
  });

  it('should show restore progress', () => {
    render(<RestorePanel isRestoring restoreProgress={{ completed: 50, total: 100 }} />);
    expect(screen.getByTestId('restore-progress')).toBeDefined();
  });

  it('should call onRestore when restore button clicked', () => {
    const onRestore = vi.fn();
    render(<RestorePanel backups={backups} selectedBackupId="op-1" onRestore={onRestore} />);
    fireEvent.click(screen.getByTestId('restore-btn-op-1'));
    expect(onRestore).toHaveBeenCalledWith('op-1');
  });
});
