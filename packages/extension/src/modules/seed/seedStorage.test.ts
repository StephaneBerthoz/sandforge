import { describe, it, expect, vi } from 'vitest';
import { CRM_STARTER, DATA_STORAGE_NOT_TOLD, SALES_CLOUD_STARTER } from '@sandforge/shared';
import type { SeedTemplate } from '@sandforge/shared';
import {
  cloneRequestsEstimate,
  importRequestsEstimate,
  importRunReads,
  seedFitBudgetOf,
  seedPartitionOf,
  seedRequestsEstimate,
  seedRunReads,
  seedWritesEstimate,
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
    // 600 contacts: a job of fourteen calls, or three REST calls should a
    // duplicate rule watch them; the query of the rules besides. Counted 1 + 5.
    expect(seedWritesEstimate(objects(['Account', 150], ['Contact', 600]))).toBe(
      1 + (3 + 8 + 3) + 1,
    );
    // 25,000 contacts: slices of 10,000, 10,000 and 5,000, each the dearer
    // of its REST calls and its job — 50 or 46, 50 or 46, 25 or 29. Counted 15.
    expect(seedWritesEstimate(objects(['Contact', 25_000]))).toBe(50 + 50 + 29 + 1);
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

describe('seedWritesEstimate', () => {
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
    // API jobs of thirteen calls each, and the query of the rules, it counts.
    const none = rules({ Contact: false, Opportunity: false, OpportunityContactRole: false });
    const job = 3 + 7 + 3;
    expect(seedWritesEstimate(objects({ Contact: 300, Opportunity: 300 }), none)).toBe(
      job + job + 1,
    );
    expect(
      seedWritesEstimate(
        objects({ Contact: 300, Opportunity: 300, OpportunityContactRole: 300 }),
        none,
      ),
    ).toBe(job + job + job + 1 + 2 + 2);
  });

  it('counts no such call for roles of opportunities the seed does not write', () => {
    expect(seedWritesEstimate(objects({ Contact: 10, OpportunityContactRole: 10 }))).toBe(1 + 1);
  });

  it('prices an object a duplicate rule watches by the REST calls the insert sends it in: 600 contacts in 3, 25,000 in 125', () => {
    // The insert sends such an object 200 records a call, however many,
    // after one query of the org's rules. 25,000 were counted 15 requests.
    const watched = rules({ Contact: true });
    expect(seedWritesEstimate(objects({ Contact: 600 }), watched)).toBe(3 + 1);
    expect(seedWritesEstimate(objects({ Contact: 25_000 }), watched)).toBe(125 + 1);
  });

  it('prices each slice of an object no rule watches as one Bulk API job over its whole time: 12,000 in jobs of 10,000 and 2,000', () => {
    // A seed writes an object 10,000 records at a time, each slice one job:
    // opened, sent, closed, its state read once closed and every five
    // seconds of its time (about 191 and 57 seconds), its results read three
    // ways. Counted five a job: ten.
    expect(
      seedWritesEstimate(objects({ Opportunity: 12_000 }), rules({ Opportunity: false })),
    ).toBe(3 + 40 + 3 + (3 + 13 + 3) + 1);
    // 600 in one job of fourteen calls, counted five.
    expect(seedWritesEstimate(objects({ Opportunity: 600 }), rules({ Opportunity: false }))).toBe(
      3 + 8 + 3 + 1,
    );
  });

  it('takes an object the read of the rules did not name for one a rule may watch', () => {
    const named = rules({ Account: false });
    // Each slice the dearer of its REST calls and its job.
    expect(seedWritesEstimate(objects({ Contact: 25_000 }), named)).toBe(50 + 50 + 29 + 1);
    expect(seedWritesEstimate(objects({ Contact: 600 }), named)).toBe(3 + 8 + 3 + 1);
  });

  it('matches the objects the rules were read for whatever their case', () => {
    expect(seedWritesEstimate(objects({ Contact: 600 }), rules({ contact: true }))).toBe(3 + 1);
  });

  it('counts the REST calls of the batch size an object is given, fewer than 200 a call', () => {
    const small = {
      objects: objects({ Contact: 600, Account: 150 }).objects.map((o) => ({
        ...o,
        batchSize: 50,
      })),
    };
    expect(seedWritesEstimate(small, rules({ Contact: true, Account: true }))).toBe(12 + 3 + 1);
  });

  it('counts each partition of a seed the setting partitions as its own insert', () => {
    // Partitions of 5,000: five jobs of about 107 seconds, twenty-nine calls
    // each, where slices of 10,000 make three jobs.
    const partitioned = { duplicateRules: new Map([['Opportunity', false]]), partition: 5_000 };
    expect(seedWritesEstimate(objects({ Opportunity: 25_000 }), partitioned)).toBe(
      5 * (3 + 23 + 3) + 1,
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
    expect(seedWritesEstimate(wide, rules({ Opportunity: false }))).toBe(2 * (3 + 23 + 3) + 1);
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
    // 25,000 rows in one job of about 441 seconds: ninety-six calls. Counted 15.
    expect(
      importRequestsEstimate([{ objectApiName: 'Account', rows: 25_000 }], {
        threshold: 200,
        ...rules({ Account: false }),
      }),
    ).toBe(3 + 90 + 3);
  });

  it('counts again by REST every row of an object a duplicate rule watches, which the job may refuse', () => {
    // The writer sends what a rule refused in the job again, 200 a call.
    expect(
      importRequestsEstimate([{ objectApiName: 'Account', rows: 25_000 }], {
        threshold: 200,
        ...rules({ Account: true }),
      }),
    ).toBe(3 + 90 + 3 + 125);
    // Not read, the same.
    expect(
      importRequestsEstimate([{ objectApiName: 'Account', rows: 25_000 }], { threshold: 200 }),
    ).toBe(3 + 90 + 3 + 125);
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

  it("takes an object's own batch size over the import's, and sends nothing of a delete again", () => {
    expect(
      importRequestsEstimate(
        [
          { objectApiName: 'Account', rows: 200, perCall: 25 },
          { objectApiName: 'Contact', rows: 200 },
        ],
        { threshold: 200, perCall: 100 },
      ),
    ).toBe(8 + 2);
    // A delete a duplicate rule may watch: one job, nothing again.
    expect(
      importRequestsEstimate([{ objectApiName: 'Contact', rows: 600, deletes: true }], {
        threshold: 200,
        ...rules({ Contact: true }),
      }),
    ).toBe(3 + 8 + 3);
  });
});

describe('importRunReads', () => {
  it('counts what the CSV import and the clone read of the target from their gate on: its limits, who the run writes as, a describe an object', () => {
    // The gate's read of the limits, again for the requests alone, once for
    // the emails; the API's root and the identity URL.
    expect(importRunReads()).toBe(3 + 2);
    expect(importRunReads(4)).toBe(3 + 2 + 4);
    expect(importRunReads(-1)).toBe(3 + 2);
  });
});

describe('cloneRequestsEstimate', () => {
  const path = { threshold: 200, ...rules({ Account: false, Opportunity: false }) };

  it('counts the second pass: an update of each record of an object written without a lookup, 200 a call', () => {
    const accounts = [{ objectApiName: 'Account', rows: 600 }];
    // One job of fourteen calls, and what the run reads of the target as it
    // writes: its limits, who it writes as, the account's describe.
    expect(cloneRequestsEstimate(accounts, path)).toBe(14 + importRunReads(1));
    // Their parent account filled once they are all in.
    expect(cloneRequestsEstimate(accounts, { ...path, secondPass: new Set(['Account']) })).toBe(
      14 + 3 + importRunReads(1),
    );
  });

  it('counts the reads of the roles the platform wrote with the opportunities, and their updates', () => {
    // 150 opportunities with their roles: one read of their roles, then one
    // REST call to give them the source's fields, besides the two inserts.
    expect(
      cloneRequestsEstimate(
        [
          { objectApiName: 'Opportunity', rows: 150 },
          { objectApiName: 'OpportunityContactRole', rows: 300 },
        ],
        { ...path, ...rules({ Opportunity: false, OpportunityContactRole: false }) },
      ),
    ).toBe(1 + 13 + (1 + 1) + importRunReads(2));
    // No roles to link without opportunities.
    expect(
      cloneRequestsEstimate([{ objectApiName: 'OpportunityContactRole', rows: 300 }], path),
    ).toBe(13 + 2 + importRunReads(1));
  });

  it('counts what it reads of the target as it writes, which its records alone left out', () => {
    // The gate's reads of the limits, who the run writes as — the API's
    // root and the identity URL —, the target's describe of each object,
    // read again as the run writes.
    const two = [
      { objectApiName: 'Account', rows: 2 },
      { objectApiName: 'Contact', rows: 2 },
    ];
    expect(cloneRequestsEstimate(two, path)).toBe(1 + 1 + (3 + 2 + 2));
  });
});

describe('seedRunReads', () => {
  const object = (
    objectApiName: string,
    fieldRules: SeedTemplate['objects'][number]['fieldRules'] = [],
  ) => ({
    objectApiName,
    recordCount: 10,
    fieldRules,
    excludedFields: [],
    insertOrder: 0,
    batchSize: 200,
  });

  /** The target's limits as the run reads them from its gate on, at most. */
  const LIMITS = 3;

  it("counts the reads each run sends as it writes: the org's object list, a describe an object, who it writes as", () => {
    // The object list once, a describe of each, then jsforce's identity:
    // the API's root and the identity URL.
    expect(seedRunReads({ objects: [object('Contact')] })).toBe(1 + 1 + 2 + LIMITS);
    expect(seedRunReads({ objects: [object('Account'), object('Contact')] })).toBe(
      1 + 2 + 2 + LIMITS,
    );
  });

  it('counts the two reads that type the org when the run reads them before it writes, as the command line does', () => {
    expect(seedRunReads({ objects: [object('Contact')] }, { typedFirst: true })).toBe(
      4 + LIMITS + 2,
    );
  });

  it('counts what the command line sent before its gate as it sent it, and the limits the gate reads', () => {
    // Counted live: what the org is, the contact's describe for its fields,
    // five reads of the target's automation; then the gate's read of the
    // limits. A run that typed the org has its reads among those it sent.
    expect(seedRunReads({ objects: [object('Contact')] }, { sentBefore: 7 })).toBe(4 + LIMITS + 7);
    expect(seedRunReads({ objects: [object('Contact')] }, { sentBefore: -3 })).toBe(4 + LIMITS);
  });

  it("counts the user's Marketing User box for a campaign, the parents a relation reads, and the standard price book", () => {
    expect(seedRunReads({ objects: [object('Campaign')] })).toBe(4 + 2 + 1 + LIMITS);
    const ids = Array.from({ length: 450 }, (_, i) => `parent-${i}`);
    const related = {
      objects: [object('Contact'), object('Case')],
      relations: [
        {
          childObject: 'Contact',
          lookupField: 'AccountId',
          parentObject: 'Account',
          parents: { kind: 'existing' as const, limit: 5_000 },
          distribution: { mode: 'perParent' as const, count: 1 },
        },
        {
          childObject: 'Case',
          lookupField: 'AccountId',
          parentObject: 'Account',
          parents: { kind: 'records' as const, ids },
          distribution: { mode: 'perParent' as const, count: 1 },
        },
      ],
    } as Pick<SeedTemplate, 'objects' | 'relations'>;
    // Three pages of 2,000 for 5,000 records the org holds, three queries
    // of 200 ids for 450.
    expect(seedRunReads(related)).toBe(1 + 2 + 2 + 3 + 3 + LIMITS);
    const priced = [
      object('PricebookEntry', [
        {
          fieldApiName: 'Pricebook2Id',
          fieldType: 'reference',
          ruleType: 'reference',
          config: { referenceObject: 'Pricebook2' },
        },
      ]),
    ];
    expect(seedRunReads({ objects: priced })).toBe(4 + 1 + LIMITS);
    // A seed that writes its own price book matches nothing.
    expect(seedRunReads({ objects: [object('Pricebook2'), ...priced] })).toBe(1 + 2 + 2 + LIMITS);
  });
});

describe('seedRequestsEstimate', () => {
  const contacts = (recordCount: number) => ({
    objects: [
      {
        objectApiName: 'Contact',
        recordCount,
        fieldRules: [],
        excludedFields: [],
        insertOrder: 0,
        batchSize: 200,
      },
    ],
  });

  it('prices no less than a seed of 600 contacts under the standard duplicate rule took live, six requests more than its dry run', () => {
    // On a scratch org: three REST calls, the query of the rules, and the
    // two reads that typed the org; counted four. The command line's price,
    // the org typed first, beside the reads both runs send as they write.
    const path = { ...rules({ Contact: true }), typedFirst: true };
    expect(seedWritesEstimate(contacts(600), path)).toBe(3 + 1);
    expect(seedRequestsEstimate(contacts(600), path)).toBe(3 + 1 + (1 + 1 + 2 + 2 + 3));
    expect(seedRequestsEstimate(contacts(600), path)).toBeGreaterThanOrEqual(6);
  });

  it('prices no less than a seed of 12,000 cases no rule watches took live, 42 requests more than its dry run', () => {
    // Two jobs, of 10,000 and 2,000; counted 29, at the cadence of deletes.
    const cases = {
      objects: contacts(12_000).objects.map((o) => ({ ...o, objectApiName: 'Case' })),
    };
    const path = { ...rules({ Case: false }), typedFirst: true };
    expect(seedWritesEstimate(cases, path)).toBe(46 + 19 + 1);
    expect(seedRequestsEstimate(cases, path)).toBeGreaterThanOrEqual(42);
  });

  describe('against every request a seed sent its target, counted call by call on a scratch org', () => {
    /**
     * Each seed as the command line ran it, its `--json` saying what it sent:
     * before its gate — what the org is (a run's alone), the object's
     * describe for its fields, the reads of the target's automation —, then
     * from the gate on — its read of the limits, who it writes as (the API's
     * root and the identity URL), the object list, the describe again, the
     * query of the duplicate rules, and its writes.
     */
    const counted = [
      {
        name: '600 contacts a duplicate rule watches, sent in three REST calls',
        object: 'Contact',
        records: 600,
        watched: true,
        before: { run: 1 + 1 + 5, dryRun: 1 + 5 },
        fromGate: 1 + 2 + 1 + 1 + 1 + 3,
        // Priced ten, where it sent sixteen.
        sent: { run: 16, dryRun: 9 },
        price: { run: 18, dryRun: 19 },
      },
      {
        name: '12,000 cases no rule watches, sent as jobs of 10,000 and 2,000',
        object: 'Case',
        records: 12_000,
        watched: false,
        // Six reads of the automation: a case has assignment rules too.
        before: { run: 1 + 1 + 6, dryRun: 1 + 6 },
        // The job of 10,000 read its state 27 times, the job of 2,000 seven.
        fromGate: 1 + 2 + 1 + 1 + 1 + (3 + 27 + 3) + (3 + 7 + 3),
        // Priced 55, where it sent 60.
        sent: { run: 60, dryRun: 10 },
        price: { run: 81, dryRun: 82 },
      },
      {
        name: '600 cases no rule watches, sent as one job',
        object: 'Case',
        records: 600,
        watched: false,
        before: { run: 1 + 1 + 6, dryRun: 1 + 6 },
        fromGate: 1 + 2 + 1 + 1 + 1 + (3 + 4 + 3),
        // Priced 20, where it sent 24.
        sent: { run: 24, dryRun: 10 },
        price: { run: 30, dryRun: 31 },
      },
    ];

    it.each(counted)('prices $name at no less than it sent', (seed) => {
      const template = {
        objects: contacts(seed.records).objects.map((o) => ({ ...o, objectApiName: seed.object })),
      };
      const ruled = rules({ [seed.object]: seed.watched });
      expect(seed.before.run + seed.fromGate).toBe(seed.sent.run);
      // A run typed the org before its gate, among what it sent.
      const run = seedRequestsEstimate(template, { ...ruled, sentBefore: seed.before.run });
      expect(run).toBe(seed.price.run);
      expect(run).toBeGreaterThanOrEqual(seed.sent.run);
      // A dry run says what a run would send: the reads that type the org
      // beside what it sent itself.
      const dryRun = seedRequestsEstimate(template, {
        ...ruled,
        typedFirst: true,
        sentBefore: seed.before.dryRun,
      });
      expect(dryRun).toBe(seed.price.dryRun);
      expect(dryRun).toBeGreaterThanOrEqual(seed.sent.run);
      expect(dryRun).toBeGreaterThanOrEqual(seed.sent.dryRun);
    });
  });

  it('prices an insert past the threshold the run is given, not past 200 whatever it is', () => {
    const path = rules({ Contact: false });
    // Set to 500, 300 records go by REST; set to 100, 150 go as a job.
    expect(seedWritesEstimate(contacts(300), { ...path, bulkThreshold: 500 })).toBe(2);
    expect(seedWritesEstimate(contacts(150), { ...path, bulkThreshold: 100 })).toBe(3 + 7 + 3 + 1);
    expect(seedWritesEstimate(contacts(150), path)).toBe(1);
  });
});
