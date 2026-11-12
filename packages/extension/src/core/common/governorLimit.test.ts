import { limitCauseOf } from '@sandforge/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  ALONE,
  ALONE_PROBES,
  allowedFor,
  BULK_CHUNK,
  CallSizes,
  FULL_CALL_SIZE,
  GOVERNOR_LIMIT_ALONE,
  GOVERNOR_LIMIT_KEPT_WHOLE,
  KEPT_WHOLE,
  NOT_SPLIT,
  OBJECT_SPLIT_CALLS,
  RUN_SPLIT_CALLS,
  SplitAllowance,
  extraCallsOf,
  governorLimitNotSplit,
  isExtraCall,
  limitNoteText,
  limitSplitting,
  notSplitNote,
  sendSplittingOnLimits,
  smallerCallsNote,
  splitAllowanceOf,
  takeSmallerCalls,
  type CallKey,
  type LimitNote,
  type SplitRun,
} from './governorLimit.js';

/**
 * What a trap org answered every record of a delete of 116, its trigger
 * running a query per record: the same code and words it gave an insert.
 */
const LIMIT_REFUSAL_TEXT =
  'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: Ledger_Trigger: System.LimitException: Too many SOQL queries: 101';

/** What it answered a record whose trigger looped past the CPU limit, and the one sent beside it. */
const CPU_REFUSAL_TEXT =
  'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: Ledger_Trigger: System.LimitException: Apex CPU time limit exceeded';

const LEDGER: CallKey = { objectApiName: 'Ledger__c', op: 'delete' };

interface Answer {
  success: boolean;
  errors: string[];
}

const ok: Answer = { success: true, errors: [] };
const limitRefusal: Answer = { success: false, errors: [LIMIT_REFUSAL_TEXT] };
const cpuRefusal: Answer = { success: false, errors: [CPU_REFUSAL_TEXT] };
const otherRefusal: Answer = {
  success: false,
  errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: no'],
};

const ids = (n: number, prefix = 'r'): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`);

interface Settled {
  id: string;
  answer: Answer | undefined;
  note?: LimitNote;
  held?: true;
}

interface Harness {
  calls: string[][];
  settled: Settled[];
  run: SplitRun<string, Answer>;
}

/**
 * A run on Ledger__c whose org answers each row as `answer` says for a call
 * of that many rows; every call and every settled row is kept.
 */
function harness(
  answer: (id: string, call: readonly string[]) => Answer,
  overrides: Partial<SplitRun<string, Answer>> = {},
): Harness {
  const calls: string[][] = [];
  const settled: Settled[] = [];
  const run: SplitRun<string, Answer> = {
    key: LEDGER,
    sizes: new CallSizes(),
    allowance: new SplitAllowance(),
    send: async (part) => {
      calls.push([...part]);
      return { answers: part.map((id) => answer(id, part)) };
    },
    limited: (a) => (a && !a.success ? limitCauseOf(a.errors) : undefined),
    settle: (part, answers, again, notes, held) => {
      part.forEach((id, index) => {
        if (again.has(index)) return;
        const note = notes.get(index);
        settled.push({
          id,
          answer: answers[index],
          ...(note ? { note } : {}),
          ...(held ? { held } : {}),
        });
      });
    },
    ...overrides,
  };
  return { calls, settled, run };
}

/** An org whose trigger refuses, for a limit, every row of a call of more than `max` rows. */
const refusesOver =
  (max: number) =>
  (_id: string, call: readonly string[]): Answer =>
    call.length > max ? limitRefusal : ok;

/**
 * An org whose trigger passes the CPU limit for the records of `heavy`, alone
 * or not, and refuses with them every record of their call, as a trap org did.
 */
const cpuHeavy =
  (heavy: ReadonlySet<string>) =>
  (_id: string, call: readonly string[]): Answer =>
    call.some((id) => heavy.has(id)) ? cpuRefusal : ok;

describe('constants', () => {
  it('bound the splitting', () => {
    expect(FULL_CALL_SIZE).toBe(200);
    expect(RUN_SPLIT_CALLS).toBe(2000);
    expect(OBJECT_SPLIT_CALLS).toBe(500);
    expect(ALONE_PROBES).toBe(2);
  });
});

describe('CallSizes', () => {
  it('goes at 200 until a limit cuts it, then at half the call refused', () => {
    const sizes = new CallSizes();
    expect(sizes.of(LEDGER)).toBe(200);
    expect(sizes.wasRefused(LEDGER)).toBe(false);
    sizes.firstRefusal(LEDGER, 116);
    expect(sizes.wasRefused(LEDGER)).toBe(true);
    expect(sizes.wasCut(LEDGER)).toBe(false);
    expect(sizes.of(LEDGER)).toBe(200);
    expect(sizes.refusedAt(LEDGER, 116)).toBe(58);
    expect(sizes.wasCut(LEDGER)).toBe(true);
    expect(sizes.of(LEDGER)).toBe(58);
  });

  it('halves down to one record, and never under', () => {
    const sizes = new CallSizes();
    const seen: number[] = [];
    let size = 200;
    while (size > 1) {
      size = sizes.refusedAt(LEDGER, size);
      seen.push(size);
    }
    expect(seen).toEqual([100, 50, 25, 13, 7, 4, 2, 1]);
    expect(sizes.refusedAt(LEDGER, 1)).toBe(1);
  });

  it('never goes back up, even for a larger call refused later', () => {
    const sizes = new CallSizes();
    sizes.refusedAt(LEDGER, 100);
    expect(sizes.refusedAt(LEDGER, 200)).toBe(50);
    expect(sizes.of(LEDGER)).toBe(50);
  });

  it('keeps one size per object and per operation', () => {
    const sizes = new CallSizes();
    sizes.refusedAt(LEDGER, 200);
    expect(sizes.of({ objectApiName: 'Ledger__c', op: 'insert' })).toBe(200);
    expect(sizes.of({ objectApiName: 'Account', op: 'delete' })).toBe(200);
  });

  it('goes at 200 again once spent, and once kept whole is not split', () => {
    const sizes = new CallSizes();
    sizes.refusedAt(LEDGER, 200);
    sizes.spend(LEDGER);
    expect(sizes.isSpent(LEDGER)).toBe(true);
    expect(sizes.of(LEDGER)).toBe(200);
    const whole = new CallSizes();
    whole.firstRefusal(LEDGER, 200);
    whole.keepWhole(LEDGER);
    expect(whole.isKeptWhole(LEDGER)).toBe(true);
    expect(whole.of(LEDGER)).toBe(200);
  });

  it('keeps the first refusal’s size, limit and trigger for the notes', () => {
    const sizes = new CallSizes();
    sizes.refusedAt(LEDGER, 116, limitCauseOf([LIMIT_REFUSAL_TEXT]));
    sizes.refusedAt(LEDGER, 58, { limit: 'Apex CPU time limit exceeded' });
    sizes.countExtraCalls(LEDGER, 2);
    sizes.countSmallCallRows(LEDGER, 116);
    sizes.countNoted(LEDGER, ALONE, 2);
    sizes.countNoted(LEDGER, NOT_SPLIT, 3);
    sizes.countNoted(LEDGER, KEPT_WHOLE, 4);
    expect(sizes.report(LEDGER)).toEqual({
      objectApiName: 'Ledger__c',
      op: 'delete',
      from: 116,
      to: 29,
      rows: 116,
      extraCalls: 2,
      limit: 'Too many SOQL queries',
      automation: 'Ledger_Trigger',
      alone: 2,
      notSplit: 3,
      keptWhole: 4,
      wholeAlone: false,
      spent: false,
    });
    expect(sizes.report({ objectApiName: 'Account', op: 'delete' })).toBeUndefined();
    expect(sizes.reports('delete')).toHaveLength(1);
    expect(sizes.reports('insert')).toEqual([]);
  });
});

describe('SplitAllowance', () => {
  it('grants part of what is asked when the run’s allowance does not cover it all', () => {
    const allowance = new SplitAllowance(5);
    expect(allowance.take(LEDGER, 3)).toBe(3);
    expect(allowance.take({ objectApiName: 'Account', op: 'insert' }, 4)).toBe(2);
    expect(allowance.take(LEDGER, 1)).toBe(0);
    expect(allowance.spent).toBe(5);
  });

  it('grants one object 500 calls at most, whatever its operations', () => {
    const allowance = new SplitAllowance(RUN_SPLIT_CALLS);
    expect(allowance.take(LEDGER, 450)).toBe(450);
    expect(allowance.take({ objectApiName: 'Ledger__c', op: 'insert' }, 100)).toBe(50);
    expect(allowance.left(LEDGER)).toBe(0);
    expect(allowance.taken(LEDGER)).toBe(500);
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
    expect(new SplitAllowance(0).take(LEDGER, 1)).toBe(0);
    expect(new SplitAllowance(-10).granted).toBe(0);
    expect(new SplitAllowance(Number.NaN).take(LEDGER, 1)).toBe(0);
  });

  it('is lowered to what a gate allows, never raised', () => {
    const allowance = new SplitAllowance();
    allowance.limitTo(120);
    expect(allowance.granted).toBe(120);
    allowance.limitTo(5_000);
    expect(allowance.granted).toBe(120);
    allowance.limitTo(Number.NaN);
    expect(allowance.granted).toBe(0);
  });
});

describe('splitAllowanceOf', () => {
  it('allows half of what the requests leave past the act, 2 000 at most', () => {
    expect(splitAllowanceOf(10_000, 2_000)).toBe(2_000);
    expect(splitAllowanceOf(3_000, 1_000)).toBe(1_000);
    expect(splitAllowanceOf(1_001, 1_000)).toBe(0);
    expect(splitAllowanceOf(1_003, 1_000)).toBe(1);
    expect(splitAllowanceOf(500, 1_000)).toBe(0);
    expect(splitAllowanceOf(Number.NaN, 0)).toBe(0);
  });

  it('gives sizes of their own and the allowance asked, 2 000 when not asked', () => {
    expect(limitSplitting().allowance.granted).toBe(2000);
    expect(limitSplitting(12).allowance.granted).toBe(12);
  });
});

describe('takeSmallerCalls', () => {
  it('counts what it granted and spends the key granted fewer than it asked', () => {
    const sizes = new CallSizes();
    sizes.refusedAt(LEDGER, 200);
    const allowance = new SplitAllowance(3);
    expect(takeSmallerCalls(sizes, allowance, LEDGER, 2)).toBe(2);
    expect(sizes.isSpent(LEDGER)).toBe(false);
    expect(takeSmallerCalls(sizes, allowance, LEDGER, 2)).toBe(1);
    expect(sizes.isSpent(LEDGER)).toBe(true);
    expect(sizes.report(LEDGER)?.extraCalls).toBe(3);
    expect(takeSmallerCalls(sizes, new SplitAllowance(), LEDGER, 1)).toBe(0);
    expect(takeSmallerCalls(sizes, allowance, LEDGER, 0)).toBe(0);
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
    allowance.take(LEDGER, 500);
    expect(allowedFor(allowance, LEDGER)).toBe(500);
    const small = new SplitAllowance(10, 500);
    small.take(LEDGER, 10);
    expect(allowedFor(small, LEDGER)).toBe(10);
    // Nothing to spend: the note says none was allowed, not 500.
    expect(allowedFor(new SplitAllowance(0), LEDGER)).toBe(0);
  });
});

describe('notes', () => {
  it('say what happened in engine English', () => {
    expect(GOVERNOR_LIMIT_ALONE).toMatch(/^Sent on its own/);
    expect(GOVERNOR_LIMIT_KEPT_WHOLE).toMatch(/^Not sent in smaller calls: records of the same/);
    expect(governorLimitNotSplit(2000)).toBe(
      'Not sent in smaller calls: the run had spent the 2000 smaller calls it allows itself.',
    );
    expect(limitNoteText(ALONE, 2000)).toBe(GOVERNOR_LIMIT_ALONE);
    expect(limitNoteText(KEPT_WHOLE, 2000)).toBe(GOVERNOR_LIMIT_KEPT_WHOLE);
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

  it('name the trigger, or the target’s automation, and what became of the calls', () => {
    const sizes = new CallSizes();
    sizes.refusedAt(LEDGER, 116, limitCauseOf([LIMIT_REFUSAL_TEXT]));
    sizes.countExtraCalls(LEDGER, 3);
    sizes.countSmallCallRows(LEDGER, 116);
    const report = sizes.report(LEDGER);
    expect(report && smallerCallsNote(report)).toBe(
      'Ledger_Trigger hit Too many SOQL queries on a call of 116: sent 58 at a time, 3 calls more.',
    );
    const unnamed = new CallSizes();
    unnamed.firstRefusal(LEDGER, 200, { limit: 'Apex CPU time limit exceeded', event: 'x' });
    const plain = unnamed.report(LEDGER);
    expect(plain && smallerCallsNote(plain)).toBe(
      "The target's automation hit Apex CPU time limit exceeded on a call of 200.",
    );
    const whole = new CallSizes();
    whole.firstRefusal(LEDGER, 200, limitCauseOf([CPU_REFUSAL_TEXT]));
    whole.countNoted(LEDGER, ALONE, 2);
    whole.countExtraCalls(LEDGER, 2);
    whole.keepWhole(LEDGER);
    const kept = whole.report(LEDGER);
    expect(kept && smallerCallsNote(kept)).toBe(
      'Ledger_Trigger hit Apex CPU time limit exceeded on a call of 200, and 2 records sent on their own were refused too: not sent in smaller calls, 2 calls more.',
    );
  });
});

describe('sendSplittingOnLimits', () => {
  it('sends a record of the 116 on its own, then the rest as 58 + 57, all settled', async () => {
    const { calls, settled, run } = harness(refusesOver(100));
    const outcome = await sendSplittingOnLimits(ids(116), run);
    expect(outcome).toEqual({});
    expect(calls.map((call) => call.length)).toEqual([116, 1, 58, 57]);
    expect(settled).toHaveLength(116);
    expect(settled.every((row) => row.answer?.success)).toBe(true);
    expect(settled.map((row) => row.id).sort()).toEqual(ids(116).sort());
    expect(run.sizes.report(LEDGER)).toMatchObject({
      from: 116,
      to: 58,
      rows: 116,
      extraCalls: 3,
      automation: 'Ledger_Trigger',
      notSplit: 0,
      alone: 0,
      wholeAlone: false,
    });
    expect(run.allowance.spent).toBe(3);
  });

  it('stops after two records refused on their own: the key is left whole, the rest settled as the org refused them', async () => {
    // Every record passes the CPU limit by itself: halved down to one record
    // each, 200 of them would have cost some 400 calls.
    const { calls, settled, run } = harness(cpuHeavy(new Set(ids(200))));
    await sendSplittingOnLimits(ids(200), run);
    expect(calls.map((call) => call.length)).toEqual([200, 1, 1]);
    expect(settled).toHaveLength(200);
    expect(settled.filter((row) => row.note === ALONE).map((row) => row.id)).toEqual(['r0', 'r1']);
    const kept = settled.filter((row) => row.note === KEPT_WHOLE);
    expect(kept).toHaveLength(198);
    // Held while the key was probed, they are settled with what their call answered.
    expect(kept.every((row) => row.held === true && row.answer === cpuRefusal)).toBe(true);
    expect(run.sizes.isKeptWhole(LEDGER)).toBe(true);
    expect(run.sizes.report(LEDGER)).toMatchObject({ alone: 2, keptWhole: 198, extraCalls: 2 });
    expect(run.allowance.spent).toBe(2);

    // The next calls of the key go at 200, and are not split again.
    const next = harness(cpuHeavy(new Set(ids(250, 'n'))), {
      sizes: run.sizes,
      allowance: run.allowance,
    });
    await sendSplittingOnLimits(ids(250, 'n'), next.run);
    expect(next.calls.map((call) => call.length)).toEqual([200, 50]);
    expect(next.settled.every((row) => row.note === KEPT_WHOLE)).toBe(true);
  });

  it('settles the record refused on its own and writes the one sent beside it, as the CPU limit did live', async () => {
    const { calls, settled } = await (async () => {
      const h = harness(cpuHeavy(new Set(['r0'])));
      await sendSplittingOnLimits(ids(2), h.run);
      return h;
    })();
    expect(calls).toEqual([['r0', 'r1'], ['r0'], ['r1']]);
    expect(settled).toEqual([
      { id: 'r0', answer: cpuRefusal, note: ALONE },
      { id: 'r1', answer: ok },
    ]);
  });

  it('isolates one heavy record among 200 in a few calls, and writes the others', async () => {
    const { calls, settled, run } = harness(cpuHeavy(new Set(['r150'])));
    await sendSplittingOnLimits(ids(200), run);
    expect(calls.length).toBeLessThan(20);
    expect(settled.filter((row) => row.answer?.success)).toHaveLength(199);
    expect(settled.find((row) => row.id === 'r150')).toMatchObject({ note: ALONE });
    expect(run.sizes.isKeptWhole(LEDGER)).toBe(false);
  });

  it('goes on halving once the second record sent on its own is taken', async () => {
    const { calls, settled, run } = harness(cpuHeavy(new Set(['r0'])));
    await sendSplittingOnLimits(ids(10), run);
    expect(calls.map((call) => call.length)).toEqual([10, 1, 1, 5, 3]);
    expect(settled.filter((row) => row.answer?.success)).toHaveLength(9);
    expect(settled.find((row) => row.id === 'r0')).toMatchObject({ note: ALONE });
    expect(run.sizes.isKeptWhole(LEDGER)).toBe(false);
  });

  it('sends again only the rows refused for a limit, in order', async () => {
    const limitedIds = new Set(['r1', 'r3', 'r4', 'r7']);
    const { calls, settled, run } = harness((id, call) => {
      if (call.length > 2 && limitedIds.has(id)) return limitRefusal;
      if (id === 'r5') return otherRefusal;
      return ok;
    });
    await sendSplittingOnLimits(ids(8), run);
    // A record of the four goes on its own and is taken; the three held go
    // at half the call refused, 4, refused again, then in calls of 2.
    expect(calls).toEqual([ids(8), ['r1'], ['r3', 'r4', 'r7'], ['r3', 'r4'], ['r7']]);
    const byId = new Map(settled.map((row) => [row.id, row]));
    expect(byId.get('r5')?.answer).toBe(otherRefusal);
    expect(byId.get('r5')?.note).toBeUndefined();
    expect(['r1', 'r3', 'r4', 'r7'].every((id) => byId.get(id)?.answer?.success)).toBe(true);
    expect(settled).toHaveLength(8);
  });

  it('settles a row refused for a limit sent on its own with ALONE once the key is cut', async () => {
    const { calls, settled, run } = harness((id, call) =>
      id === 'r9' || call.length > 4 ? limitRefusal : ok,
    );
    await sendSplittingOnLimits(ids(16), run);
    const r9 = settled.find((row) => row.id === 'r9');
    expect(r9).toMatchObject({ answer: limitRefusal, note: ALONE });
    expect(settled).toHaveLength(16);
    expect(settled.filter((row) => row.answer?.success)).toHaveLength(15);
    expect(calls[0]).toHaveLength(16);
  });

  it('settles with NOT_SPLIT once the allowance is spent, and goes at 200 again', async () => {
    const { calls, settled, run } = harness(refusesOver(100), {
      allowance: new SplitAllowance(0),
    });
    await sendSplittingOnLimits(ids(316), run);
    expect(calls.map((call) => call.length)).toEqual([200, 116]);
    expect(settled.filter((row) => row.note === NOT_SPLIT)).toHaveLength(316);
    expect(run.sizes.isSpent(LEDGER)).toBe(true);
    expect(run.sizes.report(LEDGER)).toMatchObject({ notSplit: 316, extraCalls: 0 });
  });

  it('gives every row refused for a limit up when the allowance is 0, writing none of them twice', async () => {
    const { calls, settled, run } = harness(refusesOver(100), {
      allowance: new SplitAllowance(0),
    });
    await sendSplittingOnLimits(ids(116), run);
    expect(calls).toEqual([ids(116)]);
    expect(settled.map((row) => row.note)).toEqual(Array.from({ length: 116 }, () => NOT_SPLIT));
    expect(settled.every((row) => row.answer === limitRefusal)).toBe(true);
  });

  it('splits what a partial grant covers and settles the rest with NOT_SPLIT', async () => {
    const { calls, settled, run } = harness(refusesOver(50), {
      allowance: new SplitAllowance(2),
    });
    await sendSplittingOnLimits(ids(116), run);
    // The record on its own takes one call, the first half of 58 the other:
    // refused again, the key is spent.
    expect(calls.map((call) => call.length)).toEqual([116, 1, 58]);
    expect(settled.filter((row) => row.note === NOT_SPLIT)).toHaveLength(115);
    expect(settled.filter((row) => row.answer?.success)).toHaveLength(1);
    expect(run.sizes.report(LEDGER)).toMatchObject({ extraCalls: 2, spent: true });
  });

  it('cuts the following calls at the size that went through, each paid', async () => {
    const { calls, run } = harness(refusesOver(100));
    await sendSplittingOnLimits(ids(1000), run);
    expect(calls.map((call) => call.length)).toEqual([
      200, 1, 100, 99, 100, 100, 100, 100, 100, 100, 100, 100,
    ]);
    // A record on its own and two halves, then the 800 left in 8 calls of
    // 100 where calls of 200 took 4: 7 calls more.
    expect(run.allowance.spent).toBe(7);
    expect(run.sizes.report(LEDGER)).toMatchObject({ rows: 1000, extraCalls: 7 });
  });

  it('leaves another object at 200', async () => {
    const { run } = harness(refusesOver(100));
    await sendSplittingOnLimits(ids(116), run);
    const other = harness(refusesOver(150), {
      sizes: run.sizes,
      key: { objectApiName: 'Account', op: 'delete' },
    });
    await sendSplittingOnLimits(ids(150), other.run);
    expect(other.calls.map((call) => call.length)).toEqual([150]);
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
    expect(calls.map((call) => call.length)).toEqual([116, 1]);
    expect(settled.map((row) => row.id)).toEqual(['r0']);
    expect(onThrow).toHaveBeenCalledTimes(1);
    expect(onThrow.mock.calls[0][0]).toEqual(ids(116).slice(1));
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
    expect([...onThrow.mock.calls[0][0]].sort()).toEqual(ids(116).sort());
  });

  it('gives back the call that may have written and the rows held after it on stop, never sending it again', async () => {
    let sends = 0;
    const { settled, calls, run } = harness(refusesOver(100));
    const send = run.send;
    run.send = async (part) => {
      sends++;
      if (sends === 2) {
        calls.push([...part]);
        return 'stop';
      }
      return send(part);
    };
    const outcome = await sendSplittingOnLimits(ids(116), run);
    expect(outcome.stopped).toEqual({ part: ['r0'], rest: ids(116).slice(1), sent: true });
    expect(settled).toEqual([]);
    expect(calls).toHaveLength(2);
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

  it('calls onFirstRefusal once, the first time a limit refuses the key', async () => {
    const onFirstRefusal = vi.fn();
    const { run } = harness(refusesOver(30), { onFirstRefusal });
    await sendSplittingOnLimits(ids(116), run);
    expect(onFirstRefusal).toHaveBeenCalledTimes(1);
    expect(onFirstRefusal.mock.calls[0][0]).toMatchObject({ from: 116, to: 200 });
  });

  it('never settles a row twice, whatever the refusals', async () => {
    for (const answer of [
      (id: string, call: readonly string[]) => (call.length > 7 || id === 'r3' ? limitRefusal : ok),
      cpuHeavy(new Set(['r0', 'r1', 'r77'])),
      cpuHeavy(new Set(['r5', 'r300'])),
    ]) {
      const seen = new Map<string, number>();
      const { run } = harness(answer, {
        settle: (part, _answers, again) => {
          part.forEach((id, index) => {
            if (!again.has(index)) seen.set(id, (seen.get(id) ?? 0) + 1);
          });
        },
      });
      await sendSplittingOnLimits(ids(437), run);
      expect(seen.size).toBe(437);
      expect([...seen.values()].every((count) => count === 1)).toBe(true);
    }
  });

  it('sends nothing for no rows', async () => {
    const { calls, run } = harness(() => ok);
    expect(await sendSplittingOnLimits([], run)).toEqual({});
    expect(calls).toEqual([]);
  });
});

describe('sendSplittingOnLimits — rows a Bulk API job’s chunk refused for a limit', () => {
  /** What the job answered each of `rows`: the limit's refusal, its chunk rolled back. */
  const refusedByAJob = (rows: readonly string[]): SplitRun<string, Answer>['refusedIn'] => ({
    from: BULK_CHUNK,
    answers: rows.map(() => limitRefusal),
    cause: limitCauseOf(limitRefusal.errors),
  });

  it('sends a record of them on its own first, then halves of a chunk, never a call of 200, every call paid', async () => {
    const onFirstRefusal = vi.fn();
    const rows = ids(300);
    const { calls, settled, run } = harness(refusesOver(100), {
      refusedIn: refusedByAJob(rows),
      onFirstRefusal,
    });
    expect(await sendSplittingOnLimits(rows, run)).toEqual({});
    expect(calls.map((call) => call.length)).toEqual([1, 100, 100, 99]);
    expect(settled).toHaveLength(300);
    expect(settled.every((row) => row.answer?.success)).toBe(true);
    // The record on its own and the three calls of 100: none stands for a call of 200.
    expect(run.allowance.spent).toBe(4);
    expect(onFirstRefusal).toHaveBeenCalledTimes(1);
    expect(run.sizes.report(LEDGER)).toMatchObject({
      from: BULK_CHUNK,
      to: BULK_CHUNK / 2,
      rows: 300,
      extraCalls: 4,
      automation: 'Ledger_Trigger',
    });
  });

  it('halves them at once, at the size a call cut the key to, when the key was cut already', async () => {
    const sizes = new CallSizes();
    sizes.refusedAt(LEDGER, 116);
    const rows = ids(120);
    const { calls, settled, run } = harness(refusesOver(100), {
      sizes,
      refusedIn: refusedByAJob(rows),
    });
    await sendSplittingOnLimits(rows, run);
    expect(calls.map((call) => call.length)).toEqual([58, 58, 4]);
    expect(settled.every((row) => row.answer?.success)).toBe(true);
    expect(run.allowance.spent).toBe(3);
  });

  it('leaves them refused as the org refused them, sending nothing, when the allowance pays no call', async () => {
    const rows = ids(5);
    const { calls, settled, run } = harness(refusesOver(100), {
      allowance: new SplitAllowance(0),
      refusedIn: refusedByAJob(rows),
    });
    await sendSplittingOnLimits(rows, run);
    expect(calls).toEqual([]);
    expect(settled).toEqual(
      rows.map((id) => ({ id, answer: limitRefusal, note: NOT_SPLIT, held: true })),
    );
    expect(run.sizes.report(LEDGER)).toMatchObject({ notSplit: 5, spent: true });
  });

  it('leaves them refused, sending nothing, once records of the key sent on their own were refused', async () => {
    const sizes = new CallSizes();
    sizes.firstRefusal(LEDGER, 200);
    sizes.keepWhole(LEDGER);
    const rows = ids(3);
    const { calls, settled, run } = harness(refusesOver(100), {
      sizes,
      refusedIn: refusedByAJob(rows),
    });
    await sendSplittingOnLimits(rows, run);
    expect(calls).toEqual([]);
    expect(settled.map((row) => row.note)).toEqual([KEPT_WHOLE, KEPT_WHOLE, KEPT_WHOLE]);
  });
});

describe('sendSplittingOnLimits — rows priced as a Bulk API job', () => {
  /** Sizes on which a limit cut the key's calls to half a job's chunk. */
  const cutToAHundred = (): CallSizes => {
    const sizes = new CallSizes();
    sizes.refusedAt(LEDGER, BULK_CHUNK);
    return sizes;
  };

  it('pays each of their calls, where calls of 200 would have paid half of them', async () => {
    const asCalls = harness(() => ok, { sizes: cutToAHundred() });
    await sendSplittingOnLimits(ids(400), asCalls.run);
    expect(asCalls.run.allowance.spent).toBe(2);

    const asJob = harness(() => ok, { sizes: cutToAHundred(), pricedAs: 'job' });
    await sendSplittingOnLimits(ids(400), asJob.run);
    expect(asJob.calls.map((call) => call.length)).toEqual([100, 100, 100, 100]);
    expect(asJob.run.allowance.spent).toBe(4);
  });

  it('takes the calls the caller paid before asking the allowance, and pays none twice', async () => {
    const paid = { calls: 3 };
    const { calls, run } = harness(() => ok, { sizes: cutToAHundred(), pricedAs: 'job', paid });
    await sendSplittingOnLimits(ids(400), run);
    expect(calls.map((call) => call.length)).toEqual([100, 100, 100, 100]);
    expect(paid.calls).toBe(0);
    expect(run.allowance.spent).toBe(1);
  });
});
