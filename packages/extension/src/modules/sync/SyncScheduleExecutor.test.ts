import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncScheduleExecutor } from './SyncScheduleExecutor';
import type { SyncScheduleExecutorDeps } from './SyncScheduleExecutor';
import type { SyncScheduleStore } from './SyncScheduleStore';
import type { SyncScheduleEntry, SyncConfig, SyncExecutionResult } from '@sandforge/shared';
import { memoryTriggerClaims } from '../automation/TriggerClaims';

/** Fixed "now" time for deterministic tests: 2026-03-27T12:00:00Z */
const FIXED_NOW = new Date('2026-03-27T12:00:00Z').getTime();

function createScheduleEntry(overrides?: Partial<SyncScheduleEntry>): SyncScheduleEntry {
  return {
    id: 'sched-1',
    name: 'Daily Account Sync',
    configId: 'cfg-1',
    cron: '0 9 * * 1',
    timezone: 'UTC',
    enabled: true,
    maxRetries: 3,
    notifyOnComplete: false,
    notifyOnFailure: false,
    nextRunAt: '2026-03-27T09:00:00.000Z',
    createdAt: '2026-03-20T00:00:00Z',
    updatedAt: '2026-03-20T00:00:00Z',
    version: 1,
    ...overrides,
  };
}

function createSyncConfig(overrides?: Partial<SyncConfig>): SyncConfig {
  return {
    id: 'cfg-1',
    name: 'Test Config',
    description: 'Test',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    direction: 'source_to_target',
    mode: 'full',
    objects: [],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
    ...overrides,
  };
}

function createSuccessResult(): SyncExecutionResult {
  return {
    configId: 'cfg-1',
    operationId: 'op-1',
    status: 'success',
    objectResults: [],
    totalProcessed: 100,
    totalSuccess: 100,
    totalFailed: 0,
    totalSkipped: 0,
    duration: 5000,
    timestamp: '2026-03-27T12:00:05Z',
  };
}

function createMockDeps(overrides?: Partial<SyncScheduleExecutorDeps>): SyncScheduleExecutorDeps {
  return {
    // Partial mock: SyncScheduleStore's private configStore ctor member can't be structurally mocked
    scheduleStore: {
      loadAll: vi.fn(() => []),
      save: vi.fn(),
      load: vi.fn(),
      delete: vi.fn(() => true),
      list: vi.fn(() => []),
    } as unknown as SyncScheduleStore,
    configStore: {
      load: vi.fn(() => createSyncConfig()),
    },
    onExecute: vi.fn(async () => createSuccessResult()),
    notificationCenter: {
      notify: vi.fn(),
    },
    log: vi.fn(),
    now: vi.fn(() => FIXED_NOW),
    ...overrides,
  };
}

describe('SyncScheduleExecutor', () => {
  let executor: SyncScheduleExecutor;
  let deps: SyncScheduleExecutorDeps;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-27T12:00:00Z'));
    deps = createMockDeps();
    executor = new SyncScheduleExecutor(deps);
  });

  afterEach(() => {
    executor.stop();
    vi.useRealTimers();
  });

  describe('upsert', () => {
    it('should create a schedule with computed nextRunAt from cron-parser', () => {
      const entry = executor.upsert({
        id: 'sched-1',
        name: 'Monday 9am Sync',
        configId: 'cfg-1',
        cron: '0 9 * * 1',
        timezone: 'UTC',
        enabled: true,
        maxRetries: 3,
        notifyOnComplete: false,
        notifyOnFailure: false,
        createdAt: '2026-03-20T00:00:00Z',
        updatedAt: '2026-03-20T00:00:00Z',
        version: 1,
      });

      expect(entry.nextRunAt).toBeDefined();
      expect(entry.nextRunAt).not.toBe('');
      const nextDate = new Date(entry.nextRunAt!);
      expect(nextDate.getUTCDay()).toBe(1);
      expect(nextDate.getUTCHours()).toBe(9);
      expect(nextDate.getUTCMinutes()).toBe(0);
      expect(nextDate.getTime()).toBeGreaterThan(FIXED_NOW);
    });

    it('should preserve lastRunAt and lastResult when updating existing schedule', () => {
      executor.upsert(
        createScheduleEntry({
          id: 'sched-1',
          lastRunAt: undefined,
          lastResult: undefined,
        }),
      );

      const schedule = executor.getSchedule('sched-1')!;
      schedule.lastRunAt = '2026-03-26T09:00:00Z';
      schedule.lastResult = 'success';

      const updated = executor.upsert({
        id: 'sched-1',
        name: 'Updated Name',
        configId: 'cfg-1',
        cron: '0 9 * * 1',
        timezone: 'UTC',
        enabled: true,
        maxRetries: 3,
        notifyOnComplete: false,
        notifyOnFailure: false,
        createdAt: '2026-03-20T00:00:00Z',
        updatedAt: '2026-03-27T00:00:00Z',
        version: 2,
      });

      expect(updated.lastRunAt).toBe('2026-03-26T09:00:00Z');
      expect(updated.lastResult).toBe('success');
    });

    it('gives a schedule on a day its months do not have no next run, rather than one decades away', () => {
      // The parser accepts each field of `0 0 31 2,4 *`; unbounded, it answered 2054.
      const entry = executor.upsert(createScheduleEntry({ cron: '0 0 31 2,4 *' }));

      expect(entry.nextRunAt).toBe('');
      expect(deps.log).toHaveBeenCalledWith(
        expect.stringContaining('No date in the coming year matches this cron expression'),
      );
    });
  });

  describe('tick', () => {
    it('should execute a due schedule and update lastRunAt/nextRunAt', async () => {
      const entry = createScheduleEntry({
        nextRunAt: '2026-03-27T09:00:00.000Z',
        enabled: true,
      });
      deps = createMockDeps({
        // Partial mock: SyncScheduleStore's private configStore ctor member can't be structurally mocked
        scheduleStore: {
          loadAll: vi.fn(() => [entry]),
          save: vi.fn(),
          load: vi.fn(),
          delete: vi.fn(() => true),
          list: vi.fn(() => [entry]),
        } as unknown as SyncScheduleStore,
      });
      executor = new SyncScheduleExecutor(deps);
      executor.start();

      await executor.tick();

      expect(deps.onExecute).toHaveBeenCalledTimes(1);
      const saved = executor.getSchedule('sched-1')!;
      expect(saved.lastRunAt).toBeDefined();
      expect(saved.lastResult).toBe('success');
      expect(saved.nextRunAt).toBeDefined();
      expect(new Date(saved.nextRunAt!).getTime()).toBeGreaterThan(FIXED_NOW);
    });

    it('marks a schedule whose configuration is gone as failed, once, and says so', async () => {
      // The configuration a schedule names can be deleted, or never saved at
      // all. Skipping the tick left nextRunAt in the past, so the same
      // schedule came up due every 60 s, wrote one more log line nobody reads
      // and still showed as active with no last result.
      const entry = createScheduleEntry({
        nextRunAt: '2026-03-27T09:00:00.000Z',
        enabled: true,
        notifyOnFailure: true,
      });
      const storeSave = vi.fn();
      deps = createMockDeps({
        // Partial mock: SyncScheduleStore's private configStore ctor member can't be structurally mocked
        scheduleStore: {
          loadAll: vi.fn(() => [entry]),
          save: storeSave,
          load: vi.fn(),
          delete: vi.fn(() => true),
          list: vi.fn(() => [entry]),
        } as unknown as SyncScheduleStore,
        configStore: { load: vi.fn(() => undefined) },
      });
      executor = new SyncScheduleExecutor(deps);
      executor.start();

      await executor.tick();

      expect(deps.onExecute).not.toHaveBeenCalled();
      const saved = executor.getSchedule('sched-1')!;
      expect(saved.lastResult).toBe('failure');
      expect(saved.lastRunAt).toBeDefined();
      expect(new Date(saved.nextRunAt!).getTime()).toBeGreaterThan(FIXED_NOW);
      expect(storeSave).toHaveBeenCalledTimes(1);
      const notify = deps.notificationCenter.notify as ReturnType<typeof vi.fn>;
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0][0]).toBe('error');
      expect(String(notify.mock.calls[0][2])).toContain('cfg-1');

      // Next tick: the schedule is no longer due, so nothing is said twice.
      notify.mockClear();
      await executor.tick();
      expect(notify).not.toHaveBeenCalled();
    });

    it('should skip disabled schedules', async () => {
      const entry = createScheduleEntry({
        enabled: false,
        nextRunAt: '2026-03-27T09:00:00.000Z',
      });
      deps = createMockDeps({
        // Partial mock: SyncScheduleStore's private configStore ctor member can't be structurally mocked
        scheduleStore: {
          loadAll: vi.fn(() => [entry]),
          save: vi.fn(),
          load: vi.fn(),
          delete: vi.fn(() => true),
          list: vi.fn(() => [entry]),
        } as unknown as SyncScheduleStore,
      });
      executor = new SyncScheduleExecutor(deps);
      executor.start();

      await executor.tick();

      expect(deps.onExecute).not.toHaveBeenCalled();
    });

    it('should skip schedules whose nextRunAt is in the future', async () => {
      const entry = createScheduleEntry({
        nextRunAt: '2026-03-28T09:00:00.000Z',
        enabled: true,
      });
      deps = createMockDeps({
        // Partial mock: SyncScheduleStore's private configStore ctor member can't be structurally mocked
        scheduleStore: {
          loadAll: vi.fn(() => [entry]),
          save: vi.fn(),
          load: vi.fn(),
          delete: vi.fn(() => true),
          list: vi.fn(() => [entry]),
        } as unknown as SyncScheduleStore,
      });
      executor = new SyncScheduleExecutor(deps);
      executor.start();

      await executor.tick();

      expect(deps.onExecute).not.toHaveBeenCalled();
    });

    it('should execute overdue schedule exactly once on sleep-wake (not once per missed interval)', async () => {
      const threeHoursAgo = FIXED_NOW - 3 * 60 * 60 * 1000;
      const entry = createScheduleEntry({
        nextRunAt: new Date(threeHoursAgo).toISOString(),
        enabled: true,
      });

      const storeSave = vi.fn();
      deps = createMockDeps({
        // Partial mock: SyncScheduleStore's private configStore ctor member can't be structurally mocked
        scheduleStore: {
          loadAll: vi.fn(() => [entry]),
          save: storeSave,
          load: vi.fn(),
          delete: vi.fn(() => true),
          list: vi.fn(() => [entry]),
        } as unknown as SyncScheduleStore,
        now: vi.fn(() => FIXED_NOW),
      });
      executor = new SyncScheduleExecutor(deps);
      executor.start();

      // Simulate sleep-wake: set lastTickTime to 3 hours ago
      (executor as unknown as { lastTickTime: number }).lastTickTime = threeHoursAgo;

      await executor.tick();

      // Should execute exactly once despite 3 hours of missed ticks
      expect(deps.onExecute).toHaveBeenCalledTimes(1);
      expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('sleep-wake detected'));
    });
  });

  describe('two windows', () => {
    /** One window's executor over the schedules every window stores, with the claims they share. */
    function windowWith(
      entry: SyncScheduleEntry,
      claims: ReturnType<typeof memoryTriggerClaims>,
    ): SyncScheduleExecutorDeps {
      return createMockDeps({
        // Partial mock: SyncScheduleStore's private configStore ctor member can't be structurally mocked
        scheduleStore: {
          loadAll: vi.fn(() => [{ ...entry }]),
          save: vi.fn(),
          load: vi.fn(),
          delete: vi.fn(() => true),
          list: vi.fn(() => [entry]),
        } as unknown as SyncScheduleStore,
        claims,
      });
    }

    it('runs a due schedule once, in the window that claims it', async () => {
      // Every window runs its own tick loop over the same schedules. A sync
      // writes, so a schedule due with two windows open wrote twice.
      const entry = createScheduleEntry({ nextRunAt: '2026-03-27T09:00:00.000Z' });
      const claims = memoryTriggerClaims();
      const first = windowWith(entry, claims);
      const second = windowWith(entry, claims);
      const executors = [new SyncScheduleExecutor(first), new SyncScheduleExecutor(second)];
      for (const each of executors) each.start();

      await Promise.all(executors.map((each) => each.tick()));

      expect(vi.mocked(first.onExecute).mock.calls.length).toBe(1);
      expect(vi.mocked(second.onExecute)).not.toHaveBeenCalled();
      // The other window moves on to the next start, without writing over the
      // result the first one records.
      const other = executors[1].getSchedule('sched-1')!;
      expect(new Date(other.nextRunAt!).getTime()).toBeGreaterThan(FIXED_NOW);
      expect(second.scheduleStore.save).not.toHaveBeenCalled();
      for (const each of executors) each.stop();
    });

    it('lets each window run the starts it claims', async () => {
      const entry = createScheduleEntry({ nextRunAt: '2026-03-27T09:00:00.000Z' });
      const claims = memoryTriggerClaims();
      const first = windowWith(entry, claims);
      const executor = new SyncScheduleExecutor(first);
      executor.start();
      await executor.tick();

      // The next start is a new claim: the window that lost the last one may win it.
      const later = windowWith(
        createScheduleEntry({ nextRunAt: '2026-03-27T11:00:00.000Z' }),
        claims,
      );
      const other = new SyncScheduleExecutor(later);
      other.start();
      await other.tick();

      expect(first.onExecute).toHaveBeenCalledTimes(1);
      expect(later.onExecute).toHaveBeenCalledTimes(1);
      executor.stop();
      other.stop();
    });
  });

  describe('toggle', () => {
    it('should re-enable a schedule and recompute nextRunAt', () => {
      executor.upsert(createScheduleEntry({ enabled: false }));

      const toggled = executor.toggle('sched-1', true);

      expect(toggled).toBeDefined();
      expect(toggled!.enabled).toBe(true);
      expect(toggled!.nextRunAt).toBeDefined();
      expect(toggled!.nextRunAt).not.toBe('');
      expect(new Date(toggled!.nextRunAt!).getTime()).toBeGreaterThan(FIXED_NOW);
    });

    it('should return undefined for non-existent schedule', () => {
      expect(executor.toggle('non-existent', true)).toBeUndefined();
    });
  });

  describe('delete', () => {
    it('should remove schedule from map and store', () => {
      executor.upsert(createScheduleEntry());

      const result = executor.delete('sched-1');

      expect(result).toBe(true);
      expect(executor.getSchedule('sched-1')).toBeUndefined();
      expect(deps.scheduleStore.delete).toHaveBeenCalledWith('sched-1');
    });

    it('should return false when deleting non-existent schedule', () => {
      expect(executor.delete('non-existent')).toBe(false);
    });
  });

  describe('notifications', () => {
    it('should notify on execution success when notifyOnComplete is true', async () => {
      const entry = createScheduleEntry({
        notifyOnComplete: true,
        nextRunAt: '2026-03-27T09:00:00.000Z',
      });
      deps = createMockDeps({
        // Partial mock: SyncScheduleStore's private configStore ctor member can't be structurally mocked
        scheduleStore: {
          loadAll: vi.fn(() => [entry]),
          save: vi.fn(),
          load: vi.fn(),
          delete: vi.fn(() => true),
          list: vi.fn(() => [entry]),
        } as unknown as SyncScheduleStore,
      });
      executor = new SyncScheduleExecutor(deps);
      executor.start();

      await executor.tick();

      expect(deps.notificationCenter.notify).toHaveBeenCalledWith(
        'info',
        'Sync schedule started',
        'Daily Account Sync',
      );
      expect(deps.notificationCenter.notify).toHaveBeenCalledWith(
        'success',
        'Sync schedule completed',
        'Daily Account Sync',
      );
    });

    it('should notify on execution failure when notifyOnFailure is true', async () => {
      const entry = createScheduleEntry({
        notifyOnFailure: true,
        nextRunAt: '2026-03-27T09:00:00.000Z',
      });
      const failingExecute = vi.fn(async () => {
        throw new Error('Connection timeout');
      });
      deps = createMockDeps({
        // Partial mock: SyncScheduleStore's private configStore ctor member can't be structurally mocked
        scheduleStore: {
          loadAll: vi.fn(() => [entry]),
          save: vi.fn(),
          load: vi.fn(),
          delete: vi.fn(() => true),
          list: vi.fn(() => [entry]),
        } as unknown as SyncScheduleStore,
        onExecute: failingExecute,
      });
      executor = new SyncScheduleExecutor(deps);
      executor.start();

      await executor.tick();

      expect(deps.notificationCenter.notify).toHaveBeenCalledWith(
        'error',
        'Sync schedule failed',
        'Daily Account Sync: Connection timeout',
      );
    });
  });

  describe('a run that resolves as failed', () => {
    it('says it failed rather than completed, with the first error it reports', async () => {
      // The sync engine turns a failed run into a result with status
      // 'failure' instead of rejecting, so a connection or Bulk API failure
      // reaches the executor as a resolved run.
      const entry = createScheduleEntry({
        notifyOnComplete: true,
        notifyOnFailure: true,
        nextRunAt: '2026-03-27T09:00:00.000Z',
      });
      const failedRun: SyncExecutionResult = {
        ...createSuccessResult(),
        status: 'failure',
        totalSuccess: 0,
        totalFailed: 100,
        objectResults: [
          {
            objectApiName: 'Account',
            operation: 'upsert',
            processed: 100,
            success: 0,
            failed: 100,
            skipped: 0,
            conflictCount: 0,
            errors: ['INVALID_SESSION_ID'],
          },
        ],
      };
      deps = createMockDeps({
        // Partial mock: SyncScheduleStore's private configStore ctor member can't be structurally mocked
        scheduleStore: {
          loadAll: vi.fn(() => [entry]),
          save: vi.fn(),
          load: vi.fn(),
          delete: vi.fn(() => true),
          list: vi.fn(() => [entry]),
        } as unknown as SyncScheduleStore,
        onExecute: vi.fn(async () => failedRun),
      });
      executor = new SyncScheduleExecutor(deps);
      executor.start();

      await executor.tick();

      expect(deps.notificationCenter.notify).not.toHaveBeenCalledWith(
        'success',
        'Sync schedule completed',
        expect.anything(),
      );
      expect(deps.notificationCenter.notify).toHaveBeenCalledWith(
        'error',
        'Sync schedule failed',
        'Daily Account Sync: INVALID_SESSION_ID',
      );
      expect(entry.lastResult).toBe('failure');
    });

    it('stays quiet about a failed run when only completion was asked for', async () => {
      const entry = createScheduleEntry({
        notifyOnComplete: true,
        notifyOnFailure: false,
        nextRunAt: '2026-03-27T09:00:00.000Z',
      });
      deps = createMockDeps({
        // Partial mock: SyncScheduleStore's private configStore ctor member can't be structurally mocked
        scheduleStore: {
          loadAll: vi.fn(() => [entry]),
          save: vi.fn(),
          load: vi.fn(),
          delete: vi.fn(() => true),
          list: vi.fn(() => [entry]),
        } as unknown as SyncScheduleStore,
        onExecute: vi.fn(async () => ({ ...createSuccessResult(), status: 'failure' as const })),
      });
      executor = new SyncScheduleExecutor(deps);
      executor.start();

      await executor.tick();

      const levels = vi.mocked(deps.notificationCenter.notify).mock.calls.map((call) => call[0]);
      expect(levels).toEqual(['info']);
    });

    it('announces a run in which some records failed as a warning, not a success', async () => {
      const entry = createScheduleEntry({
        notifyOnComplete: true,
        notifyOnFailure: false,
        nextRunAt: '2026-03-27T09:00:00.000Z',
      });
      const partialRun: SyncExecutionResult = {
        ...createSuccessResult(),
        status: 'partial',
        totalSuccess: 98,
        totalFailed: 2,
        objectResults: [
          {
            objectApiName: 'Contact',
            operation: 'upsert',
            processed: 100,
            success: 98,
            failed: 2,
            skipped: 0,
            conflictCount: 0,
            errors: ['REQUIRED_FIELD_MISSING: LastName'],
          },
        ],
      };
      deps = createMockDeps({
        // Partial mock: SyncScheduleStore's private configStore ctor member can't be structurally mocked
        scheduleStore: {
          loadAll: vi.fn(() => [entry]),
          save: vi.fn(),
          load: vi.fn(),
          delete: vi.fn(() => true),
          list: vi.fn(() => [entry]),
        } as unknown as SyncScheduleStore,
        onExecute: vi.fn(async () => partialRun),
      });
      executor = new SyncScheduleExecutor(deps);
      executor.start();

      await executor.tick();

      expect(deps.notificationCenter.notify).not.toHaveBeenCalledWith(
        'success',
        expect.anything(),
        expect.anything(),
      );
      expect(deps.notificationCenter.notify).toHaveBeenCalledWith(
        'warning',
        'Sync schedule completed with errors',
        'Daily Account Sync: REQUIRED_FIELD_MISSING: LastName',
      );
      expect(entry.lastResult).toBe('partial');
    });

    it('announces a run cancelled from Live Operations as cancelled, not as one with errors', async () => {
      const entry = createScheduleEntry({
        notifyOnComplete: true,
        notifyOnFailure: true,
        nextRunAt: '2026-03-27T09:00:00.000Z',
      });
      const cancelledRun: SyncExecutionResult = {
        ...createSuccessResult(),
        status: 'partial',
        cancelled: true,
        error: 'Cancelled before Contact was synced.',
        totalProcessed: 40,
        totalSuccess: 40,
      };
      deps = createMockDeps({
        // Partial mock: SyncScheduleStore's private configStore ctor member can't be structurally mocked
        scheduleStore: {
          loadAll: vi.fn(() => [entry]),
          save: vi.fn(),
          load: vi.fn(),
          delete: vi.fn(() => true),
          list: vi.fn(() => [entry]),
        } as unknown as SyncScheduleStore,
        onExecute: vi.fn(async () => cancelledRun),
      });
      executor = new SyncScheduleExecutor(deps);
      executor.start();

      await executor.tick();

      expect(vi.mocked(deps.notificationCenter.notify).mock.calls.slice(1)).toEqual([
        [
          'info',
          'Sync schedule cancelled',
          'Daily Account Sync: Cancelled before Contact was synced. Its entry in the sync history has what it wrote.',
        ],
      ]);
      // Stored as its partial status, the schedule's badge read "Partial".
      expect(entry.lastResult).toBe('cancelled');
    });
  });

  describe('getSchedules', () => {
    it('should return all schedules', () => {
      executor.upsert(createScheduleEntry({ id: 'sched-1' }));
      executor.upsert(createScheduleEntry({ id: 'sched-2', name: 'Second' }));

      expect(executor.getSchedules()).toHaveLength(2);
    });
  });

  describe('start/stop', () => {
    it('should be idempotent when calling start multiple times', () => {
      deps = createMockDeps({
        // Partial mock: SyncScheduleStore's private configStore ctor member can't be structurally mocked
        scheduleStore: {
          loadAll: vi.fn(() => []),
          save: vi.fn(),
          load: vi.fn(),
          delete: vi.fn(() => true),
          list: vi.fn(() => []),
        } as unknown as SyncScheduleStore,
      });
      executor = new SyncScheduleExecutor(deps);

      executor.start();
      executor.start();

      expect(deps.scheduleStore.loadAll).toHaveBeenCalledTimes(1);
    });
  });

  describe('a schedule saved before the search for its next run was bounded', () => {
    /** `0 0 31 2,4 *` as 1.35 saved it: the unbounded search answered 2054. */
    const saved = (): SyncScheduleEntry =>
      createScheduleEntry({ cron: '0 0 31 2,4 *', nextRunAt: '2054-02-07T00:00:00.000Z' });

    /** A window opening on the schedules the store holds. */
    function open(stored: SyncScheduleEntry[]): SyncScheduleExecutor {
      deps = createMockDeps();
      vi.mocked(deps.scheduleStore.loadAll).mockReturnValue(stored);
      const opened = new SyncScheduleExecutor(deps);
      opened.start();
      opened.stop();
      return opened;
    }

    it('has its next run computed again when it is loaded, and saved', () => {
      const opened = open([saved()]);

      expect(opened.getSchedule('sched-1')?.nextRunAt).toBe('');
      expect(deps.scheduleStore.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'sched-1', nextRunAt: '' }),
      );
    });

    it('is corrected once: the next window loads the corrected schedule as it is', () => {
      const [corrected] = open([saved()]).getSchedules();

      open([corrected]);

      expect(deps.scheduleStore.save).not.toHaveBeenCalled();
    });

    it('keeps a next run in the past, a start missed while no window was open', () => {
      const missed = createScheduleEntry({ nextRunAt: '2026-03-23T09:00:00.000Z' });

      const opened = open([missed]);

      expect(opened.getSchedule('sched-1')?.nextRunAt).toBe('2026-03-23T09:00:00.000Z');
      expect(deps.scheduleStore.save).not.toHaveBeenCalled();
    });

    it('keeps a yearly schedule’s next run, however far into the year', () => {
      const yearly = createScheduleEntry({
        cron: '0 0 1 3 *',
        nextRunAt: '2027-03-01T00:00:00.000Z',
      });

      const opened = open([yearly]);

      expect(opened.getSchedule('sched-1')?.nextRunAt).toBe('2027-03-01T00:00:00.000Z');
      expect(deps.scheduleStore.save).not.toHaveBeenCalled();
    });
  });

  describe('a schedule whose stored next run cannot be read', () => {
    it('runs nothing on it, and has it computed again and saved, once', async () => {
      // `new Date('not a date')` is NaN, which no time is greater than: the
      // tick read the schedule as due and started a sync.
      deps = createMockDeps();
      vi.mocked(deps.scheduleStore.loadAll).mockReturnValue([
        createScheduleEntry({ nextRunAt: 'not a date' }),
      ]);
      executor = new SyncScheduleExecutor(deps);
      executor.start();

      await executor.tick();

      expect(deps.onExecute).not.toHaveBeenCalled();
      const replanned = executor.getSchedule('sched-1')!;
      // `0 9 * * 1` from Friday 2026-03-27 12:00: the Monday after.
      expect(replanned.nextRunAt).toBe('2026-03-30T09:00:00.000Z');
      expect(deps.scheduleStore.save).toHaveBeenCalledTimes(1);
      expect(deps.scheduleStore.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'sched-1', nextRunAt: '2026-03-30T09:00:00.000Z' }),
      );

      await executor.tick();

      expect(deps.onExecute).not.toHaveBeenCalled();
      expect(deps.scheduleStore.save).toHaveBeenCalledTimes(1);
    });

    it('lists the next run computed again as soon as the schedules are loaded, before any tick', () => {
      // The list is read from the loaded schedules. Kept as stored until the
      // first tick, the next run reached the Sync tab unreadable, and its
      // schedules did not render for up to a minute.
      deps = createMockDeps();
      vi.mocked(deps.scheduleStore.loadAll).mockReturnValue([
        createScheduleEntry({ nextRunAt: 'not a date' }),
      ]);
      executor = new SyncScheduleExecutor(deps);

      executor.start();

      expect(executor.getSchedules().map((s) => s.nextRunAt)).toEqual(['2026-03-30T09:00:00.000Z']);
      expect(deps.scheduleStore.save).toHaveBeenCalledTimes(1);
      expect(deps.log).toHaveBeenCalledWith(
        '[SyncScheduleExecutor] sched-1: next run "not a date" cannot be read, replaced by 2026-03-30T09:00:00.000Z',
      );
    });

    it('keeps a schedule with no next run as it is', () => {
      // An expression with no run in the coming year is stored with none.
      deps = createMockDeps();
      vi.mocked(deps.scheduleStore.loadAll).mockReturnValue([
        createScheduleEntry({ nextRunAt: '' }),
      ]);
      executor = new SyncScheduleExecutor(deps);

      executor.start();

      expect(executor.getSchedule('sched-1')?.nextRunAt).toBe('');
      expect(deps.scheduleStore.save).not.toHaveBeenCalled();
    });
  });
});
