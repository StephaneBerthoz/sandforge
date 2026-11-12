import { describe, expect, it } from 'vitest';
import {
  BULK_RESULT_READS,
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

  it('prices a whole job from its records: 600 take twelve calls, 10,000 fifteen, 25,000 nineteen', () => {
    // 600: 24.8 seconds, five waits. Twelve calls, where a REST write of
    // the same records sends three.
    expect(bulkJobCost(600)).toBe(3 + (1 + 5) + 3);
    // 10,000: 37.3 seconds, eight waits.
    expect(bulkJobCost(10_000)).toBe(3 + (1 + 8) + 3);
    // 25,000 in one job: 57.3 seconds, twelve waits — not three jobs of
    // five calls each.
    expect(bulkJobCost(25_000)).toBe(3 + (1 + 12) + 3);
  });
});
