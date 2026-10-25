import { describe, it, expect, vi } from 'vitest';
import type { SeedRelation } from '@sandforge/shared';
import {
  readExistingParentIds,
  readPresentParentIds,
  recordParentsRefusals,
} from './existingParents';

/** One page of a query answer, as jsforce resolves it. */
function page(ids: string[], nextRecordsUrl?: string) {
  return {
    records: ids.map((Id) => ({ attributes: { type: 'Account' }, Id })),
    done: nextRecordsUrl === undefined,
    totalSize: ids.length,
    ...(nextRecordsUrl ? { nextRecordsUrl } : {}),
  };
}

/** A connection answering the queries it is sent with the pages given, in order. */
function orgAnswering(...pages: Array<ReturnType<typeof page>>) {
  const answers = [...pages];
  return {
    query: vi.fn(async () => answers.shift()),
    queryMore: vi.fn(async () => answers.shift()),
  };
}

describe('readExistingParentIds', () => {
  it('reads the ids of the records the filter matches, bounded by the relation', async () => {
    const conn = orgAnswering(page(['001A', '001B']));

    const ids = await readExistingParentIds(conn as never, 'Account', "Industry = 'Energy'", 10);

    expect(ids).toEqual(['001A', '001B']);
    expect(conn.query).toHaveBeenCalledWith(
      "SELECT Id FROM Account WHERE Industry = 'Energy' LIMIT 10",
    );
  });

  it('reads any record of the object when the relation names no filter', async () => {
    const conn = orgAnswering(page(['001A']));

    await readExistingParentIds(conn as never, 'Account', '   ', 5);

    expect(conn.query).toHaveBeenCalledWith('SELECT Id FROM Account LIMIT 5');
  });

  it('follows the cursor when the org sends the records over several pages', async () => {
    const conn = orgAnswering(page(['001A', '001B'], '/next-1'), page(['001C']));

    const ids = await readExistingParentIds(conn as never, 'Account', undefined, 3);

    expect(ids).toEqual(['001A', '001B', '001C']);
    expect(conn.queryMore).toHaveBeenCalledWith('/next-1');
  });

  it('refuses a filter that does more than filter, before anything is sent', async () => {
    const conn = orgAnswering(page(['001A']));

    await expect(
      readExistingParentIds(conn as never, 'Account', 'Name != null LIMIT 1', 10),
    ).rejects.toThrow(/WHERE clause/);
    expect(conn.query).not.toHaveBeenCalled();
  });

  it('refuses an object name that is not one, before anything is sent', async () => {
    const conn = orgAnswering(page(['001A']));

    await expect(
      readExistingParentIds(conn as never, 'Account WHERE Id != null', undefined, 10),
    ).rejects.toThrow(/Invalid Salesforce API name/);
    expect(conn.query).not.toHaveBeenCalled();
  });

  it('refuses to read without a bound the relation allows', async () => {
    const conn = orgAnswering(page(['001A']));

    for (const limit of [0, 2.5, 2001]) {
      await expect(
        readExistingParentIds(conn as never, 'Account', undefined, limit),
      ).rejects.toThrow(/between 1 and 2000/);
    }
    expect(conn.query).not.toHaveBeenCalled();
  });
});

/** A fake account id: the prefix, then a counter. */
const account = (n: number): string => `001${String(n).padStart(12, '0')}AAA`;

describe('readPresentParentIds', () => {
  it('asks the org for the ids given, two hundred to a query, and gives back those it holds', async () => {
    const ids = Array.from({ length: 201 }, (_, n) => account(n + 1));
    const conn = orgAnswering(page(ids.slice(0, 199)), page([ids[200]]));

    const present = await readPresentParentIds(conn as never, 'Account', ids);

    expect(present).toEqual([...ids.slice(0, 199), ids[200]]);
    expect(conn.query).toHaveBeenCalledTimes(2);
    expect(conn.query.mock.calls[0]).toEqual([
      `SELECT Id FROM Account WHERE Id IN (${ids
        .slice(0, 200)
        .map((id) => `'${id}'`)
        .join(', ')})`,
    ]);
    expect(conn.query.mock.calls[1]).toEqual([
      `SELECT Id FROM Account WHERE Id IN ('${ids[200]}')`,
    ]);
  });

  it('refuses what is not a record id before anything is sent', async () => {
    const conn = orgAnswering(page([]));

    await expect(
      readPresentParentIds(conn as never, 'Account', [account(1), "001') OR (Id != '"]),
    ).rejects.toThrow(/Not a record id/);
    expect(conn.query).not.toHaveBeenCalled();
  });
});

describe('recordParentsRefusals', () => {
  /** Three contacts under each account named. */
  const relation = (ids: string[]): SeedRelation => ({
    childObject: 'Contact',
    lookupField: 'AccountId',
    parentObject: 'Account',
    parents: { kind: 'records', ids },
    distribution: { mode: 'perParent', count: 3 },
  });

  it('lets a relation through when every record it names is in the org, as the org writes ids or in 15 characters', async () => {
    const presentIds = vi.fn(async () => [account(1), account(2)]);

    const refusals = await recordParentsRefusals(
      [relation([account(1), account(2).slice(0, 15)])],
      { keyPrefixOf: async () => '001', presentIds },
    );

    expect(refusals).toEqual([]);
    expect(presentIds).toHaveBeenCalledWith('Account', [account(1), account(2).slice(0, 15)]);
  });

  it('names the records no longer in the org, and what to do', async () => {
    const refusals = await recordParentsRefusals([relation([account(1), account(2), account(3)])], {
      keyPrefixOf: async () => '001',
      presentIds: async () => [account(2)],
    });

    expect(refusals).toEqual([
      `2 of the 3 Account record(s) the relation on Contact.AccountId names are no longer in the ` +
        `org: ${account(1)}, ${account(3)}. Nothing was written. Run again what created them, or ` +
        'give the ids of Account records the org holds.',
    ]);
  });

  it('names the ids of another object than the parent, by the key prefix its describe gives, without asking the org for them', async () => {
    const presentIds = vi.fn(async () => []);
    const contact = `003${'0'.repeat(11)}1AAA`;

    const refusals = await recordParentsRefusals([relation([account(1), contact])], {
      keyPrefixOf: async () => '001',
      presentIds,
    });

    expect(refusals).toEqual([
      `The relation on Contact.AccountId names 1 id(s) that are not Account ids — the org's ` +
        `Account ids start with 001: ${contact}. Nothing was written. Give the ids of Account records.`,
    ]);
    expect(presentIds).not.toHaveBeenCalled();
  });

  it('checks presence alone where the describe gives no prefix, or cannot be read', async () => {
    for (const keyPrefixOf of [async () => undefined, async () => Promise.reject(new Error('x'))]) {
      const refusals = await recordParentsRefusals([relation([account(1)])], {
        keyPrefixOf,
        presentIds: async () => [],
      });
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toContain('no longer in the org');
    }
  });

  it('refuses what it cannot check: no reader, or a read that fails', async () => {
    expect(await recordParentsRefusals([relation([account(1)])], {})).toEqual([
      'This run cannot check that the 1 Account record(s) the relation on Contact.AccountId ' +
        'names are in the org. Nothing was written.',
    ]);
    expect(
      await recordParentsRefusals([relation([account(1)])], {
        presentIds: async () => Promise.reject(new Error('INVALID_SESSION_ID')),
      }),
    ).toEqual([
      'Reading the Account records the relation on Contact.AccountId names failed ' +
        '(INVALID_SESSION_ID). Nothing was written.',
    ]);
  });

  it('asks nothing of a relation whose parents are not named by id', async () => {
    const presentIds = vi.fn(async () => []);
    const refusals = await recordParentsRefusals(
      [
        { ...relation([]), parents: { kind: 'generated' } },
        { ...relation([]), parents: { kind: 'existing', limit: 10 } },
      ],
      { presentIds },
    );
    expect(refusals).toEqual([]);
    expect(presentIds).not.toHaveBeenCalled();
  });
});
