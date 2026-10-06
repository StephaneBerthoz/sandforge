import { describe, it, expect } from 'vitest';
import type { SyncObjectConfig } from '@sandforge/shared';
import { syncObjectPayloadSchema } from './validatePayload.js';

/**
 * Sync has no file-transfer stage. `Attachment`, `ContentVersion` and
 * `Document` keep their content in a base64 field, which Bulk API 2.0 rejects,
 * so a run with one of them failed past the bulk threshold after writing
 * whatever the REST path had already sent. They are refused by name, with the
 * reason, before a run starts.
 */

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

/** Issue messages the schema produced for `objectApiName`. */
function objectIssues(objectApiName: string): string[] {
  const result = syncObjectPayloadSchema.safeParse(createConfig({ objectApiName }));
  if (result.success) return [];
  return result.error.issues
    .filter((i) => i.path.join('.') === 'objectApiName')
    .map((i) => i.message);
}

describe('a sync may not carry an object whose content is a file', () => {
  it.each(['Attachment', 'ContentVersion', 'Document', 'contentversion', 'ATTACHMENT'])(
    'the bridge refuses %j and says files do not travel',
    (objectApiName) => {
      const issues = objectIssues(objectApiName);

      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain(objectApiName);
      expect(issues[0]).toMatch(/file/i);
    },
  );

  it.each(['Account', 'Document__c', 'Case', 'Opportunity'])(
    'the bridge accepts %j',
    (objectApiName) => {
      expect(syncObjectPayloadSchema.safeParse(createConfig({ objectApiName })).success).toBe(true);
    },
  );
});

/**
 * Sync read a list of its own — users, metadata, files — and accepted every
 * object Forge and Autopilot never copy: a login history, an Apex job, a
 * record's history or sharing rows, the link of a file it does not carry.
 * One list now, Forge's, and the boundary refuses what it names.
 */
describe('a sync may not carry an object no copy writes', () => {
  it.each([
    'ContentDocumentLink',
    'AccountHistory',
    'AccountShare',
    'LoginHistory',
    'AsyncApexJob',
    'BusinessProcess',
    'User',
  ])('the bridge refuses %j and says why', (objectApiName) => {
    const issues = objectIssues(objectApiName);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain(`"${objectApiName}"`);
    expect(issues[0]).toContain('no copy writes it');
    expect(issues[0]).toContain('the sync was not started');
  });
});
