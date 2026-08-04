import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { SchedulerPanel } from './SchedulerPanel';

// Mock hooks
const mockQueryData = vi.fn<[], Record<string, unknown> | null>().mockReturnValue(null);
const mockQueryRefetch = vi.fn();
const mockMutate = vi.fn();

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: () => ({
    data: mockQueryData(),
    loading: false,
    error: null,
    refetch: mockQueryRefetch,
  }),
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: () => ({
    mutate: mockMutate,
    data: null,
    loading: false,
    error: null,
    reset: vi.fn(),
  }),
}));

describe('SchedulerPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueryData.mockReturnValue(null);
  });

  it('should render the panel', () => {
    render(<SchedulerPanel />);
    expect(screen.getByTestId('scheduler-panel')).toBeDefined();
  });

  it('should show empty state when no schedules', () => {
    mockQueryData.mockReturnValue({ schedules: [], history: [] });
    render(<SchedulerPanel />);
    expect(screen.getByTestId('scheduler-empty')).toBeDefined();
  });

  it('should show add schedule button', () => {
    render(<SchedulerPanel />);
    expect(screen.getByTestId('add-schedule-btn')).toBeDefined();
  });

  it('should show add form when button clicked', () => {
    render(<SchedulerPanel />);
    fireEvent.click(screen.getByTestId('add-schedule-btn'));
    expect(screen.getByTestId('add-schedule-form')).toBeDefined();
  });

  it('should render schedule list', () => {
    mockQueryData.mockReturnValue({
      schedules: [
        {
          id: 'sched-1',
          operationType: 'backup',
          frequency: 'daily',
          time: '02:00',
          enabled: true,
          nextRunAt: new Date(Date.now() + 3600_000).toISOString(),
        },
        {
          id: 'sched-2',
          operationType: 'sync',
          frequency: 'hourly',
          time: '00:30',
          enabled: false,
        },
      ],
      history: [],
    });

    render(<SchedulerPanel />);
    expect(screen.getByTestId('schedules-list')).toBeDefined();
    expect(screen.getByTestId('schedule-sched-1')).toBeDefined();
    expect(screen.getByTestId('schedule-sched-2')).toBeDefined();
  });

  it('should render history table', () => {
    mockQueryData.mockReturnValue({
      schedules: [],
      history: [
        {
          id: 'run-1',
          scheduleId: 'sched-1',
          operationType: 'backup',
          status: 'success',
          startedAt: new Date(Date.now() - 3600_000).toISOString(),
          completedAt: new Date(Date.now() - 3500_000).toISOString(),
          durationMs: 100_000,
          recordsProcessed: 1500,
        },
      ],
    });

    render(<SchedulerPanel />);
    expect(screen.getByTestId('history-section')).toBeDefined();
    expect(screen.getByTestId('table-row-0')).toBeDefined();
  });

  it('should call delete when delete button clicked', () => {
    mockQueryData.mockReturnValue({
      schedules: [
        {
          id: 'sched-1',
          operationType: 'backup',
          frequency: 'daily',
          time: '02:00',
          enabled: true,
        },
      ],
      history: [],
    });

    render(<SchedulerPanel />);
    fireEvent.click(screen.getByTestId('delete-sched-1'));
    expect(mockMutate).toHaveBeenCalledWith({ scheduleId: 'sched-1' });
  });

  it('should call toggle when toggle button clicked', () => {
    mockQueryData.mockReturnValue({
      schedules: [
        {
          id: 'sched-1',
          operationType: 'backup',
          frequency: 'daily',
          time: '02:00',
          enabled: true,
        },
      ],
      history: [],
    });

    render(<SchedulerPanel />);
    fireEvent.click(screen.getByTestId('toggle-sched-1'));
    expect(mockMutate).toHaveBeenCalledWith({ scheduleId: 'sched-1', enabled: false });
  });

  it('should hide add form on cancel', () => {
    render(<SchedulerPanel />);
    fireEvent.click(screen.getByTestId('add-schedule-btn'));
    expect(screen.getByTestId('add-schedule-form')).toBeDefined();
    fireEvent.click(screen.getByTestId('cancel-add'));
    expect(screen.queryByTestId('add-schedule-form')).toBeNull();
  });

  it('should submit add form with correct data', () => {
    mockQueryData.mockReturnValue({ schedules: [], history: [] });
    render(<SchedulerPanel />);
    fireEvent.click(screen.getByTestId('add-schedule-btn'));
    fireEvent.click(screen.getByTestId('confirm-add'));
    expect(mockMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        schedule: expect.objectContaining({
          operationType: 'backup',
          frequency: 'daily',
          time: '02:00',
          enabled: true,
        }),
      }),
    );
  });
});
