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
});
