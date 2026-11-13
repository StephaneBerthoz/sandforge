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

  it('reads the state of a job that saves its records as long as a slower cadence: 60 records a second after its wait', () => {
    // A delete's cadence stays the rewind's.
    expect(bulkJobSeconds(10_000)).toBeCloseTo(24 + 10_000 / 750);
    expect(bulkJobSeconds(10_000, 'save')).toBeCloseTo(24 + 10_000 / 60);
    expect(bulkJobStateReads(10_000, undefined, 'save')).toBe(1 + 39);
    expect(bulkJobStateReads(2_000, undefined, 'save')).toBe(1 + 12);
  });

  it('prices a whole job from its records as one that saves them: 600 take fourteen calls, 10,000 forty-six, 25,000 ninety-six', () => {
    // 600: 34 seconds, seven waits. Fourteen calls, where a REST write of
    // the same records sends three.
    expect(bulkJobCost(600)).toBe(3 + (1 + 7) + 3);
    // 10,000: about 191 seconds, thirty-nine waits.
    expect(bulkJobCost(10_000)).toBe(3 + (1 + 39) + 3);
    // 25,000 in one job: about 441 seconds, eighty-nine waits — not three
    // jobs of five calls each.
    expect(bulkJobCost(25_000)).toBe(3 + (1 + 89) + 3);
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
    expect(bulkJobCost(10_000) + bulkJobCost(2_000)).toBe(46 + 19);
    expect(bulkJobCost(10_000) + bulkJobCost(2_000)).toBeGreaterThanOrEqual(42);
  });

  it('prices no job lower than the calls each job of a seed sent, counted call by call on a scratch org', () => {
    // Opened, its CSV sent, closed, its state read as long as it ran, its
    // results read three ways. 10,000 cases: 27 reads of their state over
    // the 142 seconds from its close to its results, where 100 records a
    // second priced 26. 2,000: 7 reads over 33 seconds. 600: 4 over 17.
    const counted = [
      { records: 10_000, sent: 3 + 27 + 3 },
      { records: 2_000, sent: 3 + 7 + 3 },
      { records: 600, sent: 3 + 4 + 3 },
    ];
    for (const { records, sent } of counted) {
      expect(bulkJobCost(records)).toBeGreaterThanOrEqual(sent);
    }
    // The job of 10,000 with the margin the slower cadence leaves it:
    // priced about 191 seconds for the 142 it took.
    expect(bulkJobCost(10_000) - (3 + 27 + 3)).toBe(13);
    expect(bulkJobSeconds(10_000, 'save') / 142).toBeGreaterThan(1.3);
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
