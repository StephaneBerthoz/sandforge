import { describe, it, expect, vi } from 'vitest';
import type { ForgeRunObjectRecords } from '@sandforge/shared';
import { removeRunRecords, type RunRecords } from './ForgeRunRemoval.js';
import { MemoryRemovalOrg } from '../../test/memoryRemovalOrg.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * A removal handed its records a page at a time, as it reads a run past the
 * summary's bound from its journal: it takes, keeps and refuses what the same
 * removal handed them in memory does, and leaves the same records.
 */

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

/** Minutes before now, as the org dates a record. */
const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString();

const ACCOUNTS = Array.from({ length: 7 }, (_, n) => fakeId('001', n));
const CONTACTS = Array.from({ length: 9 }, (_, n) => fakeId('003', n));

/**
 * The target as a run of seven accounts and nine contacts under them left it,
 * ten minutes ago, since when a contact was changed, another deleted, and an
 * account is one the org will not delete.
 */
function target(): MemoryRemovalOrg {
  const org = new MemoryRemovalOrg({
    Account: [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: true }],
  });
  const at = minutesAgo(10);
  for (const id of ACCOUNTS) org.add('Account', { Id: id }, at);
  CONTACTS.forEach((id, n) => org.add('Contact', { Id: id, AccountId: ACCOUNTS[n % 7] }, at));
  org.touch('Contact', CONTACTS[3], minutesAgo(1));
  void org.destroy('Contact', [CONTACTS[5]]);
  org.deletes.length = 0;
  org.refuse.set(ACCOUNTS[2], 'This account is held by a process the org runs.');
  return org;
}

/** What the run created, children first, the last written first. */
const PLAN: ForgeRunObjectRecords[] = [
  { objectApiName: 'Contact', ids: [...CONTACTS].reverse() },
  { objectApiName: 'Account', ids: [...ACCOUNTS].reverse() },
];

/** `plan` handed over `size` records a page. */
function inPages(plan: readonly ForgeRunObjectRecords[], size: number): RunRecords {
  const keys = new Set(plan.flatMap(({ ids }) => ids.map((id) => id.slice(0, 15))));
  return {
    objects: plan.map(({ objectApiName, ids }) => ({ objectApiName, count: ids.length })),
    pages: async function* (objectApiName) {
      const ids = plan.find((object) => object.objectApiName === objectApiName)?.ids ?? [];
      for (let at = 0; at < ids.length; at += size) yield ids.slice(at, at + size);
    },
    has: (key) => keys.has(key),
  };
}

/** The records a removal says it left, per object, each object's ids sorted. */
async function leftBy(outcome: Awaited<ReturnType<typeof removeRunRecords>>) {
  const left = new Map<string, string[]>();
  for await (const { objectApiName, ids } of outcome.left()) {
    left.set(objectApiName, [...(left.get(objectApiName) ?? []), ...ids]);
  }
  return new Map([...left].map(([object, ids]) => [object, [...ids].sort()]));
}

const OPTIONS = {
  runStartedAt: new Date(Date.now() - 11 * 60_000),
  runEndedAt: new Date(Date.now() - 9 * 60_000),
  includeChanged: false,
};

describe('a removal handed its records a page at a time', () => {
  it.each([1, 2, 3])(
    'takes, keeps and refuses what it does handed them whole, and leaves the same, in pages of %i',
    async (size) => {
      const wholeOrg = target();
      const whole = await removeRunRecords(wholeOrg, PLAN, OPTIONS);
      const pagedOrg = target();
      const paged = await removeRunRecords(pagedOrg, inPages(PLAN, size), OPTIONS);

      expect(paged.objects).toEqual(whole.objects);
      expect(paged.cancelled).toBe(false);
      // The changed contact, its account, and the account the org refuses.
      expect(await leftBy(paged)).toEqual(await leftBy(whole));
      expect(await leftBy(paged)).toEqual(
        new Map([
          ['Contact', [CONTACTS[3]]],
          ['Account', [ACCOUNTS[2], ACCOUNTS[3]].sort()],
        ]),
      );
      expect(pagedOrg.all('Contact').map((row) => row.Id)).toEqual([CONTACTS[3]]);
      expect(
        pagedOrg
          .all('Account')
          .map((row) => row.Id)
          .sort(),
      ).toEqual([ACCOUNTS[2], ACCOUNTS[3]].sort());
      // Handed over in pages, the records taken are not gathered: what is left is read.
      expect(paged.gone).toEqual([]);
      expect([...whole.gone].sort()).toEqual(
        [...CONTACTS, ...ACCOUNTS]
          .filter((id) => ![CONTACTS[3], ACCOUNTS[2], ACCOUNTS[3]].includes(id))
          .sort(),
      );
    },
  );

  it('leaves, once cancelled part way through an object, every record of the run still in the org', async () => {
    const org = target();
    const stop = new AbortController();
    let deletes = 0;
    org.beforeDelete = () => {
      if (++deletes === 3) stop.abort();
    };

    const outcome = await removeRunRecords(org, inPages(PLAN, 2), {
      ...OPTIONS,
      signal: stop.signal,
    });

    expect(outcome.cancelled).toBe(true);
    const stillThere = new Map([
      [
        'Contact',
        org
          .all('Contact')
          .map((row) => row.Id)
          .sort(),
      ],
      [
        'Account',
        org
          .all('Account')
          .map((row) => row.Id)
          .sort(),
      ],
    ]);
    expect(await leftBy(outcome)).toEqual(stillThere);
    expect(stillThere.get('Account')).toHaveLength(7);
  });
});
