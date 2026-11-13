import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ForgeGraphNode } from '@sandforge/shared';
import {
  BatchWriter,
  emptyBatchWriteResult,
  resolveWriteBatching,
  type BulkTransport,
  type InsertCallJournal,
  type WriteNodeInput,
} from './BatchWriter.js';
import type { CleanedRecord } from './RecordCleaner.js';
import {
  GOVERNOR_LIMIT_KEPT_WHOLE,
  governorLimitNotSplit,
  limitSplitting,
  type CallKey,
} from '../../../core/common/governorLimit.js';
import {
  bulkSaveErrorDetail,
  formatSaveError,
  toSaveOutcome,
} from '../../../core/common/existingRecordMatch.js';
import type {
  BulkApiConnection,
  JsforceIngestJobResults,
} from '../../../core/engine/BulkApiExecutor.js';
import { BulkApiManager } from '../../../core/engine/BulkApiManager.js';
import type { IngestJobResultsReading } from '../../../core/engine/ingestJobRead.js';
import {
  BulkJobLostError,
  forgeBulkWrite,
  type BulkRowState,
  type BulkWriteAnswer,
} from '../forgeBulkWrite.js';
import { IdRemapper } from '../IdRemapper.js';
import { logger } from '../../../logger.js';
import type {
  FieldInfo,
  ForgeExecutorDeps,
  ForgeProgressEvent,
  InsertResult,
} from '../ForgeExecutor.js';

/*
 * Forge's writer sending a node's rows as Bulk API 2.0 jobs, for a run that
 * asks for them (`WriteNodeInput.bulk`): what a job answered counted as a
 * REST answer is, what it could not answer sent by REST, and what its chunks
 * of 200 were refused for a limit of the target's automation sent again
 * smaller, out of the run's allowance.
 */

type InsertImpl = ForgeExecutorDeps['insertRecords'];
type BulkFn = NonNullable<ForgeExecutorDeps['bulkWriteRecords']>;

afterEach(() => {
  vi.restoreAllMocks();
});

function makeNode(objectApiName: string, recordCount: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount,
    fieldCount: 3,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 0,
    estimatedSizeMB: 0,
    estimatedApiCalls: 0,
    // What a node of more than 200 records resolves to: jobs, for a run that sends them.
    batchStrategy: 'auto',
  };
}

const FIELDS: FieldInfo[] = [
  { name: 'Id', queryable: true, createable: false, isReference: false },
  { name: 'Name', queryable: true, createable: true, isReference: false },
  { name: 'OwnerId', queryable: true, createable: true, isReference: true, nillable: false },
];

/** `n` rows of `prefix`, each its own source id and name. */
function rows(n: number, prefix = '001', extra: Record<string, unknown> = {}) {
  return Array.from({ length: n }, (_, i) => ({
    Id: `${prefix}OLD${String(i).padStart(9, '0')}`,
    Name: `R${i}`,
    ...extra,
  }));
}

/** The rows as the cleaning stage hands them on: the source id kept out of the payload. */
function makeInput(
  source: Array<Record<string, unknown>>,
  overrides: Partial<WriteNodeInput> = {},
  objectApiName = 'Account',
): WriteNodeInput {
  const payloadOf = (row: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'Id'));
  const cleaned: CleanedRecord[] = source.map((row) => ({
    source: { ...row },
    cleaned: payloadOf(row),
    nullifiedFks: [],
  }));
  return {
    node: makeNode(objectApiName, source.length),
    records: source.map(payloadOf),
    cleanedRecords: cleaned,
    fieldInfos: FIELDS,
    creatableFields: new Set(['Name', 'OwnerId']),
    upsertMode: 'off',
    targetOrgId: 'tgt',
    remapper: new IdRemapper(),
    bulk: transport(),
    waitIfPaused: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    onProgress: vi.fn<(e: ForgeProgressEvent) => void>(),
    ...overrides,
  };
}

function transport(overrides: Partial<BulkTransport> = {}): BulkTransport {
  return {
    signal: new AbortController().signal,
    restOnly: new Set<string>(),
    bulkUnsupported: new Set<string>(),
    manager: new BulkApiManager(1),
    ...overrides,
  };
}

/** The id the target gives a row it took: its name's, so that each answer is told from the others. */
const idOf = (row: Record<string, unknown>, prefix = '001'): string =>
  `${prefix}NEW${String(row['Name'])}`;

/** The answer of a job that wrote every row it was sent, each with the id its name says. */
function allWritten(sent: readonly Record<string, unknown>[]): BulkWriteAnswer {
  return {
    answers: sent.map((row) => ({ id: idOf(row), success: true, errors: [] })),
    rows: sent.map((): BulkRowState => 'answered'),
    unmatchedIds: [],
    jobId: '750JOB',
    requests: 12,
  };
}

/** A REST writer that takes every row, or answers each as `answer` says. */
function restWriter(
  answer?: (row: Record<string, unknown>, call: number) => InsertResult | undefined,
) {
  return vi
    .fn<InsertImpl>()
    .mockImplementation(async (_org, _object, sent) =>
      sent.map((row) => answer?.(row, sent.length) ?? { id: idOf(row), success: true, errors: [] }),
    );
}

function makeDeps<B extends BulkFn>(bulkWriteRecords: B, insertRecords = restWriter()) {
  return { insertRecords, bulkWriteRecords };
}

/** A wait that returns at once. */
const noWait = () => vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

const LOCK: InsertResult = {
  id: '',
  success: false,
  errors: ['UNABLE_TO_LOCK_ROW: unable to obtain exclusive access to this record'],
  errorDetails: [
    {
      statusCode: 'UNABLE_TO_LOCK_ROW',
      message: 'unable to obtain exclusive access to this record',
      fields: [],
    },
  ],
};

/** The trigger's words for a row of a chunk too large for it, as a trap org wrote them. */
const LIMIT_MESSAGE = 'Ledger_Trigger: System.LimitException: Too many SOQL queries: 101';

/** A row of a chunk the trigger refused, as a job's `sf__Error` reads (`forgeBulkWrite`). */
function limited(): InsertResult {
  return toSaveOutcome(
    {
      success: false,
      errors: [
        { statusCode: 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY', message: LIMIT_MESSAGE, fields: [] },
      ],
    },
    'Ledger__c',
  );
}

describe('resolveWriteBatching for a run that sends jobs', () => {
  it('cuts jobs of 10 000 rows from 2 000 rows of a bulk strategy, and calls of 200 below or unasked', () => {
    const planned = { api: 'bulk' as const, batchSize: 10_000, batchCount: 1 };
    expect(resolveWriteBatching(planned, 2_000, { bulk: true })).toMatchObject({
      api: 'bulk',
      batchSize: 10_000,
      batchCount: 1,
    });
    expect(resolveWriteBatching(planned, 1_999, { bulk: true })).toMatchObject({
      api: 'rest',
      batchSize: 200,
    });
    // Unasked, as the plan counts its calls: by REST.
    expect(resolveWriteBatching(planned, 5_000)).toMatchObject({ api: 'rest', batchSize: 200 });
  });
});

describe('BatchWriter — writes sent as Bulk API jobs', () => {
  it('writes everything by REST, as before, for a run that sends no job', async () => {
    const bulkWriteRecords = vi.fn<BulkFn>().mockImplementation(async (...a) => allWritten(a[3]));
    const deps = makeDeps(bulkWriteRecords);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const result = await new BatchWriter(deps).writeNode(
      makeInput(rows(2_500), { bulk: undefined }),
    );

    expect(bulkWriteRecords).not.toHaveBeenCalled();
    expect(deps.insertRecords).toHaveBeenCalledTimes(13);
    expect(result.successCount).toBe(2_500);
  });

  it('sends jobs of 10 000 rows, and what is left under 2 000 rows by REST in calls of 200', async () => {
    const bulkWriteRecords = vi.fn<BulkFn>().mockImplementation(async (...a) => allWritten(a[3]));
    const deps = makeDeps(bulkWriteRecords);
    const input = makeInput(rows(11_500));

    const result = await new BatchWriter(deps).writeNode(input);

    expect(bulkWriteRecords.mock.calls.map((c) => [c[2], c[3].length])).toEqual([
      ['insert', 10_000],
    ]);
    expect(bulkWriteRecords.mock.calls[0][4]).toMatchObject({
      bulkManager: input.bulk?.manager,
      signal: input.bulk?.signal,
    });
    expect(deps.insertRecords.mock.calls.map((c) => c[2].length)).toEqual([
      200, 200, 200, 200, 200, 200, 200, 100,
    ]);
    expect(result.successCount).toBe(11_500);
    expect(input.remapper.get('001OLD000000000')).toBe('001NEWR0');
  });

  it('writes by REST an object the run writes by REST alone, and one the org said no job writes', async () => {
    const bulkWriteRecords = vi.fn<BulkFn>().mockImplementation(async (...a) => allWritten(a[3]));
    const deps = makeDeps(bulkWriteRecords);

    await new BatchWriter(deps).writeNode(
      makeInput(rows(2_000), { bulk: transport({ restOnly: new Set(['Account']) }) }),
    );
    await new BatchWriter(deps).writeNode(
      makeInput(rows(2_000), { bulk: transport({ bulkUnsupported: new Set(['Account']) }) }),
    );

    expect(bulkWriteRecords).not.toHaveBeenCalled();
    expect(deps.insertRecords).toHaveBeenCalledTimes(20);
  });

  it('sends by REST a job that wrote nothing, and no job of the object again once the org says no job writes it', async () => {
    const bulkWriteRecords = vi.fn<BulkFn>().mockResolvedValue({
      answers: [],
      rows: [],
      unmatchedIds: [],
      untouched: { reason: 'Entity is not supported by the Bulk API', unsupported: true },
      requests: 1,
    });
    const deps = makeDeps(bulkWriteRecords);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const bulk = transport();

    const result = await new BatchWriter(deps).writeNode(makeInput(rows(22_000), { bulk }));

    expect(bulkWriteRecords).toHaveBeenCalledTimes(1);
    expect(bulk.bulkUnsupported.has('Account')).toBe(true);
    expect(result.successCount).toBe(22_000);
    expect(deps.insertRecords).toHaveBeenCalledTimes(110);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not supported by the Bulk API'));
  });

  it('writes again by REST, in the same round, the rows the job could not answer for themselves', async () => {
    const bulkWriteRecords = vi.fn<BulkFn>().mockImplementation(async (...a) => {
      const answer = allWritten(a[3]);
      // A twin, a row left unprocessed, one a duplicate rule refused, one
      // whose error did not read as one, and one refused for good.
      answer.rows[0] = 'twin';
      answer.answers[0] = { id: '', success: false, errors: ['kept out'] };
      answer.rows[1] = 'unprocessed';
      answer.answers[1] = { id: '', success: false, errors: ['not processed'] };
      answer.answers[2] = {
        id: '',
        success: false,
        errors: ['DUPLICATES_DETECTED: dup'],
        errorDetails: [{ statusCode: 'DUPLICATES_DETECTED', message: 'dup', fields: [] }],
      };
      answer.answers[3] = { id: '', success: false, errors: ['two errors; garbled'] };
      answer.answers[4] = {
        id: '',
        success: false,
        errors: ['INVALID_CROSS_REFERENCE_KEY: invalid cross reference id'],
        errorDetails: [
          {
            statusCode: 'INVALID_CROSS_REFERENCE_KEY',
            message: 'invalid cross reference id',
            fields: [],
          },
        ],
      };
      return answer;
    });
    const deps = makeDeps(bulkWriteRecords);

    const result = await new BatchWriter(deps).writeNode(makeInput(rows(2_000)));

    expect(deps.insertRecords.mock.calls.map((c) => c[2].map((r) => r['Name']))).toEqual([
      ['R0', 'R1', 'R2', 'R3'],
    ]);
    expect(result.successCount).toBe(1_999);
    expect(result.failureCount).toBe(1);
  });

  it('sends again by REST, in calls of 200, the rows a job refused for a lock', async () => {
    const bulkWriteRecords = vi.fn<BulkFn>().mockImplementation(async (...a) => {
      const answer = allWritten(a[3]);
      for (let i = 0; i < 300; i++) answer.answers[i] = LOCK;
      return answer;
    });
    const deps = makeDeps(bulkWriteRecords);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const result = await new BatchWriter(deps, undefined, noWait()).writeNode(
      makeInput(rows(2_000)),
    );

    expect(deps.insertRecords.mock.calls.map((c) => c[2].length)).toEqual([200, 100]);
    expect(result.successCount).toBe(2_000);
  });

  it('never sends again a row the job may have written, and keeps what it wrote no row was matched to', async () => {
    const bulkWriteRecords = vi.fn<BulkFn>().mockImplementation(async (...a) => {
      const answer = allWritten(a[3]);
      answer.rows[5] = 'may-have-written';
      answer.answers[5] = { id: '', success: false, errors: ['may have been written'] };
      answer.unmatchedIds = ['001ORPHAN0000001AAA'];
      return answer;
    });
    const deps = makeDeps(bulkWriteRecords);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const unattributed = vi.fn();
    const input = makeInput(rows(2_000), {
      calls: { sending: () => 'call-1', answered: vi.fn(), unattributed },
    });

    const result = await new BatchWriter(deps).writeNode(input);

    expect(deps.insertRecords).not.toHaveBeenCalled();
    expect(result.failureCount).toBe(1);
    expect(result.mayHaveBeenWritten).toEqual(['001OLD000000005']);
    expect(result.errorSamples[0].recordSummary).toContain('1 record may have been written');
    expect(unattributed).toHaveBeenCalledWith('Account', ['001ORPHAN0000001AAA']);
  });

  it('keeps a job before it goes, its id once opened, and closes it once its answers are counted', async () => {
    const told: string[] = [];
    const bulkWriteRecords = vi.fn<BulkFn>().mockImplementation(async (...a) => {
      a[4].onOpened?.('750JOB');
      told.push('job');
      return allWritten(a[3]);
    });
    const deps = makeDeps(bulkWriteRecords);
    const calls: InsertCallJournal = {
      sending: (objectApiName, sent) => {
        told.push(`sending ${objectApiName} ${sent.length}`);
        return 'call-1';
      },
      opened: (callId, jobId) => told.push(`opened ${callId} ${jobId}`),
      answered: (callId) => told.push(`answered ${callId}`),
    };

    await new BatchWriter(deps).writeNode(makeInput(rows(2_000), { calls }));

    expect(told).toEqual([
      'sending Account 2000',
      'opened call-1 750JOB',
      'job',
      'answered call-1',
    ]);
  });

  it('keeps a job as one, for the journal to keep what its results find each row by, and a REST call as none', async () => {
    const bulkWriteRecords = vi.fn<BulkFn>().mockImplementation(async (...a) => allWritten(a[3]));
    const sending = vi.fn<InsertCallJournal['sending']>().mockReturnValue('call-1');

    const writer = new BatchWriter(makeDeps(bulkWriteRecords));
    await writer.writeNode(makeInput(rows(2_000), { calls: { sending, answered: vi.fn() } }));
    await writer.writeNode(makeInput(rows(150), { calls: { sending, answered: vi.fn() } }));

    // A job of 2 000 rows, then a call of 150 by REST.
    expect(sending.mock.calls.map((call) => [call[1].length, call[3]])).toEqual([
      [2_000, true],
      [150, undefined],
    ]);
  });

  it('sends the rows of one parent together, their records kept aligned with them', async () => {
    const fields: FieldInfo[] = [
      ...FIELDS,
      { name: 'Master__c', queryable: true, createable: true, isReference: true, nillable: false },
    ];
    const source = rows(2_000).map((row, i) => ({
      ...row,
      Master__c: `a00PARENT${i % 2 === 0 ? 'B' : 'A'}`,
    }));
    const bulkWriteRecords = vi.fn<BulkFn>().mockImplementation(async (...a) => allWritten(a[3]));
    const deps = makeDeps(bulkWriteRecords);
    const input = makeInput(source, {
      fieldInfos: fields,
      creatableFields: new Set(['Name', 'Master__c']),
    });

    await new BatchWriter(deps).writeNode(input);

    const sent = bulkWriteRecords.mock.calls[0][3];
    expect(sent.slice(0, 1_000).every((row) => row['Master__c'] === 'a00PARENTA')).toBe(true);
    expect(sent[0]['Name']).toBe('R1');
    expect(input.remapper.get('001OLD000000001')).toBe('001NEWR1');
    expect(input.remapper.get('001OLD000000002')).toBe('001NEWR2');
  });

  it('stops the node at a job closed and lost, its rows among what the target may hold', async () => {
    const bulkWriteRecords = vi
      .fn<BulkFn>()
      .mockRejectedValue(new BulkJobLostError('750JOB', 'socket hang up'));
    const deps = makeDeps(bulkWriteRecords);
    const answered = vi.fn();

    const result = await new BatchWriter(deps).writeNode(
      makeInput(rows(12_000), { calls: { sending: () => 'call-1', answered } }),
    );

    expect(bulkWriteRecords).toHaveBeenCalledTimes(1);
    expect(deps.insertRecords).not.toHaveBeenCalled();
    expect(result.failureCount).toBe(12_000);
    expect(result.mayHaveBeenWritten).toHaveLength(10_000);
    // Left open, for a run taken up to read the job back by its id.
    expect(answered).not.toHaveBeenCalled();
  });

  it('counts the twins a lost job kept out of it as not written, and no row the target may hold', async () => {
    const bulkWriteRecords = vi
      .fn<BulkFn>()
      .mockRejectedValue(new BulkJobLostError('750JOB', 'socket hang up', 3, [0, 1]));
    const deps = makeDeps(bulkWriteRecords);

    const result = await new BatchWriter(deps).writeNode(makeInput(rows(2_000)));

    expect(deps.insertRecords).not.toHaveBeenCalled();
    expect(result.failureCount).toBe(2_000);
    expect(result.mayHaveBeenWritten).toHaveLength(1_998);
    expect(result.mayHaveBeenWritten).not.toContain('001OLD000000000');
    expect(result.mayHaveBeenWritten).not.toContain('001OLD000000001');
    expect(result.errorSamples.map((sample) => sample.recordSummary)).toContainEqual(
      expect.stringContaining('2 records not written'),
    );
  });

  /** A REST call the org refused for the day's request limit: the node stops there. */
  const requestLimit = (): Error =>
    Object.assign(new Error('REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.'), {
      errorCode: 'REQUEST_LIMIT_EXCEEDED',
    });

  it('counts as failed the rows a job refused for a lock when a call after it stops the node', async () => {
    const bulkWriteRecords = vi.fn<BulkFn>().mockImplementation(async (...a) => {
      const answer = allWritten(a[3]);
      for (let i = 0; i < 100; i++) answer.answers[i] = LOCK;
      answer.rows[100] = 'twin';
      answer.answers[100] = { id: '', success: false, errors: ['kept out'] };
      return answer;
    });
    const deps = makeDeps(bulkWriteRecords);
    deps.insertRecords.mockRejectedValue(requestLimit());
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const result = await new BatchWriter(deps, undefined, noWait()).writeNode(
      makeInput(rows(2_000)),
    );

    // The twin's REST call threw: the rows refused for a lock are not sent again.
    expect(deps.insertRecords).toHaveBeenCalledTimes(1);
    expect(result.successCount).toBe(1_899);
    expect(result.failureCount).toBe(101);
    expect(
      result.errorSamples.some((sample) =>
        sample.messages.some((m) => m.startsWith('Not sent again: ')),
      ),
    ).toBe(true);
  });

  it('counts as failed a row refused for a lock again when a later call of its resend stops the node', async () => {
    const bulkWriteRecords = vi.fn<BulkFn>().mockImplementation(async (...a) => {
      const answer = allWritten(a[3]);
      for (let i = 0; i < 300; i++) answer.answers[i] = LOCK;
      return answer;
    });
    // Sent again in calls of 200 and 100: the first refuses one row for a lock
    // again, the second throws.
    const insertRecords = vi
      .fn<InsertImpl>()
      .mockImplementationOnce(async (_o, _ob, sent) =>
        sent.map((row, i) => (i === 0 ? LOCK : { id: idOf(row), success: true, errors: [] })),
      )
      .mockRejectedValue(requestLimit());
    const deps = makeDeps(bulkWriteRecords, insertRecords);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const result = await new BatchWriter(deps, undefined, noWait()).writeNode(
      makeInput(rows(2_000)),
    );

    expect(insertRecords.mock.calls.map((c) => c[2].length)).toEqual([200, 100]);
    expect(result.successCount).toBe(1_899);
    // Every row counted: the hundred of the call that threw, and the one locked again.
    expect(result.failureCount).toBe(101);
  });

  it('throws the cancel on once a job the cancel aborted wrote nothing', async () => {
    const bulkWriteRecords = vi.fn<BulkFn>().mockResolvedValue({
      answers: [],
      rows: [],
      unmatchedIds: [],
      aborted: true,
      requests: 2,
    });
    const deps = makeDeps(bulkWriteRecords);
    const waitIfPaused = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error('aborted by user'));

    await expect(
      new BatchWriter(deps).writeNode(makeInput(rows(2_000), { waitIfPaused })),
    ).rejects.toThrow('aborted by user');
    expect(deps.insertRecords).not.toHaveBeenCalled();
  });

  it('sends no job a cancel comes before, the jobs before it counted', async () => {
    const bulkWriteRecords = vi.fn<BulkFn>().mockImplementation(async (...a) => allWritten(a[3]));
    const deps = makeDeps(bulkWriteRecords);
    const waitIfPaused = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error('aborted by user'));
    const tally = emptyBatchWriteResult();

    await expect(
      new BatchWriter(deps).writeNode(makeInput(rows(20_000), { waitIfPaused }), tally),
    ).rejects.toThrow('aborted by user');
    expect(bulkWriteRecords).toHaveBeenCalledTimes(1);
    expect(tally.successCount).toBe(10_000);
  });

  it('sends a round of rows refused on their fields as jobs, from 2 000 of them', async () => {
    const refusal: InsertResult = {
      id: '',
      success: false,
      errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: Bad name'],
      errorDetails: [
        { statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'Bad name', fields: ['Name'] },
      ],
    };
    const bulkWriteRecords = vi
      .fn<BulkFn>()
      .mockImplementationOnce(async (...a) => ({
        ...allWritten(a[3]),
        answers: a[3].map(() => refusal),
      }))
      .mockImplementation(async (_o, _ob, _op, sent) => ({
        ...allWritten(sent),
        answers: sent.map((_, i) => ({ id: `001NEW${i}`, success: true, errors: [] })),
      }));
    const deps = makeDeps(bulkWriteRecords);

    const result = await new BatchWriter(deps).writeNode(makeInput(rows(2_000)));

    expect(bulkWriteRecords).toHaveBeenCalledTimes(2);
    expect(bulkWriteRecords.mock.calls[1][3][0]).not.toHaveProperty('Name');
    expect(deps.insertRecords).not.toHaveBeenCalled();
    expect(result.successCount).toBe(2_000);
    expect(result.writtenWithoutFields?.rows).toBe(2_000);
  });
});

describe('BatchWriter — a job whose chunk the target’s automation refused for a Salesforce limit', () => {
  const INSERT: CallKey = { objectApiName: 'Ledger__c', op: 'insert' };

  /**
   * Jobs the first of which answers the rows of its first chunk refused for a
   * limit, its other rows written, and every one after it written whole.
   */
  function jobs() {
    return vi
      .fn<BulkFn>()
      .mockImplementationOnce(async (...a) => {
        const answer = allWritten(a[3]);
        for (let i = 0; i < 200; i++) answer.answers[i] = limited();
        return answer;
      })
      .mockImplementation(async (...a) => allWritten(a[3]));
  }

  /** The target's REST writes, its trigger refusing for a limit every row of a call of more than 100. */
  const refusingOver = (max: number) =>
    restWriter((_row, call) => (call > max ? limited() : undefined));

  const ledgers = (n: number, from = 0) => rows(n + from, 'a0B').slice(from);

  it('sends the rows a job refused for a limit by REST, a record on its own then halves of 100, never at 200, out of the run’s allowance', async () => {
    const splitting = limitSplitting();
    const deps = makeDeps(jobs(), refusingOver(100));
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const writer = new BatchWriter(deps, undefined, noWait(), splitting);

    const result = await writer.writeNode(makeInput(ledgers(2_000), {}, 'Ledger__c'));

    expect(deps.bulkWriteRecords).toHaveBeenCalledTimes(1);
    expect(deps.insertRecords.mock.calls.map((c) => c[2].length)).toEqual([1, 100, 99]);
    expect(result.successCount).toBe(2_000);
    expect(result.failureCount).toBe(0);
    // Every call that stands in for a part of the job is paid.
    expect(splitting.allowance.spent).toBe(3);
    expect(splitting.sizes.report(INSERT)).toMatchObject({
      from: 200,
      to: 100,
      automation: 'Ledger_Trigger',
      extraCalls: 3,
    });
  });

  it('sends the next node of the object by REST at the size kept, each call paid against the job, and what the allowance does not pay for as a job', async () => {
    // Three smaller calls for the first node, seven for the next.
    const splitting = limitSplitting(10);
    const deps = makeDeps(jobs(), refusingOver(100));
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const writer = new BatchWriter(deps, undefined, noWait(), splitting);
    await writer.writeNode(makeInput(ledgers(2_000), {}, 'Ledger__c'));
    deps.insertRecords.mockClear();

    const next = await writer.writeNode(makeInput(ledgers(3_200, 2_000), {}, 'Ledger__c'));

    expect(deps.insertRecords.mock.calls.map((c) => c[2].length)).toEqual([
      100, 100, 100, 100, 100, 100, 100,
    ]);
    expect(deps.bulkWriteRecords.mock.calls.map((c) => c[3].length)).toEqual([2_000, 2_500]);
    expect(next.successCount).toBe(3_200);
    expect(splitting.allowance.spent).toBe(10);
    expect(splitting.sizes.isSpent(INSERT)).toBe(true);
  });

  it('leaves refused, never sent at 200, the rows of a job the allowance pays no smaller call for', async () => {
    const splitting = limitSplitting(0);
    const deps = makeDeps(jobs(), refusingOver(100));
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const result = await new BatchWriter(deps, undefined, noWait(), splitting).writeNode(
      makeInput(ledgers(2_000), {}, 'Ledger__c'),
    );

    expect(deps.insertRecords).not.toHaveBeenCalled();
    expect(result.successCount).toBe(1_800);
    expect(result.failureCount).toBe(200);
    expect(result.errorSamples[0].messages).toEqual([
      `CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: ${LIMIT_MESSAGE}`,
      governorLimitNotSplit(0),
    ]);
  });

  it('keeps the object in jobs once records of it sent on their own were refused too', async () => {
    const splitting = limitSplitting();
    // The trigger refuses each record on its own: no smaller call takes it.
    const deps = makeDeps(
      jobs(),
      restWriter(() => limited()),
    );
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const writer = new BatchWriter(deps, undefined, noWait(), splitting);

    const result = await writer.writeNode(makeInput(ledgers(2_000), {}, 'Ledger__c'));
    await writer.writeNode(makeInput(ledgers(2_000, 2_000), {}, 'Ledger__c'));

    expect(deps.insertRecords.mock.calls.map((c) => c[2].length)).toEqual([1, 1]);
    expect(result.failureCount).toBe(200);
    expect(result.errorSamples.at(-1)?.messages).toContain(GOVERNOR_LIMIT_KEPT_WHOLE);
    // A job's chunk of 200 and a call of 200 are refused alike: the next node goes as a job.
    expect(deps.bulkWriteRecords.mock.calls.map((c) => c[3].length)).toEqual([2_000, 2_000]);
  });

  it('counts as failed, by REST too, a row a smaller call refused for a lock when a later call of its batch stops the node', async () => {
    // A batch of 200 refused for a limit, a record taken on its own, then
    // halves: the first refuses a row for a lock, the second throws.
    const insertRecords = vi
      .fn<InsertImpl>()
      .mockImplementationOnce(async (_o, _ob, sent) => sent.map(() => limited()))
      .mockImplementationOnce(async (_o, _ob, sent) =>
        sent.map((row) => ({ id: idOf(row), success: true, errors: [] })),
      )
      .mockImplementationOnce(async (_o, _ob, sent) =>
        sent.map((row, i) => (i === 0 ? LOCK : { id: idOf(row), success: true, errors: [] })),
      )
      .mockRejectedValue(
        Object.assign(new Error('REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.'), {
          errorCode: 'REQUEST_LIMIT_EXCEEDED',
        }),
      );
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const writer = new BatchWriter(
      { insertRecords, bulkWriteRecords: vi.fn<BulkFn>() },
      undefined,
      noWait(),
    );

    const result = await writer.writeNode(
      makeInput(ledgers(200), { bulk: undefined }, 'Ledger__c'),
    );

    expect(insertRecords.mock.calls.map((c) => c[2].length)).toEqual([200, 1, 100, 99]);
    expect(result.successCount).toBe(100);
    expect(result.failureCount).toBe(100);
  });
});

describe('BatchWriter — an owner the target holds inactive, in a job', () => {
  /** The owner as the source gave it, on 18 characters, and as the target names it, on 15. */
  const OWNER = '005000000000001AAA';
  const NAMED = '005000000000001';
  /** Another owner, active in the target. */
  const ACTIVE = '005000000000002AAA';
  const MESSAGE = `operation performed with inactive user [${NAMED}] as owner of ledger__c`;
  const REASON = `INACTIVE_OWNER_OR_USER: ${MESSAGE}`;
  /** The Bulk API's words for it, as an `sf__Error` reads. */
  const SF_ERROR = `INACTIVE_OWNER_OR_USER:${MESSAGE}:--`;

  /** The same refusal as a job answers it: `sf__Error` read for its code, as `forgeBulkWrite` does. */
  function byInactiveOwnerInAJob(): InsertResult {
    const detail = bulkSaveErrorDetail(SF_ERROR);
    if (!detail) throw new Error('the sf__Error reads as one error');
    return { id: '', success: false, errors: [formatSaveError(detail)], errorDetails: [detail] };
  }

  it('writes a refused round of 2 000 rows or more as a job, the owner gone from every row and from the journal', async () => {
    const bulkWriteRecords = vi
      .fn<BulkFn>()
      .mockImplementationOnce(async (...a) => ({
        ...allWritten(a[3]),
        answers: a[3].map(() => byInactiveOwnerInAJob()),
      }))
      .mockImplementation(async (...a) => allWritten(a[3]));
    const deps = makeDeps(bulkWriteRecords);
    const sending = vi
      .fn<InsertCallJournal['sending']>()
      .mockReturnValueOnce('call-1')
      .mockReturnValueOnce('call-2');
    const input = makeInput(
      rows(2_500, 'a0B', { OwnerId: OWNER }),
      { calls: { sending, answered: vi.fn() } },
      'Ledger__c',
    );

    const result = await new BatchWriter(deps).writeNode(input);

    expect(bulkWriteRecords).toHaveBeenCalledTimes(2);
    expect(bulkWriteRecords.mock.calls[1][3]).toHaveLength(2_500);
    expect(bulkWriteRecords.mock.calls[1][3].some((row) => 'OwnerId' in row)).toBe(false);
    expect(deps.insertRecords).not.toHaveBeenCalled();
    // The round is a call of its own, journaled as it goes: without the owner.
    expect(sending).toHaveBeenCalledTimes(2);
    const journaled = sending.mock.calls[1][1];
    expect(journaled.every((row) => !('OwnerId' in row.payload))).toBe(true);
    expect(result.successCount).toBe(2_500);
    expect(result.writtenWithoutFields).toEqual({
      rows: 2_500,
      fields: [{ field: 'OwnerId', refusedBy: 'inactive-owner', reason: REASON, rows: 2_500 }],
    });
  });

  it('leaves the owner of a mapped user to the row, which fails with the target’s words in a job too', async () => {
    const bulkWriteRecords = vi.fn<BulkFn>().mockImplementation(async (...a) => ({
      ...allWritten(a[3]),
      answers: a[3].map(() => byInactiveOwnerInAJob()),
    }));
    const deps = makeDeps(bulkWriteRecords);

    const result = await new BatchWriter(deps).writeNode(
      makeInput(
        rows(2_000, 'a0B', { OwnerId: OWNER }),
        { ownersMapped: new Set([NAMED]) },
        'Ledger__c',
      ),
    );

    expect(bulkWriteRecords).toHaveBeenCalledTimes(1);
    expect(deps.insertRecords).not.toHaveBeenCalled();
    expect(result.failureCount).toBe(2_000);
    expect(result.successCount).toBe(0);
  });

  /**
   * An org that takes the jobs it is sent as the Bulk API 2.0 does — opened,
   * its CSV uploaded, closed, read complete, its results read three ways —
   * and keeps each CSV. Each row is written, or refused as `refuse` says.
   */
  function bulkOrg(refuse: (row: Record<string, string>) => string | undefined = () => undefined) {
    const uploads: string[] = [];
    let written = 0;
    const conn: BulkApiConnection & IngestJobResultsReading = {
      bulk2: {
        createJob: () => {
          let id: string | undefined;
          let csv = '';
          const sent = (): Array<Record<string, string>> => {
            const [header, ...lines] = csv.trimEnd().split('\n');
            const columns = header.split(',');
            return lines.map((line) => {
              const cells = line.split(',');
              return Object.fromEntries(columns.map((c, i) => [c, cells[i] ?? '']));
            });
          };
          const results = (): JsforceIngestJobResults => {
            const successfulResults: Array<Record<string, unknown>> = [];
            const failedResults: Array<Record<string, unknown>> = [];
            for (const row of sent()) {
              const error = refuse(row);
              if (error) failedResults.push({ sf__Id: '', sf__Error: error, ...row });
              else {
                written++;
                successfulResults.push({
                  sf__Id: `a0B${String(written).padStart(12, '0')}AAA`,
                  sf__Created: 'true',
                  ...row,
                });
              }
            }
            return { successfulResults, failedResults, unprocessedRecords: [] };
          };
          return {
            get id() {
              return id;
            },
            open: async () => {
              id = `750${String(uploads.length + 1).padStart(12, '0')}AAA`;
            },
            uploadData: async (data) => {
              csv = data;
              uploads.push(data);
            },
            close: async () => undefined,
            abort: async () => undefined,
            check: async () => ({ state: 'JobComplete', numberRecordsProcessed: sent().length }),
            getAllResults: async () => results(),
          };
        },
        job: () => {
          throw new Error('no job is read back by its id here');
        },
      },
    };
    const bulkWriteRecords: BulkFn = (_org, object, operation, records, options) =>
      forgeBulkWrite(conn, options.bulkManager, object, operation, records, {
        ...(options.externalIdField ? { externalIdField: options.externalIdField } : {}),
        ...(options.onOpened ? { onOpened: options.onOpened } : {}),
        pollDelay: () => 0,
      });
    return { bulkWriteRecords, uploads };
  }

  it('sends a later job’s row without the owner the target refused earlier in the run, its cell left empty, never #N/A', async () => {
    const org = bulkOrg();
    // A REST write of the run met the inactive owner first.
    const insertRecords = restWriter((row) =>
      row['OwnerId'] === OWNER
        ? toSaveOutcome(
            {
              success: false,
              errors: [{ statusCode: 'INACTIVE_OWNER_OR_USER', message: MESSAGE, fields: [] }],
            },
            'Ledger__c',
          )
        : undefined,
    );
    const writer = new BatchWriter({ insertRecords, bulkWriteRecords: org.bulkWriteRecords });
    await writer.writeNode(
      makeInput(rows(1, 'a0C', { OwnerId: OWNER }), { bulk: undefined }, 'Note__c'),
    );

    const owners = (n: number) =>
      rows(n, 'a0B').map((row, i) => ({ ...row, OwnerId: i % 2 === 0 ? OWNER : ACTIVE }));
    const result = await writer.writeNode(makeInput(owners(2_000), {}, 'Ledger__c'));

    expect(org.uploads).toHaveLength(1);
    const [header, ...lines] = org.uploads[0].trimEnd().split('\n');
    const ownerAt = header.split(',').indexOf('OwnerId');
    const cells = lines.map((line) => line.split(',')[ownerAt]);
    expect(cells.filter((cell) => cell === '')).toHaveLength(1_000);
    expect(cells.filter((cell) => cell === ACTIVE)).toHaveLength(1_000);
    expect(cells).not.toContain('#N/A');
    expect(result.successCount).toBe(2_000);
    expect(result.writtenWithoutFields?.fields).toEqual([
      { field: 'OwnerId', refusedBy: 'inactive-owner', reason: REASON, rows: 1_000 },
    ]);
  });

  it('writes again without the owner, as a job, the rows a real job’s results refused for it', async () => {
    const org = bulkOrg((row) => (row['OwnerId'] === OWNER ? SF_ERROR : undefined));
    const insertRecords = restWriter();
    const writer = new BatchWriter({ insertRecords, bulkWriteRecords: org.bulkWriteRecords });

    const result = await writer.writeNode(
      makeInput(rows(2_000, 'a0B', { OwnerId: OWNER }), {}, 'Ledger__c'),
    );

    expect(org.uploads).toHaveLength(2);
    expect(org.uploads[1].split('\n')[0]).not.toContain('OwnerId');
    expect(insertRecords).not.toHaveBeenCalled();
    expect(result.successCount).toBe(2_000);
    expect(result.writtenWithoutFields?.fields).toEqual([
      { field: 'OwnerId', refusedBy: 'inactive-owner', reason: REASON, rows: 2_000 },
    ]);
  });
});
