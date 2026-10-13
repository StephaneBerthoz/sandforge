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

  it('says, before the click, that a backup stopped at the cap holds only part of an object', () => {
    render(
      <RestorePanel
        backups={[
          {
            ...backups[0],
            partial: true,
            objectResults: [
              {
                objectApiName: 'Contact',
                recordCount: 700,
                orgCount: 1234,
                truncated: true,
                stoppedAt: 'cap',
              },
            ],
          },
        ]}
      />,
    );

    expect(screen.getByTestId('restore-partial-op-1').textContent).toContain(
      'Contact: 700 of 1,234 rows read — stopped at the cap',
    );
  });

  it('says nothing of a whole backup', () => {
    render(<RestorePanel backups={backups} />);
    expect(screen.queryByTestId('restore-partial-op-1')).toBeNull();
    expect(screen.queryByTestId('restore-partial-badge-op-1')).toBeNull();
  });

  describe('a backup whose read failed part-way', () => {
    /** As the host lists it: the object read whole, and the one the read failed on. */
    const failedPartWay: BackupSummary = {
      operationId: 'op-3',
      orgId: 'org-1',
      timestamp: '2026-01-02T00:00:00Z',
      status: 'failed',
      partial: true,
      objectResults: [
        { objectApiName: 'Account', recordCount: 300, orgCount: 300, truncated: false },
        {
          objectApiName: 'Contact',
          recordCount: 1000,
          orgCount: 1234,
          truncated: true,
          stoppedAt: 'failure',
        },
      ],
      totalRecords: 1300,
      totalSize: 0,
    };

    it('is offered for a restore, marked partial, with how far the read got', () => {
      render(<RestorePanel backups={[failedPartWay]} />);

      expect(screen.getByTestId('restore-backup-op-3')).toBeDefined();
      expect(screen.getByTestId('restore-partial-badge-op-3').textContent).toBe('Partial');
      const note = screen.getByTestId('restore-partial-op-3');
      expect(note.querySelector('p')?.textContent).toBe(
        'Partial: a restore brings back only the rows this backup read, and leaves the rest of each object as it is.',
      );
      expect([...note.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
        'Contact: 1,000 of 1,234 rows read — the read failed there.',
      ]);
    });

    it('is restored on a click, as a completed one is', () => {
      const onRestore = vi.fn();
      render(
        <RestorePanel backups={[failedPartWay]} selectedBackupId="op-3" onRestore={onRestore} />,
      );

      fireEvent.click(screen.getByTestId('restore-btn-op-3'));

      expect(onRestore).toHaveBeenCalledWith('op-3');
    });

    it('is not offered when it kept no row: there is nothing to restore', () => {
      render(<RestorePanel backups={backups} />);

      expect(screen.queryByTestId('restore-backup-op-2')).toBeNull();
    });
  });

  it('marks a backup stopped at the cap as partial', () => {
    render(
      <RestorePanel
        backups={[
          {
            ...backups[0],
            partial: true,
            objectResults: [
              {
                objectApiName: 'Contact',
                recordCount: 700,
                orgCount: 1234,
                truncated: true,
                stoppedAt: 'cap',
              },
            ],
          },
        ]}
      />,
    );

    expect(screen.getByTestId('restore-partial-badge-op-1').textContent).toBe('Partial');
  });

  it('offers a backup whose stored time is not a date as taken at an unknown time', () => {
    // It read "Invalid Date" as the backup's title.
    render(<RestorePanel backups={[{ ...backups[0], timestamp: 'not a date' }]} />);

    const card = screen.getByTestId('restore-backup-op-1');
    expect(card.textContent).toContain('unknown');
    expect(card.textContent).not.toContain('Invalid Date');
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
