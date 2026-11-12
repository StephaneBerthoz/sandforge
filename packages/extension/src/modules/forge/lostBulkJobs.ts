/**
 * The Bulk API jobs a run closed and lost — the org may be writing them still
 * — kept for the end of the run, which is to wait for them before it gives
 * back the mute of the target's automation.
 *
 * A job the run closed goes on to its end on the org's side whatever becomes
 * of the call that sent it. When its state could not be read back after its
 * close (`BulkJobLostError`: the org answered nothing, or the job was still
 * running after the reads `forgeBulkWrite` gives it), the run counts its rows
 * as may have been written and goes on — and the org may still be writing
 * them as the run ends. A run that muted the target's automation and gave the
 * mute back at once, in its `finally`, would let the rows such a job wrote
 * after that go in with every flow, trigger and rule the mute was asked to
 * keep quiet.
 *
 * So each of those jobs is read again by its id, with Forge's growing waits,
 * until the org says it ended — complete, failed or aborted — and only then
 * may the mute go back; bounded, so that a job the org never ends cannot hold
 * the user's permission sets for ever: past {@link LOST_JOBS_WAIT_MS}, the
 * jobs still running are given back, to be named as such, their rows perhaps
 * written without the mute.
 *
 * The jobs are noted where every job of the extension's runs is sent, the
 * composition's `bulkWriteRecords`, which outlives the runs: a run marks how
 * many were noted as it starts (`count`), and takes at its end those noted
 * since, of its own target (`since`). Runs of the panel write one at a time,
 * so those are the run's own.
 */

import { FORGE_BULK_POLL_SCHEDULE, type BulkPollSchedule } from '../../core/engine/bulkJobCost.js';
import { TimeoutManager } from '../../core/engine/TimeoutManager.js';

/** A Bulk API job a run closed and could not read back: which org, which object, which job. */
export interface LostBulkJob {
  /** The org the job writes to, as SandForge names it (the run's `targetOrgId`). */
  orgId: string;
  objectApiName: string;
  /** The id the org gave the job; absent when its close was sent before the org told it, which no read can reach. */
  jobId?: string;
}

/**
 * How long the jobs a run lost are waited for before the mute is given back
 * all the same: ten minutes. A job of ten thousand rows ends in well under
 * one once the org takes it; one still running ten minutes after the run
 * read it for the last time waits behind other jobs of the org, or is held
 * by it, and the user's permission sets are not held for it.
 */
export const LOST_JOBS_WAIT_MS = 10 * 60_000;

/**
 * How long one read of a lost job is waited for, at most, before it counts as
 * unanswered and its job as still running, read again at the next turn: a
 * read of a job's state is one small request, answered in well under a
 * second, and one the org holds open is not let take the rest of the wait.
 */
const LOST_JOB_READ_TIMEOUT_MS = 30_000;

/**
 * The least time a read is sent with before the bound of the wait: less than
 * this left, the wait ends rather than send a read the bound would cut short.
 */
const LOST_JOB_READ_ROOM_MS = 5_000;

/**
 * The most lost jobs kept at once: a run loses one in a rare while, and the
 * oldest, of runs long ended, are dropped past this.
 */
const LOST_JOBS_KEPT = 500;

/** The states a job ends in, as the org reads them: it writes nothing more after. */
const ENDED_STATES: ReadonlySet<string> = new Set(['JobComplete', 'Failed', 'Aborted']);

/** How the jobs are waited for: the real clock and Forge's waits, unless told. */
export interface LostBulkJobsOptions {
  /** How long the jobs are waited for, at most; {@link LOST_JOBS_WAIT_MS} unless told. */
  waitMs?: number;
  /** How long between two reads of the jobs; Forge's growing waits unless told. */
  pollDelay?: BulkPollSchedule;
  /** Waits `ms` milliseconds. */
  sleep?: (ms: number) => Promise<void>;
  /** This machine's clock, in epoch milliseconds. */
  now?: () => number;
}

/** The Bulk API jobs the runs closed and lost, and how one is read again by its id. */
export class LostBulkJobs {
  private readonly kept: Array<{ seq: number; job: LostBulkJob }> = [];
  private noted = 0;

  /**
   * @param stateOf - Reads the job `jobId` of `orgId` by its id: the state
   *   the org says it is in (`Open`, `UploadComplete`, `InProgress`,
   *   `JobComplete`, `Failed`, `Aborted`). One request of the org's day.
   */
  constructor(
    private readonly stateOf: (orgId: string, jobId: string) => Promise<string>,
    private readonly options: LostBulkJobsOptions = {},
  ) {}

  /** How many jobs were noted so far: what a run marks as it starts. */
  get count(): number {
    return this.noted;
  }

  /** Keep `job`, closed and lost by a run under way. */
  note(job: LostBulkJob): void {
    this.noted++;
    this.kept.push({ seq: this.noted, job: { ...job } });
    if (this.kept.length > LOST_JOBS_KEPT) this.kept.splice(0, this.kept.length - LOST_JOBS_KEPT);
  }

  /** The jobs of `orgId` noted after `mark` (a {@link count} read before), in the order they were. */
  since(mark: number, orgId: string): LostBulkJob[] {
    return this.kept
      .filter(({ seq, job }) => seq > mark && job.orgId === orgId)
      .map(({ job }) => ({ ...job }));
  }

  /**
   * Read `jobs` again by their ids until the org says each ended, waiting
   * between two reads as a job's state is waited for, for
   * {@link LostBulkJobsOptions.waitMs} at most: the jobs still not seen
   * ended then. Never past that bound, whatever the org answers: each read
   * is cut at what is left of it, and at thirty seconds. A read the org does
   * not answer in time, or refuses, leaves its job among them, read again at
   * the next turn; a job without an id cannot be read and is always one of
   * them.
   *
   * @param onRead - Told of each read sent: one request of the org's day.
   */
  async stillRunning(jobs: readonly LostBulkJob[], onRead?: () => void): Promise<LostBulkJob[]> {
    const now = this.options.now ?? (() => Date.now());
    const sleep =
      this.options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const pollDelay = this.options.pollDelay ?? FORGE_BULK_POLL_SCHEDULE;
    const deadline = now() + (this.options.waitMs ?? LOST_JOBS_WAIT_MS);
    const unreadable = jobs.filter((job) => job.jobId === undefined);
    let pending = jobs.filter((job): job is LostBulkJob & { jobId: string } => !!job.jobId);
    for (let attempt = 0; pending.length > 0; attempt++) {
      // Each read raced against what is left of the wait, and a read's own
      // bound: jsforce sets no timeout of its own, and an org that took the
      // connection and never answered would hold the mute — the user's
      // permission sets — past the bound, for as long as the socket stayed
      // open.
      const timeout = new TimeoutManager(
        Math.max(1, Math.min(LOST_JOB_READ_TIMEOUT_MS, deadline - now())),
      );
      const read = await Promise.all(
        pending.map(async (job) => {
          onRead?.();
          const state = await timeout
            .withTimeout('forge:lost-bulk-job', () => this.stateOf(job.orgId, job.jobId))
            .catch(() => undefined);
          return state !== undefined && ENDED_STATES.has(state) ? undefined : job;
        }),
      );
      pending = read.filter((job) => job !== undefined);
      // The last wait leaves the next read its room before the bound: cut to
      // the bound itself, it would leave that read no time to be answered in.
      const left = deadline - now() - LOST_JOB_READ_ROOM_MS;
      if (pending.length === 0 || left <= 0) break;
      await sleep(Math.min(pollDelay(attempt), left));
    }
    return [...unreadable, ...pending];
  }
}
