import { describe, it, expect, beforeEach } from 'vitest';
import type * as vscode from 'vscode';
import { StorageAdapter } from './StorageAdapter.js';

/** In-memory Memento (globalState / workspaceState) mock. */
class MockMemento implements vscode.Memento {
  private data = new Map<string, unknown>();

  keys(): readonly string[] {
    return Array.from(this.data.keys());
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    if (!this.data.has(key)) {
      return defaultValue;
    }
    return this.data.get(key) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.data.delete(key);
    } else {
      this.data.set(key, value);
    }
  }

  setKeysForSync(_keys: readonly string[]): void {
    // noop
  }

  getInternal(): Map<string, unknown> {
    return this.data;
  }
}

/** In-memory SecretStorage mock. */
class MockSecretStorage implements vscode.SecretStorage {
  private data = new Map<string, string>();

  async keys(): Promise<string[]> {
    return Array.from(this.data.keys());
  }

  async get(key: string): Promise<string | undefined> {
    return this.data.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  onDidChange = (() => ({
    dispose: () => undefined,
  })) as unknown as vscode.Event<vscode.SecretStorageChangeEvent>;

  getInternal(): Map<string, string> {
    return this.data;
  }
}

function createContext(): {
  ctx: vscode.ExtensionContext;
  globalState: MockMemento;
  workspaceState: MockMemento;
  secrets: MockSecretStorage;
} {
  const globalState = new MockMemento();
  const workspaceState = new MockMemento();
  const secrets = new MockSecretStorage();
  const ctx = {
    globalState,
    workspaceState,
    secrets,
  } as unknown as vscode.ExtensionContext;
  return { ctx, globalState, workspaceState, secrets };
}

describe('StorageAdapter', () => {
  let adapter: StorageAdapter;
  let globalState: MockMemento;
  let workspaceState: MockMemento;
  let secrets: MockSecretStorage;

  beforeEach(() => {
    const scope = createContext();
    adapter = new StorageAdapter(scope.ctx);
    globalState = scope.globalState;
    workspaceState = scope.workspaceState;
    secrets = scope.secrets;
  });

  describe('globalState', () => {
    it('round-trips values via getGlobal / setGlobal', async () => {
      await adapter.setGlobal('sandforge.ns.field', { a: 1, b: 'two' });
      const value = adapter.getGlobal<{ a: number; b: string }>('sandforge.ns.field');
      expect(value).toEqual({ a: 1, b: 'two' });
    });

    it('returns undefined for missing globalState keys', () => {
      expect(adapter.getGlobal('missing')).toBeUndefined();
    });

    it('deleteGlobal removes the key', async () => {
      await adapter.setGlobal('x', 1);
      await adapter.deleteGlobal('x');
      expect(adapter.getGlobal('x')).toBeUndefined();
    });
  });

  describe('workspaceState', () => {
    it('round-trips values via getWorkspace / setWorkspace', async () => {
      await adapter.setWorkspace('wskey', [1, 2, 3]);
      const value = adapter.getWorkspace<number[]>('wskey');
      expect(value).toEqual([1, 2, 3]);
    });

    it('does not leak between globalState and workspaceState', async () => {
      await adapter.setGlobal('same.key', 'g');
      await adapter.setWorkspace('same.key', 'w');
      expect(adapter.getGlobal('same.key')).toBe('g');
      expect(adapter.getWorkspace('same.key')).toBe('w');
    });
  });

  describe('SecretStorage', () => {
    it('round-trips via setSecret / getSecret', async () => {
      await adapter.setSecret('sandforge.orgA.accessToken', 'tok-xyz');
      expect(await adapter.getSecret('sandforge.orgA.accessToken')).toBe('tok-xyz');
    });

    it('deleteSecret removes the secret', async () => {
      await adapter.setSecret('k', 'v');
      await adapter.deleteSecret('k');
      expect(await adapter.getSecret('k')).toBeUndefined();
    });

    it('overwrites an existing secret', async () => {
      await adapter.setSecret('k', 'first');
      await adapter.setSecret('k', 'second');
      expect(await adapter.getSecret('k')).toBe('second');
    });
  });

  describe('migrateLegacyKey', () => {
    it('moves a globalState string value into SecretStorage and deletes the old key', async () => {
      await globalState.update('legacy.apiKey', 'sk-1234');

      const migrated = await adapter.migrateLegacyKey(
        'legacy.apiKey',
        'sandforge.ai.anthropic.key',
        true,
      );

      expect(migrated).toBe(true);
      expect(await secrets.get('sandforge.ai.anthropic.key')).toBe('sk-1234');
      expect(globalState.getInternal().has('legacy.apiKey')).toBe(false);
    });

    it('serializes non-string values to JSON when migrating to SecretStorage', async () => {
      await globalState.update('legacy.blob', { refreshToken: 'rt-1', accessToken: 'at-1' });

      const migrated = await adapter.migrateLegacyKey('legacy.blob', 'sandforge.org.tokens', true);

      expect(migrated).toBe(true);
      const stored = await secrets.get('sandforge.org.tokens');
      expect(stored).toBeDefined();
      expect(JSON.parse(stored!)).toEqual({ refreshToken: 'rt-1', accessToken: 'at-1' });
      expect(globalState.getInternal().has('legacy.blob')).toBe(false);
    });

    it('moves a globalState value to a new globalState key when isSecret is false', async () => {
      await globalState.update('legacy.setting', { flag: true });

      const migrated = await adapter.migrateLegacyKey(
        'legacy.setting',
        'sandforge.ui.setting',
        false,
      );

      expect(migrated).toBe(true);
      expect(adapter.getGlobal('sandforge.ui.setting')).toEqual({ flag: true });
      expect(globalState.getInternal().has('legacy.setting')).toBe(false);
      expect(workspaceState.getInternal().size).toBe(0);
    });

    it('returns false when the old key is absent (no-op)', async () => {
      const migrated = await adapter.migrateLegacyKey('never.set', 'sandforge.whatever', true);

      expect(migrated).toBe(false);
      expect(await secrets.get('sandforge.whatever')).toBeUndefined();
    });

    it('does not clobber the new key when oldKey is missing', async () => {
      await secrets.store('sandforge.existing', 'keep-me');

      const migrated = await adapter.migrateLegacyKey('missing', 'sandforge.existing', true);

      expect(migrated).toBe(false);
      expect(await secrets.get('sandforge.existing')).toBe('keep-me');
    });
  });
});
