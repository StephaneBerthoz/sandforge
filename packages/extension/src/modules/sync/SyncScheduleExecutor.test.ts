import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncScheduleExecutor } from './SyncScheduleExecutor';
import type { SyncScheduleExecutorDeps } from './SyncScheduleExecutor';
import type { SyncScheduleEntry, SyncConfig, SyncExecutionResult } from '@sandforge/shared';

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
    dryRun: false,
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
    scheduleStore: {
      loadAll: vi.fn(() => []),
      save: vi.fn(),
      load: vi.fn(),
      delete: vi.fn(() => true),
      list: vi.fn(() => []),
    },
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
  });

  describe('tick', () => {
    it('should execute a due schedule and update lastRunAt/nextRunAt', async () => {
      const entry = createScheduleEntry({
        nextRunAt: '2026-03-27T09:00:00.000Z',
        enabled: true,
      });
      deps = createMockDeps({
        scheduleStore: {
          loadAll: vi.fn(() => [entry]),
          save: vi.fn(),
          load: vi.fn(),
          delete: vi.fn(() => true),
          list: vi.fn(() => [entry]),
        },
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

    it('should skip disabled schedules', async () => {
      const entry = createScheduleEntry({
        enabled: false,
        nextRunAt: '2026-03-27T09:00:00.000Z',
      });
      deps = createMockDeps({
        scheduleStore: {
          loadAll: vi.fn(() => [entry]),
          save: vi.fn(),
          load: vi.fn(),
          delete: vi.fn(() => true),
          list: vi.fn(() => [entry]),
        },
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
        scheduleStore: {
          loadAll: vi.fn(() => [entry]),
          save: vi.fn(),
          load: vi.fn(),
          delete: vi.fn(() => true),
          list: vi.fn(() => [entry]),
        },
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
        scheduleStore: {
          loadAll: vi.fn(() => [entry]),
          save: storeSave,
          load: vi.fn(),
          delete: vi.fn(() => true),
          list: vi.fn(() => [entry]),
        },
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
        scheduleStore: {
          loadAll: vi.fn(() => [entry]),
          save: vi.fn(),
          load: vi.fn(),
          delete: vi.fn(() => true),
          list: vi.fn(() => [entry]),
        },
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
        scheduleStore: {
          loadAll: vi.fn(() => [entry]),
          save: vi.fn(),
          load: vi.fn(),
          delete: vi.fn(() => true),
          list: vi.fn(() => [entry]),
        },
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
        scheduleStore: {
          loadAll: vi.fn(() => []),
          save: vi.fn(),
          load: vi.fn(),
          delete: vi.fn(() => true),
          list: vi.fn(() => []),
        },
      });
      executor = new SyncScheduleExecutor(deps);

      executor.start();
      executor.start();

      expect(deps.scheduleStore.loadAll).toHaveBeenCalledTimes(1);
    });
  });
});
