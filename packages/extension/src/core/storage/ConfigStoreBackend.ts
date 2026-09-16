/** Single entry in the ConfigStore */
export interface ConfigEntry {
  /** JSON-serialized value */
  value: string;
  /** Category for grouping (e.g. 'settings', 'orgs') */
  category: string;
}

/**
 * Backend persistence for ConfigStore.
 * Reads are synchronous (from memory), writes may be fire-and-forget.
 */
export interface ConfigStoreBackend {
  /** Load all persisted entries. Called once at initialization. */
  getData(): Record<string, ConfigEntry>;
  /** Persist all entries. May be fire-and-forget for async backends. */
  setData(data: Record<string, ConfigEntry>): void;
}
