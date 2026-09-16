import type { ConfigEntry, ConfigStoreBackend } from '../core/storage/ConfigStoreBackend';

/**
 * In-memory ConfigStore backend for tests.
 * Data persists for the lifetime of the instance only.
 */
export class InMemoryConfigStoreBackend implements ConfigStoreBackend {
  private data: Record<string, ConfigEntry> = {};

  /** Load all entries from memory */
  getData(): Record<string, ConfigEntry> {
    return { ...this.data };
  }

  /** Save all entries to memory */
  setData(data: Record<string, ConfigEntry>): void {
    this.data = { ...data };
  }
}
