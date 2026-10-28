import { existsSync, readdirSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgeTargetObjectAutomation, RewindResult } from '@sandforge/shared';

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { MEMORY_ORG_USER, factCombinations, type MemoryRow } from '../../test/memoryRemovalOrg.js';
import { paced } from '../../test/runnerPace.js';
import {
  AUTOMATED_PROCESS,
  CHILDREN,
  COLLEAGUE,
  COMPARED,
  FIELDS,
  ORG_ID,
  PERSON_FLAG,
  PICKED,
  PREVIEWED,
  PRICE_BOOK_HELD,
  RewindTestOrg,
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
  journalKinds,
  line,
  liveAsHeld,
  liveIds,
  opportunity,
  order,
  previewed,
  removeTaken,
  request,
  resultOf,
  rewound,
  spent,
  stateOf,
  stoppedAfter,
  taken,
  undone,
  writable,
  type OrgState,
  type Taken,
} from '../../test/rewindTestOrg.js';
import { rewindDirOf } from './OrgCheckpointStore.js';
import { previewCheckpoint } from './previewCheckpoint.js';
import { readRewindJournal } from './rewindJournal.js';
import {
  NOT_REMADE_WORDS,
  REWIND_RESIDUAL_IDS,
  RewindStopped,
  counted,
  inRewindWords,
  rewindOrgOf,
  type RewindOutcome,
} from './rewindOrg.js';
import { KEPT_IN_BIN_WORDS } from './undoRewind.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * The rewind, on the memory org the bricks run on: a checkpoint taken of it
 * as a take takes one, changes made since, the preview a user confirms, then
 * the rewind — its guard and gates, its fresh read, its journal, its passes
 * and its verify. The org counts a composite as one request and every SOAP
 * call apart, as the orgs were seen to; its clock moves a second each time
 * it is read once the checkpoint is taken, so what the rewind writes is
 * dated after Tr, as on a real org (`src/test/rewindTestOrg.ts`).
 */

beforeEach(() => {
  clock.now = T0;
});

afterEach(() => {
  removeTaken();
  vi.mocked(getJsforceConnection).mockReset();
});

describe('rewindOrg, on the memory org', () => {
  it('puts the org back as the checkpoint holds it: brings back what was deleted since with what went with it, gives back what changed, deletes what was created, then reads the org again and finds nothing that differs', async () => {
    const t = await taken();
    changedSince(t.org);
    const diff = await previewed(t);

    const result = resultOf(await rewound(t, diff.previewId));

    expect(stateOf(t.org).live).toEqual(t.atCheckpoint.live);
    expect(result.status).toBe('success');
    expect(result.residual).toEqual([]);
    // The second read found nothing to do: it is the verify, and no second pass is made.
    expect(result.passes).toBe(1);
    // The contact created since under an account created since goes with it,
    // never on its own: deleted alone first, it would stay in the bin for good.
    expect(result.deleted.map(({ objectApiName, deleted }) => [objectApiName, deleted])).toEqual([
      ['Account', 2],
    ]);
    expect(t.org.inBin('Contact').map((row) => row.Id)).toEqual([contact(4)]);
    expect(
      result.undeleted.map(({ objectApiName, undeleted }) => [objectApiName, undeleted]),
    ).toEqual([['Account', 1]]);
    // What it gave back is what the preview counted to give back: the account
    // renamed since. The account it brought back, edited before it was
    // deleted, and the contacts that came back with it were given their
    // checkpoint values too — the org reads as the checkpoint holds it — as
    // part of bringing them back.
    const toGiveBack = diff.objects
      .filter((object) => object.toGiveBack.records > 0)
      .map((object) => [object.objectApiName, object.toGiveBack.records]);
    expect(toGiveBack).toEqual([['Account', 1]]);
    expect(
      result.restored.map(({ objectApiName, planned, restored }) => [
        objectApiName,
        planned,
        restored,
      ]),
    ).toEqual([['Account', 1, 1]]);
    // Its own deletes in the bin, the account it brought back out of it.
    expect(
      t.org
        .inBin('Account')
        .map((row) => row.Id)
        .sort(),
    ).toEqual([account(4), account(5)]);

    // The journal went through, and the checkpoint says when, and until when Undo reaches.
    const journal = await readRewindJournal(t.folder, result.rewindId);
    expect(journal.endedAt).toBeDefined();
    const read = await t.store.read(t.checkpoint.checkpointId);
    const last = read?.checkpoint?.lastRewind;
    expect(last?.rewindId).toBe(result.rewindId);
    expect(last?.endedAt).toBeDefined();
    expect(Date.parse(last?.undoUntil ?? '') - Date.parse(journal.head.startedAt)).toBe(
      15 * 24 * 60 * 60_000,
    );
    expect(result.undo).toEqual({ until: last?.undoUntil, cannot: [] });
    // Its reads and the preview it acted on are deleted; the journal stays, for Undo.
    expect(readdirSync(t.folder.previewsDir)).toEqual([]);
    expect(existsSync(rewindDirOf(t.folder, result.rewindId))).toBe(true);
  });
});

describe('rewindOrg: what a pass writes, in its order', () => {
  /** An opportunity whose price book changed since, as a product was added under it. */
  function heldInPlace(org: RewindTestOrg): void {
    clock.now = SINCE;
    org.edit('Opportunity', opportunity(1), { Pricebook2Id: book(2) }, COLLEAGUE);
    org.add('OpportunityLineItem', {
      Id: line(1),
      Quantity: 1,
      OpportunityId: opportunity(1),
      LastModifiedById: COLLEAGUE,
    });
  }

  it('gives back once its deletes are through a value a record it deletes held in place (gate G1)', async () => {
    const t = await taken();
    t.org.heldByChildren.push(PRICE_BOOK_HELD);
    heldInPlace(t.org);
    const diff = await previewed(t);

    const result = resultOf(await rewound(t, diff.previewId, { request: { acceptNoUndo: true } }));

    expect(result.status).toBe('success');
    expect(stateOf(t.org).live).toEqual(t.atCheckpoint.live);
    // In the pass that deleted the product: no second pass was needed for it.
    expect(result.passes).toBe(1);
    expect(result.restored).toEqual([
      expect.objectContaining({
        objectApiName: 'Opportunity',
        planned: 1,
        restored: 1,
        refused: 0,
      }),
    ]);
    expect(result.undo?.cannot).toEqual([{ objectApiName: 'OpportunityLineItem', count: 1 }]);
    // The product went first, then the price book was given back, once.
    expect(t.org.deletes.map(({ ids }) => ids)).toEqual([[line(1)]]);
    expect(t.org.updates).toEqual([
      { objectApiName: 'Opportunity', records: [{ Id: opportunity(1), Pricebook2Id: book(1) }] },
    ]);
  });

  it('says what a record given back after the deletes waited for when the org still refuses it', async () => {
    const t = await taken();
    t.org.heldByChildren.push(PRICE_BOOK_HELD);
    heldInPlace(t.org);
    const diff = await previewed(t);
    t.org.beforeDelete = () =>
      t.org.refuseUpdate.set(opportunity(1), {
        statusCode: 'UNABLE_TO_LOCK_ROW',
        message: 'locked',
      });

    const result = resultOf(await rewound(t, diff.previewId, { request: { acceptNoUndo: true } }));

    const waited =
      'Opportunity: given back once the OpportunityLineItem records hanging from it that the ' +
      'rewind deletes were gone, as those records held some of its values in place';
    expect(result.status).toBe('partial');
    expect(result.residual).toEqual([
      {
        objectApiName: 'Opportunity',
        reason: 'refused',
        count: 1,
        ids: [opportunity(1)],
        message: `UNABLE_TO_LOCK_ROW: locked — ${waited}`,
      },
    ]);
    expect(result.restored[0].reasons).toEqual(['UNABLE_TO_LOCK_ROW: locked', waited]);
  });

  it('keeps, of a record given back after the deletes, the values it held before the rewind wrote anything: Undo gives those back', async () => {
    const t = await taken();
    t.org.heldByChildren.push(PRICE_BOOK_HELD);
    heldInPlace(t.org);
    t.org.edit('Opportunity', opportunity(1), { Name: 'Deal, changed' }, COLLEAGUE);
    const before = stateOf(t.org);
    const diff = await previewed(t);
    // The org's automation renames the opportunity as its product goes.
    t.org.beforeDelete = () => {
      t.org.beforeDelete = undefined;
      t.org.edit('Opportunity', opportunity(1), { Name: 'Recalculated' }, AUTOMATED_PROCESS);
    };

    const result = resultOf(await rewound(t, diff.previewId, { request: { acceptNoUndo: true } }));
    expect(result.status).toBe('success');
    await undone(t, result.rewindId);

    // The product the rewind deleted stays in the bin, as the preview said
    // Undo couldn't bring it back; the opportunity holds what it held before.
    expect(stateOf(t.org).live.Opportunity).toEqual(before.live.Opportunity);
  });

  it('names the children the bin holds of a record before it brings the record back, and holds what it brought back as its own whoever the org names their last modifier', async () => {
    for (const facts of factCombinations(['undeleterIsLastModifier'])) {
      const t = await taken(baseRecords, new RewindTestOrg({ facts }));
      changedSince(t.org);
      const diff = await previewed(t);
      const said = JSON.stringify(facts);

      const result = resultOf(await rewound(t, diff.previewId));

      expect(result.status, said).toBe('success');
      expect(result.residual, said).toEqual([]);
      expect(
        t.org.all('Account').find((row) => row.Id === account(2)),
        said,
      ).toMatchObject({ Industry: 'Energy' });
      const kinds = journalKinds(t.folder, result.rewindId);
      expect(kinds.indexOf('withParent'), said).toBeGreaterThan(0);
      expect(kinds.indexOf('withParent'), said).toBeLessThan(kinds.indexOf('bringingBack'));
      const journal = await readRewindJournal(t.folder, result.rewindId);
      expect(journal.did.broughtBack, said).toEqual([
        { objectApiName: 'Contact', ids: [contact(1), contact(2)] },
        { objectApiName: 'Account', ids: [account(2)] },
      ]);
    }
  });

  it('gives an order activated since that was Draft at the checkpoint its status back first, alone', async () => {
    const t = await taken(
      (org) => {
        baseRecords(org);
        org.add('Order', { Id: order(1), Status: 'Draft', Description: 'As agreed' });
      },
      new RewindTestOrg(),
      [...PICKED, 'Order'],
    );
    clock.now = SINCE;
    t.org.edit('Order', order(1), { Status: 'Activated', Description: 'Changed' }, COLLEAGUE);
    const diff = await previewed(t);

    const result = resultOf(await rewound(t, diff.previewId));

    expect(result.status).toBe('success');
    expect(t.org.updates).toEqual([
      { objectApiName: 'Order', records: [{ Id: order(1), Status: 'Draft' }] },
      { objectApiName: 'Order', records: [{ Id: order(1), Description: 'As agreed' }] },
    ]);
  });

  it('never sends a person account’s name, which the org computes from its person’s', async () => {
    const fields = {
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
    const t = await taken((org) => {
      baseRecords(org);
      org.addPersonAccount(
        { Id: account(9), Name: 'Ada Lovelace', FirstName: 'Ada', LastName: 'Lovelace' },
        contact(9),
      );
    }, new RewindTestOrg({ fields }));
    clock.now = SINCE;
    t.org.edit('Account', account(9), { Name: 'Ada Byron', LastName: 'Byron' }, COLLEAGUE);
    const diff = await previewed(t);

    const result = resultOf(await rewound(t, diff.previewId));

    expect(t.org.updates).toEqual([
      { objectApiName: 'Account', records: [{ Id: account(9), LastName: 'Lovelace' }] },
    ]);
    expect(result.restored).toEqual([
      expect.objectContaining({ objectApiName: 'Account', restored: 1, refused: 0 }),
    ]);
    expect(result.restored[0].restoredWithout).toBeUndefined();
  });

  it(
    'hands the give-back 2,000 records at most a call, and brings back 2,001 records deleted since',
    async () => {
      const count = 2_001;
      const t = await taken((org) => {
        baseRecords(org);
        for (let n = 0; n < count; n++) {
          org.add('Account', { Id: account(100 + n), Name: `Many ${n}`, Industry: 'Energy' });
          org.add('Contact', { Id: contact(100 + n), LastName: `Alone ${n}` });
        }
      });
      clock.now = SINCE;
      for (let n = 0; n < count; n++) {
        t.org.edit('Account', account(100 + n), { Industry: 'Retail' }, COLLEAGUE);
        t.org.trash('Contact', contact(100 + n), COLLEAGUE);
      }
      const diff = await previewed(t);

      const result = resultOf(await rewound(t, diff.previewId));

      expect(result.status).toBe('success');
      // The contacts it brought back, given their values too, are counted
      // brought back, as the preview counts them.
      expect(result.restored).toEqual([
        expect.objectContaining({ objectApiName: 'Account', planned: count, restored: count }),
      ]);
      expect(result.undeleted).toEqual([
        expect.objectContaining({ objectApiName: 'Contact', planned: count, undeleted: count }),
      ]);
      expect(stateOf(t.org).live).toEqual(t.atCheckpoint.live);
    },
    paced(60_000),
  );
});

describe('rewindOrg: the second pass and the verify', () => {
  it('deletes in a second pass what came back with a parent it brought back and what its own automation made in answer to the first', async () => {
    const t = await taken();
    clock.now = SINCE;
    t.org.add('Contact', {
      Id: contact(5),
      LastName: 'Made since',
      AccountId: account(2),
      LastModifiedById: COLLEAGUE,
    });
    t.org.trash('Account', account(2), COLLEAGUE);
    const diff = await previewed(t);
    let answered = false;
    const undelete = async (ids: string[]): Promise<unknown> => {
      const answer = await t.org.undelete(ids);
      if (!answered) {
        answered = true;
        t.org.add('Account', {
          Id: account(6),
          Name: 'Made by a flow',
          LastModifiedById: AUTOMATED_PROCESS,
        });
      }
      return answer;
    };

    const result = resultOf(await rewound(t, diff.previewId, { deps: { undelete } }));

    expect(result.status).toBe('success');
    expect(result.passes).toBe(2);
    expect(stateOf(t.org).live).toEqual(t.atCheckpoint.live);
    expect(
      result.deleted.map(({ objectApiName, planned, deleted }) => [
        objectApiName,
        planned,
        deleted,
      ]),
    ).toEqual([
      ['Contact', 1, 1],
      ['Account', 1, 1],
    ]);
  });

  it('counts a record the second pass gave back once, by its last outcome, when the first was refused', async () => {
    const t = await taken();
    changedSince(t.org);
    const diff = await previewed(t);
    t.org.refuseUpdate.set(account(1), { statusCode: 'UNABLE_TO_LOCK_ROW', message: 'locked' });

    const result = resultOf(
      await rewound(t, diff.previewId, {
        deps: {
          onProgress: ({ pass }) => {
            if (pass === 2) t.org.refuseUpdate.clear();
          },
        },
      }),
    );

    expect(result.status).toBe('success');
    expect(result.passes).toBe(2);
    // The account renamed since, refused, then given back; the one it
    // brought back is counted brought back.
    expect(result.restored.find((object) => object.objectApiName === 'Account')).toMatchObject({
      planned: 1,
      restored: 1,
      refused: 0,
    });
  });

  it('counts a record the second pass deleted or brought back once, by its last outcome, when the first was refused', async () => {
    const t = await taken();
    changedSince(t.org);
    const diff = await previewed(t);
    const before = stateOf(t.org);
    t.org.refuse.set(account(4), 'locked by a colleague');
    let refusing = true;
    const undelete = (ids: string[]): Promise<unknown> =>
      refusing
        ? Promise.resolve(
            ids.map((id) => ({
              id,
              success: false,
              errors: [{ statusCode: 'UNDELETE_FAILED', message: 'locked' }],
            })),
          )
        : t.org.undelete(ids);

    const result = resultOf(
      await rewound(t, diff.previewId, {
        deps: {
          undelete,
          onProgress: ({ pass }) => {
            if (pass !== 2) return;
            refusing = false;
            t.org.refuse.clear();
          },
        },
      }),
    );

    expect(result.status).toBe('success');
    expect(result.passes).toBe(2);
    expect(stateOf(t.org).live).toEqual(t.atCheckpoint.live);
    expect(
      result.deleted.map(({ objectApiName, planned, deleted, refused }) => [
        objectApiName,
        planned,
        deleted,
        refused,
      ]),
    ).toEqual([['Account', 2, 2, 0]]);
    expect(result.undeleted).toEqual([
      expect.objectContaining({ objectApiName: 'Account', planned: 1, undeleted: 1, refused: 0 }),
    ]);
    // What the first pass could not bring back, nor give its values, and the
    // second brought back and gave them, is counted brought back: the give-back
    // says the account renamed since alone, as the preview does.
    expect(
      result.restored.map(({ objectApiName, planned, restored, alreadyGone }) => [
        objectApiName,
        planned,
        restored,
        alreadyGone,
      ]),
    ).toEqual([['Account', 1, 1, 0]]);

    // The first pass named what the org refused to bring back, the second
    // named it again as it brought it back: its undo sends it back to the
    // bin, with the contacts that came back with it.
    expect(journalKinds(t.folder, result.rewindId)).toContain('bringBackLeft');
    const undo = await undone(t, result.rewindId);
    expect(undo.status).toBe('success');
    expect(undo.planned.remove).toBe(3);
    expect(stateOf(t.org)).toEqual(before);
  });

  it('leaves as they made them the records another user changed during the rewind, names who, and ends unstable', async () => {
    const t = await taken();
    changedSince(t.org);
    t.org.edit('Account', account(3), { Industry: 'Retail' }, COLLEAGUE);
    const diff = await previewed(t);
    let changed = false;
    const undelete = async (ids: string[]): Promise<unknown> => {
      if (!changed) {
        changed = true;
        t.org.edit('Account', account(3), { Industry: 'Mining' }, COLLEAGUE);
      }
      return t.org.undelete(ids);
    };

    const result = resultOf(await rewound(t, diff.previewId, { deps: { undelete } }));

    expect(result.status).toBe('unstable');
    expect(result.residual).toEqual([
      {
        objectApiName: 'Account',
        reason: 'changedDuringRewind',
        by: COLLEAGUE,
        count: 1,
        ids: [account(3)],
      },
    ]);
    expect(t.org.all('Account').find((row) => row.Id === account(3))).toMatchObject({
      Industry: 'Mining',
    });
    expect(t.org.all('Account').find((row) => row.Id === account(1))).toMatchObject({
      Name: 'Account one',
    });
  });

  it('acts on what the user confirmed and names what changed since the preview, without going on for it', async () => {
    const t = await taken();
    changedSince(t.org);
    const diff = await previewed(t);
    clock.now = PREVIEWED + 10_000;
    t.org.add('Account', {
      Id: account(7),
      Name: 'Since the preview',
      LastModifiedById: COLLEAGUE,
    });

    const result = resultOf(await rewound(t, diff.previewId));

    expect(result.status).toBe('partial');
    expect(result.residual).toEqual([
      { objectApiName: 'Account', reason: 'changedSincePreview', count: 1, ids: [account(7)] },
    ]);
    expect(liveIds(t.org, 'Account')).toContain(account(7));
    expect(result.passes).toBe(1);
  });

  it('brings back a record deleted while the checkpoint was taken, and never names it once it is back', async () => {
    const org = new RewindTestOrg();
    org.onSnapshotRead = (soql) => {
      if (/ FROM Account\b/.test(soql) && org.all('Account').some((row) => row.Id === account(3))) {
        org.trash('Account', account(3), COLLEAGUE);
      }
    };
    const t = await taken(baseRecords, org);
    const diff = await previewed(t);
    expect(diff.objects).toEqual([
      expect.objectContaining({
        objectApiName: 'Account',
        toBringBack: { inBin: 0, withParent: 0, deletedWhileTaken: 1 },
      }),
    ]);

    const result = resultOf(await rewound(t, diff.previewId));

    expect(result.status).toBe('success');
    expect(result.residual).toEqual([]);
    expect(liveIds(t.org, 'Account')).toContain(account(3));
    expect(result.undeleted).toEqual([
      expect.objectContaining({ objectApiName: 'Account', undeleted: 1 }),
    ]);
  });

  it(
    'converges, or names every record that still differs, under every hypothesis the probes left about stamps, cascades and cleared lookups',
    async () => {
      const combinations = factCombinations([
        'deleteStamps',
        'childDeletedAloneStays',
        'undeleterIsLastModifier',
        'clearedLookupRestamps',
        'undeleteRestoresLookups',
      ]);
      for (const facts of combinations) {
        const t = await taken(baseRecords, new RewindTestOrg({ facts }));
        changedSince(t.org);
        const diff = await previewed(t);
        const said = JSON.stringify(facts);

        // Where a delete left its stamps, refuted live, what it deleted reads
        // as gone from the bin: made again, with new Ids, as accepted.
        const result = resultOf(
          await rewound(t, diff.previewId, { request: { acceptRecreate: true } }),
        );

        expect(result.status, said).not.toBe('unstable');
        const named = new Set(result.residual.flatMap(({ ids }) => ids));
        const now = liveAsHeld(stateOf(t.org), t.folder);
        for (const [objectApiName, rows] of Object.entries(t.atCheckpoint.live)) {
          const held = new Map(
            (rows as Array<{ Id: string }>).map((row) => [row.Id, JSON.stringify(row)]),
          );
          const live = new Map(
            (now[objectApiName] as Array<{ Id: string }>).map((row) => [
              row.Id,
              JSON.stringify(row),
            ]),
          );
          for (const record of new Set([...held.keys(), ...live.keys()])) {
            if (held.get(record) === live.get(record)) continue;
            expect({ said, record, named: named.has(record) }).toEqual({
              said,
              record,
              named: true,
            });
          }
        }
      }
    },
    paced(60_000),
  );
});

describe('rewindOrg: what it refuses before it writes', () => {
  /** Nothing was written to the org: no update, no delete, no undelete, no journal. */
  function untouched(t: Taken, before: OrgState): void {
    expect(t.org.updates).toEqual([]);
    expect(t.org.deletes).toEqual([]);
    expect(stateOf(t.org)).toEqual(before);
    expect(existsSync(t.folder.rewindsDir) ? readdirSync(t.folder.rewindsDir) : []).toEqual([]);
  }

  it('refuses a production org with the guard’s words, having read nothing but what the guard asked', async () => {
    const t = await taken();
    changedSince(t.org);
    const diff = await previewed(t);
    t.org.edit('Organization', ORG_ID, { OrganizationType: 'Enterprise Edition' });
    const before = stateOf(t.org);
    const asked = spent(t.org);

    const outcome = await rewound(t, diff.previewId);

    expect(outcome).toMatchObject({ rewound: false, refusal: { code: 'PRODUCTION' } });
    expect(spent(t.org) - asked).toBe(2);
    untouched(t, before);
  });

  it('refuses while a take, a rewind or an undo of the org holds its lock, or a run writes to it', async () => {
    const t = await taken();
    changedSince(t.org);
    const diff = await previewed(t);
    const before = stateOf(t.org);
    const held = t.store.lock(ORG_ID, 'take');
    if (!('lock' in held)) throw new Error('the org’s lock is held');
    try {
      expect(await rewound(t, diff.previewId)).toMatchObject({
        rewound: false,
        refusal: {
          code: 'RUN_WRITING',
          message: expect.stringMatching(/^A checkpoint of DEV-ED is being taken/) as unknown,
        },
      });
    } finally {
      held.lock.release();
    }
    expect(
      await rewound(t, diff.previewId, {
        deps: { runWriting: () => 'A Sync run is writing to DEV-ED.' },
      }),
    ).toEqual({
      rewound: false,
      refusal: { code: 'RUN_WRITING', message: 'A Sync run is writing to DEV-ED.' },
    });
    untouched(t, before);
  });

  it('refuses to delete records Undo couldn’t bring back unless that was accepted', async () => {
    const t = await taken();
    clock.now = SINCE;
    t.org.add('OpportunityLineItem', {
      Id: line(1),
      Quantity: 1,
      OpportunityId: opportunity(1),
      LastModifiedById: COLLEAGUE,
    });
    const diff = await previewed(t);
    const before = stateOf(t.org);

    const outcome = await rewound(t, diff.previewId);

    expect(outcome).toEqual({
      rewound: false,
      refusal: {
        code: 'NO_UNDO',
        message:
          "Undo couldn't bring back 1 OpportunityLineItem record(s) this rewind deletes: " +
          'Salesforce undeletes them only with their parent, which stays. Rewind refused; ' +
          "accept that Undo couldn't bring them back to rewind all the same. No record was " +
          'written.',
      },
    });
    untouched(t, before);
    const accepted = resultOf(
      await rewound(t, diff.previewId, { request: { acceptNoUndo: true } }),
    );
    expect(accepted.status).toBe('success');
    expect(liveIds(t.org, 'OpportunityLineItem')).toEqual([]);
  });

  it('refuses to delete a case before the account it points at, which it deletes next, unless that Undo couldn’t bring the case back was accepted; accepted, its result says so from its journal, and its undo names the case with words that say it stays in the bin (F41, a case under its account, live)', async () => {
    // On the scratch org the live proof ran on, a case's account lookup
    // restricts the account's delete: the case goes first, alone, and the
    // account's delete then keeps it in the recycle bin for good.
    const objects = [...PICKED, 'Case'];
    const compared = [...COMPARED, 'Subject'];
    const kase = id('500', 7);
    const t = await taken(
      baseRecords,
      new RewindTestOrg({
        fields: {
          ...FIELDS,
          Case: [
            ...STAMP_FIELDS,
            writable('Subject'),
            writable('AccountId', 'reference', { referenceTo: ['Account'] }),
          ],
        },
        children: {
          ...CHILDREN,
          Account: [
            ...(CHILDREN.Account ?? []),
            { childSObject: 'Case', field: 'AccountId', restrictedDelete: true },
          ],
        },
      }),
      objects,
      { objects, fields: compared },
    );
    expect(t.checkpoint.objects.find((object) => object.objectApiName === 'Case')).toMatchObject({
      cascadeParents: [],
      restrictParents: ['AccountId'],
    });
    clock.now = SINCE;
    t.org.add('Account', { Id: account(7), Name: 'Made since', LastModifiedById: COLLEAGUE });
    t.org.add('Case', {
      Id: kase,
      Subject: 'Made since',
      AccountId: account(7),
      LastModifiedById: COLLEAGUE,
    });
    const diff = await previewed(t);
    expect(diff.undoCannot).toEqual([
      { objectApiName: 'Case', count: 1, reason: 'deletedBeforeParent' },
    ]);
    const before = stateOf(t.org);

    const outcome = await rewound(t, diff.previewId);

    expect(outcome).toEqual({
      rewound: false,
      refusal: {
        code: 'NO_UNDO',
        message:
          "Undo couldn't bring back 1 Case record(s) this rewind deletes: deleted before a " +
          'record they point at, which the rewind deletes next, Salesforce cannot bring them ' +
          "back after that. Rewind refused; accept that Undo couldn't bring them back to " +
          'rewind all the same. No record was written.',
      },
    });
    untouched(t, before);
    expect(liveIds(t.org, 'Case')).toEqual([kase]);

    const accepted = resultOf(
      await rewound(t, diff.previewId, { request: { acceptNoUndo: true } }),
    );

    expect(accepted.status).toBe('success');
    expect(t.org.deletes.map(({ ids }) => ids)).toEqual([[kase], [account(7)]]);
    expect(accepted.undo?.cannot).toEqual([
      { objectApiName: 'Case', count: 1, reason: 'deletedBeforeParent' },
    ]);
    expect(journalKinds(t.folder, accepted.rewindId)).toContain('beforeParent');
    const undo = await undone(t, accepted.rewindId);
    expect(liveIds(t.org, 'Account')).toContain(account(7));
    expect(liveIds(t.org, 'Case')).toEqual([]);
    expect(undo.undeleted).toContainEqual(
      expect.objectContaining({ objectApiName: 'Case', refused: 1, reasons: [KEPT_IN_BIN_WORDS] }),
    );
  });

  it('refuses when the org runs automation as it writes, or cannot say what it runs, unless accepted', async () => {
    const t = await taken();
    changedSince(t.org);
    const diff = await previewed(t);
    const before = stateOf(t.org);
    const blind = automationOf({ unread: [{ part: 'flows', reason: 'Tooling API timed out' }] });

    const outcome = await rewound(t, diff.previewId, { deps: { readAutomation: blind } });

    expect(outcome).toMatchObject({ rewound: false, refusal: { code: 'AUTOMATION' } });
    untouched(t, before);
    const accepted = await rewound(t, diff.previewId, {
      deps: { readAutomation: blind },
      request: { acceptAutomation: true },
    });
    expect(resultOf(accepted).status).toBe('success');
  });

  it('refuses a rewind whose writes would make the org send more emails than it has left today, whatever is accepted, and writes nothing; one that fits goes (B11, H1)', async () => {
    const t = await taken();
    changedSince(t.org);
    const diff = await previewed(t);
    const before = stateOf(t.org);
    // A flow that emails an account's owner as it is updated: the two
    // accounts the rewind gives back send one each.
    const accountChanged: ForgeTargetObjectAutomation = {
      objectApiName: 'Account',
      flows: [
        {
          apiName: 'Account_changed',
          label: 'Account changed',
          timing: 'afterSave',
          startsOn: 'update',
          condition: 'read',
          permissions: [],
          messages: [{ kind: 'email', name: 'Tell owner', limit: 'SingleEmail' }],
        },
      ],
      triggers: [],
    };
    const sending = automationOf({ objects: [accountChanged] });
    t.org.emailLimits = { SingleEmail: { Max: 15, Remaining: 1 } };

    const outcome = await rewound(t, diff.previewId, {
      deps: { readAutomation: sending },
      request: { acceptAutomation: true },
    });

    expect(outcome).toMatchObject({
      rewound: false,
      refusal: {
        code: 'EMAILS',
        message: expect.stringMatching(
          /^This rewind would make DEV-ED send about 2 single emails, 1 of 15 left today: /,
        ) as unknown,
      },
    });
    untouched(t, before);

    t.org.emailLimits = { SingleEmail: { Max: 15, Remaining: 15 } };
    const fits = await rewound(t, diff.previewId, {
      deps: { readAutomation: sending },
      request: { acceptAutomation: true },
    });
    expect(resultOf(fits).status).toBe('success');
  });

  it('refuses a rewind that would take more requests than the org has left today', async () => {
    const t = await taken();
    changedSince(t.org);
    const diff = await previewed(t);
    const before = stateOf(t.org);
    t.org.limits = { Max: 15_000, Remaining: 30 };

    const outcome = await rewound(t, diff.previewId);

    expect(outcome).toMatchObject({
      rewound: false,
      refusal: {
        code: 'API_BUDGET',
        message: expect.stringMatching(
          /^This rewind takes about \d+ API requests; DEV-ED has 30 of its 15000 left today/,
        ) as unknown,
      },
    });
    untouched(t, before);
  });
});

describe('rewindOrg: records the recycle bin no longer gives back, made again under new Ids', () => {
  /** A colleague deleted the second account — its two contacts going with it — and emptied it from the bin. */
  function emptiedFromTheBin(org: RewindTestOrg): void {
    clock.now = SINCE;
    org.trash('Account', account(2), COLLEAGUE);
    org.purge(account(2));
  }

  /** The record the org made again of `held`, by the values it holds now. */
  function madeOf(org: RewindTestOrg, objectApiName: string, name: string): string {
    const field = objectApiName === 'Account' ? 'Name' : 'LastName';
    const row = org.all(objectApiName).find((each) => each[field] === name);
    if (!row) throw new Error(`no ${objectApiName} ${name} was made again`);
    return row.Id;
  }

  it('refuses to make them again until it is accepted that their Ids are new, saying what a new Id breaks, having written nothing', async () => {
    const t = await taken();
    emptiedFromTheBin(t.org);
    const diff = await previewed(t);
    expect(diff.objects.map((object) => [object.objectApiName, object.toRecreate])).toEqual([
      ['Contact', 2],
      ['Account', 1],
    ]);
    const before = stateOf(t.org);

    const outcome = await rewound(t, diff.previewId);

    expect(outcome).toMatchObject({ rewound: false, refusal: { code: 'RECREATE' } });
    if (outcome.rewound) return;
    expect(outcome.refusal.message).toMatch(/3 Contact, Account record\(s\) deleted since/);
    expect(outcome.refusal.message).toMatch(/new Ids/);
    expect(outcome.refusal.message).toMatch(/outside Salesforce/);
    expect(t.org.creates).toEqual([]);
    expect(stateOf(t.org)).toEqual(before);
    expect(existsSync(t.folder.rewindsDir) ? readdirSync(t.folder.rewindsDir) : []).toEqual([]);
  });

  it('makes them again from the checkpoint, parents first, what it makes naming the new Ids, and leaves the org as the checkpoint holds it but for their Ids, within its estimate', async () => {
    const t = await taken();
    emptiedFromTheBin(t.org);
    clock.now = PREVIEWED;
    const preview = await previewCheckpoint({ org: t.org, store: t.store }, request(t));
    if (!preview.previewed) throw new Error(preview.refusal.message);
    const asked = spent(t.org);

    const result = resultOf(
      await rewound(t, preview.diff.previewId, { request: { acceptRecreate: true } }),
    );

    expect(result.status).toBe('success');
    expect(result.recreated).toEqual([
      { objectApiName: 'Account', planned: 1, created: 1, refused: 0, reasons: [] },
      { objectApiName: 'Contact', planned: 2, created: 2, refused: 0, reasons: [] },
    ]);
    expect(t.org.creates.map(({ objectApiName }) => objectApiName)).toEqual(['Account', 'Contact']);
    const made = madeOf(t.org, 'Account', 'Account two');
    expect(made).not.toBe(account(2));
    expect(
      t.org
        .all('Contact')
        .filter((row) => row.LastName === 'One' || row.LastName === 'Two')
        .map((row) => row.AccountId),
    ).toEqual([made, made]);
    expect(liveAsHeld(stateOf(t.org), t.folder)).toEqual(t.atCheckpoint.live);
    // Named before each insert by the Ids they had, after it by their new ones.
    const kinds = journalKinds(t.folder, result.rewindId);
    expect(kinds.filter((kind) => kind === 'recreating' || kind === 'recreated')).toEqual([
      'recreating',
      'recreated',
      'recreating',
      'recreated',
    ]);
    expect(result.apiRequests.used).toBe(spent(t.org) - asked);
    expect(result.apiRequests.used).toBeLessThanOrEqual(preview.estimate.apiRequests);
  });

  it('gives a record of the checkpoint whose lookup named a record made again the record’s new Id', async () => {
    const t = await taken(
      (org) => {
        baseRecords(org);
        org.add('Contact', { Id: contact(7), LastName: 'Boss', AccountId: account(1) });
        org.edit('Contact', contact(1), { ReportsToId: contact(7) });
      },
      new RewindTestOrg({
        fields: {
          ...FIELDS,
          Contact: [
            ...(FIELDS.Contact ?? []),
            writable('ReportsToId', 'reference', { referenceTo: ['Contact'] }),
          ],
        },
        children: {
          ...CHILDREN,
          Contact: [{ childSObject: 'Contact', field: 'ReportsToId' }],
        },
      }),
    );
    clock.now = SINCE;
    // The delete empties the lookup that named the boss, and restamps its contact.
    t.org.trash('Contact', contact(7), COLLEAGUE);
    t.org.purge(contact(7));
    const diff = await previewed(t);

    const result = resultOf(
      await rewound(t, diff.previewId, { request: { acceptRecreate: true } }),
    );

    expect(result.status).toBe('success');
    const boss = madeOf(t.org, 'Contact', 'Boss');
    expect(t.org.all('Contact').find((row) => row.Id === contact(1))?.ReportsToId).toBe(boss);
    expect(liveAsHeld(stateOf(t.org), t.folder)).toEqual(t.atCheckpoint.live);

    // Undone: what it made goes to the bin, and the lookup it gave the new Id is emptied again.
    const before = stateOf(t.org, ['Contact'], ['LastName', 'AccountId', 'ReportsToId']);
    expect(before.live.Contact).toContainEqual(
      expect.objectContaining({ Id: contact(1), ReportsToId: boss }),
    );
    const undo = await undone(t, result.rewindId);
    expect(undo.status).toBe('success');
    expect(t.org.all('Contact').map((row) => row.Id)).not.toContain(boss);
    expect(t.org.inBin('Contact').map((row) => row.Id)).toContain(boss);
    expect(t.org.all('Contact').find((row) => row.Id === contact(1))?.ReportsToId).toBeNull();
  });

  it('fills in a lookup to a record of the same object made after the one that names it, once both are made', async () => {
    const t = await taken(
      (org) => {
        org.add('Account', { Id: account(1), Name: 'Child' });
        org.add('Account', { Id: account(2), Name: 'Parent' });
        org.edit('Account', account(1), { ParentId: account(2) });
        // Live throughout: the org knows its accounts' Ids, and refuses one gone.
        org.add('Account', { Id: account(3), Name: 'Kept' });
      },
      new RewindTestOrg({
        fields: {
          ...FIELDS,
          Account: [
            ...(FIELDS.Account ?? []),
            writable('ParentId', 'reference', { referenceTo: ['Account'] }),
          ],
        },
        children: { ...CHILDREN, Account: [{ childSObject: 'Account', field: 'ParentId' }] },
      }),
    );
    clock.now = SINCE;
    for (const id of [account(1), account(2)]) {
      t.org.trash('Account', id, COLLEAGUE);
      t.org.purge(id);
    }
    const diff = await previewed(t);

    const result = resultOf(
      await rewound(t, diff.previewId, { request: { acceptRecreate: true } }),
    );

    expect(result.status).toBe('success');
    const child = madeOf(t.org, 'Account', 'Child');
    const parent = madeOf(t.org, 'Account', 'Parent');
    // Made in one insert, the child without its parent, then filled in.
    expect(t.org.creates).toHaveLength(1);
    expect(t.org.updates).toContainEqual({
      objectApiName: 'Account',
      records: [{ Id: child, ParentId: parent }],
    });
    expect(t.org.all('Account').find((row) => row.Id === child)?.ParentId).toBe(parent);
  });

  it('names a record made in an earlier insert of the same object by its new Id: 201 accounts under the first, made 200 a call', async () => {
    const fields = {
      ...FIELDS,
      Account: [
        ...(FIELDS.Account ?? []),
        writable('ParentId', 'reference', { referenceTo: ['Account'] }),
      ],
    };
    const t = await taken(
      (org) => {
        org.add('Account', { Id: account(1), Name: 'Head' });
        for (let n = 2; n <= 201; n++) {
          org.add('Account', { Id: account(n), Name: `Branch ${n}`, ParentId: account(1) });
        }
        org.add('Account', { Id: account(300), Name: 'Kept' });
      },
      new RewindTestOrg({
        fields,
        children: { ...CHILDREN, Account: [{ childSObject: 'Account', field: 'ParentId' }] },
      }),
      PICKED,
      { objects: ['Account'], fields: ['Name', 'ParentId'] },
    );
    clock.now = SINCE;
    for (let n = 1; n <= 201; n++) {
      t.org.trash('Account', account(n), COLLEAGUE);
      t.org.purge(account(n));
    }
    const diff = await previewed(t);

    const result = resultOf(
      await rewound(t, diff.previewId, { request: { acceptRecreate: true } }),
    );

    expect(result.status).toBe('success');
    expect(t.org.creates.map(({ records }) => records.length)).toEqual([200, 1]);
    const head = madeOf(t.org, 'Account', 'Head');
    const last = t.org.all('Account').find((row) => row.Name === 'Branch 201');
    // Sent in the second insert, naming the head the first one made.
    expect(t.org.creates[1].records[0]).toMatchObject({ Name: 'Branch 201', ParentId: head });
    expect(last?.ParentId).toBe(head);
    expect(liveAsHeld(stateOf(t.org, ['Account'], ['Name', 'ParentId']), t.folder)).toEqual(
      t.atCheckpoint.live,
    );
  });

  it('names a record the org refuses to make, in its words, the rest made', async () => {
    const t = await taken();
    emptiedFromTheBin(t.org);
    t.org.refuseCreate = (objectApiName, record) =>
      objectApiName === 'Contact' && record.LastName === 'Two'
        ? { statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'A phone is required' }
        : undefined;
    const diff = await previewed(t);

    const result = resultOf(
      await rewound(t, diff.previewId, { request: { acceptRecreate: true } }),
    );

    expect(result.status).toBe('partial');
    expect(result.residual).toEqual([
      {
        objectApiName: 'Contact',
        reason: 'refused',
        count: 1,
        ids: [contact(2)],
        message: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: A phone is required',
      },
    ]);
    // Tried once more by the second pass, which the org refused again.
    expect(result.recreated).toEqual([
      { objectApiName: 'Account', planned: 1, created: 1, refused: 0, reasons: [] },
      {
        objectApiName: 'Contact',
        planned: 2,
        created: 1,
        refused: 1,
        reasons: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: A phone is required'],
      },
    ]);
    expect(t.org.all('Contact').map((row) => row.LastName)).toContain('One');
  });

  it('rewound again, makes nothing a second time: what it made is the checkpoint’s', async () => {
    const t = await taken();
    emptiedFromTheBin(t.org);
    resultOf(
      await rewound(t, (await previewed(t)).previewId, { request: { acceptRecreate: true } }),
    );
    const made = t.org.creates.length;

    clock.now += 60_000;
    const again = await previewed(t);
    expect(again.objects.some((object) => (object.toRecreate ?? 0) > 0)).toBe(false);
    const result = resultOf(
      await rewound(t, again.previewId, { request: { acceptRecreate: true } }),
    );

    expect(result.status).toBe('success');
    expect(result.recreated).toBeUndefined();
    expect(t.org.creates).toHaveLength(made);
    expect(liveAsHeld(stateOf(t.org), t.folder)).toEqual(t.atCheckpoint.live);
  });

  it('stopped once an insert answered, then rewound again, makes no record twice', async () => {
    const t = await taken();
    emptiedFromTheBin(t.org);
    const diff = await previewed(t);
    const controller = new AbortController();
    const stopping = new Proxy(t.org, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        const call = value as (...args: unknown[]) => unknown;
        if (property !== 'create') return call.bind(target);
        return async (...args: unknown[]) => {
          const answer = await call.apply(target, args);
          controller.abort();
          return answer;
        };
      },
    });

    const stopped = resultOf(
      await rewound(t, diff.previewId, {
        request: { acceptRecreate: true },
        deps: {
          org: stopping,
          undelete: (ids) => stopping.undelete(ids),
          signal: controller.signal,
        },
      }),
    );
    expect(stopped.status).toBe('cancelled');
    expect(t.org.creates.map(({ objectApiName }) => objectApiName)).toEqual(['Account']);

    clock.now += 60_000;
    const result = resultOf(
      await rewound(t, (await previewed(t)).previewId, { request: { acceptRecreate: true } }),
    );

    expect(result.status).toBe('success');
    expect(t.org.creates.map(({ objectApiName }) => objectApiName)).toEqual(['Account', 'Contact']);
    expect(liveAsHeld(stateOf(t.org), t.folder)).toEqual(t.atCheckpoint.live);
  });
});

describe('rewindOrg: records emptied from the recycle bin that Salesforce still lists as deleted', () => {
  /*
   * As seen live: a boss contact, an account with two contacts and an
   * account under it deleted, then emptied from the bin. Read right after —
   * half an hour after still — all five read deleted through queryAll, so the
   * preview counts them to bring back, and only the undelete's answer says
   * the bin no longer holds them. A colleague renamed the boss's account too.
   */
  const FIELDS_SEEN = {
    ...FIELDS,
    Account: [
      ...(FIELDS.Account ?? []),
      writable('ParentId', 'reference', { referenceTo: ['Account'] }),
    ],
    Contact: [
      ...(FIELDS.Contact ?? []),
      writable('ReportsToId', 'reference', { referenceTo: ['Contact'] }),
    ],
  };
  const CHILDREN_SEEN = {
    ...CHILDREN,
    Account: [...(CHILDREN.Account ?? []), { childSObject: 'Account', field: 'ParentId' }],
    Contact: [{ childSObject: 'Contact', field: 'ReportsToId' }],
  };
  const COMPARED_SEEN = { fields: [...COMPARED, 'ParentId', 'ReportsToId'] };
  const K = account(1);
  const P = account(2);
  const C = account(3);
  const BOSS = contact(7);
  const REPORT = contact(8);
  const P1 = contact(1);
  const P2 = contact(2);

  async function emptiedButListed(): Promise<Taken> {
    const t = await taken(
      (org) => {
        org.add('Account', { Id: K, Name: 'K' });
        org.add('Account', { Id: P, Name: 'P' });
        org.add('Account', { Id: C, Name: 'C', ParentId: P });
        org.add('Contact', { Id: BOSS, LastName: 'Boss', AccountId: K });
        org.add('Contact', { Id: REPORT, LastName: 'Report', AccountId: K, ReportsToId: BOSS });
        org.add('Contact', { Id: P1, LastName: 'P1', AccountId: P });
        org.add('Contact', { Id: P2, LastName: 'P2', AccountId: P });
      },
      new RewindTestOrg({ fields: FIELDS_SEEN, children: CHILDREN_SEEN }),
      PICKED,
      COMPARED_SEEN,
    );
    clock.now = SINCE;
    t.org.edit('Account', K, { Name: 'K renamed' }, COLLEAGUE);
    for (const [objectApiName, id] of [
      ['Account', C],
      ['Contact', BOSS],
      ['Account', P],
    ] as const) {
      t.org.trash(objectApiName, id, COLLEAGUE);
    }
    for (const id of [P, C, BOSS]) t.org.empty(id);
    return t;
  }

  /** The record made again of the one the checkpoint names `name`. */
  function madeOf(org: RewindTestOrg, objectApiName: string, name: string): MemoryRow {
    const field = objectApiName === 'Account' ? 'Name' : 'LastName';
    const row = org.all(objectApiName).find((each) => each[field] === name);
    if (!row) throw new Error(`no ${objectApiName} ${name} was made again`);
    return row;
  }

  /** What still differs, each group's ids sorted. */
  const sortedIds = (residual: RewindResult['residual']): RewindResult['residual'] =>
    residual.map((group) => ({ ...group, ids: [...group.ids].sort() }));

  it('counts them to bring back, as the org lists them; made again once accepted, parents first, every lookup the checkpoint holds pointing at the new Ids; read again, nothing differs; Undo deletes them again', async () => {
    const t = await emptiedButListed();
    const diff = await previewed(t);
    expect(
      diff.objects.map(({ objectApiName, toBringBack, toRecreate }) => ({
        objectApiName,
        toBringBack,
        toRecreate,
      })),
    ).toEqual([
      {
        objectApiName: 'Contact',
        toBringBack: { inBin: 1, withParent: 2, deletedWhileTaken: 0 },
        toRecreate: undefined,
      },
      {
        objectApiName: 'Account',
        toBringBack: { inBin: 2, withParent: 0, deletedWhileTaken: 0 },
        toRecreate: undefined,
      },
    ]);

    const result = resultOf(
      await rewound(t, diff.previewId, { request: { acceptRecreate: true } }),
    );

    expect(result.status).toBe('success');
    expect(result.residual).toEqual([]);
    expect(result.recreated).toEqual([
      { objectApiName: 'Account', planned: 2, created: 2, refused: 0, reasons: [] },
      { objectApiName: 'Contact', planned: 3, created: 3, refused: 0, reasons: [] },
    ]);
    // Not brought back: made again instead, and counted so; given back, the
    // contact whose lookup the boss's delete emptied and the renamed account
    // alone, the records made again holding the checkpoint's values already.
    expect(result.undeleted).toEqual([]);
    expect(
      result.restored.map(({ objectApiName, planned, restored }) => [
        objectApiName,
        planned,
        restored,
      ]),
    ).toEqual([
      ['Contact', 1, 1],
      ['Account', 1, 1],
    ]);
    expect(t.org.creates.map(({ objectApiName }) => objectApiName)).toEqual(['Account', 'Contact']);
    const p = madeOf(t.org, 'Account', 'P');
    const c = madeOf(t.org, 'Account', 'C');
    const boss = madeOf(t.org, 'Contact', 'Boss');
    expect([p.Id, c.Id, boss.Id]).not.toContain(P);
    expect(c.ParentId).toBe(p.Id);
    expect(madeOf(t.org, 'Contact', 'P1').AccountId).toBe(p.Id);
    expect(madeOf(t.org, 'Contact', 'P2').AccountId).toBe(p.Id);
    expect(boss.AccountId).toBe(K);
    expect(t.org.all('Contact').find((row) => row.Id === REPORT)?.ReportsToId).toBe(boss.Id);
    expect(t.org.all('Account').find((row) => row.Id === K)?.Name).toBe('K');
    expect(liveAsHeld(stateOf(t.org, undefined, COMPARED_SEEN.fields), t.folder)).toEqual(
      t.atCheckpoint.live,
    );
    // Named before each insert by the Ids they had, after it by their new ones.
    const kinds = journalKinds(t.folder, result.rewindId);
    expect(kinds.filter((kind) => kind === 'recreating' || kind === 'recreated')).toEqual([
      'recreating',
      'recreated',
      'recreating',
      'recreated',
    ]);
    expect(kinds.indexOf('bringingBack')).toBeLessThan(kinds.indexOf('recreating'));

    // Read again, nothing to write: what it made stands for what the bin let go.
    clock.now += 60_000;
    const again = await previewed(t);
    expect(
      again.objects.map(
        ({ toDelete, toGiveBack, toBringBack, toRecreate }) =>
          Object.values(toDelete).reduce((sum, n) => sum + n, 0) +
          toGiveBack.records +
          Object.values(toBringBack).reduce((sum, n) => sum + n, 0) +
          (toRecreate ?? 0),
      ),
    ).toEqual(again.objects.map(() => 0));

    const contacts = [
      boss.Id,
      madeOf(t.org, 'Contact', 'P1').Id,
      madeOf(t.org, 'Contact', 'P2').Id,
    ];
    const undo = await undone(t, result.rewindId);
    expect(undo.status).toBe('success');
    // Named apart from what the rewind brought back: none, here.
    expect(undo.remade).toEqual([
      { objectApiName: 'Account', count: 2 },
      { objectApiName: 'Contact', count: 3 },
    ]);
    expect(liveIds(t.org, 'Account')).toEqual([K]);
    expect(liveIds(t.org, 'Contact')).toEqual([REPORT]);
    expect(t.org.inBin('Account').map((row) => row.Id)).toEqual(
      expect.arrayContaining([p.Id, c.Id]),
    );
    expect(t.org.inBin('Contact').map((row) => row.Id)).toEqual(expect.arrayContaining(contacts));
    expect(t.org.all('Contact').find((row) => row.Id === REPORT)?.ReportsToId).toBeNull();
  });

  it('without that accepted, leaves them, each named with what makes it again, and does the rest of the rewind', async () => {
    const t = await emptiedButListed();
    const diff = await previewed(t);

    const result = resultOf(await rewound(t, diff.previewId));

    expect(result.status).toBe('partial');
    // The contact who reported to the boss gets its lookup back only once the
    // boss is: the org refuses a lookup to a record in the bin (P-B1, P-D4).
    expect(sortedIds(result.residual)).toEqual([
      {
        objectApiName: 'Contact',
        reason: 'refused',
        count: 1,
        ids: [REPORT],
        message: 'ENTITY_IS_DELETED: entity is deleted',
      },
      { objectApiName: 'Contact', reason: 'notInBin', count: 3, ids: [P1, P2, BOSS] },
      { objectApiName: 'Account', reason: 'notInBin', count: 2, ids: [P, C] },
    ]);
    expect(result.undeleted.flatMap(({ reasons }) => reasons)).toEqual([
      NOT_REMADE_WORDS,
      NOT_REMADE_WORDS,
    ]);
    expect(t.org.creates).toEqual([]);
    expect(result.recreated).toBeUndefined();
    // The rest went through: the colleague's rename is taken back.
    expect(t.org.all('Account').find((row) => row.Id === K)?.Name).toBe('K');
  });

  it('stopped once its first insert answered, then rewound again on a fresh preview, makes none of them twice', async () => {
    const t = await emptiedButListed();
    const diff = await previewed(t);
    const controller = new AbortController();
    const stopping = new Proxy(t.org, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        const call = value as (...args: unknown[]) => unknown;
        if (property !== 'create') return call.bind(target);
        return async (...args: unknown[]) => {
          const answer = await call.apply(target, args);
          controller.abort();
          return answer;
        };
      },
    });

    const stopped = resultOf(
      await rewound(t, diff.previewId, {
        request: { acceptRecreate: true },
        deps: {
          org: stopping,
          undelete: (ids) => stopping.undelete(ids),
          signal: controller.signal,
        },
      }),
    );
    expect(stopped.status).toBe('cancelled');
    expect(t.org.creates.map(({ objectApiName }) => objectApiName)).toEqual(['Account']);

    clock.now += 60_000;
    const result = resultOf(
      await rewound(t, (await previewed(t)).previewId, { request: { acceptRecreate: true } }),
    );

    expect(result.status).toBe('success');
    expect(
      t.org.creates.map(({ objectApiName, records }) => [objectApiName, records.length]),
    ).toEqual([
      ['Account', 2],
      ['Contact', 3],
    ]);
    expect(liveAsHeld(stateOf(t.org, undefined, COMPARED_SEEN.fields), t.folder)).toEqual(
      t.atCheckpoint.live,
    );
  });
});

describe('rewindOrg: stopped, and taken up again', () => {
  it(
    'stopped at any call, leaves its journal open; the next rewind takes it up, sends again nothing it did, ends where a whole rewind ends, and Undo returns the org to how it was before the first pass',
    async () => {
      // How many calls a whole rewind of the scenario sends.
      const whole = await taken();
      changedSince(whole.org);
      const wholeDiff = await previewed(whole);
      const calls = resultOf(await rewound(whole, wholeDiff.previewId)).apiRequests.used;
      expect(calls).toBeGreaterThan(20);

      for (let at = 1; at <= calls; at++) {
        const t = await taken();
        changedSince(t.org);
        const beforeRewind = stateOf(t.org);
        const diff = await previewed(t);
        const controller = new AbortController();
        const stopping = stoppedAfter(t.org, at, controller);
        let first: RewindOutcome | undefined;
        try {
          first = await rewound(t, diff.previewId, {
            deps: {
              org: stopping,
              undelete: (ids) => stopping.undelete(ids),
              signal: controller.signal,
            },
          });
        } catch (err: unknown) {
          expect(err, `at ${at}`).toBeInstanceOf(RewindStopped);
        }
        if (first?.rewound)
          expect(first.result.status, `at ${at}`).toMatch(/^(cancelled|success)$/);

        const again = resultOf(await rewound(t, diff.previewId));

        expect(again.status, `at ${at}`).toBe('success');
        expect(stateOf(t.org).live, `at ${at}`).toEqual(t.atCheckpoint.live);
        expect(readdirSync(t.folder.rewindsDir), `at ${at}`).toEqual([again.rewindId]);
        // A record is deleted once, whatever pass or rewind deleted it.
        const deleted = t.org.deletes.flatMap(({ ids }) => ids);
        expect(new Set(deleted).size, `at ${at}`).toBe(deleted.length);

        const undo = await undone(t, again.rewindId);
        expect(undo.status, `at ${at}`).toBe('success');
        expect(stateOf(t.org), `at ${at}`).toEqual(beforeRewind);
      }
    },
    paced(180_000),
  );

  it('holds the org’s lock for its whole length, and lets it go once over', async () => {
    const t = await taken();
    changedSince(t.org);
    const diff = await previewed(t);
    const busy: boolean[] = [];

    resultOf(
      await rewound(t, diff.previewId, {
        deps: {
          onProgress: () => {
            const other = t.store.lock(ORG_ID, 'take');
            busy.push('busy' in other);
            if ('lock' in other) other.lock.release();
          },
        },
      }),
    );

    expect(busy.length).toBeGreaterThan(2);
    expect(busy.every(Boolean)).toBe(true);
    const after = t.store.lock(ORG_ID, 'take');
    expect('lock' in after).toBe(true);
    if ('lock' in after) after.lock.release();
  });

  it('once through, deletes the journal of the rewind before it, which Undo no longer reaches, names it in its result, and keeps its own for its undo', async () => {
    const t = await taken();
    changedSince(t.org);
    const first = resultOf(await rewound(t, (await previewed(t)).previewId));
    expect(first.removedJournals).toBeUndefined();

    clock.now += 60_000;
    t.org.edit('Account', account(1), { Name: 'Renamed again' }, COLLEAGUE);
    const second = resultOf(await rewound(t, (await previewed(t)).previewId));

    expect(second.status).toBe('success');
    expect(second.removedJournals).toEqual([
      { checkpointId: t.checkpoint.checkpointId, name: 'Before UAT', rewindId: first.rewindId },
    ]);
    expect(readdirSync(t.folder.rewindsDir)).toEqual([second.rewindId]);
    const undo = await undone(t, second.rewindId);
    expect(undo.status).toBe('success');
    expect(t.org.all('Account').find((row) => row.Id === account(1))?.Name).toBe('Renamed again');
  });
});

describe('rewindOrg: what it costs', () => {
  it('sends the org no more requests than the estimate its preview gave, every relationship read having records pointing through it, and counts them as the org does', async () => {
    const t = await taken((org) => {
      baseRecords(org);
      org.add('Opportunity', {
        Id: opportunity(2),
        Name: 'Deal two',
        AccountId: account(2),
        Pricebook2Id: book(1),
      });
    });
    clock.now = SINCE;
    t.org.edit('Account', account(1), { Name: 'Renamed' }, COLLEAGUE);
    t.org.add('Account', { Id: account(4), Name: 'New one', LastModifiedById: COLLEAGUE });
    t.org.add('Contact', {
      Id: contact(4),
      LastName: 'New',
      AccountId: account(4),
      LastModifiedById: COLLEAGUE,
    });
    t.org.add('Opportunity', {
      Id: opportunity(4),
      Name: 'New deal',
      AccountId: account(4),
      LastModifiedById: COLLEAGUE,
    });
    t.org.add('OpportunityLineItem', {
      Id: line(4),
      Quantity: 2,
      OpportunityId: opportunity(4),
      LastModifiedById: COLLEAGUE,
    });
    t.org.trash('Account', account(2), COLLEAGUE);
    clock.now = PREVIEWED;
    const preview = await previewCheckpoint({ org: t.org, store: t.store }, request(t));
    if (!preview.previewed) throw new Error(preview.refusal.message);
    const asked = spent(t.org);

    const result = resultOf(await rewound(t, preview.diff.previewId));

    expect(result.status).toBe('success');
    expect(stateOf(t.org).live).toEqual(t.atCheckpoint.live);
    expect(result.apiRequests.used).toBe(spent(t.org) - asked);
    expect(result.apiRequests.used).toBeLessThanOrEqual(preview.estimate.apiRequests);
    expect(result.apiRequests.leftToday).toBe(14_000 - result.apiRequests.used);
  });

  it('sends exactly what the estimate counts when there is nothing to write: the guard, the limits and the fresh read', async () => {
    const t = await taken();
    clock.now = PREVIEWED;
    const preview = await previewCheckpoint({ org: t.org, store: t.store }, request(t));
    if (!preview.previewed) throw new Error(preview.refusal.message);
    const asked = spent(t.org);

    const result = resultOf(await rewound(t, preview.diff.previewId));

    expect(result.status).toBe('success');
    expect(result.undo).toBeUndefined();
    expect(spent(t.org) - asked).toBe(preview.estimate.apiRequests);
    expect(existsSync(t.folder.rewindsDir) ? readdirSync(t.folder.rewindsDir) : []).toEqual([]);
  });
});

describe('counted', () => {
  it('counts a Bulk API job by the calls it says it sent, as the org counts them, and one when it does not say', async () => {
    const org = new RewindTestOrg();
    const answers = [
      { kind: 'answered' as const, rows: [{ success: true as const }], requests: 5 },
      { kind: 'answered' as const, rows: [{ success: true as const }] },
    ];
    const count = counted(
      {
        ...org,
        get version() {
          return org.version;
        },
        request: (asked) => org.request(asked),
        query: (soql, options) => org.query(soql, options),
        queryMore: (url) => org.queryMore(url),
        describeGlobal: () => org.describeGlobal(),
        serverTime: () => org.serverTime(),
        userId: () => org.userId(),
        describe: (name) => org.describe(name),
        update: (name, records) => org.update(name, records),
        create: (name, records) => org.create(name, records),
        destroy: (name, ids) => org.destroy(name, ids),
        queryDeleted: (soql) => org.queryDeleted(soql),
        bulkDestroy: () => Promise.resolve(answers.shift() ?? { kind: 'aborted' }),
      },
      (ids) => org.undelete(ids),
    );

    // P9, live: a job of 200 deletes, opened, sent, closed, its state read
    // twice, took five of the day's requests.
    await count.org.bulkDestroy?.('Account', [account(1)]);
    expect(count.used()).toBe(5);
    await count.org.bulkDestroy?.('Account', [account(2)]);
    expect(count.used()).toBe(6);
  });
});

describe('inRewindWords', () => {
  it('words what a rewind leaves as left as it is, never as the run wrote it', () => {
    expect(
      inRewindWords(
        'Opportunity.StageName: the value from before is no longer taken (bad value) — left as ' +
          'the run wrote it',
      ),
    ).toBe(
      "Opportunity.StageName: the checkpoint's value is no longer taken (bad value) — left as it is",
    );
    expect(inRewindWords('The values from before the run could not be read: timeout')).toBe(
      "The checkpoint's values could not be read: timeout",
    );
    expect(
      inRewindWords(
        'The user SandForge connects as may not delete Case records in this org: the 3 ' +
          'record(s) of the run stay, and were not sent.',
      ),
    ).toBe(
      'The user SandForge connects as may not delete Case records in this org: the 3 ' +
        'record(s) the rewind would delete stay, and were not sent.',
    );
    expect(inRewindWords('FIELD_INTEGRITY_EXCEPTION: no')).toBe('FIELD_INTEGRITY_EXCEPTION: no');
  });

  it('names fifty ids of a residual at most, its count saying how many there are', () => {
    expect(REWIND_RESIDUAL_IDS).toBe(50);
  });
});

describe('rewindOrgOf', () => {
  it('reads and writes the org through the connection a take reads and a removal writes through', async () => {
    const calls: string[] = [];
    const page = { totalSize: 0, done: true, records: [] };
    const conn = {
      version: '66.0',
      request: (asked: { url: string }) => {
        calls.push(`request ${asked.url}`);
        return Promise.resolve({});
      },
      query: (soql: string, options?: { scanAll?: boolean }) => {
        calls.push(`query ${soql} ${options?.scanAll === true ? 'all' : 'live'}`);
        return Promise.resolve(page);
      },
      queryMore: (url: string) => {
        calls.push(`more ${url}`);
        return Promise.resolve(page);
      },
      describe: (name: string) => {
        calls.push(`describe ${name}`);
        return Promise.resolve({});
      },
      describeGlobal: () => {
        calls.push('global');
        return Promise.resolve({ sobjects: [] });
      },
      sobject: (name: string) => ({
        update: () => {
          calls.push(`update ${name}`);
          return Promise.resolve([]);
        },
        create: (_records: unknown, options?: { headers?: Record<string, string> }) => {
          calls.push(`create ${name} ${Object.keys(options?.headers ?? {}).join(',')}`);
          return Promise.resolve([]);
        },
        destroy: () => {
          calls.push(`destroy ${name}`);
          return Promise.resolve([]);
        },
      }),
      soap: {
        getServerTimestamp: () => Promise.resolve({ timestamp: '2026-10-22T14:05:12.000Z' }),
        getUserInfo: () => Promise.resolve({ userId: MEMORY_ORG_USER }),
      },
      limitInfo: {},
    };
    const org = rewindOrgOf(conn as never);

    expect(org.version).toBe('66.0');
    await org.query('SELECT Id FROM Account', { scanAll: true });
    await org.queryMore('/services/data/v66.0/query/01g-2000');
    await org.queryDeleted('SELECT Id FROM Account WHERE IsDeleted = true');
    await org.describe('Account');
    await org.describeGlobal();
    await org.request({ method: 'GET', url: '/limits' });
    await org.update('Account', [{ Id: account(1) }]);
    await org.create('Account', [{ Name: 'Made again' }]);
    await org.destroy('Account', [account(1)]);
    expect(await org.serverTime()).toBe('2026-10-22T14:05:12.000Z');
    expect(await org.userId()).toBe(MEMORY_ORG_USER);
    expect(calls).toEqual([
      'query SELECT Id FROM Account all',
      'more /services/data/v66.0/query/01g-2000',
      'query SELECT Id FROM Account WHERE IsDeleted = true all',
      'describe Account',
      'global',
      'request /limits',
      'update Account',
      // Sent as every write is: a duplicate rule lets it save, the owner it had kept.
      'create Account Sforce-Duplicate-Rule-Header,Sforce-Auto-Assign',
      'destroy Account',
    ]);
  });
});
