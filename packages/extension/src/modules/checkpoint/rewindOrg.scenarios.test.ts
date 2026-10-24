import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  PRICE_BOOK_HELD,
  SINCE,
  STAMP_FIELDS,
  T0,
  account,
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
import { readRewindJournal, undoPlansOf } from './rewindJournal.js';
import { NOT_REMADE_WORDS, type RewindDeps } from './rewindOrg.js';

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

  it('leaves in the recycle bin a contact deleted with an account created since, never sent, and names why', async () => {
    const t = await taken((org) => {
      baseRecords(org);
      org.add('Contact', { Id: contact(30), LastName: 'Moved', AccountId: account(1) });
    });
    clock.now = SINCE;
    t.org.add('Account', { Id: account(30), Name: 'Made since' });
    t.org.edit('Contact', contact(30), { AccountId: account(30) }, COLLEAGUE);
    clock.now = SINCE + 30_000;
    t.org.trash('Account', account(30), COLLEAGUE);
    const diff = await previewed(t);
    expect(diff.objects.find((object) => object.objectApiName === 'Contact')).toMatchObject({
      toBringBack: { inBin: 0, withParent: 0, deletedWhileTaken: 0 },
      cannotUndo: [{ reason: 'deletedWithCreatedParent', count: 1 }],
    });
    const undelete = vi.spyOn(t.org, 'undelete');

    const result = resultOf(await rewound(t, diff.previewId));

    expect(undelete.mock.calls.flatMap(([ids]) => ids)).not.toContain(contact(30));
    expect(result.residual).toEqual([
      {
        objectApiName: 'Contact',
        reason: 'kept',
        count: 1,
        ids: [contact(30)],
        message: expect.stringMatching(/deleted with a record created since/),
      },
    ]);
    expect(t.org.inBin('Contact').map((row) => row.Id)).toEqual([contact(30)]);
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
