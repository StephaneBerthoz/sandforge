import { describe, expect, it } from 'vitest';
import { undeleteLeftOver, undeleteRunDeletions } from './SyncRunUndelete';
import { MemoryRemovalOrg } from '../../test/memoryRemovalOrg';

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const C1 = fakeId('003', 1);
const C2 = fakeId('003', 2);
const C3 = fakeId('003', 3);
const C4 = fakeId('003', 4);

/** The target once a delta run deleted four contacts the source had deleted. */
function target(): MemoryRemovalOrg {
  const org = new MemoryRemovalOrg();
  for (const id of [C1, C2, C3, C4]) {
    org.add('Contact', { Id: id, LastName: `Held ${id.slice(-6, -3)}` });
    org.trash('Contact', id);
  }
  return org;
}

describe('undeleteRunDeletions', () => {
  it('brings back from the recycle bin what the run deleted, and counts what it could not', async () => {
    const org = target();
    // Since the run: one emptied from the bin, one brought back by someone.
    org.purge(C3);
    await org.undelete([C4]);

    const outcome = await undeleteRunDeletions({
      org,
      plan: [{ objectApiName: 'Contact', ids: [C1, C2, C3, C4] }],
      undelete: (ids) => org.undelete(ids),
    });

    expect(outcome.objects).toEqual([
      {
        objectApiName: 'Contact',
        planned: 4,
        undeleted: 2,
        alreadyBack: 1,
        goneForGood: 1,
        refused: 0,
        reasons: [],
      },
    ]);
    expect(outcome.left).toEqual([]);
    expect(outcome.wrote).toBe(true);
    expect(
      org
        .all('Contact')
        .map((row) => row.Id)
        .sort(),
    ).toEqual([C1, C2, C4]);
    expect(undeleteLeftOver(outcome.objects[0])).toBe(1);
  });

  it('keeps what the org refused to bring back for the next removal, with why', async () => {
    const org = target();

    const outcome = await undeleteRunDeletions({
      org,
      plan: [{ objectApiName: 'Contact', ids: [C1, C2] }],
      undelete: async (ids) =>
        ids.map((id) =>
          id === C2
            ? {
                success: false,
                errors: [{ statusCode: 'UNDELETE_FAILED', message: 'a parent is deleted' }],
              }
            : { success: true },
        ),
    });

    expect(outcome.objects[0]).toMatchObject({
      undeleted: 1,
      refused: 1,
      reasons: ['UNDELETE_FAILED: a parent is deleted'],
    });
    expect(outcome.left).toEqual([C2]);
  });

  it('says back the date it gives the records an earlier run names, for that run to read as no change since it', async () => {
    const org = target();

    const outcome = await undeleteRunDeletions({
      org,
      plan: [{ objectApiName: 'Contact', ids: [C1, C2] }],
      undelete: (ids) => org.undelete(ids),
      stampsFor: (id) => id === C1,
    });

    const back = org.all('Contact').find((row) => row.Id === C1);
    expect(outcome.stamps).toEqual({ [C1]: back?.LastModifiedDate });
  });

  it('brings back nothing once stopped, and keeps it all for the next removal', async () => {
    const org = target();
    const stop = new AbortController();
    stop.abort();

    const outcome = await undeleteRunDeletions({
      org,
      plan: [{ objectApiName: 'Contact', ids: [C1, C2] }],
      undelete: (ids) => org.undelete(ids),
      signal: stop.signal,
    });

    expect(outcome).toMatchObject({ cancelled: true, wrote: false, left: [C1, C2] });
    expect(outcome.objects[0]).toMatchObject({ undeleted: 0, notReached: 2 });
    expect(org.all('Contact')).toEqual([]);
  });
});
