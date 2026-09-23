import { describe, it, expect, vi } from 'vitest';
import { ConfigStore } from './ConfigStore';
import type { ConfigEntry, ConfigStoreBackend } from './ConfigStoreBackend';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend';

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

      expect(backend.getData()['key']).toBeUndefined();
      expect(new ConfigStore(backend).getAllKeys()).toEqual([]);
    });

    it('should not persist when set is called with an unchanged primitive', () => {
      const backend = new InMemoryConfigStoreBackend();
      const store = new ConfigStore(backend);
      store.initialize();
      store.set('key', 'value', 'cat');
      const spy = vi.spyOn(backend, 'setData');

      store.set('key', 'value', 'cat');

      expect(spy).not.toHaveBeenCalled();
    });

    it('should not persist when set is called with an equal but distinct object', () => {
      const backend = new InMemoryConfigStoreBackend();
      const store = new ConfigStore(backend);
      store.initialize();
      store.set('status', { org: 'dev', jobs: [1, 2], healthy: true }, 'monitor');
      const spy = vi.spyOn(backend, 'setData');

      // Rebuilt object: same content, different reference — what a poller produces
      store.set('status', { org: 'dev', jobs: [1, 2], healthy: true }, 'monitor');

      expect(spy).not.toHaveBeenCalled();
      expect(store.get('status')).toEqual({ org: 'dev', jobs: [1, 2], healthy: true });
    });

    it('should persist when the value actually changes', () => {
      const backend = new InMemoryConfigStoreBackend();
      const store = new ConfigStore(backend);
      store.initialize();
      store.set('status', { jobs: [1, 2] }, 'monitor');
      const spy = vi.spyOn(backend, 'setData');

      store.set('status', { jobs: [1, 2, 3] }, 'monitor');

      expect(spy).toHaveBeenCalledTimes(1);
      expect(store.get('status')).toEqual({ jobs: [1, 2, 3] });
    });

    it('should persist when only the category changes', () => {
      const backend = new InMemoryConfigStoreBackend();
      const store = new ConfigStore(backend);
      store.initialize();
      store.set('key', 'value', 'cat');
      const spy = vi.spyOn(backend, 'setData');

      store.set('key', 'value', 'other');

      expect(spy).toHaveBeenCalledTimes(1);
      expect(backend.getData()['key']).toEqual({ value: '"value"', category: 'other' });
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

    it('changes the object a backend hands out only through its write', () => {
      // globalState hands out the object it keeps, not a copy.
      const held: Record<string, ConfigEntry> = { kept: { value: '1', category: 'general' } };
      const setData = vi.fn();
      const store = new ConfigStore({ getData: () => held, setData });
      store.initialize();

      store.set('added', 2);
      store.delete('kept');

      expect(held).toEqual({ kept: { value: '1', category: 'general' } });
      const [written] = setData.mock.lastCall as [Record<string, ConfigEntry>];
      expect(written).not.toHaveProperty('kept');
      expect(written).not.toBe(held);
    });
  });

  describe('the echo of its own earlier write', () => {
    /**
     * globalState as a window's extension host sees it: VS Code sends each
     * write back to the window that made it, and the memento takes what it is
     * sent — the echo of one write can arrive after the next one was made.
     */
    class EchoingBackend implements ConfigStoreBackend {
      private data: Record<string, ConfigEntry> = {};
      readonly writes: Array<Record<string, ConfigEntry>> = [];
      getData(): Record<string, ConfigEntry> {
        return this.data;
      }
      setData(data: Record<string, ConfigEntry>): void {
        this.data = JSON.parse(JSON.stringify(data)) as Record<string, ConfigEntry>;
        this.writes.push(this.data);
      }
      /** The echo of write `index` arriving now. */
      echo(index: number): void {
        this.data = JSON.parse(JSON.stringify(this.writes[index])) as Record<string, ConfigEntry>;
      }
    }

    it('is read as the store last wrote it, and a write built on it keeps the one in between', () => {
      const backend = new EchoingBackend();
      const store = new ConfigStore(backend);
      store.initialize();
      store.set('seed-template:a', { id: 'a' }, 'seedTemplates');
      store.set('schedule:sync:b', { id: 'b' }, 'syncSchedules');

      backend.echo(0);

      expect(store.get('schedule:sync:b')).toEqual({ id: 'b' });
      store.set('pipeline:saved:c', { id: 'c' }, 'pipelines');
      expect(new ConfigStore(backend).getAllKeys().sort()).toEqual([
        'pipeline:saved:c',
        'schedule:sync:b',
        'seed-template:a',
      ]);
    });

    it('does not stand for another window’s later write', () => {
      const backend = new EchoingBackend();
      const first = new ConfigStore(backend);
      const second = new ConfigStore(backend);
      first.set('seed-template:a', { id: 'a' }, 'seedTemplates');
      first.set('seed-template:a', { id: 'a', name: 'renamed' }, 'seedTemplates');

      second.delete('seed-template:a');

      expect(first.get('seed-template:a')).toBeUndefined();
    });
  });

  describe('two windows over one globalState', () => {
    /** Two windows open on the same globalState, each with its own store. */
    function twoWindows(): {
      backend: InMemoryConfigStoreBackend;
      first: ConfigStore;
      second: ConfigStore;
    } {
      const backend = new InMemoryConfigStoreBackend();
      backend.setData({
        'schedule:sync:old': { value: '{"id":"old"}', category: 'syncSchedules' },
      });
      const first = new ConfigStore(backend);
      first.initialize();
      const second = new ConfigStore(backend);
      second.initialize();
      return { backend, first, second };
    }

    it('reads a save made in the other window without a reload', () => {
      const { first, second } = twoWindows();

      first.set('seed-template:a', { id: 'a' }, 'seedTemplates');

      expect(second.get('seed-template:a')).toEqual({ id: 'a' });
      expect(second.has('seed-template:a')).toBe(true);
      expect(second.getByCategory('seedTemplates')).toEqual({ 'seed-template:a': { id: 'a' } });
      expect(second.getKeysByPrefix('seed-template:')).toEqual(['seed-template:a']);
    });

    it('keeps the other window’s save when it writes one of its own', () => {
      const { backend, first, second } = twoWindows();

      first.set('seed-template:a', { id: 'a' }, 'seedTemplates');
      second.set('pipeline:b', { id: 'b' }, 'pipelines');

      // What a window opened afterwards finds.
      expect(new ConfigStore(backend).getAllKeys().sort()).toEqual([
        'pipeline:b',
        'schedule:sync:old',
        'seed-template:a',
      ]);
      expect(first.get('pipeline:b')).toEqual({ id: 'b' });
    });

    it('keeps the other window’s save when it deletes or clears something else', () => {
      const { backend, first, second } = twoWindows();

      first.set('seed-template:a', { id: 'a' }, 'seedTemplates');
      expect(second.delete('schedule:sync:old')).toBe(true);
      second.set('pipeline:b', { id: 'b' }, 'pipelines');
      expect(second.clearCategory('pipelines')).toBe(1);

      const later = new ConfigStore(backend);
      expect(later.getAllKeys()).toEqual(['seed-template:a']);
      expect(later.get('seed-template:a')).toEqual({ id: 'a' });
    });

    it('deletes an entry the other window saved after it opened', () => {
      const { backend, first, second } = twoWindows();

      first.set('seed-template:a', { id: 'a' }, 'seedTemplates');

      expect(second.delete('seed-template:a')).toBe(true);
      expect(backend.getData()['seed-template:a']).toBeUndefined();
    });

    it('keeps both windows’ lines of a list stored under one key', () => {
      const { first, second } = twoWindows();
      const append = (store: ConfigStore, line: string): void => {
        store.set('audit:trail', [...(store.get<string[]>('audit:trail') ?? []), line], 'audit');
      };

      append(first, 'seed run');
      append(second, 'sync run');
      append(first, 'forge run');

      expect(second.get('audit:trail')).toEqual(['seed run', 'sync run', 'forge run']);
    });
  });
});
