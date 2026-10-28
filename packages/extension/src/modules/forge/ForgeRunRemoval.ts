import * as z from 'zod';
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
import {
  DELETED_PAST_DRAFT,
  LOCKED_PAST_DRAFT,
  STATUS_LIFECYCLES,
  standardPriceIds,
  statusCategories,
  type SoqlQuery,
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
import { BulkApiExecutor, type BulkApiConnection } from '../../core/engine/BulkApiExecutor.js';
import { BulkApiManager } from '../../core/engine/BulkApiManager.js';

/** Reasons kept per object: an org repeats the same few. */
const REASON_LIMIT = 5;

/**
 * Records of one object past which a removal deletes them through a Bulk API
 * 2.0 `delete` job rather than in calls of {@link RECORDS_PER_CALL}. A job
 * waits its turn in the org before it deletes anything: on a scratch org,
 * 2 000 contacts went in 8.6 seconds by ten calls and in 25.6 by one job, 24
 * of them waiting for the org; 6 000 took some 30 seconds either way; 12 000
 * went in 33 seconds as one job, where calls take about 52. Past ten
 * thousand, a job is the quicker, and its seven calls — opened, sent, closed,
 * polled, read back three times — stand for the fifty a removal sent before.
 */
export const BULK_DELETE_THRESHOLD = 10_000;

/**
 * Records one delete job holds at most. A removal is stopped between two
 * jobs, never within one the org has, so a job of a whole table held a stop
 * for as long as the org took to delete it; fifty thousand records is about a
 * minute and a half at the pace a scratch org deleted them, and every job
 * past the first saves the wait the org makes it start with.
 */
export const BULK_DELETE_JOB_RECORDS = 50_000;

/**
 * Reads of a Bulk API 2.0 job's results once it is through: its successful,
 * failed and unprocessed records, each a call of its own.
 */
export const BULK_RESULT_READS = 3;

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
 * The dates a read of dependents asks for, tried in turn, with who created
 * the record where the object keeps both dates: an object that has neither
 * `CreatedDate` nor `LastModifiedDate` may still keep a system stamp, and one
 * that keeps none is read without dates.
 */
const DEPENDENT_DATE_COLUMNS: readonly (readonly string[])[] = [
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

/**
 * The code the org refuses a delete with while other records still hang from
 * the one deleted — "associated with the following opportunities", "some
 * opportunities of this account were closed won". A record refused with it is
 * tried again for as long as a round of tries takes something more; one the
 * org refuses with any other code, once.
 */
const DEPENDENCY_REFUSAL = 'DELETE_FAILED';

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

/**
 * The objects whose records never go by a Bulk API job, however many: a
 * file's version, deleted by its document (`deleteVersions`); and a file,
 * which a rewind deletes over REST alone — a job of files was never tried on
 * an org, and 10,000 files go in 50 calls.
 */
const NEVER_BY_JOB: ReadonlySet<string> = new Set([FILE_VERSION, FILE]);

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
 * What a Bulk API 2.0 delete job answered: per record, in the order of the
 * ids it was sent, deleted or the org's error (`sf__Error`, `CODE:message:fields`);
 * or that it was aborted before the org had it; or that the org deleted none
 * of them — the job could not be handed over, an object the Bulk API does not
 * take, or it failed whole before it processed a record — which leaves them
 * to be deleted over REST, which answers each one.
 *
 * Each says how many calls the job sent the org (`requests`): opened, its CSV
 * sent, closed or aborted, each read of its state, its results read three
 * ways. The org counts each against its daily requests, and the records none
 * (asked live: a job of 200 deletes cost five). Absent from an answer that
 * does not say, which counts as one.
 */
export type BulkDeleteAnswer = (
  | { kind: 'answered'; rows: ReadonlyArray<{ success: true } | { success: false; error: string }> }
  | { kind: 'aborted' }
  | { kind: 'untouched'; reason: string }
) & { requests?: number };

/**
 * Delete `ids` of one object through one Bulk API 2.0 `delete` job, as
 * {@link RemovalOrg.bulkDestroy} says: the CSV of their ids, the job's
 * results read back and matched to them by the `Id` each row echoes
 * (`normalizeBulkJobResults`). A row no result names is answered with why.
 *
 * Whatever fails before the job is closed — opened, sent — leaves the org
 * holding nothing to process, and so does a job that failed with no record
 * processed: `untouched`. A failure once it is closed throws, as the org may
 * have deleted any of its records.
 */
export async function bulkDeleteJob(
  connection: BulkApiConnection,
  objectApiName: string,
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<BulkDeleteAnswer> {
  let closed = false;
  /** The job's last state, and its message, as the org last told it. */
  let last: { state?: string; message?: string } = {};
  /** Rows the job's results answer, written or refused: none, and it processed nothing. */
  let processed = 0;
  /** The calls the job sent the org, each one of its daily requests. */
  let requests = 0;
  const sent = <T>(calls: number, call: () => Promise<T>): Promise<T> => {
    requests += calls;
    return call();
  };
  // The job, told what the org did with it: jsforce's handle, as the executor drives it.
  const tracked: BulkApiConnection = {
    bulk2: {
      createJob: (options) => {
        const job = connection.bulk2.createJob(options);
        return {
          get id() {
            return job.id;
          },
          open: () => sent(1, () => job.open()),
          uploadData: (csv) => sent(1, () => job.uploadData(csv)),
          close: async () => {
            await sent(1, () => job.close());
            closed = true;
          },
          abort: () => sent(1, () => job.abort()),
          check: async () => {
            const status = await sent(1, () => job.check());
            last = { state: status.state, message: status.errorMessage };
            return status;
          },
          getAllResults: async () => {
            // Its successful, failed and unprocessed records: three reads.
            const results = await sent(BULK_RESULT_READS, () => job.getAllResults());
            processed = Array.isArray(results)
              ? results.length
              : (results.successfulResults?.length ?? 0) + (results.failedResults?.length ?? 0);
            return results;
          },
        };
      },
    },
  };
  let result: Awaited<ReturnType<BulkApiExecutor['executeBulk']>>;
  try {
    result = await new BulkApiExecutor().executeBulk(
      // One job at a time, and nothing else of the removal's own shares them.
      { connection: tracked, bulkManager: new BulkApiManager(1), ...(signal ? { signal } : {}) },
      objectApiName,
      // A delete sends the records to the recycle bin, as a REST delete does.
      'delete',
      ids.map((Id) => ({ Id })),
    );
  } catch (err: unknown) {
    if (!closed) return { kind: 'untouched', reason: extractErrorMessage(err), requests };
    throw err;
  }
  if (result.aborted) return { kind: 'aborted', requests };
  if (last.state !== 'JobComplete' && processed === 0) {
    return {
      kind: 'untouched',
      reason: last.message || `job ${last.state ?? 'not complete'}`,
      requests,
    };
  }
  const byRow = new Map(result.outcomes.map((outcome) => [outcome.recordIndex, outcome]));
  return {
    kind: 'answered',
    requests,
    rows: ids.map((_, at) => {
      const outcome = byRow.get(at);
      if (outcome?.success) return { success: true };
      return { success: false, error: outcome?.error ?? 'The job gave no result for it.' };
    }),
  };
}

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
      bulkDeleteJob(conn as unknown as BulkApiConnection, objectApiName, ids, signal),
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
   * sweep stops the removal before its first write.
   */
  sweep?: () => Promise<boolean>;
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
   * Read the run's records as the removal reads them before its first write —
   * what is still in the org, in its recycle bin or nowhere, what changed
   * since the run and who changed it, which objects the user may not delete —
   * and stop there, writing nothing: what it would do is said per object
   * (`RunRemovalOutcome.preview`). The sweep is not made and `onUndeletable`
   * is not asked. What hangs from the records, which a real removal reads at
   * each object's turn, record by record, is not read: a record kept for
   * records that stay is counted with those it would delete.
   */
  previewOnly?: boolean;
}

/**
 * What a removal would do with one object's records, read before its first
 * write (`RunRemovalOptions.previewOnly`). Every record of the object is
 * counted once: `toDelete`, `alreadyGone`, `keptChanged`, `undeletable`,
 * `notVisible` and `unread` add up to `planned`.
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
  /** In the org and modified since the run ended, by the org's clock, by anyone. */
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
  span: Pick<RunRemovalOptions, 'runStartedAt' | 'runEndedAt' | 'runDurationMs' | 'runRecordedAt'>;
  /** What its earlier removals stamped: see {@link RunRemovalOptions.removalStamps}. */
  removalStamps?: Readonly<Record<string, string>>;
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
 */
function withNotReached(
  objects: ForgeUndoObjectResult[],
  plan: ReadonlyArray<{ readonly objectApiName: string; readonly count: number }>,
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
    objects.push({ ...new ObjectRemoval(objectApiName, count).result, notReached: count });
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

/** One row of a delete's answer, or an update's. */
const writeResultSchema = z
  .object({
    success: z.boolean(),
    errors: z
      .array(
        z.union([
          z
            .object({
              statusCode: z.string().optional(),
              errorCode: z.string().optional(),
              message: z.string().optional(),
            })
            .loose(),
          z.string(),
        ]),
      )
      .optional(),
  })
  .loose();

type WriteError = NonNullable<z.infer<typeof writeResultSchema>['errors']>[number];

/** A record by its first fifteen characters: the same record, whichever length its id is written in. */
function recordKey(id: string): string {
  return id.slice(0, 15);
}

/** Whether a query was refused for a column its object does not have. */
function isMissingColumn(err: unknown): boolean {
  const code = (err as { errorCode?: unknown } | null)?.errorCode;
  return code === 'INVALID_FIELD' || /no such column/i.test(extractErrorMessage(err));
}

/** A date the org wrote, in epoch milliseconds; NaN when there is none to read. */
function epochOf(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : Number.NaN;
}

/** The code of a write's error, whichever name the answer gave it. */
function codeOf(error: WriteError): string | undefined {
  return typeof error === 'string' ? undefined : (error.statusCode ?? error.errorCode);
}

/** One error of a write, as the org said it: `CODE: message`. */
function describeError(error: WriteError): string {
  if (typeof error === 'string') return error;
  const code = codeOf(error);
  const message = error.message ?? '';
  return code && message ? `${code}: ${message}` : code || message || 'The org gave no reason.';
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

  constructor(objectApiName: string, planned: number) {
    this.result = {
      objectApiName,
      planned,
      deleted: 0,
      alreadyGone: 0,
      keptChanged: 0,
      keptDependents: 0,
      refused: 0,
      heldBy: [],
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
    const reasons = [
      ...(this.notVisibleNote ? [this.notVisibleNote] : []),
      ...this.notes,
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
 * The rest are deleted {@link RECORDS_PER_CALL} at a time. A record the org
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
  const records = isRunRecords(plan) ? plan : runRecordsOf(plan);
  const total = records.objects.reduce((sum, object) => sum + object.count, 0);
  const stopped = (): boolean => options.signal?.aborted === true;
  /** Every record handed over, left where it is: a removal stopped before it wrote. */
  const untouched = (): RunRemovalOutcome => ({
    objects: withNotReached([], records.objects),
    cancelled: true,
    gone: [],
    stamps: {},
    left: () => everyRecordOf(records),
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
  const session: RemovalOrg = {
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
  const order = await removalOrder(session, records.objects);
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
  const stampedBefore = new Map(
    Object.entries(options.removalStamps ?? {}).map(([id, date]) => [recordKey(id), epochOf(date)]),
  );
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
        const unchanged = modified <= runEnd || modified <= (stampedBefore.get(key) ?? Number.NaN);
        if (!unchanged) changed.add(key);
      }
    }
  }
  // The preview ends here, every record read and nothing written: what the
  // removal goes on to read — the run's other parts, what hangs from each
  // record — is read for its writes.
  if (options.previewOnly === true) {
    if (stopped()) return untouched();
    const preview = await previewOf(session, records, order, {
      snapshots,
      changed,
      undeletable: undeletableNames,
      includeChanged: options.includeChanged,
      stopped,
    });
    if (!preview) return untouched();
    return {
      ...(undeletable.length > 0 ? { undeletable } : {}),
      objects: [],
      cancelled: false,
      gone: [],
      stamps: {},
      left: () => everyRecordOf(records),
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
  });

  if (stopped()) return untouched();
  // The sweep, once what changed since the run has been read: a roll-up its
  // deletes recalculate stamps a record of the run as modified, which that
  // reading, taken before, never takes for a change. Swept first, on a
  // Developer Edition whose accounts count their opportunities, the sweep
  // took the opportunity created under a cloned account during the run, and
  // the removal kept the account as changed since the run.
  if (options.sweep && (await options.sweep())) wrote = true;

  const removals: ObjectRemoval[] = [];
  const removalOf = (objectApiName: string): ObjectRemoval | undefined =>
    removals.find((removal) => removal.result.objectApiName === objectApiName);
  /**
   * Of the records of `objects`, a page at a time, those `keep` keeps, told
   * each record with whether the removal took it — deleted it, or found it
   * gone.
   */
  async function* recordsWhere(
    objects: ReadonlyArray<{ objectApiName: string }>,
    keep: (objectApiName: string, id: string, gone: boolean) => boolean,
  ): AsyncGenerator<ForgeRunObjectRecords> {
    for (const { objectApiName } of objects) {
      const removal = removalOf(objectApiName);
      let place = 0;
      for await (const page of records.pages(objectApiName)) {
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
    recordsWhere(order, (objectApiName, id, gone) => {
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
          removal = new ObjectRemoval(objectApiName, planned?.count ?? 0);
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
    const gone: string[] = [];
    if (!isRunRecords(plan)) {
      for await (const { ids } of recordsWhere(order, (_object, _id, taken) => taken)) {
        for (const id of ids) gone.push(id);
      }
    }
    const settled = removals.map((removal) => removal.settle());
    return {
      ...(undeletable.length > 0 ? { undeletable } : {}),
      objects: cancelled ? withNotReached(settled, order) : settled,
      cancelled,
      gone,
      left: () => recordsWhere(records.objects, (_object, _id, taken) => !taken),
      stamps,
      ...(span ? { span } : {}),
      ...(otherPartStamps.length > 0 ? { otherPartStamps } : {}),
    };
  };
  // Stopped during the sweep: none of the run's records goes, and what the
  // sweep left on them is said for the next removal.
  if (stopped()) return wrote ? outcome(true) : untouched();
  const drafting = await backToDraft(
    session,
    dependents,
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
  );
  drafted = drafting.drafted;
  if (drafting.cancelled) return outcome(true);
  let settled = 0;
  for (const { objectApiName, count } of order) {
    if (stopped()) return outcome(true);
    const removal = new ObjectRemoval(objectApiName, count);
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
    const gathers =
      session.bulkDestroy !== undefined &&
      !NEVER_BY_JOB.has(objectApiName) &&
      count >= BULK_DELETE_THRESHOLD;
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
  for (let round = 0, progress = true; progress; round++) {
    progress = false;
    for (const removal of removals) {
      const again = round === 0 ? removal.refusedSent() : [];
      const waiting =
        round > 0
          ? removal.waiting()
          : again.length > 0 || deletedAny
            ? [...again, ...removal.held]
            : [];
      if (waiting.length === 0) continue;
      if (stopped()) return outcome(true);
      const deletedBefore = removal.result.deleted;
      const takenUp = new Set(again);
      const cancelledPart = await removeCandidates(session, dependents, removal, waiting, {
        stopped,
        onSent: (batch) => {
          for (const id of batch) if (takenUp.has(id)) removal.secondTry.add(id);
        },
      });
      for (const id of removal.held) if (takenUp.has(id)) removal.secondTry.add(id);
      if (cancelledPart) return outcome(true);
      if (removal.result.deleted > deletedBefore) progress = true;
    }
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
async function previewOf(
  org: RemovalOrg,
  records: RunRecords,
  order: ReadonlyArray<{ readonly objectApiName: string; readonly count: number }>,
  reading: PreviewReading,
): Promise<RunRemovalPreview | undefined> {
  const objects: RemovalPreviewObject[] = [];
  const modifiers = new Set<string>();
  for (const { objectApiName, count } of order) {
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
      reasons: [],
    };
    objects.push(object);
    const snapshot = reading.snapshots.get(objectApiName);
    if (!snapshot || snapshot.error !== undefined) {
      object.unread = count;
      object.reasons.push(snapshot?.error ?? 'The org gave no reason.');
      continue;
    }
    const changedIds: string[] = [];
    for await (const page of records.pages(objectApiName)) {
      for (const id of page) {
        const key = recordKey(id);
        if (snapshot.missing.has(key)) {
          if (snapshot.binned.has(key)) object.alreadyGone++;
          else object.notVisible++;
        } else if (reading.undeletable.has(objectApiName)) {
          object.undeletable++;
        } else if (reading.changed.has(key)) {
          object.changedSince++;
          changedIds.push(id);
          if (reading.includeChanged) object.toDelete++;
          else object.keptChanged++;
        } else {
          object.toDelete++;
        }
      }
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

/** What reading back the records the org refused to delete found. */
export interface ReadBack {
  /**
   * The ones the org no longer holds that the session had read before their
   * delete: a parent deleted after them took them along.
   */
  gone: string[];
  /**
   * The ones the read could not settle: all of them when it failed, and one
   * it no longer finds that the session had never read — gone, or out of the
   * session's sight. Not checked: never taken for gone.
   */
  unchecked: string[];
  /** Why the read failed, when it did. */
  failure?: string;
}

/**
 * Of the records the org refused to delete, the ones it no longer holds: a
 * parent deleted after them took them along. Read back by their ids. Shared by
 * the removal of a run's records and a reload's purge, which both delete
 * children before their parents.
 *
 * A record the read does not find is gone only if the session read it before
 * its delete: one the session cannot see — kept from it by sharing, or owned
 * by a user whose records it does not reach — comes back from a query no more
 * than a deleted one, and taken for gone, it was counted so while it stayed in
 * the org. One the session never read is not checked, and so is every one of
 * them when the read fails.
 *
 * @param stillThere - Reads the records of `refused` the org holds now.
 * @param seen - Whether the session read a record before its delete.
 */
export async function takenAlong(
  refused: readonly string[],
  stillThere: (ids: readonly string[]) => Promise<ReadonlyArray<Record<string, unknown>>>,
  seen: (id: string) => boolean,
): Promise<ReadBack> {
  if (refused.length === 0) return { gone: [], unchecked: [] };
  let rows: ReadonlyArray<Record<string, unknown>>;
  try {
    rows = await stillThere(refused);
  } catch (err: unknown) {
    return { gone: [], unchecked: [...refused], failure: extractErrorMessage(err) };
  }
  const still = new Set(rows.map((row) => recordKey(String(row.Id))));
  const missing = refused.filter((id) => !still.has(recordKey(id)));
  return { gone: missing.filter(seen), unchecked: missing.filter((id) => !seen(id)) };
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
 * The plan's objects in the order their records can go: each one after every
 * other object of the plan whose records point at it, and otherwise in the
 * order given. Where objects point at each other, the order given decides,
 * and what the org refuses for it is tried again once the rest is gone.
 *
 * Read from the child relationships the org lists for each object: which
 * objects hold a lookup to it. An object the org cannot describe keeps its
 * place.
 */
export async function removalOrder<T extends { readonly objectApiName: string }>(
  org: RemovalOrg,
  plan: readonly T[],
): Promise<T[]> {
  const inPlan = new Set(plan.map((object) => object.objectApiName));
  /** Per object, the objects of the plan it points at. */
  const pointsAt = new Map<string, Set<string>>();
  for (const { objectApiName } of plan) {
    let children: string[];
    try {
      const described = describedObjectSchema.parse(await org.describe(objectApiName));
      children = (described.childRelationships ?? []).map((r) => r.childSObject);
    } catch {
      continue;
    }
    for (const child of children) {
      if (child === objectApiName || !inPlan.has(child)) continue;
      const parents = pointsAt.get(child) ?? new Set<string>();
      parents.add(objectApiName);
      pointsAt.set(child, parents);
    }
  }
  const remaining = [...plan];
  const ordered: T[] = [];
  while (remaining.length > 0) {
    const free = remaining.findIndex(
      (object) =>
        !remaining.some(
          (other) =>
            other !== object && pointsAt.get(other.objectApiName)?.has(object.objectApiName),
        ),
    );
    ordered.push(...remaining.splice(free >= 0 ? free : 0, 1));
  }
  return ordered;
}

/** A SOQL query of the org, answering its rows. */
function queryOf(org: RemovalOrg): SoqlQuery {
  return async (soql) => {
    const answer = await org.query(soql);
    return answer.records.filter(
      (row): row is Record<string, unknown> => typeof row === 'object' && row !== null,
    );
  };
}

/** A record {@link backToDraft} set to Draft, and the status it had. */
interface Drafted {
  objectApiName: string;
  id: string;
  /** The Draft status it was set to. */
  draft: string;
  /** The status it had, and gets back if it stays in the org. */
  status: string;
}

/**
 * Those of `objects` whose records past Draft a removal sets back to Draft
 * before it deletes them ({@link backToDraft}), and gives back their status
 * when it keeps them: what fires on their update fires then too.
 */
export function setBackToDraftOf(objects: readonly string[]): string[] {
  return objects.filter(
    (objectApiName) =>
      STATUS_LIFECYCLES[objectApiName] !== undefined && !DELETED_PAST_DRAFT.has(objectApiName),
  );
}

/**
 * Return to a Draft status, before anything is deleted, the run's records of
 * an object with a status lifecycle — an order — that are past Draft and set
 * to go. A contract is left as it stands: the org deletes an activated one,
 * and would not set it back to Draft (`DELETED_PAST_DRAFT`).
 *
 * An activated order keeps its products and itself from being deleted —
 * "unable to modify activated order" — and a clone now writes orders back as
 * the source held them, activated ones included. The Frozen purge learnt it
 * first. Only a record the removal means to delete is touched: one it keeps,
 * changed since the run or held for a record that stays, is left as it is. A
 * refusal here shows again, with its reason, as the delete that follows.
 *
 * Which records stay is only known once the deletes are through — an item the
 * org refuses holds its order — so each record set to Draft is handed back
 * with the status it had, for {@link putBackStatuses}. Stopped, it sets
 * nothing more.
 *
 * @param goes - Whether the record is still in the org and not kept as changed.
 */
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

async function backToDraft(
  org: RemovalOrg,
  dependents: DependentsCheck,
  order: ReadonlyArray<{ readonly objectApiName: string }>,
  records: RunRecords,
  goes: (objectApiName: string, id: string) => boolean,
  stopped: () => boolean,
): Promise<{ drafted: Drafted[]; cancelled: boolean }> {
  const query = queryOf(org);
  const drafted: Drafted[] = [];
  for (const { objectApiName } of order) {
    const lifecycle = STATUS_LIFECYCLES[objectApiName];
    if (!lifecycle || DELETED_PAST_DRAFT.has(objectApiName)) continue;
    /** The object's statuses, read once its first page holds a record to set back. */
    let categories: StatusCategories | undefined;
    for await (const page of records.pages(objectApiName)) {
      const candidates = page.filter((id) => goes(objectApiName, id));
      if (candidates.length === 0) continue;
      if (stopped()) return { drafted, cancelled: true };
      categories ??= await statusCategories(query, lifecycle);
      const known = categories;
      const draft = known?.draft;
      if (!known || !draft) break;
      const { held } = await dependents.heldAmong(objectApiName, candidates);
      let rows: Array<Record<string, unknown>>;
      try {
        rows = await readRecordsById(org, objectApiName, ['Status'], candidates);
      } catch {
        continue;
      }
      const pastDraft = rows
        .filter((row) => typeof row.Id === 'string' && !held.has(recordKey(row.Id)))
        .filter((row) => {
          const category = known.categoryOf.get(String(row.Status));
          return category !== undefined && category !== 'Draft';
        })
        .map((row) => ({ objectApiName, id: String(row.Id), draft, status: String(row.Status) }));
      for (let at = 0; at < pastDraft.length; at += RECORDS_PER_CALL) {
        if (stopped()) return { drafted, cancelled: true };
        const batch = pastDraft.slice(at, at + RECORDS_PER_CALL);
        // Kept before the call: an update the org applied without answering is
        // put back all the same.
        drafted.push(...batch);
        try {
          await org.update(
            objectApiName,
            batch.map(({ id }) => ({ Id: id, Status: draft })),
          );
        } catch {
          // Shown again by the delete.
        }
      }
    }
  }
  return { drafted, cancelled: false };
}

/** How {@link putBackStatuses} says what it did. */
interface PutBackHooks {
  /**
   * Say something of an object's records on its result.
   *
   * @param failed - Whether a record of it was left in Draft.
   */
  note: (objectApiName: string, reason: string, failed: boolean) => void;
}

/**
 * Give each record {@link backToDraft} set to Draft that the removal leaves in
 * the org — kept, refused, or not reached — the status it had, and say so on
 * its object, whether the org took it back or not.
 *
 * Set to Draft before any delete, an order was then held by an item the org
 * refused, or refused itself, or the removal was cancelled before its turn:
 * it stayed in the org deactivated, and nothing said so. A record the removal
 * set to Draft and someone changed since is left as they left it. What this
 * leaves on the records, a later removal is told by {@link stampsLeft}.
 */
async function putBackStatuses(
  org: RemovalOrg,
  drafted: readonly Drafted[],
  hooks: PutBackHooks,
): Promise<void> {
  const objects = [...new Set(drafted.map((record) => record.objectApiName))];
  for (const objectApiName of objects) {
    const records = drafted.filter((record) => record.objectApiName === objectApiName);
    const byKey = new Map(records.map((record) => [recordKey(record.id), record]));
    const ids = records.map((record) => record.id);
    let rows: Array<Record<string, unknown>>;
    try {
      rows = await readRecordsById(org, objectApiName, ['Status'], ids);
    } catch (err: unknown) {
      hooks.note(
        objectApiName,
        `Status set to ${records[0].draft} for the delete, and not read back to be restored: ${extractErrorMessage(err)}`,
        true,
      );
      continue;
    }
    const inDraft = rows.flatMap((row) => {
      const record = typeof row.Id === 'string' ? byKey.get(recordKey(row.Id)) : undefined;
      return record && row.Status === record.draft ? [record] : [];
    });
    for (let at = 0; at < inDraft.length; at += RECORDS_PER_CALL) {
      const batch = inDraft.slice(at, at + RECORDS_PER_CALL);
      let answer: unknown;
      try {
        answer = await org.update(
          objectApiName,
          batch.map(({ id, status }) => ({ Id: id, Status: status })),
        );
      } catch (err: unknown) {
        answer = batch.map(() => ({ success: false, errors: [extractErrorMessage(err)] }));
      }
      const answered = Array.isArray(answer) ? answer : [answer];
      batch.forEach(({ draft, status }, index) => {
        const row = writeResultSchema.safeParse(answered[index]);
        if (row.success && row.data.success) {
          hooks.note(
            objectApiName,
            `Status set to ${draft} for the delete, then back to ${status}.`,
            false,
          );
          return;
        }
        const errors = row.success ? (row.data.errors ?? []) : [];
        const reason = errors.length > 0 ? describeError(errors[0]) : 'The org gave no reason.';
        hooks.note(
          objectApiName,
          `Status set to ${draft} for the delete, and left there: the org refused ${status} back — ${reason}`,
          true,
        );
      });
    }
  }
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
    const { end } = runSpan(part.span, [], orgAheadMs);
    const stamped = new Map(
      Object.entries(part.removalStamps ?? {}).map(([id, date]) => [recordKey(id), epochOf(date)]),
    );
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
            if (modified <= end || modified <= (stamped.get(key) ?? Number.NaN)) {
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

/** One delete of a removal: a call of up to {@link RECORDS_PER_CALL} records, or a job. */
interface DeleteRound {
  ids: string[];
  /** Sent as a Bulk API 2.0 delete job rather than over REST. */
  byJob: boolean;
}

/** `ids` cut into calls of {@link RECORDS_PER_CALL}. */
function callsOf(ids: readonly string[]): DeleteRound[] {
  const calls: DeleteRound[] = [];
  for (let at = 0; at < ids.length; at += RECORDS_PER_CALL) {
    calls.push({ ids: ids.slice(at, at + RECORDS_PER_CALL), byJob: false });
  }
  return calls;
}

/**
 * The deletes `ids` of one object go in: every custom price before any
 * standard one, which the org refuses while a custom price of its product is
 * left — `UNKNOWN_EXCEPTION` when both went in one call. Each such group of
 * {@link BULK_DELETE_THRESHOLD} records or more goes as jobs of up to
 * {@link BULK_DELETE_JOB_RECORDS}, where the org takes jobs; the rest in calls
 * of {@link RECORDS_PER_CALL}. A file's version is deleted by its document,
 * read first (`deleteVersions`), and a file over REST: never by a job
 * ({@link NEVER_BY_JOB}).
 */
async function deleteRounds(
  org: RemovalOrg,
  objectApiName: string,
  ids: string[],
): Promise<DeleteRound[]> {
  const rounds: DeleteRound[] = [];
  const byJob = org.bulkDestroy !== undefined && !NEVER_BY_JOB.has(objectApiName);
  const cut = (list: string[]): void => {
    if (!byJob || list.length < BULK_DELETE_THRESHOLD) {
      rounds.push(...callsOf(list));
      return;
    }
    // Jobs of one size: 50 500 records go as two of 25 250, not as one of
    // 50 000 and one of 500 that costs as long.
    const size = Math.ceil(list.length / Math.ceil(list.length / BULK_DELETE_JOB_RECORDS));
    for (let at = 0; at < list.length; at += size) {
      rounds.push({ ids: list.slice(at, at + size), byJob: true });
    }
  };
  if (!isPricebookEntry(objectApiName) || ids.length === 0) {
    cut(ids);
    return rounds;
  }
  let standard = new Set<string>();
  try {
    standard = new Set([...(await standardPriceIds(queryOf(org), ids))].map(recordKey));
  } catch {
    // Unread, the prices go as they come: the retry takes what is refused.
  }
  cut(ids.filter((id) => !standard.has(recordKey(id))));
  cut(ids.filter((id) => standard.has(recordKey(id))));
  return rounds;
}

/** How {@link removeCandidates} reports as it goes. */
interface CandidateHooks {
  stopped: () => boolean;
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
  hooks.onHeld?.(heldNow.length);

  const toDelete = candidates.filter((id) => !verdict.held.has(recordKey(id)));
  const queue = await deleteRounds(org, objectApiName, toDelete);
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const { ids: batch, byJob } = next;
    if (hooks.stopped()) return true;
    // Named before the delete: a file seen through its record may be out of
    // the session's reach once the record is gone.
    const files = await dependents.filesOn(batch);
    const answer = byJob
      ? await deleteByJob(org, objectApiName, batch)
      : await deleteBatch(org, objectApiName, batch);
    // Aborted before the org had it: nothing of it was deleted.
    if (answer === 'aborted') return true;
    // The org deleted none of them by the job: they go over REST, which
    // answers each one, before anything after them.
    if (answer === 'untouched') {
      queue.unshift(...callsOf(batch));
      continue;
    }
    const outcomes = answer;
    batch.forEach((id, index) => {
      const result = outcomes[index];
      if (result.kind === 'refused') {
        removal.refused.set(id, {
          reason: result.reason,
          dependency: result.dependency,
          sent: true,
        });
        return;
      }
      removal.refused.delete(id);
      const key = recordKey(id);
      const place = hooks.placeOf?.get(key);
      if (place !== undefined) removal.goneAt.add(place);
      else removal.goneLater.add(key);
      if (result.kind === 'deleted') {
        removal.result.deleted++;
        if (place === undefined) removal.deletedLater.add(key);
        for (const file of files.get(key) ?? []) {
          removal.filesLeft.set(file.key, file.name);
        }
      } else removal.result.alreadyGone++;
    });
    hooks.onSent?.(batch);
    hooks.onDeleted?.(batch.length);
  }
  return false;
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
        if (created) snapshot.firstCreated = earliest(snapshot.firstCreated, epochOf(row[created]));
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

/**
 * Of the records of one object a read did not find, those the org's recycle
 * bin holds, by key: deleted. The rest are out of the session's sight — kept
 * from it by sharing, or owned by a user whose records it does not reach — or
 * deleted for good, as the org deletes some objects. Why the bin could not be
 * read, when it could not: then none of them is taken for gone.
 */
async function recycleBinOf(
  org: RemovalOrg,
  objectApiName: string,
  ids: readonly string[],
): Promise<{ deleted: Set<string> } | { error: string }> {
  const object = assertSoqlIdentifier(objectApiName);
  const deleted = new Set<string>();
  try {
    for (const list of idLists(ids)) {
      const answer = await org.queryDeleted(
        `SELECT Id FROM ${object} WHERE Id IN (${list}) AND IsDeleted = true`,
      );
      for (const row of answer.records) {
        const id = (row as { Id?: unknown } | null)?.Id;
        if (typeof id === 'string') deleted.add(recordKey(id));
      }
    }
  } catch (err: unknown) {
    return { error: extractErrorMessage(err) };
  }
  return { deleted };
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
 * Without that time, or from an org that does not tell its clock, the span
 * runs from the first record's `CreatedDate` for as long as the run took:
 * late rather than early, as the run's first write came after it started.
 *
 * @param orgAheadMs - How far the org's clock runs ahead of this machine's.
 */
function runSpan(
  options: Pick<
    RunRemovalOptions,
    'runStartedAt' | 'runEndedAt' | 'runDurationMs' | 'runRecordedAt'
  >,
  snapshots: Iterable<ObjectSnapshot>,
  orgAheadMs: number,
): { start: number; end: number } {
  let firstCreated = Number.NaN;
  for (const snapshot of snapshots) firstCreated = earliest(firstCreated, snapshot.firstCreated);
  const duration = options.runDurationMs ?? 0;
  const recordedOnOrg = (options.runRecordedAt?.getTime() ?? Number.NaN) + orgAheadMs;
  if (options.runEndedAt === undefined && Number.isFinite(recordedOnOrg)) {
    const began = recordedOnOrg - duration - CLOCK_LEEWAY_MS;
    return {
      start: options.runStartedAt?.getTime() ?? (firstCreated > began ? firstCreated : began),
      end: recordedOnOrg + CLOCK_LEEWAY_MS,
    };
  }
  const start = options.runStartedAt?.getTime() ?? firstCreated;
  const end = options.runEndedAt?.getTime() ?? start + duration;
  return { start, end };
}

/** What a delete did to one record. */
export type DeleteOutcome =
  { kind: 'deleted' } | { kind: 'gone' } | { kind: 'refused'; reason: string; dependency: boolean };

/**
 * Delete one batch and say what became of each record: deleted, already gone
 * — deleted since it was read, often along with a parent — or refused, with
 * the org's reason. A call the org refuses whole refuses every record of it.
 */
export async function deleteBatch(
  org: RemovalOrg,
  objectApiName: string,
  batch: readonly string[],
): Promise<DeleteOutcome[]> {
  if (objectApiName === FILE_VERSION) return deleteVersions(org, batch);
  let answer: unknown;
  try {
    answer = await org.destroy(objectApiName, [...batch]);
  } catch (err: unknown) {
    const reason = extractErrorMessage(err);
    return batch.map(() => ({ kind: 'refused', reason, dependency: false }));
  }
  const rows = Array.isArray(answer) ? answer : [answer];
  return batch.map((_, index): DeleteOutcome => {
    const row = writeResultSchema.safeParse(rows[index]);
    if (row.success && row.data.success) return { kind: 'deleted' };
    const errors = row.success ? (row.data.errors ?? []) : [];
    if (errors.some((error) => codeOf(error) === 'ENTITY_IS_DELETED')) return { kind: 'gone' };
    return {
      kind: 'refused',
      reason: errors.length > 0 ? describeError(errors[0]) : 'The org gave no reason.',
      dependency: errors.some((error) => codeOf(error) === DEPENDENCY_REFUSAL),
    };
  });
}

/**
 * Delete one job's worth of records through the org's Bulk API 2.0 and say
 * what became of each, in the words a delete over REST gives it: deleted;
 * already gone — `ENTITY_IS_DELETED`, deleted since it was read; or refused
 * with the org's reason, `CODE: message` as {@link describeError} writes it,
 * and refused for records still hanging from it on `DELETE_FAILED`, tried
 * again as such. A job the org answered with an error that throws refuses
 * every record of it, as a call the org refuses whole does: the org may have
 * deleted any of them, and the second try reads which.
 *
 * @returns The outcomes; `aborted` when the stop came before the org had the
 *   job; `untouched` when it deleted none of them, for REST to take them.
 */
async function deleteByJob(
  org: RemovalOrg,
  objectApiName: string,
  batch: readonly string[],
): Promise<DeleteOutcome[] | 'aborted' | 'untouched'> {
  let answer: BulkDeleteAnswer | undefined;
  try {
    answer = await org.bulkDestroy?.(objectApiName, batch);
  } catch (err: unknown) {
    const reason = extractErrorMessage(err);
    return batch.map(() => ({ kind: 'refused', reason, dependency: false }));
  }
  if (answer === undefined || answer.kind === 'untouched') return 'untouched';
  if (answer.kind === 'aborted') return 'aborted';
  const { rows } = answer;
  return batch.map((_, at): DeleteOutcome => {
    const row = rows[at];
    if (row?.success === true) return { kind: 'deleted' };
    const { code, message } = bulkErrorOf(row?.error ?? '');
    if (code === 'ENTITY_IS_DELETED') return { kind: 'gone' };
    return {
      kind: 'refused',
      reason:
        code && message
          ? `${code}: ${message}`
          : row?.error || code || message || 'The org gave no reason.',
      dependency: code === DEPENDENCY_REFUSAL,
    };
  });
}

/**
 * The code and message of an error as Bulk API writes it in `sf__Error`:
 * `CODE:message:fields`, the fields `--` when it names none. An error the job
 * wrote of a row it gave no result for carries no code.
 */
function bulkErrorOf(text: string): { code?: string; message: string } {
  const match = /^([A-Z][A-Z0-9_]*):([\s\S]*?)(?::(?:--|[\w.,]+))?$/.exec(text.trim());
  if (!match) return { message: text.trim() };
  return { code: match[1], message: match[2].trim() };
}

/**
 * Delete the file versions `batch` names by deleting their documents, and say
 * what became of each version: the org deletes no version on its own — its
 * describe says it is not deletable — and a run keeps a version alone when it
 * was stopped before it read the version's document back (`copyFiles`). A
 * version the org no longer holds went with its document.
 */
async function deleteVersions(org: RemovalOrg, batch: readonly string[]): Promise<DeleteOutcome[]> {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await readRecordsById(org, FILE_VERSION, ['ContentDocumentId'], batch);
  } catch (err: unknown) {
    const reason = extractErrorMessage(err);
    return batch.map(() => ({ kind: 'refused', reason, dependency: false }));
  }
  const documentOf = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.Id === 'string' && typeof row.ContentDocumentId === 'string') {
      documentOf.set(recordKey(row.Id), row.ContentDocumentId);
    }
  }
  const documents = [...new Set(documentOf.values())];
  const outcomes = documents.length > 0 ? await deleteBatch(org, FILE, documents) : [];
  const byDocument = new Map(documents.map((document, at) => [document, outcomes[at]]));
  return batch.map((id): DeleteOutcome => {
    const document = documentOf.get(recordKey(id));
    if (document === undefined) return { kind: 'gone' };
    return (
      byDocument.get(document) ?? {
        kind: 'refused',
        reason: 'The org gave no answer for its document.',
        dependency: false,
      }
    );
  });
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
}

/** What {@link DependentsCheck.heldAmong} found for some records of one object. */
interface HeldVerdict {
  /** Keys of the records that records staying in the org depend on. */
  held: Set<string>;
  /** The objects whose staying records hold them, by API name. */
  holders: Set<string>;
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
   */
  async heldAmong(objectApiName: string, candidates: readonly string[]): Promise<HeldVerdict> {
    const verdict: HeldVerdict = { held: new Set(), holders: new Set(), unchecked: new Set() };
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
      candidates.forEach((id) => verdict.held.add(recordKey(id)));
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
    for (const { relationship, holding, unchecked } of await inPool(
      reads,
      DEPENDENT_READS_AT_ONCE,
    )) {
      if (unchecked) verdict.unchecked.add(relationship.childSObject);
      if (holding.size > 0) verdict.holders.add(relationship.childSObject);
      holding.forEach((key) => verdict.held.add(key));
    }
    await this.lockedPastDraft(objectApiName, candidates, verdict);
    if (isPricebookEntry(objectApiName)) await this.standardPricesHeld(candidates, verdict);
    if (objectApiName === SELLING_MODEL_OPTION_OBJECT) {
      await this.sellingModelOptionsHeld(candidates, verdict);
    }
    return verdict;
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
   * @returns The keys held, and whether the relationship could not be read.
   */
  private async holdingIn(
    relationship: DependentRelationship,
    chunk: readonly string[],
  ): Promise<{ holding: Set<string>; unchecked: boolean }> {
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
    const first = this.datesKept.get(child) ?? 0;
    for (let tried = first; tried < DEPENDENT_DATE_COLUMNS.length; tried++) {
      const dates = DEPENDENT_DATE_COLUMNS[tried];
      let answer: { records: unknown[] };
      try {
        answer = await this.org.query(
          `SELECT ${[...columns, ...dates].join(', ')} FROM ${child} ` +
            `WHERE ${field} IN (${list}) LIMIT ${DEPENDENTS_READ_LIMIT}`,
        );
      } catch (err: unknown) {
        // A column the object does not have, never one that failed by chance.
        if (isMissingColumn(err)) this.datesKept.set(child, tried + 1);
        continue;
      }
      // A read that filled its limit may hold more than it read: every
      // record of the chunk is kept rather than guessed about.
      if (answer.records.length >= DEPENDENTS_READ_LIMIT) {
        return { holding: new Set(chunk.map(recordKey)), unchecked: false };
      }
      const holding = new Set<string>();
      for (const record of answer.records) {
        if (typeof record !== 'object' || record === null) continue;
        const row = record as Record<string, unknown>;
        const parent = row[relationship.field];
        if (typeof parent !== 'string' || typeof row.Id !== 'string') continue;
        if (child === FILE_LINK && field === 'LinkedEntityId') this.noteFile(row);
        // Locked under this very record, the row stays because the record does.
        if (this.lockedUnder.get(recordKey(row.Id)) === recordKey(parent)) continue;
        if (this.stays(row, child, relationship.restricted, relationship.personContacts)) {
          holding.add(recordKey(parent));
        }
      }
      return { holding, unchecked: false };
    }
    return { holding: new Set(), unchecked: !relationship.restricted };
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
        verdict.held.add(recordKey(row.Id));
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
        verdict.held.add(recordKey(row.Id));
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
        verdict.held.add(recordKey(option.Id));
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
   * is that removal's doing. An object that keeps no created and modified
   * dates is read by its system stamp; one that keeps no date at all stays.
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
   */
  private stays(
    row: Record<string, unknown>,
    object: string,
    restricted = false,
    personContacts = false,
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
    if (this.context.goesWithParent?.(row, runEnd) === true) return false;
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
    const byRemoval =
      creator !== undefined &&
      ((creator === removalUser && created >= removalStart) ||
        earlierRemovals.some(
          (earlier) =>
            creator === earlier.user && created >= earlier.start && created <= earlier.end,
        ));
    if (byRemoval) return false;
    if (modified <= runEnd) return false;
    return !includeChanged;
  }

  /** The org's objects a person works with, read once per removal. */
  private workedObjects(): Promise<ReadonlyMap<string, string>> {
    this.worked ??= workedObjects(this.org);
    return this.worked;
  }
}
