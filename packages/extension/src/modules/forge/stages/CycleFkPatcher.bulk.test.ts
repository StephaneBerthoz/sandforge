import { afterEach, describe, expect, it, vi } from 'vitest';
import { patchCycleFkUpdates, type CycleFkPatchInput } from './CycleFkPatcher.js';
import { IdRemapper } from '../IdRemapper.js';
import type { PendingFkUpdate } from './BatchWriter.js';
import type { ForgeExecutorDeps, ForgeProgressEvent, UpdateResult } from '../ForgeExecutor.js';
import { limitSplitting, type CallKey } from '../../../core/common/governorLimit.js';
import { toSaveOutcome } from '../../../core/common/existingRecordMatch.js';
import { BulkJobLostError, type BulkRowState, type BulkWriteAnswer } from '../forgeBulkWrite.js';
import { logger } from '../../../logger.js';

/*
 * The second pass of a run that writes through the Bulk API: an object's
 * updates sent as jobs from 2 000 of them, what a job could not answer for
 * itself sent by REST, and what its chunks of 200 were refused for a limit of
 * the target's automation sent again smaller, out of the run's allowance.
 */

type UpdateRecordsFn = NonNullable<ForgeExecutorDeps['updateRecords']>;
type BulkUpdateFn = NonNullable<CycleFkPatchInput['bulkUpdate']>;

afterEach(() => {
  vi.restoreAllMocks();
});

function makeInput(overrides?: Partial<CycleFkPatchInput>): CycleFkPatchInput {
  return {
    pendingFkUpdates: [],
    remapper: new IdRemapper(),
    updateRecords: takingEvery(),
    targetOrgId: 'tgt',
    enabled: true,
    onProgress: vi.fn<(e: ForgeProgressEvent) => void>(),
    ...overrides,
  };
}

/** `n` accounts owing their parent, the parents cloned: every lookup resolvable. */
function owing(n: number, from = 0): { pending: PendingFkUpdate[]; remapper: IdRemapper } {
  const remapper = new IdRemapper();
  const pending: PendingFkUpdate[] = [];
  for (let i = from; i < from + n; i++) {
    const parent = `001PAR${String(i % 3).padStart(9, '0')}`;
    remapper.add(parent, `001TGT${String(i % 3).padStart(9, '0')}`);
    pending.push({
      objectApiName: 'Account',
      newId: `001NEW${String(i).padStart(9, '0')}`,
      sourceId: `001OLD${String(i).padStart(9, '0')}`,
      fieldName: 'ParentId',
      sourceRefId: parent,
    });
  }
  return { pending, remapper };
}

const taken = (record: Record<string, unknown>): UpdateResult => ({
  id: String(record['Id']),
  success: true,
  errors: [],
});

/** The target's REST updates: every one taken, or answered as `answer` says for a call of that many. */
function takingEvery(answer?: (call: number) => UpdateResult | undefined) {
  return vi
    .fn<UpdateRecordsFn>()
    .mockImplementation(async (_org, _object, records) =>
      records.map((record) => answer?.(records.length) ?? taken(record)),
    );
}

/** The answer of a job that took every update it was sent. */
function allTaken(records: readonly Record<string, unknown>[]): BulkWriteAnswer {
  return {
    answers: records.map(taken),
    rows: records.map((): BulkRowState => 'answered'),
    unmatchedIds: [],
    requests: 12,
  };
}

const LOCK: UpdateResult = {
  id: '',
  success: false,
  errors: ['UNABLE_TO_LOCK_ROW: unable to obtain exclusive access to this record'],
  errorDetails: [
    { statusCode: 'UNABLE_TO_LOCK_ROW', message: 'unable to obtain exclusive access', fields: [] },
  ],
};

describe('patchCycleFkUpdates — updates sent as Bulk API jobs', () => {
  it('sends an object owing 2 000 updates or more as jobs, sorted by the value each sets, and marks what they took', async () => {
    const { pending, remapper } = owing(2_100);
    const bulkUpdate = vi.fn<BulkUpdateFn>().mockImplementation(async (_o, r) => allTaken(r));
    const onPatched = vi.fn();
    const onAnswered = vi.fn();
    const input = makeInput({
      pendingFkUpdates: pending,
      remapper,
      bulkUpdate,
      onPatched,
      onAnswered,
    });

    const error = await patchCycleFkUpdates(input);

    expect(error).toBeNull();
    expect(input.updateRecords).not.toHaveBeenCalled();
    expect(bulkUpdate).toHaveBeenCalledTimes(1);
    const [object, sent] = bulkUpdate.mock.calls[0];
    expect(object).toBe('Account');
    expect(sent).toHaveLength(2_100);
    const values = sent.map((r) => String(r['ParentId']));
    expect(values).toEqual([...values].sort());
    expect(onPatched).toHaveBeenCalledTimes(2_100);
    expect(onAnswered).toHaveBeenCalledTimes(1);
  });

  it('updates by REST under 2 000 updates, and an object a duplicate rule watches whatever their number', async () => {
    const few = owing(1_999);
    const bulkUpdate = vi.fn<BulkUpdateFn>().mockImplementation(async (_o, r) => allTaken(r));
    const updateRecords = takingEvery();

    await patchCycleFkUpdates(
      makeInput({
        pendingFkUpdates: few.pending,
        remapper: few.remapper,
        updateRecords,
        bulkUpdate,
      }),
    );
    const many = owing(2_000);
    await patchCycleFkUpdates(
      makeInput({
        pendingFkUpdates: many.pending,
        remapper: many.remapper,
        updateRecords,
        bulkUpdate,
        restOnly: new Set(['Account']),
      }),
    );

    expect(bulkUpdate).not.toHaveBeenCalled();
    expect(updateRecords).toHaveBeenCalledTimes(20);
  });

  it('sends again by REST, three times at most, the updates a job refused for a lock', async () => {
    const { pending, remapper } = owing(2_000);
    const bulkUpdate = vi.fn<BulkUpdateFn>().mockImplementation(async (_o, records) => {
      const answer = allTaken(records);
      answer.answers[0] = LOCK;
      answer.answers[1] = LOCK;
      answer.rows[2] = 'unprocessed';
      return answer;
    });
    // The first record stays locked; the second goes on its second send.
    let sends = 0;
    const updateRecords = vi
      .fn<UpdateRecordsFn>()
      .mockImplementation(async (_org, _object, records) => {
        sends++;
        return records.map((r, i) => (i === 0 || (i === 1 && sends === 1) ? LOCK : taken(r)));
      });
    const wait = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    const error = await patchCycleFkUpdates(
      makeInput({ pendingFkUpdates: pending, remapper, updateRecords, bulkUpdate, wait }),
    );

    expect(updateRecords.mock.calls.map((c) => c[2].length)).toEqual([3, 2, 1]);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(error).toMatchObject({ objectApiName: '__pass2__', failedCount: 1 });
  });

  it('updates by REST what a job wrote nothing of, and counts as left empty what a lost job may have written', async () => {
    const { pending, remapper } = owing(2_000);
    const updateRecords = takingEvery();

    await patchCycleFkUpdates(
      makeInput({
        pendingFkUpdates: pending,
        remapper,
        updateRecords,
        bulkUpdate: vi.fn<BulkUpdateFn>().mockResolvedValue({
          answers: [],
          rows: [],
          unmatchedIds: [],
          untouched: { reason: 'InvalidEntity', unsupported: true },
          requests: 1,
        }),
      }),
    );
    expect(updateRecords).toHaveBeenCalledTimes(10);

    const lost = await patchCycleFkUpdates(
      makeInput({
        pendingFkUpdates: pending,
        remapper,
        updateRecords,
        bulkUpdate: vi
          .fn<BulkUpdateFn>()
          .mockRejectedValue(new BulkJobLostError('750JOB', 'socket hang up')),
      }),
    );
    expect(lost).toMatchObject({ failedCount: 2_000 });
    expect(lost?.samples[0].messages).toContainEqual(expect.stringContaining('socket hang up'));
  });

  it('updates by REST what a job that threw before the org held anything of it was to update', async () => {
    const { pending, remapper } = owing(2_000);
    const updateRecords = takingEvery();
    const onPatched = vi.fn();

    const error = await patchCycleFkUpdates(
      makeInput({
        pendingFkUpdates: pending,
        remapper,
        updateRecords,
        onPatched,
        bulkUpdate: vi.fn<BulkUpdateFn>().mockRejectedValue(new Error('no connection')),
      }),
    );

    expect(error).toBeNull();
    expect(updateRecords).toHaveBeenCalledTimes(10);
    expect(onPatched).toHaveBeenCalledTimes(2_000);
  });

  it('sends no job of an object the run heard the Bulk API does not update, and tells the run of one it hears so', async () => {
    const updateRecords = takingEvery();
    const bulkUpdate = vi.fn<BulkUpdateFn>().mockResolvedValue({
      answers: [],
      rows: [],
      unmatchedIds: [],
      untouched: { reason: 'InvalidEntity', unsupported: true },
      requests: 1,
    });
    const bulkUnsupported = new Set<string>();

    // Two nodes' passes of one run: the second sends no job of the object.
    for (let node = 0; node < 2; node++) {
      const { pending, remapper } = owing(2_000);
      await patchCycleFkUpdates(
        makeInput({
          pendingFkUpdates: pending,
          remapper,
          updateRecords,
          bulkUpdate,
          bulkUnsupported,
        }),
      );
    }

    expect(bulkUpdate).toHaveBeenCalledTimes(1);
    expect(bulkUnsupported.has('Account')).toBe(true);
    expect(updateRecords).toHaveBeenCalledTimes(20);
  });

  it('counts as not sent the updates of a job the cancel aborted, and sends nothing after it', async () => {
    const { pending, remapper } = owing(12_000);
    const updateRecords = takingEvery();
    const bulkUpdate = vi.fn<BulkUpdateFn>().mockResolvedValue({
      answers: [],
      rows: [],
      unmatchedIds: [],
      aborted: true,
      requests: 2,
    });

    const error = await patchCycleFkUpdates(
      makeInput({ pendingFkUpdates: pending, remapper, updateRecords, bulkUpdate }),
    );

    expect(bulkUpdate).toHaveBeenCalledTimes(1);
    expect(updateRecords).not.toHaveBeenCalled();
    expect(error).toMatchObject({ failedCount: 12_000 });
    expect(error?.samples[0].recordSummary).toContain('12000 lookups not sent');
  });
});

describe('patchCycleFkUpdates — a job whose chunk the target’s automation refused for a Salesforce limit', () => {
  const UPDATE: CallKey = { objectApiName: 'Account', op: 'update' };

  /** What a trigger that runs a query per record answers a row of a call, or a chunk, too large for it. */
  const LIMIT_MESSAGE = 'Account_Trigger: System.LimitException: Too many SOQL queries: 101';
  const limited = (): UpdateResult =>
    toSaveOutcome(
      {
        success: false,
        errors: [
          {
            statusCode: 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY',
            message: LIMIT_MESSAGE,
            fields: [],
          },
        ],
      },
      'Account',
    );

  /** Jobs the first of which has its first chunk refused for a limit, every one after taken whole. */
  function jobs() {
    return vi
      .fn<BulkUpdateFn>()
      .mockImplementationOnce(async (_o, records) => {
        const answer = allTaken(records);
        for (let i = 0; i < 200; i++) answer.answers[i] = limited();
        return answer;
      })
      .mockImplementation(async (_o, records) => allTaken(records));
  }

  /** REST updates, the trigger refusing for a limit every row of a call of more than 100. */
  const refusingOver = (max: number) => takingEvery((call) => (call > max ? limited() : undefined));

  it('sends them again by REST, a record on its own then halves of 100, never at 200, out of the run’s allowance', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const splitting = limitSplitting();
    const { pending, remapper } = owing(2_000);
    const updateRecords = refusingOver(100);
    const onPatched = vi.fn();

    const error = await patchCycleFkUpdates(
      makeInput({
        pendingFkUpdates: pending,
        remapper,
        updateRecords,
        bulkUpdate: jobs(),
        splitting,
        onPatched,
      }),
    );

    expect(error).toBeNull();
    expect(updateRecords.mock.calls.map((c) => c[2].length)).toEqual([1, 100, 99]);
    expect(onPatched).toHaveBeenCalledTimes(2_000);
    expect(splitting.allowance.spent).toBe(3);
    expect(splitting.sizes.report(UPDATE)).toMatchObject({ from: 200, to: 100 });
  });

  it('sends the next job of the object by REST at the size kept, each call paid against the job, and what the allowance does not pay for as a job', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    // Three smaller calls for the first pass, seven for the next.
    const splitting = limitSplitting(10);
    const bulkUpdate = jobs();
    const updateRecords = refusingOver(100);
    const first = owing(2_000);
    await patchCycleFkUpdates(
      makeInput({
        pendingFkUpdates: first.pending,
        remapper: first.remapper,
        updateRecords,
        bulkUpdate,
        splitting,
      }),
    );
    updateRecords.mockClear();

    const next = owing(3_200, 2_000);
    const error = await patchCycleFkUpdates(
      makeInput({
        pendingFkUpdates: next.pending,
        remapper: next.remapper,
        updateRecords,
        bulkUpdate,
        splitting,
      }),
    );

    expect(error).toBeNull();
    expect(updateRecords.mock.calls.map((c) => c[2].length)).toEqual([
      100, 100, 100, 100, 100, 100, 100,
    ]);
    expect(bulkUpdate.mock.calls.map((c) => c[1].length)).toEqual([2_000, 2_500]);
    expect(splitting.allowance.spent).toBe(10);
    expect(splitting.sizes.isSpent(UPDATE)).toBe(true);
  });

  it('leaves them refused as the org refused them in a pass handed no allowance, as Seed’s, sending nothing by REST', async () => {
    const { pending, remapper } = owing(2_000);
    const updateRecords = refusingOver(100);

    const error = await patchCycleFkUpdates(
      makeInput({ pendingFkUpdates: pending, remapper, updateRecords, bulkUpdate: jobs() }),
    );

    expect(updateRecords).not.toHaveBeenCalled();
    expect(error).toMatchObject({ failedCount: 200 });
    expect(error?.samples[0].messages).toEqual([
      `CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: ${LIMIT_MESSAGE}`,
    ]);
  });
});
