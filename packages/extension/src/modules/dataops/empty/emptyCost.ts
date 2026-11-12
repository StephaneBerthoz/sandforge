/**
 * What an emptying costs the org, said before it runs: the API requests its
 * passes send, the Bulk API batches its jobs take, about how long it takes,
 * and how many records it puts in the recycle bin — each against what the
 * org has left, where it said.
 *
 * Its passes send their records as every removal does (`deleteRounds`, read
 * through `goesByJob`): over REST, 200 a call, an object's records below
 * 10,000, and past that in Bulk API 2.0 jobs of one size up to 50,000 each; a
 * file never goes by a job.
 * Each pass reads its ids first, 2,000 a page. A job costs a request per call
 * it sends, opened, sent, closed, its state read as long as it runs and its
 * results read three ways (`bulkJobCost.ts`), and a Bulk API batch of the
 * org's day per 10,000 of its records, shared with every other Bulk API load
 * of the day. An order past Draft is read and set back to Draft first, 200 a
 * call. What cannot be known before — a record refused and tried again, what
 * the org's automation does in answer — is not counted, and the estimate is
 * about.
 *
 * Deleted for good (`hard`), every object goes by a job, however few its
 * records: no REST call deletes for good. That costs more requests and more
 * time for small objects — a job waits its turn in the org, some 24 seconds,
 * before it deletes a record — and a Bulk API batch each, and puts nothing in
 * the recycle bin, which also means nothing can be brought back. A file is
 * never deleted for good — that would take a job, and no file is sent by one
 * — and is not sent at all.
 *
 * The recycle bin keeps, by Salesforce's documentation, 25 records per MB of
 * the org's data storage, and pushes the oldest out past that — a
 * colleague's deleted records among them. A Developer Edition of 5 MB was
 * seen to hold at least 1,851, where that would say 125: the figure warns,
 * it does not refuse.
 */

import { apiBudgetCheckOf, type ApiBudget, type ApiBudgetCheck } from '../../forge/ForgeRunGate.js';
import {
  BULK_DELETE_JOB_RECORDS,
  goesByJob,
  type DeleteMode,
  type DeletionOrg,
} from '../../../core/removal/deleteRecords.js';
import {
  bulkJobRequests,
  bulkJobSeconds,
  bulkJobStateReads,
} from '../../../core/engine/bulkJobCost.js';
import { RECORDS_PER_CALL } from '../RecordRemoval.js';
import {
  ESTIMATE_PAGE_ROWS,
  SECONDS_PER_DESCRIBE_CALL,
  SECONDS_PER_PAGE,
  SECONDS_PER_SMALL_CALL,
  SECONDS_PER_WRITE,
  type Cost,
} from '../../checkpoint/rewindEstimate.js';
import { SUBREQUESTS_PER_COMPOSITE } from '../../checkpoint/compositeQueries.js';

/**
 * Records of a Bulk API 2.0 job one of the org's daily Bulk API batches
 * counts: the platform cuts what a job is sent into batches of this many,
 * each taken from `DailyBulkApiBatches`.
 */
export const RECORDS_PER_BULK_BATCH = 10_000;

/**
 * The org of a run, as {@link goesByJob} reads it: one that takes Bulk API
 * jobs, as every connection a run deletes through does (`deletionOrg`). An
 * estimate sends nothing: its job is never called.
 */
const TAKES_JOBS: Pick<DeletionOrg, 'bulkDestroy'> = {
  bulkDestroy: () => Promise.reject(new Error('an estimate sends no job')),
};

/** Whether the records of `objectApiName` can be deleted for good: only a job does it. */
export function deletedForGood(objectApiName: string): boolean {
  return goesByJob(TAKES_JOBS, objectApiName, 1, 'hard');
}

/**
 * Requests an emptying sends whatever it deletes: the org's global describe,
 * the user it runs as and its `/limits`.
 */
const EMPTY_FIXED_REQUESTS = 3;

/** Records of the recycle bin per MB of data storage, as Salesforce documents it. */
const BIN_RECORDS_PER_MB = 25;

/** How one pass sends its records. */
export interface PassDeletes {
  objectApiName: string;
  /** Records the pass sends. */
  records: number;
  /** REST calls of up to 200. */
  restCalls: number;
  /** Bulk API jobs, each by its records. */
  jobs: number[];
  /** Whether its records go to the recycle bin: those deleted over REST always do. */
  toTheBin: boolean;
  /** Set when its records are not sent: a file, asked to be deleted for good. */
  notSent?: true;
}

/** How `records` of `objectApiName` go, as a removal cuts them, to the bin or for good. */
export function passDeletesOf(
  objectApiName: string,
  records: number,
  mode: DeleteMode,
): PassDeletes {
  const byJob = records > 0 && goesByJob(TAKES_JOBS, objectApiName, records, mode);
  if (!byJob && mode === 'hard' && records > 0) {
    return { objectApiName, records, restCalls: 0, jobs: [], toTheBin: false, notSent: true };
  }
  if (!byJob) {
    return {
      objectApiName,
      records,
      restCalls: Math.ceil(records / RECORDS_PER_CALL),
      jobs: [],
      toTheBin: true,
    };
  }
  const count = Math.ceil(records / BULK_DELETE_JOB_RECORDS);
  const size = Math.ceil(records / count);
  const jobs: number[] = [];
  for (let left = records; left > 0; left -= size) jobs.push(Math.min(left, size));
  return { objectApiName, records, restCalls: 0, jobs, toTheBin: mode === 'recycle' };
}

/** What an emptying's passes are given to price. */
export interface EmptyCostInput {
  mode: DeleteMode;
  /** Per pass, in order, the records it sends. */
  passes: ReadonlyArray<{ objectApiName: string; records: number }>;
  /** Records set back to Draft before any delete. */
  toDraft: number;
  /** Every record the emptying deletes, what goes along included: what the recycle bin takes. */
  deleted: number;
  /** The org's daily API requests, as its `/limits` say, or why they are not known. */
  apiBudget?: ApiBudget | { unread: string };
  /** The org's daily Bulk API batches, as its `/limits` say; absent when they did not. */
  bulkBatches?: ApiBudget;
  /** The org's data storage, in MB: what the recycle bin's size is read from. */
  dataStorageMB?: number;
}

/** What an emptying costs, and how it stands against what the org has left. */
export interface EmptyCost {
  apiRequests: number;
  /** Seconds, about. */
  seconds: number;
  /** The Bulk API batches its jobs take. */
  bulkBatches: number;
  /** Per pass, how it sends its records. */
  passes: PassDeletes[];
  /** Records put in the recycle bin. */
  binRecords: number;
  /**
   * The records the recycle bin keeps by Salesforce's documentation, and
   * whether the emptying puts more in it: then older deleted records,
   * colleagues' among them, may be pushed out. Absent when the org's data
   * storage is not known.
   */
  bin?: { documentedCapacity: number; past: boolean };
  /** The requests against the org's day. */
  api: ApiBudgetCheck;
  /** The batches against the org's day: absent when it sends no job. */
  batches?: ApiBudgetCheck;
}

/** `count` calls of `secondsEach`. */
function calls(count: number, secondsEach: number): Cost {
  return { apiRequests: count, seconds: count * secondsEach };
}

function sum(costs: readonly Cost[]): Cost {
  return costs.reduce(
    (total, cost) => ({
      apiRequests: total.apiRequests + cost.apiRequests,
      seconds: total.seconds + cost.seconds,
    }),
    { apiRequests: 0, seconds: 0 },
  );
}

/** Pages of ids a pass reads for `records`: one at least, what the org holds then unknown. */
function idPages(records: number): number {
  return Math.max(1, Math.ceil(records / ESTIMATE_PAGE_ROWS));
}

/** What sending one pass's deletes costs. */
function deletesCost(deletes: PassDeletes): Cost {
  if (deletes.notSent) return { apiRequests: 0, seconds: 0 };
  return sum([
    calls(idPages(deletes.records), SECONDS_PER_PAGE),
    calls(deletes.restCalls, SECONDS_PER_WRITE),
    ...deletes.jobs.map((job) => ({
      apiRequests: bulkJobRequests({ stateReads: bulkJobStateReads(job) }),
      seconds: bulkJobSeconds(job),
    })),
  ]);
}

/**
 * What setting `records` back to Draft costs: the org's statuses read once,
 * the records read 2,000 a page, and updated 200 a call.
 */
function toDraftCost(records: number): Cost {
  if (records <= 0) return { apiRequests: 0, seconds: 0 };
  return sum([
    calls(1, SECONDS_PER_SMALL_CALL),
    calls(Math.ceil(records / ESTIMATE_PAGE_ROWS), SECONDS_PER_PAGE),
    calls(Math.ceil(records / RECORDS_PER_CALL), SECONDS_PER_WRITE),
  ]);
}

/** What an emptying costs: see the module's comment. */
export function emptyCostOf(input: EmptyCostInput): EmptyCost {
  const passes = input.passes.map(({ objectApiName, records }) =>
    passDeletesOf(objectApiName, Math.max(0, records), input.mode),
  );
  const total = sum([
    calls(EMPTY_FIXED_REQUESTS, SECONDS_PER_SMALL_CALL),
    calls(Math.ceil(passes.length / SUBREQUESTS_PER_COMPOSITE), SECONDS_PER_DESCRIBE_CALL),
    toDraftCost(input.toDraft),
    ...passes.map(deletesCost),
  ]);
  const bulkBatches = passes.reduce(
    (batches, pass) =>
      batches + pass.jobs.reduce((n, job) => n + Math.ceil(job / RECORDS_PER_BULK_BATCH), 0),
    0,
  );
  const binRecords =
    input.mode === 'recycle'
      ? Math.max(0, input.deleted)
      : passes.filter((pass) => pass.toTheBin).reduce((n, pass) => n + pass.records, 0);
  const capacity =
    input.dataStorageMB === undefined ? undefined : input.dataStorageMB * BIN_RECORDS_PER_MB;
  const sendsJobs = passes.some((pass) => pass.jobs.length > 0);
  return {
    apiRequests: total.apiRequests,
    seconds: total.seconds,
    bulkBatches,
    passes,
    binRecords,
    ...(capacity === undefined
      ? {}
      : { bin: { documentedCapacity: capacity, past: binRecords > capacity } }),
    api: apiBudgetCheckOf(total.apiRequests, input.apiBudget),
    ...(sendsJobs
      ? {
          batches: input.bulkBatches
            ? apiBudgetCheckOf(bulkBatches, input.bulkBatches)
            : {
                verdict: 'unread' as const,
                estimate: bulkBatches,
                unread: 'the limits the org answered list no DailyBulkApiBatches',
              },
        }
      : {}),
  };
}
