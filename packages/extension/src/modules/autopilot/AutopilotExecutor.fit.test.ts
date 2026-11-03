import { describe, it, expect, vi } from 'vitest';
import type { ApiName, AutopilotEdge, ExecutionPlan } from '@sandforge/shared';
import { writeOrderOf } from '../../core/common/insertionOrder.js';
import type { DescribedLookup } from '../../core/metadata/describedLookups.js';
import {
  AutopilotExecutor,
  CUT_WITH_PARENT,
  PARENT_REFUSED,
  type AutopilotRunOptions,
  type ExecutionResult,
} from './AutopilotExecutor.js';
import { RecordIdRemapper } from './RecordIdRemapper.js';
import { autopilotRunStatus } from './autopilotRunStatus.js';
import type { SmartAnonymizer } from './SmartAnonymizer.js';
import type { AutopilotRunFit, FitLink } from './autopilotFit.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * A fit reads the source, a run reads it again: between the two, a contact
 * kept with its account may have moved under an account the fit cut. The
 * remapper would empty its lookup and it would stand without its account —
 * the orphan a fit promises not to make.
 */

/** A fake id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const ACCOUNT_KEPT = id('001', 1);
const ACCOUNT_CUT = id('001', 2);
const CONTACT_KEPT = id('003', 1);
const CONTACT_MOVED = id('003', 2);

/** A plan of one wave per list given. */
function planOf(...waves: string[][]): ExecutionPlan {
  return {
    waves: waves.map((objects, order) => ({
      order,
      objects: objects as ApiName[],
      dependsOn: [],
    })),
  } as unknown as ExecutionPlan;
}

/** The lookup of `to` at `from`. */
const edge = (from: string, to: string, fieldApiName: string, required = false): AutopilotEdge => ({
  from,
  to,
  fieldApiName,
  relationshipType: 'lookup',
  required,
});

const HOLDS_CONTACT: FitLink = {
  objectApiName: 'Contact',
  field: 'AccountId',
  parent: 'Account',
  kind: 'holds',
};
const HOLDS_CASE: FitLink = {
  objectApiName: 'Case',
  field: 'ContactId',
  parent: 'Contact',
  kind: 'holds',
};

/** What a fit of `kept` hands the run, its lists also what the run reads by id. */
const fitOf = (kept: Record<string, string[]>, holds: FitLink[]): AutopilotRunFit => ({
  holds,
  kept: new Map(Object.entries(kept)),
});

/**
 * A run of `plan` over a source holding `rows`, reading `ids` by id; what the
 * target took is in `written`, in the order it took it. A record `refuse` names
 * is refused.
 */
async function run(
  plan: ExecutionPlan,
  edges: AutopilotEdge[],
  rows: Record<string, Array<Record<string, unknown>>>,
  ids: Record<string, string[]>,
  options: AutopilotRunOptions = {},
  extra: {
    refuse?: string;
    describeLookups?: () => Promise<DescribedLookup[]>;
    mapped?: Array<[string, string]>;
  } = {},
): Promise<{
  result: ExecutionResult;
  written: Array<{ object: string; record: Record<string, unknown> }>;
  pagesRead: string[];
  byIdRead: string[];
}> {
  const written: Array<{ object: string; record: Record<string, unknown> }> = [];
  const pagesRead: string[] = [];
  const byIdRead: string[] = [];
  let created = 0;
  const remapper = new RecordIdRemapper();
  remapper.registerMappings('Account', extra.mapped ?? []);
  const executor = new AutopilotExecutor({
    query: async (objectApiName) => {
      pagesRead.push(objectApiName);
      return [];
    },
    queryByIds: async (objectApiName, asked) => {
      byIdRead.push(objectApiName);
      return (rows[objectApiName] ?? [])
        .filter((row) => asked.includes(String(row['Id'])))
        .map((row) => ({ ...row }));
    },
    insert: async (objectApiName, records) =>
      records.map((record) => {
        if (record['Id'] === extra.refuse) {
          return {
            id: '',
            success: false,
            errors: ['refused'],
            details: [{ statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'refused' }],
          };
        }
        written.push({ object: objectApiName, record });
        created++;
        return { id: id('new', created), success: true, errors: [] };
      }),
    update: async (_objectApiName, records) =>
      records.map(() => ({ id: 'x', success: true, errors: [] })),
    anonymizer: { anonymize: (records: unknown[]) => records } as unknown as SmartAnonymizer,
    remapper,
    ...(extra.describeLookups ? { describeLookups: extra.describeLookups } : {}),
  });
  const counts = new Map(Object.entries(ids).map(([name, list]) => [name, list.length]));
  const result = await executor.execute(
    plan,
    edges,
    [],
    counts,
    undefined,
    new Map(Object.entries(ids)),
    { keepContactPoints: true, ...options },
  );
  return { result, written, pagesRead, byIdRead };
}

describe('a record that came to name what the fit cut', () => {
  const plan = planOf(['Account'], ['Contact']);
  const edges = [edge('Account', 'Contact', 'AccountId')];
  const rows = {
    Account: [{ Id: ACCOUNT_KEPT }],
    Contact: [
      { Id: CONTACT_KEPT, AccountId: ACCOUNT_KEPT },
      // Kept under the account kept, and moved under the one cut since.
      { Id: CONTACT_MOVED, AccountId: ACCOUNT_CUT },
    ],
  };
  const ids = { Account: [ACCOUNT_KEPT], Contact: [CONTACT_KEPT, CONTACT_MOVED] };
  const fit = fitOf(ids, [HOLDS_CONTACT]);

  it('stays out with it, counted apart: neither written nor refused, and the run not partial', async () => {
    const { result, written } = await run(plan, edges, rows, ids, { fit });

    expect(written.map((w) => w.record['Id'])).toEqual([ACCOUNT_KEPT, CONTACT_KEPT]);
    expect(result.cutSinceFit).toBe(1);
    expect(result.objectOutcomes?.['Contact']).toMatchObject({
      written: 1,
      failed: 0,
      refusals: [],
      cutSinceFit: 1,
    });
    expect(result.totalFailure).toBe(0);
    expect(result.completedObjects).toContain('Contact');
  });

  it('would stand without its account otherwise', async () => {
    const { result, written } = await run(plan, edges, rows, ids);

    const moved = written.find((w) => w.record['Id'] === CONTACT_MOVED);
    expect(moved?.record['AccountId']).toBeNull();
    expect(result).not.toHaveProperty('cutSinceFit');
  });

  it('takes the records that name it with it: what follows stays out too', async () => {
    const caseId = id('500', 1);
    const withCases = planOf(['Account'], ['Contact'], ['Case']);
    const all = { ...ids, Case: [caseId] };

    const { result, written } = await run(
      withCases,
      [...edges, edge('Contact', 'Case', 'ContactId')],
      { ...rows, Case: [{ Id: caseId, ContactId: CONTACT_MOVED }] },
      all,
      { fit: fitOf(all, [HOLDS_CONTACT, HOLDS_CASE]) },
    );

    expect(written.map((w) => w.object)).not.toContain('Case');
    expect(result.objectOutcomes?.['Case']).toMatchObject({ cutSinceFit: 1, failed: 0 });
    expect(result.cutSinceFit).toBe(2);
  });

  it('keeps out a record whose required parent read by id stayed out, the chain whole', async () => {
    // The licence came to name the account cut: it cannot be written, and the
    // contact that cannot go without it follows it out, as a refusal would
    // have, without the run reading as partial.
    const licence = id('a03', 1);
    const chain = { Account: [ACCOUNT_KEPT], Licence__c: [licence], Contact: [CONTACT_KEPT] };

    const { result, written } = await run(
      planOf(['Account'], ['Licence__c'], ['Contact']),
      [
        edge('Account', 'Licence__c', 'Account__c', true),
        edge('Licence__c', 'Contact', 'Licence__c'),
      ],
      {
        Account: [{ Id: ACCOUNT_KEPT }],
        Licence__c: [{ Id: licence, Account__c: ACCOUNT_CUT }],
        Contact: [{ Id: CONTACT_KEPT, Licence__c: licence }],
      },
      chain,
      {
        fit: fitOf(chain, [
          {
            objectApiName: 'Licence__c',
            field: 'Account__c',
            parent: 'Account',
            kind: 'holds',
          },
          {
            objectApiName: 'Contact',
            field: 'Licence__c',
            parent: 'Licence__c',
            kind: 'holds',
          },
        ]),
      },
    );

    expect(written.map((w) => w.record['Id'])).toEqual([ACCOUNT_KEPT]);
    expect(result.cutSinceFit).toBe(2);
    expect(result.totalFailure).toBe(0);
  });

  it('lets a record through whose parent the target holds, kept by the fit or not', async () => {
    // Matched in the target rather than written, as the standard price book
    // is: the run has an id for it, and the record loses nothing.
    const { result, written } = await run(
      plan,
      edges,
      rows,
      ids,
      { fit },
      { mapped: [[ACCOUNT_CUT, id('001', 900)]] },
    );

    expect(result).not.toHaveProperty('cutSinceFit');
    expect(written.find((w) => w.record['Id'] === CONTACT_MOVED)?.record['AccountId']).toBe(
      id('001', 900),
    );
  });

  it('holds a polymorphic lookup only by an id of the fitted object', async () => {
    const task = id('00T', 1);
    const onAnOpportunity = id('00T', 2);
    const all = { Account: [ACCOUNT_KEPT], Task: [task, onAnOpportunity] };

    const { result, written } = await run(
      planOf(['Account'], ['Task']),
      [edge('Account', 'Task', 'WhatId')],
      {
        Account: [{ Id: ACCOUNT_KEPT }],
        Task: [
          { Id: task, WhatId: ACCOUNT_CUT },
          { Id: onAnOpportunity, WhatId: id('006', 1) },
        ],
      },
      all,
      {
        fit: fitOf(all, [
          {
            objectApiName: 'Task',
            field: 'WhatId',
            parent: 'Account',
            kind: 'holds',
            prefix: '001',
          },
        ]),
      },
    );

    expect(written.map((w) => w.record['Id'])).toEqual([ACCOUNT_KEPT, onAnOpportunity]);
    expect(result.cutSinceFit).toBe(1);
  });

  it('leaves alone a lookup that holds nothing: empty and named by the plan, not a refusal', async () => {
    // The account's key contact, of a cycle: its record was cut by the fit.
    const cycle = planOf(['Account', 'Contact']);
    const all = { Account: [ACCOUNT_KEPT], Contact: [CONTACT_KEPT] };

    const { result, written } = await run(
      cycle,
      [edge('Account', 'Contact', 'AccountId'), edge('Contact', 'Account', 'Primary_Contact__c')],
      {
        Account: [{ Id: ACCOUNT_KEPT, Primary_Contact__c: CONTACT_MOVED }],
        Contact: [{ Id: CONTACT_KEPT, AccountId: ACCOUNT_KEPT }],
      },
      all,
      { fit: fitOf(all, [HOLDS_CONTACT]) },
    );

    expect(written.map((w) => w.record['Id'])).toEqual([ACCOUNT_KEPT, CONTACT_KEPT]);
    expect(written[0].record['Primary_Contact__c']).toBeNull();
    expect(result).not.toHaveProperty('cutSinceFit');
    expect(result.lookups ?? {}).toEqual({});
    expect(result.totalFailure).toBe(0);
  });

  it('says a lookup left empty at a record read that stayed out since the fit, and the run partial', async () => {
    // The account's key contact, kept by the fit, came to name an account the
    // fit cut: it stayed out, and the account written before it kept the
    // lookup empty. Nothing said so, and the run ended a success.
    const cycle = planOf(['Account', 'Contact']);
    const all = { Account: [ACCOUNT_KEPT], Contact: [CONTACT_KEPT, CONTACT_MOVED] };

    const { result, written } = await run(
      cycle,
      [edge('Account', 'Contact', 'AccountId'), edge('Contact', 'Account', 'Primary_Contact__c')],
      {
        Account: [{ Id: ACCOUNT_KEPT, Primary_Contact__c: CONTACT_MOVED }],
        Contact: [
          { Id: CONTACT_KEPT, AccountId: ACCOUNT_KEPT },
          { Id: CONTACT_MOVED, AccountId: ACCOUNT_CUT },
        ],
      },
      all,
      { fit: fitOf(all, [HOLDS_CONTACT]) },
    );

    expect(written.map((w) => w.record['Id'])).toEqual([ACCOUNT_KEPT, CONTACT_KEPT]);
    expect(result.cutSinceFit).toBe(1);
    expect(result.lookups?.['Account']).toEqual({
      filled: 0,
      refusals: [
        {
          statusCode: CUT_WITH_PARENT,
          fields: ['Primary_Contact__c'],
          count: 1,
          message:
            'the Contact record its Primary_Contact__c names stayed out with a record the fit ' +
            'cut, and this record, written before it, keeps its Primary_Contact__c empty.',
        },
      ],
      leftEmpty: 1,
    });
    expect(autopilotRunStatus(result)).toBe('partial');
  });

  it('leaves a parent the target refused to the hold that says so', async () => {
    const { result } = await run(plan, edges, rows, ids, { fit }, { refuse: ACCOUNT_KEPT });

    expect(result.objectOutcomes?.['Contact']?.refusals.map((r) => r.statusCode)).toEqual([
      PARENT_REFUSED,
    ]);
    expect(result.cutSinceFit).toBe(1);
  });
});

describe('how a fitted plan reads its objects', () => {
  it('reads a fitted object by the ids kept, never a page of its table', async () => {
    const accounts = Array.from({ length: 450 }, (_, i) => id('001', i + 1));
    const ids = { Account: accounts };

    const { pagesRead, byIdRead, written } = await run(
      planOf(['Account']),
      [],
      { Account: accounts.map((Id) => ({ Id })) },
      ids,
      { fit: fitOf(ids, []) },
    );

    expect(pagesRead).toEqual([]);
    expect(byIdRead).toEqual(['Account', 'Account', 'Account']);
    expect(written).toHaveLength(450);
  });
});

describe('the order a fit reads the plan in', () => {
  it('is the order the run writes a cycle in, a required lookup first', async () => {
    // Alphabetically Alpha__c goes first, and its lookup at Zeta__c would be
    // filled afterwards; it cannot be written without it, so Zeta__c goes
    // first, and the fit must hold Alpha__c to it rather than Zeta__c to Alpha__c.
    const edges = [
      edge('Zeta__c', 'Alpha__c', 'Zeta__c', true),
      edge('Alpha__c', 'Zeta__c', 'Alpha__c'),
    ];
    const plan = planOf(['Alpha__c', 'Zeta__c']);
    const alpha = id('a01', 1);
    const zeta = id('a02', 1);

    const { written } = await run(
      plan,
      edges,
      {
        Alpha__c: [{ Id: alpha, Zeta__c: zeta }],
        Zeta__c: [{ Id: zeta, Alpha__c: alpha }],
      },
      { Alpha__c: [alpha], Zeta__c: [zeta] },
    );

    const order = writeOrderOf([['Alpha__c', 'Zeta__c']], edges, () => null);
    expect(order).toEqual(['Zeta__c', 'Alpha__c']);
    expect(written.map((w) => w.object)).toEqual(order);
  });

  it('is the order the run takes from what the target says only a create can set', async () => {
    const edges = [edge('Zeta__c', 'Alpha__c', 'Zeta__c'), edge('Alpha__c', 'Zeta__c', 'Alpha__c')];
    const lookups: DescribedLookup[] = [
      { name: 'Zeta__c', referenceTo: ['Zeta__c'], createable: true, updateable: false },
      { name: 'Alpha__c', referenceTo: ['Alpha__c'], createable: true, updateable: true },
    ];
    const alpha = id('a01', 1);
    const zeta = id('a02', 1);

    const { written } = await run(
      planOf(['Alpha__c', 'Zeta__c']),
      edges,
      { Alpha__c: [{ Id: alpha }], Zeta__c: [{ Id: zeta }] },
      { Alpha__c: [alpha], Zeta__c: [zeta] },
      {},
      { describeLookups: async () => lookups },
    );

    const order = writeOrderOf([['Alpha__c', 'Zeta__c']], edges, () => lookups);
    expect(order).toEqual(['Zeta__c', 'Alpha__c']);
    expect(written.map((w) => w.object)).toEqual(order);
  });
});
