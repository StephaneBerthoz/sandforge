/**
 * Batch writer stage of the Forge execution pipeline.
 *
 * Splits a node's cleaned records into batches (REST/Bulk strategy),
 * dispatches them to the target org via insert — or upsert on an external
 * Id field when `upsertMode: 'auto'` applies — registers the new
 * source→target ID mappings, links rows the target refused because it
 * already holds them to the record it named, writes again without them the
 * rows a validation rule, a restricted picklist or the lookup filter of a
 * lookup the target lets be empty refused on fields it named, and without its
 * owner a row the target refused for holding that owner inactive, up to three
 * rounds a row — and sends without it from the start a row holding a picklist
 * value the target refused under the same record type earlier in the run, or
 * an owner it refused as inactive earlier in the run —
 * sends again, after a wait, a call that never reached the target and the
 * rows it could not lock a record for, stops at a call whose answer was lost
 * and says which rows the target may hold, collects per-record failure
 * samples, and queues nullified cycle FKs for the pass-2 UPDATE.
 *
 * A run that writes through the Bulk API (`WriteNodeInput.bulk`) sends each
 * call of {@link FORGE_BULK_MIN_ROWS} rows or more as a Bulk API 2.0 job
 * instead (`forgeBulkWrite`), and every other call — and every row a job could
 * not answer for itself — by REST as before. A row a job's chunk was refused
 * for a limit goes again by REST, a record on its own first, then in calls
 * half as large, out of the same allowance; the jobs of its object still to
 * send go by REST at the size kept, as far as the allowance pays each of
 * their calls.
 *
 * A call the target's automation refuses for a Salesforce limit — a trigger
 * that runs a query per record passes the 100 a transaction allows on a call
 * of 200, and the whole call is rolled back — has the rows it refused so sent
 * again, at once and in place, a record on its own first, then in calls half
 * as large, down to one record (`sendSplittingOnLimits`): the size that went
 * through is kept for the rest of the run on that object and operation, and
 * the calls it costs come out of the run's allowance (`LimitSplitting`, the
 * run's, which its second pass shares). A row still refused sent on its own,
 * kept from smaller calls because records of its object sent on their own
 * were refused too, or by a spent allowance, fails with the org's message and
 * a sentence that says which. A call that threw is never sent again.
 *
 * Pause/abort is honored before each call through the `waitIfPaused`
 * checkpoint injected by the executor.
 */

import type {
  ExecutionErrorSample,
  FieldInfo,
  ForgeExecutorDeps,
  ForgeProgressEvent,
  InsertResult,
} from '../ForgeExecutor.js';
import type { ForgeFieldRefusal, ForgeGraphNode } from '@sandforge/shared';
import {
  SELLING_MODEL_OPTION_OBJECT,
  isAlreadyExistsError,
  limitCauseOf,
  type GovernorLimitCause,
} from '@sandforge/shared';
import { codeAndMessage, existingRecordOf } from '../../../core/common/existingRecordMatch.js';
import { extractErrorMessage } from '../../../core/common/extractErrorMessage.js';
import {
  BULK_CHUNK,
  FULL_CALL_SIZE,
  allowedFor,
  limitNoteText,
  limitSplitting,
  sendSplittingOnLimits,
  type CallKey,
  type LimitNote,
  type LimitSplitting,
  type SmallerCalls,
  type SplitRun,
} from '../../../core/common/governorLimit.js';
import {
  INACTIVE_OWNER_REFUSAL,
  LOOKUP_FILTER_REFUSAL,
  RESTRICTED_PICKLIST_REFUSAL,
  addWrittenWithoutFields,
  heldKeyOf,
  inactiveOwnerNamed,
  refusedFields,
  refusedOnNoField,
  without,
  type FieldToLeaveOut,
  type WrittenWithoutFields,
} from '../../../core/common/refusedFields.js';
import { whatTheWriteLeft, type ThrownWrite } from '../../../core/common/thrownWrite.js';
import type { BulkApiManager } from '../../../core/engine/BulkApiManager.js';
import { buildBulkCsv } from '../../../core/engine/bulkCsv.js';
import { RetryStrategy } from '../../../core/engine/RetryStrategy.js';
import {
  ACCOUNT_CONTACT_RELATION,
  ACTIVITY_OF_RELATION,
  FLAGS_THE_PLATFORM_LEAVES,
  NATURAL_KEYS,
  directAccountContactRelations,
  existingActivityRelations,
  existingSellingModelOptions,
  recordsByNaturalKey,
  relationsLeftWithoutTheirFlags,
  withFlagsNotKept,
  type FlagsNotKept,
} from '../../../core/common/platformRecords.js';
import { logger } from '../../../logger.js';
import {
  FORGE_BULK_MIN_ROWS,
  ForgeBatchStrategy as ForgeBatchStrategyService,
} from '../ForgeBatchStrategy.js';
import type { ResolvedBatchStrategy } from '../ForgeBatchStrategy.js';
import {
  BulkJobLostError,
  FORGE_BULK_JOB_MAX_BYTES,
  FORGE_BULK_JOB_ROWS,
  type BulkRowState,
  type BulkWriteAnswer,
} from '../forgeBulkWrite.js';
import type { CleanedRecord } from './RecordCleaner.js';
import type { OwedAtInsert } from '../ForgeRunStore.js';
import type { PicklistField } from './RecordTypePicklists.js';
import type { IdRemapper } from '../IdRemapper.js';

// Shared with Frozen's loader, which writes a refused row again on the same
// rules; the stages of the clone read them from here.
export {
  addWrittenWithoutFields,
  without,
  writtenWithoutFieldsNote,
  type FieldToLeaveOut,
  type WrittenWithoutFields,
} from '../../../core/common/refusedFields.js';

/**
 * Maximum records each write API accepts in a single call.
 *
 * `rest` is the REST sObject Collections endpoint (`conn.sobject(x).create`
 * / `.upsert`), hard-capped at 200 records per call by Salesforce; `bulk`
 * is Bulk API 2.0 ingest.
 */
export const WRITE_API_MAX_BATCH: Readonly<Record<ResolvedBatchStrategy['api'], number>> = {
  rest: 200,
  bulk: 10_000,
};

/*
 * The transport is chosen call by call, never for a node as a whole.
 *
 * `composition/forgeComposition.ts` wires `insertRecords` and `upsertRecords`
 * onto `conn.sobject(name).create/upsert` — REST sObject Collections, 200
 * records a call — and, for a run that writes through the Bulk API,
 * `bulkWriteRecords` onto a Bulk API 2.0 job. The strategy returns
 * `api: 'bulk'` + `batchSize: 10_000` as soon as a node holds more than 200
 * records, but no run but one that sends jobs (`WriteNodeInput.bulk`) has one
 * to send: posting 10 000 records to the 200-record endpoint failed every
 * object above the threshold, and the batch size is derived from the
 * transport `resolveWriteBatching` settles on, never from the strategy alone.
 * A batch cut for a job that ends up under `FORGE_BULK_MIN_ROWS` rows — the
 * rest of an object past its jobs, a write the org refused as a job — still
 * goes by REST, in calls of 200.
 */

/**
 * Times a call is sent again when what it threw proves it never reached the
 * target — no connection, no address for its host, the edge's word that the
 * org is unavailable: the target holds none of its rows, so none can be
 * written twice. See `whatTheWriteLeft`.
 */
const RESENDS_OF_AN_UNREACHED_CALL = 3;

/**
 * Times a row is sent again that the target refused for a record it could not
 * lock (`UNABLE_TO_LOCK_ROW`). A call commits each of its rows on its own
 * (`allOrNone` false), so a row refused so was not written: another
 * transaction held the lock past the ten seconds the platform waits for one.
 */
const RESENDS_OF_A_LOCKED_ROW = 3;

/** The code the target refuses a row with when it could not lock a record the write needed. */
const LOCK_REFUSAL = 'UNABLE_TO_LOCK_ROW';

/**
 * Rounds a row goes again without the fields the target refused it on: a
 * refusal on another field, once the first are left out, gets a round of its
 * own — a contact refused for its phone by one rule, then for its title by
 * another.
 */
const ROUNDS_WITHOUT_FIELDS = 3;

/** The wait before the first of those sends: doubled before each next one, up to half of it left to chance. */
const RESEND_DELAY_MS = 2_000;

/** Wait `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Batch size and count for the transport {@link BatchWriter} actually calls.
 *
 * Honors a strategy that asks for *smaller* batches, clamps one that asks for
 * more than the write API accepts. No record, no batch: held to one batch at
 * least, a node that read no rows — or whose every row the target already
 * held — made an insert call with nothing in it.
 *
 * A node goes in Bulk API jobs only when the run sends jobs and may send this
 * object as one (`transport.bulk`), the strategy asks for them, and it holds
 * {@link FORGE_BULK_MIN_ROWS} rows or more; by REST otherwise, whatever the
 * strategy asked.
 *
 * @param planned - What {@link ForgeBatchStrategyService.resolve} proposed.
 * @param recordCount - Records to write for this node.
 * @param transport - Whether the run may send this node's rows as Bulk API
 *   jobs: not unless told, as the plan counts its calls.
 * @returns The API really used, the clamped batch size/count, and whether the
 *   planned size had to be reduced.
 */
export function resolveWriteBatching(
  planned: ResolvedBatchStrategy,
  recordCount: number,
  transport: { readonly bulk: boolean } = { bulk: false },
): {
  api: ResolvedBatchStrategy['api'];
  batchSize: number;
  batchCount: number;
  clamped: boolean;
} {
  const api: ResolvedBatchStrategy['api'] =
    transport.bulk && planned.api === 'bulk' && recordCount >= FORGE_BULK_MIN_ROWS
      ? 'bulk'
      : 'rest';
  const batchSize = Math.min(planned.batchSize, WRITE_API_MAX_BATCH[api]);
  return {
    api,
    batchSize,
    batchCount: Math.ceil(recordCount / batchSize),
    clamped: batchSize < planned.batchSize,
  };
}

/** Records inserted with nullified cycle FKs — patched in pass 2. */
export interface PendingFkUpdate {
  objectApiName: string;
  /** Target Id of the freshly-inserted record (the one to UPDATE). */
  newId: string;
  /** Source-org Id of the record (carried for triage on errors). */
  sourceId: string | undefined;
  fieldName: string;
  sourceRefId: string;
  /**
   * Set when only an insert sets the field in the target: never sent, the
   * platform refusing the update, and said to be left empty once its record
   * is written. See `NullifiedFk.insertOnly`.
   */
  insertOnly?: true;
}

/**
 * What the upsert of a node written a page at a time matches by, over all its
 * pages: see {@link WriteNodeInput.tableKeys}.
 */
export interface TableUpsertKeys {
  /**
   * The external ids every row the run reads of the node holds a value of,
   * none of them twice: the key is the first of them the writer would pick.
   */
  readonly unique: ReadonlySet<string>;
  /** The values of that key the node's pages have sent by upsert so far. */
  readonly sent: Set<string>;
}

/** Inputs for {@link BatchWriter.writeNode}. */
export interface WriteNodeInput {
  /** The graph node being written. */
  node: ForgeGraphNode;
  /**
   * Final insert-ready payloads (post RecordType translation and
   * anonymization), index-aligned with `cleanedRecords`.
   */
  records: Record<string, unknown>[];
  /**
   * Cleaned records carrying the source record + nullified FKs, used for
   * the source-ID lookup so remapper entries point at the correct origin
   * record and for pass-2 cycle FK patching.
   */
  cleanedRecords: CleanedRecord[];
  /** Source-org field metadata for the node (external Id detection). */
  fieldInfos: FieldInfo[];
  /** Effective createable set (upsert key must be createable). */
  creatableFields: ReadonlySet<string>;
  /** Insert vs upsert behaviour for this execution. */
  upsertMode: 'auto' | 'off';
  /**
   * For a node written a page at a time, the external ids its upsert may match
   * by, judged on every row the run reads of it before its first page.
   * Picked on one page's rows, two pages could pick two keys, or a key one
   * page holds once and a later one holds again: the second upsert matches the
   * record the first created and writes over it, two source records left as
   * one. The key is then the same on every page, and a page whose rows, as
   * written, leave a value of it empty, hold one twice, or hold one an earlier
   * page sent, is inserted. Absent, the key is picked on the rows handed.
   */
  tableKeys?: TableUpsertKeys;
  /** ID of the target Salesforce org. */
  targetOrgId: string;
  /**
   * Key prefix of the node's object in the target org, when the describe
   * gave one. An id a refusal names must carry it to be linked to: a unique
   * index is per object, so an id of anything else is not the record.
   */
  targetKeyPrefix?: string | null;
  /**
   * What the target's describe says of the object's picklist fields. A value
   * of one the target refused under a record type is not sent again in the
   * run with that record type — unless the field depends on another, whose
   * value the refusal may hang on. Absent, no refusal is remembered.
   */
  picklistFields?: ReadonlyMap<string, PicklistField>;
  /**
   * Source→target ID mappings accumulated so far — mutated on success, and
   * for a row the target already held.
   */
  remapper: IdRemapper;
  /**
   * Where the lookups a row went in without are owed, as each call's answer
   * is counted: the run's journal, which takes them with the record that owes
   * them. Absent, they are gathered in `pendingFkUpdates` for the run to owe
   * once the node is through — a process killed before then left records in
   * the target, and their journal, with none of the lookups they owed.
   */
  oweLookups?: (updates: readonly PendingFkUpdate[]) => void;
  /**
   * Told of each row the target took, created or written over through its
   * external id, as its call's answer is counted and before it is put on
   * disk: what the record owes beside its lookups — the status of an order
   * written as a draft — is owed with it.
   */
  onWritten?: (built: CleanedRecord, targetId: string) => void;
  /**
   * Told of each row the target created that went without `RecordTypeId`, as
   * its call's answer is counted: the target gave it a record type of its
   * own, which the run reads back once it is through. A row an upsert wrote
   * over keeps the type it had, and is not told. Absent, none is.
   */
  onCreatedWithoutRecordType?: (built: CleanedRecord | undefined, targetId: string) => void;
  /**
   * Where each insert call is kept before it goes and once its answer is
   * counted: the run's journal. A process killed while a call was under way
   * left records in the target the journal did not name, and a resume wrote
   * them again; kept so, the call's rows are looked for in the target first
   * (`reconcileInFlight`). An upsert call is kept too, with the external id it
   * matches by: sent again, it matches the records it wrote, but a removal
   * read the rows of one cut short as written nowhere it could reach, and
   * left the records it had created in the target. Absent, no call is kept.
   */
  calls?: InsertCallJournal;
  /**
   * The users the run's owner mapping gives records to, by their id on
   * fifteen characters. The target refusing a row for one of them as
   * inactive leaves the row a failure, with the target's words: left out,
   * the owner the user chose would have gone to the user the run writes as.
   * Absent, the run maps no owner.
   */
  ownersMapped?: ReadonlySet<string>;
  /**
   * How the run sends its writes as Bulk API 2.0 jobs, when it does
   * (`ExecuteOptions.writeApi: 'auto'`). A call of {@link FORGE_BULK_MIN_ROWS}
   * rows or more of an object neither in `restOnly` nor in `bulkUnsupported`
   * goes as a job, through `deps.bulkWriteRecords`; every other call by REST.
   * Absent, every call goes by REST, as it always did.
   */
  bulk?: BulkTransport;
  /** Pause/abort checkpoint — called between batch iterations. */
  waitIfPaused: () => Promise<void>;
  /**
   * Whether the run was cancelled, asked before each update that gives a
   * relation linked to the flags its row carried: those go before the first
   * batch, and its checkpoint. Absent, nothing stops them.
   */
  stopped?: () => boolean;
  /** Progress sink for batch-level events. */
  onProgress: (event: ForgeProgressEvent) => void;
}

/** How a run sends its writes as Bulk API jobs: see {@link WriteNodeInput.bulk}. */
export interface BulkTransport {
  /** The run's cancel: it aborts a job still open, and nothing once the job is closed. */
  readonly signal: AbortSignal;
  /**
   * Objects the run writes by REST whatever their number: a file's content in
   * base64, an email and its task, and an object an active duplicate rule
   * watches — a job carries no duplicate-rule header. A lead or a case, when
   * the run applies the target's assignment rules, is not here: the first job
   * of one is refused by `deps.bulkWriteRecords` before anything is sent, as
   * unsupported, and the object joins `bulkUnsupported`.
   */
  readonly restOnly: ReadonlySet<string>;
  /**
   * Objects the org said, in the run, the Bulk API does not write: added to
   * as it says so, read by every node after, written by REST from then on.
   */
  readonly bulkUnsupported: Set<string>;
  /** The run's job limiter: one job at a time, the run's own. */
  readonly manager: BulkApiManager;
}

/** A row of an insert call as its journal keeps it: see {@link InsertCallJournal.sending}. */
export interface RowSent {
  sourceId: string | undefined;
  /** What it writes: fingerprinted, never kept. */
  payload: Record<string, unknown>;
  /** The lookups it goes in without, owed to the second pass once it is in. */
  owes?: readonly OwedAtInsert[];
}

/** Where a node's insert calls are kept: see {@link WriteNodeInput.calls}. */
export interface InsertCallJournal {
  /**
   * Keep the call about to go, its rows in the order sent; says its id. An
   * upsert names the external id it matches the rows by.
   */
  sending(
    objectApiName: string,
    rows: readonly RowSent[],
    upsertField?: string,
  ): string | undefined;
  /** Keep that the call's answer is counted, once what it created is registered. */
  answered(callId: string): void;
  /**
   * Keep the id the org gave the job a call is sent as, once it opened it and
   * before anything of it is closed: a run taken up reads the job back by it
   * (`reconcileInFlight`) rather than looking for its rows in the target.
   */
  opened?(callId: string, jobId: string): void;
  /**
   * Keep the ids of records a job wrote that no row of it could be matched
   * to: the run's all the same, which removing its records takes back.
   */
  unattributed?(objectApiName: string, targetIds: readonly string[]): void;
}

/** Outcome of writing one node's records. */
export interface BatchWriteResult {
  /** Records the run created: inserted, or upserted where the target held no match. */
  successCount: number;
  /**
   * Records an upsert matched by their external id and wrote over: the target
   * held them before the run, so they are counted apart from the created ones
   * and never registered as the run's own.
   */
  updatedCount: number;
  /**
   * Records the target refused because it already holds them, and named:
   * mapped onto that record so their children link to it, and never written
   * to. Neither created nor failed.
   */
  linkedExistingCount: number;
  /** Records that failed (including API-truncated results). */
  failureCount: number;
  /**
   * Of those failures, the rows the target already held. A node whose every
   * failure is one of these has not orphaned its children.
   */
  alreadyExistsCount: number;
  /**
   * Of those failures, the rows refused as duplicates without one record the
   * run could trust — `<unknown>` in place of the id, several matches. Their
   * children lose the lookup, as every duplicate's did before a refusal was
   * read for the record it names.
   */
  unidentifiedExistingCount: number;
  /** Up to 3 sampled failures (truncated to keep payloads UI-friendly). */
  errorSamples: ExecutionErrorSample[];
  /** Nullified cycle FKs of successfully inserted records — pass-2 input. */
  pendingFkUpdates: PendingFkUpdate[];
  /**
   * The relations linked to without a flag their row carried, or without a
   * field of the answer that goes with it — an invitee's status, response and
   * when it responded — counted by the field and why, for the node's line to
   * say once (`flagsNotKeptNote`): see `giveLinkedRelationsTheirFlags`.
   * Absent when all of it went back, or there was none to give.
   */
  flagsNotKept?: FlagsNotKept;
  /**
   * The rows linked to a record the platform wrote with one the run created,
   * which it deletes with that record, by source id: the direct relation of a
   * contact the run created to its account. See
   * `ExecutionSummary.withTheirRecordSourceIds`. Absent when there were none.
   */
  withTheirRecord?: string[];
  /**
   * The rows the target refused on fields it named — a validation rule, a
   * restricted picklist refusing their value, or the lookup filter of a
   * lookup it lets be empty — that went in once written again without them,
   * and those sent without a value it had refused under their record type:
   * counted among the created or updated rows too. Absent when none did.
   */
  writtenWithoutFields?: WrittenWithoutFields;
  /**
   * Of the rows written again without fields, each lookup a lookup filter of
   * the target refused, and the record that went without it, by its id in
   * the target: what a verification tells from a lookup that broke. Absent
   * when none did.
   */
  leftEmptyByFilter?: Array<{ field: string; recordId: string }>;
  /**
   * The rows of a call whose answer never came back — a timeout, a connection
   * reset once the request was out, the edge saying the org failed it — by
   * source id, in the order the call carried them: the target may hold any of
   * them, under an id the run never learned. The node stopped there, as at
   * any call that throws, and counted them failed; what the run says it
   * created, and what its removal takes back, leave them out, and the sample
   * of the call says so. Never sent again: those the target wrote would be
   * written twice. Absent when every call was answered, or failed short of
   * the target.
   */
  mayHaveBeenWritten?: string[];
}

/**
 * A row the target refused as one it already holds without naming the
 * record, for an object with a natural key: it waits for the lookup by that
 * key made once the node's calls are through.
 */
interface UnnamedDuplicate {
  /** The payload sent, which carries the key. */
  payload: Record<string, unknown>;
  /** The source id of the row. */
  sourceId: unknown;
  /** What the target refused it with. */
  errors: string[];
}

/** A refusal of a row on fields it named, and the fields it made the row go again without. */
interface RefusalOnFields {
  /** What the target refused the row with. */
  readonly errors: readonly string[];
  /** The fields it named, as the payload names them. */
  readonly leftOut: readonly FieldToLeaveOut[];
}

/**
 * One row of the node's write, as its answers leave it: what it is first sent
 * as, and what it goes again without as the target refuses it on its fields.
 */
interface RowToWrite {
  /** The payload first sent. */
  readonly payload: Record<string, unknown>;
  /** The record it was cleaned from: its source id, and the lookups it owes the second pass. */
  readonly built: CleanedRecord | undefined;
  /**
   * The fields it was first sent without, their value refused under its
   * record type earlier in the run: see `BatchWriter.withoutRefusedValues`.
   */
  readonly before: readonly FieldToLeaveOut[];
  /** Each refusal on its fields, in turn: it goes again without every field they named. */
  readonly refusals: readonly RefusalOnFields[];
  /** Times it was sent again for a record the target could not lock. */
  readonly lockResends: number;
}

/** A row the target refused for a record it could not lock, and the refusal. */
interface LockedRow {
  readonly row: RowToWrite;
  readonly errors: readonly string[];
}

/** Every field a row went again without, in the order its refusals named them. */
function leftOutOf(row: RowToWrite): FieldToLeaveOut[] {
  return row.refusals.flatMap((refusal) => refusal.leftOut);
}

/** The source id of the record a row was cleaned from. */
function sourceIdOf(row: RowToWrite): string | undefined {
  const id = row.built?.source['Id'];
  return typeof id === 'string' ? id : undefined;
}

/**
 * The lookups a row goes in without, which its answer owes the second pass
 * (`settle`): kept with the call, for a row found in the target once the
 * answer is lost.
 */
function owedBy(row: RowToWrite): OwedAtInsert[] {
  return (row.built?.nullifiedFks ?? []).map(({ field, sourceRefId, insertOnly }) => ({
    field,
    sourceRefId,
    ...(insertOnly ? { insertOnly } : {}),
  }));
}

/**
 * Whether a payload names the record type it goes in with. One that does not
 * goes without the field, and the target gives it the type it gives the user
 * the run writes as: a record on Master in the source, one a decision sends
 * to the default, one whose field the run does not write.
 */
export function carriesRecordTypeId(payload: Readonly<Record<string, unknown>>): boolean {
  const recordTypeId = payload['RecordTypeId'];
  return typeof recordTypeId === 'string' && recordTypeId !== '';
}

/** What a row is sent as now: the payload first sent, without each field refused since. */
function sentAs(row: RowToWrite): Record<string, unknown> {
  return row.refusals.length === 0 ? row.payload : without(row.payload, leftOutOf(row));
}

/** One node's write as its calls are answered: where each answer is counted. */
interface NodeWrite {
  readonly objectApiName: string;
  readonly targetOrgId: string;
  /** Key prefix of the object in the target, which an id a refusal names must carry. */
  readonly targetKeyPrefix: string | null | undefined;
  readonly remapper: IdRemapper;
  readonly tally: BatchWriteResult;
  /** Where the lookups a written row owes go as its call is answered: see `WriteNodeInput.oweLookups`. */
  readonly oweLookups: ((updates: readonly PendingFkUpdate[]) => void) | undefined;
  /** Told of each row the target took: see `WriteNodeInput.onWritten`. */
  readonly onWritten: ((built: CleanedRecord, targetId: string) => void) | undefined;
  /** Told of each row created without a record type: see `WriteNodeInput.onCreatedWithoutRecordType`. */
  readonly onCreatedWithoutRecordType:
    ((built: CleanedRecord | undefined, targetId: string) => void) | undefined;
  /** Where each insert call is kept as it goes and as it is answered: see `WriteNodeInput.calls`. */
  readonly calls: InsertCallJournal | undefined;
  /** How the run sends its writes as Bulk API jobs; absent, every call goes by REST. */
  readonly bulk: BulkTransport | undefined;
  /** Duplicates the target did not name, for an object with a natural key. */
  readonly byNaturalKey: UnnamedDuplicate[];
  /** Rows the target refused on fields it named, to write again without them. */
  readonly refusedOnTheirFields: RowToWrite[];
  /** Rows the target refused for a record it could not lock, to send again after a wait. */
  readonly locked: LockedRow[];
  /** The external id the rows are upserted by, which a row never goes without. */
  readonly upsertField: string | undefined;
  /** The users the run's owner mapping gives records to: see `WriteNodeInput.ownersMapped`. */
  readonly ownersMapped: ReadonlySet<string> | undefined;
  /**
   * The picklist fields, by their lowercased name, whose values the run
   * remembers once the target refuses them: those the target's describe
   * lists, and makes depend on no other field.
   */
  readonly remembered: ReadonlySet<string>;
  /**
   * The fields the target's describe of the object lets a row leave empty, by
   * their lowercased name: read once a lookup filter first refuses a row, as
   * what says the lookup it refused can be left out. Unread until then.
   */
  mayBeEmpty?: ReadonlySet<string>;
}

/** What a call of the node's write came back with: the target's answers. */
interface CallAnswered {
  readonly answers: InsertResult[];
  /** The call as the journal keeps it, closed once its answers are counted. */
  readonly callId?: string;
}

/** What a call of the node's write came back with when it threw, and what that left in the target. */
interface CallThrew {
  readonly thrown: unknown;
  readonly left: ThrownWrite;
  /** How many times it was sent. */
  readonly tries: number;
}

/**
 * Where a node's calls stopped when one threw: the call that threw, its rows,
 * and the rows still waiting to go after it — sent again smaller after a
 * limit, or not sent yet — which go no more.
 */
interface RestStop {
  readonly threw: CallThrew;
  readonly rows: readonly RowToWrite[];
  readonly rest: readonly RowToWrite[];
}

/**
 * How a run of rows sent by REST is priced, and whether a job's chunk refused
 * them for a limit already: see `SplitRun`.
 */
type SplitHow = Pick<SplitRun<RowToWrite, InsertResult>, 'pricedAs' | 'paid' | 'refusedIn'>;

/** What a job's chunk refused each of `rows` with for a limit, by row: none unless `how` says. */
function limitedOf(
  rows: readonly RowToWrite[],
  how: SplitHow | undefined,
): Map<RowToWrite, readonly string[]> {
  const refused = new Map<RowToWrite, readonly string[]>();
  how?.refusedIn?.answers.forEach((answer, i) => {
    const row = rows[i];
    if (answer && row) refused.set(row, answer.errors);
  });
  return refused;
}

/** No row of the call goes again: see `BatchWriter.settleAnswers`. */
const NONE_AGAIN: ReadonlySet<number> = new Set();

/** No row of the call was settled for a limit: see `BatchWriter.settleAnswers`. */
const NO_LIMIT_NOTES: ReadonlyMap<number, LimitNote> = new Map();

/** The size a write's calls are kept at: its object, and the operation whose triggers it fires. */
function callKeyOf(write: Pick<NodeWrite, 'objectApiName' | 'upsertField'>): CallKey {
  return { objectApiName: write.objectApiName, op: write.upsertField ? 'upsert' : 'insert' };
}

/**
 * The limit a refused row's answer says the target's automation hit, with the
 * trigger it names: see `limitCauseOf`. Nothing for a row written, or refused
 * for anything else.
 */
function limitOf(answer: InsertResult | undefined): GovernorLimitCause | undefined {
  return answer !== undefined && !answer.success ? limitCauseOf(answer.errors) : undefined;
}

/**
 * Said once for an object and operation, the first time a limit of the
 * target's automation refuses one of its calls: who hit what, on a call of
 * how many.
 */
function warnFirstRefusal(report: SmallerCalls): void {
  const who = report.automation ?? "the target's automation";
  logger.warn(
    `[forge] ${report.objectApiName}: ${who} hit ${report.limit ?? 'a Salesforce limit'} on a ` +
      `call of ${report.from} — sending a record on its own, then smaller calls` +
      (report.op === 'upsert' ? ' (upsert).' : '.'),
  );
}

/** What refused a field, as the line of a write that leaves it out says it. */
const REFUSER: Readonly<Record<ForgeFieldRefusal, string>> = {
  'validation-rule': 'a validation rule',
  'restricted-picklist': 'a restricted picklist',
  'lookup-filter': 'a lookup filter',
  'inactive-owner': 'the target, the owner being inactive there',
};

/**
 * What refused the fields of `leftOut`, as the line of their write without
 * them says it: the rules of the target, then the target itself when it held
 * the owner inactive, set apart by a comma as the line goes on after it.
 */
function whatRefused(leftOut: readonly FieldToLeaveOut[]): string {
  const by = new Set(leftOut.map((f) => f.refusedBy));
  const named = (Object.keys(REFUSER) as ForgeFieldRefusal[])
    .filter((refusal) => refusal !== 'inactive-owner' && by.has(refusal))
    .map((refusal) => REFUSER[refusal]);
  const said =
    named.length > 1 ? `${named.slice(0, -1).join(', ')} or ${named[named.length - 1]}` : named[0];
  const rules = said === undefined ? undefined : `${said} of the target`;
  if (!by.has('inactive-owner')) return rules ?? `${REFUSER['validation-rule']} of the target`;
  const owner = `${REFUSER['inactive-owner']},`;
  return rules === undefined ? owner : `${rules} or ${owner}`;
}

/**
 * Whether the owner a payload sends is one the run's owner mapping gives
 * (`NodeWrite.ownersMapped`): one the user chose, which a row never goes
 * without.
 */
function ownerMapped(write: NodeWrite, payload: Record<string, unknown>): boolean {
  if (!write.ownersMapped || write.ownersMapped.size === 0) return false;
  const field = heldKeyOf(payload, 'OwnerId');
  const owner = field === undefined ? undefined : payload[field];
  return typeof owner === 'string' && write.ownersMapped.has(owner.slice(0, 15));
}

/**
 * The fields to write a refused row again without, each with what refused it
 * and the refusal that named it: a validation rule's, a restricted picklist's
 * or — for a lookup the target lets be empty — a lookup filter's refusal of
 * fields the row gives a value to, on the rules of `refusedFields`. A result
 * whose details do not answer its errors one for one says less than the row
 * was refused for, and nothing is left out. A parent copied from outside the
 * graph is written again on the same rule (`OrphanExpander`), its owner kept:
 * only the node's own write (`BatchWriter.settle`) asks for an inactive
 * owner's refusal to leave the owner out.
 *
 * @param keep - A field the row cannot go without: the external id an upsert matches it by.
 * @param mayBeEmpty - Whether the target lets a row leave a field empty; without it, no lookup is left out.
 * @param options - `inactiveOwner`: whether the target holding the row's owner
 *   inactive has the row go again without it. See `refusedFields`.
 */
export function fieldsToLeaveOut(
  result: InsertResult,
  payload: Record<string, unknown>,
  keep: string | undefined,
  mayBeEmpty?: (field: string) => boolean,
  options?: { readonly inactiveOwner?: boolean },
): FieldToLeaveOut[] | undefined {
  const details = result.errorDetails ?? [];
  if (details.length !== result.errors.length) return undefined;
  return refusedFields(details, payload, keep, mayBeEmpty, options);
}

/** Whether every error the target refused a row with is its failure to lock a record the write needed. */
function refusedForALock(result: InsertResult): boolean {
  const details = result.errorDetails ?? [];
  if (details.length > 0 && details.length === result.errors.length) {
    return details.every((detail) => detail.statusCode === LOCK_REFUSAL);
  }
  return result.errors.length > 0 && result.errors.every((error) => error.startsWith(LOCK_REFUSAL));
}

/** The fields a row went again without, as a sample says them. */
function fieldList(leftOut: readonly FieldToLeaveOut[]): string {
  return leftOut.map((f) => f.field).join(', ');
}

/**
 * What the sample of a row sent again says after the second answer: what the
 * first was.
 *
 * @param firstRefusal - What the target refused the row with the first time.
 */
export function sentAgainNote(
  leftOut: readonly FieldToLeaveOut[],
  firstRefusal: readonly string[],
): string {
  return `Sent again without ${fieldList(leftOut)} after the first refusal: ${firstRefusal.join('; ')}`;
}

/** Which refusal of a row each of its rounds without fields answered: one per round. */
const NTH_REFUSAL: readonly string[] = ['first', 'second', 'third'];

/**
 * What the sample of a row sent again says of each refusal it went again
 * after: the fields that refusal made it go without, and what it said.
 */
function sentAgainNotes(refusals: readonly RefusalOnFields[]): string[] {
  return refusals.map(({ leftOut, errors }, round) =>
    round === 0
      ? sentAgainNote(leftOut, errors)
      : `Sent again without ${fieldList(leftOut)} too after the ${NTH_REFUSAL[round]} refusal: ` +
        errors.join('; '),
  );
}

/**
 * What the sample of a row first sent without what the target had refused
 * earlier in the run says: the values it refused under the row's record type,
 * then the owner it held inactive, each with which fields and the refusal.
 * Nothing for a row that went with all of its values.
 */
function sentWithoutNote(before: readonly FieldToLeaveOut[]): string[] {
  const said = (leftOut: readonly FieldToLeaveOut[], why: string): string[] =>
    leftOut.length === 0
      ? []
      : [
          `Sent without ${fieldList(leftOut)}: ${why} earlier in the run, ` +
            [...new Set(leftOut.map((f) => f.reason))].join('; '),
        ];
  return [
    ...said(
      before.filter((f) => f.refusedBy !== 'inactive-owner'),
      'the target refused the same value under the same record type',
    ),
    ...said(
      before.filter((f) => f.refusedBy === 'inactive-owner'),
      'the target refused the same owner, inactive there,',
    ),
  ];
}

/** `count` records, as a sample counts them. */
function nRecords(count: number): string {
  return `${count} record${count === 1 ? '' : 's'}`;
}

/**
 * What the sample of a call whose answer never came back says after the
 * error: what the target may hold, and what the run does not know.
 */
const MAY_HAVE_BEEN_WRITTEN =
  'The call was sent and its answer never came back: the target may hold any of these ' +
  'records, and which of them is unknown. Counted as failed and never sent again, they are ' +
  'not among the records the run created, which removing its records takes back.';

/**
 * What the sample of the rows a Bulk API job may have written without saying
 * so says after why: what the run does with them, and with what the job wrote.
 */
const MAY_HAVE_BEEN_WRITTEN_BY_A_JOB =
  'Counted as failed and never sent again, they are not among the records the run created; ' +
  "the records the job wrote that no row was matched to are, and removing the run's records " +
  'takes them back.';

/** The code a duplicate rule refuses a row with: a job carries no header that waives the rule. */
const DUPLICATE_RULE_REFUSAL = 'DUPLICATES_DETECTED';

/**
 * Whether a row of a job goes once more by REST: one the job did not answer
 * for itself — kept out as another's twin, left unprocessed — or refused by a
 * duplicate rule, which the REST call's header waives, or with an error that
 * did not read as exactly one (`forgeBulkWrite` reads one into
 * `errorDetails`). Never one the job may have written, nor one refused for a
 * limit, which goes by REST on its own way (`BatchWriter.writeAsJobs`).
 */
function goesAgainByRest(state: BulkRowState, answer: InsertResult): boolean {
  if (state === 'twin' || state === 'unprocessed') return true;
  if (state !== 'answered' || answer.success) return false;
  const details = answer.errorDetails;
  return details?.length !== 1 || details[0].statusCode === DUPLICATE_RULE_REFUSAL;
}

/**
 * The rows of a job's CSV cut into runs of `maxBytes` at most, header
 * included, as `[from, to)` pairs in order. Each cell counted at its widest —
 * quoted, its quotes doubled, an empty one sent as `#N/A` — so a run never
 * passes the bound once sent. A row wider than the bound alone is a run of
 * its own: the job refuses it, and it goes by REST.
 */
function piecesUnder(
  maxBytes: number,
  csv: { readonly columns: readonly string[]; readonly rows: readonly (readonly string[])[] },
): Array<[number, number]> {
  const widest = (cells: readonly string[]): number =>
    cells.reduce(
      (sum, cell) =>
        sum + Math.max(Buffer.byteLength(cell, 'utf8'), 4) + (cell.split('"').length - 1) + 3,
      1,
    );
  const header = widest(csv.columns);
  const pieces: Array<[number, number]> = [];
  let from = 0;
  let bytes = header;
  csv.rows.forEach((cells, i) => {
    const row = widest(cells);
    if (i > from && bytes + row > maxBytes) {
      pieces.push([from, i]);
      from = i;
      bytes = header;
    }
    bytes += row;
  });
  if (csv.rows.length > from) pieces.push([from, csv.rows.length]);
  return pieces;
}

/**
 * The order to write a node's rows in when they go as Bulk API jobs: by the
 * value of the first lookup a row cannot go without — a master-detail is one
 * — so that the rows of one parent go together. Undefined when the object
 * has none, or no row holds a value of it: the rows go as they came. The
 * owner is none of them: a user's record is not what two chunks wait on.
 */
function sortedByParent(
  fieldInfos: readonly FieldInfo[],
  creatable: ReadonlySet<string>,
  records: readonly Record<string, unknown>[],
): number[] | undefined {
  const parent = fieldInfos.find(
    (f) => f.isReference && f.nillable === false && f.name !== 'OwnerId' && creatable.has(f.name),
  )?.name;
  if (parent === undefined) return undefined;
  const valueOf = (i: number): string => {
    const value = records[i][parent];
    return typeof value === 'string' ? value : '';
  };
  if (!records.some((_, i) => valueOf(i) !== '')) return undefined;
  // Stable: rows of one parent keep the order they came in.
  return records
    .map((_, i) => i)
    .sort((a, b) => {
      const va = valueOf(a);
      const vb = valueOf(b);
      if (va === vb) return a - b;
      if (va === '') return 1;
      if (vb === '') return -1;
      return va < vb ? -1 : 1;
    });
}

/** What the sample of a call refused for the target's API request limit says after the error. */
const REQUEST_LIMIT_REACHED =
  'The target refused the call for its API request limit, which no retry gets past: the node ' +
  'stopped there.';

/**
 * What the sample of a row refused for a validation rule's error on no field
 * says after the error.
 */
const REFUSED_ON_NO_FIELD =
  'A validation rule of the target, or a trigger with its code, refused the row without naming ' +
  'a field: there was none to send it again without.';

/** A {@link BatchWriteResult} with nothing counted yet. */
export function emptyBatchWriteResult(): BatchWriteResult {
  return {
    successCount: 0,
    updatedCount: 0,
    linkedExistingCount: 0,
    failureCount: 0,
    alreadyExistsCount: 0,
    unidentifiedExistingCount: 0,
    errorSamples: [],
    pendingFkUpdates: [],
  };
}

/**
 * Writes one node's records to the target org in batches, tracking new ID
 * mappings and failure samples along the way.
 */
export class BatchWriter {
  private readonly batchStrategy: ForgeBatchStrategyService;

  /**
   * The values of restricted picklists the target refused in the run, by
   * object, the record type the row named, field and value, each with the
   * refusal: a later row of the same object holding the same value under the
   * same record type goes without it from its first call, rather than be
   * refused for it and sent again. A writer is made for a run, and keeps them
   * for it. See `refusedValueKey`.
   */
  private readonly refusedValues = new Map<string, FieldToLeaveOut>();

  /**
   * The owners the target refused in the run as inactive there, by their id
   * on fifteen characters, each with the refusal: a later row — of any object
   * — sent with the same owner goes without it from its first call, and the
   * record to the user the run writes as, rather than be refused for it and
   * sent again. Kept only of a refusal that named the row's own owner: one
   * that named no user says nothing of the next row's. Kept for the run, as
   * the values are: one inactive user may own records of a dozen objects. An
   * owner the run's owner mapping gives is never kept. See
   * `inactiveOwnerNamed`.
   */
  private readonly refusedOwners = new Map<string, FieldToLeaveOut>();

  /** How long to wait before each send of a call, or of a row, the target never had. */
  private readonly backoff = new RetryStrategy({ initialDelay: RESEND_DELAY_MS });

  /**
   * @param wait - Waits out the delay before a call, or a row, is sent again.
   * @param splitting - The size each object's calls go at once a limit of the
   *   target's automation refused one, and the smaller calls the run allows
   *   itself: the run's, shared with its second pass, so that the next node,
   *   page or round of the object goes at once at the size that went
   *   through. See `sendSplittingOnLimits`. Absent, the writer's own.
   */
  constructor(
    private readonly deps: Pick<ForgeExecutorDeps, 'insertRecords' | 'upsertRecords'> &
      Partial<
        Pick<
          ForgeExecutorDeps,
          'queryRecords' | 'updateRecords' | 'describeFields' | 'bulkWriteRecords'
        >
      >,
    batchStrategy?: ForgeBatchStrategyService,
    private readonly wait: (ms: number) => Promise<void> = sleep,
    private readonly splitting: LimitSplitting = limitSplitting(),
  ) {
    this.batchStrategy = batchStrategy ?? new ForgeBatchStrategyService();
  }

  /**
   * Batch and insert (or upsert) the node's records into the target org.
   * Emits the `running` progress events; the caller owns the terminal
   * `done`/`error` node event and the fail-fast bookkeeping.
   *
   * @param tally - Where the counts go, as each call is answered. A cancel
   *   between two calls stops the node at the checkpoint before the next one,
   *   by throwing, and the counts of the calls before were then lost with the
   *   result this never returned: the rows they created were in the remap
   *   table and missing from the run's count of what it created. Passed in,
   *   the caller keeps them whatever ends the node — and one tally takes the
   *   rounds of a node written in several. Left out, a tally of the call's own.
   */
  async writeNode(
    input: WriteNodeInput,
    tally: BatchWriteResult = emptyBatchWriteResult(),
  ): Promise<BatchWriteResult> {
    const { node, fieldInfos, creatableFields, targetOrgId, remapper } = input;
    // A contact inserted with its account gets its direct relation from the
    // platform, and the relation read from the source is that one: inserted
    // again it is refused — "the contact already has a relationship with
    // this account" — and the refusal names no record to link to. The one
    // the platform made is found instead, and linked. So is the relation it
    // wrote for a task's or an event's who as it took the activity, and a
    // selling model option of a product the target already held.
    const direct = await this.heldBeforeInsert(node.objectApiName, targetOrgId, input.records);
    for (const [index, id] of direct) {
      const source = input.cleanedRecords[index]?.source;
      const oldId = source?.['Id'];
      if (typeof oldId !== 'string') continue;
      remapper.addExisting(oldId, id, node.objectApiName);
      // The direct relation the platform wrote with a contact the run created
      // goes when the contact goes: "to remove a direct relationship between a
      // contact and an account, change the contact's primary account or
      // delete the contact".
      const contact = source?.['ContactId'];
      if (
        node.objectApiName === ACCOUNT_CONTACT_RELATION &&
        typeof contact === 'string' &&
        remapper.isCreated(contact)
      ) {
        tally.withTheirRecord = [...(tally.withTheirRecord ?? []), oldId];
      }
    }
    tally.linkedExistingCount += direct.size;
    const flagsNotKept = await this.giveFlagsBack(node.objectApiName, targetOrgId, input, direct);
    if (flagsNotKept) tally.flagsNotKept = withFlagsNotKept(tally.flagsNotKept, flagsNotKept);
    let records = input.records.filter((_, i) => !direct.has(i));
    let cleanedRecords = input.cleanedRecords.filter((_, i) => !direct.has(i));
    const planned = this.batchStrategy.resolve(node.batchStrategy, records.length);
    // The resolved `api` used to be discarded, so a node resolved to
    // 'bulk' was sliced into 10 000-record batches and handed to the REST
    // write path, which rejects anything over 200.
    const { api, batchSize, batchCount, clamped } = resolveWriteBatching(planned, records.length, {
      bulk: this.jobsCanCarry(input.bulk, node.objectApiName),
    });
    if (clamped) {
      logger.warn(
        `[forge] ${node.objectApiName}: batch strategy asked for ${planned.batchSize} records ` +
          `per call (api="${planned.api}") but the write path is "${api}" ` +
          `(max ${WRITE_API_MAX_BATCH[api]}) — using ${batchSize} per call ` +
          `(${batchCount} batch(es)).`,
      );
    }
    if (api === 'bulk') {
      // Rows under one parent go in the same job, one after the other: the
      // org processes a job in chunks, side by side, and two chunks writing
      // children of one parent wait on its lock — UNABLE_TO_LOCK_ROW once
      // the wait passes. Sorted here, as the rows are cut into batches, and
      // never as a call sends them: the rows and their records stay aligned.
      const sorted = sortedByParent(fieldInfos, creatableFields, records);
      if (sorted) {
        const unsorted = { records, cleanedRecords };
        records = sorted.map((i) => unsorted.records[i]);
        cleanedRecords = sorted.map((i) => unsorted.cleanedRecords[i]);
      }
    }

    input.onProgress({
      objectName: node.objectApiName,
      status: 'running',
      progress: 0,
      // The counts the graph could not know: for a template run they are the
      // only ones it will ever get.
      recordCount: records.length,
      fieldCount: fieldInfos.length,
      createableFieldCount: creatableFields.size,
      message: `Inserting ${records.length} ${node.objectApiName} records in ${batchCount} batch(es)...`,
    });

    let recordOffset = 0;

    // Upsert via external Id when available — re-runs patch existing
    // target rows instead of failing on DUPLICATE_VALUE. When multiple
    // ext-id fields exist (legacy ExtId__c + new MigrationKey__c), the
    // first describe-order pick may be non-unique → DUPLICATE_EXTERNAL_ID.
    // Tiebreaker: prefer fields whose values are non-null + unique in
    // the *source batch*; fall back to alphabetical for determinism.
    const upsertField = this.pickUpsertField(
      fieldInfos,
      creatableFields,
      records,
      input.upsertMode === 'auto' && this.deps.upsertRecords ? 'auto' : 'off',
      input.tableKeys,
    );
    const write: NodeWrite = {
      objectApiName: node.objectApiName,
      targetOrgId,
      targetKeyPrefix: input.targetKeyPrefix,
      remapper,
      tally,
      oweLookups: input.oweLookups,
      onWritten: input.onWritten,
      onCreatedWithoutRecordType: input.onCreatedWithoutRecordType,
      calls: input.calls,
      bulk: input.bulk,
      byNaturalKey: [],
      refusedOnTheirFields: [],
      locked: [],
      upsertField,
      ownersMapped: input.ownersMapped,
      remembered: new Set(
        [...(input.picklistFields ?? [])]
          .filter(([, field]) => field.controllerName === undefined)
          .map(([name]) => name.toLowerCase()),
      ),
    };
    const { byNaturalKey } = write;
    /**
     * What waits for the node's calls to be through, settled when a cancel
     * stops the node before one of them. The duplicates the target refused
     * without naming the record were left waiting for a lookup the run no
     * longer makes: neither linked nor counted, missing from what the run said
     * it did. Not written, they stay failures the run could not identify, as
     * when the lookup cannot be read. The rows refused on their fields, or for
     * a record the target could not lock, stay the failures the target made
     * them, as when the call that writes them again fails.
     */
    const settleOnStop = (err: unknown): void => {
      const why = extractErrorMessage(err);
      this.leaveLockedAsFailed(write, write.locked.splice(0), why);
      this.leaveRefusedAsFailed(write, write.refusedOnTheirFields.splice(0), why);
      this.settleByNaturalKey(
        node.objectApiName,
        byNaturalKey,
        [],
        remapper,
        tally,
        `The record the target holds under the same key was not looked up: ${why}`,
      );
    };

    for (let b = 0; b < batchCount; b++) {
      // A value the target refused under a row's record type in a call before
      // goes no more: the row is sent without it, as it would have been sent
      // again once refused for it.
      const rows = records.slice(b * batchSize, (b + 1) * batchSize).map((payload, i) => {
        const { sent, before } = this.withoutRefusedValues(write, payload);
        // Read against cleanedRecords (post required-FK skip), so remapper
        // entries point at the correct origin record.
        const row: RowToWrite = {
          payload: sent,
          built: cleanedRecords[recordOffset + i],
          before,
          refusals: [],
          lockResends: 0,
        };
        return row;
      });
      const what = `${node.objectApiName} batch ${b + 1}/${batchCount}`;
      let stopped: CallThrew | undefined;
      try {
        // A cancel stops the node before its next call — or before a call
        // that never reached the target is sent again.
        stopped = await this.sendRows(
          write,
          input,
          rows,
          what,
          records.length - recordOffset - rows.length,
        );
      } catch (err) {
        settleOnStop(err);
        throw err;
      }
      if (stopped) {
        // A call that throws stops the node there, and what failed is its rows
        // and those of the calls it leaves unsent. Thrown on, it took down what
        // the calls before had written: counted as failed with the whole node,
        // and the lookups those rows owe lost before pass 2 could fill them in.
        // Nor are the rows refused on their fields in the calls before
        // written again: they stay the failures the target made them. Nor
        // those refused for a lock: a batch makes more than one call — sent
        // smaller after a limit, sent as jobs, or a job and the REST calls
        // after it — and a lock one of them met waits for the batch to be
        // through to go again.
        const why = extractErrorMessage(stopped.thrown);
        this.leaveLockedAsFailed(write, write.locked.splice(0), why);
        this.leaveRefusedAsFailed(write, write.refusedOnTheirFields.splice(0), why);
        break;
      }
      recordOffset += rows.length;
      // The rows the target could not lock a record for go again now, after a
      // wait: the lock another transaction held may be gone.
      let stoppedBy: CallThrew | undefined;
      try {
        stoppedBy = await this.sendLockedAgain(write, input, records.length - recordOffset);
      } catch (err) {
        settleOnStop(err);
        throw err;
      }
      if (stoppedBy) {
        this.leaveRefusedAsFailed(
          write,
          write.refusedOnTheirFields.splice(0),
          extractErrorMessage(stoppedBy.thrown),
        );
        break;
      }

      input.onProgress({
        objectName: node.objectApiName,
        status: 'running',
        progress: Math.round(((b + 1) / batchCount) * 100),
        message: `batch ${b + 1}/${batchCount} — ${Math.min((b + 1) * batchSize, records.length)}/${records.length} records`,
      });
    }

    try {
      // By REST, in calls of 200, but for a round a job takes: see `writeAgainWithoutTheirFields`.
      await this.writeAgainWithoutTheirFields(
        write,
        input,
        Math.min(batchSize, WRITE_API_MAX_BATCH.rest),
      );
    } catch (err) {
      // A cancel before a call that writes them again: see `settleOnStop`.
      settleOnStop(err);
      throw err;
    }

    const keyFields = NATURAL_KEYS[node.objectApiName];
    if (keyFields && byNaturalKey.length > 0) {
      let found: Array<string | undefined>;
      let lookupFailed: string | undefined;
      try {
        found = await this.recordsByNaturalKey(
          targetOrgId,
          node.objectApiName,
          keyFields,
          byNaturalKey.map((d) => d.payload),
        );
      } catch (err) {
        // A lookup that could not be read finds nothing: each duplicate stays
        // a failure the run could not identify, and its sample says why, while
        // what the calls wrote stays theirs, as it does when a call throws.
        found = [];
        lookupFailed = `The record the target holds under the same key could not be looked up: ${extractErrorMessage(err)}`;
      }
      this.settleByNaturalKey(
        node.objectApiName,
        byNaturalKey,
        found,
        remapper,
        tally,
        lookupFailed,
      );
    }

    return tally;
  }

  /** One call of the node's write: the upsert by its external id, or the insert. */
  private send(write: NodeWrite, records: Record<string, unknown>[]): Promise<InsertResult[]> {
    return write.upsertField && this.deps.upsertRecords
      ? this.deps.upsertRecords(write.targetOrgId, write.objectApiName, write.upsertField, records)
      : this.deps.insertRecords(write.targetOrgId, write.objectApiName, records);
  }

  /**
   * Whether the run sends jobs, can, and may send `objectApiName` as one:
   * neither writes the object by REST alone nor heard the org say the Bulk
   * API does not write it. What a limit did to the object's calls is read
   * job by job ({@link goesSmallerByRest}).
   */
  private jobsCanCarry(bulk: BulkTransport | undefined, objectApiName: string): boolean {
    return (
      bulk !== undefined &&
      this.deps.bulkWriteRecords !== undefined &&
      !bulk.restOnly.has(objectApiName) &&
      !bulk.bulkUnsupported.has(objectApiName)
    );
  }

  /**
   * Whether a limit of the target's automation cut the key's calls under 200
   * and the allowance still pays for smaller ones: a job planned for the
   * object goes by REST instead, at the size kept — a job's chunk of 200,
   * which no one sets, is the call that was refused. A key kept whole, or
   * whose allowance is spent, goes at 200 by REST as by a job: a job already
   * planned stays a job, which no smaller call is paid to replace.
   */
  private goesSmallerByRest(key: CallKey): boolean {
    return this.splitting.sizes.of(key) < FULL_CALL_SIZE;
  }

  /**
   * Send `rows` and count what the target answered for each, choosing the
   * transport: Bulk API jobs of {@link FORGE_BULK_JOB_ROWS} at most when the
   * run may send the object as jobs and they are {@link FORGE_BULK_MIN_ROWS}
   * or more, by REST otherwise ({@link sendByRest}). A cancel at the
   * checkpoint before a call is thrown on, `onStop` told the rows left unsent
   * first.
   *
   * @param after - Rows of the calls the node has still to make past these,
   *   left unsent when one of these throws.
   * @param onStop - Told the rows a cancel kept from being sent, before it is
   *   thrown on; absent, they are left uncounted, as any row a cancel keeps
   *   from its first call, but for those refused for a limit, waiting to go
   *   again smaller, counted failed with that refusal.
   * @returns The call that threw, when one did: the node stops there.
   */
  private async sendRows(
    write: NodeWrite,
    input: WriteNodeInput,
    rows: readonly RowToWrite[],
    what: string,
    after: number,
    onStop?: (unsent: readonly RowToWrite[], why: string) => void,
  ): Promise<CallThrew | undefined> {
    const { bulk } = write;
    if (
      !bulk ||
      !this.jobsCanCarry(bulk, write.objectApiName) ||
      rows.length < FORGE_BULK_MIN_ROWS
    ) {
      return this.sendByRest(write, input, rows, what, after, onStop);
    }
    for (let start = 0; start < rows.length; start += FORGE_BULK_JOB_ROWS) {
      const chunk = rows.slice(start, start + FORGE_BULK_JOB_ROWS);
      const later = rows.length - start - chunk.length + after;
      let stopped: CallThrew | undefined;
      try {
        // What is left of an object past its jobs goes by REST, under the
        // threshold: its calls of 200 cost no more than a job, and end sooner.
        stopped =
          chunk.length >= FORGE_BULK_MIN_ROWS
            ? await this.writeAsJobs(write, input, bulk, chunk, what, later, onStop)
            : await this.sendByRest(write, input, chunk, what, later, onStop);
      } catch (err) {
        onStop?.(rows.slice(start + chunk.length), extractErrorMessage(err));
        throw err;
      }
      if (stopped) return stopped;
    }
    return undefined;
  }

  /**
   * Send `rows` by REST, after the checkpoint each call has, and count what
   * the target answered for each: in calls of 200, or of the size a limit of
   * the target's automation left the object at (`callAndSettle`). A call that
   * throws stops there: its rows, those waiting to go again smaller, and
   * those after them, are counted failed.
   *
   * @param after - Rows of the calls past these, left unsent when one of these throws.
   * @param onStop - See {@link sendRows}.
   * @param how - How their calls cut smaller are paid, and whether a job's
   *   chunk refused them for a limit already: see `SplitRun`.
   */
  private async sendByRest(
    write: NodeWrite,
    input: WriteNodeInput,
    rows: readonly RowToWrite[],
    what: string,
    after: number,
    onStop?: (unsent: readonly RowToWrite[], why: string) => void,
    how?: SplitHow,
  ): Promise<CallThrew | undefined> {
    if (rows.length === 0) return undefined;
    try {
      await input.waitIfPaused();
    } catch (err) {
      const why = extractErrorMessage(err);
      if (onStop) onStop(rows, why);
      else this.leaveLimitedAsFailed(write, rows, limitedOf(rows, how), why);
      throw err;
    }
    const stopped = await this.callAndSettle(write, input, rows, onStop, how);
    if (!stopped) return undefined;
    this.settleThrown(write, stopped.threw, stopped.rows, what, stopped.rest.length + after);
    return stopped.threw;
  }

  /**
   * Send `rows` — {@link FORGE_BULK_JOB_ROWS} at most — as Bulk API 2.0 jobs,
   * one for each {@link FORGE_BULK_JOB_MAX_BYTES} of CSV they make, after the
   * checkpoint each call has, and count what each row came to. Each job is
   * kept before it goes, as a REST call is (`InsertCallJournal.sending`), with
   * its id once the org opened it (`opened`), and closed once what it created
   * is on disk.
   *
   * What the job answered is counted as a REST answer is: a row refused for
   * a lock, on its fields, as one the target holds, goes on as it would. A
   * row it could not answer for itself — kept out as another's twin, left
   * unprocessed, refused by a duplicate rule (a job carries no header that
   * waives one), or with an error that does not read as one — goes once more
   * by REST in the same round. A job that wrote nothing (`untouched`) has its
   * rows sent by REST; when the org said the Bulk API does not write the
   * object, no job of it is sent again in the run. A row the job may have
   * written without saying so is counted failed and never sent again, and the
   * records it wrote that no row was matched to are kept for removal
   * (`unattributed`). A job closed and lost (`BulkJobLostError`) stops the
   * node there, its rows counted as may have been written, as a REST call
   * whose answer was lost does.
   *
   * A row a job's chunk refused for a limit of the target's automation goes
   * again by REST as a row of a call of {@link BULK_CHUNK} refused
   * (`SplitRun.refusedIn`): a record on its own first, then in calls half as
   * large, every call paid out of the run's allowance — or it stays refused as
   * the org refused it, the key left whole or spent. The jobs of the object
   * still to send, the pieces of these rows past it among them, go by REST at
   * the size kept while the allowance pays ({@link sendJobByRest}).
   *
   * @param after - Rows past these, left unsent when one of these stops the node.
   * @param onStop - See {@link sendRows}.
   */
  private async writeAsJobs(
    write: NodeWrite,
    input: WriteNodeInput,
    bulk: BulkTransport,
    rows: readonly RowToWrite[],
    what: string,
    after: number,
    onStop?: (unsent: readonly RowToWrite[], why: string) => void,
  ): Promise<CallThrew | undefined> {
    const sendJob = this.deps.bulkWriteRecords;
    if (!sendJob) return this.sendByRest(write, input, rows, what, after, onStop);
    const key = callKeyOf(write);
    if (this.goesSmallerByRest(key)) {
      return this.sendJobByRest(write, input, bulk, rows, what, after, onStop);
    }
    const operation = write.upsertField ? 'upsert' : 'insert';
    const payloads = rows.map(sentAs);
    const pieces = piecesUnder(
      FORGE_BULK_JOB_MAX_BYTES,
      buildBulkCsv(operation, payloads, write.upsertField),
    );
    for (const [from, to] of pieces) {
      const piece = rows.slice(from, to);
      const later = rows.length - to + after;
      if (this.goesSmallerByRest(key)) {
        // A limit refused an earlier piece's job: this one's chunks of 200
        // would be refused as that one's were.
        let stopped: CallThrew | undefined;
        try {
          stopped = await this.sendJobByRest(write, input, bulk, piece, what, later, onStop);
        } catch (err) {
          onStop?.(rows.slice(to), extractErrorMessage(err));
          throw err;
        }
        if (stopped) return stopped;
        continue;
      }
      try {
        // A cancel stops the node before its next job, as before any call.
        await input.waitIfPaused();
      } catch (err) {
        onStop?.(rows.slice(from), extractErrorMessage(err));
        throw err;
      }
      const records = payloads.slice(from, to);
      // Kept before it goes, as a REST call is: see `WriteNodeInput.calls`.
      const callId = write.calls?.sending(
        write.objectApiName,
        piece.map((row, i) => ({
          sourceId: sourceIdOf(row),
          payload: records[i],
          owes: owedBy(row),
        })),
        write.upsertField,
      );
      let answer: BulkWriteAnswer;
      try {
        answer = await sendJob(write.targetOrgId, write.objectApiName, operation, records, {
          bulkManager: bulk.manager,
          signal: bulk.signal,
          ...(write.upsertField ? { externalIdField: write.upsertField } : {}),
          onOpened: (jobId) => {
            if (callId !== undefined) write.calls?.opened?.(callId, jobId);
          },
        });
      } catch (thrown) {
        if (thrown instanceof BulkJobLostError) {
          // Closed, and what it did could not be read back: the call stays
          // open in the journal, for a run taken up to read the job by its id.
          // The rows kept out of it as another's twin were never sent: not
          // written, they are no row the target may hold.
          const lost: CallThrew = { thrown, left: 'may-have-written', tries: 1 };
          const twins = new Set(thrown.twins);
          const inJob = piece.filter((_, i) => !twins.has(i));
          this.settleThrown(write, lost, inJob, `${what} (Bulk API job)`, later);
          this.leaveTwinsUnsent(write, piece.length - inJob.length, what, thrown);
          return lost;
        }
        // Thrown before anything was sent — no connection to the org: no job was opened.
        answer = {
          answers: [],
          rows: [],
          unmatchedIds: [],
          untouched: { reason: extractErrorMessage(thrown) },
          requests: 0,
        };
      }
      if (answer.aborted) {
        // Cancelled while the job was open: nothing was written, and the
        // checkpoint throws the cancel on.
        try {
          await input.waitIfPaused();
        } catch (err) {
          if (callId !== undefined) write.calls?.answered(callId);
          onStop?.(rows.slice(from), extractErrorMessage(err));
          throw err;
        }
        answer = { ...answer, untouched: { reason: 'the job was aborted' } };
      }
      if (answer.untouched) {
        // Nothing written: the call is closed, and its rows go by REST.
        if (callId !== undefined) write.calls?.answered(callId);
        if (answer.untouched.unsupported) bulk.bulkUnsupported.add(write.objectApiName);
        logger.warn(
          `[forge] ${write.objectApiName}: a Bulk API job of ${nRecords(piece.length)} wrote ` +
            `nothing (${answer.untouched.reason}) — sent by REST` +
            (answer.untouched.unsupported ? ', as every write of the object in the run.' : '.'),
        );
        let stopped: CallThrew | undefined;
        try {
          stopped = await this.sendByRest(write, input, piece, what, later, onStop);
        } catch (err) {
          onStop?.(rows.slice(to), extractErrorMessage(err));
          throw err;
        }
        if (stopped) return stopped;
        continue;
      }
      if (answer.unmatchedIds.length > 0) {
        write.calls?.unattributed?.(write.objectApiName, answer.unmatchedIds);
        logger.warn(
          `[forge] ${write.objectApiName}: Bulk API job ${answer.jobId ?? ''} wrote ` +
            `${nRecords(answer.unmatchedIds.length)} no row was matched to — kept for removal.`,
        );
      }
      const answered: RowToWrite[] = [];
      const answers: InsertResult[] = [];
      const byRest: RowToWrite[] = [];
      const limitedRows: RowToWrite[] = [];
      const limitedAnswers: InsertResult[] = [];
      const mayHave: RowToWrite[] = [];
      let cause: GovernorLimitCause | undefined;
      piece.forEach((row, i) => {
        const state = answer.rows[i] ?? 'unprocessed';
        const result = answer.answers[i];
        const limited = state === 'answered' ? limitOf(result) : undefined;
        if (state === 'may-have-written') mayHave.push(row);
        else if (limited !== undefined && result !== undefined) {
          cause ??= limited;
          limitedRows.push(row);
          limitedAnswers.push(result);
        } else if (!result || goesAgainByRest(state, result)) {
          byRest.push(row);
        } else {
          answered.push(row);
          answers.push(result);
        }
      });
      this.settleMayHaveBeenWritten(write, mayHave, what, answer.jobId);
      // Closed once what it created is on disk: the rows going again by REST
      // are kept with the calls that send them.
      await this.settleAnswers(
        write,
        answered,
        callId === undefined ? { answers } : { answers, callId },
      );
      if (byRest.length > 0) {
        let stopped: CallThrew | undefined;
        try {
          stopped = await this.sendByRest(
            write,
            input,
            byRest,
            `${what}, by REST`,
            limitedRows.length + later,
            onStop,
          );
        } catch (err) {
          onStop?.([...limitedRows, ...rows.slice(to)], extractErrorMessage(err));
          throw err;
        }
        if (stopped) return stopped;
      }
      if (limitedRows.length > 0) {
        // The job's chunks of 200 were the calls refused: never sent at 200
        // again, its rows go by REST as a refused call's do, out of the same
        // allowance.
        let stopped: CallThrew | undefined;
        try {
          stopped = await this.sendByRest(
            write,
            input,
            limitedRows,
            `${what}, by REST`,
            later,
            onStop,
            {
              refusedIn: {
                from: BULK_CHUNK,
                answers: limitedAnswers,
                ...(cause ? { cause } : {}),
              },
            },
          );
        } catch (err) {
          onStop?.(rows.slice(to), extractErrorMessage(err));
          throw err;
        }
        if (stopped) return stopped;
      }
    }
    return undefined;
  }

  /**
   * Send by REST, at the size a limit left the object at, the rows a job was
   * planned for once a limit cut a call of the object, as far as the
   * allowance pays for every one of those calls — each is one more than the
   * job — paid before the first goes, the key spent only once they went. What
   * it does not pay for goes as the job it was planned as, the object spent,
   * or by REST at 200 under {@link FORGE_BULK_MIN_ROWS}: calls of 200 in a
   * job's place cost some ten times its requests, for rows its automation
   * would refuse all the same.
   *
   * @param after - Rows past these, left unsent when one of these stops the node.
   * @param onStop - See {@link sendRows}.
   */
  private async sendJobByRest(
    write: NodeWrite,
    input: WriteNodeInput,
    bulk: BulkTransport,
    rows: readonly RowToWrite[],
    what: string,
    after: number,
    onStop?: (unsent: readonly RowToWrite[], why: string) => void,
  ): Promise<CallThrew | undefined> {
    const key = callKeyOf(write);
    const { sizes, allowance } = this.splitting;
    const size = sizes.of(key);
    const asked = Math.ceil(rows.length / size);
    const granted = allowance.take(key, asked);
    sizes.countExtraCalls(key, granted);
    const byRest = rows.slice(0, granted * size);
    const asJob = rows.slice(byRest.length);
    if (byRest.length > 0) {
      let stopped: CallThrew | undefined;
      try {
        stopped = await this.sendByRest(write, input, byRest, what, asJob.length + after, onStop, {
          pricedAs: 'job',
          paid: { calls: granted },
        });
      } catch (err) {
        onStop?.(asJob, extractErrorMessage(err));
        throw err;
      } finally {
        if (granted < asked) sizes.spend(key);
      }
      if (stopped) return stopped;
    } else if (granted < asked) {
      sizes.spend(key);
    }
    if (asJob.length === 0) return undefined;
    return asJob.length >= FORGE_BULK_MIN_ROWS
      ? this.writeAsJobs(write, input, bulk, asJob, what, after, onStop)
      : this.sendByRest(write, input, asJob, what, after, onStop);
  }

  /**
   * Count as failed, not written, the `count` rows a job lost after its close
   * kept out of it as another's twin: they were to go by REST once it
   * answered, and the node stops there.
   */
  private leaveTwinsUnsent(
    write: NodeWrite,
    count: number,
    what: string,
    lost: BulkJobLostError,
  ): void {
    if (count === 0) return;
    write.tally.failureCount += count;
    this.sample(write.tally, {
      recordSummary: `${what}: ${nRecords(count)} not written`,
      messages: [
        extractErrorMessage(lost),
        'Kept out of the Bulk API job as twins of other rows, to be written by REST once it ' +
          'answered: never sent, the target holds none of them.',
      ],
    });
  }

  /**
   * Count as failed the rows a job may have written without saying so, never
   * to be sent again, by source id among what the target may hold
   * (`mayHaveBeenWritten`), as the rows of a call whose answer was lost are.
   */
  private settleMayHaveBeenWritten(
    write: NodeWrite,
    rows: readonly RowToWrite[],
    what: string,
    jobId: string | undefined,
  ): void {
    if (rows.length === 0) return;
    const { tally } = write;
    tally.failureCount += rows.length;
    const sourceIds = rows.map(sourceIdOf).filter((id): id is string => id !== undefined);
    tally.mayHaveBeenWritten = [...(tally.mayHaveBeenWritten ?? []), ...sourceIds];
    this.sampleAhead(tally, {
      recordSummary: `${what}: ${nRecords(rows.length)} may have been written`,
      messages: [
        `Bulk API job ${jobId ?? ''} gave them no result of their own, and wrote records no ` +
          'row was matched to: the target may hold any of these records, and which of them ' +
          'is unknown.',
        MAY_HAVE_BEEN_WRITTEN_BY_A_JOB,
      ],
    });
  }

  /**
   * One call of the node's write, sent again — after a wait that doubles each
   * time, and the checkpoint each call has — while what it throws proves it
   * never reached the target, three times at most. What it threw otherwise,
   * or the last time, comes back with what it left in the target, for the
   * caller to count: never sent again, a call that may have written rows
   * writes none of them twice. A cancel at the checkpoint is thrown on.
   */
  private async call(
    write: NodeWrite,
    input: WriteNodeInput,
    rows: readonly RowToWrite[],
  ): Promise<CallAnswered | CallThrew> {
    const payloads = rows.map(sentAs);
    for (let resends = 0; ; resends++) {
      // Kept before it goes, each time it goes, an upsert with the external
      // id it matches by: see `WriteNodeInput.calls`.
      const callId = write.calls?.sending(
        write.objectApiName,
        rows.map((row, i) => ({
          sourceId: sourceIdOf(row),
          payload: payloads[i],
          owes: owedBy(row),
        })),
        write.upsertField,
      );
      try {
        const answers = await this.send(write, payloads);
        return callId === undefined ? { answers } : { answers, callId };
      } catch (thrown) {
        const left = whatTheWriteLeft(thrown);
        // A call that proved it wrote nothing is closed; one that may have
        // written rows stays open, for a run taken up to look for them.
        if (callId !== undefined && left !== 'may-have-written') write.calls?.answered(callId);
        if (left !== 'not-received' || resends === RESENDS_OF_AN_UNREACHED_CALL) {
          return { thrown, left, tries: resends + 1 };
        }
        const delay = this.backoff.calculateDelay(resends);
        logger.warn(
          `[forge] ${write.objectApiName}: a call of ${nRecords(payloads.length)} never reached ` +
            `the target (${extractErrorMessage(thrown)}) — sent again in ${delay} ms ` +
            `(${resends + 1}/${RESENDS_OF_AN_UNREACHED_CALL}).`,
        );
        await this.wait(delay);
        await input.waitIfPaused();
      }
    }
  }

  /**
   * Send `rows` and count what the target answered for each, in calls of the
   * size kept for the object and operation, read before each call
   * (`sendSplittingOnLimits`): the rows a call of more than one was refused
   * for a limit of the target's automation go again at once, a record on its
   * own first the first time, then in calls half as large, each call more
   * paid out of the run's allowance. The first call's checkpoint is the
   * caller's; each call after it has its own.
   *
   * A row sent again keeps what it was: its payload, what it was first sent
   * without, its refusals on fields and its sends for a lock — the journal
   * keeps it as it goes, and the answer of its first call, which created
   * nothing for it, is closed.
   *
   * @param onUnsent - Told the rows a cancel, or anything thrown, kept from
   *   being sent or settled, before it is thrown on. Absent, those the target
   *   had refused for a limit, waiting to go again smaller, are counted
   *   failed with that refusal; the others were never answered, as the rows
   *   of a call a cancel keeps from going.
   * @param how - How the calls cut smaller are paid, and whether a job's
   *   chunk refused the rows for a limit already: see `SplitRun`.
   * @returns Where the calls stopped when one threw: the caller counts its
   *   rows and those after them.
   */
  private async callAndSettle(
    write: NodeWrite,
    input: WriteNodeInput,
    rows: readonly RowToWrite[],
    onUnsent?: (unsent: readonly RowToWrite[], why: string) => void,
    how?: SplitHow,
  ): Promise<RestStop | undefined> {
    let threw: CallThrew | undefined;
    let answered: CallAnswered = { answers: [] };
    /** The rows the target refused for a limit, with what it refused them with. */
    const refusedForALimit = limitedOf(rows, how);
    const { stopped } = await sendSplittingOnLimits<RowToWrite, InsertResult>(rows, {
      key: callKeyOf(write),
      sizes: this.splitting.sizes,
      allowance: this.splitting.allowance,
      ...how,
      beforeEachSend: () => input.waitIfPaused(),
      send: async (part) => {
        const outcome = await this.call(write, input, part);
        if ('thrown' in outcome) {
          // Never sent again, as any call that threw: one that may have
          // written rows writes none of them twice.
          threw = outcome;
          return 'stop';
        }
        answered = outcome;
        return { answers: outcome.answers };
      },
      limited: (answer, row) => {
        const cause = limitOf(answer);
        if (cause && answer) refusedForALimit.set(row, answer.errors);
        return cause;
      },
      // Rows held while the key was probed are settled with the answers of
      // the call that refused them, closed already.
      settle: (part, answers, again, notes, held) =>
        this.settleAnswers(write, part, held ? { answers } : answered, again, notes),
      onThrow: (unsent, error) => {
        const why = extractErrorMessage(error);
        if (onUnsent) onUnsent(unsent, why);
        else this.leaveLimitedAsFailed(write, unsent, refusedForALimit, why);
      },
      onFirstRefusal: warnFirstRefusal,
    });
    if (!stopped || threw === undefined) return undefined;
    return { threw, rows: stopped.part, rest: stopped.rest };
  }

  /** Keep `sample` among the node's samples, while it holds fewer than three. */
  private sample(tally: BatchWriteResult, sample: ExecutionErrorSample): void {
    if (tally.errorSamples.length < 3) tally.errorSamples.push(sample);
  }

  /**
   * Keep `sample` first among the node's samples, the last of three making
   * room for it: what a call that may have written rows left in the target is
   * the one thing the run cannot find out for itself, and a node whose rows
   * the target refused before it had filled its three samples with them.
   */
  private sampleAhead(tally: BatchWriteResult, sample: ExecutionErrorSample): void {
    tally.errorSamples.unshift(sample);
    tally.errorSamples.splice(3);
  }

  /**
   * Count what the target answered for each row of a call. A row it gave no
   * answer for is failed: one result per row sent is what the API answers,
   * and a truncated answer has been seen in the wild. An answer past the rows
   * sent has no row behind it, and is not read.
   *
   * A row of `again`, refused for a limit of the target's automation and sent
   * again in a smaller call, is neither settled nor counted here: nothing of
   * it is remembered, and it is settled with the call that sends it again.
   * The call is closed all the same once what it created is on disk: rolled
   * back for that row, it created nothing of it.
   *
   * @param again - The places in `rows` of the rows sent again smaller.
   * @param notes - Why a row refused for a limit is settled rather than sent
   *   again, by its place in `rows`: said in its sample once it fails.
   */
  private async settleAnswers(
    write: NodeWrite,
    rows: readonly RowToWrite[],
    {
      answers,
      callId,
    }: Pick<CallAnswered, 'callId'> & {
      readonly answers: readonly (InsertResult | undefined)[];
    },
    again: ReadonlySet<number> = NONE_AGAIN,
    notes: ReadonlyMap<number, LimitNote> = NO_LIMIT_NOTES,
  ): Promise<void> {
    // The records the target created are put on disk before the run awaits
    // anything, with the lookups they owe. The describe below, read for a
    // refusal of the call, came first and left them in memory for the length
    // of a request: a process killed meanwhile left them in the target unnamed.
    // What is left: a process killed while the call is under way, before its
    // answer, or while this loop registers the answer, before the write
    // below: the target holds what the call created, and the journal names
    // none of it.
    rows.forEach((row, i) => {
      const answer = answers[i];
      if (answer?.success && !again.has(i)) this.settle(write, answer, row);
    });
    write.remapper.persist();
    await this.readWhatMayBeEmpty(
      write,
      answers.filter((answer): answer is InsertResult => answer !== undefined),
    );
    rows.forEach((row, i) => {
      if (again.has(i)) return;
      const answer = answers[i];
      if (answer) {
        if (!answer.success) this.settle(write, answer, row, notes.get(i));
        return;
      }
      write.tally.failureCount++;
      this.sample(write.tally, {
        recordSummary: summarizeRecordForError(row.payload),
        messages: [
          `No result returned for record (API truncated batch: ${answers.length}/${rows.length})`,
          ...sentAgainNotes(row.refusals),
          ...sentWithoutNote(row.before),
        ],
      });
    });
    write.remapper.persist();
    // Closed once what it created is on disk: a reader of the call finds that first.
    if (callId !== undefined) write.calls?.answered(callId);
  }

  /**
   * Read, once for the node, which of its fields the target lets a row leave
   * empty, when a lookup filter refused a row of the call: the lookup it
   * refused is left out only when it is one of them. The target's describe,
   * which the run read for its field sets; one that cannot be read leaves
   * none, and the row fails as it was refused.
   */
  private async readWhatMayBeEmpty(
    write: NodeWrite,
    answers: readonly InsertResult[],
  ): Promise<void> {
    if (write.mayBeEmpty !== undefined) return;
    const filtered = answers.some((answer) =>
      (answer.errorDetails ?? []).some((detail) => detail.statusCode === LOOKUP_FILTER_REFUSAL),
    );
    if (!filtered) return;
    const described = await this.deps
      .describeFields?.(write.targetOrgId, write.objectApiName)
      .catch(() => undefined);
    write.mayBeEmpty = new Set(
      (described ?? []).filter((f) => f.nillable === true).map((f) => f.name.toLowerCase()),
    );
  }

  /**
   * Count the rows of a call that threw, which stops the node there, and the
   * rows of the calls it leaves unsent.
   *
   * @param what - The call, as its sample names it.
   * @param after - Rows of the calls the node leaves unsent.
   */
  private settleThrown(
    write: NodeWrite,
    threw: CallThrew,
    rows: readonly RowToWrite[],
    what: string,
    after: number,
  ): void {
    const { tally } = write;
    const why = extractErrorMessage(threw.thrown);
    tally.failureCount += rows.length + after;
    if (threw.left === 'may-have-written') {
      const sourceIds = rows
        .map((row) => row.built?.source['Id'])
        .filter((id): id is string => typeof id === 'string');
      tally.mayHaveBeenWritten = [...(tally.mayHaveBeenWritten ?? []), ...sourceIds];
      this.sampleAhead(tally, {
        recordSummary: `${what}: ${nRecords(rows.length)} may have been written`,
        messages: [
          why,
          MAY_HAVE_BEEN_WRITTEN,
          ...(after > 0 ? [`${nRecords(after)} after them not sent.`] : []),
        ],
      });
      return;
    }
    const notWritten = rows.length + after;
    this.sample(tally, {
      recordSummary: `${what}: ${nRecords(notWritten)} not written`,
      messages: [
        why,
        ...(threw.left === 'request-limit' ? [REQUEST_LIMIT_REACHED] : []),
        ...(threw.left === 'not-received'
          ? [`Sent ${threw.tries} times, the call never reached the target: it holds none of them.`]
          : []),
      ],
    });
  }

  /**
   * Send again, after a wait that doubles each time, the rows the target
   * refused for a record it could not lock: three times at most each. A row
   * refused so was not written, its call committing each row on its own, and
   * sent again it cannot be written twice. One the target then refuses on its
   * fields goes into the rounds without them; one still refused for a lock
   * after its last send fails with that refusal. A call that throws stops the
   * node there, as any call does; a cancel at the checkpoint before a send is
   * thrown on, the rows waiting for it failed with the refusal they had.
   *
   * @param after - Rows of the calls the node has still to make, left unsent when one of these throws.
   * @returns The call that threw, when one did.
   */
  private async sendLockedAgain(
    write: NodeWrite,
    input: WriteNodeInput,
    after: number,
  ): Promise<CallThrew | undefined> {
    for (let resends = 0; write.locked.length > 0; resends++) {
      const delay = this.backoff.calculateDelay(resends);
      logger.warn(
        `[forge] ${write.objectApiName}: the target could not lock a record for ` +
          `${nRecords(write.locked.length)} — sent again in ${delay} ms.`,
      );
      await this.wait(delay);
      await input.waitIfPaused();
      const locked = write.locked.splice(0);
      const rows = locked.map(({ row }): RowToWrite => ({
        ...row,
        lockResends: row.lockResends + 1,
      }));
      // A row a cancel keeps from going fails with the lock's refusal it had.
      const lockedOf = new Map(rows.map((row, i) => [row, locked[i]] as const));
      const stopped = await this.callAndSettle(write, input, rows, (unsent, why) =>
        this.leaveLockedAsFailed(
          write,
          unsent.flatMap((row) => lockedOf.get(row) ?? []),
          why,
        ),
      );
      if (stopped) {
        this.settleThrown(
          write,
          stopped.threw,
          stopped.rows,
          `${write.objectApiName}, sent again`,
          after + stopped.rest.length,
        );
        // Refused for a lock again by a call of this round: not sent again either.
        this.leaveLockedAsFailed(
          write,
          write.locked.splice(0),
          extractErrorMessage(stopped.threw.thrown),
        );
        return stopped.threw;
      }
    }
    return undefined;
  }

  /**
   * Count what the target answered for one row: written, linked to the record
   * it holds, waiting for the lookup by its natural key, to go again — for a
   * lock, or without the fields it refused — or failed.
   *
   * @param limitNote - Why a row the target's automation refused for a limit
   *   was not sent again smaller: sent on its own already, records of its
   *   object sent on their own refused too, or the allowance spent. Said
   *   after the org's message when the row fails.
   */
  private settle(
    write: NodeWrite,
    result: InsertResult,
    row: RowToWrite,
    limitNote?: LimitNote,
  ): void {
    const { tally, remapper, objectApiName } = write;
    const { built, before } = row;
    const payload = sentAs(row);
    if (result.success) {
      const oldId = built?.source['Id'];
      // An upsert that matched a record by its external id wrote over one
      // the target already held. Its children point at it all the same,
      // but it is not the run's: counted as updated, and a removal of the
      // run's records must never reach it.
      const updated = result.created === false;
      if (updated) tally.updatedCount++;
      else tally.successCount++;
      if (typeof oldId === 'string') {
        if (updated) remapper.addUpdated(oldId, result.id, objectApiName);
        else remapper.add(oldId, result.id, objectApiName);
      }
      if (built) write.onWritten?.(built, result.id);
      // Created without a record type, as it was last sent: the target gave
      // it one, which may not be the one its describe names the default.
      if (!updated && !carriesRecordTypeId(payload)) {
        write.onCreatedWithoutRecordType?.(built, result.id);
      }
      // Record nullified FKs so pass 2 can patch them
      // once the parent target is in the IdRemapper.
      if (built && built.nullifiedFks.length > 0) {
        const sourceId = typeof built.source['Id'] === 'string' ? built.source['Id'] : undefined;
        const owed = built.nullifiedFks.map((nf): PendingFkUpdate => ({
          objectApiName,
          newId: result.id,
          sourceId,
          fieldName: nf.field,
          sourceRefId: nf.sourceRefId,
          ...(nf.insertOnly ? { insertOnly: true as const } : {}),
        }));
        if (write.oweLookups) write.oweLookups(owed);
        else tally.pendingFkUpdates.push(...owed);
      }
      // Counted the same whether the target refused the value of this row or
      // of one before it: either way the row is in, short of the value.
      const leftOut = [...before, ...leftOutOf(row)];
      if (leftOut.length > 0) {
        tally.writtenWithoutFields = addWrittenWithoutFields(tally.writtenWithoutFields, {
          rows: 1,
          fields: leftOut.map((f) => ({ ...f, rows: 1 })),
        });
      }
      // Each lookup a filter refused, by record: verified later, an empty
      // lookup the run left so is told from one that broke. Run on a large
      // client sandbox, a verification counted fourteen of them as broken.
      for (const { field, refusedBy } of leftOut) {
        if (refusedBy !== 'lookup-filter' || !result.id) continue;
        (tally.leftEmptyByFilter ??= []).push({ field, recordId: result.id });
      }
      return;
    }
    this.rememberRefusedValues(write, result, payload);
    this.rememberRefusedOwners(write, result, payload);
    const existing = existingRecordOf(result, write.targetKeyPrefix);
    if (existing.kind === 'linked') {
      // The target refused the row because it holds it, and said which
      // record that is. The children link to it; nothing is written to
      // it — no update, and no pass-2 patch of its lookups, which would
      // overwrite a record this run did not create.
      tally.linkedExistingCount++;
      const oldId = built?.source['Id'];
      if (typeof oldId === 'string') remapper.addExisting(oldId, existing.id, objectApiName);
      return;
    }
    if (existing.kind === 'unidentified' && NATURAL_KEYS[objectApiName]) {
      // Settled after the calls: the record may be found by its key.
      write.byNaturalKey.push({ payload, sourceId: built?.source['Id'], errors: result.errors });
      return;
    }
    const locked = refusedForALock(result);
    if (locked && row.lockResends < RESENDS_OF_A_LOCKED_ROW) {
      // Not written: sent again once the call's answers are counted.
      write.locked.push({ row, errors: result.errors });
      return;
    }
    // Refused on fields a validation rule named — a phone the target wants
    // in another format — on a restricted picklist's value its record type
    // does not take, on a lookup its filter refuses the record of, or for an
    // owner the target holds inactive, the row went down, and every record
    // hanging from it failed or was skipped for want of it. Written again
    // without them once the calls are through, it is in the target, short of
    // a value — or owned by the user the run writes as. A second refusal, on
    // fields the first did not name, gets a round of its own: the same
    // owner's refusal again finds no owner left to go, and the row fails. An
    // owner the run's owner mapping gives is never left out: the row fails
    // with the target's words rather than go to another than the user chose.
    const mayBeEmpty = (field: string): boolean =>
      write.mayBeEmpty?.has(field.toLowerCase()) ?? false;
    const leftOut = fieldsToLeaveOut(result, payload, write.upsertField, mayBeEmpty, {
      inactiveOwner: !ownerMapped(write, payload),
    });
    const roundsLeft = row.refusals.length < ROUNDS_WITHOUT_FIELDS;
    if (leftOut && roundsLeft) {
      write.refusedOnTheirFields.push({
        ...row,
        refusals: [...row.refusals, { errors: result.errors, leftOut }],
      });
      return;
    }
    tally.failureCount++;
    if (existing.kind === 'unidentified') tally.unidentifiedExistingCount++;
    // Counted apart because it says something different from a failure:
    // the target already holds the row, so nothing downstream of it is
    // orphaned. See `isAlreadyExistsError`.
    if (result.errors.every((m) => isAlreadyExistsError(m))) tally.alreadyExistsCount++;
    this.sample(tally, {
      // The row as first sent, which the fields left out cannot hide.
      recordSummary: summarizeRecordForError(row.payload),
      // Refused again, the row fails with what the target said the last
      // time, and says what it was refused with before — why it was not sent
      // again, when the refusal does not say, and why it went without a
      // value from the start, when it did.
      messages: [
        ...result.errors,
        ...sentAgainNotes(row.refusals),
        ...(locked
          ? [
              `Sent again ${row.lockResends} times, the target still could not lock a record ` +
                'the write needed.',
            ]
          : []),
        ...(leftOut && !roundsLeft
          ? [
              `Not sent again: a row goes again without the fields the target refused ` +
                `${ROUNDS_WITHOUT_FIELDS} times at most.`,
            ]
          : []),
        ...(refusedOnNoField(result.errorDetails) ? [REFUSED_ON_NO_FIELD] : []),
        ...(limitNote
          ? [
              limitNoteText(
                limitNote,
                allowedFor(this.splitting.allowance, callKeyOf(write)),
                'run',
              ),
            ]
          : []),
        ...sentWithoutNote(before),
      ],
    });
  }

  /**
   * Where the target's refusal of a row's value of `field` is kept: by
   * object, the record type the row names, field and value. An API write has
   * its restricted picklists checked before any trigger or rule runs (the
   * order of execution), so the same value under the same record type is
   * refused whatever else a row holds. Nothing for a row that names no record
   * type — an upsert that matches a record keeps the one it has, which the row
   * does not say — nor for a field whose value it does not hold, the external
   * id it is upserted by, or a field the run does not remember
   * (`NodeWrite.remembered`): one that depends on another is refused for that
   * one's value as much as for its own.
   */
  private refusedValueKey(
    write: NodeWrite,
    payload: Record<string, unknown>,
    field: string,
  ): string | undefined {
    const recordType = payload['RecordTypeId'];
    const value = payload[field];
    if (typeof recordType !== 'string' || recordType === '') return undefined;
    if (typeof value !== 'string' || value === '') return undefined;
    const name = field.toLowerCase();
    if (!write.remembered.has(name) || name === write.upsertField?.toLowerCase()) return undefined;
    return [write.objectApiName, recordType, name, value].join('\u0000');
  }

  /**
   * Keep for the run each value of a restricted picklist the target refused
   * a row for, whether or not the row goes again: see `refusedValueKey`.
   */
  private rememberRefusedValues(
    write: NodeWrite,
    result: InsertResult,
    payload: Record<string, unknown>,
  ): void {
    for (const detail of result.errorDetails ?? []) {
      if (detail.statusCode !== RESTRICTED_PICKLIST_REFUSAL) continue;
      for (const named of detail.fields) {
        const field = heldKeyOf(payload, named);
        const key = field === undefined ? undefined : this.refusedValueKey(write, payload, field);
        if (field === undefined || key === undefined || this.refusedValues.has(key)) continue;
        this.refusedValues.set(key, {
          field,
          refusedBy: 'restricted-picklist',
          reason: codeAndMessage(detail),
        });
      }
    }
  }

  /**
   * Keep for the run each owner the target refused a row for as inactive,
   * when the refusal named the row's own owner: see `refusedOwners`. Never
   * the external id the row is upserted by, which it never goes without, nor
   * an owner the run's owner mapping gives.
   */
  private rememberRefusedOwners(
    write: NodeWrite,
    result: InsertResult,
    payload: Record<string, unknown>,
  ): void {
    const field = heldKeyOf(payload, 'OwnerId');
    if (field === undefined || field.toLowerCase() === write.upsertField?.toLowerCase()) return;
    if (ownerMapped(write, payload)) return;
    for (const detail of result.errorDetails ?? []) {
      if (detail.statusCode !== INACTIVE_OWNER_REFUSAL) continue;
      const owner = inactiveOwnerNamed(detail, payload);
      if (owner === undefined || this.refusedOwners.has(owner)) continue;
      this.refusedOwners.set(owner, {
        field: 'OwnerId',
        refusedBy: 'inactive-owner',
        reason: codeAndMessage(detail),
      });
    }
  }

  /**
   * A row's payload as it is first sent: without the values the target
   * refused under the record type it names earlier in the run, nor an owner
   * it refused as inactive earlier in the run, and those it goes without,
   * with the refusal of each. Sent with them, the row would be refused for
   * them and sent again without them, as it now is from the start; its rounds
   * without fields stay for whatever else the target refuses it on. The
   * payload itself, left as it was, when it holds none.
   *
   * The owner's key is taken out of the payload, never set to null nor left
   * empty, and before the call is journaled, fingerprinted or cut into a
   * job's CSV: by REST the record goes to the user the run writes as, and so
   * it does by a job, whose CSV leaves the row's cell empty — the column's
   * default — rather than `#N/A`, a null the target refuses for an owner. The
   * journal, the job's rows and their answers all see the row as it went.
   */
  private withoutRefusedValues(
    write: NodeWrite,
    payload: Record<string, unknown>,
  ): { sent: Record<string, unknown>; before: FieldToLeaveOut[] } {
    const before: FieldToLeaveOut[] = [];
    if (this.refusedValues.size === 0 && this.refusedOwners.size === 0) {
      return { sent: payload, before };
    }
    for (const field of Object.keys(payload)) {
      const key = this.refusedValueKey(write, payload, field);
      const refused = key === undefined ? undefined : this.refusedValues.get(key);
      if (refused) before.push({ ...refused, field });
    }
    const ownerField = heldKeyOf(payload, 'OwnerId');
    const owner = ownerField === undefined ? undefined : payload[ownerField];
    if (
      ownerField !== undefined &&
      typeof owner === 'string' &&
      ownerField.toLowerCase() !== write.upsertField?.toLowerCase() &&
      !ownerMapped(write, payload)
    ) {
      const refused = this.refusedOwners.get(owner.slice(0, 15));
      if (refused) before.push({ ...refused, field: ownerField });
    }
    return before.length === 0
      ? { sent: payload, before }
      : { sent: without(payload, before), before };
  }

  /**
   * Count as failed, with what the target last refused them with, rows it
   * refused on their fields that a cancel or a call that threw kept from
   * being written again, each sample saying why.
   */
  private leaveRefusedAsFailed(write: NodeWrite, rows: readonly RowToWrite[], why: string): void {
    for (const row of rows) {
      const last = row.refusals[row.refusals.length - 1];
      write.tally.failureCount++;
      this.sample(write.tally, {
        recordSummary: summarizeRecordForError(row.payload),
        messages: [
          ...(last?.errors ?? []),
          ...sentAgainNotes(row.refusals.slice(0, -1)),
          `Not written again without ${fieldList(leftOutOf(row))}: ${why}`,
          ...sentWithoutNote(row.before),
        ],
      });
    }
  }

  /**
   * Count as failed, with the refusal they had, rows the target refused for a
   * limit of its automation that a cancel kept from going again smaller, each
   * sample saying why. A row it never answered is not among them: it was not
   * sent, as the rows of a call a cancel keeps from going.
   */
  private leaveLimitedAsFailed(
    write: NodeWrite,
    rows: readonly RowToWrite[],
    refused: ReadonlyMap<RowToWrite, readonly string[]>,
    why: string,
  ): void {
    for (const row of rows) {
      const errors = refused.get(row);
      if (!errors) continue;
      write.tally.failureCount++;
      this.sample(write.tally, {
        recordSummary: summarizeRecordForError(row.payload),
        messages: [
          ...errors,
          ...sentAgainNotes(row.refusals),
          `Not sent again in a smaller call: ${why}`,
          ...sentWithoutNote(row.before),
        ],
      });
    }
  }

  /**
   * Count as failed, with the refusal they had, rows the target could not
   * lock a record for that a cancel or a call that threw kept from being sent
   * again, each sample saying why.
   */
  private leaveLockedAsFailed(write: NodeWrite, locked: readonly LockedRow[], why: string): void {
    for (const { row, errors } of locked) {
      write.tally.failureCount++;
      this.sample(write.tally, {
        recordSummary: summarizeRecordForError(row.payload),
        messages: [
          ...errors,
          ...sentAgainNotes(row.refusals),
          `Not sent again: ${why}`,
          ...sentWithoutNote(row.before),
        ],
      });
    }
  }

  /**
   * Write again, without the fields the target refused them on, the rows it
   * refused so — through the call that first wrote them, after the
   * checkpoint each call has, as many to a call. A row taken this time counts
   * as written, and its children find it in the remap table; the fields it
   * went without are counted for the object's line. A row refused again on
   * fields the refusals before did not name goes in the next round, three
   * rounds at most; refused otherwise, it stays a failure, with the last
   * refusal and those before. A call that throws stops the node there, as
   * one of the first write does, its rows and those after it failures; a
   * cancel at the checkpoint leaves them so too, and is thrown on.
   */
  private async writeAgainWithoutTheirFields(
    write: NodeWrite,
    input: WriteNodeInput,
    batchSize: number,
  ): Promise<void> {
    while (write.refusedOnTheirFields.length > 0) {
      const rows = write.refusedOnTheirFields.splice(0);
      input.onProgress({
        objectName: write.objectApiName,
        status: 'running',
        progress: 100,
        message:
          `Writing ${rows.length} ${write.objectApiName} record${rows.length === 1 ? '' : 's'} ` +
          `again without the fields ${whatRefused(rows.flatMap(leftOutOf))} refused...`,
      });
      if (
        this.jobsCanCarry(write.bulk, write.objectApiName) &&
        rows.length >= FORGE_BULK_MIN_ROWS
      ) {
        // A round a job takes goes as jobs, as the node's first write did: a
        // rule that refused fifty thousand rows on one field took two hundred
        // and fifty calls more to write them again by REST. A row a cancel
        // keeps from going stays the failure the target made it.
        const why = `${write.objectApiName}, sent again`;
        let stoppedBy = await this.sendRows(write, input, rows, why, 0, (unsent, reason) =>
          this.leaveRefusedAsFailed(write, unsent, reason),
        );
        stoppedBy ??= await this.sendLockedAgain(write, input, 0);
        if (stoppedBy) {
          // The rows a call of the round before the one that threw had
          // refused for a lock are not sent again either: see `writeNode`.
          const reason = extractErrorMessage(stoppedBy.thrown);
          this.leaveLockedAsFailed(write, write.locked.splice(0), reason);
          this.leaveRefusedAsFailed(write, write.refusedOnTheirFields.splice(0), reason);
          return;
        }
        continue;
      }
      for (let start = 0; start < rows.length; start += batchSize) {
        const chunk = rows.slice(start, start + batchSize);
        let stopped: RestStop | undefined;
        try {
          await input.waitIfPaused();
        } catch (err) {
          this.leaveRefusedAsFailed(write, rows.slice(start), extractErrorMessage(err));
          throw err;
        }
        try {
          stopped = await this.callAndSettle(write, input, chunk, (unsent, why) =>
            this.leaveRefusedAsFailed(write, unsent, why),
          );
        } catch (err) {
          // The chunk's own rows left unsent were counted by `callAndSettle`.
          this.leaveRefusedAsFailed(write, rows.slice(start + batchSize), extractErrorMessage(err));
          throw err;
        }
        let stoppedBy: CallThrew | undefined;
        if (stopped) {
          stoppedBy = stopped.threw;
          const why = extractErrorMessage(stopped.threw.thrown);
          const after = [...stopped.rest, ...rows.slice(start + batchSize)];
          if (stopped.threw.left === 'may-have-written') {
            this.settleThrown(
              write,
              stopped.threw,
              stopped.rows,
              `${write.objectApiName}, sent again`,
              0,
            );
            this.leaveRefusedAsFailed(write, after, why);
          } else {
            this.leaveRefusedAsFailed(write, [...stopped.rows, ...after], why);
          }
        } else {
          try {
            stoppedBy = await this.sendLockedAgain(write, input, 0);
          } catch (err) {
            this.leaveRefusedAsFailed(
              write,
              rows.slice(start + batchSize),
              extractErrorMessage(err),
            );
            throw err;
          }
          if (stoppedBy) {
            this.leaveRefusedAsFailed(
              write,
              rows.slice(start + batchSize),
              extractErrorMessage(stoppedBy.thrown),
            );
          }
        }
        if (stoppedBy) {
          // Nor does the next round go: its rows stay the failures the target made them.
          this.leaveRefusedAsFailed(
            write,
            write.refusedOnTheirFields.splice(0),
            extractErrorMessage(stoppedBy.thrown),
          );
          return;
        }
      }
    }
  }

  /**
   * Settle the duplicates the target refused without naming the record it
   * holds: each is linked to the one record its key found, by index, and the
   * others are counted as failures the run could not identify.
   *
   * @param found - The record found under each duplicate's key, by index;
   *   nothing where none, or more than one, was.
   * @param notFoundBecause - Why nothing was looked up, added to the samples.
   */
  private settleByNaturalKey(
    objectApiName: string,
    duplicates: readonly UnnamedDuplicate[],
    found: ReadonlyArray<string | undefined>,
    remapper: IdRemapper,
    tally: BatchWriteResult,
    notFoundBecause?: string,
  ): void {
    duplicates.forEach((duplicate, i) => {
      const id = found[i];
      if (id && typeof duplicate.sourceId === 'string') {
        remapper.addExisting(duplicate.sourceId, id, objectApiName);
        tally.linkedExistingCount++;
        return;
      }
      tally.failureCount++;
      tally.unidentifiedExistingCount++;
      if (duplicate.errors.every((m) => isAlreadyExistsError(m))) tally.alreadyExistsCount++;
      if (tally.errorSamples.length < 3) {
        tally.errorSamples.push({
          recordSummary: summarizeRecordForError(duplicate.payload),
          messages: notFoundBecause ? [...duplicate.errors, notFoundBecause] : duplicate.errors,
        });
      }
    });
  }

  /**
   * The one target record holding each payload's natural key, by payload
   * index — or nothing where none, or more than one, does.
   */
  private async recordsByNaturalKey(
    targetOrgId: string,
    objectApiName: string,
    keyFields: readonly string[],
    payloads: readonly Record<string, unknown>[],
  ): Promise<Array<string | undefined>> {
    const query = this.deps.queryRecords;
    if (!query) return payloads.map(() => undefined);
    return recordsByNaturalKey(
      (soql) => query(targetOrgId, soql),
      objectApiName,
      keyFields,
      payloads,
    );
  }

  /**
   * Give the relations linked to before the insert the flags their source
   * rows carried and the platform's relation lacks — an event's who the event
   * also invites — and the invitee's answer, its status, response and when
   * it responded, when the target's describe lets them be updated: what it
   * could not give, counted for the node's line. See
   * `giveLinkedRelationsTheirFlags`. A run given no update of the target
   * asks nothing.
   */
  private async giveFlagsBack(
    objectApiName: string,
    targetOrgId: string,
    input: WriteNodeInput,
    linked: ReadonlyMap<number, string>,
  ): Promise<FlagsNotKept | undefined> {
    const update = this.deps.updateRecords;
    if (!update || linked.size === 0 || !FLAGS_THE_PLATFORM_LEAVES[objectApiName]) {
      return undefined;
    }
    const rows: Array<readonly [Record<string, unknown>, string]> = [];
    for (const [index, id] of linked) {
      const source = input.cleanedRecords[index]?.source;
      if (source) rows.push([source, id]);
    }
    // The target's describe, which the run read for its field sets: a
    // describe that cannot say leaves the target to answer the update.
    const described = await this.deps
      .describeFields?.(targetOrgId, objectApiName)
      .catch(() => undefined);
    return relationsLeftWithoutTheirFlags(
      objectApiName,
      rows,
      (field) => described?.find((f) => f.name === field)?.updateable !== false,
      (records) => update(targetOrgId, objectApiName, records),
      input.stopped,
    );
  }

  /**
   * The records the target already holds for these payloads, found before
   * the insert, by the index of the payload that describes each: the direct
   * relations the platform created for the contacts this run inserted, the
   * relations it wrote for the tasks and the events this run inserted, and
   * the selling model options of products the target already held.
   */
  private async heldBeforeInsert(
    objectApiName: string,
    targetOrgId: string,
    records: readonly Record<string, unknown>[],
  ): Promise<Map<number, string>> {
    const query = this.deps.queryRecords;
    if (!query) return new Map();
    const target = (soql: string): Promise<Record<string, unknown>[]> => query(targetOrgId, soql);
    if (objectApiName === ACCOUNT_CONTACT_RELATION) {
      return directAccountContactRelations(target, records);
    }
    if (ACTIVITY_OF_RELATION[objectApiName] !== undefined) {
      return existingActivityRelations(target, objectApiName, records);
    }
    if (objectApiName === SELLING_MODEL_OPTION_OBJECT) {
      return existingSellingModelOptions(target, records);
    }
    return new Map();
  }

  /**
   * Pick the upsert key field deterministically. Salesforce upsert needs an
   * external Id field that's *unique per record in the batch* — picking
   * non-unique fields blows up with DUPLICATE_EXTERNAL_ID. When multiple
   * candidates exist (legacy + new), we prefer the one whose values are all
   * present and unique in the current batch; alphabetical fallback ensures
   * determinism across describe-version drift.
   *
   * Of a node written a page at a time, the key is the first candidate whose
   * values were present and unique over every row the run reads of it
   * (`table`), on every page: see {@link WriteNodeInput.tableKeys}.
   */
  private pickUpsertField(
    fieldInfos: FieldInfo[],
    creatable: ReadonlySet<string>,
    records: Array<Record<string, unknown>>,
    mode: 'auto' | 'off',
    table?: TableUpsertKeys,
  ): string | undefined {
    if (mode === 'off' || !this.deps.upsertRecords) return undefined;
    const candidates = fieldInfos
      .filter((f) => f.externalId && creatable.has(f.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (table) return this.tableKeyOfThePage(candidates, records, table);
    if (candidates.length === 0) return undefined;
    // Prefer a candidate with non-null + unique values across the batch.
    for (const c of candidates) {
      const seen = new Set<string>();
      let ok = true;
      for (const r of records) {
        const v = r[c.name];
        if (typeof v !== 'string' || v.length === 0) {
          ok = false;
          break;
        }
        if (seen.has(v)) {
          ok = false;
          break;
        }
        seen.add(v);
      }
      if (ok) {
        // Log the chosen field so the user can attribute
        // upsert-related errors to the picked external Id without
        // having to re-derive it from describe metadata.
        logger.info(
          `[forge] upsert: using "${c.name}" as external Id (unique across ${records.length} records)`,
        );
        return c.name;
      }
    }
    // No clean winner → fall BACK TO INSERT instead of the
    // alphabetically-first candidate. The previous behavior produced
    // DUPLICATE_EXTERNAL_ID errors at run time when the chosen field
    // wasn't actually unique; falling back to a plain insert lets the
    // user see DUPLICATE_VALUE per-record (more actionable) and avoids
    // truncated batches in jsforce's bulk upsert path.
    logger.warn(
      `[forge] upsert: no externalId candidate is non-null+unique across batch ` +
        `(${candidates.map((c) => c.name).join(', ')}) — falling back to insert`,
    );
    return undefined;
  }

  /**
   * The key one page of a node written a page at a time is upserted by: the
   * first candidate unique over every row the run reads of the node, as long
   * as the page's rows, as written, each hold a value of it that neither
   * another row of the page nor an earlier page sent. Such a page is inserted
   * instead: a cleaned value no longer the source's (cut to the target's
   * length, neutralized, anonymized) can meet another, and upserted it would
   * write over the record that other value went in as.
   */
  private tableKeyOfThePage(
    candidates: readonly FieldInfo[],
    records: ReadonlyArray<Record<string, unknown>>,
    table: TableUpsertKeys,
  ): string | undefined {
    const key = candidates.find((c) => table.unique.has(c.name))?.name;
    if (key === undefined) {
      if (candidates.length > 0) {
        logger.warn(
          `[forge] upsert: no externalId candidate is non-null+unique across the rows read ` +
            `(${candidates.map((c) => c.name).join(', ')}) — falling back to insert`,
        );
      }
      return undefined;
    }
    const values = new Set<string>();
    for (const record of records) {
      const value = record[key];
      if (typeof value !== 'string' || value.length === 0 || values.has(value)) {
        logger.warn(
          `[forge] upsert: a row of this page leaves "${key}" empty or repeats it — inserting the page`,
        );
        return undefined;
      }
      if (table.sent.has(value)) {
        logger.warn(
          `[forge] upsert: a row of this page repeats a "${key}" an earlier page sent — inserting the page`,
        );
        return undefined;
      }
      values.add(value);
    }
    // Said once for the object, as its first page goes.
    if (table.sent.size === 0) {
      logger.info(
        `[forge] upsert: using "${key}" as external Id (unique across the rows read of the object)`,
      );
    }
    for (const value of values) table.sent.add(value);
    return key;
  }
}

/**
 * Compact key=value summary of a record (first ~4 fields, values truncated)
 * used for error reporting in {@link ExecutionObjectError.samples}. Keeps
 * payloads small enough to render in the wizard error panel.
 */
export function summarizeRecordForError(record: Record<string, unknown>): string {
  const keys = Object.keys(record).slice(0, 4);
  const parts: string[] = [];
  for (const k of keys) {
    const v = record[k];
    // Explicit handling for undefined and objects so debug output
    // doesn't show '[object Object]' or 'undefined' generically.
    let str: string;
    if (v === null) str = 'null';
    else if (v === undefined) str = 'undefined';
    else if (typeof v === 'string') str = v.length > 30 ? v.slice(0, 30) + '…' : v;
    else if (typeof v === 'object') {
      try {
        const json = JSON.stringify(v);
        str = json.length > 30 ? json.slice(0, 30) + '…' : json;
      } catch {
        str = '<unserializable>';
      }
    } else str = String(v);
    parts.push(`${k}=${str}`);
  }
  return parts.join(' ') || '(empty)';
}
