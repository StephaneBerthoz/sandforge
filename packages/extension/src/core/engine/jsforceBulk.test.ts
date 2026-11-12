import { describe, expect, it, vi } from 'vitest';
import type { Connection } from 'jsforce';

import { readJobResults } from './ingestJobRead.js';
import { jsforceBulk } from './jsforceBulk.js';

const JOB = '750000000000001AAA';

/** A job's JSON as the org answers a read of its state: more than is read of it. */
function jobInfo(state: string, extra: Record<string, unknown> = {}) {
  return {
    id: JOB,
    object: 'Contact',
    operation: 'insert',
    state,
    createdById: '005000000000001AAA',
    createdDate: '2026-11-12T10:00:00.000+0000',
    systemModstamp: '2026-11-12T10:00:30.000+0000',
    apiVersion: 62,
    concurrencyMode: 'Parallel',
    contentType: 'CSV',
    numberRecordsProcessed: 0,
    numberRecordsFailed: 0,
    retries: 0,
    totalProcessingTime: 0,
    ...extra,
  };
}

/**
 * A jsforce connection's Bulk API 2.0, as jsforce 3 shapes it: a job with no
 * id until the org opens it, whose `open` answers the org's JSON, and whose
 * state is read as the org says it (`states`, in turn, the last kept).
 */
function jsforceConnection(states: Array<Record<string, unknown>>) {
  const calls: string[] = [];
  const answers = [...states];
  const nextState = async () => (answers.length > 1 ? answers.shift() : answers[0]);
  const results = {
    successfulResults: [{ sf__Id: '003000000000001AAA', sf__Created: 'true', LastName: 'A' }],
    failedResults: [],
    unprocessedRecords: [],
  };
  const bulk2 = {
    createJob: vi.fn((options: Record<string, unknown>) => {
      calls.push(`create ${JSON.stringify(options)}`);
      let opened = false;
      return {
        get id() {
          return opened ? JOB : undefined;
        },
        open: async () => {
          calls.push('open');
          opened = true;
          return jobInfo('Open');
        },
        uploadData: async (csv: string) => {
          calls.push(`upload ${csv}`);
        },
        close: async () => {
          calls.push('close');
        },
        abort: async () => {
          calls.push('abort');
        },
        check: async () => {
          calls.push('check');
          return nextState();
        },
        getAllResults: async () => {
          calls.push('results');
          return results;
        },
      };
    }),
    job: vi.fn((type: string, options: { id: string }) => ({
      check: async () => {
        calls.push(`read ${type} ${options.id}`);
        return nextState();
      },
      getSuccessfulResults: async () => {
        calls.push('successful');
        return results.successfulResults;
      },
      getAllResults: async () => {
        calls.push(`results ${options.id}`);
        return results;
      },
      abort: async () => {
        calls.push(`abort ${options.id}`);
      },
    })),
  };
  return { conn: { bulk2 } as unknown as Connection, calls };
}

describe('jsforceBulk', () => {
  it("drives a job through jsforce's handle: opened, sent, closed, its state and results read, the id the org gave it once open", async () => {
    const { conn, calls } = jsforceConnection([
      jobInfo('JobComplete', { numberRecordsProcessed: 1 }),
    ]);
    const job = jsforceBulk(conn).bulk2.createJob({ operation: 'insert', object: 'Contact' });

    expect(job.id).toBeUndefined();
    await job.open();
    expect(job.id).toBe(JOB);
    await job.uploadData('LastName\nA\n');
    await job.close();
    expect(await job.check()).toEqual({ state: 'JobComplete', numberRecordsProcessed: 1 });
    expect(await job.getAllResults()).toMatchObject({
      successfulResults: [{ sf__Id: '003000000000001AAA' }],
    });

    expect(calls).toEqual([
      'create {"operation":"insert","object":"Contact"}',
      'open',
      'upload LastName\nA\n',
      'close',
      'check',
      'results',
    ]);
  });

  it("passes the org's message of a failed job on, and none of a null one", async () => {
    const failed = jsforceConnection([
      jobInfo('Failed', { errorMessage: 'InvalidBatch : Field name not found : Nope__c' }),
    ]);
    const job = jsforceBulk(failed.conn).bulk2.createJob({
      operation: 'insert',
      object: 'Contact',
    });
    expect(await job.check()).toEqual({
      state: 'Failed',
      numberRecordsProcessed: 0,
      errorMessage: 'InvalidBatch : Field name not found : Nope__c',
    });

    const complete = jsforceConnection([jobInfo('JobComplete', { errorMessage: null })]);
    const done = jsforceBulk(complete.conn).bulk2.createJob({
      operation: 'insert',
      object: 'Contact',
    });
    expect(await done.check()).toEqual({ state: 'JobComplete', numberRecordsProcessed: 0 });
  });

  it('holds a closed job to the states of an ingest job: one the org holds open still, or one no job takes, is never read as done', async () => {
    // Read as done, the executor would have read its results as all it wrote.
    const open = jsforceConnection([jobInfo('Open')]);
    const stillOpen = jsforceBulk(open.conn).bulk2.createJob({
      operation: 'insert',
      object: 'Contact',
    });
    await stillOpen.open();
    await expect(stillOpen.check()).rejects.toThrow(`Bulk API job ${JOB} is still open`);

    const odd = jsforceConnection([jobInfo('Closed')]);
    const unknown = jsforceBulk(odd.conn).bulk2.createJob({
      operation: 'insert',
      object: 'Contact',
    });
    await expect(unknown.check()).rejects.toThrow('"Closed"');

    const unsaid = jsforceConnection([{ id: JOB }]);
    const noState = jsforceBulk(unsaid.conn).bulk2.createJob({
      operation: 'insert',
      object: 'Contact',
    });
    await expect(noState.check()).rejects.toThrow('state: none');
  });

  it("reads a job back by its id, its state held to an ingest job's, its results and abort jsforce's own", async () => {
    const { conn, calls } = jsforceConnection([jobInfo('InProgress'), jobInfo('JobComplete')]);
    const bulk = jsforceBulk(conn);

    expect(await bulk.bulk2.job('ingest', { id: JOB }).check()).toEqual({
      state: 'InProgress',
      numberRecordsProcessed: 0,
      createdDate: '2026-11-12T10:00:00.000+0000',
      systemModstamp: '2026-11-12T10:00:30.000+0000',
    });
    expect(await readJobResults(bulk, JOB)).toMatchObject({
      state: 'ended',
      info: { state: 'JobComplete' },
      results: { successfulResults: [{ sf__Id: '003000000000001AAA' }] },
    });
    await bulk.bulk2.job('ingest', { id: JOB }).abort();

    expect(calls).toEqual([
      `read ingest ${JOB}`,
      `read ingest ${JOB}`,
      `results ${JOB}`,
      `abort ${JOB}`,
    ]);
  });

  it('reads a job back by its id as unread when the org names no state of an ingest job', async () => {
    const { conn, calls } = jsforceConnection([jobInfo('Deleted')]);

    expect(await readJobResults(jsforceBulk(conn), JOB)).toMatchObject({
      state: 'unread',
      reason: expect.stringContaining('"Deleted"'),
    });
    expect(calls).toEqual([`read ingest ${JOB}`]);
  });
});
