/**
 * Batch writer stage of the Forge execution pipeline.
 *
 * Splits a node's cleaned records into batches (REST/Bulk strategy),
 * dispatches them to the target org via insert — or upsert on an external
 * Id field when `upsertMode: 'auto'` applies — registers the new
 * source→target ID mappings, collects per-record failure samples, and
 * queues nullified cycle FKs for the pass-2 UPDATE.
 *
 * Pause/abort is honored between batches through the `waitIfPaused`
 * checkpoint injected by the executor.
 */

import type {
  ExecutionErrorSample,
  FieldInfo,
  ForgeExecutorDeps,
  ForgeProgressEvent,
} from '../ForgeExecutor.js';
import type { ForgeGraphNode } from '@sandforge/shared';
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
 * `ForgeBatchStrategy.batchSize` alone (PERF-01): the strategy returns
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
 * more than the write API accepts.
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
    batchCount: Math.max(1, Math.ceil(recordCount / batchSize)),
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
  /** Source→target ID mappings accumulated so far (mutated on success). */
  remapper: IdRemapper;
  /** Pause/abort checkpoint — called between batch iterations. */
  waitIfPaused: () => Promise<void>;
  /** Progress sink for batch-level events. */
  onProgress: (event: ForgeProgressEvent) => void;
}

/** Outcome of writing one node's records. */
export interface BatchWriteResult {
  /** Records successfully inserted/upserted. */
  successCount: number;
  /** Records that failed (including API-truncated results). */
  failureCount: number;
  /** Up to 3 sampled failures (truncated to keep payloads UI-friendly). */
  errorSamples: ExecutionErrorSample[];
  /** Nullified cycle FKs of successfully inserted records — pass-2 input. */
  pendingFkUpdates: PendingFkUpdate[];
}

/**
 * Writes one node's records to the target org in batches, tracking new ID
 * mappings and failure samples along the way.
 */
export class BatchWriter {
  private readonly batchStrategy: ForgeBatchStrategyService;

  constructor(
    private readonly deps: Pick<ForgeExecutorDeps, 'insertRecords' | 'upsertRecords'>,
    batchStrategy?: ForgeBatchStrategyService,
  ) {
    this.batchStrategy = batchStrategy ?? new ForgeBatchStrategyService();
  }

  /**
   * Batch and insert (or upsert) the node's records into the target org.
   * Emits the `running` progress events; the caller owns the terminal
   * `done`/`error` node event and the fail-fast bookkeeping.
   */
  async writeNode(input: WriteNodeInput): Promise<BatchWriteResult> {
    const { node, records, cleanedRecords, fieldInfos, creatableFields, targetOrgId, remapper } =
      input;
    const planned = this.batchStrategy.resolve(node.batchStrategy, records.length);
    // PERF-01: the resolved `api` used to be discarded, so a node resolved to
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
      message: `Inserting ${records.length} ${node.objectApiName} records in ${batchCount} batch(es)...`,
    });

    let nodeSuccess = 0;
    let nodeFailure = 0;
    let recordOffset = 0;
    const nodeErrorSamples: ExecutionErrorSample[] = [];
    const pendingFkUpdates: PendingFkUpdate[] = [];

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
      await input.waitIfPaused();

      const batch = records.slice(b * batchSize, (b + 1) * batchSize);
      const results =
        upsertField && this.deps.upsertRecords
          ? await this.deps.upsertRecords(targetOrgId, node.objectApiName, upsertField, batch)
          : await this.deps.insertRecords(targetOrgId, node.objectApiName, batch);

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
          nodeSuccess++;
          const built = cleanedRecords[recordOffset + i];
          const oldId = built?.source['Id'];
          if (typeof oldId === 'string') {
            remapper.add(oldId, result.id);
          }
          // Wave 2 v3 — record nullified FKs so pass 2 can patch them
          // once the parent target is in the IdRemapper.
          if (built && built.nullifiedFks.length > 0) {
            const sourceId =
              typeof built.source['Id'] === 'string' ? built.source['Id'] : undefined;
            for (const nf of built.nullifiedFks) {
              pendingFkUpdates.push({
                objectApiName: node.objectApiName,
                newId: result.id,
                sourceId,
                fieldName: nf.field,
                sourceRefId: nf.sourceRefId,
              });
            }
          }
        } else {
          nodeFailure++;
          if (nodeErrorSamples.length < 3) {
            nodeErrorSamples.push({
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
          nodeFailure++;
          if (nodeErrorSamples.length < 3) {
            nodeErrorSamples.push({
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

    return {
      successCount: nodeSuccess,
      failureCount: nodeFailure,
      errorSamples: nodeErrorSamples,
      pendingFkUpdates,
    };
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
        // CR-004: log the chosen field so the user can attribute
        // upsert-related errors to the picked external Id without
        // having to re-derive it from describe metadata.
        logger.info(
          `[forge] upsert: using "${c.name}" as external Id (unique across ${records.length} records)`,
        );
        return c.name;
      }
    }
    // CR-004: no clean winner → fall BACK TO INSERT instead of the
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
    // CR-020: explicit handling for undefined and objects so debug output
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
