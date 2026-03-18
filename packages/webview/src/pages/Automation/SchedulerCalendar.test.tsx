import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { SchedulerCalendar } from './SchedulerCalendar';
import type { ScheduledPipeline } from './SchedulerCalendar';

const scheduled: ScheduledPipeline[] = [
  {
    pipelineId: 'pipe-1',
    pipelineName: 'Daily Backup',
    trigger: { id: 't1', type: 'schedule', enabled: true, config: { cron: '0 0 * * *', timezone: 'UTC' } },
    nextFireTime: '2026-02-21T00:00:00Z',
  },
  {
    pipelineId: 'pipe-2',
    pipelineName: 'Weekly Sync',
    trigger: { id: 't2', type: 'schedule', enabled: false, config: { cron: '0 0 * * 0', timezone: 'US/Pacific' } },
  },
];

describe('SchedulerCalendar', () => {
  it('should render the calendar', () => {
    render(<SchedulerCalendar />);
    expect(screen.getByTestId('scheduler-calendar')).toBeDefined();
  });

  it('should show empty state when no scheduled items', () => {
    render(<SchedulerCalendar />);
    expect(screen.getByText('No pipelines configured')).toBeDefined();
  });

  it('should show scheduled pipeline cards', () => {
    render(<SchedulerCalendar scheduled={scheduled} />);
    expect(screen.getByTestId('scheduled-pipe-1')).toBeDefined();
    expect(screen.getByTestId('scheduled-pipe-2')).toBeDefined();
  });

  it('should show pipeline names', () => {
    render(<SchedulerCalendar scheduled={scheduled} />);
    expect(screen.getByText('Daily Backup')).toBeDefined();
    expect(screen.getByText('Weekly Sync')).toBeDefined();
  });

  it('should show active/disabled badges', () => {
    render(<SchedulerCalendar scheduled={scheduled} />);
    expect(screen.getByText('Active')).toBeDefined();
    expect(screen.getByText('Disabled')).toBeDefined();
  });

  it('should show next fire time', () => {
    render(<SchedulerCalendar scheduled={scheduled} />);
    expect(screen.getByText(/2026-02-21/)).toBeDefined();
  });

  it('should show timezone', () => {
    render(<SchedulerCalendar scheduled={scheduled} />);
    expect(screen.getByText(/US\/Pacific/)).toBeDefined();
  });

  it('should show cron expression', () => {
    render(<SchedulerCalendar scheduled={scheduled} />);
    expect(screen.getByText('0 0 * * *')).toBeDefined();
  });

  it('should render "Coming in v1.2" badge', () => {
    render(<SchedulerCalendar />);
    expect(screen.getByTestId('scheduler-coming-soon')).toBeDefined();
    expect(screen.getByText('Coming in v1.2')).toBeDefined();
  });

  it('should render "Coming in v1.2" badge when scheduled items exist', () => {
    render(<SchedulerCalendar scheduled={scheduled} />);
    expect(screen.getByTestId('scheduler-coming-soon')).toBeDefined();
    expect(screen.getByText('Coming in v1.2')).toBeDefined();
  });

  it('should have content with pointer-events-none and reduced opacity', () => {
    render(<SchedulerCalendar />);
    const container = screen.getByTestId('scheduler-calendar');
    const disabledContent = container.querySelector('.pointer-events-none.opacity-50');
    expect(disabledContent).toBeDefined();
    expect(disabledContent).not.toBeNull();
  });
});
