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
 * The calls one Bulk API 2.0 job sends the org, each one of its daily
 * requests: opened, its CSV sent, closed, each read of its state, and its
 * results read three ways once it is through, unless told how many.
 */
export function bulkJobRequests(job: { stateReads: number; resultReads?: number }): number {
  return BULK_JOB_FIXED_CALLS + job.stateReads + (job.resultReads ?? BULK_RESULT_READS);
}

/** Seconds a Bulk API job of `records` takes, about: its wait, then its records. */
export function bulkJobSeconds(records: number): number {
  return BULK_JOB_WAIT_SECONDS + records / BULK_JOB_RECORDS_PER_SECOND;
}

/**
 * Reads of its state a Bulk API job of `records` takes: one as it is closed,
 * then one each time the executor waits for it, as long as its time.
 */
export function bulkJobStateReads(records: number): number {
  return 1 + Math.ceil((bulkJobSeconds(records) * 1000) / BULK_POLL_INTERVAL_MS);
}

/**
 * Everything one Bulk API 2.0 job of `records` sends the org, from its
 * opening to the last read of its results: what a writer that sends an
 * object's records in one job pays for them, whatever their number.
 */
export function bulkJobCost(records: number): number {
  return bulkJobRequests({ stateReads: bulkJobStateReads(records) });
}
