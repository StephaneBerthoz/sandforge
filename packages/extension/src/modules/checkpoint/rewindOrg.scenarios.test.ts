import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RewindDiff } from '@sandforge/shared';
import { paced } from '../../test/runnerPace.js';

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { MEMORY_ORG_USER, orgStamp } from '../../test/memoryRemovalOrg.js';
import {
  CHILDREN,
  COLLEAGUE,
  COMPARED,
  FIELDS,
  PERSON_FLAG,
  PICKED,
  PREVIEWED,
  PRICE_BOOK_HELD,
  SINCE,
  STAMP_FIELDS,
  T0,
  account,
  automationOf,
  baseRecords,
  book,
  changedSince,
  clock,
  contact,
  id,
  line,
  liveAsHeld,
  liveIds,
  opportunity,
  previewed,
  removeTaken,
  request,
  resultOf,
  rewound,
  stateOf,
  taken,
  undone,
  writable,
  RewindTestOrg,
  type Taken,
} from '../../test/rewindTestOrg.js';
import { overwriteBackupIdOf } from '../sync/syncOverwrites.js';
import { rewindDirOf } from './OrgCheckpointStore.js';
import { previewCheckpoint } from './previewCheckpoint.js';
import { rewindStepsOf } from './rewindBounds.js';
import { readRewindJournal, undoPlansOf } from './rewindJournal.js';
import { NOT_REMADE_WORDS, type RewindDeps } from './rewindOrg.js';
import { undoCheckpoint } from './undoCheckpoint.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * A rewind and its undo in the cases a person account, a deletion boundary,
 * a journal or a colleague working meanwhile makes them meet, on the memory
 * org (`src/test/rewindTestOrg.ts`).
 */

beforeEach(() => {
  clock.now = T0;
});

afterEach(() => {
  removeTaken();
  vi.mocked(getJsforceConnection).mockReset();
});

/** A rewind of `t` accepting what Undo could not bring back, acting on a preview read now. */
async function rewindNow(
  t: Taken,
  deps: Partial<RewindDeps> = {},
): Promise<Awaited<ReturnType<typeof rewound>>> {
  const diff = await previewed(t);
  return rewound(t, diff.previewId, { deps, request: { acceptNoUndo: true } });
}

/** The fields of an org with person accounts: the flag on accounts and contacts. */
const PERSON_FIELDS: Record<string, unknown[]> = {
  ...FIELDS,
  Account: [
    ...STAMP_FIELDS,
    writable('Name'),
    writable('FirstName'),
    writable('LastName'),
    PERSON_FLAG,
  ],
  Contact: [
    ...STAMP_FIELDS,
    writable('LastName'),
    writable('AccountId', 'reference', { referenceTo: ['Account'] }),
    PERSON_FLAG,
  ],
};

/**
 * An org whose opportunities hold lines of a custom object, which come back
 * from the recycle bin on their own, and whose price book the org refuses to
 * change while a line names the opportunity.
 */
const LINE_FIELDS: Record<string, unknown[]> = {
  ...FIELDS,
  Line__c: [
    ...STAMP_FIELDS,
    writable('Units__c', 'double'),
    writable('Deal__c', 'reference', { referenceTo: ['Opportunity'] }),
  ],
};
const LINE_CHILDREN = {
  ...CHILDREN,
  Opportunity: [
    ...(CHILDREN.Opportunity ?? []),
    { childSObject: 'Line__c', field: 'Deal__c', cascadeDelete: true },
  ],
};
const LINE_OBJECTS = [...PICKED, 'Line__c'];
const LINE_COMPARED = [...COMPARED, 'Units__c', 'Deal__c'];
const lineOf = (n: number): string => id('a0l', n);

/** An org with lines, the price book held in place by them. */
function lineOrg(): RewindTestOrg {
  const org = new RewindTestOrg({ fields: LINE_FIELDS, children: LINE_CHILDREN });
  org.heldByChildren.push({ ...PRICE_BOOK_HELD, childSObject: 'Line__c', field: 'Deal__c' });
  return org;
}

describe('a value a child holds in place (gate G1)', () => {
  it('is given back by Undo before the child the rewind deleted comes back: the org refuses it while the child is there', async () => {
    const t = await taken(baseRecords, lineOrg(), LINE_OBJECTS, {
      objects: LINE_OBJECTS,
      fields: LINE_COMPARED,
    });
    clock.now = SINCE;
    t.org.edit('Opportunity', opportunity(1), { Pricebook2Id: book(2) }, COLLEAGUE);
    t.org.add('Line__c', {
      Id: lineOf(1),
      Units__c: 3,
      Deal__c: opportunity(1),
      LastModifiedById: COLLEAGUE,
    });
    const beforeRewind = stateOf(t.org, LINE_OBJECTS, LINE_COMPARED);
    const diff = await previewed(t);

    const result = resultOf(await rewound(t, diff.previewId));
    expect(result.status).toBe('success');
    expect(stateOf(t.org, LINE_OBJECTS, LINE_COMPARED).live).toEqual(t.atCheckpoint.live);

    const undo = await undone(t, result.rewindId);

    expect(undo.status).toBe('success');
    expect(stateOf(t.org, LINE_OBJECTS, LINE_COMPARED)).toEqual(beforeRewind);
    // The price book went first, while no line named the opportunity.
    const given = t.org.updates.findIndex(({ records }) => records[0]?.Pricebook2Id === book(2));
    expect(given).toBeGreaterThanOrEqual(0);
  });
});

describe('a record brought back with what its delete took along', () => {
  it('is sent back to the bin by Undo with every record that came back with it, its children’s children too', async () => {
    const t = await taken(
      (org) => {
        baseRecords(org);
        org.add('Line__c', { Id: lineOf(1), Units__c: 2, Deal__c: opportunity(1) });
      },
      lineOrg(),
      LINE_OBJECTS,
      { objects: LINE_OBJECTS, fields: LINE_COMPARED },
    );
    clock.now = SINCE;
    // The account goes with its contact, its deal, and the deal's line.
    t.org.trash('Account', account(1), COLLEAGUE);
    const beforeRewind = stateOf(t.org, LINE_OBJECTS, LINE_COMPARED);
    const diff = await previewed(t);

    const result = resultOf(await rewound(t, diff.previewId));
    expect(result.status).toBe('success');
    expect(stateOf(t.org, LINE_OBJECTS, LINE_COMPARED).live).toEqual(t.atCheckpoint.live);
    const journal = await readRewindJournal(t.folder, result.rewindId);
    expect(journal.did.broughtBack).toEqual(
      expect.arrayContaining([{ objectApiName: 'Line__c', ids: [lineOf(1)] }]),
    );

    const undo = await undone(t, result.rewindId);

    expect(undo.status).toBe('success');
    expect(stateOf(t.org, LINE_OBJECTS, LINE_COMPARED)).toEqual(beforeRewind);
  });
});

describe('what came back with a record the rewind brought back', () => {
  it('goes back to the bin with that record in the Undo, never on its own: undeleting the record then brings it all back, an opportunity’s products among them (K16, F41)', async () => {
    const t = await taken((org) => {
      baseRecords(org);
      org.add('OpportunityLineItem', { Id: line(1), Quantity: 2, OpportunityId: opportunity(1) });
    });
    clock.now = SINCE;
    // The account goes with its contact, its opportunity and the opportunity's product.
    t.org.trash('Account', account(1), COLLEAGUE);
    const beforeRewind = stateOf(t.org);
    const diff = await previewed(t);
    const result = resultOf(await rewound(t, diff.previewId));
    expect(result.status).toBe('success');
    const journal = await readRewindJournal(t.folder, result.rewindId);
    expect(journal.did.withParents).toEqual(
      expect.arrayContaining([
        {
          objectApiName: 'OpportunityLineItem',
          ids: [line(1)],
          parents: [account(1).slice(0, 15)],
        },
      ]),
    );
    const deletesBefore = t.org.deletes.length;

    const undo = await undone(t, result.rewindId);

    expect(undo.status).toBe('success');
    expect(stateOf(t.org)).toEqual(beforeRewind);
    // One delete, of the account: what came back with it went with it.
    expect(t.org.deletes.slice(deletesBefore).flatMap(({ ids }) => ids)).toEqual([account(1)]);
    expect(undo.planned.remove).toBe(4);
    expect(
      Object.fromEntries(
        undo.deleted.map(({ objectApiName, deleted }) => [objectApiName, deleted]),
      ),
    ).toEqual({ Account: 1, Contact: 1, Opportunity: 1, OpportunityLineItem: 1 });
    // Of them, what went with the account, never sent on its own: what the
    // undo's summary leaves out of what it sent.
    expect(undo.wentAlong).toEqual([
      { objectApiName: 'Contact', count: 1 },
      { objectApiName: 'Opportunity', count: 1 },
      { objectApiName: 'OpportunityLineItem', count: 1 },
    ]);

    // Undeleted later, the account brings back everything its delete took.
    await t.org.undelete([account(1)]);
    expect(liveIds(t.org, 'Contact')).toContain(contact(3));
    expect(liveIds(t.org, 'Opportunity')).toContain(opportunity(1));
    expect(liveIds(t.org, 'OpportunityLineItem')).toEqual([line(1)]);
  });

  it('stays with that record when the Undo keeps it, changed since the rewind, and is left for the next Undo with it', async () => {
    const t = await taken();
    clock.now = SINCE;
    t.org.trash('Account', account(1), COLLEAGUE);
    const diff = await previewed(t);
    // This machine's clock, which the journal dates the rewind's writes by,
    // keeps step with the org's.
    vi.useFakeTimers({ toFake: ['Date'] });
    const serverTime = t.org.serverTime.bind(t.org);
    t.org.serverTime = async () => {
      const at = await serverTime();
      vi.setSystemTime(clock.now);
      return at;
    };
    try {
      const result = resultOf(await rewound(t, diff.previewId));
      expect(result.status).toBe('success');
      // A colleague renames the opportunity that came back with the account.
      clock.now += 5 * 60_000;
      vi.setSystemTime(clock.now);
      t.org.edit('Opportunity', opportunity(1), { Name: 'Renamed after the rewind' }, COLLEAGUE);
      const deletesBefore = t.org.deletes.length;

      const undo = await undone(t, result.rewindId);

      // The opportunity holds its account, and the contact stays with both:
      // nothing went, and the account is said kept for its opportunity.
      expect(undo.status).toBe('failure');
      expect(undo.deleted).toEqual([
        expect.objectContaining({
          objectApiName: 'Account',
          deleted: 0,
          keptDependents: 1,
          heldBy: ['Opportunity'],
        }),
      ]);
      expect(liveIds(t.org, 'Account')).toContain(account(1));
      expect(liveIds(t.org, 'Opportunity')).toContain(opportunity(1));
      expect(liveIds(t.org, 'Contact')).toContain(contact(3));
      expect(t.org.deletes.slice(deletesBefore)).toEqual([]);
      // The next undo sets out to take them again, the account with what
      // came back with it.
      const next = await undoPlansOf(t.folder, result.rewindId, t.checkpoint.objects);
      try {
        const removing: string[] = [];
        for await (const page of next.remove.pages('Account')) removing.push(...page);
        expect(next.remove.objects).toEqual([{ objectApiName: 'Account', count: 1 }]);
        expect(removing).toEqual([account(1)]);
        const along: string[] = [];
        for (const { objectApiName } of next.goesWithParent.objects) {
          for await (const page of next.goesWithParent.pages(objectApiName)) {
            along.push(...page.map(({ id }) => id));
          }
        }
        expect(along.sort()).toEqual([contact(3), opportunity(1)].sort());
      } finally {
        await next.dispose();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a rewind taken up after a stop (B3)', () => {
  it('says Undo could not bring back the records Salesforce undeletes only with their parent that the stopped pass deleted on their own', async () => {
    const t = await taken();
    clock.now = SINCE;
    t.org.add('OpportunityLineItem', {
      Id: line(1),
      Quantity: 1,
      OpportunityId: opportunity(1),
      LastModifiedById: COLLEAGUE,
    });
    t.org.edit('Account', account(1), { Name: 'Renamed' }, COLLEAGUE);
    const diff = await previewed(t);
    // Stopped once the product is deleted, before the rewind ends.
    const controller = new AbortController();
    t.org.beforeDelete = () => {
      t.org.beforeDelete = undefined;
      queueMicrotask(() => controller.abort());
    };
    const stopped = resultOf(
      await rewound(t, diff.previewId, {
        deps: { signal: controller.signal },
        request: { acceptNoUndo: true },
      }),
    );
    expect(liveIds(t.org, 'OpportunityLineItem')).toEqual([]);

    const again = resultOf(await rewindNow(t));

    expect(again.rewindId).toBe(stopped.rewindId);
    expect(again.undo?.cannot).toEqual([{ objectApiName: 'OpportunityLineItem', count: 1 }]);
  });
});

describe('a person account', () => {
  /** The records long before the checkpoint, a person account among them. */
  function withPerson(org: RewindTestOrg): void {
    baseRecords(org);
    org.addPersonAccount(
      { Id: account(9), Name: 'Ada Lovelace', FirstName: 'Ada', LastName: 'Lovelace' },
      contact(9),
    );
  }

  it('deleted since, comes back with its contact, and Undo sends it back to the bin with its contact, never the contact on its own', async () => {
    const t = await taken(withPerson, new RewindTestOrg({ fields: PERSON_FIELDS }));
    clock.now = SINCE;
    t.org.trash('Account', account(9), COLLEAGUE);
    const beforeRewind = stateOf(t.org);
    const diff = await previewed(t);

    const result = resultOf(await rewound(t, diff.previewId));
    expect(result.status).toBe('success');
    expect(stateOf(t.org).live).toEqual(t.atCheckpoint.live);

    const undo = await undone(t, result.rewindId);

    expect(undo.status).toBe('success');
    expect(stateOf(t.org)).toEqual(beforeRewind);
    // The org deletes a person contact only with its account: none was sent alone.
    expect(t.org.deletes.flatMap(({ ids }) => ids)).not.toContain(contact(9));
  });

  it('is asked of no contact of an org without person accounts: the children that come back with an account are named all the same', async () => {
    const org = new RewindTestOrg();
    // The org refuses a column it does not have.
    org.missingFields.set('Contact', new Set(['IsPersonAccount']));
    const t = await taken(baseRecords, org);
    changedSince(t.org);
    const diff = await previewed(t);

    const result = resultOf(await rewound(t, diff.previewId));

    expect(result.status).toBe('success');
    const journal = await readRewindJournal(t.folder, result.rewindId);
    expect(journal.did.broughtBack).toEqual([
      { objectApiName: 'Contact', ids: [contact(1), contact(2)] },
      { objectApiName: 'Account', ids: [account(2)] },
    ]);
  });

  it('brought back from the bin since, goes back to the bin with its contact', async () => {
    const t = await taken(
      (org) => {
        withPerson(org);
        org.trash('Account', account(9));
      },
      new RewindTestOrg({ fields: PERSON_FIELDS }),
    );
    clock.now = SINCE;
    t.org.untrash(account(9), COLLEAGUE);
    const diff = await previewed(t);

    const result = resultOf(await rewound(t, diff.previewId));

    expect(result.status).toBe('success');
    expect(stateOf(t.org, [...PICKED, 'Order'])).toEqual({
      live: t.atCheckpoint.live,
      bin: expect.objectContaining({}) as unknown,
    });
    expect(t.org.inBin('Account').map((row) => row.Id)).toContain(account(9));
    expect(t.org.inBin('Contact').map((row) => row.Id)).toContain(contact(9));
    expect(t.org.deletes.flatMap(({ ids }) => ids)).not.toContain(contact(9));
  });
});

// ─── B1: the deletion boundary ───────────────────────────────────────────────

/** An org whose accounts take along cases, an object the checkpoint does not hold. */
const CASE_FIELDS: Record<string, unknown[]> = {
  ...FIELDS,
  Case: [
    ...STAMP_FIELDS,
    writable('Subject'),
    writable('AccountId', 'reference', { referenceTo: ['Account'] }),
  ],
};
const CASE_CHILDREN = {
  ...CHILDREN,
  Account: [
    ...(CHILDREN.Account ?? []),
    { childSObject: 'Case', field: 'AccountId', cascadeDelete: true },
  ],
};
const kase = (n: number): string => id('500', n);
/** A checkpoint that holds the cases too: one comes back from the bin on its own. */
const CASE_OBJECTS = [...PICKED, 'Case'];
const CASE_COMPARED = [...COMPARED, 'Subject'];

/** What a rewind says of a record it kept for the records hanging from it that it does not delete. */
const KEPT_FOR = (holders: string): string =>
  `Kept: records it does not delete hang from it (${holders}), and its deletion would take ` +
  'them along.';

describe('the deletion boundary (B1)', () => {
  it('keeps, and names, a parent created since that a checkpoint child was moved under when the child’s give-back is refused, never deleting the child, and sends back to the bin what was brought back since', async () => {
    const t = await taken((org) => {
      baseRecords(org);
      org.add('Account', { Id: account(6), Name: 'In the bin at the checkpoint' });
      org.trash('Account', account(6));
    });
    clock.now = SINCE;
    t.org.add('Account', { Id: account(7), Name: 'New home', LastModifiedById: COLLEAGUE });
    t.org.edit('Contact', contact(3), { AccountId: account(7) }, COLLEAGUE);
    t.org.untrash(account(6), COLLEAGUE);
    t.org.refuseUpdate.set(contact(3), { statusCode: 'UNABLE_TO_LOCK_ROW', message: 'locked' });
    const diff = await previewed(t);

    const result = resultOf(await rewound(t, diff.previewId));

    expect(result.status).toBe('partial');
    expect(liveIds(t.org, 'Contact')).toContain(contact(3));
    expect(t.org.deletes.flatMap(({ ids }) => ids)).not.toContain(contact(3));
    expect(liveIds(t.org, 'Account')).toContain(account(7));
    expect(t.org.inBin('Account').map((row) => row.Id)).toContain(account(6));
    expect(result.residual).toEqual(
      expect.arrayContaining([
        {
          objectApiName: 'Account',
          reason: 'kept',
          count: 1,
          ids: [account(7)],
          message: KEPT_FOR('Contact'),
        },
        expect.objectContaining({
          objectApiName: 'Contact',
          reason: 'refused',
          ids: [contact(3)],
          message: 'UNABLE_TO_LOCK_ROW: locked',
        }),
      ]),
    );
  });

  it('keeps the parent a record created while the checkpoint was taken hangs from, and deletes with its parent a record created after it', async () => {
    const org = new RewindTestOrg({ fields: CASE_FIELDS, children: CASE_CHILDREN });
    // The take reads the clock as it goes: T1 comes after T0.
    org.ticking = true;
    const t = await taken(baseRecords, org);
    org.ticking = false;
    const t0 = Date.parse(t.checkpoint.readFrom);
    const t1 = Date.parse(t.checkpoint.takenAt);
    expect(t1).toBeGreaterThan(t0);
    // Dated in T0's second: after the checkpoint began, before it ended.
    const during = orgStamp(t0);
    // Made while the checkpoint was taken, after their objects were read.
    t.org.add(
      'Account',
      { Id: account(7), Name: 'Made during', LastModifiedById: COLLEAGUE },
      during,
    );
    t.org.add('Case', { Id: kase(1), Subject: 'Made during', AccountId: account(7) }, during);
    clock.now = SINCE;
    t.org.add('Account', { Id: account(8), Name: 'Made since', LastModifiedById: COLLEAGUE });
    t.org.add('Case', { Id: kase(2), Subject: 'Made since', AccountId: account(8) });
    const diff = await previewed(t);

    const result = resultOf(await rewound(t, diff.previewId, { request: { acceptOutside: true } }));

    expect(liveIds(t.org, 'Account')).toContain(account(7));
    expect(liveIds(t.org, 'Case')).toEqual([kase(1)]);
    expect(t.org.inBin('Account').map((row) => row.Id)).toContain(account(8));
    expect(t.org.inBin('Case').map((row) => row.Id)).toEqual([kase(2)]);
    expect(result.residual).toEqual([
      {
        objectApiName: 'Account',
        reason: 'kept',
        count: 1,
        ids: [account(7)],
        message: KEPT_FOR('Case'),
      },
    ]);
  });

  it('keeps the parent of a child a colleague creates once the rewind began, and the child, and ends unstable', async () => {
    const t = await taken();
    clock.now = SINCE;
    t.org.add('Account', { Id: account(7), Name: 'Made since', LastModifiedById: COLLEAGUE });
    const diff = await previewed(t);

    const result = resultOf(
      await rewound(t, diff.previewId, {
        deps: {
          onProgress: ({ phase }) => {
            if (phase !== 'deleting' || liveIds(t.org, 'Contact').includes(contact(7))) return;
            t.org.add('Contact', {
              Id: contact(7),
              LastName: 'Made during the rewind',
              AccountId: account(7),
              CreatedById: COLLEAGUE,
              LastModifiedById: COLLEAGUE,
            });
          },
        },
      }),
    );

    expect(liveIds(t.org, 'Contact')).toContain(contact(7));
    expect(liveIds(t.org, 'Account')).toContain(account(7));
    expect(result.status).toBe('unstable');
    expect(result.residual).toEqual(
      expect.arrayContaining([
        {
          objectApiName: 'Contact',
          reason: 'changedDuringRewind',
          by: COLLEAGUE,
          count: 1,
          ids: [contact(7)],
        },
        expect.objectContaining({ objectApiName: 'Account', ids: [account(7)] }),
      ]),
    );
  });
});

// ─── B3: the journal and Undo ────────────────────────────────────────────────

describe('the journal and Undo (B3)', () => {
  it('keeps what a colleague changed since the rewind as they made it, and counts it: the undo is partial', async () => {
    const t = await taken();
    changedSince(t.org);
    // This machine's clock, which the journal dates the rewind's writes by,
    // keeps step with the org's.
    vi.useFakeTimers({ toFake: ['Date'] });
    const serverTime = t.org.serverTime.bind(t.org);
    t.org.serverTime = async () => {
      const at = await serverTime();
      vi.setSystemTime(clock.now);
      return at;
    };
    try {
      const result = resultOf(await rewindNow(t));
      expect(result.status).toBe('success');
      clock.now += 30_000;
      vi.setSystemTime(clock.now);
      t.org.edit('Account', account(1), { Name: 'After the rewind' }, COLLEAGUE);

      const undo = await undone(t, result.rewindId);

      expect(t.org.all('Account').find((row) => row.Id === account(1))?.Name).toBe(
        'After the rewind',
      );
      expect(undo.restored.find((object) => object.objectApiName === 'Account')).toMatchObject({
        keptChanged: 1,
      });
      expect(undo.status).toBe('partial');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends no product of an opportunity it deletes: they go with it, and come back with it', async () => {
    const t = await taken();
    clock.now = SINCE;
    t.org.add('Opportunity', {
      Id: opportunity(7),
      Name: 'Made since',
      AccountId: account(1),
      LastModifiedById: COLLEAGUE,
    });
    t.org.add('OpportunityLineItem', {
      Id: line(7),
      Quantity: 1,
      OpportunityId: opportunity(7),
      LastModifiedById: COLLEAGUE,
    });
    const beforeRewind = stateOf(t.org);
    const diff = await previewed(t);

    const result = resultOf(await rewound(t, diff.previewId));

    expect(result.status).toBe('success');
    expect(result.undo?.cannot).toEqual([]);
    expect(t.org.deletes.flatMap(({ ids }) => ids)).toEqual([opportunity(7)]);
    expect(t.org.inBin('OpportunityLineItem').map((row) => row.Id)).toEqual([line(7)]);
    const undo = await undone(t, result.rewindId);
    expect(undo.status).toBe('success');
    expect(stateOf(t.org)).toEqual(beforeRewind);
  });

  it('sends no case made since under an account it deletes: it goes with the account, and Undo brings it back with it, where one deleted alone first would stay in the bin for good', async () => {
    const t = await taken(
      baseRecords,
      new RewindTestOrg({ fields: CASE_FIELDS, children: CASE_CHILDREN }),
      CASE_OBJECTS,
      { objects: CASE_OBJECTS, fields: CASE_COMPARED },
    );
    expect(t.org.facts.childDeletedAloneThenParentLimbo).toBe(true);
    clock.now = SINCE;
    t.org.add('Account', { Id: account(7), Name: 'Made since', LastModifiedById: COLLEAGUE });
    t.org.add('Case', {
      Id: kase(7),
      Subject: 'Made since',
      AccountId: account(7),
      LastModifiedById: COLLEAGUE,
    });
    const beforeRewind = stateOf(t.org, CASE_OBJECTS, CASE_COMPARED);
    const diff = await previewed(t);
    expect(diff.withParentDeleted).toEqual([{ objectApiName: 'Case', count: 1 }]);

    const result = resultOf(await rewound(t, diff.previewId));

    expect(result.status).toBe('success');
    expect(result.undo?.cannot).toEqual([]);
    expect(t.org.deletes.flatMap(({ ids }) => ids)).toEqual([account(7)]);
    expect(t.org.inBin('Case').map((row) => row.Id)).toEqual([kase(7)]);
    const undo = await undone(t, result.rewindId);
    expect(undo.status).toBe('success');
    expect(stateOf(t.org, CASE_OBJECTS, CASE_COMPARED)).toEqual(beforeRewind);
  });

  describe('what goes with its parent, and points at a record deleted after it', () => {
    const BOOK_CHILDREN = {
      ...CHILDREN,
      Pricebook2: [{ childSObject: 'Opportunity', field: 'Pricebook2Id', restrictedDelete: true }],
    };
    const BOOK_OBJECTS = [...PICKED, 'Pricebook2'];
    const BOOK_FIELDS = { ...FIELDS, Pricebook2: [...STAMP_FIELDS, writable('Name')] };

    async function madeUnderABookMadeToo(): Promise<Taken> {
      const t = await taken(
        baseRecords,
        new RewindTestOrg({ fields: BOOK_FIELDS, children: BOOK_CHILDREN }),
        BOOK_OBJECTS,
      );
      clock.now = SINCE;
      t.org.add('Pricebook2', { Id: book(7), LastModifiedById: COLLEAGUE });
      t.org.add('Account', { Id: account(7), Name: 'Made since', LastModifiedById: COLLEAGUE });
      t.org.add('Contact', {
        Id: contact(7),
        LastName: 'Made since',
        AccountId: account(7),
        LastModifiedById: COLLEAGUE,
      });
      t.org.add('Opportunity', {
        Id: opportunity(7),
        Name: 'Made since',
        AccountId: account(7),
        Pricebook2Id: book(7),
        LastModifiedById: COLLEAGUE,
      });
      t.org.add('OpportunityLineItem', {
        Id: line(7),
        Quantity: 1,
        OpportunityId: opportunity(7),
        LastModifiedById: COLLEAGUE,
      });
      return t;
    }

    it('says Undo cannot bring it back, sends it, and leaves what goes with the account along', async () => {
      const t = await madeUnderABookMadeToo();

      const diff = await previewed(t);

      expect(diff.withParentDeleted).toEqual([{ objectApiName: 'Contact', count: 1 }]);
      expect(diff.undoCannot).toEqual(
        expect.arrayContaining([
          { objectApiName: 'Opportunity', count: 1, reason: 'deletedBeforeParent' },
          { objectApiName: 'OpportunityLineItem', count: 1, reason: 'deletedBeforeParent' },
        ]),
      );
      const result = resultOf(
        await rewound(t, diff.previewId, { request: { acceptNoUndo: true } }),
      );

      expect(result.status).toBe('success');
      expect(t.org.deletes.flatMap(({ ids }) => ids)).not.toContain(contact(7));
      expect(t.org.deletes.flatMap(({ ids }) => ids)).toContain(opportunity(7));
    });

    it('has Undo name what the org will not bring back, and bring back the rest', async () => {
      const t = await madeUnderABookMadeToo();
      const diff = await previewed(t);
      const result = resultOf(
        await rewound(t, diff.previewId, { request: { acceptNoUndo: true } }),
      );

      const undo = await undone(t, result.rewindId);

      expect(undo.status).toBe('partial');
      const inBin = (object: string): unknown[] => t.org.inBin(object).map((row) => row.Id);
      expect(inBin('Account')).toEqual([]);
      expect(inBin('Contact')).toEqual([]);
      expect(inBin('Pricebook2')).toEqual([]);
      expect(inBin('Opportunity')).toEqual([opportunity(7)]);
      expect(undo.undeleted.find((row) => row.objectApiName === 'Opportunity')).toMatchObject({
        planned: 1,
        undeleted: 0,
        refused: 1,
      });
    });

    it('keeps along what points at a record that goes in the same delete', async () => {
      const t = await taken(
        baseRecords,
        new RewindTestOrg({
          fields: {
            ...FIELDS,
            Opportunity: [
              ...(FIELDS.Opportunity ?? []),
              writable('Main_Contact__c', 'reference', { referenceTo: ['Contact'] }),
            ],
          },
          children: {
            ...CHILDREN,
            Contact: [
              { childSObject: 'Opportunity', field: 'Main_Contact__c', restrictedDelete: true },
            ],
          },
        }),
        PICKED,
      );
      clock.now = SINCE;
      t.org.add('Account', { Id: account(7), Name: 'Made since', LastModifiedById: COLLEAGUE });
      t.org.add('Contact', {
        Id: contact(7),
        LastName: 'Made since',
        AccountId: account(7),
        LastModifiedById: COLLEAGUE,
      });
      t.org.add('Opportunity', {
        Id: opportunity(7),
        Name: 'Made since',
        AccountId: account(7),
        Main_Contact__c: contact(7),
        LastModifiedById: COLLEAGUE,
      });

      const diff = await previewed(t);

      expect(diff.undoCannot).toEqual([]);
      expect(diff.withParentDeleted).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ objectApiName: 'Opportunity', count: 1 }),
        ]),
      );
    });
  });

  describe('an order activated since under an account it deletes', () => {
    const ORDER_FIELDS = {
      ...FIELDS,
      Order: [
        ...(FIELDS.Order ?? []),
        writable('AccountId', 'reference', { referenceTo: ['Account'] }),
      ],
    };
    const ORDER_CHILDREN = {
      ...CHILDREN,
      Account: [
        ...(CHILDREN.Account ?? []),
        { childSObject: 'Order', field: 'AccountId', cascadeDelete: true },
      ],
    };
    const ORDER_OBJECTS = [...PICKED, 'Order'];
    const order = (n: number): string => id('801', n);

    async function activatedUnderAccount(): Promise<Taken> {
      const t = await taken(
        (org) => {
          baseRecords(org);
          org.add('OrderStatus', { Id: 'status-1', ApiName: 'Draft', StatusCode: 'Draft' });
          org.add('OrderStatus', { Id: 'status-2', ApiName: 'Activated', StatusCode: 'Activated' });
        },
        new RewindTestOrg({ fields: ORDER_FIELDS, children: ORDER_CHILDREN }),
        ORDER_OBJECTS,
      );
      clock.now = SINCE;
      t.org.add('Account', { Id: account(7), Name: 'Made since', LastModifiedById: COLLEAGUE });
      t.org.add('Order', {
        Id: order(7),
        Status: 'Activated',
        AccountId: account(7),
        LastModifiedById: COLLEAGUE,
      });
      return t;
    }

    it('sets it to Draft and sends it no delete: it goes with the account, which it would keep', async () => {
      const t = await activatedUnderAccount();
      const diff = await previewed(t);
      expect(diff.withParentDeleted).toEqual([{ objectApiName: 'Order', count: 1 }]);

      const result = resultOf(await rewound(t, diff.previewId));

      expect(result.status).toBe('success');
      expect(t.org.updates).toEqual([
        { objectApiName: 'Order', records: [{ Id: order(7), Status: 'Draft' }] },
      ]);
      expect(t.org.deletes.flatMap(({ ids }) => ids)).toEqual([account(7)]);
      expect(t.org.inBin('Order').map((row) => row.Id)).toEqual([order(7)]);
    });

    it('is sent back to the bin with its account by the undo of a rewind that brought it back with it and gave it its status: the undo gives it its Draft from before first, and the org takes the account', async () => {
      const t = await taken(
        (org) => {
          baseRecords(org);
          org.add('OrderStatus', { Id: 'status-1', ApiName: 'Draft', StatusCode: 'Draft' });
          org.add('OrderStatus', { Id: 'status-2', ApiName: 'Activated', StatusCode: 'Activated' });
          org.add('Order', { Id: order(1), Status: 'Activated', AccountId: account(1) });
        },
        new RewindTestOrg({ fields: ORDER_FIELDS, children: ORDER_CHILDREN }),
        ORDER_OBJECTS,
      );
      clock.now = SINCE;
      // The one way the org deletes the account: its order a draft first.
      t.org.edit('Order', order(1), { Status: 'Draft' }, COLLEAGUE);
      clock.now = SINCE + 5_000;
      t.org.trash('Account', account(1), COLLEAGUE);
      const diff = await previewed(t);
      expect(diff.objects.find((o) => o.objectApiName === 'Order')).toMatchObject({
        toBringBack: { withParent: 1 },
      });
      const rewind = resultOf(await rewound(t, diff.previewId));
      expect(t.org.all('Order')).toEqual([expect.objectContaining({ Status: 'Activated' })]);
      const plans = await undoPlansOf(t.folder, rewind.rewindId, t.checkpoint.objects);
      try {
        expect(plans.goesWithParent.objects).toContainEqual({ objectApiName: 'Order', count: 1 });
      } finally {
        await plans.dispose();
      }
      const updatesBefore = t.org.updates.length;

      const undo = await undone(t, rewind.rewindId);

      expect(undo.status).toBe('success');
      expect(t.org.inBin('Order').map((row) => [row.Id, row.Status])).toEqual([
        [order(1), 'Draft'],
      ]);
      expect(t.org.inBin('Account').map((row) => row.Id)).toContain(account(1));
      expect(
        t.org.updates
          .slice(updatesBefore)
          .filter(({ objectApiName }) => objectApiName === 'Order')
          .flatMap(({ records }) => records.map((record) => record.Status)),
      ).toEqual(['Draft']);
    });

    it('gives it its status back when the org refuses the account', async () => {
      const t = await activatedUnderAccount();
      t.org.refuse.set(account(7), 'Held by a rule of the org');
      const diff = await previewed(t);

      const result = resultOf(await rewound(t, diff.previewId));

      expect(result.status).toBe('failure');
      expect(t.org.updates).toEqual([
        { objectApiName: 'Order', records: [{ Id: order(7), Status: 'Draft' }] },
        { objectApiName: 'Order', records: [{ Id: order(7), Status: 'Activated' }] },
      ]);
    });
  });

  it('sends no give-back whose values from before could not be kept, and names the records it left', async () => {
    const t = await taken();
    clock.now = SINCE;
    t.org.edit('Account', account(1), { Name: 'Renamed' }, COLLEAGUE);
    const diff = await previewed(t);

    const result = resultOf(
      await rewound(t, diff.previewId, {
        deps: {
          onProgress: ({ phase }) => {
            if (phase !== 'givingBack') return;
            // Where the journal keeps the accounts' values from before, a
            // folder: the values cannot be written there.
            const [rewindId] = readdirSync(t.folder.rewindsDir);
            mkdirSync(
              join(
                rewindDirOf(t.folder, rewindId),
                'backups',
                `${overwriteBackupIdOf(rewindId)}__Account.ndjson`,
              ),
              { recursive: true },
            );
          },
        },
      }),
    );

    expect(t.org.updates).toEqual([]);
    expect(t.org.all('Account').find((row) => row.Id === account(1))?.Name).toBe('Renamed');
    expect(result.residual).toEqual([
      expect.objectContaining({
        objectApiName: 'Account',
        reason: 'refused',
        ids: [account(1)],
        message: expect.stringContaining('could not be kept before they were written') as unknown,
      }),
    ]);
  });
});

// ─── M3: others at work during the rewind ────────────────────────────────────

describe('others at work during the rewind (M3)', () => {
  it('leaves as they made it a record a colleague changes during the first pass, through the second pass too, names them, and ends unstable', async () => {
    const t = await taken();
    clock.now = SINCE;
    t.org.edit('Account', account(1), { Name: 'Renamed' }, COLLEAGUE);
    // Made since under an account deleted since: it comes back with it, and
    // the second pass deletes it.
    t.org.add('Contact', {
      Id: contact(5),
      LastName: 'Made since',
      AccountId: account(2),
      LastModifiedById: COLLEAGUE,
    });
    t.org.trash('Account', account(2), COLLEAGUE);
    const diff = await previewed(t);
    let changed = false;
    const undelete = async (ids: string[]): Promise<unknown> => {
      if (!changed) {
        changed = true;
        t.org.edit('Account', account(1), { Name: 'During the rewind' }, COLLEAGUE);
      }
      return t.org.undelete(ids);
    };

    const result = resultOf(await rewound(t, diff.previewId, { deps: { undelete } }));

    expect(result.passes).toBe(2);
    expect(result.status).toBe('unstable');
    expect(t.org.all('Account').find((row) => row.Id === account(1))?.Name).toBe(
      'During the rewind',
    );
    expect(liveIds(t.org, 'Contact')).not.toContain(contact(5));
    expect(result.residual).toEqual([
      {
        objectApiName: 'Account',
        reason: 'changedDuringRewind',
        by: COLLEAGUE,
        count: 1,
        ids: [account(1)],
      },
    ]);
  });

  it('deletes in the second pass what its own user made in answer to the first, as a trigger running as it would', async () => {
    const t = await taken();
    changedSince(t.org);
    const diff = await previewed(t);
    let answered = false;
    const undelete = async (ids: string[]): Promise<unknown> => {
      const answer = await t.org.undelete(ids);
      if (!answered) {
        answered = true;
        t.org.add('Account', {
          Id: account(8),
          Name: 'Made by a trigger',
          CreatedById: MEMORY_ORG_USER,
          LastModifiedById: MEMORY_ORG_USER,
        });
      }
      return answer;
    };

    const result = resultOf(await rewound(t, diff.previewId, { deps: { undelete } }));

    expect(result.status).toBe('success');
    expect(result.passes).toBe(2);
    expect(stateOf(t.org).live).toEqual(t.atCheckpoint.live);
    expect(t.org.inBin('Account').map((row) => row.Id)).toContain(account(8));
  });

  it('ends in a busy org that keeps adding records while it runs, without going on for them, and names each: since the preview, or during the rewind', async () => {
    const t = await taken();
    changedSince(t.org);
    const diff = await previewed(t);
    // Between the preview and the rewind, then at every read of the org's clock.
    t.org.add('Account', {
      Id: account(20),
      Name: 'Since the preview',
      LastModifiedById: COLLEAGUE,
    });
    let added = 0;
    const serverTime = t.org.serverTime.bind(t.org);
    t.org.serverTime = async () => {
      const at = await serverTime();
      if (t.org.ticking) {
        added++;
        t.org.add('Account', {
          Id: account(20 + added),
          Name: `Busy ${added}`,
          LastModifiedById: COLLEAGUE,
        });
      }
      return at;
    };

    const result = resultOf(await rewound(t, diff.previewId));

    expect(result.passes).toBeLessThanOrEqual(2);
    expect(result.status).toBe('unstable');
    const named = new Map(
      result.residual.flatMap(({ reason, ids }) => ids.map((each) => [each, reason] as const)),
    );
    expect(named.get(account(20))).toBe('changedSincePreview');
    for (let n = 1; n <= added; n++) {
      expect(liveIds(t.org, 'Account')).toContain(account(20 + n));
    }
    // Those it read again by the end are named as made during it.
    const during = [...named].filter(([, reason]) => reason === 'changedDuringRewind');
    expect(during.length).toBeGreaterThan(0);
  });
});

// ─── What the org will not take back ─────────────────────────────────────────

describe('a case its rewind would delete before the account it points at', () => {
  /**
   * Cases a contact's delete takes along, whose account lookup restricts the
   * account's delete instead, as the scratch org of the live proof had it.
   */
  const RESTRICT_FIELDS: Record<string, unknown[]> = {
    ...FIELDS,
    Case: [
      ...STAMP_FIELDS,
      writable('Subject'),
      writable('AccountId', 'reference', { referenceTo: ['Account'] }),
      writable('ContactId', 'reference', { referenceTo: ['Contact'] }),
    ],
  };
  const RESTRICT_CHILDREN = {
    ...CHILDREN,
    Account: [
      ...(CHILDREN.Account ?? []),
      { childSObject: 'Case', field: 'AccountId', restrictedDelete: true },
    ],
    Contact: [{ childSObject: 'Case', field: 'ContactId', cascadeDelete: true }],
  };

  it('is kept by the second pass, which would delete it before that account, and named so, when that Undo couldn’t bring it back was not accepted: a case that came back with its contact under an account made since (F41)', async () => {
    const t = await taken(
      baseRecords,
      new RewindTestOrg({ fields: RESTRICT_FIELDS, children: RESTRICT_CHILDREN }),
      CASE_OBJECTS,
      { objects: CASE_OBJECTS, fields: CASE_COMPARED },
    );
    clock.now = SINCE;
    t.org.add('Account', { Id: account(7), Name: 'Made since', LastModifiedById: COLLEAGUE });
    t.org.add('Case', {
      Id: kase(7),
      Subject: 'Made since',
      AccountId: account(7),
      ContactId: contact(3),
      LastModifiedById: COLLEAGUE,
    });
    clock.now = SINCE + 5_000;
    // The case goes with its contact, and comes back with it.
    t.org.trash('Contact', contact(3), COLLEAGUE);
    const diff = await previewed(t);
    expect(diff.objects.find((object) => object.objectApiName === 'Case')?.toDelete).toEqual({
      createdSince: 0,
      broughtBackSince: 0,
      comesBackWithParent: 1,
    });
    expect(diff.undoCannot).toEqual([
      { objectApiName: 'Case', count: 1, reason: 'deletedBeforeParent' },
    ]);

    const result = resultOf(await rewound(t, diff.previewId));

    expect(result.passes).toBe(2);
    expect(result.residual).toContainEqual({
      objectApiName: 'Case',
      reason: 'kept',
      count: 1,
      ids: [kase(7)],
      message:
        "Kept: Undo couldn't bring it back once deleted before a record it points at, which " +
        'the rewind deletes next, and that was not accepted.',
    });
    expect(liveIds(t.org, 'Case')).toEqual([kase(7)]);
    expect(liveIds(t.org, 'Account')).toContain(account(7));
    expect(result.undo?.cannot).toEqual([]);
  });
});

describe('a record Salesforce keeps in the recycle bin for good', () => {
  it('deleted on its own, then its account, is never sent to the undelete: the preview counts it to make again, and the rewind makes it under a new Id once that is accepted (F41, Q2)', async () => {
    const t = await taken();
    clock.now = SINCE;
    t.org.trash('Contact', contact(3), COLLEAGUE);
    clock.now = SINCE + 5_000;
    t.org.trash('Account', account(1), COLLEAGUE);
    const diff = await previewed(t);
    expect(diff.objects.find((object) => object.objectApiName === 'Contact')).toMatchObject({
      toBringBack: { inBin: 0, withParent: 0, deletedWhileTaken: 0 },
      toRecreate: 1,
      cannotUndo: [],
    });
    expect(await rewound(t, diff.previewId)).toMatchObject({
      rewound: false,
      refusal: { code: 'RECREATE' },
    });
    expect(t.org.creates).toEqual([]);
    const sent: string[] = [];

    const result = resultOf(
      await rewound(t, diff.previewId, {
        request: { acceptRecreate: true },
        deps: {
          undelete: (ids) => {
            sent.push(...ids);
            return t.org.undelete(ids);
          },
        },
      }),
    );

    expect(sent).toEqual([account(1)]);
    expect(result.undeleted.flatMap(({ reasons }) => reasons)).toEqual([]);
    expect(result.recreated).toEqual([
      { objectApiName: 'Contact', planned: 1, created: 1, refused: 0, reasons: [] },
    ]);
    expect(result.residual).toEqual([]);
    expect(result.status).toBe('success');
    // Under its account, back first: the org as the checkpoint holds it, but for its Id.
    const made = t.org.all('Contact').find((row) => row.LastName === 'Three');
    expect(made).toMatchObject({ AccountId: account(1) });
    expect(made?.Id).not.toBe(contact(3));
    expect(t.org.inBin('Contact').map((row) => row.Id)).toContain(contact(3));
    expect(liveAsHeld(stateOf(t.org), t.folder)).toEqual(t.atCheckpoint.live);
    expect(liveIds(t.org, 'Opportunity')).toContain(opportunity(1));
  });
});

describe('an activated order a rewind makes again or keeps', () => {
  const ORDER_FIELDS: Record<string, unknown[]> = {
    ...FIELDS,
    Order: [
      ...STAMP_FIELDS,
      writable('Status'),
      writable('Description'),
      writable('AccountId', 'reference', { referenceTo: ['Account'] }),
    ],
    OrderItem: [
      ...STAMP_FIELDS,
      writable('Quantity', 'double'),
      writable('OrderId', 'reference', { referenceTo: ['Order'], updateable: false }),
    ],
  };
  const ORDER_CHILDREN = {
    ...CHILDREN,
    Order: [{ childSObject: 'OrderItem', field: 'OrderId', cascadeDelete: true }],
  };
  const order = (n: number): string => id('801', n);
  const item = (n: number): string => id('802', n);
  /** A flow that emails an order's owner as it is updated, and no other write. */
  const ORDER_UPDATE_EMAIL = automationOf({
    objects: [
      {
        objectApiName: 'Order',
        flows: [
          {
            apiName: 'Order_touched',
            label: 'Order touched',
            timing: 'afterSave',
            startsOn: 'update',
            condition: 'read',
            permissions: [],
            messages: [{ kind: 'email', name: 'Tell owner', limit: 'SingleEmail' }],
          },
        ],
        triggers: [],
      },
    ],
  });

  /**
   * An order activated at the checkpoint, with a product: set back to Draft
   * since, the one way the org deletes it, deleted with its product, then
   * emptied from the recycle bin.
   */
  async function purgedSince(): Promise<Taken> {
    const t = await taken(
      (org) => {
        baseRecords(org);
        org.add('OrderStatus', { Id: 'status-1', ApiName: 'Draft', StatusCode: 'Draft' });
        org.add('OrderStatus', { Id: 'status-2', ApiName: 'Activated', StatusCode: 'Activated' });
        org.add('Order', {
          Id: order(1),
          Status: 'Activated',
          Description: 'Signed',
          AccountId: account(1),
        });
        org.add('OrderItem', { Id: item(1), Quantity: 2, OrderId: order(1) });
      },
      new RewindTestOrg({ fields: ORDER_FIELDS, children: ORDER_CHILDREN }),
      [...PICKED, 'Order', 'OrderItem'],
    );
    clock.now = SINCE;
    t.org.edit('Order', order(1), { Status: 'Draft' }, COLLEAGUE);
    clock.now = SINCE + 5_000;
    t.org.trash('Order', order(1), COLLEAGUE);
    t.org.purge(order(1));
    return t;
  }

  it('is made again as a draft, its product under it, then given its status back, as the checkpoint holds it: inserted activated, the org refused it and its product (GC-F2)', async () => {
    const t = await purgedSince();
    const diff = await previewed(t);
    expect(
      diff.objects
        .filter(({ objectApiName }) => objectApiName.startsWith('Order'))
        .map(({ objectApiName, toRecreate }) => [objectApiName, toRecreate]),
    ).toEqual([
      ['OrderItem', 1],
      ['Order', 1],
    ]);

    const result = resultOf(
      await rewound(t, diff.previewId, { request: { acceptRecreate: true } }),
    );

    expect(result.recreated).toEqual([
      { objectApiName: 'Order', planned: 1, created: 1, refused: 0, reasons: [] },
      { objectApiName: 'OrderItem', planned: 1, created: 1, refused: 0, reasons: [] },
    ]);
    expect(result.status).toBe('success');
    expect(result.residual).toEqual([]);
    const [made] = t.org.all('Order');
    expect(made).toMatchObject({
      Status: 'Activated',
      Description: 'Signed',
      AccountId: account(1),
    });
    expect(t.org.all('OrderItem')).toEqual([
      expect.objectContaining({ Quantity: 2, OrderId: made?.Id }),
    ]);
    // Made a draft, its product under it, then its status alone.
    expect(
      t.org.creates.map(({ objectApiName, records }) => [
        objectApiName,
        records.map((record) => record.Status ?? record.OrderId),
      ]),
    ).toEqual([
      ['Order', ['Draft']],
      ['OrderItem', [made?.Id]],
    ]);
    expect(t.org.updates.filter(({ objectApiName }) => objectApiName === 'Order')).toEqual([
      { objectApiName: 'Order', records: [{ Id: made?.Id, Status: 'Activated' }] },
    ]);
    expect(liveAsHeld(stateOf(t.org), t.folder)).toEqual(t.atCheckpoint.live);
  });

  it('asks for and counts what a flow on an order’s update sends as its status is given back, as its preview counts it', async () => {
    const t = await purgedSince();
    // A flow that emails an order's owner as it is updated, and no other write.
    const sending = automationOf({
      objects: [
        {
          objectApiName: 'Order',
          flows: [
            {
              apiName: 'Order_touched',
              label: 'Order touched',
              timing: 'afterSave',
              startsOn: 'update',
              condition: 'read',
              permissions: [],
              messages: [{ kind: 'email', name: 'Tell owner', limit: 'SingleEmail' }],
            },
          ],
          triggers: [],
        },
      ],
    });
    t.org.emailLimits = { SingleEmail: { Max: 15, Remaining: 15 } };
    clock.now = PREVIEWED;
    const preview = await previewCheckpoint(
      { org: t.org, store: t.store, readAutomation: sending },
      request(t),
    );
    if (!preview.previewed) throw new Error(preview.refusal.message);
    expect(preview.emails?.find((each) => each.limit === 'SingleEmail')).toMatchObject({
      emails: 1,
      objects: [{ objectApiName: 'Order', write: 'update', records: 1, perRecord: 1 }],
    });
    expect(rewindStepsOf(preview.diff).giveBack).toEqual(['Order']);

    expect(
      await rewound(t, preview.diff.previewId, {
        deps: { readAutomation: sending },
        request: { acceptRecreate: true },
      }),
    ).toMatchObject({
      rewound: false,
      refusal: {
        code: 'AUTOMATION',
        message: expect.stringContaining('1 flow(s), trigger(s) or rule(s) of Order') as unknown,
      },
    });
    expect(t.org.creates).toEqual([]);

    const result = resultOf(
      await rewound(t, preview.diff.previewId, {
        deps: { readAutomation: sending },
        request: { acceptRecreate: true, acceptAutomation: true },
      }),
    );
    expect(result.status).toBe('success');
  });

  it('counts no email of an order created since that the rewind keeps, told it may not delete the product made under it outside the checkpoint: its Draft update is not sent', async () => {
    const t = await taken(
      (org) => {
        baseRecords(org);
        org.add('OrderStatus', { Id: 'status-1', ApiName: 'Draft', StatusCode: 'Draft' });
        org.add('OrderStatus', { Id: 'status-2', ApiName: 'Activated', StatusCode: 'Activated' });
      },
      new RewindTestOrg({ fields: ORDER_FIELDS, children: ORDER_CHILDREN }),
      [...PICKED, 'Order'],
    );
    clock.now = SINCE;
    t.org.add('Order', {
      Id: order(2),
      Status: 'Activated',
      AccountId: account(1),
      LastModifiedById: COLLEAGUE,
    });
    t.org.add('OrderItem', { Id: item(2), Quantity: 1, OrderId: order(2) });
    const sending = automationOf({
      objects: [
        {
          objectApiName: 'Order',
          flows: [
            {
              apiName: 'Order_touched',
              label: 'Order touched',
              timing: 'afterSave',
              startsOn: 'update',
              condition: 'read',
              permissions: [],
              messages: [{ kind: 'email', name: 'Tell owner', limit: 'SingleEmail' }],
            },
          ],
          triggers: [],
        },
      ],
    });
    t.org.emailLimits = { SingleEmail: { Max: 15, Remaining: 15 } };
    clock.now = PREVIEWED;
    const previewAsked = async (acceptOutside?: boolean) => {
      const outcome = await previewCheckpoint(
        { org: t.org, store: t.store, readAutomation: sending },
        { ...request(t), ...(acceptOutside !== undefined ? { acceptOutside } : {}) },
      );
      if (!outcome.previewed) throw new Error(outcome.refusal.message);
      return outcome;
    };

    const kept = await previewAsked(false);
    expect(kept.diff.objects.find(({ objectApiName }) => objectApiName === 'Order')).toMatchObject({
      toDelete: { createdSince: 1 },
      outside: [{ objectApiName: 'OrderItem', count: 1, parents: 1 }],
    });
    expect(kept.emails).toBeUndefined();
    // Told it may, it sets the order back to Draft, then deletes it, and the flow sends one.
    const deleted = await previewAsked(true);
    expect(deleted.emails?.find((each) => each.limit === 'SingleEmail')).toMatchObject({
      emails: 1,
      objects: [{ objectApiName: 'Order', write: 'update', records: 1 }],
    });
    // Not told, the page's: every record it would delete is counted, saying too much.
    expect((await previewAsked()).emails).toEqual(deleted.emails);

    // The rewind not asked keeps the order and writes nothing to it, as its preview counted.
    const result = resultOf(
      await rewound(t, kept.diff.previewId, {
        deps: { readAutomation: sending },
        request: { acceptAutomation: true },
      }),
    );
    expect(liveIds(t.org, 'Order')).toEqual([order(2)]);
    expect(t.org.updates.filter(({ objectApiName }) => objectApiName === 'Order')).toEqual([]);
    expect(result.residual).toContainEqual(
      expect.objectContaining({ objectApiName: 'Order', reason: 'kept', count: 1 }),
    );
  });

  it('is set back to Draft by the undo before it is deleted again, and the undo asks for and counts what a flow on an order’s update sends then: the org deletes no order past Draft (P8)', async () => {
    const t = await purgedSince();
    const diff = await previewed(t);
    const made = resultOf(await rewound(t, diff.previewId, { request: { acceptRecreate: true } }));
    const [remade] = t.org.all('Order');
    const read = await t.store.read(t.checkpoint.checkpointId);
    if (!read?.checkpoint || remade === undefined) throw new Error('nothing to undo');
    const checkpoint = read.checkpoint;
    clock.now += 60_000;
    const undo = (asked: { acceptAutomation: boolean }) =>
      undoCheckpoint(
        {
          org: t.org,
          undelete: (ids) => t.org.undelete(ids),
          store: t.store,
          readAutomation: ORDER_UPDATE_EMAIL,
        },
        { ...request(t), checkpoint, rewindId: made.rewindId, ...asked },
      );
    const updatesBefore = t.org.updates.length;

    expect(await undo({ acceptAutomation: false })).toMatchObject({
      undone: false,
      refusal: {
        code: 'AUTOMATION',
        message: expect.stringContaining(
          '1 flow(s), trigger(s) or rule(s) of Order run as the undo brings records back, gives them their values back, sets an order back to Draft or sends them back to the recycle bin',
        ) as unknown,
      },
    });
    t.org.emailLimits = { SingleEmail: { Max: 15, Remaining: 0 } };
    expect(await undo({ acceptAutomation: true })).toMatchObject({
      undone: false,
      refusal: {
        code: 'EMAILS',
        message: expect.stringMatching(
          /^This undo would make DEV-ED send about 1 single email,/,
        ) as unknown,
      },
    });
    expect(t.org.updates).toHaveLength(updatesBefore);

    t.org.emailLimits = { SingleEmail: { Max: 15, Remaining: 15 } };
    const outcome = await undo({ acceptAutomation: true });

    expect(outcome.undone).toBe(true);
    expect(t.org.updates.slice(updatesBefore)).toEqual([
      { objectApiName: 'Order', records: [{ Id: remade.Id, Status: 'Draft' }] },
    ]);
    expect(t.org.all('Order')).toEqual([]);
    expect(t.org.all('OrderItem')).toEqual([]);
  });

  describe('holding a field the org takes on an update and refuses on an insert', () => {
    /**
     * An order's fields with one the org lets a user set on an update and
     * not on a new record: a record made again is made without it, and the
     * rewind's second pass gives it back. Live, a rewind that made an
     * activated order again went through in two passes, its second giving
     * the order back its checkpoint values, on both gates of the C1 orgs.
     */
    const UPDATE_ONLY_FIELDS: Record<string, unknown[]> = {
      ...ORDER_FIELDS,
      Order: [
        ...(ORDER_FIELDS.Order ?? []),
        writable('ActivatedDate', 'datetime', { createable: false }),
      ],
    };

    /** {@link purgedSince}, the order holding that field at the checkpoint. */
    async function purgedHolding(): Promise<Taken> {
      const t = await taken(
        (org) => {
          baseRecords(org);
          org.add('OrderStatus', { Id: 'status-1', ApiName: 'Draft', StatusCode: 'Draft' });
          org.add('OrderStatus', { Id: 'status-2', ApiName: 'Activated', StatusCode: 'Activated' });
          org.add('Order', {
            Id: order(1),
            Status: 'Activated',
            Description: 'Signed',
            ActivatedDate: '2026-11-05T22:30:00.000+0000',
            AccountId: account(1),
          });
          org.add('OrderItem', { Id: item(1), Quantity: 2, OrderId: order(1) });
        },
        new RewindTestOrg({ fields: UPDATE_ONLY_FIELDS, children: ORDER_CHILDREN }),
        [...PICKED, 'Order', 'OrderItem'],
      );
      clock.now = SINCE;
      t.org.edit('Order', order(1), { Status: 'Draft' }, COLLEAGUE);
      clock.now = SINCE + 5_000;
      t.org.trash('Order', order(1), COLLEAGUE);
      t.org.purge(order(1));
      return t;
    }

    it('counts each flow once in the undo’s refusal: the flow on an order’s update fires as the undo gives the order back its values and as it sets it back to Draft, and the flow on its creation runs on neither (GC4-C2)', async () => {
      const t = await purgedHolding();
      const diff = await previewed(t);
      const made = resultOf(
        await rewound(t, diff.previewId, { request: { acceptRecreate: true } }),
      );
      expect(made.status).toBe('success');
      expect(made.passes).toBe(2);
      expect(made.restored).toEqual([
        expect.objectContaining({ objectApiName: 'Order', planned: 1, restored: 1 }),
      ]);
      const read = await t.store.read(t.checkpoint.checkpointId);
      if (!read?.checkpoint) throw new Error('nothing to undo');
      const checkpoint = read.checkpoint;
      clock.now += 60_000;
      // GC4, gate 3, P4: a flow that emails as an order is created, and one
      // as an order is updated.
      const both = automationOf({
        objectsRead: ['Order', 'OrderItem'],
        objects: [
          {
            objectApiName: 'Order',
            flows: [
              {
                apiName: 'GC_Gate_Order_Create_Email',
                label: 'GC Gate Order Create Email',
                timing: 'afterSave',
                startsOn: 'create',
                condition: 'read',
                permissions: [],
                messages: [{ kind: 'email', name: 'Send Gate Email', limit: 'SingleEmail' }],
              },
              {
                apiName: 'GC_Gate_Order_Update_Email',
                label: 'GC Gate Order Update Email',
                timing: 'afterSave',
                startsOn: 'update',
                condition: 'read',
                permissions: [],
                messages: [{ kind: 'email', name: 'Send Gate Email', limit: 'SingleEmail' }],
              },
            ],
            triggers: [],
          },
        ],
      });
      const updatesBefore = t.org.updates.length;

      const refused = await undoCheckpoint(
        {
          org: t.org,
          undelete: (ids) => t.org.undelete(ids),
          store: t.store,
          readAutomation: both,
        },
        { ...request(t), checkpoint, rewindId: made.rewindId, acceptAutomation: false },
      );

      expect(refused).toMatchObject({
        undone: false,
        refusal: {
          code: 'AUTOMATION',
          message: expect.stringMatching(
            /^DEV-ED: 1 flow\(s\), trigger\(s\) or rule\(s\) of Order run as the undo brings records back, gives them their values back, sets an order back to Draft or sends them back to the recycle bin\./,
          ) as unknown,
        },
      });
      expect(t.org.updates).toHaveLength(updatesBefore);
    });
  });

  it('stopped once it was made as a draft and before its status went back, stays a draft in a rewind said stopped part way, and the rewind taken up again gives it its status', async () => {
    const t = await purgedSince();
    const diff = await previewed(t);
    const controller = new AbortController();
    // Stopped as the org answers the insert of the order's product: the
    // order is made, a draft, and its status not given back yet.
    const create = t.org.create.bind(t.org);
    t.org.create = async (objectApiName, records) => {
      const answer = await create(objectApiName, records);
      if (objectApiName === 'OrderItem') controller.abort();
      return answer;
    };

    const stopped = resultOf(
      await rewound(t, diff.previewId, {
        deps: { signal: controller.signal },
        request: { acceptRecreate: true },
      }),
    );

    // What the user reads: a rewind stopped part way, the order and its
    // product made again, and the order named a draft, by its new Id.
    expect(stopped.status).toBe('cancelled');
    expect(stopped.recreated).toEqual([
      { objectApiName: 'Order', planned: 1, created: 1, refused: 0, reasons: [] },
      { objectApiName: 'OrderItem', planned: 1, created: 1, refused: 0, reasons: [] },
    ]);
    expect(stopped.residual).toEqual([]);
    const [draft] = t.org.all('Order');
    expect(draft).toMatchObject({ Status: 'Draft' });
    expect(stopped.draftsLeft).toEqual([{ objectApiName: 'Order', count: 1, ids: [draft?.Id] }]);
    expect(t.org.updates.filter(({ objectApiName }) => objectApiName === 'Order')).toEqual([]);

    t.org.create = create;
    // Taken up as the command line and the page take it up: the org read
    // again, the order made since a draft where the checkpoint holds it
    // activated, its status given back.
    clock.now += 60_000;
    const read = await previewCheckpoint({ org: t.org, store: t.store }, request(t));
    if (!read.previewed) throw new Error(read.refusal.message);
    expect(
      read.diff.objects
        .filter(({ objectApiName }) => objectApiName.startsWith('Order'))
        .map(({ objectApiName, toGiveBack, toRecreate }) => [
          objectApiName,
          toGiveBack.records,
          toRecreate ?? 0,
        ]),
    ).toEqual([
      ['OrderItem', 0, 0],
      ['Order', 1, 0],
    ]);
    const again = resultOf(await rewound(t, read.diff.previewId));

    expect(again.status).toBe('success');
    expect(again.draftsLeft).toBeUndefined();
    expect(t.org.all('Order')).toEqual([expect.objectContaining({ Status: 'Activated' })]);
    expect(t.org.all('OrderItem')).toHaveLength(1);
  });

  it('is left a draft, named with the org’s words, when the org refuses its status back: its product made under it all the same', async () => {
    const t = await purgedSince();
    const diff = await previewed(t);
    const update = t.org.update.bind(t.org);
    t.org.update = async (objectApiName, records) =>
      objectApiName === 'Order' && records.some((record) => record.Status === 'Activated')
        ? records.map((record) => ({
            id: record.Id,
            success: false,
            errors: [{ statusCode: 'FAILED_ACTIVATION', message: 'Choose a valid status.' }],
          }))
        : update(objectApiName, records);

    const result = resultOf(
      await rewound(t, diff.previewId, { request: { acceptRecreate: true } }),
    );

    expect(result.recreated).toContainEqual({
      objectApiName: 'Order',
      planned: 1,
      created: 1,
      refused: 0,
      reasons: [
        'Made again as a draft, but its status was refused: FAILED_ACTIVATION: Choose a valid status.',
      ],
    });
    expect(t.org.all('Order')).toEqual([expect.objectContaining({ Status: 'Draft' })]);
    expect(t.org.all('OrderItem')).toHaveLength(1);
    expect(result.status).not.toBe('success');
  });

  describe('emptied from the recycle bin, which the org still lists it in (GC2, P11)', () => {
    /** A flow that emails an order's owner as it is created, and no other write. */
    const ORDER_CREATE_EMAIL = automationOf({
      objectsRead: ['Account', 'Contact', 'Opportunity', 'Order', 'OrderItem'],
      objects: [
        {
          objectApiName: 'Order',
          flows: [
            {
              apiName: 'Order_created',
              label: 'Order created',
              timing: 'afterSave',
              startsOn: 'create',
              condition: 'read',
              permissions: [],
              messages: [{ kind: 'email', name: 'Tell owner', limit: 'SingleEmail' }],
            },
          ],
          triggers: [],
        },
      ],
    });

    /**
     * The order of {@link purgedSince}, emptied from the recycle bin instead:
     * the org still reads it deleted, with its product, and answers its
     * undelete "Entity is not in the recycle bin" (P11). Its preview counts
     * both to bring back, nothing to make again.
     */
    async function emptiedSince(): Promise<Taken> {
      const t = await taken(
        (org) => {
          baseRecords(org);
          org.add('OrderStatus', { Id: 'status-1', ApiName: 'Draft', StatusCode: 'Draft' });
          org.add('OrderStatus', { Id: 'status-2', ApiName: 'Activated', StatusCode: 'Activated' });
          org.add('Order', {
            Id: order(1),
            Status: 'Activated',
            Description: 'Signed',
            AccountId: account(1),
          });
          org.add('OrderItem', { Id: item(1), Quantity: 2, OrderId: order(1) });
        },
        new RewindTestOrg({ fields: ORDER_FIELDS, children: ORDER_CHILDREN }),
        [...PICKED, 'Order', 'OrderItem'],
      );
      clock.now = SINCE;
      t.org.edit('Order', order(1), { Status: 'Draft' }, COLLEAGUE);
      clock.now = SINCE + 5_000;
      t.org.trash('Order', order(1), COLLEAGUE);
      t.org.empty(order(1));
      return t;
    }

    async function previewedWith(
      t: Taken,
      readAutomation: RewindDeps['readAutomation'],
    ): Promise<RewindDiff> {
      clock.now = Math.max(clock.now, PREVIEWED);
      const outcome = await previewCheckpoint(
        { org: t.org, store: t.store, ...(readAutomation ? { readAutomation } : {}) },
        request(t),
      );
      if (!outcome.previewed) throw new Error(outcome.refusal.message);
      return outcome.diff;
    }

    it('is not made again by a rewind that brings it back when what the org runs as an order is created was not asked: kept, named with what runs, and the rewind after it counts it to make again and asks', async () => {
      const t = await emptiedSince();
      const diff = await previewedWith(t, ORDER_CREATE_EMAIL);
      expect(
        diff.objects
          .filter(({ objectApiName }) => objectApiName.startsWith('Order'))
          .map(({ objectApiName, toBringBack, toRecreate }) => [
            objectApiName,
            toBringBack.inBin + toBringBack.withParent,
            toRecreate ?? 0,
          ]),
      ).toEqual([
        ['OrderItem', 1, 0],
        ['Order', 1, 0],
      ]);

      const result = resultOf(
        await rewound(t, diff.previewId, {
          deps: { readAutomation: ORDER_CREATE_EMAIL },
          request: { acceptRecreate: true },
        }),
      );

      // Nothing was made: the flow on an order's insert never ran unasked.
      expect(t.org.creates).toEqual([]);
      expect(result.recreated ?? []).toEqual([]);
      // Nothing else to write: nothing went through, each record said with why,
      // and no undo is offered of what wrote nothing.
      expect(result.status).toBe('failure');
      expect(result.undo).toBeUndefined();
      const words =
        "Kept as it is: Salesforce answered it is no longer in the recycle bin, and making it again runs what DEV-ED runs as it is created or given its status back (Order: 'Order created'), which this rewind did not ask about. Rewind again: its preview counts it to make again, and asks.";
      expect(result.residual).toEqual([
        { objectApiName: 'OrderItem', reason: 'kept', count: 1, ids: [item(1)], message: words },
        { objectApiName: 'Order', reason: 'kept', count: 1, ids: [order(1)], message: words },
      ]);
      expect(result.undeleted).toContainEqual(
        expect.objectContaining({ objectApiName: 'Order', refused: 1, reasons: [words] }),
      );

      // Read again, the org's answer kept with the checkpoint: both to make
      // again, and what runs then asked about before anything is written.
      clock.now += 60_000;
      const again = await previewedWith(t, ORDER_CREATE_EMAIL);
      expect(
        again.objects
          .filter(({ objectApiName }) => objectApiName.startsWith('Order'))
          .map(({ objectApiName, toRecreate }) => [objectApiName, toRecreate ?? 0]),
      ).toEqual([
        ['OrderItem', 1],
        ['Order', 1],
      ]);
      expect(
        await rewound(t, again.previewId, {
          deps: { readAutomation: ORDER_CREATE_EMAIL },
          request: { acceptRecreate: true },
        }),
      ).toMatchObject({
        rewound: false,
        refusal: {
          code: 'AUTOMATION',
          message: expect.stringContaining(
            '1 flow(s), trigger(s) or rule(s) of Order run as the rewind brings records back, makes them again',
          ) as unknown,
        },
      });
      expect(t.org.creates).toEqual([]);

      const made = resultOf(
        await rewound(t, again.previewId, {
          deps: { readAutomation: ORDER_CREATE_EMAIL },
          request: { acceptRecreate: true, acceptAutomation: true },
        }),
      );
      expect(made.status).toBe('success');
      expect(t.org.all('Order')).toEqual([expect.objectContaining({ Status: 'Activated' })]);
      expect(t.org.all('OrderItem')).toHaveLength(1);
    });

    it('is not made again when the emails what runs as it is made sends would pass what the org has left today beyond what the rewind counted, though that was asked: kept, said, and counted by the rewind after it (checkpoint-tail)', async () => {
      // Two activated orders at the checkpoint, each set back to Draft and
      // deleted since: the first emptied from the bin, which the org still
      // lists — counted to bring back —, the second gone from it — counted to
      // make again, so what runs as an order is created is asked about.
      const t = await taken(
        (org) => {
          baseRecords(org);
          org.add('OrderStatus', { Id: 'status-1', ApiName: 'Draft', StatusCode: 'Draft' });
          org.add('OrderStatus', { Id: 'status-2', ApiName: 'Activated', StatusCode: 'Activated' });
          for (const n of [1, 2]) {
            org.add('Order', {
              Id: order(n),
              Status: 'Activated',
              Description: `Signed ${n}`,
              AccountId: account(1),
            });
          }
        },
        new RewindTestOrg({ fields: ORDER_FIELDS, children: ORDER_CHILDREN }),
        [...PICKED, 'Order', 'OrderItem'],
      );
      clock.now = SINCE;
      for (const n of [1, 2]) t.org.edit('Order', order(n), { Status: 'Draft' }, COLLEAGUE);
      clock.now = SINCE + 5_000;
      for (const n of [1, 2]) t.org.trash('Order', order(n), COLLEAGUE);
      t.org.empty(order(1));
      t.org.purge(order(2));
      // A Developer Edition with one single email left today.
      t.org.emailLimits = { SingleEmail: { Max: 15, Remaining: 1 } };
      clock.now = PREVIEWED;
      const preview = await previewCheckpoint(
        { org: t.org, store: t.store, readAutomation: ORDER_CREATE_EMAIL },
        request(t),
      );
      if (!preview.previewed) throw new Error(preview.refusal.message);
      expect(
        preview.diff.objects
          .filter(({ objectApiName }) => objectApiName === 'Order')
          .map(({ toBringBack, toRecreate }) => [toBringBack.inBin, toRecreate ?? 0]),
      ).toEqual([[1, 1]]);
      // The one counted to make again sends the one email left: it fits.
      expect(preview.emails).toEqual([
        expect.objectContaining({ limit: 'SingleEmail', emails: 1, verdict: 'fits' }),
      ]);

      const result = resultOf(
        await rewound(t, preview.diff.previewId, {
          deps: { readAutomation: ORDER_CREATE_EMAIL },
          request: { acceptRecreate: true, acceptAutomation: true },
        }),
      );

      // The order counted to make again is made; the one found gone in the
      // bin is not: its email would have been the second of one left.
      expect(t.org.creates).toEqual([
        { objectApiName: 'Order', records: [expect.objectContaining({ Description: 'Signed 2' })] },
      ]);
      const words =
        'Kept as it is: Salesforce answered it is no longer in the recycle bin, and making it again sends 1 single email more than the 1 single email it counted, past the 1 of 15 DEV-ED has left today. Rewind again: its preview counts it to make again, and its emails.';
      expect(result.residual).toContainEqual({
        objectApiName: 'Order',
        reason: 'kept',
        count: 1,
        ids: [order(1)],
        message: words,
      });
      expect(result.status).toBe('partial');
    });

    it('is made again in the same rewind when nothing the org runs as an order is created or updated was left unasked: as a draft, its product under it, then its status', async () => {
      const t = await emptiedSince();
      const quiet = automationOf({
        objectsRead: ['Account', 'Contact', 'Opportunity', 'Order', 'OrderItem'],
      });
      const diff = await previewedWith(t, quiet);

      const result = resultOf(
        await rewound(t, diff.previewId, {
          deps: { readAutomation: quiet },
          request: { acceptRecreate: true },
        }),
      );

      expect(result.status).toBe('success');
      expect(result.recreated).toEqual([
        { objectApiName: 'Order', planned: 1, created: 1, refused: 0, reasons: [] },
        { objectApiName: 'OrderItem', planned: 1, created: 1, refused: 0, reasons: [] },
      ]);
      expect(t.org.all('Order')).toEqual([expect.objectContaining({ Status: 'Activated' })]);
    });

    it('is made again in the same rewind when what runs as one is made could not all be read and --accept-automation let it run: its question said so, which a second rewind would ask word for word (checkpoint-tail)', async () => {
      const t = await emptiedSince();
      const blind = automationOf({
        objectsRead: ['Account', 'Contact', 'Opportunity', 'Order', 'OrderItem'],
        unread: [{ part: 'triggers', reason: 'INSUFFICIENT_ACCESS: no Tooling API' }],
      });
      const diff = await previewedWith(t, blind);

      // Not told to let it run, it is refused before it writes, for that.
      expect(
        await rewound(t, diff.previewId, {
          deps: { readAutomation: blind },
          request: { acceptRecreate: true },
        }),
      ).toMatchObject({
        rewound: false,
        refusal: {
          code: 'AUTOMATION',
          message: expect.stringContaining(
            'what runs as the rewind writes could not all be read, so automation may run',
          ) as unknown,
        },
      });
      expect(t.org.creates).toEqual([]);

      const result = resultOf(
        await rewound(t, diff.previewId, {
          deps: { readAutomation: blind },
          request: { acceptRecreate: true, acceptAutomation: true },
        }),
      );

      expect(result.status).toBe('success');
      expect(result.residual).toEqual([]);
      expect(result.recreated).toEqual([
        { objectApiName: 'Order', planned: 1, created: 1, refused: 0, reasons: [] },
        { objectApiName: 'OrderItem', planned: 1, created: 1, refused: 0, reasons: [] },
      ]);
      expect(t.org.all('Order')).toEqual([expect.objectContaining({ Status: 'Activated' })]);
      expect(t.org.all('OrderItem')).toHaveLength(1);
    });

    it('is not made again when the automation of its object was not read at all: nothing proves it quiet, whatever was accepted', async () => {
      const t = await emptiedSince();
      // The read reached the objects the preview counted to write, and not the order's.
      const partial = automationOf({
        objectsRead: ['Account', 'Contact', 'Opportunity', 'OrderItem'],
      });
      const diff = await previewedWith(t, partial);

      const result = resultOf(
        await rewound(t, diff.previewId, {
          deps: { readAutomation: partial },
          request: { acceptRecreate: true, acceptAutomation: true },
        }),
      );

      expect(t.org.creates).toEqual([]);
      expect(result.residual).toContainEqual(
        expect.objectContaining({
          objectApiName: 'Order',
          reason: 'kept',
          message: expect.stringContaining(
            'what DEV-ED runs as it is created or given its status back could not all be read',
          ) as unknown,
        }),
      );
    });
  });
});

describe('a record Salesforce keeps in the recycle bin under a parent live again', () => {
  /** A contact deleted on its own, then its account, then the account brought back: the contact stays in the bin for good. */
  async function keptInTheBin(): Promise<Awaited<ReturnType<typeof taken>>> {
    const t = await taken();
    clock.now = SINCE;
    t.org.trash('Contact', contact(3), COLLEAGUE);
    clock.now = SINCE + 5_000;
    t.org.trash('Account', account(1), COLLEAGUE);
    clock.now = SINCE + 10_000;
    t.org.untrash(account(1), COLLEAGUE);
    return t;
  }

  it('is refused by the org as not in the bin, and left with words that say it no longer comes back with its Id and what makes it again: no read tells it from one to bring back (F41)', async () => {
    const t = await keptInTheBin();
    const diff = await previewed(t);
    expect(diff.objects.find((object) => object.objectApiName === 'Contact')).toMatchObject({
      toBringBack: { inBin: 1 },
    });

    const result = resultOf(await rewound(t, diff.previewId));

    expect(result.residual).toEqual([
      { objectApiName: 'Contact', reason: 'notInBin', count: 1, ids: [contact(3)] },
    ]);
    expect(result.undeleted).toContainEqual(
      expect.objectContaining({
        objectApiName: 'Contact',
        refused: 1,
        reasons: [NOT_REMADE_WORDS],
      }),
    );
    expect(t.org.creates).toEqual([]);
    expect(t.org.inBin('Contact').map((row) => row.Id)).toEqual([contact(3)]);
  });

  it('is made again with a new Id once making records again was accepted, though the preview counted it to bring back: it can no longer come back with its own (F41)', async () => {
    const t = await keptInTheBin();
    const diff = await previewed(t);

    const result = resultOf(
      await rewound(t, diff.previewId, { request: { acceptRecreate: true } }),
    );

    expect(result.status).toBe('success');
    expect(result.residual).toEqual([]);
    expect(result.recreated).toEqual([
      { objectApiName: 'Contact', planned: 1, created: 1, refused: 0, reasons: [] },
    ]);
    const made = t.org.all('Contact').find((row) => row.LastName === 'Three');
    expect(made).toMatchObject({ AccountId: account(1) });
    expect(made?.Id).not.toBe(contact(3));
    expect(liveAsHeld(stateOf(t.org), t.folder)).toEqual(t.atCheckpoint.live);
  });
});

describe('a lead converted since', () => {
  const LEAD_FIELDS: Record<string, unknown[]> = {
    ...FIELDS,
    Lead: [
      ...STAMP_FIELDS,
      writable('LastName'),
      writable('Status'),
      // Set when a lead is made, never changed after: a conversion sets it.
      { name: 'IsConverted', label: 'Converted', type: 'boolean', createable: true },
    ],
  };
  const lead = (n: number): string => id('00Q', n);

  it('is left converted, never sent an update: the preview names it one the rewind cannot undo, and the rewind says why it left it (A9, F14)', async () => {
    const t = await taken(
      (org) => {
        baseRecords(org);
        org.add('Lead', { Id: lead(1), LastName: 'Ada', Status: 'Open', IsConverted: false });
      },
      new RewindTestOrg({ fields: LEAD_FIELDS }),
      [...PICKED, 'Lead'],
    );
    clock.now = SINCE;
    t.org.edit('Lead', lead(1), { Status: 'Closed - Converted', IsConverted: true }, COLLEAGUE);
    t.org.refuseUpdate.set(lead(1), {
      statusCode: 'CANNOT_UPDATE_CONVERTED_LEAD',
      message: 'cannot reference converted lead',
    });
    const diff = await previewed(t);
    expect(diff.objects.find((object) => object.objectApiName === 'Lead')).toMatchObject({
      toGiveBack: { records: 0, fields: 0, clearedLookups: 0 },
      cannotUndo: [{ reason: 'convertedLead', count: 1 }],
    });

    const result = resultOf(await rewound(t, diff.previewId));

    expect(t.org.updates.filter(({ objectApiName }) => objectApiName === 'Lead')).toEqual([]);
    expect(result.residual).toEqual([
      {
        objectApiName: 'Lead',
        reason: 'kept',
        count: 1,
        ids: [lead(1)],
        message: expect.stringMatching(/can't unconvert a lead/),
      },
    ]);
  });
});

describe('a contract activated since, and a contact gone with an account created since', () => {
  const CONTRACT_FIELDS: Record<string, unknown[]> = {
    ...FIELDS,
    Contract: [
      ...STAMP_FIELDS,
      writable('Status'),
      writable('Description'),
      // The category the org keeps of the status: no one writes it.
      { name: 'StatusCode', label: 'Status Category', type: 'picklist' },
    ],
  };
  const contract = (n: number): string => id('800', n);

  it('leaves a contract activated since as it is, never sent an update, and names why; gives back one edited since (F15)', async () => {
    const t = await taken(
      (org) => {
        baseRecords(org);
        for (const n of [1, 2]) {
          org.add('Contract', {
            Id: contract(n),
            Status: 'Draft',
            StatusCode: 'Draft',
            Description: 'As agreed',
          });
        }
      },
      new RewindTestOrg({ fields: CONTRACT_FIELDS }),
      [...PICKED, 'Contract'],
    );
    clock.now = SINCE;
    t.org.edit(
      'Contract',
      contract(1),
      { Status: 'Activated', StatusCode: 'Activated', Description: 'Signed' },
      COLLEAGUE,
    );
    t.org.edit('Contract', contract(2), { Description: 'Edited' }, COLLEAGUE);
    // What the org answers a contract set back to Draft, live.
    t.org.refuseUpdate.set(contract(1), {
      statusCode: 'FAILED_ACTIVATION',
      message: 'Choose a valid contract status and save your changes.',
    });
    const diff = await previewed(t);
    expect(diff.objects.find((object) => object.objectApiName === 'Contract')).toMatchObject({
      toGiveBack: { records: 1, fields: 1, clearedLookups: 0 },
      cannotUndo: [{ reason: 'activatedContract', count: 1 }],
    });

    const result = resultOf(await rewound(t, diff.previewId));

    expect(t.org.updates.filter(({ objectApiName }) => objectApiName === 'Contract')).toEqual([
      { objectApiName: 'Contract', records: [{ Id: contract(2), Description: 'As agreed' }] },
    ]);
    expect(result.residual).toEqual([
      {
        objectApiName: 'Contract',
        reason: 'kept',
        count: 1,
        ids: [contract(1)],
        message: expect.stringMatching(/won't set an activated contract back to Draft/),
      },
    ]);
  });
});

describe('records of the checkpoint that left with a parent the rewind must not keep', () => {
  /**
   * Contact 30 under account 1 at the checkpoint. Since: account 30 made,
   * contact 30 moved under it and renamed, contact 31 made under it, then
   * account 30 deleted, taking both contacts along in its second.
   */
  async function carriedSince(org = new RewindTestOrg()): Promise<Taken> {
    const t = await taken((held) => {
      baseRecords(held);
      held.add('Contact', { Id: contact(30), LastName: 'Moved', AccountId: account(1) });
    }, org);
    clock.now = SINCE;
    t.org.add('Account', { Id: account(30), Name: 'Made since', LastModifiedById: COLLEAGUE });
    t.org.edit(
      'Contact',
      contact(30),
      { AccountId: account(30), LastName: 'Moved since' },
      COLLEAGUE,
    );
    t.org.add('Contact', {
      Id: contact(31),
      LastName: 'Made since',
      AccountId: account(30),
      LastModifiedById: COLLEAGUE,
    });
    clock.now = SINCE + 30_000;
    t.org.trash('Account', account(30), COLLEAGUE);
    return t;
  }

  const binIds = (t: Taken, objectApiName: string): string[] =>
    t.org
      .inBin(objectApiName)
      .map((row) => row.Id)
      .sort();

  const binIdsOf = (state: ReturnType<typeof stateOf>, objectApiName: string): string[] =>
    (state.bin[objectApiName] as Array<{ Id: string }>).map((row) => row.Id).sort();

  it('brings back for a moment the account made since that took a contact of the checkpoint along, gives the contact its own account and values back, then deletes the account again with the contact made since under it: the org is the checkpoint again, and the verify names nothing', async () => {
    const t = await carriedSince();
    const diff = await previewed(t);
    expect(diff.objects.find((object) => object.objectApiName === 'Account')).toMatchObject({
      toBringBack: { inBin: 0, withParent: 0, deletedWhileTaken: 0, carriers: 1 },
      toDelete: { createdSince: 0, broughtBackSince: 0, comesBackWithParent: 0 },
    });
    expect(diff.objects.find((object) => object.objectApiName === 'Contact')).toMatchObject({
      toBringBack: { inBin: 0, withParent: 1, deletedWhileTaken: 0 },
      toDelete: { createdSince: 0, broughtBackSince: 0, comesBackWithParent: 1 },
      cannotUndo: [],
    });
    const undelete = vi.spyOn(t.org, 'undelete');

    // Deleting records Undo couldn't bring back accepted: none is.
    const result = resultOf(await rewound(t, diff.previewId, { request: { acceptNoUndo: true } }));

    expect(result.status).toBe('success');
    expect(result.residual).toEqual([]);
    expect(result.passes).toBe(2);
    expect(result.carriers).toEqual([{ objectApiName: 'Account', count: 1 }]);
    // One undelete, of the account alone: the contacts come back with it.
    expect(undelete.mock.calls.map(([ids]) => ids)).toEqual([[account(30)]]);
    // One delete, of the account again: the contact made since goes with it,
    // never sent on its own before it, which would keep it in the bin for good.
    expect(t.org.deletes.map(({ ids }) => ids)).toEqual([[account(30)]]);
    expect(result.undo?.cannot).toEqual([]);
    expect(stateOf(t.org).live).toEqual(t.atCheckpoint.live);
    expect(binIds(t, 'Account')).toEqual([account(30)]);
    expect(binIds(t, 'Contact')).toEqual([contact(31)]);
  });

  it('sends back to the recycle bin with the account, never kept alive for it, a contact whose give-back the org refuses, named in the org’s words', async () => {
    const t = await carriedSince();
    t.org.refuseUpdate.set(contact(30), {
      statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
      message: 'Phone must be written +33…',
    });
    const diff = await previewed(t);

    const result = resultOf(await rewound(t, diff.previewId));

    expect(liveIds(t.org, 'Account')).not.toContain(account(30));
    expect(binIds(t, 'Contact')).toEqual([contact(30), contact(31)]);
    const stampOf = (objectApiName: string, record: string): unknown =>
      t.org.inBin(objectApiName).find((row) => row.Id === record)?.SystemModstamp;
    expect(stampOf('Contact', contact(30))).toBe(stampOf('Account', account(30)));
    expect(result.residual).toEqual([
      {
        objectApiName: 'Contact',
        reason: 'refused',
        count: 1,
        ids: [contact(30)],
        message: expect.stringMatching(/Phone must be written/) as unknown,
      },
    ]);
    expect(result.status).toBe('partial');
  });

  it('undone, sends the contact back to the recycle bin on its own, never writing it a lookup to the account it went with, which stays in the bin with the contact made since; it says so', async () => {
    const t = await carriedSince();
    const before = stateOf(t.org);
    const diff = await previewed(t);
    const result = resultOf(await rewound(t, diff.previewId));
    const sent = t.org.updates.length;

    const undo = await undone(t, result.rewindId);

    expect(undo.status).toBe('success');
    expect(undo.residual).toEqual([]);
    expect(undo.carriedAlone).toEqual([{ objectApiName: 'Contact', count: 1 }]);
    expect(
      t.org.updates
        .slice(sent)
        .flatMap(({ records }) => records)
        .filter((record) => record.AccountId === account(30)),
    ).toEqual([]);
    expect(stateOf(t.org).live).toEqual(before.live);
    for (const objectApiName of ['Account', 'Contact']) {
      expect(binIds(t, objectApiName)).toEqual(binIdsOf(before, objectApiName));
    }
    // Back in the bin on its own, the contact holds its own account: it comes back alone.
    expect(t.org.inBin('Contact').find((row) => row.Id === contact(30))?.AccountId).toBe(
      account(1),
    );
  });

  it('stopped between its passes, leaves the account alive until it is rewound again, which deletes it with what came back with it on the same journal; its undo returns the org to how it was before the first pass', async () => {
    const t = await carriedSince();
    const before = stateOf(t.org);
    const diff = await previewed(t);
    const controller = new AbortController();

    const outcome = await rewound(t, diff.previewId, {
      deps: {
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.pass === 2) controller.abort();
        },
      },
    });
    const stopped = resultOf(outcome);

    expect(stopped.status).toBe('cancelled');
    expect(outcome.rewound && outcome.notes).toEqual([
      expect.stringMatching(/^Stopped with 1 Account record\(s\) brought back for a moment/),
    ]);
    expect(liveIds(t.org, 'Account')).toContain(account(30));
    const again = await previewed(t);
    const result = resultOf(await rewound(t, again.previewId));
    expect(result.status).toBe('success');
    expect(result.rewindId).toBe(stopped.rewindId);
    expect(stateOf(t.org).live).toEqual(t.atCheckpoint.live);
    expect(liveIds(t.org, 'Account')).not.toContain(account(30));

    await undone(t, result.rewindId);

    expect(stateOf(t.org).live).toEqual(before.live);
    for (const objectApiName of ['Account', 'Contact']) {
      expect(binIds(t, objectApiName)).toEqual(binIdsOf(before, objectApiName));
    }
  });

  it('brings back for a moment an account in the recycle bin at the checkpoint, brought back since and deleted again with a contact of the checkpoint moved under it, then deletes it again', async () => {
    const t = await taken((held) => {
      baseRecords(held);
      held.add('Account', { Id: account(40), Name: 'In the bin' });
      held.add('Contact', { Id: contact(40), LastName: 'Moved', AccountId: account(1) });
      held.trash('Account', account(40));
    });
    clock.now = SINCE;
    t.org.untrash(account(40), COLLEAGUE);
    t.org.edit('Contact', contact(40), { AccountId: account(40) }, COLLEAGUE);
    clock.now = SINCE + 30_000;
    t.org.trash('Account', account(40), COLLEAGUE);
    const diff = await previewed(t);
    expect(diff.objects.find((object) => object.objectApiName === 'Account')?.toBringBack).toEqual({
      inBin: 0,
      withParent: 0,
      deletedWhileTaken: 0,
      carriers: 1,
    });
    expect(
      diff.objects.find((object) => object.objectApiName === 'Contact')?.toBringBack,
    ).toMatchObject({ inBin: 0, withParent: 1 });

    const result = resultOf(await rewound(t, diff.previewId));

    expect(result.status).toBe('success');
    expect(stateOf(t.org).live).toEqual(t.atCheckpoint.live);
    expect(binIds(t, 'Account')).toContain(account(40));
  });

  it('brings back with the contact a note of the checkpoint hanging from it, which went along in the same second', async () => {
    const fields = {
      ...FIELDS,
      Note__c: [
        ...STAMP_FIELDS,
        writable('Body__c'),
        writable('Contact__c', 'reference', { referenceTo: ['Contact'] }),
      ],
    };
    const children = {
      ...CHILDREN,
      Contact: [{ childSObject: 'Note__c', field: 'Contact__c', cascadeDelete: true }],
    };
    const note = id('a0n', 30);
    const held = [...PICKED, 'Note__c'];
    const compared = [...COMPARED, 'Body__c', 'Contact__c'];
    const t = await taken(
      (org) => {
        baseRecords(org);
        org.add('Contact', { Id: contact(30), LastName: 'Moved', AccountId: account(1) });
        org.add('Note__c', { Id: note, Body__c: 'Kept', Contact__c: contact(30) });
      },
      new RewindTestOrg({ fields, children }),
      held,
      { objects: held, fields: compared },
    );
    clock.now = SINCE;
    t.org.add('Account', { Id: account(30), Name: 'Made since' });
    t.org.edit('Contact', contact(30), { AccountId: account(30) }, COLLEAGUE);
    clock.now = SINCE + 30_000;
    t.org.trash('Account', account(30), COLLEAGUE);
    const diff = await previewed(t);
    expect(diff.objects.find((object) => object.objectApiName === 'Note__c')?.toBringBack).toEqual({
      inBin: 0,
      withParent: 1,
      deletedWhileTaken: 0,
    });

    const result = resultOf(await rewound(t, diff.previewId));

    expect(result.residual).toEqual([]);
    expect(liveIds(t.org, 'Note__c')).toEqual([note]);
    expect(stateOf(t.org, held, compared).live).toEqual(t.atCheckpoint.live);
  });

  it('names, never brings back and never makes again, a contact deleted with its account made since in a checkpoint that does not hold accounts: the original would come back beside one made again the day someone brought the account back', async () => {
    const t = await taken(
      (held) => {
        baseRecords(held);
        held.add('Contact', { Id: contact(30), LastName: 'Moved', AccountId: account(1) });
      },
      new RewindTestOrg(),
      ['Contact'],
    );
    clock.now = SINCE;
    t.org.add('Account', { Id: account(30), Name: 'Made since' });
    t.org.edit('Contact', contact(30), { AccountId: account(30) }, COLLEAGUE);
    clock.now = SINCE + 30_000;
    t.org.trash('Account', account(30), COLLEAGUE);
    const diff = await previewed(t);
    expect(diff.objects.find((object) => object.objectApiName === 'Contact')).toMatchObject({
      toBringBack: { inBin: 0, withParent: 0, deletedWhileTaken: 0 },
      cannotUndo: [{ reason: 'deletedWithParentOutside', count: 1 }],
    });
    expect(diff.parentsOutsideRequests).toBeGreaterThan(0);
    const undelete = vi.spyOn(t.org, 'undelete');

    const result = resultOf(
      await rewound(t, diff.previewId, { request: { acceptRecreate: true } }),
    );

    expect(undelete.mock.calls.flatMap(([ids]) => ids)).not.toContain(contact(30));
    expect(t.org.creates).toEqual([]);
    expect(result.residual).toEqual([
      {
        objectApiName: 'Contact',
        reason: 'kept',
        count: 1,
        ids: [contact(30)],
        message: expect.stringMatching(/an object the checkpoint does not hold/) as unknown,
      },
    ]);
    expect(binIds(t, 'Contact')).toEqual([contact(30)]);
  });
});

describe('the records that come back with a record brought back', () => {
  /** Accounts list a view over their activities, contacts a team membership without a recycle bin. */
  const VIEW_FIELDS: Record<string, unknown[]> = {
    ...FIELDS,
    ActivityHistory: [
      ...STAMP_FIELDS,
      writable('AccountId', 'reference', { referenceTo: ['Account'] }),
    ],
    CaseTeamMember: [
      ...STAMP_FIELDS.filter(({ name }) => name !== 'IsDeleted'),
      writable('MemberId', 'reference', { referenceTo: ['Contact'] }),
    ],
    Note__c: [...STAMP_FIELDS, writable('Account__c', 'reference', { referenceTo: ['Account'] })],
  };
  const VIEW_CHILDREN = {
    ...CHILDREN,
    Account: [
      ...(CHILDREN.Account ?? []),
      { childSObject: 'ActivityHistory', field: 'AccountId', cascadeDelete: true },
      { childSObject: 'Note__c', field: 'Account__c', cascadeDelete: true },
    ],
    Contact: [{ childSObject: 'CaseTeamMember', field: 'MemberId', cascadeDelete: true }],
  };
  const many = 201;

  it(
    'are not read through an object the org does not query, nor, once it answered so, through one without a recycle bin: neither is warned of, and a read refused otherwise is',
    async () => {
      const org = new RewindTestOrg({ fields: VIEW_FIELDS, children: VIEW_CHILDREN });
      const t = await taken(
        (o) => {
          for (let n = 0; n < many; n++) {
            o.add('Account', { Id: account(100 + n), Name: `Account ${n}` });
            o.add('Contact', {
              Id: contact(100 + n),
              LastName: `Contact ${n}`,
              AccountId: account(100 + n),
            });
          }
        },
        org,
        ['Account', 'Contact'],
        { objects: ['Account', 'Contact'] },
      );
      t.org.unqueryable.add('ActivityHistory');
      t.org.refuseRead.set('ActivityHistory', {
        errorCode: 'INVALID_TYPE_FOR_OPERATION',
        message: 'entity type ActivityHistory does not support query',
      });
      t.org.missingFields.set('CaseTeamMember', new Set(['IsDeleted']));
      t.org.refuseRead.set('Note__c', {
        errorCode: 'INSUFFICIENT_ACCESS',
        message: 'insufficient access rights on object id',
      });
      clock.now = SINCE;
      for (let n = 0; n < many; n++) t.org.trash('Account', account(100 + n), COLLEAGUE);
      const asked: string[] = [];
      const request = t.org.request.bind(t.org);
      t.org.request = async (sent) => {
        if (sent.body !== undefined) asked.push(decodeURIComponent(JSON.stringify(sent.body)));
        return request(sent);
      };
      const diff = await previewed(t);

      const outcome = await rewound(t, diff.previewId);

      expect(resultOf(outcome).status).toBe('success');
      if (!outcome.rewound) return;
      const readsOf = (object: string): number =>
        asked.filter((body) => body.includes(`FROM ${object} WHERE`)).length;
      expect(readsOf('ActivityHistory')).toBe(0);
      // Two batches of accounts brought back, their contacts with them: the
      // team members asked once, under the first.
      expect(readsOf('CaseTeamMember')).toBe(1);
      expect(outcome.notes.filter((note) => /ActivityHistory|CaseTeamMember/.test(note))).toEqual(
        [],
      );
      expect(outcome.notes.filter((note) => /Note__c/.test(note)).length).toBeGreaterThan(0);
    },
    paced(60_000),
  );
});
