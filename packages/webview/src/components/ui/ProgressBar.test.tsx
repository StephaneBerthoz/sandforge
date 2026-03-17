import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProgressBar } from './ProgressBar';

describe('ProgressBar', () => {
  it('should render with correct aria attributes', () => {
    render(<ProgressBar value={50} />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
  });

  it('should render label when provided', () => {
    render(<ProgressBar value={25} label="Loading..." />);
    expect(screen.getByText('Loading...')).toBeDefined();
  });

  it('should show percentage when showPercent is true', () => {
    render(<ProgressBar value={75} showPercent />);
    expect(screen.getByText('75%')).toBeDefined();
  });

  it('should clamp value between 0 and 100', () => {
    render(<ProgressBar value={150} />);
    const bar = screen.getByRole('progressbar');
    const inner = bar.firstChild as HTMLElement;
    expect(inner.style.width).toBe('100%');
  });

  it('should handle custom max value', () => {
    render(<ProgressBar value={5} max={10} showPercent />);
    expect(screen.getByText('50%')).toBeDefined();
  });

  it('should apply variant class', () => {
    render(<ProgressBar value={50} variant="success" />);
    const bar = screen.getByRole('progressbar');
    const inner = bar.firstChild as HTMLElement;
    expect(inner.className).toContain('bg-emerald-500');
  });

  it('should apply small size', () => {
    render(<ProgressBar value={50} size="sm" />);
    const bar = screen.getByRole('progressbar');
    expect(bar.className).toContain('h-1');
  });
});
