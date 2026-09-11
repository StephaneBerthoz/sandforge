import { describe, it, expect, vi } from 'vitest';
import type { SyncObjectConfig } from '@sandforge/shared';
import { DeltaDetector } from './DeltaDetector';
import type { DeltaDetectorDeps } from './DeltaDetector';
import { syncObjectPayloadSchema } from '../../bridge/validatePayload';
import { SfdmuImporter } from '../migration/SfdmuImporter';

/**
 * `orderBy` travels the same road as `where`: an SFDMU `export.json` the user
 * did not write, converted by `SfdmuImporter`, previewed on the migration
 * page, then posted back on `sync:execute` and appended to the SOQL the delta
 * read sends to the source org. `where` is re-validated at that boundary;
 * these tests pin that `orderBy` is too, and that the query builder refuses
 * anything that is not a field list.
 */

/** ORDER BY fragments SOQL accepts and that change what the delta read does. */
const HOSTILE_ORDER_BY = [
  // Truncates the delta read: every source record then looks new.
  'Id ASC LIMIT 1',
  // Locks rows in the source org for the transaction.
  'Id ASC FOR UPDATE',
  // Skips the head of the object.
  'Id ASC LIMIT 200 OFFSET 100',
] as const;

function createConfig(overrides?: Partial<SyncObjectConfig>): SyncObjectConfig {
  return {
    objectApiName: 'Account',
    operation: 'upsert',
    fieldMappings: [],
    transformRules: [],
    excludedFields: [],
    addOnFields: [],
    batchSize: 200,
    insertOrder: 1,
    ...overrides,
  };
}

function createDeps(): DeltaDetectorDeps {
  return { query: vi.fn().mockResolvedValue([]) };
}

describe('DeltaDetector — ORDER BY injection', () => {
  describe('bridge boundary', () => {
    it.each(HOSTILE_ORDER_BY)('refuses orderBy %j', (orderBy) => {
      const parsed = syncObjectPayloadSchema.safeParse(createConfig({ orderBy }));

      expect(parsed.success).toBe(false);
    });

    it.each(['Name', 'Name DESC', 'Account.Owner.Name ASC NULLS LAST', 'CreatedDate ASC, Id DESC'])(
      'accepts the field list %j',
      (orderBy) => {
        const parsed = syncObjectPayloadSchema.safeParse(createConfig({ orderBy }));

        expect(parsed.success).toBe(true);
      },
    );
  });

  describe('query build', () => {
    it.each(HOSTILE_ORDER_BY)('never sends %j to the org', async (orderBy) => {
      const deps = createDeps();
      const detector = new DeltaDetector(deps);

      await expect(detector.detect(createConfig({ orderBy }), 'org-1')).rejects.toThrow(
        /ORDER BY/i,
      );
      expect(deps.query).not.toHaveBeenCalled();
    });

    it('still orders on a plain field list', async () => {
      const deps = createDeps();
      const detector = new DeltaDetector(deps);

      await detector.detect(createConfig({ orderBy: 'CreatedDate ASC, Id DESC' }), 'org-1');

      expect(vi.mocked(deps.query).mock.calls[0][1]).toContain('ORDER BY CreatedDate ASC, Id DESC');
    });
  });

  describe('the producer that fills it', () => {
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
});
