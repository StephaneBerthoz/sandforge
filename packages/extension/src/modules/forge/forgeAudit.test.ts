import { describe, it, expect } from 'vitest';
import type { ForgeExecutionError } from '@sandforge/shared';
import {
  auditTalliesOf,
  cancelledRunOutcome,
  contactPointsAudit,
  forgeAuditObjects,
  forgeCarried,
} from './forgeAudit.js';
import type { ExecutionSummary } from './ForgeExecutor.js';

/** An error of the run on one object, `failedCount` rows lost at `stage`. */
const error = (
  objectApiName: string,
  failedCount: number,
  overrides: Partial<ForgeExecutionError> = {},
): ForgeExecutionError => ({
  objectApiName,
  stage: 'insert',
  failedCount,
  attemptedCount: failedCount,
  samples: [],
  ...overrides,
});

/** What the executor reports of a run, with what `overrides` replaces in it. */
function summary(overrides: Partial<ExecutionSummary> = {}): ExecutionSummary {
  return {
    successCount: 0,
    updatedCount: 0,
    linkedCount: 0,
    failedCount: 0,
    failedReads: [],
    errors: [],
    remapByObject: [],
    ...overrides,
  } as unknown as ExecutionSummary;
}

describe('forgeAuditObjects', () => {
  it('counts per object the rows created, updated by an upsert, and lost', () => {
    expect(
      forgeAuditObjects({
        idRemapByObject: [
          { objectApiName: 'Account', created: 2, linked: 1, updated: 1 },
          { objectApiName: 'Contact', created: 3, linked: 0 },
        ],
        errors: [error('Contact', 1)],
      }),
    ).toEqual([
      { objectApiName: 'Account', created: 2, updated: 1, deleted: 0, failed: 0 },
      { objectApiName: 'Contact', created: 3, updated: 0, deleted: 0, failed: 1 },
    ]);
  });

  it('leaves out a note and a pass, and marks an object skipped whole, counted or not', () => {
    const objects = forgeAuditObjects({
      errors: [
        error('__pass2__', 2),
        error('Pricebook2', 0, { stage: 'scope' }),
        error('Case', 0, { stage: 'scope', skipped: true }),
        error('Task', 4, { stage: 'scope', skipped: true }),
      ],
    });

    expect(objects).toEqual([
      {
        objectApiName: 'Case',
        created: 0,
        updated: 0,
        deleted: 0,
        failed: 0,
        skipped: 'uncounted',
      },
      { objectApiName: 'Task', created: 0, updated: 0, deleted: 0, failed: 4, skipped: 'counted' },
    ]);
  });
});

describe('forgeCarried', () => {
  it('counts per object every row given a counterpart: created, linked or written over', () => {
    expect(
      forgeCarried({
        idRemapByObject: [{ objectApiName: 'Account', created: 2, linked: 1, updated: 1 }],
      }),
    ).toEqual({ Account: 4 });
  });
});

describe('contactPointsAudit', () => {
  it('says whether the run neutralized its contact points, with counts and never a value', () => {
    expect(
      contactPointsAudit({
        neutralized: true,
        fields: [{ objectApiName: 'Contact', field: 'Email', kind: 'email', values: 3 }],
        values: 3,
      }),
    ).toEqual({
      details: { contactPoints: 'neutralized', contactPointFields: 1, contactPointValues: 3 },
    });
    expect(contactPointsAudit({ neutralized: false, fields: [], values: 0 })).toEqual({
      details: { contactPoints: 'kept', contactPointFields: 0, contactPointValues: 0 },
    });
    expect(contactPointsAudit(undefined)).toEqual({});
  });
});

describe('cancelledRunOutcome', () => {
  it('records a cancelled run partial once it wrote a record, and stopped when it wrote none', () => {
    const wrote = [{ objectApiName: 'Account', created: 1, updated: 0, deleted: 0, failed: 0 }];
    const none = [{ objectApiName: 'Account', created: 0, updated: 0, deleted: 0, failed: 0 }];

    expect(cancelledRunOutcome(summary(), wrote)).toBe('partial');
    expect(cancelledRunOutcome(summary(), none)).toBe('stopped');
    expect(cancelledRunOutcome(undefined, [])).toBe('stopped');
  });

  it('keeps a cancelled run whose rows were all refused a failure', () => {
    expect(cancelledRunOutcome(summary({ failedCount: 2 }), [])).toBe('failure');
  });
});

describe('auditTalliesOf', () => {
  it('reads the tallies of an executor summary under the names a history entry gives them', () => {
    const remapByObject = [{ objectApiName: 'Account', created: 1, linked: 0 }];
    const errors = [error('Contact', 1)];

    expect(auditTalliesOf(summary({ remapByObject, errors }))).toEqual({
      idRemapByObject: remapByObject,
      errors,
      notSentByObject: undefined,
      writtenWithoutFields: undefined,
      mayHaveBeenWritten: undefined,
    });
  });
});
