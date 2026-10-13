import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '../../i18n';
import { SyncSchedulePanel, nextRefreshDelay } from './SyncSchedulePanel';
import { useSyncScheduleStore } from '../../stores/useSyncScheduleStore';
import type { SyncConfigListResponse, SyncScheduleEntry } from '@sandforge/shared';

/** Saved configurations `sync:config:list` answers with, per test. */
const savedConfigs = vi.hoisted(() => ({
  value: [] as SyncConfigListResponse['payload']['configs'],
  loading: false,
  error: null as string | null,
  refetch: vi.fn(),
}));

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string) => ({
    data:
      type === 'sync:config:list' && !savedConfigs.loading && !savedConfigs.error
        ? { configs: savedConfigs.value }
        : null,
    loading: savedConfigs.loading,
    error: savedConfigs.error,
    refetch: type === 'sync:config:list' ? savedConfigs.refetch : vi.fn(),
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

/** The "Run full next time" requests the panel posted, envelope-unwrapped. */
function sentResets(): Array<{ id: string; payload?: unknown }> {
  return mockVSCodeApi.postMessage.mock.calls
    .map(([envelope]) => (envelope as { payload: { id: string; type: string } }).payload)
    .filter((message) => message.type === 'sync:config:reset-delta');
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
    savedConfigs.refetch.mockClear();
    mockVSCodeApi.postMessage.mockClear();
  });

  it('reads the saved configurations again once a migration is saved as one, and only then', () => {
    render(<SyncSchedulePanel />);

    fromHost({
      id: 'refused',
      type: 'migration:save-sync-config:response',
      correlationId: 'req-1',
      payload: { success: false, code: 'DUPLICATE_NAME' },
    });
    expect(savedConfigs.refetch).not.toHaveBeenCalled();

    fromHost({
      id: 'saved',
      type: 'migration:save-sync-config:response',
      correlationId: 'req-2',
      payload: { success: true, id: 'cfg-migrated', name: 'Nightly accounts' },
    });
    expect(savedConfigs.refetch).toHaveBeenCalledTimes(1);
  });

  it('reads the saved configurations again once the Sync wizard saves one, and only then', () => {
    // Only a migration saved as one was heard: a configuration the wizard
    // saved in another panel stayed out of this one's picker.
    render(<SyncSchedulePanel />);

    fromHost({
      id: 'refused',
      type: 'sync:config:save:response',
      correlationId: 'req-1',
      payload: { success: false, id: 'cfg-refused' },
    });
    expect(savedConfigs.refetch).not.toHaveBeenCalled();

    fromHost({
      id: 'saved',
      type: 'sync:config:save:response',
      correlationId: 'req-2',
      payload: { success: true, id: 'cfg-2' },
    });
    expect(savedConfigs.refetch).toHaveBeenCalledTimes(1);
  });

  describe('the saved configurations, on the Sync page', () => {
    it('lists each one with Run now, which runs it by its id under the label it is listed by', () => {
      const onRunConfig = vi.fn();
      savedConfigs.value = [saved('cfg-1', 'dev1 → dev2'), saved('cfg-2', 'Nightly accounts')];
      render(<SyncSchedulePanel onRunConfig={onRunConfig} />);

      const list = screen.getByTestId('sync-saved-configs');
      expect(list.querySelectorAll('li')).toHaveLength(2);
      // Named after the configuration and the time it was saved, as the
      // picker lists it: two saved under one name are told apart.
      const run = screen.getByRole('button', {
        name: /^Run Nightly accounts · 2024-01-0\d .+ now$/,
      });
      expect(run.textContent).toBe('Run now');

      fireEvent.click(run);

      expect(onRunConfig).toHaveBeenCalledWith(
        'cfg-2',
        expect.stringMatching(/^Nightly accounts · 2024-01-0\d /),
      );
      // Nothing is sent from here: the page runs it.
      expect(mockVSCodeApi.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'sync:execute' }),
      );
    });

    it('lists them beside the schedules too', () => {
      useSyncScheduleStore.setState({ schedules: [makeMockSchedule('s-1')], loading: false });
      render(<SyncSchedulePanel onRunConfig={vi.fn()} />);

      expect(screen.getByText('Schedule s-1')).toBeDefined();
      expect(screen.getByTestId('run-saved-config-cfg-1')).toBeDefined();
    });

    it('offers no Run now while a run is under way on the page', () => {
      render(<SyncSchedulePanel onRunConfig={vi.fn()} runDisabled />);

      expect(screen.getByTestId('run-saved-config-cfg-1')).toHaveProperty('disabled', true);
    });

    it('lists nothing where no page runs them: the Automation calendar', () => {
      render(<SyncSchedulePanel />);

      expect(screen.queryByTestId('sync-saved-configs')).toBeNull();
    });

    it('lists nothing while no configuration is saved', () => {
      savedConfigs.value = [];
      render(<SyncSchedulePanel onRunConfig={vi.fn()} />);

      expect(screen.queryByTestId('sync-saved-configs')).toBeNull();
    });

    it('says which ones run as delta, and whether they carry deletions', () => {
      savedConfigs.value = [
        { ...saved('cfg-1', 'Full one'), mode: 'full' },
        { ...saved('cfg-2', 'Delta one'), mode: 'delta', watermarks: 0 },
        { ...saved('cfg-3', 'Delta deletes'), mode: 'delta', propagateDeletes: true },
      ];
      render(<SyncSchedulePanel onRunConfig={vi.fn()} />);

      expect(screen.getByTestId('saved-config-cfg-1').textContent).not.toContain('Delta,');
      expect(screen.getByTestId('saved-config-cfg-2').textContent).toContain('Delta');
      expect(screen.getByTestId('saved-config-cfg-3').textContent).toContain(
        'Delta, deletions carried',
      );
    });

    it('offers "Run full next time" only for a delta configuration holding watermarks', () => {
      savedConfigs.value = [
        { ...saved('cfg-1', 'Full one'), mode: 'full', watermarks: 2 },
        { ...saved('cfg-2', 'Fresh delta'), mode: 'delta', watermarks: 0 },
        { ...saved('cfg-3', 'Running delta'), mode: 'delta', watermarks: 2 },
      ];
      render(<SyncSchedulePanel onRunConfig={vi.fn()} />);

      expect(screen.queryByTestId('reset-delta-cfg-1')).toBeNull();
      expect(screen.queryByTestId('reset-delta-cfg-2')).toBeNull();
      expect(
        screen.getByRole('button', { name: /^Run Running delta · .+ in full next time$/ }),
      ).toBeDefined();
    });

    it('clears the watermarks by the id, says so once the host answers, and reads the list again', () => {
      savedConfigs.value = [{ ...saved('cfg-3', 'Running delta'), mode: 'delta', watermarks: 2 }];
      render(<SyncSchedulePanel onRunConfig={vi.fn()} />);

      fireEvent.click(screen.getByTestId('reset-delta-cfg-3'));

      const sent = sentResets()[0];
      expect(sent?.payload).toEqual({ id: 'cfg-3' });
      expect(screen.queryByTestId('reset-delta-done')).toBeNull();

      fromHost({
        id: 'reset-answer',
        type: 'sync:config:reset-delta:response',
        correlationId: sent?.id,
        payload: { success: true, id: 'cfg-3', cleared: 2 },
      });

      expect(screen.getByTestId('reset-delta-done').textContent).toMatch(
        /^The next run of Running delta · .+ reads everything\.$/,
      );
      expect(savedConfigs.refetch).toHaveBeenCalled();
    });

    it('says why the watermarks were not cleared when the host refuses', () => {
      savedConfigs.value = [{ ...saved('cfg-3', 'Running delta'), mode: 'delta', watermarks: 2 }];
      render(<SyncSchedulePanel onRunConfig={vi.fn()} />);

      fireEvent.click(screen.getByTestId('reset-delta-cfg-3'));
      const sent = sentResets()[0];
      fromHost({
        id: 'reset-refused',
        type: 'sync:error',
        correlationId: sent?.id,
        payload: {
          message: 'This configuration is no longer saved: there is nothing to reset.',
          code: 'UNKNOWN',
          retryable: false,
        },
      });

      expect(screen.getByTestId('reset-delta-error').textContent).toContain('no longer saved');
      expect(screen.queryByTestId('reset-delta-done')).toBeNull();
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

  it('shows a stored date it cannot read as unknown, and the rest of the list with it', () => {
    // Formatting one threw ("Invalid time value"): no schedule rendered at all.
    useSyncScheduleStore.setState({
      schedules: [
        makeMockSchedule('s-1', { nextRunAt: 'not a date', lastRunAt: 'neither' }),
        makeMockSchedule('s-2', { name: 'Weekly Backup' }),
      ],
      loading: false,
    });
    render(<SyncSchedulePanel />);

    const card = screen.getByTestId('schedule-card-s-1');
    expect(card.textContent).toContain('Next run: unknown');
    expect(card.textContent).toContain('Last run: unknown');
    expect(screen.getByText('Weekly Backup')).toBeDefined();
  });

  it('says a schedule whose last run was cancelled was cancelled, not partial', () => {
    useSyncScheduleStore.setState({
      schedules: [makeMockSchedule('s-1', { lastResult: 'cancelled' })],
      loading: false,
    });
    render(<SyncSchedulePanel />);

    const card = screen.getByTestId('schedule-card-s-1');
    expect(card.textContent).toContain('Cancelled');
    expect(card.textContent).not.toContain('Partial');
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

  it('names the edit and delete buttons after their schedule', () => {
    // Both are icons: a screen reader announced two unnamed buttons after Pause.
    useSyncScheduleStore.setState({
      schedules: [makeMockSchedule('s-1', { name: 'Nightly accounts' })],
    });
    render(<SyncSchedulePanel />);

    expect(screen.getByRole('button', { name: 'Edit Nightly accounts' })).toBe(
      screen.getByTestId('edit-btn-s-1'),
    );
    expect(screen.getByRole('button', { name: 'Delete Nightly accounts' })).toBe(
      screen.getByTestId('delete-btn-s-1'),
    );
  });

  it('gives no next run to a paused schedule, whose kept time is not a run', () => {
    // The host keeps `nextRunAt` on pause, and the card showed it as the next
    // run of a schedule that runs nothing until it is resumed.
    useSyncScheduleStore.setState({
      schedules: [
        makeMockSchedule('active', { cron: '0 9 * * 1' }),
        makeMockSchedule('paused', { cron: '30 14 15 * *', enabled: false }),
      ],
    });
    render(<SyncSchedulePanel />);

    const active = screen.getByTestId('schedule-card-active');
    const paused = screen.getByTestId('schedule-card-paused');
    expect(active.textContent).toContain('Next run');
    expect(active.textContent).toContain('Every Monday at 09:00');
    expect(paused.textContent).not.toContain('Next run');
    expect(paused.textContent).toContain('Monthly on day 15 at 14:30');
    expect(paused.textContent).toContain('Last run');
  });

  describe('once the next run is past', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** The `sync:schedule:list` requests the panel has posted. */
    const listRequests = () =>
      mockVSCodeApi.postMessage.mock.calls.filter(
        ([envelope]) =>
          (envelope as { payload: { type: string } }).payload.type === 'sync:schedule:list',
      );

    it('asks the host for the schedules again, a check after the run was due', () => {
      // The host answers the list when asked and never on its own: the next
      // run and the last result stayed as they were read, over a run that had
      // happened.
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-08T13:00:00Z'));
      render(<SyncSchedulePanel />);
      fromHost({
        id: 'ext-9',
        type: 'sync:schedule:list:response',
        payload: { schedules: [makeMockSchedule('s-1', { nextRunAt: '2024-01-08T14:00:00Z' })] },
      });
      expect(listRequests()).toHaveLength(1);

      act(() => {
        vi.advanceTimersByTime(60 * 60_000);
      });
      expect(listRequests()).toHaveLength(1);

      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(listRequests()).toHaveLength(2);
    });

    it('does not ask again for schedules that plan no run', () => {
      vi.useFakeTimers();
      useSyncScheduleStore.setState({
        schedules: [makeMockSchedule('s-1', { enabled: false })],
      });
      render(<SyncSchedulePanel />);

      act(() => {
        vi.advanceTimersByTime(24 * 60 * 60_000);
      });
      expect(listRequests()).toHaveLength(1);
    });
  });
});

describe('nextRefreshDelay', () => {
  const now = Date.parse('2024-01-08T13:00:00Z');

  it('waits one host check past the soonest run an active schedule plans', () => {
    expect(
      nextRefreshDelay(
        [
          makeMockSchedule('late', { nextRunAt: '2024-01-08T15:00:00Z' }),
          makeMockSchedule('soon', { nextRunAt: '2024-01-08T13:30:00Z' }),
        ],
        now,
      ),
    ).toBe(30 * 60_000 + 60_000);
  });

  it('checks every minute while a run is due, since its time moves on only once it ends', () => {
    expect(
      nextRefreshDelay([makeMockSchedule('due', { nextRunAt: '2024-01-08T12:00:00Z' })], now),
    ).toBe(60_000);
  });

  it('ignores a paused schedule and a schedule with no planned run', () => {
    expect(
      nextRefreshDelay(
        [
          makeMockSchedule('paused', { enabled: false, nextRunAt: '2024-01-08T13:30:00Z' }),
          makeMockSchedule('none', { nextRunAt: '' }),
        ],
        now,
      ),
    ).toBeUndefined();
  });

  it('never waits longer than a timer can', () => {
    // setTimeout fires at once past 2^31 - 1 ms, about 24.8 days.
    const delay = nextRefreshDelay(
      [makeMockSchedule('yearly', { nextRunAt: '2025-01-08T13:00:00Z' })],
      now,
    );
    expect(delay).toBe(6 * 60 * 60_000);
  });
});
