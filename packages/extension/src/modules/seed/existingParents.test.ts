import { describe, it, expect, vi } from 'vitest';
import { readExistingParentIds } from './existingParents';

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
