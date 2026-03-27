import type { ConfigStore } from '../../core/storage/ConfigStore.js';
import type { SyncHistoryEntry } from '@sandforge/shared';

/** Storage key for the entire sync history array. */
const SYNC_HISTORY_KEY = 'sync:history:all';

/** Config store category for sync history data. */
const SYNC_HISTORY_CATEGORY = 'syncHistory';

/** Maximum number of history entries retained (FIFO eviction). */
const MAX_HISTORY_SIZE = 500;

/**
 * Persists sync execution history entries to ConfigStore.
 *
 * All entries are stored under a single key as a JSON array to avoid
 * polluting the ConfigStore key namespace. Entries are capped at
 * {@link MAX_HISTORY_SIZE} with FIFO (oldest-first) eviction.
 */
export class SyncHistoryStore {
  /** @param configStore - The configuration store backend. */
  constructor(private readonly configStore: ConfigStore) {}

  /**
   * Persist a sync history entry.
   *
   * Deduplicates by `entry.id` (updating in place if the same ID exists).
   * If total entries exceed {@link MAX_HISTORY_SIZE}, the oldest entries
   * (by `startTime`) are evicted.
   *
   * @param entry - The history entry to save.
   */
  save(entry: SyncHistoryEntry): void {
    const entries = this.loadAll();
    const existingIndex = entries.findIndex((e) => e.id === entry.id);

    if (existingIndex >= 0) {
      entries[existingIndex] = entry;
    } else {
      entries.push(entry);
    }

    const trimmed =
      entries.length > MAX_HISTORY_SIZE
        ? entries
            .sort((a, b) => a.startTime.localeCompare(b.startTime))
            .slice(entries.length - MAX_HISTORY_SIZE)
        : entries;

    this.configStore.set(SYNC_HISTORY_KEY, trimmed, SYNC_HISTORY_CATEGORY);
  }

  /**
   * Load a single history entry by ID.
   *
   * @param id - The entry ID.
   * @returns The matching entry, or `undefined` if not found.
   */
  load(id: string): SyncHistoryEntry | undefined {
    return this.loadAll().find((e) => e.id === id);
  }

  /**
   * List all history entries sorted by `startTime` descending (newest first).
   *
   * @returns All stored history entries, newest first.
   */
  list(): SyncHistoryEntry[] {
    return this.loadAll().sort((a, b) => b.startTime.localeCompare(a.startTime));
  }

  /**
   * Delete a history entry by ID.
   *
   * @param id - The entry ID to delete.
   * @returns `true` if the entry existed and was removed, `false` otherwise.
   */
  delete(id: string): boolean {
    const entries = this.loadAll();
    const filtered = entries.filter((e) => e.id !== id);

    if (filtered.length === entries.length) {
      return false;
    }

    this.configStore.set(SYNC_HISTORY_KEY, filtered, SYNC_HISTORY_CATEGORY);
    return true;
  }

  /**
   * Export history entries as a JSON string.
   *
   * @param entryIds - Optional list of entry IDs to include. If omitted, all entries are exported.
   * @returns A formatted JSON string of the selected entries.
   */
  exportAsJson(entryIds?: string[]): string {
    const entries = this.getFilteredEntries(entryIds);
    return JSON.stringify(entries, null, 2);
  }

  /**
   * Export history entries as a CSV string.
   *
   * Columns: id, configName, status, totalProcessed, totalSuccess, totalFailed,
   * totalSkipped, startTime, endTime, duration, triggeredBy.
   *
   * @param entryIds - Optional list of entry IDs to include. If omitted, all entries are exported.
   * @returns A CSV string with header row and data rows.
   */
  exportAsCsv(entryIds?: string[]): string {
    const entries = this.getFilteredEntries(entryIds);
    const header =
      'id,configName,status,totalProcessed,totalSuccess,totalFailed,totalSkipped,startTime,endTime,duration,triggeredBy';

    const rows = entries.map((e) => {
      const configName = this.csvEscape(e.configSnapshot.name);
      return [
        e.id,
        configName,
        e.result.status,
        e.result.totalProcessed,
        e.result.totalSuccess,
        e.result.totalFailed,
        e.result.totalSkipped,
        e.startTime,
        e.endTime,
        e.result.duration,
        e.triggeredBy,
      ].join(',');
    });

    return [header, ...rows].join('\n');
  }

  /**
   * Remove all history entries.
   */
  clear(): void {
    this.configStore.delete(SYNC_HISTORY_KEY);
  }

  /** Load the raw array from ConfigStore. */
  private loadAll(): SyncHistoryEntry[] {
    const raw = this.configStore.get<SyncHistoryEntry[]>(SYNC_HISTORY_KEY);
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw;
  }

  /** Filter entries by IDs, or return all if no IDs specified. */
  private getFilteredEntries(entryIds?: string[]): SyncHistoryEntry[] {
    const all = this.list();
    if (!entryIds || entryIds.length === 0) {
      return all;
    }
    const idSet = new Set(entryIds);
    return all.filter((e) => idSet.has(e.id));
  }

  /** Wrap a value in double quotes if it contains a comma. */
  private csvEscape(value: string): string {
    if (value.includes(',')) {
      return `"${value}"`;
    }
    return value;
  }
}
