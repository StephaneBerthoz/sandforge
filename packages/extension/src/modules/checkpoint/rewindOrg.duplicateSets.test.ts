import { afterEach, describe, expect, it, vi } from 'vitest';

import { previewCheckpoint } from './previewCheckpoint.js';
import { undoCheckpoint } from './undoCheckpoint.js';
import {
  account,
  AUTOMATED_PROCESS,
  baseRecords,
  CHILDREN,
  clock,
  contact,
  FIELDS,
  id,
  PREVIEWED,
  previewed,
  removeTaken,
  request,
  resultOf,
  rewound,
  RewindTestOrg,
  SINCE,
  STAMP_FIELDS,
  taken,
  writable,
  type Taken,
} from '../../test/rewindTestOrg.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

/*
 * The duplicate record sets the org's duplicate rules make as records go in
 * after a checkpoint: a set of the records a save found alike, an item a
 * record, which the org deletes with its record and with its set. A
 * checkpoint holds neither object. Run for real, the rewind of an Autopilot
 * run's checkpoint first deleted the run's contacts and their items, and the
 * set the standard Contact rule had made of two of them stayed, empty, named
 * nowhere.
 */

const SET = 'DuplicateRecordSet';
const ITEM = 'DuplicateRecordItem';
const set = (n: number): string => id('0GK', n);
const item = (n: number): string => id('0GL', n);

/** An org whose contacts a duplicate rule reports, its sets and items described as the org does. */
function duplicateRuleOrg(): RewindTestOrg {
  return new RewindTestOrg({
    fields: {
      ...FIELDS,
      [SET]: [...STAMP_FIELDS, writable('RecordCount', 'int')],
      [ITEM]: [
        ...STAMP_FIELDS,
        writable('RecordId', 'reference', { referenceTo: ['Contact'] }),
        writable('DuplicateRecordSetId', 'reference', { referenceTo: [SET] }),
      ],
    },
    children: {
      ...CHILDREN,
      Contact: [{ childSObject: ITEM, field: 'RecordId', cascadeDelete: true }],
      [SET]: [{ childSObject: ITEM, field: 'DuplicateRecordSetId', cascadeDelete: true }],
    },
  });
}

/**
 * What a run did since the checkpoint: two contacts under `under` — the
 * first account, which the org held, unless told —, which the rule found
 * alike, a second on, and reported in a set of their own, made by the org's
 * Automated Process a second after; `alsoNamed`, the records of the org the
 * rule found them alike to, reported in the set too.
 */
function twinsSince(
  org: RewindTestOrg,
  alsoNamed: readonly string[] = [],
  reported = true,
  under = account(1),
): void {
  clock.now = SINCE;
  org.add('Contact', { Id: contact(5), LastName: 'Twin', AccountId: under });
  org.add('Contact', { Id: contact(6), LastName: 'Twin', AccountId: under });
  if (!reported) return;
  clock.now = SINCE + 1_000;
  org.add(SET, {
    Id: set(1),
    RecordCount: 2 + alsoNamed.length,
    CreatedById: AUTOMATED_PROCESS,
    LastModifiedById: AUTOMATED_PROCESS,
  });
  [contact(5), contact(6), ...alsoNamed].forEach((named, at) => {
    org.add(ITEM, {
      Id: item(at + 1),
      RecordId: named,
      DuplicateRecordSetId: set(1),
      CreatedById: AUTOMATED_PROCESS,
      LastModifiedById: AUTOMATED_PROCESS,
    });
  });
}

/** A checkpoint of the picked objects, what the run did since, and the preview of its rewind. */
async function afterTheRun(alsoNamed: readonly string[] = []) {
  const t: Taken = await taken(baseRecords, duplicateRuleOrg());
  twinsSince(t.org, alsoNamed);
  const diff = await previewed(t);
  return { t, diff };
}

const liveIds = (t: Taken, objectApiName: string): string[] =>
  t.org
    .all(objectApiName)
    .map((row) => row.Id)
    .sort();

afterEach(() => {
  removeTaken();
});

describe('a rewind and the duplicate record sets made since its checkpoint', () => {
  it('names the set beside what its deletions take along outside the checkpoint', async () => {
    const { diff } = await afterTheRun();

    const contacts = diff.objects.find((object) => object.objectApiName === 'Contact');
    expect(contacts?.outside).toEqual([
      { objectApiName: ITEM, count: 2, parents: 2 },
      { objectApiName: SET, count: 1, parents: 2 },
    ]);
  });

  it('deletes the set with the records it reports, counted, and leaves none of its items', async () => {
    const { t, diff } = await afterTheRun();

    const result = resultOf(await rewound(t, diff.previewId, { request: { acceptOutside: true } }));

    expect(liveIds(t, 'Contact')).not.toContain(contact(5));
    expect(liveIds(t, SET)).toEqual([]);
    expect(liveIds(t, ITEM)).toEqual([]);
    expect(result.deleted.find((object) => object.objectApiName === SET)).toMatchObject({
      planned: 1,
      deleted: 1,
      refused: 0,
    });
  });

  it('takes the set of records that go with a parent created since as well, counted as its preview named it', async () => {
    // Run for real, an Autopilot run made 24 accounts and 1,000 contacts
    // under them: the rewind deleted the accounts, the contacts and their
    // items went with them, and the set its preview named stayed, empty,
    // which its end did not say.
    const t: Taken = await taken(baseRecords, duplicateRuleOrg());
    clock.now = SINCE - 1_000;
    t.org.add('Account', { Id: account(9), Name: 'Made by the run' });
    twinsSince(t.org, [], true, account(9));
    const diff = await previewed(t);
    const named = diff.objects
      .find((object) => object.objectApiName === 'Contact')
      ?.outside.find((outside) => outside.objectApiName === SET);
    expect(named).toEqual({ objectApiName: SET, count: 1, parents: 2 });

    const result = resultOf(await rewound(t, diff.previewId, { request: { acceptOutside: true } }));

    expect(liveIds(t, 'Account')).not.toContain(account(9));
    expect(liveIds(t, 'Contact')).not.toContain(contact(5));
    expect(liveIds(t, SET)).toEqual([]);
    expect(result.deleted.find((object) => object.objectApiName === SET)).toMatchObject({
      planned: named?.count,
      deleted: named?.count,
    });
  });

  it('takes a set that reports a record of the org beside them, which then reports it alone', async () => {
    // A contact of the run found alike to one the org held: once the run's
    // goes, the set names the held contact alone, beside nothing.
    const { t, diff } = await afterTheRun([contact(3)]);

    resultOf(await rewound(t, diff.previewId, { request: { acceptOutside: true } }));

    expect(liveIds(t, SET)).toEqual([]);
    expect(liveIds(t, 'Contact')).toContain(contact(3));
  });

  it('leaves a set that still reports two records of the org alike, and names it nowhere', async () => {
    const { t, diff } = await afterTheRun([contact(1), contact(3)]);

    const contacts = diff.objects.find((object) => object.objectApiName === 'Contact');
    expect(contacts?.outside.map((outside) => outside.objectApiName)).toEqual([ITEM]);
    resultOf(await rewound(t, diff.previewId, { request: { acceptOutside: true } }));

    expect(liveIds(t, SET)).toEqual([set(1)]);
  });

  it('keeps the set with its records when what hangs from them outside the checkpoint was not accepted', async () => {
    const { t, diff } = await afterTheRun();

    const result = resultOf(await rewound(t, diff.previewId));

    expect(liveIds(t, 'Contact')).toEqual(expect.arrayContaining([contact(5), contact(6)]));
    expect(liveIds(t, SET)).toEqual([set(1)]);
    expect(liveIds(t, ITEM)).toHaveLength(2);
    // Named among what goes along, it is said left, with why.
    expect(result.deleted.find((object) => object.objectApiName === SET)).toMatchObject({
      planned: 1,
      deleted: 0,
      keptDependents: 1,
      reasons: ['they still report records alike that this rewind keeps'],
    });
  });

  it('takes no set its preview did not name', async () => {
    // Made after the preview, of a record the rewind deletes and one the
    // org held: its user confirmed nothing of it.
    const { t, diff } = await afterTheRun();
    clock.now = SINCE + 90_000;
    t.org.add(SET, { Id: set(2), CreatedById: AUTOMATED_PROCESS });
    t.org.add(ITEM, { Id: item(7), RecordId: contact(5), DuplicateRecordSetId: set(2) });
    t.org.add(ITEM, { Id: item(8), RecordId: contact(3), DuplicateRecordSetId: set(2) });

    resultOf(await rewound(t, diff.previewId, { request: { acceptOutside: true } }));

    expect(liveIds(t, SET)).toEqual([set(2)]);
  });

  it('sends what its preview estimated for the set beside what it estimated for the records', async () => {
    /** What a rewind of the twins sent, against what its preview estimated. */
    const sentAndEstimated = async (reported: boolean) => {
      const t: Taken = await taken(baseRecords, duplicateRuleOrg());
      twinsSince(t.org, [], reported);
      clock.now = PREVIEWED;
      const preview = await previewCheckpoint(
        { org: t.org, store: t.store },
        { ...request(t), acceptOutside: true },
      );
      if (!preview.previewed) throw new Error(preview.refusal.message);
      const result = resultOf(
        await rewound(t, preview.diff.previewId, { request: { acceptOutside: true } }),
      );
      return { sent: result.apiRequests.used, estimated: preview.estimate.apiRequests };
    };
    const without = await sentAndEstimated(false);
    removeTaken();
    const withSet = await sentAndEstimated(true);

    expect(withSet.sent - without.sent).toBeGreaterThan(0);
    expect(withSet.estimated - without.estimated).toBe(withSet.sent - without.sent);
  });

  it('estimates a rewind of contacts alone what it sends, the contacts of an account it leaves sent on their own', async () => {
    // Run for real, a rewind limited to Contact of 1,000 contacts made under
    // accounts made since was estimated 25 requests and sent 89: its estimate
    // counted the contacts gone with their accounts, which it does not delete.
    const t: Taken = await taken(baseRecords, duplicateRuleOrg());
    clock.now = SINCE - 1_000;
    t.org.add('Account', { Id: account(9), Name: 'Made by the run' });
    clock.now = SINCE;
    for (let n = 0; n < 450; n++) {
      t.org.add('Contact', { Id: id('003', 100 + n), LastName: 'Made', AccountId: account(9) });
    }
    clock.now = PREVIEWED;
    const asked = { objects: ['Contact'], acceptOutside: true };
    const preview = await previewCheckpoint(
      { org: t.org, store: t.store },
      { ...request(t), ...asked },
    );
    if (!preview.previewed) throw new Error(preview.refusal.message);

    const result = resultOf(await rewound(t, preview.diff.previewId, { request: asked }));

    expect(result.deleted.find((object) => object.objectApiName === 'Contact')?.deleted).toBe(450);
    expect(Math.abs(preview.estimate.apiRequests - result.apiRequests.used)).toBeLessThanOrEqual(2);
  });

  it('leaves the set, said, when its user may not delete such records, and deletes the records all the same', async () => {
    const { t, diff } = await afterTheRun();
    const describe = t.org.describe.bind(t.org);
    t.org.describe = async (objectApiName: string) =>
      objectApiName === SET
        ? { ...((await describe(objectApiName)) as object), deletable: false }
        : describe(objectApiName);

    const outcome = await rewound(t, diff.previewId, { request: { acceptOutside: true } });

    const result = resultOf(outcome);
    expect(result.status).toBe('success');
    expect(liveIds(t, 'Contact')).not.toContain(contact(5));
    expect(liveIds(t, SET)).toEqual([set(1)]);
    expect(result.deleted.find((object) => object.objectApiName === SET)).toMatchObject({
      planned: 1,
      deleted: 0,
      refused: 1,
      reasons: ['tester@example.com may not delete DuplicateRecordSet records'],
    });
  });

  it('says, once through, a set its preview named that no pass found to take and that reports nothing any more', async () => {
    // Its items gone since the preview, the set names no record the rewind
    // deletes: the rewind does not take it, and says it is left.
    const { t, diff } = await afterTheRun();
    clock.now = SINCE + 90_000;
    t.org.trash(ITEM, item(1));
    t.org.trash(ITEM, item(2));

    const result = resultOf(await rewound(t, diff.previewId, { request: { acceptOutside: true } }));

    expect(liveIds(t, SET)).toEqual([set(1)]);
    expect(result.deleted.find((object) => object.objectApiName === SET)).toMatchObject({
      planned: 1,
      deleted: 0,
      keptDependents: 1,
      reasons: [
        'they report nothing any more, and no rewind takes an empty set: delete them in DEV-ED, ' +
          'from the Duplicate Record Sets tab',
      ],
    });
  });

  it('says the items an undo did not bring back with their set, and never that the org is back as it was', async () => {
    // Run for real: the undo brought the contacts back, then the set, empty,
    // its two items still deleted, and said the org was back as it was.
    const { t, diff } = await afterTheRun();
    const rewind = resultOf(await rewound(t, diff.previewId, { request: { acceptOutside: true } }));
    const read = await t.store.read(t.checkpoint.checkpointId);
    if (!read?.checkpoint) throw new Error('the checkpoint is gone');
    clock.now += 60_000;

    const undo = await undoCheckpoint(
      { org: t.org, undelete: (ids) => t.org.undelete(ids), store: t.store },
      {
        ...request(t),
        checkpoint: read.checkpoint,
        rewindId: rewind.rewindId,
        acceptAutomation: false,
      },
    );

    if (!undo.undone) throw new Error(undo.refusal.message);
    expect(liveIds(t, 'Contact')).toEqual(expect.arrayContaining([contact(5), contact(6)]));
    expect(liveIds(t, SET)).toEqual([set(1)]);
    expect(liveIds(t, ITEM)).toEqual([]);
    expect(undo.result.status).toBe('partial');
    expect(undo.result.residual).toEqual([
      {
        objectApiName: SET,
        reason: 'notBack',
        count: 1,
        ids: [set(1)],
        message: '2 of their items',
      },
    ]);
  });
});
