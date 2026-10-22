import { describe, expect, it } from 'vitest';
import type {
  ForgeUndoObjectResult,
  SyncRestoreObjectResult,
  SyncUndeleteObjectResult,
} from '@sandforge/shared';
import { removalStatus } from '../forge/removalOutcome';
import { withRestore, withUndelete } from './SyncRunRemoval';
import type { SyncRestoreOutcome } from './SyncRunRestore';
import type { SyncUndeleteOutcome } from './SyncRunUndelete';

/*
 * How a removal ends once what it gave back and brought back is counted with
 * what it deleted: `removeSyncRun`'s composition, which a checkpoint's rewind
 * and its undo end by too, `withUndelete(withRestore(removalStatus(…)))`.
 */

/** What a removal deleted of one object, nothing left unless told. */
function deleted(counts: Partial<ForgeUndoObjectResult> = {}): ForgeUndoObjectResult {
  return {
    objectApiName: 'Account',
    planned: 3,
    deleted: 3,
    alreadyGone: 0,
    keptChanged: 0,
    keptDependents: 0,
    refused: 0,
    heldBy: [],
    unchecked: [],
    reasons: [],
    ...counts,
  };
}

/** What a give-back did of one object, every record given back unless told. */
function restored(
  counts: Partial<SyncRestoreObjectResult> = {},
  cancelled = false,
): SyncRestoreOutcome {
  return {
    objects: [
      {
        objectApiName: 'Contact',
        planned: 4,
        restored: 4,
        keptChanged: 0,
        alreadyGone: 0,
        refused: 0,
        notKept: 0,
        reasons: [],
        ...counts,
      },
    ],
    left: [],
    wrote: true,
    cancelled,
    stamps: {},
  };
}

/** What a bring-back did of one object, every record brought back unless told. */
function undeleted(
  counts: Partial<SyncUndeleteObjectResult> = {},
  cancelled = false,
): SyncUndeleteOutcome {
  return {
    objects: [
      {
        objectApiName: 'Case',
        planned: 2,
        undeleted: 2,
        alreadyBack: 0,
        goneForGood: 0,
        refused: 0,
        reasons: [],
        ...counts,
      },
    ],
    left: [],
    wrote: true,
    cancelled,
    stamps: {},
  };
}

/** The status the composition gives, as `removeSyncRun` composes it. */
function ended(
  objects: readonly ForgeUndoObjectResult[],
  back: SyncRestoreOutcome | undefined,
  brought: SyncUndeleteOutcome | undefined,
  cancelled = false,
): string {
  return withUndelete(
    withRestore(removalStatus(objects, cancelled), objects, back),
    objects,
    back,
    brought,
  );
}

describe('withRestore and withUndelete', () => {
  it('end a success when every record was deleted, given back and brought back', () => {
    expect(ended([deleted()], restored(), undeleted())).toBe('success');
  });

  it('end partial when a give-back left a record changed by someone else, every delete made', () => {
    expect(ended([deleted()], restored({ restored: 3, keptChanged: 1 }), undeleted())).toBe(
      'partial',
    );
  });

  it('count a record given back but for a field the org no longer takes as left, and the rest as done', () => {
    expect(ended([], restored({ restored: 0, restoredWithout: 4 }), undefined)).toBe('partial');
  });

  it('end partial when a bring-back left some records in the bin and brought others back', () => {
    expect(ended([deleted()], restored(), undeleted({ undeleted: 1, goneForGood: 1 }))).toBe(
      'partial',
    );
  });

  it('end a failure when nothing was deleted, given back or brought back, and something was left', () => {
    expect(
      ended([], restored({ restored: 0, refused: 4 }), undeleted({ undeleted: 0, refused: 2 })),
    ).toBe('failure');
  });

  it('end cancelled when a stop came during the give-back or the bring-back, whatever else was done', () => {
    expect(ended([deleted()], restored({}, true), undeleted())).toBe('cancelled');
    expect(ended([deleted()], restored(), undeleted({}, true))).toBe('cancelled');
    expect(ended([deleted()], restored(), undeleted(), true)).toBe('cancelled');
  });

  it('leave the removal’s own status as it was when nothing was given back or brought back', () => {
    expect(ended([deleted({ deleted: 2, refused: 1 })], undefined, undefined)).toBe('partial');
    expect(ended([deleted({ deleted: 0, refused: 3 })], undefined, undefined)).toBe('failure');
    expect(withRestore('partial', [], undefined)).toBe('partial');
    expect(withUndelete('failure', [], undefined, undefined)).toBe('failure');
  });
});
