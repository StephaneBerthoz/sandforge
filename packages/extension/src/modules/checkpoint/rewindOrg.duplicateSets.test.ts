import { afterEach, describe, expect, it, vi } from 'vitest';

import { previewCheckpoint } from './previewCheckpoint.js';
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
  undone,
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
 * What a run did since the checkpoint: two contacts under the first account,
 * which the rule found alike, a second on, and reported in a set of their
 * own, made by the org's Automated Process a second after; `alsoNamed`, the
 * records of the org the rule found them alike to, reported in the set too.
 */
function twinsSince(org: RewindTestOrg, alsoNamed: readonly string[] = [], reported = true): void {
  clock.now = SINCE;
  org.add('Contact', { Id: contact(5), LastName: 'Twin', AccountId: account(1) });
  org.add('Contact', { Id: contact(6), LastName: 'Twin', AccountId: account(1) });
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

    resultOf(await rewound(t, diff.previewId));

    expect(liveIds(t, 'Contact')).toEqual(expect.arrayContaining([contact(5), contact(6)]));
    expect(liveIds(t, SET)).toEqual([set(1)]);
    expect(liveIds(t, ITEM)).toHaveLength(2);
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

  it('leaves the set, said, when its user may not delete such records, and deletes the records all the same', async () => {
    const { t, diff } = await afterTheRun();
    const describe = t.org.describe.bind(t.org);
    t.org.describe = async (objectApiName: string) =>
      objectApiName === SET
        ? { ...((await describe(objectApiName)) as object), deletable: false }
        : describe(objectApiName);

    const outcome = await rewound(t, diff.previewId, { request: { acceptOutside: true } });

    expect(resultOf(outcome).status).toBe('success');
    expect(liveIds(t, 'Contact')).not.toContain(contact(5));
    expect(liveIds(t, SET)).toEqual([set(1)]);
    expect(outcome.rewound ? outcome.notes : []).toContain(
      '1 DuplicateRecordSet record(s) the duplicate rules of DEV-ED made since the checkpoint of ' +
        'records this rewind deletes stay: tester@example.com may not delete them.',
    );
  });

  it('brings the set back with its items once the rewind is undone', async () => {
    const { t, diff } = await afterTheRun();
    const result = resultOf(await rewound(t, diff.previewId, { request: { acceptOutside: true } }));

    const undo = await undone(t, result.rewindId);

    expect(undo.status).toBe('success');
    expect(liveIds(t, 'Contact')).toEqual(expect.arrayContaining([contact(5), contact(6)]));
    expect(liveIds(t, SET)).toEqual([set(1)]);
    expect(liveIds(t, ITEM)).toEqual([item(1), item(2)]);
  });
});
