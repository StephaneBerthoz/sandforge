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

import type { ForgeEmailLimit, ForgeUndoObjectResult } from './forge.types.js';
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
  /** The layout of the file: its header, blocks and entries. */
  formatVersion: 1;
  /** The version of the `checkpoint.json` it holds. */
  checkpointFormat: 1;
  /** The SandForge that exported it. */
  sandforgeVersion: string;
  /** The org it is a checkpoint of: an import into any other is refused. */
  organizationId: string;
  orgTier: CheckpointOrgTier;
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
>;

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
  | 'NOT_CONFIRMED';

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
}

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
 * - `deletedBeforeParent`: deleted on their own before a record they point at,
 *   which the rewind deletes next — through a lookup that restricts that
 *   record's delete, or one whose delete would take them along but does not
 *   here (made while the checkpoint was taken, brought back since, changed as
 *   the rewind began). Salesforce keeps such a record in the recycle bin for
 *   good once that record is deleted after it: its undelete answers that it is
 *   not there, with that record, after it or before it.
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
  | 'kept';

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
   * An undo's alone: per object, the records it sent back to the recycle bin
   * on their own that had gone there with a record the rewind brought back
   * for a moment, which stays there. Back in the bin, such a record no
   * longer hangs from that record, and comes back alone. Absent when there
   * is none.
   */
  carriedAlone?: Array<{ objectApiName: string; count: number }>;
  /**
   * An undo's alone: of what it sent to the recycle bin, per object, the
   * records that went there with a record it deleted, as they had come back
   * with it — counted in `deleted`, never sent on their own: a contact with
   * its account, a feed or a history with its record. Absent when there is
   * none.
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
