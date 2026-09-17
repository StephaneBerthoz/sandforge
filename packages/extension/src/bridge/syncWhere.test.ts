import { describe, it, expect } from 'vitest';
import type { SyncObjectConfig } from '@sandforge/shared';
import { syncObjectPayloadSchema, whereClauseSchema } from './validatePayload.js';
import { SfdmuImporter } from '../modules/migration/SfdmuImporter.js';

/**
 * A sync object's `where` is appended after `WHERE` in the read sent to the
 * source org. The fragment used to be checked for four DML keywords only, so a
 * filter that went on to end the statement — `LIMIT 1`, `FOR UPDATE` — was
 * accepted, cut the read short, and the run still reported itself complete.
 * An SFDMU export the user did not write carries this field verbatim.
 */

/** WHERE fragments that go on past the filter and change what the read returns. */
const HOSTILE_WHERE = [
  // Truncates the read: one record copied, sync reported complete.
  'Id != null LIMIT 1',
  // Skips the head of the object.
  'Id != null OFFSET 100',
  // Locks the rows it returned in the source org.
  'Id != null FOR UPDATE',
  // Reorders then truncates.
  'Name != null ORDER BY Name LIMIT 5',
  // Aggregation turns the read into something else.
  'Id != null GROUP BY Name',
  // Reads deleted and archived rows too.
  'Id != null ALL ROWS',
  // Security clause appended after the filter.
  'Id != null WITH SECURITY_ENFORCED',
  // Statement separator and comment markers.
  "Name = 'a'; Id != null",
  'Id != null -- trailing',
  'Id != null /* note */',
  // A closing parenthesis that escapes the grouping a builder wraps it in.
  "Name = 'a') OR (Id != null",
  // An unterminated literal swallows whatever the builder appends.
  "Name = 'a",
  // Subqueries and DML stay refused.
  'Id IN (SELECT AccountId FROM Contact)',
  "Name = 'x' DELETE",
] as const;

/** Filters that only filter, including literals that spell a refused keyword. */
const HONEST_WHERE = [
  "Status = 'Delete pending'",
  "Name = 'Select Comfort' AND Type != 'Update LIMIT 1'",
  "Description LIKE '%; -- /* for update */%'",
  "Name = 'O\\'Brien (Ltd)'",
  'CreatedDate > 2024-01-01T00:00:00Z AND (Amount > -5 OR Amount = null)',
  'Delete_Flag__c = false AND Order__c != null',
  '',
] as const;

function createConfig(overrides?: Partial<SyncObjectConfig>): SyncObjectConfig {
  return {
    objectApiName: 'Account',
    operation: 'insert',
    fieldMappings: [],
    transformRules: [],
    excludedFields: [],
    addOnFields: [],
    batchSize: 200,
    insertOrder: 1,
    ...overrides,
  };
}

describe('a sync object may only filter with its WHERE clause', () => {
  it.each(HOSTILE_WHERE)('the bridge refuses where %j', (where) => {
    expect(syncObjectPayloadSchema.safeParse(createConfig({ where })).success).toBe(false);
    expect(whereClauseSchema.safeParse(where).success).toBe(false);
  });

  it.each(HONEST_WHERE)('the bridge accepts where %j', (where) => {
    expect(syncObjectPayloadSchema.safeParse(createConfig({ where })).success).toBe(true);
  });

  it('refuses an SFDMU export whose where carries more than a filter', async () => {
    const exportJson = JSON.stringify({
      objects: [
        {
          query: 'SELECT Id, Name FROM Account',
          operation: 'Upsert',
          objectName: 'Account',
          externalId: 'Name',
          where: 'Id != null LIMIT 1',
        },
      ],
    });
    const importer = new SfdmuImporter({ readFile: async () => exportJson });

    const config = await importer.import('/workspace/export.json');

    expect(config.objects[0].where).toBe('Id != null LIMIT 1');
    expect(syncObjectPayloadSchema.safeParse(config.objects[0]).success).toBe(false);
  });
});
