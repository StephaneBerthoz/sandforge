import { describe, it, expect, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import en from '../../i18n/locales/en.json';
import { BackupPanel, isRestorable } from './BackupPanel';
import type { BackupSetSummary, BackupSummary } from '@sandforge/shared';

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

describe('isRestorable', () => {
  it('restores a completed backup, and a failed one that kept rows, never one that kept none', () => {
    expect(isRestorable(backups[0])).toBe(true);
    expect(isRestorable({ ...backups[1], totalRecords: 12 })).toBe(true);
    expect(isRestorable(backups[1])).toBe(false);
    expect(isRestorable({ ...backups[0], status: 'running' })).toBe(false);
  });
});

describe('BackupPanel', () => {
  it('should render the panel', () => {
    render(<BackupPanel />);
    expect(screen.getByTestId('backup-panel')).toBeDefined();
  });

  it('says the org has no backup yet, and opens Masking to take one', () => {
    // It asked to select a backup where none existed, and offered no way on.
    const onCreateBackup = vi.fn();
    render(<BackupPanel orgName="dev1" onCreateBackup={onCreateBackup} />);

    expect(screen.getByText('No backup of dev1 yet')).toBeDefined();
    expect(screen.getByText(en.dataops.restoreEmptyDesc)).toBeDefined();
    const action = screen.getByTestId('empty-action-button');
    expect(action.textContent).toBe('Create a backup');
    fireEvent.click(action);
    expect(onCreateBackup).toHaveBeenCalledTimes(1);
  });

  it('lists every backup once, each with Restore…, Export and Delete, nothing to select first', () => {
    // The list was on two tabs: Backup had Export, Restore had Delete and, once
    // a card was clicked, Restore.
    render(
      <BackupPanel
        orgName="dev1"
        backups={backups}
        onRestore={vi.fn()}
        onExport={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByTestId('restore-btn-op-1').textContent).toBe('Restore…');
    expect(screen.getByTestId('export-backup-op-1')).toBeDefined();
    expect(screen.getByTestId('delete-backup-btn-op-1')).toBeDefined();
    expect(screen.queryByText('Selected')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Sat|^Jan|Click a backup/ })).toBeNull();
  });

  it('exports a backup from its row', () => {
    const onExport = vi.fn();
    render(<BackupPanel backups={backups} onExport={onExport} />);

    fireEvent.click(screen.getByTestId('export-backup-op-2'));

    expect(onExport).toHaveBeenCalledWith('op-2');
  });

  it('lists a backup that kept no row, to export or delete, and offers no Restore… of it', () => {
    render(
      <BackupPanel
        orgName="dev1"
        backups={backups}
        onRestore={vi.fn()}
        onExport={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByTestId('backup-op-2')).toBeDefined();
    expect(screen.queryByTestId('restore-btn-op-2')).toBeNull();
    expect(screen.getByTestId('delete-backup-btn-op-2')).toBeDefined();
  });

  it('names the objects each backup holds, beside how many', () => {
    render(
      <BackupPanel
        backups={[
          {
            ...backups[0],
            objectResults: [
              { objectApiName: 'Contact', recordCount: 60 },
              { objectApiName: 'Lead', recordCount: 40 },
            ],
          },
          { ...backups[0], operationId: 'op-3' },
        ]}
      />,
    );
    expect(screen.getByTestId('backup-objects-op-1').textContent).toBe('2 objects: Contact, Lead');
    expect(screen.getByTestId('backup-objects-op-3').textContent).toBe('1 object: Account');
  });

  it('names a backup whose stored time is not a date as taken at an unknown time', () => {
    // It read "Invalid Date" as the backup's title.
    render(<BackupPanel backups={[{ ...backups[0], timestamp: 'not a date' }]} />);

    const card = screen.getByTestId('backup-op-1');
    expect(card.textContent).toContain('unknown');
    expect(card.textContent).not.toContain('Invalid Date');
  });

  it('says each backup’s status in words of the interface, not its stored code', () => {
    // It printed "completed" in lower-case English in every language.
    render(<BackupPanel backups={backups} />);
    expect(screen.getByTestId('backup-status-op-1').textContent).toBe('Completed');
    expect(screen.getByTestId('backup-status-op-2').textContent).toBe('Failed');
    expect(screen.queryByText('completed')).toBeNull();
  });

  it('marks a backup a cap stopped short as Partial, in amber, not Completed in green', () => {
    render(
      <BackupPanel
        backups={[
          {
            ...backups[0],
            partial: true,
            objectResults: [
              { objectApiName: 'Contact', recordCount: 700, truncated: true, stoppedAt: 'cap' },
            ],
          },
        ]}
      />,
    );
    const badge = screen.getByTestId('backup-status-op-1');
    expect(badge.textContent).toBe('Partial');
    expect(badge.className).toContain('status-warning');
  });

  it('says which objects an older partial backup holds only part of, and nothing of a whole one', () => {
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
          { ...backups[0], operationId: 'op-whole' },
        ]}
      />,
    );

    expect(screen.getByTestId('backup-partial-op-1').textContent).toBe(
      'Partial: Contact (500) hold more rows than this backup read. A restore brings back these rows only.',
    );
    expect(screen.queryByTestId('backup-partial-op-whole')).toBeNull();
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

    const note = screen.getByTestId('backup-partial-op-1');
    expect(note.querySelector('p')?.textContent).toBe(en.dataops.backupPartialLead);
    expect([...note.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'Contact: 700 of 1,234 rows read — stopped at the cap (sandforge.backup.maxRecordsPerObject).',
      'Lead: 300 rows read — the read failed there.',
      'Account: not read — the backup failed before it reached this object, and holds none of its rows.',
    ]);
    expect(screen.getByTestId('backup-status-op-1').textContent).toBe('Partial');
  });

  it('says past a million rows of an object that nothing raises a backup, and that a backup in slices holds it whole', () => {
    // It named the setting, which holds 1,000,000 rows at most.
    render(
      <BackupPanel
        backups={[
          {
            ...backups[0],
            status: 'failed',
            partial: true,
            objectResults: [
              {
                objectApiName: 'Task',
                recordCount: 1_000_000,
                orgCount: 3_400_000,
                truncated: true,
                stoppedAt: 'cap',
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
      'Task: 1,000,000 of 3,400,000 rows read — no backup holds more than 1,000,000 rows of one ' +
        'object. Tick “Back up in slices” and back up again: each slice is a backup of its own.',
    ]);
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

  it('offers no Restore… with no org to name', () => {
    render(<BackupPanel backups={backups} onRestore={vi.fn()} />);
    expect(screen.queryByTestId('restore-btn-op-1')).toBeNull();
  });

  it('should show restore progress', () => {
    render(<BackupPanel isRestoring restoreProgress={{ completed: 50, total: 100 }} />);
    expect(screen.getByTestId('restore-progress')).toBeDefined();
  });

  describe('the way back from a run on any object', () => {
    it('says a checkpoint is it, and opens Checkpoints on a take', () => {
      // The tab told a newcomer to back up before any risky operation, and a
      // backup reads only the objects the templates mask.
      const onTakeCheckpoint = vi.fn();
      render(<BackupPanel onTakeCheckpoint={onTakeCheckpoint} />);

      expect(screen.getByTestId('backup-checkpoint').textContent).toContain(
        "Before a risky run on a sandbox, take a checkpoint (Checkpoints → Take a checkpoint): Rewind… returns the org's data to it.",
      );
      fireEvent.click(screen.getByTestId('backup-checkpoint-take'));
      expect(onTakeCheckpoint).toHaveBeenCalledTimes(1);
    });

    it('says nothing of it where a checkpoint cannot be taken', () => {
      render(<BackupPanel />);
      expect(screen.queryByTestId('backup-checkpoint')).toBeNull();
    });
  });

  describe('the question a Restore… asks', () => {
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
    const asked = (props: Partial<ComponentProps<typeof BackupPanel>> = {}) => {
      const onRestore = vi.fn();
      render(<BackupPanel orgName="dev1" backups={[two]} onRestore={onRestore} {...props} />);
      fireEvent.click(screen.getByTestId(`restore-btn-${(props.backups ?? [two])[0].operationId}`));
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

    it('asks there whether every row is written back, unticked, and sends what it says', () => {
      // The box sat above the list, away from the question it changes.
      const onRestore = asked();

      const box = screen.getByTestId('restore-rewrite-all') as HTMLInputElement;
      expect(box.checked).toBe(false);
      expect(screen.getByRole('dialog').contains(box)).toBe(true);
      expect(
        screen.getByLabelText(/Write every row of the backup back.*only the rows that changed/),
      ).toBe(box);
      fireEvent.click(box);
      fireEvent.click(screen.getByTestId('danger-confirm-btn'));

      expect(onRestore).toHaveBeenCalledWith('op-9', { rewriteAll: true, includeChanged: false });
    });

    it('asks each restore afresh: a box ticked for one is not ticked for the next', () => {
      asked();
      fireEvent.click(screen.getByTestId('restore-rewrite-all'));
      fireEvent.click(screen.getByTestId('danger-dismiss-btn'));

      fireEvent.click(screen.getByTestId('restore-btn-op-9'));

      expect((screen.getByTestId('restore-rewrite-all') as HTMLInputElement).checked).toBe(false);
    });

    it('says, of a Sync run’s backup, that what changed since the run is left as it is, unless its box says otherwise', () => {
      const kept = { ...two, origin: 'sync' as const };
      const onRestore = asked({ backups: [kept] });
      expect(screen.getByRole('dialog').textContent).toMatch(
        /The records the Sync run of .+ wrote over get back the values they held before it; those changed or deleted since the run are left as they are\./,
      );

      const box = screen.getByTestId('restore-include-changed-op-9') as HTMLInputElement;
      expect(box.checked).toBe(false);
      expect(screen.getByLabelText(en.dataops.restoreIncludeChanged)).toBe(box);
      fireEvent.click(box);
      const said = screen.getByRole('dialog').textContent ?? '';
      expect(said).toMatch(/Rows changed since .+ get the backup's values back/);
      expect(said).not.toContain('are left as they are');

      fireEvent.click(screen.getByTestId('danger-confirm-btn'));
      expect(onRestore).toHaveBeenCalledWith('op-9', { rewriteAll: false, includeChanged: true });
    });

    it('asks nothing of the records changed since a run of a DataOps backup, which has none', () => {
      asked();
      expect(screen.queryByTestId('restore-include-changed-op-9')).toBeNull();
    });

    it('says a partial backup restores only the rows it read', () => {
      asked({
        backups: [
          {
            ...two,
            status: 'failed',
            partial: true,
            objectResults: [
              {
                objectApiName: 'Contact',
                recordCount: 1000,
                orgCount: 1234,
                truncated: true,
                stoppedAt: 'failure',
              },
            ],
          },
        ],
      });

      expect(screen.getByTestId('restore-confirm-objects').textContent).toContain(
        en.dataops.backupPartialLead,
      );
    });

    it('restores once the yes is given, without the org’s id no acceptance of what fires', () => {
      const onRestore = asked();
      fireEvent.click(screen.getByTestId('danger-confirm-btn'));
      expect(onRestore).toHaveBeenCalledWith('op-9', { rewriteAll: false, includeChanged: false });
      expect(screen.queryByTestId('danger-title')).toBeNull();
    });

    it('restores nothing on Cancel', () => {
      const onRestore = asked();
      fireEvent.click(screen.getByTestId('danger-dismiss-btn'));
      expect(onRestore).not.toHaveBeenCalled();
    });

    it('cannot be asked while a restore writes, and keeps the keyboard on its row', () => {
      render(<BackupPanel orgName="dev1" backups={[two]} onRestore={vi.fn()} isRestoring />);

      const restore = screen.getByTestId('restore-btn-op-9');
      expect(restore.getAttribute('aria-disabled')).toBe('true');
      restore.focus();
      expect(document.activeElement).toBe(restore);
      fireEvent.click(restore);
      expect(screen.queryByTestId('danger-title')).toBeNull();
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
    render(<BackupPanel backups={[cut]} />);

    expect(screen.getByTestId('backup-status-sync-before-run-2').textContent).toBe('Partial');
    expect(screen.getByTestId('restore-sync-partial-sync-before-run-2').textContent).toBe(
      en.dataops.restoreSyncPartial,
    );
    expect(screen.queryByTestId('backup-partial-sync-before-run-2')).toBeNull();
  });

  it('says what the last restore wrote, left alone because it already held the backup values, and had refused', () => {
    render(
      <BackupPanel backups={backups} lastRestore={{ written: 3, unchanged: 11_997, failed: 0 }} />,
    );
    expect(screen.getByTestId('restore-result').textContent).toBe(
      'Last restore — written: 3 · already as in the backup, left alone: 11997 · refused: 0',
    );
  });

  it('says nothing of the last restore while another writes', () => {
    render(
      <BackupPanel
        backups={backups}
        isRestoring
        lastRestore={{ written: 3, unchanged: 0, failed: 0 }}
      />,
    );
    expect(screen.queryByTestId('restore-result')).toBeNull();
  });

  describe('deleting backups from this machine', () => {
    it('deletes a backup only once asked to confirm', () => {
      const onDelete = vi.fn();
      render(<BackupPanel backups={backups} onDelete={onDelete} />);

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
      render(<BackupPanel backups={[run]} onDelete={vi.fn()} />);

      fireEvent.click(screen.getByTestId('delete-backup-btn-sync-before-run-1'));

      const question = screen.getByTestId('delete-backup-question').textContent ?? '';
      expect(question).not.toContain(en.dataops.backupDeleteConfirm);
      expect(question).toMatch(
        /^Delete this backup\? It holds what the Sync run of .+ wrote over: removing that run in Sync will no longer put these values back/,
      );
    });

    it('deletes every backup of the org, those it cannot restore included, once asked', () => {
      const onDeleteAll = vi.fn();
      render(<BackupPanel backups={backups} onDeleteAll={onDeleteAll} />);

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
        <BackupPanel backups={backups} onDelete={vi.fn()} onDeleteAll={vi.fn()} isRestoring />,
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
      /** The first button of a backup's entry, where the keyboard lands on it. */
      const firstButtonOf = (operationId: string): HTMLElement | null =>
        screen.getByTestId(`backup-${operationId}`).querySelector('button');

      it('goes back to the Delete that asked, on Cancel', () => {
        render(<BackupPanel backups={two} onDelete={vi.fn()} />);
        fireEvent.click(screen.getByTestId('delete-backup-btn-op-new'));

        fireEvent.click(screen.getByTestId('delete-backup-cancel'));

        expect(document.activeElement).toBe(screen.getByTestId('delete-backup-btn-op-new'));
      });

      it('stays on the Delete that asked while the deletion runs, then goes to the entry now in its place', () => {
        const onDelete = vi.fn();
        const { rerender } = render(<BackupPanel backups={two} onDelete={onDelete} />);
        fireEvent.click(screen.getByTestId('delete-backup-btn-op-new'));

        fireEvent.click(screen.getByTestId('delete-backup-confirm'));
        rerender(<BackupPanel backups={two} onDelete={onDelete} isDeleting />);

        const remove = screen.getByTestId('delete-backup-btn-op-new');
        expect(document.activeElement).toBe(remove);
        expect(remove.getAttribute('aria-disabled')).toBe('true');

        rerender(<BackupPanel backups={two.slice(1)} onDelete={onDelete} />);

        expect(document.activeElement).toBe(firstButtonOf('op-old'));
      });

      it('goes to the entry before the one deleted when that one was the last', () => {
        const { rerender } = render(<BackupPanel backups={two} onDelete={vi.fn()} />);
        fireEvent.click(screen.getByTestId('delete-backup-btn-op-old'));
        fireEvent.click(screen.getByTestId('delete-backup-confirm'));

        rerender(<BackupPanel backups={two.slice(0, 1)} onDelete={vi.fn()} />);

        expect(document.activeElement).toBe(firstButtonOf('op-new'));
      });

      it('goes to the heading once every backup is deleted', () => {
        const { rerender } = render(<BackupPanel backups={two} onDeleteAll={vi.fn()} />);
        fireEvent.click(screen.getByTestId('delete-all-backups-btn'));

        fireEvent.click(screen.getByTestId('delete-backup-confirm'));
        expect(document.activeElement).toBe(screen.getByTestId('delete-all-backups-btn'));
        rerender(<BackupPanel backups={[]} onDeleteAll={vi.fn()} />);

        expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Backups' }));
      });

      it('leaves the keyboard where it went while the deletion ran', () => {
        const panel = (list: BackupSummary[]) => (
          <>
            <button type="button">Elsewhere on the page</button>
            <BackupPanel backups={list} onDelete={vi.fn()} />
          </>
        );
        const { rerender } = render(panel(two));
        fireEvent.click(screen.getByTestId('delete-backup-btn-op-new'));
        fireEvent.click(screen.getByTestId('delete-backup-confirm'));
        const elsewhere = screen.getByRole('button', { name: 'Elsewhere on the page' });
        elsewhere.focus();
        rerender(panel(two));

        rerender(panel(two.slice(1)));

        expect(document.activeElement).toBe(elsewhere);
      });

      it('stays on the Delete that asked when the backup is still listed: the org refused it', () => {
        const { rerender } = render(<BackupPanel backups={two} onDelete={vi.fn()} />);
        fireEvent.click(screen.getByTestId('delete-backup-btn-op-new'));
        fireEvent.click(screen.getByTestId('delete-backup-confirm'));

        rerender(<BackupPanel backups={two} onDelete={vi.fn()} />);

        expect(document.activeElement).toBe(screen.getByTestId('delete-backup-btn-op-new'));
      });
    });
  });

  describe('the backup a Sync run kept of what it wrote over', () => {
    const kept: BackupSummary = { ...backups[0], operationId: 'sync-before-run-1', origin: 'sync' };

    it('says it is a Sync run’s, and that removing the run puts it back too', () => {
      render(<BackupPanel backups={[kept, backups[0]]} />);

      expect(screen.getByTestId('restore-sync-badge-sync-before-run-1').textContent).toBe(
        en.dataops.restoreSyncBadge,
      );
      expect(screen.getByTestId('restore-sync-sync-before-run-1').textContent).toBe(
        en.dataops.restoreSyncNote,
      );
    });

    it('says nothing of the kind of a DataOps backup', () => {
      render(<BackupPanel backups={[kept, backups[0]]} />);

      expect(screen.queryByTestId('restore-sync-badge-op-1')).toBeNull();
      expect(screen.queryByTestId('restore-sync-op-1')).toBeNull();
    });

    it('lists what the last restore left as it is, changed since the run, per object', () => {
      render(
        <BackupPanel
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
        <BackupPanel
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

  describe('a set of slices', () => {
    /** A masking set of three slices, the second restored before. */
    const set: BackupSetSummary = {
      setId: 'set-1',
      orgId: 'org-1',
      kind: 'masking',
      state: 'done',
      startedAt: '2026-11-14T08:00:00.000Z',
      lastActivityAt: '2026-11-14T09:00:00.000Z',
      size: 1_000,
      totalRecords: 2_500,
      slices: [1, 2, 3].map((index) => ({
        index,
        objectApiName: 'Contact',
        snapshotId: `set-1-s000${index}`,
        rows: index === 3 ? 500 : 1_000,
        masked: index === 3 ? 500 : 1_000,
        refused: 0,
        deletedSince: 0,
        nothingToMask: 0,
        state: index === 2 ? ('restored' as const) : ('masked' as const),
        ...(index === 2 ? { restoredAt: '2026-11-14T10:00:00.000Z' } : {}),
      })),
    };

    it('lists the set beside the backups, and offers nothing empty', () => {
      render(<BackupPanel orgName="dev1" sets={[set]} onCreateBackup={vi.fn()} />);

      expect(screen.getByTestId('restore-set-set-1')).toBeDefined();
      expect(screen.queryByText(en.dataops.restoreEmptyDesc)).toBeNull();
    });

    it('shows the slices of the set a masking run’s result opened the tab on', () => {
      const { unmount } = render(<BackupPanel orgName="dev1" sets={[set]} />);
      expect(screen.queryByTestId('restore-set-set-1-slices')).toBeNull();
      unmount();

      render(<BackupPanel orgName="dev1" sets={[set]} openedId="set-1" />);
      expect(screen.getByTestId('restore-set-set-1-slices')).toBeDefined();
    });

    it('asks before a restore of the set, naming what it puts back and what it costs', () => {
      const onRestoreSet = vi.fn();
      render(<BackupPanel orgName="dev1" sets={[set]} onRestoreSet={onRestoreSet} />);

      fireEvent.click(screen.getByTestId('restore-set-set-1-all'));
      expect(onRestoreSet).not.toHaveBeenCalled();
      // The slice restored before is not read again: 1,500 rows, not 2,500.
      expect(screen.getByTestId('restore-set-confirm-objects').textContent).toContain(
        'Contact: 1,500 records',
      );
      expect(screen.getByTestId('restore-set-cost').textContent).toBe(
        'About 16 requests, no Bulk API batch.',
      );
      fireEvent.click(screen.getByTestId('danger-confirm-btn'));

      expect(onRestoreSet).toHaveBeenCalledWith('set-1', undefined, { rewriteAll: false });
    });

    it('counts the slice restored before once its question says every row is written back', () => {
      const onRestoreSet = vi.fn();
      render(<BackupPanel orgName="dev1" sets={[set]} onRestoreSet={onRestoreSet} />);
      fireEvent.click(screen.getByTestId('restore-set-set-1-all'));

      fireEvent.click(screen.getByTestId('restore-rewrite-all'));

      expect(screen.getByTestId('restore-set-confirm-objects').textContent).toContain(
        'Contact: 2,500 records',
      );
      fireEvent.click(screen.getByTestId('danger-confirm-btn'));
      expect(onRestoreSet).toHaveBeenCalledWith('set-1', undefined, { rewriteAll: true });
    });

    it('counts the sets among the backups a Delete all deletes', () => {
      render(
        <BackupPanel orgName="dev1" backups={[backups[0]]} sets={[set]} onDeleteAll={vi.fn()} />,
      );
      fireEvent.click(screen.getByTestId('delete-all-backups-btn'));

      expect(screen.getByTestId('delete-backup-question').textContent).toContain(
        'Delete the 2 backups of this org',
      );
    });

    it('says which slices the last restore wrote back and which it did not read again', () => {
      render(
        <BackupPanel
          orgName="dev1"
          sets={[set]}
          lastRestore={{
            written: 10,
            unchanged: 0,
            failed: 0,
            slices: { restored: [1, 3], skipped: [2] },
          }}
        />,
      );

      expect(screen.getByTestId('restore-set-result').textContent).toBe(
        'Slices restored: 1, 3. Restored before, not read again: 2.',
      );
    });
  });
});
