import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import type { PermissionMatrixRow } from './PermissionMatrix';
import { PermissionMatrix } from './PermissionMatrix';

const mockRows: PermissionMatrixRow[] = [
  {
    objectName: 'Account',
    source: { create: true, read: true, update: true, delete: false },
    target: { create: true, read: true, update: false, delete: false },
    hasDifference: true,
  },
  {
    objectName: 'Contact',
    source: { create: true, read: true, update: true, delete: true },
    target: { create: true, read: true, update: true, delete: true },
    hasDifference: false,
  },
  {
    objectName: 'Opportunity',
    source: { create: false, read: true, update: false, delete: false },
    target: { create: true, read: true, update: true, delete: false },
    hasDifference: true,
  },
];

describe('PermissionMatrix', () => {
  it('should render the permission matrix card', () => {
    render(<PermissionMatrix rows={mockRows} />);
    expect(screen.getByText('Permission Matrix')).toBeDefined();
  });

  it('should show filtered object count', () => {
    render(<PermissionMatrix rows={mockRows} />);
    expect(screen.getByText('3 objects')).toBeDefined();
  });

  it('should render the table', () => {
    render(<PermissionMatrix rows={mockRows} />);
    expect(screen.getByTestId('perm-matrix')).toBeDefined();
  });

  it('should render rows for each object', () => {
    render(<PermissionMatrix rows={mockRows} />);
    expect(screen.getByTestId('perm-row-Account')).toBeDefined();
    expect(screen.getByTestId('perm-row-Contact')).toBeDefined();
    expect(screen.getByTestId('perm-row-Opportunity')).toBeDefined();
  });

  it('should render permission indicators', () => {
    render(<PermissionMatrix rows={mockRows} />);
    const yesIndicators = screen.getAllByTestId('perm-yes');
    const noIndicators = screen.getAllByTestId('perm-no');
    expect(yesIndicators.length).toBeGreaterThan(0);
    expect(noIndicators.length).toBeGreaterThan(0);
  });

  it('should use custom source/target labels', () => {
    render(<PermissionMatrix rows={mockRows} sourceLabel="Dev" targetLabel="Prod" />);
    expect(screen.getByText('Dev')).toBeDefined();
    expect(screen.getByText('Prod')).toBeDefined();
  });

  it('should show no data when empty', () => {
    render(<PermissionMatrix rows={[]} />);
    expect(screen.getByText('No data available')).toBeDefined();
  });

  it('should accept custom className', () => {
    const { container } = render(<PermissionMatrix rows={mockRows} className="custom" />);
    expect((container.firstChild as HTMLElement).className).toContain('custom');
  });

  it('should render filter input when rows exist', () => {
    render(<PermissionMatrix rows={mockRows} />);
    expect(screen.getByTestId('perm-filter')).toBeDefined();
  });

  it('should filter rows by object name', () => {
    render(<PermissionMatrix rows={mockRows} />);
    const filter = screen.getByTestId('perm-filter');
    fireEvent.change(filter, { target: { value: 'Account' } });
    expect(screen.getByTestId('perm-row-Account')).toBeDefined();
    expect(screen.queryByTestId('perm-row-Contact')).toBeNull();
    expect(screen.queryByTestId('perm-row-Opportunity')).toBeNull();
  });

  it('should filter case-insensitively', () => {
    render(<PermissionMatrix rows={mockRows} />);
    const filter = screen.getByTestId('perm-filter');
    fireEvent.change(filter, { target: { value: 'contact' } });
    expect(screen.getByTestId('perm-row-Contact')).toBeDefined();
    expect(screen.queryByTestId('perm-row-Account')).toBeNull();
  });

  it('should show all rows when filter is cleared', () => {
    render(<PermissionMatrix rows={mockRows} />);
    const filter = screen.getByTestId('perm-filter');
    fireEvent.change(filter, { target: { value: 'Account' } });
    expect(screen.queryByTestId('perm-row-Contact')).toBeNull();
    fireEvent.change(filter, { target: { value: '' } });
    expect(screen.getByTestId('perm-row-Account')).toBeDefined();
    expect(screen.getByTestId('perm-row-Contact')).toBeDefined();
    expect(screen.getByTestId('perm-row-Opportunity')).toBeDefined();
  });

  it('should update object count after filtering', () => {
    render(<PermissionMatrix rows={mockRows} />);
    const filter = screen.getByTestId('perm-filter');
    fireEvent.change(filter, { target: { value: 'Account' } });
    expect(screen.getByText('1 object')).toBeDefined();
  });

  it('should render profile/role column grouping headers', () => {
    render(<PermissionMatrix rows={mockRows} sourceLabel="Dev" targetLabel="Prod" />);
    expect(screen.getByTestId('perm-group-source')).toBeDefined();
    expect(screen.getByTestId('perm-group-target')).toBeDefined();
  });

  it('should not show filter when rows are empty', () => {
    render(<PermissionMatrix rows={[]} />);
    expect(screen.queryByTestId('perm-filter')).toBeNull();
  });
});
