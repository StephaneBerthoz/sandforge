import { describe, expect, it } from 'vitest';

import { duplicateSetsOf } from './duplicateRecordSets.js';

/** A fake record id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const RUN_USER = id('005', 1);
const COLLEAGUE = id('005', 2);
/** The org's Automated Process user, who creates the sets a rule makes. */
const AUTOMATED = id('005', 3);
const START = Date.parse('2026-11-13T02:19:46.000Z');
const END = Date.parse('2026-11-13T02:21:10.000Z');
const DURING = '2026-11-13T02:20:30.000+0000';

/** The run's records: two contacts and a lead. */
const RUN = new Set([id('003', 1), id('003', 2), id('00Q', 1)].map((x) => x.slice(0, 15)));
const run = { has: (key: string) => RUN.has(key), start: START, end: END, user: RUN_USER };

/**
 * An org answering the two reads a removal sends, as a scratch org answers
 * them: the sets created in the window — by the user a read names, when it
 * names one — then their items.
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
      if (soql.includes('FROM DuplicateRecordSet ')) {
        const by = /CreatedById = '(\w+)'/.exec(soql)?.[1];
        return { records: sets.filter((s) => by === undefined || s.CreatedById === by) };
      }
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
  CreatedById: AUTOMATED,
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
  it('takes the sets made in the run’s window whose every item names a record of the run, whoever created them', async () => {
    // Live, the target's Lead and Contact rules made two sets of a clone's
    // records, created by the org's Automated Process user, the run's user
    // their last modifier only; read by their creator, the removal took
    // neither, and both stayed, empty.
    const org = orgOf(
      [set(1), set(2, { CreatedById: RUN_USER }), set(3)],
      [
        item(1, 1, id('003', 1)),
        item(2, 1, id('003', 2)),
        item(3, 2, id('003', 2)),
        item(4, 3, id('00Q', 1)),
      ],
    );

    const sets = await duplicateSetsOf(org, run);

    expect(sets.map((s) => s.id)).toEqual([id('0GK', 1), id('0GK', 2), id('0GK', 3)]);
    // Asked in its window, a lead before the first write and a minute after
    // the last, of any creator.
    expect(org.asked[0]).toBe(
      'SELECT Id, CreatedDate, LastModifiedDate, LastModifiedById FROM DuplicateRecordSet ' +
        'WHERE CreatedDate >= 2026-11-13T02:19:44Z ' +
        'AND CreatedDate <= 2026-11-13T02:22:10Z LIMIT 2000',
    );
  });

  it('takes an emptied set the run’s user last modified, and leaves one someone else did', async () => {
    // A set whose records are gone holds no item: only its last modifier,
    // restamped as records leave it, ties it to the run.
    const org = orgOf([set(1), set(2, { LastModifiedById: COLLEAGUE })], []);

    const sets = await duplicateSetsOf(org, run);

    expect(sets.map((s) => s.id)).toEqual([id('0GK', 1)]);
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
      [item(1, 1, id('003', 1)), item(2, 2, id('003', 2))],
    );

    const [restamped, changed] = await duplicateSetsOf(org, run);

    expect(restamped?.modified).toBe(END);
    expect(changed?.modified).toBe(Date.parse(soonAfter));
  });

  it('reads a set the platform made after the run’s last write, modified by no one since, unchanged since the run; one modified since, by its date', async () => {
    // Run for real: the run saved its contacts by REST at 14:50:46–47 and
    // was killed, its part ending at 14:50:48; the Automated Process made
    // their set at 14:50:53, its last modifier, and no one touched it since.
    // Read by its own date, the removal kept it, empty, as changed since.
    const end = Date.parse('2026-11-13T14:50:48.000Z');
    const made = '2026-11-13T14:50:53.000+0000';
    const ofThisRun = { ...run, start: Date.parse('2026-11-13T14:49:42.000Z'), end };
    const org = orgOf(
      [
        set(1, { CreatedDate: made, LastModifiedDate: made, LastModifiedById: AUTOMATED }),
        // The same, modified again after it was made: a change since the run.
        set(2, {
          CreatedDate: made,
          LastModifiedDate: '2026-11-13T14:50:58.000+0000',
          LastModifiedById: AUTOMATED,
        }),
        // Made alike, reporting a record that is not the run's too: not taken.
        set(3, { CreatedDate: made, LastModifiedDate: made, LastModifiedById: AUTOMATED }),
      ],
      [
        item(1, 1, id('003', 1)),
        item(2, 1, id('003', 2)),
        item(3, 2, id('003', 1)),
        item(4, 3, id('003', 2)),
        item(5, 3, id('003', 9)),
      ],
    );

    const sets = await duplicateSetsOf(org, ofThisRun);

    expect(sets).toEqual([
      { id: id('0GK', 1), modified: end },
      { id: id('0GK', 2), modified: Date.parse('2026-11-13T14:50:58.000Z') },
    ]);
  });

  it('reads a set made in the second the run ended and last modified as its items were made the next unchanged since the run; one modified past its items, by its date', async () => {
    // Run for real: the run's contacts and its end at 20:00:37; the
    // Automated Process made their set at 20:00:37 and its two items at
    // 20:00:38. Read by its own date, the removal kept it, empty.
    const end = Date.parse('2026-11-13T20:00:37.000Z');
    const at = (time: string) => `2026-11-13T${time}.000+0000`;
    const byTheOrg = { CreatedDate: at('20:00:37'), LastModifiedById: AUTOMATED };
    const org = orgOf(
      [
        set(1, { ...byTheOrg, LastModifiedDate: at('20:00:38') }),
        // Modified again after its items were made: a change since the run.
        set(2, { ...byTheOrg, LastModifiedDate: at('20:00:41') }),
      ],
      [
        { ...item(1, 1, id('003', 1)), CreatedDate: at('20:00:38') },
        { ...item(2, 1, id('003', 2)), CreatedDate: at('20:00:38') },
        { ...item(3, 2, id('003', 1)), CreatedDate: at('20:00:38') },
      ],
    );

    const sets = await duplicateSetsOf(org, { ...run, end });

    expect(sets).toEqual([
      { id: id('0GK', 1), modified: end },
      { id: id('0GK', 2), modified: Date.parse(at('20:00:41')) },
    ]);
    // Its items are read with when they were made.
    expect(org.asked[1]).toContain('SELECT Id, RecordId, DuplicateRecordSetId, CreatedDate FROM');
  });

  it('reads by its own date a set made past the minute after the run’s end, modified by no one since', async () => {
    const end = Date.parse('2026-11-13T14:50:48.000Z');
    const late = '2026-11-13T14:51:49.000+0000';
    const org = orgOf(
      [set(1, { CreatedDate: late, LastModifiedDate: late, LastModifiedById: AUTOMATED })],
      [item(1, 1, id('003', 1))],
    );

    expect((await duplicateSetsOf(org, { ...run, end })).map((s) => s.modified)).toEqual([
      Date.parse(late),
    ]);
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
