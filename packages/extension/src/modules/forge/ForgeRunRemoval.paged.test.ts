import { describe, it, expect, vi } from 'vitest';
import type { ForgeRunObjectRecords } from '@sandforge/shared';
import { removeRunRecords, type RunRecords } from './ForgeRunRemoval.js';
import { removalAuditObjects, removalStatus } from './removalOutcome.js';
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
    // Every record of the run is accounted for: settled, or not reached.
    for (const object of outcome.objects) {
      const settled =
        object.deleted +
        object.alreadyGone +
        object.keptChanged +
        object.keptDependents +
        object.refused +
        (object.notVisible ?? 0);
      expect(settled + (object.notReached ?? 0)).toBe(object.planned);
    }
    expect(outcome.objects.find((o) => o.objectApiName === 'Account')).toMatchObject({
      planned: 7,
      notReached: 7,
    });
  });

  it.each([0, 2])(
    'names, stopped between two objects, the one it never reached with its records, and the next removal takes them (pages of %i)',
    async (size) => {
      // Live: a Frozen removal stopped once its 12 100 contacts were gone
      // said "Contact: 12100 deleted" and nothing of the account it left;
      // only the next removal's plan named it.
      const org = new MemoryRemovalOrg({
        Account: [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: true }],
      });
      const at = minutesAgo(10);
      org.add('Account', { Id: ACCOUNTS[0] }, at);
      for (const id of CONTACTS.slice(0, 3))
        org.add('Contact', { Id: id, AccountId: ACCOUNTS[0] }, at);
      const plan: ForgeRunObjectRecords[] = [
        { objectApiName: 'Contact', ids: CONTACTS.slice(0, 3) },
        { objectApiName: 'Account', ids: [ACCOUNTS[0]] },
      ];
      const stop = new AbortController();

      const outcome = await removeRunRecords(org, size === 0 ? plan : inPages(plan, size), {
        ...OPTIONS,
        signal: stop.signal,
        onProgress: (settled, _total, objectApiName) => {
          if (objectApiName === 'Contact' && settled === 3) stop.abort();
        },
      });

      expect(outcome.cancelled).toBe(true);
      expect(outcome.objects).toEqual([
        expect.objectContaining({ objectApiName: 'Contact', planned: 3, deleted: 3 }),
        expect.objectContaining({
          objectApiName: 'Account',
          planned: 1,
          deleted: 0,
          notReached: 1,
        }),
      ]);
      expect(outcome.objects[0].notReached).toBeUndefined();
      expect(removalAuditObjects(outcome.objects)).toEqual([
        expect.objectContaining({ objectApiName: 'Contact', deleted: 3, failed: 0 }),
        expect.objectContaining({ objectApiName: 'Account', deleted: 0, failed: 0, notSent: 1 }),
      ]);
      expect(removalStatus(outcome.objects, outcome.cancelled)).toBe('cancelled');
      expect(org.all('Account').map((row) => row.Id)).toEqual([ACCOUNTS[0]]);
      expect(await leftBy(outcome)).toEqual(new Map([['Account', [ACCOUNTS[0]]]]));
    },
  );

  it('names every object of the plan as not reached when stopped before its first delete', async () => {
    const org = target();
    const stop = new AbortController();
    stop.abort();

    const outcome = await removeRunRecords(org, inPages(PLAN, 2), {
      ...OPTIONS,
      signal: stop.signal,
    });

    expect(outcome.cancelled).toBe(true);
    expect(org.deletes).toEqual([]);
    expect(
      outcome.objects.map(({ objectApiName, planned, deleted, notReached }) => ({
        objectApiName,
        planned,
        deleted,
        notReached,
      })),
    ).toEqual([
      { objectApiName: 'Contact', planned: 9, deleted: 0, notReached: 9 },
      { objectApiName: 'Account', planned: 7, deleted: 0, notReached: 7 },
    ]);
  });
});
