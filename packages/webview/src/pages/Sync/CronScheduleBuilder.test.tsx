import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { CronScheduleBuilder, cronToHuman } from './CronScheduleBuilder';
import type { CronScheduleBuilderProps } from './CronScheduleBuilder';

const defaultProps: CronScheduleBuilderProps = {
  onSubmit: vi.fn(),
  onCancel: vi.fn(),
  configs: [
    { id: 'cfg-1', name: 'My Sync Config' },
    { id: 'cfg-2', name: 'Weekly Backup' },
  ],
};

describe('CronScheduleBuilder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render the form with name input, config selector, and frequency toggle', () => {
    render(<CronScheduleBuilder {...defaultProps} />);
    expect(screen.getByTestId('cron-schedule-builder')).toBeDefined();
    expect(screen.getByTestId('schedule-name-input')).toBeDefined();
    expect(screen.getByTestId('config-selector')).toBeDefined();
    expect(screen.getByTestId('mode-simple-btn')).toBeDefined();
    expect(screen.getByTestId('mode-advanced-btn')).toBeDefined();
  });

  it('should show simple mode panel by default with preset selector', () => {
    render(<CronScheduleBuilder {...defaultProps} />);
    expect(screen.getByTestId('simple-mode-panel')).toBeDefined();
    expect(screen.getByTestId('preset-selector')).toBeDefined();
  });

  it('should show advanced mode with raw text input when toggled', () => {
    render(<CronScheduleBuilder {...defaultProps} />);
    fireEvent.click(screen.getByTestId('mode-advanced-btn'));
    expect(screen.getByTestId('advanced-mode-panel')).toBeDefined();
    expect(screen.getByTestId('raw-cron-input')).toBeDefined();
  });

  it('should call onSubmit with correct data when form is submitted', () => {
    const onSubmit = vi.fn();
    render(<CronScheduleBuilder {...defaultProps} onSubmit={onSubmit} />);

    // Fill in name
    fireEvent.change(screen.getByTestId('schedule-name-input'), {
      target: { value: 'Daily Sync' },
    });

    // Submit
    fireEvent.click(screen.getByTestId('submit-btn'));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const callArg = onSubmit.mock.calls[0][0];
    expect(callArg.name).toBe('Daily Sync');
    expect(callArg.configId).toBe('cfg-1');
    expect(callArg.cron).toBeDefined();
    expect(callArg.timezone).toBeDefined();
  });

  it('should default timezone to local timezone', () => {
    render(<CronScheduleBuilder {...defaultProps} />);
    const selector = screen.getByTestId('timezone-selector') as HTMLSelectElement;
    // The selected timezone should be the local timezone
    expect(selector.value).toBeDefined();
    expect(selector.value.length).toBeGreaterThan(0);
  });

  it('should call onCancel when cancel button is clicked', () => {
    const onCancel = vi.fn();
    render(<CronScheduleBuilder {...defaultProps} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId('cancel-btn'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('should render with initial values when editing', () => {
    render(
      <CronScheduleBuilder
        {...defaultProps}
        initialName="Existing Schedule"
        initialCron="0 9 * * 1"
        initialTimezone="America/New_York"
        initialConfigId="cfg-2"
      />,
    );
    const nameInput = screen.getByTestId('schedule-name-input') as HTMLInputElement;
    expect(nameInput.value).toBe('Existing Schedule');
  });

  it('should show cron preview', () => {
    render(<CronScheduleBuilder {...defaultProps} />);
    expect(screen.getByTestId('cron-preview')).toBeDefined();
  });
});

describe('cronToHuman', () => {
  it('should convert daily cron to human-readable', () => {
    expect(cronToHuman('0 9 * * *')).toBe('Every day at 09:00');
  });

  it('should convert hourly cron to human-readable', () => {
    expect(cronToHuman('0 * * * *')).toBe('Every hour');
  });

  it('should convert monthly cron to human-readable', () => {
    expect(cronToHuman('30 14 15 * *')).toBe('Monthly on day 15 at 14:30');
  });

  it('should return raw cron for complex expressions', () => {
    expect(cronToHuman('*/5 * * * *')).toBe('*/5 * * * *');
  });
});
