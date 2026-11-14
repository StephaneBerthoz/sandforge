import { describe, it, expect } from 'vitest';
import { seedInsert, STREAMING_THRESHOLD, type SeedInsertConnection } from './seedInsert.js';
import { BulkApiManager } from '../../core/engine/BulkApiManager.js';
import { RetryableOperation } from '../../core/engine/RetryableOperation.js';
import type { BulkJobHandle, BulkJobRecordResult } from '../../core/engine/BulkApiExecutor.js';
import { lockedParentOrg, type LockedParentOrg } from '../../test/lockedParentOrg.js';

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

  it('sends what a standard duplicate rule watches through REST when the rules could not be read, says so in the result, and the rest as a job', async () => {
    // Sent as jobs past rules nobody could read — the query needs View
    // Setup — the standard account rule refused 296 of 500 accounts, said
    // only in the log.
    const org = fakeOrg({ rulesUnread: true });
    const { insert, logged } = writer(org);

    const contacts = await insert('org', 'Contact', records(300), 200);
    const leads = await insert('org', 'Lead', records(300), 200);
    await insert('org', 'Asset', records(300), 200);

    expect(org.jobs.map((job) => job.object)).toEqual(['Asset']);
    expect(org.restCalls).toHaveLength(4);
    expect(org.restCalls.every((call) => call.headers['Sforce-Duplicate-Rule-Header'])).toBe(true);
    expect(contacts.notes).toEqual([
      "The org's duplicate rules could not be read (the user SandForge connects as needs View " +
        'Setup and Configuration): Contact, which a standard duplicate rule watches, was sent ' +
        'through REST, whose header lets its matches be saved, rather than as a Bulk API job.',
    ]);
    expect(leads.notes?.[0]).toContain('Lead, which a standard duplicate rule watches');
    expect(logged.filter((line) => line.includes('could not be read:'))).toHaveLength(1);
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

describe('the write path of a seed, into a target where another transaction holds the parent', () => {
  /** The account the records hang from, which another transaction holds. */
  const HUB = `001${'0'.repeat(11)}9AAA`;

  /** `count` contacts: the first `onHub` under the held account, the others under none. */
  function contacts(count: number, onHub = count): Record<string, unknown>[] {
    return Array.from({ length: count }, (_, i) => ({
      LastName: `Contact ${i}`,
      ...(i < onHub ? { AccountId: HUB } : {}),
    }));
  }

  /** The write path over `org`, its waits kept rather than waited out. */
  function lockedWriter(org: LockedParentOrg, onWait?: () => void, signal?: AbortSignal) {
    const waits: number[] = [];
    const created: string[] = [];
    const stop = signal ?? new AbortController().signal;
    const insert = seedInsert({
      conn: org.connection as unknown as SeedInsertConnection,
      bulkThreshold: 200,
      bulkManager: new BulkApiManager(5),
      retry: new RetryableOperation({ retryConfig: { maxRetries: 0 }, signal: stop }),
      signal: stop,
      label: 'seed:execute op-1',
      log: () => {},
      onProgress: () => {},
      calls: { sending: () => {}, answered: (_object, ids) => created.push(...ids) },
      wait: async (ms) => {
        waits.push(ms);
        onWait?.();
      },
    });
    return { insert, waits, created };
  }

  it('sends again through REST only the records a Bulk API job refused for the lock, each created once, and says so', async () => {
    const org = lockedParentOrg({ parent: HUB, heldFor: 1 });
    const { insert, created } = lockedWriter(org);

    const answer = await insert('org', 'Contact', contacts(300, 150), 200);

    expect(org.jobs.map((job) => job.rows.length)).toEqual([300]);
    expect(org.rest.map((call) => call.rows.length)).toEqual([150]);
    expect(answer.successIds).toHaveLength(300);
    expect(answer.errors).toEqual([]);
    expect(answer.rows?.every((row) => row.id !== undefined)).toBe(true);
    expect(org.written).toHaveLength(300);
    expect(new Set(org.written.map((record) => record.row['LastName'])).size).toBe(300);
    expect(new Set(created).size).toBe(300);
    expect(answer.notes).toEqual([
      'Contact: 150 record(s) refused because the target could not lock a record their write ' +
        'needed (UNABLE_TO_LOCK_ROW), sent again up to 3 times, waiting longer each time: ' +
        '150 written.',
    ]);
  });

  it('sends again the records a REST call refused for the lock, after a wait that doubles each time', async () => {
    const org = lockedParentOrg({ parent: HUB, heldFor: 3 });
    const { insert, waits } = lockedWriter(org);

    const answer = await insert('org', 'Contact', contacts(150, 40), 200);

    expect(org.rest.map((call) => call.rows.length)).toEqual([150, 40, 40, 40]);
    expect(answer.successIds).toHaveLength(150);
    expect(answer.errors).toEqual([]);
    expect(org.written).toHaveLength(150);
    expect(waits).toHaveLength(3);
    expect(waits[2]).toBeGreaterThanOrEqual(4_000);
  });

  it('sends again the records an upload of more than 10 000 refused for the lock', async () => {
    const org = lockedParentOrg({ parent: HUB, heldFor: 1 });
    const { insert } = lockedWriter(org);

    const answer = await insert('org', 'Contact', contacts(STREAMING_THRESHOLD + 100, 100), 200);

    expect(org.jobs).toHaveLength(1);
    expect(org.rest.map((call) => call.rows.length)).toEqual([100]);
    expect(answer.successIds).toHaveLength(STREAMING_THRESHOLD + 100);
    expect(answer.errors).toEqual([]);
    expect(org.written).toHaveLength(STREAMING_THRESHOLD + 100);
  });

  it('leaves refused, saying how many times they went, the records the lock still held after their third send', async () => {
    const org = lockedParentOrg({ parent: HUB, heldFor: Infinity });
    const { insert } = lockedWriter(org);

    const answer = await insert('org', 'Contact', contacts(10, 4), 200);

    expect(org.rest.map((call) => call.rows.length)).toEqual([10, 4, 4, 4]);
    expect(answer.successIds).toHaveLength(6);
    expect(answer.errors).toHaveLength(4);
    for (const error of answer.errors) {
      expect(error).toMatch(/^UNABLE_TO_LOCK_ROW: unable to obtain exclusive access/);
      expect(error).toContain('sent again 3 times, waiting longer each time');
    }
    expect(answer.notes?.[0]).toContain('0 written, 4 still refused for the lock');
  });

  it('sends nothing again once the run is cancelled', async () => {
    const org = lockedParentOrg({ parent: HUB, heldFor: Infinity });
    const stop = new AbortController();
    const { insert } = lockedWriter(org, () => stop.abort(), stop.signal);

    const answer = await insert('org', 'Contact', contacts(3), 200);

    expect(org.rest).toHaveLength(1);
    expect(answer.errors).toHaveLength(3);
    expect(answer.errors[0]).not.toContain('sent again');
    expect(answer.notes?.[0]).toContain('3 not sent again: the run was stopped');
  });

  it('sends nothing again of a call the org failed whole, which the retry of calls covers', async () => {
    const org = fakeOrg({ failRest: true });
    const { insert } = writer(org);

    const answer = await insert('org', 'Account', records(3), 200);

    expect(org.restCalls).toHaveLength(1);
    expect(answer.errors).toHaveLength(3);
    expect(answer.notes).toBeUndefined();
  });
});
