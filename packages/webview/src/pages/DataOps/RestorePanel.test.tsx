import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { RestorePanel } from './RestorePanel';
import type { BackupResult } from '@sandforge/shared';

const backups: BackupResult[] = [
  {
    configId: 'cfg-1',
    operationId: 'op-1',
    status: 'completed',
    objectResults: [{ objectApiName: 'Account', recordCount: 100, size: 5000, status: 'success' }],
    totalRecords: 100,
    totalSize: 5000,
    filePath: '/backups/op-1.zip',
    checksum: 'abc123',
    startTime: '2026-01-01T00:00:00Z',
    endTime: '2026-01-01T00:01:00Z',
    duration: 60000,
  },
];

describe('RestorePanel', () => {
  it('should render the panel', () => {
    render(<RestorePanel />);
    expect(screen.getByTestId('restore-panel')).toBeDefined();
  });

  it('should show empty state when no backups', () => {
    render(<RestorePanel />);
    expect(screen.getByText('dataops.selectBackup')).toBeDefined();
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
