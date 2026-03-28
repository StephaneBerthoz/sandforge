import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BackupScheduler } from './BackupScheduler';
import type { BackupConfig, BackupResult } from '@sandforge/shared';

function makeConfig(overrides: Partial<BackupConfig> = {}): BackupConfig {
  return {
    id: 'cfg-1',
    name: 'Daily Backup',
    orgId: 'org-1',
    objects: ['Account', 'Contact'],
    includeAttachments: false,
    includeFiles: false,
    compression: true,
    encryption: false,
    retentionDays: 30,
    createdAt: '2025-01-01T00:00:00.000Z',
    schedule: {
      enabled: true,
      cron: '0 2',
      timezone: 'UTC',
      maxRetries: 3,
    },
    ...overrides,
  } as BackupConfig;
}

function makeBackupResult(overrides: Partial<BackupResult> = {}): BackupResult {
  return {
    configId: 'cfg-1',
    operationId: 'op-1',
    status: 'completed',
    objectResults: [],
    totalRecords: 100,
    totalSize: 5000,
    filePath: 'backups/daily/op-1.json',
    checksum: 'abc123',
    startTime: '2025-01-01T02:00:00.000Z',
    endTime: '2025-01-01T02:05:00.000Z',
    duration: 300000,
    ...overrides,
  } as BackupResult;
}

describe('BackupScheduler', () => {
  let scheduler: BackupScheduler;

  beforeEach(() => {
    scheduler = new BackupScheduler();
  });

  it('should register a scheduled backup', () => {
    const entry = scheduler.register(makeConfig());
    expect(entry).not.toBeNull();
    expect(entry?.configId).toBe('cfg-1');
    expect(entry?.nextRunTime).toBeDefined();
    expect(entry?.consecutiveFailures).toBe(0);
  });

  it('should return null for configs without schedule', () => {
    const config = makeConfig({ schedule: undefined });
    expect(scheduler.register(config)).toBeNull();
  });

  it('should return null for disabled schedules', () => {
    const config = makeConfig({
      schedule: { enabled: false, cron: '0 2', timezone: 'UTC', maxRetries: 3 },
    });
    expect(scheduler.register(config)).toBeNull();
  });

  it('should list all registered schedules', () => {
    scheduler.register(makeConfig());
    scheduler.register(makeConfig({ id: 'cfg-2', name: 'Weekly' }));
    expect(scheduler.listSchedules()).toHaveLength(2);
  });

  it('should unregister a schedule', () => {
    scheduler.register(makeConfig());
    expect(scheduler.unregister('cfg-1')).toBe(true);
    expect(scheduler.listSchedules()).toHaveLength(0);
  });

  it('should return false when unregistering non-existent', () => {
    expect(scheduler.unregister('fake')).toBe(false);
  });

  it('should get due backups', () => {
    const config = makeConfig();
    scheduler.register(config);
    // Set nextRunTime to the past
    const entry = scheduler.listSchedules()[0];
    entry.nextRunTime = '2020-01-01T00:00:00.000Z';

    const due = scheduler.getDueBackups();
    expect(due).toHaveLength(1);
  });

  it('should skip due backups that exceeded max retries', () => {
    scheduler.register(makeConfig());
    const entry = scheduler.listSchedules()[0];
    entry.nextRunTime = '2020-01-01T00:00:00.000Z';
    entry.consecutiveFailures = 3;

    const due = scheduler.getDueBackups();
    expect(due).toHaveLength(0);
  });

  it('should record successful run and reset failures', () => {
    scheduler.register(makeConfig());
    scheduler.recordRun('cfg-1', true);

    const entry = scheduler.listSchedules()[0];
    expect(entry.lastRunStatus).toBe('completed');
    expect(entry.consecutiveFailures).toBe(0);
    expect(entry.lastRunTime).toBeDefined();
  });

  it('should record failed run and increment failures', () => {
    scheduler.register(makeConfig());
    scheduler.recordRun('cfg-1', false);

    const entry = scheduler.listSchedules()[0];
    expect(entry.lastRunStatus).toBe('failed');
    expect(entry.consecutiveFailures).toBe(1);
  });

  it('should identify expired backups', () => {
    const old = makeBackupResult({
      operationId: 'old-op',
      endTime: '2020-01-01T00:00:00.000Z',
    });
    const recent = makeBackupResult({
      operationId: 'recent-op',
      endTime: new Date().toISOString(),
    });

    const result = scheduler.checkRetention([old, recent], 30);
    expect(result.expiredBackups).toHaveLength(1);
    expect(result.expiredBackups[0].operationId).toBe('old-op');
    expect(result.retainedBackups).toHaveLength(1);
    expect(result.retainedBackups[0].operationId).toBe('recent-op');
  });

  it('should calculate total expired size', () => {
    const old = makeBackupResult({
      operationId: 'old-op',
      endTime: '2020-01-01T00:00:00.000Z',
      totalSize: 10000,
    });

    const result = scheduler.checkRetention([old], 30);
    expect(result.totalExpiredSize).toBe(10000);
  });

  it('should retain non-completed backups regardless of age', () => {
    const running = makeBackupResult({
      operationId: 'running-op',
      status: 'running',
      endTime: '2020-01-01T00:00:00.000Z',
    });

    const result = scheduler.checkRetention([running], 30);
    expect(result.expiredBackups).toHaveLength(0);
    expect(result.retainedBackups).toHaveLength(1);
  });

  it('should get cleanup candidates (expired + failed)', () => {
    const expired = makeBackupResult({
      operationId: 'expired-op',
      endTime: '2020-01-01T00:00:00.000Z',
    });
    const failed = makeBackupResult({
      operationId: 'failed-op',
      status: 'failed',
      endTime: new Date().toISOString(),
    });
    const good = makeBackupResult({
      operationId: 'good-op',
      endTime: new Date().toISOString(),
    });

    const candidates = scheduler.getCleanupCandidates([expired, failed, good], 30);
    expect(candidates).toContain('expired-op');
    expect(candidates).toContain('failed-op');
    expect(candidates).not.toContain('good-op');
  });

  describe('computeNextRun (frozen clock)', () => {
    // Use a stable date far from DST transitions to avoid timezone flakes.
    // 2026-06-15 10:00:00 UTC (a Monday, mid-summer, no DST edge)
    const STABLE_DATE = new Date('2026-06-15T10:00:00.000Z');

    beforeEach(() => {
      vi.useFakeTimers({ now: STABLE_DATE });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should compute next run for daily schedule', () => {
      const next = scheduler.computeNextRun('0 2');
      const nextDate = new Date(next);
      expect(nextDate.getHours()).toBe(2);
      expect(nextDate.getMinutes()).toBe(0);
      expect(nextDate > STABLE_DATE).toBe(true);
    });

    it('should compute next run for weekly schedule', () => {
      const next = scheduler.computeNextRun('0 3 1'); // Monday at 03:00
      const nextDate = new Date(next);
      expect(nextDate.getDay()).toBe(1); // Monday
      expect(nextDate.getHours()).toBe(3);
    });

    it('should fallback to 24h for unrecognized cron', () => {
      const next = scheduler.computeNextRun('*/5 * * * *');
      const nextDate = new Date(next);
      const diffHours = (nextDate.getTime() - STABLE_DATE.getTime()) / (1000 * 60 * 60);
      expect(diffHours).toBeGreaterThan(23);
      expect(diffHours).toBeLessThan(25);
    });
  });
});
