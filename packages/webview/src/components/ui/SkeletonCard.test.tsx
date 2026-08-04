import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SkeletonCard } from './SkeletonCard';

describe('SkeletonCard', () => {
  it('renders with default props', () => {
    render(<SkeletonCard />);
    const card = screen.getByTestId('skeleton-card');
    expect(card).toBeDefined();
    const skeletons = card.querySelectorAll('[data-testid="skeleton"]');
    // circle + title text + multi-line text container = 3 skeleton elements
    expect(skeletons.length).toBeGreaterThanOrEqual(3);
  });

  it('renders correct number of text lines', () => {
    render(<SkeletonCard lines={5} />);
    const card = screen.getByTestId('skeleton-card');
    const lines = card.querySelectorAll('[data-testid="skeleton-line"]');
    expect(lines).toHaveLength(5);
  });

  it('hides icon when showIcon is false', () => {
    render(<SkeletonCard showIcon={false} />);
    const card = screen.getByTestId('skeleton-card');
    const circles = card.querySelectorAll('.rounded-full');
    expect(circles).toHaveLength(0);
  });

  it('shows icon when showIcon is true', () => {
    render(<SkeletonCard showIcon />);
    const card = screen.getByTestId('skeleton-card');
    const circles = card.querySelectorAll('.rounded-full');
    expect(circles).toHaveLength(1);
  });

  it('applies className prop', () => {
    render(<SkeletonCard className="test-cls" />);
    const card = screen.getByTestId('skeleton-card');
    expect(card.className).toContain('test-cls');
  });

  it('has aria-hidden attribute', () => {
    render(<SkeletonCard />);
    const card = screen.getByTestId('skeleton-card');
    expect(card.getAttribute('aria-hidden')).toBe('true');
  });
});
