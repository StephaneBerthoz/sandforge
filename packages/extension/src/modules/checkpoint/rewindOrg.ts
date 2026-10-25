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
 * this machine writes to the org, the day's requests are enough, the emails
 * the writes make it send fit what it has left of each daily limit
 * (`rewindEmails.ts`), and the deletions Undo couldn't bring back and the
 * automation the writes fire were accepted. Each refusal names why, and
 * writes nothing.
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
 * them (`heldInPlaceReason`). Those records are named so in the journal before
 * the pass writes: their undo gives their values back before the records
 * that held them come back.
 *
 * - Made again: the records the recycle bin no longer gives back, which the
 *   snapshot holds, once what is brought back is back, parents first, 200 an
 *   insert, with the snapshot's values of the fields the org lets the user
 *   set on a new record, and new Ids. A lookup that named a record made again
 *   names its new Id: one made before it as it is made, one made after it —
 *   a record pointing at a record of its own object, as an account at its
 *   parent account — empty at first, filled in once that one is made. Each
 *   insert's records are named in the journal before it goes, by the Ids the
 *   checkpoint holds them by, and once it answered by the Ids the org gave
 *   them, beside the checkpoint (`Recreated`): its undo deletes them, and
 *   every read of the checkpoint from then on names them by their new Ids, so
 *   the give-back that follows points every lookup the checkpoint holds that
 *   named one at its new Id. A record the org refuses to make is named, in
 *   its words, and left gone.
 * - Brought back: a page of 2,000 ids at a time, the undelete's own batches
 *   of 200. Before each batch goes, the children the recycle bin holds of
 *   each of its records, through every relationship its object deletes
 *   along — but to an object the org does not query, or that keeps no
 *   recycle bin — and their children, as deep as the bin holds them, are
 *   named in the journal as coming back with it: named after the undelete, a stop
 *   between the two would lose them, and its undo would keep the parent they
 *   hang from. A person account's own contact is not named: it goes back to
 *   the bin with its account, never on its own. After the undelete, what it
 *   left on its records is read, whoever the org names their last modifier:
 *   the dates an undelete moves are the rewind's own doing, and the records
 *   that came back with a record were dated in the same second.
 * - No longer in the bin, though a read found it there: Salesforce still
 *   lists a record emptied from the recycle bin as deleted, `queryAll`
 *   reading it `IsDeleted = true` until the org deletes it for good — half
 *   an hour after `Database.emptyRecycleBin` still, a day after no longer, on
 *   a scratch org — and a GET of its Id answers as for one still in the bin:
 *   only the undelete's answer, "Entity is not in the recycle bin", tells
 *   it. A record so answered that the snapshot holds, but a file, is made
 *   again in the same pass, once making records again was accepted, with
 *   what was named as coming back with it that the snapshot holds too — an
 *   account's contacts — as if the preview had counted them to make again:
 *   journaled the same way, so a stop and a resume make none twice, and
 *   Undo deletes them. Not accepted, they are left, named with what lifts
 *   it; one the checkpoint cannot make again is gone for good.
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
 * gone for good — a file, whose body the checkpoint does not hold, or a
 * record deleted while it was taken —; changed during the rewind by another user (the rewind is
 * then unstable); changed since the preview; kept by your automation — last
 * changed after Tr by the rewind's own users —; kept as the rewind had to,
 * among them a record to delete that records it does not delete hang from,
 * a lead converted since, which Salesforce cannot unconvert, a contract
 * activated since, which it will not set back to Draft, and a record deleted
 * with one created since, which comes back with that one only; refused, in
 * the org's words. A record deleted while the checkpoint was taken and
 * brought back by the rewind reads, live and not in the snapshot, as
 * unexplained: it is the rewind's own, and never named.
 *
 * **Stop** reaches every phase: between two pages, two batches, two chunks,
 * two phases and two passes. A rewind stopped part way, or killed, leaves its
 * journal open: the next rewind of the checkpoint takes it up, reads the org
 * again and acts on what still differs, so nothing the journal says was done
 * is sent again, and its undo reaches the org as it was before the first
 * pass; one whose work the fresh read finds done is taken up only to end it.
 * Once through, the journal ends, and the checkpoint's last rewind says when,
 * and until when Undo can bring back what it deleted; what Undo couldn't
 * bring back is counted from the journal, every pass of it. The journals of
 * the org's earlier rewinds, which Undo no longer reaches, are deleted then,
 * each named in the result (`removeEarlierJournals`). A rewind that finds
 * nothing to write keeps no journal, and sends the org no more than the
 * guard, the day's limits and its one read.
 */

import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Connection } from 'jsforce';
import * as z from 'zod';
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
  recordWriteHeaders,
  type RewindDiff,
  type RewindResidual,
  type RewindResidualReason,
  type RewindRecreatedObject,
  type RewindResult,
  type RewindStatus,
  type RewindUndoCannot,
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
import {
  undeleteRunDeletions,
  type SyncUndeleteOutcome,
  type UndeleteCall,
} from '../sync/SyncRunUndelete.js';
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
import { classFileOf, recreatable, rewindDiff, type RewindClass } from './rewindDiff.js';
import { checkpointEmails, emailsRefusal, writtenByPlan } from './rewindEmails.js';
import {
  budgetRefusal,
  readBudget,
  relationshipsOf,
  rewindWritesCost,
  type ObjectRelationships,
} from './rewindEstimate.js';
import {
  IDS_PER_LINE,
  openRewindJournal,
  removeEarlierJournals,
  type EarlierJournalRemoved,
  type RewindJournal,
} from './rewindJournal.js';
import {
  heldInPlaceReason,
  rewindPlan,
  rewindWriters,
  type RewindPlan,
  type RewindPlanLeft,
  type RewindPlanLeftReason,
} from './rewindPlan.js';
import {
  Recreated,
  SNAPSHOT_CHUNK_IDS,
  SnapshotIndex,
  type RecreatedPair,
} from './snapshotIndex.js';
import { IdSpoolWriter, RecordKeySet, type IdSpool } from './spooledRunRecords.js';
import { takeOrgOf, type TakeOrg } from './takeCheckpoint.js';
import { settleNotInBin } from './undoRewind.js';

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
  'toRecreate',
];

/** What the verify names: the classes a pass acts on, and what cannot come back or be given back. */
const STILL_DIFFERING: readonly RewindClass[] = [
  ...ACTED,
  'goneForGood',
  'convertedLead',
  'activatedContract',
  'deletedWithCreatedParent',
];

/**
 * Why a rewind leaves as it is what the preview named it cannot take back,
 * by class: kept, with why.
 */
const LEFT_AS_IT_IS: Readonly<Partial<Record<RewindClass, string>>> = {
  convertedLead:
    "Left converted: Salesforce can't unconvert a lead, and refuses any update of a converted one.",
  activatedContract:
    "Left activated: Salesforce won't set an activated contract back to Draft, so it is not given back.",
  deletedWithCreatedParent:
    'Left in the recycle bin: deleted with a record created since, which the rewind does not ' +
    'bring back, it comes back with that record only.',
};

/** Which brick acts on the records of each class, whose refusal the verify quotes. */
const BRICK_OF: Readonly<Partial<Record<RewindClass, Brick>>> = {
  createdSince: 'removal',
  broughtBackSince: 'removal',
  comesBackWithParent: 'removal',
  giveBack: 'restore',
  inBin: 'undelete',
  withParent: 'undelete',
  deletedWhileTaken: 'undelete',
  toRecreate: 'recreate',
};

/** The bricks a pass writes through. */
type Brick = 'restore' | 'undelete' | 'recreate' | 'removal';

/** Why a plan keeps a record it would otherwise act on: the rewind's choice, never the org's. */
const KEPT_WORDS: Readonly<Partial<Record<RewindPlanLeftReason, string>>> = {
  outsideNotAccepted:
    'Kept: records outside the checkpoint created since hang from it, and their deletion was ' +
    'not accepted.',
  holdsLeft:
    'Kept: a record the rewind left hangs from it, and its deletion would take that record along.',
  noUndoNotAccepted:
    "Kept: Undo couldn't bring it back once deleted on its own, and that was not accepted.",
  beforeParentNotAccepted:
    "Kept: Undo couldn't bring it back once deleted before a record it points at, which the " +
    'rewind deletes next, and that was not accepted.',
};

/**
 * Why a rewind kept a record it set out to delete: records it does not delete
 * hang from it — they existed at the checkpoint, were made while it was
 * taken, or someone changed them since the rewind began — and its delete
 * would take them along.
 */
function keptForWords(holders: readonly string[]): string {
  return (
    `Kept: records it does not delete hang from it (${holders.join(', ')}), and its deletion ` +
    'would take them along.'
  );
}

/** What the verify says of a record it cannot tell a reason for. */
const STILL_DIFFERS = 'It still differs from the checkpoint once the org was read again.';

/** What the org answers an undelete of a record it will not bring back, in its words. */
const NOT_IN_BIN = /Entity is not in the recycle bin/;

/**
 * Why a rewind left a record the org answered is no longer in the recycle
 * bin, which it would have made again had that been accepted: the org's own
 * words say the opposite of what a read of the bin shows.
 */
export const NOT_REMADE_WORDS =
  'Salesforce still lists it as deleted but will not bring it back: emptied from the recycle ' +
  "bin, or kept there for good (the org answers 'UNDELETE_FAILED: Entity is not in the " +
  "recycle bin'). Make them again, with new Ids, or --accept-recreate on the command line, " +
  'makes it again with a new Id.';

/** What a refusal before the first write did not do. */
const NOTHING_WRITTEN = 'No record was written.';

const ACCOUNT = 'Account';
const CONTACT = 'Contact';

/** The org's objects as its global describe lists them, as far as a bring back reads them. */
const globalObjectsSchema = z
  .object({
    sobjects: z.array(z.object({ name: z.string(), queryable: z.boolean().optional() }).loose()),
  })
  .loose();

/** What the org answers a read naming `IsDeleted` of an object that keeps no such field. */
const NO_RECYCLE_BIN = /No such column 'IsDeleted'/;

/**
 * A relationship whose children come back with a parent: the child object,
 * its field that names the parent, and, for an account's contacts in an org
 * with person accounts, that a person account's own contact is told apart.
 */
interface Cascade {
  child: string;
  field: string;
  persons?: true;
}

/** A record named in the bin as coming back with a parent: its object and its id. */
interface ChildRecord {
  objectApiName: string;
  id: string;
}

/**
 * The ids of `batch` whose undelete the org refused as not in the recycle
 * bin, by the answer it gave, one per id in their order: a list, or one
 * answer alone, each refusal's errors a list or one error.
 */
function answeredNotInBin(answer: unknown, batch: readonly string[]): string[] {
  const answers: unknown[] = Array.isArray(answer) ? answer : [answer];
  return batch.filter((_, place) => {
    const one = answers[place];
    if (typeof one !== 'object' || one === null) return false;
    const { success, errors } = one as { success?: unknown; errors?: unknown };
    if (success === true) return false;
    return (Array.isArray(errors) ? errors : [errors]).some((error) => {
      const words =
        typeof error === 'string'
          ? error
          : typeof error === 'object' && error !== null
            ? String((error as { message?: unknown }).message ?? '')
            : '';
      return NOT_IN_BIN.test(words);
    });
  });
}

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
  /**
   * Insert records of one object, 200 at most, each answered in their order:
   * what a rewind makes again of the records the recycle bin no longer gives
   * back.
   */
  create(objectApiName: string, records: Array<Record<string, unknown>>): Promise<unknown>;
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
    // A duplicate rule may hold a record made again for the one it was.
    create: (objectApiName, records) =>
      conn.sobject(objectApiName).create(records, { headers: recordWriteHeaders() }),
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
export type RewindPhase =
  'reading' | 'bringingBack' | 'recreating' | 'givingBack' | 'deleting' | 'checking';

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
  /**
   * The store the checkpoint is kept in: the org's lock, the checkpoint's
   * last rewind, and the org's checkpoints, whose earlier rewinds' journals
   * go once the rewind ended.
   */
  store: Pick<OrgCheckpointStore, 'lock' | 'update' | 'checkpointsOf'>;
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
  /** Make again, with new Ids, the records deleted since that the recycle bin no longer gives back. */
  acceptRecreate: boolean;
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

/** The plan's reasons for keeping a record Undo couldn't bring back, as the gate refuses them. */
const NO_UNDO_LEFT: ReadonlySet<RewindPlanLeftReason> = new Set([
  'noUndoNotAccepted',
  'beforeParentNotAccepted',
]);

/** Why Undo couldn't bring back records a rewind deletes, for each reason the plan keeps them for. */
const NO_UNDO_WHY: Readonly<Partial<Record<RewindPlanLeftReason, string>>> = {
  noUndoNotAccepted: 'Salesforce undeletes them only with their parent, which stays',
  beforeParentNotAccepted:
    'deleted before a record they point at, which the rewind deletes next, Salesforce cannot ' +
    'bring them back after that',
};

/**
 * The refusal of a rewind that would delete records Undo couldn't bring back,
 * not accepted: a sentence for each reason the plan kept them for.
 */
function noUndoRefusal(left: readonly RewindPlanLeft[]): CheckpointRefusal {
  const said = [...NO_UNDO_LEFT].flatMap((reason) => {
    const entries = left.filter((entry) => entry.reason === reason);
    if (entries.length === 0) return [];
    const count = entries.reduce((sum, entry) => sum + entry.count, 0);
    const objects = [...new Set(entries.map((entry) => entry.objectApiName))].join(', ');
    return [
      `Undo couldn't bring back ${count} ${objects} record(s) this rewind deletes: ` +
        `${NO_UNDO_WHY[reason] ?? ''}.`,
    ];
  });
  return {
    code: 'NO_UNDO',
    message:
      `${said.join(' ')} Rewind refused; accept that Undo couldn't bring them back to rewind ` +
      `all the same. ${NOTHING_WRITTEN}`,
  };
}

/**
 * The refusal of a rewind that would make records again with new Ids, not
 * accepted: how many, of which objects, and what a new Id breaks.
 */
function recreateRefusal(left: readonly RewindPlanLeft[]): CheckpointRefusal {
  const count = left.reduce((sum, entry) => sum + entry.count, 0);
  const objects = [...new Set(left.map((entry) => entry.objectApiName))].join(', ');
  return {
    code: 'RECREATE',
    message:
      `${count} ${objects} record(s) deleted since are no longer in the recycle bin, or ` +
      'Salesforce keeps them there for good: this rewind makes them again from the ' +
      'checkpoint, with new Ids. Anything outside Salesforce that names their old Ids — an ' +
      'integration, a link, a report filter — no longer finds them. Rewind refused; accept ' +
      `that they get new Ids to rewind all the same. ${NOTHING_WRITTEN}`,
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
  const makes = (steps.recreate ?? []).length > 0 ? 'makes them again, ' : '';
  const what =
    fired.length > 0
      ? `${fired.length} flow(s), trigger(s) or rule(s) of ${objects.join(', ')} run as the ` +
        `rewind brings records back, ${makes}gives them their values back or deletes them`
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

function emptyRecreated(objectApiName: string): RewindRecreatedObject {
  return { objectApiName, planned: 0, created: 0, refused: 0, reasons: [] };
}

function addRecreated(into: RewindRecreatedObject, from: RewindRecreatedObject): void {
  into.planned += from.planned;
  into.created += from.created;
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
  if (from.notReached) into.notReached = (into.notReached ?? 0) + from.notReached;
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
  readonly recreated = new Map<string, RewindRecreatedObject>();
  readonly deleted = new Map<string, ForgeUndoObjectResult>();
  /** Per brick and object, the records it left: what the verify quotes its reasons for, and what the next pass retries. */
  readonly left: Record<Brick, Map<string, RecordKeySet>> = {
    restore: new Map(),
    undelete: new Map(),
    recreate: new Map(),
    removal: new Map(),
  };
  /**
   * Per object, why its records given back after the deletions waited, and
   * those of them the org still refused or took without some fields.
   */
  readonly heldInPlace = new Map<string, { reason: string; ids: RecordKeySet }>();
  /**
   * Per object, the records the org answered are no longer in the recycle
   * bin, and what was to come back with them, left as they are: making them
   * again was not accepted.
   */
  readonly notInBin = new Map<string, RecordKeySet>();
  /** Per object, such records the checkpoint cannot make again: a file, or one it holds no values of. */
  readonly lost = new Map<string, RecordKeySet>();
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

  /** Name a record among those of `kept`. */
  mark(kept: 'notInBin' | 'lost', objectApiName: string, id: string): void {
    let held = this[kept].get(objectApiName);
    if (!held) {
      held = new RecordKeySet();
      this[kept].set(objectApiName, held);
    }
    held.add(id);
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

  recreate(from: RewindRecreatedObject): void {
    const into = this.recreated.get(from.objectApiName) ?? emptyRecreated(from.objectApiName);
    addRecreated(into, from);
    this.recreated.set(from.objectApiName, into);
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
  recreated: RewindRecreatedObject[];
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
  const recreated = new Map(
    [...first.recreated].map(([name, result]) => [name, structuredClone(result)]),
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
    // What the second pass makes again the first could not: its refusals settled.
    const recreateRetried = await retriedOf([plan.recreate], [firstPass.plan.recreate]);
    for (const [name, from] of tally.recreated) {
      const into = recreated.get(name) ?? emptyRecreated(name);
      const retried = recreateRetried.get(name) ?? 0;
      settle(into, ['refused', 'notReached', 'created'], retried);
      into.planned -= Math.min(retried, into.planned);
      addRecreated(into, from);
      recreated.set(name, into);
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
    recreated: [...recreated.values()],
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
    recreate: objects
      .filter((object) => object.recreated > 0)
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
      plan.recreate.count +
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
 * connection's REST requests does not see. A Bulk API job counts the calls it
 * says it sent (`BulkDeleteAnswer.requests`): opened, sent, closed, each read
 * of its state and of its results, one request each, as the org counted them.
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
      create: (objectApiName, records) => one(() => org.create(objectApiName, records)),
      destroy: (objectApiName, ids) => one(() => org.destroy(objectApiName, ids)),
      queryDeleted: (soql) => one(() => org.queryDeleted(soql)),
      ...(bulkDestroy
        ? {
            bulkDestroy: async (
              objectApiName: string,
              ids: readonly string[],
              signal?: AbortSignal,
            ) => {
              let calls = 1;
              try {
                const answer = await bulkDestroy(objectApiName, ids, signal);
                calls = answer.requests ?? 1;
                return answer;
              } finally {
                used += calls;
              }
            },
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
  /** Per object of records that came back with a parent, the cascades of their own children. */
  private readonly cascadesOfObject = new Map<string, Promise<Cascade[]>>();
  /** The objects the org does not query, read once from its global describe. */
  private unqueried: Promise<ReadonlySet<string>> | undefined;
  /** The objects the org answered keep no recycle bin: no `IsDeleted` to read. */
  private readonly noBin = new Set<string>();
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
      acceptRecreate: this.request.acceptRecreate,
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
    const noUndo = first.plan.left.filter((entry) => NO_UNDO_LEFT.has(entry.reason));
    if (noUndo.length > 0) return { rewound: false, refusal: noUndoRefusal(noUndo) };
    const notMade = first.plan.left.filter((entry) => entry.reason === 'recreateNotAccepted');
    if (notMade.length > 0) return { rewound: false, refusal: recreateRefusal(notMade) };
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
          ...(steps.recreate ?? []),
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
    // What it sent so far, its reads and the automation's, and what its
    // writes and the reads after them take.
    const rest = rewindWritesCost({
      objects: checkpoint.objects,
      diff: fresh.diff,
      automationRequests: 0,
      relationships: await this.relationships(),
      ...(reused ? { reusesPreview: true } : {}),
    });
    const overBudget = budgetRefusal(
      'rewind',
      this.count.used() + rest.apiRequests,
      budget,
      orgName,
    );
    if (writing && overBudget) return { rewound: false, refusal: overBudget };
    // The emails its writes make the org send, against what it has left of
    // each daily limit: past them, no box lifts the refusal.
    const overEmails = automation
      ? emailsRefusal(
          'rewind',
          checkpointEmails(writtenByPlan(first.plan.objects), automation, budget.emails),
          orgName,
        )
      : undefined;
    if (writing && overEmails) return { rewound: false, refusal: overEmails };
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
    const residual = await this.residualOf(fresh, fresh, [first], new PassTally());
    this.ended = true;
    return {
      rewound: true,
      result: this.resultOf({
        rewindId: newFolderId('rw', this.now()),
        status: residual.length > 0 || fresh.diff.unread.length > 0 ? 'partial' : 'success',
        tally: { deleted: [], restored: [], undeleted: [], recreated: [] },
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
      !cancelled && verify ? await this.residualOf(verify, fresh, made, one, second?.tally) : [];
    const unread = !cancelled && verify ? verify.diff.unread : [];
    const did =
      tally.deleted.some((object) => object.deleted > 0) ||
      tally.restored.some((object) => object.restored + (object.restoredWithout ?? 0) > 0) ||
      tally.undeleted.some((object) => object.undeleted > 0) ||
      tally.recreated.some((object) => object.created > 0);
    const status: RewindStatus = cancelled
      ? 'cancelled'
      : residual.some((entry) => entry.reason === 'changedDuringRewind')
        ? 'unstable'
        : residual.length > 0 || unread.length > 0
          ? did
            ? 'partial'
            : 'failure'
          : 'success';

    let removedJournals: EarlierJournalRemoved[] = [];
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
      // Undo reaches the org's last rewind alone: the journals of its earlier
      // rewinds, which hold the values they wrote over, go now, each named.
      try {
        removedJournals = await removeEarlierJournals(this.deps.store, this.lock, {
          checkpointId: checkpoint.checkpointId,
          rewindId: journal.rewindId,
        });
      } catch (err: unknown) {
        this.notes.push(
          `The journals of the earlier rewinds of ${this.request.orgName} could not be deleted ` +
            `(${extractErrorMessage(err)}): they stay until their checkpoint goes.`,
        );
      }
    }
    const undoCannot = await this.undoCannotOf(journal);
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
        undo: { until: undoUntil, cannot: undoCannot },
        removedJournals,
      }),
      notes: this.notes,
    };
  }

  /**
   * Per object and reason, the records the rewind deleted that Undo couldn't
   * bring back, as its journal says, every pass and every rewind taken up on
   * it counted — but for one it had brought back first, which its undo leaves
   * in the bin it came from:
   *
   * - one deleted on its own before a record it points at that went too,
   *   which leaves it in the bin for good (`deletedBeforeParent`): a case
   *   before its account, live;
   * - of an object Salesforce undeletes only with its parent, any other its
   *   removal was handed: it went on its own — one that goes with its parent
   *   is never handed over.
   *
   * Counted from the passes of this call alone, a rewind taken up after a
   * stop said Undo could bring back the products the stopped pass had
   * deleted.
   */
  private async undoCannotOf(journal: RewindJournal): Promise<RewindUndoCannot[]> {
    const alone = new Set(
      this.request.checkpoint.objects
        .filter((object) => !object.undeletable)
        .map((object) => object.objectApiName),
    );
    const read = await journal.read();
    const back = new Set(read.did.broughtBack.flatMap(({ ids }) => ids.map(keyOf)));
    const before = new Set(
      (read.did.deletedBeforeParent ?? []).flatMap(({ ids }) => ids.map(keyOf)),
    );
    const cannot: RewindUndoCannot[] = [];
    for (const { objectApiName, ids } of read.did.deleted) {
      const gone = ids.map(keyOf).filter((key) => !back.has(key));
      const beforeParent = gone.filter((key) => before.has(key)).length;
      const withParent = alone.has(objectApiName) ? gone.length - beforeParent : 0;
      if (withParent > 0) cannot.push({ objectApiName, count: withParent });
      if (beforeParent > 0) {
        cannot.push({ objectApiName, count: beforeParent, reason: 'deletedBeforeParent' });
      }
    }
    return cannot;
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
    /** The journals of the org's earlier rewinds it deleted once it ended. */
    removedJournals?: EarlierJournalRemoved[];
  }): RewindResult {
    const used = this.count.used();
    return {
      checkpointId: this.request.checkpoint.checkpointId,
      rewindId: parts.rewindId,
      status: parts.status,
      deleted: parts.tally.deleted,
      restored: parts.tally.restored,
      // An object whose every record the bin no longer gave back, each made
      // again instead, brought nothing back: its records are counted made again.
      undeleted: parts.tally.undeleted.filter((object) => object.planned > 0),
      ...(parts.tally.recreated.length > 0 ? { recreated: parts.tally.recreated } : {}),
      residual: parts.residual,
      ...(parts.unread.length > 0 ? { unread: [...parts.unread] } : {}),
      passes: parts.passes,
      ...(parts.undo ? { undo: parts.undo } : {}),
      ...((parts.removedJournals ?? []).length > 0
        ? { removedJournals: parts.removedJournals }
        : {}),
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
      const by = plan.giveBack.heldBy.find((held) => held.objectApiName === objectApiName)?.by;
      for await (const ids of plan.giveBack.afterDeletes.pages(objectApiName)) {
        for (const id of ids) afterKeys.add(id);
        // Named before anything is written: their undo gives these values
        // back before the records that held them come back.
        if (by) await journal.heldInPlace(objectApiName, by, ids);
      }
    }
    // What the records given back after the deletions hold, kept before
    // anything is written: the deletions may change it before they are read.
    await this.keepFirst(journal, plan.giveBack.afterDeletes, allowOf);

    // What the org answers is no longer in the recycle bin as the pass brings
    // it back, made again in this pass once that was accepted.
    const remake = this.request.acceptRecreate
      ? new IdSpoolWriter(join(plan.dir, `remake-${randomBytes(4).toString('hex')}`))
      : undefined;
    const sweep = async (): Promise<boolean> => {
      if (plan.bringBack.count > 0) {
        this.progress(
          'bringingBack',
          pass,
          pass === 1 ? 25 : 80,
          'Bringing back what was deleted since',
        );
        await this.bringBack(journal, plan.bringBack, tally, stamp, remake);
      }
      const recreate =
        remake && remake.objects.length > 0
          ? await this.withPlanned(remake, plan.recreate)
          : plan.recreate;
      if (!tally.cancelled && !this.stopped() && recreate.count > 0) {
        this.progress(
          'recreating',
          pass,
          pass === 1 ? 32 : 81,
          'Making again what the recycle bin no longer holds',
        );
        await this.recreate(journal, recreate, tally);
      } else if (recreate.count > 0) {
        for (const { objectApiName, count } of recreate.objects) {
          tally.recreate({ ...emptyRecreated(objectApiName), planned: count, notReached: count });
        }
        tally.cancelled = true;
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
      // Named before the removal is handed them: what the rewind deletes
      // before a record it points at, beside that record, for what its
      // result says Undo couldn't bring back.
      for (const { objectApiName, file } of plan.beforeParent) {
        const pairs: Array<{ id: string; parent: string }> = [];
        for await (const row of rowsOf(file)) {
          const parents = Array.isArray(row.parents) ? row.parents : [];
          for (const parent of parents) {
            if (typeof row.Id === 'string' && typeof parent === 'string') {
              pairs.push({ id: row.Id, parent });
            }
          }
          if (pairs.length >= IDS_PER_LINE) {
            await journal.beforeParent(objectApiName, pairs.splice(0));
          }
        }
        if (pairs.length > 0) await journal.beforeParent(objectApiName, pairs);
      }
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
        ...(plan.bringBack.count + plan.recreate.count + plan.giveBack.beforeDeletes.count > 0
          ? { sweep }
          : {}),
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

  /**
   * The children of an object's records that come back with them: every
   * relationship it deletes along, but to an object the org does not query.
   * An account's contacts, in an org with person accounts — its describe
   * lists the flag — are read with it.
   */
  private async cascadesOf(objectApiName: string): Promise<Cascade[]> {
    let body = this.kept.bodies.get(objectApiName);
    if (body === undefined) {
      // Kept by the reader: described once, however often its records come back.
      const answer = await this.kept.reader.describe(objectApiName);
      body = 'body' in answer ? answer.body : undefined;
    }
    const parsed = checkpointDescribeSchema.safeParse(body);
    if (!parsed.success) throw new Error(`The org gave no describe of ${objectApiName}.`);
    const persons =
      objectApiName === ACCOUNT &&
      parsed.data.fields.some((field) => field.name === PERSON_ACCOUNT_FLAG);
    const cascading = (parsed.data.childRelationships ?? []).filter(
      (relation) => relation.cascadeDelete === true,
    );
    if (cascading.length === 0) return [];
    const unqueried = await this.unqueriedObjects();
    return cascading
      .filter((relation) => !unqueried.has(relation.childSObject))
      .map((relation) => ({
        child: relation.childSObject,
        field: relation.field,
        ...(persons && relation.childSObject === CONTACT && relation.field === 'AccountId'
          ? { persons: true as const }
          : {}),
      }));
  }

  /**
   * The objects the org does not query, by name, as its global describe says
   * (`queryable: false`): described once, as the first record with children
   * comes back, unless a read of the rewind described them already.
   *
   * Such an object is a view over other records — ActivityHistory,
   * OpenActivity, NoteAndAttachment, CombinedAttachment,
   * AttachedContentDocument — listed among the children an account or a
   * contact deletes along, whose records live, and come back, as tasks,
   * events, notes and files. A read of one is refused
   * (`INVALID_TYPE_FOR_OPERATION`), and a live rewind warned for each, under
   * every record it brought back, that Undo might not send back what came
   * back with it. A describe the org does not give leaves every object read.
   */
  private unqueriedObjects(): Promise<ReadonlySet<string>> {
    this.unqueried ??= this.describeGlobal().then(
      (body) => {
        const parsed = globalObjectsSchema.safeParse(body);
        if (!parsed.success) return new Set<string>();
        return new Set(
          parsed.data.sobjects
            .filter((object) => object.queryable === false)
            .map((object) => object.name),
        );
      },
      () => {
        // Asked again by the next read that needs it, never held failed.
        this.global = undefined;
        return new Set<string>();
      },
    );
    return this.unqueried;
  }

  /**
   * The fields a record of `objectApiName` is made again with, as its
   * describe says now: of those the checkpoint compares, the ones the org
   * still has and lets the user set on a new record; and of them, the
   * lookups, whose value names a record that may have been made again.
   *
   * @throws When the org would not describe it.
   */
  private async insertFieldsOf(
    objectApiName: string,
  ): Promise<{ fields: string[]; lookups: string[] }> {
    let body = this.kept.bodies.get(objectApiName);
    if (body === undefined) {
      const answer = await this.kept.reader.describe(objectApiName);
      body = 'body' in answer ? answer.body : undefined;
    }
    const parsed = checkpointDescribeSchema.safeParse(body);
    if (!parsed.success) throw new Error(`The org gave no describe of ${objectApiName}.`);
    const byName = new Map(parsed.data.fields.map((field) => [field.name.toLowerCase(), field]));
    const held = this.request.checkpoint.objects.find(
      (object) => object.objectApiName === objectApiName,
    );
    const fields = comparedFields(
      objectApiName,
      held?.fields ?? [],
      this.request.checkpoint.ignoredFields,
    ).filter((field) => byName.get(field.toLowerCase())?.createable === true);
    const lookups = fields.filter((field) => byName.get(field.toLowerCase())?.type === 'reference');
    return { fields: fields.map(assertSoqlIdentifier), lookups };
  }

  /**
   * What a pass makes again: what the org answered is no longer in the
   * recycle bin as it brought it back, written to `remake`, and what its plan
   * counted to make again, each record once, parents first as the plan's are.
   */
  private async withPlanned(remake: IdSpoolWriter, planned: IdSpool): Promise<IdSpool> {
    for (const { objectApiName } of planned.objects) {
      for await (const ids of planned.pages(objectApiName)) {
        for (const id of ids) await remake.add(objectApiName, id);
      }
    }
    const readOrder = new Map(
      this.request.checkpoint.objects.map((object) => [object.objectApiName, object.readOrder]),
    );
    // The checkpoint reads children first: made again, parents go first.
    return remake.finish((objects) =>
      [...objects].sort(
        (a, b) => (readOrder.get(b.objectApiName) ?? 0) - (readOrder.get(a.objectApiName) ?? 0),
      ),
    );
  }

  /**
   * Make again what the recycle bin no longer gives back, parents first, from
   * the snapshot's values, 200 an insert: see the module's comment. A lookup
   * to a record still to be made — one later in the order, or of the same
   * object — goes empty, and is filled in once both are made.
   */
  private async recreate(journal: RewindJournal, spool: IdSpool, tally: PassTally): Promise<void> {
    const { checkpoint, folder } = this.request;
    /** By key, the records of the plan, by the Ids the reads name them by. */
    const planned = new RecordKeySet();
    for (const { objectApiName } of spool.objects) {
      for await (const ids of spool.pages(objectApiName)) for (const id of ids) planned.add(id);
    }
    let made = await Recreated.read(folder);
    /** The keys the checkpoint holds the records made by this pass by. */
    const madeNow = new Set<string>();
    /** The key the checkpoint holds a record by, whichever Id names it. */
    const heldKeyOf = (id: string): string => made.originalOf(id.slice(0, 15)) ?? id.slice(0, 15);
    /** Lookups left empty for a record not made yet, by the keys the checkpoint holds both by. */
    const owed: Array<{ objectApiName: string; from: string; field: string; target: string }> = [];
    for (const { objectApiName, count } of spool.objects) {
      if (tally.cancelled || this.stopped()) {
        tally.recreate({ ...emptyRecreated(objectApiName), planned: count, notReached: count });
        tally.cancelled = true;
        continue;
      }
      let insert: { fields: string[]; lookups: string[] };
      try {
        insert = await this.insertFieldsOf(objectApiName);
      } catch (err: unknown) {
        if (err instanceof OrgReadStopped) {
          tally.cancelled = true;
          tally.recreate({ ...emptyRecreated(objectApiName), planned: count, notReached: count });
          continue;
        }
        const reason = extractErrorMessage(err);
        tally.recreate({
          ...emptyRecreated(objectApiName),
          planned: count,
          refused: count,
          reasons: [reason],
        });
        for await (const ids of spool.pages(objectApiName))
          tally.leftBy('recreate', objectApiName, ids);
        continue;
      }
      for await (const ids of spool.pages(objectApiName, SNAPSHOT_CHUNK_IDS)) {
        if (tally.cancelled || this.stopped()) {
          tally.recreate({
            ...emptyRecreated(objectApiName),
            planned: ids.length,
            notReached: ids.length,
          });
          tally.cancelled = true;
          continue;
        }
        // Read with what is made so far: a lookup to a record made before
        // this one names its new Id.
        const index = await SnapshotIndex.read(folder, checkpoint.snapshotId, objectApiName, made);
        const rows: OrgRow[] = [];
        const batches = await index
          .chunk(ids)
          .batches(checkpoint.snapshotId, objectApiName, RECORDS_PER_CALL);
        for await (const batch of batches ?? []) rows.push(...batch);
        const result = { ...emptyRecreated(objectApiName), planned: ids.length };
        const found = new RecordKeySet();
        for (const row of rows) if (typeof row.Id === 'string') found.add(row.Id);
        const missing = ids.filter((id) => !found.has(id));
        if (missing.length > 0) {
          result.refused += missing.length;
          addReason(result.reasons, 'The checkpoint holds no values of it.');
          tally.leftBy('recreate', objectApiName, missing);
        }
        for (let at = 0; at < rows.length; at += RECORDS_PER_CALL) {
          if (this.stopped()) {
            const left = rows.length - at;
            result.notReached = (result.notReached ?? 0) + left;
            tally.leftBy(
              'recreate',
              objectApiName,
              rows.slice(at).map((row) => String(row.Id)),
            );
            tally.cancelled = true;
            break;
          }
          const batch = rows.slice(at, at + RECORDS_PER_CALL);
          const from = batch.map((row) => index.snapshotIdOf(String(row.Id)));
          const records = batch.map((row, place) => {
            const written = rowToWriteBack(objectApiName, row, insert.fields);
            delete written.Id;
            for (const field of insert.lookups) {
              const target = written[field];
              if (typeof target !== 'string' || target.length < 15 || !planned.has(target)) {
                continue;
              }
              const held = heldKeyOf(target);
              // Made by an insert since this page was read: its new Id.
              const now = madeNow.has(held) ? made.currentOf(held) : undefined;
              if (now !== undefined) {
                written[field] = now;
                continue;
              }
              // Named by a record of the plan not made yet: empty for now.
              owed.push({ objectApiName, from: from[place].slice(0, 15), field, target: held });
              written[field] = null;
            }
            return written;
          });
          await journal.recreating(objectApiName, from);
          const answers = saveAnswersOf(await this.org.create(objectApiName, records));
          const pairs: RecreatedPair[] = [];
          batch.forEach((row, place) => {
            const answer = answers[place];
            if (answer?.success === true && typeof answer.id === 'string') {
              pairs.push({ objectApiName, from: from[place], to: answer.id });
              return;
            }
            result.refused++;
            addReason(result.reasons, answer?.error ?? 'The org gave no answer for it.');
            tally.leftBy('recreate', objectApiName, [String(row.Id)]);
          });
          if (pairs.length > 0) {
            // Beside the checkpoint first, then in the journal: read again,
            // the checkpoint names them by their new Ids from now on.
            await Recreated.add(folder, pairs);
            await journal.recreated(
              objectApiName,
              pairs.map((pair) => ({ from: pair.from, id: pair.to })),
            );
            await journal.wrote();
            tally.wrote = true;
            result.created += pairs.length;
            for (const pair of pairs) madeNow.add(pair.from.slice(0, 15));
            made = await Recreated.read(folder);
          }
        }
        tally.recreate(result);
      }
    }
    await this.fillOwed(owed, made, madeNow, tally);
  }

  /**
   * Fill in the lookups a record was made again without, for a record made
   * after it: once both are made, 200 an update. One the org refuses is said
   * in the record's result.
   */
  private async fillOwed(
    owed: ReadonlyArray<{ objectApiName: string; from: string; field: string; target: string }>,
    made: Recreated,
    madeNow: ReadonlySet<string>,
    tally: PassTally,
  ): Promise<void> {
    const byObject = new Map<string, Map<string, Record<string, unknown>>>();
    for (const { objectApiName, from, field, target } of owed) {
      if (!madeNow.has(from) || !madeNow.has(target)) continue;
      const id = made.currentOf(from);
      const to = made.currentOf(target);
      if (id === undefined || to === undefined) continue;
      const updates = byObject.get(objectApiName) ?? new Map<string, Record<string, unknown>>();
      updates.set(id, { ...updates.get(id), Id: id, [field]: to });
      byObject.set(objectApiName, updates);
    }
    for (const [objectApiName, updates] of byObject) {
      const records = [...updates.values()];
      for (let at = 0; at < records.length; at += RECORDS_PER_CALL) {
        if (this.stopped()) return;
        const batch = records.slice(at, at + RECORDS_PER_CALL);
        const answers = saveAnswersOf(await this.org.update(objectApiName, batch));
        const result = tally.recreated.get(objectApiName);
        answers.forEach((answer, place) => {
          if (answer.success) return;
          if (result) {
            addReason(
              result.reasons,
              `Made again, but a lookup to a record made after it was refused: ${answer.error}`,
            );
          }
          tally.leftBy('recreate', objectApiName, [String(batch[place].Id)]);
        });
      }
    }
  }

  /**
   * Bring back what was deleted since, parents first, a page of 2,000 ids at
   * a time: before each batch, the children the bin holds of its records are
   * named in the journal; after it, what the undelete left on them is read.
   * What the org answers is no longer in the bin goes to `remake`, given, or
   * is left (`settleGone`).
   */
  private async bringBack(
    journal: RewindJournal,
    spool: IdSpool,
    tally: PassTally,
    stamp: (stamps: Readonly<Record<string, string>>) => void,
    remake: IdSpoolWriter | undefined,
  ): Promise<void> {
    // Read without the stop: a batch's children are named whole, or the batch is not sent.
    const children = compositeReader(this.org);
    const makesAgain = this.makesAgain();
    for (const { objectApiName, count } of spool.objects) {
      if (tally.cancelled || this.stopped()) {
        tally.undelete({ ...emptyUndelete(objectApiName), planned: count, notReached: count });
        tally.cancelled = true;
        continue;
      }
      let cascades: Cascade[];
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
        /** By key, the records the org answered are not in the bin, each with what was named under it. */
        const answeredGone = new Map<string, ChildRecord[]>();
        const call: UndeleteCall = async (batch) => {
          const { byParent, under } = await this.nameChildren(
            journal,
            children,
            cascades,
            objectApiName,
            batch,
          );
          const answer = await named(batch);
          stamp(await this.undeleteStamps(objectApiName, batch, byParent));
          for (const id of answeredNotInBin(answer, batch)) {
            answeredGone.set(keyOf(id), under.get(keyOf(id)) ?? []);
          }
          return answer;
        };
        // A record the org answers not in the bin though a read found it
        // there came back with a parent since, or is no longer there.
        const outcome = await this.settleGone(
          objectApiName,
          await settleNotInBin(
            this.org,
            await undeleteRunDeletions({
              org: this.org,
              plan: [{ objectApiName, ids }],
              undelete: call,
              ...(this.signal ? { signal: this.signal } : {}),
            }),
            [{ objectApiName, ids }],
            this.notes,
          ),
          answeredGone,
          tally,
          remake,
          makesAgain,
        );
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
   * Whether a record is one this pass can make again: of an object of the
   * checkpoint that holds no files, and held by its snapshot. Each object's
   * index is read once, as the pass first asks.
   */
  private makesAgain(): (objectApiName: string, id: string) => Promise<boolean> {
    const indexes = new Map<string, Promise<SnapshotIndex | undefined>>();
    const { checkpoint, folder } = this.request;
    return async (objectApiName, id) => {
      const object = checkpoint.objects.find((each) => each.objectApiName === objectApiName);
      if (!object || !recreatable(object)) return false;
      let index = indexes.get(objectApiName);
      if (!index) {
        // An index this machine cannot read makes nothing again: gone for good.
        index = SnapshotIndex.read(folder, checkpoint.snapshotId, objectApiName).catch(
          () => undefined,
        );
        indexes.set(objectApiName, index);
      }
      return (await index)?.has(id) === true;
    };
  }

  /**
   * `outcome` once what the org answered is no longer in the recycle bin is
   * settled — what the undelete left of `answered`, each with the records
   * named in the bin as coming back with it: what the checkpoint can make
   * again of them, and of what was to come back with them, goes to `remake`
   * when given, out of what the bring-back counts, its outcome now the
   * insert's; without it, they are left, in words that say what lifts it. A
   * record the checkpoint cannot make again is gone for good.
   *
   * Seen live: an account, a contact and a second account under the first
   * were deleted, then emptied from the bin. Read right after, all three and
   * the first account's two contacts were still in the bin, the undelete of
   * each answered "Entity is not in the recycle bin", and the rewind, asked
   * to make records again, named them refused and made nothing.
   */
  private async settleGone(
    objectApiName: string,
    outcome: SyncUndeleteOutcome,
    answered: ReadonlyMap<string, readonly ChildRecord[]>,
    tally: PassTally,
    remake: IdSpoolWriter | undefined,
    makesAgain: (objectApiName: string, id: string) => Promise<boolean>,
  ): Promise<SyncUndeleteOutcome> {
    const gone = outcome.left.filter((id) => answered.has(keyOf(id)));
    if (gone.length === 0) return outcome;
    const moved = new Set<string>();
    let notRemade = 0;
    for (const id of gone) {
      if (!(await makesAgain(objectApiName, id))) {
        tally.mark('lost', objectApiName, id);
        continue;
      }
      const along: ChildRecord[] = [];
      for (const child of answered.get(keyOf(id)) ?? []) {
        if (await makesAgain(child.objectApiName, child.id)) along.push(child);
      }
      if (remake) {
        await remake.add(objectApiName, id);
        for (const child of along) await remake.add(child.objectApiName, child.id);
        moved.add(keyOf(id));
        continue;
      }
      notRemade++;
      tally.mark('notInBin', objectApiName, id);
      for (const child of along) tally.mark('notInBin', child.objectApiName, child.id);
    }
    const stays = gone.length - moved.size;
    return {
      ...outcome,
      objects: outcome.objects.map((object) => {
        if (object.objectApiName !== objectApiName) return object;
        const reasons =
          stays === 0
            ? object.reasons.filter((reason) => !NOT_IN_BIN.test(reason))
            : notRemade > 0
              ? object.reasons.map((reason) =>
                  NOT_IN_BIN.test(reason) ? NOT_REMADE_WORDS : reason,
                )
              : object.reasons;
        return {
          ...object,
          planned: object.planned - moved.size,
          refused: Math.max(0, object.refused - moved.size),
          reasons,
        };
      }),
      left: outcome.left.filter((id) => !moved.has(keyOf(id))),
    };
  }

  /**
   * Name in the journal the records the recycle bin holds under `parents`,
   * through each of `cascades`, before they come back with them: the
   * children deleted with them, and those deleted on their own before them,
   * which the org may bring back too; and under those, through their own
   * object's cascades, their children, as deep as the bin holds them. The org
   * brings back with a record everything its delete took along: an account
   * comes back with its opportunity and the opportunity's lines, and an undo
   * that knew of the opportunity alone kept it for its lines, and the account
   * with it. Each is named beside the record of `parents` it hangs from, as
   * deep as it hangs: its undo sends it back to the bin with that record.
   * By parent, every record named under it (`byParent`), and of them, with
   * their objects, those but a person account's contact (`under`).
   *
   * A person account's own contact is not named: the org deletes it with its
   * account alone, never on its own, and an undo that sent it back to the bin
   * on its own was refused, and kept its account for it. It goes back to the
   * bin with its account, as the removal reads it.
   */
  private async nameChildren(
    journal: RewindJournal,
    reader: CompositeReader,
    cascades: readonly Cascade[],
    objectApiName: string,
    parents: readonly string[],
  ): Promise<{ byParent: Map<string, string[]>; under: Map<string, ChildRecord[]> }> {
    const byParent = new Map<string, string[]>();
    const under = new Map<string, ChildRecord[]>();
    const seen = new Set(parents.map(keyOf));
    /** Per record named, the record of `parents` it hangs from. */
    const rootOf = new Map(parents.map((id) => [keyOf(id), keyOf(id)]));
    const found = new Map<string, string[]>();
    /** Per object found, beside each of its records, the record of `parents` it hangs from. */
    const roots = new Map<string, string[]>();
    let level: Array<{ objectApiName: string; cascades: readonly Cascade[]; ids: string[] }> = [
      { objectApiName, cascades, ids: [...parents] },
    ];
    while (level.length > 0) {
      /** The records found at this level, per object: the parents of the next. */
      const next = new Map<string, string[]>();
      for (const { objectApiName: parentObject, cascades: listed, ids } of level) {
        for (const list of idLists(ids, RECORDS_PER_CALL)) {
          const relations = listed.filter(({ child }) => !this.noBin.has(child));
          if (relations.length === 0) break;
          const reads = relations.map(({ child, field, persons }) => ({
            objectApiName: child,
            soql:
              `SELECT Id, ${assertSoqlIdentifier(field)}${persons ? `, ${PERSON_ACCOUNT_FLAG}` : ''} ` +
              `FROM ${assertSoqlIdentifier(child)} WHERE ${field} IN (${list}) AND IsDeleted = true`,
            scanAll: true,
          }));
          const outcomes = await readStreams(reader, reads, (index, rows) => {
            const { child, field, persons } = relations[index];
            for (const row of rows) {
              const parent = row[field];
              if (typeof row.Id !== 'string' || typeof parent !== 'string') continue;
              const key = keyOf(row.Id);
              const root = rootOf.get(keyOf(parent));
              if (root === undefined || seen.has(key)) continue;
              seen.add(key);
              rootOf.set(key, root);
              byParent.set(root, [...(byParent.get(root) ?? []), row.Id]);
              if (persons && row[PERSON_ACCOUNT_FLAG] === true) continue;
              under.set(root, [...(under.get(root) ?? []), { objectApiName: child, id: row.Id }]);
              found.set(child, [...(found.get(child) ?? []), row.Id]);
              roots.set(child, [...(roots.get(child) ?? []), root]);
              next.set(child, [...(next.get(child) ?? []), row.Id]);
            }
          });
          outcomes.forEach((outcome, index) => {
            if (outcome.read) return;
            // An object that keeps no IsDeleted has no recycle bin — a case's
            // team members, a case team template's members: deleted for good
            // with their parent, nothing of it waits in the bin to come back.
            // The org's answer says so, once: it is not read again, and no
            // warning is given (a live rewind gave one under every record).
            if (NO_RECYCLE_BIN.test(outcome.reason)) {
              this.noBin.add(relations[index].child);
              return;
            }
            this.notes.push(
              `The ${relations[index].child} records that come back with ${parentObject} could ` +
                `not be read (${outcome.reason}): Undo may not send those ${objectApiName} ` +
                'records back to the recycle bin.',
            );
          });
        }
      }
      level = [];
      for (const [child, ids] of next) {
        level.push({ objectApiName: child, cascades: await this.cascadesUnder(child), ids });
      }
    }
    for (const [child, ids] of found) await journal.withParent(child, ids, roots.get(child));
    return { byParent, under };
  }

  /**
   * The cascades of an object whose records came back with a parent, read
   * once: none, said, when the org gives no describe of it.
   */
  private cascadesUnder(objectApiName: string): Promise<Cascade[]> {
    let cascades = this.cascadesOfObject.get(objectApiName);
    if (!cascades) {
      cascades = this.cascadesOf(objectApiName).catch((err: unknown) => {
        this.notes.push(
          `The records that come back with ${objectApiName} records could not be told ` +
            `(${extractErrorMessage(err)}): Undo may not send them back to the recycle bin.`,
        );
        return [];
      });
      this.cascadesOfObject.set(objectApiName, cascades);
    }
    return cascades;
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
      for await (const page of spool.pages(objectApiName, SNAPSHOT_CHUNK_IDS)) {
        // Made again by this pass, the bin no longer giving it back: the
        // record that stands for it holds the checkpoint's values already.
        const ids = page.filter((id) => !index.retired(id));
        if (ids.length === 0) continue;
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
    fresh: DiffRead,
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
      // Gone for good when the rewind began, gone for good still: a record
      // the bin keeps for good under a parent the rewind brought back reads
      // as one to bring back once that parent is live, which no read tells.
      const goneBefore = new RecordKeySet();
      if (fresh.dir !== verify.dir) {
        for await (const row of rowsOf(classFileOf(fresh.dir, name, 'goneForGood'))) {
          if (typeof row.Id === 'string') goneBefore.add(row.Id);
        }
      }
      for (const { cls, id } of found) {
        if (cls === 'goneForGood' || goneBefore.has(id)) {
          add(name, 'goneForGood', id);
          continue;
        }
        const keptWords = LEFT_AS_IT_IS[cls];
        if (keptWords !== undefined) {
          add(name, 'kept', id, { message: keptWords });
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
        // The org answered it is no longer in the recycle bin: gone for good
        // when the checkpoint cannot make it again, left as it is when making
        // it again was not accepted.
        if (BRICK_OF[cls] === 'undelete') {
          if (tallies.some((tally) => tally.lost.get(name)?.has(id) === true)) {
            add(name, 'goneForGood', id);
            continue;
          }
          if (tallies.some((tally) => tally.notInBin.get(name)?.has(id) === true)) {
            add(name, 'notInBin', id);
            continue;
          }
        }
        // One to bring back made again instead is said in the insert's words.
        const brick =
          BRICK_OF[cls] === 'undelete' &&
          tallies.some((tally) => tally.left.recreate.get(name)?.has(id) === true)
            ? 'recreate'
            : BRICK_OF[cls];
        const heldBy = brick === 'removal' ? this.keptForDependents(tallies, name, id) : undefined;
        if (heldBy !== undefined) {
          add(name, 'kept', id, { message: keptForWords(heldBy) });
          continue;
        }
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

  /**
   * The objects whose records, staying, held a record the last pass to leave
   * it set out to delete — records that existed at the checkpoint, were made
   * while it was taken, or were changed since the rewind began — when that
   * pass's removal kept every record of the object it left for them, and the
   * org refused none: the rewind's own choice, never the org's refusal.
   * Undefined for any other record.
   */
  private keptForDependents(
    tallies: readonly PassTally[],
    objectApiName: string,
    id: string,
  ): string[] | undefined {
    for (const tally of tallies) {
      if (tally.left.removal.get(objectApiName)?.has(id) !== true) continue;
      const result = tally.deleted.get(objectApiName);
      return result && result.refused === 0 && result.keptDependents > 0 && result.heldBy.length > 0
        ? result.heldBy
        : undefined;
    }
    return undefined;
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
            : brick === 'recreate'
              ? tally.recreated.get(objectApiName)?.reasons
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

/** One record's answer to an insert or an update, as the org gives it in a collection call. */
interface SaveAnswer {
  success: boolean;
  id?: string;
  /** The org's words, `CODE: message`, for a record it refused. */
  error?: string;
}

const saveAnswerSchema = z
  .object({
    success: z.boolean(),
    id: z.string().nullish(),
    errors: z
      .array(
        z.union([
          z.string(),
          z.object({ statusCode: z.string().optional(), message: z.string().optional() }).loose(),
        ]),
      )
      .optional(),
  })
  .loose();

/**
 * The answers of a collection insert or update, one per record in their
 * order; an answer that is not one reads as a refusal without words.
 */
function saveAnswersOf(answer: unknown): SaveAnswer[] {
  const list = Array.isArray(answer) ? answer : [answer];
  return list.map((item): SaveAnswer => {
    const parsed = saveAnswerSchema.safeParse(item);
    if (!parsed.success) return { success: false };
    const { success, id, errors } = parsed.data;
    const words = (errors ?? [])
      .map((error) =>
        typeof error === 'string'
          ? error
          : [error.statusCode, error.message].filter((part) => part).join(': '),
      )
      .filter((word) => word !== '');
    return {
      success,
      ...(typeof id === 'string' ? { id } : {}),
      ...(words.length > 0 ? { error: words.join('; ') } : {}),
    };
  });
}
