import type { ForgeExecutionResult } from '@sandforge/shared';

/** Max stored history entries. */
const MAX_HISTORY = 50;
/** Max entries shown in UI. */
const DISPLAY_LIMIT = 10;
/** Storage key in globalState. */
const STORAGE_KEY = 'forge:history';

/** Dependencies for ForgeHistoryStore. */
export interface ForgeHistoryStoreDeps {
  /** Read from globalState. */
  get: (key: string) => unknown;
  /** Write to globalState. */
  update: (key: string, value: unknown) => Promise<void>;
}

/**
 * Persists Forge execution history in VSCode globalState.
 * Stores up to 50 entries, displays up to 10 in the UI.
 */
export class ForgeHistoryStore {
  private readonly deps: ForgeHistoryStoreDeps;

  /** @param deps - globalState accessor. */
  constructor(deps: ForgeHistoryStoreDeps) {
    this.deps = deps;
  }

  /** List all stored history (newest first). */
  list(): ForgeExecutionResult[] {
    return (this.deps.get(STORAGE_KEY) as ForgeExecutionResult[] | undefined) ?? [];
  }

  /** List recent history for UI display (newest first, max 10). */
  listRecent(): ForgeExecutionResult[] {
    return this.list().slice(0, DISPLAY_LIMIT);
  }

  /** Add a result to history (newest first, capped at 50). */
  async add(result: ForgeExecutionResult): Promise<void> {
    const history = this.list();
    history.unshift(result);
    if (history.length > MAX_HISTORY) {
      history.length = MAX_HISTORY;
    }
    await this.deps.update(STORAGE_KEY, history);
  }

  /** Clear all history. */
  async clear(): Promise<void> {
    await this.deps.update(STORAGE_KEY, []);
  }
}
