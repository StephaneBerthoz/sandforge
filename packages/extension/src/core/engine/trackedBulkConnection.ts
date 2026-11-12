/**
 * A Bulk API 2.0 connection that keeps count of what its job told it and of
 * the calls it sent the org.
 *
 * The executor (`BulkApiExecutor.executeBulk`) drives a job from open to
 * results and answers with its rows, or throws; it does not say how far the
 * job got before it threw, nor how many calls it sent. Both matter to its
 * caller: whatever fails before the job is closed leaves the org nothing to
 * process, and the rows can be written another way; once it is closed, the
 * org writes it whatever becomes of the call, and its rows are only ever
 * answered by reading the job back. Each call — opened, its CSV sent, closed
 * or aborted, each read of its state, its results read three ways — is one of
 * the org's daily requests, its records none (asked live: a job of 200
 * deletes cost five).
 *
 * A removal's delete jobs are tracked the same way in `ForgeRunRemoval`
 * (`bulkDeleteJob`); Forge's writes are tracked here, and the jobs read back
 * by their id through the same connection are counted with them.
 */

import {
  openedJobId,
  type BulkApiConnection,
  type BulkJobHandle,
  type BulkJobRecordResult,
  type JsforceIngestJobResults,
} from './BulkApiExecutor.js';
import { BULK_RESULT_READS } from './bulkJobCost.js';
import type { IngestJobResultsReading } from './ingestJobRead.js';

/** What a tracked connection's job told it, and the calls it sent. */
export interface TrackedBulk<C extends BulkApiConnection = BulkApiConnection> {
  /** The connection to drive the job through: its calls are the ones counted. */
  readonly connection: C;
  /** Whether the job's close was sent, answered or not: the org may have it closed. */
  closeSent(): boolean;
  /** Whether the org answered the job's close: from then on it writes the job whatever happens. */
  closed(): boolean;
  /** The id the org gave the job once it opened it; nothing before, or when it gave none. */
  jobId(): string | undefined;
  /** The job's last state, and its message, as the org last told it. */
  last(): { state?: string; message?: string };
  /** Rows the job's results answer, written or refused: none, and it processed nothing. */
  processed(): number;
  /** The calls sent the org so far, each one of its daily requests. */
  requests(): number;
}

/** Rows a job's results answer, written or refused: its unprocessed records are not. */
function answeredRows(results: BulkJobRecordResult[] | JsforceIngestJobResults): number {
  if (Array.isArray(results)) return results.length;
  return (results.successfulResults?.length ?? 0) + (results.failedResults?.length ?? 0);
}

/**
 * Track the job created through `conn` and the jobs read back through it by
 * their id.
 *
 * @param onRequests - Told each call as it is sent, with how many requests it costs.
 */
export function trackedBulkConnection(
  conn: BulkApiConnection & IngestJobResultsReading,
  onRequests?: (requests: number) => void,
): TrackedBulk<BulkApiConnection & IngestJobResultsReading>;
export function trackedBulkConnection(
  conn: BulkApiConnection,
  onRequests?: (requests: number) => void,
): TrackedBulk;
export function trackedBulkConnection(
  conn: BulkApiConnection | (BulkApiConnection & IngestJobResultsReading),
  onRequests?: (requests: number) => void,
): TrackedBulk<BulkApiConnection> {
  let closeSent = false;
  let closed = false;
  let jobId: string | undefined;
  let last: { state?: string; message?: string } = {};
  let processed = 0;
  let requests = 0;
  /** Count a call before it is sent: the org counts one it refused all the same. */
  const sent = <T>(calls: number, call: () => Promise<T>): Promise<T> => {
    requests += calls;
    onRequests?.(calls);
    return call();
  };
  /** Its successful, failed and unprocessed records: three reads, the rows answered kept. */
  const readAll = async <R extends BulkJobRecordResult[] | JsforceIngestJobResults>(
    read: () => Promise<R>,
  ): Promise<R> => {
    const results = await sent(BULK_RESULT_READS, read);
    processed = answeredRows(results);
    return results;
  };

  const bulk2: BulkApiConnection['bulk2'] & Partial<IngestJobResultsReading['bulk2']> = {
    // The job, told what the org did with it: jsforce's handle, as the executor drives it.
    createJob: (options): BulkJobHandle => {
      const job = conn.bulk2.createJob(options);
      return {
        get id() {
          return job.id;
        },
        open: async () => {
          await sent(1, () => job.open());
          jobId = openedJobId(job);
        },
        uploadData: (csv) => sent(1, () => job.uploadData(csv)),
        close: async () => {
          closeSent = true;
          await sent(1, () => job.close());
          closed = true;
        },
        abort: () => sent(1, () => job.abort()),
        check: async () => {
          const status = await sent(1, () => job.check());
          last = { state: status.state, message: status.errorMessage };
          return status;
        },
        getAllResults: () => readAll(() => job.getAllResults()),
      };
    },
  };
  if ('job' in conn.bulk2) {
    const reading = conn.bulk2;
    // A job read back by its id, each call counted as the job's own were.
    bulk2.job = (type, options) => {
      const job = reading.job(type, options);
      return {
        check: async () => {
          const info = await sent(1, () => job.check());
          last = { state: info.state, message: info.errorMessage ?? undefined };
          return info;
        },
        getSuccessfulResults: () => sent(1, () => job.getSuccessfulResults()),
        getAllResults: () => readAll(() => job.getAllResults()),
        abort: () => sent(1, () => job.abort()),
      };
    };
  }

  return {
    connection: { bulk2 },
    closeSent: () => closeSent,
    closed: () => closed,
    jobId: () => jobId,
    last: () => last,
    processed: () => processed,
    requests: () => requests,
  };
}
