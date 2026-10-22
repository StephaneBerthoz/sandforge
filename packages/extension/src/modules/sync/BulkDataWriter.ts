import type { Connection } from 'jsforce';
import { recordWriteHeaders } from '@sandforge/shared';
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
  bulkSaveErrorDetail,
  duplicateRuleMatchIds,
  existingRecordOf,
  formatSaveError,
  saveErrorDetail,
  type SaveErrorDetail,
} from '../../core/common/existingRecordMatch.js';
import type { OperationOutcome } from './DataSync.js';
import type { PauseGate } from './PauseGate.js';
import type { SyncCreationRecorder } from './SyncRunCreations.js';
import type { SyncOverwriteKeeper } from './syncOverwrites.js';
import { WriteCancelledError } from './WriteCancelledError.js';

/** Record count threshold above which the streaming pipeline is used. */
const STREAMING_THRESHOLD = 10_000;

/** Minimal shape of a jsforce per-record DML result. */
type JsforceResult = {
  success: boolean;
  id?: string;
  errors?: Array<{ statusCode?: string; message: string }>;
  /** On an upsert: whether the org created the record rather than updated it. */
  created?: boolean;
};

/** The `created` flag of a write's answer, kept when the answer carries one. */
function createdOf(answer: { created?: boolean }): Pick<OperationOutcome, 'created'> {
  return typeof answer.created === 'boolean' ? { created: answer.created } : {};
}

/**
 * The errors of a refusal with the fields they named, when one named a field:
 * see `OperationOutcome.errorDetails`. The message alone kept them as text, and
 * a writer could not tell which fields a validation rule or a restricted
 * picklist had refused the record on.
 */
function detailsOf(details: SaveErrorDetail[]): Pick<OperationOutcome, 'errorDetails'> {
  return details.some((detail) => detail.fields.length > 0) ? { errorDetails: details } : {};
}

/**
 * The error of a Bulk API row with the fields it named: see
 * `bulkSaveErrorDetail`. Nothing for a text that is not one error.
 */
function bulkDetailsOf(error: string | undefined): Pick<OperationOutcome, 'errorDetails'> {
  const detail = error === undefined ? undefined : bulkSaveErrorDetail(error);
  return detail ? detailsOf([detail]) : {};
}

/**
 * The records a write created, by their ids in the target: every record an
 * insert wrote, and those an upsert wrote that the org said it created. One
 * the org updated was the target's before; one an upsert wrote without the
 * org saying which it did is left out, never guessed into the run's.
 */
export function createdIds(
  operation: BulkOperation,
  outcomes: readonly OperationOutcome[],
): string[] {
  if (operation !== 'insert' && operation !== 'upsert') return [];
  return outcomes.flatMap((outcome) =>
    outcome.success &&
    typeof outcome.id === 'string' &&
    outcome.id !== '' &&
    (operation === 'insert' || outcome.created === true)
      ? [outcome.id]
      : [],
  );
}

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
  /**
   * The run's cancel. A write it came before sends nothing and opens no Bulk
   * API job; it aborts a Bulk API upload while its job is still open, and
   * stops a write sent in REST batches before each of them. The write then
   * throws {@link WriteCancelledError}, with what it wrote. A job already
   * closed is awaited and counted. Left out only by a write that has to finish
   * whatever happens: a real-time session finishes the batch it is writing
   * when it stops.
   */
  signal?: AbortSignal;
  /**
   * The run's pause. Waited on before each REST batch and before a Bulk API
   * job is opened, never inside one: a batch sent is not taken back, and a
   * job runs on the platform to its end once it is closed. A cancel ends the
   * wait, and the write then stops as it would have.
   */
  pauseGate?: Pick<PauseGate, 'whilePaused'>;
  /** Progress sink invoked by the streaming and bulk paths. */
  onProgress: (processed: number, total: number, label: string) => void;
  /** Log sink for non-fatal validation warnings. */
  log: (message: string) => void;
  /**
   * Told of each call to the target before it goes — a REST batch, a Bulk
   * API job — and of what it wrote once it answers. A run that keeps what it
   * creates writes both down as they happen: told only once an object's
   * whole write returned, a window closed during a Bulk API job of ten
   * thousand rows kept none of them, though the job ran on to its end.
   */
  calls?: WriterCalls;
}

/** See {@link BulkDataWriterDeps.calls}. */
export interface WriterCalls {
  /**
   * Before a call of `rows` of `objectName` that writes records — an insert,
   * an update, an upsert — and before {@link sending}: what the call writes
   * over is read and kept first (`syncOverwrites`). Answers why the call must
   * not go, when it must not: its rows are then answered refused with those
   * words, and nothing of it is sent.
   */
  before?(
    objectName: string,
    operation: BulkOperation,
    rows: ReadonlyArray<Record<string, unknown>>,
    externalIdField?: string,
  ): Promise<string | undefined>;
  /** A call of `rows` rows of `objectName` is about to go. */
  sending(objectName: string, operation: BulkOperation, rows: number): void;
  /**
   * The call {@link sending} announced is a Bulk API job, which the org has
   * just opened under `jobId`, before anything of it is closed: the job runs
   * on to its end on the org's side whatever becomes of the window, and is
   * read back by this id (`readJobCreated`).
   */
  opened?(objectName: string, operation: BulkOperation, rows: number, jobId: string): void;
  /** The call answered: one outcome per row it sent, in their order. */
  answered(
    objectName: string,
    operation: BulkOperation,
    outcomes: readonly OperationOutcome[],
  ): void;
}

/** Both hooks told of each call, either missing: the writer's own, then one call's. */
function bothCalls(
  own: WriterCalls | undefined,
  more: WriterCalls | undefined,
): WriterCalls | undefined {
  if (!own || !more) return own ?? more;
  return {
    before: async (objectName, operation, rows, externalIdField) =>
      (await own.before?.(objectName, operation, rows, externalIdField)) ??
      (await more.before?.(objectName, operation, rows, externalIdField)),
    sending: (objectName, operation, rows) => {
      own.sending(objectName, operation, rows);
      more.sending(objectName, operation, rows);
    },
    opened: (objectName, operation, rows, jobId) => {
      own.opened?.(objectName, operation, rows, jobId);
      more.opened?.(objectName, operation, rows, jobId);
    },
    answered: (objectName, operation, outcomes) => {
      own.answered(objectName, operation, outcomes);
      more.answered(objectName, operation, outcomes);
    },
  };
}

/**
 * The calls a Sync run's writer sends, kept by the run's recorder as they go
 * (`SyncCreationRecorder`), by the panel's run and the command line's alike:
 * the command line kept none of them, and a run of it killed during a Bulk
 * API job left no trace of the job.
 *
 * What each call that can create writes is kept as it goes and as it
 * answers: kept once the object's whole write returned, a window closed
 * during it kept none of the object's records — a Bulk API job of ten
 * thousand runs on to its end — and its removal left them in the target
 * without a word. A Bulk API job is said again with its id once the org has
 * opened it: read back by that id once the run is listed again
 * (`answerJobsInFlight`), its records are listed and removed with the run.
 * An upsert says so: only the rows the org created are the run's. An update
 * or a delete creates nothing of the run's, but it is a write, dated as it
 * goes and as it answers: the sweep of the run's removal looks from its first
 * write to its last.
 *
 * Given the run's keeper of what it writes over (`syncOverwrites`), each call
 * that writes records asks it first, and tells it how it answered: an update
 * or an upsert that reaches records the target holds keeps their values
 * before it goes, and is not sent when they could not be kept.
 */
export function syncWriterCalls(
  recorder: Pick<SyncCreationRecorder, 'sending' | 'answered' | 'writing'>,
  overwrites?: Pick<SyncOverwriteKeeper, 'before' | 'answered'>,
): WriterCalls {
  const creates = (operation: BulkOperation): boolean =>
    operation === 'insert' || operation === 'upsert';
  return {
    ...(overwrites
      ? {
          before: (objectName, operation, rows, externalIdField) =>
            overwrites.before(objectName, operation, rows, externalIdField),
        }
      : {}),
    sending: (objectName, operation, rows) => {
      if (creates(operation)) {
        recorder.sending?.(objectName, rows, operation === 'upsert' ? { upsert: true } : undefined);
      } else {
        recorder.writing?.(objectName, rows);
      }
    },
    opened: (objectName, operation, rows, jobId) => {
      if (!creates(operation)) return;
      recorder.sending?.(objectName, rows, {
        job: jobId,
        ...(operation === 'upsert' ? { upsert: true } : {}),
      });
    },
    answered: (objectName, operation, outcomes) => {
      if (creates(operation)) recorder.answered?.(objectName, createdIds(operation, outcomes));
      else if (outcomes.length > 0) recorder.writing?.(objectName, outcomes.length);
      overwrites?.answered(objectName, operation, outcomes);
    },
  };
}

/**
 * Writes records to a target Salesforce org via insert/upsert/update/delete.
 *
 * Mutualizes the three execution paths shared by all four DML operations:
 * - one Bulk API 2.0 job read in chunks for very large record sets (> STREAMING_THRESHOLD),
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
      signal: deps.signal,
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
   * @param calls - Told of this insert's calls, beside the writer's own
   *   (`BulkDataWriterDeps.calls`): what a caller that writes many objects
   *   through one writer learns of one of them, its rows' outcomes call by
   *   call, in the order sent.
   * @returns Per-record outcomes aligned with the input order.
   */
  async insert(
    objectName: string,
    records: Record<string, unknown>[],
    batchSize: number,
    calls?: WriterCalls,
  ): Promise<OperationOutcome[]> {
    const told = bothCalls(this.deps.calls, calls);
    const streamed = await this.tryStreaming('insert', objectName, records, undefined, told);
    if (streamed) return streamed;

    const bulked = await this.tryBulk('insert', objectName, records, undefined, told);
    if (bulked) return bulked;

    return this.executeRestBatches(
      'insert',
      objectName,
      records,
      batchSize,
      (batch) =>
        this.deps.connection
          .sobject(objectName)
          .create(batch, { headers: recordWriteHeaders() }) as Promise<JsforceResult[]>,
      'Insert failed after retries',
      told,
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
      'upsert',
      objectName,
      records,
      batchSize,
      (batch) =>
        this.deps.connection.sobject(objectName).upsert(batch, externalIdField, {
          headers: recordWriteHeaders(),
        }) as unknown as Promise<JsforceResult[]>,
      'Upsert failed after retries',
      this.deps.calls,
      externalIdField,
    );
  }

  /**
   * Update records in the target org (records must carry their `Id`).
   *
   * With the duplicate-rule header, as an insert and an upsert: a rule can
   * block an edit as it blocks a create, and the rows an update carries look
   * like the ones the target holds as much as a new row does.
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
      'update',
      objectName,
      records,
      batchSize,
      (batch) =>
        this.deps.connection
          .sobject(objectName)
          .update(batch as Array<Record<string, unknown> & { Id: string }>, {
            headers: recordWriteHeaders(),
          }) as unknown as Promise<JsforceResult[]>,
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
      'delete',
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
   * Run the streaming path, one job read in chunks, when the record set exceeds
   * STREAMING_THRESHOLD. Returns `undefined` when streaming does not apply.
   */
  private async tryStreaming(
    operation: BulkOperation,
    objectName: string,
    records: Record<string, unknown>[],
    externalIdField?: string,
    calls: WriterCalls | undefined = this.deps.calls,
  ): Promise<OperationOutcome[] | undefined> {
    if (records.length <= STREAMING_THRESHOLD) return undefined;
    await this.deps.pauseGate?.whilePaused(this.deps.signal);
    // A cancel that came before the write opens no job: see `tryBulk`.
    if (this.deps.signal?.aborted) throw new WriteCancelledError(objectName);

    // What the job writes over, kept before it is opened: a job that could
    // not keep it is not opened, and its rows are refused with why.
    const refused = await this.refusedBefore(
      calls,
      objectName,
      operation,
      records,
      externalIdField,
    );
    if (refused) return refused;
    const chunkedExecutor = new ChunkedBulkExecutor({ signal: this.deps.signal });
    calls?.sending(objectName, operation, records.length);
    const bulkDeps: BulkApiExecutorDeps = {
      connection: this.deps.connection as unknown as BulkApiConnection,
      bulkManager: this.deps.bulkManager,
      onProgress: (processed, total) => {
        this.deps.onProgress(processed, total, `Streaming ${operation} ${objectName}`);
      },
      onOpened: (jobId) => calls?.opened?.(objectName, operation, records.length, jobId),
    };
    const streamResult = await chunkedExecutor.executeChunked(
      bulkDeps,
      objectName,
      operation,
      chunkedExecutor.createChunkGenerator(records),
      records.length,
      externalIdField,
    );
    // The cancel aborted the job before it was closed: none of its records
    // was written. Answered as an empty list, it read as an object with
    // nothing to write, and a run cancelled on its last object succeeded.
    if (streamResult.aborted) {
      calls?.answered(objectName, operation, []);
      throw new WriteCancelledError(objectName);
    }
    this.logUnmatched(`Streaming ${operation} ${objectName}`, streamResult.unmatchedIds);
    const outcomes = (streamResult.outcomes ?? []).map((outcome) =>
      this.withExistingRecord(objectName, {
        id: outcome.id,
        success: outcome.success,
        errors: outcome.success ? [] : [outcome.error ?? 'Streaming error'],
        ...createdOf(outcome),
        ...(outcome.success ? {} : bulkDetailsOf(outcome.error)),
      }),
    );
    calls?.answered(objectName, operation, outcomes);
    return outcomes;
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
    calls: WriterCalls | undefined = this.deps.calls,
  ): Promise<OperationOutcome[] | undefined> {
    if (!this.deps.bulkExecutor.shouldUseBulkApi(records.length)) return undefined;
    // A pause holds the write before its job is opened, never once it is.
    await this.deps.pauseGate?.whilePaused(this.deps.signal);
    // A cancel that came before the write opens no job. The job was created
    // and opened all the same, then aborted before its upload: nothing of it
    // was written, but the target was asked to create a job, and to abort it,
    // for a write that never started.
    if (this.deps.signal?.aborted) throw new WriteCancelledError(objectName);

    const bulkDeps: BulkApiExecutorDeps = {
      connection: this.deps.connection as unknown as BulkApiConnection,
      bulkManager: this.deps.bulkManager,
      onProgress: (processed, total) => {
        this.deps.onProgress(processed, total, `Bulk ${operation} ${objectName}`);
      },
      signal: this.deps.signal,
      onOpened: (jobId) => calls?.opened?.(objectName, operation, records.length, jobId),
    };
    const refused = await this.refusedBefore(
      calls,
      objectName,
      operation,
      records,
      externalIdField,
    );
    if (refused) return refused;
    calls?.sending(objectName, operation, records.length);
    const bulkResult = await this.deps.bulkExecutor.executeBulk(
      bulkDeps,
      objectName,
      operation,
      records,
      externalIdField,
    );
    // The cancel aborted the job before it was closed: none of its records
    // was written, as on the streaming path.
    if (bulkResult.aborted) {
      calls?.answered(objectName, operation, []);
      throw new WriteCancelledError(objectName);
    }
    this.logUnmatched(`Bulk ${operation} ${objectName}`, bulkResult.unmatchedIds);
    // Real per-record outcomes: input-aligned, real Salesforce IDs (the old
    // code fabricated `bulk-${i}` IDs and assumed the first successCount
    // records had succeeded).
    const outcomes = bulkResult.outcomes.map((outcome) =>
      this.withExistingRecord(objectName, {
        id: outcome.id,
        success: outcome.success,
        errors: outcome.success ? [] : [outcome.error ?? 'Bulk error'],
        ...createdOf(outcome),
        ...(outcome.success ? {} : bulkDetailsOf(outcome.error)),
      }),
    );
    calls?.answered(objectName, operation, outcomes);
    return outcomes;
  }

  /**
   * Ask the call's hook before a call that writes records goes
   * (`WriterCalls.before`): the rows answered refused, with its words, when
   * it says the call must not go; nothing otherwise, and for a delete.
   */
  private async refusedBefore(
    calls: WriterCalls | undefined,
    objectName: string,
    operation: BulkOperation,
    rows: ReadonlyArray<Record<string, unknown>>,
    externalIdField?: string,
  ): Promise<OperationOutcome[] | undefined> {
    if (operation === 'delete' || !calls?.before) return undefined;
    const refusal = await calls.before(objectName, operation, rows, externalIdField);
    if (refusal === undefined) return undefined;
    this.deps.log(`[WARN] ${operation} ${objectName}: ${rows.length} row(s) not sent: ${refusal}`);
    return rows.map(() => ({ success: false, errors: [refusal] }));
  }

  /**
   * Log every id of a record the job wrote that no row could be matched to.
   * The rows left without a result name ten of them; the log keeps them all,
   * as they are the only trace of records no row maps.
   */
  private logUnmatched(job: string, ids: readonly string[] | undefined): void {
    if (ids && ids.length > 0) {
      this.deps.log(
        `[WARN] ${job}: the job wrote ${ids.length} record(s) no row was matched to: ${ids.join(', ')}`,
      );
    }
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
    operation: BulkOperation,
    objectName: string,
    items: T[],
    batchSize: number,
    call: (batch: T[]) => Promise<JsforceResult[]>,
    failureMessage: string,
    calls: WriterCalls | undefined = this.deps.calls,
    externalIdField?: string,
  ): Promise<OperationOutcome[]> {
    const outcomes: OperationOutcome[] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      // A cancel stops the write before each batch, with what the batches
      // before it wrote: a large object used to be written to its last batch
      // after the run was cancelled. The first batch included — a caller looks
      // at the cancel before it writes, then waits on the target: a describe,
      // a lookup, the write whose refused rows it sends again. A cancel that
      // came meanwhile still sent a batch of up to two hundred records. A pause
      // holds the write here too, between two batches, and a cancel ends it.
      await this.deps.pauseGate?.whilePaused(this.deps.signal);
      if (this.deps.signal?.aborted) throw new WriteCancelledError(objectName, outcomes);
      const batch = items.slice(i, i + batchSize);
      // What the batch writes over, kept before it goes: a batch that could
      // not keep it is not sent, its rows refused with why, and the next
      // batch is tried as it comes.
      if (operation !== 'delete') {
        const refused = await this.refusedBefore(
          calls,
          objectName,
          operation,
          batch as unknown as Array<Record<string, unknown>>,
          externalIdField,
        );
        if (refused) {
          outcomes.push(...refused);
          continue;
        }
        if (this.deps.signal?.aborted) throw new WriteCancelledError(objectName, outcomes);
      }
      calls?.sending(objectName, operation, batch.length);
      const retryResult = await this.retryOp.execute(() => call(batch));
      // The batch failed and the cancel came before it was tried again: none
      // of it was written, and nothing after it is sent.
      if (retryResult.cancelled) {
        calls?.answered(objectName, operation, []);
        throw new WriteCancelledError(objectName, outcomes);
      }
      const answered: OperationOutcome[] = [];
      if (retryResult.success && retryResult.result) {
        for (const r of Array.isArray(retryResult.result)
          ? retryResult.result
          : [retryResult.result]) {
          answered.push(this.restOutcome(objectName, r));
        }
      } else {
        answered.push(
          ...batch.map(() => ({
            success: false as const,
            errors: [retryResult.error?.message ?? failureMessage],
          })),
        );
      }
      outcomes.push(...answered);
      calls?.answered(objectName, operation, answered);
    }
    return outcomes;
  }

  /**
   * One REST result as an outcome. The first error is the one reported, now
   * with its status code — the code is what says a row already exists — and
   * every error, with the records a duplicate rule matched, decides whether
   * the target named the record it already holds. Every error goes with it,
   * with the fields it named, when one named a field (`errorDetails`).
   */
  private restOutcome(objectName: string, r: JsforceResult): OperationOutcome {
    // An upsert's answer says whether it created the record or updated it:
    // dropped, the audit trail could only count the records as "upserted".
    if (r.success) return { id: r.id, success: true, errors: [], ...createdOf(r) };
    const errors: unknown[] = r.errors ?? [];
    const formatted = errors.map(formatSaveError);
    const outcome: OperationOutcome = {
      id: r.id,
      success: false,
      errors: [formatted[0] ?? 'Unknown error'],
      ...detailsOf(errors.map(saveErrorDetail)),
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
