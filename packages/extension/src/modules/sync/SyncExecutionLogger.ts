import type { SyncConfig, SyncExecutionResult, SyncHistoryEntry } from '@sandforge/shared';
import type { ExportFormat } from '@sandforge/shared';
import type { SyncHistoryStore } from './SyncHistoryStore.js';

/**
 * Intercepts sync execution results and persists them as history entries.
 *
 * This logger wraps around the sync orchestrator's output to capture
 * a full snapshot of every execution (config + result) for the history
 * panel, re-run support, and CSV/JSON export.
 */
export class SyncExecutionLogger {
  /**
   * @param historyStore - The store used to persist history entries.
   * @param generateId - UUID generator function, injectable for testability.
   */
  constructor(
    private readonly historyStore: SyncHistoryStore,
    private readonly generateId: () => string = () => crypto.randomUUID(),
  ) {}

  /**
   * Log a sync execution as a history entry.
   *
   * Creates a {@link SyncHistoryEntry} with a deep-cloned config snapshot,
   * computes `startTime` from the result's timestamp and duration, and
   * persists it to the history store.
   *
   * @param config - The sync configuration used for this execution.
   * @param result - The execution result from the orchestrator.
   * @param triggeredBy - How the execution was triggered.
   * @param scheduleId - Optional schedule ID if triggered by a schedule.
   * @returns The created history entry.
   */
  logExecution(
    config: SyncConfig,
    result: SyncExecutionResult,
    triggeredBy: 'manual' | 'schedule' | 'rerun',
    scheduleId?: string,
  ): SyncHistoryEntry {
    const endTimeMs = new Date(result.timestamp).getTime();
    const startTimeMs = endTimeMs - result.duration;

    const entry: SyncHistoryEntry = {
      id: this.generateId(),
      // structuredClone preserves Date / Map / undefined properly, unlike
      // JSON round-trip which silently drops them.
      configSnapshot: structuredClone(config),
      result,
      startTime: new Date(startTimeMs).toISOString(),
      endTime: result.timestamp,
      triggeredBy,
      ...(scheduleId ? { scheduleId } : {}),
    };

    this.historyStore.save(entry);
    return entry;
  }

  /**
   * Retrieve all history entries (newest first).
   *
   * @returns All stored history entries.
   */
  getHistory(): SyncHistoryEntry[] {
    return this.historyStore.list();
  }

  /**
   * Retrieve a single history entry by ID.
   *
   * @param id - The entry ID.
   * @returns The matching entry, or `undefined` if not found.
   */
  getEntry(id: string): SyncHistoryEntry | undefined {
    return this.historyStore.load(id);
  }

  /**
   * Export history entries in the specified format.
   *
   * @param format - The export format ('csv' or 'json').
   * @param entryIds - Optional list of entry IDs to include.
   * @returns The exported data as a string.
   */
  exportHistory(format: ExportFormat, entryIds?: string[]): string {
    if (format === 'csv') {
      return this.historyStore.exportAsCsv(entryIds);
    }
    return this.historyStore.exportAsJson(entryIds);
  }
}
