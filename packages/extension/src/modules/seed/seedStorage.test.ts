import { describe, it, expect, vi } from 'vitest';
import { CRM_STARTER, DATA_STORAGE_NOT_TOLD, SALES_CLOUD_STARTER } from '@sandforge/shared';
import {
  importRequestsEstimate,
  seedFitBudgetOf,
  seedPartitionOf,
  seedRequestsEstimate,
  seedStorageBytes,
  seedStorageGate,
} from './seedStorage';

const KB = 1024;
const MB = 1024 * KB;

/** An org that says it has `remaining` of `max` MB of data storage left, and its API requests. */
function limits(max: number, remaining: number, api = { Max: 15_000, Remaining: 15_000 }) {
  return {
    request: vi.fn(async () => ({
      DataStorageMB: { Max: max, Remaining: remaining },
      DailyApiRequests: api,
    })),
  };
}

/** What a read of the target said of its duplicate rules, by object. */
function rules(watched: Record<string, boolean>) {
  return { duplicateRules: new Map(Object.entries(watched)) };
}

function objects(...counts: Array<[string, number]>) {
  return {
    objects: counts.map(([objectApiName, recordCount], insertOrder) => ({
      objectApiName,
      recordCount,
      fieldRules: [],
      excludedFields: [],
      insertOrder,
      batchSize: 200,
    })),
  };
}

describe('seedStorageBytes', () => {
  it('counts the records by the sizes Salesforce documents', () => {
    expect(seedStorageBytes(objects(['Account', 10], ['Contact', 5]), [])).toBe(15 * 2 * KB);
    expect(seedStorageBytes(objects(['Campaign', 2], ['CampaignMember', 3]), [])).toBe(
      2 * 8 * KB + 3 * KB,
    );
    // A person account is an account and a contact.
    expect(seedStorageBytes(objects(['Account', 10]), ['Account'])).toBe(10 * 4 * KB);
  });

  it('puts the first built-in template within a Developer Edition, and Sales Cloud Starter past it', () => {
    expect(seedStorageBytes(CRM_STARTER, [])).toBeLessThan(1 * MB);
    expect(seedStorageBytes(SALES_CLOUD_STARTER, [])).toBeGreaterThan(14 * MB);
  });
});

describe('seedStorageGate', () => {
  it('counts what the read of the target’s deliverability sent with the seed’s requests, a part of its own', async () => {
    const gate = await seedStorageGate(limits(5, 5), CRM_STARTER, [], 'my-dev-org', undefined, {
      deliverability: 2,
    });

    expect(gate.api).toMatchObject({ parts: { deliverability: 2 } });
  });

  it('refuses a seed past the storage the org has left, naming both, before anything is written', async () => {
    // The gallery's first template took about 15 MB of a Developer Edition's 5.
    const gate = await seedStorageGate(limits(5, 5), SALES_CLOUD_STARTER, [], 'my-dev-org');
    expect(gate.check.verdict).toBe('exceeds');
    expect(gate.refusal).toBe(
      'The records to write take about 14.9 MB of data storage, and my-dev-org has 5 MB left ' +
        'of 5 MB: leave objects out, lower the records per object, or free data storage in ' +
        'my-dev-org. Nothing was written.',
    );
  });

  it('lets through a seed the org has room for', async () => {
    const gate = await seedStorageGate(limits(5, 5), CRM_STARTER, [], 'my-dev-org');
    expect(gate).toEqual({
      check: { verdict: 'fits', estimateMB: expect.any(Number), maxMB: 5, remainingMB: 5 },
      api: {
        verdict: 'fits',
        estimate: seedRequestsEstimate(CRM_STARTER),
        max: 15_000,
        remaining: 15_000,
      },
    });
  });

  it('refuses a seed past the API requests the org has left today, read from the same limits', async () => {
    // Only Forge's Review compared them: a seed into an org whose
    // integrations had used the day's requests stopped part way through.
    const transport = limits(5, 5, { Max: 15_000, Remaining: 3 });
    const gate = await seedStorageGate(transport, CRM_STARTER, [], 'my-dev-org');

    expect(transport.request).toHaveBeenCalledTimes(1);
    expect(gate.refusedFor).toBe('apiRequests');
    expect(gate.refusal).toBe(
      `The run takes about ${seedRequestsEstimate(CRM_STARTER)} API requests, and my-dev-org has ` +
        '3 of its 15000 daily requests left: it would stop part way through, its records ' +
        'refused with REQUEST_LIMIT_EXCEEDED. Run it once the org has requests to spare — the ' +
        'limit is counted over the last 24 hours — or write fewer records. Nothing was written.',
    );
  });

  it("refuses a seed past the API requests a Standard User's limits tell, though they leave out the storage", async () => {
    // A Standard User's `/limits` list DailyApiRequests and SingleEmail, and
    // no DataStorageMB: the seed took the requests for unread with the
    // storage, and went on into an org with three requests left.
    const transport = {
      request: vi.fn(async () => ({
        DailyApiRequests: { Max: 15_000, Remaining: 3 },
        SingleEmail: { Max: 15, Remaining: 15 },
      })),
    };

    const gate = await seedStorageGate(transport, CRM_STARTER, [], 'my-dev-org');

    expect(gate.check).toMatchObject({ verdict: 'unread', unread: DATA_STORAGE_NOT_TOLD });
    expect(gate.api).toEqual({
      verdict: 'exceeds',
      estimate: seedRequestsEstimate(CRM_STARTER),
      max: 15_000,
      remaining: 3,
    });
    expect(gate.refusedFor).toBe('apiRequests');
    expect(gate.refusal).toContain('my-dev-org has 3 of its 15000 daily requests left');
  });

  it("asks nothing more of a Standard User's org whose requests fit, and says the storage it does not tell", async () => {
    const transport = {
      request: vi.fn(async () => ({ DailyApiRequests: { Max: 15_000, Remaining: 14_000 } })),
    };

    const gate = await seedStorageGate(transport, CRM_STARTER, [], 'my-dev-org');

    expect(gate.refusal).toBeUndefined();
    expect(gate.check).toMatchObject({ verdict: 'unread', unread: DATA_STORAGE_NOT_TOLD });
    expect(gate.api).toMatchObject({ verdict: 'fits', remaining: 14_000, max: 15_000 });
  });

  it('counts a REST call per 200 records, and past them the dearer of the REST calls and the Bulk API job when the duplicate rules were not read', () => {
    // 600 contacts: a job of twelve calls, or three REST calls should a
    // duplicate rule watch them; the query of the rules besides. Counted 1 + 5.
    expect(seedRequestsEstimate(objects(['Account', 150], ['Contact', 600]))).toBe(
      1 + (3 + 6 + 3) + 1,
    );
    // 25,000 contacts: 125 REST calls, or jobs of 10,000, 10,000 and 5,000 of
    // 44 calls. Counted 15.
    expect(seedRequestsEstimate(objects(['Contact', 25_000]))).toBe(125 + 1);
  });

  it('lets a seed through, saying so, when the org will not say what it has left', async () => {
    const transport = { request: vi.fn(async () => Promise.reject(new Error('API_DISABLED'))) };
    const gate = await seedStorageGate(transport, SALES_CLOUD_STARTER, [], 'my-dev-org');
    expect(gate.refusal).toBeUndefined();
    expect(gate.check).toMatchObject({ verdict: 'unread', unread: 'API_DISABLED' });
    expect(gate.api).toMatchObject({ verdict: 'unread', unread: 'API_DISABLED' });
  });
});

describe('seedFitBudgetOf', () => {
  it('fits to what the gate read of the target, with no read more, its own requests leaving a tenth of the day', async () => {
    const transport = limits(5, 5, { Max: 15_000, Remaining: 2_000 });
    const gate = await seedStorageGate(transport, SALES_CLOUD_STARTER, [], 'my-dev-org');

    const budget = seedFitBudgetOf(gate);
    expect(transport.request).toHaveBeenCalledTimes(1);
    expect(budget).toEqual({
      bytes: Math.floor(0.8 * (5 - 0.5) * MB),
      terms: { remainingMB: 5, maxMB: 5, share: 0.8, roundingMB: 0.5, limitedBy: 'storage' },
      runRequests: 2_000 - 1_500,
    });
    expect(seedFitBudgetOf(gate, 1)).toMatchObject({
      bytes: 1 * MB,
      terms: { withinMB: 1, limitedBy: 'within' },
    });
  });

  it('leaves room in the requests for the checkpoint taken first, which a fit does not scale', async () => {
    const gate = await seedStorageGate(
      limits(5, 5, { Max: 15_000, Remaining: 2_000 }),
      SALES_CLOUD_STARTER,
      [],
      'my-dev-org',
      {
        state: 'planned',
        estimate: { records: 38, apiRequests: 68, apiRequestsLeft: 1_932, seconds: 44, bytes: 2e6 },
        objects: ['Account'],
        added: [],
        notHeld: [],
        keepDays: 7,
      },
    );
    expect(seedFitBudgetOf(gate)).toMatchObject({ runRequests: 2_000 - 1_500 - 68 });
  });

  it('has nothing to fit to when the org will not say its storage, and no bound on requests it will not say', async () => {
    const unread = await seedStorageGate(
      { request: vi.fn(async () => Promise.reject(new Error('API_DISABLED'))) },
      SALES_CLOUD_STARTER,
      [],
      'my-dev-org',
    );
    expect(seedFitBudgetOf(unread)).toEqual({ unread: 'API_DISABLED' });

    const noRequests = await seedStorageGate(
      { request: vi.fn(async () => ({ DataStorageMB: { Max: 5, Remaining: 5 } })) },
      SALES_CLOUD_STARTER,
      [],
      'my-dev-org',
    );
    expect(seedFitBudgetOf(noRequests)).toMatchObject({
      bytes: Math.floor(3.6 * MB),
      requestsUnread: expect.any(String),
    });
    expect(seedFitBudgetOf(noRequests)).not.toHaveProperty('runRequests');
  });
});

describe('seedRequestsEstimate', () => {
  const objects = (counts: Record<string, number>) => ({
    objects: Object.entries(counts).map(([objectApiName, recordCount], insertOrder) => ({
      objectApiName,
      recordCount,
      fieldRules: [],
      excludedFields: [],
      insertOrder,
      batchSize: 200,
    })),
  });

  it('counts the reads and the updates of the roles the platform writes with the opportunities, beside their insert', () => {
    // A seed of 300 contacts, 300 opportunities and 300 roles of their
    // contact may link every role to the platform's: two reads of two
    // hundred opportunities' roles and two updates, besides the three Bulk
    // API jobs of twelve calls each, and the query of the rules, it counts.
    const none = rules({ Contact: false, Opportunity: false, OpportunityContactRole: false });
    const job = 3 + 6 + 3;
    expect(seedRequestsEstimate(objects({ Contact: 300, Opportunity: 300 }), none)).toBe(
      job + job + 1,
    );
    expect(
      seedRequestsEstimate(
        objects({ Contact: 300, Opportunity: 300, OpportunityContactRole: 300 }),
        none,
      ),
    ).toBe(job + job + job + 1 + 2 + 2);
  });

  it('counts no such call for roles of opportunities the seed does not write', () => {
    expect(seedRequestsEstimate(objects({ Contact: 10, OpportunityContactRole: 10 }))).toBe(1 + 1);
  });

  it('prices an object a duplicate rule watches by the REST calls the insert sends it in: 600 contacts in 3, 25,000 in 125', () => {
    // The insert sends such an object 200 records a call, however many,
    // after one query of the org's rules. 25,000 were counted 15 requests.
    const watched = rules({ Contact: true });
    expect(seedRequestsEstimate(objects({ Contact: 600 }), watched)).toBe(3 + 1);
    expect(seedRequestsEstimate(objects({ Contact: 25_000 }), watched)).toBe(125 + 1);
  });

  it('prices each slice of an object no rule watches as one Bulk API job over its whole time: 12,000 in jobs of 10,000 and 2,000', () => {
    // A seed writes an object 10,000 records at a time, each slice one job:
    // opened, sent, closed, its state read once closed and every five
    // seconds of its time (37 and 27 seconds), its results read three ways.
    // Counted five a job: ten.
    expect(
      seedRequestsEstimate(objects({ Opportunity: 12_000 }), rules({ Opportunity: false })),
    ).toBe(3 + 9 + 3 + (3 + 7 + 3) + 1);
    // 600 in one job of twelve calls, counted five.
    expect(seedRequestsEstimate(objects({ Opportunity: 600 }), rules({ Opportunity: false }))).toBe(
      3 + 6 + 3 + 1,
    );
  });

  it('takes an object the read of the rules did not name for one a rule may watch', () => {
    const named = rules({ Account: false });
    expect(seedRequestsEstimate(objects({ Contact: 25_000 }), named)).toBe(125 + 1);
    expect(seedRequestsEstimate(objects({ Contact: 600 }), named)).toBe(3 + 6 + 3 + 1);
  });

  it('matches the objects the rules were read for whatever their case', () => {
    expect(seedRequestsEstimate(objects({ Contact: 600 }), rules({ contact: true }))).toBe(3 + 1);
  });

  it('counts the REST calls of the batch size an object is given, fewer than 200 a call', () => {
    const small = {
      objects: objects({ Contact: 600, Account: 150 }).objects.map((o) => ({
        ...o,
        batchSize: 50,
      })),
    };
    expect(seedRequestsEstimate(small, rules({ Contact: true, Account: true }))).toBe(12 + 3 + 1);
  });

  it('counts each partition of a seed the setting partitions as its own insert', () => {
    // Partitions of 5,000: five jobs of 31 seconds, fourteen calls each,
    // where slices of 10,000 make three jobs.
    const partitioned = { duplicateRules: new Map([['Opportunity', false]]), partition: 5_000 };
    expect(seedRequestsEstimate(objects({ Opportunity: 25_000 }), partitioned)).toBe(
      5 * (3 + 8 + 3) + 1,
    );
  });

  it('cuts a wide object into smaller slices, each its own job', () => {
    // 100 rules: 5,000 records a slice, as the run generates them.
    const wide = {
      objects: objects({ Opportunity: 10_000 }).objects.map((o) => ({
        ...o,
        fieldRules: Array.from({ length: 100 }, (_, i) => ({
          fieldApiName: `F${i}__c`,
          fieldType: 'string',
          ruleType: 'static' as const,
          config: { staticValue: 'x' },
        })),
      })),
    };
    expect(seedRequestsEstimate(wide, rules({ Opportunity: false }))).toBe(2 * (3 + 8 + 3) + 1);
  });
});

describe('seedPartitionOf', () => {
  const grappe = { enabled: true, autoActivateThreshold: 10_000, grappeSize: 5_000 };

  it('partitions a seed as the run does: when the setting is on and the seed reaches its threshold', () => {
    expect(seedPartitionOf(grappe, objects(['Contact', 6_000], ['Account', 4_000]))).toBe(5_000);
    expect(seedPartitionOf(grappe, objects(['Contact', 9_999]))).toBeUndefined();
    expect(seedPartitionOf({ ...grappe, enabled: false }, objects(['Contact', 20_000]))).toBe(
      undefined,
    );
    expect(seedPartitionOf(undefined, objects(['Contact', 20_000]))).toBeUndefined();
  });
});

describe('importRequestsEstimate', () => {
  it('prices an import past the threshold as one Bulk API job over its whole time, however many its rows', () => {
    // 25,000 rows in one job of 57 seconds: nineteen calls. Counted 15.
    expect(
      importRequestsEstimate([{ objectApiName: 'Account', rows: 25_000 }], {
        threshold: 200,
        ...rules({ Account: false }),
      }),
    ).toBe(3 + 13 + 3);
  });

  it('counts again by REST every row of an object a duplicate rule watches, which the job may refuse', () => {
    // The writer sends what a rule refused in the job again, 200 a call.
    expect(
      importRequestsEstimate([{ objectApiName: 'Account', rows: 25_000 }], {
        threshold: 200,
        ...rules({ Account: true }),
      }),
    ).toBe(3 + 13 + 3 + 125);
    // Not read, the same.
    expect(
      importRequestsEstimate([{ objectApiName: 'Account', rows: 25_000 }], { threshold: 200 }),
    ).toBe(3 + 13 + 3 + 125);
  });

  it('counts an import of no more than the threshold by REST, the batch size a call', () => {
    expect(
      importRequestsEstimate([{ objectApiName: 'Account', rows: 2 }], { threshold: 200 }),
    ).toBe(1);
    expect(
      importRequestsEstimate([{ objectApiName: 'Account', rows: 200 }], {
        threshold: 200,
        perCall: 50,
      }),
    ).toBe(4);
  });
});
