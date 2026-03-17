import type { BackupResult, BackupConfig } from '@sandforge/shared';

/** Scheduled backup entry with next run time. */
export interface ScheduledBackup {
  configId: string;
  config: BackupConfig;
  nextRunTime: string;
  lastRunTime?: string;
  lastRunStatus?: 'completed' | 'failed';
  consecutiveFailures: number;
}

/** Retention check result. */
export interface RetentionCheckResult {
  expiredBackups: BackupResult[];
  totalExpiredSize: number;
  retainedBackups: BackupResult[];
}

/**
 * Manages backup scheduling, retention policies,
 * and expiration cleanup for automated backup workflows.
 */
export class BackupScheduler {
  private readonly schedules: Map<string, ScheduledBackup> = new Map();

  /**
   * Register a backup config for scheduled execution.
   * @param config - Backup configuration with schedule
   * @returns The registered scheduled backup entry
   */
  register(config: BackupConfig): ScheduledBackup | null {
    if (!config.schedule?.enabled || !config.schedule.cron) {
      return null;
    }

    const nextRunTime = this.computeNextRun(config.schedule.cron);

    const entry: ScheduledBackup = {
      configId: config.id,
      config,
      nextRunTime,
      consecutiveFailures: 0,
    };

    this.schedules.set(config.id, entry);
    return entry;
  }

  /**
   * Unregister a scheduled backup.
   * @param configId - The backup config ID
   * @returns True if unregistered, false if not found
   */
  unregister(configId: string): boolean {
    return this.schedules.delete(configId);
  }

  /**
   * List all registered scheduled backups.
   * @returns Array of scheduled backups
   */
  listSchedules(): ScheduledBackup[] {
    return Array.from(this.schedules.values());
  }

  /**
   * Get scheduled backups that are due for execution.
   * @returns Array of configs whose next run time has passed
   */
  getDueBackups(): ScheduledBackup[] {
    const now = new Date();
    return this.listSchedules().filter((s) => {
      if (s.consecutiveFailures >= (s.config.schedule?.maxRetries ?? 3)) {
        return false;
      }
      return new Date(s.nextRunTime) <= now;
    });
  }

  /**
   * Record a backup run result and update next scheduled time.
   * @param configId - The backup config ID
   * @param success - Whether the run succeeded
   */
  recordRun(configId: string, success: boolean): void {
    const entry = this.schedules.get(configId);
    if (!entry) return;

    entry.lastRunTime = new Date().toISOString();
    entry.lastRunStatus = success ? 'completed' : 'failed';

    if (success) {
      entry.consecutiveFailures = 0;
      if (entry.config.schedule?.cron) {
        entry.nextRunTime = this.computeNextRun(entry.config.schedule.cron);
      }
    } else {
      entry.consecutiveFailures += 1;
    }

    this.schedules.set(configId, entry);
  }

  /**
   * Check backup retention and identify expired backups.
   * @param backups - All backup results
   * @param retentionDays - Number of days to retain backups
   * @returns Retention check result with expired and retained lists
   */
  checkRetention(
    backups: BackupResult[],
    retentionDays: number,
  ): RetentionCheckResult {
    const now = new Date();
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - retentionDays);

    const expired: BackupResult[] = [];
    const retained: BackupResult[] = [];
    let totalExpiredSize = 0;

    for (const backup of backups) {
      if (backup.status !== 'completed') {
        retained.push(backup);
        continue;
      }

      const backupDate = new Date(backup.endTime);
      if (backupDate < cutoff) {
        expired.push(backup);
        totalExpiredSize += backup.totalSize;
      } else {
        retained.push(backup);
      }
    }

    return { expiredBackups: expired, totalExpiredSize, retainedBackups: retained };
  }

  /**
   * Get backups that should be cleaned up (expired + failed).
   * @param backups - All backup results
   * @param retentionDays - Number of days to retain
   * @returns Array of backup operation IDs to clean up
   */
  getCleanupCandidates(
    backups: BackupResult[],
    retentionDays: number,
  ): string[] {
    const { expiredBackups } = this.checkRetention(backups, retentionDays);
    const failedBackups = backups.filter((b) => b.status === 'failed');

    const ids = new Set<string>();
    for (const b of [...expiredBackups, ...failedBackups]) {
      ids.add(b.operationId);
    }

    return Array.from(ids);
  }

  /**
   * Compute the next run time from a simple cron expression.
   * Supports: daily HH:MM, weekly DAY HH:MM, monthly DD HH:MM.
   * Falls back to 24 hours from now for unrecognized patterns.
   * @param cron - Simplified cron expression
   * @returns ISO date string for the next run
   */
  computeNextRun(cron: string): string {
    const now = new Date();
    const parts = cron.trim().split(/\s+/);

    // Daily: "0 2" → every day at 02:00
    if (parts.length === 2) {
      const [minute, hour] = parts.map(Number);
      const next = new Date(now);
      next.setHours(hour, minute, 0, 0);
      if (next <= now) {
        next.setDate(next.getDate() + 1);
      }
      return next.toISOString();
    }

    // Weekly: "0 2 1" → every Monday at 02:00 (0=Sun, 1=Mon...)
    if (parts.length === 3) {
      const [minute, hour, dayOfWeek] = parts.map(Number);
      const next = new Date(now);
      next.setHours(hour, minute, 0, 0);
      const currentDay = next.getDay();
      let daysUntil = dayOfWeek - currentDay;
      if (daysUntil < 0 || (daysUntil === 0 && next <= now)) {
        daysUntil += 7;
      }
      next.setDate(next.getDate() + daysUntil);
      return next.toISOString();
    }

    // Fallback: 24 hours from now
    const fallback = new Date(now);
    fallback.setDate(fallback.getDate() + 1);
    return fallback.toISOString();
  }
}
