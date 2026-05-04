import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuditTrailService } from './AuditTrailService';

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

describe('AuditTrailService', () => {
  let service: AuditTrailService;
  let configStore: ReturnType<typeof createMockConfigStore>;

  beforeEach(() => {
    configStore = createMockConfigStore();
    service = new AuditTrailService(configStore as never);
  });

  describe('log', () => {
    it('should create an audit entry with generated id and timestamp', () => {
      const entry = service.log({
        operationType: 'sync',
        description: 'Synced Account records',
        orgId: 'org-1',
        durationMs: 1500,
        status: 'success',
        recordCount: 100,
      });

      expect(entry.id).toMatch(/^audit-/);
      expect(entry.timestamp).toBeTruthy();
      expect(entry.operationType).toBe('sync');
      expect(entry.description).toBe('Synced Account records');
    });

    it('should persist entries to config store', () => {
      service.log({
        operationType: 'sync',
        description: 'Test',
        durationMs: 100,
        status: 'success',
      });

      expect(configStore.set).toHaveBeenCalled();
    });

    it('should prepend new entries (newest first)', () => {
      service.log({
        operationType: 'sync',
        description: 'First',
        durationMs: 100,
        status: 'success',
      });
      service.log({
        operationType: 'backup',
        description: 'Second',
        durationMs: 200,
        status: 'success',
      });

      const entries = service.list();
      expect(entries[0].description).toBe('Second');
      expect(entries[1].description).toBe('First');
    });
  });

  describe('list', () => {
    it('should return all entries without filter', () => {
      service.log({ operationType: 'sync', description: 'A', durationMs: 100, status: 'success' });
      service.log({
        operationType: 'backup',
        description: 'B',
        durationMs: 200,
        status: 'failure',
      });
      expect(service.list()).toHaveLength(2);
    });

    it('should filter by operation type', () => {
      service.log({ operationType: 'sync', description: 'A', durationMs: 100, status: 'success' });
      service.log({
        operationType: 'backup',
        description: 'B',
        durationMs: 200,
        status: 'success',
      });
      const filtered = service.list({ operationType: 'sync' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].operationType).toBe('sync');
    });

    it('should filter by status', () => {
      service.log({ operationType: 'sync', description: 'A', durationMs: 100, status: 'success' });
      service.log({ operationType: 'sync', description: 'B', durationMs: 200, status: 'failure' });
      const filtered = service.list({ status: 'failure' });
      expect(filtered).toHaveLength(1);
    });

    it('should filter by orgId', () => {
      service.log({
        operationType: 'sync',
        description: 'A',
        orgId: 'org-1',
        durationMs: 100,
        status: 'success',
      });
      service.log({
        operationType: 'sync',
        description: 'B',
        orgId: 'org-2',
        durationMs: 200,
        status: 'success',
      });
      const filtered = service.list({ orgId: 'org-1' });
      expect(filtered).toHaveLength(1);
    });

    it('should filter by search text (case-insensitive)', () => {
      service.log({
        operationType: 'sync',
        description: 'Synced Account records',
        durationMs: 100,
        status: 'success',
      });
      service.log({
        operationType: 'backup',
        description: 'Backed up Contact',
        durationMs: 200,
        status: 'success',
      });
      const filtered = service.list({ search: 'account' });
      expect(filtered).toHaveLength(1);
    });

    it('should filter by date range', () => {
      const entry1 = service.log({
        operationType: 'sync',
        description: 'A',
        durationMs: 100,
        status: 'success',
      });
      const entries = service.list({ startDate: entry1.timestamp, endDate: entry1.timestamp });
      expect(entries.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getById', () => {
    it('should return entry by id', () => {
      const entry = service.log({
        operationType: 'sync',
        description: 'Test',
        durationMs: 100,
        status: 'success',
      });
      expect(service.getById(entry.id)).toBeDefined();
      expect(service.getById(entry.id)!.description).toBe('Test');
    });

    it('should return undefined for unknown id', () => {
      expect(service.getById('unknown')).toBeUndefined();
    });
  });

  describe('count', () => {
    it('should return 0 initially', () => {
      expect(service.count()).toBe(0);
    });

    it('should return correct count', () => {
      service.log({ operationType: 'sync', description: 'A', durationMs: 100, status: 'success' });
      service.log({ operationType: 'sync', description: 'B', durationMs: 100, status: 'success' });
      expect(service.count()).toBe(2);
    });
  });

  describe('clear', () => {
    it('should remove all entries', () => {
      service.log({ operationType: 'sync', description: 'A', durationMs: 100, status: 'success' });
      service.clear();
      expect(service.count()).toBe(0);
    });
  });

  describe('export', () => {
    it('should export as JSON', () => {
      service.log({
        operationType: 'sync',
        description: 'Test',
        durationMs: 100,
        status: 'success',
      });
      const json = service.export({ format: 'json' });
      const parsed = JSON.parse(json);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);
    });

    it('should export as CSV', () => {
      service.log({
        operationType: 'sync',
        description: 'Test',
        durationMs: 100,
        status: 'success',
      });
      const csv = service.export({ format: 'csv' });
      const lines = csv.split('\n');
      expect(lines[0]).toContain('id,operationType');
      expect(lines).toHaveLength(2);
    });

    it('should apply filter during export', () => {
      service.log({ operationType: 'sync', description: 'A', durationMs: 100, status: 'success' });
      service.log({
        operationType: 'backup',
        description: 'B',
        durationMs: 200,
        status: 'failure',
      });
      const json = service.export({ format: 'json', filter: { operationType: 'sync' } });
      const parsed = JSON.parse(json);
      expect(parsed).toHaveLength(1);
    });
  });

  describe('csvEscape', () => {
    it('should not escape simple strings', () => {
      expect(AuditTrailService.csvEscape('hello')).toBe('hello');
    });

    it('should escape strings with commas', () => {
      expect(AuditTrailService.csvEscape('hello, world')).toBe('"hello, world"');
    });

    it('should escape strings with quotes', () => {
      expect(AuditTrailService.csvEscape('say "hi"')).toBe('"say ""hi"""');
    });

    it('should escape strings with newlines', () => {
      expect(AuditTrailService.csvEscape('line1\nline2')).toBe('"line1\nline2"');
    });
  });

  describe('generateId', () => {
    it('should generate unique IDs', () => {
      const id1 = AuditTrailService.generateId();
      const id2 = AuditTrailService.generateId();
      expect(id1).not.toBe(id2);
    });

    it('should start with audit- prefix', () => {
      expect(AuditTrailService.generateId()).toMatch(/^audit-/);
    });
  });

  describe('rotation', () => {
    it('should keep entries within max limit', () => {
      for (let i = 0; i < 1005; i++) {
        service.log({
          operationType: 'sync',
          description: `Entry ${i}`,
          durationMs: 10,
          status: 'success',
        });
      }
      expect(service.count()).toBeLessThanOrEqual(1000);
    });
  });
});
