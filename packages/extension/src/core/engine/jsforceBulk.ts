/**
 * A jsforce connection's Bulk API 2.0, as the executor drives a job and a job
 * is read back by its id (`BulkApiConnection`, `IngestJobResultsReading`).
 *
 * jsforce's own types are close to these, not the same: a job's `open`
 * answers what the org said of it, and a read of its state may say `Open`,
 * which the executor never expects of a job it has closed. Taken for them by
 * a cast, a connection passed whatever jsforce answered for a job's state,
 * unread. Here every answer about a job's state is held to the states the
 * Bulk API gives an ingest job (`ingestJobInfoOf`) as it comes from the org,
 * and a job still open after its close is said so rather than read as done.
 *
 * Types only of jsforce: the module stays off the activation path.
 */

import type { Connection } from 'jsforce';
import {
  openedJobId,
  type BulkApiConnection,
  type BulkJobCheckResult,
  type BulkJobHandle,
} from './BulkApiExecutor.js';
import { ingestJobInfoOf, type IngestJobResultsReading } from './ingestJobRead.js';

/**
 * A closed job's state as the executor reads it.
 *
 * @throws Error when the org holds the job open still: its close did not take.
 */
function closedJobStatus(jobId: string, answer: unknown): BulkJobCheckResult {
  const info = ingestJobInfoOf(jobId, answer);
  if (info.state === 'Open') {
    throw new Error(`Bulk API job ${jobId || '(no id)'} is still open after its close was sent`);
  }
  return {
    state: info.state,
    ...(info.numberRecordsProcessed !== undefined
      ? { numberRecordsProcessed: info.numberRecordsProcessed }
      : {}),
    ...(info.errorMessage ? { errorMessage: info.errorMessage } : {}),
  };
}

/** The Bulk API 2.0 of `conn`: its jobs created, and read back by their ids. */
export function jsforceBulk(
  conn: Pick<Connection, 'bulk2'>,
): BulkApiConnection & IngestJobResultsReading {
  return {
    bulk2: {
      createJob: (options): BulkJobHandle => {
        const job = conn.bulk2.createJob(options);
        return {
          // jsforce holds the id once the org has opened the job.
          get id() {
            return job.id;
          },
          open: async () => {
            await job.open();
          },
          uploadData: (csv) => job.uploadData(csv),
          close: () => job.close(),
          abort: () => job.abort(),
          check: async () => closedJobStatus(openedJobId(job) ?? '', await job.check()),
          getAllResults: () => job.getAllResults(),
        };
      },
      job: (type, { id }) => {
        const job = conn.bulk2.job(type, { id });
        return {
          check: async () => ingestJobInfoOf(id, await job.check()),
          getSuccessfulResults: () => job.getSuccessfulResults(),
          getAllResults: () => job.getAllResults(),
          abort: () => job.abort(),
        };
      },
    },
  };
}
