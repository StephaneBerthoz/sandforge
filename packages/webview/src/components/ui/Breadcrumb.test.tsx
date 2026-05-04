import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Breadcrumb } from './Breadcrumb';
import type { BreadcrumbItem } from './Breadcrumb';

const items: BreadcrumbItem[] = [
  { label: 'Home', onClick: vi.fn() },
  { label: 'Settings', onClick: vi.fn() },
  { label: 'Profile' },
];

describe('Breadcrumb', () => {
  it('should render all breadcrumb labels', () => {
    render(<Breadcrumb items={items} />);
    expect(screen.getByText('Home')).toBeDefined();
    expect(screen.getByText('Settings')).toBeDefined();
    expect(screen.getByText('Profile')).toBeDefined();
  });

  it('should mark the last item as current page', () => {
    render(<Breadcrumb items={items} />);
    const lastItem = screen.getByText('Profile');
    expect(lastItem.getAttribute('aria-current')).toBe('page');
  });

  it('should render ancestor items as buttons', () => {
    render(<Breadcrumb items={items} />);
    const homeBtn = screen.getByLabelText('Navigate to Home');
    expect(homeBtn.tagName).toBe('BUTTON');
  });

  it('should call onClick when an ancestor is clicked', () => {
    const onClick = vi.fn();
    const navItems: BreadcrumbItem[] = [{ label: 'Home', onClick }, { label: 'Current' }];
    render(<Breadcrumb items={navItems} />);
    fireEvent.click(screen.getByLabelText('Navigate to Home'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('should render separators between items', () => {
    const { container } = render(<Breadcrumb items={items} />);
    const separators = container.querySelectorAll('[aria-hidden="true"]');
    // Separators appear between items (items.length - 1)
    expect(separators.length).toBe(items.length - 1);
  });

  it('should have an accessible nav landmark', () => {
    render(<Breadcrumb items={items} />);
    expect(screen.getByLabelText('Breadcrumb')).toBeDefined();
  });

  it('should apply custom className', () => {
    const { container } = render(<Breadcrumb items={items} className="mb-4" />);
    expect(container.querySelector('nav')?.className).toContain('mb-4');
  });
});
