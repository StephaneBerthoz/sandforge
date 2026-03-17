import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HealthScoreGauge } from './HealthScoreGauge';

describe('HealthScoreGauge', () => {
  it('should render the score value', () => {
    render(<HealthScoreGauge score={85} />);
    expect(screen.getByText('85')).toBeDefined();
  });

  it('should show Healthy for score >= 80', () => {
    render(<HealthScoreGauge score={80} />);
    expect(screen.getByText('Healthy')).toBeDefined();
  });

  it('should show Degraded for score >= 50 and < 80', () => {
    render(<HealthScoreGauge score={65} />);
    expect(screen.getByText('Degraded')).toBeDefined();
  });

  it('should show Critical for score < 50', () => {
    render(<HealthScoreGauge score={30} />);
    expect(screen.getByText('Critical')).toBeDefined();
  });

  it('should clamp score to 0-100 range', () => {
    render(<HealthScoreGauge score={150} />);
    expect(screen.getByText('100')).toBeDefined();
  });

  it('should clamp negative scores to 0', () => {
    render(<HealthScoreGauge score={-10} />);
    expect(screen.getByText('0')).toBeDefined();
  });

  it('should render SVG with gauge arc', () => {
    render(<HealthScoreGauge score={50} />);
    expect(screen.getByTestId('health-gauge-arc')).toBeDefined();
  });

  it('should render with different sizes', () => {
    const { rerender } = render(<HealthScoreGauge score={75} size="sm" />);
    expect(screen.getByTestId('health-gauge')).toBeDefined();
    rerender(<HealthScoreGauge score={75} size="lg" />);
    expect(screen.getByTestId('health-gauge')).toBeDefined();
  });
});
