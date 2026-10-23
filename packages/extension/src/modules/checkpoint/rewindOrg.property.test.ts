/**
 * Properties of a rewind on the memory org, over random histories of what a
 * colleague did since the checkpoint, held to each hypothesis about the org
 * that the checkpoint's live probes answered or left open (`MemoryOrgFacts`):
 * rewinding twice ends where rewinding once does, an undo returns the org to
 * how it was before the rewind, a rewind stopped at any call and taken up
 * again ends where a whole one does, and one of a single pass sends no more
 * requests than its preview estimated.
 *
 * Each property runs a few histories under each combination of the facts it
 * depends on — the same histories under each, by a fixed seed — and compares
 * the org on every field the checkpoint keeps, live and in the recycle bin.
 * The one hypothesis under which a rewind misses a record, refuted live,
 * is named in a test of its own; under the one an undo cannot always meet,
 * still open, it says what it kept. Where records left the recycle bin, the
 * rewind makes them again under new Ids, and the org is compared with the
 * checkpoint by the Ids the checkpoint holds them by.
 */

import { existsSync, readdirSync } from 'node:fs';

import * as fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paced } from '../../test/runnerPace.js';
import type { OrgCheckpoint, RewindResult } from '@sandforge/shared';

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import {
  factCombinations,
  type MemoryChild,
  type MemoryOrgFacts,
} from '../../test/memoryRemovalOrg.js';
import {
  CALLS,
  COLLEAGUE,
  PERSON_FLAG,
  PRICE_BOOK_HELD,
  SINCE,
  STAMP_FIELDS,
  T0,
  RewindTestOrg,
  account,
  book,
  clock,
  contact,
  id,
  line,
  opportunity,
  previewed,
  recreatedOf,
  removeTaken,
  request,
  resultOf,
  rewound,
  spent,
  stoppedAfter,
  taken,
  undone,
  writable,
  type Taken,
} from '../../test/rewindTestOrg.js';
import { comparedFields } from './checkpointFields.js';
import { previewCheckpoint } from './previewCheckpoint.js';
import { relationshipsOf, rewindEstimate } from './rewindEstimate.js';
import {
  RewindStopped,
  type RewindDeps,
  type RewindOutcome,
  type RewindRequest,
} from './rewindOrg.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  clock.now = T0;
});

afterEach(() => {
  removeTaken();
  vi.mocked(getJsforceConnection).mockReset();
});

// ─── The org ─────────────────────────────────────────────────────────────────

/** Accounts, person accounts among them; contacts reporting to contacts; deals, their products and lines. */
const FIELDS: Record<string, unknown[]> = {
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
    writable('ReportsToId', 'reference', { referenceTo: ['Contact'] }),
    PERSON_FLAG,
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
  // Lines of a deal, which come back from the recycle bin on their own.
  Line__c: [
    ...STAMP_FIELDS,
    writable('Units__c', 'double'),
    writable('Deal__c', 'reference', { referenceTo: ['Opportunity'] }),
  ],
};

const CHILDREN: Record<string, MemoryChild[]> = {
  Account: [
    { childSObject: 'Contact', field: 'AccountId', cascadeDelete: true },
    { childSObject: 'Opportunity', field: 'AccountId', cascadeDelete: true },
  ],
  // A lookup the org clears when the contact it names is deleted.
  Contact: [{ childSObject: 'Contact', field: 'ReportsToId' }],
  Opportunity: [
    { childSObject: 'OpportunityLineItem', field: 'OpportunityId', cascadeDelete: true },
    { childSObject: 'Line__c', field: 'Deal__c', cascadeDelete: true },
  ],
};

const OBJECTS = ['Account', 'Contact', 'Opportunity', 'OpportunityLineItem', 'Line__c'];

const lineOf = (n: number): string => id('a0l', n);
const caseOf = (n: number): string => id('500', n);

/**
 * Cases, in an org whose account lookup of a case restricts the account's
 * delete rather than taking the case along, as seen live: a rewind deletes
 * such a case before its account, which then keeps it in the recycle bin for
 * good. Held by the checkpoint of a property that says so, beside the others.
 */
const CASE_FIELDS: Record<string, unknown[]> = {
  ...FIELDS,
  Case: [
    ...STAMP_FIELDS,
    writable('Subject'),
    writable('AccountId', 'reference', { referenceTo: ['Account'] }),
  ],
};
const CASE_CHILDREN: Record<string, MemoryChild[]> = {
  ...CHILDREN,
  Account: [
    ...(CHILDREN.Account ?? []),
    { childSObject: 'Case', field: 'AccountId', restrictedDelete: true },
  ],
};

/** The org: its price book held in place by an opportunity's products and lines, as seen live. */
function orgUnder(facts: MemoryOrgFacts, cases = false): RewindTestOrg {
  const org = new RewindTestOrg({
    facts,
    fields: cases ? CASE_FIELDS : FIELDS,
    children: cases ? CASE_CHILDREN : CHILDREN,
  });
  org.heldByChildren.push(PRICE_BOOK_HELD, {
    ...PRICE_BOOK_HELD,
    childSObject: 'Line__c',
    field: 'Deal__c',
  });
  return org;
}

/** What the org holds long before the checkpoint, one account and its contact in the bin. */
function atCheckpoint(org: RewindTestOrg): void {
  org.add('Account', { Id: account(1), Name: 'One' });
  org.add('Account', { Id: account(2), Name: 'Two' });
  org.add('Account', { Id: account(3), Name: 'Three' });
  org.addPersonAccount(
    { Id: account(9), Name: 'Ada Lovelace', FirstName: 'Ada', LastName: 'Lovelace' },
    contact(9),
  );
  org.add('Contact', { Id: contact(1), LastName: 'One', AccountId: account(1) });
  org.add('Contact', {
    Id: contact(2),
    LastName: 'Two',
    AccountId: account(1),
    ReportsToId: contact(1),
  });
  org.add('Contact', { Id: contact(3), LastName: 'Three', AccountId: account(2) });
  org.add('Contact', {
    Id: contact(4),
    LastName: 'Four',
    AccountId: account(3),
    ReportsToId: contact(3),
  });
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
  org.add('Line__c', { Id: lineOf(1), Units__c: 1, Deal__c: opportunity(1) });
  org.add('OpportunityLineItem', { Id: line(1), Quantity: 1, OpportunityId: opportunity(2) });
  org.add('Account', { Id: account(5), Name: 'Five' });
  org.add('Contact', { Id: contact(5), LastName: 'Five', AccountId: account(5) });
  org.trash('Account', account(5));
}

/** The org as the checkpoint keeps it: every field it compares, live and in the recycle bin. */
interface KeptState {
  live: Record<string, Array<Record<string, unknown>>>;
  bin: Record<string, string[]>;
}

function keptOf(org: RewindTestOrg, checkpoint: OrgCheckpoint): KeptState {
  const state: KeptState = { live: {}, bin: {} };
  for (const object of checkpoint.objects) {
    const fields = comparedFields(object.objectApiName, object.fields, checkpoint.ignoredFields);
    state.live[object.objectApiName] = org
      .all(object.objectApiName)
      .map((row) =>
        Object.fromEntries([['Id', row.Id], ...fields.map((field) => [field, row[field] ?? null])]),
      )
      .sort((a, b) => String(a.Id).localeCompare(String(b.Id)));
    state.bin[object.objectApiName] = org
      .inBin(object.objectApiName)
      .map((row) => row.Id)
      .sort();
  }
  return state;
}

/**
 * `state` as the checkpoint names its records: a record a rewind made again
 * by the Id it had, and every lookup naming one by that Id too.
 */
function asHeldOf(state: KeptState, t: Pick<Taken, 'folder'>): KeptState {
  const recreated = recreatedOf(t.folder);
  if (recreated.size === 0) return state;
  const held = (value: unknown): unknown =>
    typeof value === 'string' ? (recreated.get(value) ?? value) : value;
  return {
    live: Object.fromEntries(
      Object.entries(state.live).map(([objectApiName, rows]) => [
        objectApiName,
        rows
          .map((row) =>
            Object.fromEntries(Object.entries(row).map(([field, value]) => [field, held(value)])),
          )
          .sort((a, b) => String(a.Id).localeCompare(String(b.Id))),
      ]),
    ),
    bin: state.bin,
  };
}

/** The records whose kept fields differ between two states, live. */
function differing(a: KeptState, b: KeptState): string[] {
  const ids: string[] = [];
  for (const objectApiName of Object.keys(a.live)) {
    const before = new Map(a.live[objectApiName].map((row) => [row.Id, JSON.stringify(row)]));
    const after = new Map(
      (b.live[objectApiName] ?? []).map((row) => [row.Id, JSON.stringify(row)]),
    );
    for (const record of new Set([...before.keys(), ...after.keys()])) {
      if (before.get(record) !== after.get(record)) ids.push(String(record));
    }
  }
  return ids.sort();
}

// ─── What a colleague does since the checkpoint ──────────────────────────────

type Step =
  | { kind: 'edit'; object: number; pick: number; value: number }
  | { kind: 'move'; object: number; pick: number; to: number }
  | { kind: 'create'; object: number; parent: number }
  | { kind: 'trash'; object: number; pick: number }
  | { kind: 'untrash'; object: number; pick: number }
  | { kind: 'priceBook'; pick: number }
  | { kind: 'purge'; object: number; pick: number }
  | { kind: 'hardDelete'; object: number; pick: number }
  // Only in an org with cases, never drawn at random.
  | { kind: 'case'; parent: number };

const objectIndex = fc.nat(OBJECTS.length - 1);
const pick = fc.nat(30);

/** Steps of a history, with records gone for good among them when `goneForGood`. */
function stepArb(goneForGood: boolean): fc.Arbitrary<Step> {
  const steps: Array<fc.Arbitrary<Step>> = [
    fc.record({ kind: fc.constant('edit' as const), object: objectIndex, pick, value: fc.nat(9) }),
    fc.record({ kind: fc.constant('move' as const), object: objectIndex, pick, to: pick }),
    fc.record({ kind: fc.constant('create' as const), object: objectIndex, parent: pick }),
    fc.record({ kind: fc.constant('trash' as const), object: objectIndex, pick }),
    fc.record({ kind: fc.constant('untrash' as const), object: objectIndex, pick }),
    fc.record({ kind: fc.constant('priceBook' as const), pick }),
  ];
  if (goneForGood) {
    steps.push(
      fc.record({ kind: fc.constant('purge' as const), object: objectIndex, pick }),
      fc.record({ kind: fc.constant('hardDelete' as const), object: objectIndex, pick }),
    );
  }
  return fc.oneof(...steps);
}

function historyArb(goneForGood = false): fc.Arbitrary<Step[]> {
  return fc.array(stepArb(goneForGood), { minLength: 1, maxLength: 9 });
}

/** One of `rows`, by `n`, or none. */
function nth<T>(rows: readonly T[], n: number): T | undefined {
  return rows.length === 0 ? undefined : rows[n % rows.length];
}

/** The records a step may act on: never a person account's contact, which goes with its account. */
function workable(
  org: RewindTestOrg,
  objectApiName: string,
): Array<Record<string, unknown> & { Id: string }> {
  return org
    .all(objectApiName)
    .filter((row) => row.IsPersonAccount !== true || objectApiName === 'Account');
}

/** Whether the org refuses a deal's price book now: a product or a line names it. */
function priceBookHeld(org: RewindTestOrg, deal: string): boolean {
  return [
    ...org.all('OpportunityLineItem').map((row) => row.OpportunityId),
    ...org.all('Line__c').map((row) => row.Deal__c),
  ].some((value) => typeof value === 'string' && value.slice(0, 15) === deal.slice(0, 15));
}

/**
 * Do `history` in the org as a colleague, a second a step from SINCE: each
 * step the org would refuse — bringing back a record it holds in the bin
 * only with its parent, a price book a product holds — is not done.
 */
function apply(org: RewindTestOrg, history: readonly Step[], made: { next: number }): void {
  history.forEach((step, at) => {
    clock.now = SINCE + at * 1_000;
    const objectApiName = OBJECTS['object' in step ? step.object : 2];
    switch (step.kind) {
      case 'edit': {
        const row = nth(workable(org, objectApiName), step.pick);
        if (!row) return;
        const value = `Since ${step.value}`;
        const values: Record<string, unknown> =
          objectApiName === 'Account'
            ? row.IsPersonAccount === true
              ? // The org makes a person account's name of its person's.
                { LastName: value, Name: `${String(row.FirstName)} ${value}` }
              : { Name: value }
            : objectApiName === 'Contact'
              ? { LastName: value }
              : objectApiName === 'Opportunity'
                ? { Name: value }
                : objectApiName === 'Line__c'
                  ? { Units__c: step.value + 2 }
                  : { Quantity: step.value + 2 };
        org.edit(objectApiName, row.Id, values, COLLEAGUE);
        return;
      }
      case 'move': {
        const row = nth(workable(org, objectApiName), step.pick);
        if (!row) return;
        const businesses = org.all('Account').filter((each) => each.IsPersonAccount !== true);
        if (objectApiName === 'Contact') {
          if (step.to % 2 === 0) {
            const to = nth(businesses, step.to);
            if (to) org.edit('Contact', row.Id, { AccountId: to.Id }, COLLEAGUE);
          } else {
            const to = nth(
              workable(org, 'Contact').filter((each) => each.Id !== row.Id),
              step.to,
            );
            org.edit(
              'Contact',
              row.Id,
              { ReportsToId: step.to % 3 === 0 ? null : (to?.Id ?? null) },
              COLLEAGUE,
            );
          }
        } else if (objectApiName === 'Opportunity') {
          const to = nth(businesses, step.to);
          if (to) org.edit('Opportunity', row.Id, { AccountId: to.Id }, COLLEAGUE);
        }
        return;
      }
      case 'create': {
        const n = ++made.next;
        if (objectApiName === 'Account') {
          org.add('Account', { Id: account(n), Name: `New ${n}`, LastModifiedById: COLLEAGUE });
          return;
        }
        if (objectApiName === 'Contact' || objectApiName === 'Opportunity') {
          const parent = nth(
            org.all('Account').filter((each) => each.IsPersonAccount !== true),
            step.parent,
          );
          if (!parent) return;
          if (objectApiName === 'Contact') {
            org.add('Contact', {
              Id: contact(n),
              LastName: `New ${n}`,
              AccountId: parent.Id,
              LastModifiedById: COLLEAGUE,
            });
          } else {
            org.add('Opportunity', {
              Id: opportunity(n),
              Name: `New ${n}`,
              AccountId: parent.Id,
              Pricebook2Id: book(1),
              LastModifiedById: COLLEAGUE,
            });
          }
          return;
        }
        const deal = nth(org.all('Opportunity'), step.parent);
        if (!deal) return;
        if (objectApiName === 'Line__c') {
          org.add('Line__c', {
            Id: lineOf(n),
            Units__c: 1,
            Deal__c: deal.Id,
            LastModifiedById: COLLEAGUE,
          });
        } else {
          org.add('OpportunityLineItem', {
            Id: line(n),
            Quantity: 1,
            OpportunityId: deal.Id,
            LastModifiedById: COLLEAGUE,
          });
        }
        return;
      }
      case 'trash': {
        const row = nth(workable(org, objectApiName), step.pick);
        if (!row) return;
        // The org refuses an account's delete while a case names it.
        const named = (value: unknown): boolean =>
          typeof value === 'string' && value.slice(0, 15) === row.Id.slice(0, 15);
        if (objectApiName === 'Account' && org.all('Case').some((each) => named(each.AccountId))) {
          return;
        }
        org.trash(objectApiName, row.Id, COLLEAGUE);
        return;
      }
      case 'case': {
        const n = ++made.next;
        const parent = nth(
          org.all('Account').filter((each) => each.IsPersonAccount !== true),
          step.parent,
        );
        if (!parent) return;
        org.add('Case', {
          Id: caseOf(n),
          Subject: `New ${n}`,
          AccountId: parent.Id,
          LastModifiedById: COLLEAGUE,
        });
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
      case 'priceBook': {
        const deal = nth(org.all('Opportunity'), step.pick);
        if (!deal || priceBookHeld(org, deal.Id)) return;
        const next = deal.Pricebook2Id === book(1) ? book(2) : book(1);
        org.edit('Opportunity', deal.Id, { Pricebook2Id: next }, COLLEAGUE);
        return;
      }
      case 'purge': {
        const row = nth(org.inBin(objectApiName), step.pick);
        if (row) org.purge(row.Id);
        return;
      }
      case 'hardDelete': {
        const row = nth(workable(org, objectApiName), step.pick);
        if (row) org.hardDelete(objectApiName, row.Id, COLLEAGUE);
        return;
      }
    }
  });
}

/** A checkpoint taken, and the org as it keeps it. */
interface Since extends Taken {
  kept: KeptState;
  /** Each person account's contact, by its account: named through it, never on its own. */
  personOf: Map<string, string>;
}

/** The checkpoint taken under `facts`, of the org with cases when told, then `history` done since. */
async function since(
  facts: MemoryOrgFacts,
  history: readonly Step[],
  cases = false,
): Promise<Since> {
  const t = await taken(
    atCheckpoint,
    orgUnder(facts, cases),
    cases ? [...OBJECTS, 'Case'] : OBJECTS,
  );
  const kept = keptOf(t.org, t.checkpoint);
  const personOf = new Map(
    t.org
      .all('Contact')
      .filter((row) => row.IsPersonAccount === true)
      .map((row) => [row.Id, String(row.AccountId)]),
  );
  apply(t.org, history, { next: 500 });
  return { ...t, kept, personOf };
}

/**
 * Every record that differs from the checkpoint once rewound is named in
 * `residual` — a person account's contact through its account.
 */
function expectNamed(
  t: Since,
  residual: ReadonlyArray<{ ids: readonly string[] }>,
  message: string,
): void {
  const named = new Set(residual.flatMap(({ ids }) => ids));
  for (const record of differing(t.kept, asHeldOf(keptOf(t.org, t.checkpoint), t))) {
    const through = t.personOf.get(record) ?? record;
    expect({ message, record, named: named.has(through) }).toEqual({
      message,
      record,
      named: true,
    });
  }
}

/** A rewind of `t` accepting what Undo could not bring back, acting on a preview read now. */
async function rewindNow(
  t: Taken,
  deps: Partial<RewindDeps> = {},
  request: Partial<RewindRequest> = {},
): Promise<RewindOutcome> {
  const diff = await previewed(t);
  return rewound(t, diff.previewId, { deps, request: { acceptNoUndo: true, ...request } });
}

/** A rewind of `t` accepting too that what left the recycle bin is made again with new Ids. */
async function rewindMaking(t: Taken): Promise<RewindOutcome> {
  return rewindNow(t, {}, { acceptRecreate: true });
}

/** The facts and the history, said beside an assertion that fails. */
function said(
  facts: MemoryOrgFacts,
  history: readonly Step[],
  extra: Record<string, unknown> = {},
): string {
  const off = Object.entries(facts)
    .filter(([name, value]) => value !== FACT_DEFAULTS[name as keyof MemoryOrgFacts])
    .map(([name]) => name);
  return JSON.stringify({ off, history, ...extra });
}

/** The facts as the live probes saw them, beside which a message names those switched. */
const FACT_DEFAULTS = factCombinations([])[0];

/** A fixed seed: each property's histories are the same under each combination of facts. */
const SEED = 1_792_700_234;

/** Histories a property runs under each combination of facts. */
const RUNS = 3;

// ─── The properties ──────────────────────────────────────────────────────────

describe('a rewind on the memory org, over random histories since the checkpoint', () => {
  it(
    'converges, or names every record that still differs; rewound again, the org stays as the first rewind left it; and it sends no more requests than its preview estimated',
    async () => {
      for (const facts of factCombinations([
        'undeleterIsLastModifier',
        'clearedLookupRestamps',
        'childDeletedAloneStays',
        'undeleteRestoresLookups',
      ])) {
        await fc.assert(
          fc.asyncProperty(historyArb(), async (history) => {
            const t = await since(facts, history);
            clock.now = Math.max(clock.now, SINCE + 60_000);
            const preview = await previewCheckpoint({ org: t.org, store: t.store }, request(t));
            if (!preview.previewed) throw new Error(preview.refusal.message);
            const asked = spent(t.org);
            const first = resultOf(
              await rewound(t, preview.diff.previewId, { request: { acceptNoUndo: true } }),
            );
            const message = said(facts, history, { status: first.status, passes: first.passes });
            // A second pass that sends again what the org refused the first is
            // not foreseen: the estimate holds a rewind of one pass.
            if (first.passes === 1) {
              expect(spent(t.org) - asked, message).toBeLessThanOrEqual(
                preview.estimate.apiRequests,
              );
            }
            expect(first.status, message).not.toBe('unstable');
            const once = keptOf(t.org, t.checkpoint);
            expectNamed(t, first.residual, message);

            const second = resultOf(await rewindNow(t));
            expect(keptOf(t.org, t.checkpoint), message).toEqual(once);
            expect(second.status === 'success', message).toBe(first.status === 'success');
          }),
          { numRuns: RUNS, seed: SEED, endOnFailure: true },
        );
      }
    },
    paced(120_000),
  );

  it(
    'undone, returns the org to how it was before the rewind, live and in the recycle bin, but for the records it said Undo could not bring back',
    async () => {
      for (const facts of factCombinations([
        'childDeletedAloneStays',
        'undeleteRestoresLookups',
        'parentsDeletedFirst',
        'childDeletedAloneThenParentLimbo',
      ])) {
        await fc.assert(
          fc.asyncProperty(historyArb(), async (history) => {
            await undoneAfter(facts, history, 'exactly');
          }),
          { numRuns: RUNS, seed: SEED, endOnFailure: true },
        );
      }
    },
    paced(120_000),
  );

  it(
    'undone, after a family made since — an account, its contact, its deal and the deal’s line — returns that family as it was before the rewind, whether the org keeps for good in the bin a record deleted alone before its parent or not, and the rest of the org, or says each record it kept and why',
    async () => {
      // Made a second apart from SINCE, numbered from 501: the account, then
      // under it the contact and the deal, then the deal's line.
      const family: Step[] = [
        { kind: 'create', object: 0, parent: 0 },
        { kind: 'create', object: 1, parent: 3 },
        { kind: 'create', object: 2, parent: 3 },
        { kind: 'create', object: 4, parent: 2 },
      ];
      const made = [account(501), contact(502), opportunity(503), lineOf(504)];
      for (const facts of factCombinations([
        'childDeletedAloneThenParentLimbo',
        'childDeletedAloneStays',
      ])) {
        await fc.assert(
          fc.asyncProperty(historyArb(), async (history) => {
            await undoneAfter(facts, [...family, ...history], 'orSaysWhy', made);
          }),
          { numRuns: RUNS, seed: SEED, endOnFailure: true },
        );
      }
    },
    paced(120_000),
  );

  it(
    'undone, after a family made since whose account a case made since names through a lookup that restricts the account’s delete, returns the family as it was before the rewind, and the case too where the org lets it come back; where the org keeps it in the bin for good, the rewind said Undo could not bring it back, as deleted before its account (F41, live)',
    async () => {
      // The family as above, then a case under its account, numbered 505.
      const family: Step[] = [
        { kind: 'create', object: 0, parent: 0 },
        { kind: 'create', object: 1, parent: 3 },
        { kind: 'create', object: 2, parent: 3 },
        { kind: 'create', object: 4, parent: 2 },
        { kind: 'case', parent: 3 },
      ];
      const made = [account(501), contact(502), opportunity(503), lineOf(504)];
      for (const facts of factCombinations([
        'childDeletedAloneThenParentLimbo',
        'childDeletedAloneStays',
      ])) {
        await fc.assert(
          fc.asyncProperty(historyArb(), async (history) => {
            const limbo = facts.childDeletedAloneThenParentLimbo;
            const result = await undoneAfter(
              facts,
              [...family, ...history],
              'orSaysWhy',
              limbo ? made : [...made, caseOf(505)],
              true,
            );
            expect({ facts: said(facts, history), cannot: result?.undo?.cannot }).toEqual({
              facts: said(facts, history),
              cannot: expect.arrayContaining([
                { objectApiName: 'Case', count: 1, reason: 'deletedBeforeParent' },
              ]) as unknown,
            });
          }),
          { numRuns: RUNS, seed: SEED, endOnFailure: true },
        );
      }
    },
    paced(120_000),
  );

  it(
    'undone, where a colleague brought back on its own a child its parent’s delete took along — an open hypothesis — returns the org, or says each record it kept and why',
    async () => {
      for (const facts of factCombinations(['childDeletedAloneStays']).map((each) => ({
        ...each,
        cascadeChildComesBackAlone: true,
      }))) {
        await fc.assert(
          fc.asyncProperty(historyArb(), async (history) => {
            await undoneAfter(facts, history, 'orSaysWhy');
          }),
          { numRuns: RUNS, seed: SEED, endOnFailure: true },
        );
      }
    },
    paced(120_000),
  );

  it(
    'stopped at any of its calls, then rewound again, ends where a whole rewind ends, on one journal, deleting no record twice, and its undo returns the org to how it was before the first pass',
    async () => {
      for (const facts of factCombinations(['undeleterIsLastModifier', 'clearedLookupRestamps'])) {
        await fc.assert(
          fc.asyncProperty(
            historyArb(),
            fc.double({ min: 0, max: 1, noNaN: true }),
            async (history, at) => {
              // How a whole rewind of the history ends, and how many calls it sends.
              const whole = await since(facts, history);
              const counting = new AbortController();
              let calls = 0;
              const counted = new Proxy(whole.org, {
                get(target, property) {
                  const value: unknown = Reflect.get(target, property, target);
                  if (typeof value !== 'function') return value;
                  const call = value as (...args: unknown[]) => unknown;
                  return (...args: unknown[]) => {
                    if (typeof property === 'string' && CALLS.has(property)) calls++;
                    return call.apply(target, args);
                  };
                },
              });
              resultOf(
                await rewindNow(whole, {
                  org: counted,
                  undelete: (ids) => counted.undelete(ids),
                  signal: counting.signal,
                }),
              );
              const ended = keptOf(whole.org, whole.checkpoint);

              const t = await since(facts, history);
              const before = keptOf(t.org, t.checkpoint);
              const stopAt = 1 + Math.floor(at * calls);
              const message = said(facts, history, { stopAt, calls });
              const controller = new AbortController();
              const stopping = stoppedAfter(t.org, stopAt, controller);
              try {
                await rewindNow(t, {
                  org: stopping,
                  undelete: (ids) => stopping.undelete(ids),
                  signal: controller.signal,
                });
              } catch (err: unknown) {
                expect(err, message).toBeInstanceOf(RewindStopped);
              }
              const again = resultOf(await rewindNow(t));

              expect(keptOf(t.org, t.checkpoint), message).toEqual(ended);
              const journals = existsSync(t.folder.rewindsDir)
                ? readdirSync(t.folder.rewindsDir)
                : [];
              expect(journals, message).toEqual(again.undo === undefined ? [] : [again.rewindId]);
              const deleted = t.org.deletes.flatMap(({ ids }) => ids);
              expect(new Set(deleted).size, message).toBe(deleted.length);
              if (again.undo === undefined) return;
              const undo = await undone(t, again.rewindId);
              const cannot = new Set(again.undo.cannot.map(({ objectApiName }) => objectApiName));
              const after = keptOf(t.org, t.checkpoint);
              for (const objectApiName of Object.keys(before.live)) {
                if (cannot.has(objectApiName)) continue;
                expect({
                  message,
                  objectApiName,
                  live: after.live[objectApiName],
                  bin: after.bin[objectApiName],
                }).toEqual({
                  message,
                  objectApiName,
                  live: before.live[objectApiName],
                  bin: before.bin[objectApiName],
                });
              }
              expect({ message, residual: undo.residual }).toEqual({ message, residual: [] });
            },
          ),
          { numRuns: RUNS, seed: SEED, endOnFailure: true },
        );
      }
    },
    paced(120_000),
  );

  it(
    'with records gone for good — emptied from the bin, or hard-deleted whether or not the bin still shows them — makes them again under new Ids, the org then the checkpoint’s by its Ids or each record that differs named; rewound again it ends where it ended, and its undo deletes what it made and returns the org',
    async () => {
      // Every history starts with a contact deleted, then emptied from the
      // bin — the second of the bin's contacts, the first there since the
      // checkpoint — and a deal hard-deleted: each run makes records again.
      const gone: Step[] = [
        { kind: 'trash', object: 1, pick: 3 },
        { kind: 'purge', object: 1, pick: 1 },
        { kind: 'hardDelete', object: 2, pick: 1 },
      ];
      for (const facts of factCombinations(['hardDeleteInQueryAll', 'clearedLookupRestamps'])) {
        await fc.assert(
          fc.asyncProperty(historyArb(true), async (random) => {
            const history = [...gone, ...random];
            const t = await since(facts, history);
            const before = keptOf(t.org, t.checkpoint);
            expect(await rewindNow(t), said(facts, history)).toMatchObject({
              rewound: false,
              refusal: { code: 'RECREATE' },
            });
            expect(keptOf(t.org, t.checkpoint), said(facts, history)).toEqual(before);
            const first = resultOf(await rewindMaking(t));
            const message = said(facts, history, { status: first.status });
            expect(
              (first.recreated ?? []).reduce((sum, object) => sum + object.created, 0),
              message,
            ).toBeGreaterThan(0);
            const once = keptOf(t.org, t.checkpoint);
            expectNamed(t, first.residual, message);
            const second = resultOf(await rewindMaking(t));
            expect(keptOf(t.org, t.checkpoint), message).toEqual(once);
            expect(second.recreated ?? [], message).toEqual(
              (second.recreated ?? []).filter((object) => object.created === 0),
            );
            if (first.undo === undefined) return;
            await undone(t, first.rewindId);
            const after = keptOf(t.org, t.checkpoint);
            const cannot = new Set(first.undo.cannot.map(({ objectApiName }) => objectApiName));
            for (const objectApiName of Object.keys(before.live)) {
              if (cannot.has(objectApiName)) continue;
              expect({ message, objectApiName, live: after.live[objectApiName] }).toEqual({
                message,
                objectApiName,
                live: before.live[objectApiName],
              });
            }
          }),
          { numRuns: RUNS, seed: SEED, endOnFailure: true },
        );
      }
    },
    paced(120_000),
  );
});

describe('what a rewind sends, at scale, against what its preview estimated', () => {
  /**
   * The checkpoint taken, `build` done before it and `since` after, then the
   * preview and the rewind, from the command line's diff when `reuses`: what
   * the rewind sent, and what the preview estimated, or the command line's
   * estimate from that diff and the relationships the org describes.
   */
  async function sent(
    build: (org: RewindTestOrg) => void,
    since: (org: RewindTestOrg) => void,
    reuses = false,
  ): Promise<{ used: number; estimate: number; passes: number }> {
    const t = await taken(
      (org) => {
        atCheckpoint(org);
        build(org);
      },
      orgUnder({ ...FACT_DEFAULTS }),
      OBJECTS,
    );
    clock.now = SINCE;
    since(t.org);
    clock.now = SINCE + 60_000;
    const preview = await previewCheckpoint({ org: t.org, store: t.store }, request(t));
    if (!preview.previewed) throw new Error(preview.refusal.message);
    let estimate = preview.estimate.apiRequests;
    if (reuses) {
      const inCheckpoint = new Set(OBJECTS.map((name) => name.toLowerCase()));
      const relationships = new Map(
        await Promise.all(
          OBJECTS.map(
            async (name) =>
              [name, relationshipsOf(await t.org.describe(name), { inCheckpoint })] as const,
          ),
        ),
      );
      estimate = rewindEstimate({
        objects: t.checkpoint.objects,
        diff: preview.diff,
        automationRequests: 0,
        relationships,
        reusesPreview: true,
      }).apiRequests;
    }
    const asked = spent(t.org);
    const result = resultOf(
      await rewound(t, preview.diff.previewId, {
        request: { acceptNoUndo: true, ...(reuses ? { reusesPreview: preview.diff } : {}) },
      }),
    );
    expect(result.status).toBe('success');
    expect(result.apiRequests.used).toBe(spent(t.org) - asked);
    return { used: result.apiRequests.used, estimate, passes: result.passes };
  }

  const many = 2_500;

  it(
    'sends exactly what it estimated for thousands of records created since, a page of 2,000 at a time asked again whether anything points through each relationship',
    async () => {
      const { used, estimate } = await sent(
        () => undefined,
        (org) => {
          for (let n = 0; n < many; n++) {
            org.add('Account', { Id: account(1_000 + n), Name: `New ${n}` });
            org.add('Contact', {
              Id: contact(1_000 + n),
              LastName: `New ${n}`,
              AccountId: account(1_000 + n),
            });
          }
        },
      );
      expect(used).toBe(estimate);
    },
    paced(60_000),
  );

  it(
    'sends no more than it estimated for thousands of records holding values in place, kept first and given back once their lines are gone: but for the call the estimate allows for some given back before',
    async () => {
      const { used, estimate } = await sent(
        (org) => {
          for (let n = 0; n < many; n++) {
            org.add('Opportunity', {
              Id: opportunity(1_000 + n),
              Name: `Deal ${n}`,
              AccountId: account(1),
              Pricebook2Id: book(1),
            });
          }
        },
        (org) => {
          for (let n = 0; n < many; n++) {
            org.edit('Opportunity', opportunity(1_000 + n), { Pricebook2Id: book(2) }, COLLEAGUE);
            org.add('Line__c', {
              Id: lineOf(1_000 + n),
              Units__c: 1,
              Deal__c: opportunity(1_000 + n),
            });
          }
        },
      );
      // Each waited for its line: none was given back before the deletes, and
      // the call the estimate allows for those — its clock and user, a read, an
      // update and a stamps read — was not sent.
      expect(estimate - used).toBe(2 + 1 + 1 + 1);
    },
    paced(60_000),
  );

  it(
    'sends no more than it estimated for thousands of records brought back and given back, from the panel or from the command line’s diff',
    async () => {
      const build = (org: RewindTestOrg): void => {
        for (let n = 0; n < many; n++) {
          org.add('Account', { Id: account(1_000 + n), Name: `Many ${n}` });
          org.add('Contact', {
            Id: contact(1_000 + n),
            LastName: `Alone ${n}`,
            AccountId: account(1_000 + n),
          });
        }
      };
      const changed = (org: RewindTestOrg): void => {
        for (let n = 0; n < many; n++) {
          org.edit('Account', account(1_000 + n), { Name: `Renamed ${n}` }, COLLEAGUE);
          org.trash('Contact', contact(1_000 + n), COLLEAGUE);
        }
      };
      for (const reuses of [false, true]) {
        const { used, estimate } = await sent(build, changed, reuses);
        expect({ reuses, fits: used <= estimate }).toEqual({ reuses, fits: true });
      }
    },
    paced(90_000),
  );

  it('sends no more than it estimated when records come back with their parent, which a second pass deletes', async () => {
    const { used, estimate, passes } = await sent(
      () => undefined,
      (org) => {
        org.add('Contact', { Id: contact(600), LastName: 'Made since', AccountId: account(2) });
        org.trash('Account', account(2), COLLEAGUE);
      },
    );
    expect(passes).toBe(2);
    expect(used).toBeLessThanOrEqual(estimate);
  });
});

describe('a rewind on the memory org, under the one hypothesis that breaks it', () => {
  /*
   * A delete that left its stamps, which the live probes refuted (F2): the
   * reads of what changed since find nothing deleted, and the records the
   * snapshot holds that the org no longer shows read as gone for good.
   */
  const unstamped = { ...FACT_DEFAULTS, deleteStamps: false };

  it('reads a record deleted since as gone from the bin, though the bin holds it, and makes it again under a new Id, the one in the bin left there', async () => {
    const t = await since(unstamped, [{ kind: 'trash', object: 2, pick: 0 }]);

    expect(await rewindNow(t)).toMatchObject({
      rewound: false,
      refusal: { code: 'RECREATE' },
    });
    const result = resultOf(await rewindMaking(t));

    expect(result.recreated).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ objectApiName: 'Opportunity', created: 1, refused: 0 }),
      ]),
    );
    expect(t.org.inBin('Opportunity').map((row) => row.Id)).toContain(opportunity(1));
    expect(t.org.all('Opportunity').map((row) => row.Name)).toContain('Deal one');
  });

  it('leaves emptied, and unnamed, a lookup such a delete emptied without a stamp', async () => {
    // Contact Four reports to Three; Three is deleted, and Four's lookup emptied, unstamped.
    const t = await since({ ...unstamped, clearedLookupRestamps: false }, [
      { kind: 'trash', object: 1, pick: 2 },
    ]);

    const result = resultOf(await rewindMaking(t));

    expect(t.org.all('Contact').find((row) => row.Id === contact(4))?.ReportsToId).toBeNull();
    expect(result.residual.flatMap(({ ids }) => ids)).not.toContain(contact(4));
  });
});

/** A record as `state` holds it: its kept fields when live, `bin` when in the recycle bin, or none. */
function recordIn(state: KeptState, id: string): unknown {
  for (const [objectApiName, rows] of Object.entries(state.live)) {
    const row = rows.find((each) => each.Id === id);
    if (row) return { objectApiName, row };
  }
  for (const [objectApiName, ids] of Object.entries(state.bin)) {
    if (ids.includes(id)) return { objectApiName, bin: id };
  }
  return undefined;
}

/**
 * Rewind `history` under `facts`, undo it, and hold the org to how it was
 * before the rewind: `exactly`, but for the objects whose records the
 * rewind said Undo could not bring back; or, `orSaysWhy`, each object that
 * differs counted by the undo among what it kept, left or could not bring
 * back. The records of `exact` are held to how they were whatever else.
 */
async function undoneAfter(
  facts: MemoryOrgFacts,
  history: readonly Step[],
  hold: 'exactly' | 'orSaysWhy',
  exact: readonly string[] = [],
  cases = false,
): Promise<RewindResult> {
  const t = await since(facts, history, cases);
  const before = keptOf(t.org, t.checkpoint);
  const result = resultOf(await rewindNow(t));
  const message = said(facts, history, { status: result.status });
  if (result.undo === undefined) {
    expect(keptOf(t.org, t.checkpoint), message).toEqual(before);
    return result;
  }
  const undo = await undone(t, result.rewindId);
  const after = keptOf(t.org, t.checkpoint);
  for (const record of exact) {
    expect({ message, record, state: recordIn(after, record) }).toEqual({
      message,
      record,
      state: recordIn(before, record),
    });
  }
  const cannot = new Set(result.undo.cannot.map(({ objectApiName }) => objectApiName));
  /** Per object, the records the undo says it kept, left or could not bring back. */
  const counted = new Map<string, number>();
  const add = (objectApiName: string, count: number): void => {
    counted.set(objectApiName, (counted.get(objectApiName) ?? 0) + count);
  };
  for (const object of undo.undeleted)
    add(object.objectApiName, object.refused + object.goneForGood);
  for (const object of undo.restored) {
    add(object.objectApiName, object.refused + object.keptChanged + object.notKept);
  }
  for (const object of undo.deleted) {
    add(object.objectApiName, object.refused + object.keptChanged + object.keptDependents);
  }
  for (const objectApiName of Object.keys(before.live)) {
    if (cannot.has(objectApiName)) continue;
    const same = {
      live: after.live[objectApiName],
      bin: after.bin[objectApiName],
    };
    const was = { live: before.live[objectApiName], bin: before.bin[objectApiName] };
    if (hold === 'orSaysWhy' && (counted.get(objectApiName) ?? 0) > 0) continue;
    expect({ message, objectApiName, ...same }).toEqual({ message, objectApiName, ...was });
    if (hold === 'exactly') {
      expect({ message, objectApiName, left: counted.get(objectApiName) ?? 0 }).toEqual({
        message,
        objectApiName,
        left: 0,
      });
    }
  }
  if (hold === 'exactly') {
    expect({ message, residual: undo.residual }).toEqual({ message, residual: [] });
    if (cannot.size === 0) {
      expect({ message, undo: undo.status }).toEqual({ message, undo: 'success' });
    }
  }
  return result;
}
