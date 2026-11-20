import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RewindSelectionPlan } from '@sandforge/shared';

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import {
  CHILDREN,
  COLLEAGUE,
  FIELDS,
  SINCE,
  STAMP_FIELDS,
  T0,
  account,
  clock,
  contact,
  id,
  previewed,
  removeTaken,
  resultOf,
  rewound,
  taken,
  undone,
  writable,
  RewindTestOrg,
  type Taken,
} from '../../test/rewindTestOrg.js';
import { previewDirOf, rewindDirOf } from './OrgCheckpointStore.js';
import { planSelection, snapshotRowsOf } from './rewindPlan.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * The relation the platform writes between a contact and its account, in an
 * org with Contacts to Multiple Accounts, as a rewind meets it on the memory
 * org. A relation goes to the recycle bin with its contact and with its
 * account, and Salesforce undeletes none on its own (its describe says it is
 * not undeletable). Run for real on an Autopilot run's checkpoint of Account,
 * Contact and their relation (19/11): a rewind limited to Contact deleted the
 * run's 1,000 contacts, and their 1,000 relations with them, and said
 * "deleted 1,001"; its undo said "brought back 1,001" for 2,001. Its rewind
 * of every object, its preview read without --accept-outside, refused for
 * two relations Undo couldn't bring back: those of the two contacts it kept.
 */

const RELATION = 'AccountContactRelation';
/** An object the checkpoint does not hold whose records the org deletes with their contact. */
const SURVEY = 'Survey__c';
const relation = (n: number): string => id('07k', n);
const survey = (n: number): string => id('a0S', n);

/** An org whose contacts hold a relation to their account, and surveys the checkpoint does not hold. */
function relationsOrg(): RewindTestOrg {
  const org = new RewindTestOrg({
    fields: {
      ...FIELDS,
      [RELATION]: [
        ...STAMP_FIELDS,
        writable('AccountId', 'reference', { referenceTo: ['Account'], updateable: false }),
        writable('ContactId', 'reference', { referenceTo: ['Contact'], updateable: false }),
        writable('Roles'),
      ],
      [SURVEY]: [
        ...STAMP_FIELDS,
        writable('Score__c', 'double'),
        writable('Contact__c', 'reference', { referenceTo: ['Contact'] }),
      ],
    },
    children: {
      ...CHILDREN,
      Account: [
        ...(CHILDREN.Account ?? []),
        { childSObject: RELATION, field: 'AccountId', cascadeDelete: true },
      ],
      Contact: [
        { childSObject: RELATION, field: 'ContactId', cascadeDelete: true },
        { childSObject: SURVEY, field: 'Contact__c', cascadeDelete: true },
      ],
    },
  });
  org.comesBackOnlyWithParent.add(RELATION);
  return org;
}

/** What the org held long before the checkpoint: an account, its contact, their relation. */
function atCheckpoint(org: RewindTestOrg): void {
  org.add('Account', { Id: account(1), Name: 'Account one' });
  org.add('Contact', { Id: contact(1), LastName: 'One', AccountId: account(1) });
  org.add(RELATION, { Id: relation(1), AccountId: account(1), ContactId: contact(1) });
}

/** A contact made since under `under`, with the relation the platform writes with it. */
function contactMade(org: RewindTestOrg, n: number, under: string): void {
  org.add('Contact', {
    Id: contact(n),
    LastName: 'Made since',
    AccountId: under,
    LastModifiedById: COLLEAGUE,
  });
  org.add(RELATION, {
    Id: relation(n),
    AccountId: under,
    ContactId: contact(n),
    LastModifiedById: COLLEAGUE,
  });
}

/** The checkpoint of accounts, contacts and their relations, then a run's account and its contacts. */
async function afterTheRun(more: (org: RewindTestOrg) => void = () => undefined): Promise<Taken> {
  const t = await taken(atCheckpoint, relationsOrg(), ['Account', 'Contact', RELATION]);
  clock.now = SINCE;
  t.org.add('Account', { Id: account(4), Name: 'Made since', LastModifiedById: COLLEAGUE });
  contactMade(t.org, 4, account(4));
  contactMade(t.org, 5, account(4));
  more(t.org);
  return t;
}

/** What the page is told of the selection `objects`, planned from the preview `previewId`. */
async function planOf(
  t: Taken,
  previewId: string,
  readAt: string,
  objects: readonly string[] | undefined,
  acceptOutside: boolean,
): Promise<RewindSelectionPlan> {
  return planSelection({
    checkpoint: t.checkpoint,
    previewDir: previewDirOf(t.folder, previewId),
    readAt,
    ...(objects ? { objects: new Set(objects) } : {}),
    acceptOutside,
    heldRows: snapshotRowsOf(t.checkpoint, t.folder),
  });
}

const liveIdsOf = (t: Taken, objectApiName: string): string[] =>
  t.org
    .all(objectApiName)
    .map((row) => row.Id)
    .sort();
const binIdsOf = (t: Taken, objectApiName: string): string[] =>
  t.org
    .inBin(objectApiName)
    .map((row) => row.Id)
    .sort();

/** Per object, what a rewind set out to delete and deleted. */
const deletedOf = (result: ReturnType<typeof resultOf>) =>
  result.deleted.map(({ objectApiName, planned, deleted }) => ({
    objectApiName,
    planned,
    deleted,
  }));

/** The lines of a rewind's journal of one kind, as it keeps them. */
function journalLinesOf(
  t: Taken,
  rewindId: string,
  kind: string,
): Array<{ objectApiName: string; ids: string[]; parents?: string[] }> {
  return readFileSync(join(rewindDirOf(t.folder, rewindId), 'journal.ndjson'), 'utf8')
    .split('\n')
    .filter((text) => text !== '')
    .map(
      (text) =>
        JSON.parse(text) as {
          kind: string;
          objectApiName: string;
          ids: string[];
          parents?: string[];
        },
    )
    .filter((line) => line.kind === kind);
}

beforeEach(() => {
  clock.now = T0;
});

afterEach(() => {
  removeTaken();
  vi.mocked(getJsforceConnection).mockReset();
});

describe('a rewind limited to contacts, the relations made with them', () => {
  it('says, before it runs, that the relations of the contacts it deletes go with them, though relations are not picked', async () => {
    const t = await afterTheRun();
    const diff = await previewed(t);

    const plan = await planOf(t, diff.previewId, diff.readAt, ['Contact'], true);

    expect(plan.acts).toEqual([
      {
        objectApiName: RELATION,
        picked: false,
        toDelete: 2,
        withParent: 2,
        toGiveBack: 0,
        toBringBack: 0,
        toRecreate: 0,
      },
      {
        objectApiName: 'Contact',
        picked: true,
        toDelete: 2,
        toGiveBack: 0,
        toBringBack: 0,
        toRecreate: 0,
      },
    ]);
    expect(plan.left).toEqual([]);
  });

  it('counts deleted, beside the contacts it sends, the relations that went to the recycle bin with them, each named in its journal beside its contact', async () => {
    const t = await afterTheRun();
    const diff = await previewed(t);

    const result = resultOf(
      await rewound(t, diff.previewId, { request: { objects: ['Contact'], acceptOutside: true } }),
    );

    expect(result.status).toBe('success');
    expect(t.org.deletes.flatMap(({ ids }) => ids).sort()).toEqual([contact(4), contact(5)]);
    expect(binIdsOf(t, RELATION)).toEqual([relation(4), relation(5)]);
    // The account is not rewound: it stays, with nothing under it.
    expect(liveIdsOf(t, 'Account')).toContain(account(4));
    expect(deletedOf(result)).toEqual([
      { objectApiName: RELATION, planned: 2, deleted: 2 },
      { objectApiName: 'Contact', planned: 2, deleted: 2 },
    ]);
    expect(result.wentAlong).toEqual([{ objectApiName: RELATION, count: 2 }]);
    const along = journalLinesOf(t, result.rewindId, 'goingAlong');
    expect(
      along.map(({ objectApiName, ids, parents }) => ({ objectApiName, ids, parents })),
    ).toEqual([
      // Each beside its contact, by the key the journal names a record by.
      {
        objectApiName: RELATION,
        ids: [relation(4), relation(5)],
        parents: [contact(4).slice(0, 15), contact(5).slice(0, 15)],
      },
    ]);
  });

  it('counts brought back, in its undo, the relations that came back with their contacts, sending the undelete the contacts alone', async () => {
    const t = await afterTheRun();
    const diff = await previewed(t);
    const rewind = resultOf(
      await rewound(t, diff.previewId, { request: { objects: ['Contact'], acceptOutside: true } }),
    );
    const undelete = vi.spyOn(t.org, 'undelete');

    const undo = await undone(t, rewind.rewindId);

    expect(undo.status).toBe('success');
    expect(liveIdsOf(t, RELATION)).toEqual([relation(1), relation(4), relation(5)]);
    expect(undelete.mock.calls.flatMap(([ids]) => ids).sort()).toEqual([contact(4), contact(5)]);
    expect(
      undo.undeleted.map(({ objectApiName, planned, undeleted }) => ({
        objectApiName,
        planned,
        undeleted,
      })),
    ).toEqual([
      { objectApiName: 'Contact', planned: 2, undeleted: 2 },
      { objectApiName: RELATION, planned: 2, undeleted: 2 },
    ]);
    expect(undo.cameBackAlong).toEqual([{ objectApiName: RELATION, count: 2 }]);
  });

  it('keeps the contacts the relations made since hang from when deleting them was not accepted, and counts nothing gone with them', async () => {
    const t = await afterTheRun();
    const diff = await previewed(t);

    const result = resultOf(
      await rewound(t, diff.previewId, { request: { objects: ['Contact'] } }),
    );

    expect(liveIdsOf(t, 'Contact')).toEqual([contact(1), contact(4), contact(5)]);
    expect(liveIdsOf(t, RELATION)).toEqual([relation(1), relation(4), relation(5)]);
    expect(t.org.deletes).toEqual([]);
    expect(result.wentAlong).toBeUndefined();
  });
});

describe('the relation of a contact to its account, its contact kept', () => {
  /** The run's first contact answered a survey, which the checkpoint does not hold. */
  const surveyed = (org: RewindTestOrg): void => {
    org.add(SURVEY, {
      Id: survey(1),
      Score__c: 9,
      Contact__c: contact(4),
      LastModifiedById: COLLEAGUE,
    });
  };

  it('is kept with its contact, never refusing the rewind for what Undo couldn’t bring back: Salesforce deletes it only with its contact', async () => {
    const t = await afterTheRun(surveyed);
    const diff = await previewed(t);

    const plan = await planOf(t, diff.previewId, diff.readAt, undefined, false);
    expect(plan.undoCannot).toEqual([]);
    expect(plan.left).toEqual(
      expect.arrayContaining([
        { objectApiName: 'Contact', reason: 'outsideNotAccepted', count: 1 },
        { objectApiName: RELATION, reason: 'contactKept', count: 1 },
      ]),
    );
    expect(plan.acts.find((act) => act.objectApiName === RELATION)).toMatchObject({
      toDelete: 1,
      withParent: 1,
    });

    const outcome = await rewound(t, diff.previewId);
    const result = resultOf(outcome);

    // Never sent: the second contact goes, and its relation with it.
    expect(t.org.deletes.flatMap(({ ids }) => ids)).toEqual([contact(5)]);
    expect(liveIdsOf(t, RELATION)).toEqual([relation(1), relation(4)]);
    expect(liveIdsOf(t, 'Contact')).toEqual([contact(1), contact(4)]);
    expect(result.residual).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ objectApiName: RELATION, reason: 'kept', count: 1 }),
      ]),
    );
    const kept = result.residual.find((entry) => entry.objectApiName === RELATION);
    expect(kept?.message).toContain('only with the contact');
  });

  it('still refuses, unaccepted, to delete on its own a relation to another account whose contact and account both stay: Undo couldn’t bring it back', async () => {
    const t = await afterTheRun((org) => {
      surveyed(org);
      org.add(RELATION, {
        Id: relation(6),
        AccountId: account(1),
        ContactId: contact(4),
        LastModifiedById: COLLEAGUE,
      });
    });
    const diff = await previewed(t);

    const plan = await planOf(t, diff.previewId, diff.readAt, undefined, false);
    expect(plan.undoCannot).toEqual([{ objectApiName: RELATION, count: 1 }]);

    const outcome = await rewound(t, diff.previewId);
    expect(outcome.rewound).toBe(false);
    if (outcome.rewound) return;
    expect(outcome.refusal.code).toBe('NO_UNDO');
    expect(outcome.refusal.message).toContain(
      `Undo couldn't bring back 1 ${RELATION} record(s) this rewind deletes`,
    );
  });

  it('is kept, its contact not picked, in a rewind limited to the relations, naming Contact to add', async () => {
    const t = await afterTheRun();
    const diff = await previewed(t);

    const plan = await planOf(t, diff.previewId, diff.readAt, [RELATION], false);
    expect(plan.left).toEqual([{ objectApiName: RELATION, reason: 'contactKept', count: 2 }]);
    expect(plan.needs).toEqual([{ objectApiName: 'Contact', records: 2 }]);
    expect(plan.undoCannot).toEqual([]);

    const result = resultOf(await rewound(t, diff.previewId, { request: { objects: [RELATION] } }));
    expect(t.org.deletes).toEqual([]);
    expect(liveIdsOf(t, RELATION)).toEqual([relation(1), relation(4), relation(5)]);
    expect(result.residual[0]?.message).toContain('Rewind Contact with it');
  });
});
