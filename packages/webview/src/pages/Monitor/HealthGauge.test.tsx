import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HealthGauge } from './HealthGauge';

describe('HealthGauge', () => {
  it('should render with data-testid', () => {
    render(<HealthGauge value={75} />);
    expect(screen.getByTestId('health-gauge')).toBeDefined();
  });

  it('should display the value as text', () => {
    render(<HealthGauge value={85} />);
    expect(screen.getByText('85')).toBeDefined();
  });

  it('should show Healthy label for value > 80', () => {
    render(<HealthGauge value={90} />);
    expect(screen.getByText('Healthy')).toBeDefined();
  });

  it('should show Degraded label for value between 40 and 80', () => {
    render(<HealthGauge value={60} />);
    expect(screen.getByText('Degraded')).toBeDefined();
  });

  it('should show Critical label for value < 40', () => {
    render(<HealthGauge value={20} />);
    expect(screen.getByText('Critical')).toBeDefined();
  });

  it('should clamp value to 0-100 range (upper)', () => {
    render(<HealthGauge value={150} />);
    expect(screen.getByText('100')).toBeDefined();
  });

  it('should clamp value to 0-100 range (lower)', () => {
    render(<HealthGauge value={-10} />);
    expect(screen.getByText('0')).toBeDefined();
  });

  it('should render the SVG gauge arc', () => {
    render(<HealthGauge value={50} />);
    expect(screen.getByTestId('health-gauge-arc')).toBeDefined();
  });

  it('should accept a custom size prop', () => {
    render(<HealthGauge value={70} size={200} />);
    const svg = screen.getByTestId('health-gauge').querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('200');
    expect(svg?.getAttribute('height')).toBe('200');
  });

  it('should accept a custom className', () => {
    render(<HealthGauge value={50} className="my-class" />);
    const container = screen.getByTestId('health-gauge');
    expect(container.className).toContain('my-class');
  });

  it('should show green color zone at boundary (value = 81)', () => {
    render(<HealthGauge value={81} />);
    expect(screen.getByText('Healthy')).toBeDefined();
  });

  it('should show amber color zone at boundary (value = 40)', () => {
    render(<HealthGauge value={40} />);
    expect(screen.getByText('Degraded')).toBeDefined();
  });

  it('should show red color zone at boundary (value = 39)', () => {
    render(<HealthGauge value={39} />);
    expect(screen.getByText('Critical')).toBeDefined();
  });
});
