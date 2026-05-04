import { describe, it, expect, vi } from 'vitest';
import { ConfigStore } from './ConfigStore';
import { InMemoryConfigStoreBackend } from './ConfigStoreBackend';

describe('ConfigStore', () => {
  function createStore(): ConfigStore {
    const backend = new InMemoryConfigStoreBackend();
    const store = new ConfigStore(backend);
    store.initialize();
    return store;
  }

  describe('initialize', () => {
    it('should load data from backend on initialize', () => {
      const backend = new InMemoryConfigStoreBackend();
      backend.setData({
        existing: { value: '"hello"', category: 'general' },
      });
      const store = new ConfigStore(backend);

      store.initialize();

      expect(store.get<string>('existing')).toBe('hello');
    });
  });

  describe('get / set', () => {
    it('should store and retrieve a string value', () => {
      const store = createStore();

      store.set('theme', 'dark');

      expect(store.get<string>('theme')).toBe('dark');
    });

    it('should store and retrieve a number value', () => {
      const store = createStore();

      store.set('timeout', 5000);

      expect(store.get<number>('timeout')).toBe(5000);
    });

    it('should store and retrieve a boolean value', () => {
      const store = createStore();

      store.set('enabled', true);

      expect(store.get<boolean>('enabled')).toBe(true);
    });

    it('should return undefined for a non-existent key', () => {
      const store = createStore();

      expect(store.get('nonexistent')).toBeUndefined();
    });

    it('should return undefined for corrupted JSON values', () => {
      const backend = new InMemoryConfigStoreBackend();
      backend.setData({
        corrupted: { value: '{not valid json', category: 'general' },
      });
      const store = new ConfigStore(backend);
      store.initialize();

      expect(store.get('corrupted')).toBeUndefined();
    });

    it('should overwrite an existing value', () => {
      const store = createStore();

      store.set('key', 'old');
      store.set('key', 'new');

      expect(store.get<string>('key')).toBe('new');
    });

    it('should round-trip complex JSON objects', () => {
      const store = createStore();
      const complex = {
        name: 'SandForge',
        version: 1,
        features: ['seed', 'sync', 'monitor'],
        nested: {
          deep: { value: true },
          list: [1, 2, 3],
        },
      };

      store.set('config', complex);

      expect(store.get('config')).toEqual(complex);
    });

    it('should round-trip arrays', () => {
      const store = createStore();
      const arr = ['alpha', 'beta', 'gamma'];

      store.set('items', arr);

      expect(store.get('items')).toEqual(arr);
    });

    it('should round-trip null values', () => {
      const store = createStore();

      store.set('nullable', null);

      expect(store.get('nullable')).toBeNull();
    });
  });

  describe('delete', () => {
    it('should remove an existing key and return true', () => {
      const store = createStore();
      store.set('key', 'value');

      const result = store.delete('key');

      expect(result).toBe(true);
      expect(store.get('key')).toBeUndefined();
    });

    it('should return false when deleting a non-existent key', () => {
      const store = createStore();

      const result = store.delete('nonexistent');

      expect(result).toBe(false);
    });
  });

  describe('has', () => {
    it('should return true for an existing key', () => {
      const store = createStore();
      store.set('exists', 42);

      expect(store.has('exists')).toBe(true);
    });

    it('should return false for a missing key', () => {
      const store = createStore();

      expect(store.has('missing')).toBe(false);
    });
  });

  describe('getByCategory', () => {
    it('should return all configs in a given category', () => {
      const store = createStore();
      store.set('db.host', 'localhost', 'database');
      store.set('db.port', 5432, 'database');
      store.set('ui.theme', 'dark', 'ui');

      const dbConfigs = store.getByCategory('database');

      expect(dbConfigs['db.host']).toBe('localhost');
      expect(dbConfigs['db.port']).toBe(5432);
      expect(dbConfigs['ui.theme']).toBeUndefined();
    });

    it('should return empty object for a category with no entries', () => {
      const store = createStore();

      const result = store.getByCategory('empty');

      expect(result).toEqual({});
    });

    it('should skip corrupted JSON entries in getByCategory', () => {
      const backend = new InMemoryConfigStoreBackend();
      backend.setData({
        good: { value: '"valid"', category: 'cat' },
        bad: { value: '{broken json', category: 'cat' },
      });
      const store = new ConfigStore(backend);
      store.initialize();

      const result = store.getByCategory('cat');

      expect(result['good']).toBe('valid');
      expect(result['bad']).toBeUndefined();
    });
  });

  describe('getAllKeys', () => {
    it('should return all stored keys', () => {
      const store = createStore();
      store.set('a', 1);
      store.set('b', 2);
      store.set('c', 3);

      const keys = store.getAllKeys();

      expect(keys).toHaveLength(3);
      expect(keys).toContain('a');
      expect(keys).toContain('b');
      expect(keys).toContain('c');
    });

    it('should return empty array when no configs exist', () => {
      const store = createStore();

      expect(store.getAllKeys()).toEqual([]);
    });
  });

  describe('getKeysByPrefix', () => {
    it('should return keys matching the prefix', () => {
      const store = createStore();
      store.set('sync:mapping-1', { a: 1 });
      store.set('sync:mapping-2', { b: 2 });
      store.set('pipeline:pipe-1', { c: 3 });

      const keys = store.getKeysByPrefix('sync:');

      expect(keys).toHaveLength(2);
      expect(keys).toContain('sync:mapping-1');
      expect(keys).toContain('sync:mapping-2');
    });

    it('should return empty array when no keys match', () => {
      const store = createStore();
      store.set('other:key', { a: 1 });

      expect(store.getKeysByPrefix('sync:')).toEqual([]);
    });

    it('should return empty array when store is empty', () => {
      const store = createStore();

      expect(store.getKeysByPrefix('any:')).toEqual([]);
    });
  });

  describe('clearCategory', () => {
    it('should delete all configs in a category and return count', () => {
      const store = createStore();
      store.set('db.host', 'localhost', 'database');
      store.set('db.port', 5432, 'database');
      store.set('ui.theme', 'dark', 'ui');

      const deleted = store.clearCategory('database');

      expect(deleted).toBe(2);
      expect(store.has('db.host')).toBe(false);
      expect(store.has('ui.theme')).toBe(true);
    });

    it('should return 0 when category has no entries', () => {
      const store = createStore();

      expect(store.clearCategory('empty')).toBe(0);
    });
  });

  describe('clearAll', () => {
    it('should remove all config entries', () => {
      const store = createStore();
      store.set('a', 1);
      store.set('b', 2);
      store.set('c', 3);

      store.clearAll();

      expect(store.getAllKeys()).toEqual([]);
    });
  });

  describe('logWarning callback', () => {
    it('should call logWarning when get() encounters corrupted JSON', () => {
      const backend = new InMemoryConfigStoreBackend();
      backend.setData({
        bad: { value: '{invalid json', category: 'general' },
      });
      const warn = vi.fn();
      const store = new ConfigStore(backend, warn);
      store.initialize();

      store.get('bad');

      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('[ConfigStore] Failed to parse JSON for key "bad"'),
      );
    });

    it('should call logWarning for each corrupted entry in getByCategory', () => {
      const backend = new InMemoryConfigStoreBackend();
      backend.setData({
        ok: { value: '"valid"', category: 'cat' },
        bad1: { value: '{broken', category: 'cat' },
        bad2: { value: 'also broken', category: 'cat' },
      });
      const warn = vi.fn();
      const store = new ConfigStore(backend, warn);
      store.initialize();

      store.getByCategory('cat');

      expect(warn).toHaveBeenCalledTimes(2);
    });

    it('should not call logWarning when JSON is valid', () => {
      const backend = new InMemoryConfigStoreBackend();
      backend.setData({
        good: { value: '"hello"', category: 'general' },
      });
      const warn = vi.fn();
      const store = new ConfigStore(backend, warn);
      store.initialize();

      store.get('good');

      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('persistence', () => {
    it('should persist changes to backend on set', () => {
      const backend = new InMemoryConfigStoreBackend();
      const store = new ConfigStore(backend);
      store.initialize();

      store.set('key', 'value', 'cat');

      const data = backend.getData();
      expect(data['key']).toEqual({ value: '"value"', category: 'cat' });
    });

    it('should persist changes to backend on delete', () => {
      const backend = new InMemoryConfigStoreBackend();
      const store = new ConfigStore(backend);
      store.initialize();
      store.set('key', 'value');

      store.delete('key');

      expect(backend.getData()).toEqual({});
    });

    it('should survive re-initialization from same backend', () => {
      const backend = new InMemoryConfigStoreBackend();
      const store1 = new ConfigStore(backend);
      store1.initialize();
      store1.set('theme', 'dark', 'settings');
      store1.set('lang', 'fr', 'settings');

      const store2 = new ConfigStore(backend);
      store2.initialize();

      expect(store2.get<string>('theme')).toBe('dark');
      expect(store2.get<string>('lang')).toBe('fr');
    });
  });
});
