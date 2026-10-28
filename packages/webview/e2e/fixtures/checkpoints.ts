import type {
  CheckpointListEntry,
  CheckpointPreviewResponse,
  CheckpointScopeResponse,
  ForgeUndoObjectResult,
  OrgCheckpoint,
  RewindDiffObject,
  RewindResult,
  SyncRestoreObjectResult,
  SyncUndeleteObjectResult,
} from '@sandforge/shared';
import { DEV_SANDBOX } from './mock-orgs';

/**
 * What the extension answers the Checkpoints page with, for the specs that
 * draw it in Chromium: the checkpoints a store lists for the dev sandbox, the
 * scope a take reads, what a rewind to one would do and what it did. The
 * shapes are the `checkpoint:*` contract's, typed against it, so a spec draws
 * only states the extension can send.
 *
 * Dates are counted from the moment the spec runs: the list says ages and
 * expiries relative to now, and a fixture dated once would read "in 2 days"
 * today and "3 months ago" later.
 */

const DAY = 86_400_000;

/** The instant `days` from now, as the store writes dates. */
export function daysFromNow(days: number): string {
  return new Date(Date.now() + days * DAY).toISOString();
}

/** The org every checkpoint here is of: the dev sandbox the specs connect first. */
export const CHECKPOINT_ORG = DEV_SANDBOX;

/** The user the checkpoints were taken as, by a fake Id. */
export const TAKEN_BY = '005xx0000010001AAA';

/** The users a preview names, by fake Id: two the org gave a name, one it did not. */
export const USERS = {
  alice: '005xx0000020001AAA',
  integration: '005xx0000020002AAA',
  unnamed: '005xx0000020003AAA',
} as const;

/** One object a checkpoint holds, children read first. */
function heldObject(
  objectApiName: string,
  records: number,
  readOrder: number,
  fields: string[],
  undeletable = true,
): OrgCheckpoint['objects'][number] {
  return {
    objectApiName,
    records,
    inBin: 0,
    readOrder,
    readMode: 'query',
    undeletable,
    cascadeParents: [],
    fingerprint: String(readOrder).repeat(64),
    fields,
    leftOutFields: [],
  };
}

/** A ready checkpoint of everything people work in the dev sandbox, taken two days ago. */
export function readyCheckpoint(overrides: Partial<OrgCheckpoint> = {}): OrgCheckpoint {
  return {
    version: 1,
    checkpointId: 'ck-before-uat',
    name: 'Before UAT',
    org: {
      organizationId: '00Dxx0000001234AAA',
      alias: CHECKPOINT_ORG.alias,
      username: CHECKPOINT_ORG.username,
      instanceUrl: CHECKPOINT_ORG.instanceUrl,
      isSandbox: true,
      organizationType: 'Enterprise Edition',
      tier: 'sandbox',
    },
    takenBy: { userId: TAKEN_BY, viewAllData: true, modifyAllData: true },
    readFrom: daysFromNow(-2),
    takenAt: daysFromNow(-2),
    scope: { mode: 'everything', leftOut: [] },
    objects: [
      heldObject('OpportunityLineItem', 12, 0, ['Id', 'SystemModstamp', 'Quantity'], false),
      heldObject('Contact', 2012, 1, ['Id', 'SystemModstamp', 'LastName', 'AccountId']),
      heldObject('Case', 30, 2, ['Id', 'SystemModstamp', 'Subject', 'Last_Touched__c']),
      heldObject('Account', 400, 3, ['Id', 'SystemModstamp', 'Name', 'Industry']),
    ],
    ignoredFields: [],
    snapshotId: 'op-snapshot-1',
    movedWhileTaken: { changed: 0, deleted: 0, created: 0 },
    bytes: 2_400_000,
    expiresAt: daysFromNow(28),
    status: 'ready',
    takenOn: { host: 'workstation', pid: 4242 },
    ...overrides,
  };
}

/** A checkpoint as the list shows it: one that can be rewound to, unless `overrides` says otherwise. */
export function listEntry(
  checkpoint: OrgCheckpoint | null,
  overrides: Partial<CheckpointListEntry> = {},
): CheckpointListEntry {
  return {
    checkpointId: checkpoint?.checkpointId ?? 'ck-damaged',
    organizationId: '00Dxx0000001234AAA',
    ...(checkpoint ? { checkpoint } : {}),
    valid: true,
    ...overrides,
  };
}

/**
 * Every line a list can say beneath its checkpoints, each once: one that
 * expires within days, with Keep; one older than the recycle bin keeps
 * records, the org's last rewind made to it, with Undo, kept until deleted;
 * one of the org before a refresh; and one whose file does not parse.
 */
export function everyListLine(): CheckpointListEntry[] {
  const expiring = readyCheckpoint({
    checkpointId: 'ck-expiring',
    name: 'Before demo',
    expiresAt: daysFromNow(2),
  });
  const rewound = readyCheckpoint({
    checkpointId: 'ck-rewound',
    name: 'Clean baseline',
    readFrom: daysFromNow(-20),
    takenAt: daysFromNow(-20),
    expiresAt: null,
    lastRewind: {
      rewindId: 'rw-last',
      endedAt: daysFromNow(-1),
      undoUntil: daysFromNow(14),
    },
  });
  const refreshed = readyCheckpoint({
    checkpointId: 'ck-refreshed',
    name: 'Before the refresh',
    readFrom: daysFromNow(-30),
    takenAt: daysFromNow(-30),
  });
  return [
    listEntry(expiring, { expiresSoon: true }),
    listEntry(rewound, {
      binReachSince: daysFromNow(-15),
      undo: { rewindId: 'rw-last', until: daysFromNow(14) },
    }),
    listEntry(refreshed, { valid: false, why: 'refreshed', refreshedAt: daysFromNow(-5) }),
    listEntry(null, { valid: false, why: 'damaged' }),
  ];
}

/** What `checkpoint:scope` answers for the dev sandbox: a few objects, one of a package. */
export function scopeAnswer(
  overrides: Partial<CheckpointScopeResponse['payload']> = {},
): CheckpointScopeResponse['payload'] {
  return {
    orgId: CHECKPOINT_ORG.id,
    mode: 'everything',
    objects: [
      {
        objectApiName: 'Account',
        label: 'Account',
        records: 400,
        undeletable: true,
        leftOutFields: [],
      },
      {
        objectApiName: 'Contact',
        label: 'Contact',
        records: 2012,
        undeletable: true,
        leftOutFields: [
          { field: 'SSN__c', reason: 'encrypted' },
          { field: 'Salary__c', reason: 'fls' },
          { field: 'Bonus__c', reason: 'fls' },
        ],
      },
      {
        objectApiName: 'OpportunityLineItem',
        label: 'Opportunity Product',
        records: 12,
        undeletable: false,
        leftOutFields: [],
      },
      {
        objectApiName: 'Campaign',
        label: 'Campaign',
        records: 0,
        undeletable: true,
        leftOutFields: [],
      },
      {
        objectApiName: 'vlocity_cmt__Party__c',
        label: 'Party',
        namespace: 'vlocity_cmt',
        records: 0,
        undeletable: true,
        leftOutFields: [],
      },
    ],
    leftOut: [
      { objectApiName: 'FeedItem', reason: 'Chatter posts are left out.' },
      { objectApiName: 'AccountHistory', reason: 'History is the audit trail.' },
    ],
    estimate: {
      records: 2424,
      apiRequests: 250,
      apiRequestsLeft: 14_997,
      seconds: 64,
      bytes: 2_400_000,
    },
    ...overrides,
  };
}

/** One object of a diff with nothing to do, unless `overrides` says otherwise. */
export function diffObject(
  objectApiName: string,
  overrides: Partial<Omit<RewindDiffObject, 'objectApiName'>> = {},
): RewindDiffObject {
  return {
    objectApiName,
    toDelete: { createdSince: 0, broughtBackSince: 0, comesBackWithParent: 0 },
    toGiveBack: { records: 0, fields: 0, clearedLookups: 0 },
    toBringBack: { inBin: 0, withParent: 0, deletedWhileTaken: 0 },
    cannotUndo: [],
    outside: [],
    touched: 0,
    unexplained: 0,
    lastChangedBy: {},
    notCompared: [],
    ...overrides,
  };
}

/**
 * What `checkpoint:preview` answers for a checkpoint of picked objects whose
 * rewind says every part of the preview once: each class of every number,
 * who changed what and who worked in the last hour (the checkpoint's own user
 * among them), what a rewind cannot undo, what Undo could not bring back,
 * an account it brings back for a moment, records outside the checkpoint its
 * deletes take along, an object it could not read, the fields the schema
 * lost, gained and changed, and the automation the org runs as it writes,
 * whose refusal the box lifts.
 */
export function previewOfEverything(checkpointId: string): CheckpointPreviewResponse['payload'] {
  return {
    diff: {
      checkpointId,
      previewId: 'pv-everything',
      readAt: daysFromNow(0),
      objects: [
        diffObject('OpportunityLineItem', {
          toDelete: { createdSince: 3, broughtBackSince: 0, comesBackWithParent: 0 },
          toBringBack: { inBin: 0, withParent: 2, deletedWhileTaken: 0 },
          cannotUndo: [{ reason: 'deletedWithParentOutside', count: 1 }],
          lastChangedBy: { [USERS.alice]: 3 },
        }),
        diffObject('Contact', {
          toDelete: { createdSince: 5, broughtBackSince: 1, comesBackWithParent: 2 },
          toGiveBack: { records: 2, fields: 3, clearedLookups: 1 },
          toBringBack: { inBin: 0, withParent: 0, deletedWhileTaken: 1 },
          toRecreate: 2,
          cannotUndo: [{ reason: 'deletedWithCreatedParent', count: 3 }],
          touched: 4,
          unexplained: 1,
          lastChangedBy: { [USERS.alice]: 5, [USERS.unnamed]: 2 },
        }),
        diffObject('Case', {
          toGiveBack: { records: 12, fields: 12, clearedLookups: 0 },
          lastChangedBy: { [USERS.integration]: 12 },
          schemaDrift: {
            removed: ['Region__c'],
            added: ['Priority_Score__c'],
            changed: ['Origin'],
          },
          notCompared: ['Last_Touched__c'],
        }),
        diffObject('Account', {
          toDelete: { createdSince: 3, broughtBackSince: 0, comesBackWithParent: 0 },
          toGiveBack: { records: 4, fields: 9, clearedLookups: 0 },
          toBringBack: { inBin: 1, withParent: 0, deletedWhileTaken: 0, carriers: 1 },
          cannotUndo: [{ reason: 'goneForGood', count: 2 }],
          outside: [{ objectApiName: 'Opportunity', count: 50, parents: 3 }],
          lastChangedBy: { [USERS.alice]: 3, [USERS.integration]: 4 },
        }),
        diffObject('Lead', { cannotUndo: [{ reason: 'convertedLead', count: 1 }] }),
        diffObject('Contract', { cannotUndo: [{ reason: 'activatedContract', count: 1 }] }),
      ],
      undoCannot: [{ objectApiName: 'OpportunityLineItem', count: 3 }],
      unread: [{ objectApiName: 'Asset', reason: 'the org stopped answering while it was read' }],
      userNames: { [USERS.alice]: 'Alice Martin', [USERS.integration]: 'Integration User' },
      activeLastHour: [USERS.alice, TAKEN_BY],
    },
    automation: {
      objectsRead: ['OpportunityLineItem', 'Contact', 'Case', 'Account'],
      objects: [
        {
          objectApiName: 'Account',
          flows: [],
          triggers: [{ name: 'AccountRestore', events: ['afterUndelete'] }],
        },
        {
          objectApiName: 'Case',
          flows: [],
          triggers: [{ name: 'CaseTouch', events: ['beforeUpdate'] }],
        },
      ],
      unread: [],
      conditionsNotRead: 0,
      conditionsBound: 25,
      requests: 4,
    },
    estimate: { records: 39, apiRequests: 140, apiRequestsLeft: 14_900, seconds: 38, bytes: 0 },
    refusal: {
      code: 'AUTOMATION',
      message:
        'Rewinding updates 12 Cases: trigger CaseTouch runs before each update. Tick the box to rewind even so.',
    },
  };
}

/** What `checkpoint:preview` answers for a rewind of Accounts and Contacts with nothing else to say. */
export function plainPreview(
  checkpointId: string,
  previewId: string,
): CheckpointPreviewResponse['payload'] {
  return {
    diff: {
      checkpointId,
      previewId,
      readAt: daysFromNow(0),
      objects: [
        diffObject('Contact', {
          toDelete: { createdSince: 5, broughtBackSince: 0, comesBackWithParent: 0 },
          toGiveBack: { records: 2, fields: 3, clearedLookups: 0 },
          lastChangedBy: { [USERS.alice]: 7 },
        }),
        diffObject('Account', {
          toDelete: { createdSince: 3, broughtBackSince: 0, comesBackWithParent: 0 },
          toGiveBack: { records: 4, fields: 9, clearedLookups: 0 },
          toBringBack: { inBin: 1, withParent: 0, deletedWhileTaken: 0 },
          lastChangedBy: { [USERS.alice]: 7 },
        }),
      ],
      undoCannot: [],
      unread: [],
      userNames: { [USERS.alice]: 'Alice Martin' },
      activeLastHour: [],
    },
    automation: {
      objectsRead: ['Contact', 'Account'],
      objects: [],
      unread: [],
      conditionsNotRead: 0,
      conditionsBound: 25,
      requests: 3,
    },
    estimate: { records: 15, apiRequests: 120, apiRequestsLeft: 14_900, seconds: 38, bytes: 0 },
  };
}

/**
 * What `checkpoint:preview` answers for a checkpoint that holds files, of
 * picked objects, without Query All Files: a file attached since to an
 * account deleted, one deleted since brought back, one renamed given its
 * title back, one given a new version since; the links between files and
 * records that stay — added, removed and changed since — two files no record
 * of the checkpoint links to, kept, one left in the recycle bin, a file to
 * delete attached outside the checkpoint too, and the file storage against
 * what the org has left.
 */
export function previewWithFiles(checkpointId: string): CheckpointPreviewResponse['payload'] {
  const MB = 1_048_576;
  return {
    diff: {
      checkpointId,
      previewId: 'pv-files',
      readAt: daysFromNow(0),
      objects: [
        diffObject('Account', {
          toDelete: { createdSince: 1, broughtBackSince: 0, comesBackWithParent: 0 },
          lastChangedBy: { [USERS.alice]: 1 },
        }),
        diffObject('ContentDocument', {
          toDelete: { createdSince: 2, broughtBackSince: 0, comesBackWithParent: 0 },
          toGiveBack: { records: 1, fields: 1, clearedLookups: 0 },
          toBringBack: { inBin: 1, withParent: 0, deletedWhileTaken: 0 },
          cannotUndo: [{ reason: 'newFileVersion', count: 1 }],
          outside: [{ objectApiName: 'ContentDocumentLink', count: 2, parents: 1 }],
          lastChangedBy: { [USERS.alice]: 3 },
        }),
        diffObject('Attachment', {
          toDelete: { createdSince: 1, broughtBackSince: 0, comesBackWithParent: 0 },
          toBringBack: { inBin: 1, withParent: 0, deletedWhileTaken: 0 },
          lastChangedBy: { [USERS.alice]: 2 },
        }),
      ],
      undoCannot: [],
      unread: [],
      userNames: { [USERS.alice]: 'Alice Martin' },
      activeLastHour: [],
      files: {
        unlink: 1,
        relink: 1,
        updateLinks: 1,
        outsideAdded: 2,
        outsideDeleted: 1,
        storage: { bringBack: 12 * MB, remaining: 40 * MB, undo: 3 * MB },
        blindSpot: true,
      },
    },
    automation: {
      objectsRead: ['Account', 'ContentDocument', 'Attachment', 'ContentDocumentLink'],
      objects: [],
      unread: [],
      conditionsNotRead: 0,
      conditionsBound: 25,
      requests: 3,
    },
    estimate: { records: 9, apiRequests: 40, apiRequestsLeft: 14_900, seconds: 12, bytes: 0 },
  };
}

/** A preview of an org that holds its checkpoint's state: nothing to rewind. */
export function nothingToRewind(checkpointId: string): CheckpointPreviewResponse['payload'] {
  return {
    diff: {
      checkpointId,
      previewId: 'pv-nothing',
      readAt: daysFromNow(0),
      objects: [diffObject('Contact', { touched: 3 })],
      undoCannot: [],
      unread: [],
      userNames: {},
      activeLastHour: [],
    },
    estimate: { records: 0, apiRequests: 0, apiRequestsLeft: 14_900, seconds: 0, bytes: 0 },
  };
}

/** A preview with nothing a rewind could write, and records it could not take back. */
export function nothingToWrite(checkpointId: string): CheckpointPreviewResponse['payload'] {
  return {
    diff: {
      checkpointId,
      previewId: 'pv-nothing-to-write',
      readAt: daysFromNow(0),
      objects: [diffObject('Contact', { cannotUndo: [{ reason: 'goneForGood', count: 4 }] })],
      undoCannot: [],
      unread: [],
      userNames: {},
      activeLastHour: [],
    },
    estimate: { records: 0, apiRequests: 0, apiRequestsLeft: 14_900, seconds: 0, bytes: 0 },
  };
}

/** What a rewind deleted of one object, nothing left unless `overrides` says so. */
export function deletedObject(
  objectApiName: string,
  overrides: Partial<Omit<ForgeUndoObjectResult, 'objectApiName'>> = {},
): ForgeUndoObjectResult {
  return {
    objectApiName,
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

/** What a rewind gave back of one object, nothing left unless `overrides` says so. */
export function restoredObject(
  objectApiName: string,
  overrides: Partial<Omit<SyncRestoreObjectResult, 'objectApiName'>> = {},
): SyncRestoreObjectResult {
  return {
    objectApiName,
    planned: 0,
    restored: 0,
    keptChanged: 0,
    alreadyGone: 0,
    refused: 0,
    notKept: 0,
    reasons: [],
    ...overrides,
  };
}

/** What a rewind brought back of one object, nothing left unless `overrides` says so. */
export function undeletedObject(
  objectApiName: string,
  overrides: Partial<Omit<SyncUndeleteObjectResult, 'objectApiName'>> = {},
): SyncUndeleteObjectResult {
  return {
    objectApiName,
    planned: 0,
    undeleted: 0,
    alreadyBack: 0,
    goneForGood: 0,
    refused: 0,
    reasons: [],
    ...overrides,
  };
}

/**
 * What a rewind of {@link plainPreview} did: everything, read again with
 * nothing that differs, undoable for fifteen days.
 */
export function rewindResult(
  checkpointId: string,
  overrides: Partial<RewindResult> = {},
): RewindResult {
  return {
    checkpointId,
    rewindId: 'rw-new',
    status: 'success',
    deleted: [
      deletedObject('Contact', { planned: 5, deleted: 5 }),
      deletedObject('Account', { planned: 3, deleted: 3 }),
    ],
    restored: [
      restoredObject('Account', { planned: 4, restored: 4 }),
      restoredObject('Contact', { planned: 2, restored: 2 }),
    ],
    undeleted: [undeletedObject('Account', { planned: 1, undeleted: 1 })],
    residual: [],
    passes: 1,
    undo: { until: daysFromNow(15), cannot: [] },
    apiRequests: { used: 96, leftToday: 14_804 },
    finishedAt: daysFromNow(0),
    ...overrides,
  };
}

/**
 * A partial rewind that says every reason a record still differs, each with
 * its object, and what it did in each of its three parts, something left in
 * each: brought back but one gone for good, given back but one changed by
 * someone else, deleted but one kept for a record that hangs from it.
 */
export function partialOfEveryReason(checkpointId: string): RewindResult {
  return rewindResult(checkpointId, {
    status: 'partial',
    passes: 2,
    deleted: [
      deletedObject('Contact', { planned: 5, deleted: 4, keptDependents: 1 }),
      deletedObject('Account', { planned: 3, deleted: 3 }),
    ],
    restored: [
      restoredObject('Account', { planned: 4, restored: 3, keptChanged: 1 }),
      restoredObject('Case', { planned: 12, restored: 12 }),
    ],
    undeleted: [undeletedObject('Account', { planned: 2, undeleted: 1, goneForGood: 1 })],
    residual: [
      { objectApiName: 'Case', reason: 'automation', count: 12, ids: [] },
      {
        objectApiName: 'Account',
        reason: 'changedDuringRewind',
        by: USERS.alice,
        count: 1,
        ids: [],
      },
      { objectApiName: 'Contact', reason: 'changedSincePreview', count: 2, ids: [] },
      { objectApiName: 'Account', reason: 'notInBin', count: 2, ids: [] },
      {
        objectApiName: 'Lead',
        reason: 'refused',
        count: 2,
        ids: [],
        message: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Close date must be in the future',
      },
      { objectApiName: 'Account', reason: 'goneForGood', count: 1, ids: [] },
      {
        objectApiName: 'Contact',
        reason: 'kept',
        count: 1,
        ids: [],
        message: 'A Case the checkpoint holds still looks up to it.',
      },
    ],
    undo: { until: daysFromNow(15), cannot: [{ objectApiName: 'OpportunityLineItem', count: 3 }] },
  });
}

/** The result of an undo: no Undo of its own, unless `overrides` says otherwise. */
export function undoResult(
  checkpointId: string,
  overrides: Partial<RewindResult> = {},
): RewindResult {
  const result = rewindResult(checkpointId, {
    rewindId: 'rw-last',
    deleted: [deletedObject('Account', { planned: 1, deleted: 1 })],
    restored: [restoredObject('Account', { planned: 4, restored: 4 })],
    undeleted: [undeletedObject('Contact', { planned: 5, undeleted: 5 })],
    ...overrides,
  });
  if (!('undo' in overrides)) delete result.undo;
  return result;
}
