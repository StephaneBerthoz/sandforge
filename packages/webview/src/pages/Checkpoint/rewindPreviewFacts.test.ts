import { describe, expect, it } from 'vitest';
import {
  automationObjects,
  cannotUndoLines,
  carriersOf,
  carriersTotal,
  changedDuringRewind,
  comparableFields,
  deletedStatus,
  filesBroughtBack,
  filesLeft,
  heldAsItWas,
  ignoredAfter,
  isIgnored,
  keptChangedSinceRewind,
  lastChangers,
  linkWrites,
  outsideLines,
  recreateLines,
  remadeDeleted,
  residualGroups,
  residualTotal,
  rewindPhases,
  rewindSteps,
  rewindTotals,
  rewindWrites,
  rowOf,
  unseenChildren,
} from './rewindPreviewFacts';
import {
  USERS,
  deletedObject,
  diffObject,
  filesDiff,
  previewDiff,
  restoredObject,
  rewindResult,
} from './testing/checkpointFixtures';

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
      toRecreate: 0,
      cannotUndo: 5,
    });
    expect(rowOf(diffObject('Contact', { toRecreate: 3 })).toRecreate).toBe(3);
  });

  it('adds the objects into the three numbers, and a rewind writes when one is above zero', () => {
    const diff = previewDiff();
    expect(rewindTotals(diff)).toEqual({
      toDelete: 8,
      toGiveBack: 6,
      toBringBack: 1,
      toRecreate: 0,
    });
    expect(rewindWrites(diff)).toBe(true);
    // Records to make again with new Ids are writes too, on their own.
    expect(rewindWrites(previewDiff({ objects: [diffObject('Account', { toRecreate: 1 })] }))).toBe(
      true,
    );
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
    // Hidden, or either: not compared, so not known to hold its values.
    expect(
      differs(
        diffObject('Account', {
          schemaDrift: { removed: [], added: [], changed: [], hidden: ['Rating'] },
        }),
      ),
    ).toBe(false);
    expect(
      differs(
        diffObject('Account', {
          schemaDrift: { removed: [], added: [], changed: [], uncertain: { fields: ['Tier__c'] } },
        }),
      ),
    ).toBe(false);
    expect(
      heldAsItWas(
        previewDiff({ objects: [], unread: [{ objectApiName: 'Case', reason: 'Refused.' }] }),
      ),
    ).toBe(false);
    expect(heldAsItWas(previewDiff())).toBe(false);
  });

  it('counts a link between a file and a record among a rewind’s writes, on its own, and none for a checkpoint that holds no files', () => {
    const links = (files: Partial<NonNullable<ReturnType<typeof filesDiff>['files']>>) =>
      filesDiff({
        unlink: 0,
        relink: 0,
        updateLinks: 0,
        outsideAdded: 0,
        outsideDeleted: 0,
        ...files,
      });
    const quiet = (diff: ReturnType<typeof filesDiff>) => ({ ...diff, objects: [] });
    expect(linkWrites(filesDiff())).toBe(4);
    for (const one of [{ unlink: 1 }, { relink: 1 }, { updateLinks: 1 }]) {
      expect(rewindWrites(quiet(links(one)))).toBe(true);
    }
    expect(rewindWrites(quiet(links({})))).toBe(false);
    expect(linkWrites(previewDiff())).toBe(0);
  });

  it('does not hold the org as it was while files no record of the checkpoint links to were added or deleted since, which a rewind leaves', () => {
    const files = (outsideAdded: number, outsideDeleted: number) => ({
      ...filesDiff({ unlink: 0, relink: 0, updateLinks: 0, outsideAdded, outsideDeleted }),
      objects: [],
    });
    expect(filesLeft(files(2, 1))).toBe(3);
    expect(heldAsItWas(files(0, 0))).toBe(true);
    expect(heldAsItWas(files(1, 0))).toBe(false);
    expect(heldAsItWas(files(0, 1))).toBe(false);
    expect(filesLeft(previewDiff())).toBe(0);
  });

  it('names the link between a file and a record among what each step writes, as the rewind lists it: removed a delete, put back an insert, given its sharing back an update', () => {
    expect(rewindSteps(filesDiff())).toEqual({
      bringBack: ['ContentDocument'],
      recreate: ['ContentDocumentLink'],
      giveBack: ['ContentDocument', 'ContentDocumentLink'],
      delete: ['Account', 'ContentDocument', 'ContentDocumentLink'],
    });
    expect(rewindSteps(previewDiff()).delete).not.toContain('ContentDocumentLink');
  });

  it('counts the files a rewind brings back from the recycle bin, those its storage is measured on', () => {
    expect(filesBroughtBack(filesDiff())).toBe(1);
    expect(filesBroughtBack(previewDiff())).toBe(0);
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

  it('says the records deleted with their parent, of an object the checkpoint does not hold, beside those deleted with a parent created since', () => {
    const diff = previewDiff({
      objects: [
        diffObject('Contact', {
          cannotUndo: [
            { reason: 'deletedWithParentOutside', count: 2 },
            { reason: 'deletedWithCreatedParent', count: 1 },
          ],
        }),
        diffObject('Case', { cannotUndo: [{ reason: 'deletedWithParentOutside', count: 1 }] }),
      ],
    });
    expect(cannotUndoLines(diff)).toEqual([
      { reason: 'deletedWithCreatedParent', count: 1, objects: ['Contact'] },
      { reason: 'deletedWithParentOutside', count: 3, objects: ['Contact', 'Case'] },
    ]);
  });

  it('says, read object by object, what another user deleted and what is out of reach, after what a parent of another object keeps', () => {
    const diff = previewDiff({
      objects: [
        diffObject('OpportunityLineItem', { cannotUndo: [{ reason: 'outOfReach', count: 2 }] }),
        diffObject('Account', {
          cannotUndo: [
            { reason: 'deletedByOther', count: 1 },
            { reason: 'deletedWithParentOutside', count: 1 },
          ],
        }),
      ],
    });
    expect(cannotUndoLines(diff)).toEqual([
      { reason: 'deletedWithParentOutside', count: 1, objects: ['Account'] },
      { reason: 'deletedByOther', count: 1, objects: ['Account'] },
      { reason: 'outOfReach', count: 2, objects: ['OpportunityLineItem'] },
    ]);
  });

  it('says the files given a new version since, which keep it, last of what a rewind cannot undo', () => {
    const diff = previewDiff({
      objects: [
        diffObject('ContentDocument', {
          cannotUndo: [
            { reason: 'goneForGood', count: 1 },
            { reason: 'newFileVersion', count: 2 },
          ],
        }),
      ],
    });
    expect(cannotUndoLines(diff)).toEqual([
      { reason: 'goneForGood', count: 1, objects: ['ContentDocument'] },
      { reason: 'newFileVersion', count: 2, objects: ['ContentDocument'] },
    ]);
  });

  it('counts the records brought back for a moment, in none of the three numbers, and a rewind of them writes: brought back, then deleted again', () => {
    const diff = previewDiff({
      objects: [
        diffObject('Account', {
          toBringBack: { inBin: 0, withParent: 0, deletedWhileTaken: 0, carriers: 2 },
        }),
        diffObject('Contact', {
          toBringBack: { inBin: 0, withParent: 2, deletedWhileTaken: 0 },
          toGiveBack: { records: 2, fields: 2, clearedLookups: 0 },
        }),
      ],
    });
    expect(carriersOf(diff.objects[0])).toBe(2);
    expect(carriersOf(diffObject('Account', {}))).toBe(0);
    expect(carriersTotal(diff)).toBe(2);
    expect(rewindTotals(diff)).toEqual({
      toDelete: 0,
      toGiveBack: 2,
      toBringBack: 2,
      toRecreate: 0,
    });
    expect(
      rewindWrites(
        previewDiff({
          objects: [
            diffObject('Account', {
              toBringBack: { inBin: 0, withParent: 0, deletedWhileTaken: 0, carriers: 1 },
            }),
          ],
        }),
      ),
    ).toBe(true);
    // What the org runs on them is read and listed: the rewind brings them
    // back and deletes them, and is refused for it without the box.
    expect(rewindSteps(diff)).toEqual({
      bringBack: ['Account', 'Contact'],
      recreate: [],
      giveBack: ['Contact'],
      delete: ['Account'],
    });
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

  it('names once each object whose records the deletions take along out of the user’s sight, in the order the diff first names it', () => {
    expect(
      unseenChildren(
        previewDiff({
          unseen: [
            { objectApiName: 'Contact', children: ['Event', 'Task'], records: 5 },
            { objectApiName: 'Account', children: ['Task', 'acme__Visit__c'], records: 1 },
          ],
        }),
      ),
    ).toEqual(['Event', 'Task', 'acme__Visit__c']);
    // Read with View All Data and Modify All Data, or before they were told.
    expect(unseenChildren(previewDiff())).toEqual([]);
  });

  it('names the objects each step of a rewind writes: brought back, given back, deleted', () => {
    expect(rewindSteps(previewDiff())).toEqual({
      bringBack: ['Account'],
      recreate: [],
      giveBack: ['Contact', 'Account'],
      delete: ['Contact', 'Account'],
    });
    expect(
      rewindSteps(previewDiff({ objects: [diffObject('Account', { toRecreate: 2 })] })).recreate,
    ).toEqual(['Account']);
  });

  it('names the records to make again with new Ids, object by object, only the objects that have some', () => {
    expect(
      recreateLines(
        previewDiff({
          objects: [diffObject('Account', { toRecreate: 2 }), diffObject('Contact', {})],
        }),
      ),
    ).toEqual([{ objectApiName: 'Account', count: 2 }]);
  });
});

describe('what a rewind did', () => {
  it('lists the phases of a rewind in the order it runs them, with the records each acts on, and the check last', () => {
    expect(rewindPhases(previewDiff())).toEqual([
      { phase: 'bringBack', count: 1 },
      { phase: 'giveBack', count: 6 },
      { phase: 'delete', count: 8 },
      { phase: 'check', count: 0 },
    ]);
  });

  it('lists the links between files and records a rewind writes as a phase of their own, before it deletes', () => {
    expect(rewindPhases(filesDiff())).toEqual([
      { phase: 'bringBack', count: 1 },
      { phase: 'giveBack', count: 1 },
      { phase: 'links', count: 4 },
      { phase: 'delete', count: 2 },
      { phase: 'check', count: 0 },
    ]);
  });

  it('leaves out a phase the confirmed preview gave nothing to', () => {
    const diff = previewDiff({
      objects: [
        diffObject('Account', {
          toGiveBack: { records: 2, fields: 2, clearedLookups: 0 },
        }),
      ],
    });
    expect(rewindPhases(diff).map((line) => line.phase)).toEqual(['giveBack', 'check']);
  });

  it('groups what still differs by why, the reasons the user can act on first, only those that apply', () => {
    const result = rewindResult({
      residual: [
        { objectApiName: 'Case', reason: 'goneForGood', count: 2, ids: [] },
        { objectApiName: 'Case', reason: 'automation', count: 12, ids: [] },
        { objectApiName: 'Account', reason: 'automation', count: 3, ids: [] },
        { objectApiName: 'Lead', reason: 'refused', count: 0, ids: [] },
        {
          objectApiName: 'Contact',
          reason: 'kept',
          count: 4,
          ids: [],
          message:
            'Kept: records outside the checkpoint hang from them, and you did not ask to delete those.',
        },
      ],
    });
    expect(residualTotal(result)).toBe(21);
    expect(
      residualGroups(result).map((group) => [group.reason, group.total, group.residuals.length]),
    ).toEqual([
      ['automation', 15, 2],
      ['kept', 4, 1],
      ['goneForGood', 2, 1],
    ]);
    expect(automationObjects(result)).toEqual(['Case', 'Account']);
  });

  it('names what the org answered is no longer in the recycle bin before what it refused: a tick and a rewind make it again', () => {
    const result = rewindResult({
      residual: [
        { objectApiName: 'Lead', reason: 'refused', count: 1, ids: [] },
        { objectApiName: 'Account', reason: 'notInBin', count: 2, ids: [] },
        { objectApiName: 'Case', reason: 'changedSincePreview', count: 1, ids: [] },
      ],
    });
    expect(residualGroups(result).map((group) => group.reason)).toEqual([
      'changedSincePreview',
      'notInBin',
      'refused',
    ]);
  });

  it('counts, of what an undo deleted, the records the rewind made again, the others gone with a record it deleted', () => {
    const deleted = [
      deletedObject('Account', { planned: 3, deleted: 3 }),
      deletedObject('Contact', { planned: 3, deleted: 1, alreadyGone: 2 }),
    ];
    expect(remadeDeleted({ deleted })).toBe(0);
    expect(
      remadeDeleted({
        deleted,
        remade: [
          { objectApiName: 'Account', count: 2 },
          { objectApiName: 'Contact', count: 3 },
        ],
      }),
    ).toBe(3);
  });

  it('names who changed records during the rewind, the most first, by the names the preview read', () => {
    const result = rewindResult({
      status: 'unstable',
      residual: [
        {
          objectApiName: 'Case',
          reason: 'changedDuringRewind',
          by: USERS.unnamed,
          count: 2,
          ids: [],
        },
        {
          objectApiName: 'Case',
          reason: 'changedDuringRewind',
          by: USERS.alice,
          count: 9,
          ids: [],
        },
        {
          objectApiName: 'Account',
          reason: 'changedDuringRewind',
          by: USERS.alice,
          count: 5,
          ids: [],
        },
        { objectApiName: 'Account', reason: 'refused', count: 1, ids: [] },
      ],
    });
    expect(changedDuringRewind(result, { [USERS.alice]: 'Alice Martin' })).toEqual([
      { userId: USERS.alice, name: 'Alice Martin', count: 14 },
      { userId: USERS.unnamed, count: 2 },
    ]);
  });

  it('says how the deletions ended from what each object left, apart from the whole run', () => {
    const all = [deletedObject('Contact', { planned: 5, deleted: 5 })];
    // Every record added since went, while a field the automation set again
    // made the rewind partial.
    expect(deletedStatus(all, 'partial')).toBe('success');
    const kept = [
      deletedObject('Contact', { planned: 5, deleted: 3, keptChanged: 1, keptDependents: 1 }),
    ];
    expect(deletedStatus(kept, 'unstable')).toBe('partial');
    const none = [deletedObject('Contact', { planned: 2, refused: 2 })];
    expect(deletedStatus(none, 'partial')).toBe('failure');
    expect(deletedStatus(all, 'cancelled')).toBe('cancelled');
    const hidden = [deletedObject('Contact', { planned: 2, deleted: 1, notVisible: 1 })];
    expect(deletedStatus(hidden, 'success')).toBe('partial');
  });

  it('counts what an undo left as changed since the rewind, deleted and given back alike', () => {
    const result = rewindResult({
      deleted: [deletedObject('Account', { planned: 2, deleted: 1, keptChanged: 1 })],
      restored: [restoredObject('Contact', { planned: 5, restored: 2, keptChanged: 3 })],
    });
    expect(keptChangedSinceRewind(result)).toBe(4);
  });
});

describe('the fields a checkpoint compares', () => {
  const object = {
    objectApiName: 'Case',
    fields: [
      'Id',
      'SystemModstamp',
      'CreatedDate',
      'CreatedById',
      'LastModifiedDate',
      'LastModifiedById',
      'Subject',
      'Last_Touched__c',
    ],
  };

  it('offers the values a rewind compares, never the stamps nor the person flag', () => {
    expect(comparableFields(object)).toEqual(['Case.Subject', 'Case.Last_Touched__c']);
    expect(
      comparableFields({ objectApiName: 'Account', fields: ['Id', 'IsPersonAccount', 'Name'] }),
    ).toEqual(['Account.Name']);
  });

  it('reads a field left out whatever its case, as the extension does', () => {
    expect(isIgnored('Case.Last_Touched__c', ['case.last_touched__c'])).toBe(true);
    expect(isIgnored('Case.Subject', ['Case.Last_Touched__c'])).toBe(false);
  });

  it('keeps the fields left out of the objects not offered, and takes the choice for those offered', () => {
    const ignored = ['Account.Score__c', 'case.subject'];
    const shown = comparableFields(object);
    expect(ignoredAfter(ignored, shown, new Set(['Case.Last_Touched__c']))).toEqual([
      'Account.Score__c',
      'Case.Last_Touched__c',
    ]);
    expect(ignoredAfter(ignored, shown, new Set())).toEqual(['Account.Score__c']);
  });
});
