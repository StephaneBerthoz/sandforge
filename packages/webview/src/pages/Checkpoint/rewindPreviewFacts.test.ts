import { describe, expect, it } from 'vitest';
import {
  cannotUndoLines,
  heldAsItWas,
  lastChangers,
  outsideLines,
  rewindSteps,
  rewindTotals,
  rewindWrites,
  rowOf,
} from './rewindPreviewFacts';
import { USERS, diffObject, previewDiff } from './testing/checkpointFixtures';

describe('rewindPreviewFacts', () => {
  it('counts in an object’s columns every class the diff tells of it', () => {
    const row = rowOf(
      diffObject('Contact', {
        toDelete: { createdSince: 5, broughtBackSince: 2, comesBackWithParent: 1 },
        toGiveBack: { records: 4, fields: 11, clearedLookups: 3 },
        toBringBack: { inBin: 6, withParent: 7, deletedWhileTaken: 1 },
        cannotUndo: [
          { reason: 'goneForGood', count: 2 },
          { reason: 'deletedWithCreatedParent', count: 3 },
        ],
      }),
    );
    expect(row).toEqual({
      objectApiName: 'Contact',
      toDelete: 8,
      // Cleared lookups are records given back already: counted once.
      toGiveBack: 4,
      toBringBack: 14,
      cannotUndo: 5,
    });
  });

  it('adds the objects into the three numbers, and a rewind writes when one is above zero', () => {
    const diff = previewDiff();
    expect(rewindTotals(diff)).toEqual({ toDelete: 8, toGiveBack: 6, toBringBack: 1 });
    expect(rewindWrites(diff)).toBe(true);
    expect(rewindWrites(previewDiff({ objects: [diffObject('Account', { touched: 3 })] }))).toBe(
      false,
    );
  });

  it('holds the org as it was when nothing differs, a touched record and a field added since aside', () => {
    expect(heldAsItWas(previewDiff({ objects: [] }))).toBe(true);
    expect(
      heldAsItWas(
        previewDiff({
          objects: [
            diffObject('Account', {
              touched: 4,
              schemaDrift: { removed: [], added: ['Region__c'], changed: [] },
            }),
          ],
        }),
      ),
    ).toBe(true);
  });

  it('does not hold the org as it was when something is left differing or unread', () => {
    const differs = (object: ReturnType<typeof diffObject>) =>
      heldAsItWas(previewDiff({ objects: [object] }));
    expect(differs(diffObject('Account', { unexplained: 1 }))).toBe(false);
    expect(
      differs(diffObject('Account', { cannotUndo: [{ reason: 'goneForGood', count: 1 }] })),
    ).toBe(false);
    expect(
      differs(
        diffObject('Account', { schemaDrift: { removed: ['Region__c'], added: [], changed: [] } }),
      ),
    ).toBe(false);
    expect(
      heldAsItWas(
        previewDiff({ objects: [], unread: [{ objectApiName: 'Case', reason: 'Refused.' }] }),
      ),
    ).toBe(false);
    expect(heldAsItWas(previewDiff())).toBe(false);
  });

  it('names who last changed the records, every object together, the most first, by Id when unnamed', () => {
    expect(lastChangers(previewDiff())).toEqual([
      { userId: USERS.alice, name: 'Alice Martin', count: 8 },
      { userId: USERS.integration, name: 'Integration User', count: 4 },
      { userId: USERS.unnamed, count: 2 },
    ]);
  });

  it('says what a rewind cannot undo by reason, with the objects each is of', () => {
    const diff = previewDiff({
      objects: [
        diffObject('Contact', { cannotUndo: [{ reason: 'goneForGood', count: 3 }] }),
        diffObject('Lead', { cannotUndo: [{ reason: 'convertedLead', count: 1 }] }),
        diffObject('Account', {
          cannotUndo: [
            { reason: 'goneForGood', count: 2 },
            { reason: 'activatedContract', count: 0 },
          ],
        }),
      ],
    });
    expect(cannotUndoLines(diff)).toEqual([
      { reason: 'goneForGood', count: 5, objects: ['Contact', 'Account'] },
      { reason: 'convertedLead', count: 1, objects: ['Lead'] },
    ]);
  });

  it('lists what the deletions take along outside the checkpoint, under the object they hang from', () => {
    const diff = previewDiff({
      objects: [
        diffObject('Account', {
          toDelete: { createdSince: 3, broughtBackSince: 0, comesBackWithParent: 0 },
          outside: [
            { objectApiName: 'Opportunity', count: 50, parents: 3 },
            { objectApiName: 'Case', count: 0, parents: 0 },
          ],
        }),
      ],
    });
    expect(outsideLines(diff)).toEqual([
      { objectApiName: 'Account', outside: 'Opportunity', count: 50, parents: 3 },
    ]);
  });

  it('names the objects each step of a rewind writes: brought back, given back, deleted', () => {
    expect(rewindSteps(previewDiff())).toEqual({
      bringBack: ['Account'],
      giveBack: ['Contact', 'Account'],
      delete: ['Contact', 'Account'],
    });
  });
});
