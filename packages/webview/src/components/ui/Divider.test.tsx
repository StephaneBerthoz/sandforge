import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Divider } from './Divider';

describe('Divider', () => {
  it('should render a horizontal separator by default', () => {
    render(<Divider />);
    const separator = screen.getByRole('separator');
    expect(separator.getAttribute('aria-orientation')).toBe('horizontal');
  });

  it('should render a vertical separator', () => {
    render(<Divider orientation="vertical" />);
    const separator = screen.getByRole('separator');
    expect(separator.getAttribute('aria-orientation')).toBe('vertical');
    expect(separator.className).toContain('w-px');
  });

  it('should render label text when provided', () => {
    render(<Divider label="OR" />);
    expect(screen.getByText('OR')).toBeDefined();
  });

  it('should render flanking lines when label is provided', () => {
    const { container } = render(<Divider label="Section" />);
    const lines = container.querySelectorAll('.h-px');
    expect(lines.length).toBe(2);
  });

  it('should render a simple line when no label is provided', () => {
    const { container } = render(<Divider />);
    const separator = screen.getByRole('separator');
    expect(separator.className).toContain('h-px');
    expect(container.querySelector('span')).toBeNull();
  });

  it('should apply custom className', () => {
    render(<Divider className="my-4" />);
    const separator = screen.getByRole('separator');
    expect(separator.className).toContain('my-4');
  });
});
