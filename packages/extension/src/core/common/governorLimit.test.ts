import { limitCauseOf } from '@sandforge/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  ALONE,
  allowedFor,
  BULK_CHUNK,
  CallSizes,
  FULL_CALL_SIZE,
  GOVERNOR_LIMIT_ALONE,
  LIMITED_JOB_REST_SIZE,
  NOT_SPLIT,
  OBJECT_SPLIT_CALLS,
  RUN_SPLIT_CALLS,
  SplitAllowance,
  extraCallsOf,
  governorLimitNotSplit,
  isExtraCall,
  limitNoteText,
  notSplitNote,
  sendSplittingOnLimits,
  smallerCallsNote,
  takeSmallerCalls,
  type CallKey,
  type LimitNote,
  type SplitRun,
} from './governorLimit.js';

/** The message the 116 `Provenance__c` of a real removal were refused with. */
const INCIDENT =
  'DELETE_FAILED: SSC_TRG_Provenance: execution of BeforeDelete\n\ncaused by: System.LimitException: Too many SOQL queries: 101\n\nTrigger.SSC_TRG_Provenance: line 5, column 1';

const PROVENANCE: CallKey = { objectApiName: 'Provenance__c', op: 'delete' };

interface Answer {
  success: boolean;
  errors: string[];
}

const ok: Answer = { success: true, errors: [] };
const limitRefusal: Answer = { success: false, errors: [INCIDENT] };
const otherRefusal: Answer = {
  success: false,
  errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: no'],
};

const ids = (n: number, prefix = 'r'): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`);

interface Harness {
  calls: string[][];
  settled: Array<{ id: string; answer: Answer | undefined; note?: LimitNote }>;
  run: SplitRun<string, Answer>;
}

/**
 * A run on Provenance__c whose org answers each row as `answer` says for a
 * call of that many rows; every call and every settled row is kept.
 */
function harness(
  answer: (id: string, callSize: number) => Answer,
  overrides: Partial<SplitRun<string, Answer>> = {},
): Harness {
  const calls: string[][] = [];
  const settled: Harness['settled'] = [];
  const run: SplitRun<string, Answer> = {
    key: PROVENANCE,
    sizes: new CallSizes(),
    allowance: new SplitAllowance(),
    send: async (part) => {
      calls.push([...part]);
      return { answers: part.map((id) => answer(id, part.length)) };
    },
    limited: (a) => (a && !a.success ? limitCauseOf(a.errors) : undefined),
    settle: (part, answers, again, notes) => {
      part.forEach((id, index) => {
        if (again.has(index)) return;
        const note = notes.get(index);
        settled.push({ id, answer: answers[index], ...(note ? { note } : {}) });
      });
    },
    ...overrides,
  };
  return { calls, settled, run };
}

/** An org whose trigger refuses every call of more than `max` rows for a limit. */
const refusesOver =
  (max: number) =>
  (_id: string, callSize: number): Answer =>
    callSize > max ? limitRefusal : ok;

describe('constants', () => {
  it('bound the splitting as the plan says', () => {
    expect(FULL_CALL_SIZE).toBe(200);
    expect(BULK_CHUNK).toBe(200);
    expect(LIMITED_JOB_REST_SIZE).toBe(100);
    expect(RUN_SPLIT_CALLS).toBe(2000);
    expect(OBJECT_SPLIT_CALLS).toBe(500);
  });
});

describe('CallSizes', () => {
  it('goes at 200 until a limit, then at half the call refused', () => {
    const sizes = new CallSizes();
    expect(sizes.of(PROVENANCE)).toBe(200);
    expect(sizes.refusedAt(PROVENANCE, 116)).toBe(58);
    expect(sizes.of(PROVENANCE)).toBe(58);
  });

  it('halves down to one record, and never under', () => {
    const sizes = new CallSizes();
    const seen: number[] = [];
    let size = 200;
    while (size > 1) {
      size = sizes.refusedAt(PROVENANCE, size);
      seen.push(size);
    }
    expect(seen).toEqual([100, 50, 25, 13, 7, 4, 2, 1]);
    expect(sizes.refusedAt(PROVENANCE, 1)).toBe(1);
  });

  it('never goes back up, even for a larger call refused later', () => {
    const sizes = new CallSizes();
    sizes.refusedAt(PROVENANCE, 100);
    expect(sizes.refusedAt(PROVENANCE, 200)).toBe(50);
    expect(sizes.of(PROVENANCE)).toBe(50);
  });

  it('keeps one size per object and per operation', () => {
    const sizes = new CallSizes();
    sizes.refusedAt(PROVENANCE, 200);
    expect(sizes.of({ objectApiName: 'Provenance__c', op: 'insert' })).toBe(200);
    expect(sizes.of({ objectApiName: 'Account', op: 'delete' })).toBe(200);
    expect(sizes.wasShrunk({ objectApiName: 'Provenance__c', op: 'insert' })).toBe(false);
  });

  it('keeps a spent object off jobs while it goes at 200 again', () => {
    const sizes = new CallSizes();
    expect(sizes.wasShrunk(PROVENANCE)).toBe(false);
    sizes.refusedAt(PROVENANCE, 200);
    expect(sizes.wasShrunk(PROVENANCE)).toBe(true);
    sizes.spend(PROVENANCE);
    expect(sizes.isSpent(PROVENANCE)).toBe(true);
    expect(sizes.of(PROVENANCE)).toBe(200);
    expect(sizes.wasShrunk(PROVENANCE)).toBe(true);
  });

  it('keeps the first refusal’s size, limit and trigger for the notes', () => {
    const sizes = new CallSizes();
    sizes.refusedAt(PROVENANCE, 116, limitCauseOf([INCIDENT]));
    sizes.refusedAt(PROVENANCE, 58, { limit: 'Apex CPU time limit exceeded' });
    sizes.countExtraCalls(PROVENANCE, 2);
    sizes.countSmallCallRows(PROVENANCE, 116);
    expect(sizes.report(PROVENANCE)).toEqual({
      objectApiName: 'Provenance__c',
      op: 'delete',
      from: 116,
      to: 29,
      rows: 116,
      extraCalls: 2,
      limit: 'Too many SOQL queries',
      automation: 'SSC_TRG_Provenance',
      event: 'before delete',
      notSplit: 0,
      spent: false,
    });
    expect(sizes.report({ objectApiName: 'Account', op: 'delete' })).toBeUndefined();
  });

  it('lists the sizes of an operation and is seeded back from them', () => {
    const sizes = new CallSizes();
    sizes.refusedAt(PROVENANCE, 116);
    sizes.refusedAt({ objectApiName: 'Contact', op: 'delete' }, 200);
    sizes.spend({ objectApiName: 'Contact', op: 'delete' });
    sizes.refusedAt({ objectApiName: 'Account', op: 'insert' }, 200);
    const listed = sizes.list('delete');
    expect(listed).toEqual({ Provenance__c: 58, Contact: 100 });

    const seeded = CallSizes.from(listed, 'delete');
    expect(seeded.of(PROVENANCE)).toBe(58);
    expect(seeded.wasShrunk(PROVENANCE)).toBe(true);
    expect(seeded.isSpent({ objectApiName: 'Contact', op: 'delete' })).toBe(false);
    expect(seeded.of({ objectApiName: 'Provenance__c', op: 'insert' })).toBe(200);
    expect(seeded.list('delete')).toEqual(listed);
    expect(seeded.report(PROVENANCE)).toMatchObject({ to: 58, rows: 0, extraCalls: 0 });
    expect(seeded.report(PROVENANCE)?.from).toBeUndefined();
  });

  it('drops a seed that is not a size under 200', () => {
    const seeded = CallSizes.from(
      { A: 0, B: 200, C: 250, D: Number.NaN, E: 12.7, F: -3 },
      'delete',
    );
    expect(seeded.list('delete')).toEqual({ E: 12 });
    expect(CallSizes.from(undefined, 'delete').list('delete')).toEqual({});
  });
});

describe('SplitAllowance', () => {
  it('grants part of what is asked when the run’s allowance does not cover it all', () => {
    const allowance = new SplitAllowance(5);
    expect(allowance.take(PROVENANCE, 3)).toBe(3);
    expect(allowance.take({ objectApiName: 'Account', op: 'insert' }, 4)).toBe(2);
    expect(allowance.take(PROVENANCE, 1)).toBe(0);
    expect(allowance.spent).toBe(5);
  });

  it('grants one object 500 calls at most, whatever its operations', () => {
    const allowance = new SplitAllowance(RUN_SPLIT_CALLS);
    expect(allowance.take(PROVENANCE, 450)).toBe(450);
    expect(allowance.take({ objectApiName: 'Provenance__c', op: 'insert' }, 100)).toBe(50);
    expect(allowance.left(PROVENANCE)).toBe(0);
    expect(allowance.taken(PROVENANCE)).toBe(500);
    expect(allowance.take({ objectApiName: 'Account', op: 'delete' }, 100)).toBe(100);
  });

  it('grants the run 2 000 calls at most, across objects', () => {
    const allowance = new SplitAllowance();
    for (let i = 0; i < 4; i++) {
      expect(allowance.take({ objectApiName: `O${i}`, op: 'delete' }, 500)).toBe(500);
    }
    expect(allowance.take({ objectApiName: 'O4', op: 'delete' }, 1)).toBe(0);
    expect(allowance.spent).toBe(2000);
  });

  it('grants nothing from a nil, negative or unreadable allowance', () => {
    expect(new SplitAllowance(0).take(PROVENANCE, 1)).toBe(0);
    expect(new SplitAllowance(-10).granted).toBe(0);
    expect(new SplitAllowance(Number.NaN).take(PROVENANCE, 1)).toBe(0);
  });
});

describe('takeSmallerCalls', () => {
  it('counts what it granted and spends the key granted fewer than it asked', () => {
    const sizes = new CallSizes();
    sizes.refusedAt(PROVENANCE, 200);
    const allowance = new SplitAllowance(3);
    expect(takeSmallerCalls(sizes, allowance, PROVENANCE, 2)).toBe(2);
    expect(sizes.isSpent(PROVENANCE)).toBe(false);
    expect(takeSmallerCalls(sizes, allowance, PROVENANCE, 2)).toBe(1);
    expect(sizes.isSpent(PROVENANCE)).toBe(true);
    expect(sizes.report(PROVENANCE)?.extraCalls).toBe(3);
    expect(takeSmallerCalls(sizes, new SplitAllowance(), PROVENANCE, 1)).toBe(0);
    expect(takeSmallerCalls(sizes, allowance, PROVENANCE, 0)).toBe(0);
  });
});

describe('extra calls', () => {
  it('count the calls more than calls of 200 would have taken', () => {
    expect(extraCallsOf(400, 100)).toBe(2);
    expect(extraCallsOf(116, 58)).toBe(1);
    expect(extraCallsOf(50_000, 50)).toBe(750);
    expect(extraCallsOf(150, 200)).toBe(0);
    expect(extraCallsOf(0, 50)).toBe(0);
    expect(extraCallsOf(120, 50, 50)).toBe(0);
  });

  it('are paid call by call to what they come to at once', () => {
    for (const [rows, size] of [
      [400, 100],
      [1000, 58],
      [116, 58],
      [199, 1],
      [201, 100],
    ] as const) {
      let paid = 0;
      for (let left = rows; left > 0; left -= size) if (isExtraCall(left, size)) paid++;
      expect(paid).toBe(extraCallsOf(rows, size));
    }
    // The last call never is one more: it holds what is left.
    expect(isExtraCall(100, 100)).toBe(false);
  });
});

describe('allowedFor', () => {
  it('names the object’s share when that ran out first, the run’s otherwise', () => {
    const allowance = new SplitAllowance(2000, 500);
    allowance.take(PROVENANCE, 500);
    expect(allowedFor(allowance, PROVENANCE)).toBe(500);
    const small = new SplitAllowance(10, 500);
    small.take(PROVENANCE, 10);
    expect(allowedFor(small, PROVENANCE)).toBe(10);
    // Nothing to spend: the note says none was allowed, not 500.
    expect(allowedFor(new SplitAllowance(0), PROVENANCE)).toBe(0);
  });
});

describe('notes', () => {
  it('say what happened in engine English', () => {
    expect(GOVERNOR_LIMIT_ALONE).toMatch(/^Sent on its own/);
    expect(governorLimitNotSplit(2000)).toBe(
      'Not sent in smaller calls: the run had spent the 2000 smaller calls it allows itself.',
    );
    expect(limitNoteText(ALONE, 2000)).toBe(GOVERNOR_LIMIT_ALONE);
    // Allowed none — a rewind whose budget leaves nothing past its estimate —
    // it spent nothing: the note says what allowed it none.
    expect(limitNoteText(NOT_SPLIT, 0, 'removal')).toBe(
      'Not sent in smaller calls: what the org has left today allowed the removal none.',
    );
    expect(notSplitNote(116, 0, 'removal')).toBe(
      '116 not sent in smaller calls: what the org has left today allowed the removal none.',
    );
    expect(notSplitNote(58, 1, 'removal')).toBe(
      '58 not sent in smaller calls: the removal had spent the 1 smaller calls it allows itself.',
    );
  });

  it('name the trigger of the incident, or the target’s automation', () => {
    const sizes = new CallSizes();
    sizes.refusedAt(PROVENANCE, 116, limitCauseOf([INCIDENT]));
    sizes.countExtraCalls(PROVENANCE, 2);
    const report = sizes.report(PROVENANCE);
    expect(report && smallerCallsNote(report)).toBe(
      'SSC_TRG_Provenance (before delete) hit Too many SOQL queries on a call of 116: sent 58 at a time, 2 calls more.',
    );
    const unnamed = new CallSizes();
    unnamed.refusedAt(PROVENANCE, 200, { limit: 'Apex CPU time limit exceeded' });
    unnamed.countExtraCalls(PROVENANCE, 1);
    const plain = unnamed.report(PROVENANCE);
    expect(plain && smallerCallsNote(plain)).toBe(
      "The target's automation hit Apex CPU time limit exceeded on a call of 200: sent 100 at a time, 1 call more.",
    );
    const seeded = CallSizes.from({ Provenance__c: 58 }, 'delete').report(PROVENANCE);
    expect(seeded && smallerCallsNote(seeded)).toBe(
      'Sent 58 at a time, the size a limit called for in an earlier removal, 0 calls more.',
    );
  });
});

describe('sendSplittingOnLimits', () => {
  it('sends the incident’s 116 rows as 58 + 58, in 3 calls, all settled', async () => {
    const { calls, settled, run } = harness(refusesOver(100));
    const outcome = await sendSplittingOnLimits(ids(116), run);
    expect(outcome).toEqual({});
    expect(calls.map((call) => call.length)).toEqual([116, 58, 58]);
    expect(settled).toHaveLength(116);
    expect(settled.every((row) => row.answer?.success)).toBe(true);
    expect(settled.map((row) => row.id)).toEqual(ids(116));
    expect(run.sizes.report(PROVENANCE)).toMatchObject({
      from: 116,
      to: 58,
      rows: 116,
      extraCalls: 2,
      automation: 'SSC_TRG_Provenance',
      event: 'before delete',
      notSplit: 0,
    });
    expect(run.allowance.spent).toBe(2);
  });

  it('sends again only the rows refused for a limit, contiguous and in order', async () => {
    const limitedIds = new Set(['r1', 'r3', 'r4', 'r7']);
    const { calls, settled, run } = harness((id, size) => {
      if (size > 2 && limitedIds.has(id)) return limitRefusal;
      if (id === 'r5') return otherRefusal;
      return ok;
    });
    await sendSplittingOnLimits(ids(8), run);
    // A call of 8 halves to 4: the 4 limited rows go again in one call of 4,
    // refused again, then in two calls of 2.
    expect(calls).toEqual([ids(8), ['r1', 'r3', 'r4', 'r7'], ['r1', 'r3'], ['r4', 'r7']]);
    const byId = new Map(settled.map((row) => [row.id, row]));
    expect(byId.get('r5')?.answer).toBe(otherRefusal);
    expect(byId.get('r5')?.note).toBeUndefined();
    expect(['r1', 'r3', 'r4', 'r7'].every((id) => byId.get(id)?.answer?.success)).toBe(true);
    expect(settled).toHaveLength(8);
  });

  it('settles a row refused for a limit sent on its own with ALONE', async () => {
    const { calls, settled, run } = harness((id) => (id === 'r2' ? limitRefusal : ok));
    await sendSplittingOnLimits(ids(4), run);
    expect(calls.map((call) => call.length)).toEqual([4, 1]);
    const r2 = settled.find((row) => row.id === 'r2');
    expect(r2).toMatchObject({ answer: limitRefusal, note: ALONE });
    expect(settled).toHaveLength(4);
    expect(settled.filter((row) => row.note !== undefined)).toHaveLength(1);
  });

  it('settles with NOT_SPLIT once the allowance is spent, and goes at 200 again', async () => {
    const { calls, settled, run } = harness(refusesOver(100), {
      allowance: new SplitAllowance(0),
    });
    await sendSplittingOnLimits(ids(316), run);
    expect(calls.map((call) => call.length)).toEqual([200, 116]);
    expect(settled.filter((row) => row.note === NOT_SPLIT)).toHaveLength(316);
    expect(run.sizes.isSpent(PROVENANCE)).toBe(true);
    expect(run.sizes.wasShrunk(PROVENANCE)).toBe(true);
    expect(run.sizes.report(PROVENANCE)).toMatchObject({ notSplit: 316, extraCalls: 0 });
  });

  it('splits what a partial grant covers and settles the rest with NOT_SPLIT', async () => {
    const { calls, settled, run } = harness(refusesOver(50), {
      allowance: new SplitAllowance(1),
    });
    await sendSplittingOnLimits(ids(116), run);
    // One call of 58 granted, refused again: the object is spent.
    expect(calls.map((call) => call.length)).toEqual([116, 58]);
    expect(settled.filter((row) => row.note === NOT_SPLIT)).toHaveLength(116);
    expect(calls[1]).toEqual(ids(58));
    expect(run.sizes.report(PROVENANCE)).toMatchObject({ extraCalls: 1, spent: true });
  });

  it('cuts the following calls at the size that went through, each paid', async () => {
    const { calls, run } = harness(refusesOver(100));
    await sendSplittingOnLimits(ids(1000), run);
    expect(calls.map((call) => call.length)).toEqual([
      200, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
    ]);
    // 2 halves, then the 800 left in 8 calls of 100 where calls of 200 took
    // 4: 11 calls where 5 would have gone, 6 more, as the removal counts them.
    expect(run.allowance.spent).toBe(6);
    expect(run.sizes.report(PROVENANCE)).toMatchObject({ rows: 1000, extraCalls: 6 });
  });

  it('starts at the size kept, and leaves another object at 200', async () => {
    const sizes = CallSizes.from({ Provenance__c: 58 }, 'delete');
    const { calls, run } = harness(refusesOver(100), { sizes });
    await sendSplittingOnLimits(ids(116), run);
    expect(calls.map((call) => call.length)).toEqual([58, 58]);
    expect(run.allowance.spent).toBe(1);

    const other = harness(refusesOver(150), {
      sizes,
      key: { objectApiName: 'Account', op: 'delete' },
    });
    await sendSplittingOnLimits(ids(150), other.run);
    expect(other.calls.map((call) => call.length)).toEqual([150]);
  });

  it('pays every smaller call of rows priced as a job', async () => {
    const sizes = CallSizes.from({ Provenance__c: 100 }, 'delete');
    const { calls, run } = harness(() => ok, { sizes, pricedAs: 'job' });
    await sendSplittingOnLimits(ids(400), run);
    expect(calls.map((call) => call.length)).toEqual([100, 100, 100, 100]);
    expect(run.allowance.spent).toBe(4);
  });

  it('takes the calls the caller paid for before asking the allowance', async () => {
    const sizes = CallSizes.from({ Provenance__c: 100 }, 'delete');
    const paid = { calls: 3 };
    const { calls, run } = harness(() => ok, { sizes, pricedAs: 'job', paid });
    await sendSplittingOnLimits(ids(400), run);
    expect(calls).toHaveLength(4);
    expect(paid.calls).toBe(0);
    expect(run.allowance.spent).toBe(1);
  });

  it('hands to unpaid, unsent, the rows the allowance no longer pays smaller calls for', async () => {
    const sizes = CallSizes.from({ Provenance__c: 100 }, 'delete');
    const unpaid = vi.fn();
    const { calls, settled, run } = harness(() => ok, {
      sizes,
      pricedAs: 'job',
      allowance: new SplitAllowance(2),
      unpaid,
    });
    await sendSplittingOnLimits(ids(500), run);
    // Two calls of 100 paid; the 300 rows left are never sent at 200.
    expect(calls.map((call) => call.length)).toEqual([100, 100]);
    expect(settled).toHaveLength(200);
    expect(unpaid).toHaveBeenCalledTimes(1);
    expect(unpaid.mock.calls[0][0]).toEqual(ids(500).slice(200));
    expect(run.sizes.report(PROVENANCE)).toMatchObject({ notSplit: 300, spent: true });

    // A key spent before the rows are handed sends none of them.
    const again = harness(() => ok, { sizes, pricedAs: 'job', unpaid: vi.fn() });
    await sendSplittingOnLimits(ids(50), again.run);
    expect(again.calls).toHaveLength(0);
    expect(again.run.unpaid).toHaveBeenCalledWith(ids(50));
  });

  it('sends the first call at the size the caller paid for, unchecked', async () => {
    const beforeEachSend = vi.fn();
    const { calls, run } = harness(() => ok, { firstSize: 50, beforeEachSend });
    await sendSplittingOnLimits(ids(120), run);
    expect(calls.map((call) => call.length)).toEqual([50, 70]);
    expect(beforeEachSend).toHaveBeenCalledTimes(1);
  });

  it('holds no more than maxSize, and does not pay for it', async () => {
    const { calls, run } = harness(() => ok, { maxSize: 50 });
    await sendSplittingOnLimits(ids(120), run);
    expect(calls.map((call) => call.length)).toEqual([50, 50, 20]);
    expect(run.allowance.spent).toBe(0);
  });

  it('hands on the part and the queue when beforeEachSend throws, and throws again', async () => {
    const cancelled = new Error('cancelled');
    let checks = 0;
    const onThrow = vi.fn();
    const { calls, settled, run } = harness(refusesOver(100), {
      beforeEachSend: () => {
        checks++;
        if (checks === 2) throw cancelled;
      },
      onThrow,
    });
    await expect(sendSplittingOnLimits(ids(116), run)).rejects.toBe(cancelled);
    expect(calls.map((call) => call.length)).toEqual([116, 58]);
    expect(settled.map((row) => row.id)).toEqual(ids(58));
    expect(onThrow).toHaveBeenCalledTimes(1);
    expect(onThrow.mock.calls[0][0]).toEqual(ids(116).slice(58));
    expect(onThrow.mock.calls[0][1]).toBe(cancelled);
  });

  it('hands on the part and the queue when a call throws', async () => {
    const onThrow = vi.fn();
    let sends = 0;
    const { run } = harness(refusesOver(100), { onThrow });
    run.send = async (part) => {
      sends++;
      if (sends === 2) throw new Error('socket hang up');
      return { answers: part.map(() => limitRefusal) };
    };
    await expect(sendSplittingOnLimits(ids(116), run)).rejects.toThrow('socket hang up');
    expect(onThrow.mock.calls[0][0]).toEqual(ids(116));
  });

  it('gives back the call that may have written and the rows after it on stop', async () => {
    let sends = 0;
    const { settled, run } = harness(refusesOver(100));
    const send = run.send;
    run.send = async (part) => {
      sends++;
      return sends === 2 ? 'stop' : send(part);
    };
    const outcome = await sendSplittingOnLimits(ids(116), run);
    expect(outcome.stopped).toEqual({ part: ids(58), rest: ids(116).slice(58), sent: true });
    expect(settled).toEqual([]);
  });

  it('stops unsent when beforeEachSend says so', async () => {
    const { calls, run } = harness(() => ok, { beforeEachSend: () => 'stop' });
    const outcome = await sendSplittingOnLimits(ids(450), run);
    expect(calls).toHaveLength(1);
    expect(outcome.stopped).toEqual({
      part: ids(450).slice(200, 400),
      rest: ids(450).slice(400),
      sent: false,
    });
  });

  it('calls onFirstRefusal once, the first time the key is cut', async () => {
    const onFirstRefusal = vi.fn();
    const { run } = harness(refusesOver(30), { onFirstRefusal });
    await sendSplittingOnLimits(ids(116), run);
    expect(onFirstRefusal).toHaveBeenCalledTimes(1);
    expect(onFirstRefusal.mock.calls[0][0]).toMatchObject({ from: 116, to: 58 });
  });

  it('never settles a row twice, whatever the refusals', async () => {
    const seen = new Map<string, number>();
    const { run } = harness((id, size) => (size > 7 || id === 'r3' ? limitRefusal : ok), {
      settle: (part, _answers, again) => {
        part.forEach((id, index) => {
          if (!again.has(index)) seen.set(id, (seen.get(id) ?? 0) + 1);
        });
      },
    });
    await sendSplittingOnLimits(ids(437), run);
    expect(seen.size).toBe(437);
    expect([...seen.values()].every((count) => count === 1)).toBe(true);
  });

  it('sends nothing for no rows', async () => {
    const { calls, run } = harness(() => ok);
    expect(await sendSplittingOnLimits([], run)).toEqual({});
    expect(calls).toEqual([]);
  });
});
