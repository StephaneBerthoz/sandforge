import { describe, expect, it } from 'vitest';
import type { ForgeUndoObjectResult } from '@sandforge/shared';

import {
  removalAuditObjects,
  removalAuditOutcome,
  removalMark,
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

  it('is no success while records the removal could not see may be in the org', () => {
    expect(removalStatus([object({ deleted: 2, notVisible: 1 })], false)).toBe('partial');
    expect(removalStatus([object({ alreadyGone: 1, notVisible: 1 })], false)).toBe('failure');
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
      removalMark(
        {
          status: 'partial',
          finishedAt: '2026-09-24T10:00:00.000Z',
          objects: [
            object({ deleted: 2, alreadyGone: 1, keptChanged: 1 }),
            object({ keptDependents: 2, refused: 1 }),
          ],
        },
        7,
      ),
    ).toEqual({
      removedAt: '2026-09-24T10:00:00.000Z',
      deleted: 2,
      alreadyGone: 1,
      kept: 3,
      refused: 1,
    });
  });

  it('adds what a removal of what was left took to what the earlier ones took, and says what it left', () => {
    // The first removal deleted 249 records and kept 24; the second took them.
    const earlier = {
      removedAt: '2026-09-29T15:51:27.295Z',
      deleted: 249,
      alreadyGone: 0,
      kept: 24,
      refused: 0,
    };

    expect(
      removalMark(
        {
          status: 'success',
          finishedAt: '2026-09-29T16:10:00.000Z',
          objects: [object({ deleted: 22, alreadyGone: 1 }), object({ deleted: 1 })],
        },
        24,
        earlier,
      ),
    ).toEqual({
      removedAt: '2026-09-29T16:10:00.000Z',
      deleted: 272,
      alreadyGone: 1,
      kept: 0,
      refused: 0,
    });
  });

  it('counts a cancelled removal with the others, and what it did not reach', () => {
    // A partial removal deleted 5 and kept 4; the next, set to take those 4,
    // deleted 1 and was cancelled; the last took the other 3.
    const partial = {
      removedAt: '2026-09-30T09:00:00.000Z',
      deleted: 5,
      alreadyGone: 0,
      kept: 4,
      refused: 0,
    };
    const cancelled = removalMark(
      {
        status: 'cancelled',
        finishedAt: '2026-09-30T09:10:00.000Z',
        objects: [object({ planned: 2, deleted: 1 })],
      },
      4,
      partial,
    );

    expect(cancelled).toEqual({
      removedAt: '2026-09-30T09:10:00.000Z',
      deleted: 6,
      alreadyGone: 0,
      kept: 0,
      refused: 0,
      notReached: 3,
    });
    expect(
      removalMark(
        {
          status: 'success',
          finishedAt: '2026-09-30T09:20:00.000Z',
          objects: [object({ deleted: 1 }), object({ deleted: 2 })],
        },
        3,
        cancelled,
      ),
    ).toEqual({
      removedAt: '2026-09-30T09:20:00.000Z',
      deleted: 9,
      alreadyGone: 0,
      kept: 0,
      refused: 0,
    });
  });

  it('counts what a removal that deleted nothing found gone', () => {
    expect(
      removalMark(
        {
          status: 'failure',
          finishedAt: '2026-09-30T09:00:00.000Z',
          objects: [object({ alreadyGone: 2, refused: 1 })],
        },
        3,
      ),
    ).toEqual({
      removedAt: '2026-09-30T09:00:00.000Z',
      deleted: 0,
      alreadyGone: 2,
      kept: 0,
      refused: 1,
    });
  });

  it('says what the removal could not see, which a cancel did not leave unreached', () => {
    expect(
      removalMark(
        {
          status: 'cancelled',
          finishedAt: '2026-09-30T09:00:00.000Z',
          objects: [object({ deleted: 2, notVisible: 1 })],
        },
        5,
      ),
    ).toEqual({
      removedAt: '2026-09-30T09:00:00.000Z',
      deleted: 2,
      alreadyGone: 0,
      kept: 0,
      refused: 0,
      notReached: 2,
      notVisible: 1,
    });
  });

  it('leaves no mark for a removal that took no record, whether it ended or was cancelled', () => {
    for (const status of ['failure', 'cancelled'] as const) {
      expect(
        removalMark(
          { status, finishedAt: '2026-09-30T09:00:00.000Z', objects: [object({ refused: 1 })] },
          3,
        ),
      ).toBeUndefined();
    }
  });
});
