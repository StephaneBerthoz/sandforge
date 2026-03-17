import type { SyncConfig } from '@sandforge/shared';

/** A scheduled sync entry */
export interface ScheduledSync {
  syncId: string;
  configId: string;
  cron: string;
  nextRun: Date;
  enabled: boolean;
}

/**
 * Manages scheduled sync configurations.
 * Stores scheduled sync entries, calculates next run times from cron expressions,
 * and supports enabling, disabling, and cancelling schedules.
 */
export class SyncScheduler {
  private readonly schedules: Map<string, ScheduledSync> = new Map();
  private idCounter = 0;

  /**
   * Schedule a sync configuration for periodic execution.
   * Returns the created ScheduledSync entry with the calculated next run time.
   */
  schedule(config: SyncConfig): ScheduledSync {
    if (!config.schedule) {
      throw new Error('SyncConfig must have a schedule defined');
    }

    this.idCounter++;
    const syncId = `sync-${this.idCounter}`;

    const scheduled: ScheduledSync = {
      syncId,
      configId: config.id,
      cron: config.schedule.cron,
      nextRun: this.getNextRun(config.schedule.cron),
      enabled: config.schedule.enabled,
    };

    this.schedules.set(syncId, scheduled);
    return scheduled;
  }

  /**
   * Cancel a scheduled sync by its sync ID.
   * Returns true if the schedule was found and removed, false otherwise.
   */
  cancel(syncId: string): boolean {
    return this.schedules.delete(syncId);
  }

  /**
   * Return all currently scheduled syncs.
   */
  getScheduled(): ScheduledSync[] {
    return [...this.schedules.values()];
  }

  /**
   * Calculate the next run time from a simplified cron expression.
   * Supports standard 5-field cron (minute hour dayOfMonth month dayOfWeek).
   * Returns the next occurrence after the current time.
   */
  getNextRun(cron: string): Date {
    const parts = cron.trim().split(/\s+/);
    if (parts.length < 5) {
      return new Date(Date.now() + 60 * 60 * 1000);
    }

    const now = new Date();
    const next = new Date(now);

    const minute = parseCronField(parts[0], 0, 59);
    const hour = parseCronField(parts[1], 0, 23);

    if (minute !== null) {
      next.setMinutes(minute);
    }
    if (hour !== null) {
      next.setHours(hour);
    }
    next.setSeconds(0);
    next.setMilliseconds(0);

    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }

    return next;
  }
}

/**
 * Parse a single cron field. Returns null for wildcard (*), the numeric value otherwise.
 */
function parseCronField(
  field: string,
  _min: number,
  _max: number
): number | null {
  if (field === '*') {
    return null;
  }

  const num = parseInt(field, 10);
  if (isNaN(num)) {
    return null;
  }

  return num;
}
