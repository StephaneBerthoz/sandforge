import { CronExpressionParser } from 'cron-parser';
import type { SyncScheduleEntry, SyncConfig, SyncExecutionResult } from '@sandforge/shared';
import type { SyncScheduleStore } from './SyncScheduleStore.js';

/** Dependencies required by SyncScheduleExecutor. */
export interface SyncScheduleExecutorDeps {
  /** Persistence store for schedule entries. */
  scheduleStore: SyncScheduleStore;
  /** Load a SyncConfig by ID. */
  configStore: { load(id: string): SyncConfig | undefined };
  /** Callback invoked to execute a sync config. */
  onExecute: (config: SyncConfig) => Promise<SyncExecutionResult>;
  /** Notification center for schedule lifecycle events. */
  notificationCenter: {
    notify(level: string, title: string, message: string): void;
  };
  /** Logger function. */
  log: (msg: string) => void;
  /** Overridable clock for testing. Defaults to Date.now. */
  now?: () => number;
}

/** Tick interval in milliseconds (60 seconds). */
const TICK_INTERVAL_MS = 60_000;

/**
 * Cron-based sync schedule executor with persistence, sleep-wake resilience,
 * and notification integration.
 *
 * Replaces the legacy SyncScheduler class. Uses cron-parser for
 * timezone-aware next-run computation and a 60s tick loop to detect
 * due schedules.
 */
export class SyncScheduleExecutor {
  private readonly deps: SyncScheduleExecutorDeps;
  private readonly schedules: Map<string, SyncScheduleEntry> = new Map();
  private checkInterval: ReturnType<typeof setInterval> | undefined;
  private lastTickTime: number = 0;

  /** @param deps - Injected dependencies for testability. */
  constructor(deps: SyncScheduleExecutorDeps) {
    this.deps = deps;
  }

  /**
   * Start the executor: load all schedules from store and begin the tick loop.
   * Idempotent -- calling start() when already running is a no-op.
   */
  start(): void {
    if (this.checkInterval) return;

    const all = this.deps.scheduleStore.loadAll();
    for (const entry of all) {
      this.schedules.set(entry.id, entry);
    }

    this.lastTickTime = this.now();
    this.checkInterval = setInterval(() => {
      void this.tick();
    }, TICK_INTERVAL_MS);

    this.deps.log('[SyncScheduleExecutor] started');
  }

  /** Stop the tick loop. */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = undefined;
      this.deps.log('[SyncScheduleExecutor] stopped');
    }
  }

  /**
   * Core scheduling loop. Checks all enabled schedules for overdue execution.
   *
   * Sleep-wake detection: if elapsed time since last tick exceeds 2x the
   * tick interval, each overdue schedule executes exactly once (not once per
   * missed interval), then recomputes nextRunAt to the next future occurrence.
   */
  async tick(): Promise<void> {
    const currentTime = this.now();
    const elapsed = currentTime - this.lastTickTime;

    if (elapsed > 2 * TICK_INTERVAL_MS) {
      this.deps.log(
        `[SyncScheduleExecutor] sleep-wake detected (elapsed ${Math.round(elapsed / 1000)}s)`,
      );
    }

    this.lastTickTime = currentTime;

    for (const schedule of this.schedules.values()) {
      if (!schedule.enabled) continue;
      if (!schedule.nextRunAt) continue;

      const nextRun = new Date(schedule.nextRunAt).getTime();
      if (nextRun > currentTime) continue;

      const config = this.deps.configStore.load(schedule.configId);
      if (!config) {
        this.deps.log(
          `[SyncScheduleExecutor] config not found for schedule ${schedule.id} (configId=${schedule.configId})`,
        );
        continue;
      }

      if (schedule.notifyOnComplete) {
        this.deps.notificationCenter.notify(
          'info',
          'Sync schedule started',
          schedule.name,
        );
      }

      try {
        const result = await this.deps.onExecute(config);
        schedule.lastRunAt = new Date(currentTime).toISOString();
        schedule.lastResult = result.status;
        schedule.nextRunAt = this.computeNextRunAt(schedule.cron, schedule.timezone);
        schedule.updatedAt = new Date(currentTime).toISOString();
        this.deps.scheduleStore.save(schedule);

        if (schedule.notifyOnComplete) {
          this.deps.notificationCenter.notify(
            'success',
            'Sync schedule completed',
            schedule.name,
          );
        }
      } catch (err: unknown) {
        schedule.lastRunAt = new Date(currentTime).toISOString();
        schedule.lastResult = 'failure';
        schedule.nextRunAt = this.computeNextRunAt(schedule.cron, schedule.timezone);
        schedule.updatedAt = new Date(currentTime).toISOString();
        this.deps.scheduleStore.save(schedule);

        if (schedule.notifyOnFailure) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          this.deps.notificationCenter.notify(
            'error',
            'Sync schedule failed',
            `${schedule.name}: ${errorMsg}`,
          );
        }
      }
    }
  }

  /**
   * Create or update a schedule entry.
   * Computes nextRunAt via cron-parser and persists to store.
   *
   * @param input - Schedule data without computed runtime fields.
   * @returns The full schedule entry with computed nextRunAt.
   */
  upsert(
    input: Omit<SyncScheduleEntry, 'nextRunAt' | 'lastRunAt' | 'lastResult'>,
  ): SyncScheduleEntry {
    const existing = this.schedules.get(input.id);
    const entry: SyncScheduleEntry = {
      ...input,
      nextRunAt: this.computeNextRunAt(input.cron, input.timezone),
      lastRunAt: existing?.lastRunAt,
      lastResult: existing?.lastResult,
    };

    this.schedules.set(entry.id, entry);
    this.deps.scheduleStore.save(entry);
    this.deps.log(`[SyncScheduleExecutor] upserted schedule ${entry.id}`);
    return entry;
  }

  /**
   * Delete a schedule by ID.
   *
   * @param scheduleId - The schedule to remove.
   * @returns True if the schedule existed and was removed.
   */
  delete(scheduleId: string): boolean {
    const existed = this.schedules.delete(scheduleId);
    if (existed) {
      this.deps.scheduleStore.delete(scheduleId);
      this.deps.log(`[SyncScheduleExecutor] deleted schedule ${scheduleId}`);
    }
    return existed;
  }

  /**
   * Enable or disable a schedule.
   * When re-enabling, recomputes nextRunAt from cron-parser.
   *
   * @param scheduleId - The schedule to toggle.
   * @param enabled - New enabled state.
   * @returns The updated schedule, or undefined if not found.
   */
  toggle(scheduleId: string, enabled: boolean): SyncScheduleEntry | undefined {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) return undefined;

    schedule.enabled = enabled;
    if (enabled) {
      schedule.nextRunAt = this.computeNextRunAt(schedule.cron, schedule.timezone);
    }
    schedule.updatedAt = new Date(this.now()).toISOString();
    this.deps.scheduleStore.save(schedule);
    this.deps.log(
      `[SyncScheduleExecutor] toggled ${scheduleId} -> ${enabled ? 'enabled' : 'disabled'}`,
    );
    return schedule;
  }

  /** Get all schedule entries. */
  getSchedules(): SyncScheduleEntry[] {
    return Array.from(this.schedules.values());
  }

  /** Get a single schedule by ID. */
  getSchedule(id: string): SyncScheduleEntry | undefined {
    return this.schedules.get(id);
  }

  /**
   * Compute the next run time for a cron expression in a given timezone.
   *
   * @param cron - Standard 5-field cron expression.
   * @param timezone - IANA timezone string.
   * @returns ISO date string of the next occurrence, or empty string on parse error.
   */
  private computeNextRunAt(cron: string, timezone: string): string {
    try {
      const expression = CronExpressionParser.parse(cron, {
        tz: timezone,
        currentDate: new Date(this.now()),
      });
      const next = expression.next();
      return next.toDate().toISOString();
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.deps.log(`[SyncScheduleExecutor] invalid cron "${cron}": ${errorMsg}`);
      return '';
    }
  }

  /** Get current timestamp using the injectable clock. */
  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }
}
