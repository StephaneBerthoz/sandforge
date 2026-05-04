import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Tabs } from './Tabs';

const tabs = [
  { id: 'general', label: 'General' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'disabled', label: 'Disabled', disabled: true },
];

describe('Tabs', () => {
  it('should render all tabs', () => {
    render(<Tabs tabs={tabs} />);
    expect(screen.getAllByRole('tab')).toHaveLength(3);
  });

  it('should mark first tab as selected by default', () => {
    render(<Tabs tabs={tabs} />);
    const firstTab = screen.getByRole('tab', { name: 'General' });
    expect(firstTab.getAttribute('aria-selected')).toBe('true');
  });

  it('should mark activeTab as selected', () => {
    render(<Tabs tabs={tabs} activeTab="advanced" />);
    const advTab = screen.getByRole('tab', { name: 'Advanced' });
    expect(advTab.getAttribute('aria-selected')).toBe('true');
  });

  it('should call onTabChange when a tab is clicked', () => {
    const handler = vi.fn();
    render(<Tabs tabs={tabs} onTabChange={handler} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Advanced' }));
    expect(handler).toHaveBeenCalledWith('advanced');
  });

  it('should not call onTabChange for disabled tabs', () => {
    const handler = vi.fn();
    render(<Tabs tabs={tabs} onTabChange={handler} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Disabled' }));
    expect(handler).not.toHaveBeenCalled();
  });

  it('should switch tabs internally when onTabChange is not provided', () => {
    render(<Tabs tabs={tabs} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Advanced' }));
    expect(screen.getByRole('tab', { name: 'Advanced' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe(
      'false',
    );
  });
});
