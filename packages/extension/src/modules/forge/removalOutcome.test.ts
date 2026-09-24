import { describe, expect, it } from 'vitest';
import type { ForgeUndoObjectResult } from '@sandforge/shared';

import {
  removalAuditObjects,
  removalAuditOutcome,
  removalMark,
  removalMarks,
  removalStatus,
} from './removalOutcome.js';

/** One object's outcome, nothing counted but what a test names. */
function object(overrides: Partial<ForgeUndoObjectResult>): ForgeUndoObjectResult {
  return {
    objectApiName: 'Contact',
    planned: 0,
    deleted: 0,
    alreadyGone: 0,
    keptChanged: 0,
    keptDependents: 0,
    refused: 0,
    heldBy: [],
    unchecked: [],
    reasons: [],
    ...overrides,
  };
}

describe('removalStatus', () => {
  it('is a success when nothing is left in the org, deleted or found gone', () => {
    expect(removalStatus([object({ deleted: 2 }), object({ alreadyGone: 1 })], false)).toBe(
      'success',
    );
  });

  it('is partial when records went and others stay', () => {
    expect(removalStatus([object({ deleted: 2 }), object({ keptDependents: 1 })], false)).toBe(
      'partial',
    );
  });

  it('is a failure when records stay and none was deleted', () => {
    expect(removalStatus([object({ refused: 1 }), object({ alreadyGone: 1 })], false)).toBe(
      'failure',
    );
  });

  it('is cancelled when it was stopped, whatever it did by then', () => {
    expect(removalStatus([object({ deleted: 3 })], true)).toBe('cancelled');
  });
});

describe('removalAuditOutcome', () => {
  it('records a cancelled removal as partial when it deleted something, as failed otherwise', () => {
    expect(removalAuditOutcome({ status: 'cancelled', objects: [object({ deleted: 1 })] })).toBe(
      'partial',
    );
    expect(
      removalAuditOutcome({ status: 'cancelled', objects: [object({ keptChanged: 1 })] }),
    ).toBe('failure');
  });

  it('records any other removal as it ended', () => {
    expect(removalAuditOutcome({ status: 'partial', objects: [] })).toBe('partial');
  });
});

describe('removalAuditObjects', () => {
  it('counts per object what was deleted and what the org refused, and leaves out the rest', () => {
    expect(
      removalAuditObjects([
        object({ objectApiName: 'Contact', deleted: 2, refused: 1 }),
        object({ objectApiName: 'Account', keptDependents: 1 }),
      ]),
    ).toEqual([{ objectApiName: 'Contact', created: 0, updated: 0, deleted: 2, failed: 1 }]);
  });
});

describe('removalMark', () => {
  it('sums, over the objects, what went each way, dated by the end of the removal', () => {
    expect(
      removalMark({
        finishedAt: '2026-09-24T10:00:00.000Z',
        objects: [
          object({ deleted: 2, alreadyGone: 1, keptChanged: 1 }),
          object({ keptDependents: 2, refused: 1 }),
        ],
      }),
    ).toEqual({
      removedAt: '2026-09-24T10:00:00.000Z',
      deleted: 2,
      alreadyGone: 1,
      kept: 3,
      refused: 1,
    });
  });
});

describe('removalMarks', () => {
  it('marks a run once its records went, and offers again one stopped or that took nothing', () => {
    expect(
      ['success', 'partial', 'failure', 'cancelled'].map((s) => removalMarks(s as never)),
    ).toEqual([true, true, false, false]);
  });
});
