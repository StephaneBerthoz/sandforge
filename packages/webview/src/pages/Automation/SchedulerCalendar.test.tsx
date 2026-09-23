import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import '../../i18n';
import type { SyncConfigListResponse, SyncScheduleEntry } from '@sandforge/shared';
import { SchedulerCalendar, groupByNextRun } from './SchedulerCalendar';
import { useSyncScheduleStore } from '../../stores/useSyncScheduleStore';

/** Saved configurations `sync:config:list` answers with. */
const savedConfigs = vi.hoisted(() => ({
  value: [] as SyncConfigListResponse['payload']['configs'],
}));

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string) => ({
    data: type === 'sync:config:list' ? { configs: savedConfigs.value } : null,
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

const mockVSCodeApi = {
  postMessage: vi.fn(),
  getState: () => undefined,
  setState: () => undefined,
};

vi.mock('../../hooks/useVSCodeApi', () => ({
  getVscodeApi: () => mockVSCodeApi,
  useVSCodeApi: () => mockVSCodeApi,
}));

/** Every request the panel posted to the host, by type. */
function sent(type: string): Array<{ type: string; payload?: Record<string, unknown> }> {
  return mockVSCodeApi.postMessage.mock.calls
    .map(([envelope]) => (envelope as { payload: { type: string } }).payload)
    .filter((message) => message.type === type);
}

/** Deliver a message from the extension host to the panel's window. */
function fromHost(data: Record<string, unknown>): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { timestamp: Date.now(), ...data } }));
  });
}

/** Local time on the day the tests are set, as an ISO instant. */
const at = (localDateTime: string): string => new Date(localDateTime).toISOString();

function schedule(id: string, overrides: Partial<SyncScheduleEntry> = {}): SyncScheduleEntry {
  return {
    id,
    name: `Schedule ${id}`,
    configId: 'cfg-1',
    cron: '0 9 * * *',
    timezone: 'Europe/Paris',
    enabled: true,
    maxRetries: 3,
    notifyOnComplete: false,
    notifyOnFailure: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    ...overrides,
  };
}

/** 08:00 on a Monday, the reader's local time. */
const NOW = new Date('2026-03-02T08:00:00');

describe('groupByNextRun', () => {
  it('lays the active schedules out by day, soonest first, after the ones already due', () => {
    const groups = groupByNextRun(
      [
        schedule('later-today', { nextRunAt: at('2026-03-02T18:00:00') }),
        schedule('next-week', { nextRunAt: at('2026-03-09T09:00:00') }),
        schedule('due', { nextRunAt: at('2026-03-02T07:59:00') }),
        schedule('soon', { nextRunAt: at('2026-03-02T09:00:00') }),
        schedule('tomorrow', { nextRunAt: at('2026-03-03T06:00:00') }),
      ],
      NOW.getTime(),
    );

    expect(
      groups.map((group) => [group.kind, group.day, group.schedules.map((s) => s.id)]),
    ).toEqual([
      ['due', undefined, ['due']],
      ['day', '2026-03-02', ['soon', 'later-today']],
      ['day', '2026-03-03', ['tomorrow']],
      ['day', '2026-03-09', ['next-week']],
    ]);
  });

  it('puts a paused schedule apart, whatever run time the host kept on it', () => {
    // The host leaves nextRunAt as it was when a schedule is paused: that time
    // is not a run.
    const groups = groupByNextRun(
      [schedule('paused', { enabled: false, nextRunAt: at('2026-03-02T09:00:00') })],
      NOW.getTime(),
    );

    expect(groups).toEqual([
      { kind: 'paused', schedules: [expect.objectContaining({ id: 'paused' })] },
    ]);
  });

  it('puts apart an active schedule the host planned no run for', () => {
    // An expression cron-parser refuses leaves nextRunAt empty.
    const groups = groupByNextRun(
      [schedule('broken', { nextRunAt: '' }), schedule('none')],
      NOW.getTime(),
    );

    expect(groups).toEqual([
      {
        kind: 'unplanned',
        schedules: [
          expect.objectContaining({ id: 'broken' }),
          expect.objectContaining({ id: 'none' }),
        ],
      },
    ]);
  });

  it('has nothing to lay out when there is no schedule', () => {
    expect(groupByNextRun([], NOW.getTime())).toEqual([]);
  });
});

describe('SchedulerCalendar', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    useSyncScheduleStore.setState({ schedules: [], loading: false, error: null });
    savedConfigs.value = [
      { id: 'cfg-1', name: 'dev1 → dev2', description: '', updatedAt: '2026-01-01T09:00:00Z' },
    ];
    mockVSCodeApi.postMessage.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows no coming-soon badge: the calendar is the sync schedules', () => {
    render(<SchedulerCalendar />);
    expect(screen.getByTestId('scheduler-calendar')).toBeDefined();
    expect(screen.queryByTestId('scheduler-coming-soon')).toBeNull();
    expect(screen.queryByText('Coming soon')).toBeNull();
  });

  it('says it lists the sync schedules, then the schedules of the saved pipelines', () => {
    render(<SchedulerCalendar />);
    expect(screen.getByTestId('scheduler-intro').textContent).toBe(
      'The sync schedules, by the day each next runs, then the schedules of the saved ' +
        'pipelines, with the next run of each.',
    );
  });

  it('lists each saved pipeline schedule with its next run, in the time zone it is read in', () => {
    render(
      <SchedulerCalendar
        pipelineSchedules={[
          {
            pipelineId: 'p1',
            pipelineName: 'Nightly backup',
            trigger: {
              id: 't1',
              type: 'schedule',
              enabled: true,
              config: { cron: '0 2 * * *', timezone: 'Asia/Tokyo' },
            },
            status: {
              pipelineId: 'p1',
              triggerId: 't1',
              type: 'schedule',
              armed: true,
              timezone: 'Asia/Tokyo',
              nextRunAt: '2026-03-02T17:00:00.000Z',
            },
          },
          {
            pipelineId: 'p2',
            pipelineName: 'Weekly compare',
            trigger: {
              id: 't2',
              type: 'schedule',
              enabled: false,
              config: { cron: '0 6 * * 1', timezone: 'UTC' },
            },
            status: {
              pipelineId: 'p2',
              triggerId: 't2',
              type: 'schedule',
              armed: false,
              idle: 'disabled',
              timezone: 'UTC',
            },
          },
        ]}
      />,
    );
    const nightly = screen.getByTestId('scheduler-pipeline-p1-t1');
    expect(nightly.textContent).toContain('Nightly backup');
    expect(nightly.textContent).toContain('0 2 * * *');
    // 17:00 UTC is 02:00 the next morning in Tokyo, where the schedule is read.
    expect(nightly.textContent).toMatch(/Next run: .*2:00.*\(Asia\/Tokyo\)/);
    expect(screen.getByTestId('scheduler-pipeline-p2-t2').textContent).toContain(
      'Switched off: it starts nothing.',
    );
  });

  it('says how to give a pipeline a schedule when none has one', () => {
    render(<SchedulerCalendar />);
    expect(screen.getByTestId('scheduler-pipelines-empty').textContent).toMatch(/Triggers tab/);
  });

  it('asks the host for the schedules and lays out what it answers by day', () => {
    render(<SchedulerCalendar />);
    expect(sent('sync:schedule:list')).toHaveLength(1);

    fromHost({
      id: 'ext-1',
      type: 'sync:schedule:list:response',
      payload: {
        schedules: [
          schedule('a', { name: 'Accounts', nextRunAt: at('2026-03-02T09:00:00') }),
          schedule('b', { name: 'Contacts', nextRunAt: at('2026-03-03T06:30:00') }),
          schedule('c', { name: 'Cases', nextRunAt: at('2026-03-05T21:15:00') }),
        ],
      },
    });

    const today = screen.getByTestId('scheduler-group-day-2026-03-02');
    expect(within(today).getByRole('heading').textContent).toBe('Today');
    expect(within(today).getByText('Accounts')).toBeDefined();
    expect(screen.getByTestId('scheduler-entry-time-a').textContent).toBe('09:00');

    const tomorrow = screen.getByTestId('scheduler-group-day-2026-03-03');
    expect(within(tomorrow).getByRole('heading').textContent).toBe('Tomorrow');
    expect(screen.getByTestId('scheduler-entry-time-b').textContent).toBe('06:30');

    const later = screen.getByTestId('scheduler-group-day-2026-03-05');
    expect(within(later).getByRole('heading').textContent).toBe(
      new Intl.DateTimeFormat(undefined, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }).format(new Date('2026-03-05T00:00:00')),
    );
  });

  it('shows how the last run went and when it was', () => {
    useSyncScheduleStore.setState({
      schedules: [
        schedule('a', {
          nextRunAt: at('2026-03-02T09:00:00'),
          lastRunAt: at('2026-03-01T09:00:00'),
          lastResult: 'partial',
        }),
      ],
    });
    render(<SchedulerCalendar />);

    const entry = screen.getByTestId('scheduler-entry-a');
    expect(within(entry).getByText('Partial')).toBeDefined();
    expect(entry.textContent).toContain('Last run: 2026-03-01 09:00');
  });

  it('shows a last run that was cancelled as cancelled, and one it cannot read as unknown', () => {
    // Formatting a stored date that could not be read threw, and the agenda
    // did not render.
    useSyncScheduleStore.setState({
      schedules: [
        schedule('a', {
          nextRunAt: at('2026-03-02T09:00:00'),
          lastRunAt: 'not a date',
          lastResult: 'cancelled',
        }),
      ],
    });
    render(<SchedulerCalendar />);

    const entry = screen.getByTestId('scheduler-entry-a');
    expect(within(entry).getByText('Cancelled')).toBeDefined();
    expect(entry.textContent).toContain('Last run: unknown');
  });

  it('shows a run whose time has passed as due, with its date', () => {
    useSyncScheduleStore.setState({
      schedules: [schedule('a', { nextRunAt: at('2026-03-02T07:00:00') })],
    });
    render(<SchedulerCalendar />);

    const due = screen.getByTestId('scheduler-group-due');
    expect(within(due).getByRole('heading').textContent).toBe('Due now');
    expect(screen.getByTestId('scheduler-entry-time-a').textContent).toBe('2026-03-02 07:00');
  });

  it('gives a paused schedule no run time', () => {
    useSyncScheduleStore.setState({
      schedules: [schedule('a', { enabled: false, nextRunAt: at('2026-03-02T09:00:00') })],
    });
    render(<SchedulerCalendar />);

    const paused = screen.getByTestId('scheduler-group-paused');
    expect(within(paused).getByRole('heading').textContent).toBe('Paused');
    expect(screen.queryByTestId('scheduler-entry-time-a')).toBeNull();
    expect(within(paused).getByTestId('toggle-btn-a').textContent).toBe('Resume');
  });

  it('pauses a schedule from the calendar', () => {
    useSyncScheduleStore.setState({
      schedules: [schedule('a', { nextRunAt: at('2026-03-02T09:00:00') })],
    });
    render(<SchedulerCalendar />);

    fireEvent.click(screen.getByTestId('toggle-btn-a'));

    expect(sent('sync:schedule:toggle')).toEqual([
      expect.objectContaining({ payload: { scheduleId: 'a', enabled: false } }),
    ]);
  });

  it('deletes a schedule from the calendar once the deletion is confirmed', () => {
    useSyncScheduleStore.setState({
      schedules: [schedule('a', { nextRunAt: at('2026-03-02T09:00:00') })],
    });
    render(<SchedulerCalendar />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Schedule a' }));
    expect(sent('sync:schedule:delete')).toHaveLength(0);
    fireEvent.click(screen.getByTestId('confirm-delete-btn-a'));

    expect(sent('sync:schedule:delete')).toEqual([
      expect.objectContaining({ payload: { scheduleId: 'a' } }),
    ]);
  });

  it('edits a schedule in place, in the builder the Sync tab uses', () => {
    useSyncScheduleStore.setState({
      schedules: [schedule('a', { nextRunAt: at('2026-03-02T09:00:00') })],
    });
    render(<SchedulerCalendar />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Schedule a' }));

    expect(screen.getByTestId('cron-schedule-builder')).toBeDefined();
  });

  it('offers to create the first schedule when there is none', () => {
    render(<SchedulerCalendar />);
    fromHost({ id: 'ext-2', type: 'sync:schedule:list:response', payload: { schedules: [] } });

    expect(screen.getByText('No schedules yet')).toBeDefined();
    fireEvent.click(screen.getByText('Create a schedule'));
    expect(screen.getByTestId('cron-schedule-builder')).toBeDefined();
  });
});
