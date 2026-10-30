/**
 * Properties of a rewind limited to some objects, on the memory org, over
 * random histories since the checkpoint and random selections of its
 * objects: it writes nothing outside the selection but what coming back with
 * a record it brings back takes; a rewind of every object after it ends where
 * a rewind of every object alone does; its undo returns the org to how it
 * was before it; and the plan of the selection the page is told
 * (`planSelection`, `checkpoint:plan-selection`) is the plan the rewind
 * then makes, count for count — a plan computed apart is caught diverging.
 */

import * as fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RewindDiff, RewindSelectionPlan } from '@sandforge/shared';

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { paced } from '../../test/runnerPace.js';
import { type MemoryChild } from '../../test/memoryRemovalOrg.js';
import {
  COLLEAGUE,
  PRICE_BOOK_HELD,
  SINCE,
  STAMP_FIELDS,
  T0,
  RewindTestOrg,
  account,
  book,
  clock,
  contact,
  line,
  opportunity,
  previewed,
  recreatedOf,
  removeTaken,
  resultOf,
  rewound,
  taken,
  undone,
  writable,
  type Taken,
} from '../../test/rewindTestOrg.js';
import { comparedFields } from './checkpointFields.js';
import { previewDirOf } from './OrgCheckpointStore.js';
import { readRewindJournal } from './rewindJournal.js';
import { planSelection, snapshotRowsOf } from './rewindPlan.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** The plans the rewind made, each as the page would be told it, as each was made. */
const madePlans: Array<Promise<RewindSelectionPlan>> = [];
vi.mock('./rewindPlan.js', async (original) => {
  const actual = await original<typeof import('./rewindPlan.js')>();
  return {
    ...actual,
    rewindPlan: vi.fn(async (input: Parameters<typeof actual.rewindPlan>[0]) => {
      const plan = await actual.rewindPlan(input);
      // Told now: its folder goes with the rewind's reads once it is over.
      if (input.pass === 1) madePlans.push(actual.selectionPlanOf(plan));
      return plan;
    }),
  };
});

beforeEach(() => {
  clock.now = T0;
  madePlans.length = 0;
});

afterEach(() => {
  removeTaken();
  vi.mocked(getJsforceConnection).mockReset();
});

// ─── The org ─────────────────────────────────────────────────────────────────

const FIELDS: Record<string, unknown[]> = {
  Account: [...STAMP_FIELDS, writable('Name')],
  Contact: [
    ...STAMP_FIELDS,
    writable('LastName'),
    writable('AccountId', 'reference', { referenceTo: ['Account'] }),
    writable('ReportsToId', 'reference', { referenceTo: ['Contact'] }),
  ],
  Opportunity: [
    ...STAMP_FIELDS,
    writable('Name'),
    writable('AccountId', 'reference', { referenceTo: ['Account'] }),
    writable('Pricebook2Id', 'reference', { referenceTo: ['Pricebook2'] }),
  ],
  OpportunityLineItem: [
    ...STAMP_FIELDS,
    writable('Quantity', 'double'),
    writable('OpportunityId', 'reference', { referenceTo: ['Opportunity'], updateable: false }),
  ],
};

const CHILDREN: Record<string, MemoryChild[]> = {
  Account: [
    { childSObject: 'Contact', field: 'AccountId', cascadeDelete: true },
    { childSObject: 'Opportunity', field: 'AccountId', cascadeDelete: true },
  ],
  Contact: [{ childSObject: 'Contact', field: 'ReportsToId' }],
  Opportunity: [
    { childSObject: 'OpportunityLineItem', field: 'OpportunityId', cascadeDelete: true },
  ],
};

const OBJECTS = ['Account', 'Contact', 'Opportunity', 'OpportunityLineItem'];

function orgOf(): RewindTestOrg {
  const org = new RewindTestOrg({ fields: FIELDS, children: CHILDREN });
  org.heldByChildren.push(PRICE_BOOK_HELD);
  return org;
}

function atCheckpoint(org: RewindTestOrg): void {
  org.add('Account', { Id: account(1), Name: 'One' });
  org.add('Account', { Id: account(2), Name: 'Two' });
  org.add('Contact', { Id: contact(1), LastName: 'One', AccountId: account(1) });
  org.add('Contact', {
    Id: contact(2),
    LastName: 'Two',
    AccountId: account(1),
    ReportsToId: contact(1),
  });
  org.add('Contact', { Id: contact(3), LastName: 'Three', AccountId: account(2) });
  org.add('Opportunity', {
    Id: opportunity(1),
    Name: 'Deal one',
    AccountId: account(1),
    Pricebook2Id: book(1),
  });
  org.add('Opportunity', {
    Id: opportunity(2),
    Name: 'Deal two',
    AccountId: account(2),
    Pricebook2Id: book(1),
  });
  org.add('OpportunityLineItem', { Id: line(1), Quantity: 1, OpportunityId: opportunity(2) });
}

type Step =
  | { kind: 'edit'; object: number; pick: number; value: number }
  | { kind: 'move'; object: number; pick: number; to: number }
  | { kind: 'create'; object: number; parent: number }
  | { kind: 'trash'; object: number; pick: number }
  | { kind: 'untrash'; object: number; pick: number };

const objectIndex = fc.nat(OBJECTS.length - 1);
const pick = fc.nat(30);
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ kind: fc.constant('edit' as const), object: objectIndex, pick, value: fc.nat(9) }),
  fc.record({ kind: fc.constant('move' as const), object: objectIndex, pick, to: pick }),
  fc.record({ kind: fc.constant('create' as const), object: objectIndex, parent: pick }),
  fc.record({ kind: fc.constant('trash' as const), object: objectIndex, pick }),
  fc.record({ kind: fc.constant('untrash' as const), object: objectIndex, pick }),
);
const historyArb = fc.array(stepArb, { minLength: 1, maxLength: 8 });
/** A selection: the objects picked, at least one, never every one. */
const selectionArb = fc
  .subarray(OBJECTS, { minLength: 1, maxLength: OBJECTS.length - 1 })
  .map((objects) => [...objects]);

const nth = <T>(rows: readonly T[], n: number): T | undefined =>
  rows.length === 0 ? undefined : rows[n % rows.length];

/** Do `history` as a colleague, a second a step: what the org would refuse is not done. */
function apply(org: RewindTestOrg, history: readonly Step[]): void {
  let made = 500;
  history.forEach((step, at) => {
    clock.now = SINCE + at * 1_000;
    const objectApiName = OBJECTS[step.object];
    switch (step.kind) {
      case 'edit': {
        const row = nth(org.all(objectApiName), step.pick);
        if (!row) return;
        const value = `Since ${step.value}`;
        const field =
          objectApiName === 'Contact'
            ? { LastName: value }
            : objectApiName === 'OpportunityLineItem'
              ? { Quantity: step.value + 2 }
              : { Name: value };
        org.edit(objectApiName, row.Id, field, COLLEAGUE);
        return;
      }
      case 'move': {
        const row = nth(org.all(objectApiName), step.pick);
        if (!row) return;
        if (objectApiName === 'Contact' && step.to % 2 === 1) {
          const to = nth(
            org.all('Contact').filter((each) => each.Id !== row.Id),
            step.to,
          );
          org.edit('Contact', row.Id, { ReportsToId: to?.Id ?? null }, COLLEAGUE);
          return;
        }
        if (objectApiName === 'Contact' || objectApiName === 'Opportunity') {
          const to = nth(org.all('Account'), step.to);
          if (to) org.edit(objectApiName, row.Id, { AccountId: to.Id }, COLLEAGUE);
        }
        return;
      }
      case 'create': {
        const n = ++made;
        if (objectApiName === 'Account') {
          org.add('Account', { Id: account(n), Name: `New ${n}`, LastModifiedById: COLLEAGUE });
          return;
        }
        if (objectApiName === 'OpportunityLineItem') {
          const deal = nth(org.all('Opportunity'), step.parent);
          if (deal) {
            org.add('OpportunityLineItem', {
              Id: line(n),
              Quantity: 1,
              OpportunityId: deal.Id,
              LastModifiedById: COLLEAGUE,
            });
          }
          return;
        }
        const parent = nth(org.all('Account'), step.parent);
        if (!parent) return;
        org.add(
          objectApiName,
          objectApiName === 'Contact'
            ? {
                Id: contact(n),
                LastName: `New ${n}`,
                AccountId: parent.Id,
                LastModifiedById: COLLEAGUE,
              }
            : {
                Id: opportunity(n),
                Name: `New ${n}`,
                AccountId: parent.Id,
                Pricebook2Id: book(1),
                LastModifiedById: COLLEAGUE,
              },
        );
        return;
      }
      case 'trash': {
        const row = nth(org.all(objectApiName), step.pick);
        if (row) org.trash(objectApiName, row.Id, COLLEAGUE);
        return;
      }
      case 'untrash': {
        const row = nth(org.inBin(objectApiName), step.pick);
        if (!row) return;
        try {
          org.untrash(row.Id, COLLEAGUE);
        } catch {
          // The org refused it: it stays in the bin.
        }
        return;
      }
    }
  });
}

/** The checkpoint, then `history` done since. */
async function since(history: readonly Step[]): Promise<Taken> {
  const t = await taken(atCheckpoint, orgOf(), OBJECTS);
  apply(t.org, history);
  clock.now = Math.max(clock.now, SINCE + 60_000);
  return t;
}

/**
 * The org as the checkpoint keeps it: every field it compares, live, and the
 * ids in the bin — a record made again, and a lookup to one, by the Id the
 * checkpoint holds it by.
 */
function keptOf(t: Taken): Record<string, unknown> {
  const { org, checkpoint } = t;
  const recreated = recreatedOf(t.folder);
  const held = (value: unknown): unknown =>
    typeof value === 'string' ? (recreated.get(value) ?? value) : value;
  const state: Record<string, unknown> = {};
  for (const object of checkpoint.objects) {
    const fields = comparedFields(object.objectApiName, object.fields, checkpoint.ignoredFields);
    state[`${object.objectApiName}.live`] = org
      .all(object.objectApiName)
      .map((row) =>
        Object.fromEntries([
          ['Id', held(row.Id)],
          ...fields.map((field) => [field, held(row[field] ?? null)]),
        ]),
      )
      .sort((a, b) => String(a.Id).localeCompare(String(b.Id)));
    state[`${object.objectApiName}.bin`] = org
      .inBin(object.objectApiName)
      .map((row) => String(held(row.Id)))
      .sort();
  }
  return state;
}

/**
 * The rewind of `t` limited to `objects` (every object when undefined),
 * accepting what Undo cannot bring back and new Ids for what the bin no
 * longer gives back.
 */
async function rewindOf(
  t: Taken,
  objects: readonly string[] | undefined,
  acceptOutside = false,
): Promise<{ diff: RewindDiff; result: ReturnType<typeof resultOf> }> {
  const diff = await previewed(t);
  const result = resultOf(
    await rewound(t, diff.previewId, {
      request: {
        acceptNoUndo: true,
        acceptRecreate: true,
        acceptOutside,
        ...(objects !== undefined ? { objects: [...objects] } : {}),
      },
    }),
  );
  return { diff, result };
}

const SEED = 1_792_700_311;
const RUNS = process.platform === 'win32' ? 3 : 12;

describe('a rewind limited to some objects, over random histories and selections', () => {
  it(
    'writes nothing outside the objects picked but what came back with a record it brought back, as its journal says',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          historyArb,
          selectionArb,
          fc.boolean(),
          async (history, objects, outside) => {
            const t = await since(history);
            const { result } = await rewindOf(t, objects, outside);
            if (result.undo === undefined) return;
            const journal = await readRewindJournal(t.folder, result.rewindId);
            const cameWith = new Set(
              (journal.did.withParents ?? []).flatMap(({ ids }) =>
                ids.map((id) => id.slice(0, 15)),
              ),
            );
            const written = [
              ...journal.did.deleted,
              ...journal.did.givenBack,
              ...journal.did.broughtBack,
              ...(journal.did.recreated ?? []),
            ];
            const outsideWrites = written
              .filter(({ objectApiName }) => !objects.includes(objectApiName))
              .flatMap(({ objectApiName, ids }) =>
                ids
                  .filter((id) => !cameWith.has(id.slice(0, 15)))
                  .map((id) => `${objectApiName} ${id}`),
              );
            expect(outsideWrites, JSON.stringify({ history, objects })).toEqual([]);
            expect([...(result.scope?.objects ?? [])].sort()).toEqual([...objects].sort());
          },
        ),
        { numRuns: RUNS, seed: SEED, endOnFailure: true },
      );
    },
    paced(120_000),
  );

  it(
    'then rewound whole, leaves the org as a rewind of every object alone leaves it',
    async () => {
      await fc.assert(
        fc.asyncProperty(historyArb, selectionArb, async (history, objects) => {
          const first = await since(history);
          await rewindOf(first, objects);
          await rewindOf(first, undefined);
          const twice = keptOf(first);

          const other = await since(history);
          await rewindOf(other, undefined);
          expect(twice, JSON.stringify({ history, objects })).toEqual(keptOf(other));
        }),
        { numRuns: RUNS, seed: SEED, endOnFailure: true },
      );
    },
    paced(120_000),
  );

  it(
    'undone, returns the org to how it was before the rewind, live and in the recycle bin',
    async () => {
      await fc.assert(
        fc.asyncProperty(historyArb, selectionArb, async (history, objects) => {
          const t = await since(history);
          const before = keptOf(t);
          const { result } = await rewindOf(t, objects);
          // Nothing written, nothing to undo; what Undo said it could not bring back stays gone.
          if (result.undo === undefined || result.undo.cannot.length > 0) return;
          await undone(t, result.rewindId);
          expect(keptOf(t), JSON.stringify({ history, objects })).toEqual(before);
        }),
        { numRuns: RUNS, seed: SEED, endOnFailure: true },
      );
    },
    paced(120_000),
  );
});

/**
 * The selection's plan as the page would be told it before the rewind, and
 * the plan the rewind made as it began, each made by `plan` from the preview.
 */
async function bothPlans(
  history: readonly Step[],
  objects: readonly string[],
  outside: boolean,
  plan: (t: Taken, diff: RewindDiff) => Promise<RewindSelectionPlan>,
): Promise<{ told: RewindSelectionPlan; made: RewindSelectionPlan | undefined }> {
  const t = await since(history);
  const diff = await previewed(t);
  const told = await plan(t, diff);
  madePlans.length = 0;
  resultOf(
    await rewound(t, diff.previewId, {
      request: {
        acceptNoUndo: true,
        acceptRecreate: true,
        acceptOutside: outside,
        objects: [...objects],
      },
    }),
  );
  const [made] = await Promise.all(madePlans);
  return { told, made };
}

/** The plan of the selection the page is told: the rewind's own, from the preview's folder. */
const told =
  (objects: readonly string[], outside: boolean) =>
  (t: Taken, diff: RewindDiff): Promise<RewindSelectionPlan> =>
    planSelection({
      checkpoint: t.checkpoint,
      previewDir: previewDirOf(t.folder, diff.previewId),
      readAt: diff.readAt,
      objects: new Set(objects),
      acceptOutside: outside,
      heldRows: snapshotRowsOf(t.checkpoint, t.folder),
    });

/** A plan computed apart: the preview's numbers of the objects picked, as a page might count them. */
const apart =
  (objects: readonly string[]) =>
  (_t: Taken, diff: RewindDiff): Promise<RewindSelectionPlan> =>
    Promise.resolve({
      objects: [...objects],
      acts: diff.objects
        .filter((o) => objects.includes(o.objectApiName))
        .map((o) => ({
          objectApiName: o.objectApiName,
          picked: true,
          toDelete:
            o.toDelete.createdSince + o.toDelete.broughtBackSince + o.toDelete.comesBackWithParent,
          toGiveBack: o.toGiveBack.records,
          toBringBack:
            o.toBringBack.inBin + o.toBringBack.withParent + o.toBringBack.deletedWhileTaken,
          toRecreate: o.toRecreate ?? 0,
        }))
        .filter((a) => a.toDelete + a.toGiveBack + a.toBringBack + a.toRecreate > 0),
      left: [],
      needs: [],
      undoCannot: diff.undoCannot.filter((u) => objects.includes(u.objectApiName)),
    });

describe('the plan of a selection the page is told', () => {
  const property = (
    planOf: (
      objects: readonly string[],
      outside: boolean,
    ) => (t: Taken, diff: RewindDiff) => Promise<RewindSelectionPlan>,
  ) =>
    fc.asyncProperty(historyArb, selectionArb, fc.boolean(), async (history, objects, outside) => {
      const { told: said, made } = await bothPlans(
        history,
        objects,
        outside,
        planOf(objects, outside),
      );
      expect(made).toBeDefined();
      expect(said, JSON.stringify({ history, objects, outside })).toEqual(made);
    });

  it(
    'is, count for count, the plan the rewind that follows makes from the same preview',
    async () => {
      await fc.assert(property(told), { numRuns: RUNS, seed: SEED, endOnFailure: true });
    },
    paced(120_000),
  );

  it(
    'catches a plan computed apart from the rewind’s own: it diverges on some history and selection',
    async () => {
      const outcome = await fc.check(
        property((objects) => apart(objects)),
        {
          numRuns: RUNS * 4,
          seed: SEED,
          endOnFailure: true,
        },
      );
      expect(outcome.failed).toBe(true);
    },
    paced(120_000),
  );
});
