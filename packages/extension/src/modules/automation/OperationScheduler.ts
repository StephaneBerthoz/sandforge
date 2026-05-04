import type { ScheduledOperation, ScheduledOperationRun } from '@sandforge/shared';

/** Dependencies required by OperationScheduler. */
export interface OperationSchedulerDeps {
  /** Key-value persistence. */
  configStore: {
    get<T>(key: string): T | undefined;
    set<T>(key: string, value: T): void;
  };
  /** Logger function. */
  log: (msg: string) => void;
  /** Callback invoked when a scheduled operation should execute. */
  onExecute: (schedule: ScheduledOperation) => Promise<OperationExecutionResult>;
}

/** Result from executing a scheduled operation. */
export interface OperationExecutionResult {
  success: boolean;
  recordsProcessed: number;
  error?: string;
}

/** Config store keys */
const SCHEDULES_KEY = 'sandforge.scheduler.schedules';
const HISTORY_KEY = 'sandforge.scheduler.history';

/** Max history entries retained per schedule. */
const MAX_HISTORY = 10;

/**
 * Manages scheduled recurring operations (backup, sync, cleanup).
 *
 * Persists schedules and history via ConfigStore. Uses setInterval
 * to check for due operations every minute.
 */
export class OperationScheduler {
  private readonly deps: OperationSchedulerDeps;
  private readonly schedules: Map<string, ScheduledOperation> = new Map();
  private readonly history: ScheduledOperationRun[] = [];
  private checkInterval: ReturnType<typeof setInterval> | undefined;

  /** @param deps - Injected dependencies. */
  constructor(deps: OperationSchedulerDeps) {
    this.deps = deps;
    this.loadFromStore();
  }

  /**
   * Start the scheduler tick (checks every 60 seconds).
   * Safe to call multiple times.
   */
  start(): void {
    if (this.checkInterval) return;
    this.checkInterval = setInterval(() => {
      void this.tick();
    }, 60_000);
    this.deps.log('[OperationScheduler] started');
  }

  /** Stop the scheduler tick. */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = undefined;
      this.deps.log('[OperationScheduler] stopped');
    }
  }

  /**
   * Create or update a scheduled operation.
   *
   * @param schedule - The schedule definition (without computed nextRunAt).
   * @returns The persisted schedule with computed nextRunAt.
   */
  upsert(schedule: Omit<ScheduledOperation, 'lastRunAt' | 'nextRunAt'>): ScheduledOperation {
    const existing = this.schedules.get(schedule.id);
    const full: ScheduledOperation = {
      ...schedule,
      lastRunAt: existing?.lastRunAt,
      nextRunAt: this.computeNextRunAt(schedule),
    };
    this.schedules.set(full.id, full);
    this.persist();
    this.deps.log(
      `[OperationScheduler] upserted schedule ${full.id} (${full.operationType} ${full.frequency})`,
    );
    return full;
  }

  /**
   * Remove a scheduled operation by ID.
   *
   * @param scheduleId - The ID to remove.
   * @returns True if the schedule existed and was removed.
   */
  delete(scheduleId: string): boolean {
    const existed = this.schedules.delete(scheduleId);
    if (existed) {
      this.persist();
      this.deps.log(`[OperationScheduler] deleted schedule ${scheduleId}`);
    }
    return existed;
  }

  /**
   * Enable or disable a schedule.
   *
   * @param scheduleId - The schedule to toggle.
   * @param enabled - New enabled state.
   * @returns The updated schedule or undefined if not found.
   */
  toggle(scheduleId: string, enabled: boolean): ScheduledOperation | undefined {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) return undefined;

    schedule.enabled = enabled;
    if (enabled) {
      schedule.nextRunAt = this.computeNextRunAt(schedule);
    }
    this.persist();
    this.deps.log(
      `[OperationScheduler] toggled ${scheduleId} → ${enabled ? 'enabled' : 'disabled'}`,
    );
    return schedule;
  }

  /** Get all scheduled operations. */
  getSchedules(): ScheduledOperation[] {
    return Array.from(this.schedules.values());
  }

  /** Get a schedule by ID. */
  getSchedule(id: string): ScheduledOperation | undefined {
    return this.schedules.get(id);
  }

  /** Get the last N history entries across all schedules. */
  getHistory(limit: number = MAX_HISTORY): ScheduledOperationRun[] {
    return this.history.slice(-limit);
  }

  /**
   * Compute the next run time for a schedule.
   *
   * @param schedule - Schedule definition with frequency and time.
   * @returns ISO date string of the next run.
   */
  computeNextRunAt(schedule: {
    frequency: string;
    time: string;
    dayOfWeek?: number;
    dayOfMonth?: number;
  }): string {
    const now = new Date();
    const [hours, minutes] = schedule.time.split(':').map(Number);
    const next = new Date(now);
    next.setSeconds(0, 0);
    next.setHours(hours, minutes);

    switch (schedule.frequency) {
      case 'hourly':
        next.setHours(now.getHours());
        next.setMinutes(minutes);
        if (next <= now) next.setHours(next.getHours() + 1);
        break;

      case 'daily':
        if (next <= now) next.setDate(next.getDate() + 1);
        break;

      case 'weekly': {
        const targetDay = schedule.dayOfWeek ?? 1;
        const currentDay = next.getDay();
        let daysUntil = targetDay - currentDay;
        if (daysUntil < 0 || (daysUntil === 0 && next <= now)) {
          daysUntil += 7;
        }
        next.setDate(next.getDate() + daysUntil);
        break;
      }

      case 'monthly': {
        const targetDate = schedule.dayOfMonth ?? 1;
        next.setDate(targetDate);
        if (next <= now) next.setMonth(next.getMonth() + 1);
        break;
      }
    }

    return next.toISOString();
  }

  /**
   * Check for due operations and execute them.
   * Called automatically by the interval, can also be called manually.
   */
  async tick(): Promise<void> {
    const now = new Date();
    for (const schedule of this.schedules.values()) {
      if (!schedule.enabled || !schedule.nextRunAt) continue;
      const nextRun = new Date(schedule.nextRunAt);
      if (nextRun > now) continue;

      this.deps.log(`[OperationScheduler] executing ${schedule.operationType} (${schedule.id})`);
      const startedAt = new Date().toISOString();

      let result: OperationExecutionResult;
      try {
        result = await this.deps.onExecute(schedule);
      } catch (err: unknown) {
        result = {
          success: false,
          recordsProcessed: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      const completedAt = new Date().toISOString();
      const run: ScheduledOperationRun = {
        id: `run-${Date.now()}-${schedule.id}`,
        scheduleId: schedule.id,
        operationType: schedule.operationType,
        status: result.success ? 'success' : 'failure',
        startedAt,
        completedAt,
        durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
        recordsProcessed: result.recordsProcessed,
        error: result.error,
      };

      this.history.push(run);
      if (this.history.length > MAX_HISTORY * this.schedules.size) {
        this.history.splice(0, this.history.length - MAX_HISTORY * this.schedules.size);
      }

      schedule.lastRunAt = completedAt;
      schedule.nextRunAt = this.computeNextRunAt(schedule);
      this.persist();
    }
  }

  /** Load schedules and history from the config store. */
  private loadFromStore(): void {
    const schedules = this.deps.configStore.get<ScheduledOperation[]>(SCHEDULES_KEY);
    if (schedules) {
      for (const s of schedules) {
        this.schedules.set(s.id, s);
      }
    }

    const history = this.deps.configStore.get<ScheduledOperationRun[]>(HISTORY_KEY);
    if (history) {
      this.history.push(...history);
    }
  }

  /** Persist current state to the config store. */
  private persist(): void {
    this.deps.configStore.set(SCHEDULES_KEY, Array.from(this.schedules.values()));
    this.deps.configStore.set(HISTORY_KEY, this.history);
  }
}
