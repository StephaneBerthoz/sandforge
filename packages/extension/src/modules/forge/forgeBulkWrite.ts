/**
 * One write of a Forge run sent as a Bulk API 2.0 ingest job, each row
 * answered by what the org did with it — or said to be unanswerable, never
 * guessed.
 *
 * A clone of a whole org writes millions of rows; by REST calls of 200 that
 * is fifty of the org's daily requests per ten thousand rows, where a job
 * sends about a dozen (`bulkJobCost`). A job's answer is not a REST answer,
 * though, and what Forge does with an answer — maps the source id to the
 * record the target created, sends a refused row again without the field a
 * rule named, counts what it may have written — must never take one row's
 * answer for another's. So:
 *
 * - its rows are found in the job's results by the cells they echo
 *   (`normalizeBulkJobResults`); rows sent alike could take each other's
 *   result, so they are kept out of the job (`twin`) and written by REST,
 *   each answered on its own (`ambiguousRows`);
 * - a row the job did not process, or no result was matched to when the job
 *   wrote nothing it could not lay on a row, wrote nothing (`unprocessed`),
 *   and may be sent again; a row no result was matched to while the job
 *   wrote records no row was matched to (`unmatchedIds`), or written without
 *   its id said, may be one of those (`may-have-written`), and is never sent
 *   again;
 * - whatever fails before the job is closed leaves the org nothing to
 *   process (`untouched`), and the whole write may go by REST. Once its close
 *   is sent, the org may write it whatever becomes of this call, so a failure
 *   then — a read of its state cut, its results not read — is never taken for
 *   one that wrote nothing: the job is read back by its id until it has
 *   ended, and its rows answered from its results; failing that, the write
 *   throws {@link BulkJobLostError}, its rows all `may-have-written`;
 * - an insert sends an empty value as a null (`#N/A`): an empty cell is no
 *   value at all to the Bulk API, and gives the field its default, where the
 *   same row sent by REST blanks it.
 *
 * The job names its operation, its object and, for an upsert, its external id,
 * and nothing else: never an `assignmentRuleId`, so no assignment rule runs on
 * what it writes, as a REST write sends `Sforce-Auto-Assign: FALSE`.
 *
 * Cutting a write to one job's measure — {@link FORGE_BULK_JOB_ROWS} rows,
 * {@link FORGE_BULK_JOB_MAX_BYTES} of CSV — is the caller's; a write past it
 * is refused here before anything is sent.
 */

import {
  BulkApiExecutor,
  normalizeBulkJobResults,
  type BulkApiConnection,
  type BulkExecutionResult,
  type BulkRecordOutcome,
} from '../../core/engine/BulkApiExecutor.js';
import type { BulkApiManager } from '../../core/engine/BulkApiManager.js';
import { ambiguousRows, buildBulkCsv } from '../../core/engine/bulkCsv.js';
import { FORGE_BULK_POLL_SCHEDULE, type BulkPollSchedule } from '../../core/engine/bulkJobCost.js';
import {
  readJobResults,
  type IngestJobInfo,
  type IngestJobResultsReading,
  type JobResultsRead,
} from '../../core/engine/ingestJobRead.js';
import { trackedBulkConnection } from '../../core/engine/trackedBulkConnection.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { bulkSaveErrorDetail, formatSaveError } from '../../core/common/existingRecordMatch.js';
import type { InsertResult } from './ForgeExecutor.js';

/** What became of one row of a write sent as a job. */
export type BulkRowState =
  /** The job answered it: written, with its id, or refused, with why. */
  | 'answered'
  /** The job did not write it: it may be sent again. */
  | 'unprocessed'
  /** Its cells are another row's: kept out of the job, to be written on its own. */
  | 'twin'
  /** The job may have written it, without saying so: never sent again. */
  | 'may-have-written';

/** What a write sent as a job came to. */
export interface BulkWriteAnswer {
  /**
   * One per record, in the order sent: the job's answer for an `answered`
   * row, else a refusal saying why the row has none.
   */
  answers: InsertResult[];
  /** One per record, in the order sent: what became of it. */
  rows: BulkRowState[];
  /**
   * Ids of records the job wrote that no row was matched to: the run's all
   * the same, kept so a removal deletes them.
   */
  unmatchedIds: string[];
  /** The id the org gave the job once it opened it; absent when no job was opened. */
  jobId?: string;
  /**
   * Set when nothing was written: the job failed before it was closed, or
   * ended having processed no row. `unsupported` when the org said the object
   * is not one the Bulk API writes, so the run stops sending it as jobs.
   */
  untouched?: { reason: string; unsupported?: boolean };
  /** Set when the run's cancel aborted the job before it was closed: nothing was written. */
  aborted?: true;
  /** The calls the job sent the org, each one of its daily requests, reads back included. */
  requests: number;
}

/**
 * Thrown when a job was closed — the org may have written any of its rows —
 * and what it did could not be read back: every row of it may have been
 * written, and none is sent again.
 */
export class BulkJobLostError extends Error {
  constructor(
    readonly jobId: string,
    reason: string,
    /** The calls the job sent the org before it was lost. */
    readonly requests = 0,
    /**
     * The rows, by index among those given, kept out of the job as another's
     * twin: never sent, the target holds none of them.
     */
    readonly twins: readonly number[] = [],
  ) {
    super(
      `Bulk API job ${jobId || '(no id)'} was closed, and what it wrote could not be read ` +
        `back: ${reason}`,
    );
    this.name = 'BulkJobLostError';
  }
}

/**
 * Rows one job takes at most, as the plan counts a job (`ForgeBatchStrategy`'s
 * batches of 10 000): a stop waits for the job the org holds, and a job of ten
 * thousand rows ends in well under a minute.
 */
export const FORGE_BULK_JOB_ROWS = 10_000;

/**
 * Bytes of CSV one job takes at most: well under the 150 MB the org accepts
 * of one upload once encoded, so a job of wide rows is cut before it nears it.
 */
export const FORGE_BULK_JOB_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Reads of a closed job by its id before it is taken for lost: with the
 * waits of `FORGE_BULK_POLL_SCHEDULE`, some four minutes.
 */
const READS_AFTER_CLOSE = 10;

/** The org's words for an object the Bulk API does not write. */
const UNSUPPORTED_RE = /not supported by the Bulk API|InvalidEntity/i;

/** What a row with no answer of its own says. */
const NO_ANSWER: Readonly<Record<Exclude<BulkRowState, 'answered'>, string>> = {
  unprocessed: 'The Bulk API job did not write this row.',
  twin:
    'Kept out of the Bulk API job: another row carries the same values, and the ' +
    "job's results could not tell them apart.",
  'may-have-written':
    'The Bulk API job may have written this row without saying so: it is not sent again.',
};

/** How a write is sent as a job. */
export interface ForgeBulkWriteOptions {
  /** The external id an upsert matches records on. */
  externalIdField?: string;
  /** The run's cancel: it aborts the job while it is still open, and nothing once it is closed. */
  signal?: AbortSignal;
  /** Told the job's id once the org opened it, before anything of it is closed. */
  onOpened?: (jobId: string) => void;
  /** Told how far the org has processed the job, as its state is read. */
  onProgress?: (processed: number, total: number) => void;
  /** How long the job is left between two reads of its state; Forge's growing waits unless told. */
  pollDelay?: BulkPollSchedule;
}

/**
 * Send `records` of `objectName` as one Bulk API 2.0 job, and answer each.
 *
 * @param conn - The target's connection: its Bulk API, and its jobs read back by id.
 * @param bulkManager - The run's job limiter: one job at a time.
 * @throws BulkJobLostError when the job was closed and could not be read back.
 */
export async function forgeBulkWrite(
  conn: BulkApiConnection & IngestJobResultsReading,
  bulkManager: BulkApiManager,
  objectName: string,
  operation: 'insert' | 'upsert' | 'update',
  records: Record<string, unknown>[],
  options: ForgeBulkWriteOptions = {},
): Promise<BulkWriteAnswer> {
  const sent = operation === 'insert' ? records.map(emptyAsNull) : records;
  const twins = ambiguousRows(buildBulkCsv(operation, sent, options.externalIdField));
  const inJob: number[] = [];
  sent.forEach((_, i) => {
    if (!twins.has(i)) inJob.push(i);
  });
  const subset = inJob.map((i) => sent[i]);
  const rows: BulkRowState[] = sent.map((_, i) => (twins.has(i) ? 'twin' : 'unprocessed'));
  /** The answer when the job wrote nothing: each row as unwritten, or a twin. */
  const nothingWritten = (
    extra: Partial<BulkWriteAnswer> & { requests: number },
  ): BulkWriteAnswer => ({
    answers: rows.map((state) => noAnswer(state === 'twin' ? 'twin' : 'unprocessed')),
    rows,
    unmatchedIds: [],
    ...extra,
  });
  if (subset.length === 0) return nothingWritten({ requests: 0 });

  const upload = buildBulkCsv(operation, subset, options.externalIdField);
  const bytes = Buffer.byteLength(upload.text, 'utf8');
  if (subset.length > FORGE_BULK_JOB_ROWS || bytes > FORGE_BULK_JOB_MAX_BYTES) {
    return nothingWritten({
      requests: 0,
      untouched: {
        reason:
          `${subset.length} rows, ${bytes} bytes of CSV: past what one job takes ` +
          `(${FORGE_BULK_JOB_ROWS} rows, ${FORGE_BULK_JOB_MAX_BYTES} bytes)`,
      },
    });
  }

  /**
   * Each row answered from the job's outcomes, laid back on the records sent:
   * or, for a job that ended having processed no row, nothing written.
   *
   * @param unmatchedWrites - How many records the job wrote that no row was
   *   matched to, with their ids or without (`unmatchedIds` holds the ids):
   *   a row left without a result may be one of them.
   */
  const answered = (
    job: { info: IngestJobInfo; processed: number; requests: number; jobId?: string },
    outcomes: readonly BulkRecordOutcome[],
    unmatchedIds: readonly string[],
    unmatchedWrites: number,
  ): BulkWriteAnswer => {
    const said = { requests: job.requests, ...(job.jobId ? { jobId: job.jobId } : {}) };
    if (job.info.state !== 'JobComplete' && job.processed === 0 && unmatchedWrites === 0) {
      return nothingWritten({
        ...said,
        untouched: untouchedBy(jobErrorOf(job.info) ?? 'job not complete'),
      });
    }
    const byRow = new Map(outcomes.map((outcome) => [outcome.recordIndex, outcome]));
    const answers: InsertResult[] = rows.map((state) =>
      noAnswer(state === 'twin' ? 'twin' : 'unprocessed'),
    );
    inJob.forEach((recordIndex, at) => {
      const row = rowOf(byRow.get(at), unmatchedWrites > 0);
      rows[recordIndex] = row.state;
      answers[recordIndex] = row.answer;
    });
    return { answers, rows, unmatchedIds: [...unmatchedIds], ...said };
  };

  const tracked = trackedBulkConnection(conn);
  // The id the org gave the job, as it told it once open: `result.jobId` may
  // be an id of the limiter's own (`bulk-…`) for a job the org gave none.
  let jobId: string | undefined;
  const withJob = (): Pick<BulkWriteAnswer, 'jobId'> => (jobId ? { jobId } : {});
  const pollDelay = options.pollDelay ?? FORGE_BULK_POLL_SCHEDULE;
  let result: BulkExecutionResult;
  try {
    result = await new BulkApiExecutor().executeBulk(
      {
        connection: tracked.connection,
        bulkManager,
        pollIntervalMs: pollDelay,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        onOpened: (id) => {
          jobId = id;
          options.onOpened?.(id);
        },
      },
      objectName,
      operation,
      subset,
      options.externalIdField,
    );
  } catch (err: unknown) {
    const reason = extractErrorMessage(err);
    if (!tracked.closeSent()) {
      // Opened, sent, or not even that: the org holds nothing to process.
      return nothingWritten({
        requests: tracked.requests(),
        ...withJob(),
        untouched: untouchedBy(reason),
      });
    }
    if (jobId === undefined) {
      throw new BulkJobLostError('', reason, tracked.requests(), [...twins]);
    }
    const read = await readBack(tracked.connection, jobId, pollDelay);
    if (read.state === 'never-closed') {
      // The close never reached the org: the job was left open, is aborted
      // now, and was read again after its abort, still open or aborted with
      // no row processed (`readJobResults`).
      return nothingWritten({
        requests: tracked.requests(),
        jobId,
        untouched: untouchedBy(reason),
      });
    }
    if (read.state !== 'ended') {
      throw new BulkJobLostError(
        jobId,
        read.state === 'unread' ? read.reason : 'still running',
        tracked.requests(),
        [...twins],
      );
    }
    const normalized = normalizeBulkJobResults(read.results, upload, jobErrorOf(read.info));
    return answered(
      { info: read.info, processed: tracked.processed(), requests: tracked.requests(), jobId },
      normalized.outcomes,
      normalized.unattributedSuccessIds,
      normalized.unattributedSuccesses,
    );
  }
  if (result.aborted) {
    return nothingWritten({ requests: tracked.requests(), ...withJob(), aborted: true });
  }
  const last = tracked.last();
  return answered(
    {
      info: {
        state: last.state ?? 'JobComplete',
        ...(last.message ? { errorMessage: last.message } : {}),
      },
      processed: tracked.processed(),
      requests: tracked.requests(),
      ...withJob(),
    },
    result.outcomes,
    result.unmatchedIds ?? [],
    result.unmatchedWrites ?? 0,
  );
}

/**
 * Read a closed job back by its id until it has ended, waiting between two
 * reads as it was polled. A job found open was never closed: it is aborted
 * at once — the run sent it, and stopped uploading it — and read again, so
 * that one the lost close reached in the meantime is read on as running.
 */
async function readBack(
  conn: IngestJobResultsReading,
  jobId: string,
  pollDelay: BulkPollSchedule,
): Promise<JobResultsRead> {
  let read = await readJobResults(conn, jobId, { openGraceMs: 0 });
  for (let attempt = 1; attempt < READS_AFTER_CLOSE; attempt++) {
    if (read.state === 'ended' || read.state === 'never-closed') return read;
    await new Promise((resolve) => setTimeout(resolve, pollDelay(attempt - 1)));
    read = await readJobResults(conn, jobId, { openGraceMs: 0 });
  }
  return read;
}

/** Why a job that ended did not complete, as the org says it; nothing for a complete one. */
function jobErrorOf(info: IngestJobInfo): string | undefined {
  if (info.state === 'JobComplete') return undefined;
  return info.errorMessage || `job ${info.state}`;
}

/** Nothing written, for `reason`: unsupported when the org says the Bulk API does not write the object. */
function untouchedBy(reason: string): NonNullable<BulkWriteAnswer['untouched']> {
  return UNSUPPORTED_RE.test(reason) ? { reason, unsupported: true } : { reason };
}

/** A refusal saying why a row has no answer of its own. */
function noAnswer(state: Exclude<BulkRowState, 'answered'>): InsertResult {
  return { id: '', success: false, errors: [NO_ANSWER[state]] };
}

/**
 * What became of one row of the job, from its outcome: written with its id,
 * refused with its error read for its code and fields (`bulkSaveErrorDetail`)
 * when it is exactly one error, not processed, or written perhaps.
 *
 * @param unmatched - Whether the job wrote records no row was matched to, an
 *   id given for each or not: a row left without a result may be one of them.
 */
function rowOf(
  outcome: BulkRecordOutcome | undefined,
  unmatched: boolean,
): { state: BulkRowState; answer: InsertResult } {
  if (outcome === undefined || outcome.state === 'no-result') {
    const state = unmatched ? 'may-have-written' : 'unprocessed';
    return { state, answer: noAnswer(state) };
  }
  if (outcome.state === 'unprocessed')
    return { state: 'unprocessed', answer: noAnswer('unprocessed') };
  if (outcome.success) {
    if (!outcome.id) return { state: 'may-have-written', answer: noAnswer('may-have-written') };
    return {
      state: 'answered',
      answer: {
        id: outcome.id,
        success: true,
        errors: [],
        ...(outcome.created !== undefined ? { created: outcome.created } : {}),
      },
    };
  }
  const error = outcome.error ?? 'Unknown error';
  const detail = bulkSaveErrorDetail(error);
  return {
    state: 'answered',
    answer: detail
      ? { id: '', success: false, errors: [formatSaveError(detail)], errorDetails: [detail] }
      : { id: '', success: false, errors: [error] },
  };
}

/** An insert's record with every empty value sent as a null: see the module's note. */
function emptyAsNull(record: Record<string, unknown>): Record<string, unknown> {
  let copy: Record<string, unknown> | undefined;
  for (const [field, value] of Object.entries(record)) {
    if (value !== '') continue;
    copy ??= { ...record };
    copy[field] = null;
  }
  return copy ?? record;
}
