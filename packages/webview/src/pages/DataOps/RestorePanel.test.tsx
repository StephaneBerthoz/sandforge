import { describe, it, expect, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import en from '../../i18n/locales/en.json';
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

  it('says the org has no backup yet, and opens the Backup tab to take one', () => {
    // It asked to select a backup where none existed, and offered no way on.
    const onCreateBackup = vi.fn();
    render(<RestorePanel orgName="dev1" onCreateBackup={onCreateBackup} />);

    expect(screen.getByText('No backup of dev1 yet')).toBeDefined();
    expect(screen.queryByText('Select a backup to restore')).toBeNull();
    const action = screen.getByTestId('empty-action-button');
    expect(action.textContent).toBe('Create a backup');
    fireEvent.click(action);
    expect(onCreateBackup).toHaveBeenCalledTimes(1);
  });

  it('says to click a backup while none is picked, and no longer once one is', () => {
    // After a delete, two cards and no button stood there, and nothing said why.
    const { rerender } = render(<RestorePanel orgName="dev1" backups={backups} />);
    expect(screen.getByTestId('restore-pick').textContent).toBe(
      'Click a backup to restore or delete it.',
    );

    rerender(<RestorePanel orgName="dev1" backups={backups} selectedBackupId="op-1" />);
    expect(screen.queryByTestId('restore-pick')).toBeNull();
  });

  it('names the objects each backup holds, beside how many', () => {
    render(
      <RestorePanel
        backups={[
          {
            ...backups[0],
            objectResults: [
              { objectApiName: 'Contact', recordCount: 60 },
              { objectApiName: 'Lead', recordCount: 40 },
            ],
          },
        ]}
      />,
    );
    expect(screen.getByTestId('backup-objects-op-1').textContent).toBe('2 objects: Contact, Lead');
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

    it('names, before the click, each object the backup never reached', () => {
      render(
        <RestorePanel
          backups={[
            {
              ...failedPartWay,
              objectResults: [
                ...failedPartWay.objectResults,
                {
                  objectApiName: 'Opportunity',
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
        [...screen.getByTestId('restore-partial-op-3').querySelectorAll('li')].map(
          (li) => li.textContent,
        ),
      ).toEqual([
        'Contact: 1,000 of 1,234 rows read — the read failed there.',
        'Opportunity: not read — the backup failed before it reached this object, and holds none of its rows.',
      ]);
    });

    it('is restored once confirmed, as a completed one is, the confirmation saying it is partial', () => {
      const onRestore = vi.fn();
      render(
        <RestorePanel
          orgName="dev1"
          backups={[failedPartWay]}
          selectedBackupId="op-3"
          onRestore={onRestore}
        />,
      );

      fireEvent.click(screen.getByTestId('restore-btn-op-3'));
      expect(screen.getByTestId('restore-confirm-objects').textContent).toContain(
        en.dataops.backupPartialLead,
      );
      fireEvent.click(screen.getByTestId('danger-confirm-btn'));

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
    render(
      <RestorePanel orgName="dev1" backups={backups} selectedBackupId="op-1" onRestore={vi.fn()} />,
    );
    expect(screen.getByText('Selected')).toBeDefined();
    expect(screen.getByTestId('restore-btn-op-1')).toBeDefined();
  });

  it('offers no Restore with no org to name', () => {
    render(<RestorePanel backups={backups} selectedBackupId="op-1" onRestore={vi.fn()} />);
    expect(screen.queryByTestId('restore-btn-op-1')).toBeNull();
  });

  it('should show restore progress', () => {
    render(<RestorePanel isRestoring restoreProgress={{ completed: 50, total: 100 }} />);
    expect(screen.getByTestId('restore-progress')).toBeDefined();
  });

  describe('the question a Restore asks', () => {
    /** A backup of two objects, as the host lists it. */
    const two: BackupSummary = {
      operationId: 'op-9',
      orgId: 'org-1',
      timestamp: '2026-01-01T00:00:00Z',
      status: 'completed',
      objectResults: [
        { objectApiName: 'Contact', recordCount: 1_200 },
        { objectApiName: 'Lead', recordCount: 1 },
      ],
      totalRecords: 1_201,
      totalSize: 0,
    };
    const asked = (props: Partial<ComponentProps<typeof RestorePanel>> = {}) => {
      const onRestore = vi.fn();
      render(
        <RestorePanel
          orgName="dev1"
          backups={[two]}
          selectedBackupId="op-9"
          onRestore={onRestore}
          {...props}
        />,
      );
      fireEvent.click(screen.getByTestId('restore-btn-op-9'));
      return onRestore;
    };

    it('writes nothing on the click: it asks first, naming the org, each object and its records', () => {
      // A restore went out on the click, under a button that named no org.
      const onRestore = asked();

      expect(onRestore).not.toHaveBeenCalled();
      expect(screen.getByTestId('danger-title').textContent).toMatch(
        /^Restore the backup of .+ into dev1\?$/,
      );
      expect(
        [...screen.getByTestId('restore-confirm-objects').querySelectorAll('li')].map(
          (li) => li.textContent,
        ),
      ).toEqual(['Contact: 1,200 records', 'Lead: 1 record']);
      expect(screen.getByTestId('danger-confirm-btn').textContent).toBe('Restore into dev1');
      // A plain question: a restore is no delete, and Production Guard asks on production.
      expect(screen.queryByTestId('danger-input')).toBeNull();
    });

    it('says the rows changed since the backup get its values back, whoever changed them', () => {
      asked();
      expect(screen.getByRole('dialog').textContent).toMatch(
        /Rows changed since .+ get the backup's values back, whoever changed them\./,
      );
    });

    it('says every row is written when the box says so', () => {
      asked({ rewriteAll: true });
      expect(screen.getByRole('dialog').textContent).toContain(
        en.dataops.restoreConfirm.rewriteAll,
      );
    });

    it('says, of a Sync run’s backup, that what changed since the run is left as it is, unless the box says otherwise', () => {
      asked({ backups: [{ ...two, origin: 'sync' }] });
      expect(screen.getByRole('dialog').textContent).toMatch(
        /The records the Sync run of .+ wrote over get back the values they held before it; those changed or deleted since the run are left as they are\./,
      );
    });

    it('says, of a Sync run’s backup restored with what changed since, that those get its values back too', () => {
      asked({ backups: [{ ...two, origin: 'sync' }], includeChanged: true });
      const said = screen.getByRole('dialog').textContent ?? '';
      expect(said).toMatch(/Rows changed since .+ get the backup's values back/);
      expect(said).not.toContain('are left as they are');
    });

    it('restores once the yes is given', () => {
      const onRestore = asked();
      fireEvent.click(screen.getByTestId('danger-confirm-btn'));
      expect(onRestore).toHaveBeenCalledWith('op-9');
      expect(screen.queryByTestId('danger-title')).toBeNull();
    });

    it('restores nothing on Cancel', () => {
      const onRestore = asked();
      fireEvent.click(screen.getByTestId('danger-dismiss-btn'));
      expect(onRestore).not.toHaveBeenCalled();
    });
  });

  describe('the choice to write every row back', () => {
    it('is offered unchecked, says what each way does, and is told when checked', () => {
      const onChange = vi.fn();
      render(<RestorePanel backups={backups} onRewriteAllChange={onChange} />);

      const box = screen.getByTestId('restore-rewrite-all') as HTMLInputElement;
      expect(box.checked).toBe(false);
      expect(
        screen.getByLabelText(/Write every row of the backup back.*only the rows that changed/),
      ).toBe(box);

      fireEvent.click(box);
      expect(onChange).toHaveBeenCalledWith(true);
    });

    it('cannot be changed while a restore writes', () => {
      render(<RestorePanel backups={backups} onRewriteAllChange={vi.fn()} isRestoring />);
      expect((screen.getByTestId('restore-rewrite-all') as HTMLInputElement).disabled).toBe(true);
    });

    it('is not offered with no backup to restore', () => {
      render(<RestorePanel onRewriteAllChange={vi.fn()} />);
      expect(screen.queryByTestId('restore-rewrite-all')).toBeNull();
    });
  });

  it('says a Sync run’s backup it lists as partial holds what the run had kept by then', () => {
    const cut: BackupSummary = {
      ...backups[0],
      operationId: 'sync-before-run-2',
      origin: 'sync',
      partial: true,
      totalRecords: 40,
      objectResults: [{ objectApiName: 'Account', recordCount: 40, truncated: false }],
    };
    render(<RestorePanel backups={[cut]} />);

    expect(screen.getByTestId('restore-partial-badge-sync-before-run-2')).toBeTruthy();
    expect(screen.getByTestId('restore-sync-partial-sync-before-run-2').textContent).toBe(
      en.dataops.restoreSyncPartial,
    );
    expect(screen.queryByTestId('restore-partial-sync-before-run-2')).toBeNull();
  });

  it('says what the last restore wrote, left alone because it already held the backup values, and had refused', () => {
    render(
      <RestorePanel backups={backups} lastRestore={{ written: 3, unchanged: 11_997, failed: 0 }} />,
    );
    expect(screen.getByTestId('restore-result').textContent).toBe(
      'Last restore — written: 3 · already as in the backup, left alone: 11997 · refused: 0',
    );
  });

  it('says nothing of the last restore while another writes', () => {
    render(
      <RestorePanel
        backups={backups}
        isRestoring
        lastRestore={{ written: 3, unchanged: 0, failed: 0 }}
      />,
    );
    expect(screen.queryByTestId('restore-result')).toBeNull();
  });

  describe('deleting backups from this machine', () => {
    it('deletes the backup selected only once asked to confirm', () => {
      const onDelete = vi.fn();
      render(<RestorePanel backups={backups} selectedBackupId="op-1" onDelete={onDelete} />);

      fireEvent.click(screen.getByTestId('delete-backup-btn-op-1'));
      expect(onDelete).not.toHaveBeenCalled();
      expect(screen.getByTestId('delete-backup-question').textContent).toContain(
        en.dataops.backupDeleteConfirm,
      );
      fireEvent.click(screen.getByTestId('delete-backup-cancel'));
      expect(screen.queryByTestId('delete-backup-question')).toBeNull();

      fireEvent.click(screen.getByTestId('delete-backup-btn-op-1'));
      // Its button says it deletes, never a bare Confirm.
      expect(screen.getByTestId('delete-backup-confirm').textContent).toBe('Delete');
      fireEvent.click(screen.getByTestId('delete-backup-confirm'));
      expect(onDelete).toHaveBeenCalledWith('op-1');
    });

    it('says, before deleting the backup a Sync run kept, that removing the run will no longer put its values back', () => {
      const run: BackupSummary = {
        ...backups[0],
        operationId: 'sync-before-run-1',
        origin: 'sync',
      };
      render(
        <RestorePanel backups={[run]} selectedBackupId="sync-before-run-1" onDelete={vi.fn()} />,
      );

      fireEvent.click(screen.getByTestId('delete-backup-btn-sync-before-run-1'));

      const question = screen.getByTestId('delete-backup-question').textContent ?? '';
      expect(question).not.toContain(en.dataops.backupDeleteConfirm);
      expect(question).toMatch(
        /^Delete this backup\? It holds what the Sync run of .+ wrote over: removing that run in Sync will no longer put these values back/,
      );
    });

    it('deletes every backup of the org, those it cannot restore included, once asked', () => {
      const onDeleteAll = vi.fn();
      render(<RestorePanel backups={backups} onDeleteAll={onDeleteAll} />);

      fireEvent.click(screen.getByTestId('delete-all-backups-btn'));
      expect(screen.getByTestId('delete-backup-question').textContent).toContain(
        en.dataops.backupDeleteAllConfirm_other.replace('{{count}}', '2'),
      );
      expect(screen.getByTestId('delete-backup-confirm').textContent).toBe(
        en.dataops.backupDeleteAll,
      );
      fireEvent.click(screen.getByTestId('delete-backup-confirm'));
      expect(onDeleteAll).toHaveBeenCalledTimes(1);
    });

    it('offers no deletion while a restore is running', () => {
      render(
        <RestorePanel
          backups={backups}
          selectedBackupId="op-1"
          onDelete={vi.fn()}
          onDeleteAll={vi.fn()}
          isRestoring
        />,
      );

      const remove = screen.getByTestId('delete-backup-btn-op-1');
      expect(remove.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(remove);
      expect(screen.queryByTestId('delete-backup-question')).toBeNull();
      expect(screen.queryByTestId('delete-all-backups-btn')).toBeNull();
    });

    describe('where the keyboard goes once the question is answered', () => {
      /** Two backups the panel can restore, newest first, as the host lists them. */
      const two: BackupSummary[] = [
        { ...backups[0], operationId: 'op-new', timestamp: '2026-01-02T00:00:00Z' },
        { ...backups[0], operationId: 'op-old' },
      ];
      const cardOf = (operationId: string): HTMLElement | null =>
        screen.getByTestId(`restore-backup-${operationId}`).querySelector('[role="button"]');

      it('goes back to the Delete that asked, on Cancel', () => {
        render(<RestorePanel backups={two} selectedBackupId="op-new" onDelete={vi.fn()} />);
        fireEvent.click(screen.getByTestId('delete-backup-btn-op-new'));

        fireEvent.click(screen.getByTestId('delete-backup-cancel'));

        expect(document.activeElement).toBe(screen.getByTestId('delete-backup-btn-op-new'));
      });

      it('stays on the Delete that asked while the deletion runs, then goes to the card now in its place', () => {
        const onDelete = vi.fn();
        const { rerender } = render(
          <RestorePanel backups={two} selectedBackupId="op-new" onDelete={onDelete} />,
        );
        fireEvent.click(screen.getByTestId('delete-backup-btn-op-new'));

        fireEvent.click(screen.getByTestId('delete-backup-confirm'));
        rerender(
          <RestorePanel backups={two} selectedBackupId="op-new" onDelete={onDelete} isDeleting />,
        );

        const remove = screen.getByTestId('delete-backup-btn-op-new');
        expect(document.activeElement).toBe(remove);
        expect(remove.getAttribute('aria-disabled')).toBe('true');

        rerender(<RestorePanel backups={two.slice(1)} onDelete={onDelete} />);

        expect(document.activeElement).toBe(cardOf('op-old'));
      });

      it('goes to the card before the one deleted when that one was the last', () => {
        const { rerender } = render(
          <RestorePanel backups={two} selectedBackupId="op-old" onDelete={vi.fn()} />,
        );
        fireEvent.click(screen.getByTestId('delete-backup-btn-op-old'));
        fireEvent.click(screen.getByTestId('delete-backup-confirm'));

        rerender(<RestorePanel backups={two.slice(0, 1)} onDelete={vi.fn()} />);

        expect(document.activeElement).toBe(cardOf('op-new'));
      });

      it('goes to the heading once every backup is deleted', () => {
        const { rerender } = render(<RestorePanel backups={two} onDeleteAll={vi.fn()} />);
        fireEvent.click(screen.getByTestId('delete-all-backups-btn'));

        fireEvent.click(screen.getByTestId('delete-backup-confirm'));
        expect(document.activeElement).toBe(screen.getByTestId('delete-all-backups-btn'));
        rerender(<RestorePanel backups={[]} onDeleteAll={vi.fn()} />);

        expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Restore' }));
      });

      it('leaves the keyboard where it went while the deletion ran', () => {
        const panel = (list: BackupSummary[], selected?: string) => (
          <>
            <button type="button">Elsewhere on the page</button>
            <RestorePanel backups={list} selectedBackupId={selected} onDelete={vi.fn()} />
          </>
        );
        const { rerender } = render(panel(two, 'op-new'));
        fireEvent.click(screen.getByTestId('delete-backup-btn-op-new'));
        fireEvent.click(screen.getByTestId('delete-backup-confirm'));
        const elsewhere = screen.getByRole('button', { name: 'Elsewhere on the page' });
        elsewhere.focus();
        rerender(panel(two, 'op-new'));

        rerender(panel(two.slice(1)));

        expect(document.activeElement).toBe(elsewhere);
      });

      it('stays on the Delete that asked when the backup is still listed: the org refused it', () => {
        const { rerender } = render(
          <RestorePanel backups={two} selectedBackupId="op-new" onDelete={vi.fn()} />,
        );
        fireEvent.click(screen.getByTestId('delete-backup-btn-op-new'));
        fireEvent.click(screen.getByTestId('delete-backup-confirm'));

        rerender(<RestorePanel backups={two} selectedBackupId="op-new" onDelete={vi.fn()} />);

        expect(document.activeElement).toBe(screen.getByTestId('delete-backup-btn-op-new'));
      });
    });
  });

  describe('the backup a Sync run kept of what it wrote over', () => {
    const kept: BackupSummary = { ...backups[0], operationId: 'sync-before-run-1', origin: 'sync' };

    it('says it is a Sync run’s, and that removing the run puts it back too', () => {
      render(<RestorePanel backups={[kept, backups[0]]} />);

      expect(screen.getByTestId('restore-sync-badge-sync-before-run-1').textContent).toBe(
        en.dataops.restoreSyncBadge,
      );
      expect(screen.getByTestId('restore-sync-sync-before-run-1').textContent).toBe(
        en.dataops.restoreSyncNote,
      );
    });

    it('says nothing of the kind of a DataOps backup', () => {
      render(<RestorePanel backups={[kept, backups[0]]} />);

      expect(screen.queryByTestId('restore-sync-badge-op-1')).toBeNull();
      expect(screen.queryByTestId('restore-sync-op-1')).toBeNull();
    });

    it('offers, once it is selected, to restore the records changed since the run too', () => {
      const onIncludeChangedChange = vi.fn();
      const { rerender } = render(
        <RestorePanel
          backups={[kept, backups[0]]}
          selectedBackupId="sync-before-run-1"
          onRestore={vi.fn()}
          onIncludeChangedChange={onIncludeChangedChange}
        />,
      );

      const box = screen.getByTestId('restore-include-changed-sync-before-run-1');
      expect((box as HTMLInputElement).checked).toBe(false);
      expect(screen.getByLabelText(en.dataops.restoreIncludeChanged)).toBe(box);
      fireEvent.click(box);
      expect(onIncludeChangedChange).toHaveBeenCalledWith(true);

      // A DataOps backup has no run to be held to.
      rerender(
        <RestorePanel
          backups={[kept, backups[0]]}
          selectedBackupId="op-1"
          onRestore={vi.fn()}
          onIncludeChangedChange={onIncludeChangedChange}
        />,
      );
      expect(screen.queryByTestId('restore-include-changed-op-1')).toBeNull();
    });

    it('lists what the last restore left as it is, changed since the run, per object', () => {
      render(
        <RestorePanel
          backups={[kept]}
          lastRestore={{
            written: 1,
            unchanged: 0,
            failed: 0,
            keptChanged: {
              objects: [
                { objectApiName: 'Account', count: 1 },
                { objectApiName: 'Contact', count: 1200 },
              ],
            },
          }}
        />,
      );

      expect(screen.getByTestId('restore-kept-changed').textContent).toBe(
        en.dataops.restoreKeptChanged.replace('{{objects}}', 'Account 1, Contact 1,200'),
      );
    });

    it('says why every record read as changed since a run no longer kept', () => {
      render(
        <RestorePanel
          backups={[kept]}
          lastRestore={{
            written: 0,
            unchanged: 0,
            failed: 0,
            keptChanged: { objects: [{ objectApiName: 'Account', count: 2 }], runNotKept: true },
          }}
        />,
      );

      expect(screen.getByTestId('restore-kept-changed').textContent).toContain(
        en.dataops.restoreRunNotKept,
      );
    });
  });
});
