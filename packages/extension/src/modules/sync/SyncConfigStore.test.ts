import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SyncConfigStore } from './SyncConfigStore';
import type { SyncConfig } from '@sandforge/shared';
import type { SyncWatermark } from './SyncDelta';
import type { SyncCopiedFile } from './SyncFiles';

/** Minimal in-memory ConfigStore mock. */
function createMockConfigStore() {
  const data: Record<string, { value: string; category: string }> = {};

  return {
    get: vi.fn(<T>(key: string): T | undefined => {
      const entry = data[key];
      if (!entry) return undefined;
      return JSON.parse(entry.value) as T;
    }),
    set: vi.fn(<T>(key: string, value: T, category: string): void => {
      data[key] = { value: JSON.stringify(value), category };
    }),
    delete: vi.fn((key: string): boolean => {
      if (!(key in data)) return false;
      delete data[key];
      return true;
    }),
    has: vi.fn((key: string): boolean => key in data),
    getKeysByPrefix: vi.fn((prefix: string): string[] =>
      Object.keys(data).filter((k) => k.startsWith(prefix)),
    ),
    getByCategory: vi.fn((category: string): Record<string, unknown> => {
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(data)) {
        if (entry.category === category) {
          result[key] = JSON.parse(entry.value);
        }
      }
      return result;
    }),
    getAllKeys: vi.fn((): string[] => Object.keys(data)),
    clearCategory: vi.fn(),
    clearAll: vi.fn(),
    initialize: vi.fn(),
  };
}

function createSyncConfig(overrides?: Partial<SyncConfig>): SyncConfig {
  return {
    id: 'cfg-1',
    name: 'Test Config',
    description: 'A test sync config',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    direction: 'source_to_target',
    mode: 'full',
    objects: [],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
    ...overrides,
  };
}

describe('SyncConfigStore', () => {
  let store: SyncConfigStore;
  let configStore: ReturnType<typeof createMockConfigStore>;

  beforeEach(() => {
    configStore = createMockConfigStore();
    store = new SyncConfigStore(configStore as never);
  });

  describe('save / load', () => {
    it('should round-trip save and load a config', () => {
      const config = createSyncConfig();
      store.save(config);
      const loaded = store.load('cfg-1');
      expect(loaded).toBeDefined();
      expect(loaded?.id).toBe('cfg-1');
      expect(loaded?.name).toBe('Test Config');
    });

    it('should store with the correct key prefix and category', () => {
      const config = createSyncConfig();
      store.save(config);
      expect(configStore.set).toHaveBeenCalledWith('sync:config:cfg-1', config, 'syncConfigs');
    });

    it('should return undefined for non-existent config', () => {
      expect(store.load('non-existent')).toBeUndefined();
    });

    it('should overwrite an existing config on save', () => {
      store.save(createSyncConfig());
      store.save(createSyncConfig({ name: 'Updated Config' }));
      const loaded = store.load('cfg-1');
      expect(loaded?.name).toBe('Updated Config');
    });
  });

  describe('list', () => {
    it('should return empty array when no configs exist', () => {
      expect(store.list()).toEqual([]);
    });

    it('should return all configs sorted by updatedAt descending', () => {
      store.save(createSyncConfig({ id: 'old', updatedAt: '2026-01-01T00:00:00Z' }));
      store.save(createSyncConfig({ id: 'new', updatedAt: '2026-03-01T00:00:00Z' }));
      store.save(createSyncConfig({ id: 'mid', updatedAt: '2026-02-01T00:00:00Z' }));

      const list = store.list();
      expect(list).toHaveLength(3);
      expect(list[0].id).toBe('new');
      expect(list[1].id).toBe('mid');
      expect(list[2].id).toBe('old');
    });
  });

  describe('delete', () => {
    it('should delete an existing config and return true', () => {
      store.save(createSyncConfig());
      expect(store.delete('cfg-1')).toBe(true);
      expect(store.load('cfg-1')).toBeUndefined();
    });

    it('should return false when deleting a non-existent config', () => {
      expect(store.delete('non-existent')).toBe(false);
    });

    it('deletes the watermarks of the configuration with it', () => {
      store.save(createSyncConfig());
      store.recordWatermark('cfg-1', watermark());
      store.delete('cfg-1');
      expect(store.loadDelta('cfg-1')).toEqual({ kind: 'none' });
    });
  });

  describe('watermarks', () => {
    it('keeps them beside the configuration, never listed as one', () => {
      store.save(createSyncConfig());
      store.recordWatermark('cfg-1', watermark());
      expect(store.list().map((c) => c.id)).toEqual(['cfg-1']);
      expect(configStore.set).toHaveBeenLastCalledWith(
        'sync:delta:cfg-1',
        expect.anything(),
        'syncDelta',
      );
    });

    it("replaces an object's watermark for the same pair of orgs and keeps the others", () => {
      store.recordWatermark('cfg-1', watermark());
      store.recordWatermark('cfg-1', watermark({ objectApiName: 'Contact' }));
      store.recordWatermark('cfg-1', watermark({ targetOrgId: 'other-org' }));
      store.recordWatermark('cfg-1', watermark({ watermark: '2026-10-13T10:00:00.000Z' }));

      const load = store.loadDelta('cfg-1');
      expect(load.kind).toBe('stored');
      const entries = load.kind === 'stored' ? load.state.entries : [];
      expect(entries.map((e) => [e.objectApiName, e.targetOrgId, e.watermark])).toEqual([
        ['Contact', 'tgt-org', '2026-10-13T09:00:00.000Z'],
        ['Account', 'other-org', '2026-10-13T09:00:00.000Z'],
        ['Account', 'tgt-org', '2026-10-13T10:00:00.000Z'],
      ]);
    });

    it('reads stored data that is not watermarks as unreadable, and records over it', () => {
      configStore.set(
        'sync:delta:cfg-1',
        { version: 1, entries: [{ watermark: 42 }] },
        'syncDelta',
      );
      expect(store.loadDelta('cfg-1')).toMatchObject({ kind: 'unreadable' });

      store.recordWatermark('cfg-1', watermark());
      expect(store.loadDelta('cfg-1')).toMatchObject({
        kind: 'stored',
        state: { entries: [expect.objectContaining({ objectApiName: 'Account' })] },
      });
    });

    it('clears them for "Run full next time", says how many, and remembers it was asked', () => {
      store.recordWatermark('cfg-1', watermark());
      store.recordWatermark('cfg-1', watermark({ objectApiName: 'Contact' }));

      expect(store.clearDelta('cfg-1')).toBe(2);
      expect(store.loadDelta('cfg-1')).toMatchObject({
        kind: 'stored',
        state: { entries: [], resetAt: expect.any(String) },
      });
      expect(store.clearDelta('cfg-1')).toBe(0);
    });
  });

  describe('the files a configuration copied', () => {
    it('keeps each file once per source file and pair of orgs, the last copy winning', () => {
      store.recordFile('cfg-1', copiedFile());
      store.recordFile('cfg-1', copiedFile({ sourceVersionId: fakeId('068', 2) }));
      store.recordFile('cfg-1', copiedFile({ targetOrgId: 'other-org' }));

      const kept = store.loadFiles('cfg-1');
      expect(kept.kind === 'stored' ? kept.map.entries : []).toEqual([
        copiedFile({ sourceVersionId: fakeId('068', 2) }),
        copiedFile({ targetOrgId: 'other-org' }),
      ]);
    });

    it('keeps them through "Run full next time": a full read copies none of them twice', () => {
      store.recordFile('cfg-1', copiedFile());

      store.clearDelta('cfg-1');

      expect(store.loadFiles('cfg-1').kind).toBe('stored');
    });

    it('deletes them with the configuration', () => {
      store.save(createSyncConfig());
      store.recordFile('cfg-1', copiedFile());

      store.delete('cfg-1');

      expect(store.loadFiles('cfg-1')).toEqual({ kind: 'none' });
    });

    it('reads a record that is not one as unreadable, and refuses to write over it', () => {
      configStore.set(
        'sync:files:cfg-1',
        { version: 1, entries: [{ sourceId: 'x' }] },
        'syncFiles',
      );

      expect(store.loadFiles('cfg-1')).toMatchObject({ kind: 'unreadable' });
      expect(() => store.recordFile('cfg-1', copiedFile())).toThrow(
        'the record of copied files does not read',
      );
    });
  });
});

/** A fake id: the object's prefix and a counter, the length of a real one. */
function fakeId(prefix: string, n: number): string {
  return `${prefix}${String(n).padStart(12, '0')}AAA`;
}

/** One file a run copied, as it is recorded. */
function copiedFile(overrides: Partial<SyncCopiedFile> = {}): SyncCopiedFile {
  return {
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    objectApiName: 'Account',
    kind: 'document',
    sourceId: fakeId('069', 1),
    targetId: fakeId('069', 9),
    sourceVersionId: fakeId('068', 1),
    linked: [fakeId('001', 9)],
    copiedAt: '2026-10-13T09:01:00.000Z',
    ...overrides,
  };
}

/** One object's watermark as a run records it. */
function watermark(overrides: Partial<SyncWatermark> = {}): SyncWatermark {
  return {
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    objectApiName: 'Account',
    watermark: '2026-10-13T09:00:00.000Z',
    fingerprint: 'a'.repeat(64),
    recordedAt: '2026-10-13T09:01:00.000Z',
    ...overrides,
  };
}
