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

  it('names a backup whose stored time is not a date as taken at an unknown time', () => {
    // It read "Invalid Date" as the backup's title.
    render(<BackupPanel backups={[{ ...backups[0], timestamp: 'not a date' }]} />);

    const card = screen.getByTestId('backup-op-1');
    expect(card.textContent).toContain('unknown');
    expect(card.textContent).not.toContain('Invalid Date');
  });

  it('says which objects a partial backup holds only part of, and nothing of a whole one', () => {
    // Live: 1 220 contacts, 500 read, listed as complete.
    render(
      <BackupPanel
        backups={[
          {
            ...backups[0],
            partial: true,
            objectResults: [
              { objectApiName: 'Contact', recordCount: 500, truncated: true },
              { objectApiName: 'Account', recordCount: 40 },
            ],
          },
        ]}
      />,
    );

    expect(screen.getByTestId('backup-partial-op-1').textContent).toBe(
      'Partial: Contact (500) hold more rows than this backup read. A restore brings back these rows only.',
    );
    expect(screen.queryByTestId('backup-partial-op-2')).toBeNull();
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
