import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BatchWriter,
  emptyBatchWriteResult,
  type InsertCallJournal,
  type WriteNodeInput,
} from './BatchWriter.js';
import {
  CallSizes,
  GOVERNOR_LIMIT_ALONE,
  SplitAllowance,
  type CallKey,
} from '../../../core/common/governorLimit.js';
import { BulkApiManager } from '../../../core/engine/BulkApiManager.js';
import {
  bulkSaveErrorDetail,
  formatSaveError,
  toSaveOutcome,
} from '../../../core/common/existingRecordMatch.js';
import type { BulkRowState, BulkWriteAnswer } from '../forgeBulkWrite.js';
import { IdRemapper } from '../IdRemapper.js';
import { logger } from '../../../logger.js';
import type { ForgeExecutorDeps, ForgeProgressEvent, InsertResult } from '../ForgeExecutor.js';
import type { ForgeGraphNode } from '@sandforge/shared';

/*
 * A call the target's automation refuses for a Salesforce limit, written
 * again in smaller calls: the incident of a removal refused on its 116
 * `Provenance__c` by a trigger that ran a query per record, met by a write.
 */

type InsertImpl = ForgeExecutorDeps['insertRecords'];
type BulkFn = NonNullable<ForgeExecutorDeps['bulkWriteRecords']>;

const OBJECT = 'Provenance__c';
const INSERT: CallKey = { objectApiName: OBJECT, op: 'insert' };

/** The trigger's refusal of a row of a call too large for it, as the org wrote it. */
const LIMIT_MESSAGE =
  'SSC_TRG_Provenance: execution of BeforeInsert\n\ncaused by: System.LimitException: ' +
  'Too many SOQL queries: 101\n\nTrigger.SSC_TRG_Provenance: line 12, column 1';

/** A row of a call the trigger refused, as the REST writers hand it on. */
function limited(): InsertResult {
  return toSaveOutcome(
    {
      success: false,
      errors: [
        { statusCode: 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY', message: LIMIT_MESSAGE, fields: [] },
      ],
    },
    OBJECT,
  );
}

/** The same refusal as a job answers it, read from its `sf__Error`. */
function limitedInAJob(): InsertResult {
  const detail = bulkSaveErrorDetail(
    `CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY:${LIMIT_MESSAGE.replace(/\n/g, ' ')}:--`,
  );
  if (!detail) throw new Error('the sf__Error reads as one error');
  return { id: '', success: false, errors: [formatSaveError(detail)], errorDetails: [detail] };
}

const LOCK: InsertResult = {
  id: '',
  success: false,
  errors: ['UNABLE_TO_LOCK_ROW: unable to obtain exclusive access to this record'],
};

/** The owner the target holds inactive, as the source gave it and as the target names it. */
const OWNER = '005AU00000AbCdEYAQ';
const NAMED = '005AU00000AbCdE';
const OWNER_MESSAGE = `operation performed with inactive user [${NAMED}] as owner of [provenance__c]`;

const byInactiveOwner = (): InsertResult =>
  toSaveOutcome(
    {
      success: false,
      errors: [{ statusCode: 'INACTIVE_OWNER_OR_USER', message: OWNER_MESSAGE, fields: [] }],
    },
    OBJECT,
  );

function byInactiveOwnerInAJob(): InsertResult {
  const detail = bulkSaveErrorDetail(`INACTIVE_OWNER_OR_USER:${OWNER_MESSAGE}:--`);
  if (!detail) throw new Error('the sf__Error reads as one error');
  return { id: '', success: false, errors: [formatSaveError(detail)], errorDetails: [detail] };
}

/** The id the target gives a row it took: its name's, so that each answer is told from the others. */
const idOf = (row: Record<string, unknown>): string => `a0BNEW-${String(row['Name'])}`;

/**
 * The target, whose trigger refuses for a limit every row of a call of more
 * than `max` rows, and takes the rows of a smaller one.
 */
function refusingCallsOver(
  max: number,
  also?: (row: Record<string, unknown>) => InsertResult | undefined,
): InsertImpl {
  return async (_org, _object, rows) =>
    rows.length > max
      ? rows.map(() => limited())
      : rows.map((row) => also?.(row) ?? { id: idOf(row), success: true, errors: [] });
}

/** `n` rows of the object, each its own source id and name. */
function provenances(
  n: number,
  extra: Record<string, unknown> = {},
): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    Id: `a0BOLD${String(i).padStart(9, '0')}`,
    Name: `P${i}`,
    ...extra,
  }));
}

function makeNode(
  recordCount: number,
  batchStrategy: ForgeGraphNode['batchStrategy'] = 'rest',
): ForgeGraphNode {
  return {
    objectApiName: OBJECT,
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
    batchStrategy,
  };
}

/** The node's rows as the cleaning stage hands them on: the source id kept out of the payload. */
function makeInput(
  rows: Array<Record<string, unknown>>,
  overrides: Partial<WriteNodeInput> = {},
): WriteNodeInput {
  const payloadOf = (row: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'Id'));
  return {
    node: makeNode(rows.length),
    records: rows.map(payloadOf),
    cleanedRecords: rows.map((row) => ({
      source: { ...row },
      cleaned: payloadOf(row),
      nullifiedFks: [],
    })),
    fieldInfos: [
      { name: 'Id', queryable: true, createable: false, isReference: false },
      { name: 'Name', queryable: true, createable: true, isReference: false },
      { name: 'OwnerId', queryable: true, createable: true, isReference: true },
    ],
    creatableFields: new Set(['Name', 'OwnerId']),
    upsertMode: 'off',
    targetOrgId: 'tgt',
    remapper: new IdRemapper(),
    waitIfPaused: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    onProgress: vi.fn<(e: ForgeProgressEvent) => void>(),
    ...overrides,
  };
}

/** A node whose strategy asks for jobs, written by a run that sends them. */
function bulkInput(
  rows: Array<Record<string, unknown>>,
  overrides: Partial<WriteNodeInput> = {},
): WriteNodeInput {
  return makeInput(rows, {
    node: makeNode(rows.length, 'auto'),
    bulk: {
      signal: new AbortController().signal,
      restOnly: new Set<string>(),
      bulkUnsupported: new Set<string>(),
      manager: new BulkApiManager(1),
    },
    ...overrides,
  });
}

/** The answer of a job that wrote every row it was sent, but those `refuse` answers for. */
function jobAnswer(
  sent: readonly Record<string, unknown>[],
  refuse: (index: number) => InsertResult | undefined,
): BulkWriteAnswer {
  return {
    answers: sent.map(
      (row, i) => refuse(i) ?? { id: `a0BJOB-${String(row['Name'])}`, success: true, errors: [] },
    ),
    rows: sent.map((): BulkRowState => 'answered'),
    unmatchedIds: [],
    jobId: '750JOB',
    requests: 12,
  };
}

/** A journal of the node's calls, keeping the rows of each and the calls closed. */
function journal(): InsertCallJournal & { sizes: number[]; closed: string[] } {
  const sizes: number[] = [];
  const closed: string[] = [];
  return {
    sizes,
    closed,
    sending: vi.fn<InsertCallJournal['sending']>((_object, rows) => {
      sizes.push(rows.length);
      return `call-${sizes.length}`;
    }),
    answered: vi.fn<InsertCallJournal['answered']>((id) => {
      closed.push(id);
    }),
  };
}

const sizesSent = (insertRecords: InsertImpl): number[] =>
  vi.mocked(insertRecords).mock.calls.map((call) => call[2].length);

describe('BatchWriter — a call the target’s automation refused for a Salesforce limit', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes the rows again in calls half as large, each call journaled and closed, and the next batch at the size that went through', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const insertRecords = vi.fn<InsertImpl>(refusingCallsOver(50));
    const calls = journal();
    const sizes = new CallSizes();
    const allowance = new SplitAllowance();
    const input = makeInput(provenances(400), { calls });

    const result = await new BatchWriter({ insertRecords }, undefined, {
      sizes,
      allowance,
    }).writeNode(input);

    // 1 call of 200, 2 of 100, 4 of 50; then the next batch at 50 at once.
    expect(sizesSent(insertRecords)).toEqual([200, 100, 50, 50, 100, 50, 50, 50, 50, 50, 50]);
    expect(calls.sizes).toEqual(sizesSent(insertRecords));
    expect(calls.closed).toEqual(calls.sizes.map((_, i) => `call-${i + 1}`));
    expect(result).toMatchObject({ successCount: 400, failureCount: 0, errorSamples: [] });
    // Each answer paired with its own row, through every smaller call.
    for (let i = 0; i < 400; i++) {
      expect(input.remapper.get(`a0BOLD${String(i).padStart(9, '0')}`)).toBe(`a0BNEW-P${i}`);
    }
    expect(sizes.report(INSERT)).toEqual({
      objectApiName: OBJECT,
      op: 'insert',
      from: 200,
      to: 50,
      rows: 400,
      // 2 + 2 + 2 calls sending refused rows again, 3 more than calls of 200 for the next batch.
      extraCalls: 9,
      limit: 'Too many SOQL queries',
      automation: 'SSC_TRG_Provenance',
      event: 'before insert',
      notSplit: 0,
      spent: false,
    });
    expect(allowance.spent).toBe(9);
    // Said once for the object, the first time.
    const said = warn.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes('hit'));
    expect(said).toEqual([
      `[forge] ${OBJECT}: SSC_TRG_Provenance hit Too many SOQL queries on a call of 200 — sending 100 at a time.`,
    ]);
  });

  it('keeps an object it never refused at 200, beside one it did', async () => {
    const sizes = new CallSizes();
    const insertRecords = vi.fn<InsertImpl>(async (_org, object, rows) =>
      object === OBJECT && rows.length > 50
        ? rows.map(() => limited())
        : rows.map((row) => ({ id: idOf(row), success: true, errors: [] })),
    );
    const writer = new BatchWriter({ insertRecords }, undefined, { sizes });
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await writer.writeNode(makeInput(provenances(200)));
    const other = makeInput(provenances(200), {
      node: { ...makeNode(200), objectApiName: 'Other__c' },
    });
    await writer.writeNode(other);

    expect(sizesSent(insertRecords).slice(-1)).toEqual([200]);
    expect(sizes.of({ objectApiName: 'Other__c', op: 'insert' })).toBe(200);
  });

  it('fails a row the trigger refuses sent on its own, saying what to fix', async () => {
    const insertRecords = vi.fn<InsertImpl>(refusingCallsOver(0));

    const result = await new BatchWriter({ insertRecords }).writeNode(makeInput(provenances(1)));

    expect(sizesSent(insertRecords)).toEqual([1]);
    expect(result.failureCount).toBe(1);
    expect(result.errorSamples).toHaveLength(1);
    expect(result.errorSamples[0].messages[1]).toBe(GOVERNOR_LIMIT_ALONE);
    expect(result.errorSamples[0].messages[0]).toMatch(/^CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: /);
  });

  it('fails the rows the allowance does not pay smaller calls for, saying so, and goes back to calls of 200', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const insertRecords = vi.fn<InsertImpl>(refusingCallsOver(50));
    const sizes = new CallSizes();

    const result = await new BatchWriter({ insertRecords }, undefined, {
      sizes,
      allowance: new SplitAllowance(2),
    }).writeNode(makeInput(provenances(400)));

    // The two calls of 100 paid, refused in turn; nothing smaller paid for
    // the first, the second not sent again; the next batch at 200.
    expect(sizesSent(insertRecords)).toEqual([200, 100, 100, 200]);
    expect(result).toMatchObject({ successCount: 0, failureCount: 400 });
    expect(result.errorSamples[0].messages[1]).toBe(
      'Not sent in smaller calls: the run had spent the 2 smaller calls it allows itself.',
    );
    expect(sizes.report(INSERT)).toMatchObject({ notSplit: 400, spent: true, extraCalls: 2 });
    expect(sizes.of(INSERT)).toBe(200);
  });

  it('says no smaller call was allowed when the run was allowed none', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const insertRecords = vi.fn<InsertImpl>(refusingCallsOver(50));

    const result = await new BatchWriter({ insertRecords }, undefined, {
      allowance: new SplitAllowance(0),
    }).writeNode(makeInput(provenances(200)));

    expect(sizesSent(insertRecords)).toEqual([200]);
    expect(result.failureCount).toBe(200);
    expect(result.errorSamples[0].messages[1]).toBe(
      'Not sent in smaller calls: what the org has left today allowed the run none.',
    );
  });

  it('sends rows refused for a lock again by their circuit, and rows refused for a limit by theirs, from one call', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const wait = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    let first = true;
    const insertRecords = vi.fn<InsertImpl>(async (_org, _object, rows) => {
      if (first) {
        first = false;
        return rows.map((_, i) => (i === 0 ? LOCK : limited()));
      }
      return rows.length > 2
        ? rows.map(() => limited())
        : rows.map((row) => ({ id: idOf(row), success: true, errors: [] }));
    });

    const result = await new BatchWriter({ insertRecords }, undefined, { wait }).writeNode(
      makeInput(provenances(4)),
    );

    expect(
      vi.mocked(insertRecords).mock.calls.map((call) => call[2].map((row) => row['Name'])),
    ).toEqual([['P0', 'P1', 'P2', 'P3'], ['P1', 'P2'], ['P3'], ['P0']]);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ successCount: 4, failureCount: 0 });
  });

  it('keeps the sends for a lock of a row it sends again smaller: three at most', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const wait = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    // Every call of one row meets the lock; a call of two, the trigger's limit.
    const insertRecords = vi
      .fn<InsertImpl>()
      .mockImplementationOnce(async (_org, _object, rows) => rows.map(() => LOCK))
      .mockImplementation(refusingCallsOver(1, () => LOCK));

    const result = await new BatchWriter({ insertRecords }, undefined, { wait }).writeNode(
      makeInput(provenances(2)),
    );

    // The first write; the first send again, halved; two more, one row a call.
    expect(sizesSent(insertRecords)).toEqual([2, 2, 1, 1, 1, 1, 1, 1]);
    expect(wait).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ successCount: 0, failureCount: 2 });
    expect(result.errorSamples[0].messages).toContain(
      'Sent again 3 times, the target still could not lock a record the write needed.',
    );
  });

  it('keeps the rows it sends again smaller as they were: a refusal on fields keeps its rounds', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    // A row refused for its inactive owner goes again without it, in a round
    // the trigger refuses for a limit: halved, and the last row alone still.
    const insertRecords = vi
      .fn<InsertImpl>()
      .mockImplementationOnce(async (_org, _object, rows) => rows.map(() => byInactiveOwner()))
      .mockImplementation(
        refusingCallsOver(1, (row) => (row['Name'] === 'P2' ? limited() : undefined)),
      );

    const result = await new BatchWriter({ insertRecords }).writeNode(
      makeInput(provenances(3, { OwnerId: OWNER })),
    );

    const sent = vi.mocked(insertRecords).mock.calls.map((call) => call[2]);
    expect(sent.map((rows) => rows.map((row) => row['Name']))).toEqual([
      ['P0', 'P1', 'P2'],
      ['P0', 'P1', 'P2'],
      ['P0', 'P1'],
      ['P0'],
      ['P1'],
      ['P2'],
    ]);
    // Sent again smaller, a row goes as its round sent it: without its owner.
    expect(sent.slice(1).every((rows) => rows.every((row) => !('OwnerId' in row)))).toBe(true);
    expect(result).toMatchObject({ successCount: 2, failureCount: 1 });
    expect(result.writtenWithoutFields?.rows).toBe(2);
    const [sample] = result.errorSamples;
    expect(sample.messages[1]).toBe(GOVERNOR_LIMIT_ALONE);
    expect(sample.messages[2]).toBe(
      `Sent again without OwnerId after the first refusal: INACTIVE_OWNER_OR_USER: ${OWNER_MESSAGE}`,
    );
  });

  it('leaves the rows waiting to go again smaller the failures the target made them when a cancel comes before their call, each counted once', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const insertRecords = vi
      .fn<InsertImpl>()
      .mockImplementationOnce(async (_org, _object, rows) => rows.map(() => byInactiveOwner()))
      .mockImplementation(refusingCallsOver(2));
    const cancel = new Error('Execution cancelled');
    const waitIfPaused = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(cancel);
    const tally = emptyBatchWriteResult();
    const input = makeInput(provenances(4, { OwnerId: OWNER }), { waitIfPaused });

    await expect(new BatchWriter({ insertRecords }).writeNode(input, tally)).rejects.toThrow(
      cancel,
    );

    // The first write, the round refused for a limit; no call after the cancel.
    expect(sizesSent(insertRecords)).toEqual([4, 4]);
    expect(tally).toMatchObject({ successCount: 0, failureCount: 4 });
    expect(tally.errorSamples[0].messages).toContain(
      'Not written again without OwnerId: Execution cancelled',
    );
  });

  it('leaves uncounted, as a cancel leaves any row of the first write, the rows waiting to go again smaller', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const insertRecords = vi.fn<InsertImpl>(refusingCallsOver(2));
    const cancel = new Error('Execution cancelled');
    const waitIfPaused = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(cancel);
    const tally = emptyBatchWriteResult();
    const input = makeInput(provenances(6), { waitIfPaused });

    await expect(new BatchWriter({ insertRecords }).writeNode(input, tally)).rejects.toThrow(
      cancel,
    );

    expect(sizesSent(insertRecords)).toEqual([6, 3]);
    expect(tally).toMatchObject({ successCount: 0, failureCount: 0 });
  });

  it('stops at a smaller call that may have written, counting the rows waiting to go again and those after them', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const reset = Object.assign(new Error('read ECONNRESET'), {
      name: 'FetchError',
      type: 'system',
      code: 'ECONNRESET',
    });
    const insertRecords = vi.fn<InsertImpl>(async (_org, _object, rows) => {
      if (rows.length > 100) return rows.map(() => limited());
      throw reset;
    });

    const result = await new BatchWriter({ insertRecords }).writeNode(makeInput(provenances(400)));

    expect(sizesSent(insertRecords)).toEqual([200, 100]);
    expect(result).toMatchObject({ successCount: 0, failureCount: 400 });
    expect(result.mayHaveBeenWritten).toHaveLength(100);
    expect(result.mayHaveBeenWritten?.[0]).toBe('a0BOLD000000000');
    expect(result.errorSamples[0]).toMatchObject({
      recordSummary: `${OBJECT} batch 1/2: 100 records may have been written`,
    });
    expect(result.errorSamples[0].messages).toContain('300 records after them not sent.');
  });

  describe('written as Bulk API jobs', () => {
    it('sends the rows a job refused for a limit again by REST at 100, closes the job, and sends its round without fields by REST', async () => {
      vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const bulkWriteRecords = vi.fn<BulkFn>(async (_o, _ob, _op, sent) =>
        jobAnswer(sent, (i) =>
          i < 300 ? limitedInAJob() : i < 2_300 ? byInactiveOwnerInAJob() : undefined,
        ),
      );
      const insertRecords = vi.fn<InsertImpl>(refusingCallsOver(100));
      const calls = journal();
      const sizes = new CallSizes();

      const result = await new BatchWriter({ insertRecords, bulkWriteRecords }, undefined, {
        sizes,
      }).writeNode(bulkInput(provenances(2_400, { OwnerId: OWNER }), { calls }));

      expect(bulkWriteRecords).toHaveBeenCalledTimes(1);
      // The job's 300 by REST at 100, then the round of 2 000 without the owner, by REST at 100.
      expect(sizesSent(insertRecords)).toEqual(Array.from({ length: 23 }, () => 100));
      expect(calls.closed).toContain('call-1');
      expect(calls.closed).toHaveLength(calls.sizes.length);
      expect(result).toMatchObject({ successCount: 2_400, failureCount: 0 });
      expect(sizes.report(INSERT)).toMatchObject({ from: 200, to: 100, notSplit: 0 });
    });

    it('sends the next node of the object by REST, never as a job, once a job of it was refused for a limit', async () => {
      vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const bulkWriteRecords = vi.fn<BulkFn>(async (_o, _ob, _op, sent) =>
        jobAnswer(sent, (i) => (i < 100 ? limitedInAJob() : undefined)),
      );
      const insertRecords = vi.fn<InsertImpl>(refusingCallsOver(100));
      const writer = new BatchWriter({ insertRecords, bulkWriteRecords });

      await writer.writeNode(bulkInput(provenances(2_000)));
      const next = await writer.writeNode(bulkInput(provenances(2_000)));

      expect(bulkWriteRecords).toHaveBeenCalledTimes(1);
      expect(sizesSent(insertRecords)).toEqual(Array.from({ length: 21 }, () => 100));
      expect(next).toMatchObject({ successCount: 2_000, failureCount: 0 });
    });

    it('pays every REST call that replaces a job’s rows refused for a limit', async () => {
      vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const bulkWriteRecords = vi.fn<BulkFn>(async (_o, _ob, _op, sent) =>
        jobAnswer(sent, () => limitedInAJob()),
      );
      const insertRecords = vi.fn<InsertImpl>(refusingCallsOver(100));
      const sizes = new CallSizes();
      const allowance = new SplitAllowance();

      const result = await new BatchWriter({ insertRecords, bulkWriteRecords }, undefined, {
        sizes,
        allowance,
      }).writeNode(bulkInput(provenances(2_000)));

      // Twenty calls of 100 where one job went: each is one more.
      expect(sizesSent(insertRecords)).toEqual(Array.from({ length: 20 }, () => 100));
      expect(allowance.spent).toBe(20);
      expect(sizes.report(INSERT)).toMatchObject({ rows: 2_000, extraCalls: 20, notSplit: 0 });
      expect(result).toMatchObject({ successCount: 2_000, failureCount: 0 });
    });

    it('leaves refused, never sent at 200, the rows of a job the allowance pays no smaller call for', async () => {
      vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const bulkWriteRecords = vi.fn<BulkFn>(async (_o, _ob, _op, sent) =>
        jobAnswer(sent, () => limitedInAJob()),
      );
      const insertRecords = vi.fn<InsertImpl>(refusingCallsOver(100));
      const sizes = new CallSizes();

      const result = await new BatchWriter({ insertRecords, bulkWriteRecords }, undefined, {
        sizes,
        allowance: new SplitAllowance(3),
      }).writeNode(bulkInput(provenances(4_000)));

      // Three calls of 100 paid; the 3 700 rows left stay refused, unsent.
      expect(bulkWriteRecords).toHaveBeenCalledTimes(1);
      expect(sizesSent(insertRecords)).toEqual([100, 100, 100]);
      expect(result).toMatchObject({ successCount: 300, failureCount: 3_700 });
      expect(result.errorSamples[0].messages[1]).toBe(
        'Not sent in smaller calls: the run had spent the 3 smaller calls it allows itself.',
      );
      expect(sizes.report(INSERT)).toMatchObject({ notSplit: 3_700, spent: true, extraCalls: 3 });

      // Allowed none, the job's refusals are its rows' last word: no call at all.
      insertRecords.mockClear();
      const none = await new BatchWriter({ insertRecords, bulkWriteRecords }, undefined, {
        allowance: new SplitAllowance(0),
      }).writeNode(bulkInput(provenances(4_000)));
      expect(insertRecords).not.toHaveBeenCalled();
      expect(none).toMatchObject({ successCount: 0, failureCount: 4_000 });
    });

    it('sends by REST the piece of a chunk past the job a limit refused, never as a job', async () => {
      vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const bulkWriteRecords = vi.fn<BulkFn>(async (_o, _ob, _op, sent) =>
        jobAnswer(sent, () => limitedInAJob()),
      );
      const insertRecords = vi.fn<InsertImpl>(refusingCallsOver(100));
      // Rows of some 6 KB: the 10 000 make two jobs' CSV, cut at 50 MB.
      const wide = 'x'.repeat(6_000);

      const result = await new BatchWriter({ insertRecords, bulkWriteRecords }).writeNode(
        bulkInput(provenances(10_000, { Description__c: wide }), {
          creatableFields: new Set(['Name', 'OwnerId', 'Description__c']),
        }),
      );

      expect(bulkWriteRecords).toHaveBeenCalledTimes(1);
      expect(bulkWriteRecords.mock.calls[0][3].length).toBeLessThan(10_000);
      expect(sizesSent(insertRecords).every((size) => size <= 100)).toBe(true);
      expect(sizesSent(insertRecords).reduce((sum, size) => sum + size, 0)).toBe(10_000);
      expect(result).toMatchObject({ successCount: 10_000, failureCount: 0 });
    });

    it('sends by REST the jobs still planned as far as the allowance pays every call, and the rest as a job', async () => {
      vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const bulkWriteRecords = vi.fn<BulkFn>(async (_o, _ob, _op, sent) =>
        jobAnswer(sent, () => limitedInAJob()),
      );
      const insertRecords = vi.fn<InsertImpl>(refusingCallsOver(100));
      const allowance = new SplitAllowance(150);

      const result = await new BatchWriter({ insertRecords, bulkWriteRecords }, undefined, {
        allowance,
      }).writeNode(bulkInput(provenances(30_000)));

      // The first job's 10 000 rows by REST, 100 calls; 50 calls of the
      // second job's, the 5 000 rows left a job, as the third, the object spent.
      expect(bulkWriteRecords.mock.calls.map((call) => call[3].length)).toEqual([
        10_000, 5_000, 10_000,
      ]);
      expect(sizesSent(insertRecords)).toEqual(Array.from({ length: 150 }, () => 100));
      expect(allowance.spent).toBe(150);
      expect(result).toMatchObject({ successCount: 15_000, failureCount: 15_000 });
    });

    it('sends an object whose allowance is spent by REST at 200, never as a job', async () => {
      vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const bulkWriteRecords = vi.fn<BulkFn>(async (_o, _ob, _op, sent) =>
        jobAnswer(sent, () => undefined),
      );
      const insertRecords = vi.fn<InsertImpl>(refusingCallsOver(200));
      const sizes = new CallSizes();
      sizes.refusedAt(INSERT, 200);
      sizes.spend(INSERT);

      const result = await new BatchWriter({ insertRecords, bulkWriteRecords }, undefined, {
        sizes,
      }).writeNode(bulkInput(provenances(2_000)));

      expect(bulkWriteRecords).not.toHaveBeenCalled();
      expect(sizesSent(insertRecords)).toEqual(Array.from({ length: 10 }, () => 200));
      expect(result.successCount).toBe(2_000);
    });
  });
});
