import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SkeletonPanel } from './SkeletonPanel';

describe('SkeletonPanel', () => {
  it('renders with default sections', () => {
    render(<SkeletonPanel />);
    const panel = screen.getByTestId('skeleton-panel');
    expect(panel).toBeDefined();
    expect(screen.getAllByTestId('skeleton-panel-section')).toHaveLength(2);
  });

  it('renders custom number of sections', () => {
    render(<SkeletonPanel sections={4} />);
    expect(screen.getAllByTestId('skeleton-panel-section')).toHaveLength(4);
  });

  it('each section contains skeleton elements', () => {
    render(<SkeletonPanel sections={1} />);
    const section = screen.getByTestId('skeleton-panel-section');
    const skeletons = section.querySelectorAll('[data-testid="skeleton"]');
    // title skeleton + multi-line text container = 2 skeleton elements
    expect(skeletons.length).toBeGreaterThanOrEqual(2);
  });

  it('applies className prop', () => {
    render(<SkeletonPanel className="custom-panel" />);
    const panel = screen.getByTestId('skeleton-panel');
    expect(panel.className).toContain('custom-panel');
  });

  it('has aria-hidden attribute', () => {
    render(<SkeletonPanel />);
    const panel = screen.getByTestId('skeleton-panel');
    expect(panel.getAttribute('aria-hidden')).toBe('true');
  });
});
