import type { SyncScheduleEntry, SyncConfig, SyncExecutionResult } from '@sandforge/shared';
import { nextCronRun, SCHEDULE_HORIZON_MS } from '../../core/common/cronSchedule.js';
import type { SyncScheduleStore } from './SyncScheduleStore.js';
import { memoryTriggerClaims, type TriggerClaims } from '../automation/TriggerClaims.js';

/** Dependencies required by SyncScheduleExecutor. */
export interface SyncScheduleExecutorDeps {
  /** Persistence store for schedule entries. */
  scheduleStore: SyncScheduleStore;
  /** Load a SyncConfig by ID. */
  configStore: { load(id: string): SyncConfig | undefined };
  /** Callback invoked to execute a sync config. */
  onExecute: (config: SyncConfig) => Promise<SyncExecutionResult>;
  /**
   * Notification center for schedule lifecycle events. A schedule runs with
   * nobody watching, so the level is the one the panels render rather than a
   * free string that only ever reached a log line.
   */
  notificationCenter: {
    notify(level: 'info' | 'success' | 'warning' | 'error', title: string, message: string): void;
  };
  /** Logger function. */
  log: (msg: string) => void;
  /** Overridable clock for testing. Defaults to Date.now. */
  now?: () => number;
  /**
   * What the VS Code windows share about the starts they make — the claims
   * the pipeline triggers take. Every window runs its own tick loop over the
   * same schedules, and a sync writes: a start is made by the one window that
   * claims it. Without it the claims are this window's alone.
   */
  claims?: Pick<TriggerClaims, 'claim' | 'prune'>;
}

/** Tick interval in milliseconds (60 seconds). */
const TICK_INTERVAL_MS = 60_000;

/** How long a claim is kept: far longer than two windows could both see one start. */
const CLAIM_LIFETIME_MS = 2 * 24 * 60 * 60_000;

/** How often old claims are pruned. */
const PRUNE_INTERVAL_MS = 60 * 60_000;

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
  private readonly claims: Pick<TriggerClaims, 'claim' | 'prune'>;
  private lastPrune = 0;
  /** Schedules whose run this window started and has not seen finish. */
  private readonly running = new Set<string>();

  /** @param deps - Injected dependencies for testability. */
  constructor(deps: SyncScheduleExecutorDeps) {
    this.deps = deps;
    this.claims = deps.claims ?? memoryTriggerClaims();
  }

  /**
   * Start the executor: load all schedules from store and begin the tick loop.
   * Idempotent -- calling start() when already running is a no-op.
   */
  start(): void {
    if (this.checkInterval) return;

    const all = this.deps.scheduleStore.loadAll();
    const loadedAt = this.now();
    for (const entry of all) {
      this.schedules.set(entry.id, this.withPlausibleNextRun(entry, loadedAt));
    }

    this.lastTickTime = this.now();
    this.checkInterval = setInterval(() => {
      void this.tick();
    }, TICK_INTERVAL_MS);

    this.deps.log('[SyncScheduleExecutor] started');
  }

  /**
   * A schedule as it was loaded, with its next run computed again when none
   * computed now could be that far: more than a year ahead.
   *
   * Before 1.36.0 the search for the next run was unbounded, and an
   * expression naming a day its months do not have (`0 0 31 2,4 *`) was
   * given a date in 2054 it does not even match. Saved with the schedule,
   * that date stayed its next run. Computed again, the answer is within a
   * year or no run at all, and saved, so it is corrected once. A next run in
   * the past is kept: it is a start missed while no window was open, and the
   * first tick makes it.
   *
   * @param entry - The schedule as stored.
   * @param now - When the schedules were loaded.
   */
  private withPlausibleNextRun(entry: SyncScheduleEntry, now: number): SyncScheduleEntry {
    const stored = entry.nextRunAt ? new Date(entry.nextRunAt).getTime() : Number.NaN;
    if (!(stored > now + SCHEDULE_HORIZON_MS)) return entry;
    const corrected: SyncScheduleEntry = {
      ...entry,
      nextRunAt: this.computeNextRunAt(entry.cron, entry.timezone),
    };
    this.deps.scheduleStore.save(corrected);
    this.deps.log(
      `[SyncScheduleExecutor] ${entry.id}: next run ${entry.nextRunAt} replaced by ${corrected.nextRunAt || 'none'}`,
    );
    return corrected;
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
    if (currentTime - this.lastPrune >= PRUNE_INTERVAL_MS) {
      this.lastPrune = currentTime;
      this.claims.prune(CLAIM_LIFETIME_MS);
    }

    for (const schedule of this.schedules.values()) {
      if (!schedule.enabled) continue;
      if (!schedule.nextRunAt) continue;

      const nextRun = new Date(schedule.nextRunAt).getTime();
      if (Number.isNaN(nextRun)) {
        // A stored next run that reads as no date is neither before nor after
        // any time, so the test below let it through as due and a sync ran on
        // it. It is computed again from the expression instead, and saved, so
        // it is corrected once; nothing runs on it.
        const unreadable = schedule.nextRunAt;
        schedule.nextRunAt = this.computeNextRunAt(schedule.cron, schedule.timezone);
        this.deps.scheduleStore.save(schedule);
        this.deps.log(
          `[SyncScheduleExecutor] ${schedule.id}: next run "${unreadable}" cannot be read, replaced by ${schedule.nextRunAt || 'none'}`,
        );
        continue;
      }
      if (nextRun > currentTime) continue;
      // Its start is being made here: the ticks that come round while the run
      // lasts see the same start due, and it is not made twice.
      if (this.running.has(schedule.id)) continue;

      // Every window sees the start fall due; the one that claims it makes it.
      // The others move on to the next start and leave the stored schedule to
      // the window that ran it: saving their copy would write over its result.
      if (!this.claims.claim(`sync-schedule:${schedule.id}:${nextRun}`)) {
        this.deps.log(
          `[SyncScheduleExecutor] ${schedule.id} due at ${schedule.nextRunAt} is run by another window`,
        );
        schedule.nextRunAt = this.computeNextRunAt(schedule.cron, schedule.timezone);
        continue;
      }

      const config = this.deps.configStore.load(schedule.configId);
      if (!config) {
        // Treated as a run that failed rather than a tick to skip: leaving
        // nextRunAt in the past made the same schedule due again 60 s later,
        // forever, while it still read as active with no last result and only
        // the log said anything.
        this.deps.log(
          `[SyncScheduleExecutor] config not found for schedule ${schedule.id} (configId=${schedule.configId})`,
        );
        schedule.lastRunAt = new Date(currentTime).toISOString();
        schedule.lastResult = 'failure';
        schedule.nextRunAt = this.computeNextRunAt(schedule.cron, schedule.timezone);
        schedule.updatedAt = new Date(currentTime).toISOString();
        this.deps.scheduleStore.save(schedule);

        if (schedule.notifyOnFailure) {
          this.deps.notificationCenter.notify(
            'error',
            'Sync schedule failed',
            `${schedule.name}: sync configuration "${schedule.configId}" no longer exists. ` +
              `Save the configuration again, or delete the schedule.`,
          );
        }
        continue;
      }

      if (schedule.notifyOnComplete) {
        this.deps.notificationCenter.notify('info', 'Sync schedule started', schedule.name);
      }

      this.running.add(schedule.id);
      try {
        const result = await this.deps.onExecute(config);
        schedule.lastRunAt = new Date(currentTime).toISOString();
        schedule.lastResult = result.status;
        schedule.nextRunAt = this.computeNextRunAt(schedule.cron, schedule.timezone);
        schedule.updatedAt = new Date(currentTime).toISOString();
        this.deps.scheduleStore.save(schedule);

        // The engine answers a run that failed (connection, Bulk API, abort)
        // with a failure-status result instead of rejecting, so it is reported
        // here as a failure, never as completed.
        if (result.status === 'failure') {
          if (schedule.notifyOnFailure) {
            const firstError = result.objectResults.flatMap((o) => o.errors)[0];
            this.deps.notificationCenter.notify(
              'error',
              'Sync schedule failed',
              `${schedule.name}: ${firstError ?? 'the run failed; its entry in the sync history has the details.'}`,
            );
          }
        } else if (result.status === 'partial' && schedule.notifyOnComplete) {
          // Some records were refused: announcing that as a success hid them.
          const firstError = result.objectResults.flatMap((o) => o.errors)[0];
          this.deps.notificationCenter.notify(
            'warning',
            'Sync schedule completed with errors',
            `${schedule.name}: ${firstError ?? 'some records failed; its entry in the sync history has the details.'}`,
          );
        } else if (schedule.notifyOnComplete) {
          this.deps.notificationCenter.notify('success', 'Sync schedule completed', schedule.name);
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
      } finally {
        this.running.delete(schedule.id);
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
   * A schedule saved before such expressions were refused can still name a
   * day its months do not have: it gets no next run, never one decades away
   * (see `nextCronRun`).
   *
   * @param cron - Standard 5-field cron expression.
   * @param timezone - IANA timezone string.
   * @returns ISO date string of the next occurrence, or empty string when the
   *   expression does not parse or falls due on no date in the coming year.
   */
  private computeNextRunAt(cron: string, timezone: string): string {
    const next = nextCronRun(cron, timezone, this.now());
    if (typeof next === 'number') return new Date(next).toISOString();
    this.deps.log(`[SyncScheduleExecutor] no next run for cron "${cron}": ${next.reason}`);
    return '';
  }

  /** Get current timestamp using the injectable clock. */
  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }
}
