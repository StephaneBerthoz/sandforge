import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { AuditTrailViewer } from './AuditTrailViewer';
import type { AuditLogEntry } from '@sandforge/shared';

const entries: AuditLogEntry[] = [
  {
    id: 'aud-1',
    action: 'seed_execute',
    module: 'seed',
    orgId: 'org-1',
    details: { records: 500 },
    timestamp: '2026-02-20T10:00:00Z',
  },
  {
    id: 'aud-2',
    action: 'backup_create',
    module: 'dataops',
    orgId: 'org-1',
    details: { size: '4.9 KB' },
    timestamp: '2026-02-20T11:00:00Z',
  },
  {
    id: 'aud-3',
    action: 'settings_change',
    module: 'settings',
    details: { key: 'language', value: 'fr' },
    timestamp: '2026-02-20T12:00:00Z',
  },
];

/** A run as a write path records it: its org, its source, its outcome, its counts. */
const forgeRun: AuditLogEntry = {
  id: 'aud-forge',
  action: 'forge_execute',
  module: 'forge',
  orgId: '00D000000000001AAA',
  orgAlias: 'target-sandbox',
  sourceOrgId: '00D000000000002AAA',
  sourceOrgAlias: 'source-uat',
  operationId: 'op-1',
  outcome: 'partial',
  guard: 'confirmed',
  objects: [
    { objectApiName: 'Account', created: 3, updated: 0, deleted: 0, failed: 1 },
    { objectApiName: 'Contact', created: 0, updated: 0, deleted: 0, failed: 0, upserted: 5 },
    { objectApiName: 'Case', created: 0, updated: 0, deleted: 0, failed: 0 },
  ],
  details: {},
  timestamp: '2026-09-02T08:00:00.000Z',
};

describe('AuditTrailViewer', () => {
  it('should render the viewer', () => {
    render(<AuditTrailViewer />);
    expect(screen.getByTestId('audit-trail-viewer')).toBeDefined();
  });

  it('should show empty state when no entries', () => {
    render(<AuditTrailViewer />);
    expect(screen.getByText('No audit entries')).toBeDefined();
  });

  it('should show audit entries', () => {
    render(<AuditTrailViewer entries={entries} />);
    expect(screen.getByTestId('audit-aud-1')).toBeDefined();
    expect(screen.getByTestId('audit-aud-2')).toBeDefined();
    expect(screen.getByTestId('audit-aud-3')).toBeDefined();
  });

  it('names each action in the reader’s language, not by its code', () => {
    render(<AuditTrailViewer entries={[...entries, forgeRun]} />);
    const badges = screen.getAllByText(/Seed Execute|Backup Create|Settings Change|Forge Clone/);
    expect(badges.length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText('seed_execute')).toBeNull();
    expect(screen.queryByText('forge_execute')).toBeNull();
  });

  it('should show module names', () => {
    render(<AuditTrailViewer entries={entries} />);
    expect(screen.getAllByText('seed').length).toBeGreaterThan(0);
    expect(screen.getAllByText('dataops').length).toBeGreaterThan(0);
  });

  it('should show timestamps', () => {
    render(<AuditTrailViewer entries={entries} />);
    expect(screen.getByText('2026-02-20 10:00:00')).toBeDefined();
  });

  it('should show entry details', () => {
    render(<AuditTrailViewer entries={entries} />);
    expect(screen.getByText(/records: 500/)).toBeDefined();
  });

  it('says which org a run wrote, where from, how it ended and what the guard decided', () => {
    render(<AuditTrailViewer entries={[forgeRun]} />);
    const row = screen.getByTestId('audit-aud-forge');

    expect(row.textContent).toContain('into target-sandbox');
    expect(row.textContent).toContain('from source-uat');
    expect(row.textContent).toContain('Partial');
    expect(row.textContent).toContain('Guard: confirmed');
  });

  it('lists what the run did per object, naming only the columns it filled', () => {
    render(<AuditTrailViewer entries={[forgeRun]} />);
    const row = screen.getByTestId('audit-aud-forge');

    expect(row.textContent).toContain('Account 3 created · 1 failed');
    // An upsert is counted apart: Salesforce does not say which way it went.
    expect(row.textContent).toContain('Contact 5 upserted');
    // An object the run wrote nothing to is not listed.
    expect(row.textContent).not.toContain('Case');
  });

  it('counts apart the rows a cancel kept from the target', () => {
    // Neither written nor failed: the entry of a load cancelled while an
    // object was written said what it wrote and what failed, and nothing of
    // the rows it never sent.
    const cancelledLoad: AuditLogEntry = {
      id: 'aud-frozen',
      action: 'frozen_load',
      module: 'frozen',
      orgId: '00D000000000001AAA',
      outcome: 'partial',
      objects: [
        {
          objectApiName: 'Account',
          created: 200,
          updated: 0,
          deleted: 0,
          failed: 1,
          notSent: 299,
        },
      ],
      details: {},
      timestamp: '2026-09-25T08:00:00.000Z',
    };
    render(<AuditTrailViewer entries={[cancelledLoad]} />);

    expect(screen.getByTestId('audit-aud-frozen').textContent).toContain(
      'Account 200 created · 1 failed · 299 not sent',
    );
  });

  it('counts apart, after what was written, the records written without a field the target refused', () => {
    const clone: AuditLogEntry = {
      ...forgeRun,
      id: 'aud-forge-without',
      objects: [
        {
          objectApiName: 'Contact',
          created: 3,
          updated: 0,
          deleted: 0,
          failed: 1,
          writtenWithoutFields: 2,
        },
      ],
    };
    render(<AuditTrailViewer entries={[clone]} />);

    // One count for both: the entry keeps how many records, the run's
    // results which refused each field.
    expect(screen.getByTestId('audit-aud-forge-without').querySelector('li')?.textContent).toBe(
      'Contact 3 created · 2 written without a field the target refused · 1 failed',
    );
  });

  it('counts after the failed, apart, the records a call may have written before its answer was lost', () => {
    const clone: AuditLogEntry = {
      ...forgeRun,
      id: 'aud-forge-unanswered',
      objects: [
        {
          objectApiName: 'Contact',
          created: 3,
          updated: 0,
          deleted: 0,
          failed: 2,
          mayHaveBeenWritten: 2,
        },
      ],
    };
    render(<AuditTrailViewer entries={[clone]} />);

    expect(screen.getByTestId('audit-aud-forge-unanswered').querySelector('li')?.textContent).toBe(
      'Contact 3 created · 2 failed · 2 may be in the target, their call unanswered',
    );
  });

  it('names an object of a clone a cancel stopped before it wrote, with the rows it never sent', () => {
    // Nothing created, nothing failed: what the cancel kept from the target
    // is all there is to say of the object, and the entry says why it stopped.
    const cancelledClone: AuditLogEntry = {
      ...forgeRun,
      id: 'aud-forge-cancelled',
      outcome: 'stopped',
      guard: 'allowed',
      objects: [
        { objectApiName: 'Account', created: 0, updated: 0, deleted: 0, failed: 0, notSent: 2 },
      ],
      details: { code: 'RUN_CANCELLED' },
    };
    render(<AuditTrailViewer entries={[cancelledClone]} />);
    const row = screen.getByTestId('audit-aud-forge-cancelled');

    expect(row.textContent).toContain('Stopped');
    expect(row.querySelectorAll('li')).toHaveLength(1);
    expect(row.querySelector('li')?.textContent).toBe('Account 2 not sent');
    expect(row.textContent).toContain('code: RUN_CANCELLED');
  });

  it('names an object the run skipped whole, told apart from one it did nothing to', () => {
    // Nothing in any column, an object a clone skipped before it could count
    // its records was not listed: the entry of a run that lost it read as
    // that of a run that never met it.
    const skippedRun: AuditLogEntry = {
      ...forgeRun,
      id: 'aud-forge-skipped',
      outcome: 'failure',
      objects: [
        { objectApiName: 'Account', created: 0, updated: 0, deleted: 0, failed: 7 },
        {
          objectApiName: 'Contract',
          created: 0,
          updated: 0,
          deleted: 0,
          failed: 0,
          skipped: 'uncounted',
        },
        {
          objectApiName: 'Task__c',
          created: 0,
          updated: 0,
          deleted: 0,
          failed: 2,
          skipped: 'counted',
        },
        { objectApiName: 'Case', created: 0, updated: 0, deleted: 0, failed: 0 },
      ],
    };
    render(<AuditTrailViewer entries={[skippedRun]} />);
    const row = screen.getByTestId('audit-aud-forge-skipped');

    expect([...row.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'Account 7 failed',
      'Contract skipped, record count unknown',
      'Task__c skipped · 2 failed',
    ]);
  });

  it('says a removal took up what an earlier one left, and when that one ended', () => {
    // Counted alone, the few records a second removal took read as the
    // removal of the whole run.
    const removal: AuditLogEntry = {
      id: 'aud-removal',
      action: 'cleanup_delete',
      module: 'frozen',
      orgId: '00D000000000001AAA',
      orgAlias: 'target-sandbox',
      outcome: 'success',
      guard: 'allowed',
      objects: [{ objectApiName: 'Order', created: 0, updated: 0, deleted: 2, failed: 0 }],
      leftBy: '2026-09-29T15:51:27.295Z',
      details: {},
      timestamp: '2026-09-29T16:10:00.000Z',
    };
    render(
      <AuditTrailViewer entries={[removal, { ...removal, id: 'aud-first', leftBy: undefined }]} />,
    );

    expect(screen.getByTestId('audit-left-by-aud-removal').textContent).toBe(
      'picked up where the removal of 2026-09-29 15:51:27 left off',
    );
    expect(screen.queryByTestId('audit-left-by-aud-first')).toBeNull();
  });

  it('should show filters', () => {
    render(<AuditTrailViewer entries={entries} />);
    expect(screen.getByTestId('audit-filters')).toBeDefined();
  });

  it('should filter by action', () => {
    render(<AuditTrailViewer entries={entries} />);
    const actionSelect = screen.getByTestId('audit-filters').querySelectorAll('select')[0];
    fireEvent.change(actionSelect, { target: { value: 'seed_execute' } });
    expect(screen.getByTestId('audit-aud-1')).toBeDefined();
    expect(screen.queryByTestId('audit-aud-2')).toBeNull();
  });

  it('should filter by module', () => {
    render(<AuditTrailViewer entries={entries} />);
    const moduleSelect = screen.getByTestId('audit-filters').querySelectorAll('select')[1];
    fireEvent.change(moduleSelect, { target: { value: 'dataops' } });
    expect(screen.getByTestId('audit-aud-2')).toBeDefined();
    expect(screen.queryByTestId('audit-aud-1')).toBeNull();
  });

  it('hands module and org to the host when it filters the trail itself', () => {
    // The host filters the whole trail, not the page on screen: its filter
    // reaches entries the page never held.
    const onFilterChange = vi.fn();
    render(
      <AuditTrailViewer
        entries={[forgeRun]}
        facets={{
          modules: ['forge', 'sync'],
          orgs: [
            { orgId: '00D000000000001AAA', orgAlias: 'target-sandbox' },
            { orgId: '00D000000000003AAA' },
          ],
        }}
        filter={{ module: 'forge' }}
        onFilterChange={onFilterChange}
      />,
    );

    fireEvent.change(screen.getByTestId('org-filter'), {
      target: { value: '00D000000000003AAA' },
    });

    expect(onFilterChange).toHaveBeenCalledWith({
      module: 'forge',
      orgId: '00D000000000003AAA',
    });
    // Offered from the whole trail, including a module this page does not hold.
    expect(screen.getByRole('option', { name: 'sync' })).toBeDefined();
    // An org recorded without an alias is offered under its id.
    expect(screen.getByRole('option', { name: '00D000000000003AAA' })).toBeDefined();
  });

  it('offers the next entries when the host holds more than the page', () => {
    const onShowMore = vi.fn();
    render(<AuditTrailViewer entries={[forgeRun]} total={240} onShowMore={onShowMore} />);

    expect(screen.getByText('Showing 1 of 240')).toBeDefined();
    fireEvent.click(screen.getByTestId('audit-show-more'));
    expect(onShowMore).toHaveBeenCalledTimes(1);
  });

  it('offers nothing more once every entry is on screen', () => {
    render(<AuditTrailViewer entries={[forgeRun]} total={1} onShowMore={vi.fn()} />);

    expect(screen.queryByTestId('audit-show-more')).toBeNull();
  });

  it('says how a run was set up and let through, and the user it wrote as, in words', () => {
    const setUp: AuditLogEntry = {
      ...forgeRun,
      userId: 'sha256:0123456789ab',
      context: {
        anonymized: true,
        contactPoints: 'neutralized',
        reviewSkipped: true,
        simulatedMinutesBefore: 6,
        rehearsedMinutesBefore: 2,
        firedOnInsert: { flow: 2, trigger: 1, process: 0, workflowRule: 0, unread: ['processes'] },
        firedOnUpdate: { flow: 1, trigger: 0, process: 0, workflowRule: 0 },
        confirmed: ['automation', 'volume'],
        decisions: [
          { kind: 'map_value', count: 2, rows: 9 },
          { kind: 'ignore', count: 1 },
        ],
      },
    };

    render(<AuditTrailViewer entries={[setUp]} />);

    expect(screen.getByTestId('audit-context-aud-forge').textContent).toBe(
      [
        'Anonymized',
        'Emails and phones neutralized',
        'Review skipped',
        'Simulated 6 min before',
        'Rehearsed 2 min before',
        'Fires on insert: 2 flows, 1 Apex trigger',
        'automation partly unread',
        'Fires on update: 1 flow',
        'Confirmed: what fires on insert and update, the records to write',
        'Decisions: values mapped: 2 (9 rows), gaps ignored: 1',
        'User sha256:0123456789ab',
      ].join(' · '),
    );
  });

  it('says nothing fires on insert when nothing did, and what the config kept for a run that never got there', () => {
    const quiet: AuditLogEntry = {
      ...forgeRun,
      context: {
        anonymized: false,
        contactPoints: 'kept',
        reviewSkipped: false,
        firedOnInsert: { flow: 0, trigger: 0, process: 0, workflowRule: 0, unread: [] },
      },
    };
    const refused: AuditLogEntry = {
      ...forgeRun,
      id: 'aud-refused',
      context: { anonymized: false, contactPoints: 'neutralized', reviewSkipped: false },
    };

    render(<AuditTrailViewer entries={[quiet, refused]} />);

    expect(screen.getByTestId('audit-context-aud-forge').textContent).toBe(
      'Not anonymized · Emails and phones kept as read · Nothing fires on insert',
    );
    expect(screen.getByTestId('audit-context-aud-refused').textContent).toBe(
      'Not anonymized · Emails and phones neutralized',
    );
  });

  it('shows no set-up line for an entry that says nothing of it', () => {
    render(<AuditTrailViewer entries={[forgeRun]} />);

    expect(screen.queryByTestId('audit-context-aud-forge')).toBeNull();
  });

  it('exports the trail as filtered, with the action picked on the tab', () => {
    const onExport = vi.fn();
    render(<AuditTrailViewer entries={entries} onExport={onExport} />);

    fireEvent.click(screen.getByTestId('audit-export-csv'));
    fireEvent.change(screen.getByTestId('action-filter'), { target: { value: 'seed_execute' } });
    fireEvent.click(screen.getByTestId('audit-export-json'));

    expect(onExport.mock.calls).toEqual([
      ['csv', undefined],
      ['json', 'seed_execute'],
    ]);
  });

  it('holds its export buttons while an export is made, and offers none without a host', () => {
    const { rerender } = render(
      <AuditTrailViewer entries={entries} onExport={vi.fn()} exporting />,
    );

    expect((screen.getByTestId('audit-export-csv') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('audit-export-json') as HTMLButtonElement).disabled).toBe(true);

    rerender(<AuditTrailViewer entries={entries} />);
    expect(screen.queryByTestId('audit-export-csv')).toBeNull();
  });
});
