import { describe, expect, it, vi } from 'vitest';

import { MemoryRemovalOrg } from '../../test/memoryRemovalOrg.js';
import { recycleBinOf } from './recycleBin.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const ACCOUNTS = [fakeId('001', 1), fakeId('001', 2), fakeId('001', 3)];
const keys = (ids: readonly string[]): Set<string> => new Set(ids.map((id) => id.slice(0, 15)));

describe('recycleBinOf', () => {
  it('reads deleted the records the bin holds, and leaves out one found nowhere', async () => {
    const org = new MemoryRemovalOrg({});
    for (const id of ACCOUNTS) org.add('Account', { Id: id });
    org.trash('Account', ACCOUNTS[0]);
    org.trash('Account', ACCOUNTS[1]);
    org.purge(ACCOUNTS[1]);

    expect(await recycleBinOf(org, 'Account', ACCOUNTS)).toEqual({
      deleted: keys([ACCOUNTS[0]]),
      inBin: true,
    });
  });

  it('never says in the bin what a pass deleted for good, though queryAll reads it deleted as one there', async () => {
    // As probed live: a hard-deleted record still reads IsDeleted = true.
    const org = new MemoryRemovalOrg({}, { facts: { hardDeleteInQueryAll: true } });
    org.add('Account', { Id: ACCOUNTS[0] });
    org.hardDelete('Account', ACCOUNTS[0]);

    expect(await recycleBinOf(org, 'Account', [ACCOUNTS[0]])).toEqual({
      deleted: keys([ACCOUNTS[0]]),
      inBin: true,
    });
    expect(await recycleBinOf(org, 'Account', [ACCOUNTS[0]], 'hard')).toEqual({
      deleted: keys([ACCOUNTS[0]]),
      inBin: false,
    });
  });

  it('says why the bin could not be read, taking none of them for gone', async () => {
    const org = new MemoryRemovalOrg({});
    org.refuseRead.set('Account', { errorCode: 'INVALID_TYPE', message: 'no such object' });

    expect(await recycleBinOf(org, 'Account', ACCOUNTS)).toEqual({
      error: expect.stringContaining('no such object'),
    });
  });
});
