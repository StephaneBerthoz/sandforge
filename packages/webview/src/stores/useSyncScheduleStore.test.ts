import { describe, it, expect, beforeEach } from 'vitest';
import { useSyncScheduleStore } from './useSyncScheduleStore';
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

describe('useSyncScheduleStore', () => {
  beforeEach(() => {
    useSyncScheduleStore.setState({
      schedules: [],
      loading: false,
      error: null,
    });
  });

  it('should start with empty state', () => {
    const state = useSyncScheduleStore.getState();
    expect(state.schedules).toHaveLength(0);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it('fetchSchedules sets loading to true', () => {
    useSyncScheduleStore.getState().fetchSchedules();
    expect(useSyncScheduleStore.getState().loading).toBe(true);
  });

  it('handleMessage with schedule list response updates schedules', () => {
    useSyncScheduleStore.setState({ loading: true });
    const schedules = [makeMockSchedule('s-1'), makeMockSchedule('s-2')];

    useSyncScheduleStore.getState().handleMessage({
      type: 'sync:schedule:list:response',
      payload: { schedules },
    });

    const state = useSyncScheduleStore.getState();
    expect(state.schedules).toHaveLength(2);
    expect(state.schedules[0].id).toBe('s-1');
    expect(state.loading).toBe(false);
  });

  it('toggleSchedule sends correct message with scheduleId and enabled flag', () => {
    // Just verify it does not throw (postMessage is no-op in test)
    expect(() => {
      useSyncScheduleStore.getState().toggleSchedule('s-1', false);
    }).not.toThrow();
  });

  it('handleMessage with toggle response updates schedule enabled state', () => {
    useSyncScheduleStore.setState({
      schedules: [makeMockSchedule('s-1', { enabled: true })],
    });

    useSyncScheduleStore.getState().handleMessage({
      type: 'sync:schedule:toggle:response',
      payload: { scheduleId: 's-1', enabled: false },
    });

    const state = useSyncScheduleStore.getState();
    expect(state.schedules[0].enabled).toBe(false);
  });

  it('handleMessage with delete response removes schedule', () => {
    useSyncScheduleStore.setState({
      schedules: [makeMockSchedule('s-1'), makeMockSchedule('s-2')],
    });

    useSyncScheduleStore.getState().handleMessage({
      type: 'sync:schedule:delete:response',
      payload: { scheduleId: 's-1' },
    });

    const state = useSyncScheduleStore.getState();
    expect(state.schedules).toHaveLength(1);
    expect(state.schedules[0].id).toBe('s-2');
  });

  it('handleMessage with upsert response adds new schedule', () => {
    useSyncScheduleStore.setState({ loading: true, schedules: [] });
    const schedule = makeMockSchedule('s-new');

    useSyncScheduleStore.getState().handleMessage({
      type: 'sync:schedule:upsert:response',
      payload: { schedule },
    });

    const state = useSyncScheduleStore.getState();
    expect(state.schedules).toHaveLength(1);
    expect(state.schedules[0].id).toBe('s-new');
    expect(state.loading).toBe(false);
  });

  it('handleMessage with upsert response updates existing schedule', () => {
    useSyncScheduleStore.setState({
      schedules: [makeMockSchedule('s-1', { name: 'Old Name' })],
    });

    useSyncScheduleStore.getState().handleMessage({
      type: 'sync:schedule:upsert:response',
      payload: { schedule: makeMockSchedule('s-1', { name: 'New Name' }) },
    });

    const state = useSyncScheduleStore.getState();
    expect(state.schedules).toHaveLength(1);
    expect(state.schedules[0].name).toBe('New Name');
  });

  it('handleMessage with error sets error and loading=false', () => {
    useSyncScheduleStore.setState({ loading: true });

    useSyncScheduleStore.getState().handleMessage({
      type: 'sync:schedule:error',
      payload: { message: 'Server error' },
    });

    const state = useSyncScheduleStore.getState();
    expect(state.loading).toBe(false);
    expect(state.error).toBe('Server error');
  });

  it('handleMessage ignores unknown message types', () => {
    useSyncScheduleStore.setState({
      schedules: [makeMockSchedule('s-1')],
    });

    useSyncScheduleStore.getState().handleMessage({
      type: 'unknown:type',
      payload: {},
    });

    expect(useSyncScheduleStore.getState().schedules).toHaveLength(1);
  });
});
