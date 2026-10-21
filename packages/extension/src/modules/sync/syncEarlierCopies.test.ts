import { describe, it, expect, vi } from 'vitest';
import type { SyncRunKept } from './SyncRunCreations.js';
import { EARLIER_COPIES_CHECKED, earlierCopiesOf } from './syncEarlierCopies.js';

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

function run(overrides: Partial<SyncRunKept> = {}): SyncRunKept {
  return {
    runId: 'run-1',
    configId: 'quick-1',
    configName: 'Quick Sync',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    startedAt: '2026-10-14T09:00:00.000Z',
    created: [
      { objectApiName: 'Account', ids: [fakeId('001', 1), fakeId('001', 2)] },
      { objectApiName: 'Contact', ids: [fakeId('003', 1), fakeId('003', 2), fakeId('003', 3)] },
    ],
    ...overrides,
  };
}

const ASKED = {
  sourceOrgId: 'src-org',
  targetOrgId: 'tgt-org',
  objects: ['Account', 'Contact'],
};

describe('earlierCopiesOf', () => {
  it('counts what the last run between the two orgs created that the target still holds', async () => {
    const countInTarget = vi.fn(async (object: string, ids: readonly string[]) =>
      object === 'Contact' ? ids.length - 1 : ids.length,
    );

    const copies = await earlierCopiesOf(ASKED, {
      runs: async () => [run(), run({ runId: 'run-0', startedAt: '2026-10-07T09:00:00.000Z' })],
      isSaved: () => false,
      countInTarget,
    });

    expect(copies).toEqual({
      leftAsIs: false,
      run: { runId: 'run-1', configName: 'Quick Sync', startedAt: '2026-10-14T09:00:00.000Z' },
      objects: [
        { objectApiName: 'Account', count: 2 },
        { objectApiName: 'Contact', count: 2 },
      ],
    });
    expect(countInTarget).toHaveBeenCalledTimes(2);
  });

  it('says a saved configuration leaves its earlier copies as they are, asking nothing', async () => {
    const runs = vi.fn();

    const copies = await earlierCopiesOf(
      { ...ASKED, configId: 'cfg-saved' },
      { runs, isSaved: (id) => id === 'cfg-saved', countInTarget: vi.fn() },
    );

    expect(copies).toEqual({ leftAsIs: true, objects: [] });
    expect(runs).not.toHaveBeenCalled();
  });

  it('passes over a run of other orgs, and one whose records a removal took', async () => {
    const copies = await earlierCopiesOf(ASKED, {
      runs: async () => [
        run({ runId: 'other-pair', targetOrgId: 'other-org' }),
        run({
          runId: 'removed',
          removal: {
            undo: {
              removedAt: '2026-10-14T10:00:00.000Z',
              deleted: 5,
              alreadyGone: 0,
              kept: 0,
              refused: 0,
            },
          },
        }),
        run({ runId: 'older', created: [{ objectApiName: 'Account', ids: [fakeId('001', 7)] }] }),
      ],
      isSaved: () => false,
      countInTarget: async (_object, ids) => ids.length,
    });

    expect(copies.run?.runId).toBe('older');
    expect(copies.objects).toEqual([{ objectApiName: 'Account', count: 1 }]);
  });

  it('counts what the run kept when the target cannot be asked, and says why', async () => {
    const copies = await earlierCopiesOf(ASKED, {
      runs: async () => [run()],
      isSaved: () => false,
      countInTarget: async () => {
        throw new Error('INVALID_SESSION_ID');
      },
    });

    expect(copies.objects).toEqual([
      { objectApiName: 'Account', count: 2 },
      { objectApiName: 'Contact', count: 3 },
    ]);
    expect(copies.unread).toBe('INVALID_SESSION_ID');
  });

  it('asks the target of at most so many records an object, counting the rest as kept', async () => {
    const ids = Array.from({ length: EARLIER_COPIES_CHECKED + 5 }, (_, n) => fakeId('001', n));
    const countInTarget = vi.fn(async (_object: string, asked: readonly string[]) => asked.length);

    const copies = await earlierCopiesOf(
      { ...ASKED, objects: ['Account'] },
      {
        runs: async () => [run({ created: [{ objectApiName: 'Account', ids }] })],
        isSaved: () => false,
        countInTarget,
      },
    );

    expect(countInTarget.mock.calls[0][1]).toHaveLength(EARLIER_COPIES_CHECKED);
    expect(copies.objects).toEqual([{ objectApiName: 'Account', count: ids.length }]);
  });
});
