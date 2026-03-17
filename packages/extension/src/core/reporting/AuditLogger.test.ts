import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { AuditLogger } from './AuditLogger';

describe('AuditLogger', () => {
  let logger: AuditLogger;
  let emitter: EventEmitter;

  beforeEach(() => {
    emitter = new EventEmitter();
    logger = new AuditLogger(emitter);
  });

  describe('log', () => {
    it('should create an audit log entry with correct fields', () => {
      const entry = logger.log('seed_execute', 'seed', { records: 100 });

      expect(entry.id).toBeDefined();
      expect(entry.action).toBe('seed_execute');
      expect(entry.module).toBe('seed');
      expect(entry.details).toEqual({ records: 100 });
      expect(entry.timestamp).toBeDefined();
    });

    it('should include orgId when provided', () => {
      const entry = logger.log(
        'org_connect',
        'connection',
        { method: 'oauth' },
        'org-abc'
      );

      expect(entry.orgId).toBe('org-abc');
    });

    it('should leave orgId undefined when not provided', () => {
      const entry = logger.log('settings_change', 'settings', {});

      expect(entry.orgId).toBeUndefined();
    });

    it('should generate unique IDs for each entry', () => {
      const entry1 = logger.log('seed_execute', 'seed', {});
      const entry2 = logger.log('seed_execute', 'seed', {});

      expect(entry1.id).not.toBe(entry2.id);
    });

    it('should emit auditLogged event', () => {
      const listener = vi.fn();
      emitter.on('auditLogged', listener);

      const entry = logger.log('sync_execute', 'sync', { count: 50 });

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(entry);
    });

    it('should store the entry for later retrieval', () => {
      const entry = logger.log('backup_create', 'dataops', {});

      const found = logger.getEntry(entry.id);
      expect(found).toEqual(entry);
    });
  });

  describe('getEntries', () => {
    it('should return all entries when no filter is provided', () => {
      logger.log('seed_execute', 'seed', {});
      logger.log('sync_execute', 'sync', {});
      logger.log('backup_create', 'dataops', {});

      const entries = logger.getEntries();
      expect(entries).toHaveLength(3);
    });

    it('should filter by action', () => {
      logger.log('seed_execute', 'seed', {});
      logger.log('sync_execute', 'sync', {});
      logger.log('seed_execute', 'seed', {});

      const entries = logger.getEntries({ action: 'seed_execute' });
      expect(entries).toHaveLength(2);
      expect(entries.every((e) => e.action === 'seed_execute')).toBe(true);
    });

    it('should filter by module', () => {
      logger.log('seed_execute', 'seed', {});
      logger.log('sync_execute', 'sync', {});

      const entries = logger.getEntries({ module: 'sync' });
      expect(entries).toHaveLength(1);
      expect(entries[0].module).toBe('sync');
    });

    it('should filter by orgId', () => {
      logger.log('seed_execute', 'seed', {}, 'org-1');
      logger.log('sync_execute', 'sync', {}, 'org-2');
      logger.log('backup_create', 'dataops', {}, 'org-1');

      const entries = logger.getEntries({ orgId: 'org-1' });
      expect(entries).toHaveLength(2);
      expect(entries.every((e) => e.orgId === 'org-1')).toBe(true);
    });

    it('should filter by date range', () => {
      vi.useFakeTimers();

      vi.setSystemTime(new Date('2026-01-10T00:00:00.000Z'));
      logger.log('seed_execute', 'seed', {});

      vi.setSystemTime(new Date('2026-01-15T00:00:00.000Z'));
      logger.log('sync_execute', 'sync', {});

      vi.setSystemTime(new Date('2026-01-20T00:00:00.000Z'));
      logger.log('backup_create', 'dataops', {});

      vi.useRealTimers();

      const entries = logger.getEntries({
        fromDate: '2026-01-12T00:00:00.000Z',
        toDate: '2026-01-18T00:00:00.000Z',
      });
      expect(entries).toHaveLength(1);
      expect(entries[0].action).toBe('sync_execute');
    });

    it('should combine multiple filters', () => {
      logger.log('seed_execute', 'seed', {}, 'org-1');
      logger.log('seed_execute', 'seed', {}, 'org-2');
      logger.log('sync_execute', 'sync', {}, 'org-1');

      const entries = logger.getEntries({
        action: 'seed_execute',
        orgId: 'org-1',
      });
      expect(entries).toHaveLength(1);
    });

    it('should return empty array when no entries match', () => {
      logger.log('seed_execute', 'seed', {});

      const entries = logger.getEntries({ action: 'org_connect' });
      expect(entries).toHaveLength(0);
    });
  });

  describe('getEntry', () => {
    it('should return the entry by id', () => {
      const entry = logger.log('seed_execute', 'seed', { key: 'value' });

      const found = logger.getEntry(entry.id);
      expect(found).toEqual(entry);
    });

    it('should return undefined for a non-existent id', () => {
      expect(logger.getEntry('nonexistent')).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('should remove all entries', () => {
      logger.log('seed_execute', 'seed', {});
      logger.log('sync_execute', 'sync', {});

      logger.clear();

      expect(logger.getEntries()).toHaveLength(0);
    });

    it('should allow logging new entries after clear', () => {
      logger.log('seed_execute', 'seed', {});
      logger.clear();
      logger.log('sync_execute', 'sync', {});

      expect(logger.getEntries()).toHaveLength(1);
      expect(logger.getEntries()[0].action).toBe('sync_execute');
    });
  });

  describe('exportEntries', () => {
    it('should export entries as formatted JSON', () => {
      logger.log('seed_execute', 'seed', { count: 10 });

      const json = logger.exportEntries('json');
      const parsed = JSON.parse(json);

      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].action).toBe('seed_execute');
      expect(parsed[0].details).toEqual({ count: 10 });
    });

    it('should export empty array as JSON when no entries', () => {
      const json = logger.exportEntries('json');
      expect(JSON.parse(json)).toEqual([]);
    });

    it('should export entries as CSV with header row', () => {
      logger.log('seed_execute', 'seed', {});

      const csv = logger.exportEntries('csv');
      const lines = csv.split('\n');

      expect(lines[0]).toBe(
        'id,action,module,orgId,userId,details,timestamp,ipAddress'
      );
      expect(lines).toHaveLength(2);
    });

    it('should properly escape CSV values containing commas', () => {
      logger.log('seed_execute', 'seed', { note: 'a,b,c' });

      const csv = logger.exportEntries('csv');
      const lines = csv.split('\n');
      const dataLine = lines[1];

      expect(dataLine).toContain('"');
    });

    it('should export multiple entries as CSV rows', () => {
      logger.log('seed_execute', 'seed', {});
      logger.log('sync_execute', 'sync', {});
      logger.log('backup_create', 'dataops', {});

      const csv = logger.exportEntries('csv');
      const lines = csv.split('\n');

      expect(lines).toHaveLength(4);
    });
  });

  describe('on / off', () => {
    it('should register and unregister event listeners via on/off', () => {
      const listener = vi.fn();
      logger.on('auditLogged', listener);

      logger.log('seed_execute', 'seed', {});
      expect(listener).toHaveBeenCalledOnce();

      logger.off('auditLogged', listener);

      logger.log('sync_execute', 'sync', {});
      expect(listener).toHaveBeenCalledOnce();
    });
  });

  describe('default EventEmitter', () => {
    it('should create its own EventEmitter when none is provided', () => {
      const standalone = new AuditLogger();
      const entry = standalone.log('seed_execute', 'seed', {});

      expect(entry.id).toBeDefined();
      expect(standalone.getEntry(entry.id)).toBeDefined();
    });
  });
});
