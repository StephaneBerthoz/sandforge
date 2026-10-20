import { describe, expect, it, vi } from 'vitest';

import { rowsToRestore, sameValue } from './restoreDiff.js';

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
