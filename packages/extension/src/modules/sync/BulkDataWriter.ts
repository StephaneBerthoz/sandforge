import type { Connection } from 'jsforce';
import type { RetryConfig } from '../../core/engine/RetryStrategy.js';
import { RetryableOperation } from '../../core/engine/RetryableOperation.js';
import { TimeoutManager } from '../../core/engine/TimeoutManager.js';
import type { BulkApiExecutor } from '../../core/engine/BulkApiExecutor.js';
import type {
  BulkApiConnection,
  BulkApiExecutorDeps,
  BulkOperation,
} from '../../core/engine/BulkApiExecutor.js';
import type { BulkApiManager } from '../../core/engine/BulkApiManager.js';
import { ChunkedBulkExecutor } from '../../core/engine/ChunkedBulkExecutor.js';
import { FieldTypeValidator } from './FieldTypeValidator.js';
import type { FieldDescriptor } from './FieldTypeValidator.js';
import type { OperationOutcome } from './DataSync.js';

/** Record count threshold above which the streaming pipeline is used. */
const STREAMING_THRESHOLD = 10_000;

/** Minimal shape of a jsforce per-record DML result. */
type JsforceResult = { success: boolean; id?: string; errors?: Array<{ message: string }> };

/** Dependencies required by BulkDataWriter. */
export interface BulkDataWriterDeps {
  /** jsforce connection to the target org. */
  connection: Connection;
  /** Selects REST vs Bulk API based on record count. */
  bulkExecutor: BulkApiExecutor;
  /** Bounds the number of concurrent Bulk API jobs. */
  bulkManager: BulkApiManager;
  /** Retry configuration for REST batch calls. */
  retryConfig: Partial<RetryConfig>;
  /** Timeout (ms) for the pre-upsert describe call. */
  describeTimeoutMs: number;
  /** Abort signal cancelling the streaming upload path. */
  signal: AbortSignal;
  /** Progress sink invoked by the streaming and bulk paths. */
  onProgress: (processed: number, total: number, label: string) => void;
  /** Log sink for non-fatal validation warnings. */
  log: (message: string) => void;
}

/**
 * Convert a describe field result to a FieldDescriptor for FieldTypeValidator.
 * Maps the jsforce describe shape to the validator's input type.
 */
function toValidatorField(f: { name: string; type: string; length: number }): FieldDescriptor {
  return { apiName: f.name, type: f.type, maxLength: f.length || undefined };
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
export class BulkDataWriter {
  private readonly retryOp: RetryableOperation;
  private readonly fieldValidator = new FieldTypeValidator();

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
      records,
      batchSize,
      (batch) =>
        this.deps.connection.sobject(objectName).create(batch) as Promise<JsforceResult[]>,
      'Insert failed after retries',
    );
  }

  /**
   * Upsert records into the target org using an external ID field.
   * The REST path validates source field types against the target describe first.
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

    await this.validateUpsertFieldTypes(objectName, records);

    return this.executeRestBatches(
      records,
      batchSize,
      (batch) =>
        this.deps.connection
          .sobject(objectName)
          .upsert(batch, externalIdField) as unknown as Promise<JsforceResult[]>,
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
    );
    return Array.from({ length: records.length }, (_, i) => ({
      id:
        i < streamResult.successCount ? (streamResult.successIds[i] ?? `stream-${i}`) : undefined,
      success: i < streamResult.successCount,
      errors:
        i >= streamResult.successCount
          ? [streamResult.errors[i - streamResult.successCount] ?? 'Streaming error']
          : [],
    }));
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
    return Array.from({ length: bulkResult.totalRecords }, (_, i) => ({
      id: i < bulkResult.successCount ? `bulk-${i}` : undefined,
      success: i < bulkResult.successCount,
      errors:
        i >= bulkResult.successCount
          ? [bulkResult.failures.find((f) => f.recordIndex === i)?.error ?? 'Bulk error']
          : [],
    }));
  }

  /**
   * Run the REST batch path: slice items into batches, execute each batch
   * with retry, and flatten per-record results. A batch that exhausts its
   * retries marks every item in it as failed with the last error message.
   */
  private async executeRestBatches<T>(
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
          outcomes.push({
            id: r.id,
            success: r.success,
            errors: r.success ? [] : [r.errors?.[0]?.message ?? 'Unknown error'],
          });
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
   * Validate source field types against the target describe before a REST
   * upsert. Validation failures are logged as warnings and never block the
   * upsert (matches the pre-extraction behavior).
   */
  private async validateUpsertFieldTypes(
    objectName: string,
    records: Record<string, unknown>[],
  ): Promise<void> {
    const targetTimeout = new TimeoutManager(this.deps.describeTimeoutMs);
    const targetDesc = await targetTimeout.withTimeout(`describe-${objectName}`, () =>
      this.deps.connection.describe(objectName),
    );
    const targetFields = (
      targetDesc.fields as Array<{
        name: string;
        type: string;
        length: number;
        createable: boolean;
      }>
    )
      .filter((f) => f.createable)
      .map(toValidatorField);
    const sourceFields =
      records.length > 0 ? Object.keys(records[0]).map((k) => ({ apiName: k, type: 'string' })) : [];
    const fieldMapping: Record<string, string> = {};
    for (const sf of sourceFields) {
      const matched = targetFields.find((tf) => tf.apiName === sf.apiName);
      if (matched) {
        fieldMapping[sf.apiName] = matched.apiName;
      }
    }
    const validation = this.fieldValidator.validateMapping(sourceFields, targetFields, fieldMapping);
    if (!validation.valid) {
      this.deps.log(
        `[WARN] Field type validation failed for upsert on ${objectName}: ${validation.errors.length} error(s)`,
      );
    }
  }
}
