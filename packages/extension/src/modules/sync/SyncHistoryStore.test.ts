import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SyncHistoryStore } from './SyncHistoryStore';
import type { SyncHistoryEntry, SyncConfig, SyncExecutionResult } from '@sandforge/shared';

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
    getKeysByPrefix: vi.fn((): string[] => []),
    getByCategory: vi.fn((): Record<string, unknown> => ({})),
    getAllKeys: vi.fn((): string[] => Object.keys(data)),
    clearCategory: vi.fn(),
    clearAll: vi.fn(),
    initialize: vi.fn(),
  };
}

function createConfig(id: string): SyncConfig {
  return {
    id,
    name: `Config ${id}`,
    description: 'Test config',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    direction: 'source_to_target',
    mode: 'full',
    objects: [],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    dryRun: false,
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
  };
}

function createResult(configId: string): SyncExecutionResult {
  return {
    configId,
    operationId: `op-${configId}`,
    status: 'success',
    objectResults: [],
    totalProcessed: 100,
    totalSuccess: 100,
    totalFailed: 0,
    totalSkipped: 0,
    duration: 5000,
    timestamp: '2026-03-15T10:00:05Z',
  };
}

function createHistoryEntry(id: string, startTime: string): SyncHistoryEntry {
  const configId = `cfg-${id}`;
  return {
    id,
    configSnapshot: createConfig(configId),
    result: createResult(configId),
    startTime,
    endTime: '2026-03-15T10:00:05Z',
    triggeredBy: 'manual',
  };
}

describe('SyncHistoryStore', () => {
  let store: SyncHistoryStore;
  let configStore: ReturnType<typeof createMockConfigStore>;

  beforeEach(() => {
    configStore = createMockConfigStore();
    store = new SyncHistoryStore(configStore as never);
  });

  describe('save + list', () => {
    it('should save and list entries sorted by startTime descending', () => {
      store.save(createHistoryEntry('e1', '2026-03-01T00:00:00Z'));
      store.save(createHistoryEntry('e3', '2026-03-03T00:00:00Z'));
      store.save(createHistoryEntry('e2', '2026-03-02T00:00:00Z'));

      const list = store.list();
      expect(list).toHaveLength(3);
      expect(list[0].id).toBe('e3');
      expect(list[1].id).toBe('e2');
      expect(list[2].id).toBe('e1');
    });
  });

  describe('deduplication', () => {
    it('should not create duplicate when saving same id twice', () => {
      const entry = createHistoryEntry('dup-1', '2026-03-01T00:00:00Z');
      store.save(entry);
      store.save({ ...entry, triggeredBy: 'rerun' });

      const list = store.list();
      expect(list).toHaveLength(1);
      expect(list[0].triggeredBy).toBe('rerun');
    });
  });

  describe('FIFO eviction', () => {
    it('should cap at 500 entries and evict the oldest', () => {
      for (let i = 0; i < 501; i++) {
        const padded = String(i).padStart(4, '0');
        store.save(
          createHistoryEntry(
            `e-${padded}`,
            `2026-01-01T${padded.slice(0, 2)}:${padded.slice(2)}:00Z`,
          ),
        );
      }

      const list = store.list();
      expect(list).toHaveLength(500);
      // The very first entry (e-0000 with earliest startTime) should be evicted
      expect(list.find((e) => e.id === 'e-0000')).toBeUndefined();
      // The last entry should still be present
      expect(list.find((e) => e.id === 'e-0500')).toBeDefined();
    });
  });

  describe('load', () => {
    it('should return correct entry by id', () => {
      store.save(createHistoryEntry('target', '2026-03-01T00:00:00Z'));
      store.save(createHistoryEntry('other', '2026-03-02T00:00:00Z'));

      const entry = store.load('target');
      expect(entry).toBeDefined();
      expect(entry?.id).toBe('target');
    });

    it('should return undefined for non-existent id', () => {
      expect(store.load('ghost')).toBeUndefined();
    });
  });

  describe('delete', () => {
    it('should remove entry and persist', () => {
      store.save(createHistoryEntry('del-1', '2026-03-01T00:00:00Z'));
      store.save(createHistoryEntry('del-2', '2026-03-02T00:00:00Z'));

      const result = store.delete('del-1');
      expect(result).toBe(true);
      expect(store.list()).toHaveLength(1);
      expect(store.load('del-1')).toBeUndefined();
    });

    it('should return false for non-existent entry', () => {
      expect(store.delete('ghost')).toBe(false);
    });
  });

  describe('exportAsCsv', () => {
    it('should produce correct header and row count', () => {
      store.save(createHistoryEntry('csv-1', '2026-03-01T00:00:00Z'));
      store.save(createHistoryEntry('csv-2', '2026-03-02T00:00:00Z'));

      const csv = store.exportAsCsv();
      const lines = csv.split('\n');

      expect(lines[0]).toBe(
        'id,configName,status,totalProcessed,totalSuccess,totalFailed,totalSkipped,startTime,endTime,duration,triggeredBy',
      );
      expect(lines).toHaveLength(3); // header + 2 data rows
    });

    it('should wrap config names containing commas in double quotes', () => {
      const entry = createHistoryEntry('csv-comma', '2026-03-01T00:00:00Z');
      entry.configSnapshot.name = 'Sync, Full';
      store.save(entry);

      const csv = store.exportAsCsv();
      expect(csv).toContain('"Sync, Full"');
    });
  });

  describe('exportAsJson', () => {
    it('should produce valid JSON with correct entry count', () => {
      store.save(createHistoryEntry('json-1', '2026-03-01T00:00:00Z'));
      store.save(createHistoryEntry('json-2', '2026-03-02T00:00:00Z'));

      const json = store.exportAsJson();
      const parsed = JSON.parse(json) as SyncHistoryEntry[];

      expect(parsed).toHaveLength(2);
      expect(parsed[0].id).toBe('json-2'); // sorted newest first
    });

    it('should filter by entryIds when provided', () => {
      store.save(createHistoryEntry('json-a', '2026-03-01T00:00:00Z'));
      store.save(createHistoryEntry('json-b', '2026-03-02T00:00:00Z'));
      store.save(createHistoryEntry('json-c', '2026-03-03T00:00:00Z'));

      const json = store.exportAsJson(['json-a', 'json-c']);
      const parsed = JSON.parse(json) as SyncHistoryEntry[];

      expect(parsed).toHaveLength(2);
      expect(parsed.map((e) => e.id)).toContain('json-a');
      expect(parsed.map((e) => e.id)).toContain('json-c');
    });
  });

  describe('clear', () => {
    it('should remove all entries', () => {
      store.save(createHistoryEntry('clr-1', '2026-03-01T00:00:00Z'));
      store.clear();

      expect(store.list()).toHaveLength(0);
    });
  });
});
