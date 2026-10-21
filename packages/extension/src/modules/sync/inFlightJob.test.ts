import { describe, it, expect, vi } from 'vitest';
import {
  answerJobInFlight,
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
  options: { systemModstamp?: string; unreadable?: boolean } = {},
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
    answerInFlight: async (runId, objectApiName, ids, at) => {
      added.push({ runId, objectApiName, ids: [...ids], at });
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

  it('says why a job could not be read back, rather than reading it as one that wrote nothing', async () => {
    const { conn } = orgWithJob('JobComplete', [], { unreadable: true });

    expect(await readJobCreated(conn, JOB, false)).toEqual({
      state: 'unread',
      reason: 'INVALIDJOB: Unable to find object',
    });
  });
});

describe('answerJobInFlight', () => {
  const run = {
    runId: 'op-1',
    lastWrittenAt: '2026-10-17T10:00:00.000Z',
    inFlight: { objectApiName: 'Contact', rows: 2, at: '2026-10-17T10:00:01.000Z', job: JOB },
  };

  it('answers the job with what it created, dated by the org when it ended, set to the clock of this machine', async () => {
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
    const done = await answerJobInFlight(
      store,
      run,
      conn,
      async () => '2026-10-17T11:00:30.000Z',
      now,
    );

    expect(done.answered).toBe(true);
    expect(store.added).toEqual([
      {
        runId: 'op-1',
        objectApiName: 'Contact',
        ids: [fakeId('003', 1), fakeId('003', 2)],
        at: '2026-10-17T10:05:00.000Z',
      },
    ]);
  });

  it('answers a job never closed with nothing, and leaves a running or unreadable one under way', async () => {
    const closed = answers();
    await answerJobInFlight(closed, run, orgWithJob('Open').conn);
    expect(closed.added).toEqual([
      { runId: 'op-1', objectApiName: 'Contact', ids: [], at: '2026-10-17T10:00:00.000Z' },
    ]);

    const running = answers();
    const stillRunning = await answerJobInFlight(running, run, orgWithJob('InProgress').conn);
    expect(stillRunning).toEqual({ read: { state: 'running' }, answered: false });
    const unread = answers();
    const notRead = await answerJobInFlight(
      unread,
      run,
      orgWithJob('JobComplete', [], { unreadable: true }).conn,
    );
    expect(notRead.answered).toBe(false);
    expect([...running.added, ...unread.added]).toEqual([]);
  });

  it('asks the org nothing for a run that ended, or whose call under way is no job', async () => {
    const { conn, asked } = orgWithJob('JobComplete');
    const store = answers();

    await answerJobInFlight(
      store,
      { ...run, end: { at: run.lastWrittenAt, status: 'partial' } },
      conn,
    );
    await answerJobInFlight(
      store,
      { ...run, inFlight: { objectApiName: 'Contact', rows: 200, at: run.lastWrittenAt } },
      conn,
    );

    expect(asked).toEqual([]);
    expect(store.added).toEqual([]);
  });

  it('reads an upsert job as one, only the rows it created kept', async () => {
    const { conn } = orgWithJob('JobComplete', [
      { sf__Id: fakeId('003', 1), sf__Created: 'false' },
      { sf__Id: fakeId('003', 2), sf__Created: 'true' },
    ]);
    const store = answers();

    await answerJobInFlight(store, { ...run, inFlight: { ...run.inFlight, upsert: true } }, conn);

    expect(store.added).toMatchObject([{ ids: [fakeId('003', 2)] }]);
  });
});
