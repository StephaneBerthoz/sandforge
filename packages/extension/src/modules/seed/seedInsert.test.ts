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
function fakeOrg({ ruled = [] as string[], rulesUnread = false } = {}) {
  const restCalls: Array<{ object: string; rows: number; headers: Record<string, string> }> = [];
  const jobs: Array<{ object: string; uploads: number }> = [];
  let made = 0;
  const id = (): string => `a00000000000${String(100000 + made++).slice(-6)}`;
  const conn: SeedInsertConnection = {
    sobject: (object) => ({
      create: async (sent, options) => {
        restCalls.push({ object, rows: sent.length, headers: options.headers });
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
        const job: BulkJobHandle = {
          id: `750${jobs.length}`,
          open: async () => {},
          uploadData: async (csv: string) => {
            entry.uploads++;
            sent = csv.trim().split('\n').length - 1;
          },
          close: async () => {},
          abort: async () => {},
          check: async () => ({ state: 'JobComplete', numberRecordsProcessed: sent }),
          getAllResults: async (): Promise<BulkJobRecordResult[]> =>
            Array.from({ length: sent }, () => ({ success: true, id: id() })),
        };
        return job;
      },
    },
  };
  return { conn, restCalls, jobs };
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
