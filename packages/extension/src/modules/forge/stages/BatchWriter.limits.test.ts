import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BatchWriter,
  emptyBatchWriteResult,
  type InsertCallJournal,
  type WriteNodeInput,
} from './BatchWriter.js';
import {
  GOVERNOR_LIMIT_ALONE,
  GOVERNOR_LIMIT_KEPT_WHOLE,
  limitSplitting,
  type CallKey,
} from '../../../core/common/governorLimit.js';
import { toSaveOutcome } from '../../../core/common/existingRecordMatch.js';
import { IdRemapper } from '../IdRemapper.js';
import { logger } from '../../../logger.js';
import type { ForgeExecutorDeps, ForgeProgressEvent, InsertResult } from '../ForgeExecutor.js';
import type { ForgeGraphNode } from '@sandforge/shared';

/*
 * A call the target's automation refuses for a Salesforce limit, written
 * again in smaller calls. Each refusal below is what a trap org answered an
 * insert of 200 whose trigger ran a query per record: every row refused,
 * nothing written, under the same code and words.
 */

type InsertImpl = ForgeExecutorDeps['insertRecords'];

const OBJECT = 'Ledger__c';
const INSERT: CallKey = { objectApiName: OBJECT, op: 'insert' };

/** The trigger's refusal of a row of a call too large for it, as the trap org wrote it. */
const LIMIT_MESSAGE = 'Ledger_Trigger: System.LimitException: Too many SOQL queries: 101';

/** What a trap org answered a row whose trigger looped past the CPU limit. */
const CPU_MESSAGE = 'Ledger_Trigger: System.LimitException: Apex CPU time limit exceeded';

/** A row of a call the trigger refused, as the REST writers hand it on. */
function limited(message = LIMIT_MESSAGE): InsertResult {
  return toSaveOutcome(
    {
      success: false,
      errors: [{ statusCode: 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY', message, fields: [] }],
    },
    OBJECT,
  );
}

const LOCK: InsertResult = {
  id: '',
  success: false,
  errors: ['UNABLE_TO_LOCK_ROW: unable to obtain exclusive access to this record'],
};

/** The words of the rule that refuses a phone, as the target would give them. */
const RULE = 'Enter the phone in international format';

const byRule = (): InsertResult =>
  toSaveOutcome(
    {
      success: false,
      errors: [
        { statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: RULE, fields: ['Phone'] },
      ],
    },
    OBJECT,
  );

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
function ledgers(n: number, extra: Record<string, unknown> = {}): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    Id: `a0BOLD${String(i).padStart(9, '0')}`,
    Name: `P${i}`,
    ...extra,
  }));
}

function makeNode(recordCount: number): ForgeGraphNode {
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
    batchStrategy: 'rest',
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
      { name: 'Phone', queryable: true, createable: true, isReference: false },
    ],
    creatableFields: new Set(['Name', 'Phone']),
    upsertMode: 'off',
    targetOrgId: 'tgt',
    remapper: new IdRemapper(),
    waitIfPaused: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    onProgress: vi.fn<(e: ForgeProgressEvent) => void>(),
    ...overrides,
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

const namesSent = (insertRecords: InsertImpl): unknown[][] =>
  vi.mocked(insertRecords).mock.calls.map((call) => call[2].map((row) => row['Name']));

const noWait = (): Promise<void> => Promise.resolve();

describe('BatchWriter — a call the target’s automation refused for a Salesforce limit', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes the rows again, a record on its own then in calls half as large, each call journaled and closed, and the next batch at the size that went through', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const insertRecords = vi.fn<InsertImpl>(refusingCallsOver(50));
    const calls = journal();
    const splitting = limitSplitting();
    const input = makeInput(ledgers(400), { calls });

    const result = await new BatchWriter({ insertRecords }, undefined, noWait, splitting).writeNode(
      input,
    );

    // A call of 200 refused; a record on its own; 100 and 99, each refused
    // and halved; then the next batch at 50 at once.
    expect(sizesSent(insertRecords)).toEqual([200, 1, 100, 50, 50, 99, 50, 49, 50, 50, 50, 50]);
    expect(calls.sizes).toEqual(sizesSent(insertRecords));
    expect(calls.closed).toEqual(calls.sizes.map((_, i) => `call-${i + 1}`));
    expect(result).toMatchObject({ successCount: 400, failureCount: 0, errorSamples: [] });
    // Each answer paired with its own row, through every smaller call.
    for (let i = 0; i < 400; i++) {
      expect(input.remapper.get(`a0BOLD${String(i).padStart(9, '0')}`)).toBe(`a0BNEW-P${i}`);
    }
    expect(splitting.sizes.report(INSERT)).toEqual({
      objectApiName: OBJECT,
      op: 'insert',
      from: 200,
      to: 50,
      rows: 400,
      // A record on its own, 2 + 2 + 2 calls sending refused rows again, 3
      // more than calls of 200 for the next batch.
      extraCalls: 10,
      limit: 'Too many SOQL queries',
      automation: 'Ledger_Trigger',
      alone: 0,
      notSplit: 0,
      keptWhole: 0,
      wholeAlone: false,
      spent: false,
    });
    expect(splitting.allowance.spent).toBe(10);
    // Said once for the object, the first time.
    const said = warn.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes('hit'));
    expect(said).toEqual([
      `[forge] ${OBJECT}: Ledger_Trigger hit Too many SOQL queries on a call of 200 — sending a record on its own, then smaller calls.`,
    ]);
  });

  it('keeps an object it never refused at 200, beside one it did', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const splitting = limitSplitting();
    const insertRecords = vi.fn<InsertImpl>(async (_org, object, rows) =>
      object === OBJECT && rows.length > 50
        ? rows.map(() => limited())
        : rows.map((row) => ({ id: idOf(row), success: true, errors: [] })),
    );
    const writer = new BatchWriter({ insertRecords }, undefined, noWait, splitting);

    await writer.writeNode(makeInput(ledgers(200)));
    await writer.writeNode(
      makeInput(ledgers(200), { node: { ...makeNode(200), objectApiName: 'Other__c' } }),
    );

    expect(sizesSent(insertRecords).slice(-1)).toEqual([200]);
    expect(splitting.sizes.of({ objectApiName: 'Other__c', op: 'insert' })).toBe(200);
  });

  it('fails a row the trigger refuses sent on its own, saying what to fix', async () => {
    const insertRecords = vi.fn<InsertImpl>(refusingCallsOver(0));

    const result = await new BatchWriter({ insertRecords }).writeNode(makeInput(ledgers(1)));

    expect(sizesSent(insertRecords)).toEqual([1]);
    expect(result.failureCount).toBe(1);
    expect(result.errorSamples).toHaveLength(1);
    expect(result.errorSamples[0].messages).toEqual([
      `CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: ${LIMIT_MESSAGE}`,
      GOVERNOR_LIMIT_ALONE,
    ]);
  });

  it('leaves the rows whole once two records sent on their own are refused, as a record past the CPU limit alone is', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const insertRecords = vi.fn<InsertImpl>(async (_org, _object, rows) =>
      rows.map(() => limited(CPU_MESSAGE)),
    );
    const splitting = limitSplitting();

    const result = await new BatchWriter({ insertRecords }, undefined, noWait, splitting).writeNode(
      makeInput(ledgers(400)),
    );

    // Halved down to one record each, 400 of them would have cost some 800 calls.
    expect(sizesSent(insertRecords)).toEqual([200, 1, 1, 200]);
    expect(result).toMatchObject({ successCount: 0, failureCount: 400 });
    expect(result.errorSamples.map((sample) => sample.messages.at(-1))).toEqual([
      GOVERNOR_LIMIT_ALONE,
      GOVERNOR_LIMIT_ALONE,
      GOVERNOR_LIMIT_KEPT_WHOLE,
    ]);
    expect(splitting.sizes.report(INSERT)).toMatchObject({
      alone: 2,
      keptWhole: 398,
      wholeAlone: true,
      extraCalls: 2,
      limit: 'Apex CPU time limit exceeded',
    });
  });

  it('writes the record sent beside one past the CPU limit, and fails that one alone', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const insertRecords = vi.fn<InsertImpl>(async (_org, _object, rows) =>
      rows.some((row) => row['Name'] === 'P0')
        ? rows.map(() => limited(CPU_MESSAGE))
        : rows.map((row) => ({ id: idOf(row), success: true, errors: [] })),
    );

    const result = await new BatchWriter({ insertRecords }).writeNode(makeInput(ledgers(2)));

    expect(namesSent(insertRecords)).toEqual([['P0', 'P1'], ['P0'], ['P1']]);
    expect(result).toMatchObject({ successCount: 1, failureCount: 1 });
    expect(result.errorSamples[0].messages).toEqual([
      `CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: ${CPU_MESSAGE}`,
      GOVERNOR_LIMIT_ALONE,
    ]);
  });

  it('fails the rows the allowance does not pay smaller calls for, saying so, and goes back to calls of 200', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const insertRecords = vi.fn<InsertImpl>(refusingCallsOver(50));
    const splitting = limitSplitting(2);

    const result = await new BatchWriter({ insertRecords }, undefined, noWait, splitting).writeNode(
      makeInput(ledgers(400)),
    );

    // A record on its own and a call of 100 paid, the 100 refused in turn;
    // the 99 left not sent again; the next batch at 200.
    expect(sizesSent(insertRecords)).toEqual([200, 1, 100, 200]);
    expect(result).toMatchObject({ successCount: 1, failureCount: 399 });
    expect(result.errorSamples[0].messages).toEqual([
      `CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: ${LIMIT_MESSAGE}`,
      'Not sent in smaller calls: the run had spent the 2 smaller calls it allows itself.',
    ]);
    expect(splitting.sizes.report(INSERT)).toMatchObject({
      notSplit: 399,
      spent: true,
      extraCalls: 2,
    });
    expect(splitting.sizes.of(INSERT)).toBe(200);
  });

  it('fails every row a limit refused when the run is allowed no smaller call, writing none of them twice', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const insertRecords = vi.fn<InsertImpl>(refusingCallsOver(50));

    const result = await new BatchWriter(
      { insertRecords },
      undefined,
      noWait,
      limitSplitting(0),
    ).writeNode(makeInput(ledgers(200)));

    expect(sizesSent(insertRecords)).toEqual([200]);
    expect(result).toMatchObject({ successCount: 0, failureCount: 200 });
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

    const result = await new BatchWriter({ insertRecords }, undefined, wait).writeNode(
      makeInput(ledgers(4)),
    );

    expect(namesSent(insertRecords)).toEqual([
      ['P0', 'P1', 'P2', 'P3'],
      ['P1'],
      ['P2', 'P3'],
      ['P0'],
    ]);
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

    const result = await new BatchWriter({ insertRecords }, undefined, wait).writeNode(
      makeInput(ledgers(2)),
    );

    // The first write; the first send again, a record on its own then the
    // other; two more, one row a call.
    expect(sizesSent(insertRecords)).toEqual([2, 2, 1, 1, 1, 1, 1, 1]);
    expect(wait).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ successCount: 0, failureCount: 2 });
    expect(result.errorSamples[0].messages).toContain(
      'Sent again 3 times, the target still could not lock a record the write needed.',
    );
  });

  it('keeps the rows it sends again smaller as they were: a refusal on fields keeps its rounds', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    // A row refused for its phone goes again without it, in a round the
    // trigger refuses for a limit: probed, halved, and the last row alone still.
    const insertRecords = vi
      .fn<InsertImpl>()
      .mockImplementationOnce(async (_org, _object, rows) => rows.map(() => byRule()))
      .mockImplementation(
        refusingCallsOver(1, (row) => (row['Name'] === 'P2' ? limited() : undefined)),
      );

    const result = await new BatchWriter({ insertRecords }).writeNode(
      makeInput(ledgers(3, { Phone: '555-0100' })),
    );

    const sent = vi.mocked(insertRecords).mock.calls.map((call) => call[2]);
    expect(namesSent(insertRecords)).toEqual([
      ['P0', 'P1', 'P2'],
      ['P0', 'P1', 'P2'],
      ['P0'],
      ['P1', 'P2'],
      ['P1'],
      ['P2'],
    ]);
    // Sent again smaller, a row goes as its round sent it: without its phone.
    expect(sent.slice(1).every((rows) => rows.every((row) => !('Phone' in row)))).toBe(true);
    expect(result).toMatchObject({ successCount: 2, failureCount: 1 });
    expect(result.writtenWithoutFields?.rows).toBe(2);
    const [sample] = result.errorSamples;
    expect(sample.messages[0]).toBe(`CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: ${LIMIT_MESSAGE}`);
    expect(sample.messages).toContain(GOVERNOR_LIMIT_ALONE);
    expect(sample.messages.some((line) => line.startsWith('Sent again without Phone'))).toBe(true);
  });

  it('leaves the rows waiting to go again smaller the failures the target made them when a cancel comes before their call, each counted once', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const insertRecords = vi
      .fn<InsertImpl>()
      .mockImplementationOnce(async (_org, _object, rows) => rows.map(() => byRule()))
      .mockImplementation(refusingCallsOver(2));
    const cancel = new Error('Execution cancelled');
    const waitIfPaused = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(cancel);
    const tally = emptyBatchWriteResult();
    const input = makeInput(ledgers(4, { Phone: '555-0100' }), { waitIfPaused });

    await expect(new BatchWriter({ insertRecords }).writeNode(input, tally)).rejects.toThrow(
      cancel,
    );

    // The first write, the round refused for a limit; no call after the cancel.
    expect(sizesSent(insertRecords)).toEqual([4, 4]);
    expect(tally).toMatchObject({ successCount: 0, failureCount: 4 });
    expect(tally.errorSamples[0].messages).toContain(
      'Not written again without Phone: Execution cancelled',
    );
  });

  it('counts failed, with the refusal they had, the rows of the first write a cancel kept from going again smaller', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const insertRecords = vi.fn<InsertImpl>(refusingCallsOver(2));
    const cancel = new Error('Execution cancelled');
    const waitIfPaused = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(cancel);
    const tally = emptyBatchWriteResult();
    const input = makeInput(ledgers(6), { waitIfPaused });

    await expect(new BatchWriter({ insertRecords }).writeNode(input, tally)).rejects.toThrow(
      cancel,
    );

    // The call of 6 refused, a record on its own taken; the cancel came
    // before the halves of the 5 others.
    expect(sizesSent(insertRecords)).toEqual([6, 1]);
    expect(tally).toMatchObject({ successCount: 1, failureCount: 5 });
    expect(tally.errorSamples[0].messages).toEqual([
      `CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: ${LIMIT_MESSAGE}`,
      'Not sent again in a smaller call: Execution cancelled',
    ]);
  });

  it('leaves uncounted, as before, the rows of a first call a cancel kept from going', async () => {
    const insertRecords = vi.fn<InsertImpl>(refusingCallsOver(200));
    const cancel = new Error('Execution cancelled');
    const waitIfPaused = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(cancel);
    const tally = emptyBatchWriteResult();

    await expect(
      new BatchWriter({ insertRecords }).writeNode(
        makeInput(ledgers(300), { waitIfPaused }),
        tally,
      ),
    ).rejects.toThrow(cancel);

    expect(sizesSent(insertRecords)).toEqual([200]);
    expect(tally).toMatchObject({ successCount: 200, failureCount: 0 });
  });

  it('stops at a smaller call that may have written, never sending it again, counting the rows waiting to go again and those after them', async () => {
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

    const result = await new BatchWriter({ insertRecords }).writeNode(makeInput(ledgers(400)));

    expect(sizesSent(insertRecords)).toEqual([200, 1]);
    expect(result).toMatchObject({ successCount: 0, failureCount: 400 });
    expect(result.mayHaveBeenWritten).toEqual(['a0BOLD000000000']);
    expect(result.errorSamples[0]).toMatchObject({
      recordSummary: `${OBJECT} batch 1/2: 1 record may have been written`,
    });
    expect(result.errorSamples[0].messages).toContain('399 records after them not sent.');
  });
});
