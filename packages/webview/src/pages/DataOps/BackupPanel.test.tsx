import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { BackupPanel } from './BackupPanel';
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
  {
    configId: 'cfg-2',
    operationId: 'op-2',
    status: 'failed',
    objectResults: [],
    totalRecords: 0,
    totalSize: 0,
    filePath: '',
    checksum: '',
    startTime: '2026-01-01T00:00:00Z',
    endTime: '2026-01-01T00:00:30Z',
    duration: 30000,
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

  it('should format backup size', () => {
    render(<BackupPanel backups={backups} />);
    expect(screen.getAllByText(/4\.9 KB/).length).toBeGreaterThan(0);
  });
});
