import { describe, expect, it } from 'vitest';

import {
  LATE_WITHIN_MS,
  MADE_KEPT_PER_OBJECT,
  MADE_WITHIN_MS,
  SAME_SAVE_MS,
  TIE_DEPTH,
  TIE_LEAD_MS,
  madeKept,
  sweepTiesOf,
  type SweepAnchor,
  type SweepCandidate,
  type SweepPointer,
  type SweepTieInput,
} from './sweepTies.js';

/** A record's key: its object's prefix, then a counter, fifteen characters. */
const key = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}`;

/** When the run created its case, and the span of its writes. */
const RUN_CASE_AT = Date.parse('2026-10-15T09:00:10.000Z');
const RUN_FIRST = Date.parse('2026-10-15T09:00:00.000Z');
const RUN_LAST = Date.parse('2026-10-15T09:02:00.000Z');

const CASE = key('500', 1);
const CONTACT = key('003', 1);
/** An account the run only linked to: in its id map, never one of its records. */
const LINKED_ACCOUNT = key('001', 9);

const created = (at = RUN_CASE_AT): SweepAnchor => ({ kind: 'created', from: at, to: at });

/** A record found, created `after` ms after the run's case unless told. */
function found(
  recordKey: string,
  after: number,
  references: SweepCandidate['references'] = [],
  automatedProcess = false,
): SweepCandidate {
  return { key: recordKey, created: RUN_CASE_AT + after, automatedProcess, references };
}

/** Everything a tie is told from, the run's case and contact its records. */
function input(
  candidates: SweepCandidate[],
  overrides: Partial<SweepTieInput> = {},
): SweepTieInput {
  return {
    anchors: new Map([
      [CASE, created()],
      [CONTACT, created()],
    ]),
    candidates,
    pointers: [],
    runSpan: { from: RUN_FIRST, to: RUN_LAST },
    // A long run's window: wide enough that time alone keeps nothing out of it.
    window: { from: RUN_FIRST - 1_000, to: RUN_CASE_AT + 2 * 60 * 60_000 },
    removalBegan: Number.POSITIVE_INFINITY,
    ...overrides,
  };
}

const under = (recordKey: string, cascade = false) => ({ key: recordKey, cascade });

describe('sweepTiesOf: what ties a record to the run', () => {
  it('ties a record whose lookup points at a record the run created: under', () => {
    const task = key('00T', 1);
    const ties = sweepTiesOf(input([found(task, 5_000, [under(CASE, true)])]));
    expect(ties.get(task)).toEqual({ class: 'made', sameSave: false, turn: 'with' });
  });

  it('ties a record a record of the run points at: pointed, and it waits for that record when the lookup restricts the delete', () => {
    const asset = key('02i', 1);
    const pointers: SweepPointer[] = [{ from: CASE, to: asset, restricted: true }];
    const ties = sweepTiesOf(input([found(asset, 1_000)], { pointers }));
    expect(ties.get(asset)).toEqual({ class: 'made', sameSave: true, turn: 'after' });

    const notRestricted = sweepTiesOf(
      input([found(asset, 1_000)], { pointers: [{ ...pointers[0], restricted: false }] }),
    );
    expect(notRestricted.get(asset)?.turn).toBe('before');
  });

  it('ties a record that points at a record already tied: in a chain, timed by the record of the run it ends at', () => {
    const feedItem = key('0D5', 1);
    const comment = key('0D7', 1);
    const ties = sweepTiesOf(
      input([
        found(feedItem, 1_000, [under(CASE, true)]),
        found(comment, 30_000, [under(feedItem, true)]),
      ]),
    );
    expect(ties.get(comment)).toEqual({ class: 'made', sameSave: false, turn: 'with' });
  });

  it('takes no tie from a record the run only linked to', () => {
    const task = key('00T', 1);
    const ties = sweepTiesOf(input([found(task, 5_000, [under(LINKED_ACCOUNT, true)])]));
    // In the window, tied to nothing of the run.
    expect(ties.get(task)).toEqual({ class: 'untied', sameSave: false, turn: 'before' });
  });

  it('follows a chain three links and no further', () => {
    const one = key('a01', 1);
    const two = key('a02', 1);
    const three = key('a03', 1);
    const four = key('a04', 1);
    const ties = sweepTiesOf(
      input([
        found(one, 1_000, [under(CASE)]),
        found(two, 1_000, [under(one)]),
        found(three, 1_000, [under(two)]),
        found(four, 1_000, [under(three)]),
      ]),
    );
    expect(TIE_DEPTH).toBe(3);
    expect(ties.get(three)?.class).toBe('made');
    expect(ties.get(four)?.class).toBe('untied');
  });

  it('ends a cycle, tied or not', () => {
    const a = key('a01', 1);
    const b = key('a02', 1);
    const loose = sweepTiesOf(input([found(a, 1_000, [under(b)]), found(b, 1_000, [under(a)])]));
    expect(loose.get(a)?.class).toBe('untied');
    expect(loose.get(b)?.class).toBe('untied');

    const held = sweepTiesOf(
      input([found(a, 1_000, [under(b), under(CASE)]), found(b, 1_000, [under(a)])]),
    );
    expect(held.get(a)?.class).toBe('made');
    expect(held.get(b)?.class).toBe('made');
  });
});

describe('sweepTiesOf: when a tied record came', () => {
  const task = key('00T', 1);
  const classAt = (after: number): string | undefined =>
    sweepTiesOf(input([found(task, after, [under(CASE)])])).get(task)?.class;

  it('takes a record from two seconds before to a minute after its record for made, and later for late', () => {
    expect(TIE_LEAD_MS).toBe(2_000);
    expect(MADE_WITHIN_MS).toBe(60_000);
    expect(classAt(-2_000)).toBe('made');
    expect(classAt(-3_000)).toBe('untied');
    expect(classAt(60_000)).toBe('made');
    expect(classAt(61_000)).toBe('late');
  });

  it('keeps a tie fifteen minutes and no longer: past it, a record is not told from hand work', () => {
    expect(LATE_WITHIN_MS).toBe(15 * 60_000);
    expect(classAt(LATE_WITHIN_MS)).toBe('late');
    expect(classAt(LATE_WITHIN_MS + 1_000)).toBe('untied');
  });

  it('says a record of the same save within two seconds of its record', () => {
    expect(SAME_SAVE_MS).toBe(2_000);
    const sameSave = (after: number): boolean | undefined =>
      sweepTiesOf(input([found(task, after, [under(CASE)])])).get(task)?.sameSave;
    expect(sameSave(2_000)).toBe(true);
    expect(sameSave(-2_000)).toBe(true);
    expect(sameSave(3_000)).toBe(false);
  });

  it('times a record tied to one of the run’s whose date could not be read by the run’s span', () => {
    const anchors = new Map([[CASE, { kind: 'created' as const, from: NaN, to: NaN }]]);
    // Ninety seconds after the case would be late; inside the run's span, it is made.
    const ties = sweepTiesOf(input([found(task, 90_000, [under(CASE)])], { anchors }));
    expect(ties.get(task)?.class).toBe('made');
  });

  it('takes nothing created once the removal began, late or untied', () => {
    const ties = sweepTiesOf(
      input([found(task, 120_000, [under(CASE)]), found(key('00T', 2), 120_000)], {
        removalBegan: RUN_CASE_AT + 100_000,
      }),
    );
    expect(ties.size).toBe(0);
  });

  it('names nothing tied to nothing outside the run’s window', () => {
    const ties = sweepTiesOf(
      input([found(task, 10 * 60_000)], { window: { from: RUN_FIRST, to: RUN_LAST + 60_000 } }),
    );
    expect(ties.has(task)).toBe(false);
  });
});

describe('sweepTiesOf: the run’s records and their creators', () => {
  const task = key('00T', 1);

  it('takes what is tied only to a record the run wrote over for madeOver, and a record it created first', () => {
    const updated = key('003', 7);
    const anchors = new Map<string, SweepAnchor>([
      [CASE, created()],
      [updated, { kind: 'overwritten', from: RUN_FIRST, to: RUN_LAST }],
    ]);
    const over = sweepTiesOf(input([found(task, 5_000, [under(updated, true)])], { anchors }));
    // A record the run only wrote over is not deleted by its removal: what is
    // under it does not go along.
    expect(over.get(task)).toEqual({ class: 'madeOver', sameSave: false, turn: 'before' });

    const both = sweepTiesOf(
      input([found(task, 5_000, [under(updated), under(CASE)])], { anchors }),
    );
    expect(both.get(task)?.class).toBe('made');
  });

  it('takes a tied record of the org’s Automated Process user for late only, and one tied to nothing for none', () => {
    const ties = sweepTiesOf(
      input([found(task, 5_000, [under(CASE)], true), found(key('00T', 2), 5_000, [], true)]),
    );
    expect(ties.get(task)?.class).toBe('late');
    expect(ties.has(key('00T', 2))).toBe(false);
  });

  it('keeps for made what an earlier sweep found made, its tie since cleared by a removal', () => {
    const ties = sweepTiesOf(input([found(task, 5_000)], { madeEarlier: new Set([task]) }));
    expect(ties.get(task)?.class).toBe('made');
  });

  it('goes with a record of the run only by lookups that cascade', () => {
    const feedItem = key('0D5', 1);
    const comment = key('0D7', 1);
    const ties = sweepTiesOf(
      input([
        found(feedItem, 1_000, [under(CASE, false)]),
        found(comment, 1_000, [under(feedItem, true)]),
      ]),
    );
    expect(ties.get(feedItem)?.turn).toBe('before');
    expect(ties.get(comment)?.turn).toBe('before');
  });
});

describe('madeKept: what the sweeps of a run found made for it', () => {
  const made = (prefix: string, n: number): string => `${key(prefix, n)}AAA`;

  it('keeps those kept, then those found, each once whichever length its id is in', () => {
    expect(madeKept([made('00T', 1)], [key('00T', 1), made('00T', 2)])).toEqual([
      made('00T', 1),
      made('00T', 2),
    ]);
    expect(madeKept(undefined, new Set([made('02i', 1)]))).toEqual([made('02i', 1)]);
    expect(madeKept(undefined, [])).toEqual([]);
  });

  it('leaves out what does not read as an id: each ends up in a delete', () => {
    expect(madeKept(['not an id'], ["00T' OR Id != '", made('00T', 1)])).toEqual([made('00T', 1)]);
  });

  it('holds each object to its bound, an object by the first three characters of its ids', () => {
    const tasks = Array.from({ length: MADE_KEPT_PER_OBJECT + 5 }, (_, n) => made('00T', n));

    const kept = madeKept(tasks, [made('00T', MADE_KEPT_PER_OBJECT + 9), made('02i', 1)]);

    expect(kept.filter((one) => one.startsWith('00T'))).toHaveLength(MADE_KEPT_PER_OBJECT);
    expect(kept).toContain(made('02i', 1));
    // The earliest stay: they are what the org no longer tells.
    expect(kept[0]).toBe(made('00T', 0));
  });
});
