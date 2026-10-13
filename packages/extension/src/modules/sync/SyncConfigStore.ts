import type { ConfigStore } from '../../core/storage/ConfigStore.js';
import type { SyncConfig } from '@sandforge/shared';
import {
  readDeltaState,
  type SyncDeltaLoad,
  type SyncDeltaState,
  type SyncWatermark,
} from './SyncDelta.js';

/** Key prefix for sync config entries in the config store. */
const SYNC_CONFIG_PREFIX = 'sync:config:';

/** Config store category for sync configuration data. */
const SYNC_CONFIG_CATEGORY = 'syncConfigs';

/** Key prefix of a configuration's watermarks, beside the configuration itself. */
const SYNC_DELTA_PREFIX = 'sync:delta:';

/**
 * Category of the watermarks: apart from the configurations', so the list of
 * configurations never reads one as a configuration.
 */
const SYNC_DELTA_CATEGORY = 'syncDelta';

/**
 * Persists sync configurations to ConfigStore.
 *
 * Thin facade over ConfigStore with a dedicated key prefix (`sync:config:`)
 * and category (`syncConfigs`). Follows the same pattern as AlertStateStore.
 *
 * A delta configuration's watermarks are kept beside it, under its id: see
 * `SyncDelta`. Deleting the configuration deletes them.
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
   * Delete a sync configuration by ID, and its watermarks with it.
   *
   * @param id - The configuration ID to delete.
   * @returns `true` if the entry existed and was removed, `false` otherwise.
   */
  delete(id: string): boolean {
    this.configStore.delete(`${SYNC_DELTA_PREFIX}${id}`);
    return this.configStore.delete(`${SYNC_CONFIG_PREFIX}${id}`);
  }

  /**
   * The watermarks of a configuration, read as watermarks or not at all: see
   * `readDeltaState`. The store is a file anyone can edit, and a watermark
   * read wrong would skip records for good.
   *
   * @param id - The configuration ID.
   */
  loadDelta(id: string): SyncDeltaLoad {
    return readDeltaState(this.configStore.get<unknown>(`${SYNC_DELTA_PREFIX}${id}`));
  }

  /**
   * Record one object's watermark, replacing the one it had for the same pair
   * of orgs. Stored data that did not read as watermarks is replaced.
   *
   * @param id - The configuration ID.
   * @param watermark - The object's new watermark.
   */
  recordWatermark(id: string, watermark: SyncWatermark): void {
    const current = this.loadDelta(id);
    const entries = current.kind === 'stored' ? current.state.entries : [];
    const kept = entries.filter(
      (e) =>
        e.sourceOrgId !== watermark.sourceOrgId ||
        e.targetOrgId !== watermark.targetOrgId ||
        e.objectApiName !== watermark.objectApiName,
    );
    const state: SyncDeltaState = {
      version: 1,
      entries: [...kept, watermark],
      ...(current.kind === 'stored' && current.state.resetAt
        ? { resetAt: current.state.resetAt }
        : {}),
    };
    this.configStore.set(`${SYNC_DELTA_PREFIX}${id}`, state, SYNC_DELTA_CATEGORY);
  }

  /**
   * "Run full next time": clear every watermark of a configuration, so its
   * next run reads each object whole and says it was asked to.
   *
   * @param id - The configuration ID.
   * @returns How many watermarks were cleared.
   */
  clearDelta(id: string): number {
    const current = this.loadDelta(id);
    const cleared = current.kind === 'stored' ? current.state.entries.length : 0;
    const state: SyncDeltaState = { version: 1, entries: [], resetAt: new Date().toISOString() };
    this.configStore.set(`${SYNC_DELTA_PREFIX}${id}`, state, SYNC_DELTA_CATEGORY);
    return cleared;
  }
}
