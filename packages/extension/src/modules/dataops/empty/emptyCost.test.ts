import { describe, expect, it } from 'vitest';
import { deletedForGood, emptyCostOf, passDeletesOf, RECORDS_PER_BULK_BATCH } from './emptyCost';

describe('passDeletesOf', () => {
  it('sends an object’s records to the recycle bin over REST, 200 a call, below 10,000', () => {
    expect(passDeletesOf('Contact', 9_999, 'recycle')).toEqual({
      objectApiName: 'Contact',
      records: 9_999,
      restCalls: 50,
      jobs: [],
      toTheBin: true,
    });
  });

  it('sends them in Bulk API jobs of one size, 50,000 at most, from 10,000', () => {
    expect(passDeletesOf('Contact', 10_000, 'recycle').jobs).toEqual([10_000]);
    expect(passDeletesOf('Contact', 50_500, 'recycle').jobs).toEqual([25_250, 25_250]);
    expect(passDeletesOf('Contact', 120_000, 'recycle')).toMatchObject({
      restCalls: 0,
      jobs: [40_000, 40_000, 40_000],
      toTheBin: true,
    });
  });

  it('never sends a file or a file’s version by a job, however many, and so never deletes one for good: it is not sent', () => {
    expect(passDeletesOf('ContentDocument', 20_000, 'recycle')).toMatchObject({
      restCalls: 100,
      jobs: [],
      toTheBin: true,
    });
    expect(passDeletesOf('ContentDocument', 20, 'hard')).toEqual({
      objectApiName: 'ContentDocument',
      records: 20,
      restCalls: 0,
      jobs: [],
      toTheBin: false,
      notSent: true,
    });
    expect(deletedForGood('ContentDocument')).toBe(false);
    expect(deletedForGood('ContentVersion')).toBe(false);
    expect(deletedForGood('Attachment')).toBe(true);
  });

  it('deleting for good, sends every object by a job, one record as well, and nothing to the recycle bin', () => {
    expect(passDeletesOf('Contact', 1, 'hard')).toEqual({
      objectApiName: 'Contact',
      records: 1,
      restCalls: 0,
      jobs: [1],
      toTheBin: false,
    });
    expect(passDeletesOf('Contact', 0, 'hard')).toMatchObject({ restCalls: 0, jobs: [] });
  });
});

describe('emptyCostOf', () => {
  it('counts the fixed requests, the describes, each pass’s pages of ids, its calls and its jobs, each job by the calls it sends', () => {
    const cost = emptyCostOf({
      mode: 'recycle',
      passes: [
        { objectApiName: 'Account', records: 4 },
        { objectApiName: 'Contact', records: 12_000 },
      ],
      toDraft: 0,
      deleted: 12_004,
    });

    // 3 fixed, 1 call of describes; Account: 1 page, 1 call; Contact: 6
    // pages, one job of 12,000 — opened, sent, closed, its state read 9
    // times over its 40 seconds, its results read 3 ways.
    expect(cost.apiRequests).toBe(3 + 1 + 1 + 1 + 6 + 15);
    expect(cost.seconds).toBeCloseTo(3 * 0.35 + 2.5 + 1 + 0.86 + 6 + 40, 5);
    expect(cost.bulkBatches).toBe(2);
    expect(cost.binRecords).toBe(12_004);
  });

  it('prices setting orders back to Draft: their statuses, their pages, their updates', () => {
    const without = emptyCostOf({ mode: 'recycle', passes: [], toDraft: 0, deleted: 0 });
    const withOrders = emptyCostOf({ mode: 'recycle', passes: [], toDraft: 2_001, deleted: 0 });

    expect(withOrders.apiRequests - without.apiRequests).toBe(1 + 2 + 11);
  });

  it('deleting for good costs a job, its wait and a batch per object, and puts nothing in the recycle bin', () => {
    const passes = [
      { objectApiName: 'Account', records: 4 },
      { objectApiName: 'Contact', records: 6 },
    ];
    const recycle = emptyCostOf({ mode: 'recycle', passes, toDraft: 0, deleted: 10 });
    const hard = emptyCostOf({ mode: 'hard', passes, toDraft: 0, deleted: 10 });

    expect(recycle.bulkBatches).toBe(0);
    expect(hard.bulkBatches).toBe(2);
    expect(hard.apiRequests).toBeGreaterThan(recycle.apiRequests);
    // Two jobs, each waiting its turn some 24 seconds, where two REST calls went.
    expect(hard.seconds - recycle.seconds).toBeCloseTo(2 * 24 + (4 + 6) / 750 - 2 * 0.86, 5);
    expect(recycle.binRecords).toBe(10);
    expect(hard.binRecords).toBe(0);
  });

  it('prices nothing of a file asked to be deleted for good, which is not sent', () => {
    const without = emptyCostOf({ mode: 'hard', passes: [], toDraft: 0, deleted: 0 });
    const files = emptyCostOf({
      mode: 'hard',
      passes: [{ objectApiName: 'ContentDocument', records: 30 }],
      toDraft: 0,
      deleted: 30,
    });

    // The one call of describes is the pass's; nothing else is sent for it.
    expect(files.apiRequests - without.apiRequests).toBe(1);
    expect(files.binRecords).toBe(0);
    expect(files.passes[0].notSent).toBe(true);
  });

  it('weighs the requests against what the org has left today, and says when it did not say', () => {
    const passes = [{ objectApiName: 'Contact', records: 2_000 }];
    const base = { mode: 'recycle' as const, passes, toDraft: 0, deleted: 2_000 };

    expect(emptyCostOf({ ...base, apiBudget: { max: 15_000, remaining: 10 } }).api.verdict).toBe(
      'exceeds',
    );
    expect(emptyCostOf({ ...base, apiBudget: { max: 15_000, remaining: 1_500 } }).api.verdict).toBe(
      'near',
    );
    expect(
      emptyCostOf({ ...base, apiBudget: { max: 15_000, remaining: 14_000 } }).api.verdict,
    ).toBe('fits');
    expect(emptyCostOf({ ...base, apiBudget: { unread: 'not told' } }).api).toMatchObject({
      verdict: 'unread',
      unread: 'not told',
    });
  });

  it('weighs the Bulk API batches against the org’s day only when it sends a job, and says when the org did not say them', () => {
    const rest = emptyCostOf({
      mode: 'recycle',
      passes: [{ objectApiName: 'Contact', records: 10 }],
      toDraft: 0,
      deleted: 10,
    });
    const jobs = emptyCostOf({
      mode: 'recycle',
      passes: [{ objectApiName: 'Contact', records: 30_000 }],
      toDraft: 0,
      deleted: 30_000,
      bulkBatches: { max: 15_000, remaining: 2 },
    });
    const untold = emptyCostOf({
      mode: 'hard',
      passes: [{ objectApiName: 'Contact', records: 10 }],
      toDraft: 0,
      deleted: 10,
    });

    expect(rest.batches).toBeUndefined();
    expect(jobs.bulkBatches).toBe(30_000 / RECORDS_PER_BULK_BATCH);
    expect(jobs.batches?.verdict).toBe('exceeds');
    expect(untold.batches).toMatchObject({ verdict: 'unread', estimate: 1 });
  });

  it('says when the recycle bin would take more than Salesforce documents it keeps: 25 records per MB of data storage', () => {
    const base = {
      mode: 'recycle' as const,
      passes: [{ objectApiName: 'Contact', records: 200 }],
      toDraft: 0,
    };

    expect(emptyCostOf({ ...base, deleted: 126, dataStorageMB: 5 }).bin).toEqual({
      documentedCapacity: 125,
      past: true,
    });
    expect(emptyCostOf({ ...base, deleted: 125, dataStorageMB: 5 }).bin?.past).toBe(false);
    expect(emptyCostOf({ ...base, deleted: 125 }).bin).toBeUndefined();
  });
});
