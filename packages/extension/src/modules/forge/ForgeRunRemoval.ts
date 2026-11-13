import type { Connection } from 'jsforce';
import type {
  ForgeRemovalSpan,
  ForgeRunObjectRecords,
  ForgeUndoObjectResult,
} from '@sandforge/shared';
import {
  PRICEBOOK_ENTRY_CURRENCY_FIELD,
  PRICEBOOK_ENTRY_OBJECT,
  PRICEBOOK_ENTRY_PRODUCT_FIELD,
  PRICEBOOK_ENTRY_SELLING_MODEL_FIELD,
  SELLING_MODEL_OPTION_OBJECT,
  isPricebookEntry,
} from '@sandforge/shared';

import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { limitSplitting, type LimitSplitting } from '../../core/common/governorLimit.js';
import {
  LOCKED_PAST_DRAFT,
  STATUS_LIFECYCLES,
  standardPriceIds,
  statusCategories,
  type StatusCategories,
} from '../../core/common/platformRecords.js';
import { describedObjectSchema } from '../dataops/DataQualityScanner.js';
import type { OrgSession } from '../dataops/RecordRemoval.js';
import {
  idLists,
  inPool,
  orgSession,
  readRecordsById,
  RECORDS_PER_CALL,
  workedObjects,
} from '../dataops/RecordRemoval.js';
import { jsforceBulk } from '../../core/engine/jsforceBulk.js';
import {
  BULK_DELETE_JOB_RECORDS,
  bulkDeleteJob,
  deleteLimitNotes,
  goesByJob,
  lockResendNote,
  queryOf,
  removalOrder,
  retryRounds,
  sendDeletes,
  takenAlong,
  type BulkDeleteAnswer,
  type DeleteOutcome,
} from '../../core/removal/deleteRecords.js';
import { backToDraft, putBackStatuses, type Drafted } from '../../core/removal/recordsToDraft.js';
import { recycleBinOf } from '../../core/removal/recycleBin.js';
import {
  OTHER_VERSIONS_KEPT,
  isArticleVersionObject,
  versionsKeptOf,
  withArticleRemoval,
} from '../seed/articleRemoval.js';
import {
  QUOTE_OBJECT,
  quoteSyncCopiesOf,
  quoteSyncCopyObjectsOf,
  type PlatformCopies,
  type QuoteSyncRun,
} from './quoteSyncCopies.js';
import { MADE_WITHIN_MS, TIE_LEAD_MS } from './sweepTies.js';
import { DUPLICATE_SET_OBJECT, duplicateSetsOf } from './duplicateRecordSets.js';

// The deletes themselves are the removal core's, shared with whatever else
// deletes records: what the removal's callers have always read from here.
export {
  BULK_DELETE_JOB_RECORDS,
  BULK_DELETE_THRESHOLD,
  bulkDeleteJob,
  deleteBatch,
  deleteLimitNotes,
  deleteSplittingOnLimits,
  removalOrder,
  takenAlong,
  type BulkDeleteAnswer,
  type DeleteOutcome,
  type LimitedDeletes,
  type ReadBack,
} from '../../core/removal/deleteRecords.js';
export { setBackToDraftOf } from '../../core/removal/recordsToDraft.js';

/** Reasons kept per object: an org repeats the same few. */
const REASON_LIMIT = 5;

/**
 * Reads of an object's dependents sent at once. Each answers in a quarter of a
 * second on a scratch org, most of it the way there and back, and a contact
 * lists 23 relationships the check reads per 200 records: 12 000 contacts took
 * 1 380 reads one after the other, nearly six minutes of a removal that spent
 * less than one deleting. Four at a time, as the related records of a delete
 * are counted (`countRelated`).
 */
const DEPENDENT_READS_AT_ONCE = 4;

/**
 * Rows one read of an object's dependents takes. A list that fills it may
 * hold more than were read, and every record it names is kept.
 */
const DEPENDENTS_READ_LIMIT = 2_000;

/**
 * Levels below a record of the run that what goes along with it is read
 * down: an object may be the detail of a detail of a detail of a standard
 * object, three custom levels, and an account takes along an opportunity
 * that takes along a quote and its lines. Past them, what goes along is
 * kept, unread.
 */
const CASCADE_LEVELS_READ = 4;

/**
 * The dates a read of dependents asks for, tried in turn, with who created
 * the record and who last modified it where the object keeps both dates: an
 * object that has neither `CreatedDate` nor `LastModifiedDate` may still keep
 * a system stamp, and one that keeps none is read without dates. Who last
 * modified a record tells a change since the run from what a removal of it
 * made the org write (`DependentsCheck.stays`). A feed item keeps who created
 * it and not who last modified it: read with its system stamp alone, the
 * tracked change a removal's delete of line items made the org write passed
 * for one added since the run, and kept the opportunity and its account.
 */
const DEPENDENT_DATE_COLUMNS: readonly (readonly string[])[] = [
  ['CreatedDate', 'LastModifiedDate', 'CreatedById', 'LastModifiedById'],
  ['CreatedDate', 'LastModifiedDate', 'CreatedById'],
  ['SystemModstamp'],
  [],
];

/**
 * Leeway on a date this machine's clock gave, once read on the org's: the
 * drift of one clock from the other between a run and its removal, and the
 * second the org rounds its dates to. A Frozen reload judges the records of a
 * load the org did not date by it too, as that load's removal will.
 */
export const CLOCK_LEEWAY_MS = 10_000;

/** Key prefix of a user: the owner a file's first link names. */
const USER_KEY_PREFIX = '005';

/** A file's link to a record, which the org deletes with the record. */
const FILE_LINK = 'ContentDocumentLink';

/** A file, which the org keeps when a record it was attached to goes. */
const FILE = 'ContentDocument';

/** A file's version, which the org deletes only with its document. */
const FILE_VERSION = 'ContentVersion';

/** Files named per object: the count says how many there were. */
const FILE_NAME_LIMIT = 5;

/** Records told by their key, as a set of keys tells them, without holding them. */
export interface RecordKeys {
  has(key: string): boolean;
}

/**
 * The records a removal takes, read a page at a time each time it goes
 * through them: per object, in the order the plan gives the objects —
 * children before their parents, as far as the run knows — and the order it
 * gives each object's records.
 *
 * A run past the summary's bound keeps its ids in its journal, a million of
 * them for a run of whole tables; read into memory whole, a removal held each
 * several times over — its plan, its records' keys, their dates: removing a
 * million records so took some 650 MB more of the extension host than it held
 * before. Read from the journal a page at a time (`ForgeRunJournal.recordsOf`),
 * it holds a page of ids, a few bytes a record besides, and the records it
 * could not take: some 150 MB for the same million.
 */
export interface RunRecords {
  /** The objects, in the plan's order, with how many records of each. */
  readonly objects: ReadonlyArray<{ readonly objectApiName: string; readonly count: number }>;
  /** The ids of an object's records, a page at a time: the same pages each time it is asked. */
  pages(objectApiName: string): AsyncIterable<readonly string[]>;
  /** Whether a record, by its key — the first fifteen characters of its id — is one of them. */
  has(key: string): boolean;
}

/** The records of a plan held in memory, as a removal reads them: each object one page. */
export function runRecordsOf(plan: readonly ForgeRunObjectRecords[]): RunRecords {
  const keys = new Set(plan.flatMap((object) => object.ids.map(recordKey)));
  const idsOf = new Map<string, string[]>();
  for (const { objectApiName, ids } of plan) {
    idsOf.set(objectApiName, [...(idsOf.get(objectApiName) ?? []), ...ids]);
  }
  return {
    objects: [...idsOf].map(([objectApiName, ids]) => ({ objectApiName, count: ids.length })),
    pages: async function* (objectApiName) {
      const ids = idsOf.get(objectApiName);
      if (ids && ids.length > 0) yield ids;
    },
    has: (key) => keys.has(key),
  };
}

/** Whether `plan` is records read a page at a time rather than a plan held in memory. */
export function isRunRecords(
  plan: readonly ForgeRunObjectRecords[] | RunRecords,
): plan is RunRecords {
  return !Array.isArray(plan);
}

/** How many records a plan holds, in memory or read a page at a time. */
export function recordsIn(plan: readonly ForgeRunObjectRecords[] | RunRecords): number {
  return isRunRecords(plan)
    ? plan.objects.reduce((sum, object) => sum + object.count, 0)
    : plan.reduce((sum, object) => sum + object.ids.length, 0);
}

/** The objects of a plan, in its order. */
export function objectsIn(plan: readonly ForgeRunObjectRecords[] | RunRecords): string[] {
  return (isRunRecords(plan) ? plan.objects : plan).map((object) => object.objectApiName);
}

/**
 * A mark for each of an object's records by its place among them, a bit
 * each: which a removal took, without holding their ids.
 */
class PlaceMarks {
  private bits = new Uint8Array(0);

  add(place: number): void {
    const byte = place >> 3;
    if (byte >= this.bits.length) {
      const grown = new Uint8Array(Math.max(byte + 1, this.bits.length * 2, 64));
      grown.set(this.bits);
      this.bits = grown;
    }
    this.bits[byte] |= 1 << (place & 7);
  }

  has(place: number): boolean {
    const byte = place >> 3;
    return byte < this.bits.length && (this.bits[byte] & (1 << (place & 7))) !== 0;
  }
}

/** A date for each of an object's records by its place among them; NaN where none was read. */
class PlaceDates {
  private dates = new Float64Array(0);

  set(place: number, date: number): void {
    if (place >= this.dates.length) {
      const grown = new Float64Array(Math.max(place + 1, this.dates.length * 2, 64)).fill(
        Number.NaN,
      );
      grown.set(this.dates);
      this.dates = grown;
    }
    this.dates[place] = date;
  }

  at(place: number): number {
    return place < this.dates.length ? this.dates[place] : Number.NaN;
  }

  /** The latest of the dates from `from` to `to`, both included; NaN when none is. */
  latestWithin(from: number, to: number): number {
    let latest = Number.NaN;
    for (const date of this.dates) {
      if (date >= from && date <= to && !(date <= latest)) latest = date;
    }
    return latest;
  }
}

/** Whether `value` is the id of one of the run's records. */
function isRunRecord(value: unknown, runRecords: RecordKeys): boolean {
  return typeof value === 'string' && runRecords.has(recordKey(value));
}

/**
 * The dates a snapshot of the run's records reads them by, tried in turn: when
 * each was created, which dates a run that kept no dates of its own by the
 * org's clock, and when each was last modified; or, for an object that keeps
 * no `LastModifiedDate` — a relation of an email message — its system stamp
 * alone.
 */
const SNAPSHOT_DATE_COLUMNS: readonly { created?: string; modified: string }[] = [
  { created: 'CreatedDate', modified: 'LastModifiedDate' },
  { modified: 'SystemModstamp' },
];

/**
 * A record the platform adds on its own to a record it has just written: the
 * fields that tie it to the run, read with it, and whether they do.
 */
interface PlatformAdded {
  /** The fields read with the record to tell. */
  ends: readonly string[];
  /** Whether the record came with the run, by those fields. */
  cameWithRun: (row: Record<string, unknown>, runRecords: RecordKeys) => boolean;
}

/**
 * The records the platform adds on its own to a record right after it is
 * written, which come with the run and go with it: they never hold a record
 * of the run in the org. Each is read by the ends that tie it to the run
 * rather than by its date, because the platform writes it a moment after the
 * record — after the run's last write when that record was the last — and
 * dated, it read as added since the run and held the record. Seen on a
 * sandbox, cloning a quote with its account and files, and an account alone:
 *
 * - `ContentDocumentLink`: the owner's link and the record's link to a file
 *   the run wrote, stamped a second after the file. It came with the run when
 *   it links a document the run created to one of the run's records or to a
 *   user; a link to a file from before the run is someone's since.
 * - `DuplicateRecordItem`: a duplicate rule's report that the record matches
 *   others, written up to two seconds after the record, into a set the org
 *   already held. Cloning an account alone, it came after the run's last
 *   write and held the account. It is bookkeeping about the run's record,
 *   whenever it was written: the org deletes it with the record.
 * - `ContentVersion`: a file's version, made with the file — the first one
 *   makes it — or as a new version of it, which moves the file's own dates
 *   (P-A6, a scratch org). A version of a file of the run's comes and goes
 *   with it, the file's dates saying whether it changed since: read by its
 *   own, a file made while a checkpoint was taken was held by its first
 *   version, dated before the checkpoint's end, and a rewind kept it.
 *
 * The same clone had the platform write QuoteHistory, Pricebook2History and
 * ContentDocumentHistory rows, which this check never reads (the org gives
 * them no page layout), and restamp each file's version seconds after the run,
 * which is read by its created and modified dates, both inside the run.
 */
const PLATFORM_ADDED: Readonly<Record<string, PlatformAdded>> = {
  ContentDocumentLink: {
    ends: ['ContentDocumentId', 'LinkedEntityId'],
    cameWithRun: (row, runRecords) => {
      const linked = row.LinkedEntityId;
      return (
        isRunRecord(row.ContentDocumentId, runRecords) &&
        (isRunRecord(linked, runRecords) ||
          (typeof linked === 'string' && linked.startsWith(USER_KEY_PREFIX)))
      );
    },
  },
  DuplicateRecordItem: {
    ends: ['RecordId'],
    cameWithRun: (row, runRecords) => isRunRecord(row.RecordId, runRecords),
  },
  ContentVersion: {
    ends: ['ContentDocumentId'],
    cameWithRun: (row, runRecords) => isRunRecord(row.ContentDocumentId, runRecords),
  },
};

/** What the removal of a run's records needs from the org it wrote to. */
export type RemovalOrg = Pick<
  OrgSession,
  'query' | 'destroy' | 'describe' | 'describeGlobal' | 'update'
> & {
  /**
   * The org's clock now, as the org writes a date: the removal dates its own
   * start by it, as the org dates what the removal makes it do.
   */
  serverTime(): Promise<string>;
  /**
   * The id of the user the session writes as: what the org creates in answer
   * to the removal is created by that user.
   */
  userId(): Promise<string>;
  /**
   * A query that reads the org's recycle bin too (`queryAll`): what tells a
   * record deleted from one the session cannot see.
   */
  queryDeleted(soql: string): Promise<{ records: unknown[] }>;
  /**
   * Delete `ids` of one object through one Bulk API 2.0 `delete` job — to the
   * recycle bin, as a delete over REST sends them, never `hardDelete` — and
   * answer each of them, in their order. A removal sends this way the records
   * of an object past {@link BULK_DELETE_THRESHOLD}; absent, every delete
   * goes over REST.
   *
   * @param signal - A stop before the job is closed aborts it, and the org
   *   deletes none of its records; once closed, the job is awaited.
   */
  bulkDestroy?(
    objectApiName: string,
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<BulkDeleteAnswer>;
};

/**
 * The org a removal works on, over a jsforce connection: the session the
 * cleanup work uses, the org's clock and the session's user, which only the
 * SOAP API tells, and its Bulk API 2.0 for the deletes past
 * {@link BULK_DELETE_THRESHOLD}.
 *
 * @param conn - The run's target org.
 * @param context - Names the work in the API-usage warnings.
 */
export function removalOrg(conn: Connection, context: string): RemovalOrg {
  return {
    ...orgSession(conn, context),
    serverTime: async () => (await conn.soap.getServerTimestamp()).timestamp,
    userId: async () => (await conn.soap.getUserInfo()).userId,
    queryDeleted: async (soql) => {
      const answer = await conn.query<Record<string, unknown>>(soql, { scanAll: true });
      return { records: answer.records };
    },
    bulkDestroy: (objectApiName, ids, signal) =>
      bulkDeleteJob(jsforceBulk(conn), objectApiName, ids, signal),
  };
}

/**
 * How a removal of a run's records goes.
 *
 * The run's span is the target's, never this machine's: every date the
 * removal compares with it is the org's own, and against a clock a second
 * behind the org's, the records a run wrote last would read as changed since.
 * Given, it is what the run read back from the org as it ended
 * (`ForgeExecutionResult.writtenBetween`); absent — a run recorded before runs
 * kept it, or one whose dates could not all be read back — it is read from the
 * records and from when the run was recorded.
 */
export interface RunRemovalOptions {
  /**
   * The target's date of the run's first write: a record older than this did
   * not come with it. Absent, the earliest `CreatedDate` of the run's records,
   * or when the run began if that is later.
   */
  runStartedAt?: Date;
  /**
   * The target's date of the last stamp the run left: a record modified after
   * it was changed since. Absent, when the run was recorded, read on the
   * org's clock; or, with no such time, the start plus `runDurationMs`.
   */
  runEndedAt?: Date;
  /** How long the run took, for a run whose end the target did not date. */
  runDurationMs?: number;
  /**
   * When the run was recorded, on this machine's clock, right after its last
   * write: for a run the target did not date, the latest that write can have
   * been, once read on the org's clock.
   */
  runRecordedAt?: Date;
  /**
   * For a run dated by `runRecordedAt` alone: end it with its last write as
   * the org dated it — the latest `CreatedDate` or `LastModifiedDate` of its
   * records, as the removal reads them, that falls within the run as this
   * machine's clock dates it, and the rest of that second — rather than
   * {@link CLOCK_LEEWAY_MS} after it was recorded. The leeway stands where
   * the org gave no such date: no record left, none written within it.
   *
   * A part of a clone cut and taken up is dated by its journal, on the
   * machine's clock. Live, a contact role the run's user made by hand under
   * the cut part's opportunity, eight seconds after that part ended, fell
   * within that leeway: removed by the journal, it was read as the run's and
   * went with the opportunity, unsaid. What the part's second pass wrote to its own
   * records is within it still: a lookup filled in, a status given back.
   */
  endedByItsWrites?: boolean;
  /**
   * What earlier removals of the run wrote to records they left in the org,
   * by record id: the `LastModifiedDate` the org left on each. A record last
   * modified no later than that was not changed since the run.
   */
  removalStamps?: Readonly<Record<string, string>>;
  /**
   * When earlier removals of the run that wrote to the org ran, and as which
   * user: what that user created meanwhile is the org's answer to one of
   * them, as what the removal's user creates once it is under way is its own.
   */
  removalSpans?: readonly ForgeRemovalSpan[];
  /**
   * Delete the records the run created that were modified since it ended too,
   * and let what was added to its records since go with them.
   */
  includeChanged: boolean;
  /**
   * The sweep of what the target's automation created during the run
   * (`sweepRunRecords`), made once the removal has read the run's records —
   * and so what changed since the run — and before its first write; it
   * resolves to whether it deleted anything. Made before that reading, a
   * sweep that deleted a child of one of the run's records with a roll-up
   * summary restamped that record as the org recalculated the summary, and
   * the removal then kept it as changed since the run. A stop during the
   * sweep stops the removal before its first write. It is handed the
   * removal's sizes and smaller calls ({@link splitting}): a sweep whose
   * deletes the target's automation refuses for a limit spends them with
   * the removal, one bound for the two.
   */
  sweep?: (splitting?: LimitSplitting) => Promise<boolean>;
  /**
   * The last part of a sweep granted with the removal, made once the run's
   * records are deleted: what the sweep found made for the run that a record
   * of the run points at through a lookup the org restricts the delete by —
   * an Asset a Case of the run names (`Case.AssetId`) — which goes only once
   * that record is gone. It resolves to whether it deleted anything; a
   * record of the run kept leaves what it points at, and says so. Absent,
   * nothing waits for the run's records. Handed the removal's sizes and
   * smaller calls, as {@link sweep} is.
   */
  afterRemoval?: (splitting?: LimitSplitting) => Promise<boolean>;
  /**
   * The size each object's deletes go at once the target's automation
   * refused one of its calls for a Salesforce limit, and the smaller calls
   * the removal allows itself (`sendSplittingOnLimits`): a rewind hands one
   * for the act, from what its gate read of the org's daily requests, shared
   * by its passes. Absent, the removal's own, of 2 000 smaller calls: it reads
   * none of the org's requests.
   */
  splitting?: LimitSplitting;
  /**
   * The ids of the records a granted sweep found made for the run by the
   * target's automation, which it deletes: a child among them, still in the
   * org when its parent's turn comes, holds none of the run's records back,
   * and goes along with it. Absent without a granted sweep: such a child
   * holds its parent as any record that stays.
   */
  automationMade?: ReadonlySet<string>;
  /**
   * The user the run wrote as, by Salesforce id, as the run kept it
   * (`ForgeExecutionResult.runUserId`): what the target's automation made
   * under the run's records was created as that user, and the platform's
   * copies of a synced quote's lines too. Absent — a run recorded before it
   * was kept — the creator of the run's own record each is tied to stands
   * for it.
   */
  runUserId?: string;
  /**
   * Asked before the removal's first write, when the user it runs as may not
   * delete the records of some objects of the run, as their describes say:
   * whether to remove the rest, leaving those, or to stop with nothing
   * removed. Absent, the rest is removed. Either way the records of those
   * objects are never sent: each object's result says why they stay. Asked
   * nothing, a removal deleted the children, then had every parent refused.
   */
  onUndeletable?: (objects: readonly UndeletableObject[]) => Promise<boolean>;
  /**
   * Called once, right before the removal's first write — its sweep's
   * included —, once `onUndeletable` has been answered and all it reads first
   * is read: where a removal that mutes the target's automation takes its
   * lease. A person answering the question then holds no permission set
   * assigned; taken before it, the sets stayed assigned, renewed, for as long
   * as the question stayed open, and for nothing once it was answered no. Not
   * called by a preview, nor by a removal that stops before it writes.
   */
  beforeFirstWrite?: () => Promise<void>;
  /**
   * Stops the removal before its next call to the org, but for the calls that
   * give a status it changed for a delete back to the records it leaves, and
   * the reads of what it left on them.
   */
  signal?: AbortSignal;
  /** Told how many of the run's records are settled, after each step. */
  onProgress?: (settled: number, total: number, objectApiName: string) => void;
  /**
   * The run's other parts, each removed apart from this one: the part a
   * resume took the run up with, the part it resumed, a retry of it. What
   * this removal's deletes restamp of their records is said back, part by
   * part (`RunRemovalOutcome.otherPartStamps`), for each part's own removal
   * to read as the run's doing, not as a change since.
   */
  otherParts?: readonly RunPartAlongside[];
  /**
   * Records of the run's other parts that `otherParts` does not hand over:
   * those the same removal takes part by part, before or after this one —
   * the parts of a journal removed whole, or what earlier removals of the
   * run's other parts left. As theirs, one under a record of the plan is the
   * run's own, never what the target's automation made for the run.
   */
  otherPartRecords?: readonly ForgeRunObjectRecords[];
  /**
   * The run's parts after the one removed, each with what it wrote beyond its
   * own records: see {@link RunLaterPart}. Absent, the plan's records are read
   * against the run's own end alone.
   */
  laterParts?: readonly RunLaterPart[];
  /**
   * Whether a record outside the plan, read hanging from one of its records
   * through a relationship the org deletes along, goes with that record
   * whatever its dates: read with them, against `runEnd`, the run's end on
   * the org's clock. The undo of a rewind names this way what came back with
   * a record the rewind brought back: older than the rewind, such a record
   * would hold its parent; sent on its own before it, Salesforce would keep
   * it in the recycle bin for good once its parent went after it.
   */
  goesWithParent?: (row: Readonly<Record<string, unknown>>, runEnd: number) => boolean;
  /**
   * With {@link goesWithParent}: what it names is read in turn for what hangs
   * from it, by the run's dates, as what came with the run is — it goes
   * whatever its own dates, but what someone hung under it since does not.
   * The undo of a rewind names so what came back with the records it sends
   * back to the recycle bin, which no other removal reads below: a record
   * added since under one of them went with it, unsaid. Absent, what it
   * names goes as it is, unread further down: a Frozen reload names so the
   * records of the other loads it replaces, whose own removal reads them by
   * their own load's dates.
   */
  goesWithParentReadBelow?: true;
  /**
   * Set when what goes along with the plan's records was read before the
   * removal, as far down as it hangs, and taken along once accepted: a
   * rewind's plan reads every record of its checkpoint's objects that hangs
   * from what it deletes, keeps what holds a record it leaves, and asks
   * before it takes along what outside them was created since. What hangs
   * from a record that goes along is then not read again, a level further
   * down: the rewind's estimate prices the reads its removal sends.
   */
  alongAccepted?: true;
  /**
   * Records outside the plan that go with a parent of the plan and are set to
   * Draft with its own, before any delete: an order past Draft keeps the
   * account it hangs from from being deleted, which then refuses it whatever
   * goes with it (a rewind of a clone, live). What the removal leaves of them
   * gets its status back as its own do.
   */
  alongToDraft?: RunRecords;
  /**
   * Read the run's records as the removal reads them before its first write —
   * what is still in the org, in its recycle bin or nowhere, what changed
   * since the run and who changed it, which objects the user may not delete —
   * and stop there, writing nothing: what it would do is said per object
   * (`RunRemovalOutcome.preview`). The sweep is not made and `onUndeletable`
   * is not asked. What hangs from the records, which a real removal reads at
   * each object's turn, record by record, is not read: a record kept for
   * records that stay is counted with those it would delete — unless
   * `previewHeld` asks for it.
   */
  previewOnly?: boolean;
  /**
   * With `previewOnly`: read too what hangs from the records it would send,
   * as a real removal reads it at each object's turn, children first — a
   * record of the run kept for one that stays then stays itself, and holds
   * its parents — and count apart the records it would keep for them
   * (`RemovalPreviewObject.keptDependents`). Not read: the rows a record past
   * Draft locks under it, which a real removal sets back to Draft first.
   *
   * A Frozen reload's purge deleted the records of the loads it replaced
   * without reading what hung from them: a contact made by hand under one of
   * their accounts went with the account, unsaid, the reload a success.
   */
  previewHeld?: boolean;
}

/**
 * What a removal would do with one object's records, read before its first
 * write (`RunRemovalOptions.previewOnly`). Every record of the object is
 * counted once: `toDelete`, `alreadyGone`, `keptChanged`, `undeletable`,
 * `notVisible`, `unread` and, when it was read, `keptDependents` add up to
 * `planned`.
 */
export interface RemovalPreviewObject {
  objectApiName: string;
  /** The run's records of the object: what the removal sets out to take. */
  planned: number;
  /**
   * In the org, and sent: unchanged since the run, or changed since and
   * included. The org may still refuse some, and the removal keep some for
   * records that stay, which only a real removal finds out.
   */
  toDelete: number;
  /**
   * Found deleted, as a read of the recycle bin finds them: gone, as the
   * removal counts them, and never counted as records a restore brings back.
   * A record emptied from the bin reads deleted as one still in it, and a
   * child deleted on its own before its parent stays in the bin for good once
   * the parent goes too: no read tells either from one that would come back.
   */
  alreadyGone: number;
  /**
   * In the org and modified since the run ended, by the org's clock, by
   * anyone; or an article version whose article holds a version the run did
   * not write, which deleting the article would take with it.
   */
  changedSince: number;
  /** Of those, the ones the removal keeps: all of them, unless changed records are included. */
  keptChanged: number;
  /** Who last modified the records changed since, by user Id: how many each. */
  changedBy: Record<string, number>;
  /** In the org, of an object the user the removal runs as may not delete: left, never sent. */
  undeletable: number;
  /**
   * Found neither in the org nor in its recycle bin: out of the sight of the
   * user the removal runs as, or deleted for good. Never counted as removed.
   */
  notVisible: number;
  /** Of an object the removal could not read at all: none of them would be sent. */
  unread: number;
  /**
   * Of `planned`, the records the platform copied as the run wrote — the
   * lines of a quote the run synced — that the run's id map does not hold
   * (`ForgeUndoObjectResult.platformCopies`). Absent when none.
   */
  platformCopies?: number;
  /**
   * Read when the preview was asked what hangs from the records
   * (`RunRemovalOptions.previewHeld`): of the records it would send, those a
   * record staying in the org hangs from, which a removal keeps
   * (`ForgeUndoObjectResult.keptDependents`), counted here and no longer in
   * `toDelete`. Absent otherwise.
   */
  keptDependents?: number;
  /** The objects of the records that hold them, by API name, as a removal names them. */
  heldBy?: string[];
  /**
   * Of `keptDependents`, those held by nothing but records the target's
   * automation likely made for the run, which a sweep takes first
   * (`ForgeUndoObjectResult.heldByAutomation`). Absent when none.
   */
  heldByAutomation?: number;
  /**
   * Read when the preview was asked what hangs from the records: what the
   * org would take along with the records it would send that the run did not
   * write, come with them as it wrote (`ForgeUndoObjectResult.cameAlong`).
   * Absent when none would go so.
   */
  cameAlong?: { count: number; objects: string[] };
  /** Why records stay, or could not be told, in the org's words where it gave them. */
  reasons: string[];
}

/** What a removal of a run's records would do, read before its first write, nothing written. */
export interface RunRemovalPreview {
  /** Per object, in the order the removal would take them: children before their parents. */
  objects: RemovalPreviewObject[];
  /** The names of the users `changedBy` counts, by user Id, where the org said them. */
  userNames: Record<string, string>;
}

/**
 * Another part of the run a removal takes one part of, as that part's own
 * removal would read it: its records left in the org, its span, and what its
 * earlier removals stamped.
 *
 * Removed part by part from the panel, a clone killed while it wrote an
 * opportunity outside its graph and then resumed lost that opportunity: the
 * resumed part's removal deleted the contact role it had written under it,
 * the org dated the opportunity anew as modified by the removal's user, and
 * the killed part's removal kept it as changed since the run. Its removal
 * spans stay out of it: what the removal's user created meanwhile is read as
 * a removal's doing, and a record a colleague hung under the part's records
 * would go with them.
 */
export interface RunPartAlongside {
  /** Its records left in the org, children before their parents. */
  plan: readonly ForgeRunObjectRecords[] | RunRecords;
  /** Its span, as {@link RunRemovalOptions} takes a run's. */
  span: Pick<
    RunRemovalOptions,
    'runStartedAt' | 'runEndedAt' | 'runDurationMs' | 'runRecordedAt' | 'endedByItsWrites'
  >;
  /** What its earlier removals stamped: see {@link RunRemovalOptions.removalStamps}. */
  removalStamps?: Readonly<Record<string, string>>;
  /** The run's parts after it: see {@link RunRemovalOptions.laterParts}. */
  laterParts?: readonly RunLaterPart[];
}

/**
 * A later part of the run — the part a resume took the run up with — as a
 * removal of an earlier part reads what it wrote beyond the records it
 * created: the lookups the earlier part's records owed, filled in, a status
 * given back (`wrote`), and the records it linked to (`linked`).
 *
 * Cut right after its opportunity and taken up, a clone was removed part by
 * part, live: the resume had filled in the opportunity's synced quote, and
 * given the contact role the platform wrote with it the source's fields. The
 * cut part's removal, read against its own end, kept the opportunity as
 * changed since the run, and the contact for a role it took for the target's
 * automation's. What the run wrote is no change since it, and a record it
 * linked to that the org made as the run wrote goes with the record it hangs
 * from: last modified no later than the end of the part that wrote it, as
 * that part's own records are read. Changed after it, by anyone, it stays.
 */
export interface RunLaterPart {
  /**
   * Its span, as {@link RunRemovalOptions} takes a run's. Dated by this
   * machine's clock alone, it ends {@link CLOCK_LEEWAY_MS} after the part was
   * recorded, whatever `endedByItsWrites` says: the only date the org gave
   * what it wrote to an earlier part's record, or to one it linked to, is
   * that record's own, which is what is read against this end.
   */
  span: Pick<RunRemovalOptions, 'runStartedAt' | 'runEndedAt' | 'runDurationMs' | 'runRecordedAt'>;
  /** Records of earlier parts it wrote to, by id. */
  wrote?: readonly string[];
  /**
   * Records it linked to, by id: one created once the run began, which hangs
   * from a record of the plan, goes with it.
   */
  linked?: readonly string[];
}

/**
 * The span of the latest of `parts` that names each record in `which`, by
 * record key, on the org's clock: a part whose end cannot be read on it
 * names none.
 */
function laterSpansOf(
  parts: readonly RunLaterPart[] | undefined,
  which: 'wrote' | 'linked',
  orgAheadMs: number,
): Map<string, { start: number; end: number }> {
  const spans = new Map<string, { start: number; end: number }>();
  for (const part of parts ?? []) {
    const span = runSpan(part.span, [], orgAheadMs);
    if (!Number.isFinite(span.end)) continue;
    for (const id of part[which] ?? []) {
      const key = recordKey(id);
      if (!(span.end <= (spans.get(key)?.end ?? Number.NEGATIVE_INFINITY))) spans.set(key, span);
    }
  }
  return spans;
}

/**
 * The keys of the records of `parts` and of `more`, as one: see
 * {@link DependentsContext.otherPartRecords}.
 */
function otherPartRecordsOf(
  parts: readonly RunPartAlongside[] = [],
  more: readonly ForgeRunObjectRecords[] = [],
): RecordKeys | undefined {
  if (parts.length === 0 && more.length === 0) return undefined;
  const records = [
    ...parts.map(({ plan }) => (isRunRecords(plan) ? plan : runRecordsOf(plan))),
    runRecordsOf(more),
  ];
  return { has: (key) => records.some((part) => part.has(key)) };
}

/** The objects the records of `parts` and of `more` are of. */
function otherPartObjectsOf(
  parts: readonly RunPartAlongside[] = [],
  more: readonly ForgeRunObjectRecords[] = [],
): Set<string> {
  return new Set(
    [...parts.map(({ plan }) => (isRunRecords(plan) ? plan.objects : plan)), more]
      .flat()
      .map((object) => object.objectApiName),
  );
}

/** {@link laterSpansOf}, each record's end alone. */
function laterEndsOf(
  parts: readonly RunLaterPart[] | undefined,
  orgAheadMs: number,
): Map<string, number> {
  return new Map([...laterSpansOf(parts, 'wrote', orgAheadMs)].map(([key, { end }]) => [key, end]));
}

/** An object of a run whose records the user a removal runs as may not delete, and how many it holds. */
export interface UndeletableObject {
  objectApiName: string;
  records: number;
}

/** Why the records of an object the user may not delete stay, as its result says it. */
export function undeletableReason(objectApiName: string, records: number): string {
  return (
    `The user SandForge connects as may not delete ${objectApiName} records in this org: ` +
    `the ${records} record(s) of the run stay, and were not sent.`
  );
}

/**
 * What an object's result says of its records found neither in the org nor
 * in its recycle bin.
 *
 * @param binError - Why the recycle bin could not be read, when it could not.
 */
function notVisibleNoteOf(count: number, binError: string | undefined): string {
  return (
    `Not visible: ${count} record(s) found neither in the org nor in its ` +
    "recycle bin, as the user the removal runs as sees them — out of that user's sight, " +
    'or deleted for good — are not counted as removed' +
    (binError ? ` (the recycle bin could not be read: ${binError})` : '.')
  );
}

/**
 * `objects`, the results of a removal that was stopped, with what the stop
 * kept it from reaching: on each object it reached, the records it had not
 * settled — deleted, found gone, kept or refused — and, after them, each
 * object of `plan` it never reached, with every record of it. Stopped part
 * way, a removal named only the objects it had reached: its output and its
 * audit entry listed the contacts it deleted, not the account it never got
 * to, which only the next removal's plan named.
 *
 * @param plan - The objects the removal set out to take, in its order.
 * @param copiesOf - How many of an object's records are the platform's copies.
 */
function withNotReached(
  objects: ForgeUndoObjectResult[],
  plan: ReadonlyArray<{ readonly objectApiName: string; readonly count: number }>,
  copiesOf: (objectApiName: string) => number,
): ForgeUndoObjectResult[] {
  for (const object of objects) {
    const settled =
      object.deleted +
      object.alreadyGone +
      object.keptChanged +
      object.keptDependents +
      object.refused +
      (object.notVisible ?? 0);
    if (object.planned > settled) object.notReached = object.planned - settled;
  }
  const named = new Set(objects.map((object) => object.objectApiName));
  for (const { objectApiName, count } of plan) {
    if (count === 0 || named.has(objectApiName)) continue;
    named.add(objectApiName);
    objects.push({
      ...new ObjectRemoval(objectApiName, count, copiesOf(objectApiName)).result,
      notReached: count,
    });
  }
  return objects;
}

/** What a removal did, object by object. */
export interface RunRemovalOutcome {
  /**
   * The objects of the run whose records the user the removal runs as may
   * not delete, as their describes say. Absent when there is none.
   */
  undeletable?: UndeletableObject[];
  /**
   * Set when the removal stopped before its first write, asked about
   * {@link undeletable} (`RunRemovalOptions.onUndeletable`): nothing was removed.
   */
  stoppedForUndeletable?: true;
  /**
   * Per object, in the order they were removed. A removal stopped before it
   * was through names every object of the plan, the ones it never reached
   * after the others, each with the records it did not reach
   * (`ForgeUndoObjectResult.notReached`); one stopped for
   * {@link stoppedForUndeletable} names none.
   */
  objects: ForgeUndoObjectResult[];
  /** Whether the removal was stopped before it was through. */
  cancelled: boolean;
  /**
   * The run's records the removal deleted, or found gone, by their ids as the
   * plan names them: what a caller that keeps the run's records — a Frozen
   * load's mapping — no longer has in the org. Empty when the records were
   * handed over a page at a time (`RunRecords`): see `left`.
   */
  gone: string[];
  /**
   * The run's records the removal left in the org — kept, refused, not
   * visible, or not reached — per object a page at a time, read again from
   * the records it was handed: what the next removal sets out to take.
   */
  left(): AsyncIterable<ForgeRunObjectRecords>;
  /**
   * What this removal left on records of the run it did not delete — what it
   * wrote to them, and what the org wrote in answer to its deletes — by record
   * id: the `LastModifiedDate` the org left on each, for a later removal to
   * pass back as `removalStamps`. Only records unchanged since the run when it
   * began, and last modified by its user since it started, are named: a change
   * someone made stays a change.
   */
  stamps: Record<string, string>;
  /**
   * When this removal ran, by the org's clock, and as which user, for a later
   * removal to pass back in `removalSpans`. Absent when it wrote nothing, and
   * when the org did not tell its clock or its user.
   */
  span?: ForgeRemovalSpan;
  /**
   * What this removal left on the records of the run's other parts, one map
   * per part in the order `RunRemovalOptions.otherParts` gives them, as
   * {@link stamps} says it of the part removed: only records unchanged since
   * their own part when it began, and last modified by its user since it
   * started. Absent when no other part was given, or when it wrote nothing.
   */
  otherPartStamps?: Array<Record<string, string>>;
  /**
   * What the removal would do, set when it was asked for that alone
   * (`RunRemovalOptions.previewOnly`) and read through: it wrote nothing,
   * `objects` is empty and `left` gives back every record it was handed.
   */
  preview?: RunRemovalPreview;
}

/** What a removal that took none of the run's records hands on: a sweep alone. */
export const NOTHING_REMOVED: RunRemovalOutcome = {
  objects: [],
  cancelled: false,
  gone: [],
  stamps: {},
  left: async function* () {},
};

/** A record by its first fifteen characters: the same record, whichever length its id is written in. */
function recordKey(id: string): string {
  return id.slice(0, 15);
}

/** Whether a query was refused for a column its object does not have. */
function isMissingColumn(err: unknown): boolean {
  const code = (err as { errorCode?: unknown } | null)?.errorCode;
  return code === 'INVALID_FIELD' || /no such column/i.test(extractErrorMessage(err));
}

/**
 * The first of {@link DEPENDENT_DATE_COLUMNS} after `tried` that does not ask
 * for the column the org said the object lacks: a file's link keeps no
 * `CreatedDate`, and is not asked it twice. The next one when the org named
 * none.
 */
function datesWithout(err: unknown, tried: number): number {
  const missing = /no such column '(\w+)'/i.exec(extractErrorMessage(err))?.[1];
  const next = DEPENDENT_DATE_COLUMNS.findIndex(
    (dates, at) => at > tried && (missing === undefined || !dates.includes(missing)),
  );
  return next === -1 ? DEPENDENT_DATE_COLUMNS.length : next;
}

/** A date the org wrote, in epoch milliseconds; NaN when there is none to read. */
function epochOf(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : Number.NaN;
}

/** What the org holds of one object's records now, before anything is deleted. */
interface ObjectSnapshot {
  /**
   * When each record was last modified, by its place among the object's
   * records; NaN for one not found, or whose date could not be read.
   */
  modified: PlaceDates;
  /** Keys of the records the read did not find: every other one is still there. */
  missing: Set<string>;
  /**
   * The column those dates were read from: `LastModifiedDate`, which the org
   * keeps with who modified the record, or `SystemModstamp`. Absent when the
   * object could not be read.
   */
  modifiedColumn?: string;
  /** The earliest `CreatedDate` among them; NaN when none could be read. */
  firstCreated: number;
  /** The latest `CreatedDate` among them; NaN when none could be read. */
  lastCreated: number;
  /** Why the object could not be read, when it could not. */
  error?: string;
  /**
   * Keys of the records the read did not find that the org's recycle bin
   * holds: deleted. One found nowhere is out of the session's sight, or gone
   * for good.
   */
  binned: Set<string>;
  /** Why the recycle bin could not be read, when it could not. */
  binError?: string;
}

/** A snapshot of an object nothing has been read of yet. */
function emptySnapshot(): ObjectSnapshot {
  return {
    modified: new PlaceDates(),
    missing: new Set(),
    firstCreated: Number.NaN,
    lastCreated: Number.NaN,
    binned: new Set(),
  };
}

/** Why the org refused to delete one record. */
interface Refusal {
  /** In the org's words. */
  reason: string;
  /** Refused for records still hanging from it: tried again while a round of tries takes something more. */
  dependency: boolean;
  /**
   * Whether the org answered a delete of it. A record of an object the
   * removal could not read is counted refused unsent, with why: never read,
   * it is never sent, nor taken for gone by a read that no longer finds it.
   */
  sent: boolean;
  /**
   * Refused for a Salesforce limit the target's automation hit: sent on its
   * own already, kept from smaller calls because records of its object sent
   * on their own were refused too, or by the removal's allowance. The second
   * try does not send it again, which would be refused the same; the next
   * removal of the run does.
   */
  limit?: true;
}

/** Where a removal stands with one object's records. */
class ObjectRemoval {
  readonly result: ForgeUndoObjectResult;
  /** Why the object as a whole could not be read or checked. */
  private readonly notes: string[] = [];
  /** Records the org refused, by id. */
  readonly refused = new Map<string, Refusal>();
  /**
   * The object's records refused unsent because the object could not be read
   * at all, and why: every one of them, counted without their ids.
   */
  unread?: { reason: string; count: number };
  /** Records kept because records that stay depend on them. */
  held: string[] = [];
  /**
   * The records deleted, or found gone, at the object's turn, by their place
   * among its records: a bit each, whatever the object holds.
   */
  readonly goneAt = new PlaceMarks();
  /**
   * Keys of the records deleted, or found gone, once their turn was over —
   * sent again, or taken along by a parent: a few, of those refused or held.
   */
  readonly goneLater = new Set<string>();
  /** Keys of the records among those that this removal deleted. */
  readonly deletedLater = new Set<string>();
  /** Records found neither in the org nor in its recycle bin: never taken for gone. */
  notVisible = 0;
  /** What is said of the records not visible, once the object's turn is over. */
  notVisibleNote?: string;
  /**
   * The records the org had refused that the second try took up, by id: sent
   * again, or kept for a record that stays.
   */
  readonly secondTry = new Set<string>();
  /**
   * The files attached to the records deleted that the run did not create, by
   * their document's key: each named by its title, or its id.
   */
  readonly filesLeft = new Map<string, string>();
  /**
   * Of the records held, by their key, those held by nothing but records the
   * target's automation likely made for the run, with those records' objects:
   * what a sweep takes first. Read against `held` as the object settles.
   */
  readonly automationHeld = new Map<string, ReadonlySet<string>>();
  /**
   * Of `automationHeld`, by key, those one of whose holders was created after
   * the run's last write: see {@link ForgeUndoObjectResult.heldByAutomationAfterRun}.
   */
  readonly automationHeldAfter = new Set<string>();
  /**
   * Of `automationHeld`, by key, those every holder of which hangs from them
   * through a relationship the org deletes along: see
   * {@link ForgeUndoObjectResult.heldByAutomationAlong}.
   */
  readonly automationHeldAlong = new Set<string>();
  /**
   * The records not the run's that the org took along with the ones deleted,
   * as the request included what was added or changed since the run: each by
   * its key, with its object. See {@link ForgeUndoObjectResult.tookAlong}.
   */
  readonly tookAlong = new Map<string, string>();
  /**
   * The records the run did not write that came with its records and that
   * the org took along with the ones deleted: each by its key, with its
   * object. See {@link ForgeUndoObjectResult.cameAlong}.
   */
  readonly cameAlong = new Map<string, string>();
  /**
   * What is said of the calls a limit of the target's automation refused,
   * once the object's turn is over (`deleteLimitNotes`): placed before the
   * org's refusals.
   */
  limitNotes: string[] = [];
  /**
   * The records the org could not lock, sent again (`DeleteOutcome.lockResends`),
   * by key, with what their last answer was: what the object's result says of
   * them (`lockResendNote`).
   */
  readonly lockResent = new Map<string, DeleteOutcome['kind']>();

  /**
   * @param copies - Of `planned`, the records the platform copied as the run
   *   wrote ({@link ForgeUndoObjectResult.platformCopies}).
   */
  constructor(objectApiName: string, planned: number, copies = 0) {
    this.result = {
      objectApiName,
      planned,
      deleted: 0,
      alreadyGone: 0,
      keptChanged: 0,
      keptDependents: 0,
      refused: 0,
      heldBy: [],
      ...(copies > 0 ? { platformCopies: copies } : {}),
      unchecked: [],
      reasons: [],
    };
  }

  /** Note why the object as a whole could not be read or checked. */
  note(reason: string): void {
    if (!this.notes.includes(reason)) this.notes.push(reason);
  }

  /** Whether the removal deleted the record `id`, at `place` among the object's records, or found it gone. */
  isGone(id: string, place: number): boolean {
    return this.goneAt.has(place) || this.goneLater.has(recordKey(id));
  }

  /**
   * The records worth another try while a round of tries takes something
   * more: the ones refused for a dependency and the ones held by one. They
   * keep their count until they are settled again, so a removal stopped
   * meanwhile still accounts for them.
   */
  waiting(): string[] {
    return [
      ...[...this.refused].filter(([, refusal]) => refusal.dependency).map(([id]) => id),
      ...this.held,
    ];
  }

  /** The records whose delete the org refused, whatever it refused it with, by id. */
  refusedSent(): string[] {
    return [...this.refused].filter(([, refusal]) => refusal.sent).map(([id]) => id);
  }

  /**
   * Of {@link refusedSent}, those the second try sends once more: all but the
   * ones refused for a limit, which went on their own already or were kept
   * from smaller calls, and would only be refused again.
   */
  refusedToSendAgain(): string[] {
    return [...this.refused]
      .filter(([, refusal]) => refusal.sent && refusal.limit !== true)
      .map(([id]) => id);
  }

  /**
   * What became of the records the second try took up, said once: deleted,
   * already gone, kept for records that stay, or refused again — the org's
   * words for those follow, as for any refusal.
   */
  private secondTryNote(): string[] {
    if (this.secondTry.size === 0) return [];
    let deleted = 0;
    let gone = 0;
    let held = 0;
    let refused = 0;
    for (const id of this.secondTry) {
      const key = recordKey(id);
      if (this.deletedLater.has(key)) deleted++;
      else if (this.goneLater.has(key)) gone++;
      else if (this.refused.has(id)) refused++;
      else held++;
    }
    const parts = [
      deleted > 0 ? `${deleted} deleted` : '',
      gone > 0 ? `${gone} already gone` : '',
      held > 0 ? `${held} kept for records that stay` : '',
      refused > 0 ? `${refused} refused again` : '',
    ].filter(Boolean);
    return [`Refused at first, sent again once the rest had gone: ${parts.join(', ')}.`];
  }

  /** The object's result, its counts and reasons as they stand. */
  settle(): ForgeUndoObjectResult {
    this.result.keptDependents = this.held.length;
    this.result.refused = this.refused.size + (this.unread?.count ?? 0);
    if (this.notVisible > 0) this.result.notVisible = this.notVisible;
    if (this.held.length === 0) this.result.heldBy = [];
    const byAutomation = this.held.flatMap((id) => {
      const holders = this.automationHeld.get(recordKey(id));
      return holders ? [holders] : [];
    });
    const after = this.held.filter((id) => {
      const key = recordKey(id);
      return this.automationHeld.has(key) && this.automationHeldAfter.has(key);
    }).length;
    const along = this.held.filter((id) => {
      const key = recordKey(id);
      return this.automationHeld.has(key) && this.automationHeldAlong.has(key);
    }).length;
    if (byAutomation.length > 0) {
      this.result.heldByAutomation = byAutomation.length;
      if (after > 0) this.result.heldByAutomationAfterRun = after;
      else delete this.result.heldByAutomationAfterRun;
      if (along > 0) this.result.heldByAutomationAlong = along;
      else delete this.result.heldByAutomationAlong;
      this.result.automationHolders = [...new Set(byAutomation.flatMap((holders) => [...holders]))];
    } else {
      delete this.result.heldByAutomation;
      delete this.result.heldByAutomationAfterRun;
      delete this.result.heldByAutomationAlong;
      delete this.result.automationHolders;
    }
    const reasons = [
      ...(this.notVisibleNote ? [this.notVisibleNote] : []),
      ...this.notes,
      ...this.limitNotes,
      ...lockResendNote(this.lockResent.values()),
      ...this.secondTryNote(),
      ...(this.unread ? [this.unread.reason] : []),
      ...[...this.refused.values()].map((r) => r.reason),
    ];
    this.result.reasons = [...new Set(reasons)].slice(0, REASON_LIMIT);
    if (this.filesLeft.size > 0) {
      this.result.filesLeft = {
        count: this.filesLeft.size,
        names: [...this.filesLeft.values()].slice(0, FILE_NAME_LIMIT),
      };
    }
    if (this.tookAlong.size > 0) {
      this.result.tookAlong = {
        count: this.tookAlong.size,
        objects: [...new Set(this.tookAlong.values())],
      };
    }
    if (this.cameAlong.size > 0) {
      this.result.cameAlong = {
        count: this.cameAlong.size,
        objects: [...new Set(this.cameAlong.values())],
      };
    }
    return this.result;
  }
}

/**
 * Remove from the org the records a Forge run created, each object after the
 * objects of the run whose records point at it, and say what became of each.
 *
 * Nothing is deleted before every object has been read, by the sweep it is
 * handed (`RunRemovalOptions.sweep`) no more than by the removal: deleting a
 * child can stamp its parent as modified (a roll-up recalculated), and a
 * parent read afterwards would look changed since the run. A record no longer
 * in the org is counted as already gone; one modified after the run ended is
 * kept unless `includeChanged` says otherwise. What the removal itself and its
 * sweep stamp — a refused delete, a child deleted under a record — is never
 * read as a change, because that reading is the one taken before the first
 * delete; and what it left on a record it did not delete — a status given
 * back, an amount its deleted children changed — a later removal is told
 * (`RunRemovalOutcome.stamps`), with when it ran (`RunRemovalOutcome.span`),
 * whether it ended, was stopped, or was cancelled.
 *
 * An order past Draft is set to Draft before anything is deleted, and one the
 * removal leaves in the org — kept, refused, or not reached when it was
 * cancelled — gets its status back as it ends. A contract past Draft is
 * deleted as it stands (`DELETED_PAST_DRAFT`).
 *
 * The objects go in the order their records can go, not the reverse of the
 * one they were written in. A clone writes its root first and its optional
 * parents after, so reversed, the root opportunity came last: its account
 * was refused ("some opportunities of this account were closed won"), its
 * price book too ("associated with the following opportunities"), and the
 * removal ended partial with both left behind. Once the rest of the plan has
 * gone, every record the org refused is sent once more, whatever it refused
 * it with, with the records held back for one of them; and what it still
 * refuses for records hanging from it — a cycle no order breaks — is tried
 * again while a round of tries takes something more.
 *
 * A record is also kept while records that stay in the org would be deleted
 * along with it — the org deletes what cascades from a record, and those are
 * not all the run's to take: one that was in the org before the run, one of
 * the run's own records kept here or refused by the org, and one added or
 * changed since the run unless `includeChanged` asks for what changed since
 * the run as well. What was created during the run and never touched since —
 * the contact of a person account, a task a flow opened on insert — came with
 * the run and goes with it.
 *
 * And a record is kept while one that stays would have the org refuse its
 * delete, whoever made that one: a record pointing at it through a lookup the
 * org restricts the delete by — an order's item at the price it uses — a
 * custom price at its product's standard price, an active price at its
 * selling model option, and an order or a contract past Draft that stays at
 * the rows the platform locks under it (`LOCKED_PAST_DRAFT`). Run for real, a
 * removal kept two activated orders for the files the org had attached to
 * them, sent the deletes of their items and actions all the same, then of the
 * prices and options behind those: each refused, and the org's refusals were
 * all it said of why the removal ended partial.
 *
 * The rest are deleted {@link RECORDS_PER_CALL} at a time. A call the target's
 * automation refuses for a Salesforce limit — the 116 records of a custom
 * object refused whole by a trigger that ran a query per record, "Too many
 * SOQL queries: 101" — goes again over REST, a record on its own first, then
 * in calls half as large, down to one record; the size the limit called for
 * holds for the object's next calls, within the smaller calls the removal
 * allows itself (`RunRemovalOptions.splitting`). A record the org
 * refuses is counted with its reason, and the rest go on; so does the next
 * object when one cannot be read at all. The files attached to a record
 * deleted, which the run did not create, stay in the org once their record is
 * gone: each object's result names them, and the removal leaves them there.
 *
 * Handed a page at a time (`RunRecords`), the records are read from where
 * they are kept each time the removal goes through them — the snapshot, the
 * records changed since, each object's turn, what it leaves — and it holds a
 * page of ids at a time, a date and a mark for each record by its place, and
 * the records it could not take.
 *
 * @param org - The run's target org.
 * @param plan - The run's records, children before their parents as far as
 *   the run knows — the reverse of the order it wrote them: in memory, or
 *   read a page at a time.
 * @param options - The run's time span, what earlier removals of it wrote,
 *   whether changed records go, the stop signal.
 */
export async function removeRunRecords(
  org: RemovalOrg,
  plan: readonly ForgeRunObjectRecords[] | RunRecords,
  options: RunRemovalOptions,
): Promise<RunRemovalOutcome> {
  /** The run's records as they were handed over: what is said gone, or left. */
  const handed = isRunRecords(plan) ? plan : runRecordsOf(plan);
  /**
   * The records the removal takes: those handed over, and the platform's
   * copies of them once they are read ({@link withCopies}).
   */
  let records = handed;
  let total = records.objects.reduce((sum, object) => sum + object.count, 0);
  /** How many of each object's records are the platform's copies. */
  const copiesCount = new Map<string, number>();
  const copiesOf = (objectApiName: string): number => copiesCount.get(objectApiName) ?? 0;
  const stopped = (): boolean => options.signal?.aborted === true;
  // The sizes the deletes go at and the smaller calls a limit may cost,
  // shared by every object's pages, the second try and the sweep: a size a
  // limit taught one call holds for the rest.
  const splitting = options.splitting ?? limitSplitting();
  /** Every record handed over, left where it is: a removal stopped before it wrote. */
  const untouched = (): RunRemovalOutcome => ({
    objects: withNotReached([], records.objects, copiesOf),
    cancelled: true,
    gone: [],
    stamps: {},
    left: () => everyRecordOf(handed),
  });

  const snapshots = new Map<string, ObjectSnapshot>();
  /** The object of each key prefix of the records handed over, from the first id of each. */
  const objectOfPrefix = new Map<string, string>();
  for (const { objectApiName } of records.objects) {
    const snapshot = emptySnapshot();
    snapshots.set(objectApiName, snapshot);
    let at = 0;
    for await (const page of records.pages(objectApiName)) {
      if (stopped()) return untouched();
      const first = page[0];
      if (first !== undefined && !objectOfPrefix.has(first.slice(0, 3))) {
        objectOfPrefix.set(first.slice(0, 3), objectApiName);
      }
      const place = at;
      at += page.length;
      if (snapshot.error !== undefined) continue;
      const missing = await readSnapshotPage(org, objectApiName, page, place, snapshot);
      if (snapshot.error !== undefined || missing.length === 0) continue;
      if (stopped()) return untouched();
      const bin = await recycleBinOf(org, objectApiName, missing);
      if ('error' in bin) snapshot.binError = bin.error;
      else for (const key of bin.deleted) snapshot.binned.add(key);
    }
  }

  // Each object described once: the order and the dependents check read it.
  const describes = new Map<string, Promise<unknown>>();
  /** Whether the removal has asked the org to write: until then it stamped nothing. */
  let wrote = false;
  const bulkDestroy = org.bulkDestroy?.bind(org);
  const counted: RemovalOrg = {
    query: (soql) => org.query(soql),
    destroy: (objectApiName, ids) => {
      wrote = true;
      return org.destroy(objectApiName, ids);
    },
    ...(bulkDestroy
      ? {
          // The removal's stop aborts a job the org does not have yet.
          bulkDestroy: (objectApiName: string, ids: readonly string[]) => {
            wrote = true;
            return bulkDestroy(objectApiName, ids, options.signal);
          },
        }
      : {}),
    update: (objectApiName, records) => {
      wrote = true;
      return org.update(objectApiName, records);
    },
    serverTime: () => org.serverTime(),
    userId: () => org.userId(),
    queryDeleted: (soql) => org.queryDeleted(soql),
    describeGlobal: () => org.describeGlobal(),
    describe: (objectApiName) => {
      let described = describes.get(objectApiName);
      if (!described) {
        described = org.describe(objectApiName);
        describes.set(objectApiName, described);
      }
      return described;
    },
  };
  // A Knowledge article's version is deleted by deleting its article, which
  // its describe and its own delete both refuse: see `articleRemoval`.
  const session = withArticleRemoval(counted, { includeChanged: options.includeChanged });
  let order = await removalOrder(session, records.objects);
  // Whether the user may delete each object's records, from the describes the
  // order read, before anything is written: a profile without Delete on
  // Account had the run's contacts deleted, then every account refused.
  const undeletable = await undeletableOf(
    session,
    order,
    (objectApiName, count) => count - (snapshots.get(objectApiName)?.missing.size ?? 0),
  );
  const undeletableNames = new Set(undeletable.map((object) => object.objectApiName));
  // A preview asks nothing: it says which objects stay.
  if (undeletable.length > 0 && options.onUndeletable && options.previewOnly !== true) {
    if (stopped()) return untouched();
    if (!(await options.onUndeletable(undeletable))) {
      return { ...untouched(), objects: [], undeletable, stoppedForUndeletable: true };
    }
  }
  // Read before the removal's first write: what the org creates from then on,
  // as the user the removal runs as, is the removal's doing, dated by the same
  // clock as the run. A preview writes nothing, and needs the clock alone.
  const [clock, removalUser] = await Promise.all([
    removalClockOf(session),
    options.previewOnly === true ? undefined : removalUserOf(session),
  ]);

  // A record in the org is changed when it was modified after the run ended,
  // both by the org's clock — or after what an earlier removal of the run
  // wrote to it, which was that removal's doing.
  const { start: runStart, end: runEnd } = runSpan(options, snapshots.values(), clock.aheadMs);
  // The lines the platform copied as the run wrote under a quote it synced,
  // read before the first write — once the run's quote lines go, the platform
  // deletes the line items they are paired with, and its copies lose what
  // tells them — and taken with the run's own, at their object's turn: left,
  // they held the quote, its opportunity, account, products and price book,
  // and deleted by hand they had the quote's totals recalculated, read by the
  // next removal as a change since the run. Read with the rest, before the
  // first write, the quote they restamp is no change. A preview names them.
  // Of a run cut and taken up, the opportunity may be another part's.
  if (stopped()) return untouched();
  const otherPartRecords = otherPartRecordsOf(options.otherParts, options.otherPartRecords);
  const otherPartObjects = otherPartObjectsOf(options.otherParts, options.otherPartRecords);
  const copies = await platformCopiesOf(session, records, {
    start: runStart,
    end: runEnd,
    ...(options.runUserId ? { user: recordKey(options.runUserId) } : {}),
    ...(otherPartRecords
      ? {
          otherParts: {
            has: (key: string) => otherPartRecords.has(key),
            objects: otherPartObjects,
          },
        }
      : {}),
    undeletable: undeletableNames,
    snapshots,
  });
  // The sets the target's duplicate rules made of the run's records, read
  // with the copies and taken as they are: left, they stayed empty. Told only
  // by the run's user, and never by a rewind, whose plan reads what it deletes.
  if (options.runUserId && options.alongAccepted !== true) {
    const sets = await duplicateSetsOf(session, {
      has: (key) => records.has(key),
      start: runStart,
      end: runEnd,
      user: options.runUserId,
    });
    if (
      sets.length > 0 &&
      !records.objects.some((object) => object.objectApiName === DUPLICATE_SET_OBJECT) &&
      (await deletable(session, DUPLICATE_SET_OBJECT))
    ) {
      copies.push({ objectApiName: DUPLICATE_SET_OBJECT, copies: sets });
    }
  }
  if (copies.length > 0) {
    records = await withCopies(records, copies, snapshots, objectOfPrefix);
    for (const { objectApiName, copies: of } of copies) copiesCount.set(objectApiName, of.length);
    total = records.objects.reduce((sum, object) => sum + object.count, 0);
    // Described once already, but for an object only its copies bring: the
    // copies go before the prices and products they point at.
    order = await removalOrder(session, records.objects);
  }
  const stampedBefore = new Map(
    Object.entries(options.removalStamps ?? {}).map(([id, date]) => [recordKey(id), epochOf(date)]),
  );
  // What a later part of the run wrote to a record of this one is the run's doing.
  const writtenLater = laterEndsOf(options.laterParts, clock.aheadMs);
  const changed = new Set<string>();
  for (const { objectApiName } of records.objects) {
    const snapshot = snapshots.get(objectApiName);
    if (!snapshot || snapshot.error !== undefined) continue;
    let place = 0;
    for await (const page of records.pages(objectApiName)) {
      for (const id of page) {
        const modified = snapshot.modified.at(place++);
        const key = recordKey(id);
        if (snapshot.missing.has(key)) continue;
        // A date that cannot be read cannot show the record was left alone.
        const unchanged =
          modified <= runEnd ||
          modified <= (stampedBefore.get(key) ?? Number.NaN) ||
          modified <= (writtenLater.get(key) ?? Number.NaN);
        if (!unchanged) changed.add(key);
      }
    }
  }
  // The preview ends here, every record read and nothing written: what the
  // removal goes on to read — the run's other parts, what hangs from each
  // record — is read for its writes.
  if (options.previewOnly === true) {
    if (stopped()) return untouched();
    /** The run's records the preview would not send: they stay, and hold their parents. */
    const notSent = new Set<string>();
    const preview = await previewOf(session, records, order, {
      snapshots,
      changed,
      undeletable: undeletableNames,
      includeChanged: options.includeChanged,
      stopped,
      copiesOf,
      ...(options.previewHeld === true
        ? {
            held: {
              notSent,
              // As the removal's own check, but that nothing has gone yet: a
              // record of the run stays when the preview would not send it.
              check: new DependentsCheck(session, {
                runRecords: records,
                reached: { has: () => false },
                stays: (key) => notSent.has(key),
                runStart,
                runEnd,
                removalStart: clock.start,
                removalUser: undefined,
                earlierRemovals: (options.removalSpans ?? []).map((span) => ({
                  start: epochOf(span.first),
                  end: epochOf(span.last),
                  user: recordKey(span.userId),
                })),
                includeChanged: options.includeChanged,
                previewing: true,
                ...(options.goesWithParent ? { goesWithParent: options.goesWithParent } : {}),
                ...(options.goesWithParentReadBelow ? { goesWithParentReadBelow: true } : {}),
                ...(options.alongAccepted ? { alongAccepted: options.alongAccepted } : {}),
                ...(options.runUserId ? { runUser: recordKey(options.runUserId) } : {}),
                ...(options.laterParts
                  ? { linkedLater: laterSpansOf(options.laterParts, 'linked', clock.aheadMs) }
                  : {}),
                ...(otherPartRecords ? { otherPartRecords, otherPartObjects } : {}),
              }),
            },
          }
        : {}),
    });
    if (!preview) return untouched();
    return {
      ...(undeletable.length > 0 ? { undeletable } : {}),
      objects: [],
      cancelled: false,
      gone: [],
      stamps: {},
      left: () => everyRecordOf(handed),
      preview,
    };
  }
  // The run's other parts are read before the first write too, as their own
  // removals would read them: what this one stamps of their records is said
  // back only of those that had not changed since their part.
  const otherParts = await unchangedOfOtherParts(
    session,
    options.otherParts ?? [],
    clock.aheadMs,
    stopped,
  );
  if (!otherParts) return untouched();

  /** The objects the removal has been through, or is going through. */
  const reachedObjects = new Set<string>();
  /** Records of the run whose object the removal has been through. */
  const reached: RecordKeys = {
    has: (key) => records.has(key) && reachedObjects.has(objectOfPrefix.get(key.slice(0, 3)) ?? ''),
  };
  const dependents = new DependentsCheck(session, {
    runRecords: records,
    reached,
    stays: (key) => changed.has(key) && !options.includeChanged,
    runStart,
    runEnd,
    removalStart: clock.start,
    removalUser,
    earlierRemovals: (options.removalSpans ?? []).map((span) => ({
      start: epochOf(span.first),
      end: epochOf(span.last),
      user: recordKey(span.userId),
    })),
    includeChanged: options.includeChanged,
    ...(options.goesWithParent ? { goesWithParent: options.goesWithParent } : {}),
    ...(options.goesWithParentReadBelow ? { goesWithParentReadBelow: true } : {}),
    ...(options.alongAccepted ? { alongAccepted: options.alongAccepted } : {}),
    ...(options.alongToDraft ? { alongToDraft: options.alongToDraft } : {}),
    ...(options.runUserId ? { runUser: recordKey(options.runUserId) } : {}),
    ...(options.automationMade ? { automationMade: keysAsAsked(options.automationMade) } : {}),
    ...(options.laterParts
      ? { linkedLater: laterSpansOf(options.laterParts, 'linked', clock.aheadMs) }
      : {}),
    ...(otherPartRecords ? { otherPartRecords, otherPartObjects } : {}),
  });

  if (stopped()) return untouched();
  await options.beforeFirstWrite?.();
  // The sweep, once what changed since the run has been read: a roll-up its
  // deletes recalculate stamps a record of the run as modified, which that
  // reading, taken before, never takes for a change. Swept first, on a
  // Developer Edition whose accounts count their opportunities, the sweep
  // took the opportunity created under a cloned account during the run, and
  // the removal kept the account as changed since the run.
  if (options.sweep && (await options.sweep(splitting))) wrote = true;

  const removals: ObjectRemoval[] = [];
  const removalOf = (objectApiName: string): ObjectRemoval | undefined =>
    removals.find((removal) => removal.result.objectApiName === objectApiName);
  /**
   * Of the records of `objects` in `source`, a page at a time, those `keep`
   * keeps, told each record with whether the removal took it — deleted it, or
   * found it gone. The platform's copies come after the records handed over,
   * in each object's pages: a record has the same place in both.
   */
  async function* recordsWhere(
    source: RunRecords,
    objects: ReadonlyArray<{ objectApiName: string }>,
    keep: (objectApiName: string, id: string, gone: boolean) => boolean,
  ): AsyncGenerator<ForgeRunObjectRecords> {
    for (const { objectApiName } of objects) {
      const removal = removalOf(objectApiName);
      let place = 0;
      for await (const page of source.pages(objectApiName)) {
        const ids = page.filter((id) =>
          keep(objectApiName, id, removal?.isGone(id, place++) === true),
        );
        if (ids.length > 0) yield { objectApiName, ids };
      }
    }
  }
  /**
   * The run's records the removal may have left in the org, per object: the
   * ones there and unchanged since the run when it began, read by their
   * `LastModifiedDate`, that it has not deleted or found gone since.
   */
  const leftUnchanged = (): AsyncIterable<ForgeRunObjectRecords> =>
    recordsWhere(records, order, (objectApiName, id, gone) => {
      const snapshot = snapshots.get(objectApiName);
      const key = recordKey(id);
      return (
        snapshot?.modifiedColumn === 'LastModifiedDate' &&
        !snapshot.missing.has(key) &&
        !changed.has(key) &&
        !gone
      );
    });
  /** The records set to Draft for their delete, with the status each had. */
  let drafted: Drafted[] = [];
  // Every way out once a status may have been changed: what the removal leaves
  // in the org gets its status back first; then, once it has written, what it
  // left on the run's records is read, and when it ran is said, for the next
  // removal.
  const outcome = async (cancelled: boolean): Promise<RunRemovalOutcome> => {
    await putBackStatuses(session, drafted, {
      note: (objectApiName, reason, failed) => {
        let removal = removalOf(objectApiName);
        // An object not reached is named only for a record left in Draft:
        // otherwise it is as the removal found it.
        if (!removal) {
          if (!failed) return;
          const planned = records.objects.find((object) => object.objectApiName === objectApiName);
          removal = new ObjectRemoval(objectApiName, planned?.count ?? 0, copiesOf(objectApiName));
          removals.push(removal);
        }
        removal.note(reason);
      },
    });
    const stamps = wrote
      ? await stampsLeft(session, leftUnchanged(), { start: clock.start, user: removalUser })
      : {};
    const otherPartStamps: Array<Record<string, string>> = [];
    if (wrote) {
      for (const part of otherParts) {
        otherPartStamps.push(
          await stampsLeft(session, part.unchanged(), { start: clock.start, user: removalUser }),
        );
      }
    }
    const span = wrote ? removalSpanOf(clock, removalUser) : undefined;
    // Handed over in memory, the records taken are said by their ids; read a
    // page at a time, they are not gathered — what is left is read instead.
    // The platform's copies are not the run's to keep but the removal's to
    // find again: said neither gone nor left.
    const gone: string[] = [];
    if (!isRunRecords(plan)) {
      for await (const { ids } of recordsWhere(handed, order, (_object, _id, taken) => taken)) {
        for (const id of ids) gone.push(id);
      }
    }
    for (const removal of removals) {
      removal.limitNotes = deleteLimitNotes(removal.result.objectApiName, splitting);
    }
    const settled = removals.map((removal) => removal.settle());
    return {
      ...(undeletable.length > 0 ? { undeletable } : {}),
      objects: cancelled ? withNotReached(settled, order, copiesOf) : settled,
      cancelled,
      gone,
      left: () => recordsWhere(handed, handed.objects, (_object, _id, taken) => !taken),
      stamps,
      ...(span ? { span } : {}),
      ...(otherPartStamps.length > 0 ? { otherPartStamps } : {}),
    };
  };
  // Stopped during the sweep: none of the run's records goes, and what the
  // sweep left on them is said for the next removal.
  if (stopped()) return wrote ? outcome(true) : untouched();
  /** Of records about to be set to Draft, those records that stay hang from: they stay as they are. */
  const heldOf = async (
    objectApiName: string,
    candidates: readonly string[],
  ): Promise<ReadonlySet<string>> => (await dependents.heldAmong(objectApiName, candidates)).held;
  const drafting = await backToDraft(
    session,
    order,
    records,
    (objectApiName, id) => {
      const key = recordKey(id);
      const snapshot = snapshots.get(objectApiName);
      return (
        snapshot !== undefined &&
        snapshot.error === undefined &&
        !undeletableNames.has(objectApiName) &&
        !snapshot.missing.has(key) &&
        !(changed.has(key) && !options.includeChanged)
      );
    },
    stopped,
    heldOf,
  );
  drafted = drafting.drafted;
  if (drafting.cancelled) return outcome(true);
  if (options.alongToDraft) {
    const along = await backToDraft(
      session,
      options.alongToDraft.objects,
      options.alongToDraft,
      () => true,
      stopped,
      heldOf,
    );
    drafted = [...drafted, ...along.drafted];
    if (along.cancelled) return outcome(true);
  }
  let settled = 0;
  for (const { objectApiName, count } of order) {
    if (stopped()) return outcome(true);
    const removal = new ObjectRemoval(objectApiName, count, copiesOf(objectApiName));
    removals.push(removal);
    reachedObjects.add(objectApiName);
    const snapshot = snapshots.get(objectApiName);

    if (!snapshot || snapshot.error !== undefined) {
      removal.unread = { reason: snapshot?.error ?? 'The org gave no reason.', count };
      settled += count;
      options.onProgress?.(settled, total, objectApiName);
      continue;
    }
    // Refused unsent, as the object's records the org would refuse each: and
    // they stay, so what they hang from stays with them. A record already in
    // the recycle bin is gone, and one found nowhere is not visible, as at
    // any other object's turn: counted refused with the rest, a record
    // deleted since the run was said to be left in the org.
    if (undeletableNames.has(objectApiName)) {
      let at = 0;
      let staying = 0;
      for await (const page of records.pages(objectApiName)) {
        for (const id of page) {
          const key = recordKey(id);
          const place = at++;
          if (!snapshot.missing.has(key)) staying++;
          else if (snapshot.binned.has(key)) {
            removal.result.alreadyGone++;
            removal.goneAt.add(place);
          } else removal.notVisible++;
        }
      }
      if (removal.notVisible > 0) {
        removal.notVisibleNote = notVisibleNoteOf(removal.notVisible, snapshot.binError);
      }
      if (staying > 0) {
        removal.unread = { reason: undeletableReason(objectApiName, staying), count: staying };
      }
      settled += count;
      options.onProgress?.(settled, total, objectApiName);
      continue;
    }

    // Records read from a journal come a page of two thousand at a time: an
    // object of a job's worth gathers its pages up to a job before they are
    // checked and sent, or no page would ever reach the threshold, and twelve
    // thousand contacts went in sixty calls. Every other object goes a page at
    // a time, as it did.
    const gathers = goesByJob(session, objectApiName, count);
    let candidates: string[] = [];
    /** The place among the object's records of each candidate, by its key. */
    let placeOf = new Map<string, number>();
    /** Check and send the candidates gathered so far; whether the removal was stopped. */
    const sendGathered = async (): Promise<boolean> => {
      const sent = candidates;
      const places = placeOf;
      candidates = [];
      placeOf = new Map();
      return removeCandidates(session, dependents, removal, sent, {
        stopped,
        splitting,
        placeOf: places,
        onDeleted: (deleted) => {
          settled += deleted;
          options.onProgress?.(settled, total, objectApiName);
        },
        onHeld: (held) => {
          settled += held;
          options.onProgress?.(settled, total, objectApiName);
        },
      });
    };
    let at = 0;
    for await (const page of records.pages(objectApiName)) {
      if (stopped()) return outcome(true);
      const gatheredBefore = candidates.length;
      for (const id of page) {
        const key = recordKey(id);
        const place = at++;
        if (snapshot.missing.has(key)) {
          // Gone only when the recycle bin holds it: a record the session
          // cannot see comes back from a query no more than a deleted one, and
          // taken for gone it was counted removed while it stayed in the org.
          if (snapshot.binned.has(key)) {
            removal.result.alreadyGone++;
            removal.goneAt.add(place);
          } else removal.notVisible++;
        } else if (changed.has(key) && !options.includeChanged) removal.result.keptChanged++;
        else {
          candidates.push(id);
          placeOf.set(key, place);
        }
      }
      if (removal.notVisible > 0) {
        removal.notVisibleNote = notVisibleNoteOf(removal.notVisible, snapshot.binError);
      }
      settled += page.length - (candidates.length - gatheredBefore);
      if (gathers && candidates.length < BULK_DELETE_JOB_RECORDS) continue;
      if (await sendGathered()) return outcome(true);
    }
    if (gathers && candidates.length > 0) {
      if (stopped()) return outcome(true);
      if (await sendGathered()) return outcome(true);
    }
  }

  // The second try. Once the rest of the plan has gone, every record the org
  // refused is sent once more, children first, whatever it refused it with,
  // with the records held for one of them; then, while a round deletes
  // something more, what is still refused for records hanging from it, or
  // held by one of those. A record refused at its turn stayed refused when
  // what held it went later in the same removal. Run for real on a sandbox,
  // a catalog clone's selling model options were refused while the active
  // prices they are sold under stood ("associated with an active price book
  // entry", as UNKNOWN_EXCEPTION), the prices went next, and the options, the
  // products and the products' classification behind them stayed until a
  // second removal took them all. What the org refuses for any other reason
  // than records hanging from it goes once more, and no more. Settled
  // already, a record is not counted twice.
  const deletedAny = removals.some((removal) => removal.result.deleted > 0);
  const stoppedRetrying = await retryRounds(removals, {
    stopped,
    idsOf: (removal, round) => {
      if (round > 0) return removal.waiting();
      const again = removal.refusedToSendAgain();
      return again.length > 0 || deletedAny ? [...again, ...removal.held] : [];
    },
    send: async (removal, waiting, round) => {
      // What the org had refused that this round takes up: nothing has been
      // sent since the round read it.
      const takenUp = new Set(round === 0 ? removal.refusedToSendAgain() : []);
      const cancelledPart = await removeCandidates(session, dependents, removal, waiting, {
        stopped,
        splitting,
        onSent: (batch) => {
          for (const id of batch) if (takenUp.has(id)) removal.secondTry.add(id);
        },
      });
      for (const id of removal.held) if (takenUp.has(id)) removal.secondTry.add(id);
      return cancelledPart;
    },
    deleted: (removal) => removal.result.deleted,
  });
  if (stoppedRetrying) return outcome(true);

  // The last part of a granted sweep, once every record of the run that will
  // go has gone, its second try included: what one of them pointed at through
  // a lookup the org restricts the delete by. Sent before, an Asset a Case of
  // the run named was refused — DELETE_FAILED, "associated with the following
  // cases" — and deleting the Case first, then the Asset, took both.
  if (options.afterRemoval) {
    if (stopped()) return outcome(true);
    if (await options.afterRemoval(splitting)) wrote = true;
  }

  for (const removal of removals) {
    if (stopped()) return outcome(true);
    await settleTakenAlong(session, removal, snapshots.get(removal.result.objectApiName));
  }
  return outcome(false);
}

/** What {@link previewOf} reads the run's records against: the removal's own reading of them. */
interface PreviewReading {
  snapshots: ReadonlyMap<string, ObjectSnapshot>;
  /** Keys of the records changed since the run. */
  changed: ReadonlySet<string>;
  /** The objects whose records the user may not delete. */
  undeletable: ReadonlySet<string>;
  includeChanged: boolean;
  stopped: () => boolean;
  /** How many of an object's records are the platform's copies. */
  copiesOf: (objectApiName: string) => number;
  /**
   * What hangs from the records, read when asked (`RunRemovalOptions.previewHeld`):
   * the check, and the keys of the run's records the preview would not send,
   * which it fills as it goes.
   */
  held?: { check: DependentsCheck; notSent: Set<string> };
}

/**
 * What the removal would do with each object's records, from what it read
 * of them before its first write, each record counted as its turn would
 * count it: found deleted, nowhere, of an object it may not delete or could
 * not read, kept as changed since, or sent. Of the records changed since, who
 * last changed them is read, a few lists at a time, with those users' names.
 *
 * @returns Undefined when the removal was stopped meanwhile.
 */
/**
 * What a removal reads of the articles of `objectApiName`'s versions before it
 * deletes any: the versions it would keep for their article, or why the org
 * refused the read, which refuses every one of them in a removal. A preview
 * that asked nothing of the articles said "6 to delete of 6", and said it
 * again after the removal had every one refused (`articleRemoval`).
 */
async function articlesReadOf(
  org: RemovalOrg,
  records: RunRecords,
  objectApiName: string,
  missing: ReadonlySet<string>,
  reading: Pick<PreviewReading, 'changed' | 'includeChanged'>,
): Promise<{ kept: ReadonlySet<string>; unread?: string }> {
  const { changed, includeChanged } = reading;
  const sent: string[] = [];
  for await (const page of records.pages(objectApiName)) {
    for (const id of page) {
      const key = recordKey(id);
      if (!missing.has(key) && (includeChanged || !changed.has(key))) sent.push(id);
    }
  }
  try {
    return { kept: await versionsKeptOf(org, objectApiName, sent, { includeChanged }) };
  } catch (err: unknown) {
    return { kept: new Set(), unread: extractErrorMessage(err) };
  }
}

async function previewOf(
  org: RemovalOrg,
  records: RunRecords,
  order: ReadonlyArray<{ readonly objectApiName: string; readonly count: number }>,
  reading: PreviewReading,
): Promise<RunRemovalPreview | undefined> {
  const objects: RemovalPreviewObject[] = [];
  const modifiers = new Set<string>();
  for (const { objectApiName, count } of order) {
    const copies = reading.copiesOf(objectApiName);
    const object: RemovalPreviewObject = {
      objectApiName,
      planned: count,
      toDelete: 0,
      alreadyGone: 0,
      changedSince: 0,
      keptChanged: 0,
      changedBy: {},
      undeletable: 0,
      notVisible: 0,
      unread: 0,
      ...(copies > 0 ? { platformCopies: copies } : {}),
      reasons: [],
    };
    objects.push(object);
    const snapshot = reading.snapshots.get(objectApiName);
    if (!snapshot || snapshot.error !== undefined) {
      object.unread = count;
      object.reasons.push(snapshot?.error ?? 'The org gave no reason.');
      // Never sent, its records stay, and hold their parents.
      if (reading.held) {
        for await (const page of records.pages(objectApiName)) {
          for (const id of page) reading.held.notSent.add(recordKey(id));
        }
      }
      continue;
    }
    const articles =
      isArticleVersionObject(objectApiName) && !reading.undeletable.has(objectApiName)
        ? await articlesReadOf(org, records, objectApiName, snapshot.missing, reading)
        : undefined;
    const changedIds: string[] = [];
    /** The records it would send, read for what hangs from them when asked. */
    const sent: string[] = [];
    const notSent = (key: string): void => {
      reading.held?.notSent.add(key);
    };
    for await (const page of records.pages(objectApiName)) {
      for (const id of page) {
        const key = recordKey(id);
        if (snapshot.missing.has(key)) {
          if (snapshot.binned.has(key)) object.alreadyGone++;
          else object.notVisible++;
        } else if (reading.undeletable.has(objectApiName)) {
          object.undeletable++;
          notSent(key);
        } else if (articles?.unread !== undefined) {
          object.unread++;
          notSent(key);
        } else if (reading.changed.has(key)) {
          object.changedSince++;
          changedIds.push(id);
          if (reading.includeChanged) {
            object.toDelete++;
            sent.push(id);
          } else {
            object.keptChanged++;
            notSent(key);
          }
        } else if (articles?.kept.has(key)) {
          object.changedSince++;
          object.keptChanged++;
          notSent(key);
        } else {
          object.toDelete++;
          sent.push(id);
        }
      }
    }
    if (reading.held && sent.length > 0) {
      if (reading.stopped()) return undefined;
      const verdict = await reading.held.check.heldAmong(objectApiName, sent);
      const kept = sent.filter((id) => verdict.held.has(recordKey(id)));
      if (kept.length > 0) {
        object.toDelete -= kept.length;
        object.keptDependents = kept.length;
        object.heldBy = [...verdict.holders];
        for (const id of kept) reading.held.notSent.add(recordKey(id));
        const byAutomation = kept.filter((id) => verdict.byAutomation.has(recordKey(id)));
        if (byAutomation.length > 0) object.heldByAutomation = byAutomation.length;
      }
      const came = new Map<string, string>();
      for (const id of sent) {
        if (verdict.held.has(recordKey(id))) continue;
        for (const [taken, under] of verdict.cameAlong.get(recordKey(id)) ?? []) {
          came.set(taken, under);
        }
      }
      if (came.size > 0) {
        object.cameAlong = { count: came.size, objects: [...new Set(came.values())] };
      }
      if (verdict.reason !== undefined) object.reasons.push(verdict.reason);
      if (verdict.unchecked.size > 0) {
        object.reasons.push(
          `Not checked: what hangs from them through ${[...verdict.unchecked].join(', ')}, ` +
            'which the org deletes along but does not let be read by the record it hangs from.',
        );
      }
    }
    if (articles?.unread !== undefined) {
      object.reasons.push(`Its articles could not be read: ${articles.unread}`);
    } else if (articles !== undefined && articles.kept.size > 0) {
      object.reasons.push(OTHER_VERSIONS_KEPT);
    }
    if (object.notVisible > 0) {
      object.reasons.push(notVisibleNoteOf(object.notVisible, snapshot.binError));
    }
    if (object.undeletable > 0) {
      object.reasons.push(undeletableReason(objectApiName, object.undeletable));
    }
    // An object whose records keep no `LastModifiedDate` keeps no last
    // modifier either: its changes were read by their system stamp.
    if (changedIds.length === 0 || snapshot.modifiedColumn !== 'LastModifiedDate') continue;
    if (reading.stopped()) return undefined;
    try {
      const rows = await readRecordsById(
        org,
        objectApiName,
        ['LastModifiedById'],
        changedIds,
        DEPENDENT_READS_AT_ONCE,
      );
      for (const row of rows) {
        const by = row.LastModifiedById;
        if (typeof by !== 'string' || by === '') continue;
        object.changedBy[by] = (object.changedBy[by] ?? 0) + 1;
        modifiers.add(by);
      }
    } catch (err: unknown) {
      object.reasons.push(
        `Who changed them since the run could not be read: ${extractErrorMessage(err)}`,
      );
    }
  }
  if (reading.stopped()) return undefined;
  return { objects, userNames: await userNamesOf(org, [...modifiers]) };
}

/**
 * The names of the users `ids` names, by user Id, as the org gives them; a
 * read that fails leaves them named by their Id.
 */
async function userNamesOf(
  org: Pick<RemovalOrg, 'query'>,
  ids: readonly string[],
): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  if (ids.length === 0) return names;
  try {
    for (const row of await readRecordsById(org, 'User', ['Name'], [...ids].sort())) {
      if (typeof row.Id === 'string' && typeof row.Name === 'string') names[row.Id] = row.Name;
    }
  } catch {
    // Unread: the users stay named by their Id.
  }
  return names;
}

/**
 * Count as gone the refused records the org no longer holds: a parent the
 * removal deleted after their last try took them along. Every one the org
 * refused was in the snapshot, read before the first delete; one of an object
 * the removal could not read was never sent, and is not read back either.
 *
 * The org deletes an email message's relations only with their message —
 * "can be updated only in a draft state", on each of them — and the removal
 * reaches the relations first, children before their parents. Their message
 * took them a call later, and the removal still said the org had refused
 * them, and that it ended partial. Sent again once the rest has gone, they
 * now answer that they are gone; read back, what went after its second try.
 *
 * A read back that fails leaves them refused, and says they were not checked.
 */
async function settleTakenAlong(
  org: RemovalOrg,
  removal: ObjectRemoval,
  snapshot: ObjectSnapshot | undefined,
): Promise<void> {
  const { gone, unchecked, failure } = await takenAlong(
    removal.refusedSent(),
    (ids) => readRecordsById(org, removal.result.objectApiName, [], ids),
    (id) =>
      snapshot !== undefined &&
      snapshot.error === undefined &&
      !snapshot.missing.has(recordKey(id)),
  );
  for (const id of gone) {
    removal.refused.delete(id);
    removal.goneLater.add(recordKey(id));
    removal.result.alreadyGone++;
  }
  if (unchecked.length > 0) {
    removal.note(
      `Not checked: ${unchecked.length} refused record(s) could not be read back once the ` +
        `rest had gone, to tell whether a parent deleted after them took them along` +
        (failure ? ` — ${failure}` : '.'),
    );
  }
}

/**
 * The objects whose records a removal of a run's `objects` deletes: those,
 * then the objects outside them the platform's copies of the run's lines are
 * on, which it takes with the run's own ({@link quoteSyncCopyObjectsOf}). What
 * the target runs as records go is read on these, the question asked and the
 * mute planned from it: read on the run's objects alone, a clone without
 * quote lines in its plan had its removal delete the copies the platform made
 * of its line items, the flow on quote lines never read.
 *
 * @param otherParts - The objects the run's other parts created records of,
 *   for the removal of one part of a run cut and taken up: the opportunity
 *   whose quote the part synced may be another part's.
 */
export function objectsRemovedOf(
  objects: readonly string[],
  otherParts: readonly string[] = [],
): string[] {
  return [...new Set([...objects, ...quoteSyncCopyObjectsOf(objects, otherParts)])];
}

/**
 * The objects of the plan whose records the user the removal runs as may not
 * delete, as their describes say (`deletable: false`), with their records
 * still in the org. A file's version is deleted through its document,
 * whatever its own describe says; and a describe that does not say is not
 * taken for a refusal.
 *
 * @param found - How many of an object's records the removal found in the
 *   org: one deleted since the run does not stay on the user's account, and
 *   an object none of whose records is left is not one to ask about.
 */
async function undeletableOf(
  org: RemovalOrg,
  order: ReadonlyArray<{ readonly objectApiName: string; readonly count: number }>,
  found: (objectApiName: string, count: number) => number,
): Promise<UndeletableObject[]> {
  const undeletable: UndeletableObject[] = [];
  for (const { objectApiName, count } of order) {
    if (objectApiName === FILE_VERSION || count === 0) continue;
    const records = found(objectApiName, count);
    if (records === 0) continue;
    try {
      const described = describedObjectSchema.safeParse(await org.describe(objectApiName));
      if (described.success && described.data.deletable === false) {
        undeletable.push({ objectApiName, records });
      }
    } catch {
      // Not described: its deletes answer for it, as they did.
    }
  }
  return undeletable;
}

/**
 * What a removal left on the run's records it did not delete, by id: the
 * `LastModifiedDate` of each that its user last modified once it had started
 * — what a later removal reads as this one's doing, not as a change since the
 * run.
 *
 * Deleting a record's children restamps it: an opportunity's line items
 * deleted, the org recalculates its amount and dates the opportunity then, as
 * modified by whoever deleted them. Cancelled after the line items, a removal
 * left the opportunity so, and the next one read it as changed since the run
 * and kept it, and its account and price book with it. An order given its
 * status back is stamped the same way. A record someone else modified last
 * keeps their change, and so does one that had changed since the run when the
 * removal began: `records` holds only the ones that had not.
 *
 * Read {@link RECORDS_PER_CALL} at a time, and best effort: an object whose
 * records cannot be read back leaves them unstamped, and an org that did not
 * tell its clock or the removal's user leaves every record so.
 *
 * @param removal - When the removal started, by the org's clock, and the key
 *   of the user it runs as.
 */
async function stampsLeft(
  org: RemovalOrg,
  records: AsyncIterable<ForgeRunObjectRecords>,
  removal: { start: number; user: string | undefined },
): Promise<Record<string, string>> {
  const stamps: Record<string, string> = {};
  const { start, user } = removal;
  if (user === undefined || !Number.isFinite(start)) return stamps;
  for await (const { objectApiName, ids } of records) {
    let rows: Array<Record<string, unknown>>;
    try {
      rows = await readRecordsById(
        org,
        objectApiName,
        ['LastModifiedDate', 'LastModifiedById'],
        ids,
      );
    } catch {
      continue;
    }
    for (const row of rows) {
      if (
        typeof row.Id === 'string' &&
        typeof row.LastModifiedDate === 'string' &&
        typeof row.LastModifiedById === 'string' &&
        recordKey(row.LastModifiedById) === user &&
        epochOf(row.LastModifiedDate) >= start
      ) {
        stamps[row.Id] = row.LastModifiedDate;
      }
    }
  }
  return stamps;
}

/** Of another part of the run, its records that had not changed since it when the removal began. */
interface PartUnchanged {
  /** Those records, per object a page at a time, read again from the part's records. */
  unchanged(): AsyncIterable<ForgeRunObjectRecords>;
}

/**
 * Of each of the run's other parts, the records that had not changed since it
 * as the removal begins, read before its first write — by `LastModifiedDate`,
 * against the part's own end and what its earlier removals stamped, as its
 * own removal reads a change since the run — and marked by their place, a bit
 * each, so that a part of a million records is read again a page at a time
 * rather than held. What the removal stamps of them is read back as it ends
 * ({@link stampsLeft}): a record a colleague had changed since its part is
 * never among them, and keeps the change.
 *
 * A part whose end cannot be read on the org's clock, and an object whose
 * records cannot be read by their modified date, leave their records
 * unstamped: the part's own removal then reads them as it would have.
 *
 * @returns Undefined when the removal was stopped while it read them.
 */
async function unchangedOfOtherParts(
  org: RemovalOrg,
  parts: readonly RunPartAlongside[],
  orgAheadMs: number,
  stopped: () => boolean,
): Promise<PartUnchanged[] | undefined> {
  const read: PartUnchanged[] = [];
  for (const part of parts) {
    const records = isRunRecords(part.plan) ? part.plan : runRecordsOf(part.plan);
    // Read without its records' dates, a part asked to end with its last
    // write ends with its leeway: its own records read the same either way,
    // the dates that would end it being theirs.
    const { end } = runSpan(part.span, [], orgAheadMs);
    const stamped = new Map(
      Object.entries(part.removalStamps ?? {}).map(([id, date]) => [recordKey(id), epochOf(date)]),
    );
    const writtenLater = laterEndsOf(part.laterParts, orgAheadMs);
    const marks = new Map<string, PlaceMarks>();
    if (Number.isFinite(end)) {
      for (const { objectApiName } of records.objects) {
        const unchanged = new PlaceMarks();
        let at = 0;
        let unread = false;
        for await (const page of records.pages(objectApiName)) {
          if (stopped()) return undefined;
          const place = at;
          at += page.length;
          if (unread) continue;
          let rows: Array<Record<string, unknown>>;
          try {
            rows = await readRecordsById(
              org,
              objectApiName,
              ['LastModifiedDate'],
              page,
              DEPENDENT_READS_AT_ONCE,
            );
          } catch {
            unread = true;
            continue;
          }
          const modifiedOf = new Map<string, number>();
          for (const row of rows) {
            if (typeof row.Id === 'string') {
              modifiedOf.set(recordKey(row.Id), epochOf(row.LastModifiedDate));
            }
          }
          page.forEach((id, offset) => {
            const key = recordKey(id);
            const modified = modifiedOf.get(key);
            if (modified === undefined) return;
            if (
              modified <= end ||
              modified <= (stamped.get(key) ?? Number.NaN) ||
              modified <= (writtenLater.get(key) ?? Number.NaN)
            ) {
              unchanged.add(place + offset);
            }
          });
        }
        if (!unread) marks.set(objectApiName, unchanged);
      }
    }
    read.push({
      unchanged: async function* () {
        for (const { objectApiName } of records.objects) {
          const unchanged = marks.get(objectApiName);
          if (!unchanged) continue;
          let place = 0;
          for await (const page of records.pages(objectApiName)) {
            const ids = page.filter(() => unchanged.has(place++));
            if (ids.length > 0) yield { objectApiName, ids };
          }
        }
      },
    });
  }
  return read;
}

/** How {@link removeCandidates} reports as it goes. */
interface CandidateHooks {
  stopped: () => boolean;
  /** The sizes the removal's deletes go at, and the smaller calls it may still make. */
  splitting: LimitSplitting;
  /** Records deleted, or found gone, by one call. */
  onDeleted?: (count: number) => void;
  /** Records kept for their dependents or left for the org's refusal to be read. */
  onHeld?: (count: number) => void;
  /** The records of one delete, once the org answered it. */
  onSent?: (batch: readonly string[]) => void;
  /**
   * At the object's turn, a page of its records: each candidate's place among
   * them, by its key — where what the removal takes is marked. Without it,
   * the candidates are records taken up again once their turn is over: those
   * held before are among them, and are settled afresh.
   */
  placeOf?: ReadonlyMap<string, number>;
}

/**
 * Settle `candidates` of one object: keep the ones records that stay depend
 * on, delete the rest, and count each in `removal`.
 *
 * @returns Whether the removal was stopped part way.
 */
async function removeCandidates(
  org: RemovalOrg,
  dependents: DependentsCheck,
  removal: ObjectRemoval,
  candidates: readonly string[],
  hooks: CandidateHooks,
): Promise<boolean> {
  const { objectApiName } = removal.result;
  const verdict = await dependents.heldAmong(objectApiName, candidates);
  if (verdict.reason !== undefined) removal.note(verdict.reason);
  for (const name of verdict.unchecked) {
    if (!removal.result.unchecked.includes(name)) removal.result.unchecked.push(name);
  }
  const heldNow = candidates.filter((id) => verdict.held.has(recordKey(id)));
  if (hooks.placeOf) {
    // A page of the object's turn: what the pages before it held stays held.
    for (const id of heldNow) removal.held.push(id);
    removal.result.heldBy = [...new Set([...removal.result.heldBy, ...verdict.holders])];
  } else {
    // Every record held before is among the candidates: the held ones are
    // settled afresh, and a record refused before and held now is held.
    removal.held = heldNow;
    // The objects are named, never their records: a person reads which kind
    // of record stays, the org can show which ones.
    removal.result.heldBy = [...verdict.holders];
  }
  for (const id of heldNow) removal.refused.delete(id);
  // Which of them nothing but what the automation likely made holds, settled
  // afresh for every candidate.
  for (const id of candidates) {
    const key = recordKey(id);
    const holders = verdict.byAutomation.get(key);
    if (holders) removal.automationHeld.set(key, holders);
    else removal.automationHeld.delete(key);
    if (holders && verdict.automationAfter.has(key)) removal.automationHeldAfter.add(key);
    else removal.automationHeldAfter.delete(key);
    if (holders && verdict.automationAlong.has(key)) removal.automationHeldAlong.add(key);
    else removal.automationHeldAlong.delete(key);
  }
  hooks.onHeld?.(heldNow.length);

  const toDelete = candidates.filter((id) => !verdict.held.has(recordKey(id)));
  /** The files attached to the records of the delete under way that the run did not create. */
  let files = new Map<string, AttachedFile[]>();
  const settle = (sent: readonly string[], outcomes: readonly DeleteOutcome[]): void => {
    sent.forEach((id, index) => {
      const result = outcomes[index];
      const key = recordKey(id);
      if (result.lockResends !== undefined || removal.lockResent.has(key)) {
        removal.lockResent.set(key, result.kind);
      }
      if (result.kind === 'refused') {
        removal.refused.set(id, {
          reason: result.reason,
          dependency: result.dependency,
          sent: true,
          ...(result.limit ? { limit: true as const } : {}),
        });
        return;
      }
      removal.refused.delete(id);
      const place = hooks.placeOf?.get(key);
      if (place !== undefined) removal.goneAt.add(place);
      else removal.goneLater.add(key);
      if (result.kind === 'deleted') {
        removal.result.deleted++;
        if (place === undefined) removal.deletedLater.add(key);
        for (const file of files.get(key) ?? []) {
          removal.filesLeft.set(file.key, file.name);
        }
        for (const [taken, object] of verdict.along.get(key) ?? []) {
          removal.tookAlong.set(taken, object);
        }
        for (const [taken, object] of verdict.cameAlong.get(key) ?? []) {
          removal.cameAlong.set(taken, object);
        }
      } else removal.result.alreadyGone++;
    });
    hooks.onSent?.(sent);
    hooks.onDeleted?.(sent.length);
  };
  const { stopped } = await sendDeletes(org, objectApiName, toDelete, {
    stopped: hooks.stopped,
    splitting: hooks.splitting,
    // Named before the delete: a file seen through its record may be out of
    // the session's reach once the record is gone.
    prepare: async (batch) => {
      files = await dependents.filesOn(batch);
    },
    settle,
  });
  return stopped;
}

/**
 * Read one page of an object's records into its snapshot: which are still in
 * the org, when each was last modified — by its system stamp when the object
 * keeps no modified date — by its place among the object's records, and when
 * the first of them was created. An email message's relation keeps no
 * modified date: read by it alone, the object was refused whole, and the
 * removal said so of records its message took along. The object's first page
 * settles which date it is read by; a page that cannot be read by it leaves
 * the whole object unread, as one read whole would be.
 *
 * @param place - The place of the page's first record among the object's.
 * @returns The ids of the page's records the read did not find.
 */
async function readSnapshotPage(
  org: RemovalOrg,
  objectApiName: string,
  page: readonly string[],
  place: number,
  snapshot: ObjectSnapshot,
): Promise<string[]> {
  let error: string | undefined;
  const columnsTried = snapshot.modifiedColumn
    ? SNAPSHOT_DATE_COLUMNS.filter(({ modified }) => modified === snapshot.modifiedColumn)
    : SNAPSHOT_DATE_COLUMNS;
  for (const { created, modified } of columnsTried) {
    try {
      const columns = created ? [created, modified] : [modified];
      // A few lists at a time: a run of 12 000 records was read in 60 of them.
      const rows = await readRecordsById(
        org,
        objectApiName,
        columns,
        page,
        DEPENDENT_READS_AT_ONCE,
      );
      const dates = new Map<string, number>();
      for (const row of rows) {
        if (typeof row.Id === 'string') dates.set(recordKey(row.Id), epochOf(row[modified]));
        if (created) {
          snapshot.firstCreated = earliest(snapshot.firstCreated, epochOf(row[created]));
          snapshot.lastCreated = latest(snapshot.lastCreated, epochOf(row[created]));
        }
      }
      snapshot.modifiedColumn = modified;
      const missing: string[] = [];
      page.forEach((id, at) => {
        const key = recordKey(id);
        const date = dates.get(key);
        if (date === undefined) {
          snapshot.missing.add(key);
          missing.push(id);
        }
        snapshot.modified.set(place + at, date ?? Number.NaN);
      });
      return missing;
    } catch (err: unknown) {
      error ??= extractErrorMessage(err);
    }
  }
  snapshot.error = error;
  snapshot.modifiedColumn = undefined;
  return [];
}

/** Every record handed over, a page at a time per object: what a removal stopped before it wrote leaves. */
async function* everyRecordOf(records: RunRecords): AsyncGenerator<ForgeRunObjectRecords> {
  for (const { objectApiName } of records.objects) {
    for await (const ids of records.pages(objectApiName)) {
      if (ids.length > 0) yield { objectApiName, ids: [...ids] };
    }
  }
}

/** What {@link platformCopiesOf} tells the platform's copies against. */
interface CopiesReading {
  /** The run's span, by the org's clock. */
  start: number;
  end: number;
  /** The key of the user the run wrote as, where it kept it. */
  user?: string;
  /** The records of the run's other parts, and their objects: see {@link QuoteSyncRun.otherParts}. */
  otherParts?: QuoteSyncRun['otherParts'];
  /** The objects of the plan whose records the user may not delete. */
  undeletable: ReadonlySet<string>;
  /** What the removal read of the run's records, per object. */
  snapshots: ReadonlyMap<string, ObjectSnapshot>;
}

/**
 * The lines the platform copied as the run wrote under a quote it synced
 * (`quoteSyncCopiesOf`), but for those of an object the removal would not
 * send: one the user may not delete, or one whose records it could not read.
 * Those stay, and hold the quote as they did.
 */
async function platformCopiesOf(
  org: RemovalOrg,
  records: RunRecords,
  reading: CopiesReading,
): Promise<PlatformCopies> {
  const objects = new Set(
    records.objects.filter((object) => object.count > 0).map((object) => object.objectApiName),
  );
  if (!objects.has(QUOTE_OBJECT)) return [];
  const quotes: string[] = [];
  for await (const page of records.pages(QUOTE_OBJECT)) quotes.push(...page);
  const copies = await quoteSyncCopiesOf(
    org,
    {
      has: (key) => records.has(key),
      start: reading.start,
      end: reading.end,
      ...(reading.user !== undefined ? { user: reading.user } : {}),
      ...(reading.otherParts ? { otherParts: reading.otherParts } : {}),
    },
    quotes,
    objects,
  );
  const taken: PlatformCopies = [];
  for (const object of copies) {
    const { objectApiName } = object;
    if (reading.undeletable.has(objectApiName)) continue;
    const snapshot = reading.snapshots.get(objectApiName);
    if (snapshot) {
      if (snapshot.error !== undefined || snapshot.modifiedColumn !== 'LastModifiedDate') continue;
    } else if (!(await deletable(org, objectApiName))) continue;
    taken.push(object);
  }
  return taken;
}

/** Whether the describe of an object says the user may delete its records; not described, no. */
async function deletable(org: RemovalOrg, objectApiName: string): Promise<boolean> {
  try {
    const described = describedObjectSchema.safeParse(await org.describe(objectApiName));
    return described.success && described.data.deletable !== false;
  } catch {
    return false;
  }
}

/**
 * `records` with the platform's `copies` after each object's own records, a
 * page of their own, and read into the object's snapshot as the run's records
 * were: in the org, last modified when the read of them said.
 */
async function withCopies(
  records: RunRecords,
  copies: PlatformCopies,
  snapshots: Map<string, ObjectSnapshot>,
  objectOfPrefix: Map<string, string>,
): Promise<RunRecords> {
  const extra = new Map(copies.map(({ objectApiName, copies: of }) => [objectApiName, of]));
  const keys = new Set(copies.flatMap(({ copies: of }) => of.map((copy) => recordKey(copy.id))));
  const objects = records.objects.map((object) => {
    const of = extra.get(object.objectApiName);
    return of ? { objectApiName: object.objectApiName, count: object.count + of.length } : object;
  });
  for (const [objectApiName, of] of extra) {
    if (!records.objects.some((object) => object.objectApiName === objectApiName)) {
      objects.push({ objectApiName, count: of.length });
    }
    let snapshot = snapshots.get(objectApiName);
    if (!snapshot) {
      snapshot = { ...emptySnapshot(), modifiedColumn: 'LastModifiedDate' };
      snapshots.set(objectApiName, snapshot);
    }
    // Their places come after the object's own records, however many its pages hold.
    let at = 0;
    for await (const page of records.pages(objectApiName)) at += page.length;
    for (const copy of of) snapshot.modified.set(at++, copy.modified);
    const prefix = of[0]?.id.slice(0, 3);
    if (prefix !== undefined && !objectOfPrefix.has(prefix)) {
      objectOfPrefix.set(prefix, objectApiName);
    }
  }
  return {
    objects,
    pages: async function* (objectApiName) {
      yield* records.pages(objectApiName);
      const of = extra.get(objectApiName);
      if (of && of.length > 0) yield of.map((copy) => copy.id);
    },
    has: (key) => records.has(key) || keys.has(key),
  };
}

/** The org's clock as a removal starts. */
interface RemovalClock {
  /**
   * When the removal starts, by the org's clock, to the second: the org dates
   * what it writes to the second, so what the removal makes it write within
   * the second it started is dated to that second's start. Infinite when the
   * org did not tell its clock: nothing is then read as the removal's doing.
   */
  start: number;
  /** How far the org's clock runs ahead of this machine's; NaN when untold. */
  aheadMs: number;
}

/** The org's clock, read once, before the removal's first write. */
async function removalClockOf(org: RemovalOrg): Promise<RemovalClock> {
  const before = Date.now();
  let now = Number.NaN;
  try {
    now = epochOf(await org.serverTime());
  } catch {
    // Untold: see `RemovalClock`.
  }
  if (!Number.isFinite(now)) return { start: Number.POSITIVE_INFINITY, aheadMs: Number.NaN };
  // This machine's time halfway through the call: the org read its clock in it.
  return { start: Math.floor(now / 1000) * 1000, aheadMs: now - (before + Date.now()) / 2 };
}

/**
 * The key of the user the removal runs as. An org that does not say leaves
 * nothing read as the removal's own doing.
 */
async function removalUserOf(org: RemovalOrg): Promise<string | undefined> {
  try {
    const user = await org.userId();
    return typeof user === 'string' && user !== '' ? recordKey(user) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * When a removal that wrote ran, for a later one to read what the org
 * created meanwhile as its doing: from its start to the org's time as it
 * ends — this machine's time with the gap measured as it started, give or
 * take {@link CLOCK_LEEWAY_MS} — and as which user. Undefined when the org
 * did not tell its clock or its user: nothing is then read as its doing.
 */
function removalSpanOf(
  clock: RemovalClock,
  user: string | undefined,
): ForgeRemovalSpan | undefined {
  if (user === undefined || !Number.isFinite(clock.start)) return undefined;
  return {
    first: new Date(clock.start).toISOString(),
    last: new Date(Date.now() + clock.aheadMs + CLOCK_LEEWAY_MS).toISOString(),
    userId: user,
  };
}

/** The earlier of two dates, either of which may be NaN for a date not read. */
function earliest(a: number, b: number): number {
  if (Number.isNaN(a)) return b;
  return b < a ? b : a;
}

/** The later of two dates, either of which may be NaN for a date not read. */
function latest(a: number, b: number): number {
  if (Number.isNaN(a)) return b;
  return b > a ? b : a;
}

/**
 * What is left of the second a date the org gave falls in: the org dates its
 * writes to the second, truncated, so what it made later in that second
 * reads as made at the same time, and cannot be told from it.
 */
const REST_OF_THE_SECOND_MS = 999;

/**
 * The latest date the org gave the run's records from `from` to `to`, both
 * included: when one was created, or last modified. NaN when none falls
 * there. A `CreatedDate` the run copied from the source falls years before;
 * a change made after the run, past `to`.
 */
function lastWriteOf(snapshots: readonly ObjectSnapshot[], from: number, to: number): number {
  let last = Number.NaN;
  for (const snapshot of snapshots) {
    if (snapshot.lastCreated >= from && snapshot.lastCreated <= to) {
      last = latest(last, snapshot.lastCreated);
    }
    last = latest(last, snapshot.modified.latestWithin(from, to));
  }
  return last;
}

/**
 * The run's span, in the target's dates: the one given, or, for a run whose
 * dates the org did not give back, read from its records and from when it
 * was recorded.
 *
 * Recorded right after its last write, on this machine's clock, the run is
 * read on the org's with the gap between the two measured as the removal
 * starts, give or take {@link CLOCK_LEEWAY_MS}: it ended when it was recorded,
 * and began as long before as it took, or with its first record's
 * `CreatedDate` if that came later. Timed from that first record for as long
 * as the run took, the end fell after the run's last write by the whole of
 * its reading of the source, and what someone changed or added in that time
 * went with the run. And a `CreatedDate` alone cannot start it: where the
 * run's user may set audit fields, the clone writes the source's, years
 * before the run.
 *
 * Asked to (`endedByItsWrites`), it ends instead with the latest date the
 * org gave the run's records within that span — when one was created, or
 * last modified — and the rest of that second: see
 * {@link RunRemovalOptions.endedByItsWrites}. The leeway stands where the org
 * gave none.
 *
 * Without that time, or from an org that does not tell its clock, the span
 * runs from the first record's `CreatedDate` for as long as the run took:
 * late rather than early, as the run's first write came after it started.
 *
 * @param orgAheadMs - How far the org's clock runs ahead of this machine's.
 */
function runSpan(
  options: Pick<
    RunRemovalOptions,
    'runStartedAt' | 'runEndedAt' | 'runDurationMs' | 'runRecordedAt' | 'endedByItsWrites'
  >,
  snapshots: Iterable<ObjectSnapshot>,
  orgAheadMs: number,
): { start: number; end: number } {
  const read = [...snapshots];
  let firstCreated = Number.NaN;
  for (const snapshot of read) firstCreated = earliest(firstCreated, snapshot.firstCreated);
  const duration = options.runDurationMs ?? 0;
  const recordedOnOrg = (options.runRecordedAt?.getTime() ?? Number.NaN) + orgAheadMs;
  if (options.runEndedAt === undefined && Number.isFinite(recordedOnOrg)) {
    const began = recordedOnOrg - duration - CLOCK_LEEWAY_MS;
    const recordedEnd = recordedOnOrg + CLOCK_LEEWAY_MS;
    const lastWrite =
      options.endedByItsWrites === true ? lastWriteOf(read, began, recordedEnd) : Number.NaN;
    return {
      start: options.runStartedAt?.getTime() ?? (firstCreated > began ? firstCreated : began),
      end: Number.isFinite(lastWrite)
        ? Math.min(lastWrite + REST_OF_THE_SECOND_MS, recordedEnd)
        : recordedEnd,
    };
  }
  const start = options.runStartedAt?.getTime() ?? firstCreated;
  const end = options.runEndedAt?.getTime() ?? start + duration;
  return { start, end };
}

/** What the dependents check knows of the removal under way. */
interface DependentsContext {
  /** Keys of every record the run created. */
  runRecords: RecordKeys;
  /** Keys of the run's records whose object has been through the removal. */
  reached: RecordKeys;
  /** Whether a run record not reached yet is one the removal will keep. */
  stays: (key: string) => boolean;
  runStart: number;
  runEnd: number;
  /**
   * When this removal started, by the org's clock: what its user created
   * after it is its own doing. Infinite when the org did not tell.
   */
  removalStart: number;
  /** The key of the user the removal runs as; undefined when the org did not tell. */
  removalUser: string | undefined;
  /**
   * When earlier removals of the run ran, by the org's clock, and the key of
   * the user each ran as: what that user created meanwhile was their doing.
   */
  earlierRemovals: ReadonlyArray<{ start: number; end: number; user: string }>;
  /** Whether what changed since the run, and what was added since, goes too. */
  includeChanged: boolean;
  /** As {@link RunRemovalOptions.goesWithParent}. */
  goesWithParent?: (row: Readonly<Record<string, unknown>>, runEnd: number) => boolean;
  /** As {@link RunRemovalOptions.goesWithParentReadBelow}. */
  goesWithParentReadBelow?: true;
  /** As {@link RunRemovalOptions.alongAccepted}. */
  alongAccepted?: true;
  /** As {@link RunRemovalOptions.alongToDraft}. */
  alongToDraft?: RunRecords;
  /**
   * The key of the user the run wrote as, where the run kept it; absent, the
   * creator of the run's record a dependent hangs from stands for it.
   */
  runUser?: string;
  /** Keys of what a granted sweep found made for the run: see {@link RunRemovalOptions.automationMade}. */
  automationMade?: Pick<ReadonlySet<string>, 'has'>;
  /**
   * By key, the records a later part of the run linked to, with that part's
   * span on the org's clock: see {@link RunLaterPart.linked}.
   */
  linkedLater?: ReadonlyMap<string, { start: number; end: number }>;
  /**
   * Keys of the records the run's other parts created, left in the org: see
   * {@link RunRemovalOptions.otherParts} and
   * {@link RunRemovalOptions.otherPartRecords}. One under a record of this
   * part is the run's own, which its part's removal takes, never what the
   * target's automation made for the run, which a sweep takes: a sweep
   * leaves what the run's id map holds.
   */
  otherPartRecords?: RecordKeys;
  /** The objects of {@link otherPartRecords}. */
  otherPartObjects?: ReadonlySet<string>;
  /**
   * Whether the check reads for a preview, nothing deleted nor set to Draft
   * yet: the rows a record past Draft locks under it are not held, as a
   * removal sets the record back to Draft before its deletes.
   */
  previewing?: true;
}

/**
 * The keys of `ids` as they stand each time one is asked about: a granted
 * sweep fills its set (`SweepParts.automationMade`) once the removal has read
 * the run's records, after the dependents check was made. Copied when the
 * check was made, the set was still empty, and a child the sweep took held
 * its parent back all the same.
 */
function keysAsAsked(ids: ReadonlySet<string>): Pick<ReadonlySet<string>, 'has'> {
  let keys = new Set<string>();
  let read = -1;
  return {
    has: (key) => {
      if (ids.size !== read) {
        keys = new Set([...ids].map(recordKey));
        read = ids.size;
      }
      return keys.has(key);
    },
  };
}

/** What a sweep reads below the records it takes against: see {@link sweptHeldCheck}. */
export interface SweptReading {
  /** The run's first write, less a sweep's lead, on the org's clock, epoch milliseconds. */
  runStart: number;
  /** The run's last write, on the org's clock, epoch milliseconds: what came later stays. */
  runEnd: number;
  /**
   * The records the run created, by key: the run's own, which its removal
   * takes. Not what it linked to or matched, which were the target's before
   * it, and stay.
   */
  runRecords: RecordKeys;
  /**
   * The ids of what the sweep takes, as they stand: one among them hanging
   * from another goes with it. One held is let go of before its parent is
   * read, children first.
   */
  taken: ReadonlySet<string>;
  /** As {@link RunRemovalOptions.removalSpans}. */
  removalSpans?: readonly ForgeRemovalSpan[];
  /** As {@link RunRemovalOptions.includeChanged}. */
  includeChanged: boolean;
  /** The user the run wrote as, by Salesforce id. */
  runUserId?: string;
}

/**
 * The check a sweep reads below the records it is about to take with, as a
 * removal reads what goes along with the run's (`DependentsCheck.heldBelow`):
 * of `ids`, records of one object, those a record that stays hangs from —
 * made by hand since, older and moved under one, changed since unless the
 * request includes it, or one the sweep does not take — with the objects of
 * what holds them; read down as far as a removal reads. Each describe and
 * the dates each object keeps are read once per check.
 *
 * What a sweep takes went in cascade with what it hung from: a contact the
 * target's automation made under an account of the run went with the
 * account, the sweep having let it go along, and a campaign member someone
 * added to that contact since went with it, unread. A record of another
 * part of the run under one, written after this part, stays: deleting what it
 * hangs from would take it along with the part removed.
 */
export function sweptHeldCheck(
  org: RemovalOrg,
  reading: SweptReading,
): (
  objectApiName: string,
  ids: readonly string[],
) => Promise<{ held: Set<string>; holders: string[]; reason?: string }> {
  const check = new DependentsCheck(org, {
    runRecords: reading.runRecords,
    reached: { has: () => false },
    stays: () => false,
    runStart: reading.runStart,
    runEnd: reading.runEnd,
    // Before the removal: nothing yet is a removal's doing but an earlier one's.
    removalStart: Number.POSITIVE_INFINITY,
    removalUser: undefined,
    earlierRemovals: (reading.removalSpans ?? []).map((span) => ({
      start: epochOf(span.first),
      end: epochOf(span.last),
      user: recordKey(span.userId),
    })),
    includeChanged: reading.includeChanged,
    automationMade: keysAsAsked(reading.taken),
    ...(reading.runUserId ? { runUser: recordKey(reading.runUserId) } : {}),
  });
  return async (objectApiName, ids) => {
    // Read as what goes along with a record of the run is read: for what
    // stays under it alone.
    const verdict = await check.heldAmong(objectApiName, ids, 1);
    return {
      held: verdict.held,
      holders: [...verdict.holders],
      ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
    };
  };
}

/** What {@link DependentsCheck.heldAmong} found for some records of one object. */
interface HeldVerdict {
  /** Keys of the records that records staying in the org depend on. */
  held: Set<string>;
  /** The objects whose staying records hold them, by API name. */
  holders: Set<string>;
  /** Of `held`, the keys of those held by something other than what the automation likely made. */
  otherwise: Set<string>;
  /**
   * Of `held`, by key, those held by nothing but records the target's
   * automation likely made for the run — created as its user, under the
   * record, within a sweep's `made` of it — with those records' objects.
   */
  byAutomation: Map<string, Set<string>>;
  /**
   * Of `byAutomation`, the keys of those one of whose holders was created
   * after the run's last write, as the org dated it.
   */
  automationAfter: Set<string>;
  /**
   * Of `byAutomation`, the keys of those every holder of which hangs from
   * them through a relationship the org deletes along: a sweep lets those go
   * with them, rather than delete them first.
   */
  automationAlong: Set<string>;
  /**
   * By the key of a record about to go, the records not the run's that the
   * org would take along with it only because the request includes what was
   * added or changed since the run: each by its key, with its object.
   */
  along: Map<string, Map<string, string>>;
  /**
   * By the key of a record about to go, the records the run did not write
   * that came with its records — made by the platform or the target's
   * automation as it wrote, and unchanged since — that the org would take
   * along with it, as far down as what goes along was read: each by its key,
   * with its object. Not the run's, another part's, what a sweep takes, nor
   * what the removal is told goes with its parent: those are named where
   * they are counted.
   */
  cameAlong: Map<string, Map<string, string>>;
  /** Relationships the org deletes along that could not be read by the record, by child object. */
  unchecked: Set<string>;
  /** Why the object's relationships could not be read at all; every record is then held. */
  reason?: string;
}

/**
 * A relationship read for the records that hang from a record: whether the
 * org refuses the record's delete over one of them, rather than take it along.
 */
interface DependentRelationship {
  childSObject: string;
  field: string;
  restricted: boolean;
  /**
   * The contacts of accounts, in an org with person accounts: a person
   * account's own contact is read as such, and goes with its account.
   */
  personContacts?: true;
}

/** The person account's flag, on an account and on its contact, in an org that has them. */
const PERSON_ACCOUNT_FLAG = 'IsPersonAccount';

/**
 * A record that stays under one of the run's that may be what the target's
 * automation made for the run, until the record it hangs from is read: see
 * {@link DependentsCheck.byAutomationOnly}.
 */
interface AutomationHolder {
  /** The record of the run it holds, by its id. */
  parent: string;
  /** Its own id: what stays under it is read too (`automationHeldBelow`). */
  id: string;
  /** Its object. */
  object: string;
  /** When it was created, by the org's clock. */
  created: number;
  /** The key of who created it. */
  creator: string;
  /**
   * Whether it hangs from that record through a relationship the org deletes
   * along: a sweep that takes it lets it go with that record. Otherwise it
   * restricts that record's delete, and a sweep deletes it first.
   */
  along: boolean;
}

/** What {@link DependentsCheck.stays} says of why a record goes, when asked. */
interface StaysAsked {
  /** It goes only as the request includes what was added or changed since the run. */
  onlyIncluded: boolean;
  /** It goes as what a removal of the run made while it went. */
  byRemoval?: true;
}

/**
 * A record that goes along with one about to go and is not the run's, read
 * for what stays under it in turn ({@link DependentsCheck.heldBelow}).
 */
interface GoingAlong {
  /** The key of the record it goes with. */
  parent: string;
  /** Its id. */
  id: string;
  /**
   * Whether it came with the run's records — made as the run wrote, by the
   * platform or the target's automation, and unchanged since — rather than
   * with the removal itself, as the request includes what was added or
   * changed since the run, or as the removal is told it goes with its parent:
   * named apart once it went ({@link HeldVerdict.cameAlong}).
   */
  came: boolean;
}

/** A file attached to a record: its document's key, and its title or its id. */
interface AttachedFile {
  key: string;
  name: string;
}

/**
 * Products per read of their prices: a product may have a price in every
 * book, currency and selling model, and a read that fills
 * {@link DEPENDENTS_READ_LIMIT} may hold more than it read.
 */
const PRODUCTS_PER_PRICE_READ = 50;

/** A row's values for `fields`, as one key: the rows that agree on each share it. */
function valuesKey(row: Record<string, unknown>, fields: readonly string[]): string {
  return JSON.stringify(fields.map((field) => row[field] ?? null));
}

/**
 * Finds, among records about to be deleted, the ones records that stay in the
 * org hang from: the children the org would delete along with them, and the
 * records that would have it refuse their delete.
 */
class DependentsCheck {
  private worked?: Promise<ReadonlyMap<string, string>>;
  /** Each lifecycle's statuses, read once per removal. */
  private readonly statuses = new Map<string, Promise<StatusCategories | undefined>>();
  /**
   * The key of each row the platform locks under a record past Draft, and the
   * key of that record: the row stays because the record does, and does not
   * hold it.
   */
  private readonly lockedUnder = new Map<string, string>();
  /**
   * Per record read, by its key, the documents of the files attached to it
   * that the run did not create.
   */
  private readonly files = new Map<string, Set<string>>();
  /**
   * Per dependent object, the first of {@link DEPENDENT_DATE_COLUMNS} it may
   * keep: the ones before it named a column it does not have.
   */
  private readonly datesKept = new Map<string, number>();
  /**
   * Per dependent object, its lookups to the objects of the run's other
   * parts that the org deletes along: read once, from those objects'
   * describes ({@link ofOtherParts}).
   */
  private readonly cascadeEnds = new Map<string, Promise<string[]>>();

  constructor(
    private readonly org: RemovalOrg,
    private readonly context: DependentsContext,
  ) {}

  /**
   * The records among `candidates` that a record staying in the org depends
   * on: through a relationship the org deletes along, or one it restricts
   * their delete by; as the rows a record past Draft locks under it; or by a
   * rule of the platform's that no relationship lists.
   *
   * Only the objects a person works with are read — queryable, createable and
   * given a page layout: an object's history, sharing rows and feed are the
   * org's own bookkeeping and go with it. An object that cannot be described
   * keeps every candidate, with the org's reason; a relationship the org
   * deletes along that it does not let be read by the record it depends on is
   * named as not checked.
   *
   * What goes along with a candidate is read in turn, down its own
   * relationships (`heldBelow`): a record staying under it holds it, and so
   * the candidate.
   *
   * @param below - How many levels below the removal's own records the
   *   candidates are: records that go along with them, read for what stays
   *   under them, and for nothing else.
   */
  async heldAmong(
    objectApiName: string,
    candidates: readonly string[],
    below = 0,
  ): Promise<HeldVerdict> {
    const verdict: HeldVerdict = {
      held: new Set(),
      holders: new Set(),
      otherwise: new Set(),
      byAutomation: new Map(),
      automationAfter: new Set(),
      automationAlong: new Set(),
      along: new Map(),
      cameAlong: new Map(),
      unchecked: new Set(),
    };
    if (candidates.length === 0) return verdict;
    let relationships: DependentRelationship[];
    try {
      const described = describedObjectSchema.parse(await this.org.describe(objectApiName));
      const worked = await this.workedObjects();
      // An account's describe lists the person flag only in an org with person accounts.
      const persons =
        objectApiName === 'Account' &&
        described.fields.some((field) => field.name === PERSON_ACCOUNT_FLAG);
      relationships = (described.childRelationships ?? [])
        .filter(
          (r) =>
            (r.cascadeDelete === true || r.restrictedDelete === true) && worked.has(r.childSObject),
        )
        .map((r) => ({
          childSObject: r.childSObject,
          field: r.field,
          restricted: r.cascadeDelete !== true,
          ...(persons && r.childSObject === 'Contact' && r.field === 'AccountId'
            ? { personContacts: true as const }
            : {}),
        }));
    } catch (err: unknown) {
      verdict.reason = extractErrorMessage(err);
      candidates.forEach((id) => this.hold(verdict, recordKey(id)));
      return verdict;
    }

    // Past one read's worth of records, a relationship no record of which
    // points anywhere holds none of them: asked once, it is not read for
    // each 200. A contact lists 23 relationships the check reads; a scratch
    // org held records of one of them, and the other 22 were read 60 times
    // each for 12 000 contacts, empty every time.
    const chunks: string[][] = [];
    for (let at = 0; at < candidates.length; at += RECORDS_PER_CALL) {
      chunks.push(candidates.slice(at, at + RECORDS_PER_CALL));
    }
    const pointing =
      chunks.length > 1
        ? await inPool(
            relationships.map((relationship) => () => this.anyPointing(relationship)),
            DEPENDENT_READS_AT_ONCE,
          )
        : relationships.map(() => true);
    const reads = relationships
      .filter((_, at) => pointing[at])
      .flatMap((relationship) =>
        chunks.map((chunk) => async () => ({
          relationship,
          ...(await this.holdingIn(relationship, chunk)),
        })),
      );
    // Read a few at a time, and settled in the order they were asked: the
    // objects holding records are named in the same order however the reads
    // came back.
    const mayBeAutomation: AutomationHolder[] = [];
    /** By object, what goes along with a candidate that is not the run's: see `heldBelow`. */
    const goingAlong = new Map<string, GoingAlong[]>();
    for (const { relationship, holding, unchecked, automation, along, goes: going } of await inPool(
      reads,
      DEPENDENT_READS_AT_ONCE,
    )) {
      if (unchecked) verdict.unchecked.add(relationship.childSObject);
      if (holding.size > 0 || automation.length > 0) {
        verdict.holders.add(relationship.childSObject);
      }
      holding.forEach((key) => this.hold(verdict, key));
      for (const holder of automation) verdict.held.add(recordKey(holder.parent));
      mayBeAutomation.push(...automation);
      for (const { parent, key } of along) {
        const goes = verdict.along.get(parent) ?? new Map<string, string>();
        goes.set(key, relationship.childSObject);
        verdict.along.set(parent, goes);
      }
      if (going.length > 0) {
        goingAlong.set(relationship.childSObject, [
          ...(goingAlong.get(relationship.childSObject) ?? []),
          ...going,
        ]);
      }
    }
    await this.heldBelow(goingAlong, verdict, below);
    // What goes along is read for what stays under it alone: the rules below
    // are the removal's own records'.
    if (below > 0) return verdict;
    if (this.context.previewing !== true) {
      await this.lockedPastDraft(objectApiName, candidates, verdict);
    }
    if (isPricebookEntry(objectApiName)) await this.standardPricesHeld(candidates, verdict);
    if (objectApiName === SELLING_MODEL_OPTION_OBJECT) {
      await this.sellingModelOptionsHeld(candidates, verdict);
    }
    // A rewind's plan read below what it deletes already, and its estimate
    // prices the reads its removal sends: see `alongAccepted`.
    if (this.context.alongAccepted !== true) {
      await this.automationHeldBelow(mayBeAutomation, verdict);
    }
    const byAutomation = await this.byAutomationOnly(
      objectApiName,
      mayBeAutomation,
      verdict.otherwise,
    );
    verdict.byAutomation = byAutomation.objects;
    verdict.automationAfter = byAutomation.after;
    verdict.automationAlong = byAutomation.along;
    return verdict;
  }

  /** Hold a record for something other than what the target's automation likely made. */
  private hold(verdict: HeldVerdict, key: string): void {
    verdict.held.add(key);
    verdict.otherwise.add(key);
  }

  /**
   * Hold the candidates under which a record that goes along with them — not
   * the run's, come with it — holds in turn a record that stays: the org
   * would delete that one too, a level further down. Read as the candidates
   * were, by the same dates, each object's records once, down to
   * {@link CASCADE_LEVELS_READ} levels; past them, or where they could not be
   * read, what goes along is kept. Held so, a candidate is named for the
   * objects of both: the one going along, and the one that stays under it.
   * What the request takes along a level down only as it includes what was
   * added or changed since the run is named with the candidate's own, and so
   * is what came with the run's records, at any level read (`cameAlong`).
   *
   * Read one level down only, a contact the target's automation made under
   * an account a load wrote went with the account, as it came with the load,
   * and a campaign member someone added to that contact since went with the
   * contact, unsaid: a Frozen reload's purge, refused for a contact made by
   * hand under the account, went through for this one and said success.
   */
  private async heldBelow(
    goingAlong: ReadonlyMap<string, readonly GoingAlong[]>,
    verdict: HeldVerdict,
    below: number,
  ): Promise<void> {
    /** Add `taken`, of `object`, to what goes along with `parent` in `named`. */
    const named = (
      by: Map<string, Map<string, string>>,
      parent: string,
      taken: string,
      object: string,
    ): void => {
      const goes = by.get(parent) ?? new Map<string, string>();
      goes.set(taken, object);
      by.set(parent, goes);
    };
    for (const [objectApiName, going] of goingAlong) {
      const ids = [...new Set(going.map((record) => record.id))];
      const under =
        below + 1 < CASCADE_LEVELS_READ
          ? await this.heldAmong(objectApiName, ids, below + 1)
          : undefined;
      for (const { parent, id, came } of going) {
        const key = recordKey(id);
        if (!under || under.held.has(key)) {
          this.hold(verdict, parent);
          verdict.holders.add(objectApiName);
          under?.holders.forEach((holder) => verdict.holders.add(holder));
          continue;
        }
        // Gone along, unsaid: a contact the target's automation made with an
        // account of a load went with the account, and the removal said
        // "Contact: 4 deleted of 4", the load's own four.
        if (came) named(verdict.cameAlong, parent, key, objectApiName);
        for (const [taken, object] of under.along.get(key) ?? []) {
          named(verdict.along, parent, taken, object);
        }
        for (const [taken, object] of under.cameAlong.get(key) ?? []) {
          named(verdict.cameAlong, parent, taken, object);
        }
      }
      under?.unchecked.forEach((name) => verdict.unchecked.add(name));
    }
  }

  /**
   * Hold, as any record that stays holds them, the candidates under which a
   * record the target's automation likely made holds in turn a record that
   * stays — added by hand since, older and moved under it, changed since —
   * read as what goes along is read (`heldBelow`): a sweep keeps such a
   * record (`sweptHeldCheck`), and the candidate stays with it. Said held by
   * the automation, the removal would answer that `--sweep` takes it, which
   * the sweep then keeps. What else the automation made under it holds
   * nothing here: a sweep takes that too.
   */
  private async automationHeldBelow(
    holders: readonly AutomationHolder[],
    verdict: HeldVerdict,
  ): Promise<void> {
    const byObject = new Map<string, AutomationHolder[]>();
    for (const holder of holders) {
      if (verdict.otherwise.has(recordKey(holder.parent))) continue;
      byObject.set(holder.object, [...(byObject.get(holder.object) ?? []), holder]);
    }
    for (const [objectApiName, held] of byObject) {
      const under = await this.heldAmong(objectApiName, [...new Set(held.map((h) => h.id))], 1);
      for (const holder of held) {
        if (!under.otherwise.has(recordKey(holder.id))) continue;
        this.hold(verdict, recordKey(holder.parent));
        under.holders.forEach((name) => verdict.holders.add(name));
      }
      under.unchecked.forEach((name) => verdict.unchecked.add(name));
    }
  }

  /**
   * Of the records `holders` hold, those nothing else holds — not in
   * `otherwise` — and every one of whose holders the target's automation
   * likely made for the run: created as the run's user — the one it kept, or
   * else the one who created the record it holds — from
   * {@link TIE_LEAD_MS} before that record to {@link MADE_WITHIN_MS} after
   * it, a sweep's `made`: the sweep's own bounds, so that what is counted held
   * by the automation is what a sweep takes. A sweep takes those first, and
   * the record they hold goes then; one past that minute a sweep takes only
   * when asked, and is not counted. The records held are read for when they were created and by
   * whom, only when some holder may be the automation's; a read that fails
   * counts none.
   *
   * Of those, the ones a holder of which came after the run's last write are
   * said apart: a sweep takes them too, within its minute, but what came then
   * is the automation run late, or a person working as the run's user. Live,
   * the removal of a cut part's summary said a contact role made by hand five
   * seconds after the part's last write was created "during the run".
   *
   * Of those, the ones every holder of which hangs from them through a
   * relationship the org deletes along are said apart too: a sweep does not
   * delete those first, it lets them go with the record they hold. Live, a
   * removal said "--sweep takes them first" of a contact role made by hand
   * under the run's contact; the sweep left it to go with the contact, and
   * found it gone.
   *
   * @returns The objects of their holders, by the key of each record held,
   *   the keys of those held by a record created after the run's end, and
   *   the keys of those held only by records that go along with them.
   */
  private async byAutomationOnly(
    objectApiName: string,
    holders: readonly AutomationHolder[],
    otherwise: ReadonlySet<string>,
  ): Promise<{ objects: Map<string, Set<string>>; after: Set<string>; along: Set<string> }> {
    const byAutomation = new Map<string, Set<string>>();
    const after = new Set<string>();
    const pending = holders.filter((holder) => !otherwise.has(recordKey(holder.parent)));
    if (pending.length === 0) return { objects: byAutomation, after, along: new Set() };
    let anchors: Map<string, Record<string, unknown>>;
    try {
      const rows = await readRecordsById(
        this.org,
        objectApiName,
        ['CreatedDate', 'CreatedById'],
        [...new Set(pending.map((holder) => holder.parent))],
      );
      anchors = new Map(
        rows.flatMap((row) => (typeof row.Id === 'string' ? [[recordKey(row.Id), row]] : [])),
      );
    } catch {
      return { objects: byAutomation, after, along: new Set() };
    }
    /** Keys of the records one of whose holders is not the automation's after all. */
    const notOnly = new Set<string>();
    /** Keys of the records one of whose holders restricts their delete. */
    const notAlong = new Set<string>();
    for (const holder of pending) {
      const key = recordKey(holder.parent);
      const anchor = anchors.get(key);
      const anchorCreated = epochOf(anchor?.CreatedDate);
      const anchorCreator = anchor?.CreatedById;
      const user =
        this.context.runUser ??
        (typeof anchorCreator === 'string' ? recordKey(anchorCreator) : undefined);
      const gap = holder.created - anchorCreated;
      const made =
        user !== undefined &&
        holder.creator === user &&
        gap >= -TIE_LEAD_MS &&
        gap <= MADE_WITHIN_MS;
      if (!made) {
        notOnly.add(key);
        continue;
      }
      const objects = byAutomation.get(key) ?? new Set<string>();
      objects.add(holder.object);
      byAutomation.set(key, objects);
      if (holder.created > this.context.runEnd) after.add(key);
      if (!holder.along) notAlong.add(key);
    }
    for (const key of notOnly) {
      byAutomation.delete(key);
      after.delete(key);
    }
    const along = new Set([...byAutomation.keys()].filter((key) => !notAlong.has(key)));
    return { objects: byAutomation, after, along };
  }

  /**
   * The keys of the records of `chunk` that a record of this relationship,
   * staying, depends on.
   *
   * Read with the dates that tell whether a record came with the run, where
   * the object has them. A real org answers three ways: most objects keep
   * `CreatedDate` and `LastModifiedDate`; a file's link to a record
   * (ContentDocumentLink) keeps only `SystemModstamp`; and a member of a sales
   * engagement list (ActionableListMember) cannot be read by the record it
   * points at at all. A record read without any date is taken to stay; a
   * relationship that cannot be read holds nothing and is named as not
   * checked, or no record with such a relationship could ever be removed. One
   * the org restricts the delete by is not named: the org's refusal says what
   * it holds.
   *
   * The links of a file to the records read also say which files stay in the
   * org once those records are gone: see {@link filesOn}.
   *
   * The dates an object does not keep are not asked of it again: a file's
   * link refused `CreatedDate` for every 200 records, and was read twice each
   * time.
   *
   * A record that stays and may be what the target's automation made for the
   * run is said apart (`automation`), until the record it holds is read
   * ({@link byAutomationOnly}): it holds that record all the same.
   *
   * A record that goes with its parent only because the request includes
   * what was added or changed since the run is said apart (`along`): not the
   * run's, it is taken all the same, and the removal names it.
   *
   * A record that goes along with its parent, the org deleting it with it,
   * and is neither the run's nor another part's, nor what a sweep takes or
   * the removal is told goes with its parent, is said apart too (`goes`):
   * what stays under it is read in turn (`heldBelow`).
   *
   * @returns The keys held, the records that may be the automation's, those
   *   taken along only as the request includes changes, those going along to
   *   read further down, and whether the relationship could not be read.
   */
  private async holdingIn(
    relationship: DependentRelationship,
    chunk: readonly string[],
  ): Promise<{
    holding: Set<string>;
    automation: AutomationHolder[];
    along: Array<{ parent: string; key: string }>;
    goes: GoingAlong[];
    unchecked: boolean;
  }> {
    const child = assertSoqlIdentifier(relationship.childSObject);
    const field = assertSoqlIdentifier(relationship.field);
    const [list] = idLists(chunk, chunk.length);
    // A record the platform adds is read with the ends that tie it to the
    // run, whichever one the relationship follows: see `PLATFORM_ADDED`.
    const columns = new Set([
      'Id',
      field,
      ...(PLATFORM_ADDED[child]?.ends ?? []),
      ...(relationship.personContacts ? [PERSON_ACCOUNT_FLAG] : []),
    ]);
    let tried = this.datesKept.get(child) ?? 0;
    while (tried < DEPENDENT_DATE_COLUMNS.length) {
      const dates = DEPENDENT_DATE_COLUMNS[tried];
      let answer: { records: unknown[] };
      try {
        answer = await this.org.query(
          `SELECT ${[...columns, ...dates].join(', ')} FROM ${child} ` +
            `WHERE ${field} IN (${list}) LIMIT ${DEPENDENTS_READ_LIMIT}`,
        );
      } catch (err: unknown) {
        // A column the object does not have, never one that failed by chance.
        if (isMissingColumn(err)) {
          tried = datesWithout(err, tried);
          this.datesKept.set(child, tried);
        } else {
          tried++;
        }
        continue;
      }
      // A read that filled its limit may hold more than it read: every
      // record of the chunk is kept rather than guessed about.
      if (answer.records.length >= DEPENDENTS_READ_LIMIT) {
        return {
          holding: new Set(chunk.map(recordKey)),
          automation: [],
          along: [],
          goes: [],
          unchecked: false,
        };
      }
      const holding = new Set<string>();
      const automation: AutomationHolder[] = [];
      const along: Array<{ parent: string; key: string }> = [];
      const goes: GoingAlong[] = [];
      /** Of `automation`, by its own id, what holds through a restricted lookup. */
      const restrictedBy = new Map<string, AutomationHolder>();
      for (const record of answer.records) {
        if (typeof record !== 'object' || record === null) continue;
        const row = record as Record<string, unknown>;
        const parent = row[relationship.field];
        if (typeof parent !== 'string' || typeof row.Id !== 'string') continue;
        if (child === FILE_LINK && field === 'LinkedEntityId') this.noteFile(row);
        // Locked under this very record, the row stays because the record does.
        if (this.lockedUnder.get(recordKey(row.Id)) === recordKey(parent)) continue;
        const asked: StaysAsked = { onlyIncluded: false };
        if (!this.stays(row, child, relationship.restricted, relationship.personContacts, asked)) {
          if (asked.onlyIncluded) along.push({ parent: recordKey(parent), key: recordKey(row.Id) });
          if (child !== FILE_LINK && this.goesAlongUnread(row)) {
            const came =
              !asked.onlyIncluded &&
              asked.byRemoval !== true &&
              this.context.goesWithParent?.(row, this.context.runEnd) !== true;
            goes.push({ parent: recordKey(parent), id: row.Id, came });
          }
          continue;
        }
        const made = this.mayBeAutomation(row);
        if (made) {
          const holder = {
            parent,
            id: row.Id,
            object: child,
            along: !relationship.restricted,
            ...made,
          };
          automation.push(holder);
          if (relationship.restricted) restrictedBy.set(row.Id, holder);
        } else holding.add(recordKey(parent));
      }
      // One that holds through a restricted lookup alone, and hangs in
      // cascade from a record of another part of the run, is that part's.
      const theirs = await this.ofOtherParts(child, [...restrictedBy.keys()]);
      for (const [id, holder] of restrictedBy) {
        if (!theirs.has(recordKey(id))) continue;
        automation.splice(automation.indexOf(holder), 1);
        holding.add(recordKey(holder.parent));
      }
      return { holding, automation, along, goes, unchecked: false };
    }
    return {
      holding: new Set(),
      automation: [],
      along: [],
      goes: [],
      unchecked: !relationship.restricted,
    };
  }

  /**
   * Whether a record that goes along with one about to be deleted has what
   * hangs from it still to read: not the run's, nor another part's, whose
   * own removal reads them; nor what a granted sweep takes, which the sweep
   * read below before it took it; nor what the removal is told goes with
   * its parent, which goes as it is, unless it is asked to read below it
   * (`goesWithParentReadBelow`); nor any of it once what goes along was read
   * and accepted before (`alongAccepted`).
   */
  private goesAlongUnread(row: Record<string, unknown>): boolean {
    const key = recordKey(row.Id as string);
    const { runRecords, otherPartRecords, automationMade, goesWithParent, runEnd } = this.context;
    return (
      this.context.alongAccepted !== true &&
      !runRecords.has(key) &&
      otherPartRecords?.has(key) !== true &&
      automationMade?.has(key) !== true &&
      (this.context.goesWithParentReadBelow === true || goesWithParent?.(row, runEnd) !== true)
    );
  }

  /**
   * Of the records `ids` of `child`, by key, those that hang through a
   * relationship the org deletes along from a record of another part of the
   * run, and from none of the part removed: that part's, held for its
   * removal, as a sweep of the part removed reads them — never what the
   * target's automation made for the run, which a sweep takes first. The line
   * the platform copied under the resume's synced quote holds the cut part's
   * product by its restricted lookup alone: the cut part's sweep, live, left
   * it as the resume's, and its removal read it as the automation's. Read
   * only for a removal of one part, and only those records; a read that
   * fails tells none.
   */
  private async ofOtherParts(child: string, ids: readonly string[]): Promise<Set<string>> {
    const theirs = new Set<string>();
    const { otherPartRecords, otherPartObjects, runRecords } = this.context;
    if (ids.length === 0 || !otherPartRecords || !otherPartObjects) return theirs;
    let ends = this.cascadeEnds.get(child);
    if (!ends) {
      ends = (async () => {
        const fields = new Set<string>();
        for (const parent of otherPartObjects) {
          try {
            const described = describedObjectSchema.parse(await this.org.describe(parent));
            for (const r of described.childRelationships ?? []) {
              if (r.childSObject === child && r.cascadeDelete === true) fields.add(r.field);
            }
          } catch {
            // Not described: no lookup to it is told.
          }
        }
        return [...fields];
      })();
      this.cascadeEnds.set(child, ends);
    }
    const fields = await ends;
    if (fields.length === 0) return theirs;
    let rows: Array<Record<string, unknown>>;
    try {
      rows = await readRecordsById(this.org, child, fields, ids);
    } catch {
      return theirs;
    }
    for (const row of rows) {
      if (typeof row.Id !== 'string') continue;
      const named = fields.flatMap((name) => {
        const value = row[name];
        return typeof value === 'string' ? [recordKey(value)] : [];
      });
      if (named.some((key) => runRecords.has(key))) continue;
      if (named.some((key) => otherPartRecords.has(key))) theirs.add(recordKey(row.Id));
    }
    return theirs;
  }

  /**
   * Whether a record that stays under one of the run's may be what the
   * target's automation made for the run, as far as its own row tells: not
   * the run's, created as the run's user — any user, when the run did not
   * keep it, until the record it holds says who wrote it — within a sweep's
   * reach of the run, and changed since by no one else. A record someone else
   * changed since is theirs now, and a sweep would keep it too.
   *
   * @returns When it was created and by whom, or nothing.
   */
  private mayBeAutomation(
    row: Record<string, unknown>,
  ): Pick<AutomationHolder, 'created' | 'creator'> | undefined {
    const { runRecords, runStart, runEnd, runUser, otherPartRecords } = this.context;
    if (typeof row.Id !== 'string' || runRecords.has(recordKey(row.Id))) return undefined;
    // A record of another part of the run is the run's, held for that part's
    // removal. Live, a resume that wrote 52 s after the cut part's
    // opportunity had its quote and line read as the automation's, which a
    // sweep takes first, while the same removal named them the resume's and
    // the cut part's sweep listed neither.
    if (otherPartRecords?.has(recordKey(row.Id)) === true) return undefined;
    if (typeof row.CreatedById !== 'string') return undefined;
    const creator = recordKey(row.CreatedById);
    if (runUser !== undefined && creator !== runUser) return undefined;
    const created = epochOf(row.CreatedDate);
    if (!(created >= runStart - TIE_LEAD_MS && created <= runEnd + MADE_WITHIN_MS)) {
      return undefined;
    }
    const modified = epochOf(row.LastModifiedDate);
    const modifier =
      typeof row.LastModifiedById === 'string' ? recordKey(row.LastModifiedById) : undefined;
    if (modified > runEnd && modifier !== undefined && modifier !== creator) return undefined;
    return { created, creator };
  }

  /**
   * Whether any record of a relationship points at a record at all: one the
   * org answers none for holds none of the records about to go. Asked of it
   * whole, once, and read for each 200 records only when it answers one —
   * or cannot answer: a file's link, which the org reads only by the records
   * it links, is read as it always was.
   */
  private async anyPointing(relationship: DependentRelationship): Promise<boolean> {
    try {
      const child = assertSoqlIdentifier(relationship.childSObject);
      const field = assertSoqlIdentifier(relationship.field);
      const answer = await this.org.query(`SELECT Id FROM ${child} WHERE ${field} != null LIMIT 1`);
      return answer.records.length > 0;
    } catch {
      return true;
    }
  }

  /**
   * Note the file a link attaches to a record, unless the run created it: a
   * file of the run's goes with the run, any other stays in the org once the
   * record is gone.
   */
  private noteFile(row: Record<string, unknown>): void {
    const record = row.LinkedEntityId;
    const document = row.ContentDocumentId;
    if (typeof record !== 'string' || typeof document !== 'string') return;
    if (isRunRecord(document, this.context.runRecords)) return;
    const files = this.files.get(recordKey(record)) ?? new Set<string>();
    files.add(document);
    this.files.set(recordKey(record), files);
  }

  /**
   * The files attached to the records `ids` that the run did not create, by
   * record key, as the links last read said: each by its title, or by its id
   * where the title could not be read.
   *
   * Run for real, removing a Frozen load with the records changed since took
   * two activated orders, and with them the links to the PDFs the org had
   * generated as it activated them: the org kept the files, linked to their
   * owner alone, and nothing named them.
   */
  async filesOn(ids: readonly string[]): Promise<Map<string, AttachedFile[]>> {
    const byRecord = new Map<string, string[]>();
    for (const id of ids) {
      const documents = this.files.get(recordKey(id));
      if (documents && documents.size > 0) byRecord.set(recordKey(id), [...documents]);
    }
    const documents = [...new Set([...byRecord.values()].flat())];
    if (documents.length === 0) return new Map();
    const titles = new Map<string, string>();
    try {
      for (const row of await readRecordsById(this.org, FILE, ['Title'], documents)) {
        if (typeof row.Id === 'string' && typeof row.Title === 'string' && row.Title !== '') {
          titles.set(recordKey(row.Id), row.Title);
        }
      }
    } catch {
      // Unread, each file is named by its id.
    }
    return new Map(
      [...byRecord].map(([record, attached]) => [
        record,
        attached.map((document) => ({
          key: recordKey(document),
          name: titles.get(recordKey(document)) ?? document,
        })),
      ]),
    );
  }

  /**
   * Hold, among `candidates`, the rows the platform will not delete under a
   * record past Draft (`LOCKED_PAST_DRAFT`) — an activated order's items and
   * actions, an activated contract's item prices — held by that record's
   * object, and no longer holding it in turn.
   *
   * Read as the object's turn comes: the removal has set to Draft by then
   * every order of the run it deletes, so one still past Draft stays — held
   * for records that stay, changed since the run, one the org would not set
   * to Draft, or one the run did not create. An activated contract of the
   * run's that the removal takes goes as it stands, its item prices with it
   * (`DELETED_PAST_DRAFT`). Unread, the rows are sent, and the org's refusal
   * says why they stay.
   */
  private async lockedPastDraft(
    objectApiName: string,
    candidates: readonly string[],
    verdict: HeldVerdict,
  ): Promise<void> {
    for (const [parentObject, locked] of Object.entries(LOCKED_PAST_DRAFT)) {
      const lookup = locked.find((rows) => rows.object === objectApiName)?.lookup;
      const lifecycle = STATUS_LIFECYCLES[parentObject];
      if (!lookup || !lifecycle) continue;
      const categories = await this.statusCategoriesOf(lifecycle);
      if (!categories) continue;
      let rows: Array<Record<string, unknown>>;
      let parents: Array<Record<string, unknown>>;
      try {
        rows = await readRecordsById(this.org, objectApiName, [lookup], candidates);
        const parentIds = [
          ...new Set(
            rows.map((row) => row[lookup]).filter((id): id is string => typeof id === 'string'),
          ),
        ];
        parents =
          parentIds.length > 0
            ? await readRecordsById(this.org, parentObject, ['Status'], parentIds)
            : [];
      } catch {
        continue;
      }
      const pastDraft = new Set(
        parents
          .filter((row) => {
            const category = categories.categoryOf.get(String(row.Status));
            return category !== undefined && category !== 'Draft';
          })
          .map((row) => recordKey(String(row.Id))),
      );
      for (const row of rows) {
        const parent = row[lookup];
        if (typeof row.Id !== 'string' || typeof parent !== 'string') continue;
        if (!pastDraft.has(recordKey(parent))) continue;
        this.hold(verdict, recordKey(row.Id));
        verdict.holders.add(parentObject);
        this.lockedUnder.set(recordKey(row.Id), recordKey(parent));
      }
    }
  }

  /** A lifecycle's statuses, each with its category, read once per removal. */
  private statusCategoriesOf(lifecycle: string): Promise<StatusCategories | undefined> {
    let categories = this.statuses.get(lifecycle);
    if (!categories) {
      categories = statusCategories(queryOf(this.org), lifecycle);
      this.statuses.set(lifecycle, categories);
    }
    return categories;
  }

  /**
   * Hold, among the price book entries `candidates`, the standard prices a
   * custom price that stays needs: of the same product — under the same
   * selling model, and in the same currency, where the org keeps them. The
   * org refuses such a standard price, and says only `UNKNOWN_EXCEPTION`.
   *
   * A custom price among the candidates stays when it is held itself; the
   * others are deleted first (`deleteRounds`). Unread, the standard prices are
   * sent, and the org's refusal says why they stay.
   */
  private async standardPricesHeld(
    candidates: readonly string[],
    verdict: HeldVerdict,
  ): Promise<void> {
    try {
      const query = queryOf(this.org);
      const standard = [...(await standardPriceIds(query, candidates))];
      if (standard.length === 0) return;
      const fields = await this.priceKeyFields();
      const own = await readRecordsById(this.org, PRICEBOOK_ENTRY_OBJECT, fields, standard);
      const prices = await this.pricesOfProducts(own, fields);
      const priceIds = prices.flatMap((price) => (typeof price.Id === 'string' ? [price.Id] : []));
      const standardPrices = new Set([...(await standardPriceIds(query, priceIds))].map(recordKey));
      const deleting = new Set(candidates.map(recordKey));
      const needed = new Set<string>();
      for (const price of prices) {
        if (typeof price.Id !== 'string') continue;
        const key = recordKey(price.Id);
        if (standardPrices.has(key)) continue;
        const stays = deleting.has(key)
          ? verdict.held.has(key)
          : this.stays(price, PRICEBOOK_ENTRY_OBJECT, true);
        if (stays) needed.add(valuesKey(price, fields));
      }
      for (const row of own) {
        if (typeof row.Id !== 'string' || !needed.has(valuesKey(row, fields))) continue;
        this.hold(verdict, recordKey(row.Id));
        verdict.holders.add(PRICEBOOK_ENTRY_OBJECT);
      }
    } catch {
      // Unread: see above.
    }
  }

  /**
   * Hold, among the selling model options `candidates`, the ones an active
   * price that stays is sold under: of the same product, under the same
   * selling model. The org refuses such an option — "this combination of
   * product and product selling model is associated with an active price
   * book entry". Unread, the options are sent, and the org's refusal says why
   * they stay.
   */
  private async sellingModelOptionsHeld(
    candidates: readonly string[],
    verdict: HeldVerdict,
  ): Promise<void> {
    const fields = [PRICEBOOK_ENTRY_PRODUCT_FIELD, PRICEBOOK_ENTRY_SELLING_MODEL_FIELD];
    try {
      const options = await readRecordsById(
        this.org,
        SELLING_MODEL_OPTION_OBJECT,
        fields,
        candidates,
      );
      const prices = await this.pricesOfProducts(options, [...fields, 'IsActive']);
      const sold = new Set(
        prices
          .filter(
            (price) =>
              typeof price.Id === 'string' &&
              price.IsActive === true &&
              this.stays(price, PRICEBOOK_ENTRY_OBJECT, true),
          )
          .map((price) => valuesKey(price, fields)),
      );
      for (const option of options) {
        if (typeof option.Id !== 'string' || !sold.has(valuesKey(option, fields))) continue;
        this.hold(verdict, recordKey(option.Id));
        verdict.holders.add(PRICEBOOK_ENTRY_OBJECT);
      }
    } catch {
      // Unread: see above.
    }
  }

  /**
   * What a standard price answers to a custom price by: their product, and
   * their selling model and currency where the org keeps them — a custom price
   * needs the standard price of its own (`dedupePricebookEntries`).
   */
  private async priceKeyFields(): Promise<string[]> {
    const described = describedObjectSchema.parse(await this.org.describe(PRICEBOOK_ENTRY_OBJECT));
    const kept = new Set(described.fields.map((field) => field.name));
    return [
      PRICEBOOK_ENTRY_PRODUCT_FIELD,
      ...[PRICEBOOK_ENTRY_SELLING_MODEL_FIELD, PRICEBOOK_ENTRY_CURRENCY_FIELD].filter((field) =>
        kept.has(field),
      ),
    ];
  }

  /**
   * Every price, in any book, of the products `rows` name, with `fields`. A
   * read that fills its limit throws: what it left unread could hold anything.
   */
  private async pricesOfProducts(
    rows: ReadonlyArray<Record<string, unknown>>,
    fields: readonly string[],
  ): Promise<Array<Record<string, unknown>>> {
    const products = [
      ...new Set(
        rows
          .map((row) => row[PRICEBOOK_ENTRY_PRODUCT_FIELD])
          .filter((id): id is string => typeof id === 'string'),
      ),
    ];
    const columns = [...new Set(['Id', ...fields])].map(assertSoqlIdentifier).join(', ');
    const prices: Array<Record<string, unknown>> = [];
    for (const list of idLists(products, PRODUCTS_PER_PRICE_READ)) {
      const answer = await this.org.query(
        `SELECT ${columns} FROM ${PRICEBOOK_ENTRY_OBJECT} ` +
          `WHERE ${PRICEBOOK_ENTRY_PRODUCT_FIELD} IN (${list}) LIMIT ${DEPENDENTS_READ_LIMIT}`,
      );
      if (answer.records.length >= DEPENDENTS_READ_LIMIT) {
        throw new Error('More prices than one read takes.');
      }
      for (const record of answer.records) {
        if (typeof record === 'object' && record !== null) {
          prices.push(record as Record<string, unknown>);
        }
      }
    }
    return prices;
  }

  /**
   * Whether a dependent record stays in the org once the removal is through.
   *
   * One of the run's own stays when its object has been through the removal
   * and it is still there — kept, or refused — or when the removal will keep
   * it. Any other record read with its dates:
   *
   * - one from before the run always stays: the run never made it, someone
   *   moved it under a record the run did;
   * - one created while the run went and not modified since came with the
   *   run — a person account's contact, a task a flow opened on insert — and
   *   goes with it;
   * - one added or modified since the run stays, unless the request includes
   *   what changed since the run. Editing a cloned record adds records of its
   *   own — a tracked change in its feed — and a request that asks for the
   *   changed records back out means those too.
   *
   * What the platform adds on its own to a record of the run comes with the
   * run, whatever its date: see `PLATFORM_ADDED`; and what the user a removal
   * of the run ran as created while it went — this one, or an earlier one —
   * is that removal's doing, as is the last change of a record created while
   * the run went that such a user made while it went. What a granted sweep
   * found made for the run goes too (`automationMade`). An object that keeps
   * no created and modified dates is read by its system stamp; one that keeps
   * no date at all stays.
   *
   * A record that has the org refuse the delete of the one it points at,
   * rather than go with it, stays whatever its dates, unless it is the run's.
   * One the removal is told goes with its parent (`goesWithParent`) goes.
   *
   * A person account's own contact is the account's other half: the org
   * creates, deletes and brings it back with its account, never on its own.
   * It goes with its account whatever its creation date, unless changed
   * since the run. Read by its dates as any contact, one older than the run
   * kept its account: a rewind brought back from the recycle bin a person
   * account deleted since, its contact with it, and could then neither delete
   * it again nor have its undo send it back.
   *
   * @param object - The record's object.
   * @param restricted - Whether the org refuses the delete of the record it
   *   points at over it.
   * @param personContacts - Whether the record is a contact read under its
   *   account in an org with person accounts.
   * @param asked - Set `onlyIncluded` when the record goes only because the
   *   request includes what was added or changed since the run: someone's,
   *   not the run's, taken along all the same; and `byRemoval` when it goes
   *   as what a removal of the run made.
   */
  private stays(
    row: Record<string, unknown>,
    object: string,
    restricted = false,
    personContacts = false,
    asked?: StaysAsked,
  ): boolean {
    const key = recordKey(row.Id as string);
    const {
      runRecords,
      reached,
      runStart,
      runEnd,
      removalStart,
      removalUser,
      earlierRemovals,
      includeChanged,
    } = this.context;
    if (runRecords.has(key)) return reached.has(key) || this.context.stays(key);
    if (restricted) return true;
    // What a granted sweep found made for the run goes with the record it
    // hangs from, whatever its dates: the sweep deletes it anyway.
    if (this.context.automationMade?.has(key) === true) return false;
    if (this.context.goesWithParent?.(row, runEnd) === true) return false;
    // Set to Draft by this removal, it holds that write's date, not a change.
    if (this.context.alongToDraft?.has(key) === true) return false;
    if (PLATFORM_ADDED[object]?.cameWithRun(row, runRecords)) return false;
    if (personContacts && row[PERSON_ACCOUNT_FLAG] === true) {
      // A date that cannot be read cannot show the contact was left alone.
      const modified = epochOf(row.LastModifiedDate ?? row.SystemModstamp);
      return !(modified <= runEnd) && !includeChanged;
    }
    const dated =
      'CreatedDate' in row ? 'CreatedDate' : 'SystemModstamp' in row ? 'SystemModstamp' : undefined;
    if (!dated) return true;
    const created = epochOf(row[dated]);
    const modified = epochOf(dated === 'CreatedDate' ? row.LastModifiedDate : row.SystemModstamp);
    // A date that cannot be read cannot show the record came with the run.
    if (!(created >= runStart)) return true;
    // Made as the run wrote — as this part went, or the later part that
    // linked to it — and last written then: the run's, as the record it hangs
    // from. One made between the parts is someone's, the run's user's too.
    const linked = this.context.linkedLater?.get(key);
    if (linked && (created <= runEnd || created >= linked.start) && modified <= linked.end) {
      return false;
    }
    // Created once this removal was under way, by the user it runs as: the
    // org answering what the removal did. Deleting an opportunity's line
    // items changes its amount, and feed tracking records the change on the
    // opportunity — which, read as added since the run, kept the opportunity,
    // and its account and price book behind it. So does what the org created
    // while an earlier removal of the run went, as the user it ran as: one
    // cancelled right after the line items left that tracked change, and on a
    // sandbox the next removal kept the opportunity for it. A record someone
    // else created meanwhile — a colleague's task, an integration's contact —
    // is theirs: taken for the removal's, it went with its parent, unreported.
    const creator = typeof row.CreatedById === 'string' ? recordKey(row.CreatedById) : undefined;
    /** Whether `user` wrote at `at` as a removal of the run: this one, or one before it. */
    const asRemoval = (user: string | undefined, at: number): boolean =>
      user !== undefined &&
      ((user === removalUser && at >= removalStart) ||
        earlierRemovals.some(
          (earlier) => user === earlier.user && at >= earlier.start && at <= earlier.end,
        ));
    if (asRemoval(creator, created)) {
      if (asked) asked.byRemoval = true;
      return false;
    }
    if (modified <= runEnd) return false;
    // Created while the run went and last modified by a removal of it, as
    // its user, while that removal went: the org's answer to what the
    // removal deleted, not a change since the run. Deleting a quote line of
    // the run had the platform delete the line item it was paired with, and
    // clear and restamp the line it had copied from that item: read as
    // changed since the run, the copy kept its quote. Who last modified a
    // record is all the org says: one someone changed in between, then a
    // removal restamped, reads the same.
    const modifier =
      typeof row.LastModifiedById === 'string' ? recordKey(row.LastModifiedById) : undefined;
    if (created <= runEnd && asRemoval(modifier, modified)) return false;
    // Taken along unsaid, a contact made by hand under an account of a load
    // went with the account a removal including changes deleted, and the
    // removal said "Contact: 4 deleted of 4", the four the load wrote.
    if (includeChanged && asked) asked.onlyIncluded = true;
    return !includeChanged;
  }

  /** The org's objects a person works with, read once per removal. */
  private workedObjects(): Promise<ReadonlyMap<string, string>> {
    this.worked ??= workedObjects(this.org);
    return this.worked;
  }
}
