import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RewindDiff } from '@sandforge/shared';

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { MEMORY_ORG_USER, type MemoryChild } from '../../test/memoryRemovalOrg.js';
import {
  CHILDREN,
  COLLEAGUE,
  FIELDS,
  PICKED,
  PREVIEWED,
  REWOUND,
  SINCE,
  STAMP_FIELDS,
  T0,
  account,
  baseRecords,
  changedSince,
  clock,
  contact,
  heldObjectByObject,
  line,
  opportunity,
  previewed,
  removeTaken,
  request,
  resultOf,
  rewound,
  spent,
  stateOf,
  taken,
  withdrawn,
  writable,
  RewindTestOrg,
  type Taken,
} from '../../test/rewindTestOrg.js';
import { previewCheckpoint } from './previewCheckpoint.js';
import { OTHERS_DELETION_WORDS, OUT_OF_REACH_WORDS } from './rewindOrg.js';
import { undoCheckpoint, type UndoCheckpointOutcome } from './undoCheckpoint.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * A preview, a rewind and its undo by a user without View All Data and
 * Modify All Data, who holds the checkpoint's objects by View All and Modify
 * All on each, on the memory org (`src/test/rewindTestOrg.ts`), which refuses
 * that user the undelete of what another user deleted, as P-B3 saw a scratch
 * org refuse it.
 */

beforeEach(() => {
  clock.now = T0;
});

afterEach(() => {
  removeTaken();
  vi.mocked(getJsforceConnection).mockReset();
});

/** What the user holds: Modify All on the accounts, contacts and opportunities, none on their products. */
const HELD = {
  Account: { modifyAll: true },
  Contact: { modifyAll: true },
  Opportunity: { modifyAll: true },
};

/** The org's records long before the checkpoint, and a product under the opportunity. */
function withProduct(org: RewindTestOrg): void {
  baseRecords(org);
  org.add('OpportunityLineItem', { Id: line(1), Quantity: 1, OpportunityId: opportunity(1) });
}

/** A checkpoint of the objects picked, taken by the user object by object. */
async function takenObjectByObject(
  build: (org: RewindTestOrg) => void = baseRecords,
  org = new RewindTestOrg(),
): Promise<Taken> {
  return taken((held) => {
    build(held);
    heldObjectByObject(held, HELD);
  }, org);
}

/** The cannot-undo reasons of each object of a diff, by object. */
function cannotOf(diff: RewindDiff): Record<string, Array<{ reason: string; count: number }>> {
  return Object.fromEntries(diff.objects.map((o) => [o.objectApiName, o.cannotUndo]));
}

/** Of a diff, per object, what it brings back on its own and with its parent, and what it makes again. */
function backOf(diff: RewindDiff): Record<string, [number, number, number]> {
  return Object.fromEntries(
    diff.objects.map((o) => [
      o.objectApiName,
      [o.toBringBack.inBin, o.toBringBack.withParent, o.toRecreate ?? 0],
    ]),
  );
}

describe('a checkpoint taken object by object', () => {
  it('holds each object by how its user held it, and a preview reads it again object by object, counting what that sent', async () => {
    const t = await takenObjectByObject();

    expect(
      t.checkpoint.objects.map(({ objectApiName, access }) => [objectApiName, access]),
    ).toEqual(
      expect.arrayContaining([
        ['Account', 'object'],
        ['Contact', 'object'],
        ['Opportunity', 'object'],
        ['OpportunityLineItem', 'parent'],
      ]),
    );
    const diff = await previewed(t);
    // The user's id, their rows, their groups; the products and the
    // opportunities they hang from described.
    expect(diff.access).toEqual({ kind: 'perObject', requests: 3 + 2 });
    expect(diff.unread).toEqual([]);
  });
});

describe('what another user deleted since, read object by object', () => {
  it('names what a colleague deleted since deleted by another user, never to bring back nor to make again, and brings back what the user deleted', async () => {
    const t = await takenObjectByObject();
    changedSince(t.org);
    t.org.trash('Contact', contact(3));

    const diff = await previewed(t);

    expect(cannotOf(diff)).toMatchObject({
      Account: [{ reason: 'deletedByOther', count: 1 }],
      Contact: [{ reason: 'deletedByOther', count: 2 }],
    });
    expect(backOf(diff)).toMatchObject({ Account: [0, 0, 0], Contact: [1, 0, 0] });
  });

  it('brings everything back with View All Data and Modify All Data, the same changes made: the negative control', async () => {
    const t = await taken();
    changedSince(t.org);
    t.org.trash('Contact', contact(3));

    const diff = await previewed(t);

    expect(diff.access).toEqual({ kind: 'org' });
    expect(backOf(diff)).toMatchObject({ Account: [1, 0, 0], Contact: [1, 2, 0] });
    expect(diff.objects.flatMap((o) => o.cannotUndo)).toEqual([]);
  });

  it('rewinds the rest and leaves in the recycle bin what the colleague deleted, never asking the org to bring it back, each record named with why', async () => {
    const t = await takenObjectByObject();
    changedSince(t.org);
    t.org.trash('Contact', contact(3));
    const diff = await previewed(t);
    const asked: string[] = [];

    const result = resultOf(
      await rewound(t, diff.previewId, {
        deps: {
          undelete: (ids) => {
            asked.push(...ids);
            return t.org.undelete(ids);
          },
        },
      }),
    );

    expect(asked).toEqual([contact(3)]);
    expect(t.org.all('Contact').map((row) => row.Id)).toContain(contact(3));
    expect(t.org.inBin('Account').map((row) => row.Id)).toContain(account(2));
    // The colleague's contact under an account created since went with it.
    expect(
      t.org
        .inBin('Contact')
        .map((row) => row.Id)
        .sort(),
    ).toEqual([contact(1), contact(2), contact(4)]);
    // What the colleague created since is deleted, what they changed given back.
    expect(
      t.org
        .all('Account')
        .map((row) => row.Id)
        .sort(),
    ).toEqual([account(1), account(3)]);
    expect(t.org.all('Account').find((row) => row.Id === account(1))?.Name).toBe('Account one');
    expect(result.status).toBe('partial');
    expect(result.residual).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          objectApiName: 'Account',
          reason: 'kept',
          count: 1,
          message: OTHERS_DELETION_WORDS,
        }),
        expect.objectContaining({
          objectApiName: 'Contact',
          reason: 'kept',
          count: 2,
          message: OTHERS_DELETION_WORDS,
        }),
      ]),
    );
    expect(result.residual.filter((entry) => entry.reason === 'refused')).toEqual([]);
  });
});

describe('an object held through what it hangs from, read object by object', () => {
  it('names a product a colleague deleted out of reach when the bin shows the user their own deletions alone, deleted by another when it shows them all, never to make again', async () => {
    const hidden = await takenObjectByObject(withProduct);
    hidden.org.binShowsOwnOnly.add('OpportunityLineItem');
    clock.now = SINCE;
    hidden.org.trash('OpportunityLineItem', line(1), COLLEAGUE);
    const seen = await takenObjectByObject(withProduct);
    clock.now = SINCE;
    seen.org.trash('OpportunityLineItem', line(1), COLLEAGUE);

    const outOfSight = await previewed(hidden);
    const inSight = await previewed(seen);

    expect(cannotOf(outOfSight).OpportunityLineItem).toEqual([{ reason: 'outOfReach', count: 1 }]);
    expect(cannotOf(inSight).OpportunityLineItem).toEqual([{ reason: 'deletedByOther', count: 1 }]);
    for (const diff of [outOfSight, inSight]) {
      expect(backOf(diff).OpportunityLineItem).toEqual([0, 0, 0]);
    }
  });

  it('makes the product again with View All Data and Modify All Data: the negative control', async () => {
    const t = await taken(withProduct);
    t.org.binShowsOwnOnly.add('OpportunityLineItem');
    clock.now = SINCE;
    t.org.trash('OpportunityLineItem', line(1), COLLEAGUE);

    const diff = await previewed(t);

    expect(backOf(diff).OpportunityLineItem).toEqual([0, 0, 1]);
  });

  it('never makes again a product Salesforce answers is no longer in the recycle bin, though the opportunity it came back with is made again', async () => {
    const run = async (t: Taken) => {
      clock.now = SINCE;
      t.org.trash('Opportunity', opportunity(1));
      t.org.empty(opportunity(1));
      const diff = await previewed(t);
      return resultOf(await rewound(t, diff.previewId, { request: { acceptRecreate: true } }));
    };

    const perObject = await run(await takenObjectByObject(withProduct));
    const whole = await run(await taken(withProduct));

    expect(perObject.recreated?.map((o) => [o.objectApiName, o.created])).toEqual([
      ['Opportunity', 1],
    ]);
    expect(perObject.residual).toContainEqual(
      expect.objectContaining({
        objectApiName: 'OpportunityLineItem',
        reason: 'kept',
        count: 1,
        message: OUT_OF_REACH_WORDS,
      }),
    );
    // With View All Data and Modify All Data, the product is made again with it.
    expect(whole.recreated?.map((o) => [o.objectApiName, o.created])).toEqual([
      ['Opportunity', 1],
      ['OpportunityLineItem', 1],
    ]);
  });
});

describe('an object no longer held', () => {
  it('is not read, could not be read with why, and is left as it is', async () => {
    const t = await takenObjectByObject();
    withdrawn(t.org, ['Contact']);
    clock.now = SINCE;
    t.org.edit('Contact', contact(3), { LastName: 'Changed' }, COLLEAGUE);

    const diff = await previewed(t);
    const result = resultOf(await rewound(t, diff.previewId, { request: { acceptUnseen: true } }));

    expect(diff.unread).toEqual([
      {
        objectApiName: 'Contact',
        reason: 'tester@example.com no longer has View All and Modify All on Contact',
      },
    ]);
    expect(diff.objects.map((o) => o.objectApiName)).not.toContain('Contact');
    expect(t.org.all('Contact').find((row) => row.Id === contact(3))?.LastName).toBe('Changed');
    expect(result.unread).toEqual(diff.unread);
    expect(result.status).not.toBe('success');
  });

  it('refuses a rewind acting on a preview read with more than its user holds now, writing nothing, and acts on one read as they hold it', async () => {
    const t = await taken();
    changedSince(t.org);
    const diff = await previewed(t);
    heldObjectByObject(t.org, HELD);
    const before = stateOf(t.org);

    const refused = await rewound(t, diff.previewId, { request: { reusesPreview: diff } });

    expect(refused).toEqual({
      rewound: false,
      refusal: {
        code: 'PERMISSIONS',
        message:
          'The preview read DEV-ED with permissions its user no longer has (View All Data and ' +
          'Modify All Data). Preview the rewind again: it reads the org as the user can now. ' +
          'No record was written.',
      },
    });
    expect(stateOf(t.org)).toEqual(before);

    clock.now = REWOUND + 60_000;
    const again = await previewed(t);
    const result = resultOf(
      await rewound(t, again.previewId, { request: { reusesPreview: again } }),
    );
    expect(result.status).toBe('partial');
  });
});

/** The fields of an org whose accounts hold tasks, which a delete of an account takes along. */
const WITH_TASKS: Record<string, unknown[]> = {
  ...FIELDS,
  Task: [
    ...STAMP_FIELDS,
    writable('Subject'),
    writable('WhatId', 'reference', { referenceTo: ['Account'] }),
  ],
};

const TASK_CHILDREN: Record<string, MemoryChild[]> = {
  ...CHILDREN,
  Account: [...CHILDREN.Account, { childSObject: 'Task', field: 'WhatId', cascadeDelete: true }],
};

describe('what a delete takes along out of sight', () => {
  /** Accounts created since, a private task of the colleague's under one. */
  async function withTasks(perObject: boolean): Promise<Taken> {
    const org = new RewindTestOrg({ fields: WITH_TASKS, children: TASK_CHILDREN });
    const t = perObject
      ? await takenObjectByObject(baseRecords, org)
      : await taken(baseRecords, org);
    clock.now = SINCE;
    t.org.add('Account', { Id: account(4), Name: 'New one', LastModifiedById: COLLEAGUE });
    t.org.add('Account', { Id: account(5), Name: 'New two', LastModifiedById: COLLEAGUE });
    t.org.add('Task', { Id: '00T000000000001AAA', Subject: 'Private', WhatId: account(4) });
    return t;
  }

  it('names, of the accounts to delete, the tasks under them the user cannot be shown, and refuses the rewind until that is accepted, writing nothing', async () => {
    const t = await withTasks(true);
    const diff = await previewed(t);
    const before = stateOf(t.org, [...PICKED, 'Task']);

    const refused = await rewound(t, diff.previewId, { request: { acceptOutside: true } });

    expect(diff.unseen).toEqual([{ objectApiName: 'Account', children: ['Task'], records: 2 }]);
    expect(refused).toEqual({
      rewound: false,
      refusal: {
        code: 'UNSEEN',
        message:
          "Deleting 2 Account record(s) created since also deletes what tester@example.com can't " +
          "see under them in Task: Rewind can't count those. Rewind refused; accept that it " +
          "deletes what tester@example.com can't see to rewind all the same. No record was " +
          'written.',
      },
    });
    expect(stateOf(t.org, [...PICKED, 'Task'])).toEqual(before);

    const accepted = resultOf(
      await rewound(t, diff.previewId, { request: { acceptOutside: true, acceptUnseen: true } }),
    );
    expect(accepted.status).toBe('success');
    expect(t.org.all('Account').map((row) => row.Id)).not.toContain(account(4));
    expect(t.org.all('Task')).toEqual([]);
  });

  it('asks nothing of a user with View All Data and Modify All Data, who sees every task: the negative control', async () => {
    const t = await withTasks(false);
    const diff = await previewed(t);

    const result = resultOf(await rewound(t, diff.previewId, { request: { acceptOutside: true } }));

    expect(diff).not.toHaveProperty('unseen');
    expect(result.status).toBe('success');
  });
});

describe('what a rewind object by object costs', () => {
  it('sends exactly what the estimate counts when there is nothing to write, the reads of the user’s permissions among them', async () => {
    const t = await takenObjectByObject();
    clock.now = PREVIEWED;
    const preview = await previewCheckpoint({ org: t.org, store: t.store }, request(t));
    if (!preview.previewed) throw new Error(preview.refusal.message);
    const asked = spent(t.org);

    const result = resultOf(await rewound(t, preview.diff.previewId));

    expect(result.status).toBe('success');
    expect(spent(t.org) - asked).toBe(preview.estimate.apiRequests);
  });

  it('counts the reads of the user’s permissions in the estimate: the same diff read with View All Data and Modify All Data costs that much less', async () => {
    const t = await takenObjectByObject();
    clock.now = PREVIEWED;
    const preview = await previewCheckpoint({ org: t.org, store: t.store }, request(t));
    if (!preview.previewed) throw new Error(preview.refusal.message);
    const { rewindEstimate } = await import('./rewindEstimate.js');

    const asOrg = rewindEstimate({
      objects: t.checkpoint.objects,
      diff: { ...preview.diff, access: { kind: 'org' } },
      automationRequests: 0,
    });
    const asRead = rewindEstimate({
      objects: t.checkpoint.objects,
      diff: preview.diff,
      automationRequests: 0,
    });

    expect(asRead.apiRequests - asOrg.apiRequests).toBe(5);
  });
});

/** The undo of the last rewind of `t`, by the user the org's session acts as. */
async function undoneNow(t: Taken, rewindId: string): Promise<UndoCheckpointOutcome> {
  clock.now += 60_000;
  const read = await t.store.read(t.checkpoint.checkpointId);
  if (!read?.checkpoint) throw new Error('the checkpoint is gone');
  return undoCheckpoint(
    { org: t.org, undelete: (ids) => t.org.undelete(ids), store: t.store },
    { ...request(t), checkpoint: read.checkpoint, rewindId, acceptAutomation: false },
  );
}

describe('the undo of a rewind object by object', () => {
  it('takes back the user’s own rewind', async () => {
    const t = await takenObjectByObject();
    changedSince(t.org);
    t.org.trash('Contact', contact(3));
    const atRewind = stateOf(t.org);
    const rewind = resultOf(await rewound(t, (await previewed(t)).previewId));

    const outcome = await undoneNow(t, rewind.rewindId);

    expect(outcome.undone).toBe(true);
    expect(stateOf(t.org).live).toEqual(atRewind.live);
  });

  it('refuses to take back what the rewind did to an object the user no longer holds, writing nothing and leaving the undo offered', async () => {
    const t = await takenObjectByObject();
    changedSince(t.org);
    const rewind = resultOf(await rewound(t, (await previewed(t)).previewId));
    withdrawn(t.org, ['Account']);
    const before = stateOf(t.org);

    const outcome = await undoneNow(t, rewind.rewindId);

    expect(outcome).toEqual({
      undone: false,
      refusal: {
        code: 'PERMISSIONS',
        message:
          'Undo takes back what the rewind did to objects tester@example.com no longer holds ' +
          'whole (Account: tester@example.com no longer has View All and Modify All on ' +
          'Account), and does not stop part way: an undo left part way could not be offered ' +
          'again. Undo it once the user has View All and Modify All on them again, or as a user ' +
          'with View All Data and Modify All Data. No record was written.',
      },
    });
    expect(stateOf(t.org)).toEqual(before);
    const read = await t.store.read(t.checkpoint.checkpointId);
    expect(read?.checkpoint?.lastRewind?.undoneAt).toBeUndefined();
  });

  it('refuses to take back a rewind made as another user, whose deletions the user cannot bring back', async () => {
    const t = await taken();
    changedSince(t.org);
    const diff = await previewed(t);
    // The rewind is made as the colleague, who holds View All Data and Modify All Data.
    t.org.userId = () => Promise.resolve(COLLEAGUE);
    const rewind = resultOf(await rewound(t, diff.previewId));
    t.org.userId = () => Promise.resolve(MEMORY_ORG_USER);
    heldObjectByObject(t.org, HELD);
    const before = stateOf(t.org);

    const outcome = await undoneNow(t, rewind.rewindId);

    expect(outcome).toMatchObject({ undone: false, refusal: { code: 'PERMISSIONS' } });
    expect(outcome.undone === false && outcome.refusal.message).toContain(
      'This rewind was made as another user than tester@example.com',
    );
    expect(stateOf(t.org)).toEqual(before);
  });
});
