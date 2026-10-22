import { describe, it, expect, vi } from 'vitest';
import {
  answerJobsInFlight,
  jobAnsweredLines,
  readJobCreated,
  type IngestJobReading,
  type InFlightAnswers,
} from './inFlightJob';

const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;
const JOB = fakeId('750', 1);

/** An org holding one ingest job, in `state`, whose successful results are `rows`. */
function orgWithJob(
  state: string,
  rows: Array<Record<string, unknown>> = [],
  options: { systemModstamp?: string; unreadable?: boolean; createdDate?: string } = {},
) {
  const asked: string[] = [];
  const abort = vi.fn(async () => undefined);
  const conn: IngestJobReading = {
    bulk2: {
      job: (type, { id }) => {
        asked.push(`${type} ${id}`);
        return {
          check: async () => {
            if (options.unreadable) throw new Error('INVALIDJOB: Unable to find object');
            return {
              state,
              ...(options.systemModstamp ? { systemModstamp: options.systemModstamp } : {}),
              ...(options.createdDate ? { createdDate: options.createdDate } : {}),
            };
          },
          getSuccessfulResults: async () => rows,
          abort,
        };
      },
    },
  };
  return { conn, asked, abort };
}

/** A run file's store, recording what it is told to add. */
function answers(): InFlightAnswers & { added: unknown[] } {
  const added: unknown[] = [];
  return {
    added,
    answerInFlight: async (runId, objectApiName, ids, at, job) => {
      added.push({ runId, objectApiName, ids: [...ids], at, ...(job ? { job } : {}) });
      return true;
    },
  };
}

describe('readJobCreated', () => {
  it('reads every record an insert job wrote from its successful results, by the job id', async () => {
    const { conn, asked } = orgWithJob('JobComplete', [
      { sf__Id: fakeId('003', 1), sf__Created: 'true', LastName: 'A' },
      { sf__Id: fakeId('003', 2), sf__Created: 'true', LastName: 'B' },
      { sf__Id: 'not an id', sf__Created: 'true' },
    ]);

    const read = await readJobCreated(conn, JOB, false);

    expect(asked).toEqual([`ingest ${JOB}`]);
    expect(read).toEqual({ state: 'ended', created: [fakeId('003', 1), fakeId('003', 2)] });
  });

  it('keeps of an upsert job the rows the org says it created, never one it updated or does not say of', async () => {
    const { conn } = orgWithJob('JobComplete', [
      { sf__Id: fakeId('003', 1), sf__Created: 'true' },
      { sf__Id: fakeId('003', 2), sf__Created: 'false' },
      { sf__Id: fakeId('003', 3) },
    ]);

    expect(await readJobCreated(conn, JOB, true)).toEqual({
      state: 'ended',
      created: [fakeId('003', 1)],
    });
  });

  it('reads what a job that failed or was aborted once it ran wrote all the same', async () => {
    for (const state of ['Failed', 'Aborted']) {
      const { conn } = orgWithJob(state, [{ sf__Id: fakeId('001', 1), sf__Created: 'true' }], {
        systemModstamp: '2026-10-17T10:05:00.000Z',
      });
      expect(await readJobCreated(conn, JOB, false)).toEqual({
        state: 'ended',
        created: [fakeId('001', 1)],
        at: '2026-10-17T10:05:00.000Z',
      });
    }
  });

  it('says a job the org still processes is running, its records not read yet', async () => {
    for (const state of ['UploadComplete', 'InProgress']) {
      const { conn } = orgWithJob(state);
      expect(await readJobCreated(conn, JOB, false)).toEqual({ state: 'running' });
    }
  });

  it('aborts a job left open, which the org never processes and nothing closes any more', async () => {
    const { conn, abort } = orgWithJob('Open');

    expect(await readJobCreated(conn, JOB, false)).toEqual({ state: 'never-closed' });
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('never aborts a job opened less than an hour ago: its window may be uploading it still', async () => {
    const now = Date.parse('2026-10-22T12:00:00.000Z');
    const opened = orgWithJob('Open', [], { createdDate: '2026-10-22T11:58:00.000+0000' });

    expect(await readJobCreated(opened.conn, JOB, false, () => now)).toEqual({ state: 'running' });
    expect(opened.abort).not.toHaveBeenCalled();

    const left = orgWithJob('Open', [], { createdDate: '2026-10-22T10:30:00.000+0000' });
    expect(await readJobCreated(left.conn, JOB, false, () => now)).toEqual({
      state: 'never-closed',
    });
    expect(left.abort).toHaveBeenCalledTimes(1);
  });

  it('says why a job could not be read back, rather than reading it as one that wrote nothing', async () => {
    const { conn } = orgWithJob('JobComplete', [], { unreadable: true });

    expect(await readJobCreated(conn, JOB, false)).toEqual({
      state: 'unread',
      reason: 'INVALIDJOB: Unable to find object',
    });
  });
});

describe('answerJobsInFlight', () => {
  const call = { objectApiName: 'Contact', rows: 2, at: '2026-10-17T10:00:01.000Z', job: JOB };
  const run = {
    runId: 'op-1',
    lastWrittenAt: '2026-10-17T10:00:00.000Z',
    jobs: [call],
  };

  it('answers the job with what it created, naming it, dated by the org when it ended, set to the clock of this machine', async () => {
    const { conn } = orgWithJob(
      'JobComplete',
      [
        { sf__Id: fakeId('003', 1), sf__Created: 'true' },
        { sf__Id: fakeId('003', 2), sf__Created: 'true' },
      ],
      { systemModstamp: '2026-10-17T10:05:30.000Z' },
    );
    const store = answers();
    const now = () => new Date('2026-10-17T11:00:00.000Z');

    // The org's clock 30 seconds ahead of this machine's.
    const done = await answerJobsInFlight(
      store,
      run,
      conn,
      async () => '2026-10-17T11:00:30.000Z',
      now,
    );

    expect(done).toEqual([
      {
        job: JOB,
        objectApiName: 'Contact',
        read: expect.objectContaining({ state: 'ended' }),
        answered: true,
      },
    ]);
    expect(store.added).toEqual([
      {
        runId: 'op-1',
        objectApiName: 'Contact',
        ids: [fakeId('003', 1), fakeId('003', 2)],
        at: '2026-10-17T10:05:00.000Z',
        job: JOB,
      },
    ]);
  });

  it('answers the job of a run that ended: a write that failed once the org opened its job ends the run', async () => {
    const { conn, asked } = orgWithJob('Failed', [
      { sf__Id: fakeId('003', 1), sf__Created: 'true' },
    ]);
    const store = answers();

    const done = await answerJobsInFlight(
      store,
      { ...run, end: { at: run.lastWrittenAt, status: 'failure' } } as typeof run,
      conn,
    );

    expect(asked).toEqual([`ingest ${JOB}`]);
    expect(done.map((job) => job.answered)).toEqual([true]);
    expect(store.added).toMatchObject([{ ids: [fakeId('003', 1)], job: JOB }]);
  });

  it('answers each of several jobs, asking the org its clock once', async () => {
    const second = fakeId('750', 2);
    const states: Record<string, string> = { [JOB]: 'JobComplete', [second]: 'InProgress' };
    const conn: IngestJobReading = {
      bulk2: {
        job: (_type, { id }) => ({
          check: async () => ({ state: states[id], systemModstamp: '2026-10-17T10:05:30.000Z' }),
          getSuccessfulResults: async () => [{ sf__Id: fakeId('003', 1), sf__Created: 'true' }],
          abort: async () => undefined,
        }),
      },
    };
    const serverTime = vi.fn(async () => '2026-10-17T11:00:00.000Z');
    const store = answers();

    const done = await answerJobsInFlight(
      store,
      { ...run, jobs: [call, { ...call, objectApiName: 'Lead', job: second }] },
      conn,
      serverTime,
    );

    expect(done.map(({ job, read, answered }) => [job, read.state, answered])).toEqual([
      [JOB, 'ended', true],
      [second, 'running', false],
    ]);
    expect(serverTime).toHaveBeenCalledTimes(1);
  });

  it('answers a job never closed with nothing, and leaves a running or unreadable one unanswered', async () => {
    const closed = answers();
    await answerJobsInFlight(closed, run, orgWithJob('Open').conn);
    expect(closed.added).toEqual([
      {
        runId: 'op-1',
        objectApiName: 'Contact',
        ids: [],
        at: '2026-10-17T10:00:00.000Z',
        job: JOB,
      },
    ]);

    const running = answers();
    const stillRunning = await answerJobsInFlight(running, run, orgWithJob('InProgress').conn);
    expect(stillRunning).toEqual([
      { job: JOB, objectApiName: 'Contact', read: { state: 'running' }, answered: false },
    ]);
    const unread = answers();
    const notRead = await answerJobsInFlight(
      unread,
      run,
      orgWithJob('JobComplete', [], { unreadable: true }).conn,
    );
    expect(notRead.map((job) => job.answered)).toEqual([false]);
    expect([...running.added, ...unread.added]).toEqual([]);
  });

  it('asks the org nothing for a run whose file names no job left unanswered', async () => {
    const { conn, asked } = orgWithJob('JobComplete');
    const store = answers();

    expect(await answerJobsInFlight(store, { ...run, jobs: undefined }, conn)).toEqual([]);
    expect(await answerJobsInFlight(store, { ...run, jobs: [] }, conn)).toEqual([]);

    expect(asked).toEqual([]);
    expect(store.added).toEqual([]);
  });

  it('reads an upsert job as one, only the rows it created kept', async () => {
    const { conn } = orgWithJob('JobComplete', [
      { sf__Id: fakeId('003', 1), sf__Created: 'false' },
      { sf__Id: fakeId('003', 2), sf__Created: 'true' },
    ]);
    const store = answers();

    await answerJobsInFlight(store, { ...run, jobs: [{ ...call, upsert: true }] }, conn);

    expect(store.added).toMatchObject([{ ids: [fakeId('003', 2)] }]);
  });
});

describe('jobAnsweredLines', () => {
  it('says what became of each job, a job still running or unread said so', () => {
    expect(
      jobAnsweredLines('sync:removal of op-1', [
        {
          job: JOB,
          objectApiName: 'Contact',
          read: { state: 'ended', created: [fakeId('003', 1)] },
          answered: true,
        },
        { job: JOB, objectApiName: 'Contact', read: { state: 'never-closed' }, answered: true },
        { job: JOB, objectApiName: 'Contact', read: { state: 'running' }, answered: false },
        {
          job: JOB,
          objectApiName: 'Contact',
          read: { state: 'unread', reason: 'INVALIDJOB' },
          answered: false,
        },
      ]),
    ).toEqual([
      `[INFO] sync:removal of op-1, job ${JOB}: the job no line of the run answered ended in the org; 1 record(s) it created kept with the run`,
      `[INFO] sync:removal of op-1, job ${JOB}: the job was never closed, and wrote nothing`,
      `[INFO] sync:removal of op-1, job ${JOB}: the job is still running in the org; read again later`,
      `[WARN] sync:removal of op-1, job ${JOB}: the job could not be read back: INVALIDJOB`,
    ]);
  });
});
