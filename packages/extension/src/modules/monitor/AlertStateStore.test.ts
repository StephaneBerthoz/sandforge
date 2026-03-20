import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AlertStateStore } from './AlertStateStore';
import type { AlertDefinition, AlertInstance } from '@sandforge/shared';

/** Minimal in-memory ConfigStore mock matching the GovernancePolicyStore pattern. */
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
    getByCategory: vi.fn(),
    getAllKeys: vi.fn((): string[] => Object.keys(data)),
    clearCategory: vi.fn(),
    clearAll: vi.fn(),
    initialize: vi.fn(),
  };
}

function createAlert(overrides?: Partial<AlertInstance>): AlertInstance {
  return {
    id: 'alert-1',
    definitionId: 'def-1',
    severity: 'critical',
    status: 'active',
    message: 'Test alert',
    currentValue: 92,
    threshold: 90,
    orgId: 'org-1',
    triggeredAt: '2026-03-20T10:00:00.000Z',
    ...overrides,
  };
}

function createDefinition(overrides?: Partial<AlertDefinition>): AlertDefinition {
  return {
    id: 'def-1',
    name: 'API Alert',
    description: 'Test definition',
    enabled: true,
    metric: 'DailyApiRequests',
    condition: { operator: 'gte', threshold: 90 },
    severity: 'critical',
    cooldownMinutes: 15,
    notificationChannels: ['vscode_notification'],
    ...overrides,
  };
}

describe('AlertStateStore', () => {
  let store: AlertStateStore;
  let configStore: ReturnType<typeof createMockConfigStore>;

  beforeEach(() => {
    configStore = createMockConfigStore();
    store = new AlertStateStore(configStore as never);
  });

  describe('saveAlerts / loadAlerts', () => {
    it('should round-trip save and load active alerts', () => {
      const alerts = [createAlert(), createAlert({ id: 'alert-2' })];
      store.saveAlerts(alerts);
      const loaded = store.loadAlerts();
      expect(loaded).toHaveLength(2);
      expect(loaded[0].id).toBe('alert-1');
      expect(loaded[1].id).toBe('alert-2');
    });

    it('should return empty array when nothing is stored', () => {
      expect(store.loadAlerts()).toEqual([]);
    });

    it('should overwrite previous alerts on save', () => {
      store.saveAlerts([createAlert()]);
      store.saveAlerts([createAlert({ id: 'alert-new' })]);
      const loaded = store.loadAlerts();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe('alert-new');
    });
  });

  describe('saveDefinitions / loadDefinitions', () => {
    it('should round-trip save and load definitions', () => {
      const defs = [createDefinition(), createDefinition({ id: 'def-2', metric: 'DataStorageMB' })];
      store.saveDefinitions(defs);
      const loaded = store.loadDefinitions();
      expect(loaded).toHaveLength(2);
      expect(loaded[0].id).toBe('def-1');
      expect(loaded[1].metric).toBe('DataStorageMB');
    });

    it('should return empty array when nothing is stored', () => {
      expect(store.loadDefinitions()).toEqual([]);
    });
  });

  describe('saveHistory / loadHistory', () => {
    it('should append new alerts to history without duplicates', () => {
      const alert1 = createAlert({ id: 'hist-1' });
      const alert2 = createAlert({ id: 'hist-2' });
      const alert3 = createAlert({ id: 'hist-3' });

      store.saveHistory([alert1, alert2]);
      store.saveHistory([alert2, alert3]);

      const history = store.loadHistory();
      expect(history).toHaveLength(3);
      const ids = history.map((a) => a.id);
      expect(ids).toEqual(['hist-1', 'hist-2', 'hist-3']);
    });

    it('should cap history at 500 entries (FIFO)', () => {
      const batch1: AlertInstance[] = [];
      for (let i = 0; i < 498; i++) {
        batch1.push(createAlert({ id: `old-${i}` }));
      }
      store.saveHistory(batch1);

      const batch2: AlertInstance[] = [];
      for (let i = 0; i < 10; i++) {
        batch2.push(createAlert({ id: `new-${i}` }));
      }
      store.saveHistory(batch2);

      const history = store.loadHistory();
      expect(history).toHaveLength(500);
      expect(history[0].id).toBe('old-8');
      expect(history[history.length - 1].id).toBe('new-9');
    });

    it('should return empty array when no history exists', () => {
      expect(store.loadHistory()).toEqual([]);
    });

    it('should not write to configStore when all alerts already exist in history', () => {
      const alert = createAlert({ id: 'dup-1' });
      store.saveHistory([alert]);
      configStore.set.mockClear();

      store.saveHistory([alert]);
      expect(configStore.set).not.toHaveBeenCalled();
    });

    it('should preserve ordering: oldest first, newest last', () => {
      store.saveHistory([createAlert({ id: 'first' })]);
      store.saveHistory([createAlert({ id: 'second' })]);
      store.saveHistory([createAlert({ id: 'third' })]);

      const history = store.loadHistory();
      expect(history.map((a) => a.id)).toEqual(['first', 'second', 'third']);
    });
  });
});
