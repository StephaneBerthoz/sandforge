/**
 * Checkpoint & Rewind — shared shapes for the `checkpoint:*` bridge contract
 * and the checkpoint's own file.
 *
 * A checkpoint is the state of an org's data at a moment: a snapshot of the
 * objects people work in, read by a user who sees all data, kept on this
 * machine. Rewind puts the org back to it, whoever changed it since: it deletes
 * the records created since, gives the records changed since their values back
 * and brings back from the recycle bin the records deleted since. Undo takes a
 * rewind back from its journal.
 *
 * Three times recur in these shapes, all read on the org's clock: T0, when the
 * take began (`readFrom`); T1, when it ended, after every snapshot read
 * (`takenAt`); and Tr, when a preview or a rewind began its reads (`readAt`).
 * The org dates what it writes to the second, so a record created in the
 * second of T0 is told from one created before it by T0 rounded down, never by
 * T0 itself.
 *
 * `checkpoint.json` is read back with `orgCheckpointSchema`
 * (`schemas/checkpoint.schema.ts`), whose inferred type is pinned to
 * {@link OrgCheckpoint}: a file that does not parse is listed as damaged and
 * never used, since a rewind planned from half a checkpoint would delete what
 * the missing half held.
 */

import type { ForgeUndoObjectResult } from './forge.types.js';
import type { ISODateString } from './common.types.js';
import type { SyncRestoreObjectResult, SyncUndeleteObjectResult } from './sync.types.js';

// ─── The checkpoint file (checkpoint.json, version 1) ────────────────────────

/** The kind of org a checkpoint may be taken of: never a production org. */
export type CheckpointOrgTier = 'sandbox' | 'scratch' | 'developer';

/**
 * Which objects a checkpoint holds: every object people work in, empty ones
 * included so that what is created there later is caught too, or only the
 * objects the user picked.
 */
export type CheckpointScopeMode = 'everything' | 'picked';

/**
 * How an object's records are read. `scanAllLive` reads with `queryAll` and
 * `IsDeleted = false`: Tasks and Events the platform archives (closed tasks
 * and past events older than about a year) leave plain `query()`, and would
 * otherwise read as deleted since.
 */
export type CheckpointReadMode = 'query' | 'scanAllLive';

/**
 * Why a field of an object is not in the snapshot: field-level security hides
 * it from the user, it is a classic encrypted field read masked, its value is
 * a file body, or it is a compound field whose parts are kept instead.
 */
export type CheckpointLeftOutFieldReason = 'fls' | 'encrypted' | 'base64' | 'compound';

/**
 * Where a take stands. A checkpoint is usable once `ready`; one left `taking`
 * by a take that never ended, or `failed`, is listed and can only be deleted.
 */
export type CheckpointStatus = 'taking' | 'ready' | 'failed';

/** The org a checkpoint is of, as it was when the take began. */
export interface CheckpointOrg {
  /**
   * The org's Organization Id. A refreshed sandbox gets a new one, so a
   * checkpoint never applies to the org its sandbox became.
   */
  organizationId: string;
  /** The alias it was known by on this machine, when it had one. */
  alias?: string;
  /** The user SandForge connected as. */
  username: string;
  instanceUrl: string;
  /** `Organization.IsSandbox`, read live. */
  isSandbox: boolean;
  /** `Organization.OrganizationType`, read live: `Developer Edition`, … */
  organizationType: string;
  tier: CheckpointOrgTier;
  /**
   * When the scratch org expires: the Salesforce CLI's `YYYY-MM-DD`, or an
   * instant. Absent for any other org.
   */
  scratchExpiresAt?: string;
}

/**
 * The user who took the checkpoint. Both permissions are required at take,
 * rewind and undo: without View All Data a record the user cannot see reads
 * as deleted, and without Modify All Data other users' deletions cannot be
 * brought back from the recycle bin.
 */
export interface CheckpointTakenBy {
  userId: string;
  /**
   * The org's Automated Process user. What it writes in answer to a rewind is
   * the rewind's own doing, which the convergence pass takes back too.
   */
  automatedProcessUserId?: string;
  viewAllData: true;
  modifyAllData: true;
}

/** An object the scope left out, with the reason a person reads. */
export interface CheckpointLeftOutObject {
  objectApiName: string;
  reason: string;
}

/** Which objects the checkpoint holds, and the ones its scope left out. */
export interface CheckpointScope {
  mode: CheckpointScopeMode;
  leftOut: CheckpointLeftOutObject[];
}

/** A field of an object the snapshot does not hold, and why. */
export interface CheckpointLeftOutField {
  /** The field's API name. */
  field: string;
  reason: CheckpointLeftOutFieldReason;
}

/** One object of a checkpoint, as it was read. */
export interface CheckpointObject {
  objectApiName: string;
  /** Rows in the snapshot: the org's count when it was read, or the take failed. */
  records: number;
  /** Ids of it in the recycle bin at T0, stamped before T0. */
  inBin: number;
  /**
   * Its place in the take's reading order, children first: a record the
   * snapshot holds then names only parents that existed when they were read.
   */
  readOrder: number;
  readMode: CheckpointReadMode;
  /** Whether Salesforce undeletes its records on their own; false for OpportunityLineItem and the like. */
  undeletable: boolean;
  /** Its reference fields whose parent's delete takes the record along. */
  cascadeParents: string[];
  /**
   * sha256, hex, of each field's name, type, createable, updateable, nillable,
   * referenceTo and encrypted flag: what tells a field added, removed or
   * changed since the take.
   */
  fingerprint: string;
  /** The fields the snapshot holds, by API name. */
  fields: string[];
  leftOutFields: CheckpointLeftOutField[];
}

/**
 * Records that moved while the take read, counted from a read of what changed
 * between T0 and T1. Each is held as it was read; a rewind treats it as
 * changed since.
 */
export interface CheckpointMovedWhileTaken {
  changed: number;
  deleted: number;
  created: number;
}

/** The last rewind made to a checkpoint, and how long it can be undone. */
export interface CheckpointLastRewind {
  rewindId: string;
  /** When it ended, org clock; absent while it runs, or from one stopped part way. */
  endedAt?: ISODateString;
  /**
   * Until when Undo can bring back what it deleted: 15 days after it, with the
   * recycle bin, sooner if the bin fills.
   */
  undoUntil?: ISODateString;
  /** When it was undone; absent until it is. */
  undoneAt?: ISODateString;
}

/** Where the take ran, so a take another process left unfinished can be told from one under way. */
export interface CheckpointTakenOn {
  host: string;
  pid: number;
}

/** `checkpoint.json`, version 1. */
export interface OrgCheckpoint {
  version: 1;
  /** `ck-20261022-140512-a1b2`: the name of its folder. */
  checkpointId: string;
  /** What it is called: `Before UAT`, or the date and time by default. */
  name: string;
  org: CheckpointOrg;
  takenBy: CheckpointTakenBy;
  /** T0: when the take began, org clock. */
  readFrom: ISODateString;
  /** T1: when the take ended, after every snapshot read, org clock. */
  takenAt: ISODateString;
  scope: CheckpointScope;
  objects: CheckpointObject[];
  /**
   * Fields, `Object.Field`, its owner chose to stop comparing — one the org's
   * automation sets on every save: neither compared nor written back, and a
   * difference in one never makes a rewind partial.
   */
  ignoredFields: string[];
  /** The DataOps operation id of the snapshot, inside the checkpoint's `snapshots.json`. */
  snapshotId: string;
  movedWhileTaken: CheckpointMovedWhileTaken;
  /** Bytes it takes on this machine. */
  bytes: number;
  /** When it is deleted from this machine; null keeps it until its owner deletes it. */
  expiresAt: ISODateString | null;
  status: CheckpointStatus;
  takenOn: CheckpointTakenOn;
  lastRewind?: CheckpointLastRewind;
}

// ─── Listing, scope and estimates ────────────────────────────────────────────

/**
 * Why a checkpoint listed cannot be previewed or rewound to: its file does not
 * parse, its take is under way or never ended, its take failed, the sandbox was
 * refreshed since — another org now — or the scratch org has expired. Every
 * one of these can still be deleted.
 */
export type CheckpointInvalidReason =
  'damaged' | 'taking' | 'failed' | 'refreshed' | 'scratchExpired';

/** A checkpoint as the list shows it, read from this machine without contacting the org. */
export interface CheckpointListEntry {
  /** Its folder's name, for a damaged one too. */
  checkpointId: string;
  /** The Organization Id it is filed under. */
  organizationId: string;
  /** What its `checkpoint.json` holds; absent when the file does not parse. */
  checkpoint?: OrgCheckpoint;
  /** Whether it can be previewed and rewound to. */
  valid: boolean;
  /** Why it cannot; absent when it can. */
  why?: CheckpointInvalidReason;
  /** When the sandbox was refreshed, when that is why. */
  refreshedAt?: ISODateString;
  /**
   * Set when it expires within three days, with [Keep] beside the date: said
   * by the store that lists it, so the list, the Home tile and the command
   * line warn on the same day.
   */
  expiresSoon?: true;
  /**
   * Records deleted before this date can't come back with their Id: set once
   * the checkpoint is older than the recycle bin's 15 days.
   */
  binReachSince?: ISODateString;
  /**
   * The org's latest rewind, when it was made to this checkpoint and can still
   * be undone: Undo is offered for an org's latest rewind only.
   */
  undo?: { rewindId: string; until: ISODateString };
}

/** One object a take would read, as its scope reads it before anything is kept. */
export interface CheckpointScopeObject {
  objectApiName: string;
  label: string;
  /** The managed package it belongs to; absent for the org's own objects. */
  namespace?: string;
  /** Its records now. */
  records: number;
  undeletable: boolean;
  /** Fields the snapshot would leave out, said before the take. */
  leftOutFields: CheckpointLeftOutField[];
}

/**
 * The phases of a take, in the order it runs them, as its requests are
 * estimated and counted: the guard's reads and the day's limits, the
 * describes of the scope, the user and T0, the counts, the recycle bin at
 * T0, the snapshot, and T1 with what moved while it was taken.
 */
export type CheckpointTakePhase =
  'guard' | 'scope' | 'start' | 'counts' | 'bin' | 'snapshot' | 'stability';

/** The API requests a take sent the org, in all and phase by phase, SOAP calls among them. */
export interface CheckpointTakeRequests {
  total: number;
  byPhase: Record<CheckpointTakePhase, number>;
}

/** What a take, a preview or a rewind would cost, said before it runs. */
export interface CheckpointEstimate {
  /** Records it reads or writes. */
  records: number;
  /** API requests it takes, about. */
  apiRequests: number;
  /**
   * A take's requests phase by phase, which add up to {@link apiRequests}:
   * what its count is held to once it ran. Absent for the other acts.
   */
  requestsByPhase?: Record<CheckpointTakePhase, number>;
  /** Requests the org had left today when the estimate was made. */
  apiRequestsLeft: number;
  /** About how long it runs, in seconds. */
  seconds: number;
  /** Bytes it keeps on this machine. */
  bytes: number;
}

/**
 * Why a take, a rewind or an undo is refused before it reads or writes, as
 * the guards say it: a production org or an unknown edition (`PRODUCTION`,
 * which nothing lifts), an org other than the checkpoint's own
 * (`OTHER_ORG`), an expired scratch org, a user without View All Data and
 * Modify All Data (`PERMISSIONS`), a SandForge run or another take, rewind or
 * undo writing to the org (`RUN_WRITING`), more API requests than the org has
 * left today, more records than the take's limit, automation not accepted,
 * and deletions Undo could not bring back not accepted (`NO_UNDO`).
 */
export type CheckpointRefusalCode =
  | 'PRODUCTION'
  | 'OTHER_ORG'
  | 'SCRATCH_EXPIRED'
  | 'PERMISSIONS'
  | 'RUN_WRITING'
  | 'API_BUDGET'
  | 'TOO_MANY_RECORDS'
  | 'AUTOMATION'
  | 'NO_UNDO';

/** A refusal said before anything runs, with the words a person reads. */
export interface CheckpointRefusal {
  code: CheckpointRefusalCode;
  message: string;
}

// ─── The preview: what a rewind would do ─────────────────────────────────────

/**
 * What a rewind cannot take back of an object, named in the preview: records
 * deleted since that the recycle bin no longer holds, leads converted since,
 * contracts activated since, and records deleted since with a parent created
 * since, which cannot come back on their own.
 */
export type RewindCannotUndoReason =
  'goneForGood' | 'convertedLead' | 'activatedContract' | 'deletedWithCreatedParent';

/** Fields of an object whose description changed since the take, by API name. */
export interface RewindSchemaDrift {
  /** Deleted since: named, with what to do. */
  removed: string[];
  /** Added since: their values are left alone. */
  added: string[];
  /** Whose type or flags changed: tried field by field. */
  changed: string[];
}

/** What a rewind would do to one object of the checkpoint. */
export interface RewindDiffObject {
  objectApiName: string;
  /**
   * Records to delete: created since, brought back from the recycle bin since
   * (they were in it at the checkpoint), and created since then deleted with a
   * parent the rewind brings back, which comes back with it and goes again.
   */
  toDelete: { createdSince: number; broughtBackSince: number; comesBackWithParent: number };
  /**
   * Records to give their checkpoint values back, the fields that differ in
   * all, and of those records the ones whose lookup the deletion of a parent
   * cleared.
   */
  toGiveBack: { records: number; fields: number; clearedLookups: number };
  /**
   * Records to bring back from the recycle bin: on their own, with a parent
   * brought back (an object Salesforce undeletes only with its parent), and
   * those deleted while the checkpoint was taken, which come back with the
   * values they had when deleted.
   */
  toBringBack: { inBin: number; withParent: number; deletedWhileTaken: number };
  cannotUndo: Array<{ reason: RewindCannotUndoReason; count: number }>;
  /**
   * Records outside the checkpoint, created under records of this object the
   * rewind deletes, that go with them: per object outside it, and the records
   * of this one they hang from.
   */
  outside: Array<{ objectApiName: string; count: number; parents: number }>;
  /** Records stamped since that hold their checkpoint values: nothing to give back. */
  touched: number;
  /**
   * Records the checkpoint does not hold although they are dated before it — a
   * load with back-dated creation dates, a transaction that committed late:
   * left in place, since a rewind deletes nothing it cannot prove was created
   * since.
   */
  unexplained: number;
  /** Who last changed the records to delete or give back: user Id, how many. */
  lastChangedBy: Record<string, number>;
  /** Absent when no field changed since the take. */
  schemaDrift?: RewindSchemaDrift;
  /** Its fields the checkpoint does not compare, by API name. */
  notCompared: string[];
}

/** What a rewind to a checkpoint would do, read from the org now, writing nothing. */
export interface RewindDiff {
  checkpointId: string;
  /** Names this preview: a rewind acts on what it confirmed that still differs. */
  previewId: string;
  /** Tr: when its reads began, org clock. */
  readAt: ISODateString;
  /**
   * The objects with anything to delete, give back, bring back or name, in
   * the checkpoint's reading order. One that holds its checkpoint state is
   * left out, and one that could not be read is in {@link unread} instead.
   */
  objects: RewindDiffObject[];
  /**
   * Records it deletes that Undo couldn't bring back, per object: in an object
   * Salesforce undeletes only with its parent, under a parent that stays.
   * The rewind needs them accepted.
   */
  undoCannot: Array<{ objectApiName: string; count: number }>;
  /**
   * Objects whose read failed, with the reason: never read as unchanged, so
   * the rewind leaves them as they are.
   */
  unread: Array<{ objectApiName: string; reason: string }>;
  /** The names of the users {@link RewindDiffObject.lastChangedBy} counts, by user Id. */
  userNames: Record<string, string>;
  /** The users who changed records of the checkpoint's objects in the hour before Tr. */
  activeLastHour: string[];
}

// ─── The result of a rewind, and of an undo ──────────────────────────────────

/**
 * How a rewind or an undo ended. `partial`: records still differ from the
 * checkpoint among the fields it compares; `unstable`: another user changed
 * records during it, left as they made them.
 */
export type RewindStatus = 'success' | 'partial' | 'failure' | 'unstable' | 'cancelled';

/**
 * Why a record still differs once the rewind verified: the org's automation
 * set it again, another user changed it during the rewind, it changed after
 * the preview the rewind acted on, the org refused the write, the recycle
 * bin no longer holds it, or the rewind kept it as it had to — records
 * outside a checkpoint of picked objects hang from it and their deletion was
 * not accepted, a record the rewind left hangs from it, or Undo couldn't
 * bring it back and that was not accepted — which its `message` says.
 */
export type RewindResidualReason =
  'automation' | 'changedDuringRewind' | 'changedSincePreview' | 'refused' | 'goneForGood' | 'kept';

/** Records of one object that still differ, for one reason. */
export interface RewindResidual {
  objectApiName: string;
  reason: RewindResidualReason;
  /** The user who last changed them, by Id, when another user did. */
  by?: string;
  /** How many. */
  count: number;
  /** Their ids, or the first of them when there are many: {@link count} says how many there are. */
  ids: string[];
  /** The org's words, for a refusal; the rewind's own, for a record it kept. */
  message?: string;
}

/** What a rewind, or an undo of one, did, object by object. */
export interface RewindResult {
  checkpointId: string;
  rewindId: string;
  status: RewindStatus;
  /** What it deleted, per object, children before their parents. */
  deleted: ForgeUndoObjectResult[];
  /** What it gave back its values, per object. */
  restored: SyncRestoreObjectResult[];
  /** What it brought back from the recycle bin, per object, parents first. */
  undeleted: SyncUndeleteObjectResult[];
  /** What still differs once it read the org again. */
  residual: RewindResidual[];
  /**
   * Objects the last read of the org could not read, with the reason: never
   * taken for objects that match the checkpoint, so a rewind that names one
   * is partial. Absent when every object was read.
   */
  unread?: Array<{ objectApiName: string; reason: string }>;
  /** Passes it made: the rewind, then one convergence pass at most. */
  passes: number;
  /**
   * Until when it can be undone, and what Undo couldn't bring back, per
   * object. Absent from an undo's own result, and from a rewind that wrote
   * nothing.
   */
  undo?: { until: ISODateString; cannot: Array<{ objectApiName: string; count: number }> };
  /** API requests it used, counted by SandForge, and the requests the org has left today. */
  apiRequests: { used: number; leftToday: number };
  finishedAt: ISODateString;
}
