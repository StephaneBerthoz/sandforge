import { describe, it, expect } from 'vitest';
import type { ForgeExecutionResult } from '@sandforge/shared';
import {
  createdTargets,
  csvCell,
  idMapCsv,
  idMapRows,
  objectResultsCsv,
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

describe('csvCell', () => {
  it('quotes every value and doubles the quotes in it', () => {
    expect(csvCell('Acme')).toBe('"Acme"');
    expect(csvCell('say "hi", then go')).toBe('"say ""hi"", then go"');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(42)).toBe('"42"');
    expect(csvCell(undefined)).toBe('""');
  });

  it('writes a value a spreadsheet would run as a formula as text', () => {
    expect(csvCell('=HYPERLINK("https://x.example")')).toBe(
      '"\'=HYPERLINK(""https://x.example"")"',
    );
    expect(csvCell('+1')).toBe(`"'+1"`);
    expect(csvCell('-cmd')).toBe(`"'-cmd"`);
    expect(csvCell('@SUM(A1)')).toBe(`"'@SUM(A1)"`);
  });
});

describe('the Id map as a file', () => {
  it('gives each row its object, its ids and what became of it, in the order the run produced them', () => {
    expect(idMapRows(RUN)).toEqual([
      {
        objectApiName: 'Account',
        sourceId: '001000000000001AAA',
        targetId: '001000000000101AAA',
        outcome: 'created',
      },
      {
        objectApiName: 'Account',
        sourceId: '001000000000002AAA',
        targetId: '001000000000102AAA',
        outcome: 'created',
      },
      {
        objectApiName: 'Contact',
        sourceId: '003000000000001AAA',
        targetId: '003000000000101AAA',
        outcome: 'created',
      },
      // Linked: its object is that of the created rows its id's prefix names.
      {
        objectApiName: 'Account',
        sourceId: '001000000000003AAA',
        targetId: '001000000000103AAA',
        outcome: 'linked to existing',
      },
      {
        objectApiName: 'Contact',
        sourceId: '003000000000002AAA',
        targetId: '003000000000102AAA',
        outcome: 'written with its record',
      },
      // No created row shares its prefix: no object, rather than a guess.
      {
        objectApiName: undefined,
        sourceId: '01s000000000001AAA',
        targetId: '01s000000000101AAA',
        outcome: 'mapped',
      },
    ]);
  });

  it('writes a header and one line per row', () => {
    expect(idMapCsv(idMapRows(RUN)).split('\n')).toEqual([
      '"Object","Source Id","Target Id","Outcome"',
      '"Account","001000000000001AAA","001000000000101AAA","created"',
      '"Account","001000000000002AAA","001000000000102AAA","created"',
      '"Contact","003000000000001AAA","003000000000101AAA","created"',
      '"Account","001000000000003AAA","001000000000103AAA","linked to existing"',
      '"Contact","003000000000002AAA","003000000000102AAA","written with its record"',
      '"","01s000000000001AAA","01s000000000101AAA","mapped"',
    ]);
  });

  it('is a header alone for a run recorded before it kept its Id map', () => {
    expect(idMapCsv(idMapRows({}))).toBe('"Object","Source Id","Target Id","Outcome"');
  });
});

describe('the records a run created, by target id', () => {
  it('names the object of each record the run created, and none it linked to or found', () => {
    expect([...createdTargets(RUN)].sort()).toEqual([
      ['001000000000101AAA', 'Account'],
      ['001000000000102AAA', 'Account'],
      ['003000000000101AAA', 'Contact'],
    ]);
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
