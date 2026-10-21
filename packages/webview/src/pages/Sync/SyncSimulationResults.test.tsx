import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '../../i18n';
import type { SyncSimulationResult } from '@sandforge/shared';
import { SyncSimulationResults } from './SyncSimulationResults';

function simulation(overrides: Partial<SyncSimulationResult> = {}): SyncSimulationResult {
  return {
    configId: 'cfg',
    operationId: 'wv-sim',
    direction: 'source_to_target',
    conflictStrategy: 'source_wins',
    objects: [
      {
        objectApiName: 'Account',
        operation: 'upsert',
        read: 12,
        insert: 4,
        update: 7,
        delete: 0,
        skipped: 0,
        refused: 1,
        conflicts: 0,
        conflictFields: [],
        notes: ['1 record(s) carry no value in Ext_Id__c: an upsert matches on it.'],
      },
      {
        objectApiName: 'Contact',
        operation: 'insert',
        read: 3,
        insert: 3,
        update: 0,
        delete: 0,
        skipped: 0,
        refused: 0,
        conflicts: 0,
        conflictFields: [],
        notes: [],
      },
    ],
    duration: 10,
    timestamp: '2026-10-06T00:00:00.000Z',
    ...overrides,
  };
}

describe('SyncSimulationResults', () => {
  it('says what a run would meet before its first write, and what an earlier run copied', () => {
    const base = simulation();
    render(
      <SyncSimulationResults
        simulation={{
          ...base,
          objects: [{ ...base.objects[1], read: 5, skipped: 2, alreadyCopied: 2 }],
          writeOrder: { objects: ['Contact'], moved: [], cycles: [] },
          writeCheck: {
            objects: [{ objectApiName: 'Contact', rows: 3 }],
            total: 3,
            alreadyCopied: 2,
            storage: { verdict: 'exceeds', estimateMB: 0.01, maxMB: 5, remainingMB: 0 },
            emails: [],
            verdict: 'refused',
          },
        }}
        onRun={vi.fn()}
      />,
    );

    expect(screen.getByTestId('sync-write-check-verdict').textContent).toBe(
      'The run is refused before it writes anything.',
    );
    expect(screen.getByTestId('sync-simulation-copied-Contact').textContent).toBe(
      '2 already copied by an earlier run of this configuration, left as they are.',
    );
  });

  it("lists beside an object the target's validation rules, which a simulation cannot evaluate", () => {
    const base = simulation();
    render(
      <SyncSimulationResults
        simulation={{
          ...base,
          objects: [
            {
              ...base.objects[0],
              validationRules: [
                { name: 'Type_By_Profile', message: 'One account type for this profile' },
                { name: 'Siret_Format', message: 'SIRET: 14 digits', field: 'Siret__c' },
              ],
            },
            base.objects[1],
          ],
        }}
        onRun={vi.fn()}
      />,
    );

    const rules = screen.getByTestId('sync-simulation-rules-Account');
    expect(rules.textContent).toContain('2 active validation rules of the target');
    expect(rules.textContent).toContain('Type_By_Profile — One account type for this profile');
    expect(rules.textContent).toContain('Siret_Format (Siret__c) — SIRET: 14 digits');
    expect(screen.queryByTestId('sync-simulation-rules-Contact')).toBeNull();
  });

  it("says when the target's validation rules could not be listed", () => {
    render(
      <SyncSimulationResults
        simulation={simulation({ validationRulesUnread: 'INSUFFICIENT_ACCESS' })}
        onRun={vi.fn()}
      />,
    );

    expect(screen.getByTestId('sync-simulation-rules-unread').textContent).toContain(
      'could not be listed (INSUFFICIENT_ACCESS)',
    );
  });

  it('adds up what the run would do and says that nothing was written', () => {
    render(<SyncSimulationResults simulation={simulation()} onRun={vi.fn()} />);

    const summary = screen.getByTestId('sync-simulation-summary');
    expect(summary.textContent).toContain('Simulation — nothing written');
    expect(summary.textContent).toContain('Would insert: 7');
    expect(summary.textContent).toContain('Would update: 7');
    expect(summary.textContent).toContain('Would be refused: 1');
    // A one-way run does not compare, so it has no conflicts to count.
    expect(summary.textContent).not.toContain('In conflict');
    expect(screen.getByText(/Nothing was written/)).toBeDefined();
    // What it really leaves unchecked: since it predicts a required field
    // left empty, it no longer says it does not check required fields.
    const notChecked = screen.getByText(/does not run its validation rules/).textContent ?? '';
    expect(notChecked).toContain('predicts what the target');
    expect(notChecked).toContain('a required field left empty');
    expect(notChecked).toContain('triggers or flows');
    expect(notChecked).toContain('sharing');
    expect(notChecked).not.toMatch(/does not run[^:]*required fields/);
  });

  it('gives each object its own line, with the reasons the counts leave unsaid', () => {
    render(<SyncSimulationResults simulation={simulation()} onRun={vi.fn()} />);

    const account = screen.getByTestId('sync-simulation-object-Account');
    expect(account.textContent).toContain('Upsert — 12 records read');
    expect(account.textContent).toContain('Would update: 7');
    expect(within(account).getByText(/carry no value in Ext_Id__c/)).toBeDefined();
    const contact = screen.getByTestId('sync-simulation-object-Contact');
    expect(contact.textContent).toContain('Would insert: 3');
    expect(contact.textContent).not.toContain('Would update');
  });

  it('names the conflicts of a bidirectional run and the strategy that settles them', () => {
    const bidirectional = simulation({
      direction: 'bidirectional',
      conflictStrategy: 'target_wins',
      objects: [
        {
          objectApiName: 'Account',
          operation: 'upsert',
          read: 5,
          insert: 0,
          update: 5,
          delete: 0,
          skipped: 0,
          refused: 0,
          conflicts: 2,
          conflictFields: ['Phone', 'Name'],
          notes: [],
        },
      ],
    });

    render(<SyncSimulationResults simulation={bidirectional} onRun={vi.fn()} />);

    expect(screen.getByTestId('sync-simulation-summary').textContent).toContain('In conflict: 2');
    const account = screen.getByTestId('sync-simulation-object-Account');
    expect(account.textContent).toContain(
      '2 records differ from the target on a field the run writes: Target Wins decides which value is written.',
    );
    expect(account.textContent).toContain('Fields that differ: Phone, Name.');
  });

  it('says where a simulation stopped, and that a run would stop there too', () => {
    render(
      <SyncSimulationResults
        simulation={simulation({ objects: [], error: 'INVALID_TYPE', failedObject: 'Case' })}
        onRun={vi.fn()}
      />,
    );

    const error = screen.getByTestId('sync-simulation-error');
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent).toBe(
      'The simulation stopped at Case: INVALID_TYPE. A run would stop there too.',
    );
  });

  it('calls a simulation a cancel stopped cancelled', () => {
    render(<SyncSimulationResults simulation={simulation({ cancelled: true })} onRun={vi.fn()} />);

    expect(screen.getByTestId('sync-simulation-summary').textContent).toContain(
      'Simulation cancelled',
    );
  });

  it('runs the sync for real from the findings', () => {
    const onRun = vi.fn();
    render(<SyncSimulationResults simulation={simulation()} onRun={onRun} />);

    fireEvent.click(screen.getByTestId('sync-run-after-simulation'));

    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it('says how a delta run would read each object, and counts the deletions it would carry', () => {
    const [account] = simulation().objects;
    render(
      <SyncSimulationResults
        simulation={simulation({
          objects: [
            {
              ...account,
              delete: 2,
              delta: {
                read: 'delta',
                since: '2026-10-13T09:00:00.000Z',
                changed: 12,
                deletionsChecked: true,
                deleted: 2,
                deleteFailed: 0,
              },
            },
          ],
        })}
        onRun={vi.fn()}
      />,
    );

    expect(screen.getByTestId('sync-simulation-delta-Account').textContent).toMatch(
      /^Delta since 2026-10-13 .* · 12 changed · 2 would be deleted$/,
    );
    expect(screen.getByTestId('sync-simulation-summary').textContent).toContain('Would delete: 2');
    const card = screen.getByTestId('sync-simulation-object-Account');
    expect(within(card).getByText('Would delete:')).toBeDefined();
  });
});
