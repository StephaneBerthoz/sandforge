/**
 * A rewind: the org put back as it was at a checkpoint, whoever changed it
 * since — what was created since deleted, what was changed since given its
 * checkpoint values back, what was deleted since brought back from the
 * recycle bin with its Id — then read again, and what still differs named
 * with why.
 *
 * Nothing is read before the guard has said the org is no production org, is
 * the checkpoint's own and lets its user see and put back every record; and
 * nothing is written before the org's lock is held, for the rewind's whole
 * length (neither its journal nor its bricks take it), no SandForge run of
 * this machine writes to the org, the day's requests are enough, and the
 * deletions Undo couldn't bring back and the automation the writes fire were
 * accepted. Each refusal names why, and writes nothing.
 *
 * **What it acts on.** Tr is read on the org's clock, then the org is read
 * again since the checkpoint (`rewindDiff`), and the first pass is planned
 * from what the user confirmed and what still differs (`rewindPlan`). A
 * command line that rewinds from the preview it just showed acts on that
 * preview, whose Tr it takes.
 *
 * **The order of one pass**, the order a Sync run's removal takes a run back
 * in (`removeSyncRun`): the removal of what is deleted reads its records, then
 * in its sweep, before its first delete, what was deleted since comes back,
 * parents first, and what was changed since gets its values back; then it
 * deletes, children first. What a record deleted by the pass held in place —
 * seen live, an opportunity's price book cannot change while it has products,
 * and its amount is theirs to add up — is given back once the pass's deletes
 * are through, and its refusal, when the org still refuses, says it waited for
 * them (`heldInPlaceReason`).
 *
 * - Brought back: a page of 2,000 ids at a time, the undelete's own batches
 *   of 200. Before each batch goes, the children the recycle bin holds of
 *   each of its records, through every relationship its object deletes
 *   along, are named in the journal as coming back with it: named after the
 *   undelete, a stop between the two would lose them, and its undo would keep
 *   the parent they hang from. After it, what the undelete left on its
 *   records is read, whoever the org names their last modifier: the dates an
 *   undelete moves are the rewind's own doing, and the children that came
 *   back with a record were dated in the same second.
 * - Given back: a chunk of 2,000 records a call, each chunk's values read
 *   from the snapshot by their offsets, the org's values read just before its
 *   writes. Only the fields the checkpoint compares and the org still has are
 *   read and written, and a person account's name, which the org computes,
 *   never. What each update writes over is kept in the journal before it
 *   goes. Of a record given back after the deletions, the values it held
 *   before the pass wrote anything are kept first: the deletions may change
 *   them before its give-back reads them, and Undo gives back the values kept
 *   first. An order past Draft that was Draft at the checkpoint gets its
 *   status back alone, first: its other fields stay locked until it is.
 * - Deleted: the records spooled to disk, handed to `removeRunRecords`, named
 *   in the journal before, and what it left named once it answered.
 *
 * **The second pass** runs once the first wrote anything: the org read again,
 * the pass planned from what the first left and from what the rewind's own
 * users — the one it writes as, the org's Automated Process — made after Tr,
 * with what every earlier write of the rewind left on records, so that its
 * own writes never read as someone's change since Tr. The read after the last
 * pass that wrote is the verify.
 *
 * **The verify** names each record that still differs, by object and reason:
 * gone for good; changed during the rewind by another user (the rewind is
 * then unstable); changed since the preview; kept by your automation — last
 * changed after Tr by the rewind's own users —; kept as the rewind had to;
 * refused, in the org's words. A record deleted while the checkpoint was
 * taken and brought back by the rewind reads, live and not in the snapshot,
 * as unexplained: it is the rewind's own, and never named.
 *
 * **Stop** reaches every phase: between two pages, two batches, two chunks,
 * two phases and two passes. A rewind stopped part way, or killed, leaves its
 * journal open: the next rewind of the checkpoint takes it up, reads the org
 * again and acts on what still differs, so nothing the journal says was done
 * is sent again, and its undo reaches the org as it was before the first
 * pass; one whose work the fresh read finds done is taken up only to end it.
 * Once through, the journal ends, and the checkpoint's last rewind says when,
 * and until when Undo can bring back what it deleted. A rewind that finds
 * nothing to write keeps no journal, and sends the org no more than the
 * guard, the day's limits and its one read.
 */

import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Connection } from 'jsforce';
import {
  blindedBy,
  firedOnRemovalStepsOf,
  type CheckpointRefusal,
  type CheckpointRefusalCode,
  type ForgeRemovalSpan,
  type ForgeRemovalSteps,
  type ForgeTargetAutomation,
  type ForgeUndoObjectResult,
  type OrgCheckpoint,
  type OrgTypeAndEdition,
  type RewindDiff,
  type RewindResidual,
  type RewindResidualReason,
  type RewindResult,
  type RewindStatus,
  type SyncRestoreObjectResult,
  type SyncUndeleteObjectResult,
} from '@sandforge/shared';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import { readColumnsApart } from '../../core/common/wideRead.js';
import { idLists, RECORDS_PER_CALL, workedObjects } from '../dataops/RecordRemoval.js';
import {
  removalOrg,
  removeRunRecords,
  type RemovalOrg,
  type RunRemovalOptions,
  type RunRemovalOutcome,
} from '../forge/ForgeRunRemoval.js';
import { orgDateTime } from '../sync/SyncDelta.js';
import {
  restoreOverwrites,
  type BackupReader,
  type SyncRestoreOutcome,
} from '../sync/SyncRunRestore.js';
import { undeleteRunDeletions, type UndeleteCall } from '../sync/SyncRunUndelete.js';
import {
  PERSON_ACCOUNT_FLAG,
  checkpointDescribeSchema,
  comparedFields,
  rowToWriteBack,
} from './checkpointFields.js';
import { guardCheckpoint } from './checkpointGuard.js';
import {
  OrgReadStopped,
  compositeReader,
  type CompositeReader,
  type CountedPage,
  type OrgRow,
} from './compositeQueries.js';
import {
  RECYCLE_BIN_DAYS,
  newFolderId,
  previewDirOf,
  type CheckpointFolder,
  type OrgCheckpointStore,
  type OrgLock,
  type OrgLockHolder,
} from './OrgCheckpointStore.js';
import { deletedSpoolOf, liveSpoolOf, readStreams, spooledRows } from './orgStreams.js';
import { classFileOf, rewindDiff, type RewindClass } from './rewindDiff.js';
import {
  budgetRefusal,
  readBudget,
  relationshipsOf,
  rewindEstimate,
  type ObjectRelationships,
} from './rewindEstimate.js';
import { openRewindJournal, type RewindJournal } from './rewindJournal.js';
import {
  heldInPlaceReason,
  rewindPlan,
  rewindWriters,
  type RewindPlan,
  type RewindPlanLeft,
  type RewindPlanLeftReason,
} from './rewindPlan.js';
import { SNAPSHOT_CHUNK_IDS, SnapshotIndex } from './snapshotIndex.js';
import { RecordKeySet, type IdSpool } from './spooledRunRecords.js';
import { takeOrgOf, type TakeOrg } from './takeCheckpoint.js';

// ─── Figures ─────────────────────────────────────────────────────────────────

/** The grain the org dates a write to: its second, truncated. */
const ORG_DATE_GRAIN_MS = 1_000;

/** How long Undo can bring back what a rewind deleted: the recycle bin's 15 days. */
const UNDO_WINDOW_MS = RECYCLE_BIN_DAYS * 24 * 60 * 60_000;

/** Ids a residual names at most: its count says how many there are. */
export const REWIND_RESIDUAL_IDS = 50;

/** Reasons a brick's result keeps of an object, as the bricks keep them: a few. */
const REASONS_KEPT = 5;

/** The classes of a diff a pass acts on, which name a record that still differs. */
const ACTED: readonly RewindClass[] = [
  'createdSince',
  'broughtBackSince',
  'comesBackWithParent',
  'giveBack',
  'inBin',
  'withParent',
  'deletedWhileTaken',
];

/** What the verify names: the classes a pass acts on, and what cannot come back. */
const STILL_DIFFERING: readonly RewindClass[] = [...ACTED, 'goneForGood'];

/** Which brick acts on the records of each class, whose refusal the verify quotes. */
const BRICK_OF: Readonly<Partial<Record<RewindClass, Brick>>> = {
  createdSince: 'removal',
  broughtBackSince: 'removal',
  comesBackWithParent: 'removal',
  giveBack: 'restore',
  inBin: 'undelete',
  withParent: 'undelete',
  deletedWhileTaken: 'undelete',
};

/** The bricks a pass writes through. */
type Brick = 'restore' | 'undelete' | 'removal';

/** Why a plan keeps a record it would otherwise act on: the rewind's choice, never the org's. */
const KEPT_WORDS: Readonly<Partial<Record<RewindPlanLeftReason, string>>> = {
  outsideNotAccepted:
    'Kept: records outside the checkpoint created since hang from it, and their deletion was ' +
    'not accepted.',
  holdsLeft:
    'Kept: a record the rewind left hangs from it, and its deletion would take that record along.',
  noUndoNotAccepted:
    "Kept: Undo couldn't bring it back once deleted on its own, and that was not accepted.",
};

/** What the verify says of a record it cannot tell a reason for. */
const STILL_DIFFERS = 'It still differs from the checkpoint once the org was read again.';

/** What a refusal before the first write did not do. */
const NOTHING_WRITTEN = 'No record was written.';

// ─── What a rewind works with ────────────────────────────────────────────────

/**
 * What a rewind reads an org through, as a take does — queries alone or in
 * composites, the global describe, the org's clock, the user it reads as —
 * and what a removal writes through: describes, updates, deletes, the
 * recycle bin.
 */
export interface RewindOrg extends TakeOrg {
  /** A page of a query, its count of every row it selects said too, as a removal reads it. */
  query(
    soql: string,
    options?: { scanAll?: boolean },
  ): Promise<CountedPage & { totalSize: number }>;
  describe(objectApiName: string): Promise<unknown>;
  update(objectApiName: string, records: Array<Record<string, unknown>>): Promise<unknown>;
  destroy(objectApiName: string, ids: string[]): Promise<unknown>;
  /** A query that reads the recycle bin too: one page. */
  queryDeleted(soql: string): Promise<{ records: unknown[] }>;
  /** A delete of one object through a Bulk API job, past the threshold a removal sends one at. */
  bulkDestroy?: RemovalOrg['bulkDestroy'];
}

/** A jsforce connection, as a rewind reads and writes the org through it. */
export function rewindOrgOf(conn: Connection): RewindOrg {
  const take = takeOrgOf(conn);
  const removal = removalOrg(conn, 'Checkpoint rewind');
  const bulkDestroy = removal.bulkDestroy;
  return {
    get version() {
      return take.version;
    },
    request: (request) => take.request(request),
    query: async (soql, options) =>
      await conn.query<OrgRow>(soql, { scanAll: options?.scanAll === true }),
    queryMore: (nextRecordsUrl) => take.queryMore(nextRecordsUrl),
    describeGlobal: () => take.describeGlobal(),
    serverTime: () => take.serverTime(),
    userId: () => take.userId(),
    describe: (objectApiName) => removal.describe(objectApiName),
    update: (objectApiName, records) => removal.update(objectApiName, records),
    destroy: (objectApiName, ids) => removal.destroy(objectApiName, ids),
    queryDeleted: (soql) => removal.queryDeleted(soql),
    ...(bulkDestroy
      ? {
          bulkDestroy: (objectApiName: string, ids: readonly string[], signal?: AbortSignal) =>
            bulkDestroy(objectApiName, ids, signal),
        }
      : {}),
  };
}

/** The phase a rewind is in, as its progress says it. */
export type RewindPhase = 'reading' | 'bringingBack' | 'givingBack' | 'deleting' | 'checking';

/** How far a rewind is. */
export interface RewindProgress {
  phase: RewindPhase;
  /** The pass: the rewind, or its convergence pass. */
  pass: 1 | 2;
  percentage: number;
  step: string;
}

/** What a rewind works with. */
export interface RewindDeps {
  org: RewindOrg;
  /** Takes records out of the recycle bin by their ids (`conn.soap.undelete`). */
  undelete: UndeleteCall;
  /** The store the checkpoint is kept in: the org's lock, and the checkpoint's last rewind. */
  store: Pick<OrgCheckpointStore, 'lock' | 'update'>;
  /**
   * What the org runs as records of `objects` are brought back, updated or
   * deleted. Not given, nothing of it is read, and nothing is refused for it.
   */
  readAutomation?: (objects: readonly string[]) => Promise<ForgeTargetAutomation>;
  /**
   * What else of this machine is writing to the org, said as a refusal names
   * it, or nothing. Asked once the org's lock is held, before anything is read.
   */
  runWriting?: (organizationId: string) => Promise<string | undefined> | string | undefined;
  /** Asked before a pass's first delete when the user may not delete some objects' records. */
  onUndeletable?: RunRemovalOptions['onUndeletable'];
  onProgress?: (progress: RewindProgress) => void;
  /** Stops the rewind before its next call to the org. */
  signal?: AbortSignal;
  /** This machine's clock: the ids of the reads and of the journal, and when it finished. */
  now?: () => Date;
}

/** What a rewind is asked. */
export interface RewindRequest {
  checkpoint: OrgCheckpoint;
  /** The checkpoint's folder: its snapshot, its previews, its rewinds' journals. */
  folder: CheckpointFolder;
  /** How the user knows the org: its alias, else its username. */
  orgName: string;
  /** The org as the registry holds it; undefined when it holds none, which the guard refuses. */
  registered: OrgTypeAndEdition | undefined;
  /** The user SandForge connects as. */
  username: string;
  /** The preview the user confirmed: the rewind acts on what of it still differs. */
  previewId: string;
  /**
   * The preview itself, when the rewind acts on it as read — the command
   * line rewinds from the diff it just showed, in the same command: no fresh
   * diff is read, and its Tr is the rewind's.
   */
  reusesPreview?: RewindDiff;
  /** Rewind even though the org runs automation as the rewind writes. */
  acceptAutomation: boolean;
  /** Delete records Undo couldn't bring back. */
  acceptNoUndo: boolean;
  /** A checkpoint of picked objects: delete too the records outside it that hang from what it deletes. */
  acceptOutside: boolean;
}

/** How a rewind ended: what it did and what still differs, or the refusal it met before writing. */
export type RewindOutcome =
  | {
      rewound: true;
      result: RewindResult;
      /** What could not be read, kept or said, in plain words; never thrown. */
      notes: string[];
    }
  | { rewound: false; refusal: CheckpointRefusal };

/** Why a rewind ended before it wrote anything: it was stopped. Nothing was written. */
export class RewindStopped extends Error {
  constructor() {
    super('The rewind was stopped before it wrote anything to the org.');
    this.name = 'RewindStopped';
  }
}

// ─── Small helpers ───────────────────────────────────────────────────────────

/** A record by its first fifteen characters. */
function keyOf(id: string): string {
  return id.slice(0, 15);
}

/** A date as the org gives it, `+0000` or `Z`, in milliseconds; NaN for anything else. */
function dateMs(value: unknown): number {
  const at = orgDateTime(value);
  return at === null ? Number.NaN : Date.parse(at);
}

/** The rows of a file of a read, or none when it holds none: a class nobody fell into has no file. */
async function* rowsOf(file: string): AsyncGenerator<OrgRow> {
  try {
    for await (const row of spooledRows(file)) yield row;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** {@link guardCheckpoint}'s view of the org: it reads the answer's records, nothing else of jsforce's query. */
function guardConnectionOf(org: RewindOrg): Pick<Connection, 'query'> {
  return { query: (soql: string) => org.query(soql) } as unknown as Pick<Connection, 'query'>;
}

/** A refusal under `code`. */
function refusedWith(code: CheckpointRefusalCode, message: string): RewindOutcome {
  return { rewound: false, refusal: { code, message } };
}

/** The refusal of a rewind while a take, another rewind or an undo of the org holds its lock. */
function lockedRefusal(orgName: string, holder: OrgLockHolder): CheckpointRefusal {
  const what =
    holder.operation === 'take'
      ? `A checkpoint of ${orgName} is being taken`
      : holder.operation === 'rewind'
        ? `A rewind is writing to ${orgName}`
        : holder.operation === 'undo'
          ? `An undo is writing to ${orgName}`
          : `SandForge is deleting checkpoints of ${orgName}`;
  return {
    code: 'RUN_WRITING',
    message:
      `${what} (process ${holder.pid} on ${holder.host}): rewind once it has ended. ` +
      'No record was read or written.',
  };
}

/** The refusal of a rewind that would delete records Undo couldn't bring back, not accepted. */
function noUndoRefusal(left: readonly RewindPlanLeft[]): CheckpointRefusal {
  const count = left.reduce((sum, entry) => sum + entry.count, 0);
  const objects = [...new Set(left.map((entry) => entry.objectApiName))].join(', ');
  return {
    code: 'NO_UNDO',
    message:
      `Undo couldn't bring back ${count} ${objects} record(s) this rewind deletes: Salesforce ` +
      'undeletes them only with their parent, which stays. Rewind refused; accept that Undo ' +
      `couldn't bring them back to rewind all the same. ${NOTHING_WRITTEN}`,
  };
}

/** The refusal of a rewind whose writes fire the org's automation, not accepted. */
function automationRefusal(
  orgName: string,
  automation: ForgeTargetAutomation,
  steps: ForgeRemovalSteps,
): CheckpointRefusal {
  const fired = firedOnRemovalStepsOf(automation, steps);
  const objects = [...new Set(fired.map((each) => each.objectApiName))];
  const what =
    fired.length > 0
      ? `${fired.length} flow(s), trigger(s) or rule(s) of ${objects.join(', ')} run as the ` +
        'rewind brings records back, gives them their values back or deletes them'
      : 'what runs as the rewind writes could not all be read, so automation may run';
  return {
    code: 'AUTOMATION',
    message:
      `${orgName}: ${what}. Rewind refused; accept that it runs to rewind all the same. ` +
      NOTHING_WRITTEN,
  };
}

/** What a read of the org's automation that failed answers: each part it reads left unread, and why. */
export function automationUnread(
  objects: readonly string[],
  reason: string,
): ForgeTargetAutomation {
  return {
    objectsRead: [...objects],
    objects: [],
    unread: (['flows', 'triggers', 'processes', 'workflowRules'] as const).map((part) => ({
      part,
      reason,
    })),
    conditionsNotRead: 0,
    conditionsBound: 0,
    requests: 0,
  };
}

/**
 * A brick's reason in a rewind's words. The bricks were written for a Sync
 * run's removal, which leaves a record "as the run wrote it": a rewind did
 * not write what it leaves, someone else did.
 */
export function inRewindWords(reason: string): string {
  return reason
    .replace(
      /the value from before is no longer taken/g,
      "the checkpoint's value is no longer taken",
    )
    .replace(/left as the run wrote it\b/g, 'left as it is')
    .replace(/left as the run wrote them\b/g, 'left as they are')
    .replace(
      /^The values from before the run could not be read:/,
      "The checkpoint's values could not be read:",
    )
    .replace(
      /record\(s\) of the run stay, and were not sent\./,
      'record(s) the rewind would delete stay, and were not sent.',
    );
}

/** Add a reason to a result's, each once, a few at most. */
function addReason(reasons: string[], reason: string): void {
  if (reasons.length < REASONS_KEPT && !reasons.includes(reason)) reasons.push(reason);
}

/** Add `count` from `categories` of `tally`, in turn, as far as they hold it: what a retry settled. */
function settle<T extends object>(
  tally: T,
  categories: ReadonlyArray<keyof T>,
  count: number,
): void {
  let left = count;
  for (const category of categories) {
    if (left <= 0) return;
    const held = Number(tally[category] ?? 0);
    const taken = Math.min(held, left);
    (tally as Record<keyof T, unknown>)[category] = held - taken;
    left -= taken;
  }
}

// ─── The tally of the bricks ─────────────────────────────────────────────────

function emptyRestore(objectApiName: string): SyncRestoreObjectResult {
  return {
    objectApiName,
    planned: 0,
    restored: 0,
    keptChanged: 0,
    alreadyGone: 0,
    refused: 0,
    notKept: 0,
    reasons: [],
  };
}

function addRestore(into: SyncRestoreObjectResult, from: SyncRestoreObjectResult): void {
  into.planned += from.planned;
  into.restored += from.restored;
  into.keptChanged += from.keptChanged;
  into.alreadyGone += from.alreadyGone;
  into.refused += from.refused;
  into.notKept += from.notKept;
  if (from.notReached) into.notReached = (into.notReached ?? 0) + from.notReached;
  if (from.restoredWithout)
    into.restoredWithout = (into.restoredWithout ?? 0) + from.restoredWithout;
  for (const reason of from.reasons) addReason(into.reasons, reason);
}

function emptyUndelete(objectApiName: string): SyncUndeleteObjectResult {
  return {
    objectApiName,
    planned: 0,
    undeleted: 0,
    alreadyBack: 0,
    goneForGood: 0,
    refused: 0,
    reasons: [],
  };
}

function addUndelete(into: SyncUndeleteObjectResult, from: SyncUndeleteObjectResult): void {
  into.planned += from.planned;
  into.undeleted += from.undeleted;
  into.alreadyBack += from.alreadyBack;
  into.goneForGood += from.goneForGood;
  into.refused += from.refused;
  if (from.notReached) into.notReached = (into.notReached ?? 0) + from.notReached;
  for (const reason of from.reasons) addReason(into.reasons, reason);
}

function addDeleted(into: ForgeUndoObjectResult, from: ForgeUndoObjectResult): void {
  into.planned += from.planned;
  into.deleted += from.deleted;
  into.alreadyGone += from.alreadyGone;
  into.keptChanged += from.keptChanged;
  into.keptDependents += from.keptDependents;
  into.refused += from.refused;
  if (from.notVisible) into.notVisible = (into.notVisible ?? 0) + from.notVisible;
  for (const object of from.heldBy) if (!into.heldBy.includes(object)) into.heldBy.push(object);
  for (const object of from.unchecked) {
    if (!into.unchecked.includes(object)) into.unchecked.push(object);
  }
  for (const reason of from.reasons) addReason(into.reasons, reason);
  if (from.filesLeft) {
    into.filesLeft = {
      count: (into.filesLeft?.count ?? 0) + from.filesLeft.count,
      names: [...(into.filesLeft?.names ?? []), ...from.filesLeft.names].slice(0, REASONS_KEPT),
    };
  }
}

/** What one pass did, object by object, and what each brick left, by record. */
class PassTally {
  readonly restored = new Map<string, SyncRestoreObjectResult>();
  readonly undeleted = new Map<string, SyncUndeleteObjectResult>();
  readonly deleted = new Map<string, ForgeUndoObjectResult>();
  /** Per brick and object, the records it left: what the verify quotes its reasons for, and what the next pass retries. */
  readonly left: Record<Brick, Map<string, RecordKeySet>> = {
    restore: new Map(),
    undelete: new Map(),
    removal: new Map(),
  };
  /**
   * Per object, why its records given back after the deletions waited, and
   * those of them the org still refused or took without some fields.
   */
  readonly heldInPlace = new Map<string, { reason: string; ids: RecordKeySet }>();
  wrote = false;
  cancelled = false;

  leftBy(brick: Brick, objectApiName: string, ids: Iterable<string>): void {
    let held = this.left[brick].get(objectApiName);
    if (!held) {
      held = new RecordKeySet();
      this.left[brick].set(objectApiName, held);
    }
    for (const id of ids) held.add(id);
  }

  restore(from: SyncRestoreObjectResult): void {
    const into = this.restored.get(from.objectApiName) ?? emptyRestore(from.objectApiName);
    addRestore(into, { ...from, reasons: from.reasons.map(inRewindWords) });
    this.restored.set(from.objectApiName, into);
  }

  undelete(from: SyncUndeleteObjectResult): void {
    const into = this.undeleted.get(from.objectApiName) ?? emptyUndelete(from.objectApiName);
    addUndelete(into, from);
    this.undeleted.set(from.objectApiName, into);
  }

  delete(objects: readonly ForgeUndoObjectResult[]): void {
    for (const from of objects) {
      const into = this.deleted.get(from.objectApiName);
      const worded = { ...from, reasons: from.reasons.map(inRewindWords) };
      if (into) addDeleted(into, worded);
      else this.deleted.set(from.objectApiName, structuredClone(worded));
    }
  }
}

/** The records of `spools`, per object, by key. */
async function keysOf(spools: readonly IdSpool[]): Promise<Map<string, RecordKeySet>> {
  const keys = new Map<string, RecordKeySet>();
  for (const spool of spools) {
    for (const { objectApiName } of spool.objects) {
      const held = keys.get(objectApiName) ?? new RecordKeySet();
      for await (const ids of spool.pages(objectApiName)) for (const id of ids) held.add(id);
      keys.set(objectApiName, held);
    }
  }
  return keys;
}

/**
 * Of the records the second pass acted on, per object, those the first acted
 * on too: each one's outcome of the first pass is replaced by its outcome of
 * the second — a failure of the first it settles, or a success its own
 * automation undid since.
 */
async function retriedOf(
  second: readonly IdSpool[],
  first: readonly IdSpool[],
): Promise<Map<string, number>> {
  const before = await keysOf(first);
  const seen = new Map<string, RecordKeySet>();
  const retried = new Map<string, number>();
  for (const spool of second) {
    for (const { objectApiName } of spool.objects) {
      const earlier = before.get(objectApiName);
      if (!earlier) continue;
      const counted = seen.get(objectApiName) ?? new RecordKeySet();
      seen.set(objectApiName, counted);
      for await (const ids of spool.pages(objectApiName)) {
        for (const id of ids) {
          if (earlier.has(id) && counted.add(id)) {
            retried.set(objectApiName, (retried.get(objectApiName) ?? 0) + 1);
          }
        }
      }
    }
  }
  return retried;
}

/** What the passes did, the second's retries counted once, by their last outcome. */
async function passesTally(
  firstPass: { tally: PassTally; plan: RewindPlan },
  second: { tally: PassTally; plan: RewindPlan } | undefined,
): Promise<{
  deleted: ForgeUndoObjectResult[];
  restored: SyncRestoreObjectResult[];
  undeleted: SyncUndeleteObjectResult[];
}> {
  const first = firstPass.tally;
  const deleted = new Map(
    [...first.deleted].map(([name, result]) => [name, structuredClone(result)]),
  );
  const restored = new Map(
    [...first.restored].map(([name, result]) => [name, structuredClone(result)]),
  );
  const undeleted = new Map(
    [...first.undeleted].map(([name, result]) => [name, structuredClone(result)]),
  );
  if (second) {
    const { tally, plan } = second;
    const restoreRetried = await retriedOf(
      [plan.giveBack.beforeDeletes, plan.giveBack.afterDeletes],
      [firstPass.plan.giveBack.beforeDeletes, firstPass.plan.giveBack.afterDeletes],
    );
    for (const [name, from] of tally.restored) {
      const into = restored.get(name) ?? emptyRestore(name);
      const retried = restoreRetried.get(name) ?? 0;
      settle(
        into,
        [
          'refused',
          'notReached',
          'notKept',
          'keptChanged',
          'restoredWithout',
          'alreadyGone',
          'restored',
        ],
        retried,
      );
      into.planned -= Math.min(retried, into.planned);
      addRestore(into, from);
      restored.set(name, into);
    }
    const undeleteRetried = await retriedOf([plan.bringBack], [firstPass.plan.bringBack]);
    for (const [name, from] of tally.undeleted) {
      const into = undeleted.get(name) ?? emptyUndelete(name);
      const retried = undeleteRetried.get(name) ?? 0;
      settle(into, ['refused', 'notReached', 'goneForGood', 'alreadyBack', 'undeleted'], retried);
      into.planned -= Math.min(retried, into.planned);
      addUndelete(into, from);
      undeleted.set(name, into);
    }
    const removalRetried = await retriedOf([plan.deletes.spool], [firstPass.plan.deletes.spool]);
    for (const [name, from] of tally.deleted) {
      const into = deleted.get(name);
      if (!into) {
        deleted.set(name, structuredClone(from));
        continue;
      }
      const retried = removalRetried.get(name) ?? 0;
      settle(
        into,
        ['refused', 'keptDependents', 'keptChanged', 'notVisible', 'alreadyGone', 'deleted'],
        retried,
      );
      into.planned -= Math.min(retried, into.planned);
      addDeleted(into, from);
    }
  }
  for (const [name, { reason }] of [...first.heldInPlace, ...(second?.tally.heldInPlace ?? [])]) {
    const result = restored.get(name);
    if (result) addReason(result.reasons, reason);
  }
  return {
    deleted: [...deleted.values()],
    restored: [...restored.values()],
    undeleted: [...undeleted.values()],
  };
}

// ─── A read of the org since the checkpoint ──────────────────────────────────

/** A diff read by the rewind, or the preview it acts on, and its folder. */
interface DiffRead {
  diff: RewindDiff;
  dir: string;
}

/** A plan the rewind made, as the verify reads what it acted on and what it kept. */
interface PlanMade {
  plan: RewindPlan;
  /** Per object, every record a class of the plan names: what it acted on. */
  acted: Map<string, RecordKeySet>;
}

/**
 * A reader that keeps every describe it is answered in full, by object: the
 * relationships a pass reads the children that come back with a record
 * through, and the estimate counts.
 */
function keepingDescribes(reader: CompositeReader): {
  reader: CompositeReader;
  bodies: Map<string, unknown>;
} {
  const bodies = new Map<string, unknown>();
  return {
    bodies,
    reader: {
      lane: () => reader.lane(),
      calls: () => reader.calls(),
      describe: async (objectApiName, modifiedSince) => {
        const answer = await reader.describe(objectApiName, modifiedSince);
        if ('body' in answer) bodies.set(objectApiName, answer.body);
        return answer;
      },
    },
  };
}

/** The objects whose records each step of a plan writes, and what a removal sets back to Draft. */
function stepsOf(plan: RewindPlan): ForgeRemovalSteps {
  const objects = plan.objects;
  const deleted = objects
    .filter((object) => object.deleted + object.withParentDeleted + object.nextPassDeleted > 0)
    .map((object) => object.objectApiName);
  return {
    bringBack: objects
      .filter((object) => object.broughtBack + object.backWithParent > 0)
      .map((object) => object.objectApiName),
    giveBack: objects
      .filter(
        (object) => object.givenBackFirst + object.givenBackAfter + object.givenBackNextPass > 0,
      )
      .map((object) => object.objectApiName),
    // An order activated since is set back to Draft before its delete: the
    // platform deletes one no other way.
    setToDraft: deleted.filter((name) => name === 'Order'),
    delete: deleted,
  };
}

/** Whether a plan writes anything to the org. */
function writes(plan: RewindPlan): boolean {
  return (
    plan.deletes.spool.count +
      plan.bringBack.count +
      plan.giveBack.beforeDeletes.count +
      plan.giveBack.afterDeletes.count >
    0
  );
}

// ─── The rewind ──────────────────────────────────────────────────────────────

/**
 * The calls a rewind, or an undo of one, sends the org through `org`,
 * counted: a composite is one request, whatever it holds, and every SOAP call
 * one more — the clock, the user, each undelete — which a count of the
 * connection's REST requests does not see.
 */
export function counted(
  org: RewindOrg,
  undelete: UndeleteCall,
): { org: RewindOrg; undelete: UndeleteCall; used: () => number; add: (requests: number) => void } {
  let used = 0;
  const one = <T>(call: () => Promise<T>): Promise<T> => {
    used++;
    return call();
  };
  const bulkDestroy = org.bulkDestroy?.bind(org);
  return {
    org: {
      get version() {
        return org.version;
      },
      request: (request) => one(() => org.request(request)),
      query: (soql, options) => one(() => org.query(soql, options)),
      queryMore: (nextRecordsUrl) => one(() => org.queryMore(nextRecordsUrl)),
      describeGlobal: () => one(() => org.describeGlobal()),
      serverTime: () => one(() => org.serverTime()),
      userId: () => one(() => org.userId()),
      describe: (objectApiName) => one(() => org.describe(objectApiName)),
      update: (objectApiName, records) => one(() => org.update(objectApiName, records)),
      destroy: (objectApiName, ids) => one(() => org.destroy(objectApiName, ids)),
      queryDeleted: (soql) => one(() => org.queryDeleted(soql)),
      ...(bulkDestroy
        ? {
            bulkDestroy: (objectApiName: string, ids: readonly string[], signal?: AbortSignal) =>
              one(() => bulkDestroy(objectApiName, ids, signal)),
          }
        : {}),
    },
    undelete: (ids) => one(() => undelete(ids)),
    used: () => used,
    add: (requests) => {
      used += requests;
    },
  };
}

/**
 * Rewind an org to a checkpoint: see the module's comment.
 *
 * @returns What it did and what still differs, stopped part way included;
 *   or the refusal a guard or a gate gave, with nothing written.
 * @throws {RewindStopped} When it was stopped before it wrote anything.
 * @throws When a call to the org failed outright, or the checkpoint's files
 *   or the journal could not be read or written: the journal stays open, and
 *   the next rewind of the checkpoint takes it up.
 */
export async function rewindOrg(deps: RewindDeps, request: RewindRequest): Promise<RewindOutcome> {
  const { checkpoint, orgName } = request;
  if (request.reusesPreview && request.reusesPreview.previewId !== request.previewId) {
    throw new Error('A rewind acts on the preview it names: the one given is another.');
  }
  const count = counted(deps.org, deps.undelete);
  const guard = await guardCheckpoint(guardConnectionOf(count.org), {
    act: 'rewind',
    orgName,
    registered: request.registered,
    username: request.username,
    organizationId: checkpoint.org.organizationId,
  });
  if (!guard.allowed) return { rewound: false, refusal: guard.refusal };
  const locked = deps.store.lock(checkpoint.org.organizationId, 'rewind', checkpoint.checkpointId);
  if ('busy' in locked) return { rewound: false, refusal: lockedRefusal(orgName, locked.busy) };
  const rewind = new Rewind(deps, request, count, locked.lock);
  try {
    const writing = await deps.runWriting?.(guard.org.id);
    if (writing !== undefined) return refusedWith('RUN_WRITING', writing);
    return await rewind.go();
  } finally {
    await rewind.cleanUp();
    locked.lock.release();
  }
}

/** One rewind under way: see the module's comment. */
class Rewind {
  private readonly org: RewindOrg;
  private readonly signal: AbortSignal | undefined;
  private readonly now: () => Date;
  private readonly notes: string[] = [];
  /** The folders of the reads it made, deleted once it is over. */
  private readonly ownDirs: string[] = [];
  /** Whether it went through: the preview it acted on is then deleted too. */
  private ended = false;
  private readonly kept: ReturnType<typeof keepingDescribes>;
  /** The org's objects, described once when a read needs them. */
  private global: Promise<unknown> | undefined;
  /** Every date a write of the rewind left on a record, by id: its own doing, whoever the org names. */
  private readonly stamps: Record<string, string> = {};
  /** The same dates, by the record's key, in milliseconds. */
  private readonly stampOf = new Map<string, number>();
  /** When its removals ran, and as whom. */
  private readonly spans: ForgeRemovalSpan[] = [];
  /** The user the rewind writes as. */
  private userId = '';
  /** The users whose writes are the rewind's own, by their keys. */
  private owners = new Set<string>();
  /** Tr, in milliseconds, less the second the org dates to: what it dates no later was made before Tr. */
  private before = Number.NaN;

  constructor(
    private readonly deps: RewindDeps,
    private readonly request: RewindRequest,
    private readonly count: ReturnType<typeof counted>,
    private readonly lock: OrgLock,
  ) {
    this.org = count.org;
    this.signal = deps.signal;
    this.now = deps.now ?? (() => new Date());
    this.kept = keepingDescribes(compositeReader(this.org, this.signal));
  }

  private stopped(): boolean {
    return this.signal?.aborted === true;
  }

  private progress(phase: RewindPhase, pass: 1 | 2, percentage: number, step: string): void {
    this.deps.onProgress?.({ phase, pass, percentage, step });
  }

  private describeGlobal(): Promise<unknown> {
    return (this.global ??= this.org.describeGlobal());
  }

  /** The org read again since the checkpoint, at `readAt`, into a folder of its own. */
  private async diff(readAt: string): Promise<DiffRead> {
    const previewId = newFolderId('pv', this.now());
    const dir = previewDirOf(this.request.folder, previewId);
    this.ownDirs.push(dir);
    const diff = await rewindDiff({
      checkpoint: this.request.checkpoint,
      folder: this.request.folder,
      reader: this.kept.reader,
      describeGlobal: () => this.describeGlobal(),
      previewId,
      readAt,
      ...(this.signal ? { signal: this.signal } : {}),
    });
    return { diff, dir };
  }

  /** A pass planned in a folder of its own, beside the read it is made from. */
  private async plan(
    pass: 1 | 2,
    confirmedDir: string,
    fresh: DiffRead,
    readAt: string,
  ): Promise<PlanMade> {
    const plan = await rewindPlan({
      checkpoint: this.request.checkpoint,
      pass,
      confirmedDir,
      freshDir: fresh.dir,
      readAt,
      ownWriters: rewindWriters(this.request.checkpoint.takenBy, this.userId),
      acceptOutside: this.request.acceptOutside,
      acceptNoUndo: this.request.acceptNoUndo,
      ...(pass === 2 && Object.keys(this.stamps).length > 0
        ? { removalStamps: { ...this.stamps } }
        : {}),
      ...(pass === 2 && this.spans.length > 0 ? { removalSpans: [...this.spans] } : {}),
      dir: join(fresh.dir, `plan${pass}-${randomBytes(4).toString('hex')}`),
      ...(this.signal ? { signal: this.signal } : {}),
    });
    const acted = new Map<string, RecordKeySet>();
    for (const { objectApiName } of this.request.checkpoint.objects) {
      const held = new RecordKeySet();
      for (const cls of ACTED) {
        for await (const row of rowsOf(classFileOf(plan.dir, objectApiName, cls))) {
          if (typeof row.Id === 'string') held.add(row.Id);
        }
      }
      if (held.size > 0) acted.set(objectApiName, held);
    }
    return { plan, acted };
  }

  /** The relationships of the objects the reads described, for the estimate. */
  private async relationships(): Promise<Map<string, ObjectRelationships>> {
    const read = this.global;
    const worked = read
      ? new Set((await workedObjects({ describeGlobal: () => read })).keys())
      : undefined;
    const inCheckpoint = new Set(
      this.request.checkpoint.objects.map(({ objectApiName }) => objectApiName.toLowerCase()),
    );
    const relationships = new Map<string, ObjectRelationships>();
    for (const [objectApiName, body] of this.kept.bodies) {
      relationships.set(
        objectApiName,
        relationshipsOf(body, { inCheckpoint, ...(worked ? { worked } : {}) }),
      );
    }
    return relationships;
  }

  async go(): Promise<RewindOutcome> {
    const { checkpoint, orgName, folder } = this.request;
    const budget = await readBudget(this.org, orgName);
    if (this.stopped()) throw new RewindStopped();

    // ─── Tr, the read it acts on, and the first pass ───
    this.progress('reading', 1, 5, `Reading ${orgName} again`);
    const reused = this.request.reusesPreview;
    let tr: string;
    let fresh: DiffRead;
    let first: PlanMade;
    try {
      tr = reused ? reused.readAt : await this.org.serverTime();
      this.before = Date.parse(tr) - ORG_DATE_GRAIN_MS;
      if (!Number.isFinite(this.before)) throw new Error(`Not a date: ${tr}`);
      fresh = reused
        ? { diff: reused, dir: previewDirOf(folder, this.request.previewId) }
        : await this.diff(tr);
      first = await this.plan(1, previewDirOf(folder, this.request.previewId), fresh, tr);
    } catch (err: unknown) {
      if (err instanceof OrgReadStopped || this.stopped()) throw new RewindStopped();
      throw err;
    }

    // ─── What it refuses before it writes ───
    const noUndo = first.plan.left.filter((entry) => entry.reason === 'noUndoNotAccepted');
    if (noUndo.length > 0) return { rewound: false, refusal: noUndoRefusal(noUndo) };
    // A rewind stopped part way that wrote, whose work the fresh read finds
    // done: its journal is taken up to end it, and its Undo stays offered.
    const last = checkpoint.lastRewind;
    const stoppedBefore =
      last !== undefined && last.endedAt === undefined && last.undoneAt === undefined;
    const writing = writes(first.plan);
    if (!writing && !stoppedBefore) return this.wroteNothing(fresh, first, budget.remaining);
    const steps = stepsOf(first.plan);
    let automation: ForgeTargetAutomation | undefined;
    if (writing && this.deps.readAutomation) {
      const objects = [
        ...new Set([
          ...(steps.bringBack ?? []),
          ...(steps.giveBack ?? []),
          ...(steps.setToDraft ?? []),
          ...(steps.delete ?? []),
        ]),
      ];
      try {
        automation = await this.deps.readAutomation(objects);
      } catch (err: unknown) {
        automation = automationUnread(objects, extractErrorMessage(err));
      }
      // Read through the host's own reader: counted as it says it sent them.
      this.count.add(automation.requests);
    }
    const rest = rewindEstimate({
      objects: checkpoint.objects,
      diff: fresh.diff,
      automationRequests: 0,
      relationships: await this.relationships(),
      reusesPreview: true,
    });
    const overBudget = budgetRefusal(
      'rewind',
      this.count.used() + rest.apiRequests,
      budget,
      orgName,
    );
    if (writing && overBudget) return { rewound: false, refusal: overBudget };
    if (
      automation &&
      !this.request.acceptAutomation &&
      (firedOnRemovalStepsOf(automation, steps).length > 0 || blindedBy(automation.unread))
    ) {
      return { rewound: false, refusal: automationRefusal(orgName, automation, steps) };
    }
    if (this.stopped()) throw new RewindStopped();
    // The user it writes as, read once it will write: what its own writes
    // and the automation they fire are told by, from the first write on.
    this.userId = await this.org.userId();
    this.owners = new Set(rewindWriters(checkpoint.takenBy, this.userId).map(keyOf));

    // ─── The journal, then the passes ───
    const journal = await openRewindJournal({
      folder,
      lock: this.lock,
      startedAt: tr,
      userId: this.userId,
      ...(checkpoint.takenBy.automatedProcessUserId !== undefined
        ? { automatedProcessUserId: checkpoint.takenBy.automatedProcessUserId }
        : {}),
      now: this.now,
    });
    try {
      return await this.passes(journal, tr, fresh, first, budget.remaining);
    } finally {
      await journal.close();
    }
  }

  /** A rewind whose first pass has nothing to write: what was read is what still differs. */
  private async wroteNothing(
    fresh: DiffRead,
    first: PlanMade,
    remaining: number,
  ): Promise<RewindOutcome> {
    const residual = await this.residualOf(fresh, [first], new PassTally());
    this.ended = true;
    return {
      rewound: true,
      result: this.resultOf({
        rewindId: newFolderId('rw', this.now()),
        status: residual.length > 0 || fresh.diff.unread.length > 0 ? 'partial' : 'success',
        tally: { deleted: [], restored: [], undeleted: [] },
        residual,
        unread: fresh.diff.unread,
        passes: 1,
        leftToday: remaining,
      }),
      notes: this.notes,
    };
  }

  private async passes(
    journal: RewindJournal,
    tr: string,
    fresh: DiffRead,
    first: PlanMade,
    remaining: number,
  ): Promise<RewindOutcome> {
    const { checkpoint } = this.request;
    const prior = await journal.read();
    this.addStamps(prior.rewind.removalStamps ?? {});
    this.spans.push(...(prior.rewind.removalSpans ?? []));
    const undoUntil = new Date(Date.parse(prior.head.startedAt) + UNDO_WINDOW_MS).toISOString();
    await this.deps.store.update(checkpoint.checkpointId, (held) => ({
      ...held,
      lastRewind: { rewindId: journal.rewindId, undoUntil },
    }));

    const writing = writes(first.plan);
    const one = writing ? await this.pass(journal, first.plan, fresh.diff, 1) : new PassTally();
    const made: PlanMade[] = [first];
    let second: { tally: PassTally; plan: RewindPlan } | undefined;
    let verify: DiffRead | undefined;
    let cancelled = one.cancelled;
    try {
      if (!cancelled && one.wrote) {
        this.progress('reading', 2, 70, `Reading ${this.request.orgName} again`);
        const again = await this.diff(await this.org.serverTime());
        const next = await this.plan(2, first.plan.dir, again, tr);
        made.push(next);
        verify = again;
        if (writes(next.plan)) {
          const two = await this.pass(journal, next.plan, again.diff, 2);
          second = { tally: two, plan: next.plan };
          cancelled = two.cancelled;
          if (!cancelled && two.wrote) {
            this.progress('checking', 2, 90, `Checking ${this.request.orgName}`);
            verify = await this.diff(await this.org.serverTime());
          }
        }
      } else if (!cancelled && writing) {
        // Nothing went: the org is read again all the same, for what changed
        // under the refusals, by whom.
        this.progress('checking', 1, 90, `Checking ${this.request.orgName}`);
        verify = await this.diff(await this.org.serverTime());
      } else if (!cancelled) {
        verify = fresh;
      }
    } catch (err: unknown) {
      if (!(err instanceof OrgReadStopped) && !this.stopped()) throw err;
      cancelled = true;
    }
    if (this.stopped()) cancelled = true;

    const tally = await passesTally({ tally: one, plan: first.plan }, second);
    const residual =
      !cancelled && verify ? await this.residualOf(verify, made, one, second?.tally) : [];
    const unread = !cancelled && verify ? verify.diff.unread : [];
    const did =
      tally.deleted.some((object) => object.deleted > 0) ||
      tally.restored.some((object) => object.restored + (object.restoredWithout ?? 0) > 0) ||
      tally.undeleted.some((object) => object.undeleted > 0);
    const status: RewindStatus = cancelled
      ? 'cancelled'
      : residual.some((entry) => entry.reason === 'changedDuringRewind')
        ? 'unstable'
        : residual.length > 0 || unread.length > 0
          ? did
            ? 'partial'
            : 'failure'
          : 'success';

    if (!cancelled) {
      await journal.end();
      this.ended = true;
      const endedAt = verify?.diff.readAt ?? this.now().toISOString();
      try {
        await this.deps.store.update(checkpoint.checkpointId, (held) => ({
          ...held,
          lastRewind: { rewindId: journal.rewindId, endedAt, undoUntil },
        }));
      } catch (err: unknown) {
        this.notes.push(
          `The checkpoint could not be told when the rewind ended (${extractErrorMessage(err)}): ` +
            'its list may not offer to undo it.',
        );
      }
    }
    const undoCannot = new Map<string, number>();
    for (const { plan } of made) {
      for (const { objectApiName, count } of plan.undoCannot) {
        undoCannot.set(objectApiName, (undoCannot.get(objectApiName) ?? 0) + count);
      }
    }
    return {
      rewound: true,
      result: this.resultOf({
        rewindId: journal.rewindId,
        status,
        tally,
        residual,
        unread,
        passes: second ? 2 : 1,
        leftToday: remaining,
        undo: {
          until: undoUntil,
          cannot: [...undoCannot].map(([objectApiName, count]) => ({ objectApiName, count })),
        },
      }),
      notes: this.notes,
    };
  }

  private resultOf(parts: {
    rewindId: string;
    status: RewindStatus;
    tally: Awaited<ReturnType<typeof passesTally>>;
    residual: RewindResidual[];
    unread: RewindDiff['unread'];
    passes: number;
    /** The requests the org had left today when the rewind began. */
    leftToday: number;
    undo?: RewindResult['undo'];
  }): RewindResult {
    const used = this.count.used();
    return {
      checkpointId: this.request.checkpoint.checkpointId,
      rewindId: parts.rewindId,
      status: parts.status,
      deleted: parts.tally.deleted,
      restored: parts.tally.restored,
      undeleted: parts.tally.undeleted,
      residual: parts.residual,
      ...(parts.unread.length > 0 ? { unread: [...parts.unread] } : {}),
      passes: parts.passes,
      ...(parts.undo ? { undo: parts.undo } : {}),
      apiRequests: { used, leftToday: Math.max(0, parts.leftToday - used) },
      finishedAt: this.now().toISOString(),
    };
  }

  /** Delete the folders of the reads it made, and of the preview it acted on once it went through. */
  async cleanUp(): Promise<void> {
    const dirs = [...this.ownDirs];
    if (this.ended) dirs.push(previewDirOf(this.request.folder, this.request.previewId));
    for (const dir of dirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // ─── One pass ───

  /** Make one pass of the rewind: see the module's comment. */
  private async pass(
    journal: RewindJournal,
    plan: RewindPlan,
    diff: RewindDiff,
    pass: 1 | 2,
  ): Promise<PassTally> {
    const tally = new PassTally();
    const passStamps: Record<string, string> = {};
    const stamp = (stamps: Readonly<Record<string, string>>): void => {
      Object.assign(passStamps, stamps);
      this.addStamps(stamps);
    };
    const allowOf = this.allowLists(diff);
    const afterKeys = new RecordKeySet();
    for (const { objectApiName } of plan.giveBack.afterDeletes.objects) {
      for await (const ids of plan.giveBack.afterDeletes.pages(objectApiName)) {
        for (const id of ids) afterKeys.add(id);
      }
    }
    // What the records given back after the deletions hold, kept before
    // anything is written: the deletions may change it before they are read.
    await this.keepFirst(journal, plan.giveBack.afterDeletes, allowOf);

    const sweep = async (): Promise<boolean> => {
      if (plan.bringBack.count > 0) {
        this.progress(
          'bringingBack',
          pass,
          pass === 1 ? 25 : 80,
          'Bringing back what was deleted since',
        );
        await this.bringBack(journal, plan.bringBack, tally, stamp);
      }
      if (!tally.cancelled && !this.stopped() && plan.giveBack.beforeDeletes.count > 0) {
        this.progress(
          'givingBack',
          pass,
          pass === 1 ? 40 : 82,
          'Giving back what was changed since',
        );
        await this.giveBack(
          journal,
          plan,
          plan.giveBack.beforeDeletes,
          'before',
          allowOf,
          afterKeys,
          tally,
          stamp,
        );
      }
      return tally.wrote;
    };

    let outcome: RunRemovalOutcome | undefined;
    if (plan.deletes.spool.count > 0) {
      this.progress('deleting', pass, pass === 1 ? 55 : 85, 'Deleting what was created since');
      await journal.deleting(plan.deletes);
      const removalStamps = { ...this.stamps, ...plan.removal.removalStamps };
      const spans = [...this.spans, ...(plan.removal.removalSpans ?? [])].filter(
        (span, at, all) =>
          all.findIndex((other) => JSON.stringify(other) === JSON.stringify(span)) === at,
      );
      outcome = await removeRunRecords(this.org, plan.deletes, {
        runStartedAt: plan.removal.runStartedAt,
        runEndedAt: plan.removal.runEndedAt,
        includeChanged: plan.removal.includeChanged,
        ...(Object.keys(removalStamps).length > 0 ? { removalStamps } : {}),
        ...(spans.length > 0 ? { removalSpans: spans } : {}),
        ...(plan.bringBack.count + plan.giveBack.beforeDeletes.count > 0 ? { sweep } : {}),
        ...(this.deps.onUndeletable ? { onUndeletable: this.deps.onUndeletable } : {}),
        ...(this.signal ? { signal: this.signal } : {}),
        onProgress: (settled, total, objectApiName) =>
          this.progress(
            'deleting',
            pass,
            pass === 1 ? 55 : 85,
            `Deleting ${objectApiName}: ${settled} / ${total}`,
          ),
      });
      await journal.deleted(outcome);
      tally.delete(outcome.objects);
      for await (const { objectApiName, ids } of outcome.left()) {
        tally.leftBy('removal', objectApiName, ids);
      }
      if (outcome.cancelled) tally.cancelled = true;
      if (outcome.objects.some((object) => object.deleted > 0) || outcome.span) tally.wrote = true;
      stamp(outcome.stamps);
      if (outcome.span) this.spans.push(outcome.span);
    } else if (!this.stopped()) {
      await sweep();
    } else {
      tally.cancelled = true;
    }

    if (!tally.cancelled && !this.stopped() && plan.giveBack.afterDeletes.count > 0) {
      this.progress(
        'givingBack',
        pass,
        pass === 1 ? 65 : 88,
        'Giving back what the deleted records held in place',
      );
      await this.giveBack(
        journal,
        plan,
        plan.giveBack.afterDeletes,
        'after',
        allowOf,
        afterKeys,
        tally,
        stamp,
      );
    }
    if (this.stopped()) tally.cancelled = true;
    await journal.removal({
      removalStamps: passStamps,
      removalSpans: outcome?.span ? [outcome.span] : [],
    });
    return tally;
  }

  /**
   * Per object, the fields its records may be given back: those the
   * checkpoint compares, less those the read the pass acts on says the org has
   * lost since or hides now.
   */
  private allowLists(diff: RewindDiff): (objectApiName: string) => string[] {
    const notCompared = new Map(
      diff.objects.map((object) => [
        object.objectApiName,
        new Set(object.notCompared.map((field) => field.toLowerCase())),
      ]),
    );
    const byName = new Map(
      this.request.checkpoint.objects.map((object) => [object.objectApiName, object]),
    );
    return (objectApiName) => {
      const object = byName.get(objectApiName);
      const gone = notCompared.get(objectApiName);
      return comparedFields(
        objectApiName,
        object?.fields ?? [],
        this.request.checkpoint.ignoredFields,
      ).filter((field) => !gone?.has(field.toLowerCase()));
    };
  }

  /**
   * Keep, in the journal, what the records of `spool` hold now of the fields
   * they may be given back, before the pass writes anything: Undo gives back
   * the values kept first. A read that fails is said, and those records keep
   * what their give-back reads just before it writes.
   */
  private async keepFirst(
    journal: RewindJournal,
    spool: IdSpool,
    allowOf: (objectApiName: string) => string[],
  ): Promise<void> {
    for (const { objectApiName } of spool.objects) {
      const fields = allowOf(objectApiName);
      if (fields.length === 0) continue;
      const object = assertSoqlIdentifier(objectApiName);
      const held = this.request.checkpoint.objects.find(
        (each) => each.objectApiName === objectApiName,
      );
      const person = held?.fields.some((field) => field === PERSON_ACCOUNT_FLAG) === true;
      const columns = [
        'Id',
        ...fields.map(assertSoqlIdentifier),
        ...(person ? [PERSON_ACCOUNT_FLAG] : []),
      ];
      const read = async (statement: string): Promise<OrgRow[]> =>
        (await this.org.query(statement)).records;
      try {
        for await (const ids of spool.pages(objectApiName)) {
          for (const list of idLists(ids, RECORDS_PER_CALL)) {
            if (this.stopped()) return;
            const rows = await readColumnsApart(
              `SELECT ${columns.join(', ')} FROM ${object} WHERE Id IN (${list})`,
              read,
            );
            const values = rows.map((row) => rowToWriteBack(objectApiName, row, fields));
            if (values.length > 0) await journal.keep(objectApiName, values);
          }
        }
      } catch (err: unknown) {
        if (err instanceof OrgReadStopped) return;
        this.notes.push(
          `What the ${objectApiName} records given back after the deletions held could not be kept ` +
            `before the rewind wrote (${extractErrorMessage(err)}): Undo gives them back what they held ` +
            'once the deletions were through.',
        );
      }
    }
  }

  /** The children of an object's records that come back with them: every relationship it deletes along. */
  private async cascadesOf(
    objectApiName: string,
  ): Promise<Array<{ child: string; field: string }>> {
    let body = this.kept.bodies.get(objectApiName);
    if (body === undefined) {
      const answer = await this.kept.reader.describe(objectApiName);
      body = 'body' in answer ? answer.body : undefined;
    }
    const parsed = checkpointDescribeSchema.safeParse(body);
    if (!parsed.success) throw new Error(`The org gave no describe of ${objectApiName}.`);
    return (parsed.data.childRelationships ?? [])
      .filter((relation) => relation.cascadeDelete === true)
      .map((relation) => ({ child: relation.childSObject, field: relation.field }));
  }

  /**
   * Bring back what was deleted since, parents first, a page of 2,000 ids at
   * a time: before each batch, the children the bin holds of its records are
   * named in the journal; after it, what the undelete left on them is read.
   */
  private async bringBack(
    journal: RewindJournal,
    spool: IdSpool,
    tally: PassTally,
    stamp: (stamps: Readonly<Record<string, string>>) => void,
  ): Promise<void> {
    // Read without the stop: a batch's children are named whole, or the batch is not sent.
    const children = compositeReader(this.org);
    for (const { objectApiName, count } of spool.objects) {
      if (tally.cancelled || this.stopped()) {
        tally.undelete({ ...emptyUndelete(objectApiName), planned: count, notReached: count });
        tally.cancelled = true;
        continue;
      }
      let cascades: Array<{ child: string; field: string }>;
      try {
        cascades = await this.cascadesOf(objectApiName);
      } catch (err: unknown) {
        cascades = [];
        this.notes.push(
          `The records that come back with ${objectApiName} could not be told ` +
            `(${extractErrorMessage(err)}): Undo may not send those ${objectApiName} records back to ` +
            'the recycle bin.',
        );
      }
      for await (const ids of spool.pages(objectApiName, SNAPSHOT_CHUNK_IDS)) {
        if (tally.cancelled || this.stopped()) {
          tally.undelete({
            ...emptyUndelete(objectApiName),
            planned: ids.length,
            notReached: ids.length,
          });
          tally.cancelled = true;
          continue;
        }
        const named = journal.bringingBack([{ objectApiName, ids }], this.count.undelete);
        const call: UndeleteCall = async (batch) => {
          const byParent = await this.nameChildren(
            journal,
            children,
            cascades,
            objectApiName,
            batch,
          );
          const answer = await named(batch);
          stamp(await this.undeleteStamps(objectApiName, batch, byParent));
          return answer;
        };
        const outcome = await undeleteRunDeletions({
          org: this.org,
          plan: [{ objectApiName, ids }],
          undelete: call,
          ...(this.signal ? { signal: this.signal } : {}),
        });
        for (const object of outcome.objects) tally.undelete(object);
        tally.leftBy('undelete', objectApiName, outcome.left);
        if (outcome.wrote) {
          tally.wrote = true;
          await journal.wrote();
        }
        if (outcome.cancelled) tally.cancelled = true;
      }
    }
  }

  /**
   * Name in the journal the children the recycle bin holds of `parents`,
   * through each of `cascades`, before they come back with them: the
   * children deleted with them, and those deleted on their own before them,
   * which the org may bring back too. By parent, the children named.
   */
  private async nameChildren(
    journal: RewindJournal,
    reader: CompositeReader,
    cascades: ReadonlyArray<{ child: string; field: string }>,
    objectApiName: string,
    parents: readonly string[],
  ): Promise<Map<string, string[]>> {
    const byParent = new Map<string, string[]>();
    if (cascades.length === 0 || parents.length === 0) return byParent;
    const [list] = idLists(parents, RECORDS_PER_CALL);
    const reads = cascades.map(({ child, field }) => ({
      objectApiName: child,
      soql:
        `SELECT Id, ${assertSoqlIdentifier(field)} FROM ${assertSoqlIdentifier(child)} ` +
        `WHERE ${field} IN (${list}) AND IsDeleted = true`,
      scanAll: true,
    }));
    const found = new Map<string, string[]>();
    const outcomes = await readStreams(reader, reads, (index, rows) => {
      const { child, field } = cascades[index];
      for (const row of rows) {
        const parent = row[field];
        if (typeof row.Id !== 'string' || typeof parent !== 'string') continue;
        found.set(child, [...(found.get(child) ?? []), row.Id]);
        const key = keyOf(parent);
        byParent.set(key, [...(byParent.get(key) ?? []), row.Id]);
      }
    });
    outcomes.forEach((outcome, index) => {
      if (outcome.read) return;
      this.notes.push(
        `The ${cascades[index].child} records that come back with ${objectApiName} could not be ` +
          `read (${outcome.reason}): Undo may not send those ${objectApiName} records back to the ` +
          'recycle bin.',
      );
    });
    for (const [child, ids] of found) await journal.withParent(child, ids);
    return byParent;
  }

  /**
   * What an undelete left on the records it brought back, by id, whoever the
   * org names their last modifier, and on the children named as coming back
   * with each: the org dated them in the same second. Best effort: a read that
   * fails is said.
   */
  private async undeleteStamps(
    objectApiName: string,
    ids: readonly string[],
    children: ReadonlyMap<string, readonly string[]>,
  ): Promise<Record<string, string>> {
    const stamps: Record<string, string> = {};
    const object = assertSoqlIdentifier(objectApiName);
    try {
      for (const list of idLists(ids, RECORDS_PER_CALL)) {
        const answer = await this.org.query(
          `SELECT Id, LastModifiedDate FROM ${object} WHERE Id IN (${list})`,
        );
        for (const row of answer.records) {
          if (typeof row.Id !== 'string' || typeof row.LastModifiedDate !== 'string') continue;
          stamps[row.Id] = row.LastModifiedDate;
          for (const child of children.get(keyOf(row.Id)) ?? [])
            stamps[child] = row.LastModifiedDate;
        }
      }
    } catch (err: unknown) {
      this.notes.push(
        `What bringing back ${objectApiName} records left on them could not be read ` +
          `(${extractErrorMessage(err)}): the second pass may read them as changed by someone else.`,
      );
    }
    return stamps;
  }

  /**
   * Give `spool`'s records their checkpoint values back, a chunk of 2,000 a
   * call. Before the deletions, a record given back after them too is given
   * back in a call of its own whose count is not the result's: its give-back
   * after the deletions settles it. After them, a refusal says what the
   * record waited for.
   */
  private async giveBack(
    journal: RewindJournal,
    plan: RewindPlan,
    spool: IdSpool,
    phase: 'before' | 'after',
    allowOf: (objectApiName: string) => string[],
    afterKeys: RecordKeySet,
    tally: PassTally,
    stamp: (stamps: Readonly<Record<string, string>>) => void,
  ): Promise<void> {
    const { checkpoint, folder } = this.request;
    for (const { objectApiName, count } of spool.objects) {
      if (tally.cancelled || this.stopped()) {
        tally.restore({ ...emptyRestore(objectApiName), planned: count, notReached: count });
        tally.cancelled = true;
        continue;
      }
      const fields = allowOf(objectApiName);
      const index = await SnapshotIndex.read(folder, checkpoint.snapshotId, objectApiName);
      const held = plan.giveBack.heldBy.find((entry) => entry.objectApiName === objectApiName);
      const status = fields.find((field) => field.toLowerCase() === 'status');
      for await (const ids of spool.pages(objectApiName, SNAPSHOT_CHUNK_IDS)) {
        if (tally.cancelled || this.stopped()) {
          tally.restore({
            ...emptyRestore(objectApiName),
            planned: ids.length,
            notReached: ids.length,
          });
          tally.cancelled = true;
          continue;
        }
        const call = async (
          chunk: readonly string[],
          written: readonly string[],
          rows?: (row: OrgRow) => boolean,
        ): Promise<SyncRestoreOutcome> => {
          const outcome = await restoreOverwrites({
            org: this.org,
            plan: [{ objectApiName, backup: checkpoint.snapshotId, ids: [...chunk] }],
            backups: writtenBack(index.chunk(chunk), objectApiName, written, rows),
            fields: { [objectApiName]: [...written] },
            changedAfter: plan.restore.changedAfter,
            ownWriters: rewindWriters(checkpoint.takenBy, this.userId),
            includeChanged: false,
            stamps: { ...plan.restore.stamps, ...this.stamps },
            keep: journal.keep,
            stampsFor: () => true,
            ...(this.signal ? { signal: this.signal } : {}),
          });
          stamp(outcome.stamps);
          if (outcome.wrote) {
            tally.wrote = true;
            await journal.wrote();
          }
          if (outcome.cancelled) tally.cancelled = true;
          return outcome;
        };
        // An order activated since, Draft at the checkpoint: its status
        // first, alone, its other fields locked until it is back in Draft.
        if (objectApiName === 'Order' && status !== undefined) {
          await call(ids, [status], (row) => row[status] === 'Draft');
          if (tally.cancelled) continue;
        }
        const twice = phase === 'before' ? ids.filter((id) => afterKeys.has(id)) : [];
        if (twice.length > 0) {
          await call(twice, fields);
          if (tally.cancelled) continue;
        }
        const once = twice.length > 0 ? ids.filter((id) => !afterKeys.has(id)) : ids;
        if (once.length === 0) continue;
        const outcome = await call(once, fields);
        for (const object of outcome.objects) tally.restore(object);
        tally.leftBy('restore', objectApiName, outcome.left);
        const result = outcome.objects[0];
        if (
          phase === 'after' &&
          held &&
          result &&
          result.refused + (result.restoredWithout ?? 0) > 0
        ) {
          const waited = tally.heldInPlace.get(objectApiName) ?? {
            reason: heldInPlaceReason(objectApiName, held.by),
            ids: new RecordKeySet(),
          };
          for (const id of outcome.left) waited.ids.add(id);
          tally.heldInPlace.set(objectApiName, waited);
        }
      }
    }
  }

  // ─── The verify ───

  /**
   * What still differs once the org was read again, per object and reason,
   * each record named once: see the module's comment.
   */
  private async residualOf(
    verify: DiffRead,
    made: readonly PlanMade[],
    first: PassTally,
    second?: PassTally,
  ): Promise<RewindResidual[]> {
    const groups = new Map<string, RewindResidual>();
    const add = (
      objectApiName: string,
      reason: RewindResidualReason,
      id: string,
      extra: { by?: string; message?: string } = {},
    ): void => {
      const at = `${objectApiName}\u0000${reason}\u0000${extra.by ?? ''}\u0000${extra.message ?? ''}`;
      let group = groups.get(at);
      if (!group) {
        group = {
          objectApiName,
          reason,
          ...(extra.by !== undefined ? { by: extra.by } : {}),
          count: 0,
          ids: [],
          ...(extra.message !== undefined ? { message: extra.message } : {}),
        };
        groups.set(at, group);
      }
      group.count++;
      if (group.ids.length < REWIND_RESIDUAL_IDS) group.ids.push(id);
    };
    const last = made[made.length - 1];
    const tallies = second ? [second, first] : [first];
    const objects = [...this.request.checkpoint.objects].sort((a, b) => a.readOrder - b.readOrder);
    for (const object of objects) {
      const name = object.objectApiName;
      const found: Array<{ cls: RewindClass; id: string }> = [];
      for (const cls of STILL_DIFFERING) {
        for await (const row of rowsOf(classFileOf(verify.dir, name, cls))) {
          if (typeof row.Id === 'string') found.push({ cls, id: row.Id });
        }
      }
      if (found.length === 0) continue;
      const rows = await this.whoChanged(verify.dir, name, found);
      const kept = this.keptOf(last, name);
      for (const { cls, id } of found) {
        if (cls === 'goneForGood') {
          add(name, 'goneForGood', id);
          continue;
        }
        const row = rows.get(keyOf(id));
        const after = dateMs(row?.at) > this.before;
        const own = after && this.isOwn(id, row);
        if (after && !own) {
          add(name, 'changedDuringRewind', id, row?.by ? { by: row.by } : {});
          continue;
        }
        const acted = made.some(({ acted: actedOn }) => actedOn.get(name)?.has(id) === true);
        if (!acted) {
          add(name, own ? 'automation' : 'changedSincePreview', id);
          continue;
        }
        const keptFor = kept(id, cls);
        if (keptFor !== undefined) {
          add(name, 'kept', id, { message: keptFor });
          continue;
        }
        if (own) {
          add(name, 'automation', id);
          continue;
        }
        const brick = BRICK_OF[cls];
        add(name, 'refused', id, {
          message: brick ? this.refusalOf(tallies, brick, name, id) : STILL_DIFFERS,
        });
      }
    }
    return [...groups.values()];
  }

  /** Who last changed the records `found` names, and when, as the verify read them. */
  private async whoChanged(
    dir: string,
    objectApiName: string,
    found: ReadonlyArray<{ id: string }>,
  ): Promise<Map<string, { by?: string; at?: string }>> {
    const wanted = new Set(found.map(({ id }) => keyOf(id)));
    const rows = new Map<string, { by?: string; at?: string }>();
    for (const file of [liveSpoolOf(dir, objectApiName), deletedSpoolOf(dir, objectApiName)]) {
      for await (const row of rowsOf(file)) {
        if (typeof row.Id !== 'string' || !wanted.has(keyOf(row.Id))) continue;
        rows.set(keyOf(row.Id), {
          ...(typeof row.LastModifiedById === 'string' ? { by: row.LastModifiedById } : {}),
          ...(typeof row.LastModifiedDate === 'string' ? { at: row.LastModifiedDate } : {}),
        });
      }
    }
    return rows;
  }

  /** Whether the record's last change after Tr is the rewind's own: by its users, or no later than a date it left. */
  private isOwn(id: string, row: { by?: string; at?: string } | undefined): boolean {
    if (row?.by !== undefined && this.owners.has(keyOf(row.by))) return true;
    return dateMs(row?.at) <= (this.stampOf.get(keyOf(id)) ?? Number.NaN);
  }

  /** Dates the rewind's writes left on records: its own doing, whoever the org names. */
  private addStamps(stamps: Readonly<Record<string, string>>): void {
    for (const [id, at] of Object.entries(stamps)) {
      this.stamps[id] = at;
      const ms = dateMs(at);
      const key = keyOf(id);
      if (Number.isFinite(ms) && !((this.stampOf.get(key) ?? Number.NEGATIVE_INFINITY) > ms)) {
        this.stampOf.set(key, ms);
      }
    }
  }

  /**
   * Why the last plan kept a record of `objectApiName` it would otherwise act
   * on, in the rewind's words: by the ids it names, or, for a record to delete
   * it did not hand the removal, by the reason it kept that object's records
   * for. Undefined for a record it did not keep.
   */
  private keptOf(
    made: PlanMade,
    objectApiName: string,
  ): (id: string, cls: RewindClass) => string | undefined {
    const entries = made.plan.left.filter(
      (entry) => entry.objectApiName === objectApiName && KEPT_WORDS[entry.reason] !== undefined,
    );
    return (id, cls) => {
      if (entries.length === 0) return undefined;
      const named = entries.find((entry) => entry.ids.some((held) => keyOf(held) === keyOf(id)));
      if (named) return KEPT_WORDS[named.reason];
      if (BRICK_OF[cls] === 'removal' && !made.plan.deletes.has(keyOf(id)))
        return KEPT_WORDS[entries[0].reason];
      return undefined;
    };
  }

  /** The words a brick refused a record in, from the last pass that left it; generic when none says. */
  private refusalOf(
    tallies: readonly PassTally[],
    brick: Brick,
    objectApiName: string,
    id: string,
  ): string {
    // A record that waited for the deletes in any pass says so, whichever
    // pass refused it last.
    const waited =
      brick === 'restore'
        ? tallies
            .map((tally) => tally.heldInPlace.get(objectApiName))
            .find((held) => held?.ids.has(id) === true)?.reason
        : undefined;
    for (const tally of tallies) {
      if (tally.left[brick].get(objectApiName)?.has(id) !== true) continue;
      const reasons =
        brick === 'restore'
          ? tally.restored.get(objectApiName)?.reasons
          : brick === 'undelete'
            ? tally.undeleted.get(objectApiName)?.reasons
            : tally.deleted.get(objectApiName)?.reasons;
      const words = reasons?.find((reason) => reason !== waited);
      if (words === undefined) continue;
      return waited ? `${words} — ${waited}` : words;
    }
    return waited ?? STILL_DIFFERS;
  }
}

/**
 * A reader of a chunk of the snapshot, each row as a rewind writes it back:
 * its id and the fields of `fields` it holds, less what its kind of account
 * cannot hold — a person account's name, which the org computes, would be
 * sent, refused, and sent again without — and only the rows `rows` keeps.
 */
function writtenBack(
  reader: BackupReader,
  objectApiName: string,
  fields: readonly string[],
  rows?: (row: OrgRow) => boolean,
): BackupReader {
  return {
    batches: async (operationId, object, size) => {
      const batches = await reader.batches(operationId, object, size);
      if (!batches) return null;
      return {
        async *[Symbol.asyncIterator]() {
          for await (const batch of batches) {
            const written = batch
              .filter((row) => rows?.(row) ?? true)
              .map((row) => rowToWriteBack(objectApiName, row, fields));
            if (written.length > 0) yield written;
          }
        },
      };
    },
  };
}
