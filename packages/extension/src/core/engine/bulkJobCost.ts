/**
 * What one Bulk API 2.0 job costs the org it runs on: the calls it sends, each
 * one of the org's daily requests, and the time it takes.
 *
 * Kept apart from every module that prices a job, so they all price it alike
 * and none imports another for it: the rewind estimate priced a job by the
 * calls it sends, and the gate every module's run meets priced it five calls
 * whatever it held, for want of reaching that estimate, which imports the
 * gate and could not be imported back.
 *
 * A job costs one request per call it sends, its records none: asked live, a
 * job of 200 deletes — opened, its CSV sent, closed, its state read twice —
 * took five off the day, as many as it sent. Once through, a job's results
 * are read three ways, each a call of its own. Its time was measured on
 * deletes (`BULK_JOB_WAIT_SECONDS`, `BULK_JOB_RECORDS_PER_SECOND`): nothing
 * measured an insert, and the slower figures are taken, so a job is read as
 * often as it may be.
 */

import { BULK_POLL_INTERVAL_MS } from './BulkApiExecutor.js';

/**
 * Reads of a Bulk API 2.0 job's results once it is through: its successful,
 * failed and unprocessed records, each a call of its own.
 */
export const BULK_RESULT_READS = 3;

/** Calls a Bulk API job sends whatever it holds: opened, its CSV sent, closed. */
const BULK_JOB_FIXED_CALLS = 3;

/**
 * Seconds a Bulk API job waits its turn in the org before it writes a record,
 * about: on a scratch org, 24 of the 25.6 seconds a job of 2,000 contact
 * deletes took.
 */
const BULK_JOB_WAIT_SECONDS = 24;

/**
 * Records a Bulk API job writes a second once under way, about: 12,000
 * deletes in 33 seconds, fifty thousand in about a minute and a half, the
 * slower of the two taken, so a job is read as often as it may be.
 */
const BULK_JOB_RECORDS_PER_SECOND = 750;

/**
 * How long a job is left before its state is read again, by the number of
 * reads already waited for (0 for the first wait), in milliseconds.
 */
export type BulkPollSchedule = (attempt: number) => number;

/** Seed's and Sync's wait between two reads of a job's state: always five seconds. */
const FIXED_POLL_SCHEDULE: BulkPollSchedule = () => BULK_POLL_INTERVAL_MS;

/**
 * Forge's wait between two reads of a job's state: five seconds, then ten,
 * then twenty, then thirty for as long as the job runs. A clone of a whole
 * org sends hundreds of jobs, each waiting its turn in the org before it
 * writes a row; read every five seconds, a job of ten thousand rows takes
 * nine reads of the day's requests, where this takes five, and a job that
 * ends between two reads is seen at most thirty seconds late.
 */
export const FORGE_BULK_POLL_SCHEDULE: BulkPollSchedule = (attempt) =>
  [5_000, 10_000, 20_000][attempt] ?? 30_000;

/**
 * The calls one Bulk API 2.0 job sends the org, each one of its daily
 * requests: opened, its CSV sent, closed, each read of its state, and its
 * results read three ways once it is through, unless told how many.
 */
export function bulkJobRequests(job: { stateReads: number; resultReads?: number }): number {
  return BULK_JOB_FIXED_CALLS + job.stateReads + (job.resultReads ?? BULK_RESULT_READS);
}

/** Seconds a Bulk API job of `records` takes, about: its wait, then its records. */
export function bulkJobSeconds(records: number): number {
  return BULK_JOB_WAIT_SECONDS + Math.max(0, records) / BULK_JOB_RECORDS_PER_SECOND;
}

/**
 * Reads of its state a Bulk API job of `records` takes: one as it is closed,
 * then one after each wait of `schedule`, until the waits cover its time.
 *
 * @param schedule - The waits between two reads; five seconds each unless told.
 */
export function bulkJobStateReads(
  records: number,
  schedule: BulkPollSchedule = FIXED_POLL_SCHEDULE,
): number {
  const ms = bulkJobSeconds(records) * 1000;
  let waited = 0;
  let waits = 0;
  while (waited < ms) {
    // A wait of nothing would never cover the job's time: one millisecond at least.
    waited += Math.max(1, schedule(waits));
    waits++;
  }
  return 1 + waits;
}

/**
 * Everything one Bulk API 2.0 job of `records` sends the org, from its
 * opening to the last read of its results: what a writer that sends an
 * object's records in one job pays for them, whatever their number.
 */
export function bulkJobCost(records: number): number {
  return bulkJobRequests({ stateReads: bulkJobStateReads(records) });
}
