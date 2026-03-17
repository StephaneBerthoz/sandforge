import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import type { ApiLimit } from '@sandforge/shared';
import { LimitsPanel } from './LimitsPanel';

const mockLimits: ApiLimit[] = [
  { name: 'DailyApiRequests', max: 100000, remaining: 95000, usedPercent: 5 },
  { name: 'DailyBulkApiBatches', max: 15000, remaining: 2000, usedPercent: 86.7 },
  { name: 'DataStorageMB', max: 5000, remaining: 200, usedPercent: 96 },
];

describe('LimitsPanel', () => {
  it('should render the limits title', () => {
    render(<LimitsPanel limits={mockLimits} />);
    expect(screen.getByText('monitor.limits')).toBeDefined();
  });

  it('should render limit count subtitle', () => {
    render(<LimitsPanel limits={mockLimits} />);
    expect(screen.getByText('3 limits tracked')).toBeDefined();
  });

  it('should render all limit names', () => {
    render(<LimitsPanel limits={mockLimits} />);
    expect(screen.getByText('DailyApiRequests')).toBeDefined();
    expect(screen.getByText('DailyBulkApiBatches')).toBeDefined();
    expect(screen.getByText('DataStorageMB')).toBeDefined();
  });

  it('should sort limits by usage descending (most used first)', () => {
    render(<LimitsPanel limits={mockLimits} />);
    const items = screen.getAllByText(/Daily|Data/);
    expect(items[0].textContent).toBe('DataStorageMB');
  });

  it('should render remaining/max counts', () => {
    render(<LimitsPanel limits={mockLimits} />);
    /* toLocaleString may or may not add commas depending on test environment locale */
    expect(screen.getByText(/95.?000/)).toBeDefined();
  });

  it('should show no data message when empty', () => {
    render(<LimitsPanel limits={[]} />);
    expect(screen.getByText('No data available')).toBeDefined();
  });

  it('should render progress bars for each limit', () => {
    render(<LimitsPanel limits={mockLimits} />);
    const progressBars = screen.getAllByRole('progressbar');
    expect(progressBars.length).toBe(3);
  });
});
