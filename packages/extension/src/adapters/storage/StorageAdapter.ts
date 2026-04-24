import type * as vscode from 'vscode';

/**
 * StorageAdapter — unified access to VSCode globalState, workspaceState, and SecretStorage.
 *
 * Provides:
 *  - typed get/set for ephemeral state (globalState / workspaceState)
 *  - secret get/set/delete backed by VSCode SecretStorage (OS keychain)
 *  - generic legacy-key migration helper (moves globalState value to SecretStorage
 *    or a new globalState key, then deletes the old entry)
 *
 * Key format convention: `sandforge.${namespace}.${field}` — enforced by callers.
 *
 * Why: centralises storage IO, avoids direct `context.globalState.*` scatter,
 * unblocks HARD-06 SecretStorage migration.
 */
export class StorageAdapter {
  private readonly context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  // ── globalState ─────────────────────────────────────────────

  /** Retrieve a typed value from globalState. */
  getGlobal<T>(key: string): T | undefined {
    return this.context.globalState.get<T>(key);
  }

  /** Persist a typed value to globalState. */
  async setGlobal<T>(key: string, value: T): Promise<void> {
    await this.context.globalState.update(key, value);
  }

  /** Delete a key from globalState. */
  async deleteGlobal(key: string): Promise<void> {
    await this.context.globalState.update(key, undefined);
  }

  // ── workspaceState ──────────────────────────────────────────

  /** Retrieve a typed value from workspaceState. */
  getWorkspace<T>(key: string): T | undefined {
    return this.context.workspaceState.get<T>(key);
  }

  /** Persist a typed value to workspaceState. */
  async setWorkspace<T>(key: string, value: T): Promise<void> {
    await this.context.workspaceState.update(key, value);
  }

  /** Delete a key from workspaceState. */
  async deleteWorkspace(key: string): Promise<void> {
    await this.context.workspaceState.update(key, undefined);
  }

  // ── SecretStorage ───────────────────────────────────────────

  /** Retrieve a secret from the OS keychain via SecretStorage. */
  async getSecret(key: string): Promise<string | undefined> {
    return this.context.secrets.get(key);
  }

  /** Persist a secret to the OS keychain via SecretStorage. */
  async setSecret(key: string, value: string): Promise<void> {
    await this.context.secrets.store(key, value);
  }

  /** Delete a secret from the OS keychain. */
  async deleteSecret(key: string): Promise<void> {
    await this.context.secrets.delete(key);
  }

  // ── Legacy migration ────────────────────────────────────────

  /**
   * Migrate a legacy globalState value to either SecretStorage or a new globalState key.
   *
   * @param oldKey  - legacy globalState key (e.g. `sandforge.apiKey`)
   * @param newKey  - new key (SecretStorage if isSecret, else globalState)
   * @param isSecret - true to move the value into SecretStorage, false for globalState
   * @returns true if a value was migrated, false if oldKey had no value
   */
  async migrateLegacyKey(oldKey: string, newKey: string, isSecret: boolean): Promise<boolean> {
    const existing = this.context.globalState.get<unknown>(oldKey);
    if (existing === undefined || existing === null) {
      return false;
    }

    if (isSecret) {
      const serialized = typeof existing === 'string' ? existing : JSON.stringify(existing);
      await this.context.secrets.store(newKey, serialized);
    } else {
      await this.context.globalState.update(newKey, existing);
    }

    await this.context.globalState.update(oldKey, undefined);
    return true;
  }
}
