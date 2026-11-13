import { describe, it, expect } from 'vitest';
import {
  LOST_JOBS_WAIT_MS,
  LostBulkJobs,
  pastMuteNotes,
  type LostBulkJob,
} from './lostBulkJobs.js';

/*
 * The jobs a run closed and lost, waited for at its end before it gives back
 * the mute of the target's automation: what the org wrote of them after the
 * mute was given back went in with every flow and trigger it kept quiet.
 */

/** A clock that moves only when the jobs are waited for, and the waits it was asked. */
function fakeClock() {
  let at = 0;
  const waits: number[] = [];
  return {
    waits,
    now: () => at,
    sleep: async (ms: number) => {
      waits.push(ms);
      at += ms;
    },
  };
}

/** A reader answering, for each job, its states one read after another, the last for good. */
function statesOf(states: Record<string, Array<string | Error>>) {
  const reads: string[] = [];
  const stateOf = async (orgId: string, jobId: string): Promise<string> => {
    reads.push(`${orgId}/${jobId}`);
    const left = states[jobId] ?? [];
    const next = left.length > 1 ? left.shift() : left[0];
    if (next === undefined) throw new Error(`no job ${jobId}`);
    if (next instanceof Error) throw next;
    return next;
  };
  return { reads, stateOf };
}

const JOB_A: LostBulkJob = { orgId: 'tgt-org', objectApiName: 'Contact', jobId: '750A' };
const JOB_B: LostBulkJob = { orgId: 'tgt-org', objectApiName: 'Case', jobId: '750B' };

describe('LostBulkJobs', () => {
  it('gives the jobs noted since a mark, of one org, in the order they were noted', () => {
    const jobs = new LostBulkJobs(async () => 'JobComplete');
    jobs.note({ ...JOB_A, jobId: '750OLD' });
    const mark = jobs.count;
    jobs.note(JOB_A);
    jobs.note({ orgId: 'other-org', objectApiName: 'Account', jobId: '750C' });
    jobs.note(JOB_B);

    expect(mark).toBe(1);
    expect(jobs.count).toBe(4);
    expect(jobs.since(mark, 'tgt-org')).toEqual([JOB_A, JOB_B]);
    expect(jobs.since(jobs.count, 'tgt-org')).toEqual([]);
  });

  it('reads each job again, with the growing waits, until the org says it ended', async () => {
    const clock = fakeClock();
    const { reads, stateOf } = statesOf({
      '750A': ['InProgress', 'InProgress', 'JobComplete'],
      '750B': ['UploadComplete', 'Failed'],
    });
    const jobs = new LostBulkJobs(stateOf, clock);
    let requests = 0;

    const running = await jobs.stillRunning([JOB_A, JOB_B], () => requests++);

    expect(running).toEqual([]);
    expect(reads).toEqual([
      'tgt-org/750A',
      'tgt-org/750B',
      'tgt-org/750A',
      'tgt-org/750B',
      'tgt-org/750A',
    ]);
    expect(requests).toBe(5);
    expect(clock.waits).toEqual([5_000, 10_000]);
  });

  it('takes an aborted job for ended, and reads again a job whose read the org did not answer', async () => {
    const clock = fakeClock();
    const { reads, stateOf } = statesOf({
      '750A': [new Error('socket hang up'), 'Aborted'],
    });

    const running = await new LostBulkJobs(stateOf, clock).stillRunning([JOB_A]);

    expect(running).toEqual([]);
    expect(reads).toHaveLength(2);
  });

  it('stops waiting past its bound, the jobs still running then given back', async () => {
    const clock = fakeClock();
    const { stateOf } = statesOf({ '750A': ['InProgress'], '750B': ['JobComplete'] });

    const running = await new LostBulkJobs(stateOf, clock).stillRunning([JOB_A, JOB_B]);

    expect(running).toEqual([JOB_A]);
    // Ten minutes, never more: the last wait is cut to leave the last read
    // its five seconds before the bound.
    expect(clock.waits.reduce((sum, ms) => sum + ms, 0)).toBe(LOST_JOBS_WAIT_MS - 5_000);
    expect(clock.now()).toBeLessThanOrEqual(LOST_JOBS_WAIT_MS);
    expect(Math.max(...clock.waits)).toBe(30_000);
  });

  it('stops at its bound when a read is never answered, the job still running then', async () => {
    // jsforce sets no timeout of its own: a read the org took and never
    // answered held the mute, and the user's permission sets, for ever.
    let reads = 0;
    const never = new LostBulkJobs(
      () => {
        reads++;
        return new Promise<string>(() => undefined);
      },
      { waitMs: 40 },
    );
    const started = Date.now();

    const running = await never.stillRunning([JOB_A]);

    expect(running).toEqual([JOB_A]);
    expect(reads).toBe(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('gives back at once a job whose id the org never told: no read reaches it', async () => {
    const clock = fakeClock();
    const { reads, stateOf } = statesOf({});
    const unnamed: LostBulkJob = { orgId: 'tgt-org', objectApiName: 'Contact' };

    const running = await new LostBulkJobs(stateOf, clock).stillRunning([unnamed]);

    expect(running).toEqual([unnamed]);
    expect(reads).toEqual([]);
    expect(clock.waits).toEqual([]);
  });
});

describe('pastMuteNotes', () => {
  it('names each job still running past the mute under its object, as a note that fails no row', () => {
    const notes = pastMuteNotes([
      { objectApiName: 'Account', jobId: '750000000000001AAA' },
      { objectApiName: 'Account' },
      { objectApiName: 'Contact', jobId: '750000000000002AAA' },
    ]);

    expect(
      notes.map(({ objectApiName, stage, failedCount }) => [objectApiName, stage, failedCount]),
    ).toEqual([
      ['Account', 'scope', 0],
      ['Contact', 'scope', 0],
    ]);
    expect(notes[0].samples.map((sample) => sample.recordSummary)).toEqual([
      'Bulk API job 750000000000001AAA',
      'Bulk API job (the org gave no id)',
    ]);
    expect(notes[0].samples[0].messages[0]).toContain('Bulk Data Load Jobs');
    expect(notes[0].samples[1].messages[0]).toContain('could not be waited for');
  });

  it('says nothing when no job ran past the mute', () => {
    expect(pastMuteNotes([])).toEqual([]);
  });
});
