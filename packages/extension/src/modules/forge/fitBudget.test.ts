import * as fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import {
  BYTES_PER_MB,
  mutePlanOf,
  stillRunningOf,
  type ForgeTargetAutomation,
  type ForgeTargetFlow,
} from '@sandforge/shared';

import { apiBudgetCheckOf } from './ForgeRunGate.js';
import {
  STORAGE_ROUNDING_MARGIN_MB,
  automationRoomOf,
  evenlyKept,
  fitBudgetOf,
  roomBytesOf,
  storageFitBudgetOf,
  storageRecountWords,
  type FitAct,
} from './fitBudget.js';

const KB = 1024;

/** A flow of the target read with its start condition, creating nothing unless told. */
function flow(overrides: Partial<ForgeTargetFlow> = {}): ForgeTargetFlow {
  return {
    apiName: 'Flow',
    label: 'Flow',
    timing: 'afterSave',
    startsOn: 'create',
    condition: 'read',
    permissions: [],
    ...overrides,
  };
}

/**
 * A client sandbox's shape on Account: an insert flow that publishes an event
 * and tests the org's bypass, an update flow that creates a Task and an
 * action plan, also behind the bypass, a flow with no bypass creating an
 * Asset, one creating sharing rows, a trigger, and a flow not read.
 */
const READ: ForgeTargetAutomation = {
  objectsRead: ['Account'],
  objects: [
    {
      objectApiName: 'Account',
      flows: [
        flow({
          apiName: 'Account_Event',
          label: 'Account event',
          creates: ['ProviderEvent__e'],
          permissions: [{ name: 'Account_BypassFlow', bypass: true, held: false }],
        }),
        flow({
          apiName: 'Account_Follow_Up',
          label: 'Account follow-up',
          startsOn: 'update',
          creates: ['Task', 'ActionPlan'],
          permissions: [{ name: 'Account_BypassFlow', bypass: true, held: false }],
        }),
        flow({ apiName: 'Account_Asset', label: 'Account asset', creates: ['Asset'] }),
        flow({ apiName: 'Account_Share', label: 'Account share', creates: ['AccountShare'] }),
        flow({ apiName: 'Unread', label: 'Unread flow', condition: 'notRead' }),
      ],
      triggers: [{ name: 'AccountTrigger', events: ['afterInsert'] }],
    },
  ],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  bypassGrants: [
    {
      permission: 'Account_BypassFlow',
      permissionSets: [{ name: 'Account_Bypass', label: 'Account bypass', grants: 1 }],
    },
  ],
  requests: 1,
};

/** The run inserts accounts, and updates those it writes a second time. */
const insertsAndUpdates = (_object: string, act: string): boolean =>
  act === 'insert' || act === 'update';

describe('fitBudgetOf', () => {
  it('keeps 80 % of what a Developer Edition says it has left, its rounding off first', () => {
    const budget = fitBudgetOf({ storage: { maxMB: 5, remainingMB: 5 } });

    expect(STORAGE_ROUNDING_MARGIN_MB).toBe(0.5);
    // 0.8 × (5 − 0.5): without the margin, the 4 MB a 5 MB org may not have.
    expect(budget).toMatchObject({ bytes: Math.floor(3.6 * BYTES_PER_MB) });
    expect(budget).not.toMatchObject({ bytes: 4 * BYTES_PER_MB });
    expect(budget).toMatchObject({
      terms: { remainingMB: 5, maxMB: 5, share: 0.8, roundingMB: 0.5, limitedBy: 'storage' },
    });
  });

  it('says the storage left may count a load minutes after it, never a number of seconds', () => {
    // Run for real on a Developer Edition: 5 MB of 5 left a hundred seconds
    // after a load, 2 only 384 seconds after it.
    expect(storageRecountWords('DEV')).toBe(
      'Salesforce can take several minutes to count a load in what DEV says it has left: ' +
        'a run started sooner after another may read room it no longer has',
    );
    expect(storageRecountWords('DEV')).not.toMatch(/\d+ seconds/);
  });

  it('holds to the bound asked when it is lower than what the org has left, and says which held', () => {
    expect(fitBudgetOf({ storage: { maxMB: 500, remainingMB: 500 }, withinMB: 3 })).toMatchObject({
      bytes: 3 * BYTES_PER_MB,
      terms: { withinMB: 3, limitedBy: 'within' },
    });
    expect(fitBudgetOf({ storage: { maxMB: 5, remainingMB: 5 }, withinMB: 50 })).toMatchObject({
      terms: { withinMB: 50, limitedBy: 'storage' },
    });
  });

  it('leaves nothing to write in an org that says less than its rounding, and nothing to fit to in one that would not say', () => {
    expect(fitBudgetOf({ storage: { maxMB: 5, remainingMB: 0 } })).toMatchObject({ bytes: 0 });
    expect(fitBudgetOf({ storage: { unread: 'INSUFFICIENT_ACCESS' } })).toEqual({
      unread: 'INSUFFICIENT_ACCESS',
    });
  });

  it('bounds the run’s own requests to what passes its gate without asking, the checkpoint taken first counted', () => {
    const api = { max: 15_000, remaining: 2_000 };
    const budget = fitBudgetOf({
      storage: { maxMB: 5, remainingMB: 5 },
      api,
      otherRequests: { checkpoint: 68, fit: 19 },
    });
    expect(budget).toMatchObject({ runRequests: 2_000 - 1_500 - 68 - 19 });
    const run = 'runRequests' in budget ? (budget.runRequests ?? 0) : 0;
    expect(apiBudgetCheckOf({ run, checkpoint: 68, fit: 19 }, api).verdict).toBe('fits');
    expect(apiBudgetCheckOf({ run: run + 1, checkpoint: 68, fit: 19 }, api).verdict).toBe('near');
    expect(
      fitBudgetOf({ storage: { maxMB: 5, remainingMB: 5 }, api: { unread: 'refused' } }),
    ).toMatchObject({ requestsUnread: 'refused' });
  });

  it('keeps a run within its requests, whatever the parts, as its gate judges them', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1_000, max: 100_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 500 }),
        (max, remaining, checkpoint) => {
          const api = { max, remaining };
          const budget = fitBudgetOf({
            storage: { maxMB: 5, remainingMB: 5 },
            api,
            otherRequests: { checkpoint },
          });
          const run = 'runRequests' in budget ? (budget.runRequests ?? 0) : 0;
          if (run > 0) {
            expect(apiBudgetCheckOf({ run, checkpoint }, api).verdict).toBe('fits');
            expect(apiBudgetCheckOf({ run: run + 1, checkpoint }, api).verdict).not.toBe('fits');
          }
        },
      ),
    );
  });
});

describe('automationRoomOf', () => {
  it('keeps room only for what still runs once the mute holds: the asset of the flow without a bypass', () => {
    const plan = mutePlanOf(READ, insertsAndUpdates);
    const room = automationRoomOf(stillRunningOf(READ, plan, insertsAndUpdates), insertsAndUpdates);

    expect(room.perRecord).toEqual([
      {
        objectApiName: 'Account',
        act: 'insert',
        bytes: 2 * KB,
        creates: [{ objectApiName: 'Asset', by: 'Account asset' }],
      },
    ]);
  });

  it('keeps room for what the mute would keep quiet when the run does not mute, an update flow on the records it updates', () => {
    const room = automationRoomOf(stillRunningOf(READ, undefined), insertsAndUpdates);

    expect(room.perRecord).toEqual([
      {
        objectApiName: 'Account',
        act: 'insert',
        bytes: 2 * KB,
        creates: [{ objectApiName: 'Asset', by: 'Account asset' }],
      },
      {
        objectApiName: 'Account',
        act: 'update',
        bytes: 4 * KB,
        creates: [
          { objectApiName: 'Task', by: 'Account follow-up' },
          { objectApiName: 'ActionPlan', by: 'Account follow-up' },
        ],
      },
    ]);
    // 100 accounts inserted, 10 of them written a second time.
    const kept = (_object: string, act: FitAct): number => (act === 'insert' ? 100 : 10);
    expect(roomBytesOf(room, kept)).toBe(100 * 2 * KB + 10 * 4 * KB);
    // Without the update the run makes, the follow-up flow creates nothing under it.
    const insertsOnly = (_object: string, act: FitAct): boolean => act === 'insert';
    expect(roomBytesOf(automationRoomOf(stillRunningOf(READ, undefined), insertsOnly), kept)).toBe(
      100 * 2 * KB,
    );
  });

  it('leaves a platform event out, and names a sharing row, a trigger and a flow not read without counting them', () => {
    const room = automationRoomOf(stillRunningOf(READ, undefined), insertsAndUpdates);

    expect(room.perRecord.flatMap((r) => r.creates.map((c) => c.objectApiName))).not.toContain(
      'ProviderEvent__e',
    );
    expect(room.notCounted).toEqual([
      { objectApiName: 'Account', kind: 'trigger', name: 'AccountTrigger' },
      { objectApiName: 'Account', kind: 'share', name: 'AccountShare' },
      { objectApiName: 'Account', kind: 'notRead', name: 'Unread flow' },
    ]);
  });

  it('keeps no room for a removal: a delete creates nothing the storage counts', () => {
    const removing = stillRunningOf(READ, undefined, (_object, write) => write === 'delete');
    expect(automationRoomOf(removing, insertsAndUpdates)).toEqual({
      perRecord: [],
      notCounted: [],
    });
  });
});

describe('storageFitBudgetOf', () => {
  it('says the budget as the fit’s line does: what may be written, the room off, and what is not counted', () => {
    const budget = fitBudgetOf({ storage: { maxMB: 21, remainingMB: 21 } });
    if ('unread' in budget) throw new Error(budget.unread);
    const room = automationRoomOf(stillRunningOf(READ, undefined), insertsAndUpdates);

    expect(storageFitBudgetOf(budget, BYTES_PER_MB / 2, room)).toEqual({
      budgetMB: (Math.floor(0.8 * 20.5 * BYTES_PER_MB) - BYTES_PER_MB / 2) / BYTES_PER_MB,
      remainingMB: 21,
      maxMB: 21,
      share: 0.8,
      roundingMB: 0.5,
      limitedBy: 'storage',
      automationMB: 0.5,
      notCounted: room.notCounted,
    });
  });
});

describe('evenlyKept', () => {
  it('keeps exactly k positions, never further apart than ⌈n / k⌉, the same ones every time', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5_000 }),
        fc.integer({ min: 1, max: 5_000 }),
        (n, k) => {
          const kept = evenlyKept(n, k);
          const keep = Math.min(n, k);
          expect(kept).toHaveLength(keep);
          expect(new Set(kept).size).toBe(keep);
          expect(kept.every((i, at) => i >= 0 && i < n && (at === 0 || i > kept[at - 1]!))).toBe(
            true,
          );
          const gap = Math.ceil(n / keep);
          let previous = -1;
          for (const i of kept) {
            expect(i - previous).toBeLessThanOrEqual(gap);
            previous = i;
          }
          expect(n - previous).toBeLessThanOrEqual(gap);
          expect(evenlyKept(n, k)).toEqual(kept);
        },
      ),
    );
  });

  it('spreads what it keeps over the whole table, the first records no more than the last', () => {
    expect(evenlyKept(10, 3)).toEqual([3, 6, 9]);
    expect(evenlyKept(10, 5)).toEqual([1, 3, 5, 7, 9]);
    expect(evenlyKept(4, 9)).toEqual([0, 1, 2, 3]);
    expect(evenlyKept(4, 0)).toEqual([]);
    expect(evenlyKept(0, 3)).toEqual([]);
  });
});
