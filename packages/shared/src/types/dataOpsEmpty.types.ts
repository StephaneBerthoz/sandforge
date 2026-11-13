/**
 * The contract of an emptying — DataOps Cleanup's "Empty objects" and "Empty
 * the org" — between the extension and whoever asks for one: what it reads,
 * what its dry run says, what a run and its undo did.
 *
 * An emptying deletes every record of the objects picked, or of every object
 * people work in, less what is never touched. It refuses a production org
 * whatever is set, says everything before it deletes anything, keeps a
 * journal on this machine, and its Undo brings the records back from the
 * recycle bin while the bin holds them — never after a delete for good.
 */

import type { GuardTier } from '../utils/org-kind.js';
import type { MutedAutomation } from '../utils/automation-mute.js';
import type { RunCheckpointEstimate, RunCheckpointInfo } from './checkpoint.types.js';

/** The objects picked, or every object people work in. */
export type DataOpsEmptyMode = 'objects' | 'org';

/**
 * Where deleted records go: the recycle bin, from which an undo brings them
 * back while it holds them; or nowhere, deleted for good with what goes
 * along, which no undo brings back.
 */
export type DataOpsEmptyDeleteMode = 'recycle' | 'hard';

/** What a person asks an emptying to delete. */
export interface DataOpsEmptyScopeRequest {
  mode: DataOpsEmptyMode;
  /** In `objects` mode, the objects picked. */
  objects?: string[];
  /** In `org` mode, the objects left out by name. */
  excluded?: string[];
  /** In `org` mode, whether custom settings are emptied: not unless asked. */
  customSettings?: boolean;
  /** In `org` mode, whether files and attachments are emptied: not unless asked. */
  files?: boolean;
  /** In `org` mode, whether the objects of managed packages are emptied: not unless asked. */
  managedPackages?: boolean;
  /**
   * In `org` mode, whether the objects whose records no undelete brings back
   * on their own are emptied by passes of their own: not unless asked.
   */
  unrestorable?: boolean;
}

/** Why an emptying leaves an object out. */
export type DataOpsEmptyLeftOutReason =
  /** The org's configuration kept as records: its flows, orchestrations, settings and definitions. */
  | 'configuration'
  /** Its records cannot come back from the recycle bin on their own, not asked for. */
  | 'notRestorable'
  | 'excludedByUser'
  | 'notFound'
  | 'chatter'
  | 'history'
  | 'sharing'
  | 'changeEvent'
  | 'unsupportedKind'
  | 'customSetting'
  | 'files'
  | 'managedPackage'
  | 'documents'
  | 'heldWithFiles'
  | 'setup'
  | 'platformCreated'
  | 'metadata'
  | 'notDeletable'
  | 'notDescribed'
  | 'noRecycleBin'
  | 'notForGood';

/** An object an emptying leaves out, with why. */
export interface DataOpsEmptyLeftOut {
  objectApiName: string;
  reason: DataOpsEmptyLeftOutReason;
  /** The org's own words, where it gave any. */
  detail?: string;
}

/** A number the org gave, or why it gave none: a table it would not count is never an empty one. */
export interface DataOpsEmptyCounted {
  records?: number;
  /** The org's words, when it gave no number. */
  unread?: string;
  /** The statement may count more than it names. */
  atMost?: true;
  /** A difference whose second count may count more: there may be more. */
  atLeast?: true;
}

/** One pass of an emptying's dry run: an object emptied, in the order the run takes them. */
export interface DataOpsEmptyPreviewPass {
  objectApiName: string;
  /** Its records the emptying deletes, every pass together. */
  records: DataOpsEmptyCounted;
  /** Of them, those its own pass sends: the rest go with an object whose pass comes before. */
  sent: DataOpsEmptyCounted;
  /** Of a task or an event, those archived. */
  archived?: DataOpsEmptyCounted;
  /** Rows kept whatever is asked: the standard price book. */
  kept?: DataOpsEmptyCounted;
}

/** Records of an object not emptied that go along all the same. */
export interface DataOpsEmptyAlong {
  objectApiName: string;
  records: DataOpsEmptyCounted;
  /** By route: the lookup the records hang by, and the emptied object at the top. */
  via: Array<{ field: string; parent: string; emptied: string; records: DataOpsEmptyCounted }>;
}

/** What the org will likely refuse, or what the run does first so that it does not. */
export type DataOpsEmptyLikelyRefusalCode =
  'activatedOrder' | 'standardPriceBook' | 'directContactRelation' | 'personAccountContact';

/** A likely refusal, counted. */
export interface DataOpsEmptyLikelyRefusal {
  code: DataOpsEmptyLikelyRefusalCode;
  objectApiName: string;
  records: DataOpsEmptyCounted;
}

/** Records of an object not emptied naming deleted records through a lookup that refuses the delete. */
export interface DataOpsEmptyBlocker {
  objectApiName: string;
  field: string;
  parent: string;
  records: DataOpsEmptyCounted;
}

/**
 * Records no undo would bring back: those that leave before a record they
 * name, once it has gone too (`restricted`, or `unordered` where a constraint
 * gave way); a product's standard prices, which go with it and do not come
 * back with it (`standardPrices`); and what the pass of an object whose
 * records no undelete brings back on their own sends (`notRestorable`).
 */
export interface DataOpsEmptyUndoLost {
  objectApiName: string;
  /** The lookup through which they name the record they go before, or with; absent for `notRestorable`. */
  field?: string;
  /** The object of that record; absent for `notRestorable`. */
  parent?: string;
  reason: 'restricted' | 'unordered' | 'standardPrices' | 'notRestorable';
  records: DataOpsEmptyCounted;
}

/** Records that go before the record they name, as the platform requires. */
export interface DataOpsEmptyBeforeParent {
  objectApiName: string;
  field: string;
  parent: string;
  reason: 'restricted' | 'customPrices';
}

/** That `first` goes before `then`, and why: one that gave way where objects point at each other. */
export interface DataOpsEmptyOrderConstraint {
  first: string;
  then: string;
  reason: 'cascade' | 'restricted' | 'customPrices' | 'lookup';
}

/** How one pass sends its records. */
export interface DataOpsEmptyPassDeletes {
  objectApiName: string;
  records: number;
  restCalls: number;
  /** Bulk API jobs, each by its records. */
  jobs: number[];
  toTheBin: boolean;
  /** Set when its records are not sent: a file, asked to be deleted for good. */
  notSent?: true;
}

/** The parts of a count of requests beside a run's own. */
export interface DataOpsEmptyRequestParts {
  run: number;
  checkpoint?: number;
  readBack?: number;
  deliverability?: number;
  fit?: number;
}

/** A count of calls against what the org has left of its day. */
export type DataOpsEmptyBudgetCheck =
  | {
      verdict: 'fits' | 'near' | 'exceeds';
      estimate: number;
      max: number;
      remaining: number;
      parts?: DataOpsEmptyRequestParts;
    }
  | { verdict: 'unread'; estimate: number; unread: string; parts?: DataOpsEmptyRequestParts };

/** What an emptying costs, and how it stands against what the org has left. */
export interface DataOpsEmptyCost {
  /** From the dry run to the last delete: the dry run's read of the org, the run's own, its passes. */
  apiRequests: number;
  /**
   * Those requests apart: one read of the org, how many reads it holds, the
   * passes', a margin, connecting the org and checking each read's
   * connection, and the lease of the run's mute when it mutes.
   */
  requests?: {
    reads: number;
    readings: 1 | 2;
    passes: number;
    margin: number;
    connecting?: number;
    mute?: number;
  };
  seconds: number;
  bulkBatches: number;
  passes: DataOpsEmptyPassDeletes[];
  binRecords: number;
  bin?: { documentedCapacity: number; past: boolean };
  api: DataOpsEmptyBudgetCheck;
  batches?: DataOpsEmptyBudgetCheck;
}

/** What an emptying would do, said before it does anything. */
export interface DataOpsEmptyPreview {
  mode: DataOpsEmptyMode;
  deleteMode: DataOpsEmptyDeleteMode;
  passes: DataOpsEmptyPreviewPass[];
  along: DataOpsEmptyAlong[];
  leftOut: DataOpsEmptyLeftOut[];
  refusals: DataOpsEmptyLikelyRefusal[];
  blockers: DataOpsEmptyBlocker[];
  beforeParent: DataOpsEmptyBeforeParent[];
  unordered: DataOpsEmptyOrderConstraint[];
  undoLost: DataOpsEmptyUndoLost[];
  undo: boolean;
  affected: string[];
  cost: DataOpsEmptyCost;
  total: { records: number; objects: number; uncounted: string[] };
  statements: number;
  stopped?: true;
}

/**
 * What the user sees of the records an emptying deletes. With View All Data
 * and Modify All Data, every record (`org`). Without them, object by object:
 * an object they hold Modify All on, or hold through every record it hangs
 * from, is seen whole; any other is not, and the records of it they cannot
 * see are neither counted nor deleted — but those a deleted parent takes
 * along are, seen or not.
 */
export type DataOpsEmptyAccess =
  | { kind: 'org' }
  | {
      kind: 'perObject';
      viewAllData: boolean;
      modifyAllData: boolean;
      /** The objects the emptying deletes records of that the user is not proven to see whole. */
      unseen: Array<{ objectApiName: string; reason: string; detail?: string }>;
    };

/** Why an emptying, or its undo, stops before it writes anything. */
export type DataOpsEmptyRefusalCode =
  /** A production org, by the registry or by what the org says: nothing lifts it. */
  | 'PRODUCTION'
  /** A sandbox marked Staging, which an emptying of the whole org never reaches. */
  | 'STAGING_ORG'
  /** Something else of this machine writes to the org, or holds its lock. */
  | 'RUN_WRITING'
  /** The org's last emptying stopped part way: resume it or undo it first. */
  | 'OPEN_RUN'
  /** Someone other than the user changed records of these objects in the last hour. */
  | 'PEOPLE_ACTIVE'
  /** Deleting for good needs Bulk API Hard Delete, which the user lacks. */
  | 'HARD_DELETE_NOT_PERMITTED'
  /** The preview the run was confirmed on is no longer kept. */
  | 'PREVIEW_GONE'
  /** The preview was stopped before every count was in. */
  | 'PREVIEW_STOPPED'
  /** The org now holds more to delete than the preview showed. */
  | 'ORG_CHANGED'
  /** Records no undo would bring back, not accepted. */
  | 'NO_UNDO'
  /** More requests than the org has left today. */
  | 'API_BUDGET'
  /** More Bulk API batches than the org has left today. */
  | 'BULK_BATCHES'
  /** Production Guard refused, or its confirmation was declined. */
  | 'GUARD'
  /** An undo of a run that is not the org's last emptying. */
  | 'NOT_LAST_RUN'
  /** An undo of a run that deleted for good, or of one already undone. */
  | 'UNDO_UNAVAILABLE'
  /** No journal of that run is on this machine, or it is not the one to take up. */
  | 'RUN_GONE'
  /** The checkpoint asked for first cannot be taken from where the run was asked. */
  | 'CHECKPOINT_REFUSED'
  /** Stopped before anything was deleted. */
  | 'CANCELLED';

/**
 * A refusal, under its code — one of {@link DataOpsEmptyRefusalCode}, or one
 * of what fires, its emails and its mute, as every DataOps act gives them —
 * and in words a person reads.
 */
export interface DataOpsEmptyRefusal {
  code: string;
  message: string;
}

/** How an emptying or its undo ended, once it ran. */
export type DataOpsEmptyStatus = 'success' | 'partial' | 'failure' | 'cancelled';

/** What a run did with one object's records. */
export interface DataOpsEmptyPassResult {
  objectApiName: string;
  /** The records its pass read to delete. */
  planned: number;
  deleted: number;
  /** Gone before their delete reached them: taken along by a parent, or deleted by someone. */
  gone: number;
  refused: number;
  /** Not reached when the run was stopped. Absent when none. */
  notReached?: number;
  /** Records made after the preview was read, which the run leaves: absent when none were counted. */
  madeSince?: number;
  /** Why records stay, in the org's words where it gave them. */
  reasons: string[];
}

/** What an emptying did. */
export interface DataOpsEmptyRunResult {
  runId: string;
  status: DataOpsEmptyStatus;
  /** Whether it deleted for good: nothing it deleted can be brought back. */
  hard: boolean;
  passes: DataOpsEmptyPassResult[];
  totals: { deleted: number; gone: number; refused: number; notReached: number };
  /** Why the org refused to delete for good, before the job it refused held a record. */
  hardRefused?: string;
  /** Whether its Undo is offered, and why not. */
  undo: { offered: true } | { offered: false; why: 'hard' | 'nothingDeleted' };
  /** Set when it took up a run stopped part way. */
  resumed?: true;
  /** What could not be read, kept or said, in plain words. */
  notes: string[];
  /** What its mute assigned, kept quiet and took back, when it was asked to mute. */
  mutedAutomation?: MutedAutomation;
  /** The checkpoint taken before its first delete, when asked. */
  checkpoint?: RunCheckpointInfo;
  /** The org's earlier emptyings whose journals went once this one ended: Undo reaches the last alone. */
  removedRuns?: string[];
  /**
   * Every request the run sent the org, from its read of it again to its last
   * delete, counted as sent; absent where nothing counts them.
   */
  requestsSent?: number;
  startedAt: string;
  finishedAt: string;
}

/** What an undo did with one object's records. */
export interface DataOpsEmptyUndoObject {
  objectApiName: string;
  /** The records the run deleted of it, which the undo sets out to bring back. */
  planned: number;
  undeleted: number;
  /** Back in the org already: with a parent brought back, or by someone. */
  alreadyBack: number;
  /**
   * Not in the recycle bin, Salesforce answers: emptied from it, or kept there
   * for good — deleted on its own before a record it hangs from.
   */
  notInBin: number;
  /** Deleted by another user, whose deletions only Modify All Data brings back. */
  othersDeletion: number;
  /** Refused for another reason, in `reasons`. */
  refused: number;
  notReached?: number;
  reasons: string[];
}

/** What an undo of an emptying did. */
export interface DataOpsEmptyUndoResult {
  runId: string;
  status: DataOpsEmptyStatus;
  objects: DataOpsEmptyUndoObject[];
  notes: string[];
  mutedAutomation?: MutedAutomation;
  /** Every request the undo sent the org, counted as sent; absent where nothing counts them. */
  requestsSent?: number;
  finishedAt: string;
}

/** The org's tier, as an emptying reads it: production is refused before anything is. */
export type DataOpsEmptyTier = Exclude<GuardTier, 'production'>;

/** What the dry run answers, kept on the extension's side for the run to act on. */
export interface DataOpsEmptyPreviewKept {
  previewId: string;
  /** When the org was read, on its clock: the run leaves what was made after it. */
  readAt: string;
  orgName: string;
  tier: DataOpsEmptyTier;
  preview: DataOpsEmptyPreview;
  access: DataOpsEmptyAccess;
  /** Whether the user may delete for good, as `UserPermissionAccess` says. */
  hardDelete: { permitted: boolean; unread?: string };
  /** People other than the user who changed records of these objects in the hour before the read. */
  peopleActive: { people: number; unread?: string[] };
  /** What a checkpoint before the run would hold and cost, when it was asked. */
  checkpoint?: RunCheckpointEstimate;
  /** The org's last emptying, when it stopped part way: resume or undo it first. */
  openRun?: { runId: string; startedAt: string };
}
