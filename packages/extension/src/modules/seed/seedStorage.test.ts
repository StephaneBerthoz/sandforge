import { describe, it, expect, vi } from 'vitest';
import { CRM_STARTER, SALES_CLOUD_STARTER } from '@sandforge/shared';
import { seedStorageBytes, seedStorageGate } from './seedStorage';

const KB = 1024;
const MB = 1024 * KB;

/** An org that says it has `remaining` of `max` MB of data storage left. */
function limits(max: number, remaining: number) {
  return {
    request: vi.fn(async () => ({ DataStorageMB: { Max: max, Remaining: remaining } })),
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
    });
  });

  it('lets a seed through, saying so, when the org will not say what it has left', async () => {
    const transport = { request: vi.fn(async () => Promise.reject(new Error('API_DISABLED'))) };
    const gate = await seedStorageGate(transport, SALES_CLOUD_STARTER, [], 'my-dev-org');
    expect(gate.refusal).toBeUndefined();
    expect(gate.check).toMatchObject({ verdict: 'unread', unread: 'API_DISABLED' });
  });
});
