import { describe, expect, it, vi } from 'vitest';

import {
  changedSinceRun,
  mergedById,
  rowsToRestore,
  sameValue,
  withoutRecords,
} from './restoreDiff.js';

/** A fake contact id, the length of a real one. */
const contactId = (n: number): string => `003${String(n).padStart(12, '0')}AAA`;

/**
 * An org that answers a read by Id with the rows it holds, each with the
 * columns the read names; the statements it was sent are kept.
 */
function orgHolding(rows: Array<Record<string, unknown>>) {
  const sent: string[] = [];
  const query = vi.fn(async (soql: string) => {
    sent.push(soql);
    const match = /^SELECT (.+) FROM \w+ WHERE Id IN \((.*)\)$/.exec(soql);
    if (!match) throw new Error(`unexpected query: ${soql}`);
    const columns = match[1].split(', ');
    const wanted = new Set(match[2].split(', ').map((quoted) => quoted.slice(1, -1)));
    const records = rows
      .filter((row) => wanted.has(String(row.Id)))
      .map((row) => Object.fromEntries(columns.map((column) => [column, row[column] ?? null])));
    return { totalSize: records.length, records };
  });
  return { query, sent };
}

describe('sameValue', () => {
  it('takes an empty value for the same whether the answer leaves it out or says null', () => {
    expect(sameValue(null, undefined)).toBe(true);
    expect(sameValue(undefined, null)).toBe(true);
    expect(sameValue('', null)).toBe(false);
  });

  it('takes a number and its text for the same value, and two texts that differ for two', () => {
    expect(sameValue(1200, '1200')).toBe(true);
    expect(sameValue(true, 'true')).toBe(true);
    expect(sameValue('Manager', 'Director')).toBe(false);
    expect(sameValue('Manager', null)).toBe(false);
  });

  it('compares a compound value whole', () => {
    expect(sameValue({ city: 'Lyon' }, { city: 'Lyon' })).toBe(true);
    expect(sameValue({ city: 'Lyon' }, { city: 'Nantes' })).toBe(false);
  });
});

describe('rowsToRestore', () => {
  it('writes only the rows whose record the org no longer holds with every value, and counts the rest', async () => {
    const backup = [1, 2, 3, 4].map((n) => ({
      Id: contactId(n),
      LastName: `C${n}`,
      Title: 'Lead',
    }));
    const { query } = orgHolding([
      { Id: contactId(1), LastName: 'C1', Title: 'Lead' },
      { Id: contactId(2), LastName: 'C2', Title: 'Changed since' },
      { Id: contactId(3), LastName: 'C3', Title: 'Lead' },
      { Id: contactId(4), LastName: 'C4', Title: null },
    ]);

    const outcome = await rowsToRestore({ query }, 'Contact', backup);

    expect(outcome.write.map((row) => row.Id)).toEqual([contactId(2), contactId(4)]);
    expect(outcome.unchanged).toBe(2);
    expect(outcome.unread).toBeUndefined();
    // One read by Id, of the fields the restore would write.
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toMatch(/^SELECT Id, LastName, Title FROM Contact WHERE Id IN /);
  });

  it('writes a row whose record the read did not find, for the org to say what became of it', async () => {
    const backup = [{ Id: contactId(1), LastName: 'Gone' }];

    const outcome = await rowsToRestore(orgHolding([]), 'Contact', backup);

    expect(outcome).toEqual({ write: backup, unchanged: 0 });
  });

  it('writes every row, and says why, when the org cannot be read', async () => {
    const backup = [{ Id: contactId(1), LastName: 'C1' }];
    const query = vi.fn().mockRejectedValue(new Error("No such column 'Retired__c'"));

    const outcome = await rowsToRestore({ query }, 'Contact', backup);

    expect(outcome).toEqual({ write: backup, unchanged: 0, unread: "No such column 'Retired__c'" });
  });

  it('reads a wide object a few columns at a time, each read short of what a URL holds, and compares every field', async () => {
    const fields = Array.from({ length: 400 }, (_, n) => `Custom_Field_Number_${n}__c`);
    const row = (n: number, last: string) => ({
      Id: contactId(n),
      ...Object.fromEntries(fields.map((field) => [field, 'same'])),
      [fields[399]]: last,
    });
    const { query, sent } = orgHolding([row(1, 'same'), row(2, 'changed since')]);

    const outcome = await rowsToRestore({ query }, 'Contact', [row(1, 'same'), row(2, 'same')]);

    expect(outcome.write.map((r) => r.Id)).toEqual([contactId(2)]);
    expect(outcome.unchanged).toBe(1);
    expect(sent.length).toBeGreaterThan(1);
    for (const soql of sent) expect(encodeURIComponent(soql).length).toBeLessThan(16_000);
  });

  it('writes a row without an Id as it is, and reads nothing for a batch without one', async () => {
    const { query } = orgHolding([]);

    const outcome = await rowsToRestore({ query }, 'Contact', [{ LastName: 'No id' }]);

    expect(outcome).toEqual({ write: [{ LastName: 'No id' }], unchanged: 0 });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('mergedById', () => {
  /** A backup's lines of one object, read again each time they are gone through. */
  const linesOf = (...batches: Array<Array<Record<string, unknown>>>) => ({
    async *[Symbol.asyncIterator]() {
      for (const batch of batches) yield batch;
    },
  });

  /** Every batch of a pass, as the restore goes through them. */
  async function passOf(
    rows: AsyncIterable<Array<Record<string, unknown>>>,
  ): Promise<Array<Array<Record<string, unknown>>>> {
    const batches: Array<Array<Record<string, unknown>>> = [];
    for await (const batch of rows) batches.push(batch);
    return batches;
  }

  it('holds each record once, each field as the first line that holds it kept it', async () => {
    // An update kept the name and the title; the pass that set a lookup kept
    // the account and the name again, as the update had written it.
    const merged = mergedById(
      linesOf(
        [{ Id: contactId(1), Name: 'Before', Title: 'Buyer' }],
        [{ Id: contactId(1).slice(0, 15), Name: 'Written by the run', AccountId: null }],
      ),
      200,
    );

    expect(await passOf(merged.batches)).toEqual([
      [{ Id: contactId(1), Name: 'Before', Title: 'Buyer', AccountId: null }],
    ]);
    expect(merged.lines()).toBe(2);
  });

  it('hands the records on a batch of the size asked at a time, and as often as asked', async () => {
    const merged = mergedById(
      linesOf(
        [1, 2, 3].map((n) => ({ Id: contactId(n), Name: `Before ${n}` })),
        [{ Id: contactId(2), Name: 'Again' }],
      ),
      2,
    );

    const first = await passOf(merged.batches);
    const second = await passOf(merged.batches);

    expect(first.map((batch) => batch.map((row) => row.Name))).toEqual([
      ['Before 1', 'Before 2'],
      ['Before 3'],
    ]);
    expect(second).toEqual(first);
    expect(merged.lines()).toBe(4);
  });

  it('keeps a line that names no record as it is, for the org to answer', async () => {
    const merged = mergedById(linesOf([{ Name: 'No id' }, { Id: 'not-an-id', Name: 'Odd' }]), 200);

    expect(await passOf(merged.batches)).toEqual([
      [{ Name: 'No id' }, { Id: 'not-an-id', Name: 'Odd' }],
    ]);
  });
});

describe('changedSinceRun', () => {
  const RUN_END = Date.parse('2026-10-20T10:00:00.000Z');

  /** An org holding contacts with when each was last modified, and those in its recycle bin. */
  function orgSince(held: Record<string, string>, binned: string[] = []) {
    const query = vi.fn(async (soql: string, options?: { scanAll?: boolean }) => {
      const asked = new Set(
        (/Id IN \((.*)\)/.exec(soql)?.[1] ?? '').split(', ').map((quoted) => quoted.slice(1, -1)),
      );
      if (soql.endsWith('AND IsDeleted = true')) {
        const records = options?.scanAll ? binned.filter((id) => asked.has(id)) : [];
        return { records: records.map((Id) => ({ Id })) };
      }
      return {
        records: Object.entries(held)
          .filter(([id]) => asked.has(id))
          .map(([Id, LastModifiedDate]) => ({ Id, LastModifiedDate })),
      };
    });
    return { query };
  }

  it('names the records modified after the run ended and those deleted since, by their first fifteen characters', async () => {
    const org = orgSince(
      {
        [contactId(1)]: '2026-10-20T09:59:00.000+0000',
        [contactId(2)]: '2026-10-20T10:00:01.000+0000',
      },
      [contactId(3)],
    );

    const changed = await changedSinceRun(
      org,
      'Contact',
      [contactId(1), contactId(2), contactId(3), contactId(4)],
      RUN_END,
    );

    expect([...changed]).toEqual([contactId(2).slice(0, 15), contactId(3).slice(0, 15)]);
    // Only the records the read did not find are looked for in the bin.
    expect(org.query.mock.calls[1]?.[0]).toContain(`'${contactId(3)}', '${contactId(4)}'`);
    expect(org.query.mock.calls[1]?.[0]).not.toContain(contactId(1));
  });

  it('reads every record the org holds as changed since a run whose end is unknown', async () => {
    const org = orgSince({ [contactId(1)]: '2020-01-01T00:00:00.000+0000' });

    const changed = await changedSinceRun(org, 'Contact', [contactId(1)], Number.NEGATIVE_INFINITY);

    expect([...changed]).toEqual([contactId(1).slice(0, 15)]);
  });

  it('reads two hundred records a query', async () => {
    const ids = Array.from({ length: 250 }, (_, n) => contactId(n + 1));
    const org = orgSince(Object.fromEntries(ids.map((id) => [id, '2026-10-20T09:00:00.000+0000'])));

    expect(await changedSinceRun(org, 'Contact', ids, RUN_END)).toEqual(new Set());
    expect(org.query).toHaveBeenCalledTimes(2);
  });
});

describe('withoutRecords', () => {
  it('leaves out the rows of the records named, each time the rows are gone through', async () => {
    const rows = {
      async *[Symbol.asyncIterator]() {
        yield [{ Id: contactId(1) }, { Id: contactId(2) }];
        yield [{ Id: contactId(3).slice(0, 15) }];
      },
    };
    const left = withoutRecords(
      rows,
      new Set([contactId(2).slice(0, 15), contactId(3).slice(0, 15)]),
    );
    const pass = async (): Promise<unknown[][]> => {
      const batches: unknown[][] = [];
      for await (const batch of left) batches.push(batch);
      return batches;
    };

    expect(await pass()).toEqual([[{ Id: contactId(1) }]]);
    expect(await pass()).toEqual([[{ Id: contactId(1) }]]);
  });
});
