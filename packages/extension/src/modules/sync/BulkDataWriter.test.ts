import type { Connection } from 'jsforce';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BulkDataWriter } from './BulkDataWriter.js';
import type { BulkDataWriterDeps } from './BulkDataWriter.js';
import type { BulkApiExecutor } from '../../core/engine/BulkApiExecutor.js';
import type { BulkApiManager } from '../../core/engine/BulkApiManager.js';

/**
 * The streaming path builds its own `ChunkedBulkExecutor`, so the only way to
 * reach it from a unit test is to replace the module. `vi.hoisted` keeps the
 * spies reachable from the hoisted factory.
 */
const streaming = vi.hoisted(() => ({
  executeChunked: vi.fn(),
  createChunkGenerator: vi.fn(),
}));

vi.mock('../../core/engine/ChunkedBulkExecutor.js', () => ({
  ChunkedBulkExecutor: vi.fn().mockImplementation((config: unknown) => ({
    config,
    executeChunked: streaming.executeChunked,
    createChunkGenerator: streaming.createChunkGenerator,
  })),
}));

import { ChunkedBulkExecutor } from '../../core/engine/ChunkedBulkExecutor.js';

/** Records above this count take the streaming path (STREAMING_THRESHOLD). */
const STREAMING_THRESHOLD = 10_000;

/** Minimal jsforce per-record DML result, as the SObject methods return it. */
type JsforceResult = { success: boolean; id?: string; errors?: Array<{ message: string }> };

/** Spies standing in for the jsforce `sobject(name)` DML surface. */
interface SObjectSpies {
  create: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

interface Harness {
  writer: BulkDataWriter;
  deps: BulkDataWriterDeps;
  sobject: SObjectSpies;
  sobjectFor: ReturnType<typeof vi.fn>;
  describe: ReturnType<typeof vi.fn>;
  shouldUseBulkApi: ReturnType<typeof vi.fn>;
  executeBulk: ReturnType<typeof vi.fn>;
  abort: AbortController;
}

/**
 * Build a writer whose every collaborator is a spy. Retries are configured to
 * zero so the REST failure path resolves without burning real backoff delays.
 */
function createHarness(overrides?: {
  useBulkApi?: boolean;
  describeFields?: Array<{ name: string; type: string; length: number; createable: boolean }>;
}): Harness {
  const sobject: SObjectSpies = {
    create: vi.fn().mockResolvedValue([]),
    upsert: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue([]),
    destroy: vi.fn().mockResolvedValue([]),
  };
  const sobjectFor = vi.fn().mockReturnValue(sobject);
  const describe = vi.fn().mockResolvedValue({
    fields: overrides?.describeFields ?? [
      { name: 'Name', type: 'string', length: 255, createable: true },
    ],
  });
  const shouldUseBulkApi = vi.fn().mockReturnValue(overrides?.useBulkApi ?? false);
  const executeBulk = vi.fn();
  const abort = new AbortController();

  const deps: BulkDataWriterDeps = {
    connection: { sobject: sobjectFor, describe } as unknown as Connection,
    bulkExecutor: { shouldUseBulkApi, executeBulk } as unknown as BulkApiExecutor,
    bulkManager: {} as unknown as BulkApiManager,
    retryConfig: { maxRetries: 0, initialDelay: 0, jitter: false },
    describeTimeoutMs: 5000,
    signal: abort.signal,
    onProgress: vi.fn(),
    log: vi.fn(),
  };

  return {
    writer: new BulkDataWriter(deps),
    deps,
    sobject,
    sobjectFor,
    describe,
    shouldUseBulkApi,
    executeBulk,
    abort,
  };
}

/** N distinct records, so batch slicing is observable in the spy calls. */
function makeRecords(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({ Name: `Acme ${i}` }));
}

/** N successful jsforce results with predictable IDs. */
function okResults(count: number, offset = 0): JsforceResult[] {
  return Array.from({ length: count }, (_, i) => ({
    success: true,
    id: `001${String(offset + i).padStart(3, '0')}`,
  }));
}

describe('BulkDataWriter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('REST batch path', () => {
    it('slices records into batches of batchSize and flattens results in input order', async () => {
      const h = createHarness();
      h.sobject.create
        .mockResolvedValueOnce(okResults(2, 0))
        .mockResolvedValueOnce(okResults(2, 2))
        .mockResolvedValueOnce(okResults(1, 4));

      const outcomes = await h.writer.insert('Account', makeRecords(5), 2);

      expect(h.sobject.create).toHaveBeenCalledTimes(3);
      expect(h.sobject.create.mock.calls[0][0]).toHaveLength(2);
      expect(h.sobject.create.mock.calls[2][0]).toEqual([{ Name: 'Acme 4' }]);
      expect(outcomes).toHaveLength(5);
      expect(outcomes.map((o) => o.id)).toEqual(['001000', '001001', '001002', '001003', '001004']);
      expect(outcomes.every((o) => o.success)).toBe(true);
    });

    it('carries the first Salesforce error onto the matching outcome', async () => {
      const h = createHarness();
      h.sobject.create.mockResolvedValue([
        { success: true, id: '001000' },
        {
          success: false,
          errors: [{ message: 'REQUIRED_FIELD_MISSING: Name' }, { message: 'second' }],
        },
      ]);

      const outcomes = await h.writer.insert('Account', makeRecords(2), 200);

      expect(outcomes[0]).toEqual({ id: '001000', success: true, errors: [] });
      expect(outcomes[1]).toEqual({
        id: undefined,
        success: false,
        errors: ['REQUIRED_FIELD_MISSING: Name'],
      });
    });

    it('falls back to "Unknown error" when a failed result carries no error array', async () => {
      const h = createHarness();
      h.sobject.create.mockResolvedValue([{ success: false }]);

      const outcomes = await h.writer.insert('Account', makeRecords(1), 200);

      expect(outcomes[0].errors).toEqual(['Unknown error']);
    });

    it('accepts the single-object result jsforce returns for a one-record batch', async () => {
      const h = createHarness();
      h.sobject.create.mockResolvedValue({ success: true, id: '001SINGLE' });

      const outcomes = await h.writer.insert('Account', makeRecords(1), 200);

      expect(outcomes).toEqual([{ id: '001SINGLE', success: true, errors: [] }]);
    });

    it('marks every record of an exhausted batch as failed with the last error', async () => {
      const h = createHarness();
      h.sobject.create.mockRejectedValue(new Error('UNABLE_TO_LOCK_ROW'));

      const outcomes = await h.writer.insert('Account', makeRecords(3), 3);

      expect(outcomes).toHaveLength(3);
      expect(outcomes.every((o) => !o.success)).toBe(true);
      expect(outcomes.every((o) => o.errors[0] === 'UNABLE_TO_LOCK_ROW')).toBe(true);
    });

    it('routes update through sobject.update and delete through sobject.destroy', async () => {
      const h = createHarness();
      h.sobject.update.mockResolvedValue(okResults(1));
      h.sobject.destroy.mockResolvedValue(okResults(1));

      await h.writer.update('Account', [{ Id: '001000', Name: 'Renamed' }], 200);
      await h.writer.delete('Account', ['001000'], 200);

      expect(h.sobject.update).toHaveBeenCalledWith([{ Id: '001000', Name: 'Renamed' }]);
      expect(h.sobject.destroy).toHaveBeenCalledWith(['001000']);
    });
  });

  describe('upsert field-type validation', () => {
    it('logs a warning but still upserts when a source field is incompatible', async () => {
      const h = createHarness({
        describeFields: [{ name: 'Name', type: 'date', length: 0, createable: true }],
      });
      h.sobject.upsert.mockResolvedValue(okResults(1));

      const outcomes = await h.writer.upsert('Account', 'External_Id__c', makeRecords(1), 200);

      expect(h.describe).toHaveBeenCalledWith('Account');
      expect(h.deps.log).toHaveBeenCalledWith(
        expect.stringContaining('Field type validation failed for upsert on Account'),
      );
      expect(h.sobject.upsert).toHaveBeenCalledWith([{ Name: 'Acme 0' }], 'External_Id__c');
      expect(outcomes[0].success).toBe(true);
    });

    it('stays silent when every mapped field is compatible', async () => {
      const h = createHarness();
      h.sobject.upsert.mockResolvedValue(okResults(1));

      await h.writer.upsert('Account', 'External_Id__c', makeRecords(1), 200);

      expect(h.deps.log).not.toHaveBeenCalledWith(
        expect.stringContaining('Field type validation failed'),
      );
    });

    it('ignores non-createable target fields when building the mapping', async () => {
      const h = createHarness({
        describeFields: [{ name: 'Name', type: 'date', length: 0, createable: false }],
      });
      h.sobject.upsert.mockResolvedValue(okResults(1));

      await h.writer.upsert('Account', 'External_Id__c', makeRecords(1), 200);

      // The only incompatible field is filtered out, so nothing is validated.
      expect(h.deps.log).not.toHaveBeenCalledWith(
        expect.stringContaining('Field type validation failed'),
      );
    });
  });

  describe('Bulk API path', () => {
    it('uses executeBulk and skips REST entirely above the bulk threshold', async () => {
      const h = createHarness({ useBulkApi: true });
      h.executeBulk.mockResolvedValue({
        outcomes: [
          { recordIndex: 0, id: '001BULK', success: true },
          { recordIndex: 1, success: false, error: 'STORAGE_LIMIT_EXCEEDED' },
        ],
      });

      const outcomes = await h.writer.insert('Account', makeRecords(2), 200);

      expect(h.executeBulk).toHaveBeenCalledTimes(1);
      expect(h.sobject.create).not.toHaveBeenCalled();
      expect(outcomes).toEqual([
        { id: '001BULK', success: true, errors: [] },
        { id: undefined, success: false, errors: ['STORAGE_LIMIT_EXCEEDED'] },
      ]);
    });

    it('forwards the external ID field and labels bulk progress with the operation', async () => {
      const h = createHarness({ useBulkApi: true });
      h.executeBulk.mockImplementation(
        async (
          bulkDeps: { onProgress: (processed: number, total: number) => void },
          ..._rest: unknown[]
        ) => {
          bulkDeps.onProgress(1, 2);
          return { outcomes: [] };
        },
      );

      await h.writer.upsert('Account', 'External_Id__c', makeRecords(2), 200);

      expect(h.executeBulk.mock.calls[0][4]).toBe('External_Id__c');
      expect(h.deps.onProgress).toHaveBeenCalledWith(1, 2, 'Bulk upsert Account');
    });

    it('substitutes a generic message when a bulk failure carries no error text', async () => {
      const h = createHarness({ useBulkApi: true });
      h.executeBulk.mockResolvedValue({
        outcomes: [{ recordIndex: 0, success: false }],
      });

      const outcomes = await h.writer.insert('Account', makeRecords(1), 200);

      expect(outcomes[0].errors).toEqual(['Bulk error']);
    });
  });

  describe('streaming path', () => {
    it('streams above the threshold, hands over the abort signal and the full input array', async () => {
      const h = createHarness({ useBulkApi: true });
      const records = makeRecords(STREAMING_THRESHOLD + 1);
      const generator = Symbol('chunks');
      streaming.createChunkGenerator.mockReturnValue(generator);
      streaming.executeChunked.mockResolvedValue({
        outcomes: [{ recordIndex: 0, id: '001STREAM', success: true }],
      });

      const outcomes = await h.writer.insert('Account', records, 200);

      expect(vi.mocked(ChunkedBulkExecutor).mock.calls[0][0]).toEqual({ signal: h.abort.signal });
      const call = streaming.executeChunked.mock.calls[0];
      expect(call[1]).toBe('Account');
      expect(call[2]).toBe('insert');
      expect(call[3]).toBe(generator);
      expect(call[4]).toBe(records.length);
      // The full array is passed so results are attributed per input record.
      expect(call[6]).toBe(records);
      // Streaming wins: the bulk executor is never consulted.
      expect(h.executeBulk).not.toHaveBeenCalled();
      expect(outcomes).toEqual([{ id: '001STREAM', success: true, errors: [] }]);
    });

    it('labels streaming progress with the operation and object', async () => {
      const h = createHarness();
      streaming.executeChunked.mockImplementation(
        async (
          bulkDeps: { onProgress: (processed: number, total: number) => void },
          ..._rest: unknown[]
        ) => {
          bulkDeps.onProgress(2000, 10_001);
          return { outcomes: [] };
        },
      );

      await h.writer.upsert('Contact', 'External_Id__c', makeRecords(STREAMING_THRESHOLD + 1), 200);

      expect(h.deps.onProgress).toHaveBeenCalledWith(2000, 10_001, 'Streaming upsert Contact');
      expect(streaming.executeChunked.mock.calls[0][5]).toBe('External_Id__c');
    });

    it('returns an empty outcome list when the chunked run reports none', async () => {
      const h = createHarness();
      streaming.executeChunked.mockResolvedValue({ totalRecords: 0, successCount: 0 });

      const outcomes = await h.writer.insert('Account', makeRecords(STREAMING_THRESHOLD + 1), 200);

      expect(streaming.executeChunked).toHaveBeenCalledTimes(1);
      expect(h.sobject.create).not.toHaveBeenCalled();
      expect(outcomes).toEqual([]);
    });

    it('maps a streaming failure without a message to "Streaming error"', async () => {
      const h = createHarness();
      streaming.executeChunked.mockResolvedValue({
        outcomes: [{ recordIndex: 0, success: false }],
      });

      const outcomes = await h.writer.insert('Account', makeRecords(STREAMING_THRESHOLD + 1), 200);

      expect(outcomes[0]).toEqual({ id: undefined, success: false, errors: ['Streaming error'] });
    });

    it('does not stream deletes: IDs are cheap to hold, so the threshold does not apply', async () => {
      const h = createHarness();
      h.sobject.destroy.mockImplementation(async (batch: string[]) =>
        batch.map((id) => ({ success: true, id })),
      );
      const ids = Array.from({ length: STREAMING_THRESHOLD + 1 }, (_, i) => `001${i}`);

      const outcomes = await h.writer.delete('Account', ids, 5000);

      expect(streaming.executeChunked).not.toHaveBeenCalled();
      expect(h.sobject.destroy).toHaveBeenCalledTimes(3);
      expect(outcomes).toHaveLength(ids.length);
    });
  });
});
