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
    // Insert: these cases are about the SHAPE of the field name. The rule about
    // when a key is required has its own block at the bottom.
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
    'the bridge accepts the field name %j',
    (externalIdField) => {
      const parsed = syncObjectPayloadSchema.safeParse(createConfig({ externalIdField }));

      expect(parsed.success).toBe(true);
    },
  );

  it('still accepts an object with no external id', () => {
    expect(syncObjectPayloadSchema.safeParse(createConfig()).success).toBe(true);
  });
});

/**
 * An upsert needs a key the TARGET org can match on.
 *
 * The writer fell back to `Id` whenever none was named, so Quick Sync and ten
 * built-in templates ran as "upsert on Id": a record id issued by the source
 * org, which the target has never seen, on a payload that does not even carry
 * it — `Id` cannot be created, so the auto-mapper never maps it. Not one of
 * those runs could match a record. Two cases here used to assert the opposite:
 * that the bridge accepts `Id` as the upsert key, and that an upsert with no
 * key at all is fine.
 */
describe('an upsert is refused without a key the target org issued', () => {
  it('refuses an upsert with no external id', () => {
    const parsed = syncObjectPayloadSchema.safeParse(createConfig({ operation: 'upsert' }));

    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0].message).toContain('External ID');
  });

  it('refuses an upsert on Id', () => {
    const parsed = syncObjectPayloadSchema.safeParse(
      createConfig({ operation: 'upsert', externalIdField: 'Id' }),
    );

    expect(parsed.success).toBe(false);
  });

  it('refuses an upsert whose key box was left empty', () => {
    // '' is preprocessed to undefined, so this is the "no key" case arriving
    // from a box the user never filled in.
    const parsed = syncObjectPayloadSchema.safeParse(
      createConfig({ operation: 'upsert', externalIdField: '' }),
    );

    expect(parsed.success).toBe(false);
  });

  it('accepts an upsert on a real external id', () => {
    const parsed = syncObjectPayloadSchema.safeParse(
      createConfig({ operation: 'upsert', externalIdField: 'Ext_Id__c' }),
    );

    expect(parsed.success).toBe(true);
  });

  it.each(['insert', 'update', 'delete'] as const)('lets %s run with no key', (operation) => {
    expect(syncObjectPayloadSchema.safeParse(createConfig({ operation })).success).toBe(true);
  });
});
