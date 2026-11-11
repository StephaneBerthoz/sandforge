import { describe, expect, it, vi } from 'vitest';

import type { JsforceIngestJobResults } from './BulkApiExecutor.js';
import {
  readJobResults,
  type IngestJobInfo,
  type IngestJobResultsReading,
} from './ingestJobRead.js';

const JOB = '750000000000001AAA';

/**
 * An org holding one ingest job, in the state `info` says — or, given several,
 * in each in turn, one a read, the last one kept — whose results are `results`.
 */
function orgWithJob(
  info: IngestJobInfo | IngestJobInfo[],
  results: JsforceIngestJobResults = {},
  options: { unreadable?: boolean; resultsUnreadable?: boolean } = {},
) {
  const asked: string[] = [];
  const states = Array.isArray(info) ? [...info] : [info];
  const check = vi.fn(async () => {
    if (options.unreadable) throw new Error('INVALIDJOB: Unable to find object');
    return (states.length > 1 ? states.shift() : states[0]) as IngestJobInfo;
  });
  const abort = vi.fn(async () => undefined);
  const getAllResults = vi.fn(async () => {
    if (options.resultsUnreadable) throw new Error('socket hang up');
    return results;
  });
  const getSuccessfulResults = vi.fn(async () => results.successfulResults ?? []);
  const conn: IngestJobResultsReading = {
    bulk2: {
      job: (type, { id }) => {
        asked.push(`${type} ${id}`);
        return {
          check,
          getSuccessfulResults,
          getAllResults,
          abort,
        };
      },
    },
  };
  return { conn, asked, check, abort, getAllResults, getSuccessfulResults };
}

describe('readJobResults', () => {
  it('reads every result of a job that ended, by its id, with what the org says of it', async () => {
    const results = {
      successfulResults: [{ sf__Id: '003000000000001AAA', sf__Created: 'true', LastName: 'A' }],
      failedResults: [{ sf__Error: 'REQUIRED_FIELD_MISSING:x:LastName --', LastName: '' }],
      unprocessedRecords: [{ LastName: 'C' }],
    };
    const info = { state: 'JobComplete', systemModstamp: '2026-11-01T10:00:00.000+0000' };
    const { conn, asked, getAllResults, getSuccessfulResults } = orgWithJob(info, results);

    expect(await readJobResults(conn, JOB)).toEqual({ state: 'ended', info, results });
    expect(asked).toEqual([`ingest ${JOB}`]);
    expect(getAllResults).toHaveBeenCalledTimes(1);
    expect(getSuccessfulResults).not.toHaveBeenCalled();
  });

  it('reads only the successful results when told, one call where every result takes three', async () => {
    const { conn, getAllResults, getSuccessfulResults } = orgWithJob(
      { state: 'Failed', errorMessage: 'InvalidBatch' },
      {
        successfulResults: [{ sf__Id: '003000000000001AAA' }],
        failedResults: [{ sf__Error: 'x' }],
      },
    );

    expect(await readJobResults(conn, JOB, { successfulOnly: true })).toEqual({
      state: 'ended',
      info: { state: 'Failed', errorMessage: 'InvalidBatch' },
      results: { successfulResults: [{ sf__Id: '003000000000001AAA' }] },
    });
    expect(getSuccessfulResults).toHaveBeenCalledTimes(1);
    expect(getAllResults).not.toHaveBeenCalled();
  });

  it('says a job the org still processes is running, and reads none of its results', async () => {
    for (const state of ['UploadComplete', 'InProgress']) {
      const { conn, getAllResults } = orgWithJob({ state });
      expect(await readJobResults(conn, JOB)).toEqual({ state: 'running' });
      expect(getAllResults).not.toHaveBeenCalled();
    }
  });

  it('aborts a job left open past the hour its window may take to upload it, and says it never closed', async () => {
    const now = Date.parse('2026-10-22T12:00:00.000Z');
    const opened = orgWithJob({ state: 'Open', createdDate: '2026-10-22T11:58:00.000+0000' });
    expect(await readJobResults(opened.conn, JOB, { now: () => now })).toEqual({
      state: 'running',
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
    const { conn, abort } = orgWithJob({ state: 'Open', createdDate: '2026-10-22T11:59:59.000Z' });

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

    expect(await readJobResults(conn, JOB, { openGraceMs: 0 })).toEqual({ state: 'running' });
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
      results,
    });

    const done = orgWithJob([{ state: 'Open' }, { state: 'JobComplete' }], results);
    expect(await readJobResults(done.conn, JOB, { openGraceMs: 0 })).toMatchObject({
      state: 'ended',
      results,
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
});
