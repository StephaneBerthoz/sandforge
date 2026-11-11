import { describe, expect, it } from 'vitest';

import {
  BULK_RESULT_READS,
  FORGE_BULK_POLL_SCHEDULE,
  bulkJobRequests,
  bulkJobSeconds,
  bulkJobStateReads,
} from './bulkJobCost.js';

describe('bulkJobRequests', () => {
  it('prices a Bulk API job by the calls it sends, as the org counted one live: a job of 200 deletes with two reads of its state cost five', () => {
    // P9, on a scratch org: opened, its CSV sent, closed, its state read
    // twice, its results never read — five of the day's requests, the
    // /limits delta the same.
    expect(bulkJobRequests({ stateReads: 2, resultReads: 0 })).toBe(5);
    // A job read back once through reads its results three ways.
    expect(BULK_RESULT_READS).toBe(3);
    expect(bulkJobRequests({ stateReads: 2 })).toBe(8);
  });
});

describe('bulkJobSeconds', () => {
  it('takes a job for its wait in the org, then 750 records a second', () => {
    expect(bulkJobSeconds(0)).toBe(24);
    expect(bulkJobSeconds(12_000)).toBe(24 + 16);
    // A count below nothing is no record, never a job quicker than its wait.
    expect(bulkJobSeconds(-5)).toBe(24);
  });
});

describe('bulkJobStateReads', () => {
  it('reads the state of a job once as it is closed, then once every five seconds of its time, as Seed and Sync poll', () => {
    // 24 seconds of waiting, then 750 records a second: 12,000 take 40.
    expect(bulkJobStateReads(12_000)).toBe(1 + 8);
    expect(bulkJobStateReads(50_000)).toBe(1 + Math.ceil((24 + 50_000 / 750) / 5));
  });

  it('reads a Forge job after five, ten, twenty, then every thirty seconds: fewer reads for a long job', () => {
    expect([0, 1, 2, 3, 4, 10].map(FORGE_BULK_POLL_SCHEDULE)).toEqual([
      5_000, 10_000, 20_000, 30_000, 30_000, 30_000,
    ]);
    // 10,000 rows take some 37 seconds: waits of 5, 10, 20 cover 35, a fourth covers it.
    expect(bulkJobStateReads(10_000, FORGE_BULK_POLL_SCHEDULE)).toBe(1 + 4);
    expect(bulkJobStateReads(10_000)).toBe(1 + 8);
    // 2,000 rows take some 27 seconds: three waits.
    expect(bulkJobStateReads(2_000, FORGE_BULK_POLL_SCHEDULE)).toBe(1 + 3);
  });

  it('never loops on a schedule that waits nothing', () => {
    expect(bulkJobStateReads(0, () => 0)).toBe(1 + 24_000);
  });
});
