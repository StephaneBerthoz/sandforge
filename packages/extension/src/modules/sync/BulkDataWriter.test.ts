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
  ChunkedBulkExecutor: vi.fn().mockImplementation(function (config: unknown) {
    return {
      config,
      executeChunked: streaming.executeChunked,
      createChunkGenerator: streaming.createChunkGenerator,
    };
  }),
}));

import { ChunkedBulkExecutor } from '../../core/engine/ChunkedBulkExecutor.js';
import { PauseGate } from './PauseGate.js';
import { WriteCancelledError } from './WriteCancelledError.js';

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

    it('reports a REST refusal with its status code and the record the target already holds', async () => {
      const h = createHarness();
      h.deps.keyPrefixOf = () => '001';
      h.sobject.create.mockResolvedValue([
        {
          success: false,
          errors: [
            {
              statusCode: 'DUPLICATE_VALUE',
              message:
                'duplicate value found: Code__c duplicates value on record with id: 001Fk00000AbCdE',
              fields: [],
            },
          ],
        },
      ]);

      const outcomes = await h.writer.insert('Account', makeRecords(1), 200);

      expect(outcomes[0]).toEqual({
        id: undefined,
        success: false,
        errors: [
          'DUPLICATE_VALUE: duplicate value found: Code__c duplicates value on record with id: 001Fk00000AbCdE',
        ],
        existingId: '001Fk00000AbCdEIAV',
      });
    });

    it('carries every error of a refusal with the fields it named, when one named a field', async () => {
      // Kept as the first error's text alone, a refusal said where it was
      // refused only in words: no writer could send the record again without
      // the field a restricted picklist had refused the value of.
      const h = createHarness();
      h.sobject.create.mockResolvedValue([
        {
          success: false,
          errors: [
            {
              statusCode: 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST',
              message: 'Tier: bad value for restricted picklist field: Gold',
              fields: ['Tier__c'],
            },
            {
              statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
              message: 'Phone must be written +33…',
              fields: ['Phone'],
            },
          ],
        },
      ]);

      const [outcome] = await h.writer.insert('Account', makeRecords(1), 200);

      expect(outcome).toEqual({
        id: undefined,
        success: false,
        errors: [
          'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: Tier: bad value for restricted picklist field: Gold [Tier__c]',
        ],
        errorDetails: [
          {
            statusCode: 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST',
            message: 'Tier: bad value for restricted picklist field: Gold',
            fields: ['Tier__c'],
          },
          {
            statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
            message: 'Phone must be written +33…',
            fields: ['Phone'],
          },
        ],
      });
    });

    it('names the single record a blocking duplicate rule matched', async () => {
      const h = createHarness();
      h.sobject.create.mockResolvedValue([
        {
          success: false,
          errors: [
            {
              statusCode: 'DUPLICATES_DETECTED',
              message: 'Use one of these records?',
              fields: [],
              duplicateResult: {
                allowSave: false,
                matchResults: [
                  {
                    entityType: 'Account',
                    matchRecords: [
                      {
                        matchConfidence: 100,
                        record: { attributes: { type: 'Account' }, Id: '001Fk00000AbCdEIAV' },
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ]);

      const outcomes = await h.writer.insert('Account', makeRecords(1), 200);

      expect(outcomes[0].existingId).toBe('001Fk00000AbCdEIAV');
    });

    it('names no record whose id belongs to another object', async () => {
      const h = createHarness();
      h.deps.keyPrefixOf = () => '001';
      h.sobject.create.mockResolvedValue([
        {
          success: false,
          errors: [
            {
              statusCode: 'DUPLICATE_VALUE',
              message:
                'duplicate value found: Code__c duplicates value on record with id: 003Fk00000MnOpQ',
            },
          ],
        },
      ]);

      const outcomes = await h.writer.insert('Account', makeRecords(1), 200);

      expect(outcomes[0].existingId).toBeUndefined();
    });

    it('keeps the status code of a refusal ahead of its message', async () => {
      // The code reads the same in every org; the message is in the org's
      // language. Kept to the message, a French org's duplicate never
      // matched `DUPLICATE_VALUE`.
      const h = createHarness();
      h.sobject.create.mockResolvedValue([
        {
          success: false,
          errors: [{ statusCode: 'DUPLICATE_VALUE', message: 'valeur en double trouvée' }],
        },
      ]);

      const outcomes = await h.writer.insert('Account', makeRecords(1), 200);

      expect(outcomes[0].errors).toEqual(['DUPLICATE_VALUE: valeur en double trouvée']);
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

    it('stops between two batches on a cancel, and says what the batches before it wrote', async () => {
      // A large object used to be written to its last batch after the run
      // was cancelled.
      const h = createHarness();
      h.sobject.create.mockImplementation(async (batch: unknown[]) => {
        h.abort.abort();
        return okResults(batch.length);
      });

      const writing = h.writer.insert('Account', makeRecords(5), 2);

      await expect(writing).rejects.toBeInstanceOf(WriteCancelledError);
      const stopped = (await writing.catch((err: unknown) => err)) as WriteCancelledError;
      expect(h.sobject.create).toHaveBeenCalledTimes(1);
      expect(stopped.objectApiName).toBe('Account');
      expect(stopped.written.map((o) => o.id)).toEqual(['001000', '001001']);
    });

    it('does not send again a batch the target failed on once the run is cancelled', async () => {
      // The batch went out once more after its backoff, the cancel come
      // during the wait: a write after the run had been stopped.
      const h = createHarness();
      const writer = new BulkDataWriter({
        ...h.deps,
        retryConfig: { maxRetries: 2, initialDelay: 20, jitter: false },
      });
      h.sobject.create.mockImplementation(async () => {
        setTimeout(() => h.abort.abort(), 5);
        throw Object.assign(new Error('UNABLE_TO_LOCK_ROW'), { errorCode: 'UNABLE_TO_LOCK_ROW' });
      });

      const writing = writer.insert('Account', makeRecords(3), 3);

      await expect(writing).rejects.toBeInstanceOf(WriteCancelledError);
      await expect(writing).rejects.toMatchObject({ objectApiName: 'Account', written: [] });
      expect(h.sobject.create).toHaveBeenCalledTimes(1);
    });

    it('sends no batch of a write the cancel came before, and says it wrote nothing', async () => {
      // A caller looks at the cancel before it writes, then waits on the
      // target; a cancel that came meanwhile still sent the first batch.
      const h = createHarness();
      h.abort.abort();
      h.sobject.create.mockResolvedValue(okResults(1));

      const writing = h.writer.insert('Account', makeRecords(1), 200);

      await expect(writing).rejects.toBeInstanceOf(WriteCancelledError);
      await expect(writing).rejects.toMatchObject({ objectApiName: 'Account', written: [] });
      expect(h.sobject.create).not.toHaveBeenCalled();
    });

    it('sends no update, upsert or delete the cancel came before either', async () => {
      const h = createHarness();
      h.abort.abort();

      const stopped = await Promise.all([
        h.writer.update('Account', [{ Id: '001000', Name: 'Renamed' }], 200).catch((e) => e),
        h.writer.upsert('Account', 'External_Id__c', makeRecords(2), 200).catch((e) => e),
        h.writer.delete('Account', ['001000'], 200).catch((e) => e),
      ]);

      expect(stopped.every((err) => err instanceof WriteCancelledError)).toBe(true);
      expect(h.sobject.update).not.toHaveBeenCalled();
      expect(h.sobject.upsert).not.toHaveBeenCalled();
      expect(h.sobject.destroy).not.toHaveBeenCalled();
    });

    it('writes every batch of a write given no cancel, as a real-time batch has to be', async () => {
      const h = createHarness();
      const writer = new BulkDataWriter({ ...h.deps, signal: undefined });
      h.sobject.create.mockImplementation(async (batch: unknown[]) => okResults(batch.length));

      const outcomes = await writer.insert('Account', makeRecords(5), 2);

      expect(h.sobject.create).toHaveBeenCalledTimes(3);
      expect(outcomes).toHaveLength(5);
    });

    it('stops a delete between two batches as well', async () => {
      const h = createHarness();
      h.sobject.destroy.mockImplementation(async (ids: string[]) => {
        h.abort.abort();
        return ids.map((id) => ({ success: true, id }));
      });

      const deleting = h.writer.delete('Account', ['001A', '001B', '001C'], 2);

      const stopped = (await deleting.catch((err: unknown) => err)) as WriteCancelledError;
      expect(stopped).toBeInstanceOf(WriteCancelledError);
      expect(stopped.written.map((o) => o.id)).toEqual(['001A', '001B']);
      expect(h.sobject.destroy).toHaveBeenCalledTimes(1);
    });

    it('holds the write between two batches while the run is paused, and goes on when resumed', async () => {
      const h = createHarness();
      const gate = new PauseGate();
      const writer = new BulkDataWriter({ ...h.deps, pauseGate: gate });
      h.sobject.create.mockImplementation(async (batch: unknown[]) => {
        // The pause comes while the first batch is on its way.
        gate.pause();
        return okResults(batch.length);
      });

      const writing = writer.insert('Account', makeRecords(4), 2);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(h.sobject.create).toHaveBeenCalledTimes(1);

      gate.resume();
      const outcomes = await writing;
      expect(h.sobject.create).toHaveBeenCalledTimes(2);
      expect(outcomes).toHaveLength(4);
    });

    it('stops a paused write when the run is cancelled, with what it wrote before the pause', async () => {
      const h = createHarness();
      const gate = new PauseGate();
      const writer = new BulkDataWriter({ ...h.deps, pauseGate: gate });
      h.sobject.create.mockImplementation(async (batch: unknown[]) => {
        gate.pause();
        return okResults(batch.length);
      });

      const writing = writer.insert('Account', makeRecords(4), 2);
      await new Promise((resolve) => setTimeout(resolve, 10));
      h.abort.abort();

      const stopped = (await writing.catch((err: unknown) => err)) as WriteCancelledError;
      expect(stopped).toBeInstanceOf(WriteCancelledError);
      expect(stopped.written).toHaveLength(2);
      expect(h.sobject.create).toHaveBeenCalledTimes(1);
    });

    it('routes update through sobject.update and delete through sobject.destroy', async () => {
      const h = createHarness();
      h.sobject.update.mockResolvedValue(okResults(1));
      h.sobject.destroy.mockResolvedValue(okResults(1));

      await h.writer.update('Account', [{ Id: '001000', Name: 'Renamed' }], 200);
      await h.writer.delete('Account', ['001000'], 200);

      expect(h.sobject.update).toHaveBeenCalledWith(
        [{ Id: '001000', Name: 'Renamed' }],
        expect.anything(),
      );
      expect(h.sobject.destroy).toHaveBeenCalledWith(['001000']);
    });

    it('tells Salesforce an updated row is meant to look like the ones already there', async () => {
      // A duplicate rule can block an edit as it blocks a create, and an
      // update carries the rows the source holds into an org that holds their
      // likes. Inserts and upserts said so; an update went without the header
      // and the rule refused the row.
      const h = createHarness();
      h.sobject.update.mockResolvedValue(okResults(1));

      await h.writer.update('Account', [{ Id: '001000', Name: 'Renamed' }], 200);

      const updateOptions = h.sobject.update.mock.calls[0][1] as
        { headers?: Record<string, string> } | undefined;
      expect(updateOptions?.headers?.['Sforce-Duplicate-Rule-Header']).toBe('allowSave=true');
    });
  });

  describe('upsert', () => {
    it('writes without describing the target: field types are checked before the run starts', async () => {
      // The check that lived here typed every source field as 'string' and only
      // logged, so it could neither see a real mismatch nor stop one. The sync
      // handler now compares both orgs' describes before anything is written.
      const h = createHarness();
      h.sobject.upsert.mockResolvedValue(okResults(1));

      const outcomes = await h.writer.upsert('Account', 'External_Id__c', makeRecords(1), 200);

      expect(h.describe).not.toHaveBeenCalled();
      expect(h.sobject.upsert).toHaveBeenCalledWith(
        [{ Name: 'Acme 0' }],
        'External_Id__c',
        expect.anything(),
      );
      expect(outcomes[0].success).toBe(true);
    });

    it('tells Salesforce the rows are meant to look like the ones already there', async () => {
      // A sync copies rows from an org into one that resembles it, which is
      // what a duplicate rule exists to stop. Forge learnt this on a live pair
      // of sandboxes; without it fourteen of sixteen accounts were refused on
      // the first real run of Sync.
      const h = createHarness();
      h.sobject.upsert.mockResolvedValue(okResults(1));
      h.sobject.create.mockResolvedValue(okResults(1));

      await h.writer.upsert('Account', 'External_Id__c', makeRecords(1), 200);
      await h.writer.insert('Account', makeRecords(1), 200);

      const upsertOptions = h.sobject.upsert.mock.calls[0][2] as {
        headers: Record<string, string>;
      };
      const insertOptions = h.sobject.create.mock.calls[0][1] as {
        headers: Record<string, string>;
      };
      expect(upsertOptions.headers['Sforce-Duplicate-Rule-Header']).toBe('allowSave=true');
      expect(insertOptions.headers['Sforce-Duplicate-Rule-Header']).toBe('allowSave=true');
    });

    it('keeps what the org did with each record, created or updated', async () => {
      // The answer says it for every record, and was dropped: the audit trail
      // could only count the records of an upsert as "upserted".
      const h = createHarness();
      h.sobject.upsert.mockResolvedValue([
        { success: true, id: '001000000000001', created: true },
        { success: true, id: '001000000000002', created: false },
      ]);

      const outcomes = await h.writer.upsert('Account', 'External_Id__c', makeRecords(2), 200);

      expect(outcomes.map((o) => o.created)).toEqual([true, false]);
    });

    it('keeps it from the Bulk API answer too', async () => {
      const h = createHarness({ useBulkApi: true });
      h.executeBulk.mockResolvedValue({
        successCount: 2,
        failureCount: 0,
        successIds: ['001000000000001', '001000000000002'],
        failures: [],
        outcomes: [
          { recordIndex: 0, id: '001000000000001', success: true, created: false },
          { recordIndex: 1, id: '001000000000002', success: true, created: true },
        ],
      });

      const outcomes = await h.writer.upsert('Account', 'External_Id__c', makeRecords(2), 200);

      expect(outcomes.map((o) => o.created)).toEqual([false, true]);
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

    it('opens no Bulk API job while the run is paused, and opens it once resumed', async () => {
      const h = createHarness({ useBulkApi: true });
      const gate = new PauseGate();
      gate.pause();
      const writer = new BulkDataWriter({ ...h.deps, pauseGate: gate });
      h.executeBulk.mockResolvedValue({
        outcomes: [{ recordIndex: 0, id: '001B', success: true }],
      });

      const writing = writer.insert('Account', makeRecords(1), 200);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(h.executeBulk).not.toHaveBeenCalled();

      gate.resume();
      await writing;
      expect(h.executeBulk).toHaveBeenCalledTimes(1);
    });

    it('names the record the target already holds from the sf__Error of a bulk refusal', async () => {
      const h = createHarness({ useBulkApi: true });
      h.deps.keyPrefixOf = () => '001';
      h.executeBulk.mockResolvedValue({
        outcomes: [
          {
            recordIndex: 0,
            success: false,
            error:
              'DUPLICATE_VALUE:duplicate value found: Code__c duplicates value on record with id: 001Fk00000AbCdE:--',
          },
          {
            recordIndex: 1,
            success: false,
            error:
              'DUPLICATE_VALUE:duplicate value found: <unknown> duplicates value on record with id: <unknown>:--',
          },
        ],
      });

      const outcomes = await h.writer.insert('Account', makeRecords(2), 200);

      expect(outcomes[0].existingId).toBe('001Fk00000AbCdEIAV');
      expect(outcomes[1].existingId).toBeUndefined();
    });

    it('reads the fields a bulk refusal named out of its sf__Error', async () => {
      // As a real target wrote it: the fields after the message's last colon,
      // separated by spaces, before the closing dashes.
      const h = createHarness({ useBulkApi: true });
      h.executeBulk.mockResolvedValue({
        outcomes: [
          {
            recordIndex: 0,
            success: false,
            error:
              'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST:Tier: bad value for restricted picklist field: Gold:Tier__c --',
          },
          {
            recordIndex: 1,
            success: false,
            error:
              'DUPLICATE_VALUE:duplicate value found: Code__c duplicates value on record with id: <unknown>:--',
          },
        ],
      });

      const outcomes = await h.writer.insert('Account', makeRecords(2), 200);

      expect(outcomes[0].errorDetails).toEqual([
        {
          statusCode: 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST',
          message: 'Tier: bad value for restricted picklist field: Gold',
          fields: ['Tier__c'],
        },
      ]);
      // One that names no field leaves the outcome as it was.
      expect(outcomes[1]).not.toHaveProperty('errorDetails');
    });

    it('substitutes a generic message when a bulk failure carries no error text', async () => {
      const h = createHarness({ useBulkApi: true });
      h.executeBulk.mockResolvedValue({
        outcomes: [{ recordIndex: 0, success: false }],
      });

      const outcomes = await h.writer.insert('Account', makeRecords(1), 200);

      expect(outcomes[0].errors).toEqual(['Bulk error']);
    });

    it("hands the job the run's cancel", async () => {
      const h = createHarness({ useBulkApi: true });
      h.executeBulk.mockResolvedValue({ outcomes: [] });

      await h.writer.update('Account', makeRecords(2), 200);

      expect(h.executeBulk.mock.calls[0][0]).toMatchObject({ signal: h.abort.signal });
    });

    it('throws, rather than answering nothing, when the cancel aborted the job before it was closed', async () => {
      // An empty answer read as an object that had nothing to write: a run
      // cancelled on its last object ended as a success.
      const h = createHarness({ useBulkApi: true });
      h.executeBulk.mockResolvedValue({
        totalRecords: 2,
        successCount: 0,
        failureCount: 0,
        failures: [],
        successIds: [],
        outcomes: [],
        aborted: true,
      });

      const writing = h.writer.upsert('Contact', 'External_Id__c', makeRecords(2), 200);

      await expect(writing).rejects.toBeInstanceOf(WriteCancelledError);
      await expect(writing).rejects.toMatchObject({ objectApiName: 'Contact', written: [] });
    });

    it('logs every id of a record the job wrote that no row could be matched to', async () => {
      // The rows left without a result name ten of them; the log is where the
      // rest of them can be read, as no row maps them.
      const h = createHarness({ useBulkApi: true });
      const unmatchedIds = Array.from(
        { length: 12 },
        (_, i) => `001${String(i).padStart(15, '0')}`,
      );
      h.executeBulk.mockResolvedValue({
        outcomes: [{ recordIndex: 0, success: false, error: 'No result returned by Bulk API job' }],
        unmatchedIds,
      });

      await h.writer.insert('Account', makeRecords(1), 200);

      expect(h.deps.log).toHaveBeenCalledWith(
        `[WARN] Bulk insert Account: the job wrote 12 record(s) no row was matched to: ${unmatchedIds.join(', ')}`,
      );
    });

    it('opens no job for a write the cancel came before', async () => {
      // The job was opened, then aborted before its upload: nothing written,
      // and a job created and aborted in the target for a write that never
      // started.
      const h = createHarness({ useBulkApi: true });
      h.abort.abort();

      const writing = h.writer.insert('Account', makeRecords(2), 200);

      await expect(writing).rejects.toBeInstanceOf(WriteCancelledError);
      await expect(writing).rejects.toMatchObject({ objectApiName: 'Account', written: [] });
      expect(h.executeBulk).not.toHaveBeenCalled();
      expect(h.sobject.create).not.toHaveBeenCalled();
    });
  });

  describe('streaming path', () => {
    it('streams above the threshold and hands over the abort signal', async () => {
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

    it('throws, rather than answering nothing, when the cancel aborted the upload', async () => {
      // An empty answer read as an object that had nothing to write: a run
      // cancelled on its last object ended as a success.
      const h = createHarness();
      streaming.executeChunked.mockResolvedValue({
        totalRecords: 2000,
        successCount: 0,
        failureCount: 0,
        successIds: [],
        errors: [],
        aborted: true,
      });

      const writing = h.writer.insert('Contact', makeRecords(STREAMING_THRESHOLD + 1), 200);

      await expect(writing).rejects.toBeInstanceOf(WriteCancelledError);
      await expect(writing).rejects.toMatchObject({ objectApiName: 'Contact' });
    });

    it('opens no job to stream a write the cancel came before', async () => {
      const h = createHarness();
      h.abort.abort();

      const writing = h.writer.upsert(
        'Contact',
        'External_Id__c',
        makeRecords(STREAMING_THRESHOLD + 1),
        200,
      );

      await expect(writing).rejects.toMatchObject({ objectApiName: 'Contact', written: [] });
      expect(streaming.executeChunked).not.toHaveBeenCalled();
    });

    it('logs every id of a record the streamed job wrote that no row could be matched to', async () => {
      const h = createHarness();
      streaming.executeChunked.mockResolvedValue({
        outcomes: [{ recordIndex: 0, success: false, error: 'No result returned by Bulk API job' }],
        unmatchedIds: ['001000000000000009'],
      });

      await h.writer.update('Contact', makeRecords(STREAMING_THRESHOLD + 1), 200);

      expect(h.deps.log).toHaveBeenCalledWith(
        '[WARN] Streaming update Contact: the job wrote 1 record(s) no row was matched to: 001000000000000009',
      );
    });

    it('maps a streaming failure without a message to "Streaming error"', async () => {
      const h = createHarness();
      streaming.executeChunked.mockResolvedValue({
        outcomes: [{ recordIndex: 0, success: false }],
      });

      const outcomes = await h.writer.insert('Account', makeRecords(STREAMING_THRESHOLD + 1), 200);

      expect(outcomes[0]).toEqual({ id: undefined, success: false, errors: ['Streaming error'] });
    });

    it('names the record the target already holds from a streamed refusal', async () => {
      const h = createHarness();
      streaming.executeChunked.mockResolvedValue({
        outcomes: [
          {
            recordIndex: 0,
            success: false,
            error:
              'DUPLICATE_VALUE:duplicate value found: Code__c duplicates value on record with id: 001Fk00000AbCdE:--',
          },
        ],
      });

      const outcomes = await h.writer.insert('Account', makeRecords(STREAMING_THRESHOLD + 1), 200);

      expect(outcomes[0].existingId).toBe('001Fk00000AbCdEIAV');
    });

    it('reads the fields a streamed refusal named out of its sf__Error', async () => {
      const h = createHarness();
      streaming.executeChunked.mockResolvedValue({
        outcomes: [
          {
            recordIndex: 0,
            success: false,
            error:
              'REQUIRED_FIELD_MISSING:Required fields are missing: [Name, StageName]:Name StageName --',
          },
        ],
      });

      const outcomes = await h.writer.insert('Account', makeRecords(STREAMING_THRESHOLD + 1), 200);

      expect(outcomes[0].errorDetails).toEqual([
        {
          statusCode: 'REQUIRED_FIELD_MISSING',
          message: 'Required fields are missing: [Name, StageName]',
          fields: ['Name', 'StageName'],
        },
      ]);
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
