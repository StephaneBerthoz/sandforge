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

describe('Tabs — keyboard', () => {
  const tabs = [
    { id: 'one', label: 'One' },
    { id: 'two', label: 'Two', disabled: true },
    { id: 'three', label: 'Three' },
  ];

  it('moves to the next enabled tab on ArrowRight, stepping over a disabled one', () => {
    const onTabChange = vi.fn();
    render(<Tabs tabs={tabs} activeTab="one" onTabChange={onTabChange} />);
    fireEvent.keyDown(screen.getAllByRole('tab')[0], { key: 'ArrowRight' });
    expect(onTabChange).toHaveBeenCalledWith('three');
  });

  it('wraps at the end', () => {
    const onTabChange = vi.fn();
    render(<Tabs tabs={tabs} activeTab="three" onTabChange={onTabChange} />);
    fireEvent.keyDown(screen.getAllByRole('tab')[0], { key: 'ArrowRight' });
    expect(onTabChange).toHaveBeenCalledWith('one');
  });

  it('goes back on ArrowLeft', () => {
    const onTabChange = vi.fn();
    render(<Tabs tabs={tabs} activeTab="one" onTabChange={onTabChange} />);
    fireEvent.keyDown(screen.getAllByRole('tab')[0], { key: 'ArrowLeft' });
    expect(onTabChange).toHaveBeenCalledWith('three');
  });

  it('Home and End jump to the ends', () => {
    const onTabChange = vi.fn();
    render(<Tabs tabs={tabs} activeTab="three" onTabChange={onTabChange} />);
    fireEvent.keyDown(screen.getAllByRole('tab')[0], { key: 'Home' });
    expect(onTabChange).toHaveBeenLastCalledWith('one');
    fireEvent.keyDown(screen.getAllByRole('tab')[0], { key: 'End' });
    expect(onTabChange).toHaveBeenLastCalledWith('three');
  });

  it('keeps one tab in the page tab order and takes the others out', () => {
    render(<Tabs tabs={tabs} activeTab="three" />);
    expect(screen.getByRole('tab', { name: 'Three' }).getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('tab', { name: 'One' }).getAttribute('tabindex')).toBe('-1');
  });

  it('ignores a key that is not part of the pattern', () => {
    const onTabChange = vi.fn();
    render(<Tabs tabs={tabs} activeTab="one" onTabChange={onTabChange} />);
    fireEvent.keyDown(screen.getAllByRole('tab')[0], { key: 'a' });
    expect(onTabChange).not.toHaveBeenCalled();
  });
});
