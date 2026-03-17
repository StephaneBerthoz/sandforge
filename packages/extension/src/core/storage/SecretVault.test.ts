import { describe, it, expect, vi } from 'vitest';
import type { SecretStorageAdapter } from './SecretVault';
import { SecretVault } from './SecretVault';

/** In-memory mock of VSCode SecretStorage */
class MockSecretStorage implements SecretStorageAdapter {
  private data = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.data.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  /** Expose internal data map for test assertions */
  getInternalStore(): Map<string, string> {
    return this.data;
  }
}

describe('SecretVault', () => {
  function createVault(prefix = 'sandforge'): { vault: SecretVault; storage: MockSecretStorage } {
    const storage = new MockSecretStorage();
    const vault = new SecretVault(storage, prefix);
    return { vault, storage };
  }

  describe('storeSecret / getSecret', () => {
    it('should store and retrieve a secret string', async () => {
      const { vault } = createVault();

      await vault.storeSecret('token', 'abc123');

      const result = await vault.getSecret('token');
      expect(result).toBe('abc123');
    });

    it('should return undefined for a non-existent secret', async () => {
      const { vault } = createVault();

      const result = await vault.getSecret('missing');
      expect(result).toBeUndefined();
    });

    it('should overwrite an existing secret', async () => {
      const { vault } = createVault();

      await vault.storeSecret('token', 'old');
      await vault.storeSecret('token', 'new');

      const result = await vault.getSecret('token');
      expect(result).toBe('new');
    });
  });

  describe('deleteSecret', () => {
    it('should delete an existing secret', async () => {
      const { vault } = createVault();

      await vault.storeSecret('token', 'abc');
      await vault.deleteSecret('token');

      const result = await vault.getSecret('token');
      expect(result).toBeUndefined();
    });

    it('should not throw when deleting a non-existent secret', async () => {
      const { vault } = createVault();

      await expect(vault.deleteSecret('nonexistent')).resolves.toBeUndefined();
    });
  });

  describe('storeObject / getObject', () => {
    it('should round-trip a simple object', async () => {
      const { vault } = createVault();
      const obj = { username: 'admin', role: 'owner' };

      await vault.storeObject('user', obj);

      const result = await vault.getObject<typeof obj>('user');
      expect(result).toEqual(obj);
    });

    it('should round-trip a complex nested object', async () => {
      const { vault } = createVault();
      const tokens = {
        accessToken: 'at_123',
        refreshToken: 'rt_456',
        expiresAt: 1700000000,
        scopes: ['api', 'refresh_token'],
        metadata: {
          instanceUrl: 'https://test.salesforce.com',
          orgId: '00D000000000001',
        },
      };

      await vault.storeObject('oauth', tokens);

      const result = await vault.getObject<typeof tokens>('oauth');
      expect(result).toEqual(tokens);
    });

    it('should return undefined for corrupted JSON in getObject', async () => {
      const { vault } = createVault();
      await vault.storeSecret('corrupted', 'not-valid-json{');
      const result = await vault.getObject<{ foo: string }>('corrupted');
      expect(result).toBeUndefined();
    });

    it('should return undefined for a non-existent object key', async () => {
      const { vault } = createVault();

      const result = await vault.getObject<Record<string, string>>('missing');
      expect(result).toBeUndefined();
    });

    it('should round-trip arrays', async () => {
      const { vault } = createVault();
      const arr = ['token1', 'token2', 'token3'];

      await vault.storeObject('tokens', arr);

      const result = await vault.getObject<string[]>('tokens');
      expect(result).toEqual(arr);
    });

    it('should round-trip null', async () => {
      const { vault } = createVault();

      await vault.storeObject('nullable', null);

      const result = await vault.getObject('nullable');
      expect(result).toBeNull();
    });
  });

  describe('hasSecret', () => {
    it('should return true when a secret exists', async () => {
      const { vault } = createVault();
      await vault.storeSecret('api_key', 'secret123');

      expect(await vault.hasSecret('api_key')).toBe(true);
    });

    it('should return false when a secret does not exist', async () => {
      const { vault } = createVault();

      expect(await vault.hasSecret('missing')).toBe(false);
    });

    it('should return false after a secret is deleted', async () => {
      const { vault } = createVault();
      await vault.storeSecret('temp', 'value');
      await vault.deleteSecret('temp');

      expect(await vault.hasSecret('temp')).toBe(false);
    });
  });

  describe('logWarning callback', () => {
    it('should call logWarning when getObject encounters corrupted JSON', async () => {
      const storage = new MockSecretStorage();
      const warn = vi.fn();
      const vault = new SecretVault(storage, 'sandforge', warn);

      await vault.storeSecret('bad', 'not-valid-json{');
      const result = await vault.getObject<{ foo: string }>('bad');

      expect(result).toBeUndefined();
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('[SecretVault] Failed to parse JSON for key "bad"')
      );
    });

    it('should not call logWarning when getObject parses valid JSON', async () => {
      const storage = new MockSecretStorage();
      const warn = vi.fn();
      const vault = new SecretVault(storage, 'sandforge', warn);

      await vault.storeObject('ok', { hello: 'world' });
      await vault.getObject('ok');

      expect(warn).not.toHaveBeenCalled();
    });

    it('should not call logWarning when getObject key does not exist', async () => {
      const storage = new MockSecretStorage();
      const warn = vi.fn();
      const vault = new SecretVault(storage, 'sandforge', warn);

      await vault.getObject('missing');

      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('key prefixing', () => {
    it('should prefix all keys with the configured prefix', async () => {
      const { vault, storage } = createVault('myapp');

      await vault.storeSecret('token', 'value');

      const internalStore = storage.getInternalStore();
      expect(internalStore.has('myapp.token')).toBe(true);
      expect(internalStore.has('token')).toBe(false);
    });

    it('should use the default prefix when none is specified', async () => {
      const storage = new MockSecretStorage();
      const vault = new SecretVault(storage);

      await vault.storeSecret('key', 'value');

      const internalStore = storage.getInternalStore();
      expect(internalStore.has('sandforge.key')).toBe(true);
    });

    it('should isolate secrets between different prefixes', async () => {
      const storage = new MockSecretStorage();
      const vault1 = new SecretVault(storage, 'app1');
      const vault2 = new SecretVault(storage, 'app2');

      await vault1.storeSecret('token', 'from_app1');
      await vault2.storeSecret('token', 'from_app2');

      expect(await vault1.getSecret('token')).toBe('from_app1');
      expect(await vault2.getSecret('token')).toBe('from_app2');
    });
  });
});
