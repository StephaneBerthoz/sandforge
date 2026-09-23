import { randomUUID } from 'node:crypto';

import type { ConfigStoreBackend, ConfigEntry } from './ConfigStoreBackend';
import { extractErrorMessage } from '../common/extractErrorMessage.js';

/**
 * The entry saying which store wrote the backend's data last, and which of
 * its writes that was. Never listed: no key a caller asks for, and no prefix,
 * starts with the character this one starts with.
 */
const REVISION_KEY = '\u0000configStore:revision';

/** The category of {@link REVISION_KEY}, which no caller asks for either. */
const REVISION_CATEGORY = '\u0000configStore';

/** Who wrote the backend's data, and how many writes it had made then. */
interface Revision {
  writer: string;
  write: number;
}

/** The revision stamped on `entries`, or undefined for data no store of this kind stamped. */
function revisionOf(entries: Record<string, ConfigEntry>): Revision | undefined {
  const raw = entries[REVISION_KEY]?.value;
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<Revision>;
    return typeof parsed.writer === 'string' && typeof parsed.write === 'number'
      ? { writer: parsed.writer, write: parsed.write }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stores and retrieves configuration objects (templates, settings).
 * All values are stored as JSON strings, grouped by category.
 * Backed by a ConfigStoreBackend for persistence.
 *
 * The backend is read on every call, and every write re-reads it and changes
 * only the entries it names. The backend behind the extension is globalState,
 * which every open window shares. The store used to load it once and write its
 * own copy back whole, so a template saved in one window reached another only
 * after a reload, and that window's next write of anything put its stale copy
 * back: the template, a schedule, a pipeline or an audit trail line saved
 * elsewhere was gone. Reading afresh also matters to a list kept under one
 * key, such as the audit trail: its owner reads it, appends and writes it
 * back, and must start from the lines the other window added.
 *
 * What globalState holds can also be older than this store's last write. VS
 * Code sends every write of an extension's state back to the window that made
 * it, and the memento takes what it is sent: the echo of one write, arriving
 * after the next one was made, stands in for both until the next echo comes.
 * A write built on it would drop the write in between. So every write is
 * stamped with the store that made it and its number, and data stamped with
 * an earlier write of this store is read as this store last wrote it.
 */
export class ConfigStore {
  private backend: ConfigStoreBackend;
  private logWarning?: (msg: string) => void;
  /** Who this store is in the stamps of its writes: one store per window. */
  private readonly writer = randomUUID();
  /** How many writes this store has made. */
  private writes = 0;
  /** The data as this store last wrote it. */
  private written: Record<string, ConfigEntry> | undefined;

  constructor(backend: ConfigStoreBackend, logWarning?: (msg: string) => void) {
    this.backend = backend;
    this.logWarning = logWarning;
  }

  /**
   * Read the backend once, so one that cannot be read fails when the store is
   * built rather than on its first use. Nothing is kept from it.
   */
  initialize(): void {
    this.backend.getData();
  }

  /** Get a config value by key, parsed from JSON. Logs and returns undefined on parse error. */
  get<T>(key: string): T | undefined {
    const entry = this.current()[key];
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
   * Dirty-check: a write that changes nothing is skipped, because the backend
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
    this.update((entries) => {
      const existing = entries[key];
      if (existing && existing.value === serialized && existing.category === category) {
        return false;
      }
      entries[key] = { value: serialized, category };
      return true;
    });
  }

  /** Delete a config entry, returns true if a row was removed */
  delete(key: string): boolean {
    return this.update((entries) => {
      if (!(key in entries)) {
        return false;
      }
      delete entries[key];
      return true;
    });
  }

  /** Check if a config key exists */
  has(key: string): boolean {
    return key in this.current();
  }

  /** Get all config entries in a category, keyed by their config key */
  getByCategory(category: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(this.current())) {
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
    return Object.keys(this.current()).filter((key) => key !== REVISION_KEY);
  }

  /** Get all config keys that start with the given prefix. */
  getKeysByPrefix(prefix: string): string[] {
    return this.getAllKeys().filter((key) => key.startsWith(prefix));
  }

  /** Delete all configs in a category, returns count of deleted rows */
  clearCategory(category: string): number {
    let count = 0;
    this.update((entries) => {
      for (const [key, entry] of Object.entries(entries)) {
        if (entry.category === category) {
          delete entries[key];
          count++;
        }
      }
      return count > 0;
    });
    return count;
  }

  /** Clear all config entries */
  clearAll(): void {
    this.write({});
  }

  /**
   * The entries as the backend holds them now, which another window may have
   * changed — or as this store last wrote them, when what the backend holds
   * is the echo of one of this store's earlier writes.
   */
  private current(): Record<string, ConfigEntry> {
    const held = this.backend.getData();
    const revision = revisionOf(held);
    if (this.written && revision?.writer === this.writer && revision.write < this.writes) {
      return this.written;
    }
    return held;
  }

  /**
   * Apply one change to the entries as they are now and write the result.
   * The change works on a copy: a backend such as globalState hands out the
   * object it keeps, which must change only through its own write.
   * Returns what `change` returned: whether there was anything to write.
   */
  private update(change: (entries: Record<string, ConfigEntry>) => boolean): boolean {
    const entries = { ...this.current() };
    const changed = change(entries);
    if (changed) {
      this.write(entries);
    }
    return changed;
  }

  /** Stamp `entries` as this store's next write, and hand them to the backend. */
  private write(entries: Record<string, ConfigEntry>): void {
    this.writes += 1;
    entries[REVISION_KEY] = {
      value: JSON.stringify({ writer: this.writer, write: this.writes } satisfies Revision),
      category: REVISION_CATEGORY,
    };
    this.backend.setData(entries);
    this.written = entries;
  }
}
