import { describe, it, expect } from 'vitest';
import type { ForgeExecutionResult } from '@sandforge/shared';
import {
  createdTargets,
  objectResultsCsv,
  rootCopyOf,
  type ObjectResultRow,
} from './forgeResultsExport';

/** A run: two accounts and a contact created, an account linked to, the standard price book mapped. */
const RUN: Pick<
  ForgeExecutionResult,
  'idRemapTable' | 'idRemapExisting' | 'idRemapCreated' | 'idRemapWithTheirRecord'
> = {
  idRemapTable: {
    '001000000000001AAA': '001000000000101AAA',
    '001000000000002AAA': '001000000000102AAA',
    '003000000000001AAA': '003000000000101AAA',
    '001000000000003AAA': '001000000000103AAA',
    '003000000000002AAA': '003000000000102AAA',
    '01s000000000001AAA': '01s000000000101AAA',
  },
  idRemapExisting: ['001000000000003AAA', '003000000000002AAA'],
  idRemapWithTheirRecord: ['003000000000002AAA'],
  idRemapCreated: [
    { objectApiName: 'Account', sourceIds: ['001000000000001AAA', '001000000000002AAA'] },
    { objectApiName: 'Contact', sourceIds: ['003000000000001AAA'] },
  ],
};

describe('the records a run created, by target id', () => {
  it('names the object of each record the run created, and none it linked to or found', () => {
    expect([...createdTargets(RUN)].sort()).toEqual([
      ['001000000000101AAA', 'Account'],
      ['001000000000102AAA', 'Account'],
      ['003000000000101AAA', 'Contact'],
    ]);
  });
});

describe('the copy of the record the run cloned', () => {
  /** The run above, rooted at the accounts. */
  const ROOTED = {
    ...RUN,
    graph: {
      nodes: [
        { objectApiName: 'Contact', level: 1 },
        { objectApiName: 'Account', level: 0 },
      ],
    },
  } as unknown as Parameters<typeof rootCopyOf>[0];

  it('finds the record asked for, typed with 15 characters or 18', () => {
    const copy = { targetId: '001000000000102AAA', objectApiName: 'Account' };
    expect(rootCopyOf(ROOTED, '001000000000002AAA')).toEqual(copy);
    expect(rootCopyOf(ROOTED, '001000000000002')).toEqual(copy);
  });

  it('takes, for a run from a query, the first record it created of the root object', () => {
    expect(rootCopyOf(ROOTED, undefined)).toEqual({
      targetId: '001000000000101AAA',
      objectApiName: 'Account',
    });
  });

  it('gives the copy its object’s label where discovery’s describe gave the node one', () => {
    const labelled = {
      ...ROOTED,
      graph: {
        nodes: [
          { objectApiName: 'Contact', level: 1 },
          { objectApiName: 'Account', level: 0, label: 'Compte' },
        ],
      },
    } as unknown as Parameters<typeof rootCopyOf>[0];

    expect(rootCopyOf(labelled, '001000000000002AAA')).toEqual({
      targetId: '001000000000102AAA',
      objectApiName: 'Account',
      label: 'Compte',
    });
  });

  it('finds none of a record the target held, which the run linked to', () => {
    expect(rootCopyOf(ROOTED, '001000000000003AAA')).toBeUndefined();
    expect(rootCopyOf({ ...ROOTED, idRemapTable: {} }, '001000000000002AAA')).toBeUndefined();
  });
});

describe('the per-object results as a file', () => {
  const rows: ObjectResultRow[] = [
    { objectApiName: 'Account', records: 3, status: 'done', errors: [] },
    {
      objectApiName: 'Contact',
      records: 4,
      status: 'error',
      errors: ['FIELD_INTEGRITY_EXCEPTION: bad, "quoted"', 'second'],
    },
    { objectApiName: 'Case', records: undefined, status: 'skipped', errors: [] },
    { objectApiName: 'Pricebook2', records: 1, status: 'done', errors: [] },
  ];

  it('writes each object with what the run read, its status code, what it created, linked and failed', () => {
    const lines = objectResultsCsv(rows, {
      idRemapByObject: [
        { objectApiName: 'Account', created: 2, linked: 1 },
        { objectApiName: 'Contact', created: 1, linked: 0 },
      ],
      errors: [
        {
          objectApiName: 'Contact',
          stage: 'insert',
          failedCount: 2,
          attemptedCount: 3,
          samples: [],
        },
        {
          objectApiName: 'Contact',
          stage: 'scope',
          failedCount: 1,
          attemptedCount: 0,
          samples: [],
        },
        // Neither written nor failed, whatever it counts.
        {
          objectApiName: 'Pricebook2',
          stage: 'scope',
          failedCount: 1,
          attemptedCount: 0,
          referenceData: true,
          samples: [],
        },
      ],
    }).split('\n');

    expect(lines).toEqual([
      '"Object","Records read","Status","Created","Linked","Failed","Errors"',
      '"Account","3","done","2","1","0",""',
      '"Contact","4","error","1","0","3","FIELD_INTEGRITY_EXCEPTION: bad, ""quoted""; second"',
      '"Case","","skipped","0","0","0",""',
      '"Pricebook2","1","done","0","0","0",""',
    ]);
  });
});
