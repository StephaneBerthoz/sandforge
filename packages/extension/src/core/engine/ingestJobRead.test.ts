import { describe, expect, it, vi } from 'vitest';

import type { JsforceIngestJobResults } from './BulkApiExecutor.js';
import { ingestJobInfoOf, readJobResults, type IngestJobResultsReading } from './ingestJobRead.js';

const JOB = '750000000000001AAA';

/** What the org answers a read of a job's state with: its JSON, as jsforce hands it on. */
interface JobAnswer {
  state: string;
  numberRecordsProcessed?: number;
  errorMessage?: string | null;
  createdDate?: string;
  systemModstamp?: string;
}

/**
 * An org holding one ingest job, in the state `info` says — or, given several,
 * in each in turn, one a read, the last one kept — whose results are `results`.
 * Its results are read as jsforce reads them, three ways: its successful,
 * failed and unprocessed records, each a call of its own (`asked`).
 */
function orgWithJob(
  info: JobAnswer | JobAnswer[],
  results: JsforceIngestJobResults = {},
  options: { unreadable?: boolean; resultsUnreadable?: boolean } = {},
) {
  const asked: string[] = [];
  const states = Array.isArray(info) ? [...info] : [info];
  const check = vi.fn(async (): Promise<JobAnswer> => {
    if (options.unreadable) throw new Error('INVALIDJOB: Unable to find object');
    return (states.length > 1 ? states.shift() : states[0]) ?? { state: 'JobComplete' };
  });
  const abort = vi.fn(async () => undefined);
  /** One of the job's three result endpoints. */
  const endpoint = async <T>(path: string, rows: T): Promise<T> => {
    asked.push(`GET ${JOB}/${path}`);
    if (options.resultsUnreadable) throw new Error('socket hang up');
    return rows;
  };
  const getSuccessfulResults = vi.fn(() =>
    endpoint('successfulResults', results.successfulResults ?? []),
  );
  const getAllResults = vi.fn(async (): Promise<JsforceIngestJobResults> => {
    const [successfulResults, failedResults, unprocessedRecords] = await Promise.all([
      getSuccessfulResults(),
      endpoint('failedResults', results.failedResults ?? []),
      endpoint('unprocessedrecords', results.unprocessedRecords ?? []),
    ]);
    return { successfulResults, failedResults, unprocessedRecords };
  });
  const conn: IngestJobResultsReading = {
    bulk2: {
      job: (type, { id }) => {
        asked.push(`${type} ${id}`);
        return { check, getSuccessfulResults, getAllResults, abort };
      },
    },
  };
  return { conn, asked, check, abort, getAllResults, getSuccessfulResults };
}

describe('readJobResults', () => {
  it('reads every result of a job that ended, by its id, three ways, with what the org says of it', async () => {
    const results = {
      successfulResults: [{ sf__Id: '003000000000001AAA', sf__Created: 'true', LastName: 'A' }],
      failedResults: [
        { sf__Id: '', sf__Error: 'REQUIRED_FIELD_MISSING:x:LastName --', LastName: '' },
      ],
      unprocessedRecords: [{ LastName: 'C' }],
    };
    const info = {
      state: 'JobComplete',
      numberRecordsProcessed: 2,
      systemModstamp: '2026-11-01T10:00:00.000+0000',
    };
    const { conn, asked, getAllResults } = orgWithJob(info, results);

    expect(await readJobResults(conn, JOB)).toEqual({ state: 'ended', info, results });
    expect(asked).toEqual([
      `ingest ${JOB}`,
      `GET ${JOB}/successfulResults`,
      `GET ${JOB}/failedResults`,
      `GET ${JOB}/unprocessedrecords`,
    ]);
    expect(getAllResults).toHaveBeenCalledTimes(1);
  });

  it('reads only the successful results when told, one call where every result takes three', async () => {
    const { conn, asked, getAllResults } = orgWithJob(
      { state: 'Failed', errorMessage: 'InvalidBatch', numberRecordsProcessed: 2 },
      {
        successfulResults: [{ sf__Id: '003000000000001AAA' }],
        failedResults: [{ sf__Error: 'x' }],
      },
    );

    expect(await readJobResults(conn, JOB, { successfulOnly: true })).toEqual({
      state: 'ended',
      info: { state: 'Failed', errorMessage: 'InvalidBatch', numberRecordsProcessed: 2 },
      results: { successfulResults: [{ sf__Id: '003000000000001AAA' }] },
    });
    expect(asked).toEqual([`ingest ${JOB}`, `GET ${JOB}/successfulResults`]);
    expect(getAllResults).not.toHaveBeenCalled();
  });

  it('says a job the org still processes is running, with what the org says of it, and reads none of its results', async () => {
    for (const state of ['UploadComplete', 'InProgress']) {
      const { conn, getAllResults } = orgWithJob({ state, numberRecordsProcessed: 800 });
      expect(await readJobResults(conn, JOB)).toEqual({
        state: 'running',
        info: { state, numberRecordsProcessed: 800 },
      });
      expect(getAllResults).not.toHaveBeenCalled();
    }
  });

  it('reads what a job that failed or was aborted once it ran wrote, the org taking no row of it back', async () => {
    const results = { successfulResults: [{ sf__Id: '003000000000001AAA', LastName: 'A' }] };
    for (const state of ['Failed', 'Aborted']) {
      const { conn } = orgWithJob({ state, numberRecordsProcessed: 1 }, results);
      expect(await readJobResults(conn, JOB)).toMatchObject({ state: 'ended', info: { state } });
    }
  });

  it('aborts a job left open past the hour its window may take to upload it, and says it never closed', async () => {
    const now = Date.parse('2026-10-22T12:00:00.000Z');
    const opened = orgWithJob({
      state: 'Open',
      numberRecordsProcessed: 0,
      createdDate: '2026-10-22T11:58:00.000+0000',
    });
    // Said with what the org says of it, and when its hour of grace ends.
    expect(await readJobResults(opened.conn, JOB, { now: () => now })).toEqual({
      state: 'running',
      info: {
        state: 'Open',
        numberRecordsProcessed: 0,
        createdDate: '2026-10-22T11:58:00.000+0000',
      },
      openUntil: '2026-10-22T12:58:00.000Z',
      graceLeftMs: 58 * 60_000,
    });
    expect(opened.abort).not.toHaveBeenCalled();

    const left = orgWithJob({ state: 'Open', createdDate: '2026-10-22T10:30:00.000+0000' });
    expect(await readJobResults(left.conn, JOB, { now: () => now })).toEqual({
      state: 'never-closed',
    });
    expect(left.abort).toHaveBeenCalledTimes(1);
    // Aborted an hour on, it is not read again: no close of its window is on its way.
    expect(left.check).toHaveBeenCalledTimes(1);
  });

  it('aborts at once an open job its caller sent and stopped uploading, when told no grace', async () => {
    const now = Date.parse('2026-10-22T12:00:00.000Z');
    const { conn, abort } = orgWithJob([
      { state: 'Open', createdDate: '2026-10-22T11:59:59.000Z' },
      { state: 'Aborted', numberRecordsProcessed: 0 },
    ]);

    expect(await readJobResults(conn, JOB, { now: () => now, openGraceMs: 0 })).toEqual({
      state: 'never-closed',
    });
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('says a job never closed when its abort is refused and it is open still: an open job is never processed', async () => {
    const { conn, abort, check } = orgWithJob({ state: 'Open' });
    abort.mockRejectedValueOnce(new Error('INVALIDJOBSTATE'));

    expect(await readJobResults(conn, JOB)).toEqual({ state: 'never-closed' });
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('reads a job again once its abort is refused, and says it runs when a close lost on its way reached the org', async () => {
    const { conn, abort, getAllResults } = orgWithJob([{ state: 'Open' }, { state: 'InProgress' }]);
    abort.mockRejectedValueOnce(new Error('INVALIDJOBSTATE: job is not open'));

    expect(await readJobResults(conn, JOB, { openGraceMs: 0 })).toEqual({
      state: 'running',
      info: { state: 'InProgress' },
    });
    expect(getAllResults).not.toHaveBeenCalled();
  });

  it('with no grace, reads a job again after its abort: never closed only when it was aborted before it processed a row', async () => {
    const clean = orgWithJob([{ state: 'Open' }, { state: 'Aborted', numberRecordsProcessed: 0 }]);
    expect(await readJobResults(clean.conn, JOB, { openGraceMs: 0 })).toEqual({
      state: 'never-closed',
    });
    expect(clean.getAllResults).not.toHaveBeenCalled();

    // The close reached the org first, and the abort came once it had begun:
    // what the job wrote is read, never taken for nothing.
    const results = { successfulResults: [{ sf__Id: '003000000000001AAA' }] };
    const late = orgWithJob(
      [{ state: 'Open' }, { state: 'Aborted', numberRecordsProcessed: 1 }],
      results,
    );
    expect(await readJobResults(late.conn, JOB, { openGraceMs: 0 })).toEqual({
      state: 'ended',
      info: { state: 'Aborted', numberRecordsProcessed: 1 },
      results: {
        successfulResults: results.successfulResults,
        failedResults: [],
        unprocessedRecords: [],
      },
    });

    // Aborted, and the org says nothing of what it processed: read, never taken for nothing.
    const unsaid = orgWithJob([{ state: 'Open' }, { state: 'Aborted' }], results);
    expect(await readJobResults(unsaid.conn, JOB, { openGraceMs: 0 })).toMatchObject({
      state: 'ended',
    });

    const done = orgWithJob([{ state: 'Open' }, { state: 'JobComplete' }], results);
    expect(await readJobResults(done.conn, JOB, { openGraceMs: 0 })).toMatchObject({
      state: 'ended',
      results: { successfulResults: results.successfulResults },
    });
  });

  it('says why a job or its results could not be read back, rather than reading it as one that wrote nothing', async () => {
    const gone = orgWithJob({ state: 'JobComplete' }, {}, { unreadable: true });
    expect(await readJobResults(gone.conn, JOB)).toEqual({
      state: 'unread',
      reason: 'INVALIDJOB: Unable to find object',
    });

    const cut = orgWithJob({ state: 'JobComplete' }, {}, { resultsUnreadable: true });
    expect(await readJobResults(cut.conn, JOB)).toEqual({
      state: 'unread',
      reason: 'socket hang up',
    });
  });

  it('reads an answer that names no state of an ingest job as unread, and none of its results', async () => {
    // Read as ended, its results would have been taken for all it wrote; read
    // as open, it would have been aborted and said to have written nothing.
    for (const answer of [
      { state: 'Closed' },
      { state: '' },
      { state: 'JobComplete', numberRecordsProcessed: -1 },
    ]) {
      const { conn, abort, getAllResults } = orgWithJob(answer);
      const read = await readJobResults(conn, JOB);
      expect(read).toMatchObject({ state: 'unread' });
      expect(abort).not.toHaveBeenCalled();
      expect(getAllResults).not.toHaveBeenCalled();
    }
  });
});

describe('ingestJobInfoOf', () => {
  it('keeps what the org says of a job, a null message as the org may send one', () => {
    expect(
      ingestJobInfoOf(JOB, {
        id: JOB,
        state: 'Failed',
        numberRecordsProcessed: 0,
        numberRecordsFailed: 0,
        errorMessage: 'InvalidBatch : Field name not found : Nope__c',
        object: 'Contact',
      }),
    ).toEqual({
      state: 'Failed',
      numberRecordsProcessed: 0,
      errorMessage: 'InvalidBatch : Field name not found : Nope__c',
    });
    expect(ingestJobInfoOf(JOB, { state: 'JobComplete', errorMessage: null })).toEqual({
      state: 'JobComplete',
      errorMessage: null,
    });
  });

  it('refuses an answer that names no state of an ingest job, naming the job and what it said', () => {
    expect(() => ingestJobInfoOf(JOB, { state: 'Closed' })).toThrow(`${JOB}`);
    expect(() => ingestJobInfoOf(JOB, { state: 'Closed' })).toThrow('"Closed"');
    expect(() => ingestJobInfoOf(JOB, undefined)).toThrow('state: none');
    expect(() =>
      ingestJobInfoOf(JOB, { state: 'JobComplete', numberRecordsProcessed: '3' }),
    ).toThrow(JOB);
  });
});
