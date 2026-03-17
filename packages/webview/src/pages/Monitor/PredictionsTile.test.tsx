import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { PredictionsTile } from './PredictionsTile';
import type { LimitPrediction } from './PredictionsTile';

const samplePredictions: LimitPrediction[] = [
  { limitName: 'DailyApiRequests', currentUsage: 85, estimatedHoursToLimit: 1.5 },
  { limitName: 'DataStorageMB', currentUsage: 60, estimatedHoursToLimit: 8 },
  { limitName: 'DailyAsyncApexExecutions', currentUsage: 20, estimatedHoursToLimit: 48 },
];

describe('PredictionsTile', () => {
  it('should render with data-testid', () => {
    render(<PredictionsTile predictions={samplePredictions} />);
    expect(screen.getByTestId('predictions-tile')).toBeDefined();
  });

  it('should render all predictions', () => {
    render(<PredictionsTile predictions={samplePredictions} />);
    expect(screen.getByTestId('prediction-DailyApiRequests')).toBeDefined();
    expect(screen.getByTestId('prediction-DataStorageMB')).toBeDefined();
    expect(screen.getByTestId('prediction-DailyAsyncApexExecutions')).toBeDefined();
  });

  it('should sort predictions by urgency (most urgent first)', () => {
    render(<PredictionsTile predictions={samplePredictions} />);
    const rows = screen.getAllByTestId(/^prediction-[A-Z]/);
    expect(rows[0].getAttribute('data-testid')).toBe('prediction-DailyApiRequests');
    expect(rows[1].getAttribute('data-testid')).toBe('prediction-DataStorageMB');
    expect(rows[2].getAttribute('data-testid')).toBe('prediction-DailyAsyncApexExecutions');
  });

  it('should show red urgency for predictions < 2h', () => {
    render(<PredictionsTile predictions={samplePredictions} />);
    const dot = screen.getByTestId('prediction-dot-DailyApiRequests');
    expect(dot.getAttribute('aria-label')).toBe('Critical');
  });

  it('should show amber urgency for predictions < 12h', () => {
    render(<PredictionsTile predictions={samplePredictions} />);
    const dot = screen.getByTestId('prediction-dot-DataStorageMB');
    expect(dot.getAttribute('aria-label')).toBe('Warning');
  });

  it('should show green urgency for predictions > 12h', () => {
    render(<PredictionsTile predictions={samplePredictions} />);
    const dot = screen.getByTestId('prediction-dot-DailyAsyncApexExecutions');
    expect(dot.getAttribute('aria-label')).toBe('Safe');
  });

  it('should display formatted time estimates', () => {
    render(<PredictionsTile predictions={samplePredictions} />);
    const apiTime = screen.getByTestId('prediction-time-DailyApiRequests');
    // 1.5h rounds to 2h
    expect(apiTime.textContent).toBe('2h');
    const storageTime = screen.getByTestId('prediction-time-DataStorageMB');
    expect(storageTime.textContent).toBe('8h');
    const asyncTime = screen.getByTestId('prediction-time-DailyAsyncApexExecutions');
    expect(asyncTime.textContent).toBe('2d 0h');
  });

  it('should display current usage percentages', () => {
    render(<PredictionsTile predictions={samplePredictions} />);
    expect(screen.getByText('85%')).toBeDefined();
    expect(screen.getByText('60%')).toBeDefined();
    expect(screen.getByText('20%')).toBeDefined();
  });

  it('should show empty state when no predictions', () => {
    render(<PredictionsTile predictions={[]} />);
    expect(screen.getByText('No predictions available')).toBeDefined();
  });

  it('should accept a custom className', () => {
    render(<PredictionsTile predictions={samplePredictions} className="my-custom" />);
    const container = screen.getByTestId('predictions-tile');
    expect(container.className).toContain('my-custom');
  });

  it('should format sub-hour times in minutes', () => {
    const shortPredictions: LimitPrediction[] = [
      { limitName: 'QuickLimit', currentUsage: 95, estimatedHoursToLimit: 0.5 },
    ];
    render(<PredictionsTile predictions={shortPredictions} />);
    const timeEl = screen.getByTestId('prediction-time-QuickLimit');
    expect(timeEl.textContent).toBe('30m');
  });
});
