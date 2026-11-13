import { describe, it, expect } from 'vitest';
import type { RunCheckpointEstimate, RunCheckpointTaken } from '@sandforge/shared';

import {
  API_BUDGET_EXCEEDED,
  CHECKPOINT_REFUSED,
  CHECKPOINT_STOPPED_WORDS,
  ForgeRunGateError,
  checkpointPartOf,
  checkpointScopeStop,
  forgeRequestPartsOf,
  forgeWriteBudgetOf,
  takeCheckpointFirst,
  writePlanOf,
} from './ForgeRunGate.js';
import { RUN_CANCELLED } from './forgeAudit.js';

/** `n` rows of an object, as the run holds them. */
const rows = (n: number): Record<string, unknown>[] =>
  Array.from({ length: n }, (_, i) => ({ Id: `row-${i}` }));

/** What a checkpoint first would cost, as its scope estimates it at the gate. */
function estimateOf(
  apiRequests: number,
  refusal?: RunCheckpointEstimate['refusal'],
): RunCheckpointEstimate {
  return {
    state: 'planned',
    estimate: { records: 38, apiRequests, apiRequestsLeft: 14_000, seconds: 44, bytes: 2_200_000 },
    objects: ['Contact', 'Account', 'Task'],
    added: [
      {
        objectApiName: 'Task',
        reason: "The target's flow 'Welcome task' creates Task records as Contact records go in.",
      },
    ],
    notHeld: [],
    keepDays: 7,
    ...(refusal ? { refusal } : {}),
  };
}

/** The checkpoint a take kept, as the run names it. */
const TAKEN: RunCheckpointTaken = {
  state: 'taken',
  checkpointId: 'ck-20261101-101540-a1b2',
  name: 'Before Forge run 2026-11-01 10:15 UTC',
  takenAt: '2026-11-01T10:15:40.000Z',
  expiresAt: '2026-11-08T10:15:40.000Z',
  objects: ['Contact', 'Account', 'Task'],
  records: 38,
  bytes: 2_100_000,
  requests: 66,
  added: [],
  notHeld: [],
};

// 400 contacts and 200 accounts: two REST calls and one.
const plan = writePlanOf([
  { objectApiName: 'Contact', rows: rows(400) },
  { objectApiName: 'Account', rows: rows(200) },
]);

describe('the parts of a Forge run’s API requests at its write gate', () => {
  it('counts a REST call per 200 rows, again for the objects its second pass updates, then the checkpoint and the read-backs', () => {
    expect(forgeRequestPartsOf({ plan })).toEqual({ run: 3 });
    expect(forgeRequestPartsOf({ plan, updatedAfterInsert: ['Contact'] })).toEqual({ run: 5 });
    expect(
      forgeRequestPartsOf({
        plan,
        readBack: 2,
        checkpoint: estimateOf(68),
        updatedAfterInsert: [],
      }),
    ).toEqual({ run: 3, checkpoint: 68, readBack: 2 });
    // A dry run reads none back, and a run that takes no checkpoint has no such part.
    expect(forgeRequestPartsOf({ plan, readBack: 0 })).toEqual({ run: 3 });
    expect(checkpointPartOf(undefined)).toEqual({});
  });

  it('counts in the calls of their object the rows the write links by a value the target holds: sent, though they create nothing', () => {
    // 200 contacts to create, 1 linked by its value: two calls, as sent.
    const linked = writePlanOf([
      {
        objectApiName: 'Contact',
        rows: rows(200),
        leftOut: { linkedByValue: { rows: 1, fields: ['Ext_Id__c'] } },
      },
      {
        objectApiName: 'Lead',
        rows: [],
        leftOut: { linkedByValue: { rows: 3, fields: ['Key__c'] } },
      },
    ]);

    expect(linked.totalRows).toBe(200);
    expect(forgeRequestPartsOf({ plan: linked })).toEqual({ run: 3 });
  });

  it('counts what the read of the target’s deliverability sent, a part of its own, and nothing when it sent none', () => {
    expect(forgeRequestPartsOf({ plan, deliverability: 2 })).toEqual({ run: 3, deliverability: 2 });
    expect(forgeRequestPartsOf({ plan, deliverability: 0 })).toEqual({ run: 3 });
  });

  it('counts the lease of the mute the run holds, a part of its own named after the checkpoint’s, and nothing for none', () => {
    expect(forgeRequestPartsOf({ plan, mute: 7 })).toEqual({ run: 3, mute: 7 });
    expect(forgeRequestPartsOf({ plan, mute: 0 })).toEqual({ run: 3 });
    const stop = forgeWriteBudgetOf({
      plan,
      checkpoint: estimateOf(68),
      mute: 7,
      readBack: 2,
      budget: { max: 500, remaining: 4 },
      target: 'TGT',
    });
    expect(stop.api).toMatchObject({ verdict: 'exceeds', estimate: 3 + 68 + 7 + 2 });
    expect(stop.stop?.message).toContain(
      "68 of them for the checkpoint taken first, 7 to assign and take back the permission sets that mute the target's automation, 2 to read back the record types the target gave",
    );
  });

  it('refuses a run the read of its deliverability takes past what the target has left, naming the part', () => {
    const stop = forgeWriteBudgetOf({
      plan,
      deliverability: 2,
      budget: { max: 500, remaining: 4 },
      target: 'TGT',
    });

    expect(stop.api).toMatchObject({ verdict: 'exceeds', estimate: 5 });
    expect(stop.stop?.message).toContain(
      '2 of them to read whether the target delivers its emails',
    );
  });
});

describe('forgeWriteBudgetOf', () => {
  it('lets the run through with its requests and the checkpoint’s exactly what the target has left, and refuses one more, naming both parts', () => {
    // 3 for the rows, 68 for the checkpoint, 2 to read back: 73.
    const input = { plan, readBack: 2, checkpoint: estimateOf(68), target: 'DEV-SB' };

    const fits = forgeWriteBudgetOf({ ...input, budget: { max: 500, remaining: 73 } });
    expect(fits.api).toMatchObject({ verdict: 'near', estimate: 73 });
    expect(fits.stop).toBeUndefined();

    const over = forgeWriteBudgetOf({ ...input, budget: { max: 500, remaining: 72 } });
    expect(over.stop?.code).toBe(API_BUDGET_EXCEEDED);
    expect(over.stop?.message).toMatch(
      /^The run takes about 73 API requests \(68 of them for the checkpoint taken first, 2 to read back the record types the target gave\), and DEV-SB has 72 of its 500 daily requests left/,
    );
    expect(over.stop?.message).toMatch(/Nothing was written\.$/);
  });

  it('judges "near" on the sum, and the question says the parts and the checkpoint', () => {
    // 1 550 left of 15 000: the rows' 3 leave 1 547; with the checkpoint's 90, 1 457.
    const alone = forgeWriteBudgetOf({
      plan,
      budget: { max: 15_000, remaining: 1_550 },
      target: 'DEV-SB',
    });
    expect(alone.api.verdict).toBe('fits');
    expect(alone.confirmation).toEqual({});
    expect(alone.asks).toBe(false);

    const checkpoint = estimateOf(90);
    const first = forgeWriteBudgetOf({
      plan,
      checkpoint,
      budget: { max: 15_000, remaining: 1_550 },
      target: 'DEV-SB',
    });
    expect(first.api.verdict).toBe('near');
    expect(first.confirmation).toEqual({
      apiRequests: {
        estimate: 93,
        remaining: 1_550,
        max: 15_000,
        parts: { run: 3, checkpoint: 90 },
      },
      checkpoint,
    });
  });

  it('asks whenever a checkpoint is taken first, whose cost is the target’s tables', () => {
    const budget = forgeWriteBudgetOf({
      plan,
      checkpoint: estimateOf(5),
      budget: { max: 15_000, remaining: 15_000 },
      target: 'DEV-SB',
    });
    expect(budget.asks).toBe(true);
    expect(budget.stop).toBeUndefined();
    expect(budget.confirmation.checkpoint?.objects).toEqual(['Contact', 'Account', 'Task']);
  });

  it('refuses for the checkpoint’s own refusal before the budget, whatever the requests', () => {
    const refusal = {
      code: 'DISK' as const,
      message:
        'The checkpoint before the run takes about 2.1 MB on this machine, and its disk has ' +
        '0.5 MB free, less than that and a tenth more: make room, or leave objects out of the ' +
        'checkpoint. No record was read.',
    };
    const budget = forgeWriteBudgetOf({
      plan,
      checkpoint: estimateOf(68, refusal),
      budget: { max: 500, remaining: 1 },
      target: 'DEV-SB',
    });
    expect(budget.stop).toEqual({
      code: CHECKPOINT_REFUSED,
      message:
        'The checkpoint before the run was refused: The checkpoint before the run takes about ' +
        '2.1 MB on this machine, and its disk has 0.5 MB free, less than that and a tenth more: ' +
        'make room, or leave objects out of the checkpoint. Nothing was written. Untick ' +
        'Checkpoint first to run without it, or fix what refuses it.',
      refusal,
    });
    expect(checkpointScopeStop(estimateOf(68))).toBeUndefined();
    expect(checkpointScopeStop(undefined)).toBeUndefined();
  });

  it('reads the budget the target would not say as not known, never as enough', () => {
    const budget = forgeWriteBudgetOf({
      plan,
      checkpoint: estimateOf(68),
      budget: { unread: 'INSUFFICIENT_ACCESS' },
      target: 'DEV-SB',
    });
    expect(budget.api).toEqual({
      verdict: 'unread',
      estimate: 71,
      unread: 'INSUFFICIENT_ACCESS',
      parts: { run: 3, checkpoint: 68 },
    });
    expect(budget.stop).toBeUndefined();
  });
});

describe('ForgeRunGateError, past the budget or for the checkpoint', () => {
  it('tells the page the code, for it to say why the run was refused', () => {
    expect(new ForgeRunGateError(API_BUDGET_EXCEEDED, 'past the day').stop).toEqual({
      code: API_BUDGET_EXCEEDED,
    });
    expect(new ForgeRunGateError(CHECKPOINT_REFUSED, 'refused').stop).toEqual({
      code: CHECKPOINT_REFUSED,
    });
    expect(new ForgeRunGateError('WRITE_DECLINED', 'cancelled').stop).toEqual({
      code: 'WRITE_DECLINED',
    });
  });

  it('tells the page nothing of a code of the command line’s own', () => {
    expect(new ForgeRunGateError('AUTOMATION_NOT_ACCEPTED', 'not accepted').stop).toBeUndefined();
  });

  it('tells the page what refused the checkpoint taken first, by its code, from the gate’s stop', async () => {
    const refusal = {
      code: 'DISK' as const,
      message: 'The disk has 1.0 MB free. No record was read.',
    };
    const atTheGate = forgeWriteBudgetOf({
      plan,
      checkpoint: estimateOf(68, refusal),
      budget: { max: 15_000, remaining: 14_000 },
      target: 'DEV-SB',
    }).stop;
    expect(atTheGate).toBeDefined();
    const scoped = ForgeRunGateError.of(atTheGate!);
    expect(scoped.stop).toEqual({ code: CHECKPOINT_REFUSED, reason: 'DISK' });
    expect(scoped.message).toBe(atTheGate!.message);

    const took = await takeCheckpointFirst(async () => ({
      taken: false,
      refusal: { code: 'RUN_WRITING', message: 'A Sync run is writing to DEV-SB.' },
    }));
    expect(
      'stop' in took && ForgeRunGateError.of({ ...took.stop, code: CHECKPOINT_REFUSED }).stop,
    ).toEqual({ code: CHECKPOINT_REFUSED, reason: 'RUN_WRITING' });
  });

  it('names no reason for a take that failed, nor past the budget', async () => {
    const failed = await takeCheckpointFirst(async () => {
      throw new Error('socket hang up');
    });
    expect(
      'stop' in failed && ForgeRunGateError.of({ ...failed.stop, code: CHECKPOINT_REFUSED }).stop,
    ).toEqual({ code: CHECKPOINT_REFUSED });
    const over = forgeWriteBudgetOf({
      plan,
      checkpoint: estimateOf(68),
      budget: { max: 500, remaining: 1 },
      target: 'DEV-SB',
    }).stop;
    expect(ForgeRunGateError.of(over!).stop).toEqual({ code: API_BUDGET_EXCEEDED });
  });
});

describe('takeCheckpointFirst', () => {
  it('answers the checkpoint the take kept', async () => {
    expect(await takeCheckpointFirst(async () => ({ taken: true, checkpoint: TAKEN }))).toEqual({
      checkpoint: TAKEN,
    });
  });

  it('stops the run for a take refused, with the take’s own refusal and its words', async () => {
    const refusal = {
      code: 'RUN_WRITING' as const,
      message: 'A Sync run is writing to DEV-SB. No record was read.',
    };
    expect(await takeCheckpointFirst(async () => ({ taken: false, refusal }))).toEqual({
      stop: {
        code: CHECKPOINT_REFUSED,
        message:
          'The checkpoint before the run was refused: A Sync run is writing to DEV-SB. Nothing ' +
          'was written. Untick Checkpoint first to run without it, or fix what refuses it.',
        refusal,
      },
    });
  });

  it('stops the run for a take that failed, and under the cancel’s code for one its Stop ended', async () => {
    expect(
      await takeCheckpointFirst(async () => {
        throw new Error('socket hang up');
      }),
    ).toEqual({
      stop: {
        code: CHECKPOINT_REFUSED,
        message:
          'The checkpoint before the run could not be taken: socket hang up. Nothing was written.',
      },
    });
    expect(await takeCheckpointFirst(async () => ({ taken: false, stopped: true }))).toEqual({
      stop: { code: RUN_CANCELLED, message: CHECKPOINT_STOPPED_WORDS },
    });
  });
});
