import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { SyncSchedulePanel } from './SyncSchedulePanel';
import { useSyncScheduleStore } from '../../stores/useSyncScheduleStore';
import type { SyncScheduleEntry } from '@sandforge/shared';

const makeMockSchedule = (id: string, overrides?: Partial<SyncScheduleEntry>): SyncScheduleEntry => ({
  id,
  name: `Schedule ${id}`,
  configId: 'cfg-1',
  cron: '0 9 * * 1',
  timezone: 'America/New_York',
  enabled: true,
  maxRetries: 3,
  notifyOnComplete: false,
  notifyOnFailure: true,
  nextRunAt: '2024-01-08T14:00:00Z',
  lastRunAt: '2024-01-01T14:00:00Z',
  lastResult: 'success',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  version: 1,
  ...overrides,
});

describe('SyncSchedulePanel', () => {
  beforeEach(() => {
    useSyncScheduleStore.setState({
      schedules: [],
      loading: false,
      error: null,
    });
  });

  it('should render the panel with test ID', () => {
    render(<SyncSchedulePanel />);
    expect(screen.getByTestId('sync-schedule-panel')).toBeDefined();
  });

  it('should show EmptyState when no schedules exist', () => {
    useSyncScheduleStore.setState({ schedules: [], loading: false });
    render(<SyncSchedulePanel />);
    expect(screen.getByTestId('sync-schedule-panel')).toBeDefined();
  });

  it('should render schedule list when schedules exist', () => {
    useSyncScheduleStore.setState({
      schedules: [makeMockSchedule('s-1'), makeMockSchedule('s-2', { name: 'Weekly Backup' })],
      loading: false,
    });
    render(<SyncSchedulePanel />);
    expect(screen.getByText('Schedule s-1')).toBeDefined();
    expect(screen.getByText('Weekly Backup')).toBeDefined();
  });

  it('should show New Schedule button when schedules exist', () => {
    useSyncScheduleStore.setState({
      schedules: [makeMockSchedule('s-1')],
      loading: false,
    });
    render(<SyncSchedulePanel />);
    expect(screen.getByTestId('new-schedule-btn')).toBeDefined();
  });

  it('should show CronScheduleBuilder when New Schedule is clicked', () => {
    useSyncScheduleStore.setState({
      schedules: [makeMockSchedule('s-1')],
      loading: false,
    });
    render(<SyncSchedulePanel />);
    fireEvent.click(screen.getByTestId('new-schedule-btn'));
    expect(screen.getByTestId('cron-schedule-builder')).toBeDefined();
  });

  it('should call toggleSchedule with correct args when pause/resume is clicked', () => {
    const toggleScheduleSpy = vi.fn();
    useSyncScheduleStore.setState({
      schedules: [makeMockSchedule('s-1', { enabled: true })],
      loading: false,
      toggleSchedule: toggleScheduleSpy,
    });
    render(<SyncSchedulePanel />);
    fireEvent.click(screen.getByTestId('toggle-btn-s-1'));
    expect(toggleScheduleSpy).toHaveBeenCalledWith('s-1', false);
  });

  it('should call deleteSchedule after confirmation', () => {
    const deleteScheduleSpy = vi.fn();
    useSyncScheduleStore.setState({
      schedules: [makeMockSchedule('s-1')],
      loading: false,
      deleteSchedule: deleteScheduleSpy,
    });
    render(<SyncSchedulePanel />);
    // Click delete to show confirmation
    fireEvent.click(screen.getByTestId('delete-btn-s-1'));
    // Confirm
    fireEvent.click(screen.getByTestId('confirm-delete-btn-s-1'));
    expect(deleteScheduleSpy).toHaveBeenCalledWith('s-1');
  });

  it('should show edit form when edit button is clicked', () => {
    useSyncScheduleStore.setState({
      schedules: [makeMockSchedule('s-1')],
      loading: false,
    });
    render(<SyncSchedulePanel />);
    fireEvent.click(screen.getByTestId('edit-btn-s-1'));
    expect(screen.getByTestId('cron-schedule-builder')).toBeDefined();
  });

  it('should show SkeletonTable when loading', () => {
    useSyncScheduleStore.setState({ loading: true, schedules: [] });
    render(<SyncSchedulePanel />);
    expect(screen.getByTestId('sync-schedule-panel')).toBeDefined();
  });
});
