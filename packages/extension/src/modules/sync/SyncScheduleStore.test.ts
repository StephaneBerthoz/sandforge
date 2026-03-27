import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SyncScheduleStore } from './SyncScheduleStore';
import type { SyncScheduleEntry } from '@sandforge/shared';

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

function createScheduleEntry(overrides?: Partial<SyncScheduleEntry>): SyncScheduleEntry {
  return {
    id: 'sched-1',
    name: 'Daily Account Sync',
    configId: 'cfg-1',
    cron: '0 6 * * *',
    timezone: 'UTC',
    enabled: true,
    maxRetries: 3,
    notifyOnComplete: true,
    notifyOnFailure: true,
    nextRunAt: '2026-03-28T06:00:00.000Z',
    createdAt: '2026-03-27T10:00:00.000Z',
    updatedAt: '2026-03-27T10:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

describe('SyncScheduleStore', () => {
  let store: SyncScheduleStore;
  let configStore: ReturnType<typeof createMockConfigStore>;

  beforeEach(() => {
    configStore = createMockConfigStore();
    store = new SyncScheduleStore(configStore as never);
  });

  describe('save / load', () => {
    it('should round-trip save and load a schedule', () => {
      const entry = createScheduleEntry();
      store.save(entry);
      const loaded = store.load('sched-1');
      expect(loaded).toBeDefined();
      expect(loaded?.id).toBe('sched-1');
      expect(loaded?.name).toBe('Daily Account Sync');
      expect(loaded?.cron).toBe('0 6 * * *');
    });

    it('should store with the correct key prefix and category', () => {
      const entry = createScheduleEntry();
      store.save(entry);
      expect(configStore.set).toHaveBeenCalledWith(
        'schedule:sync:sched-1',
        entry,
        'syncSchedules',
      );
    });

    it('should return undefined for non-existent schedule', () => {
      expect(store.load('non-existent')).toBeUndefined();
    });

    it('should overwrite an existing schedule on save (upsert behavior)', () => {
      store.save(createScheduleEntry());
      store.save(createScheduleEntry({ name: 'Updated Schedule' }));
      const loaded = store.load('sched-1');
      expect(loaded?.name).toBe('Updated Schedule');
    });
  });

  describe('list', () => {
    it('should return empty array when no schedules exist', () => {
      expect(store.list()).toEqual([]);
    });

    it('should return all schedules sorted by createdAt descending', () => {
      store.save(createScheduleEntry({ id: 'old', createdAt: '2026-01-01T00:00:00Z' }));
      store.save(createScheduleEntry({ id: 'new', createdAt: '2026-03-01T00:00:00Z' }));
      store.save(createScheduleEntry({ id: 'mid', createdAt: '2026-02-01T00:00:00Z' }));

      const list = store.list();
      expect(list).toHaveLength(3);
      expect(list[0].id).toBe('new');
      expect(list[1].id).toBe('mid');
      expect(list[2].id).toBe('old');
    });
  });

  describe('delete', () => {
    it('should delete an existing schedule and return true', () => {
      store.save(createScheduleEntry());
      expect(store.delete('sched-1')).toBe(true);
      expect(store.load('sched-1')).toBeUndefined();
    });

    it('should return false when deleting a non-existent schedule', () => {
      expect(store.delete('non-existent')).toBe(false);
    });
  });

  describe('loadAll', () => {
    it('should return the same result as list', () => {
      store.save(createScheduleEntry({ id: 'a', createdAt: '2026-01-01T00:00:00Z' }));
      store.save(createScheduleEntry({ id: 'b', createdAt: '2026-02-01T00:00:00Z' }));

      const listResult = store.list();
      const loadAllResult = store.loadAll();
      expect(loadAllResult).toEqual(listResult);
    });
  });
});
