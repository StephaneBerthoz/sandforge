import type { ForgeExecutionError } from '@sandforge/shared';

/**
 * The reports of a real clone into the trap target (`test/fixtures/trap-org`),
 * as its run summary recorded them on 2026-10-31, of a clone run without the
 * target's bypass and without a value for the field the source lacks: the
 * required field absent from the source (trap 6) refused both accounts, in
 * the French of the user the run wrote as, and the email rule (trap 3) the
 * contact that had none. The records are the trap source's synthetic seed.
 */
export const TRAP_REFUSALS: readonly ForgeExecutionError[] = [
  {
    objectApiName: 'Account',
    stage: 'insert',
    failedCount: 2,
    attemptedCount: 2,
    samples: [
      {
        recordSummary:
          'Name=Trap Account 03 Type=Customer Phone=+33 6 39 98 90 03 CleanStatus=Pending',
        messages: [
          "REQUIRED_FIELD_MISSING: Des champs obligatoires n'ont pas été remplis\u00a0: [Trap_Target_Only__c]",
        ],
      },
      {
        recordSummary:
          'Name=Trap Account 15 Type=Customer Phone=+33 6 39 98 90 15 CleanStatus=Pending',
        messages: [
          "REQUIRED_FIELD_MISSING: Des champs obligatoires n'ont pas été remplis\u00a0: [Trap_Target_Only__c]",
        ],
      },
    ],
  },
  {
    objectApiName: 'Contact',
    stage: 'insert',
    failedCount: 1,
    attemptedCount: 1,
    samples: [
      {
        recordSummary:
          'LastName=Contact 0025 FirstName=Trap Phone=+33 6 39 98 00 25 CleanStatus=Pending',
        messages: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: Email is required. [Email]'],
      },
    ],
  },
];

/**
 * The second pass's report, as it words a lookup it could not fill in: a
 * contact written without the manager the clone did not hold. It counts
 * lookups left empty on records the target holds.
 */
export const SECOND_PASS_REPORT: ForgeExecutionError = {
  objectApiName: '__pass2__',
  stage: 'insert',
  failedCount: 1,
  attemptedCount: 4,
  samples: [
    {
      recordSummary:
        'Contact source=003000000000002AAA target=003000000000102AAA ReportsToId=<source 003000000000009AAA>',
      messages: [
        "Cycle FK 'ReportsToId' could not be resolved — referenced parent (source 003000000000009AAA) was not cloned",
      ],
    },
  ],
};

/** An object the run skipped whole before reading it: the target has none of it. */
export const SKIPPED_WHOLE: ForgeExecutionError = {
  objectApiName: 'Invoice__c',
  stage: 'scope',
  failedCount: 0,
  attemptedCount: 0,
  skipped: true,
  samples: [
    {
      recordSummary: '(node-level skip)',
      messages: [
        'Object is not in the target org, or the user the run writes as cannot see it: ' +
          'none of its records can be written there',
      ],
    },
  ],
};

/**
 * Notes, as the executor writes them: the lookups contacts went in without,
 * one sample per lookup, and the tracked changes the platform writes itself.
 * They count no failed record.
 */
export const RUN_NOTES: readonly ForgeExecutionError[] = [
  {
    objectApiName: 'Contact',
    stage: 'scope',
    failedCount: 0,
    attemptedCount: 0,
    samples: [
      {
        recordSummary: 'ReportsToId → Contact (2 records)',
        messages: [
          'Written without ReportsToId: the target holds no record of these ids, outside the run.',
        ],
      },
      {
        recordSummary: 'Trap_Preferred_Account__c → Account (1 record)',
        messages: [
          'Written without Trap_Preferred_Account__c: the target holds no record of these ids, outside the run.',
        ],
      },
    ],
  },
  {
    objectApiName: 'FeedItem',
    stage: 'scope',
    failedCount: 0,
    attemptedCount: 0,
    samples: [
      {
        recordSummary: 'Type=TrackedChange (1 record)',
        messages: [
          'Not written: the platform writes each tracked change itself, and refuses one a copy sends.',
        ],
      },
    ],
  },
];

/**
 * Reference data the target holds no match for by name: linked, never
 * written, it is neither written nor failed, whatever its report counts.
 */
export const UNMATCHED_REFERENCE_DATA: ForgeExecutionError = {
  objectApiName: 'BusinessHours',
  stage: 'scope',
  failedCount: 1,
  attemptedCount: 1,
  referenceData: true,
  samples: [
    {
      recordSummary: 'Id=01m000000000001AAA matchValue=Office hours',
      messages: ['Reference-data row not found on target org'],
    },
  ],
};
