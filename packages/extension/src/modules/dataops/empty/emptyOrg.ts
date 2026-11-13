/**
 * The org an emptying reads and deletes through, over a jsforce connection:
 * its queries, a page at a time and through the recycle bin, its describes,
 * its clock and its user, its `/limits`, its deletes over REST and in Bulk
 * API 2.0 jobs — to the recycle bin, or for good — and its undeletes.
 *
 * A job closed and not read back — the org answered nothing, or failed the
 * read of its state after the close — goes on to its end on the org's side,
 * whatever became of the call that sent it, and may still be deleting as the
 * run ends. A run that muted the org's automation and gave the mute back at
 * once would let those deletes run every trigger and flow it was asked to
 * keep quiet. So each such job is kept by its id, and the run waits for them
 * (`stillRunning`) before it gives the mute back, as Forge's runs wait for
 * theirs (`LostBulkJobs`).
 */

import type { Connection } from 'jsforce';
import { openedJobId, type BulkApiConnection } from '../../../core/engine/BulkApiExecutor.js';
import { jsforceBulk } from '../../../core/engine/jsforceBulk.js';
import {
  bulkDeleteJob,
  deletionOrg,
  type BulkDeleteAnswer,
} from '../../../core/removal/deleteRecords.js';
import { countRequests } from '../../../core/precheck/orgKindLive.js';
import { LostBulkJobs, type LostBulkJob } from '../../forge/lostBulkJobs.js';
import type { EmptyPreviewOrg } from './emptyPreview.js';

/** A page of a query, as the org answers it. */
export interface EmptyQueryPage {
  totalSize: number;
  done: boolean;
  records: Array<Record<string, unknown>>;
  nextRecordsUrl?: string;
}

/** What an emptying, its dry run and its undo read and write an org through. */
export interface EmptyOrg extends EmptyPreviewOrg {
  query(soql: string, options?: { scanAll?: boolean }): Promise<EmptyQueryPage>;
  queryMore(nextRecordsUrl: string): Promise<EmptyQueryPage>;
  /** A query that reads the recycle bin too: one page. */
  queryDeleted(soql: string): Promise<{ records: unknown[] }>;
  describeGlobal(): Promise<unknown>;
  /** The objects the org's Tooling API serves; none when it cannot say. */
  toolingObjects(): Promise<string[]>;
  /** The org's clock now, as it dates what it writes. */
  serverTime(): Promise<string>;
  /** The id of the user the connection acts as. */
  userId(): Promise<string>;
  /** What the org's `/limits` answer. */
  limits(): Promise<unknown>;
  update(objectApiName: string, records: Array<Record<string, unknown>>): Promise<unknown>;
  destroy(objectApiName: string, ids: string[]): Promise<unknown>;
  bulkDestroy?(
    objectApiName: string,
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<BulkDeleteAnswer>;
  bulkHardDestroy?(
    objectApiName: string,
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<BulkDeleteAnswer>;
  /** Takes records out of the recycle bin by their ids, one answer per id. */
  undelete(ids: string[]): Promise<unknown>;
  /** The delete jobs closed and not read back so far. */
  lostJobs?(): readonly LostBulkJob[];
  /** Of `jobs`, those the org still runs once waited for, at most ten minutes. */
  stillRunning?(jobs: readonly LostBulkJob[]): Promise<LostBulkJob[]>;
  /** Every request sent the org through this one so far, counted as sent. */
  requestsSent?(): number;
}

/**
 * The Bulk API of `conn` with each job's id kept as the org opens it, and
 * whether it was closed: a job that fails after its close is one the org may
 * still be running.
 */
function trackedBulk(conn: Connection): {
  bulk: BulkApiConnection;
  last: () => { jobId?: string; closed: boolean };
} {
  const bulk = jsforceBulk(conn);
  let last: { jobId?: string; closed: boolean } = { closed: false };
  return {
    bulk: {
      bulk2: {
        createJob: (options) => {
          const job = bulk.bulk2.createJob(options);
          last = { closed: false };
          return {
            get id() {
              return job.id;
            },
            open: async () => {
              await job.open();
              const jobId = openedJobId(job);
              last = { ...(jobId !== undefined ? { jobId } : {}), closed: false };
            },
            uploadData: (csv) => job.uploadData(csv),
            close: async () => {
              await job.close();
              last = { ...last, closed: true };
            },
            abort: () => job.abort(),
            check: () => job.check(),
            getAllResults: () => job.getAllResults(),
          };
        },
      },
    },
    last: () => last,
  };
}

/**
 * The org an emptying works on, over `conn`: see the module's comment.
 *
 * @param orgId - The org's id in the registry, as the jobs it loses name it.
 * @param context - Names the work in the API-usage warnings.
 */
export function emptyOrgOf(conn: Connection, orgId: string, context: string): EmptyOrg {
  // Counted from the first call, through the connection itself: what else
  // reads through it — the guard, the emails' limits — is counted with it.
  const requestsSent = countRequests(conn);
  const deletion = deletionOrg(conn, context);
  const tracked = trackedBulk(conn);
  const lost: LostBulkJob[] = [];
  const waits = new LostBulkJobs(
    async (_orgId, jobId) =>
      (await jsforceBulk(conn).bulk2.job('ingest', { id: jobId }).check()).state,
  );
  const job =
    (operation: 'delete' | 'hardDelete') =>
    async (objectApiName: string, ids: readonly string[], signal?: AbortSignal) => {
      try {
        return await bulkDeleteJob(tracked.bulk, objectApiName, ids, signal, operation);
      } catch (err: unknown) {
        const last = tracked.last();
        if (last.closed) {
          lost.push({ orgId, objectApiName, ...(last.jobId ? { jobId: last.jobId } : {}) });
        }
        throw err;
      }
    };
  const page = (answer: {
    totalSize: number;
    done: boolean;
    records: Array<Record<string, unknown>>;
    nextRecordsUrl?: string;
  }): EmptyQueryPage => ({
    totalSize: answer.totalSize,
    done: answer.done,
    records: answer.records,
    ...(answer.nextRecordsUrl ? { nextRecordsUrl: answer.nextRecordsUrl } : {}),
  });
  return {
    describe: (objectApiName) => conn.describe(objectApiName),
    count: async (soql) => (await conn.query(soql)).totalSize,
    countAll: async (soql) => (await conn.query(soql, { scanAll: true })).totalSize,
    readIds: async (soql, all) => {
      const answer = await conn.query<Record<string, unknown>>(soql, { scanAll: all });
      return {
        totalSize: answer.totalSize,
        ids: answer.records.flatMap((row) => (typeof row.Id === 'string' ? [row.Id] : [])),
      };
    },
    query: async (soql, options) =>
      page(await conn.query<Record<string, unknown>>(soql, { scanAll: options?.scanAll === true })),
    queryMore: async (nextRecordsUrl) =>
      page(await conn.queryMore<Record<string, unknown>>(nextRecordsUrl)),
    queryDeleted: (soql) => deletion.queryDeleted(soql),
    describeGlobal: () => conn.describeGlobal(),
    toolingObjects: async () => {
      try {
        return (await conn.tooling.describeGlobal()).sobjects.map((sobject) => sobject.name);
      } catch {
        return [];
      }
    },
    serverTime: async () => (await conn.soap.getServerTimestamp()).timestamp,
    userId: async () => (await conn.soap.getUserInfo()).userId,
    limits: () => conn.request({ method: 'GET', url: '/limits' }),
    update: (objectApiName, records) => deletion.update(objectApiName, records),
    destroy: (objectApiName, ids) => deletion.destroy(objectApiName, ids),
    bulkDestroy: job('delete'),
    bulkHardDestroy: job('hardDelete'),
    undelete: (ids) => conn.soap.undelete(ids),
    lostJobs: () => [...lost],
    stillRunning: (jobs) => waits.stillRunning(jobs),
    requestsSent,
  };
}
