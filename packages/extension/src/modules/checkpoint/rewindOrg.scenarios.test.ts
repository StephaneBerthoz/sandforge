import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { readRewindJournal } from './rewindJournal.js';
import type { RewindDeps } from './rewindOrg.js';

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
