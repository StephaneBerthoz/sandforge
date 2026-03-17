import type { Memento } from 'vscode';
import type { ConfigStoreBackend, ConfigEntry } from './ConfigStoreBackend';

/** Key used in VSCode globalState to persist ConfigStore data */
const STORAGE_KEY = 'sandforge.configStore';

/**
 * ConfigStore backend using VSCode's Memento (globalState).
 * Reads are synchronous (Memento caches in memory).
 * Writes call Memento.update() fire-and-forget (updates in-memory cache immediately).
 */
export class MementoConfigStoreBackend implements ConfigStoreBackend {
  private memento: Memento;

  constructor(memento: Memento) {
    this.memento = memento;
  }

  /** Load all entries from globalState */
  getData(): Record<string, ConfigEntry> {
    return this.memento.get<Record<string, ConfigEntry>>(STORAGE_KEY, {});
  }

  /** Persist all entries to globalState (fire-and-forget) */
  setData(data: Record<string, ConfigEntry>): void {
    void this.memento.update(STORAGE_KEY, data);
  }
}
