/**
 * A Bulk API 2.0 ingest job read back from the org by its id: its state and,
 * once it has ended, its results.
 *
 * A job goes on to its end on the org's side once it is closed, whatever
 * becomes of the window, or the call, that sent it. Sync and Seed read back
 * the jobs a closed window left unanswered (`readJobCreated`); Forge reads
 * back a job whose state could not be read while it ran, so its rows are
 * answered by what the org did with them rather than sent again on a guess.
 * Both read it here, alike.
 *
 * Read only, but for a job the org never processed: one left open — its
 * sender stopped before it was closed — is aborted, so that nothing closes it
 * later, and it wrote nothing. Never one opened less than
 * {@link OPEN_JOB_GRACE_MS} ago, unless its caller knows it sent it: a job
 * stays open for the whole of its upload, and a second window that listed the
 * run during it aborted the first window's job, whose records were then never
 * written.
 */

import * as z from 'zod';
import { extractErrorMessage } from '../common/extractErrorMessage.js';
import type { JsforceIngestJobResults } from './BulkApiExecutor.js';

/**
 * How long a job left open is taken for one still being uploaded: an hour.
 * Its window uploads a job's rows right after the org opens it, and closes
 * it once they are all sent; a job open longer than this was left so.
 */
const OPEN_JOB_GRACE_MS = 60 * 60_000;

/**
 * What the org says of an ingest job read by its id, the part read here: the
 * states the Bulk API 2.0 gives an ingest job, and no other. An answer that
 * names none of them is not read as any — not as ended, which would read its
 * results as all it wrote, nor as never closed, which would say it wrote
 * nothing.
 */
const ingestJobInfoSchema = z.object({
  state: z.enum(['Open', 'UploadComplete', 'InProgress', 'JobComplete', 'Failed', 'Aborted']),
  /** Rows the org processed so far, written or refused. */
  numberRecordsProcessed: z.number().int().nonnegative().optional(),
  /** Why the job failed, as the org says it. */
  errorMessage: z.string().nullish(),
  systemModstamp: z.string().optional(),
  createdDate: z.string().optional(),
});

/** What the org says of an ingest job read by its id: the part read here. */
export type IngestJobInfo = z.infer<typeof ingestJobInfoSchema>;

/**
 * The org's answer to a read of a job's state, held to {@link IngestJobInfo}.
 *
 * @throws Error naming the job when the answer is not one of a job's states.
 */
export function ingestJobInfoOf(jobId: string, answer: unknown): IngestJobInfo {
  const parsed = ingestJobInfoSchema.safeParse(answer);
  if (parsed.success) return parsed.data;
  const said =
    typeof answer === 'object' && answer !== null && 'state' in answer
      ? String(JSON.stringify(answer.state))
      : 'none';
  throw new Error(
    `The org's answer about Bulk API job ${jobId || '(no id)'} is not an ingest job's state (state: ${said})`,
  );
}

/**
 * What a read of a job's state answers, as jsforce hands it on: the org's
 * JSON, held to {@link IngestJobInfo} only once read here.
 */
interface IngestJobAnswer {
  state: string;
  systemModstamp?: string;
  createdDate?: string;
  errorMessage?: string | null;
  numberRecordsProcessed?: number;
}

/** How an ingest job is reached by its id: the part of a jsforce connection Sync and Seed read. */
export interface IngestJobReading {
  bulk2: {
    job(
      type: 'ingest',
      options: { id: string },
    ): {
      check(): Promise<IngestJobAnswer>;
      getSuccessfulResults(): Promise<ReadonlyArray<Record<string, unknown>>>;
      abort(): Promise<unknown>;
    };
  };
}

/**
 * How an ingest job is reached by its id with every one of its results: its
 * successful, failed and unprocessed records, read three ways
 * (`getAllResults`), as jsforce reads them.
 */
export interface IngestJobResultsReading extends IngestJobReading {
  bulk2: {
    job(
      type: 'ingest',
      options: { id: string },
    ): ReturnType<IngestJobReading['bulk2']['job']> & {
      getAllResults(): Promise<JsforceIngestJobResults>;
    };
  };
}

/** What a job read back by its id says. */
export type JobResultsRead =
  /** It ended — complete, failed, or aborted once it ran: what the org says of it, and its results. */
  | { state: 'ended'; info: IngestJobInfo; results: JsforceIngestJobResults }
  /** The org is still processing it, or its sender may still be uploading it. */
  | { state: 'running' }
  /** It was never closed, and wrote nothing: aborted now. */
  | { state: 'never-closed' }
  /** The org could not be asked, no longer holds the job, or answered no state of one. */
  | { state: 'unread'; reason: string };

/** How a job is read back. */
interface ReadOptions {
  /** This machine's clock, in epoch milliseconds. */
  now?: () => number;
  /**
   * How long a job left open is taken for one still being uploaded; an hour
   * unless told. A caller that sent the job itself and knows it stopped
   * uploading it passes 0: open, the job was never closed, and is aborted.
   */
  openGraceMs?: number;
}

/**
 * Read a job back by its id: its state and, once it has ended, every one of
 * its results — successful, failed and unprocessed.
 *
 * With `successfulOnly`, only its successful results are read, one call where
 * every result takes three: all the records a job wrote are there, and a
 * caller that wants only those reads nothing more.
 */
export function readJobResults(
  conn: IngestJobResultsReading,
  jobId: string,
  options?: ReadOptions,
): Promise<JobResultsRead>;
export function readJobResults(
  conn: IngestJobReading,
  jobId: string,
  options: ReadOptions & { successfulOnly: true },
): Promise<JobResultsRead>;
export async function readJobResults(
  conn: IngestJobReading | IngestJobResultsReading,
  jobId: string,
  options: ReadOptions & { successfulOnly?: true } = {},
): Promise<JobResultsRead> {
  const now = options.now ?? (() => Date.now());
  try {
    // Every result is read only of a connection that reads them: the
    // overloads hold a caller that does not to `successfulOnly`.
    const job: ReturnType<IngestJobReading['bulk2']['job']> &
      Partial<Pick<ReturnType<IngestJobResultsReading['bulk2']['job']>, 'getAllResults'>> =
      conn.bulk2.job('ingest', { id: jobId });
    let info = ingestJobInfoOf(jobId, await job.check());
    if (info.state === 'Open') {
      // Opened lately: its window may be uploading it still. Read again later.
      const opened = Date.parse(info.createdDate ?? '');
      const grace = options.openGraceMs ?? OPEN_JOB_GRACE_MS;
      if (Number.isFinite(opened) && now() - opened < grace) {
        return { state: 'running' };
      }
      // Never closed: the org never processes it, and nothing closes it now.
      const refused = await job.abort().then(
        () => false,
        () => true,
      );
      // Unless a close was on its way: a caller that reads back, with no
      // grace, the job whose close it sent and lost may find it open in the
      // instant before the org takes that close, and abort it after. The
      // abort is then refused — the job is no longer open — or comes once the
      // org has begun processing it, and the job writes rows all the same.
      // So, refused or with no grace, the job is read again: never closed
      // only if it is still open or was aborted before it processed a row;
      // otherwise read for what it is now, running or ended. A job past its
      // hour of grace, aborted, is not read again: no close of its window is
      // on its way an hour on.
      if (!refused && grace > 0) return { state: 'never-closed' };
      info = ingestJobInfoOf(jobId, await job.check());
      if (
        info.state === 'Open' ||
        (info.state === 'Aborted' && info.numberRecordsProcessed === 0)
      ) {
        return { state: 'never-closed' };
      }
    }
    if (info.state === 'UploadComplete' || info.state === 'InProgress') return { state: 'running' };
    // Ended — complete, failed, or aborted once it ran: what it wrote is in
    // its successful results all the same.
    if (options.successfulOnly) {
      return {
        state: 'ended',
        info,
        results: { successfulResults: [...(await job.getSuccessfulResults())] },
      };
    }
    if (job.getAllResults === undefined) {
      throw new Error(`Bulk API job ${jobId}: this connection reads no failed or unprocessed rows`);
    }
    return { state: 'ended', info, results: await job.getAllResults() };
  } catch (err: unknown) {
    return { state: 'unread', reason: extractErrorMessage(err) };
  }
}
