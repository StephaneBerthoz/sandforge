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

  it('names, before the click, the objects a backup reads and the template they come from', () => {
    const { rerender } = render(
      <BackupPanel objects={['Contact', 'Lead']} template="GDPR Template" />,
    );
    expect(screen.getByTestId('backup-objects').textContent).toBe(
      'Backs up Contact, Lead: the objects GDPR Template masks.',
    );

    rerender(<BackupPanel objects={['Contact', 'Lead', 'Opportunity']} />);
    expect(screen.getByTestId('backup-objects').textContent).toBe(
      'Backs up Contact, Lead, Opportunity: the objects the anonymization templates mask.',
    );
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

  it('says, per object, the rows read against the rows the org held, and whether the cap stopped it or the read failed', () => {
    render(
      <BackupPanel
        backups={[
          {
            ...backups[0],
            status: 'failed',
            partial: true,
            objectResults: [
              {
                objectApiName: 'Contact',
                recordCount: 700,
                orgCount: 1234,
                truncated: true,
                stoppedAt: 'cap',
              },
              { objectApiName: 'Lead', recordCount: 300, truncated: true, stoppedAt: 'failure' },
              { objectApiName: 'Account', recordCount: 40, orgCount: 40, truncated: false },
            ],
          },
        ]}
      />,
    );

    const note = screen.getByTestId('backup-partial-op-1');
    expect(note.querySelector('p')?.textContent).toBe(
      'Partial: a restore brings back only the rows this backup read, and leaves the rest of each object as it is.',
    );
    expect([...note.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'Contact: 700 of 1,234 rows read — stopped at the cap (sandforge.backup.maxRecordsPerObject).',
      'Lead: 300 rows read — the read failed there.',
    ]);
    expect(screen.getByText('failed')).toBeDefined();
  });

  it('names the encrypted fields a backup did not keep, read masked, and that a restore leaves them', () => {
    render(
      <BackupPanel
        backups={[
          {
            ...backups[0],
            objectResults: [
              { objectApiName: 'Account', recordCount: 100, notKept: ['Tax_Id__c'] },
              { objectApiName: 'Contact', recordCount: 3 },
            ],
          },
        ]}
      />,
    );

    expect(screen.getByTestId('backup-not-kept-op-1-Account').textContent).toBe(
      'Account: Tax_Id__c not kept — encrypted fields the user SandForge connects as sees ' +
        'masked, lacking View Encrypted Data. A restore leaves them as the org holds them.',
    );
    expect(screen.queryByTestId('backup-not-kept-op-1-Contact')).toBeNull();
  });

  it('names each object a failed backup never reached, and says it holds none of it', () => {
    render(
      <BackupPanel
        backups={[
          {
            ...backups[0],
            status: 'failed',
            partial: true,
            objectResults: [
              { objectApiName: 'Contact', recordCount: 300, orgCount: 300, truncated: false },
              { objectApiName: 'Lead', recordCount: 0, truncated: true, stoppedAt: 'failure' },
              {
                objectApiName: 'Account',
                recordCount: 0,
                truncated: true,
                stoppedAt: 'not_reached',
              },
            ],
          },
        ]}
      />,
    );

    expect(
      [...screen.getByTestId('backup-partial-op-1').querySelectorAll('li')].map(
        (li) => li.textContent,
      ),
    ).toEqual([
      'Lead: 0 rows read — the read failed there.',
      'Account: not read — the backup failed before it reached this object, and holds none of its rows.',
    ]);
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
