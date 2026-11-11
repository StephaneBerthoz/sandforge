import { describe, it, expect } from 'vitest';
import type {
  ForgeExecutionError,
  ForgeExecutionErrorSample,
  ForgeExecutionResult,
} from '@sandforge/shared';
import {
  createdTargets,
  isRunNote,
  objectResultsCsv,
  reportCell,
  rootCopyOf,
  runErrorsReportLines,
  runFailureCell,
  runNotesReportLines,
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
      '"Contact","4","error","1","0","3","FIELD_INTEGRITY_EXCEPTION: bad, ""quoted""; second; 2 failed at insert; 1 failed at scope"',
      '"Case","","skipped","0","0","0",""',
      '"Pricebook2","1","done","0","0","0",""',
    ]);
  });

  it('gives an object the run failed what it failed in its Errors cell, as the copied report does', () => {
    const lines = objectResultsCsv(
      [{ objectApiName: 'Provenance__c', records: 116, status: 'error', errors: [] }],
      {
        idRemapByObject: [],
        errors: [
          {
            objectApiName: 'Provenance__c',
            stage: 'insert',
            failedCount: 116,
            attemptedCount: 116,
            samples: [
              {
                recordSummary: 'Name=P-1',
                messages: ['CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: SSC_TRG_Provenance: …'],
              },
            ],
          },
        ],
      },
    ).split('\n');

    expect(lines[1]).toBe(
      '"Provenance__c","116","error","0","0","116","116 failed at insert: CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY"',
    );
  });
});

/** A report of the run, failing `failedCount` of `objectApiName` at insert unless told otherwise. */
function report(
  objectApiName: string,
  fields: Partial<ForgeExecutionError> = {},
): ForgeExecutionError {
  return {
    objectApiName,
    stage: 'insert',
    failedCount: 1,
    attemptedCount: 1,
    samples: [],
    ...fields,
  };
}

/** A sample of a report, with its messages. */
function sample(...messages: string[]): ForgeExecutionErrorSample {
  return { recordSummary: 'Name=A', messages };
}

/** The real refusal of the incident, as Salesforce words it, over lines. */
const LIMIT_MESSAGE =
  'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: SSC_TRG_Provenance: execution of BeforeInsert\n\ncaused by: System.LimitException: Too many SOQL queries: 101\n\nTrigger.SSC_TRG_Provenance: line 12, column 1';

describe('which reports of the run are notes', () => {
  it('takes a scope report that fails and skips nothing, and reference data whatever it counts', () => {
    expect(isRunNote(report('A', { stage: 'scope', failedCount: 0 }))).toBe(true);
    expect(isRunNote(report('A', { stage: 'scope', failedCount: 4, referenceData: true }))).toBe(
      true,
    );
  });

  it('leaves out a report that failed a record, one at another stage and an object skipped whole', () => {
    expect(isRunNote(report('A', { stage: 'scope', failedCount: 1 }))).toBe(false);
    expect(isRunNote(report('A', { stage: 'insert', failedCount: 0 }))).toBe(false);
    expect(isRunNote(report('A', { stage: 'scope', failedCount: 0, skipped: true }))).toBe(false);
  });
});

describe('a cell of the copied report', () => {
  it('runs spaces and line breaks into one space, so a message over lines keeps its row', () => {
    expect(reportCell('  execution of BeforeInsert\n\ncaused by:\tSystem.LimitException  ')).toBe(
      'execution of BeforeInsert caused by: System.LimitException',
    );
  });

  it('escapes a pipe, which would otherwise open a column', () => {
    expect(reportCell('Status | Active')).toBe('Status \\| Active');
  });

  it('cuts a long message at 300 characters with an ellipsis', () => {
    const cell = reportCell('x'.repeat(400));
    expect(cell).toHaveLength(300);
    expect(cell.endsWith('…')).toBe(true);
    expect(reportCell('x'.repeat(300))).toBe('x'.repeat(300));
  });
});

describe('what the run failed of an object, for its Errors cell', () => {
  it('says how many failed at which stage, with the codes its samples open with', () => {
    expect(
      runFailureCell('Contact', [
        report('Contact', {
          failedCount: 2,
          samples: [
            sample('FIELD_INTEGRITY_EXCEPTION: bad'),
            sample('FIELD_INTEGRITY_EXCEPTION: bad', 'REQUIRED_FIELD_MISSING: [Name]'),
          ],
        }),
      ]),
    ).toBe('2 failed at insert: FIELD_INTEGRITY_EXCEPTION, REQUIRED_FIELD_MISSING');
  });

  it('says an object skipped whole, and joins its reports with semicolons', () => {
    expect(
      runFailureCell('Case', [
        report('Case', { failedCount: 3, samples: [sample('a message with no code')] }),
        report('Case', { stage: 'scope', failedCount: 5, skipped: true }),
        report('Account', { failedCount: 9 }),
      ]),
    ).toBe('3 failed at insert; 5 failed at scope (skipped whole)');
  });

  it('is empty for an object with notes only, reference data, or nothing at all', () => {
    const reports = [
      report('Contact', { stage: 'scope', failedCount: 0, samples: [sample('LOOKUP: left')] }),
      report('Pricebook2', { stage: 'scope', failedCount: 2, referenceData: true }),
    ];
    expect(runFailureCell('Contact', reports)).toBe('');
    expect(runFailureCell('Pricebook2', reports)).toBe('');
    expect(runFailureCell('Account', reports)).toBe('');
  });
});

describe("the copied report's Run Errors section", () => {
  it('says nothing of a run that failed nothing', () => {
    expect(runErrorsReportLines([])).toEqual([]);
    expect(runErrorsReportLines([report('Contact', { stage: 'scope', failedCount: 0 })])).toEqual(
      [],
    );
  });

  it('counts the failed records across distinct objects, then a row per report', () => {
    const lines = runErrorsReportLines([
      report('Provenance__c', {
        failedCount: 116,
        attemptedCount: 116,
        samples: [sample(LIMIT_MESSAGE), sample(LIMIT_MESSAGE), sample(LIMIT_MESSAGE)],
      }),
      report('Provenance__c', { stage: 'scope', failedCount: 4, attemptedCount: 0, skipped: true }),
      report('__pass2__', {
        failedCount: 40,
        attemptedCount: 900,
        samples: [sample('a lookup left as it was')],
      }),
      // Neither a failure nor counted.
      report('Pricebook2', { stage: 'scope', failedCount: 7, referenceData: true }),
    ]);

    expect(lines).toEqual([
      '',
      '## Run Errors',
      '',
      '- Failed records: 160 across 2 objects',
      '',
      '| Object | Stage | Failed | Attempted | Codes seen in samples | Sample message |',
      '|--------|-------|--------|-----------|-----------------------|----------------|',
      '| Provenance__c | insert | 116 | 116 | CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY (3 of 3 samples) | CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: SSC_TRG_Provenance: execution of BeforeInsert caused by: System.LimitException: Too many SOQL queries: 101 Trigger.SSC_TRG_Provenance: line 12, column 1 |',
      '| Provenance__c | skipped whole | 4 | 0 | (no code) | - |',
      '| __pass2__ | insert | 40 | 900 | (no code) | a lookup left as it was |',
    ]);
  });

  it('counts each code by the samples it was seen in, and says one object as one', () => {
    const lines = runErrorsReportLines([
      report('Contact', {
        failedCount: 3,
        attemptedCount: 3,
        samples: [
          sample('FIELD_INTEGRITY_EXCEPTION: a | b'),
          sample('INVALID_CROSS_REFERENCE_KEY: c', 'FIELD_INTEGRITY_EXCEPTION: d'),
          sample('INVALID_CROSS_REFERENCE_KEY: e'),
        ],
      }),
    ]);

    expect(lines[3]).toBe('- Failed records: 3 across 1 object');
    expect(lines[7]).toBe(
      '| Contact | insert | 3 | 3 | FIELD_INTEGRITY_EXCEPTION (2 of 3 samples), INVALID_CROSS_REFERENCE_KEY (2 of 3 samples) | FIELD_INTEGRITY_EXCEPTION: a \\| b |',
    );
  });
});

describe("the copied report's Run Notes section", () => {
  it('says nothing of a run that took no note', () => {
    expect(runNotesReportLines([])).toEqual([]);
  });

  it('gives each note its first sample: what it is about, then what it says', () => {
    expect(
      runNotesReportLines([
        report('Provenance__c', {
          stage: 'scope',
          failedCount: 0,
          attemptedCount: 116,
          samples: [
            {
              recordSummary: 'Provenance__c: 116 records sent 58 at a time',
              messages: [
                'SSC_TRG_Provenance (before insert) hit Too many SOQL queries on calls of 116: 2 calls more.',
                'not read',
              ],
            },
            { recordSummary: 'not read either', messages: [] },
          ],
        }),
        report('Contact', {
          stage: 'scope',
          failedCount: 0,
          samples: [{ recordSummary: 'AccountId left empty', messages: [] }],
        }),
        report('Lead', { stage: 'scope', failedCount: 0 }),
      ]),
    ).toEqual([
      '',
      '## Run Notes',
      '',
      '| Object | Note |',
      '|--------|------|',
      '| Provenance__c | Provenance__c: 116 records sent 58 at a time — SSC_TRG_Provenance (before insert) hit Too many SOQL queries on calls of 116: 2 calls more. |',
      '| Contact | AccountId left empty |',
      '| Lead | - |',
    ]);
  });
});
