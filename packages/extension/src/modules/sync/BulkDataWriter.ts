import type { Connection } from 'jsforce';
import { duplicateRuleHeaders } from '@sandforge/shared';
import type { RetryConfig } from '../../core/engine/RetryStrategy.js';
import { RetryableOperation } from '../../core/engine/RetryableOperation.js';
import type { BulkApiExecutor } from '../../core/engine/BulkApiExecutor.js';
import type {
  BulkApiConnection,
  BulkApiExecutorDeps,
  BulkOperation,
} from '../../core/engine/BulkApiExecutor.js';
import type { BulkApiManager } from '../../core/engine/BulkApiManager.js';
import { ChunkedBulkExecutor } from '../../core/engine/ChunkedBulkExecutor.js';
import {
  duplicateRuleMatchIds,
  existingRecordOf,
  formatSaveError,
} from '../../core/common/existingRecordMatch.js';
import type { OperationOutcome } from './DataSync.js';

/** Record count threshold above which the streaming pipeline is used. */
const STREAMING_THRESHOLD = 10_000;

/** Minimal shape of a jsforce per-record DML result. */
type JsforceResult = {
  success: boolean;
  id?: string;
  errors?: Array<{ statusCode?: string; message: string }>;
};

/** Dependencies required by BulkDataWriter. */
export interface BulkDataWriterDeps {
  /**
   * Key prefix of an object in the target org, when the caller holds its
   * describe. A duplicate's id must carry it before an outcome names it as
   * the record the target already holds; without it the id is checked for
   * form alone.
   */
  keyPrefixOf?: (objectName: string) => string | null | undefined;
  /** jsforce connection to the target org. */
  connection: Connection;
  /** Selects REST vs Bulk API based on record count. */
  bulkExecutor: BulkApiExecutor;
  /** Bounds the number of concurrent Bulk API jobs. */
  bulkManager: BulkApiManager;
  /** Retry configuration for REST batch calls. */
  retryConfig: Partial<RetryConfig>;
  /** Abort signal cancelling the streaming upload path. */
  signal: AbortSignal;
  /** Progress sink invoked by the streaming and bulk paths. */
  onProgress: (processed: number, total: number, label: string) => void;
  /** Log sink for non-fatal validation warnings. */
  log: (message: string) => void;
}

/**
 * Writes records to a target Salesforce org via insert/upsert/update/delete.
 *
 * Mutualizes the three execution paths shared by all four DML operations:
 * - streaming chunked upload for very large record sets (> STREAMING_THRESHOLD),
 * - Bulk API 2.0 above the configured bulk threshold,
 * - REST batches with retry for small record sets.
 *
 * Extracted from SyncOpsHandler so the handler only orchestrates
 * message handling while this class owns the write mechanics.
 */
/**
 * A sync between two orgs writes rows that look exactly like rows the target
 * already has — which is what a duplicate rule exists to stop. Forge learnt
 * this on a live pair of sandboxes in 2026-09 and started sending the header
 * Salesforce provides for it; Sync did not, and fourteen of sixteen accounts
 * were refused with "You are creating a duplicate record" on the first real
 * run of it. See `duplicate-rules.ts`: the header waives duplicate RULES only,
 * a unique index still refuses, and what protects a production org is the
 * production guard rather than a data-quality rule.
 */
export class BulkDataWriter {
  private readonly retryOp: RetryableOperation;

  /** @param deps - Injected writer dependencies. */
  constructor(private readonly deps: BulkDataWriterDeps) {
    this.retryOp = new RetryableOperation({
      retryConfig: deps.retryConfig,
      onRetry: (attempt, classified, delay) => {
        deps.log(
          `[RETRY] sync attempt=${attempt} code=${classified.originalError.statusCode} delay=${delay}ms`,
        );
      },
    });
  }

  /**
   * Insert records into the target org.
   *
   * @param objectName - Salesforce object API name.
   * @param records - Records to insert.
   * @param batchSize - REST batch size (small-record path only).
   * @returns Per-record outcomes aligned with the input order.
   */
  async insert(
    objectName: string,
    records: Record<string, unknown>[],
    batchSize: number,
  ): Promise<OperationOutcome[]> {
    const streamed = await this.tryStreaming('insert', objectName, records);
    if (streamed) return streamed;

    const bulked = await this.tryBulk('insert', objectName, records);
    if (bulked) return bulked;

    return this.executeRestBatches(
      objectName,
      records,
      batchSize,
      (batch) =>
        this.deps.connection
          .sobject(objectName)
          .create(batch, { headers: duplicateRuleHeaders(true) }) as Promise<JsforceResult[]>,
      'Insert failed after retries',
    );
  }

  /**
   * Upsert records into the target org using an external ID field.
   *
   * @param objectName - Salesforce object API name.
   * @param externalIdField - External ID field used as the upsert key.
   * @param records - Records to upsert.
   * @param batchSize - REST batch size (small-record path only).
   * @returns Per-record outcomes aligned with the input order.
   */
  async upsert(
    objectName: string,
    externalIdField: string,
    records: Record<string, unknown>[],
    batchSize: number,
  ): Promise<OperationOutcome[]> {
    const streamed = await this.tryStreaming('upsert', objectName, records, externalIdField);
    if (streamed) return streamed;

    const bulked = await this.tryBulk('upsert', objectName, records, externalIdField);
    if (bulked) return bulked;

    return this.executeRestBatches(
      objectName,
      records,
      batchSize,
      (batch) =>
        this.deps.connection.sobject(objectName).upsert(batch, externalIdField, {
          headers: duplicateRuleHeaders(true),
        }) as unknown as Promise<JsforceResult[]>,
      'Upsert failed after retries',
    );
  }

  /**
   * Update records in the target org (records must carry their `Id`).
   *
   * @param objectName - Salesforce object API name.
   * @param records - Records to update.
   * @param batchSize - REST batch size (small-record path only).
   * @returns Per-record outcomes aligned with the input order.
   */
  async update(
    objectName: string,
    records: Record<string, unknown>[],
    batchSize: number,
  ): Promise<OperationOutcome[]> {
    const streamed = await this.tryStreaming('update', objectName, records);
    if (streamed) return streamed;

    const bulked = await this.tryBulk('update', objectName, records);
    if (bulked) return bulked;

    return this.executeRestBatches(
      objectName,
      records,
      batchSize,
      (batch) =>
        this.deps.connection
          .sobject(objectName)
          .update(batch as Array<Record<string, unknown> & { Id: string }>) as unknown as Promise<
          JsforceResult[]
        >,
      'Update failed after retries',
    );
  }

  /**
   * Delete records from the target org by ID.
   * Deletes have no streaming path: IDs are cheap to hold in memory, so only
   * the Bulk API and REST batch paths apply.
   *
   * @param objectName - Salesforce object API name.
   * @param recordIds - IDs of the records to delete.
   * @param batchSize - REST batch size (small-record path only).
   * @returns Per-record outcomes aligned with the input order.
   */
  async delete(
    objectName: string,
    recordIds: string[],
    batchSize: number,
  ): Promise<OperationOutcome[]> {
    const bulkRecords = recordIds.map((id) => ({ Id: id }));
    const bulked = await this.tryBulk('delete', objectName, bulkRecords);
    if (bulked) return bulked;

    return this.executeRestBatches(
      objectName,
      recordIds,
      batchSize,
      (batch) =>
        this.deps.connection.sobject(objectName).destroy(batch) as unknown as Promise<
          JsforceResult[]
        >,
      'Delete failed after retries',
    );
  }

  /**
   * Run the streaming chunked-upload path when the record set exceeds
   * STREAMING_THRESHOLD. Returns `undefined` when streaming does not apply.
   */
  private async tryStreaming(
    operation: BulkOperation,
    objectName: string,
    records: Record<string, unknown>[],
    externalIdField?: string,
  ): Promise<OperationOutcome[] | undefined> {
    if (records.length <= STREAMING_THRESHOLD) return undefined;

    const chunkedExecutor = new ChunkedBulkExecutor({ signal: this.deps.signal });
    const bulkDeps: BulkApiExecutorDeps = {
      connection: this.deps.connection as unknown as BulkApiConnection,
      bulkManager: this.deps.bulkManager,
      onProgress: (processed, total) => {
        this.deps.onProgress(processed, total, `Streaming ${operation} ${objectName}`);
      },
    };
    const streamResult = await chunkedExecutor.executeChunked(
      bulkDeps,
      objectName,
      operation,
      chunkedExecutor.createChunkGenerator(records),
      records.length,
      externalIdField,
      // Full array is already in memory here — enables honest per-record
      // result attribution instead of the old "first successCount succeeded"
      // assumption, which misattributed failures after partial job errors.
      records,
    );
    return (streamResult.outcomes ?? []).map((outcome) =>
      this.withExistingRecord(objectName, {
        id: outcome.id,
        success: outcome.success,
        errors: outcome.success ? [] : [outcome.error ?? 'Streaming error'],
      }),
    );
  }

  /**
   * Run the Bulk API 2.0 path when the record count exceeds the configured
   * bulk threshold. Returns `undefined` when Bulk API does not apply.
   */
  private async tryBulk(
    operation: BulkOperation,
    objectName: string,
    records: Record<string, unknown>[],
    externalIdField?: string,
  ): Promise<OperationOutcome[] | undefined> {
    if (!this.deps.bulkExecutor.shouldUseBulkApi(records.length)) return undefined;

    const bulkDeps: BulkApiExecutorDeps = {
      connection: this.deps.connection as unknown as BulkApiConnection,
      bulkManager: this.deps.bulkManager,
      onProgress: (processed, total) => {
        this.deps.onProgress(processed, total, `Bulk ${operation} ${objectName}`);
      },
    };
    const bulkResult = await this.deps.bulkExecutor.executeBulk(
      bulkDeps,
      objectName,
      operation,
      records,
      externalIdField,
    );
    // Real per-record outcomes: input-aligned, real Salesforce IDs (the old
    // code fabricated `bulk-${i}` IDs and assumed the first successCount
    // records had succeeded).
    return bulkResult.outcomes.map((outcome) =>
      this.withExistingRecord(objectName, {
        id: outcome.id,
        success: outcome.success,
        errors: outcome.success ? [] : [outcome.error ?? 'Bulk error'],
      }),
    );
  }

  /**
   * `outcome`, with the record the target already holds when its refusal
   * names one. Bulk API writes the whole refusal into `sf__Error`, code and
   * id included, so its text is all there is to read.
   */
  private withExistingRecord(objectName: string, outcome: OperationOutcome): OperationOutcome {
    if (outcome.success) return outcome;
    const existing = existingRecordOf(outcome, this.deps.keyPrefixOf?.(objectName));
    return existing.kind === 'linked' ? { ...outcome, existingId: existing.id } : outcome;
  }

  /**
   * Run the REST batch path: slice items into batches, execute each batch
   * with retry, and flatten per-record results. A batch that exhausts its
   * retries marks every item in it as failed with the last error message.
   */
  private async executeRestBatches<T>(
    objectName: string,
    items: T[],
    batchSize: number,
    call: (batch: T[]) => Promise<JsforceResult[]>,
    failureMessage: string,
  ): Promise<OperationOutcome[]> {
    const outcomes: OperationOutcome[] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const retryResult = await this.retryOp.execute(() => call(batch));
      if (retryResult.success && retryResult.result) {
        for (const r of Array.isArray(retryResult.result)
          ? retryResult.result
          : [retryResult.result]) {
          outcomes.push(this.restOutcome(objectName, r));
        }
      } else {
        outcomes.push(
          ...batch.map(() => ({
            success: false as const,
            errors: [retryResult.error?.message ?? failureMessage],
          })),
        );
      }
    }
    return outcomes;
  }

  /**
   * One REST result as an outcome. The first error is the one reported, now
   * with its status code — the code is what says a row already exists — and
   * every error, with the records a duplicate rule matched, decides whether
   * the target named the record it already holds.
   */
  private restOutcome(objectName: string, r: JsforceResult): OperationOutcome {
    if (r.success) return { id: r.id, success: true, errors: [] };
    const errors: unknown[] = r.errors ?? [];
    const formatted = errors.map(formatSaveError);
    const outcome: OperationOutcome = {
      id: r.id,
      success: false,
      errors: [formatted[0] ?? 'Unknown error'],
    };
    const existing = existingRecordOf(
      {
        success: false,
        errors: formatted,
        duplicateMatchIds: errors.flatMap((e) => duplicateRuleMatchIds(e, objectName)),
      },
      this.deps.keyPrefixOf?.(objectName),
    );
    return existing.kind === 'linked' ? { ...outcome, existingId: existing.id } : outcome;
  }
}
