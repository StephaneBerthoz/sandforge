import type { ConfigStore } from '../../core/storage/ConfigStore.js';
import type { SyncConfig } from '@sandforge/shared';
import {
  readDeltaState,
  type SyncDeltaLoad,
  type SyncDeltaState,
  type SyncDeltaStore,
  type SyncWatermark,
} from './SyncDelta.js';
import {
  readFileMap,
  SYNC_FILE_MAP_MAX,
  type SyncCopiedFile,
  type SyncFileMap,
  type SyncFileMapLoad,
  type SyncFileStore,
} from './SyncFiles.js';

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

/** Key prefix of the files a configuration copied, beside its watermarks. */
const SYNC_FILES_PREFIX = 'sync:files:';

/** Category of the files a configuration copied. */
const SYNC_FILES_CATEGORY = 'syncFiles';

/**
 * Persists sync configurations to ConfigStore.
 *
 * Thin facade over ConfigStore with a dedicated key prefix (`sync:config:`)
 * and category (`syncConfigs`). Follows the same pattern as AlertStateStore.
 *
 * A delta configuration's watermarks are kept beside it, under its id: see
 * `SyncDelta`. So is the record of the files a configuration copied: see
 * `SyncFiles`. Deleting the configuration deletes both.
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
   * Whether a configuration is saved under that id: what a removal of one of
   * its runs tells only a saved one (see `SyncRemovalConfigs`).
   *
   * @param id - The configuration ID.
   */
  isSaved(id: string): boolean {
    return this.load(id) !== undefined;
  }

  /**
   * Where a run keeps its watermarks: beside the saved configuration of the
   * same id, and nowhere for one that is not saved. The panel's runs and the
   * command line's runs of a saved configuration keep them here alike.
   */
  deltaStore(): SyncDeltaStore {
    return {
      load: (configId) => (this.isSaved(configId) ? this.loadDelta(configId) : null),
      record: (configId, watermark) => this.recordWatermark(configId, watermark),
    };
  }

  /**
   * Where a run keeps the files it copied: beside the saved configuration of
   * the same id, and nowhere for one that is not saved, which copies none.
   */
  fileStore(): SyncFileStore {
    return {
      load: (configId) => (this.isSaved(configId) ? this.loadFiles(configId) : null),
      record: (configId, entry) => this.recordFile(configId, entry),
    };
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
    this.configStore.delete(`${SYNC_FILES_PREFIX}${id}`);
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
   * The files a configuration copied, read as such or not at all: see
   * `readFileMap`. A record read wrong would copy files a second time.
   *
   * @param id - The configuration ID.
   */
  loadFiles(id: string): SyncFileMapLoad {
    return readFileMap(this.configStore.get<unknown>(`${SYNC_FILES_PREFIX}${id}`));
  }

  /**
   * Record one copied file, replacing what was kept of the same source file
   * between the same orgs. Kept as soon as the file exists in the target, so a
   * run stopped right after never copies it again.
   *
   * @param id - The configuration ID.
   * @param entry - The file as copied.
   * @throws {Error} When the record holds as many files as it may, or does not read.
   */
  recordFile(id: string, entry: SyncCopiedFile): void {
    const current = this.loadFiles(id);
    if (current.kind === 'unreadable') {
      throw new Error(`the record of copied files does not read: ${current.issue}`);
    }
    const entries = current.kind === 'stored' ? current.map.entries : [];
    const kept = entries.filter(
      (e) =>
        e.sourceOrgId !== entry.sourceOrgId ||
        e.targetOrgId !== entry.targetOrgId ||
        e.sourceId !== entry.sourceId,
    );
    if (kept.length >= SYNC_FILE_MAP_MAX) {
      throw new Error(`the record of copied files holds ${SYNC_FILE_MAP_MAX} files already`);
    }
    const map: SyncFileMap = { version: 1, entries: [...kept, entry] };
    this.configStore.set(`${SYNC_FILES_PREFIX}${id}`, map, SYNC_FILES_CATEGORY);
  }

  /**
   * Forget the copies a removal deleted from the target: the entries of the
   * files copied between these orgs whose copy is one of `targetIds`. Kept,
   * an entry had the next run take the file as copied and link the records to
   * a copy that is gone; forgotten, the next run that reads the file's record
   * copies it again. Nothing is changed when none is kept.
   *
   * @param id - The configuration ID.
   * @param orgs - The orgs the run copied between.
   * @param targetIds - The copies deleted, by id, whichever length it is written in.
   * @returns The entries forgotten, with the object each was copied for.
   */
  forgetFiles(
    id: string,
    orgs: { sourceOrgId: string; targetOrgId: string },
    targetIds: readonly string[],
  ): SyncCopiedFile[] {
    const current = this.loadFiles(id);
    if (current.kind !== 'stored' || targetIds.length === 0) return [];
    const gone = new Set(targetIds.map((targetId) => targetId.slice(0, 15)));
    const forgotten: SyncCopiedFile[] = [];
    const kept = current.map.entries.filter((entry) => {
      const goes =
        entry.sourceOrgId === orgs.sourceOrgId &&
        entry.targetOrgId === orgs.targetOrgId &&
        gone.has(entry.targetId.slice(0, 15));
      if (goes) forgotten.push(entry);
      return !goes;
    });
    if (forgotten.length > 0) {
      const map: SyncFileMap = { version: 1, entries: kept };
      this.configStore.set(`${SYNC_FILES_PREFIX}${id}`, map, SYNC_FILES_CATEGORY);
    }
    return forgotten;
  }

  /**
   * Have the next run read `objects` whole: a removal took back records or
   * files a run had created for them, and a delta read from their watermark
   * would take the copies for still there. Only an object with a watermark
   * between these orgs is marked; one without is read whole anyway.
   *
   * @param id - The configuration ID.
   * @param orgs - The orgs the run copied between.
   * @param objects - The objects whose copies the removal took.
   * @param at - When the removal ended.
   * @returns The objects marked.
   */
  markRemoved(
    id: string,
    orgs: { sourceOrgId: string; targetOrgId: string },
    objects: readonly string[],
    at: string,
  ): string[] {
    const current = this.loadDelta(id);
    if (current.kind !== 'stored' || objects.length === 0) return [];
    const marked: string[] = [];
    const entries = current.state.entries.map((entry) => {
      if (
        entry.sourceOrgId !== orgs.sourceOrgId ||
        entry.targetOrgId !== orgs.targetOrgId ||
        !objects.includes(entry.objectApiName)
      ) {
        return entry;
      }
      marked.push(entry.objectApiName);
      return { ...entry, removedAt: at };
    });
    if (marked.length > 0) {
      const state: SyncDeltaState = { ...current.state, entries };
      this.configStore.set(`${SYNC_DELTA_PREFIX}${id}`, state, SYNC_DELTA_CATEGORY);
    }
    return marked;
  }

  /**
   * "Run full next time": clear every watermark of a configuration, so its
   * next run reads each object whole and says it was asked to. The record of
   * the files it copied stays: a full read copies none of them twice.
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
