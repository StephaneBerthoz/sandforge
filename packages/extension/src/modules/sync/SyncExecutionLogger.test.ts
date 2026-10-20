import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  MAX_HISTORY_REFUSALS_PER_OBJECT,
  SyncExecutionLogger,
  objectResultForHistory,
} from './SyncExecutionLogger';
import type { SyncHistoryStore } from './SyncHistoryStore';
import type {
  SyncConfig,
  SyncExecutionResult,
  SyncHistoryEntry,
  SyncObjectResult,
} from '@sandforge/shared';

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

describe('objectResultForHistory', () => {
  /** An object's result whose errors are the lines given. */
  const objectResult = (errors: string[], refusalsDropped?: number): SyncObjectResult => ({
    objectApiName: 'Contact',
    operation: 'insert',
    processed: errors.length,
    success: 0,
    failed: errors.length,
    skipped: 0,
    conflictCount: 0,
    errors,
    ...(refusalsDropped === undefined ? {} : { refusalsDropped }),
  });
  const refusal = 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Phone must be written +33. [Phone]';

  it('keeps the first refusals and every note of the run, and counts what it left out', () => {
    const errors = [
      ...Array.from({ length: 800 }, () => refusal),
      'Linked 12 records to the ones the target already holds.',
    ];

    const kept = objectResultForHistory(objectResult(errors, 200));

    expect(kept.errors).toHaveLength(MAX_HISTORY_REFUSALS_PER_OBJECT + 1);
    expect(kept.errors.at(-1)).toBe('Linked 12 records to the ones the target already holds.');
    expect(kept.refusalsDropped).toBe(200 + 800 - MAX_HISTORY_REFUSALS_PER_OBJECT);
  });

  it('keeps a refusal with no code once, past the first ones', () => {
    const errors = Array.from({ length: 120 }, () => 'Insert failed after retries');

    const kept = objectResultForHistory(objectResult(errors));

    expect(kept.errors).toHaveLength(MAX_HISTORY_REFUSALS_PER_OBJECT);
    expect(kept.refusalsDropped).toBe(120 - MAX_HISTORY_REFUSALS_PER_OBJECT);
  });

  it('leaves a result that fits as it is', () => {
    const result = objectResult([refusal, refusal]);
    expect(objectResultForHistory(result)).toBe(result);
  });

  it('is how a run is kept in the history, while the run itself is left whole', () => {
    const store = createMockHistoryStore();
    const run: SyncExecutionResult = {
      ...createResult(),
      objectResults: [objectResult(Array.from({ length: 300 }, () => refusal))],
    };

    const entry = new SyncExecutionLogger(store, () => 'id-1').logExecution(
      createConfig(),
      run,
      'manual',
    );

    expect(entry.result.objectResults[0].errors).toHaveLength(MAX_HISTORY_REFUSALS_PER_OBJECT);
    expect(run.objectResults[0].errors).toHaveLength(300);
  });
});
