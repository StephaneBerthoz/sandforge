import { describe, expect, it } from 'vitest';
import { bulkJobCost } from '../../core/engine/bulkJobCost.js';
import { loadRequestsEstimate } from './loadRequests.js';

/**
 * What a load reads of its target besides its records, from its gate on:
 * the three reads of its limits, the two calls of who it writes as.
 */
const RUN_READS = 3 + 2;

describe('the API requests of a Frozen load', () => {
  it('prices each object it inserts as the writer sends it: 200 records a REST call, and a describe and a count of its verification each', () => {
    // 450 contacts: three calls of 200, a describe, three counts of 200 ids.
    // 3 accounts: one call, a describe, one count.
    expect(
      loadRequestsEstimate({
        inserts: [
          { objectApiName: 'Contact', rows: 450 },
          { objectApiName: 'Account', rows: 3 },
        ],
        threshold: 10_000,
      }),
    ).toBe(3 + 1 + 3 + (1 + 1 + 1) + RUN_READS);
  });

  it('prices an object past the Bulk API threshold as one job, and its rows again where a duplicate rule may refuse them', () => {
    const job = bulkJobCost(600);
    const watched = loadRequestsEstimate({
      inserts: [{ objectApiName: 'Contact', rows: 600 }],
      threshold: 200,
      duplicateRules: new Map([['contact', true]]),
    });
    const unwatched = loadRequestsEstimate({
      inserts: [{ objectApiName: 'Contact', rows: 600 }],
      threshold: 200,
      duplicateRules: new Map([['contact', false]]),
    });

    expect(unwatched).toBe(job + 1 + 3 + RUN_READS);
    // The writer sends what the rule refused in the job again by REST, 200 a call.
    expect(watched).toBe(unwatched + 3);
  });

  it("counts a reload's purge of the loads before it, deletes and the records it sets inactive alike, and nothing it would not take", () => {
    const load = { inserts: [{ objectApiName: 'Account', rows: 10 }], threshold: 10_000 };

    expect(
      loadRequestsEstimate({
        ...load,
        purged: [
          { objectApiName: 'Account', rows: 250, deletes: true },
          { objectApiName: 'BusinessHours', rows: 1, deletes: false },
          { objectApiName: 'Contact', rows: 0, deletes: true },
        ],
      }) - loadRequestsEstimate(load),
    ).toBe(2 + 1);
  });

  it('counts the read of the target automation sent just before its gate', () => {
    const load = { inserts: [{ objectApiName: 'Account', rows: 1 }], threshold: 10_000 };

    expect(loadRequestsEstimate({ ...load, automationRead: 5 })).toBe(
      loadRequestsEstimate(load) + 5,
    );
  });

  it('reads nothing of an object the dataset holds no record of', () => {
    expect(
      loadRequestsEstimate({ inserts: [{ objectApiName: 'Case', rows: 0 }], threshold: 10_000 }),
    ).toBe(RUN_READS);
  });
});
