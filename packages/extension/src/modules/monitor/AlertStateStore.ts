import type { ConfigStore } from '../../core/storage/ConfigStore.js';
import type { AlertDefinition, AlertInstance } from '@sandforge/shared';

/** Key prefix for alert state entries in the config store. */
const ALERT_PREFIX = 'alert:state:';

/** Config store category for alert data. */
const ALERT_CATEGORY = 'alerts';

/** Maximum number of history entries retained (FIFO). */
const MAX_HISTORY_SIZE = 500;

/**
 * Persists alert state (active alerts, definitions, and history) to ConfigStore.
 *
 * Follows the same wrapper pattern as GovernancePolicyStore:
 * a thin facade over ConfigStore with a dedicated key prefix and category.
 */
export class AlertStateStore {
  /** @param configStore - The configuration store backend. */
  constructor(private readonly configStore: ConfigStore) {}

  /**
   * Persist the current active alerts array.
   *
   * @param alerts - The active alert instances to persist.
   */
  saveAlerts(alerts: AlertInstance[]): void {
    this.configStore.set(`${ALERT_PREFIX}active`, alerts, ALERT_CATEGORY);
  }

  /**
   * Load persisted active alerts.
   *
   * @returns The stored alert instances, or an empty array if nothing is persisted.
   */
  loadAlerts(): AlertInstance[] {
    const raw = this.configStore.get<AlertInstance[]>(`${ALERT_PREFIX}active`);
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw;
  }

  /**
   * Persist alert definitions.
   *
   * @param definitions - The alert definitions to persist.
   */
  saveDefinitions(definitions: AlertDefinition[]): void {
    this.configStore.set(`${ALERT_PREFIX}definitions`, definitions, ALERT_CATEGORY);
  }

  /**
   * Load persisted alert definitions.
   *
   * @returns The stored definitions, or an empty array if nothing is persisted.
   */
  loadDefinitions(): AlertDefinition[] {
    const raw = this.configStore.get<AlertDefinition[]>(`${ALERT_PREFIX}definitions`);
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw;
  }

  /**
   * Append alerts to the history store (deduplicating by ID, capped at 500 FIFO).
   *
   * @param alerts - New alert instances to append.
   */
  saveHistory(alerts: AlertInstance[]): void {
    const existing = this.loadHistory();
    const existingIds = new Set(existing.map((a) => a.id));

    const newEntries = alerts.filter((a) => !existingIds.has(a.id));
    if (newEntries.length === 0) {
      return;
    }

    const combined = [...existing, ...newEntries];
    const trimmed =
      combined.length > MAX_HISTORY_SIZE
        ? combined.slice(combined.length - MAX_HISTORY_SIZE)
        : combined;

    this.configStore.set(`${ALERT_PREFIX}history`, trimmed, ALERT_CATEGORY);
  }

  /**
   * Load the full alert history.
   *
   * @returns The stored history array, or an empty array if nothing is persisted.
   */
  loadHistory(): AlertInstance[] {
    const raw = this.configStore.get<AlertInstance[]>(`${ALERT_PREFIX}history`);
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw;
  }
}
