import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AuditTrailPanel } from './AuditTrailPanel';
import type { AuditEntryDisplay } from './AuditTrailPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, defaultValue: string) => defaultValue,
  }),
}));

function makeEntry(overrides: Partial<AuditEntryDisplay> = {}): AuditEntryDisplay {
  return {
    id: 'audit-1',
    operationType: 'sync',
    description: 'Synced Account records',
    orgId: 'org-1',
    user: 'admin',
    timestamp: '2026-03-13T10:00:00.000Z',
    durationMs: 1500,
    status: 'success',
    recordCount: 100,
    ...overrides,
  };
}

describe('AuditTrailPanel', () => {
  it('renders the panel', () => {
    render(<AuditTrailPanel />);
    expect(screen.getByTestId('audit-trail-panel')).toBeTruthy();
  });

  it('shows empty state when no entries', () => {
    render(<AuditTrailPanel entries={[]} />);
    expect(screen.getByTestId('audit-empty')).toBeTruthy();
  });

  it('shows loading state', () => {
    render(<AuditTrailPanel loading={true} />);
    expect(screen.getByTestId('audit-loading')).toBeTruthy();
  });

  it('renders entries', () => {
    const entries = [
      makeEntry({ id: 'a-1' }),
      makeEntry({ id: 'a-2', operationType: 'backup', description: 'Backed up Contact' }),
    ];
    render(<AuditTrailPanel entries={entries} />);
    expect(screen.getByTestId('audit-entries')).toBeTruthy();
    expect(screen.getByTestId('audit-entry-a-1')).toBeTruthy();
    expect(screen.getByTestId('audit-entry-a-2')).toBeTruthy();
  });

  it('shows total count badge', () => {
    render(<AuditTrailPanel entries={[makeEntry()]} total={42} />);
    expect(screen.getByText('42 entries')).toBeTruthy();
  });

  it('expands entry detail on click', () => {
    render(<AuditTrailPanel entries={[makeEntry()]} />);
    fireEvent.click(screen.getByTestId('audit-entry-audit-1').querySelector('div')!);
    expect(screen.getByTestId('audit-detail-audit-1')).toBeTruthy();
  });

  it('collapses entry detail on second click', () => {
    render(<AuditTrailPanel entries={[makeEntry()]} />);
    const row = screen.getByTestId('audit-entry-audit-1').querySelector('div')!;
    fireEvent.click(row);
    expect(screen.getByTestId('audit-detail-audit-1')).toBeTruthy();
    fireEvent.click(row);
    expect(screen.queryByTestId('audit-detail-audit-1')).toBeNull();
  });

  it('filters by search text', () => {
    const entries = [
      makeEntry({ id: 'a-1', description: 'Synced Account' }),
      makeEntry({ id: 'a-2', description: 'Backed up Contact' }),
    ];
    render(<AuditTrailPanel entries={entries} />);
    const input = screen.getByTestId('audit-search');
    fireEvent.change(input, { target: { value: 'Account' } });
    expect(screen.getByTestId('audit-entry-a-1')).toBeTruthy();
    expect(screen.queryByTestId('audit-entry-a-2')).toBeNull();
  });

  it('calls onExport with csv format', () => {
    const onExport = vi.fn();
    render(<AuditTrailPanel entries={[makeEntry()]} onExport={onExport} />);
    fireEvent.click(screen.getByTestId('export-csv-btn'));
    expect(onExport).toHaveBeenCalledWith('csv');
  });

  it('calls onExport with json format', () => {
    const onExport = vi.fn();
    render(<AuditTrailPanel entries={[makeEntry()]} onExport={onExport} />);
    fireEvent.click(screen.getByTestId('export-json-btn'));
    expect(onExport).toHaveBeenCalledWith('json');
  });

  it('calls onFilter when apply button is clicked', () => {
    const onFilter = vi.fn();
    render(<AuditTrailPanel entries={[makeEntry()]} onFilter={onFilter} />);
    fireEvent.click(screen.getByTestId('apply-filter-btn'));
    expect(onFilter).toHaveBeenCalled();
  });

  it('shows error in detail panel for failed entries', () => {
    const entry = makeEntry({ status: 'failure', error: 'Connection timeout' });
    render(<AuditTrailPanel entries={[entry]} />);
    fireEvent.click(screen.getByTestId('audit-entry-audit-1').querySelector('div')!);
    expect(screen.getByText('Connection timeout')).toBeTruthy();
  });
});
