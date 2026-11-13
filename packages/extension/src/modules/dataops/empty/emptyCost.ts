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
 * call. Once the passes are through, each counts what was made since the
 * preview read the org, a statement a pass. A record the preview says will
 * be refused at first — what an object not emptied holds of it — is sent
 * again and read back once the rest has gone, 200 a call each.
 *
 * Before any of that, the org is read: its clock, its global describe, its
 * limits, the describes of what goes and what blocks, a count per object and
 * per relationship, what the user may do and see, who else is at work, and
 * what its automation runs ({@link EmptyCost.requests}). The dry run reads it
 * so, and the run reads it again before its first delete, to refuse what the
 * dry run did not show: both are in the estimate, which says what the
 * emptying sends from its dry run to its last delete. Counted on the deletes
 * alone, it said 25 requests where a dry run took 153 and its run about 170.
 * Beside them, before each read, the check of the connection it reads
 * through and, once, the org's connect by a command line, which no read
 * counts ({@link CONNECTING_REQUESTS}); and the lease of a mute the run holds
 * while it deletes, its permission sets assigned and taken back
 * (`muteLeaseRequests`). What cannot be known before — what the org's
 * automation does in answer — is not counted, and the estimate is about.
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
  SECONDS_PER_PAGE,
  SECONDS_PER_SMALL_CALL,
  SECONDS_PER_WRITE,
  type Cost,
} from '../../checkpoint/rewindEstimate.js';

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
 * Requests a read of the org sends whatever it deletes: what kind of org it
 * is, its clock, its global describe, what its Tooling API serves, its
 * `/limits`, what the user may do, who the user is — twice, the second for
 * their grants — and the org's Automated Process user.
 */
export const EMPTY_FIXED_READS = 9;

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
  /** The requests a read of the org as the dry run reads it takes: see {@link EmptyCost.requests}. */
  reads: number;
  /** The reads of the org the estimate holds: the dry run's and the run's (2), the run's alone (1). */
  readings?: 1 | 2;
  /** Of the objects going along, those whose records past Draft are read by a condition of their own. */
  draftReads?: number;
  /** Per object of records the org will refuse at first, how many: sent again, then read back. */
  refused?: readonly number[];
}

/** What an emptying costs, and how it stands against what the org has left. */
export interface EmptyCost {
  /** Every request together: the reads of the org, `requests.readings` times, and the passes'. */
  apiRequests: number;
  /**
   * The requests apart: `reads`, one read of the org as the dry run read it —
   * counted as they were sent where the dry run counted them, else its
   * describes, its counts and its fixed reads, what the automation reads
   * apart; how many such reads the estimate holds; what the passes send; and
   * the margin for what the org's answers make vary ({@link MARGIN_SHARE}).
   */
  requests: {
    reads: number;
    readings: 1 | 2;
    passes: number;
    margin: number;
    /** Connecting the org and checking the connection of each read ({@link CONNECTING_REQUESTS}). */
    connecting?: number;
    /** The lease of the mute the run holds while it deletes: absent when it mutes nothing. */
    mute?: number;
  };
  /** Seconds of the run, about: its read of the org and its passes. */
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

/**
 * What one pass costs: its ids read, its deletes, and the count of what was
 * made since the preview once the passes are through.
 */
function deletesCost(deletes: PassDeletes): Cost {
  if (deletes.notSent) return { apiRequests: 0, seconds: 0 };
  return sum([
    calls(idPages(deletes.records), SECONDS_PER_PAGE),
    calls(1, SECONDS_PER_SMALL_CALL),
    calls(deletes.restCalls, SECONDS_PER_WRITE),
    ...deletes.jobs.map((job) => ({
      apiRequests: bulkJobRequests({ stateReads: bulkJobStateReads(job) }),
      seconds: bulkJobSeconds(job),
    })),
  ]);
}

/**
 * What setting `records` back to Draft costs: the org's statuses read once,
 * the records read 2,000 a page, updated 200 a call, and read back by their
 * ids once the passes are through, 200 a statement, to give the status back
 * to those the run left.
 */
function toDraftCost(records: number): Cost {
  if (records <= 0) return { apiRequests: 0, seconds: 0 };
  return sum([
    calls(1, SECONDS_PER_SMALL_CALL),
    calls(Math.ceil(records / ESTIMATE_PAGE_ROWS), SECONDS_PER_PAGE),
    calls(Math.ceil(records / RECORDS_PER_CALL), SECONDS_PER_WRITE),
    calls(Math.ceil(records / RECORDS_PER_CALL), SECONDS_PER_PAGE),
  ]);
}

/**
 * What the records the org refuses at first cost once the rest has gone:
 * sent again, 200 a call, and read back to tell those a parent took along.
 */
function refusedCost(records: number): Cost {
  if (records <= 0) return { apiRequests: 0, seconds: 0 };
  const batches = Math.ceil(records / RECORDS_PER_CALL);
  return sum([calls(batches, SECONDS_PER_WRITE), calls(batches, SECONDS_PER_PAGE)]);
}

/**
 * The share of the requests the estimate adds for what the org's answers
 * make vary: a job's state read more often than its pace says, a record the
 * org could not lock sent again, a call a limit cut in halves, the
 * automation read again by the run. On the memory org the estimate met what
 * was sent to the request; a real org is never that even.
 */
const MARGIN_SHARE = 0.05;

/**
 * Requests no read of the org counts, sent before it: the identity call that
 * checks the connection each read goes through — the API's version root,
 * then the identity URL — and, once, the org's connect by a command line,
 * that identity and its Organization record (`connectionChecks.ts`). The
 * panel, connected long before and its connection checked once in five
 * minutes, sends fewer: they are a margin there.
 */
export const CONNECTING_REQUESTS = { check: 2, connect: 3 } as const;

/**
 * `cost`'s requests and seconds with `reads` for one read of the org,
 * `readings` times, each after its connection's check, and the org's connect
 * once; and `mute`, what the lease of the run's mute sends.
 */
function withReads(
  passes: Cost,
  reads: number,
  readings: 1 | 2,
  mute = 0,
): Pick<EmptyCost, 'apiRequests' | 'seconds' | 'requests'> {
  const connecting = readings * CONNECTING_REQUESTS.check + CONNECTING_REQUESTS.connect;
  const counted = readings * reads + connecting + passes.apiRequests + mute;
  const margin = Math.ceil(counted * MARGIN_SHARE);
  return {
    apiRequests: counted + margin,
    seconds: reads * SECONDS_PER_SMALL_CALL + passes.seconds,
    requests: {
      reads,
      readings,
      passes: passes.apiRequests,
      margin,
      connecting,
      ...(mute > 0 ? { mute } : {}),
    },
  };
}

/** What an emptying costs: see the module's comment. */
export function emptyCostOf(input: EmptyCostInput): EmptyCost {
  const passes = input.passes.map(({ objectApiName, records }) =>
    passDeletesOf(objectApiName, Math.max(0, records), input.mode),
  );
  const passCost = sum([
    toDraftCost(input.toDraft),
    calls(input.draftReads ?? 0, SECONDS_PER_PAGE),
    ...passes.map(deletesCost),
    ...(input.refused ?? []).map(refusedCost),
  ]);
  const total = withReads(passCost, Math.max(0, input.reads), input.readings ?? 2);
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
    ...total,
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

/** A pass of a run taken up, as its journal leaves it. */
export interface ResumedPass {
  objectApiName: string;
  /** The records left for it to send: its spool less what the journal names deleted or gone, or the preview's count. */
  records: number;
  /** Whether its ids were read already: the spool is read again, not the org. */
  idsRead: boolean;
}

/**
 * What taking up a run costs, from its connect to its last delete: `reads`,
 * the requests its reads of the org sent before its first delete, as
 * counted; what is left of each pass, sent as the run sends it — its ids
 * read unless its spool holds them, its deletes, the count of what was made
 * since —; the lease of its mute; and the margin. Its JSON gave what it sent
 * alone, which nothing held to an estimate.
 */
export function resumeRequestsOf(
  mode: DeleteMode,
  passes: readonly ResumedPass[],
  reads: number,
  mute = 0,
): number {
  const passCost = sum(
    passes.map((pass) => {
      const deletes = passDeletesOf(pass.objectApiName, Math.max(0, pass.records), mode);
      const cost = deletesCost(deletes);
      if (!pass.idsRead || deletes.notSent) return cost;
      const pages = idPages(deletes.records);
      return {
        apiRequests: cost.apiRequests - pages,
        seconds: cost.seconds - pages * SECONDS_PER_PAGE,
      };
    }),
  );
  return withReads(passCost, Math.max(0, reads), 1, Math.max(0, mute)).apiRequests;
}

/**
 * The requests an undo sends past its reads, for each 200 ids its journal
 * names: the recycle bin read, the org read, the undelete.
 */
export const UNDO_CALLS_PER_BATCH = 3;

/**
 * What an undo costs, from its connect to its last read: `reads`, what its
 * reads of the org sent before its first undelete, as counted; `calls`,
 * those its batches send and its reads again of what the bin would not give
 * back (`undoCallsOf`); the lease of its mute; and the margin.
 */
export function undoRequestsOf(calls: number, reads: number, mute = 0): number {
  return withReads(
    { apiRequests: Math.max(0, calls), seconds: 0 },
    Math.max(0, reads),
    1,
    Math.max(0, mute),
  ).apiRequests;
}

/**
 * `cost` priced again with `reads` for one read of the org — the requests a
 * read sent, as counted once it was through — held `readings` times: a dry
 * run's estimate holds its own read and its run's, a run's gate its own
 * alone, the dry run's being spent. Against what the org had left as the
 * read began, which the limits the estimate was read with say. `mute`, what
 * the lease of the mute the run holds sends (`muteLeaseRequests`).
 */
export function pricedWithReads(
  cost: EmptyCost,
  reads: number,
  readings: 1 | 2,
  mute = 0,
): EmptyCost {
  const passes = {
    apiRequests: cost.requests.passes,
    seconds: cost.seconds - cost.requests.reads * SECONDS_PER_SMALL_CALL,
  };
  const total = withReads(passes, Math.max(0, reads), readings, Math.max(0, mute));
  const budget =
    cost.api.verdict === 'unread'
      ? { unread: cost.api.unread }
      : { max: cost.api.max, remaining: cost.api.remaining };
  return { ...cost, ...total, api: apiBudgetCheckOf(total.apiRequests, budget) };
}
