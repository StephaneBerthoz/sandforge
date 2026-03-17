import { describe, it, expect } from 'vitest';
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

  it('should show action badges', () => {
    render(<AuditTrailViewer entries={entries} />);
    expect(screen.getAllByText('seed_execute').length).toBeGreaterThan(0);
    expect(screen.getAllByText('backup_create').length).toBeGreaterThan(0);
    expect(screen.getAllByText('settings_change').length).toBeGreaterThan(0);
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
});
