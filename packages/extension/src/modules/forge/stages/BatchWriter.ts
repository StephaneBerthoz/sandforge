/**
 * Batch writer stage of the Forge execution pipeline.
 *
 * Splits a node's cleaned records into batches (REST/Bulk strategy),
 * dispatches them to the target org via insert — or upsert on an external
 * Id field when `upsertMode: 'auto'` applies — registers the new
 * source→target ID mappings, links rows the target refused because it
 * already holds them to the record it named, collects per-record failure
 * samples, and queues nullified cycle FKs for the pass-2 UPDATE.
 *
 * Pause/abort is honored between batches through the `waitIfPaused`
 * checkpoint injected by the executor.
 */

import type {
  ExecutionErrorSample,
  FieldInfo,
  ForgeExecutorDeps,
  ForgeProgressEvent,
  InsertResult,
} from '../ForgeExecutor.js';
import type { ForgeGraphNode } from '@sandforge/shared';
import { SELLING_MODEL_OPTION_OBJECT, isAlreadyExistsError } from '@sandforge/shared';
import { existingRecordOf } from '../../../core/common/existingRecordMatch.js';
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
   * Source→target ID mappings accumulated so far — mutated on success, and
   * for a row the target already held.
   */
  remapper: IdRemapper;
  /** Pause/abort checkpoint — called between batch iterations. */
  waitIfPaused: () => Promise<void>;
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
      const oldId = input.cleanedRecords[index]?.source['Id'];
      if (typeof oldId === 'string') remapper.addExisting(oldId, id, node.objectApiName);
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
    /** Duplicates the target did not name, for an object with a natural key. */
    const byNaturalKey: UnnamedDuplicate[] = [];

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

    for (let b = 0; b < batchCount; b++) {
      try {
        await input.waitIfPaused();
      } catch (err) {
        // A cancel stops the node before its next call. The duplicates the
        // target refused in the calls before, without naming the record, were
        // left waiting for a lookup the run no longer makes: neither linked
        // nor counted, missing from what the run said it did. Not written,
        // they stay failures the run could not identify, as when the lookup
        // cannot be read.
        this.settleByNaturalKey(
          node.objectApiName,
          byNaturalKey,
          [],
          remapper,
          tally,
          `The record the target holds under the same key was not looked up: ${extractErrorMessage(err)}`,
        );
        throw err;
      }

      const batch = records.slice(b * batchSize, (b + 1) * batchSize);
      let results: InsertResult[];
      try {
        results =
          upsertField && this.deps.upsertRecords
            ? await this.deps.upsertRecords(targetOrgId, node.objectApiName, upsertField, batch)
            : await this.deps.insertRecords(targetOrgId, node.objectApiName, batch);
      } catch (err) {
        // A call that throws stops the node there, and what failed is its rows
        // and those of the calls it leaves unsent. Thrown on, it took down what
        // the calls before had written: counted as failed with the whole node,
        // and the lookups those rows owe lost before pass 2 could fill them in.
        const notWritten = records.length - recordOffset;
        tally.failureCount += notWritten;
        if (tally.errorSamples.length < 3) {
          tally.errorSamples.push({
            recordSummary: `${node.objectApiName} batch ${b + 1}/${batchCount}: ${notWritten} record${notWritten === 1 ? '' : 's'} not written`,
            messages: [extractErrorMessage(err)],
          });
        }
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
        const result = results[i];
        if (result.success) {
          const built = cleanedRecords[recordOffset + i];
          const oldId = built?.source['Id'];
          // An upsert that matched a record by its external id wrote over one
          // the target already held. Its children point at it all the same,
          // but it is not the run's: counted as updated, and a removal of the
          // run's records must never reach it.
          const updated = result.created === false;
          if (updated) tally.updatedCount++;
          else tally.successCount++;
          if (typeof oldId === 'string') {
            if (updated) remapper.addUpdated(oldId, result.id, node.objectApiName);
            else remapper.add(oldId, result.id, node.objectApiName);
          }
          // Record nullified FKs so pass 2 can patch them
          // once the parent target is in the IdRemapper.
          if (built && built.nullifiedFks.length > 0) {
            const sourceId =
              typeof built.source['Id'] === 'string' ? built.source['Id'] : undefined;
            for (const nf of built.nullifiedFks) {
              tally.pendingFkUpdates.push({
                objectApiName: node.objectApiName,
                newId: result.id,
                sourceId,
                fieldName: nf.field,
                sourceRefId: nf.sourceRefId,
              });
            }
          }
        } else {
          const existing = existingRecordOf(result, input.targetKeyPrefix);
          if (existing.kind === 'linked') {
            // The target refused the row because it holds it, and said which
            // record that is. The children link to it; nothing is written to
            // it — no update, and no pass-2 patch of its lookups, which would
            // overwrite a record this run did not create.
            tally.linkedExistingCount++;
            const oldId = cleanedRecords[recordOffset + i]?.source['Id'];
            if (typeof oldId === 'string') {
              remapper.addExisting(oldId, existing.id, node.objectApiName);
            }
            continue;
          }
          const naturalKey = NATURAL_KEYS[node.objectApiName];
          if (existing.kind === 'unidentified' && naturalKey) {
            // Settled after the batches: the record may be found by its key.
            byNaturalKey.push({
              payload: batch[i],
              sourceId: cleanedRecords[recordOffset + i]?.source['Id'],
              errors: result.errors,
            });
            continue;
          }
          tally.failureCount++;
          if (existing.kind === 'unidentified') tally.unidentifiedExistingCount++;
          // Counted apart because it says something different from a failure:
          // the target already holds the row, so nothing downstream of it is
          // orphaned. See `isAlreadyExistsError`.
          if (result.errors.every((m) => isAlreadyExistsError(m))) tally.alreadyExistsCount++;
          if (tally.errorSamples.length < 3) {
            tally.errorSamples.push({
              recordSummary: summarizeRecordForError(batch[i]),
              messages: result.errors,
            });
          }
        }
      }
      // Account for missing results — keeps recordOffset aligned with
      // the source batch and prevents IdRemapper cross-contamination.
      if (actual < expected) {
        for (let i = actual; i < expected; i++) {
          tally.failureCount++;
          if (tally.errorSamples.length < 3) {
            tally.errorSamples.push({
              recordSummary: summarizeRecordForError(batch[i]),
              messages: [
                `No result returned for record (API truncated batch: ${actual}/${expected})`,
              ],
            });
          }
        }
      }

      recordOffset += expected;

      input.onProgress({
        objectName: node.objectApiName,
        status: 'running',
        progress: Math.round(((b + 1) / batchCount) * 100),
        message: `batch ${b + 1}/${batchCount} — ${Math.min((b + 1) * batchSize, records.length)}/${records.length} records`,
      });
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
