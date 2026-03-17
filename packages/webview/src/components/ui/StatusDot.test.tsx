import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusDot } from './StatusDot';

describe('StatusDot', () => {
  it('should render with online status color', () => {
    render(<StatusDot status="online" />);
    const dot = screen.getByTestId('status-dot');
    expect(dot.className).toContain('bg-emerald-500');
  });

  it('should render with error status color', () => {
    render(<StatusDot status="error" />);
    const dot = screen.getByTestId('status-dot');
    expect(dot.className).toContain('bg-red-500');
  });

  it('should render label text when provided', () => {
    render(<StatusDot status="online" label="Connected" />);
    expect(screen.getByText('Connected')).toBeDefined();
  });

  it('should use status as aria-label when no label is provided', () => {
    render(<StatusDot status="warning" />);
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('warning');
  });

  it('should show pulse animation when pulse is true', () => {
    const { container } = render(<StatusDot status="online" pulse />);
    const pulseEl = container.querySelector('.animate-ping');
    expect(pulseEl).not.toBeNull();
  });

  it('should not show pulse animation by default', () => {
    const { container } = render(<StatusDot status="online" />);
    const pulseEl = container.querySelector('.animate-ping');
    expect(pulseEl).toBeNull();
  });

  it('should apply custom className', () => {
    render(<StatusDot status="offline" className="ml-2" />);
    const wrapper = screen.getByRole('status');
    expect(wrapper.className).toContain('ml-2');
  });
});
