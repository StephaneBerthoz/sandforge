/**
 * The Bulk API job a run had under way when its window closed, read back from
 * the org by its id.
 *
 * A job goes on to its end on the org's side once it is closed, whatever
 * becomes of the window that sent it: a seed of thousands of contacts whose
 * window closed while its job ran left them all in the org, and its run file
 * named the call and none of its records — the removal took what the earlier
 * calls created and left the job's. The run keeps the job's id as soon as the
 * org has opened it (`SyncCreationRecorder.sending`), and the job's successful
 * results name every record it wrote, with whether it created it
 * (`sf__Created`), for as long as the org keeps the job: seven days.
 *
 * Read only, but for a job the org never processed: one left open — the
 * window closed before it was closed — is aborted, so that nothing closes it
 * later, and it wrote nothing.
 */

import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import type { SyncRunKept } from './SyncRunCreations.js';

/** A Salesforce id, as every id read back is: they end up in deletes. */
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** How an ingest job is reached by its id: the part of a jsforce connection this reads. */
export interface IngestJobReading {
  bulk2: {
    job(
      type: 'ingest',
      options: { id: string },
    ): {
      check(): Promise<{ state: string; systemModstamp?: string }>;
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
 */
export async function readJobCreated(
  conn: IngestJobReading,
  jobId: string,
  upsert: boolean,
): Promise<JobCreatedRead> {
  try {
    const job = conn.bulk2.job('ingest', { id: jobId });
    const info = await job.check();
    if (info.state === 'Open') {
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
  ): Promise<boolean>;
}

/** What answering a run's job under way did. */
export interface JobAnswered {
  /** The job's state, as read; nothing when the run had no job under way. */
  read?: JobCreatedRead;
  /** Whether the run's file now holds the job's answer. */
  answered: boolean;
}

/**
 * Answer the Bulk API job a run left under way, when it left one and no
 * window writes the run any more: read back by its id, its records go into
 * the run's file as its answer would have, and the run is listed with them
 * and removed with them. A job still running is left under way, and read
 * again at the next listing; one the org cannot be asked about is said.
 *
 * Dated by the org's own date of the job — when it last changed state, its
 * records all written by then — set to this machine's clock as the run's
 * lines are, once the org says its time: a removal reads the run's last
 * write against the dates the org gave its records, and dated when it was
 * read back, a job's records changed since the run would have read as
 * unchanged.
 *
 * @param serverTime - The org's clock now, when it can be read.
 * @param now - This machine's clock.
 */
export async function answerJobInFlight(
  store: InFlightAnswers,
  run: Pick<SyncRunKept, 'runId' | 'end' | 'inFlight' | 'lastWrittenAt'>,
  conn: IngestJobReading,
  serverTime?: () => Promise<string>,
  now: () => Date = () => new Date(),
): Promise<JobAnswered> {
  const call = run.inFlight;
  if (run.end || !call?.job) return { answered: false };
  const read = await readJobCreated(conn, call.job, call.upsert === true);
  if (read.state === 'running' || read.state === 'unread') return { read, answered: false };
  let at = now().toISOString();
  if (read.state === 'ended' && read.at !== undefined && Number.isFinite(Date.parse(read.at))) {
    let ahead = 0;
    if (serverTime) {
      try {
        const before = now().getTime();
        const orgNow = Date.parse(await serverTime());
        if (Number.isFinite(orgNow)) ahead = orgNow - (before + now().getTime()) / 2;
      } catch {
        // Untold: the org's date stands for this machine's, give or take the leeway.
      }
    }
    at = new Date(Date.parse(read.at) - ahead).toISOString();
  } else if (run.lastWrittenAt !== undefined) {
    // A job never closed wrote nothing: the run last wrote when it said it did.
    at = run.lastWrittenAt;
  }
  const created = read.state === 'ended' ? read.created : [];
  const answered = await store.answerInFlight(run.runId, call.objectApiName, created, at);
  return { read, answered };
}
