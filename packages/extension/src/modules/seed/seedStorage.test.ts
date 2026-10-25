import { describe, it, expect, vi } from 'vitest';
import { CRM_STARTER, DATA_STORAGE_NOT_TOLD, SALES_CLOUD_STARTER } from '@sandforge/shared';
import { seedRequestsEstimate, seedStorageBytes, seedStorageGate } from './seedStorage';

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

  it('counts a REST call per 200 records, and five calls per Bulk API job past them', () => {
    expect(seedRequestsEstimate(objects(['Account', 150], ['Contact', 600]))).toBe(1 + 5);
    expect(seedRequestsEstimate(objects(['Contact', 25_000]))).toBe(15);
  });

  it('lets a seed through, saying so, when the org will not say what it has left', async () => {
    const transport = { request: vi.fn(async () => Promise.reject(new Error('API_DISABLED'))) };
    const gate = await seedStorageGate(transport, SALES_CLOUD_STARTER, [], 'my-dev-org');
    expect(gate.refusal).toBeUndefined();
    expect(gate.check).toMatchObject({ verdict: 'unread', unread: 'API_DISABLED' });
    expect(gate.api).toMatchObject({ verdict: 'unread', unread: 'API_DISABLED' });
  });
});
