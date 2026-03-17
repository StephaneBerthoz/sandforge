import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Skeleton } from './Skeleton';

describe('Skeleton', () => {
  it('should render with data-testid on root', () => {
    render(<Skeleton />);
    expect(screen.getByTestId('skeleton')).toBeDefined();
  });

  it('should be aria-hidden for accessibility', () => {
    render(<Skeleton />);
    expect(screen.getByTestId('skeleton').getAttribute('aria-hidden')).toBe('true');
  });

  it('should use sf-skeleton class for animation', () => {
    render(<Skeleton />);
    expect(screen.getByTestId('skeleton').className).toContain('sf-skeleton');
  });

  /* --- text variant --- */
  it('should default to text variant with 100% width and 1em height', () => {
    render(<Skeleton />);
    const el = screen.getByTestId('skeleton');
    expect(el.style.width).toBe('100%');
    expect(el.style.height).toBe('1em');
  });

  it('should accept custom width and height for text variant', () => {
    render(<Skeleton width="200px" height="20px" />);
    const el = screen.getByTestId('skeleton');
    expect(el.style.width).toBe('200px');
    expect(el.style.height).toBe('20px');
  });

  it('should render multiple lines with lines prop', () => {
    render(<Skeleton lines={3} />);
    const lines = screen.getAllByTestId('skeleton-line');
    expect(lines).toHaveLength(3);
  });

  it('should have varying widths for multi-line skeletons', () => {
    render(<Skeleton lines={4} />);
    const lines = screen.getAllByTestId('skeleton-line');
    const widths = lines.map((line) => line.style.width);
    // First line should be 100%, others should vary
    expect(widths[0]).toBe('100%');
    expect(widths[1]).toBe('92%');
    expect(widths[2]).toBe('85%');
    expect(widths[3]).toBe('78%');
  });

  it('should apply sf-skeleton class on each line', () => {
    render(<Skeleton lines={2} />);
    const lines = screen.getAllByTestId('skeleton-line');
    lines.forEach((line) => {
      expect(line.className).toContain('sf-skeleton');
    });
  });

  /* --- rect variant --- */
  it('should render rect variant with default dimensions', () => {
    render(<Skeleton variant="rect" />);
    const el = screen.getByTestId('skeleton');
    expect(el.style.width).toBe('100%');
    expect(el.style.height).toBe('100px');
  });

  it('should render rect variant with custom dimensions', () => {
    render(<Skeleton variant="rect" width="300px" height="200px" />);
    const el = screen.getByTestId('skeleton');
    expect(el.style.width).toBe('300px');
    expect(el.style.height).toBe('200px');
  });

  it('should apply radius-md on rect variant', () => {
    render(<Skeleton variant="rect" />);
    expect(screen.getByTestId('skeleton').className).toContain('rounded-[var(--sf-radius-md)]');
  });

  /* --- circle variant --- */
  it('should render circle variant with default 40px size', () => {
    render(<Skeleton variant="circle" />);
    const el = screen.getByTestId('skeleton');
    expect(el.style.width).toBe('40px');
    expect(el.style.height).toBe('40px');
  });

  it('should render circle variant with custom size', () => {
    render(<Skeleton variant="circle" width="60px" />);
    const el = screen.getByTestId('skeleton');
    expect(el.style.width).toBe('60px');
    expect(el.style.height).toBe('60px');
  });

  it('should apply rounded-full on circle variant', () => {
    render(<Skeleton variant="circle" />);
    expect(screen.getByTestId('skeleton').className).toContain('rounded-full');
  });

  it('should allow separate height for circle variant', () => {
    render(<Skeleton variant="circle" width="40px" height="50px" />);
    const el = screen.getByTestId('skeleton');
    expect(el.style.width).toBe('40px');
    expect(el.style.height).toBe('50px');
  });

  /* --- className merging --- */
  it('should merge custom className', () => {
    render(<Skeleton className="mt-4" />);
    expect(screen.getByTestId('skeleton').className).toContain('mt-4');
  });

  it('should merge custom className on multi-line container', () => {
    render(<Skeleton lines={2} className="mb-2" />);
    expect(screen.getByTestId('skeleton').className).toContain('mb-2');
  });
});
