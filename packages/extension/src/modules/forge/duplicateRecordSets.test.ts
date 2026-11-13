import { describe, expect, it } from 'vitest';

import { duplicateSetsOf } from './duplicateRecordSets.js';

/** A fake record id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const RUN_USER = id('005', 1);
const COLLEAGUE = id('005', 2);
const START = Date.parse('2026-11-13T02:19:46.000Z');
const END = Date.parse('2026-11-13T02:21:10.000Z');
const DURING = '2026-11-13T02:20:30.000+0000';

/** The run's records: two contacts and a lead. */
const RUN = new Set([id('003', 1), id('003', 2), id('00Q', 1)].map((x) => x.slice(0, 15)));
const run = { has: (key: string) => RUN.has(key), start: START, end: END, user: RUN_USER };

/**
 * An org answering the two reads a removal sends, as a scratch org answers
 * them: the sets the run's user created in the window, then their items.
 */
function orgOf(
  sets: Array<Record<string, unknown>>,
  items: Array<Record<string, unknown>>,
  fails?: RegExp,
): { query(soql: string): Promise<{ records: unknown[] }>; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    query: async (soql) => {
      asked.push(soql);
      if (fails?.test(soql)) throw new Error("INVALID_TYPE: sObject type 'DuplicateRecordSet'");
      if (soql.includes('FROM DuplicateRecordSet ')) return { records: sets };
      const wanted =
        /IN \((.*)\)/
          .exec(soql)?.[1]
          .split(', ')
          .map((x) => x.slice(1, -1)) ?? [];
      return {
        records: items.filter((item) => wanted.includes(String(item.DuplicateRecordSetId))),
      };
    },
  };
}

const set = (n: number, more: Record<string, unknown> = {}) => ({
  Id: id('0GK', n),
  LastModifiedDate: DURING,
  LastModifiedById: RUN_USER,
  ...more,
});
const item = (n: number, setN: number, record: string) => ({
  Id: id('0GL', n),
  DuplicateRecordSetId: id('0GK', setN),
  RecordId: record,
});

describe('duplicateSetsOf', () => {
  it('takes the sets the run’s user made in its window whose every item names a record of the run, and an emptied one', async () => {
    // Live, a clone of the whole org had the target's Lead and Contact rules
    // make two sets of its own records, which stayed empty once it was taken back.
    const org = orgOf(
      [set(1), set(2), set(3)],
      [item(1, 1, id('003', 1)), item(2, 1, id('003', 2)), item(3, 3, id('00Q', 1))],
    );

    const sets = await duplicateSetsOf(org, run);

    expect(sets.map((s) => s.id)).toEqual([id('0GK', 1), id('0GK', 2), id('0GK', 3)]);
    // Asked of the run's user, in its window, a lead before the first write
    // and a minute after the last.
    expect(org.asked[0]).toBe(
      'SELECT Id, LastModifiedDate, LastModifiedById FROM DuplicateRecordSet ' +
        `WHERE CreatedById = '${RUN_USER}' AND CreatedDate >= 2026-11-13T02:19:44Z ` +
        'AND CreatedDate <= 2026-11-13T02:22:10Z LIMIT 2000',
    );
  });

  it('leaves a set one item of which names a record that is not the run’s: it reports that record too', async () => {
    const org = orgOf([set(1)], [item(1, 1, id('003', 1)), item(2, 1, id('003', 9))]);

    expect(await duplicateSetsOf(org, run)).toEqual([]);
  });

  it('reads a set the platform restamped as the run’s user as it reported into it unchanged since the run, and one someone else changed by its date', async () => {
    const soonAfter = '2026-11-13T02:21:12.000+0000';
    const org = orgOf(
      [
        set(1, { LastModifiedDate: soonAfter }),
        set(2, { LastModifiedDate: soonAfter, LastModifiedById: COLLEAGUE }),
      ],
      [],
    );

    const [restamped, changed] = await duplicateSetsOf(org, run);

    expect(restamped?.modified).toBe(END);
    expect(changed?.modified).toBe(Date.parse(soonAfter));
  });

  it('tells none when the org will not read its sets, or a read fills its limit', async () => {
    expect(await duplicateSetsOf(orgOf([set(1)], [], /DuplicateRecordSet/), run)).toEqual([]);
    const many = Array.from({ length: 2_000 }, (_, n) => set(n + 1));
    expect(await duplicateSetsOf(orgOf(many, []), run)).toEqual([]);
  });

  it('reads nothing for a run whose span or user is not told', async () => {
    const org = orgOf([set(1)], []);

    expect(await duplicateSetsOf(org, { ...run, end: Number.NaN })).toEqual([]);
    expect(await duplicateSetsOf(org, { ...run, user: 'not an id' })).toEqual([]);
    expect(org.asked).toEqual([]);
  });
});
