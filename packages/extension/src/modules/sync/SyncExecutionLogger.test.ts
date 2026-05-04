import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SyncExecutionLogger } from './SyncExecutionLogger';
import type { SyncHistoryStore } from './SyncHistoryStore';
import type { SyncConfig, SyncExecutionResult, SyncHistoryEntry } from '@sandforge/shared';

function createConfig(id: string = 'cfg-1'): SyncConfig {
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

function createResult(configId: string = 'cfg-1'): SyncExecutionResult {
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
    timestamp: '2026-03-15T10:00:05.000Z',
  };
}

function createMockHistoryStore() {
  const entries: SyncHistoryEntry[] = [];
  return {
    save: vi.fn((entry: SyncHistoryEntry) => {
      entries.push(entry);
    }),
    load: vi.fn((id: string) => entries.find((e) => e.id === id)),
    list: vi.fn(() => [...entries].sort((a, b) => b.startTime.localeCompare(a.startTime))),
    delete: vi.fn(() => true),
    exportAsJson: vi.fn(() => JSON.stringify(entries, null, 2)),
    exportAsCsv: vi.fn(() => 'id,configName,status\nrow1'),
    clear: vi.fn(),
  } as unknown as SyncHistoryStore & {
    save: ReturnType<typeof vi.fn>;
    load: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    exportAsJson: ReturnType<typeof vi.fn>;
    exportAsCsv: ReturnType<typeof vi.fn>;
  };
}

describe('SyncExecutionLogger', () => {
  let logger: SyncExecutionLogger;
  let mockStore: ReturnType<typeof createMockHistoryStore>;
  let idCounter: number;

  beforeEach(() => {
    mockStore = createMockHistoryStore();
    idCounter = 0;
    logger = new SyncExecutionLogger(mockStore, () => `generated-${++idCounter}`);
  });

  describe('logExecution', () => {
    it('should create entry with correct fields and deep-cloned config', () => {
      const config = createConfig();
      const result = createResult();

      const entry = logger.logExecution(config, result, 'manual');

      expect(entry.id).toBe('generated-1');
      expect(entry.triggeredBy).toBe('manual');
      expect(entry.endTime).toBe('2026-03-15T10:00:05.000Z');
      // startTime = timestamp - duration (5000ms)
      expect(entry.startTime).toBe('2026-03-15T10:00:00.000Z');
      expect(entry.configSnapshot).toEqual(config);
      expect(entry.scheduleId).toBeUndefined();
      expect(mockStore.save).toHaveBeenCalledWith(entry);
    });

    it('should include scheduleId when triggeredBy is schedule', () => {
      const config = createConfig();
      const result = createResult();

      const entry = logger.logExecution(config, result, 'schedule', 'sched-42');

      expect(entry.triggeredBy).toBe('schedule');
      expect(entry.scheduleId).toBe('sched-42');
    });

    it('should deep clone config so mutations do not affect stored entry', () => {
      const config = createConfig();
      const result = createResult();

      const entry = logger.logExecution(config, result, 'manual');

      // Mutate the original config
      config.name = 'MUTATED';
      config.description = 'MUTATED DESC';

      // The stored entry should not be affected
      expect(entry.configSnapshot.name).toBe('Config cfg-1');
      expect(entry.configSnapshot.description).toBe('Test config');
    });
  });

  describe('getHistory', () => {
    it('should delegate to historyStore.list()', () => {
      logger.logExecution(createConfig(), createResult(), 'manual');

      const history = logger.getHistory();
      expect(mockStore.list).toHaveBeenCalled();
      expect(history).toHaveLength(1);
    });
  });

  describe('getEntry', () => {
    it('should delegate to historyStore.load()', () => {
      logger.logExecution(createConfig(), createResult(), 'manual');

      const entry = logger.getEntry('generated-1');
      expect(mockStore.load).toHaveBeenCalledWith('generated-1');
      expect(entry).toBeDefined();
    });
  });

  describe('exportHistory', () => {
    it('should delegate to exportAsCsv for csv format', () => {
      logger.exportHistory('csv');
      expect(mockStore.exportAsCsv).toHaveBeenCalledWith(undefined);
    });

    it('should delegate to exportAsJson for json format', () => {
      logger.exportHistory('json', ['id-1', 'id-2']);
      expect(mockStore.exportAsJson).toHaveBeenCalledWith(['id-1', 'id-2']);
    });
  });
});
