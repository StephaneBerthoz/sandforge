import { describe, expect, it } from 'vitest';
import {
  deletedForGood,
  emptyCostOf,
  passDeletesOf,
  pricedWithReads,
  RECORDS_PER_BULK_BATCH,
} from './emptyCost';

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
  it('counts a read of the org twice, the dry run’s and its run’s, then each pass’s pages of ids, its count of what was made since, its calls and its jobs, each job by the calls it sends', () => {
    const cost = emptyCostOf({
      mode: 'recycle',
      passes: [
        { objectApiName: 'Account', records: 4 },
        { objectApiName: 'Contact', records: 12_000 },
      ],
      toDraft: 0,
      deleted: 12_004,
      reads: 40,
    });

    // 40 reads twice, each after its connection's check (2), the org's
    // connect once (3); Account: 1 page, 1 count, 1 call; Contact: 6 pages, 1
    // count, one job of 12,000 — opened, sent, closed, its state read 9
    // times over its 40 seconds, its results read 3 ways. Then 5% for what
    // the org's answers make vary, rounded up.
    const counted = 2 * 40 + (2 * 2 + 3) + (1 + 1 + 1) + (6 + 1 + 15);
    expect(cost.apiRequests).toBe(counted + Math.ceil(counted * 0.05));
    expect(cost.requests).toEqual({
      reads: 40,
      readings: 2,
      passes: 3 + 22,
      margin: 6,
      connecting: 7,
    });
    // The run's time: its own read of the org, and its passes.
    expect(cost.seconds).toBeCloseTo(40 * 0.35 + (1 + 0.35 + 0.86) + (6 + 0.35 + 40), 5);
    expect(cost.bulkBatches).toBe(2);
    expect(cost.binRecords).toBe(12_004);
  });

  it('says more than the deletes alone: a dry run of 10,207 contacts read 153 requests, where the deletes priced 25', () => {
    const base = {
      mode: 'recycle' as const,
      passes: [{ objectApiName: 'Contact', records: 10_207 }],
      toDraft: 0,
      deleted: 10_207,
    };
    const deletesAlone = emptyCostOf({ ...base, reads: 0 });
    const read = emptyCostOf({ ...base, reads: 153 });

    expect(deletesAlone.apiRequests).toBeLessThan(153);
    expect(read.apiRequests).toBeGreaterThanOrEqual(2 * 153 + deletesAlone.apiRequests);
  });

  it('prices setting orders back to Draft: their statuses, their pages, their updates; and the read of those going along', () => {
    const base = { mode: 'recycle' as const, passes: [], deleted: 0, reads: 0 };
    const without = emptyCostOf({ ...base, toDraft: 0 });
    const withOrders = emptyCostOf({ ...base, toDraft: 2_001 });
    const along = emptyCostOf({ ...base, toDraft: 2_001, draftReads: 1 });

    // Statuses, 2 pages, 11 updates, and 11 reads back once the passes are through.
    expect(withOrders.requests.passes - without.requests.passes).toBe(1 + 2 + 11 + 11);
    expect(along.requests.passes - withOrders.requests.passes).toBe(1);
  });

  it('prices what the org refuses at first, sent again and read back once the rest has gone, 200 a call each', () => {
    const base = {
      mode: 'recycle' as const,
      passes: [{ objectApiName: 'Account', records: 7 }],
      toDraft: 0,
      deleted: 7,
      reads: 0,
    };

    expect(
      emptyCostOf({ ...base, refused: [1, 201] }).requests.passes -
        emptyCostOf(base).requests.passes,
    ).toBe(2 * 1 + 2 * 2);
  });

  it('deleting for good costs a job, its wait and a batch per object, and puts nothing in the recycle bin', () => {
    const passes = [
      { objectApiName: 'Account', records: 4 },
      { objectApiName: 'Contact', records: 6 },
    ];
    const recycle = emptyCostOf({ mode: 'recycle', passes, toDraft: 0, deleted: 10, reads: 0 });
    const hard = emptyCostOf({ mode: 'hard', passes, toDraft: 0, deleted: 10, reads: 0 });

    expect(recycle.bulkBatches).toBe(0);
    expect(hard.bulkBatches).toBe(2);
    expect(hard.apiRequests).toBeGreaterThan(recycle.apiRequests);
    // Two jobs, each waiting its turn some 24 seconds, where two REST calls went.
    expect(hard.seconds - recycle.seconds).toBeCloseTo(2 * 24 + (4 + 6) / 750 - 2 * 0.86, 5);
    expect(recycle.binRecords).toBe(10);
    expect(hard.binRecords).toBe(0);
  });

  it('prices nothing of a file asked to be deleted for good, which is not sent', () => {
    const without = emptyCostOf({ mode: 'hard', passes: [], toDraft: 0, deleted: 0, reads: 0 });
    const files = emptyCostOf({
      mode: 'hard',
      passes: [{ objectApiName: 'ContentDocument', records: 30 }],
      toDraft: 0,
      deleted: 30,
      reads: 0,
    });

    // Nothing is sent for it, its ids not even read.
    expect(files.apiRequests).toBe(without.apiRequests);
    expect(files.binRecords).toBe(0);
    expect(files.passes[0].notSent).toBe(true);
  });

  it('weighs the requests against what the org has left today, and says when it did not say', () => {
    const passes = [{ objectApiName: 'Contact', records: 2_000 }];
    const base = { mode: 'recycle' as const, passes, toDraft: 0, deleted: 2_000, reads: 0 };

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
      reads: 0,
    });
    const jobs = emptyCostOf({
      mode: 'recycle',
      passes: [{ objectApiName: 'Contact', records: 30_000 }],
      toDraft: 0,
      deleted: 30_000,
      reads: 0,
      bulkBatches: { max: 15_000, remaining: 2 },
    });
    const untold = emptyCostOf({
      mode: 'hard',
      passes: [{ objectApiName: 'Contact', records: 10 }],
      toDraft: 0,
      deleted: 10,
      reads: 0,
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
      reads: 0,
    };

    expect(emptyCostOf({ ...base, deleted: 126, dataStorageMB: 5 }).bin).toEqual({
      documentedCapacity: 125,
      past: true,
    });
    expect(emptyCostOf({ ...base, deleted: 125, dataStorageMB: 5 }).bin?.past).toBe(false);
    expect(emptyCostOf({ ...base, deleted: 125 }).bin).toBeUndefined();
  });
});

describe('pricedWithReads', () => {
  const cost = emptyCostOf({
    mode: 'recycle',
    passes: [{ objectApiName: 'Contact', records: 400 }],
    toDraft: 0,
    deleted: 400,
    reads: 30,
    apiBudget: { max: 15_000, remaining: 14_000 },
  });

  it('prices a dry run on the reads it sent as counted, its own and its run’s', () => {
    const priced = pricedWithReads(cost, 153, 2);
    const counted = 2 * 153 + 7 + cost.requests.passes;

    expect(priced.apiRequests).toBe(counted + Math.ceil(counted * 0.05));
    expect(priced.requests).toEqual({
      reads: 153,
      readings: 2,
      passes: cost.requests.passes,
      margin: Math.ceil(counted * 0.05),
      connecting: 7,
    });
    expect(priced.api).toMatchObject({ verdict: 'fits', estimate: priced.apiRequests });
    expect(priced.seconds - cost.seconds).toBeCloseTo((153 - 30) * 0.35, 5);
  });

  it('holds a run to its own read alone, the dry run’s spent, against what the org had left', () => {
    const run = pricedWithReads(cost, 153, 1);
    const tight = pricedWithReads(
      { ...cost, api: { verdict: 'fits', estimate: 0, max: 15_000, remaining: 155 } },
      153,
      1,
    );

    expect(run.requests).toMatchObject({ reads: 153, readings: 1, connecting: 2 + 3 });
    expect(run.apiRequests).toBeLessThan(pricedWithReads(cost, 153, 2).apiRequests - 140);
    expect(tight.api.verdict).toBe('exceeds');
  });

  it('counts the lease of the mute the run holds while it deletes, beside its reads and passes: the requests it sends were counted as sent, and the estimate said less', () => {
    const muted = pricedWithReads(cost, 153, 2, 9);
    const quiet = pricedWithReads(cost, 153, 2);
    const counted = 2 * 153 + 7 + cost.requests.passes + 9;

    expect(muted.apiRequests).toBe(counted + Math.ceil(counted * 0.05));
    expect(muted.apiRequests - quiet.apiRequests).toBeGreaterThanOrEqual(9);
    expect(muted.requests.mute).toBe(9);
    expect(quiet.requests).not.toHaveProperty('mute');
  });
});
