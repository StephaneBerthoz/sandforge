/**
 * Checkpoint & Rewind — shared shapes for the `checkpoint:*` bridge contract
 * and the checkpoint's own file.
 *
 * A checkpoint is the state of an org's data at a moment: a snapshot of the
 * objects people work in, read by a user who sees every record of them, kept
 * on this machine. Rewind puts the org back to it, whoever changed it since: it deletes
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

import type { MutedAutomation } from '../utils/automation-mute.js';
import type { ForgeEmailLimit, ForgeUndoObjectResult } from './forge.types.js';
import type { ISODateString } from './common.types.js';
import type { SyncRestoreObjectResult, SyncUndeleteObjectResult } from './sync.types.js';
import type { FrozenLoadRecordsInfo } from './frozen.types.js';

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
 * What kind of custom setting an object is: a hierarchy, one row for the org's
 * default and one per profile or user, each known by its owner
 * (`SetupOwnerId`), or a list, its rows known by their names. Both carry
 * `SetupOwnerId` (P-C2), so a list is told by the `Name` its describe makes
 * required, which a hierarchy names itself.
 */
export type CheckpointCustomSettingKind = 'hierarchy' | 'list';

/**
 * Where a take stands. A checkpoint is usable once `ready`; one left `taking`
 * by a take that never ended, or `failed`, is listed and can only be deleted.
 */
export type CheckpointStatus = 'taking' | 'ready' | 'failed';

/** The modules whose run can take a checkpoint of the objects it writes before its first write. */
export type CheckpointBeforeRunModule =
  | 'forge'
  | 'sync'
  | 'seed'
  | 'autopilot'
  | 'frozen'
  /** An emptying of objects, or of the whole org, of DataOps Cleanup. */
  | 'empty'
  /**
   * A checkpoint's records set up again in another org: a Frozen load of
   * the checkpoint, said as its replay, never as a load of a dataset.
   */
  | 'replay';

/**
 * Where a checkpoint taken before a run comes from (`Checkpoint first`): the
 * module whose run took it, the run by its operation id, and whether the
 * panel or a command line ran it. A version that does not know the field
 * reads the checkpoint as any other.
 */
export interface CheckpointBeforeRun {
  module: CheckpointBeforeRunModule;
  operationId: string;
  tool: 'panel' | 'cli';
}

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
  /**
   * The org's data storage, in MB, as its `/limits` said it at the take
   * (`DataStorageMB.Max`). Nothing the org says names a sandbox's license,
   * and this does, as Salesforce documents it: 200 MB for a Developer
   * sandbox, 1 GB for a Developer Pro, 5 GB for a Partial Copy, production's
   * own for a Full sandbox. Past a Developer Pro's, the checkpoint may hold
   * production's records, and a replay into another org masks them. Absent
   * from a checkpoint taken before 1.81, and when the org did not say.
   */
  dataStorageMaxMB?: number;
  /**
   * Set when the org was marked Staging in Org Manager when it was taken: a
   * sandbox that holds real data, which a replay into another org masks. The
   * mark is the panel's: a take from the command line, or before 1.81, has
   * none.
   */
  staging?: true;
}

/**
 * How a checkpoint knows its user sees and puts back every record of an
 * object: View All Data and Modify All Data (`org`); Modify All on the object
 * itself, which needs View All on it (`object`); or, for an object with no
 * permissions of its own — an opportunity's products, a case's comments —
 * Modify All on every record it hangs from by a lookup whose delete takes it
 * along (`parent`). An object proven none of these ways is left out, named.
 */
export type CheckpointObjectAccess = 'org' | 'object' | 'parent';

/**
 * The user who took the checkpoint, and whether they had View All Data and
 * Modify All Data. With both, every object is held, whoever owns its records:
 * without View All Data a record the user cannot see reads as deleted, and
 * without Modify All Data other users' deletions cannot be brought back from
 * the recycle bin. Without them, each object the checkpoint holds says how
 * its user held it whole ({@link CheckpointObject.access}). A checkpoint
 * taken before 1.70 holds both, `true`.
 */
export interface CheckpointTakenBy {
  userId: string;
  /**
   * The org's Automated Process user. What it writes in answer to a rewind is
   * the rewind's own doing, which the convergence pass takes back too.
   */
  automatedProcessUserId?: string;
  viewAllData: boolean;
  modifyAllData: boolean;
  /**
   * Whether the user had Query All Files. Without it, a file the user does
   * not own is read only by its id, or through a link to a record the user
   * sees: one in a library the user is not a member of, or linked to no
   * record the checkpoint holds, is never seen. Absent from a checkpoint
   * taken before files were held.
   */
  queryAllFiles?: boolean;
}

/**
 * The files a checkpoint holds beside its objects, in its folder's `files/`:
 * the links between a file (`ContentDocument`) and a record of the checkpoint,
 * and each file's latest version and size, which a rewind cannot write back
 * and reads to tell a file given a new version since. A file's content is no
 * record's value, and is not held.
 *
 * Absent from a checkpoint taken before files were held, and from one whose
 * scope left `ContentDocument` out: a rewind to it leaves files added since
 * where they are, as SandForge 1.69 did.
 */
export interface CheckpointFiles {
  /** Files the checkpoint holds the latest version and size of: its own snapshot's, and every one a link names. */
  documents: number;
  /** Links between a file and a record of the checkpoint. */
  links: number;
  /** Of the files, those a link ties to a record of the checkpoint: those a rewind acts on. */
  anchored: number;
  /**
   * Objects whose records' links were read by lists of their ids, the org
   * having refused to read them with one statement, or answered too late.
   * Absent when there is none.
   */
  readByIds?: string[];
}

/** Why an object is left out of a checkpoint taken without View All Data and Modify All Data. */
export type CheckpointAccessLeftOutCode =
  /** Neither View All nor Modify All on it. */
  | 'noViewAll'
  /** View All on it, and not Modify All: what others changed could not be put back. */
  | 'noModifyAll'
  /** A task or an event: activities have no View All. */
  | 'activities'
  /** A product or a price book: they have no View All or Modify All. */
  | 'catalog'
  /** A file: nothing proves who sees every file. */
  | 'filesNotProven'
  /** A custom setting: no permission row tells who sees and writes every row. */
  | 'settingNotProven'
  /** No permission of its own, and what it hangs from is not proven held whole. */
  | 'parentNotSeen';

/** Why a checkpoint leaves an object out. */
export type CheckpointLeftOutCode =
  /** Its owner asked for it to be left out. */
  | 'excludedByUser'
  /** Picked, and the org has no such object. */
  | 'notFound'
  /** A Chatter post, comment or feed. */
  | 'chatter'
  /** A history object: the org's trace of changes. */
  | 'history'
  /** A sharing object: who may see a record, which the org keeps itself. */
  | 'sharing'
  /** A change event of Change Data Capture. */
  | 'changeEvent'
  /** A big object, an external or Data Cloud object, a Knowledge version or a platform event. */
  | 'unsupportedKind'
  /** A custom setting the take did not name: configuration. */
  | 'customSetting'
  /** Named as a custom setting, and the org has no custom setting of that name. */
  | 'notCustomSetting'
  /** A document of the Documents tab: shared content kept in folders. */
  | 'files'
  /** A file's version or link: held with its file, `ContentDocument`. */
  | 'heldWithFiles'
  /** Users, permissions and the rest of setup, and the org's logs and jobs. */
  | 'setup'
  /** Records Salesforce alone creates: approvals, Einstein insights, invoices and the like. */
  | 'platformCreated'
  /** Metadata, which the Tooling API serves: deployed, not kept as data. */
  | 'metadata'
  /** The user may not query, create, edit and delete its records. */
  | 'notWritable'
  /** Its describe could not be read. */
  | 'notDescribed'
  /** No `SystemModstamp`: nothing would tell a record that moved since. */
  | 'noSystemModstamp'
  /**
   * No `IsDeleted`: the org deletes its records for good, with no recycle bin,
   * so nothing would tell one deleted since, nor bring it back.
   */
  | 'noRecycleBin'
  /** The org refuses to read it whole. */
  | 'unreadable'
  /** More records than a checkpoint holds of one object: part of it would pass for all of it. */
  | 'pastTheLimit'
  /**
   * Without View All Data and Modify All Data, why an object the user is not
   * proven to see and put back whole is left out. `filesNotProven` and
   * `settingNotProven` are the note's `files` and a custom setting's: `files`
   * already names the Documents tab's.
   */
  | CheckpointAccessLeftOutCode;

/**
 * An object the scope left out, and why: `code`, which a page says in its
 * language and tells reasons apart by, and `reason`, the same in English for
 * the file, the command line and a run's notes.
 */
export interface CheckpointLeftOutObject {
  objectApiName: string;
  /** Absent from a checkpoint taken before reasons had codes: `reason` alone says why. */
  code?: CheckpointLeftOutCode;
  reason: string;
  /** What `code` leaves to name, in the words it came in: the org's, or a parent's. */
  detail?: string;
  /** Of `pastTheLimit`, its records and the checkpoint's limit for one object. */
  records?: number;
  limit?: number;
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
   * Its reference fields whose parent the org refuses to delete while the
   * record lives — a case's account, on some orgs: a rewind that deletes
   * both deletes the record first, and Salesforce then keeps it in the
   * recycle bin for good. Absent from a checkpoint taken before they were
   * kept, which knows none.
   */
  restrictParents?: string[];
  /**
   * sha256, hex, of each field's name, type, createable, updateable, nillable,
   * referenceTo and encrypted flag: what tells a field added, removed or
   * changed since the take.
   */
  fingerprint: string;
  /** The fields the snapshot holds, by API name. */
  fields: string[];
  leftOutFields: CheckpointLeftOutField[];
  /**
   * Set when the object is a custom setting the take was asked to hold by
   * name, with its kind: a rewind brings one of its rows back only once no
   * other row holds its name or its owner, and every act on the checkpoint
   * asks for Customize Application. Absent for any other object, and from a
   * checkpoint taken before custom settings could be held.
   */
  customSetting?: CheckpointCustomSettingKind;
  /**
   * How its user held it whole at the take ({@link CheckpointObjectAccess}).
   * Set on each object of a checkpoint taken without View All Data and Modify
   * All Data; absent from a checkpoint taken before 1.70, whose user had both.
   */
  access?: CheckpointObjectAccess;
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

/**
 * Where a checkpoint imported on this machine came from: the `.sfcheckpoint`
 * file another machine exported it to. Its rewinds there, and their Undo,
 * stayed there.
 */
export interface CheckpointImportedFrom {
  /** When it was imported, this machine's clock. */
  at: ISODateString;
  /** The SandForge that exported it. */
  sandforgeVersion: string;
  /** sha256, hex, of the file it was imported from. */
  sha256: string;
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
  /** Absent before files were held, and when the scope left files out: see {@link CheckpointFiles}. */
  files?: CheckpointFiles;
  /** Set on a checkpoint imported from a file another machine exported: see {@link CheckpointImportedFrom}. */
  importedFrom?: CheckpointImportedFrom;
  /** Set on a checkpoint a run took of what it writes before its first write: see {@link CheckpointBeforeRun}. */
  beforeRun?: CheckpointBeforeRun;
  /**
   * What its replay annex holds, counts alone: see
   * {@link CheckpointReplayAnnexSummary}. Absent from a checkpoint taken
   * before 1.81, which a replay sets up again without it.
   */
  replayAnnex?: CheckpointReplayAnnexSummary;
}

// ─── What a checkpoint keeps to be replayed in another org (replay.json.gz) ──

/**
 * The parts of a checkpoint's replay annex, each read on its own at the take:
 * one the org would not answer is named, never guessed, and the others are
 * kept.
 */
export type CheckpointReplayAnnexPart = 'recordTypes' | 'users' | 'queues' | 'standardPricebook';

/**
 * A record type of the org, as the annex keeps it: what a replay finds it by
 * in another org, its developer name and its namespace, never its label,
 * which two types of one object may share.
 */
export interface CheckpointReplayRecordType {
  id: string;
  sobjectType: string;
  developerName: string;
  /** The managed package it belongs to; absent for the org's own. */
  namespacePrefix?: string;
  name: string;
  isActive: boolean;
  /**
   * Whether it is a person account's type. Absent when the org has no person
   * accounts, whose record types do not have the field.
   */
  isPersonType?: boolean;
}

/**
 * A user a record of the checkpoint names, by its owner or another lookup to
 * a user: what a replay finds the same person by in another org, a sandbox's
 * suffix taken off the username.
 */
export interface CheckpointReplayUser {
  id: string;
  username: string;
  name: string;
  isActive: boolean;
  /** `Standard`, `AutomatedProcess`, …: only a standard user owns a replayed record. */
  userType: string;
}

/** A queue of the org, and the objects whose records it may own. */
export interface CheckpointReplayQueue {
  id: string;
  developerName: string;
  name: string;
  sobjectTypes: string[];
}

/**
 * `replay.json.gz`, in a checkpoint's folder from 1.81 on: what the take read
 * of the org beside its records, between T0 and T1, so that the checkpoint
 * sets its records up again in another org once its own is gone — refreshed,
 * expired, a teammate's. A checkpoint holds no user, record type or queue,
 * which are setup, and a replay finds them in the other org by what this
 * keeps of them. It holds the names and usernames of the users its records
 * name: personal data, kept and exported as the records are.
 */
export interface CheckpointReplayAnnex {
  version: 1;
  /** The org it was read of: the checkpoint's own, which a hierarchy setting's org-wide row names. */
  organizationId: string;
  recordTypes: CheckpointReplayRecordType[];
  users: CheckpointReplayUser[];
  queues: CheckpointReplayQueue[];
  /** The org's standard price book; absent when it was not asked, or the org has none. */
  standardPricebookId?: string;
  /** The parts the org did not answer, with its words. */
  unread: Array<{ part: CheckpointReplayAnnexPart; reason: string }>;
}

/**
 * What a checkpoint's replay annex holds, as its `checkpoint.json` counts it:
 * enough to say, without opening it, what a replay will find by name and
 * what it will give the defaults of the other org instead.
 */
export interface CheckpointReplayAnnexSummary {
  recordTypes: number;
  users: number;
  queues: number;
  /** Whether it holds the org's standard price book. */
  standardPricebook: boolean;
  /** The parts the org did not answer; absent when it answered every one asked. */
  unread?: CheckpointReplayAnnexPart[];
}

// ─── A checkpoint as a file that leaves the machine (.sfcheckpoint) ──────────

/**
 * The first line of a `.sfcheckpoint` file, unencrypted: what it holds, enough
 * to refuse it for another org, a production org or a newer format before a
 * key is asked, and how its blocks are encrypted. Every block authenticates
 * it, so a byte changed in it refuses the file. It names neither the
 * checkpoint, whose name may carry a client's, nor a user or an alias.
 */
export interface CheckpointArchiveHeader {
  format: 'sandforge-checkpoint';
  /**
   * The layout of the file: its header, blocks and entries. 2 for a file
   * that carries its checkpoint's replay annex (`replay.json.gz`): SandForge
   * 1.80 refuses an entry of a path it does not know, so such a file says it
   * was made by a newer SandForge before any key is asked. 1 for any other.
   */
  formatVersion: 1 | 2;
  /** The version of the `checkpoint.json` it holds. */
  checkpointFormat: 1;
  /** The SandForge that exported it. */
  sandforgeVersion: string;
  /**
   * The org it is a checkpoint of: an import into any other is refused, and
   * a replay into it, which a rewind does instead.
   */
  organizationId: string;
  orgTier: CheckpointOrgTier;
  /**
   * The org's data storage as the take read it ({@link CheckpointOrg.dataStorageMaxMB}),
   * and its Staging mark ({@link CheckpointOrg.staging}): a replay of a file
   * received knows, before any key, that it sets up real data only masked.
   * Absent when the checkpoint does not say; SandForge 1.80 drops both.
   */
  dataStorageMaxMB?: number;
  staging?: true;
  checkpointId: string;
  takenAt: ISODateString;
  /** Records it holds, every object together. */
  records: number;
  objects: number;
  /** Files it holds, and their bytes as an import writes them back: what the disk must have room for. */
  files: number;
  bytes: number;
  cipher: 'aes-256-gcm';
  /** How the block key is drawn from the key a person is given: HKDF-SHA256 over `salt`. */
  kdf: 'hkdf-sha256';
  /** 32 random bytes, hex: a key given twice still encrypts each file under a key of its own. */
  salt: string;
  /** 8 random bytes, hex: each block's nonce is it, then the block's index. */
  noncePrefix: string;
  /** 16 bytes drawn from the key and the salt, hex: a wrong key is told before a block is read. */
  keyCheck: string;
  /** Bytes of the compressed entries each block holds, the last one fewer. */
  chunkBytes: number;
}

/**
 * What the page is told of a `.sfcheckpoint` file before it asks for the key:
 * its header without the values its blocks are decrypted with, which nobody
 * reads.
 */
export type CheckpointArchiveSummary = Pick<
  CheckpointArchiveHeader,
  | 'formatVersion'
  | 'checkpointFormat'
  | 'sandforgeVersion'
  | 'organizationId'
  | 'orgTier'
  | 'checkpointId'
  | 'takenAt'
  | 'records'
  | 'objects'
  | 'files'
  | 'bytes'
  | 'dataStorageMaxMB'
  | 'staging'
>;

// ─── A replay into another org ───────────────────────────────────────────────

/**
 * Whom a replay gives its records to: their owner when the other org holds
 * the same active standard user — by its id, or with the annex by its
 * username without a sandbox's suffix — else the user who replays (`same`);
 * or the user who replays, always (`me`).
 */
export type CheckpointReplayOwners = 'same' | 'me';

/**
 * An object whose records a replay links to the records the other org
 * already holds with the same values of `fields`, instead of creating them:
 * `--link Account=AccountNumber`.
 */
export interface CheckpointReplayLink {
  objectApiName: string;
  fields: string[];
}

/** What a replay is asked, each choice with its default as the command line and the page offer it. */
export interface CheckpointReplayChoices {
  owners: CheckpointReplayOwners;
  /**
   * Users of the checkpoint's org and the active users of the other org that
   * own their records there, by id: `--owner-map`. Absent unless given.
   */
  ownerMap?: Record<string, string>;
  /** Whether the custom settings the checkpoint holds are set up too, never over a row there. */
  customSettings: boolean;
  /** Whether personal data is masked: required of real data, a Partial Copy's, a Full's, a Staging's. */
  mask: boolean;
  /** Emails and phone numbers made unreachable (`neutralized`), or kept as they are. */
  contactPoints: 'neutralized' | 'kept';
  /** The objects replayed, by API name; empty for every object the checkpoint holds. */
  objects: string[];
  /** Objects left out of those. */
  excluded: string[];
  link: CheckpointReplayLink[];
  /**
   * Declared, and kept in the audit trail, of a sandbox's checkpoint that
   * does not say its license — taken before 1.81: it holds no real data.
   */
  noRealData?: true;
}

/** Why records of an object a checkpoint holds are not replayed. */
export type CheckpointReplayNotReplayedReason =
  /** Files, attachments and documents: a checkpoint keeps no file's content. */
  | 'fileContentNotKept'
  /** The other org has no such object: deploy it, or leave it out. */
  | 'notInTarget'
  /** The other org creates none of its records itself. */
  | 'notCreateable'
  /** Left out as asked. */
  | 'excluded';

/** Why a lookup of replayed records is emptied rather than set. */
export type CheckpointReplayLookupEmptiedReason =
  /** Its object is held by the checkpoint and not replayed: add it. */
  | 'objectNotReplayed'
  /** Its object is not held by the checkpoint, and the other org holds no record of that id. */
  | 'objectNotHeld'
  /** A user the other org has no active standard user for, on a lookup that may be empty. */
  | 'userNotInTarget';

/** Why records are refused before anything is written, each with the path that lifts it. */
export type CheckpointReplayRefusedReason =
  /** A required lookup to a record neither replayed nor in the other org. */
  | 'requiredLookupMissing'
  /** A parent of theirs was refused: an orphan is never written. */
  | 'parentRefused'
  /** Person accounts, which the other org has not turned on. */
  | 'personAccountsUnsupported'
  /** A currency the other org has not activated. */
  | 'inactiveCurrency'
  /** A record type the other org has, and does not let its user create records of. */
  | 'recordTypeUnavailable';

/**
 * What a replay would do, and did, beyond what its load counts: every record
 * that does not go across as it was, said with why, so that a success hides
 * nothing.
 */
export interface CheckpointReplaySummary {
  records: {
    toCreate: number;
    /** Records the other org holds under the same Id — a sandbox copied from the same production — linked, not changed. */
    linkedById: number;
    /** Records the other org holds with the same values of the fields a link names, linked, not created. */
    linkedByKey: number;
    refusedBeforeWrite: number;
  };
  owners: {
    kept: number;
    toRunningUser: number;
    reasons: { notInTarget: number; inactive: number; queueMissing: number };
  };
  recordTypes: Array<{
    object: string;
    recordType: string;
    outcome: 'byName' | 'byId' | 'default';
    records: number;
  }>;
  notReplayed: Array<{
    object: string;
    records: number;
    reason: CheckpointReplayNotReplayedReason;
  }>;
  lookupsEmptied: Array<{
    field: string;
    records: number;
    reason: CheckpointReplayLookupEmptiedReason;
  }>;
  refused: Array<{
    object: string;
    records: number;
    reason: CheckpointReplayRefusedReason;
    /** What lifts it, as a person reads it. */
    path?: string;
  }>;
  /** Fields the checkpoint holds that the other org's objects do not have: left out. */
  fieldsNotInTarget: Array<{ object: string; fields: string[] }>;
  /** Of the custom settings, when asked: rows set up, and rows the other org already had, kept. */
  customSettings?: { inserted: number; alreadyThere: number };
  currencies: {
    refused: Array<{ code: string; records: number }>;
    /** Set when the other org has one currency: amounts are kept as they are, in its currency. */
    singleCurrencyTarget?: true;
  };
  /** Where the standard price book's entries were told from: the annex, the entries themselves, or neither. */
  standardPricebook?: 'annex' | 'deduced' | 'ambiguous' | 'none';
  masked: {
    fields: string[];
    /** Free-text fields the masking does not read: they go as they are. */
    unmaskedFreeText?: string[];
  };
  contactPoints: 'neutralized' | 'kept';
  /** Archived tasks and events replayed, which the other org holds live. */
  archivedActivities?: number;
  /**
   * The parts of the annex the checkpoint lacks — all of them for one taken
   * before 1.81 — whose records a replay gives the other org's defaults.
   */
  degraded: CheckpointReplayAnnexPart[];
  /** Created and modified dates and users are the replay's own: the platform sets them. */
  auditDates: 'new';
}

/**
 * Why a replay is refused before anything is written, the source of its
 * checkpoint asked, never contacted:
 *
 * - `REPLAY_SAME_ORG`: the other org is the checkpoint's own, which a rewind
 *   brings back instead;
 * - `REPLAY_REAL_DATA`: the checkpoint is of a Partial Copy, a Full or a
 *   Staging sandbox, replayed only masked;
 * - `REPLAY_COPY_UNKNOWN`: of a sandbox taken before 1.81, whose license it
 *   does not say: masked, or declared to hold no real data;
 * - `REPLAY_TOO_MANY`: more records than a replay sets up at once: fewer objects;
 * - `REPLAY_NOTHING`: nothing left to replay, every object left out or empty;
 * - `REPLAY_CHECKPOINT_UNUSABLE`: a take under way, failed, or a file damaged.
 */
export type CheckpointReplayRefusalCode =
  | 'REPLAY_SAME_ORG'
  | 'REPLAY_REAL_DATA'
  | 'REPLAY_COPY_UNKNOWN'
  | 'REPLAY_TOO_MANY'
  | 'REPLAY_NOTHING'
  | 'REPLAY_CHECKPOINT_UNUSABLE';

/** A replay refused, with the words a person reads. */
export interface CheckpointReplayRefusal {
  code: CheckpointReplayRefusalCode;
  message: string;
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
   * Set when the scratch org it is of expires within three days: its
   * checkpoints then can only be deleted, whatever Keep says, and a Frozen
   * Dataset frozen before keeps its data for another org.
   */
  scratchExpiresSoon?: true;
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
  /**
   * Its replays into other orgs this machine keeps, each org's once, newest
   * first: read from the replays' own files, which a deletion of the
   * checkpoint leaves. Absent when it was never replayed.
   */
  replays?: CheckpointReplayListed[];
}

/**
 * A checkpoint's replay into another org, as this machine's files say it, no
 * org asked: what a removal of it takes, which needs neither the checkpoint
 * nor its org.
 */
export interface CheckpointReplayListed {
  /**
   * The other org: its Organization Id as it answered, the name the replay
   * gave it, and the registered org that answers with that Id now, when one
   * does — what a removal connects to.
   */
  target: { organizationId: string; name?: string; orgId?: string };
  /** When its last replay wrote its last record; absent when none wrote. */
  replayedAt?: ISODateString;
  /** Records its replays created there that no removal took, every object together. */
  inPlace: number;
  /** Set when a removal took every record its last replay created. */
  removed?: true;
  /** What its last replay was asked. */
  choices?: CheckpointReplayChoices;
  /**
   * The replay a removal takes next there, counts only, under the registered
   * org's id: absent when no registered org answers with its Id, or no
   * replay wrote.
   */
  records?: FrozenLoadRecordsInfo;
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
  /** Its kind, when it is a custom setting the take was asked to hold by name. */
  customSetting?: CheckpointCustomSettingKind;
  /** How its user would hold it whole ({@link CheckpointObjectAccess}); absent from an older answer. */
  access?: CheckpointObjectAccess;
}

/**
 * A custom setting of the org, as a take offers it: held only when named,
 * in either mode. Its kind and rows are absent when the org would not
 * describe or count it.
 */
export interface CheckpointScopeCustomSetting {
  objectApiName: string;
  label: string;
  kind?: CheckpointCustomSettingKind;
  /** Its rows now. */
  records?: number;
}

/**
 * What a take would hold of the org's files, said before it reads a record:
 * whether its user has Query All Files, without which the files of libraries
 * the user is not a member of are never seen, and the objects of files a
 * scope of picked objects holds though they were not picked
 * (`ContentDocument`, `Attachment`), which a rewind of the picked ones would
 * otherwise leave as they are.
 */
export interface CheckpointScopeFiles {
  /** Whether `ContentDocument` is among the objects held. */
  held: boolean;
  queryAllFiles: boolean;
  /** Objects added to the objects picked; none in `everything` mode. */
  addedToPicked: string[];
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
 * Modify All Data who has View All and Modify All on none of the objects, or
 * on an object picked, or without Customize Application where custom
 * settings are held (`PERMISSIONS`), a SandForge run or another take, rewind or
 * undo writing to the org (`RUN_WRITING`), more API requests than the org has
 * left today, more records than the take's limit, automation not accepted,
 * deletions Undo could not bring back not accepted (`NO_UNDO`), records to
 * make again with new Ids not accepted (`RECREATE`), more emails than the
 * org has left today of a daily limit (`EMAILS`), which nothing lifts either,
 * files to bring back from the recycle bin that take more file storage
 * than the org has left (`FILE_STORAGE`): a file in the bin takes none, and
 * its undelete counts it again, and, for a user without View All Data and
 * Modify All Data, records to delete whose delete takes along records of
 * objects the user is not proven to see whole, not accepted (`UNSEEN`,
 * {@link RewindDiff.unseen}).
 *
 * An import of a `.sfcheckpoint` file is refused, beside the org's own
 * refusals, for a file that is no checkpoint file (`IMPORT_NOT_ARCHIVE`), one
 * a newer SandForge made (`IMPORT_VERSION`), a key that is not the file's
 * (`IMPORT_KEY`), a file changed or damaged since it was exported
 * (`IMPORT_DAMAGED`), too little room on this machine's disk (`IMPORT_DISK`),
 * and another checkpoint of its id kept here already (`IMPORT_KEPT_OTHER`).
 *
 * A rewind held to bounds ({@link RewindBounds}) — a pipeline's Rewind step,
 * whose bounds stand in for the person who would read the preview, or the
 * command line given `--max-records` or `--refuse-when-active` — is refused
 * besides with `TOO_MANY_TO_REWIND`, `PEOPLE_ACTIVE`,
 * `UNDELETABLE_UNATTENDED` and `NOT_CONFIRMED`, each said below.
 */
export type CheckpointRefusalCode =
  | 'PRODUCTION'
  /**
   * The org could not be typed, for a cause something lifts: its session was
   * refused, it did not answer, or its user may not read the Organization
   * record. Not `PRODUCTION`: the message says what lifts it.
   */
  | 'ORG_UNTYPED'
  | 'OTHER_ORG'
  | 'SCRATCH_EXPIRED'
  | 'PERMISSIONS'
  | 'RUN_WRITING'
  | 'API_BUDGET'
  | 'TOO_MANY_RECORDS'
  | 'AUTOMATION'
  | 'NO_UNDO'
  | 'RECREATE'
  | 'EMAILS'
  | 'FILE_STORAGE'
  | 'UNSEEN'
  | 'IMPORT_NOT_ARCHIVE'
  | 'IMPORT_VERSION'
  | 'IMPORT_KEY'
  | 'IMPORT_DAMAGED'
  | 'IMPORT_DISK'
  | 'IMPORT_KEPT_OTHER'
  /**
   * The rewind would delete, give back, bring back and make again more
   * records, all together, than its bound allows ({@link RewindBounds.maxRecords}):
   * a Rewind step's limit, or the command line's `--max-records`. Said with
   * both numbers. Not `TOO_MANY_RECORDS`, which is a take's limit.
   */
  | 'TOO_MANY_TO_REWIND'
  /**
   * Held to {@link RewindBounds.refuseWhenActive}: users other than the
   * rewind's own writers — the user it runs as and the org's Automated
   * Process — changed records of the checkpoint's objects in the hour before
   * the rewind began reading, whose work it would take back. Said with how
   * many people. A rewind from the panel shows them in its preview instead.
   */
  | 'PEOPLE_ACTIVE'
  /**
   * A rewind nobody watches — a pipeline's Rewind step — would delete records
   * of objects its user may not delete. The panel asks a person whether to
   * delete the rest; with nobody to ask, the answer is no: the deletion is
   * left untouched, nothing is written, and the objects are named.
   */
  | 'UNDELETABLE_UNATTENDED'
  /**
   * A pipeline's Rewind step that no person confirmed for its configuration
   * as saved: never confirmed, or confirmed before its configuration changed
   * (`rewindGrantDigest`). Said with the step's name, and that typing the
   * org's alias on the step confirms it.
   */
  | 'NOT_CONFIRMED'
  /**
   * Asked to mute the org's automation (`muteAutomation`), the rewind or the
   * undo could not: the org is a production org, its user cannot assign
   * permission sets, or a set could not be assigned. Said with why; nothing
   * was assigned, nothing written.
   */
  | 'MUTE'
  /**
   * A checkpoint asked before a run (`Checkpoint first`) would hold none of
   * the objects the run writes: each is left out, unproven held by a user
   * without View All Data and Modify All Data, or of a kind no checkpoint
   * holds. The run is refused, nothing written: the option promised a rewind.
   */
  | 'NOTHING_HELD'
  /**
   * A checkpoint asked before a run would not fit on this machine's disk: the
   * store's disk has less free than the take's bytes and a tenth more. Said
   * before anything is read, as an import is refused (`IMPORT_DISK`).
   */
  | 'DISK'
  /**
   * The org delivers every email its automation sends (Setup > Deliverability:
   * All email), or would not say whether it does, and what fires as the
   * rewind or the undo writes sends some: written only once that is accepted
   * (`acceptEmails`). Not `EMAILS`, the daily limit, which nothing lifts.
   */
  | 'EMAILS_DELIVERED';

/**
 * What a rewind nobody watches is held to, in the place of the person who
 * would read its preview first: a pipeline's Rewind step, whose bounds are
 * its configuration, or the command line given `--max-records` or
 * `--refuse-when-active`. The acceptances and the refusals every rewind
 * meets (`EMAILS` among them, which nothing lifts) apply besides.
 */
export interface RewindBounds {
  /**
   * The most records the rewind may delete, give back, bring back and make
   * again, all together, as its plan counts them; past it, `TOO_MANY_TO_REWIND`.
   * Absent, no such bound: the command line without `--max-records`.
   */
  maxRecords?: number;
  /**
   * Whether the rewind is refused (`PEOPLE_ACTIVE`) when anyone but its own
   * writers changed records of the checkpoint's objects in the hour before it
   * began reading. On a Developer Edition whose people share the user
   * SandForge connects as, their changes are that user's, and are not told
   * apart.
   */
  refuseWhenActive: boolean;
}

/**
 * A write a rewind or an undo makes, as the org's automation fires on it:
 * `insert` for a record a rewind makes again, with a new Id.
 */
export type CheckpointWrite = 'insert' | 'update' | 'delete' | 'undelete';

/**
 * The emails a rewind's or an undo's writes make the org send against one of
 * its daily limits, as its automation sends them — the flows, processes and
 * workflow rules that fire on each write and that no bypass the user holds
 * keeps quiet — against what the org has left of it today. Each email action
 * counts once a record, whatever condition decides it: an estimate that errs
 * says too much. On a Developer Edition, which counts its email alerts
 * against its fifteen single emails a day, the alerts are among the single
 * emails (`alertsCounted`).
 */
export interface CheckpointEmails {
  limit: ForgeEmailLimit;
  /** The emails, every object and write together. */
  emails: number;
  /** Per object and write: the records written, and the emails each sends, and by what. */
  objects: Array<{
    objectApiName: string;
    write: CheckpointWrite;
    records: number;
    perRecord: number;
    sentBy: string[];
  }>;
  /** Set when the org's email alerts are among `emails`: it counts them against its single emails. */
  alertsCounted?: true;
  /**
   * `exceeds` past what the org has left today, which refuses the act;
   * `unread` when the org did not say what it has left.
   */
  verdict: 'fits' | 'exceeds' | 'unread';
  /** What the org has left of the limit today, and its whole; absent when unread. */
  remaining?: number;
  max?: number;
  /** Why what it has left could not be read. */
  unread?: string;
}

/** A refusal said before anything runs, with the words a person reads. */
export interface CheckpointRefusal {
  code: CheckpointRefusalCode;
  message: string;
  /**
   * Of a take past its limit (`TOO_MANY_RECORDS`), the least limit the same
   * take is not refused at: the records of what it keeps there, the objects
   * its own limit left out for their size among them. Past a million, the
   * most any checkpoint holds of one object, no limit a take is given holds
   * them, and only fewer objects do.
   */
  holdingLimit?: number;
}

// ─── A checkpoint taken before a run (Checkpoint first) ──────────────────────

/**
 * What a run asks of the checkpoint it takes before its first write
 * (`checkpointFirst`, beside `muteAutomation` on the run's request): how many
 * days it is kept — `sandforge.checkpoint.beforeRunKeepDays` when not said,
 * 0 keeping it until it is deleted — and the objects, by API name, left out
 * of it. Absent from the request, the run takes none.
 */
export interface RunCheckpointRequest {
  keepDays?: number;
  excluded?: string[];
}

/** Why a checkpoint before a run holds an object beside those the run writes. */
export type RunCheckpointAddedCode =
  /** The target's automation that still runs creates its records as the run's writes fire it. */
  | 'createdByAutomation'
  /** Salesforce Files, which every checkpoint of picked objects holds. */
  | 'files'
  /** Attachments, which every checkpoint of picked objects holds. */
  | 'attachments'
  /** Held as every checkpoint of picked objects holds it. */
  | 'heldUnasked';

/** An automation of the target that creates the records of an object a checkpoint before a run adds. */
export interface RunCheckpointCreator {
  kind: 'flow' | 'process' | 'workflowRule' | 'trigger';
  name: string;
  /** The object whose records' write fires it. */
  objectApiName: string;
  write: 'insert' | 'update' | 'delete' | 'undelete';
}

/**
 * An object a checkpoint before a run holds beside those the run writes
 * (`added`), or leaves out (`notHeld`), and why: `code`, which a page says in
 * its language — a `RunCheckpointAddedCode` of what it holds, the
 * `CheckpointLeftOutCode` of what it leaves out —, and `reason`, the same in
 * English for the command line and a run's file: "the target's flow 'X'
 * creates Asset records as Case records go in", "Chatter posts… a rewind
 * leaves its records as they are", "left out as asked".
 */
export interface RunCheckpointObjectNote {
  objectApiName: string;
  /** Absent from a note kept before notes had codes: `reason` alone says why. */
  code?: RunCheckpointAddedCode | CheckpointLeftOutCode;
  reason: string;
  /** Of a left-out code, what it leaves to name, in the words it came in (`CheckpointLeftOutObject.detail`). */
  detail?: string;
  /** Of `pastTheLimit`, the object's records and the checkpoint's limit for one object. */
  records?: number;
  limit?: number;
  /** Of `createdByAutomation`, the automations that create its records, three at most. */
  creators?: RunCheckpointCreator[];
  /** Of `createdByAutomation`, how many more create them. */
  moreCreators?: number;
}

/**
 * What a checkpoint before a run would hold and cost, read before anything is
 * taken: what a run's question, its simulation and its dry run say. The
 * records, requests, seconds and bytes are the take's estimate, which the
 * run's API budget counts as its `checkpoint` part; `refusal`, the one a real
 * run would meet, which refuses it before its first write.
 */
export interface RunCheckpointEstimate {
  state: 'planned';
  estimate: CheckpointEstimate;
  /** The objects it would hold, by API name, those the run writes first. */
  objects: string[];
  added: RunCheckpointObjectNote[];
  notHeld: RunCheckpointObjectNote[];
  /** The days it would be kept; 0 keeps it until it is deleted. */
  keepDays: number;
  refusal?: CheckpointRefusal;
}

/**
 * The checkpoint a run took before its first write, as the run's result and
 * its history name it: where to rewind to, what it holds, and what it does
 * not. A process killed after the take leaves it ready.
 */
export interface RunCheckpointTaken {
  state: 'taken';
  checkpointId: string;
  /** `Before Forge run 2026-10-30 21:40 UTC`. */
  name: string;
  /** T1 of the take, org clock. */
  takenAt: ISODateString;
  /** When it is deleted from this machine; null keeps it until it is deleted. */
  expiresAt: ISODateString | null;
  /** The objects it holds, by API name. */
  objects: string[];
  records: number;
  bytes: number;
  /** The API requests the take sent. */
  requests: number;
  added: RunCheckpointObjectNote[];
  notHeld: RunCheckpointObjectNote[];
}

/**
 * A checkpoint a run took and deleted again: the run wrote nothing — its
 * mute refused, no row to write, or a stop before its first write — so there
 * was nothing for it to rewind.
 */
export interface RunCheckpointDeleted {
  state: 'deleted';
  deleted: 'nothingWritten';
}

/** What a run's result says of the checkpoint it took before its first write. */
export type RunCheckpointInfo = RunCheckpointTaken | RunCheckpointDeleted;

// ─── The preview: what a rewind would do ─────────────────────────────────────

/**
 * What a rewind cannot take back of an object, named in the preview: records
 * deleted since that the recycle bin no longer holds and that a rewind cannot
 * make again either — a file, whose body the checkpoint does not hold, or a
 * record the checkpoint holds no values of — leads converted since,
 * contracts activated since, records deleted since with a parent created
 * since that Salesforce does not undelete on its own, and records deleted
 * since with their parent, a record of an object the checkpoint does not
 * hold (`deletedWithParentOutside`): they come back with that parent only,
 * which a checkpoint holding its object would bring back — and files given a
 * new version since (`newFileVersion`): Salesforce neither deletes a version
 * nor lets the latest point back at an older one, so such a file keeps its
 * new content, the one it had staying in its version history.
 *
 * Read by a user without View All Data and Modify All Data
 * ({@link RewindDiff.access}): records deleted since by another user
 * (`deletedByOther`), whom the deleted row names its last modifier —
 * Salesforce brings back what someone else deleted for a user with Modify All
 * Data only, Modify All on the object notwithstanding (P-B3) — never tried,
 * never made again; and records of an object held through the records it
 * hangs from, neither live nor in what the user's read of the recycle bin
 * shows (`outOfReach`): nothing proves the user sees what others deleted of
 * it, so such a record may sleep in the bin out of sight, and is never made
 * again, which could leave two of it.
 */
export type RewindCannotUndoReason =
  | 'goneForGood'
  | 'convertedLead'
  | 'activatedContract'
  | 'deletedWithCreatedParent'
  | 'deletedWithParentOutside'
  | 'newFileVersion'
  | 'deletedByOther'
  | 'outOfReach';

/**
 * Fields of an object whose description changed since the take, by API name.
 * A field the describe no longer lists is either deleted since or hidden
 * from the user by field-level security, which takes it out of the describe
 * and of every query alike, View All Data and Modify All Data
 * notwithstanding. The Tooling API's `FieldDefinition` still lists a field
 * hidden so, and no longer one deleted: it tells a custom field's two cases
 * apart. A standard field cannot be deleted: one gone is hidden. None of the
 * three is read, compared or written.
 */
export interface RewindSchemaDrift {
  /** Custom fields deleted since, as `FieldDefinition` no longer lists them: named, with what to do. */
  removed: string[];
  /** Added since: their values are left alone. */
  added: string[];
  /** Whose type or flags changed: tried field by field. */
  changed: string[];
  /**
   * Hidden from the user since by field-level security: a standard field
   * gone from the describe, or a custom one `FieldDefinition` still lists.
   * Absent when none is.
   */
  hidden?: string[];
  /**
   * Custom fields gone from the describe that could not be told deleted from
   * hidden: the org refused the read of `FieldDefinition`, with its answer.
   * Absent when none is.
   */
  uncertain?: { fields: string[]; reason?: string };
}

/**
 * Why Undo couldn't bring back records a rewind deletes:
 *
 * - `onlyWithParent`: of an object Salesforce undeletes only with its parent
 *   (an opportunity's products), deleted on their own under a parent that
 *   stays;
 * - `deletedBeforeParent`: deleted before a record they point at, which the
 *   rewind deletes next — through a lookup that restricts that record's
 *   delete, or one whose delete would take them along but does not here (made
 *   while the checkpoint was taken, brought back since, changed as the rewind
 *   began). Salesforce keeps such a record in the recycle bin for good once
 *   that record is deleted after it: its undelete answers that it is not
 *   there, with that record, after it or before it. It holds as well of a
 *   record that goes with its own parent, and of what hangs from it: an
 *   opportunity whose price book the rewind deletes after its account, with
 *   its lines.
 */
export type RewindUndoCannotReason = 'onlyWithParent' | 'deletedBeforeParent';

/**
 * Records of one object a rewind deletes, or deleted, that Undo couldn't
 * bring back, for one reason. No reason is `onlyWithParent`, as a diff or a
 * result made before the second reason was told says it.
 */
export interface RewindUndoCannot {
  objectApiName: string;
  count: number;
  reason?: RewindUndoCannotReason;
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
   *
   * `carriers`: records the checkpoint does not hold — created since, or in
   * the recycle bin at the checkpoint and brought back since — deleted since
   * with records it holds, which their delete took along. Salesforce brings
   * those back with that record only: a rewind brings it back for a moment,
   * gives what it took along its checkpoint values, then deletes it again
   * with what came back with it. In none of the three numbers: before the
   * rewind and after it, such a record is in the recycle bin. Absent when
   * there is none, and from a diff read before carriers were told.
   */
  toBringBack: { inBin: number; withParent: number; deletedWhileTaken: number; carriers?: number };
  /**
   * Records deleted since that the recycle bin no longer gives back — gone
   * from it, or kept there for good — whose values the checkpoint holds: a
   * rewind makes them again, with the checkpoint's values and new Ids, and
   * points at the new Ids every lookup the checkpoint holds that named the old
   * ones. Anything outside Salesforce that names an old Id — an integration,
   * a link, a report filter — no longer finds the record. Absent from a diff
   * read before records were made again.
   */
  toRecreate?: number;
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

/**
 * What a rewind to a checkpoint that holds files would do to the links
 * between its files and its records, and what it leaves of the org's files.
 * The files themselves are records of `ContentDocument` among the diff's
 * objects: deleted, brought back, given their fields back, or named.
 */
export interface RewindFilesDiff {
  /** Links added since between a file and a record that both stay: removed. */
  unlink: number;
  /**
   * Links of the checkpoint removed since, between a file and a record that
   * both stay: inserted again, each under a new Id, as Salesforce brings no
   * link back from the recycle bin.
   */
  relink: number;
  /** Links whose sharing (`ShareType`, `Visibility`) changed since: given back. */
  updateLinks: number;
  /**
   * Files added since that no link ties to a record the checkpoint holds — a
   * user's own, a library's: left, and counted.
   */
  outsideAdded: number;
  /** Files deleted since that no link tied to a record the checkpoint holds: left in the recycle bin. */
  outsideDeleted: number;
  /** File storage, in bytes. */
  storage: {
    /** What the files it brings back from the recycle bin take once back: the bin holds them for nothing. */
    bringBack: number;
    /** What the org has left; absent when it did not say. */
    remaining?: number;
    /** What the files it deletes would take again, were Undo to bring them back. */
    undo: number;
  };
  /**
   * Set when the user lacks Query All Files: a file the user does not own
   * that no link ties to a record the checkpoint holds — in a library the
   * user is not a member of — is not seen, neither deleted nor brought back.
   */
  blindSpot?: true;
}

/** What a rewind did to the links between files and records, or an undo of one. */
export interface RewindFilesResult {
  /** Links it removed. */
  unlinked: number;
  /** Links it inserted again, each under a new Id. */
  relinked: number;
  /** Links it gave their sharing back. */
  linksUpdated: number;
  /** Links the org refused to remove, insert or update: each named among the residual. */
  linksRefused: number;
}

/**
 * How the user who read the org holds what it read: with View All Data and
 * Modify All Data (`org`), every record of every object, whoever changed it;
 * or, without them, object by object (`perObject`): View All and Modify All
 * on each object, or on every record it hangs from, read again at each act,
 * what reading them sent the org in `requests` — each act sends them again.
 * Read so, what other users deleted since stays in the recycle bin
 * (`deletedByOther`, `outOfReach`), and an object no longer held is not read.
 */
export type RewindDiffAccess = { kind: 'org' } | { kind: 'perObject'; requests: number };

/**
 * Records of one object a rewind deletes whose delete also takes along
 * records of objects the user is not proven to see whole — a private task of
 * another user under an account created since: no read counts them, and
 * Undo brings back only what comes back with them.
 */
export interface RewindDiffUnseen {
  /** The object of the records to delete. */
  objectApiName: string;
  /** The objects whose records go with them out of the user's sight. */
  children: string[];
  /** How many of its records the rewind deletes. */
  records: number;
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
   * Records it deletes that Undo couldn't bring back, per object and reason
   * ({@link RewindUndoCannot}). The rewind needs them accepted.
   */
  undoCannot: RewindUndoCannot[];
  /**
   * Records it deletes that go with a parent it deletes too, per object: made
   * since the checkpoint was taken and unchanged since the read began, they
   * are taken along by their parent's delete, never sent on their own, and
   * Undo brings them back with that parent. Absent when none does, and from
   * a diff read before they were counted.
   */
  withParentDeleted?: Array<{ objectApiName: string; count: number }>;
  /**
   * The requests it sent to tell, of the records it holds deleted since,
   * those deleted with a parent of an object outside the checkpoint: that
   * parent's object described, what the records point at read from the
   * recycle bin, and those parents read by id. Each read of the org since the
   * checkpoint sends them again. Absent when it sent none.
   */
  parentsOutsideRequests?: number;
  /**
   * The requests it sent to tell the custom fields gone from a describe
   * deleted since from those hidden by field-level security
   * (`RewindSchemaDrift`): each read of the org since the checkpoint sends
   * them again. Absent when it sent none.
   */
  fieldsRequests?: number;
  /**
   * How many of the checkpoint's objects it described again, asked whether
   * their fields changed since the take: `first`, before the change reads,
   * those it found something moved in since — and, of an org with person
   * accounts whose contacts moved, the account — 25 a call with a file's
   * link; `later`, once the counts were read, those nothing moved in that
   * hold fewer records than the checkpoint, 25 a call. Each read of the org
   * since the checkpoint describes as many again. Absent from a diff that
   * described every object it read.
   */
  described?: { first: number; later: number };
  /**
   * Of the objects it read, those whose fields it did not describe and left
   * with nothing to do: nothing moved in them since, so a rewind writes
   * nothing there, and a field deleted or hidden since in one of them is not
   * known. Absent when there is none.
   */
  fieldsNotChecked?: number;
  /**
   * The requests its reads of files sent beyond the reads every object has:
   * the links of the records it holds as they are now, the files it reads by
   * their ids — those the user sees no other way, those a link names that it
   * did not find — and the links of the files to delete to anything else.
   * Each read of the org since the checkpoint sends them again. Absent for a
   * checkpoint that holds no files.
   */
  filesRequests?: number;
  /**
   * Objects whose read failed, with the reason: never read as unchanged, so
   * the rewind leaves them as they are. An object the user no longer holds
   * whole, read object by object ({@link access}), is one of them, never read.
   */
  unread: Array<{ objectApiName: string; reason: string }>;
  /** How the user who read the org holds what it read: see {@link RewindDiffAccess}. */
  access: RewindDiffAccess;
  /**
   * Read object by object, per object of records to delete, the objects
   * their delete takes records of along that the user is not proven to see
   * whole: a rewind deletes them only once that is accepted (`UNSEEN`).
   * Absent when there is none, and from a read with View All Data and Modify
   * All Data.
   */
  unseen?: RewindDiffUnseen[];
  /** The names of the users {@link RewindDiffObject.lastChangedBy} counts, by user Id. */
  userNames: Record<string, string>;
  /** The users who changed records of the checkpoint's objects in the hour before Tr. */
  activeLastHour: string[];
  /**
   * The links between files and records, and the files left: absent for a
   * checkpoint that holds no files ({@link OrgCheckpoint.files}), whose
   * rewind leaves files added since where they are.
   */
  files?: RewindFilesDiff;
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
 * the preview the rewind acted on, the org refused the write — the insert of
 * a record made again among them — the recycle bin no longer holds it and it
 * could not be made again, the org answered as the rewind brought it back
 * that the bin no longer holds it — Salesforce still lists a record emptied
 * from it as deleted — and making it again was not accepted (`notInBin`), or
 * the rewind kept it as it had to — records outside a checkpoint of picked
 * objects hang from it and their deletion was not accepted, a record the
 * rewind left hangs from it, or Undo couldn't bring it back and that was not
 * accepted — which its `message` says.
 */
export type RewindResidualReason =
  | 'automation'
  | 'changedDuringRewind'
  | 'changedSincePreview'
  | 'refused'
  | 'notInBin'
  | 'goneForGood'
  | 'kept'
  | 'notBack';

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

/**
 * Records of one object a rewind made again, with new Ids, from the
 * checkpoint's values: those the recycle bin no longer gave back.
 */
export interface RewindRecreatedObject {
  objectApiName: string;
  /** Records it set out to make again. */
  planned: number;
  /** Records made again, each under a new Id. */
  created: number;
  /** Records the org refused to make, its reasons in {@link reasons}. */
  refused: number;
  /** Records a stop left before they were sent. */
  notReached?: number;
  /** The org's reasons, a few at most. */
  reasons: string[];
}

/** What a rewind, or an undo of one, did, object by object. */
export interface RewindResult {
  checkpointId: string;
  rewindId: string;
  /**
   * What the run muted of the target's automation, when it was asked to
   * (`muteAutomation`): the permission sets assigned to the user it wrote as
   * for its duration, what they silenced, what still ran, and whether they
   * were taken back. Absent when it was not asked.
   */
  mutedAutomation?: MutedAutomation;
  status: RewindStatus;
  /** What it deleted, per object, children before their parents. */
  deleted: ForgeUndoObjectResult[];
  /** What it gave back its values, per object. */
  restored: SyncRestoreObjectResult[];
  /** What it brought back from the recycle bin, per object, parents first. */
  undeleted: SyncUndeleteObjectResult[];
  /**
   * What it made again with new Ids, per object, parents first: records the
   * recycle bin no longer gave back. Absent when it made none, and from an
   * undo's result, which deletes what a rewind made.
   */
  recreated?: RewindRecreatedObject[];
  /**
   * An undo's alone: of what it sent to the recycle bin, per object, the
   * records the rewind had made again with new Ids that are no longer in the
   * org — deleted again, or gone with a record it deleted. Absent when there
   * is none.
   */
  remade?: Array<{ objectApiName: string; count: number }>;
  /**
   * A rewind's alone: per object, the records it brought back for a moment
   * to bring back records of the checkpoint they had taken along, then
   * deleted again (`RewindDiffObject.toBringBack.carriers`). Absent when
   * there is none.
   */
  carriers?: Array<{ objectApiName: string; count: number }>;
  /**
   * A rewind's alone: per object, the orders and contracts it made again as
   * drafts and was stopped before it gave back the status the checkpoint
   * holds, by their new Ids — the first of them when there are many. They
   * stay drafts until a rewind again gives them that status, an update.
   * Absent when there is none.
   */
  draftsLeft?: Array<{ objectApiName: string; count: number; ids: string[] }>;
  /**
   * An undo's alone: per object, the records it sent back to the recycle bin
   * on their own that had gone there with a record the rewind brought back
   * for a moment, which stays there. Back in the bin, such a record no
   * longer hangs from that record, and comes back alone. Absent when there
   * is none.
   */
  carriedAlone?: Array<{ objectApiName: string; count: number }>;
  /**
   * Of what it sent to the recycle bin, per object, the records that went
   * there with a record it deleted — counted in `deleted`, never sent on
   * their own: of a rewind, a contact created since with the account created
   * since it hangs from; of an undo, what had come back with a record, a
   * contact with its account, a feed or a history with its record. Absent
   * when there is none.
   */
  wentAlong?: Array<{ objectApiName: string; count: number }>;
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
   * object and reason. Absent from an undo's own result, and from a rewind
   * that wrote nothing.
   */
  undo?: { until: ISODateString; cannot: RewindUndoCannot[] };
  /**
   * A rewind's alone: the journals of the org's earlier rewinds it deleted
   * once it ended, by the checkpoint each rewound to — Undo reaches the org's
   * last rewind alone, and each held the values its rewind wrote over. Absent
   * when it deleted none.
   */
  removedJournals?: Array<{ checkpointId: string; name: string; rewindId: string }>;
  /**
   * What it did to the links between files and records: absent for a
   * checkpoint that holds no files, and when it touched no link. The files
   * it deleted and brought back are among {@link deleted} and
   * {@link undeleted}, as `ContentDocument`.
   */
  files?: RewindFilesResult;
  /** API requests it used, counted by SandForge, and the requests the org has left today. */
  apiRequests: { used: number; leftToday: number };
  finishedAt: ISODateString;
  /**
   * A rewind's alone, limited to some of the checkpoint's objects: see
   * {@link RewindScope}. Absent from a rewind of every object, and from an
   * undo's result.
   */
  scope?: RewindScope;
}

/**
 * The objects a rewind of some of a checkpoint's objects was limited to, and
 * what it left of the others. Its verification compares the objects picked
 * alone: what still differs in the others is counted here, never among the
 * residual, and never makes the rewind partial.
 */
export interface RewindScope {
  /** The objects picked, by API name. */
  objects: string[];
  /** The objects not picked that still differ from the checkpoint, and their records that do. */
  notRewound: { objects: string[]; records: number };
}

// ─── A rewind of some objects: its plan, made from a preview ────────────────

/**
 * Why a rewind limited to some objects leaves a record that differs, as its
 * plan made from the preview says before it runs:
 *
 * - `needsUnpickedParent`: it comes back only with a parent of an object not
 *   picked, which this rewind leaves deleted; or a lookup of it names such a
 *   parent, deleted since: its other fields are given back, that lookup left;
 * - `heldByUnpicked`: some of its values are held in place by children of an
 *   object not picked, created since (an opportunity's amount under its
 *   products): those fields are left;
 * - `outsideNotAccepted`: deleting it would take along records outside what
 *   this rewind rewinds — of an object not picked, or outside the
 *   checkpoint — and that was not accepted;
 * - `holdsLeft`: a record left hangs from it, which its deletion would take
 *   along;
 * - `keyTaken`: a row of a custom setting to bring back whose owner or name a
 *   live row holds.
 */
export type RewindSelectionLeftReason =
  'needsUnpickedParent' | 'heldByUnpicked' | 'outsideNotAccepted' | 'holdsLeft' | 'keyTaken';

/**
 * What a rewind limited to the objects picked would do to one object. An
 * object not picked is among them for what the rewind itself brings about
 * alone: children of it created since, which come back with a parent the
 * rewind brings back, deleted again.
 */
export interface RewindSelectionAct {
  objectApiName: string;
  /** Whether the object is one of those picked. */
  picked: boolean;
  toDelete: number;
  /**
   * Of {@link toDelete}, the records that go with a parent it deletes, never
   * sent on their own: what its estimate does not count sent. Absent from a
   * plan made before it was told.
   */
  withParent?: number;
  toGiveBack: number;
  toBringBack: number;
  toRecreate: number;
}

/**
 * What a rewind limited to the objects picked would do and leave, planned on
 * this machine from a preview with the rewind's own plan, the org not read:
 * the counts the rewind that follows it acts on, the preview's still holding.
 * A dependency is proposed, never added: the rewind does no more than what
 * was confirmed.
 */
export interface RewindSelectionPlan {
  /** The objects picked, by API name. */
  objects: string[];
  /** Per object it would write to, in the checkpoint's reading order. */
  acts: RewindSelectionAct[];
  /** Records that differ it would leave, per object and reason. */
  left: Array<{ objectApiName: string; reason: RewindSelectionLeftReason; count: number }>;
  /**
   * Objects not picked that records of those picked need to be rewound with,
   * each with how many of the records picked need it: what the page offers to
   * add, one by one.
   */
  needs: Array<{ objectApiName: string; records: number }>;
  /**
   * Records it deletes that Undo couldn't bring back, per object and reason
   * ({@link RewindUndoCannot}): a record deleted on its own because its
   * parent is not picked among them. The rewind needs them accepted.
   */
  undoCannot: RewindUndoCannot[];
}

// ─── The rewinds of an org, as the histories mark the runs they took back ────

/** What a rewind did in all, as its line in the ledger counts it: records, never which. */
export interface CheckpointRewindTotals {
  deleted: number;
  restored: number;
  undeleted: number;
  recreated: number;
}

/**
 * A rewind that wrote, as it ended: gone through, stopped part way, or ended
 * before it was through. Its four times are on the org's clock;
 * `orgAheadMs` is how far the org's clock was ahead of this machine's at the
 * rewind's last read of it, which puts them on the machine's clock the
 * histories of Seed, Sync and Forge date their runs by.
 */
export interface CheckpointRewindEnded {
  kind: 'rewind';
  rewindId: string;
  checkpointId: string;
  /** What the checkpoint was called when the rewind ended: the mark names it so. */
  checkpointName: string;
  organizationId: string;
  mode: CheckpointScopeMode;
  /** The objects the checkpoint held: all the rewind could take back. */
  objects: string[];
  /**
   * The objects the rewind was limited to, of {@link objects}: a run's writes
   * to the others it did not take back. Absent from a rewind of every object,
   * and from a line written before a rewind could be limited, read as one.
   */
  limitedTo?: string[];
  /** T0 of the checkpoint. */
  readFrom: ISODateString;
  /** T1 of the checkpoint. */
  takenAt: ISODateString;
  /** Tr, when the rewind began its reads. */
  startedAt: ISODateString;
  /** When it ended, or was stopped. */
  endedAt: ISODateString;
  /** Absent when the rewind never read the org's clock: the marks then read the two clocks as one. */
  orgAheadMs?: number;
  status: RewindStatus;
  totals: CheckpointRewindTotals;
}

/** The undo of a rewind once it went through, whole or in part, on this machine's clock. */
export interface CheckpointRewindUndone {
  kind: 'undo';
  /** The rewind it took back. */
  rewindId: string;
  checkpointId: string;
  organizationId: string;
  status: Extract<RewindStatus, 'success' | 'partial' | 'unstable'>;
  undoneAt: ISODateString;
}

/**
 * A line of an org's rewind ledger, `rewinds.ndjson` in the org's folder of
 * the store, beside its checkpoints and outliving them: what the Seed, Sync
 * and Forge histories mark a run rewound by. It names no record and holds no
 * value: the exact count of a run's records a rewind took is the run's
 * removal preview to give.
 */
export type CheckpointRewindRecord = CheckpointRewindEnded | CheckpointRewindUndone;

/**
 * A line of the ledger as `checkpoint:rewinds` answers it, with the
 * registered orgs it is of, by their ids in this machine's registry: those
 * that were its Organization Id, a sandbox refreshed since among them.
 */
export type CheckpointRewindListed = CheckpointRewindRecord & { orgIds: string[] };
