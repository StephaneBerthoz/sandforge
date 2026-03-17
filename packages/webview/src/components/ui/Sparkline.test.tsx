import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Sparkline } from './Sparkline';

describe('Sparkline', () => {
  it('should render an SVG element', () => {
    render(<Sparkline data={[10, 20, 30, 40, 50]} />);
    const svg = screen.getByTestId('sparkline');
    expect(svg.tagName).toBe('svg');
  });

  it('should render a path for valid data', () => {
    render(<Sparkline data={[10, 20, 30, 40, 50]} />);
    const path = screen.getByTestId('sparkline-path');
    expect(path).toBeDefined();
    expect(path.getAttribute('d')).toBeTruthy();
  });

  it('should handle empty data gracefully by rendering nothing', () => {
    const { container } = render(<Sparkline data={[]} />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('should handle single data point by rendering a dot', () => {
    render(<Sparkline data={[50]} />);
    const svg = screen.getByTestId('sparkline');
    expect(svg).toBeDefined();
    const circle = svg.querySelector('circle');
    expect(circle).toBeDefined();
    expect(circle).not.toBeNull();
  });

  it('should show threshold lines when showThresholds is true', () => {
    render(<Sparkline data={[10, 50, 80, 95]} showThresholds />);
    expect(screen.getByTestId('threshold-75')).toBeDefined();
    expect(screen.getByTestId('threshold-90')).toBeDefined();
  });

  it('should not show threshold lines by default', () => {
    render(<Sparkline data={[10, 50, 80, 95]} />);
    expect(screen.queryByTestId('threshold-75')).toBeNull();
    expect(screen.queryByTestId('threshold-90')).toBeNull();
  });

  it('should apply custom color to stroke', () => {
    render(<Sparkline data={[10, 20, 30]} color="var(--sf-error)" />);
    const path = screen.getByTestId('sparkline-path');
    expect(path.getAttribute('stroke')).toBe('var(--sf-error)');
  });

  it('should apply custom dimensions', () => {
    render(<Sparkline data={[10, 20, 30]} width={200} height={50} />);
    const svg = screen.getByTestId('sparkline');
    expect(svg.getAttribute('width')).toBe('200');
    expect(svg.getAttribute('height')).toBe('50');
    expect(svg.getAttribute('viewBox')).toBe('0 0 200 50');
  });

  it('should have animation class when animate is true', () => {
    render(<Sparkline data={[10, 20, 30]} animate />);
    const svg = screen.getByTestId('sparkline');
    expect(svg.classList.contains('sparkline-animate')).toBe(true);
  });

  it('should not have animation class when animate is false', () => {
    render(<Sparkline data={[10, 20, 30]} />);
    const svg = screen.getByTestId('sparkline');
    expect(svg.classList.contains('sparkline-animate')).toBe(false);
  });

  it('should apply custom className', () => {
    render(<Sparkline data={[10, 20, 30]} className="my-sparkline" />);
    const svg = screen.getByTestId('sparkline');
    expect(svg.classList.contains('my-sparkline')).toBe(true);
  });

  it('should render path for exactly 2 data points', () => {
    render(<Sparkline data={[20, 80]} />);
    const path = screen.getByTestId('sparkline-path');
    expect(path.getAttribute('d')).toContain('M');
    expect(path.getAttribute('d')).toContain('L');
  });

  it('should have role img and aria-label', () => {
    render(<Sparkline data={[10, 20, 30]} />);
    const svg = screen.getByTestId('sparkline');
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('Sparkline chart');
  });
});
