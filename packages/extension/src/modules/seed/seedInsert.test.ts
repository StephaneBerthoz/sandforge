import { describe, it, expect } from 'vitest';
import { seedInsert, STREAMING_THRESHOLD, type SeedInsertConnection } from './seedInsert.js';
import { BulkApiManager } from '../../core/engine/BulkApiManager.js';
import { RetryableOperation } from '../../core/engine/RetryableOperation.js';
import type { BulkJobHandle, BulkJobRecordResult } from '../../core/engine/BulkApiExecutor.js';

/** `count` records of `object`, each a name of its own. */
function records(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({ Name: `Row ${i}` }));
}

/**
 * An org that takes every record it is sent: through REST, `create` calls of
 * the size sent; through the Bulk API, jobs that complete at once. `ruled`
 * are the objects an active duplicate rule watches.
 */
function fakeOrg({
  ruled = [] as string[],
  rulesUnread = false,
  jobIds = false,
  failRest = false,
} = {}) {
  const restCalls: Array<{ object: string; rows: number; headers: Record<string, string> }> = [];
  const jobs: Array<{ object: string; uploads: number }> = [];
  /** The jobs closed, in order. */
  const closed: string[] = [];
  let made = 0;
  const id = (): string => `a00000000000${String(100000 + made++).slice(-6)}`;
  const conn: SeedInsertConnection = {
    sobject: (object) => ({
      create: async (sent, options) => {
        restCalls.push({ object, rows: sent.length, headers: options.headers });
        if (failRest) throw new Error('UNABLE_TO_LOCK_ROW: try again');
        return sent.map(() => ({ success: true, id: id() }));
      },
    }),
    query: async () => {
      if (rulesUnread) throw new Error('INVALID_TYPE: DuplicateRule');
      return { records: ruled.map((SobjectType) => ({ SobjectType })) };
    },
    bulk2: {
      createJob: ({ object }) => {
        const entry = { object, uploads: 0 };
        jobs.push(entry);
        let sent = 0;
        const number = jobs.length;
        // jsforce gives a job its id once the org has opened it.
        let opened = false;
        const job: BulkJobHandle = {
          get id() {
            return jobIds ? (opened ? `75000000000000${number}AAA` : undefined) : `750${number}`;
          },
          open: async () => {
            opened = true;
          },
          uploadData: async (csv: string) => {
            entry.uploads++;
            sent = csv.trim().split('\n').length - 1;
          },
          close: async () => {
            closed.push(object);
          },
          abort: async () => {},
          check: async () => ({ state: 'JobComplete', numberRecordsProcessed: sent }),
          getAllResults: async (): Promise<BulkJobRecordResult[]> =>
            Array.from({ length: sent }, () => ({ success: true, id: id() })),
        };
        return job;
      },
    },
  };
  return { conn, restCalls, jobs, closed };
}

/** The write path over `org`, with the panel's defaults; `signal` is the run's cancel. */
function writer(org: ReturnType<typeof fakeOrg>, signal = new AbortController().signal) {
  const logged: string[] = [];
  const insert = seedInsert({
    conn: org.conn,
    bulkThreshold: 200,
    bulkManager: new BulkApiManager(5),
    retry: new RetryableOperation({ retryConfig: { maxRetries: 0 }, signal }),
    signal,
    label: 'seed:execute op-1',
    log: (line) => logged.push(line),
    onProgress: () => {},
  });
  return { insert, logged };
}

describe('the write path of a seed', () => {
  it('writes an insert of the bulk threshold or fewer through REST, a batch a call, with the duplicate header', async () => {
    const org = fakeOrg();
    const { insert } = writer(org);

    const answer = await insert('org', 'Account', records(200), 150);

    expect(org.jobs).toEqual([]);
    expect(org.restCalls.map((call) => call.rows)).toEqual([150, 50]);
    expect(org.restCalls[0].headers['Sforce-Duplicate-Rule-Header']).toBe('allowSave=true');
    expect(answer.successIds).toHaveLength(200);
    expect(answer.rows).toHaveLength(200);
  });

  it('sends an insert past the threshold as one Bulk API job', async () => {
    const org = fakeOrg();
    const { insert } = writer(org);

    const answer = await insert('org', 'Asset', records(201), 200);

    expect(org.restCalls).toEqual([]);
    expect(org.jobs).toEqual([{ object: 'Asset', uploads: 1 }]);
    expect(answer.successIds).toHaveLength(201);
  });

  it('sends an object a duplicate rule watches through REST, whatever it holds, and says why', async () => {
    const org = fakeOrg({ ruled: ['Contact'] });
    const { insert, logged } = writer(org);

    await insert('org', 'Contact', records(450), 200);

    expect(org.jobs).toEqual([]);
    expect(org.restCalls.map((call) => call.rows)).toEqual([200, 200, 50]);
    expect(logged).toContain(
      '[INFO] seed:execute op-1: Contact goes through REST: an active duplicate rule watches it, ' +
        'which a Bulk API job cannot waive',
    );
  });

  it('tells of each REST call before it goes and of what it created as it answers, before the insert returns', async () => {
    const org = fakeOrg({ ruled: ['Contact'] });
    const told: string[] = [];
    const insert = seedInsert({
      conn: org.conn,
      bulkThreshold: 200,
      bulkManager: new BulkApiManager(5),
      retry: new RetryableOperation({ retryConfig: { maxRetries: 0 } }),
      signal: new AbortController().signal,
      label: 'seed:execute op-1',
      log: () => {},
      onProgress: () => {},
      calls: {
        sending: (object, rows) =>
          told.push(`sending ${object} ${rows} after ${org.restCalls.length}`),
        answered: (object, ids) =>
          told.push(`answered ${object} ${ids.length} after ${org.restCalls.length}`),
      },
    });

    await insert('org', 'Contact', records(450), 200);

    // Each call kept before it went, and its records once it answered, not all of them at the end.
    expect(told).toEqual([
      'sending Contact 200 after 0',
      'answered Contact 200 after 1',
      'sending Contact 200 after 1',
      'answered Contact 200 after 2',
      'sending Contact 50 after 2',
      'answered Contact 50 after 3',
    ]);
  });

  it('names a Bulk API job by its id once the org has opened it, before the job is closed', async () => {
    const org = fakeOrg({ jobIds: true });
    const told: string[] = [];
    const insert = seedInsert({
      conn: org.conn,
      bulkThreshold: 200,
      bulkManager: new BulkApiManager(5),
      retry: new RetryableOperation({ retryConfig: { maxRetries: 0 } }),
      signal: new AbortController().signal,
      label: 'seed:execute op-1',
      log: () => {},
      onProgress: () => {},
      calls: {
        sending: (object, rows, call) =>
          told.push(
            `sending ${object} ${rows}${call?.job ? ` job ${call.job}` : ''} closed ${org.closed.length}`,
          ),
        answered: (object, ids) => told.push(`answered ${object} ${ids.length}`),
      },
    });

    await insert('org', 'Contact', records(250), 200);
    await insert('org', 'Asset', records(STREAMING_THRESHOLD + 1), 200);

    expect(told).toEqual([
      'sending Contact 250 closed 0',
      'sending Contact 250 job 750000000000001AAA closed 0',
      'answered Contact 250',
      `sending Asset ${STREAMING_THRESHOLD + 1} closed 1`,
      `sending Asset ${STREAMING_THRESHOLD + 1} job 750000000000002AAA closed 1`,
      `answered Asset ${STREAMING_THRESHOLD + 1}`,
    ]);
  });

  it('answers a REST call the org failed on with nothing created, so the call is no longer under way', async () => {
    const org = fakeOrg({ failRest: true });
    const told: string[] = [];
    const insert = seedInsert({
      conn: org.conn,
      bulkThreshold: 200,
      bulkManager: new BulkApiManager(5),
      retry: new RetryableOperation({ retryConfig: { maxRetries: 0 } }),
      signal: new AbortController().signal,
      label: 'seed:execute op-1',
      log: () => {},
      onProgress: () => {},
      calls: {
        sending: (object, rows) => told.push(`sending ${object} ${rows}`),
        answered: (object, ids) => told.push(`answered ${object} ${ids.length}`),
      },
    });

    const answer = await insert('org', 'Account', records(3), 200);

    expect(answer.successIds).toEqual([]);
    expect(told).toEqual(['sending Account 3', 'answered Account 0']);
  });

  it('sends an object a duplicate rule watches through REST past 10 000 records too, and says it is slower', async () => {
    const org = fakeOrg({ ruled: ['Contact'] });
    const { insert, logged } = writer(org);

    const answer = await insert('org', 'Contact', records(STREAMING_THRESHOLD + 500), 200);

    expect(org.jobs).toEqual([]);
    expect(org.restCalls).toHaveLength(53);
    expect(org.restCalls.every((call) => call.headers['Sforce-Duplicate-Rule-Header'])).toBe(true);
    expect(answer.successIds).toHaveLength(STREAMING_THRESHOLD + 500);
    expect(logged).toContain(
      '[INFO] seed:execute op-1: Contact goes through REST: an active duplicate rule watches it, ' +
        'which a Bulk API job cannot waive — 10500 records in 53 calls, slower than one job',
    );
  });

  it('says once when the duplicate rules could not be read, and sends the object as a job', async () => {
    const org = fakeOrg({ rulesUnread: true });
    const { insert, logged } = writer(org);

    await insert('org', 'Contact', records(300), 200);
    await insert('org', 'Lead', records(300), 200);

    expect(org.jobs.map((job) => job.object)).toEqual(['Contact', 'Lead']);
    expect(logged.filter((line) => line.includes('could not be read'))).toHaveLength(1);
  });

  it('sends an insert past 10 000 records as one job, uploaded once', async () => {
    const org = fakeOrg();
    const { insert } = writer(org);

    const answer = await insert('org', 'Asset', records(STREAMING_THRESHOLD + 500), 200);

    expect(org.restCalls).toEqual([]);
    expect(org.jobs).toEqual([{ object: 'Asset', uploads: 1 }]);
    expect(answer.successIds).toHaveLength(STREAMING_THRESHOLD + 500);
    expect(answer.errors).toEqual([]);
  });

  it('opens no job and sends no call once the run is cancelled', async () => {
    const org = fakeOrg();
    const stop = new AbortController();
    stop.abort();
    const { insert } = writer(org, stop.signal);

    for (const count of [50, 300, STREAMING_THRESHOLD + 1]) {
      expect(await insert('org', 'Asset', records(count), 200)).toMatchObject({
        successIds: [],
        stopped: true,
      });
    }
    expect(org.jobs).toEqual([]);
    expect(org.restCalls).toEqual([]);
  });

  it('keeps every error of a refused record with its code, and counts each record of a lost batch', async () => {
    const org = fakeOrg();
    org.conn.sobject = (object) => ({
      create: async (sent) => {
        org.restCalls.push({ object, rows: sent.length, headers: {} });
        if (sent.length === 1) {
          return [
            {
              success: false,
              errors: [{ statusCode: 'REQUIRED_FIELD_MISSING', message: 'Name', fields: ['Name'] }],
            },
          ];
        }
        throw Object.assign(new Error('UNABLE_TO_LOCK_ROW'), { errorCode: 'UNABLE_TO_LOCK_ROW' });
      },
    });
    const { insert } = writer(org);

    const one = await insert('org', 'Account', records(1), 200);
    const lost = await insert('org', 'Account', records(3), 200);

    expect(one.errors).toEqual(['REQUIRED_FIELD_MISSING: Name [Name]']);
    expect(lost.errors).toHaveLength(3);
  });
});
