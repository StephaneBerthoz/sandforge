import { describe, expect, it, vi } from 'vitest';

import type {
  BulkApiConnection,
  BulkJobCheckResult,
  BulkJobHandle,
  JsforceIngestJobResults,
} from './BulkApiExecutor.js';
import type { IngestJobResultsReading } from './ingestJobRead.js';
import { trackedBulkConnection } from './trackedBulkConnection.js';

const JOB = '750000000000001AAA';

/** A job handle as jsforce gives one: no id until the org opens it. */
function jsforceJob(results: JsforceIngestJobResults): BulkJobHandle {
  let id: string | undefined;
  return {
    get id() {
      return id;
    },
    open: vi.fn(async () => {
      id = JOB;
    }),
    uploadData: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    check: vi.fn(async (): Promise<BulkJobCheckResult> => ({
      state: 'Failed',
      errorMessage: 'InvalidBatch : Field name not found : Nope__c',
    })),
    getAllResults: vi.fn(async () => results),
  };
}

/** A connection whose created job is `job`, and whose jobs read back by id answer `byId`. */
function connectionOf(
  job: BulkJobHandle,
  byId: JsforceIngestJobResults = {},
): BulkApiConnection & IngestJobResultsReading {
  return {
    bulk2: {
      createJob: () => job,
      job: () => ({
        check: async () => ({ state: 'JobComplete' }),
        getSuccessfulResults: async () => byId.successfulResults ?? [],
        getAllResults: async () => byId,
        abort: async () => undefined,
      }),
    },
  };
}

describe('trackedBulkConnection', () => {
  it('counts each call the job sends, its results read three ways, and tells each as it is sent', async () => {
    const told: number[] = [];
    const tracked = trackedBulkConnection(
      connectionOf(
        jsforceJob({
          successfulResults: [{ sf__Id: '003000000000001AAA' }],
          failedResults: [{ sf__Error: 'x' }],
          unprocessedRecords: [{ Name: 'C' }],
        }),
      ),
      (n) => told.push(n),
    );
    const job = tracked.connection.bulk2.createJob({ operation: 'insert', object: 'Contact' });

    await job.open();
    await job.uploadData('Name\nA\n');
    await job.close();
    await job.check();
    await job.getAllResults();

    expect(tracked.requests()).toBe(1 + 1 + 1 + 1 + 3);
    expect(told).toEqual([1, 1, 1, 1, 3]);
    // Answered rows, written or refused: the unprocessed one is not.
    expect(tracked.processed()).toBe(2);
  });

  it('says whether the close was sent, and whether the org answered it', async () => {
    const created = jsforceJob({});
    vi.mocked(created.close).mockRejectedValueOnce(new Error('socket hang up'));
    const tracked = trackedBulkConnection(connectionOf(created));
    const job = tracked.connection.bulk2.createJob({ operation: 'insert', object: 'Contact' });

    expect([tracked.closeSent(), tracked.closed()]).toEqual([false, false]);
    await expect(job.close()).rejects.toThrow('socket hang up');
    // Sent, and counted: the org may hold the job closed all the same.
    expect([tracked.closeSent(), tracked.closed()]).toEqual([true, false]);
    expect(tracked.requests()).toBe(1);

    await job.close();
    expect(tracked.closed()).toBe(true);
  });

  it('keeps the id the org gave the job once it opened it, and its last state and message', async () => {
    const tracked = trackedBulkConnection(connectionOf(jsforceJob({})));
    const job = tracked.connection.bulk2.createJob({ operation: 'insert', object: 'Contact' });

    expect(tracked.jobId()).toBeUndefined();
    await job.open();
    expect(tracked.jobId()).toBe(JOB);
    expect(job.id).toBe(JOB);

    await job.check();
    expect(tracked.last()).toEqual({
      state: 'Failed',
      message: 'InvalidBatch : Field name not found : Nope__c',
    });
  });

  it('counts the reads of a job read back by its id, as the job counts its own', async () => {
    const tracked = trackedBulkConnection(
      connectionOf(jsforceJob({}), { successfulResults: [{ sf__Id: '003000000000001AAA' }] }),
    );
    const reading = tracked.connection.bulk2.job('ingest', { id: JOB });

    await reading.check();
    await reading.getAllResults();
    await reading.getSuccessfulResults();
    await reading.abort();

    expect(tracked.requests()).toBe(1 + 3 + 1 + 1);
    expect(tracked.last()).toEqual({ state: 'JobComplete', message: undefined });
    expect(tracked.processed()).toBe(1);
  });

  it('counts a call the org refused: it is one of its requests all the same', async () => {
    const created = jsforceJob({});
    vi.mocked(created.open).mockRejectedValueOnce(new Error('InvalidEntity'));
    const tracked = trackedBulkConnection(connectionOf(created));
    const job = tracked.connection.bulk2.createJob({ operation: 'insert', object: 'Thing__c' });

    await expect(job.open()).rejects.toThrow('InvalidEntity');
    expect(tracked.requests()).toBe(1);
    expect(tracked.jobId()).toBeUndefined();
  });

  it('reads nothing back by id through a connection that cannot', () => {
    const plain: BulkApiConnection = { bulk2: { createJob: () => jsforceJob({}) } };

    expect('job' in trackedBulkConnection(plain).connection.bulk2).toBe(false);
  });
});
