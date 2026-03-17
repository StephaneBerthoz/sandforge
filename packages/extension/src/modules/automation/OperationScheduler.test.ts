import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OperationScheduler } from './OperationScheduler';
import type { OperationSchedulerDeps, OperationExecutionResult } from './OperationScheduler';
import type { ScheduledOperation } from '@sandforge/shared';

function createMockDeps(overrides?: Partial<OperationSchedulerDeps>): OperationSchedulerDeps {
  const store = new Map<string, unknown>();
  return {
    configStore: {
      get: vi.fn(<T>(key: string): T | undefined => store.get(key) as T | undefined),
      set: vi.fn(<T>(key: string, value: T): void => { store.set(key, value); }),
    },
    log: vi.fn(),
    onExecute: vi.fn<(schedule: ScheduledOperation) => Promise<OperationExecutionResult>>().mockResolvedValue({
      success: true,
      recordsProcessed: 42,
    }),
    ...overrides,
  };
}

function makeScheduleInput() {
  return {
    id: 'sched-1',
    operationType: 'backup' as const,
    frequency: 'daily' as const,
    time: '02:00',
    enabled: true,
  };
}

describe('OperationScheduler', () => {
  let scheduler: OperationScheduler;
  let deps: OperationSchedulerDeps;

  beforeEach(() => {
    vi.useFakeTimers();
    deps = createMockDeps();
    scheduler = new OperationScheduler(deps);
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  describe('upsert', () => {
    it('should create a new schedule and compute nextRunAt', () => {
      const result = scheduler.upsert(makeScheduleInput());
      expect(result.id).toBe('sched-1');
      expect(result.nextRunAt).toBeDefined();
      expect(result.operationType).toBe('backup');
    });

    it('should update an existing schedule', () => {
      scheduler.upsert(makeScheduleInput());
      const updated = scheduler.upsert({ ...makeScheduleInput(), frequency: 'weekly', dayOfWeek: 3 });
      expect(updated.frequency).toBe('weekly');
      expect(scheduler.getSchedules()).toHaveLength(1);
    });

    it('should persist to config store', () => {
      scheduler.upsert(makeScheduleInput());
      expect(deps.configStore.set).toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('should remove an existing schedule', () => {
      scheduler.upsert(makeScheduleInput());
      const result = scheduler.delete('sched-1');
      expect(result).toBe(true);
      expect(scheduler.getSchedules()).toHaveLength(0);
    });

    it('should return false for non-existent schedule', () => {
      expect(scheduler.delete('non-existent')).toBe(false);
    });
  });

  describe('toggle', () => {
    it('should toggle a schedule on/off', () => {
      scheduler.upsert(makeScheduleInput());
      const result = scheduler.toggle('sched-1', false);
      expect(result?.enabled).toBe(false);
    });

    it('should return undefined for non-existent schedule', () => {
      expect(scheduler.toggle('non-existent', true)).toBeUndefined();
    });

    it('should recompute nextRunAt when enabling', () => {
      scheduler.upsert(makeScheduleInput());
      scheduler.toggle('sched-1', false);
      const result = scheduler.toggle('sched-1', true);
      expect(result?.nextRunAt).toBeDefined();
    });
  });

  describe('getSchedules', () => {
    it('should return all schedules', () => {
      scheduler.upsert(makeScheduleInput());
      scheduler.upsert({ ...makeScheduleInput(), id: 'sched-2', operationType: 'sync' });
      expect(scheduler.getSchedules()).toHaveLength(2);
    });

    it('should return empty array when no schedules', () => {
      expect(scheduler.getSchedules()).toEqual([]);
    });
  });

  describe('getHistory', () => {
    it('should return empty history initially', () => {
      expect(scheduler.getHistory()).toEqual([]);
    });
  });

  describe('computeNextRunAt', () => {
    it('should compute next hourly run', () => {
      vi.setSystemTime(new Date('2026-03-13T10:30:00Z'));
      const result = scheduler.computeNextRunAt({ frequency: 'hourly', time: '00:15' });
      const next = new Date(result);
      expect(next.getMinutes()).toBe(15);
      expect(next > new Date('2026-03-13T10:30:00Z')).toBe(true);
    });

    it('should compute next daily run', () => {
      vi.setSystemTime(new Date('2026-03-13T10:00:00Z'));
      const result = scheduler.computeNextRunAt({ frequency: 'daily', time: '02:00' });
      const next = new Date(result);
      expect(next.getDate()).toBe(14);
      expect(next.getHours()).toBe(2);
    });

    it('should compute next weekly run', () => {
      vi.setSystemTime(new Date('2026-03-13T10:00:00Z')); // Friday
      const result = scheduler.computeNextRunAt({ frequency: 'weekly', time: '08:00', dayOfWeek: 1 }); // Monday
      const next = new Date(result);
      expect(next.getDay()).toBe(1);
    });

    it('should compute next monthly run', () => {
      vi.setSystemTime(new Date('2026-03-13T10:00:00Z'));
      const result = scheduler.computeNextRunAt({ frequency: 'monthly', time: '08:00', dayOfMonth: 1 });
      const next = new Date(result);
      expect(next.getDate()).toBe(1);
      expect(next.getMonth()).toBe(3); // April
    });
  });

  describe('tick', () => {
    it('should execute due operations', async () => {
      vi.setSystemTime(new Date('2026-03-13T01:00:00Z'));
      scheduler.upsert(makeScheduleInput());

      // Set nextRunAt to the past
      const stored = scheduler.getSchedule('sched-1');
      if (stored) {
        stored.nextRunAt = new Date('2026-03-13T00:00:00Z').toISOString();
      }

      await scheduler.tick();
      expect(deps.onExecute).toHaveBeenCalledTimes(1);
    });

    it('should not execute disabled schedules', async () => {
      vi.setSystemTime(new Date('2026-03-13T03:00:00Z'));
      scheduler.upsert(makeScheduleInput());
      scheduler.toggle('sched-1', false);

      await scheduler.tick();
      expect(deps.onExecute).not.toHaveBeenCalled();
    });

    it('should record history after execution', async () => {
      vi.setSystemTime(new Date('2026-03-13T03:00:00Z'));
      scheduler.upsert(makeScheduleInput());
      const stored = scheduler.getSchedule('sched-1');
      if (stored) stored.nextRunAt = new Date('2026-03-13T00:00:00Z').toISOString();

      await scheduler.tick();
      const history = scheduler.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe('success');
      expect(history[0].recordsProcessed).toBe(42);
    });

    it('should record failure in history', async () => {
      vi.setSystemTime(new Date('2026-03-13T03:00:00Z'));
      vi.mocked(deps.onExecute).mockRejectedValue(new Error('Connection failed'));
      scheduler.upsert(makeScheduleInput());
      const stored = scheduler.getSchedule('sched-1');
      if (stored) stored.nextRunAt = new Date('2026-03-13T00:00:00Z').toISOString();

      await scheduler.tick();
      const history = scheduler.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe('failure');
      expect(history[0].error).toBe('Connection failed');
    });

    it('should update nextRunAt after execution', async () => {
      vi.setSystemTime(new Date('2026-03-13T03:00:00Z'));
      scheduler.upsert(makeScheduleInput());
      const stored = scheduler.getSchedule('sched-1');
      if (stored) stored.nextRunAt = new Date('2026-03-13T00:00:00Z').toISOString();

      await scheduler.tick();
      const updated = scheduler.getSchedule('sched-1');
      expect(updated?.nextRunAt).toBeDefined();
      expect(new Date(updated!.nextRunAt!).getTime()).toBeGreaterThan(new Date('2026-03-13T03:00:00Z').getTime());
    });
  });

  describe('start/stop', () => {
    it('should start and stop without errors', () => {
      scheduler.start();
      expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('started'));
      scheduler.stop();
      expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('stopped'));
    });

    it('should not create multiple intervals', () => {
      scheduler.start();
      scheduler.start();
      scheduler.stop();
      // If multiple intervals were created, stop would only clear one
    });
  });

  describe('persistence', () => {
    it('should load from config store on construction', () => {
      const store = new Map<string, unknown>();
      store.set('sandforge.scheduler.schedules', [
        { id: 's1', operationType: 'backup', frequency: 'daily', time: '02:00', enabled: true, nextRunAt: '2026-03-14T02:00:00Z' },
      ]);
      store.set('sandforge.scheduler.history', []);

      const loadDeps = createMockDeps({
        configStore: {
          get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
          set: vi.fn(),
        },
      });

      const loaded = new OperationScheduler(loadDeps);
      expect(loaded.getSchedules()).toHaveLength(1);
      expect(loaded.getSchedules()[0].id).toBe('s1');
    });
  });
});
