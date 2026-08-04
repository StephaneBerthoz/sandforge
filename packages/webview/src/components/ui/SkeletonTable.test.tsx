import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SkeletonTable } from './SkeletonTable';

describe('SkeletonTable', () => {
  it('renders with default rows and columns', () => {
    render(<SkeletonTable />);
    const table = screen.getByTestId('skeleton-table');
    expect(table).toBeDefined();
    expect(screen.getByTestId('skeleton-table-header')).toBeDefined();
    expect(screen.getAllByTestId('skeleton-table-row')).toHaveLength(5);
  });

  it('renders custom number of rows', () => {
    render(<SkeletonTable rows={3} />);
    expect(screen.getAllByTestId('skeleton-table-row')).toHaveLength(3);
  });

  it('renders custom number of columns per row', () => {
    render(<SkeletonTable rows={1} columns={6} />);
    const row = screen.getByTestId('skeleton-table-row');
    const skeletons = row.querySelectorAll('[data-testid="skeleton"]');
    expect(skeletons).toHaveLength(6);
  });

  it('applies className prop', () => {
    render(<SkeletonTable className="my-custom-class" />);
    const table = screen.getByTestId('skeleton-table');
    expect(table.className).toContain('my-custom-class');
  });

  it('has aria-hidden attribute', () => {
    render(<SkeletonTable />);
    const table = screen.getByTestId('skeleton-table');
    expect(table.getAttribute('aria-hidden')).toBe('true');
  });
});
