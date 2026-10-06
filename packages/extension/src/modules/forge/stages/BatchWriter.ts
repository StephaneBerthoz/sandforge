/**
 * Batch writer stage of the Forge execution pipeline.
 *
 * Splits a node's cleaned records into batches (REST/Bulk strategy),
 * dispatches them to the target org via insert — or upsert on an external
 * Id field when `upsertMode: 'auto'` applies — registers the new
 * source→target ID mappings, links rows the target refused because it
 * already holds them to the record it named, writes again without them the
 * rows a validation rule, a restricted picklist or the lookup filter of a
 * lookup the target lets be empty refused on fields it named, up to three
 * rounds a row — and sends without it from the start a row holding a picklist
 * value the target refused under the same record type earlier in the run —
 * sends again, after a wait, a call that never reached the target and the
 * rows it could not lock a record for, stops at a call whose answer was lost
 * and says which rows the target may hold, collects per-record failure
 * samples, and queues nullified cycle FKs for the pass-2 UPDATE.
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
import { SELLING_MODEL_OPTION_OBJECT, isAlreadyExistsError } from '@sandforge/shared';
import { codeAndMessage, existingRecordOf } from '../../../core/common/existingRecordMatch.js';
import { extractErrorMessage } from '../../../core/common/extractErrorMessage.js';
import {
  LOOKUP_FILTER_REFUSAL,
  RESTRICTED_PICKLIST_REFUSAL,
  addWrittenWithoutFields,
  heldKeyOf,
  refusedFields,
  refusedOnNoField,
  without,
  type FieldToLeaveOut,
  type WrittenWithoutFields,
} from '../../../core/common/refusedFields.js';
import { whatTheWriteLeft, type ThrownWrite } from '../../../core/common/thrownWrite.js';
import { RetryStrategy } from '../../../core/engine/RetryStrategy.js';
import {
  ACCOUNT_CONTACT_RELATION,
  ACTIVITY_OF_RELATION,
  FLAGS_THE_PLATFORM_LEAVES,
  NATURAL_KEYS,
  directAccountContactRelations,
  existingActivityRelations,
  existingSellingModelOptions,
  giveLinkedRelationsTheirFlags,
  recordsByNaturalKey,
} from '../../../core/common/platformRecords.js';
import { logger } from '../../../logger.js';
import { ForgeBatchStrategy as ForgeBatchStrategyService } from '../ForgeBatchStrategy.js';
import type { ResolvedBatchStrategy } from '../ForgeBatchStrategy.js';
import type { CleanedRecord } from './RecordCleaner.js';
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

/**
 * The API this writer really dispatches on.
 *
 * `composition/forgeComposition.ts` wires both `insertRecords` and
 * `upsertRecords` onto `conn.sobject(name).create/upsert` — REST sObject
 * Collections. No Bulk 2.0 transport is reachable from this stage, so the
 * effective batch size is derived from THIS constant and never from
 * `ForgeBatchStrategy.batchSize` alone: the strategy returns
 * `api: 'bulk'` + `batchSize: 10_000` as soon as a node holds more than 200
 * records, and posting 10 000 records to a 200-record endpoint failed every
 * object above the threshold. Moving Forge onto a real Bulk path means
 * changing this constant *and* the injected deps together, which keeps the
 * two in sync by construction.
 */
const WRITE_API: ResolvedBatchStrategy['api'] = 'rest';

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
 * @param planned - What {@link ForgeBatchStrategyService.resolve} proposed.
 * @param recordCount - Records to write for this node.
 * @returns The API really used, the clamped batch size/count, and whether the
 *   planned size had to be reduced.
 */
export function resolveWriteBatching(
  planned: ResolvedBatchStrategy,
  recordCount: number,
): {
  api: ResolvedBatchStrategy['api'];
  batchSize: number;
  batchCount: number;
  clamped: boolean;
} {
  const batchSize = Math.min(planned.batchSize, WRITE_API_MAX_BATCH[WRITE_API]);
  return {
    api: WRITE_API,
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
   * What the node's line says of the relations linked to without a flag
   * their row carried, or without a field of the answer that goes with it —
   * an invitee's status, response and when it responded: see
   * `giveLinkedRelationsTheirFlags`. Absent when all of it went back, or
   * there was none to give.
   */
  flagsNotKept?: string;
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
  /** Duplicates the target did not name, for an object with a natural key. */
  readonly byNaturalKey: UnnamedDuplicate[];
  /** Rows the target refused on fields it named, to write again without them. */
  readonly refusedOnTheirFields: RowToWrite[];
  /** Rows the target refused for a record it could not lock, to send again after a wait. */
  readonly locked: LockedRow[];
  /** The external id the rows are upserted by, which a row never goes without. */
  readonly upsertField: string | undefined;
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
}

/** What a call of the node's write came back with when it threw, and what that left in the target. */
interface CallThrew {
  readonly thrown: unknown;
  readonly left: ThrownWrite;
  /** How many times it was sent. */
  readonly tries: number;
}

/** What refused a field, as the line of a write that leaves it out says it. */
const REFUSER: Readonly<Record<ForgeFieldRefusal, string>> = {
  'validation-rule': 'a validation rule',
  'restricted-picklist': 'a restricted picklist',
  'lookup-filter': 'a lookup filter',
};

/** What refused the fields of `leftOut`, as the line of their write without them says it. */
function whatRefused(leftOut: readonly FieldToLeaveOut[]): string {
  const by = new Set(leftOut.map((f) => f.refusedBy));
  const named = (Object.keys(REFUSER) as ForgeFieldRefusal[])
    .filter((refusal) => by.has(refusal))
    .map((refusal) => REFUSER[refusal]);
  const said =
    named.length > 1 ? `${named.slice(0, -1).join(', ')} or ${named[named.length - 1]}` : named[0];
  return `${said ?? REFUSER['validation-rule']} of the target`;
}

/**
 * The fields to write a refused row again without, each with what refused it
 * and the refusal that named it: a validation rule's, a restricted picklist's
 * or — for a lookup the target lets be empty — a lookup filter's refusal of
 * fields the row gives a value to, on the rules of `refusedFields`. A result
 * whose details do not answer its errors one for one says less than the row
 * was refused for, and nothing is left out. A parent copied from outside the
 * graph is written again on the same rule (`OrphanExpander`).
 *
 * @param keep - A field the row cannot go without: the external id an upsert matches it by.
 * @param mayBeEmpty - Whether the target lets a row leave a field empty; without it, no lookup is left out.
 */
export function fieldsToLeaveOut(
  result: InsertResult,
  payload: Record<string, unknown>,
  keep: string | undefined,
  mayBeEmpty?: (field: string) => boolean,
): FieldToLeaveOut[] | undefined {
  const details = result.errorDetails ?? [];
  if (details.length !== result.errors.length) return undefined;
  return refusedFields(details, payload, keep, mayBeEmpty);
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
 * What the sample of a row first sent without the values the target had
 * refused under its record type says: which fields, and the refusal. Nothing
 * for a row that went with all of its values.
 */
function sentWithoutNote(before: readonly FieldToLeaveOut[]): string[] {
  if (before.length === 0) return [];
  const refusals = [...new Set(before.map((f) => f.reason))].join('; ');
  return [
    `Sent without ${fieldList(before)}: the target refused the same value under the same ` +
      `record type earlier in the run, ${refusals}`,
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

  /** How long to wait before each send of a call, or of a row, the target never had. */
  private readonly backoff = new RetryStrategy({ initialDelay: RESEND_DELAY_MS });

  /**
   * @param wait - Waits out the delay before a call, or a row, is sent again.
   */
  constructor(
    private readonly deps: Pick<ForgeExecutorDeps, 'insertRecords' | 'upsertRecords'> &
      Partial<Pick<ForgeExecutorDeps, 'queryRecords' | 'updateRecords' | 'describeFields'>>,
    batchStrategy?: ForgeBatchStrategyService,
    private readonly wait: (ms: number) => Promise<void> = sleep,
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
    if (flagsNotKept) {
      tally.flagsNotKept = tally.flagsNotKept
        ? `${tally.flagsNotKept}, ${flagsNotKept}`
        : flagsNotKept;
    }
    const records = input.records.filter((_, i) => !direct.has(i));
    const cleanedRecords = input.cleanedRecords.filter((_, i) => !direct.has(i));
    const planned = this.batchStrategy.resolve(node.batchStrategy, records.length);
    // The resolved `api` used to be discarded, so a node resolved to
    // 'bulk' was sliced into 10 000-record batches and handed to the REST
    // write path, which rejects anything over 200.
    const { batchSize, batchCount, clamped } = resolveWriteBatching(planned, records.length);
    if (clamped) {
      logger.warn(
        `[forge] ${node.objectApiName}: batch strategy asked for ${planned.batchSize} records ` +
          `per call (api="${planned.api}") but the write path is "${WRITE_API}" ` +
          `(max ${WRITE_API_MAX_BATCH[WRITE_API]}) — using ${batchSize} per call ` +
          `(${batchCount} batch(es)).`,
      );
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
    );
    const write: NodeWrite = {
      objectApiName: node.objectApiName,
      targetOrgId,
      targetKeyPrefix: input.targetKeyPrefix,
      remapper,
      tally,
      byNaturalKey: [],
      refusedOnTheirFields: [],
      locked: [],
      upsertField,
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
      let outcome: CallAnswered | CallThrew;
      try {
        // A cancel stops the node before its next call — or before a call
        // that never reached the target is sent again.
        await input.waitIfPaused();
        outcome = await this.call(write, input, rows.map(sentAs));
      } catch (err) {
        settleOnStop(err);
        throw err;
      }
      if ('thrown' in outcome) {
        // A call that throws stops the node there, and what failed is its rows
        // and those of the calls it leaves unsent. Thrown on, it took down what
        // the calls before had written: counted as failed with the whole node,
        // and the lookups those rows owe lost before pass 2 could fill them in.
        this.settleThrown(write, outcome, rows, what, records.length - recordOffset - rows.length);
        // Nor are the rows refused on their fields in the calls before
        // written again: they stay the failures the target made them.
        this.leaveRefusedAsFailed(
          write,
          write.refusedOnTheirFields.splice(0),
          extractErrorMessage(outcome.thrown),
        );
        break;
      }
      await this.settleAnswers(write, rows, outcome.answers);
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
      await this.writeAgainWithoutTheirFields(write, input, batchSize);
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
    payloads: Record<string, unknown>[],
  ): Promise<CallAnswered | CallThrew> {
    for (let resends = 0; ; resends++) {
      try {
        return { answers: await this.send(write, payloads) };
      } catch (thrown) {
        const left = whatTheWriteLeft(thrown);
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
   */
  private async settleAnswers(
    write: NodeWrite,
    rows: readonly RowToWrite[],
    answers: readonly InsertResult[],
  ): Promise<void> {
    await this.readWhatMayBeEmpty(write, answers);
    rows.forEach((row, i) => {
      const answer = answers[i];
      if (answer) {
        this.settle(write, answer, row);
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
      let outcome: CallAnswered | CallThrew;
      try {
        outcome = await this.call(write, input, rows.map(sentAs));
      } catch (err) {
        this.leaveLockedAsFailed(write, locked, extractErrorMessage(err));
        throw err;
      }
      if ('thrown' in outcome) {
        this.settleThrown(write, outcome, rows, `${write.objectApiName}, sent again`, after);
        return outcome;
      }
      await this.settleAnswers(write, rows, outcome.answers);
    }
    return undefined;
  }

  /**
   * Count what the target answered for one row: written, linked to the record
   * it holds, waiting for the lookup by its natural key, to go again — for a
   * lock, or without the fields it refused — or failed.
   */
  private settle(write: NodeWrite, result: InsertResult, row: RowToWrite): void {
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
      // Record nullified FKs so pass 2 can patch them
      // once the parent target is in the IdRemapper.
      if (built && built.nullifiedFks.length > 0) {
        const sourceId = typeof built.source['Id'] === 'string' ? built.source['Id'] : undefined;
        for (const nf of built.nullifiedFks) {
          tally.pendingFkUpdates.push({
            objectApiName,
            newId: result.id,
            sourceId,
            fieldName: nf.field,
            sourceRefId: nf.sourceRefId,
            ...(nf.insertOnly ? { insertOnly: true as const } : {}),
          });
        }
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
      return;
    }
    this.rememberRefusedValues(write, result, payload);
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
    // does not take, or on a lookup its filter refuses the record of, the row
    // went down, and every record hanging from it failed or was skipped for
    // want of it. Written again without them once the calls are through, it
    // is in the target, short of a value. A second refusal, on fields the
    // first did not name, gets a round of its own.
    const mayBeEmpty = (field: string): boolean =>
      write.mayBeEmpty?.has(field.toLowerCase()) ?? false;
    const leftOut = fieldsToLeaveOut(result, payload, write.upsertField, mayBeEmpty);
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
   * A row's payload as it is first sent: without the values the target
   * refused under the record type it names earlier in the run, and those it
   * goes without, with the refusal of each. Sent with them, the row would be
   * refused for them and sent again without them, as it now is from the
   * start; its rounds without fields stay for whatever else the target
   * refuses it on. The payload itself, left as it was, when it holds none.
   */
  private withoutRefusedValues(
    write: NodeWrite,
    payload: Record<string, unknown>,
  ): { sent: Record<string, unknown>; before: FieldToLeaveOut[] } {
    const before: FieldToLeaveOut[] = [];
    if (this.refusedValues.size === 0) return { sent: payload, before };
    for (const field of Object.keys(payload)) {
      const key = this.refusedValueKey(write, payload, field);
      const refused = key === undefined ? undefined : this.refusedValues.get(key);
      if (refused) before.push({ ...refused, field });
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
      for (let start = 0; start < rows.length; start += batchSize) {
        const chunk = rows.slice(start, start + batchSize);
        let outcome: CallAnswered | CallThrew;
        try {
          await input.waitIfPaused();
          outcome = await this.call(write, input, chunk.map(sentAs));
        } catch (err) {
          this.leaveRefusedAsFailed(write, rows.slice(start), extractErrorMessage(err));
          throw err;
        }
        let stoppedBy: CallThrew | undefined;
        if ('thrown' in outcome) {
          stoppedBy = outcome;
          const why = extractErrorMessage(outcome.thrown);
          if (outcome.left === 'may-have-written') {
            this.settleThrown(write, outcome, chunk, `${write.objectApiName}, sent again`, 0);
            this.leaveRefusedAsFailed(write, rows.slice(start + batchSize), why);
          } else {
            this.leaveRefusedAsFailed(write, rows.slice(start), why);
          }
        } else {
          await this.settleAnswers(write, chunk, outcome.answers);
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
   * it responded, when the target's describe lets them be updated: what the
   * node's line says of what it could not give. See
   * `giveLinkedRelationsTheirFlags`. A run given no update of the target
   * asks nothing.
   */
  private async giveFlagsBack(
    objectApiName: string,
    targetOrgId: string,
    input: WriteNodeInput,
    linked: ReadonlyMap<number, string>,
  ): Promise<string | undefined> {
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
    return giveLinkedRelationsTheirFlags(
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
   */
  private pickUpsertField(
    fieldInfos: FieldInfo[],
    creatable: ReadonlySet<string>,
    records: Array<Record<string, unknown>>,
    mode: 'auto' | 'off',
  ): string | undefined {
    if (mode === 'off' || !this.deps.upsertRecords) return undefined;
    const candidates = fieldInfos
      .filter((f) => f.externalId && creatable.has(f.name))
      .sort((a, b) => a.name.localeCompare(b.name));
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
