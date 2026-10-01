/**
 * Batch writer stage of the Forge execution pipeline.
 *
 * Splits a node's cleaned records into batches (REST/Bulk strategy),
 * dispatches them to the target org via insert — or upsert on an external
 * Id field when `upsertMode: 'auto'` applies — registers the new
 * source→target ID mappings, links rows the target refused because it
 * already holds them to the record it named, writes once more without them
 * the rows a validation rule or a restricted picklist refused on fields it
 * named — and sends without it from the start a row holding a picklist value
 * the target refused under the same record type earlier in the run —
 * collects per-record failure samples, and queues nullified cycle FKs for
 * the pass-2 UPDATE.
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
import type {
  ForgeFieldRefusal,
  ForgeGraphNode,
  ForgeRefusedField,
  ForgeWrittenWithoutFields,
} from '@sandforge/shared';
import { SELLING_MODEL_OPTION_OBJECT, isAlreadyExistsError } from '@sandforge/shared';
import { codeAndMessage, existingRecordOf } from '../../../core/common/existingRecordMatch.js';
import { extractErrorMessage } from '../../../core/common/extractErrorMessage.js';
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
   * The rows the target refused on fields it named — a validation rule, or a
   * restricted picklist refusing their value — that went in once written
   * again without them, and those sent without a value it had refused under
   * their record type: counted among the created or updated rows too. Absent
   * when none did.
   */
  writtenWithoutFields?: WrittenWithoutFields;
}

/**
 * Rows written without the fields the target refused them on: how many, and
 * each field left out with what refused it, the refusal that named it and
 * how many of them went without it.
 */
export type WrittenWithoutFields = Omit<ForgeWrittenWithoutFields, 'objectApiName'>;

/** A field a row goes without, what refused it, and the refusal that named it. */
export type FieldToLeaveOut = Omit<ForgeRefusedField, 'rows' | 'refusedBy'> & {
  readonly refusedBy: ForgeFieldRefusal;
};

/**
 * The code a validation rule of the target refuses a row with. A trigger that
 * puts an error on one of the row's fields is reported with it too, and is
 * the same refusal of that field.
 */
const VALIDATION_RULE_REFUSAL = 'FIELD_CUSTOM_VALIDATION_EXCEPTION';

/**
 * The code a restricted picklist of the target refuses a value with: one the
 * field does not hold, one the record type the row goes in with does not
 * take, or one its controlling value does not allow.
 */
const RESTRICTED_PICKLIST_REFUSAL = 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST';

/** What refused a row on the fields its error named, by the code it refused with. */
const REFUSED_BY: ReadonlyMap<string, ForgeFieldRefusal> = new Map([
  [VALIDATION_RULE_REFUSAL, 'validation-rule'],
  [RESTRICTED_PICKLIST_REFUSAL, 'restricted-picklist'],
]);

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

/**
 * A row the target refused on fields it named — a validation rule, or a
 * restricted picklist refusing its value: it waits to be written once more
 * without them, once the node's calls are through.
 */
interface RefusedOnItsFields {
  /** The payload first sent. */
  payload: Record<string, unknown>;
  /** The record it was cleaned from: its source id, and the lookups it owes the second pass. */
  built: CleanedRecord | undefined;
  /** What the target refused it with. */
  errors: string[];
  /** The fields it goes again without, as the payload names them. */
  leftOut: FieldToLeaveOut[];
  /**
   * The fields it was first sent without, their value refused under its
   * record type earlier in the run: see `BatchWriter.withoutRefusedValues`.
   */
  before: readonly FieldToLeaveOut[];
}

/** One node's write as its calls are answered: where each answer is counted. */
interface NodeWrite {
  readonly objectApiName: string;
  /** Key prefix of the object in the target, which an id a refusal names must carry. */
  readonly targetKeyPrefix: string | null | undefined;
  readonly remapper: IdRemapper;
  readonly tally: BatchWriteResult;
  /** Duplicates the target did not name, for an object with a natural key. */
  readonly byNaturalKey: UnnamedDuplicate[];
  /** Rows the target refused on fields it named, to write again without them. */
  readonly refusedOnTheirFields: RefusedOnItsFields[];
  /** The external id the rows are upserted by, which a row never goes without. */
  readonly upsertField: string | undefined;
  /**
   * The picklist fields, by their lowercased name, whose values the run
   * remembers once the target refuses them: those the target's describe
   * lists, and makes depend on no other field.
   */
  readonly remembered: ReadonlySet<string>;
}

/**
 * `from` added to `into`, which is changed in place — or made, when there is
 * none: a field left out for the same refusal is counted once, with the rows
 * of both.
 */
export function addWrittenWithoutFields(
  into: WrittenWithoutFields | undefined,
  from: WrittenWithoutFields,
): WrittenWithoutFields {
  const sum = into ?? { rows: 0, fields: [] };
  sum.rows += from.rows;
  for (const field of from.fields) {
    const known = sum.fields.find((f) => f.field === field.field && f.reason === field.reason);
    if (known) known.rows += field.rows;
    else sum.fields.push({ ...field });
  }
  return sum;
}

/** What refused a field rows went without, as the object's line says it. */
const REFUSED_IT: Readonly<Record<ForgeFieldRefusal, string>> = {
  'validation-rule': 'a validation rule of the target refused it',
  'restricted-picklist': 'a restricted picklist of the target refused its value',
};

/**
 * What the object's line says of the rows written without the fields the
 * target refused them on: each field, how many rows went without it, what
 * refused it and in what words. Empty when none did. A field recorded before
 * a picklist's refusal was written again is a validation rule's.
 */
export function writtenWithoutFieldsNote(written: WrittenWithoutFields | undefined): string {
  return (written?.fields ?? [])
    .map(
      ({ field, refusedBy = 'validation-rule', reason, rows }) =>
        `, ${rows} written without ${field}: ${REFUSED_IT[refusedBy]}, ${reason}`,
    )
    .join('');
}

/** What refused the fields of `leftOut`, as the line of their second write says it. */
function whatRefused(leftOut: readonly FieldToLeaveOut[]): string {
  const by = new Set(leftOut.map((f) => f.refusedBy));
  if (by.size > 1) return 'a validation rule or a restricted picklist of the target';
  return by.has('restricted-picklist')
    ? 'a restricted picklist of the target'
    : 'a validation rule of the target';
}

/** Whether a payload gives a field a value: leaving out one it gives none changes nothing. */
function holdsValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

/**
 * The key of `payload` the platform named, when the payload gives it a value.
 * An API name ignores case, and a payload built from the source's describe
 * need not spell a field as the target's names it.
 */
function heldKeyOf(payload: Record<string, unknown>, named: string): string | undefined {
  const wanted = named.toLowerCase();
  return Object.keys(payload).find(
    (key) => key.toLowerCase() === wanted && holdsValue(payload[key]),
  );
}

/**
 * The fields to write a refused row again without, each with what refused it
 * and the refusal that named it: only when every error of the refusal is a
 * validation rule's or a restricted picklist's, and each names a field the
 * row gives a value to; a refusal that holds both leaves out every field they
 * name. Nothing otherwise — an error that names no field, or only fields the
 * row leaves empty, would refuse the row again whatever went, as any other
 * error would.
 *
 * A restricted picklist's refusal gets past the check before the write when
 * the record type is at fault: the check keeps a value the target's describe
 * lists, and one the UI API says the record type takes, and a record type
 * never given values of the field takes none of them while the UI API answers
 * them all. A real run was refused so on every row of an object, and what
 * hung from them failed with them. No read tells it; the refusal does. A
 * parent copied from outside the graph is written again on the same rule
 * (`OrphanExpander`).
 *
 * @param keep - A field the row cannot go without: the external id an upsert matches it by.
 */
export function fieldsToLeaveOut(
  result: InsertResult,
  payload: Record<string, unknown>,
  keep: string | undefined,
): FieldToLeaveOut[] | undefined {
  const details = result.errorDetails ?? [];
  if (details.length === 0 || details.length !== result.errors.length) return undefined;
  const leftOut = new Map<string, FieldToLeaveOut>();
  for (const detail of details) {
    const refusedBy = REFUSED_BY.get(detail.statusCode);
    if (!refusedBy) return undefined;
    const held = detail.fields
      .map((named) => heldKeyOf(payload, named))
      .filter(
        (key): key is string => key !== undefined && key.toLowerCase() !== keep?.toLowerCase(),
      );
    if (held.length === 0) return undefined;
    for (const field of held) {
      if (!leftOut.has(field)) {
        leftOut.set(field, { field, refusedBy, reason: codeAndMessage(detail) });
      }
    }
  }
  return [...leftOut.values()];
}

/** `payload` without the fields of `leftOut`, the payload itself left as it was. */
export function without(
  payload: Record<string, unknown>,
  leftOut: readonly FieldToLeaveOut[],
): Record<string, unknown> {
  const fields = new Set(leftOut.map((f) => f.field));
  return Object.fromEntries(Object.entries(payload).filter(([key]) => !fields.has(key)));
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

  constructor(
    private readonly deps: Pick<ForgeExecutorDeps, 'insertRecords' | 'upsertRecords'> &
      Partial<Pick<ForgeExecutorDeps, 'queryRecords' | 'updateRecords' | 'describeFields'>>,
    batchStrategy?: ForgeBatchStrategyService,
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
      targetKeyPrefix: input.targetKeyPrefix,
      remapper,
      tally,
      byNaturalKey: [],
      refusedOnTheirFields: [],
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
     * when the lookup cannot be read. The rows refused on their fields stay
     * the failures the target made them, as when the call that writes them
     * again fails.
     */
    const settleOnStop = (err: unknown): void => {
      const why = extractErrorMessage(err);
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
      try {
        await input.waitIfPaused();
      } catch (err) {
        // A cancel stops the node before its next call.
        settleOnStop(err);
        throw err;
      }

      // A value the target refused under a row's record type in a call before
      // goes no more: the row is sent without it, as it would have been sent
      // again once refused for it.
      const prepared = records
        .slice(b * batchSize, (b + 1) * batchSize)
        .map((payload) => this.withoutRefusedValues(write, payload));
      const batch = prepared.map((row) => row.sent);
      let results: InsertResult[];
      try {
        results = await this.send(write, targetOrgId, batch);
      } catch (err) {
        // A call that throws stops the node there, and what failed is its rows
        // and those of the calls it leaves unsent. Thrown on, it took down what
        // the calls before had written: counted as failed with the whole node,
        // and the lookups those rows owe lost before pass 2 could fill them in.
        const notWritten = records.length - recordOffset;
        tally.failureCount += notWritten;
        this.sample(tally, {
          recordSummary: `${node.objectApiName} batch ${b + 1}/${batchCount}: ${notWritten} record${notWritten === 1 ? '' : 's'} not written`,
          messages: [extractErrorMessage(err)],
        });
        // Nor are the rows refused on their fields in the calls before
        // written again: they stay the failures the target made them.
        this.leaveRefusedAsFailed(
          write,
          write.refusedOnTheirFields.splice(0),
          extractErrorMessage(err),
        );
        break;
      }

      // Register new IDs for this batch + capture failure samples.
      // Use cleanedRecords (post required-FK skip) for the source-ID
      // lookup so remapper entries point at the correct origin record.
      //
      // Defense: jsforce/Salesforce should return one result per input
      // record (and in input order), but partial-failure modes have
      // truncated arrays in the wild. If results.length < batch.length,
      // count the missing entries as failures and KEEP recordOffset
      // aligned to batch.length so subsequent batches still index
      // correctly.
      const expected = batch.length;
      const actual = results.length;
      for (let i = 0; i < actual; i++) {
        // An answer past the rows sent — a writer that answered more than it
        // was given — has no row behind it, and nothing it went without.
        const before = i < expected ? prepared[i].before : [];
        this.settle(
          write,
          results[i],
          batch[i],
          cleanedRecords[recordOffset + i],
          undefined,
          before,
        );
      }
      // Account for missing results — keeps recordOffset aligned with
      // the source batch and prevents IdRemapper cross-contamination.
      for (let i = actual; i < expected; i++) {
        tally.failureCount++;
        this.sample(tally, {
          recordSummary: summarizeRecordForError(batch[i]),
          messages: [
            `No result returned for record (API truncated batch: ${actual}/${expected})`,
            ...sentWithoutNote(prepared[i].before),
          ],
        });
      }

      recordOffset += expected;

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
  private send(
    write: NodeWrite,
    targetOrgId: string,
    records: Record<string, unknown>[],
  ): Promise<InsertResult[]> {
    return write.upsertField && this.deps.upsertRecords
      ? this.deps.upsertRecords(targetOrgId, write.objectApiName, write.upsertField, records)
      : this.deps.insertRecords(targetOrgId, write.objectApiName, records);
  }

  /** Keep `sample` among the node's samples, while it holds fewer than three. */
  private sample(tally: BatchWriteResult, sample: ExecutionErrorSample): void {
    if (tally.errorSamples.length < 3) tally.errorSamples.push(sample);
  }

  /**
   * Count what the target answered for one row.
   *
   * @param payload - What was sent for it.
   * @param built - The record it was cleaned from.
   * @param retried - Set when the row went again without the fields the
   *   target refused it on: it is not sent a third time.
   * @param before - The fields it was first sent without, their value refused
   *   under its record type earlier in the run.
   */
  private settle(
    write: NodeWrite,
    result: InsertResult,
    payload: Record<string, unknown>,
    built: CleanedRecord | undefined,
    retried?: RefusedOnItsFields,
    before: readonly FieldToLeaveOut[] = retried?.before ?? [],
  ): void {
    const { tally, remapper, objectApiName } = write;
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
      const leftOut = [...before, ...(retried?.leftOut ?? [])];
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
    // Refused on fields a validation rule named — a phone the target wants
    // in another format — or on a restricted picklist's value its record
    // type does not take, the row went down, and every record hanging from
    // it failed or was skipped for want of it. Written again without them
    // once the calls are through, it is in the target, short of a value.
    const leftOut = retried ? undefined : fieldsToLeaveOut(result, payload, write.upsertField);
    if (leftOut) {
      write.refusedOnTheirFields.push({ payload, built, errors: result.errors, leftOut, before });
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
      recordSummary: summarizeRecordForError(retried?.payload ?? payload),
      // Refused again, the row fails with what the target said the second
      // time, and says what it was first refused with — and why it went
      // without a value from the start, when it did.
      messages: [
        ...result.errors,
        ...(retried ? [sentAgainNote(retried.leftOut, retried.errors)] : []),
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
   * start; its one second call stays for whatever else the target refuses it
   * on. The payload itself, left as it was, when it holds none.
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
   * Count as failed, with what the target refused them with, rows it refused
   * on their fields that a cancel or a call that threw kept from being
   * written again, each sample saying why.
   */
  private leaveRefusedAsFailed(
    write: NodeWrite,
    rows: readonly RefusedOnItsFields[],
    why: string,
  ): void {
    for (const row of rows) {
      write.tally.failureCount++;
      this.sample(write.tally, {
        recordSummary: summarizeRecordForError(row.payload),
        messages: [
          ...row.errors,
          `Not written again without ${fieldList(row.leftOut)}: ${why}`,
          ...sentWithoutNote(row.before),
        ],
      });
    }
  }

  /**
   * Write once more, without the fields the target refused them on, the rows
   * it refused so — through the call that first wrote them, after the
   * checkpoint each call has, as many to a call, and once each. A row taken
   * this time counts as written, and its children find it in the remap
   * table; the fields it went without are counted for the object's line. A
   * row refused again stays a failure, with the second refusal. A call that
   * throws stops the node there, as one of the first write does, its rows and
   * those after it failures; a cancel at the checkpoint leaves them so too,
   * and is thrown on.
   */
  private async writeAgainWithoutTheirFields(
    write: NodeWrite,
    input: WriteNodeInput,
    batchSize: number,
  ): Promise<void> {
    const rows = write.refusedOnTheirFields.splice(0);
    if (rows.length === 0) return;
    input.onProgress({
      objectName: write.objectApiName,
      status: 'running',
      progress: 100,
      message:
        `Writing ${rows.length} ${write.objectApiName} record${rows.length === 1 ? '' : 's'} ` +
        `again without the fields ${whatRefused(rows.flatMap((row) => row.leftOut))} refused...`,
    });
    for (let start = 0; start < rows.length; start += batchSize) {
      try {
        await input.waitIfPaused();
      } catch (err) {
        this.leaveRefusedAsFailed(write, rows.slice(start), extractErrorMessage(err));
        throw err;
      }
      const chunk = rows.slice(start, start + batchSize);
      const payloads = chunk.map((row) => without(row.payload, row.leftOut));
      let results: InsertResult[];
      try {
        results = await this.send(write, input.targetOrgId, payloads);
      } catch (err) {
        this.leaveRefusedAsFailed(write, rows.slice(start), extractErrorMessage(err));
        return;
      }
      chunk.forEach((row, i) => {
        const result = results[i];
        if (result) {
          this.settle(write, result, payloads[i], row.built, row);
          return;
        }
        write.tally.failureCount++;
        this.sample(write.tally, {
          recordSummary: summarizeRecordForError(row.payload),
          messages: [
            `No result returned for record (API truncated batch: ${results.length}/${chunk.length})`,
            sentAgainNote(row.leftOut, row.errors),
            ...sentWithoutNote(row.before),
          ],
        });
      });
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
