import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PageHeader } from './PageHeader';

describe('PageHeader', () => {
  it('should render with data-testid', () => {
    render(<PageHeader title="Dashboard" />);
    expect(screen.getByTestId('page-header')).toBeDefined();
  });

  it('should render the title', () => {
    render(<PageHeader title="Monitor" />);
    expect(screen.getByText('Monitor')).toBeDefined();
  });

  it('should render the title as an h1 element', () => {
    render(<PageHeader title="Monitor" />);
    expect(screen.getByRole('heading', { level: 1 })).toBeDefined();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Monitor');
  });

  it('should render subtitle when provided', () => {
    render(<PageHeader title="Monitor" subtitle="Real-time org health" />);
    expect(screen.getByTestId('page-header-subtitle')).toBeDefined();
    expect(screen.getByText('Real-time org health')).toBeDefined();
  });

  it('should not render subtitle when not provided', () => {
    render(<PageHeader title="Monitor" />);
    expect(screen.queryByTestId('page-header-subtitle')).toBeNull();
  });

  it('should render icon when provided', () => {
    render(<PageHeader title="Dashboard" icon="dashboard" />);
    expect(screen.getByTestId('icon-dashboard')).toBeDefined();
  });

  it('should not render icon when not provided', () => {
    render(<PageHeader title="Dashboard" />);
    expect(screen.queryByTestId('icon-dashboard')).toBeNull();
  });

  it('should render actions when provided', () => {
    render(
      <PageHeader title="Settings" actions={<button data-testid="action-btn">Save</button>} />,
    );
    expect(screen.getByTestId('page-header-actions')).toBeDefined();
    expect(screen.getByTestId('action-btn')).toBeDefined();
    expect(screen.getByText('Save')).toBeDefined();
  });

  it('should not render actions container when not provided', () => {
    render(<PageHeader title="Settings" />);
    expect(screen.queryByTestId('page-header-actions')).toBeNull();
  });

  it('should render breadcrumb segments', () => {
    render(<PageHeader title="Page Title" breadcrumb={['Home', 'Monitor', 'Details']} />);
    expect(screen.getByTestId('page-header-breadcrumb')).toBeDefined();
    expect(screen.getByText('Home')).toBeDefined();
    expect(screen.getByText('Monitor')).toBeDefined();
    expect(screen.getByText('Details')).toBeDefined();
  });

  it('should render breadcrumb separators between segments', () => {
    const { container } = render(
      <PageHeader title="Details" breadcrumb={['Home', 'Monitor', 'Details']} />,
    );
    const separators = container.querySelectorAll('[aria-hidden="true"]');
    // 3 segments = 2 separators
    expect(separators.length).toBe(2);
  });

  it('should not render breadcrumb when not provided', () => {
    render(<PageHeader title="Details" />);
    expect(screen.queryByTestId('page-header-breadcrumb')).toBeNull();
  });

  it('should not render breadcrumb when array is empty', () => {
    render(<PageHeader title="Details" breadcrumb={[]} />);
    expect(screen.queryByTestId('page-header-breadcrumb')).toBeNull();
  });

  it('should render breadcrumb with nav element for accessibility', () => {
    render(<PageHeader title="Details" breadcrumb={['Home', 'Details']} />);
    const nav = screen.getByLabelText('Breadcrumb');
    expect(nav.tagName).toBe('NAV');
  });

  it('should apply custom className', () => {
    render(<PageHeader title="Test" className="mt-4" />);
    expect(screen.getByTestId('page-header').className).toContain('mt-4');
  });

  it('should render all elements together', () => {
    render(
      <PageHeader
        title="Full Header"
        subtitle="A complete header"
        icon="gear"
        breadcrumb={['Root', 'Section']}
        actions={<button>Action</button>}
      />,
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Full Header');
    expect(screen.getByText('A complete header')).toBeDefined();
    expect(screen.getByTestId('icon-gear')).toBeDefined();
    expect(screen.getByTestId('page-header-breadcrumb')).toBeDefined();
    expect(screen.getByText('Root')).toBeDefined();
    expect(screen.getByText('Section')).toBeDefined();
    expect(screen.getByText('Action')).toBeDefined();
  });
});
