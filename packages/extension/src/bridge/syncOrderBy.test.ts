import { describe, it, expect } from 'vitest';
import type { SyncObjectConfig } from '@sandforge/shared';
import { syncObjectPayloadSchema } from './validatePayload.js';
import { SfdmuImporter } from '../modules/migration/SfdmuImporter.js';

/**
 * `orderBy` travels the same road as `where`: an SFDMU `export.json` the user
 * did not write, converted by `SfdmuImporter`, previewed on the migration
 * page, then posted back on `sync:execute`. The sync read appends it to the
 * query it sends to the source org, so a fragment that is more than a sort
 * would change what that read returns. The boundary refuses anything that is
 * not a field list; the query builder checks again where it becomes text.
 */

/** ORDER BY fragments SOQL accepts and that would change what a read returns. */
const HOSTILE_ORDER_BY = [
  // Truncates the read: only the head of the object comes back.
  'Id ASC LIMIT 1',
  // Locks rows in the source org for the transaction.
  'Id ASC FOR UPDATE',
  // Skips the head of the object.
  'Id ASC LIMIT 200 OFFSET 100',
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

describe('a sync object may only order on a field list', () => {
  it.each(HOSTILE_ORDER_BY)('the bridge refuses orderBy %j', (orderBy) => {
    const parsed = syncObjectPayloadSchema.safeParse(createConfig({ orderBy }));

    expect(parsed.success).toBe(false);
  });

  it.each(['Name', 'Name DESC', 'Account.Owner.Name ASC NULLS LAST', 'CreatedDate ASC, Id DESC'])(
    'the bridge accepts the field list %j',
    (orderBy) => {
      const parsed = syncObjectPayloadSchema.safeParse(createConfig({ orderBy }));

      expect(parsed.success).toBe(true);
    },
  );

  it('refuses an SFDMU export whose orderBy carries more than a field list', async () => {
    const exportJson = JSON.stringify({
      objects: [
        {
          query: 'SELECT Id, Name FROM Account',
          operation: 'Upsert',
          objectName: 'Account',
          externalId: 'Name',
          orderBy: 'Id ASC LIMIT 1',
        },
      ],
    });
    const importer = new SfdmuImporter({ readFile: async () => exportJson });

    const config = await importer.import('/workspace/export.json');

    expect(config.objects[0].orderBy).toBe('Id ASC LIMIT 1');
    expect(syncObjectPayloadSchema.safeParse(config.objects[0]).success).toBe(false);
  });
});
