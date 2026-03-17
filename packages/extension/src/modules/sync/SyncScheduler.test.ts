import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncScheduler } from './SyncScheduler';
import type { SyncConfig, SyncSchedule } from '@sandforge/shared';

function createSchedule(overrides?: Partial<SyncSchedule>): SyncSchedule {
  return {
    enabled: true,
    cron: '0 6 * * *',
    timezone: 'UTC',
    maxRetries: 3,
    notifyOnFailure: true,
    ...overrides,
  };
}

function createConfig(overrides?: Partial<SyncConfig>): SyncConfig {
  return {
    id: 'config-1',
    name: 'Daily Sync',
    description: 'Sync accounts daily',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    direction: 'source_to_target',
    mode: 'incremental',
    objects: [],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    dryRun: false,
    schedule: createSchedule(),
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('SyncScheduler', () => {
  let scheduler: SyncScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-20T10:00:00Z'));
    scheduler = new SyncScheduler();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('schedule', () => {
    it('should create a scheduled sync with unique ID', () => {
      const result = scheduler.schedule(createConfig());

      expect(result.syncId).toBe('sync-1');
      expect(result.configId).toBe('config-1');
    });

    it('should assign incremental sync IDs', () => {
      const first = scheduler.schedule(createConfig({ id: 'c1' }));
      const second = scheduler.schedule(createConfig({ id: 'c2' }));

      expect(first.syncId).toBe('sync-1');
      expect(second.syncId).toBe('sync-2');
    });

    it('should use cron from config schedule', () => {
      const result = scheduler.schedule(
        createConfig({ schedule: createSchedule({ cron: '30 12 * * *' }) })
      );

      expect(result.cron).toBe('30 12 * * *');
    });

    it('should set enabled from config schedule', () => {
      const result = scheduler.schedule(
        createConfig({ schedule: createSchedule({ enabled: false }) })
      );

      expect(result.enabled).toBe(false);
    });

    it('should calculate nextRun from cron expression', () => {
      const result = scheduler.schedule(
        createConfig({ schedule: createSchedule({ cron: '0 6 * * *' }) })
      );

      expect(result.nextRun).toBeInstanceOf(Date);
      expect(result.nextRun.getHours()).toBe(6);
      expect(result.nextRun.getMinutes()).toBe(0);
    });

    it('should throw when config has no schedule', () => {
      const config = createConfig({ schedule: undefined });

      expect(() => scheduler.schedule(config)).toThrow('schedule defined');
    });
  });

  describe('cancel', () => {
    it('should remove a scheduled sync and return true', () => {
      const scheduled = scheduler.schedule(createConfig());
      const removed = scheduler.cancel(scheduled.syncId);

      expect(removed).toBe(true);
      expect(scheduler.getScheduled()).toHaveLength(0);
    });

    it('should return false when sync ID does not exist', () => {
      expect(scheduler.cancel('non-existent')).toBe(false);
    });

    it('should only remove the specified schedule', () => {
      scheduler.schedule(createConfig({ id: 'c1' }));
      const second = scheduler.schedule(createConfig({ id: 'c2' }));

      scheduler.cancel(second.syncId);

      expect(scheduler.getScheduled()).toHaveLength(1);
    });
  });

  describe('getScheduled', () => {
    it('should return empty array when no schedules exist', () => {
      expect(scheduler.getScheduled()).toEqual([]);
    });

    it('should return all scheduled syncs', () => {
      scheduler.schedule(createConfig({ id: 'c1' }));
      scheduler.schedule(createConfig({ id: 'c2' }));

      expect(scheduler.getScheduled()).toHaveLength(2);
    });

    it('should return a copy of the schedules array', () => {
      scheduler.schedule(createConfig());
      const first = scheduler.getScheduled();
      const second = scheduler.getScheduled();

      expect(first).not.toBe(second);
    });
  });

  describe('getNextRun', () => {
    it('should return a Date in the future', () => {
      const now = new Date();
      const next = scheduler.getNextRun('0 6 * * *');

      expect(next.getTime()).toBeGreaterThan(now.getTime());
    });

    it('should set correct hour and minute from cron', () => {
      const next = scheduler.getNextRun('30 14 * * *');

      expect(next.getHours()).toBe(14);
      expect(next.getMinutes()).toBe(30);
    });

    it('should advance to next day if the time has already passed today', () => {
      vi.setSystemTime(new Date('2026-02-20T15:00:00Z'));

      const next = scheduler.getNextRun('0 6 * * *');

      expect(next.getDate()).toBe(21);
    });

    it('should return a fallback date for invalid cron expression', () => {
      const next = scheduler.getNextRun('invalid');

      expect(next).toBeInstanceOf(Date);
    });
  });
});
