import type { ConfigStoreBackend, ConfigEntry } from './ConfigStoreBackend';
import { extractErrorMessage } from '../common/extractErrorMessage.js';

/**
 * Stores and retrieves configuration objects (templates, settings).
 * All values are stored as JSON strings, grouped by category.
 * Backed by a ConfigStoreBackend for persistence.
 */
export class ConfigStore {
  private backend: ConfigStoreBackend;
  private entries: Record<string, ConfigEntry> = {};
  private logWarning?: (msg: string) => void;

  constructor(backend: ConfigStoreBackend, logWarning?: (msg: string) => void) {
    this.backend = backend;
    this.logWarning = logWarning;
  }

  /** Load persisted entries from the backend */
  initialize(): void {
    this.entries = this.backend.getData();
  }

  /** Get a config value by key, parsed from JSON. Logs and returns undefined on parse error. */
  get<T>(key: string): T | undefined {
    const entry = this.entries[key];
    if (!entry) {
      return undefined;
    }
    try {
      return JSON.parse(entry.value) as T;
    } catch (err: unknown) {
      const msg = extractErrorMessage(err);
      this.logWarning?.(`[ConfigStore] Failed to parse JSON for key "${key}": ${msg}`);
      return undefined;
    }
  }

  /**
   * Set a config value (serialized to JSON).
   *
   * Dirty-check: a write that changes nothing is skipped, because persist()
   * re-serializes the whole blob and callers such as the Monitor poller call
   * set() on a timer (~2 880 times a day) with a value that is almost always
   * identical.
   *
   * The comparison is made on the serialized form. Reference equality would be
   * useless here — those callers rebuild an equal object on every tick, so it
   * would never match. A deep structural compare would have to re-parse the
   * stored JSON, costing more on large blobs than the write it saves. The
   * serialization is needed for the write anyway, so comparing the two strings
   * adds one O(n) compare and no extra allocation.
   *
   * A value that re-serializes with a different key order (or a changed
   * category) is treated as different and written: the check can only ever miss
   * a skip, never a real change, so no update is lost.
   */
  set<T>(key: string, value: T, category: string = 'general'): void {
    const serialized = JSON.stringify(value);
    const existing = this.entries[key];
    if (existing && existing.value === serialized && existing.category === category) {
      return;
    }
    this.entries[key] = {
      value: serialized,
      category,
    };
    this.persist();
  }

  /** Delete a config entry, returns true if a row was removed */
  delete(key: string): boolean {
    if (!(key in this.entries)) {
      return false;
    }
    delete this.entries[key];
    this.persist();
    return true;
  }

  /** Check if a config key exists */
  has(key: string): boolean {
    return key in this.entries;
  }

  /** Get all config entries in a category, keyed by their config key */
  getByCategory(category: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(this.entries)) {
      if (entry.category === category) {
        try {
          result[key] = JSON.parse(entry.value);
        } catch (err: unknown) {
          const msg = extractErrorMessage(err);
          this.logWarning?.(
            `[ConfigStore] Corrupted entry in category "${category}", key "${key}": ${msg}`,
          );
        }
      }
    }
    return result;
  }

  /** Get all stored config keys */
  getAllKeys(): string[] {
    return Object.keys(this.entries);
  }

  /** Get all config keys that start with the given prefix. */
  getKeysByPrefix(prefix: string): string[] {
    return Object.keys(this.entries).filter((key) => key.startsWith(prefix));
  }

  /** Delete all configs in a category, returns count of deleted rows */
  clearCategory(category: string): number {
    let count = 0;
    for (const [key, entry] of Object.entries(this.entries)) {
      if (entry.category === category) {
        delete this.entries[key];
        count++;
      }
    }
    if (count > 0) {
      this.persist();
    }
    return count;
  }

  /** Clear all config entries */
  clearAll(): void {
    this.entries = {};
    this.persist();
  }

  /** Persist current state to backend */
  private persist(): void {
    this.backend.setData({ ...this.entries });
  }
}
