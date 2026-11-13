import { describe, it, expect } from 'vitest';
import type { ForgeExecutionError, ForgeExecutionResult } from '@sandforge/shared';
import {
  createdTargets,
  isRunNote,
  lookupsLeftEmptyOf,
  objectResultsCsv,
  reportCell,
  rootCopyOf,
  runErrorsReportLines,
  runFailureCell,
  runFailuresOf,
  runNotesReportLines,
  type ObjectResultRow,
} from './forgeResultsExport';
import {
  ORPHAN_PARENTS_REPORT,
  RUN_NOTES,
  SECOND_PASS_REPORT,
  SKIPPED_WHOLE,
  TRAP_REFUSALS,
  UNMATCHED_REFERENCE_DATA,
} from './testing/forgeRunReports';

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

/**
 * The second pass refused by a lookup filter of the target: the update that
 * fills the lookup in is refused, with the filter's default message, and the
 * lookup stays empty.
 */
const SECOND_PASS_REFUSED: ForgeExecutionError = {
  objectApiName: '__pass2__',
  stage: 'insert',
  failedCount: 2,
  attemptedCount: 5,
  samples: [
    {
      recordSummary: 'Id=003000000000103AAA AccountId=001000000000104AAA',
      messages: [
        'FIELD_FILTER_VALIDATION_EXCEPTION: Value does not exist or does not match filter criteria.',
      ],
    },
  ],
};

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

  it('gives an object the target refused what the run failed of it, as the copied report does', () => {
    // The Errors cell held discovery's words alone: the accounts the target
    // refused every one of read "error" and a failed count, and nothing of why.
    const lines = objectResultsCsv(
      [
        { objectApiName: 'Account', records: 2, status: 'error', errors: [] },
        { objectApiName: 'Contact', records: 1, status: 'error', errors: [] },
        { objectApiName: 'BusinessHours', records: 1, status: 'done', errors: [] },
        { objectApiName: 'Invoice__c', records: undefined, status: 'skipped', errors: [] },
      ],
      {
        idRemapByObject: [],
        errors: [...TRAP_REFUSALS, ...RUN_NOTES, UNMATCHED_REFERENCE_DATA, SKIPPED_WHOLE],
      },
    ).split('\n');

    expect(lines).toEqual([
      '"Object","Records read","Status","Created","Linked","Failed","Errors"',
      '"Account","2","error","0","0","2","2 failed at insert: REQUIRED_FIELD_MISSING"',
      // The contact's note, of the lookups it went in without, is no failure.
      '"Contact","1","error","0","0","1","1 failed at insert: FIELD_CUSTOM_VALIDATION_EXCEPTION"',
      // Nor is reference data the target holds no match for.
      '"BusinessHours","1","done","0","0","0",""',
      '"Invoice__c","","skipped","0","0","0","skipped whole"',
    ]);
  });

  it('gives the lookups the second pass left empty a row of their own, in the copied report’s words', () => {
    // The file had no line for them: those records are in the target without
    // the lookup, which the copied report says and the run counts failed
    // nowhere, so they stay out of the Failed column.
    const lines = objectResultsCsv(
      [
        { objectApiName: 'Account', records: 2, status: 'error', errors: [] },
        { objectApiName: 'Contact', records: 1, status: 'error', errors: [] },
      ],
      { idRemapByObject: [], errors: [...TRAP_REFUSALS, SECOND_PASS_REPORT, ...RUN_NOTES] },
    ).split('\n');

    expect(lines).toEqual([
      '"Object","Records read","Status","Created","Linked","Failed","Errors"',
      '"Account","2","error","0","0","2","2 failed at insert: REQUIRED_FIELD_MISSING"',
      '"Contact","1","error","0","0","1","1 failed at insert: FIELD_CUSTOM_VALIDATION_EXCEPTION"',
      '"Lookups the second pass left empty","","","","","","1 of 4 left empty"',
    ]);
  });

  it('names the codes the second pass was refused with on its row', () => {
    const lines = objectResultsCsv([], {
      idRemapByObject: [],
      errors: [SECOND_PASS_REFUSED],
    }).split('\n');

    expect(lines).toEqual([
      '"Object","Records read","Status","Created","Linked","Failed","Errors"',
      '"Lookups the second pass left empty","","","","","","2 of 5 left empty: FIELD_FILTER_VALIDATION_EXCEPTION"',
    ]);
  });
});

describe('the lookups the second pass left empty', () => {
  it('adds up what each report of the pass left and tried, and names each code once', () => {
    expect(lookupsLeftEmptyOf([...TRAP_REFUSALS, SECOND_PASS_REPORT, SECOND_PASS_REFUSED])).toEqual(
      { leftEmpty: 3, attempted: 9, codes: ['FIELD_FILTER_VALIDATION_EXCEPTION'] },
    );
  });

  it('is nothing for a run whose second pass left none', () => {
    expect(lookupsLeftEmptyOf([...TRAP_REFUSALS, ...RUN_NOTES])).toBeUndefined();
  });
});

/** A report of the run, failing one record at insert unless told otherwise. */
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

/** The rows of a record-scoped run held back for want of the account they need, as the run says it. */
const HELD_BACK = report('Opportunity', {
  stage: 'scope',
  failedCount: 3,
  attemptedCount: 0,
  samples: [
    {
      recordSummary: 'AccountId → Account (3 records)',
      messages: [
        'Not written: AccountId may not be left empty, and the Account it points at failed in this run.',
      ],
    },
  ],
});

describe('which reports of the run are notes', () => {
  it('takes a scope report that fails and skips nothing, and reference data whatever it counts', () => {
    for (const note of RUN_NOTES) expect(isRunNote(note)).toBe(true);
    expect(isRunNote(UNMATCHED_REFERENCE_DATA)).toBe(true);
  });

  it('leaves out a report that failed a record, one at another stage and an object skipped whole', () => {
    for (const refusal of TRAP_REFUSALS) expect(isRunNote(refusal)).toBe(false);
    expect(isRunNote(HELD_BACK)).toBe(false);
    expect(isRunNote(report('Contact', { stage: 'query', failedCount: 0 }))).toBe(false);
    expect(isRunNote(SKIPPED_WHOLE)).toBe(false);
    expect(isRunNote(SECOND_PASS_REPORT)).toBe(false);
  });
});

describe('a cell of the copied report', () => {
  it('runs spaces and line breaks into one space, so a message over lines keeps its row', () => {
    expect(reportCell('  execution of BeforeInsert\n\ncaused by:\tSystem.LimitException  ')).toBe(
      'execution of BeforeInsert caused by: System.LimitException',
    );
  });

  it('escapes a pipe, which would otherwise open a column', () => {
    expect(reportCell('Status must be Open | Closed')).toBe('Status must be Open \\| Closed');
  });

  it('cuts a long message at 300 characters with an ellipsis', () => {
    const cell = reportCell('x'.repeat(400));
    expect(cell).toHaveLength(300);
    expect(cell.endsWith('…')).toBe(true);
    expect(reportCell('x'.repeat(300))).toBe('x'.repeat(300));
  });
});

describe('what the run failed of an object, in parts the results page words', () => {
  it('gives each report its stage, its count, whether it skipped the object, and its codes', () => {
    expect(
      runFailuresOf('Account', [
        ...TRAP_REFUSALS,
        report('Account', { stage: 'query', failedCount: 0, attemptedCount: 0 }),
      ]),
    ).toEqual([
      { stage: 'insert', failed: 2, skipped: false, codes: ['REQUIRED_FIELD_MISSING'] },
      { stage: 'query', failed: 0, skipped: false, codes: [] },
    ]);
    expect(runFailuresOf('Invoice__c', [SKIPPED_WHOLE])).toEqual([
      { stage: 'scope', failed: 0, skipped: true, codes: [] },
    ]);
  });

  it('leaves out notes, reference data, the second pass and other objects', () => {
    const reports = [...RUN_NOTES, UNMATCHED_REFERENCE_DATA, SECOND_PASS_REPORT, ...TRAP_REFUSALS];
    expect(runFailuresOf('FeedItem', reports)).toEqual([]);
    expect(runFailuresOf('BusinessHours', reports)).toEqual([]);
    expect(runFailuresOf('Contact', reports)).toEqual([
      { stage: 'insert', failed: 1, skipped: false, codes: ['FIELD_CUSTOM_VALIDATION_EXCEPTION'] },
    ]);
  });
});

describe('what the run failed of an object, for its Errors cell', () => {
  it('says how many failed at which stage, with the code each refusal opens with', () => {
    expect(runFailureCell('Account', TRAP_REFUSALS)).toBe(
      '2 failed at insert: REQUIRED_FIELD_MISSING',
    );
    expect(runFailureCell('Contact', TRAP_REFUSALS)).toBe(
      '1 failed at insert: FIELD_CUSTOM_VALIDATION_EXCEPTION',
    );
  });

  it('names each code its samples open with once, and none from what the run says after it', () => {
    // A row refused again once sent without the field the first refusal
    // named: the line that says so quotes that refusal, and is no code.
    expect(
      runFailureCell('Contact', [
        report('Contact', {
          failedCount: 2,
          attemptedCount: 3,
          samples: [
            {
              recordSummary: 'LastName=Contact 0007 FirstName=Trap',
              messages: [
                'FIELD_CUSTOM_VALIDATION_EXCEPTION: Email is required. [Email]',
                'Sent again without Phone after the first refusal: INVALID_EMAIL_ADDRESS: Email: invalid email address [Email]',
              ],
            },
            {
              recordSummary: 'LastName=Contact 0008 FirstName=Trap',
              messages: [
                'FIELD_CUSTOM_VALIDATION_EXCEPTION: Email is required. [Email]',
                'DUPLICATES_DETECTED: Use one of these records?',
              ],
            },
          ],
        }),
      ]),
    ).toBe('2 failed at insert: FIELD_CUSTOM_VALIDATION_EXCEPTION, DUPLICATES_DETECTED');
  });

  it('says an object skipped whole, the rows held back, and joins its reports with semicolons', () => {
    expect(runFailureCell('Invoice__c', [SKIPPED_WHOLE])).toBe('skipped whole');
    expect(
      runFailureCell('Invoice__c', [
        report('Invoice__c', { stage: 'scope', failedCount: 5, skipped: true }),
      ]),
    ).toBe('5 failed at scope (skipped whole)');
    expect(runFailureCell('Opportunity', [HELD_BACK, ...TRAP_REFUSALS])).toBe('3 failed at scope');
    expect(
      runFailureCell('Account', [
        ...TRAP_REFUSALS,
        report('Account', { stage: 'query', failedCount: 0, attemptedCount: 0 }),
      ]),
    ).toBe('2 failed at insert: REQUIRED_FIELD_MISSING; 0 failed at query');
  });

  it('is empty for an object with notes only, reference data, or nothing at all', () => {
    const reports = [...RUN_NOTES, UNMATCHED_REFERENCE_DATA];
    expect(runFailureCell('Contact', reports)).toBe('');
    expect(runFailureCell('FeedItem', reports)).toBe('');
    expect(runFailureCell('BusinessHours', reports)).toBe('');
    expect(runFailureCell('Account', reports)).toBe('');
  });
});

describe("the copied report's Run Errors section", () => {
  it('says nothing of a run that failed nothing, its notes and reference data included', () => {
    expect(runErrorsReportLines([])).toEqual([]);
    expect(runErrorsReportLines([...RUN_NOTES, UNMATCHED_REFERENCE_DATA])).toEqual([]);
  });

  it('counts the failed records across distinct objects, then a row per report', () => {
    const lines = runErrorsReportLines([
      ...TRAP_REFUSALS,
      SKIPPED_WHOLE,
      SECOND_PASS_REPORT,
      // Neither failures nor counted.
      ...RUN_NOTES,
      UNMATCHED_REFERENCE_DATA,
    ]);

    expect(lines).toEqual([
      '',
      '## Run Errors',
      '',
      '- Failed records: 3 across 3 objects',
      // Those contacts are in the target, without the lookup.
      '- Lookups the second pass left empty: 1',
      '',
      '| Object | Stage | Failed | Attempted | Codes seen in samples | Sample message |',
      '|--------|-------|--------|-----------|-----------------------|----------------|',
      // The no-break space Salesforce puts before a colon in French runs into a space.
      "| Account | insert | 2 | 2 | REQUIRED_FIELD_MISSING (2 of 2 samples) | REQUIRED_FIELD_MISSING: Des champs obligatoires n'ont pas été remplis : [Trap_Target_Only__c] |",
      '| Contact | insert | 1 | 1 | FIELD_CUSTOM_VALIDATION_EXCEPTION (1 of 1 sample) | FIELD_CUSTOM_VALIDATION_EXCEPTION: Email is required. [Email] |',
      '| Invoice__c | skipped whole | 0 | 0 | (no code) | Object is not in the target org, or the user the run writes as cannot see it: none of its records can be written there |',
      "| __pass2__ | insert | 1 | 4 | (no code) | Cycle FK 'ReportsToId' could not be resolved — referenced parent (source 003000000000009AAA) was not cloned |",
    ]);
    const text = lines.join('\n');
    expect(text).not.toContain('BusinessHours');
    expect(text).not.toContain('FeedItem');
    expect(text).not.toContain('Written without');
  });

  it('counts the second pass apart from the failed records, and as no object', () => {
    expect(runErrorsReportLines([SECOND_PASS_REPORT]).slice(0, 5)).toEqual([
      '',
      '## Run Errors',
      '',
      '- Lookups the second pass left empty: 1',
      '',
    ]);
  });

  it('counts the parents fetched outside the clone apart from the failed records, and as no object', () => {
    // Counted as an object, with its parents among the failed records, the
    // fetched parents' report read "5 failed records across 3 objects" of a
    // run that failed 3 rows of 2 objects, the rows that needed those parents
    // among them.
    const lines = runErrorsReportLines([...TRAP_REFUSALS, ORPHAN_PARENTS_REPORT]);

    expect(lines.slice(0, 6)).toEqual([
      '',
      '## Run Errors',
      '',
      '- Failed records: 3 across 2 objects',
      '- Parents fetched outside the clone, not copied: 2',
      '',
    ]);
    // Its row stays, as the errors panel lists it.
    expect(lines.at(-1)).toMatch(/^\| __expandOrphanParents__ \| insert \| 2 \| 2 \| /);
  });

  it('says only the parents not copied of a run that failed nothing else', () => {
    expect(runErrorsReportLines([ORPHAN_PARENTS_REPORT]).slice(0, 5)).toEqual([
      '',
      '## Run Errors',
      '',
      '- Parents fetched outside the clone, not copied: 2',
      '',
    ]);
  });

  it('counts each code by the samples it was seen in, and keeps a message over lines on its row', () => {
    const lines = runErrorsReportLines([
      report('Contact', {
        failedCount: 3,
        attemptedCount: 3,
        samples: [
          {
            recordSummary: 'LastName=Contact 0001',
            messages: [
              'FIELD_CUSTOM_VALIDATION_EXCEPTION: Status must be Open | Closed\n\nSee the rule',
            ],
          },
          {
            recordSummary: 'LastName=Contact 0002',
            messages: [
              'INVALID_CROSS_REFERENCE_KEY: invalid cross reference id',
              'FIELD_CUSTOM_VALIDATION_EXCEPTION: Status must be Open | Closed',
            ],
          },
          {
            recordSummary: 'LastName=Contact 0003',
            messages: ['INVALID_CROSS_REFERENCE_KEY: invalid cross reference id'],
          },
        ],
      }),
    ]);

    expect(lines[3]).toBe('- Failed records: 3 across 1 object');
    expect(lines[7]).toBe(
      '| Contact | insert | 3 | 3 | FIELD_CUSTOM_VALIDATION_EXCEPTION (2 of 3 samples), INVALID_CROSS_REFERENCE_KEY (2 of 3 samples) | FIELD_CUSTOM_VALIDATION_EXCEPTION: Status must be Open \\| Closed See the rule |',
    );
  });
});

describe("the copied report's Run Notes section", () => {
  it('says nothing of a run that took no note', () => {
    expect(runNotesReportLines([])).toEqual([]);
  });

  it('gives each sample of a note a row: what it is about, then what it says', () => {
    // A note of the lookups an object went in without names each in a sample
    // of its own: kept to its first, the report named one lookup of two.
    const notes = [
      ...TRAP_REFUSALS,
      ...RUN_NOTES,
      UNMATCHED_REFERENCE_DATA,
      report('Lead', { stage: 'scope', failedCount: 0, attemptedCount: 0 }),
    ].filter(isRunNote);

    expect(runNotesReportLines(notes)).toEqual([
      '',
      '## Run Notes',
      '',
      '| Object | Note |',
      '|--------|------|',
      '| Contact | ReportsToId → Contact (2 records) — Written without ReportsToId: the target holds no record of these ids, outside the run. |',
      '| Contact | Trap_Preferred_Account__c → Account (1 record) — Written without Trap_Preferred_Account__c: the target holds no record of these ids, outside the run. |',
      '| FeedItem | Type=TrackedChange (1 record) — Not written: the platform writes each tracked change itself, and refuses one a copy sends. |',
      '| BusinessHours | Id=01m000000000001AAA matchValue=Office hours — Reference-data row not found on target org |',
      '| Lead | - |',
    ]);
  });
});
