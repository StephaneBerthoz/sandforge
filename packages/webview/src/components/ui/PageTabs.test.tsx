import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PageTabs } from './PageTabs';
import type { PageTab } from './PageTabs';

const tabs: PageTab[] = [
  { id: 'overview', label: 'Overview', icon: 'dashboard' },
  { id: 'details', label: 'Details' },
  { id: 'alerts', label: 'Alerts', badge: 5 },
];

describe('PageTabs', () => {
  it('should render with data-testid on root', () => {
    render(<PageTabs tabs={tabs} activeTab="overview" onTabChange={vi.fn()} />);
    expect(screen.getByTestId('page-tabs')).toBeDefined();
  });

  it('should render all tabs with role="tab"', () => {
    render(<PageTabs tabs={tabs} activeTab="overview" onTabChange={vi.fn()} />);
    expect(screen.getAllByRole('tab')).toHaveLength(3);
  });

  it('should render tab labels', () => {
    render(<PageTabs tabs={tabs} activeTab="overview" onTabChange={vi.fn()} />);
    expect(screen.getByText('Overview')).toBeDefined();
    expect(screen.getByText('Details')).toBeDefined();
    expect(screen.getByText('Alerts')).toBeDefined();
  });

  it('should mark active tab with aria-selected=true', () => {
    render(<PageTabs tabs={tabs} activeTab="details" onTabChange={vi.fn()} />);
    const detailsTab = screen.getByTestId('page-tab-details');
    expect(detailsTab.getAttribute('aria-selected')).toBe('true');
  });

  it('should mark inactive tabs with aria-selected=false', () => {
    render(<PageTabs tabs={tabs} activeTab="details" onTabChange={vi.fn()} />);
    const overviewTab = screen.getByTestId('page-tab-overview');
    expect(overviewTab.getAttribute('aria-selected')).toBe('false');
  });

  it('should apply accent border on active tab', () => {
    render(<PageTabs tabs={tabs} activeTab="overview" onTabChange={vi.fn()} />);
    const activeTab = screen.getByTestId('page-tab-overview');
    expect(activeTab.className).toContain('border-(--sf-accent)');
  });

  it('should apply transparent border on inactive tab', () => {
    render(<PageTabs tabs={tabs} activeTab="overview" onTabChange={vi.fn()} />);
    const inactiveTab = screen.getByTestId('page-tab-details');
    expect(inactiveTab.className).toContain('border-transparent');
  });

  it('should call onTabChange when a tab is clicked', () => {
    const handler = vi.fn();
    render(<PageTabs tabs={tabs} activeTab="overview" onTabChange={handler} />);
    fireEvent.click(screen.getByTestId('page-tab-details'));
    expect(handler).toHaveBeenCalledWith('details');
  });

  it('should call onTabChange with correct tab id', () => {
    const handler = vi.fn();
    render(<PageTabs tabs={tabs} activeTab="overview" onTabChange={handler} />);
    fireEvent.click(screen.getByTestId('page-tab-alerts'));
    expect(handler).toHaveBeenCalledWith('alerts');
  });

  /* --- icon rendering --- */
  it('should render icon when tab has icon prop', () => {
    render(<PageTabs tabs={tabs} activeTab="overview" onTabChange={vi.fn()} />);
    expect(screen.getByTestId('icon-dashboard')).toBeDefined();
  });

  it('should not render icon when tab has no icon prop', () => {
    render(<PageTabs tabs={tabs} activeTab="overview" onTabChange={vi.fn()} />);
    const detailsTab = screen.getByTestId('page-tab-details');
    const icons = detailsTab.querySelectorAll('.codicon');
    expect(icons).toHaveLength(0);
  });

  /* --- badge rendering --- */
  it('should render badge count when badge prop is provided', () => {
    render(<PageTabs tabs={tabs} activeTab="overview" onTabChange={vi.fn()} />);
    const badge = screen.getByTestId('page-tab-badge-alerts');
    expect(badge.textContent).toBe('5');
  });

  it('should not render badge when badge is 0', () => {
    const tabsWithZero: PageTab[] = [{ id: 'test', label: 'Test', badge: 0 }];
    render(<PageTabs tabs={tabsWithZero} activeTab="test" onTabChange={vi.fn()} />);
    expect(screen.queryByTestId('page-tab-badge-test')).toBeNull();
  });

  it('should not render badge when badge is undefined', () => {
    render(<PageTabs tabs={tabs} activeTab="overview" onTabChange={vi.fn()} />);
    expect(screen.queryByTestId('page-tab-badge-overview')).toBeNull();
  });

  /* --- tablist role --- */
  it('should have role="tablist" on the container', () => {
    render(<PageTabs tabs={tabs} activeTab="overview" onTabChange={vi.fn()} />);
    expect(screen.getByRole('tablist')).toBeDefined();
  });

  /* --- className merging --- */
  it('should merge custom className on root element', () => {
    render(<PageTabs tabs={tabs} activeTab="overview" onTabChange={vi.fn()} className="mt-6" />);
    expect(screen.getByTestId('page-tabs').className).toContain('mt-6');
  });

  /* --- full-width --- */
  it('should have w-full for full-width layout', () => {
    render(<PageTabs tabs={tabs} activeTab="overview" onTabChange={vi.fn()} />);
    expect(screen.getByTestId('page-tabs').className).toContain('w-full');
  });
});

describe('PageTabs — keyboard', () => {
  const keyTabs = [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
    { id: 'c', label: 'C' },
  ];

  it('moves on ArrowRight and wraps at the end', () => {
    const onTabChange = vi.fn();
    const { rerender } = render(
      <PageTabs tabs={keyTabs} activeTab="a" onTabChange={onTabChange} />,
    );
    fireEvent.keyDown(screen.getAllByRole('tab')[0], { key: 'ArrowRight' });
    expect(onTabChange).toHaveBeenLastCalledWith('b');

    rerender(<PageTabs tabs={keyTabs} activeTab="c" onTabChange={onTabChange} />);
    fireEvent.keyDown(screen.getAllByRole('tab')[0], { key: 'ArrowRight' });
    expect(onTabChange).toHaveBeenLastCalledWith('a');
  });

  it('moves on ArrowLeft', () => {
    const onTabChange = vi.fn();
    render(<PageTabs tabs={keyTabs} activeTab="b" onTabChange={onTabChange} />);
    fireEvent.keyDown(screen.getAllByRole('tab')[0], { key: 'ArrowLeft' });
    expect(onTabChange).toHaveBeenLastCalledWith('a');
  });

  it('Home and End jump to the ends', () => {
    const onTabChange = vi.fn();
    render(<PageTabs tabs={keyTabs} activeTab="b" onTabChange={onTabChange} />);
    fireEvent.keyDown(screen.getAllByRole('tab')[0], { key: 'Home' });
    expect(onTabChange).toHaveBeenLastCalledWith('a');
    fireEvent.keyDown(screen.getAllByRole('tab')[0], { key: 'End' });
    expect(onTabChange).toHaveBeenLastCalledWith('c');
  });

  it('keeps one tab in the tab order and names no panel it does not render', () => {
    render(<PageTabs tabs={keyTabs} activeTab="b" onTabChange={vi.fn()} />);
    const active = screen.getByTestId('page-tab-b');
    // An aria-controls pointing at an element that does not exist is a
    // critical axe violation; this bar does not render the panel.
    expect(active.getAttribute('aria-controls')).toBeNull();
    expect(active.getAttribute('tabindex')).toBe('0');
    expect(screen.getByTestId('page-tab-a').getAttribute('tabindex')).toBe('-1');
  });

  it('ignores keys outside the pattern', () => {
    const onTabChange = vi.fn();
    render(<PageTabs tabs={keyTabs} activeTab="a" onTabChange={onTabChange} />);
    fireEvent.keyDown(screen.getAllByRole('tab')[0], { key: 'x' });
    expect(onTabChange).not.toHaveBeenCalled();
  });
});
