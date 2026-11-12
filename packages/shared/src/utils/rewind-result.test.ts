import { describe, expect, it } from 'vitest';
import { rewindWroteNothing } from './rewind-result.js';

const NONE = { deleted: [], restored: [], undeleted: [] };

describe('rewindWroteNothing', () => {
  it('says an act that deleted, gave back, brought back and made again nothing wrote nothing', () => {
    expect(rewindWroteNothing(NONE)).toBe(true);
    expect(
      rewindWroteNothing({
        deleted: [
          {
            objectApiName: 'Case',
            planned: 2,
            deleted: 0,
            alreadyGone: 2,
            keptChanged: 0,
            keptDependents: 0,
            refused: 0,
            heldBy: [],
            unchecked: [],
            reasons: [],
          },
        ],
        restored: [],
        undeleted: [
          {
            objectApiName: 'Account',
            planned: 1,
            undeleted: 0,
            alreadyBack: 1,
            goneForGood: 0,
            refused: 0,
            reasons: [],
          },
        ],
        files: { unlinked: 0, relinked: 0, linksUpdated: 0, linksRefused: 1 },
      }),
    ).toBe(true);
  });

  it('says an act wrote once it deleted, gave back, brought back, made again or relinked one record', () => {
    expect(
      rewindWroteNothing({
        ...NONE,
        restored: [
          {
            objectApiName: 'Account',
            planned: 1,
            restored: 0,
            restoredWithout: 1,
            keptChanged: 0,
            alreadyGone: 0,
            refused: 0,
            notKept: 0,
            reasons: [],
          },
        ],
      }),
    ).toBe(false);
    expect(
      rewindWroteNothing({
        ...NONE,
        recreated: [{ objectApiName: 'Contact', planned: 1, created: 1, refused: 0, reasons: [] }],
      }),
    ).toBe(false);
    expect(
      rewindWroteNothing({
        ...NONE,
        files: { unlinked: 0, relinked: 1, linksUpdated: 0, linksRefused: 0 },
      }),
    ).toBe(false);
  });
});
