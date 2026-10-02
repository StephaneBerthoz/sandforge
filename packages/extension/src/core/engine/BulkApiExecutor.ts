import { BulkApiManager, type BulkJobInfo, type BulkJobStatus } from './BulkApiManager.js';
import { SF_LIMITS } from '@sandforge/shared';
import { buildBulkCsv, resultCells, rowKey, type BulkCsv, type CellMatch } from './bulkCsv.js';

/** Result of a bulk API execution */
export interface BulkExecutionResult {
  /** Total number of records submitted */
  totalRecords: number;
  /** Number of successfully processed records */
  successCount: number;
  /** Number of failed records */
  failureCount: number;
  /** Details of individual record failures */
  failures: BulkRecordFailure[];
  /** Salesforce Bulk API job ID */
  jobId: string;
  /** Whether Bulk API 2.0 was used (vs REST) */
  usedBulkApi: boolean;
  /** Real Salesforce record IDs for successfully processed records */
  successIds: string[];
  /**
   * Per-input-record outcomes, aligned with the input order (one entry per
   * submitted record). IDs are the real Salesforce IDs returned by the job —
   * never fabricated.
   */
  outcomes: BulkRecordOutcome[];
  /**
   * Ids of records the job wrote that no row could be matched to: in
   * `successIds`, on no outcome. Each row left without a result names them.
   */
  unmatchedIds?: string[];
  /**
   * Set when the run's cancel aborted the job before it was closed:
   * Salesforce processed none of its records, and `outcomes` is empty.
   */
  aborted?: boolean;
}

/** A single record failure from a bulk job */
export interface BulkRecordFailure {
  /** Zero-based index of the failed record in the input array (-1 when the failure could not be attributed) */
  recordIndex: number;
  /** Error description from Salesforce */
  error: string;
}

/** Outcome of a single input record after a bulk job. */
export interface BulkRecordOutcome {
  /** Zero-based index of the record in the input array. */
  recordIndex: number;
  /** Real Salesforce record ID on success (absent when the backend omitted it — never fabricated). */
  id?: string;
  /** Whether this record was processed successfully. */
  success: boolean;
  /** Error message on failure. */
  error?: string;
  /**
   * For an upsert, whether the job created the record (true) or updated one
   * (false), from its `sf__Created` column. Absent when the row does not say.
   */
  created?: boolean;
}

/**
 * Real jsforce Bulk API 2.0 ingest result shape, as returned by
 * `JobV2.getAllResults()`. Every row echoes the uploaded columns plus
 * `sf__Id` / `sf__Error` — that echo is what allows honest result-to-record
 * attribution, the order of the rows being none of the upload's.
 */
export interface JsforceIngestJobResults {
  successfulResults?: Array<Record<string, unknown>>;
  failedResults?: Array<Record<string, unknown>>;
  unprocessedRecords?: Array<Record<string, unknown>> | string;
}

/** Normalized view of a bulk job's results (see normalizeBulkJobResults). */
export interface NormalizedBulkResults {
  /** Exactly one entry per uploaded row, in input order. */
  outcomes: BulkRecordOutcome[];
  /** Real IDs of success rows that could not be attributed to an input record. */
  unattributedSuccessIds: string[];
  /** Errors of failure rows that could not be attributed to an input record. */
  unattributedFailures: string[];
}

/** The outcome of a row no result row was matched to. */
const NO_RESULT = 'No result returned by Bulk API job';
/** The outcome of a row the job never processed. */
const NOT_PROCESSED = 'Record not processed by Bulk API job';
/** How many ids of records no row was matched to an outcome names. */
const UNMATCHED_IDS_NAMED = 10;

/**
 * The `sf__Created` column of a successful row: what an upsert did with the
 * record. A result read as CSV holds it as text.
 */
function createdFlag(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}

/** A result row waiting for the uploaded row it answers. */
interface PendingResult {
  readonly row: Readonly<Record<string, unknown>>;
  /** Give this result to the row at `recordIndex`. */
  readonly settle: (recordIndex: number) => void;
  /** Keep this result, though no row was matched to it. */
  readonly orphan: () => void;
}

/**
 * Normalize bulk job results into per-input-record outcomes.
 *
 * Two input shapes are supported:
 *  - the legacy flat `BulkJobRecordResult[]` (test doubles), treated as
 *    already input-ordered;
 *  - the real jsforce `{ successfulResults, failedResults, unprocessedRecords }`
 *    shape, whose rows are correlated back to the uploaded rows by the cells
 *    they echo (Salesforce does NOT guarantee result ordering relative to the
 *    upload).
 *
 * A result row is matched on the cells its row was uploaded with
 * ({@link buildBulkCsv}): its `Id` on an update or a delete, its external id
 * on an upsert, every column on an insert, where a row carrying fewer fields
 * than another is matched on the empty cells it was sent with. Keyed on the
 * fields each record object carried, as they were, a row whose fields
 * differed from the first row's — whose fields alone made jsforce's header —
 * matched nothing. The cells are compared as sent first, then in the form the
 * platform echoes them in, which writes back a number, a checkbox or a date
 * otherwise: run on a real target, 250 rows carrying the same fields, a whole
 * number and a date among them, all came back "No result returned".
 *
 * Records that no result row claims are failed-closed with an explicit
 * "No result returned" error instead of being silently assumed successful —
 * the previous "first successCount records succeeded" assumption mixed up
 * successes and failures whenever a job had partial errors. Their error says
 * why when the job failed, and names what the job returned that no row was
 * matched to, so a record it wrote is never lost without a word.
 *
 * @param rawResults - Raw value returned by `job.getAllResults()`.
 * @param upload - What the job was sent, row by row.
 * @param jobError - Why the job did not complete, when it did not.
 */
export function normalizeBulkJobResults(
  rawResults: BulkJobRecordResult[] | JsforceIngestJobResults,
  upload: BulkCsv,
  jobError?: string,
): NormalizedBulkResults {
  const count = upload.rows.length;
  const outcomes: BulkRecordOutcome[] = [];
  const unattributedSuccessIds: string[] = [];
  const unattributedFailures: string[] = [];
  const claimed = new Array<boolean>(count).fill(false);

  const claim = (id: string | undefined, recordIndex: number, created?: boolean): void => {
    if (recordIndex >= 0 && recordIndex < count && !claimed[recordIndex]) {
      claimed[recordIndex] = true;
      outcomes.push({
        recordIndex,
        id,
        success: true,
        ...(created !== undefined ? { created } : {}),
      });
    } else if (id !== undefined) {
      unattributedSuccessIds.push(id);
    }
  };
  const claimFailure = (error: string, recordIndex: number): void => {
    if (recordIndex >= 0 && recordIndex < count && !claimed[recordIndex]) {
      claimed[recordIndex] = true;
      outcomes.push({ recordIndex, success: false, error });
    } else {
      unattributedFailures.push(error);
    }
  };
  const why = jobError ? ` (${jobError})` : '';

  if (Array.isArray(rawResults)) {
    // Legacy flat shape: rows are already input-ordered.
    rawResults.forEach((row, i) => {
      if (row.success) {
        claim(row.id, i);
      } else {
        claimFailure(row.errors?.join(', ') ?? 'Unknown error', i);
      }
    });
  } else {
    // Real jsforce shape: correlate result rows to the uploaded rows.
    const pending: PendingResult[] = [];
    for (const row of rawResults.successfulResults ?? []) {
      const id = typeof row['sf__Id'] === 'string' ? row['sf__Id'] : undefined;
      const created = createdFlag(row['sf__Created']);
      pending.push({ row, settle: (i) => claim(id, i, created), orphan: () => claim(id, -1) });
    }
    for (const row of rawResults.failedResults ?? []) {
      const error =
        typeof row['sf__Error'] === 'string' && row['sf__Error'].length > 0
          ? row['sf__Error']
          : 'Unknown error';
      pending.push({
        row,
        settle: (i) => claimFailure(error, i),
        orphan: () => claimFailure(error, -1),
      });
    }
    const unprocessed = rawResults.unprocessedRecords;
    for (const row of Array.isArray(unprocessed) ? unprocessed : []) {
      const error = `${NOT_PROCESSED}${why}`;
      pending.push({
        row,
        settle: (i) => claimFailure(error, i),
        orphan: () => claimFailure(error, -1),
      });
    }
    let left = pending;
    for (const match of ['exact', 'canonical'] as const) {
      if (left.length > 0) left = settleBy(match, left, upload, claimed);
    }
    for (const result of left) result.orphan();
  }

  // Any input record that no result row claimed got no outcome at all —
  // fail closed instead of assuming success.
  const noResult = `${NO_RESULT}${why}${unmatchedResults(unattributedSuccessIds, unattributedFailures)}`;
  for (let i = 0; i < count; i++) {
    if (!claimed[i]) claimFailure(noResult, i);
  }

  outcomes.sort((a, b) => a.recordIndex - b.recordIndex);
  return { outcomes, unattributedSuccessIds, unattributedFailures };
}

/**
 * Give each result the row it echoes, its cells compared as `match` says, and
 * hand back the results no row is left for. A row is given one result; rows
 * sent with the same cells take the results that echo them in turn.
 */
function settleBy(
  match: CellMatch,
  results: readonly PendingResult[],
  upload: BulkCsv,
  claimed: readonly boolean[],
): PendingResult[] {
  const waiting = new Map<string, number[]>();
  upload.rows.forEach((cells, i) => {
    if (claimed[i]) return;
    const key = rowKey(cells, upload.identity, match);
    const queue = waiting.get(key);
    if (queue) queue.push(i);
    else waiting.set(key, [i]);
  });
  const unmatched: PendingResult[] = [];
  for (const result of results) {
    const key = rowKey(resultCells(upload.columns, result.row), upload.identity, match);
    const recordIndex = waiting.get(key)?.shift();
    if (recordIndex === undefined) unmatched.push(result);
    else result.settle(recordIndex);
  }
  return unmatched;
}

/**
 * What the job returned that no row was matched to, for the rows left without
 * a result: the ids of the records it wrote — the only place they can be read
 * from, since no row maps them — and how many rows it did not write.
 */
function unmatchedResults(ids: readonly string[], errors: readonly string[]): string {
  const said: string[] = [];
  if (ids.length > 0) {
    const named = ids.slice(0, UNMATCHED_IDS_NAMED).join(', ');
    const more =
      ids.length > UNMATCHED_IDS_NAMED ? ` and ${ids.length - UNMATCHED_IDS_NAMED} more` : '';
    said.push(`wrote ${ids.length} record(s) no row was matched to: ${named}${more}`);
  }
  if (errors.length > 0) {
    said.push(
      `did not write ${errors.length} row(s) no row was matched to, the first for: ${errors[0]}`,
    );
  }
  return said.length > 0 ? `; the job ${said.join('; it ')}` : '';
}

/** Supported bulk operations */
export type BulkOperation = 'insert' | 'update' | 'upsert' | 'delete' | 'hardDelete';

/**
 * Represents a jsforce Bulk API 2.0 job handle.
 * This interface abstracts jsforce internals for testability.
 *
 * Note on `getAllResults`: real jsforce returns the grouped
 * {@link JsforceIngestJobResults} shape; test doubles return the flat
 * input-ordered `BulkJobRecordResult[]`. {@link normalizeBulkJobResults}
 * accepts both.
 */
export interface BulkJobHandle {
  id?: string;
  open: () => Promise<void>;
  /**
   * Upload the job's data, once: jsforce refuses a second upload to the same
   * job ("Data can only be uploaded to a job once"). Sent the CSV text, it
   * sends it as it is; sent records, it writes the header from the first one.
   */
  uploadData: (csv: string) => Promise<void>;
  /** Mark the upload complete (`UploadComplete`): Salesforce then processes the job's data. */
  close: () => Promise<void>;
  /** Mark the job `Aborted`: Salesforce processes none of its data. */
  abort: () => Promise<void>;
  check: () => Promise<BulkJobCheckResult>;
  getAllResults: () => Promise<BulkJobRecordResult[] | JsforceIngestJobResults>;
}

/** Result of checking a bulk job status */
export interface BulkJobCheckResult {
  state: BulkJobStatus;
  numberRecordsProcessed?: number;
  /** Why the job failed, as Salesforce says it: a header it refused fails every row. */
  errorMessage?: string;
}

/** Individual record result from bulk job */
export interface BulkJobRecordResult {
  /** Whether this individual record was processed successfully */
  success: boolean;
  /** Salesforce record ID (present on success for insert/upsert operations) */
  id?: string;
  /** Error messages for failed records */
  errors?: string[];
}

/** Connection abstraction for creating Bulk API 2.0 jobs */
export interface BulkApiConnection {
  bulk2: {
    createJob: (opts: {
      operation: BulkOperation;
      object: string;
      externalIdFieldName?: string;
    }) => BulkJobHandle;
  };
}

/** Dependencies required by BulkApiExecutor */
export interface BulkApiExecutorDeps {
  /** jsforce connection (abstracted for testability) */
  connection: BulkApiConnection;
  /** BulkApiManager for job tracking */
  bulkManager: BulkApiManager;
  /** Optional progress callback (processed, total) */
  onProgress?: (processed: number, total: number) => void;
  /**
   * The run's cancel. It aborts the job while the job is still open; once the
   * job is closed, Salesforce writes all of it, and it is awaited and counted.
   */
  signal?: AbortSignal;
}

/**
 * Why a job ended without completing, for the rows it left without a result:
 * Salesforce's message — a header it refused fails the whole job — or the
 * state it ended in when it gave none.
 */
export function jobErrorOf(status: BulkJobCheckResult): string | undefined {
  if (status.state === 'JobComplete') return undefined;
  return status.errorMessage || `job ${status.state}`;
}

/**
 * Abort a job that was never closed. A failed abort leaves it open, and an
 * open job is never processed either: nothing of it is written, so the
 * failure is not the run's.
 */
export async function abortOpenJob(job: BulkJobHandle): Promise<void> {
  try {
    await job.abort();
  } catch {
    // Left open, the job is never processed.
  }
}

/**
 * Selects between REST API and Bulk API 2.0 based on record count
 * and executes bulk operations via jsforce with BulkApiManager tracking.
 */
export class BulkApiExecutor {
  private readonly threshold: number;

  constructor(threshold: number = SF_LIMITS.REST_API_BATCH_SIZE) {
    this.threshold = threshold;
  }

  /** Determine whether Bulk API should be used for the given record count */
  shouldUseBulkApi(recordCount: number): boolean {
    return recordCount > this.threshold;
  }

  /** Get the configured threshold for switching to Bulk API */
  getThreshold(): number {
    return this.threshold;
  }

  /**
   * Execute a DML operation via Bulk API 2.0.
   * Creates a job, uploads data, polls until completion, and returns results.
   * The job is tracked via BulkApiManager throughout its lifecycle.
   *
   * @param deps - Connection, manager, and progress callback
   * @param objectName - Salesforce object API name
   * @param operation - DML operation type
   * @param records - Records to process
   * @param externalIdField - External ID field for upsert operations
   */
  async executeBulk(
    deps: BulkApiExecutorDeps,
    objectName: string,
    operation: BulkOperation,
    records: Record<string, unknown>[],
    externalIdField?: string,
  ): Promise<BulkExecutionResult> {
    if (!deps.bulkManager.canStartNewJob()) {
      throw new Error('Maximum concurrent bulk jobs reached');
    }

    // Every field any record carries, rather than the first record's alone:
    // see `buildBulkCsv`.
    const upload = buildBulkCsv(operation, records, externalIdField);
    const job = deps.connection.bulk2.createJob({
      operation,
      object: objectName,
      ...(externalIdField ? { externalIdFieldName: externalIdField } : {}),
    });

    // Tracked under an id of our own when Salesforce has not assigned one yet
    // (jsforce fills `job.id` only once the job is open): the limiter's map is
    // window-lived, and two jobs keyed on the same millisecond overwrote each
    // other, undercounting the cap and crossing their record counts.
    const jobId = job.id ?? `bulk-${crypto.randomUUID()}`;
    const jobInfo: BulkJobInfo = {
      id: jobId,
      operation,
      object: objectName,
      state: 'UploadComplete',
      numberRecordsProcessed: 0,
      numberRecordsFailed: 0,
      totalProcessingTime: 0,
      createdDate: new Date().toISOString(),
    };
    deps.bulkManager.registerJob(jobInfo);
    try {
      await job.open();

      /*
       * A cancel before the job is closed aborts it, as the streaming upload
       * does. Salesforce processes a job's data only once the job is closed,
       * and never an aborted one's. The job used to be closed whatever the run
       * said: a cancel that came during the upload of up to ten thousand
       * records had every one of them written. Once closed, the job is awaited
       * and counted like any other.
       */
      let uploaded = 0;
      if (!deps.signal?.aborted) {
        await job.uploadData(upload.text);
        uploaded = records.length;
      }
      if (deps.signal?.aborted) {
        await abortOpenJob(job);
        deps.bulkManager.updateJobState(jobId, 'Aborted');
        return {
          totalRecords: uploaded,
          successCount: 0,
          failureCount: 0,
          failures: [],
          jobId,
          usedBulkApi: true,
          successIds: [],
          outcomes: [],
          aborted: true,
        };
      }
      await job.close();

      let status = await job.check();
      while (status.state === 'InProgress' || status.state === 'UploadComplete') {
        deps.bulkManager.updateJobState(jobId, status.state);
        deps.onProgress?.(status.numberRecordsProcessed ?? 0, records.length);
        await new Promise((r) => setTimeout(r, 5000));
        status = await job.check();
      }

      const results = await job.getAllResults();
      const normalized = normalizeBulkJobResults(results, upload, jobErrorOf(status));

      const failures: BulkRecordFailure[] = normalized.outcomes
        .filter((o) => !o.success)
        .map((o) => ({ recordIndex: o.recordIndex, error: o.error ?? 'Unknown error' }));
      for (const error of normalized.unattributedFailures) {
        failures.push({ recordIndex: -1, error });
      }

      // Real IDs only — the previous `bulk-${jobId}-${i}` fallback fabricated
      // IDs that downstream consumers (remap tables, history) treated as real.
      const successIds = normalized.outcomes
        .filter((o) => o.success && o.id !== undefined)
        .map((o) => o.id as string)
        .concat(normalized.unattributedSuccessIds);
      const successCount =
        normalized.outcomes.filter((o) => o.success).length +
        normalized.unattributedSuccessIds.length;

      const finalState: BulkJobStatus = status.state === 'JobComplete' ? 'JobComplete' : 'Failed';
      deps.bulkManager.updateJobState(jobId, finalState);
      deps.bulkManager.updateJobCounts(
        jobId,
        status.numberRecordsProcessed ?? records.length,
        failures.length,
      );

      return {
        totalRecords: records.length,
        successCount,
        failureCount: failures.length,
        failures,
        jobId,
        usedBulkApi: true,
        successIds,
        outcomes: normalized.outcomes,
        ...(normalized.unattributedSuccessIds.length > 0
          ? { unmatchedIds: normalized.unattributedSuccessIds }
          : {}),
      };
    } catch (err: unknown) {
      // The limiter counts this job until it reaches a terminal state, and it
      // outlives the run: a job that threw mid-flight has to free its slot,
      // or the window loses one Bulk API slot for good.
      deps.bulkManager.updateJobState(jobId, 'Failed');
      throw err;
    }
  }
}
