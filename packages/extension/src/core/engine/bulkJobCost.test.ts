import { describe, expect, it } from 'vitest';
import {
  BULK_RESULT_READS,
  FORGE_BULK_POLL_SCHEDULE,
  bulkJobCost,
  bulkJobRequests,
  bulkJobSeconds,
  bulkJobStateReads,
} from './bulkJobCost.js';

describe('what a Bulk API job costs', () => {
  it('prices a Bulk API job by the calls it sends, as the org counted one live: a job of 200 deletes with two reads of its state cost five', () => {
    // On a scratch org: opened, its CSV sent, closed, its state read twice,
    // its results never read — five of the day's requests, the /limits
    // delta the same.
    expect(bulkJobRequests({ stateReads: 2, resultReads: 0 })).toBe(5);
    // A job read back once through reads its results three ways.
    expect(BULK_RESULT_READS).toBe(3);
    expect(bulkJobRequests({ stateReads: 2 })).toBe(8);
  });

  it('reads the state of a job once as it is closed, then once every five seconds of its time', () => {
    // 24 seconds of waiting, then 750 records a second: 12,000 take 40.
    expect(bulkJobSeconds(12_000)).toBe(40);
    expect(bulkJobStateReads(12_000)).toBe(1 + 8);
    expect(bulkJobStateReads(50_000)).toBe(1 + Math.ceil((24 + 50_000 / 750) / 5));
  });

  it('reads the state of a job that saves its records as long as a slower cadence: 100 records a second after its wait', () => {
    // A delete's cadence stays the rewind's.
    expect(bulkJobSeconds(10_000)).toBeCloseTo(24 + 10_000 / 750);
    expect(bulkJobSeconds(10_000, 'save')).toBe(124);
    expect(bulkJobStateReads(10_000, undefined, 'save')).toBe(1 + 25);
    expect(bulkJobStateReads(2_000, undefined, 'save')).toBe(1 + 9);
  });

  it('prices a whole job from its records as one that saves them: 600 take thirteen calls, 10,000 thirty-two, 25,000 sixty-two', () => {
    // 600: 30 seconds, six waits. Thirteen calls, where a REST write of
    // the same records sends three.
    expect(bulkJobCost(600)).toBe(3 + (1 + 6) + 3);
    // 10,000: 124 seconds, twenty-five waits.
    expect(bulkJobCost(10_000)).toBe(3 + (1 + 25) + 3);
    // 25,000 in one job: 274 seconds, fifty-five waits — not three jobs of
    // five calls each.
    expect(bulkJobCost(25_000)).toBe(3 + (1 + 55) + 3);
  });

  it('prices no less than a seed of 12,000 cases took live: its jobs of 10,000 and 2,000 took about 39 calls, priced 28 at the cadence of deletes', () => {
    // On a scratch org, no duplicate rule on the object: 42 requests more
    // than the dry run, the two reads that typed the org and the query of
    // the rules among them. Priced at the deletes' cadence, the jobs came to
    // 15 and 13.
    expect(
      bulkJobRequests({ stateReads: bulkJobStateReads(10_000) }) +
        bulkJobRequests({ stateReads: bulkJobStateReads(2_000) }),
    ).toBe(28);
    expect(bulkJobCost(10_000) + bulkJobCost(2_000)).toBe(32 + 16);
    expect(bulkJobCost(10_000) + bulkJobCost(2_000)).toBeGreaterThanOrEqual(42);
  });

  it('takes a count below nothing for no record, never a job quicker than its wait', () => {
    expect(bulkJobSeconds(0)).toBe(24);
    expect(bulkJobSeconds(-5)).toBe(24);
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
