/**
 * The Bulk API jobs of a run that no line of its file answers, read back from
 * the org by their ids.
 *
 * A job goes on to its end on the org's side once it is closed, whatever
 * becomes of the window that sent it: a seed of thousands of contacts whose
 * window closed while its job ran left them all in the org, and its run file
 * named the call and none of its records — the removal took what the earlier
 * calls created and left the job's. So did a Sync run whose job failed while
 * it was polled: the run ended in failure, and the job's records were in the
 * target all the same. The run keeps the job's id as soon as the org has
 * opened it (`SyncCreationRecorder.sending`), and the job's successful
 * results name every record it wrote, with whether it created it
 * (`sf__Created`), for as long as the org keeps the job: seven days.
 *
 * Read only, but for a job the org never processed: one left open — the
 * window closed before it was closed — is aborted, so that nothing closes it
 * later, and it wrote nothing. Never one opened less than
 * {@link OPEN_JOB_GRACE_MS} ago: a job stays open for the whole of its
 * upload, and a second window that listed the run during it aborted the
 * first window's job, whose records were then never written.
 */

import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import type { SyncRunKept } from './SyncRunCreations.js';

/**
 * How long a job left open is taken for one still being uploaded: an hour.
 * Its window uploads a job's rows right after the org opens it, and closes
 * it once they are all sent; a job open longer than this was left so.
 */
export const OPEN_JOB_GRACE_MS = 60 * 60_000;

/** A Salesforce id, as every id read back is: they end up in deletes. */
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** How an ingest job is reached by its id: the part of a jsforce connection this reads. */
export interface IngestJobReading {
  bulk2: {
    job(
      type: 'ingest',
      options: { id: string },
    ): {
      check(): Promise<{ state: string; systemModstamp?: string; createdDate?: string }>;
      getSuccessfulResults(): Promise<ReadonlyArray<Record<string, unknown>>>;
      abort(): Promise<unknown>;
    };
  };
}

/** What a job read back by its id says of the records it wrote. */
export type JobCreatedRead =
  /** It ended: the records it created, and when the org last dated it. */
  | { state: 'ended'; created: string[]; at?: string }
  /** The org is still processing it: its records are not all known yet. */
  | { state: 'running' }
  /** It was never closed, and wrote nothing: aborted now. */
  | { state: 'never-closed' }
  /** The org could not be asked, or no longer holds the job. */
  | { state: 'unread'; reason: string };

/** The `sf__Created` column of a successful row, as a CSV result holds it: text. */
function createdFlag(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}

/**
 * The records a job created, read from its successful results by its id: on
 * an insert every row the job wrote; on an upsert the rows the org says it
 * created, a row it updated being the target's before. A row whose
 * `sf__Created` does not say is left out of an upsert, never guessed into the
 * run's.
 *
 * @param upsert - Whether the job upserts.
 * @param now - This machine's clock, in epoch milliseconds.
 */
export async function readJobCreated(
  conn: IngestJobReading,
  jobId: string,
  upsert: boolean,
  now: () => number = () => Date.now(),
): Promise<JobCreatedRead> {
  try {
    const job = conn.bulk2.job('ingest', { id: jobId });
    const info = await job.check();
    if (info.state === 'Open') {
      // Opened lately: its window may be uploading it still. Read again later.
      const opened = Date.parse(info.createdDate ?? '');
      if (Number.isFinite(opened) && now() - opened < OPEN_JOB_GRACE_MS) {
        return { state: 'running' };
      }
      // Never closed: the org never processes it, and nothing closes it now.
      await job.abort().catch(() => undefined);
      return { state: 'never-closed' };
    }
    if (info.state === 'UploadComplete' || info.state === 'InProgress') return { state: 'running' };
    // Ended — complete, failed, or aborted once it ran: what it wrote is in
    // its successful results all the same.
    const rows = await job.getSuccessfulResults();
    const created = rows.flatMap((row) => {
      const id = row['sf__Id'];
      if (typeof id !== 'string' || !RECORD_ID.test(id)) return [];
      if (upsert && createdFlag(row['sf__Created']) !== true) return [];
      return [id];
    });
    return {
      state: 'ended',
      created,
      ...(typeof info.systemModstamp === 'string' ? { at: info.systemModstamp } : {}),
    };
  } catch (err: unknown) {
    return { state: 'unread', reason: extractErrorMessage(err) };
  }
}

/** Where the answer of a job read back goes: the run's file (`SyncRunCreations.answerInFlight`). */
export interface InFlightAnswers {
  answerInFlight(
    runId: string,
    objectApiName: string,
    ids: readonly string[],
    at: string,
    job?: string,
  ): Promise<boolean>;
}

/** What answering one of a run's jobs did. */
export interface JobAnswered {
  /** The job, by its id. */
  job: string;
  /** Its object. */
  objectApiName: string;
  /** Its state, as read. */
  read: JobCreatedRead;
  /** Whether the run's file now holds its answer. */
  answered: boolean;
}

/**
 * Answer the Bulk API jobs of a run that no line answers (`SyncRunKept.jobs`),
 * once no window writes the run any more, whether it ended or not: each read
 * back by its id, its records go into the run's file as its answer would
 * have, naming the job, and the run is listed with them and removed with
 * them. A job still running is left unanswered, and read again at the next
 * listing; one the org cannot be asked about is said.
 *
 * Dated by the org's own date of the job — when it last changed state, its
 * records all written by then — set to this machine's clock as the run's
 * lines are, once the org says its time: a removal reads the run's last
 * write against the dates the org gave its records, and dated when it was
 * read back, a job's records changed since the run would have read as
 * unchanged.
 *
 * @param serverTime - The org's clock now, when it can be read: asked once.
 * @param now - This machine's clock.
 * @returns What became of each job, in the order the run sent them.
 */
export async function answerJobsInFlight(
  store: InFlightAnswers,
  run: Pick<SyncRunKept, 'runId' | 'jobs' | 'lastWrittenAt'>,
  conn: IngestJobReading,
  serverTime?: () => Promise<string>,
  now: () => Date = () => new Date(),
): Promise<JobAnswered[]> {
  /** How far the org's clock stands ahead of this machine's, asked once; 0 untold. */
  let ahead: Promise<number> | undefined;
  const aheadOf = (): Promise<number> => {
    ahead ??= (async () => {
      if (!serverTime) return 0;
      try {
        const before = now().getTime();
        const orgNow = Date.parse(await serverTime());
        return Number.isFinite(orgNow) ? orgNow - (before + now().getTime()) / 2 : 0;
      } catch {
        // Untold: the org's date stands for this machine's, give or take the leeway.
        return 0;
      }
    })();
    return ahead;
  };
  const done: JobAnswered[] = [];
  for (const call of run.jobs ?? []) {
    if (call.job === undefined) continue;
    const said = { job: call.job, objectApiName: call.objectApiName };
    const read = await readJobCreated(conn, call.job, call.upsert === true, () => now().getTime());
    if (read.state === 'running' || read.state === 'unread') {
      done.push({ ...said, read, answered: false });
      continue;
    }
    let at = now().toISOString();
    if (read.state === 'ended' && read.at !== undefined && Number.isFinite(Date.parse(read.at))) {
      at = new Date(Date.parse(read.at) - (await aheadOf())).toISOString();
    } else if (run.lastWrittenAt !== undefined) {
      // A job never closed wrote nothing: the run last wrote when it said it did.
      at = run.lastWrittenAt;
    }
    const created = read.state === 'ended' ? read.created : [];
    const answered = await store.answerInFlight(
      run.runId,
      call.objectApiName,
      created,
      at,
      call.job,
    );
    done.push({ ...said, read, answered });
  }
  return done;
}

/**
 * What answering a run's jobs came to, as the lines the log keeps: one per
 * job, a job still running or not read said so, to be read again next time.
 *
 * @param context - What asked: the removal and its run.
 */
export function jobAnsweredLines(context: string, answered: readonly JobAnswered[]): string[] {
  return answered.map(({ job, read }) => {
    const of = `${context}, job ${job}`;
    switch (read.state) {
      case 'ended':
        return (
          `[INFO] ${of}: the job no line of the run answered ended in the org; ` +
          `${read.created.length} record(s) it created kept with the run`
        );
      case 'never-closed':
        return `[INFO] ${of}: the job was never closed, and wrote nothing`;
      case 'running':
        return `[INFO] ${of}: the job is still running in the org; read again later`;
      default:
        return `[WARN] ${of}: the job could not be read back: ${read.reason}`;
    }
  });
}
