import { describe, it, expect } from 'vitest';
import type { SyncObjectConfig } from '@sandforge/shared';
import { syncObjectPayloadSchema } from './validatePayload.js';

/**
 * `externalIdField` is the upsert key handed to Salesforce and the match key of
 * a bidirectional run. It is a field name and nothing else; the Clone and Seed
 * CSV boundaries already said so, the sync boundary accepted any string. An
 * SFDMU composite key (`Name;Parent.Name`) is not something the upsert API can
 * take either, so it is refused here rather than failing inside the job.
 */

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

describe('a sync object upserts on a field name', () => {
  it.each(['Ext__c WHERE', 'E'.repeat(500), 'Name;Parent.Name', 'Ext__c ;'])(
    'the bridge refuses externalIdField %j',
    (externalIdField) => {
      const parsed = syncObjectPayloadSchema.safeParse(createConfig({ externalIdField }));

      expect(parsed.success).toBe(false);
    },
  );

  // The External ID box is shown for every operation and sends what it holds,
  // so a box left empty on an insert arrives as '' and must not stop the run.
  it.each(['', '   '])('treats a blank externalIdField %j as no key', (externalIdField) => {
    const parsed = syncObjectPayloadSchema.safeParse(
      createConfig({ operation: 'insert', externalIdField }),
    );

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.externalIdField).toBeUndefined();
  });

  it.each(['Ext_Id__c', 'ns__Legacy_Key__c', 'Id'])(
    'the bridge accepts externalIdField %j',
    (externalIdField) => {
      const parsed = syncObjectPayloadSchema.safeParse(createConfig({ externalIdField }));

      expect(parsed.success).toBe(true);
    },
  );

  it('still accepts an object with no external id', () => {
    expect(syncObjectPayloadSchema.safeParse(createConfig()).success).toBe(true);
  });
});
