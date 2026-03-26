import type { ConfigStore } from '../../core/storage/ConfigStore.js';
import type { SyncConfig } from '@sandforge/shared';

/** Key prefix for sync config entries in the config store. */
const SYNC_CONFIG_PREFIX = 'sync:config:';

/** Config store category for sync configuration data. */
const SYNC_CONFIG_CATEGORY = 'syncConfigs';

/**
 * Persists sync configurations to ConfigStore.
 *
 * Thin facade over ConfigStore with a dedicated key prefix (`sync:config:`)
 * and category (`syncConfigs`). Follows the same pattern as AlertStateStore.
 */
export class SyncConfigStore {
  /** @param configStore - The configuration store backend. */
  constructor(private readonly configStore: ConfigStore) {}

  /**
   * Persist a sync configuration.
   *
   * @param config - The sync configuration to save.
   */
  save(config: SyncConfig): void {
    this.configStore.set(`${SYNC_CONFIG_PREFIX}${config.id}`, config, SYNC_CONFIG_CATEGORY);
  }

  /**
   * Load a sync configuration by ID.
   *
   * @param id - The configuration ID.
   * @returns The stored config, or `undefined` if not found.
   */
  load(id: string): SyncConfig | undefined {
    return this.configStore.get<SyncConfig>(`${SYNC_CONFIG_PREFIX}${id}`);
  }

  /**
   * List all persisted sync configurations, sorted by `updatedAt` descending.
   *
   * @returns All stored sync configs, newest first.
   */
  list(): SyncConfig[] {
    const byCategory = this.configStore.getByCategory(SYNC_CONFIG_CATEGORY);
    const configs = Object.values(byCategory) as SyncConfig[];
    return configs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * Delete a sync configuration by ID.
   *
   * @param id - The configuration ID to delete.
   * @returns `true` if the entry existed and was removed, `false` otherwise.
   */
  delete(id: string): boolean {
    return this.configStore.delete(`${SYNC_CONFIG_PREFIX}${id}`);
  }
}
