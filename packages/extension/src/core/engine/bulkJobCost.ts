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
 * deletes (`BULK_JOB_WAIT_SECONDS`, `BULK_JOB_RECORDS_PER_SECOND`), and a job
 * that saves records — an insert, an update, an upsert — runs slower
 * (`BULK_SAVE_RECORDS_PER_SECOND`); the slower figures are taken, so a job is
 * read as often as it may be.
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
 * Records a Bulk API job saves a second once under way — an insert, an
 * update, an upsert, each record through the target's save path, its
 * triggers and its rules, which a delete is not —, at the slowest: asked live, a seed
 * of 12,000 cases on a scratch org, sent as jobs of 10,000 and 2,000, took 42
 * requests more than its dry run. Less the two reads that typed the org and
 * the query of the duplicate rules, the jobs took about 39, some 27 of them
 * reads of their state, where the cadence of deletes priced them 28 calls
 * with 16 such reads. Its records went at about 160 a second, its wait taken
 * as a delete's; 100 were taken, slower than that one run. A floor of reads a
 * job would not do: what the deletes' cadence missed grows with the job's
 * records, and a floor set by these two jobs would price one of 50,000 short.
 *
 * Counted call by call on the same org later, the same seed went
 * slower: its job of 10,000 read its state 27 times over the 142 seconds
 * from its close to its results, about 70 records a second with its wait;
 * the job of 2,000, 7 times over 33 seconds; a job of 600 cases, 4 times over
 * 17. At 100 a second the job of 10,000 was priced 26 reads, one short of
 * what it sent. 60 are taken, and the wait on top: the job of 10,000 is
 * priced 191 seconds, a third more than the slower of the two runs took.
 */
const BULK_SAVE_RECORDS_PER_SECOND = 60;

/** What a Bulk API job does with its records, as far as its time goes. */
export type BulkJobWork = 'delete' | 'save';

/**
 * The calls one Bulk API 2.0 job sends the org, each one of its daily
 * requests: opened, its CSV sent, closed, each read of its state, and its
 * results read three ways once it is through, unless told how many.
 */
export function bulkJobRequests(job: { stateReads: number; resultReads?: number }): number {
  return BULK_JOB_FIXED_CALLS + job.stateReads + (job.resultReads ?? BULK_RESULT_READS);
}

/**
 * Seconds a Bulk API job of `records` takes, about: its wait, then its
 * records, deleted or saved (`work`).
 */
export function bulkJobSeconds(records: number, work: BulkJobWork = 'delete'): number {
  const perSecond = work === 'save' ? BULK_SAVE_RECORDS_PER_SECOND : BULK_JOB_RECORDS_PER_SECOND;
  return BULK_JOB_WAIT_SECONDS + Math.max(0, records) / perSecond;
}

/**
 * Reads of its state a Bulk API job of `records` takes: one as it is closed,
 * then one after each wait of `schedule`, until the waits cover its time.
 *
 * @param schedule - The waits between two reads; five seconds each unless told.
 * @param work - What the job does with its records, which sets its time (`bulkJobSeconds`).
 */
export function bulkJobStateReads(
  records: number,
  schedule: BulkPollSchedule = FIXED_POLL_SCHEDULE,
  work: BulkJobWork = 'delete',
): number {
  const ms = bulkJobSeconds(records, work) * 1000;
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
 * object's records in one job pays for them, whatever their number, priced
 * as a job that saves them — a writer's delete, quicker, is priced so too.
 */
export function bulkJobCost(records: number): number {
  return bulkJobRequests({ stateReads: bulkJobStateReads(records, FIXED_POLL_SCHEDULE, 'save') });
}
