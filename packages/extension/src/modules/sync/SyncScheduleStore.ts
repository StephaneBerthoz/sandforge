import type { ConfigStore } from '../../core/storage/ConfigStore.js';
import type { SyncScheduleEntry } from '@sandforge/shared';

/** Key prefix for sync schedule entries in the config store. */
const SYNC_SCHEDULE_PREFIX = 'schedule:sync:';

/** Config store category for sync schedule data. */
const SYNC_SCHEDULE_CATEGORY = 'syncSchedules';

/**
 * Persists sync schedule entries to ConfigStore.
 *
 * Thin facade over ConfigStore with a dedicated key prefix (`schedule:sync:`)
 * and category (`syncSchedules`). Follows the same pattern as SyncConfigStore.
 */
export class SyncScheduleStore {
  /** @param configStore - The configuration store backend. */
  constructor(private readonly configStore: ConfigStore) {}

  /**
   * Persist a sync schedule entry.
   *
   * @param schedule - The schedule entry to save.
   */
  save(schedule: SyncScheduleEntry): void {
    this.configStore.set(
      `${SYNC_SCHEDULE_PREFIX}${schedule.id}`,
      schedule,
      SYNC_SCHEDULE_CATEGORY,
    );
  }

  /**
   * Load a sync schedule entry by ID.
   *
   * @param id - The schedule ID.
   * @returns The stored schedule, or `undefined` if not found.
   */
  load(id: string): SyncScheduleEntry | undefined {
    return this.configStore.get<SyncScheduleEntry>(`${SYNC_SCHEDULE_PREFIX}${id}`);
  }

  /**
   * List all persisted sync schedule entries, sorted by `createdAt` descending.
   *
   * @returns All stored schedule entries, newest first.
   */
  list(): SyncScheduleEntry[] {
    const byCategory = this.configStore.getByCategory(SYNC_SCHEDULE_CATEGORY);
    const entries = Object.values(byCategory) as SyncScheduleEntry[];
    return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Delete a sync schedule entry by ID.
   *
   * @param id - The schedule ID to delete.
   * @returns `true` if the entry existed and was removed, `false` otherwise.
   */
  delete(id: string): boolean {
    return this.configStore.delete(`${SYNC_SCHEDULE_PREFIX}${id}`);
  }

  /**
   * Load all persisted sync schedule entries.
   * Used on startup to reload all schedules into memory.
   *
   * @returns All stored schedule entries, newest first.
   */
  loadAll(): SyncScheduleEntry[] {
    return this.list();
  }
}
