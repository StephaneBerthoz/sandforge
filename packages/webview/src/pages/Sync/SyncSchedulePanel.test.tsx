import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '../../i18n';
import { SyncSchedulePanel } from './SyncSchedulePanel';
import { useSyncScheduleStore } from '../../stores/useSyncScheduleStore';
import type { SyncConfigListResponse, SyncScheduleEntry } from '@sandforge/shared';

/** Saved configurations `sync:config:list` answers with, per test. */
const savedConfigs = vi.hoisted(() => ({
  value: [] as SyncConfigListResponse['payload']['configs'],
  loading: false,
  error: null as string | null,
}));

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string) => ({
    data:
      type === 'sync:config:list' && !savedConfigs.loading && !savedConfigs.error
        ? { configs: savedConfigs.value }
        : null,
    loading: savedConfigs.loading,
    error: savedConfigs.error,
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

/** Deliver a message from the extension host to the panel's window. */
function fromHost(data: Record<string, unknown>): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { timestamp: Date.now(), ...data } }));
  });
}

/** A saved configuration summary, as `sync:config:list` answers it. */
function saved(
  id: string,
  name: string,
  updatedAt = '2024-01-01T09:00:00Z',
): SyncConfigListResponse['payload']['configs'][number] {
  return { id, name, description: '', updatedAt };
}

const makeMockSchedule = (
  id: string,
  overrides?: Partial<SyncScheduleEntry>,
): SyncScheduleEntry => ({
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
    savedConfigs.value = [saved('cfg-1', 'dev1 \u2192 dev2')];
    savedConfigs.loading = false;
    savedConfigs.error = null;
    mockVSCodeApi.postMessage.mockClear();
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

  it('fills the schedule list from the answer the host sends', () => {
    // The store sent sync:schedule:list on mount and listened for nothing:
    // the answer arrived, the list stayed empty and loading stayed on.
    render(<SyncSchedulePanel />);

    fromHost({
      id: 'ext-1',
      type: 'sync:schedule:list:response',
      payload: { schedules: [makeMockSchedule('s-1')] },
    });

    expect(screen.getByText('Schedule s-1')).toBeDefined();
    expect(useSyncScheduleStore.getState().loading).toBe(false);
  });

  it('adds a schedule the host confirms, then updates it in place', () => {
    render(<SyncSchedulePanel />);

    fromHost({
      id: 'ext-2',
      type: 'sync:schedule:upsert:response',
      payload: { success: true, schedule: makeMockSchedule('s-1') },
    });
    expect(screen.getByText('Schedule s-1')).toBeDefined();

    fromHost({
      id: 'ext-3',
      type: 'sync:schedule:upsert:response',
      payload: { success: true, schedule: makeMockSchedule('s-1', { name: 'Renamed' }) },
    });
    expect(screen.getByText('Renamed')).toBeDefined();
    expect(useSyncScheduleStore.getState().schedules).toHaveLength(1);
  });

  it('pauses a schedule once the host confirms the toggle', () => {
    useSyncScheduleStore.setState({ schedules: [makeMockSchedule('s-1')] });
    render(<SyncSchedulePanel />);

    fromHost({
      id: 'ext-6',
      type: 'sync:schedule:toggle:response',
      payload: { success: true, scheduleId: 's-1', enabled: false },
    });

    expect(useSyncScheduleStore.getState().schedules[0].enabled).toBe(false);
  });

  it('removes a schedule once the host confirms the delete', () => {
    useSyncScheduleStore.setState({
      schedules: [makeMockSchedule('s-1'), makeMockSchedule('s-2')],
    });
    render(<SyncSchedulePanel />);

    fromHost({
      id: 'ext-7',
      type: 'sync:schedule:delete:response',
      payload: { success: true, scheduleId: 's-1' },
    });

    expect(screen.queryByText('Schedule s-1')).toBeNull();
    expect(screen.getByText('Schedule s-2')).toBeDefined();
  });

  it('shows a refused schedule request instead of leaving the panel loading', () => {
    useSyncScheduleStore.setState({ loading: true });
    render(<SyncSchedulePanel />);

    fromHost({
      id: 'ext-4',
      type: 'sync:schedule:error',
      payload: { message: 'Schedule not found: sched-9' },
    });

    expect(screen.getByTestId('sync-schedule-error').textContent).toContain(
      'Schedule not found: sched-9',
    );
    expect(useSyncScheduleStore.getState().loading).toBe(false);
  });

  it('offers the saved configurations and never a made-up default', () => {
    // `cfg-default` was a placeholder with no configuration behind it: every
    // schedule built on it named an id the executor could not load.
    savedConfigs.value = [saved('cfg-7', 'Nightly accounts'), saved('cfg-8', 'Contacts')];
    useSyncScheduleStore.setState({ schedules: [makeMockSchedule('s-1')] });
    render(<SyncSchedulePanel />);
    fireEvent.click(screen.getByTestId('new-schedule-btn'));

    const picker = screen.getByLabelText('Sync configuration') as HTMLSelectElement;
    const values = Array.from(picker.options).map((o) => o.value);
    expect(values).toEqual(['cfg-7', 'cfg-8']);
    expect(values).not.toContain('cfg-default');
  });

  it('tells apart two configurations saved under the same pair of orgs', () => {
    // A changed configuration is saved as a new entry under the same name, and
    // nothing deletes the older one: the picker has to show which is which.
    savedConfigs.value = [
      saved('cfg-new', 'dev1 \u2192 dev2', '2024-03-02T10:15:30Z'),
      saved('cfg-old', 'dev1 \u2192 dev2', '2024-03-01T08:00:00Z'),
    ];
    useSyncScheduleStore.setState({ schedules: [makeMockSchedule('s-1')] });
    render(<SyncSchedulePanel />);
    fireEvent.click(screen.getByTestId('new-schedule-btn'));

    const picker = screen.getByLabelText('Sync configuration') as HTMLSelectElement;
    const labels = Array.from(picker.options).map((o) => o.textContent ?? '');
    expect(labels).toHaveLength(2);
    expect(labels[0]).toContain('dev1 \u2192 dev2');
    expect(labels[1]).toContain('dev1 \u2192 dev2');
    expect(labels[0]).not.toBe(labels[1]);
  });

  it('cannot create a schedule while no configuration has been saved', () => {
    savedConfigs.value = [];
    useSyncScheduleStore.setState({ schedules: [makeMockSchedule('s-1')] });
    render(<SyncSchedulePanel />);

    expect((screen.getByTestId('new-schedule-btn') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('new-schedule-btn'));
    expect(screen.queryByTestId('cron-schedule-builder')).toBeNull();
  });

  it('says why an empty Schedules tab offers nothing to create', () => {
    savedConfigs.value = [];
    render(<SyncSchedulePanel />);
    fromHost({ id: 'ext-5', type: 'sync:schedule:list:response', payload: { schedules: [] } });

    expect(screen.getByTestId('sync-schedule-panel').textContent).toContain(
      'Save a sync configuration',
    );
    expect(screen.queryByText('Create a schedule')).toBeNull();
  });

  it('says why New schedule is disabled while schedules exist but no configuration is saved', () => {
    // Schedules built on the old placeholder are still stored, so the list is
    // not empty and the empty state that gave the reason never shows.
    savedConfigs.value = [];
    useSyncScheduleStore.setState({ schedules: [makeMockSchedule('s-1')] });
    render(<SyncSchedulePanel />);

    expect((screen.getByTestId('new-schedule-btn') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('sync-schedule-no-config').textContent).toContain(
      'Save a sync configuration',
    );
  });

  it('does not say no configuration is saved while the saved list is still loading', () => {
    savedConfigs.loading = true;
    render(<SyncSchedulePanel />);
    fromHost({ id: 'ext-8', type: 'sync:schedule:list:response', payload: { schedules: [] } });

    expect(screen.getByTestId('sync-schedule-panel').textContent).not.toContain(
      'Save a sync configuration',
    );
  });

  it('shows a refused configuration list instead of reading it as none saved', () => {
    savedConfigs.error = 'sync:config:list was refused';
    useSyncScheduleStore.setState({ schedules: [makeMockSchedule('s-1')] });
    render(<SyncSchedulePanel />);

    expect(screen.getByTestId('sync-schedule-error').textContent).toContain(
      'sync:config:list was refused',
    );
    expect(screen.queryByTestId('sync-schedule-no-config')).toBeNull();
  });

  it('asks for a configuration again when the one an edited schedule ran is gone', () => {
    // Preselecting the first saved configuration moved the schedule onto
    // another org pair as soon as any other field was saved, with nothing
    // saying the configuration had changed.
    const upsertSpy = vi.fn();
    useSyncScheduleStore.setState({
      schedules: [makeMockSchedule('s-1', { configId: 'cfg-gone' })],
      upsertSchedule: upsertSpy,
    });
    render(<SyncSchedulePanel />);
    fireEvent.click(screen.getByTestId('edit-btn-s-1'));

    const selector = screen.getByTestId('config-selector') as HTMLSelectElement;
    expect(selector.value).toBe('');
    expect(selector.textContent).toContain('no longer exists');
    expect((screen.getByTestId('submit-btn') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByTestId('cron-schedule-builder'));
    expect(upsertSpy).not.toHaveBeenCalled();

    fireEvent.change(selector, { target: { value: 'cfg-1' } });
    fireEvent.submit(screen.getByTestId('cron-schedule-builder'));
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy.mock.calls[0][0]).toMatchObject({ id: 's-1', configId: 'cfg-1' });
  });

  it('cannot edit a schedule while no configuration has been saved', () => {
    savedConfigs.value = [];
    useSyncScheduleStore.setState({ schedules: [makeMockSchedule('s-1')] });
    render(<SyncSchedulePanel />);

    expect((screen.getByTestId('edit-btn-s-1') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('edit-btn-s-1'));
    expect(screen.queryByTestId('cron-schedule-builder')).toBeNull();
  });
});
