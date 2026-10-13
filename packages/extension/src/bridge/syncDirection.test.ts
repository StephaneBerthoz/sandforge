import { describe, it, expect } from 'vitest';
import { syncConfigSavePayloadSchema, syncExecutePayloadSchema } from './validatePayload.js';

/**
 * The orchestrator has one direction branch, `bidirectional`, and every other
 * value writes source to target. A config asking for `target_to_source` ran
 * the opposite way to what it said, into the org the user meant to read from.
 * The modes behave the same way: a full sync and a delta sync exist, so
 * `incremental` and `cdc` would each replay the whole object set while
 * claiming not to. Both are refused before anything runs. A delta sync writes
 * again what its overlap reads twice, which only an upsert or an update does
 * without a second copy, and carries deletions only when it is a delta.
 */

/** Minimal valid sync config as sent by the webview. */
function validSyncConfig(): Record<string, unknown> {
  return {
    id: 'cfg-1',
    name: 'sync-from-ui',
    description: '',
    sourceOrgId: '00DXXXXXXXXXXXXXXX',
    targetOrgId: '00DYYYYYYYYYYYYYYY',
    direction: 'source_to_target',
    mode: 'full',
    objects: [
      {
        objectApiName: 'Account',
        operation: 'insert',
        batchSize: 200,
        fieldMappings: [],
        transformRules: [],
        excludedFields: [],
        addOnFields: [],
        insertOrder: 0,
      },
    ],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** A delta config of one Account object, with deletions when asked. */
function deltaConfig(
  object: Record<string, unknown>,
  propagateDeletes = false,
): Record<string, unknown> {
  const base = validSyncConfig();
  const [account] = base.objects as Array<Record<string, unknown>>;
  return {
    ...base,
    mode: 'delta',
    ...(propagateDeletes ? { propagateDeletes: true } : {}),
    objects: [{ ...account, ...object }],
  };
}

/** First issue message the schema produced for `path`, or '' if it raised none. */
function issueFor(
  result: { success: boolean; error?: { issues: readonly unknown[] } },
  path: string,
): string {
  if (result.success || !result.error) return '';
  const issues = result.error.issues as Array<{ path: Array<string | number>; message: string }>;
  return issues.find((i) => i.path.join('.') === path)?.message ?? '';
}

describe('a sync config may only ask for what the sync does', () => {
  it('sync:execute refuses target_to_source, saying which way the sync writes', () => {
    const config = { ...validSyncConfig(), direction: 'target_to_source' };

    const result = syncExecutePayloadSchema.safeParse({ config });

    expect(result.success).toBe(false);
    expect(issueFor(result, 'config.direction')).toContain('target_to_source');
    expect(issueFor(result, 'config.direction')).toContain('source to target');
  });

  it('sync:config:save refuses target_to_source', () => {
    const config = { ...validSyncConfig(), direction: 'target_to_source' };

    expect(syncConfigSavePayloadSchema.safeParse({ config }).success).toBe(false);
  });

  it.each(['incremental', 'cdc'])('refuses mode %j', (mode) => {
    const result = syncExecutePayloadSchema.safeParse({ config: { ...validSyncConfig(), mode } });

    expect(result.success).toBe(false);
    expect(issueFor(result, 'config.mode')).toContain(mode);
    expect(issueFor(result, 'config.mode')).toContain('full');
  });

  it.each(['upsert', 'update'])('accepts a delta sync of an object written by %s', (operation) => {
    const config = deltaConfig({ operation, externalIdField: 'Ext_Id__c' }, true);

    const result = syncConfigSavePayloadSchema.safeParse({ config });

    expect(result.success).toBe(true);
    expect(result.data?.config).toMatchObject({ mode: 'delta', propagateDeletes: true });
  });

  it.each([
    ['insert', 'create a second copy'],
    ['delete', 'delete a record already gone'],
  ])('refuses a delta sync of an object written by %s', (operation, why) => {
    const result = syncExecutePayloadSchema.safeParse({ config: deltaConfig({ operation }) });

    expect(result.success).toBe(false);
    expect(issueFor(result, 'config.objects.0.operation')).toContain(why);
    expect(issueFor(result, 'config.objects.0.operation')).toContain('upsert on an External ID');
  });

  it('refuses deletions on a full sync, which has no point to look for them from', () => {
    const config = { ...validSyncConfig(), propagateDeletes: true };

    const result = syncExecutePayloadSchema.safeParse({ config });

    expect(result.success).toBe(false);
    expect(issueFor(result, 'config.propagateDeletes')).toContain('delta sync only');
  });

  it('refuses deletions where no source field is carried onto the key', () => {
    const config = deltaConfig(
      {
        operation: 'upsert',
        externalIdField: 'Ext_Id__c',
        fieldMappings: [{ sourceField: 'Name', targetField: 'Ext_Id__c', type: 'constant' }],
      },
      true,
    );

    const result = syncExecutePayloadSchema.safeParse({ config });

    expect(result.success).toBe(false);
    expect(issueFor(result, 'config.objects.0')).toContain('no source field is carried');
  });

  it('sync:config:save refuses a mode the sync cannot run', () => {
    const config = { ...validSyncConfig(), mode: 'incremental' };

    const result = syncConfigSavePayloadSchema.safeParse({ config });

    expect(result.success).toBe(false);
    expect(issueFor(result, 'config.mode')).toContain('incremental');
  });

  it.each([syncExecutePayloadSchema, syncConfigSavePayloadSchema])(
    'refuses conflictStrategy "manual", naming the strategies that are acted on',
    (schema) => {
      const config = { ...validSyncConfig(), conflictStrategy: 'manual' };

      const result = schema.safeParse({ config });

      expect(result.success).toBe(false);
      expect(issueFor(result, 'config.conflictStrategy')).toContain('Manual conflict review');
      expect(issueFor(result, 'config.conflictStrategy')).toContain('newest wins');
    },
  );

  it.each(['source_wins', 'target_wins', 'newest_wins', 'merge'])(
    'accepts conflictStrategy %j',
    (conflictStrategy) => {
      const config = { ...validSyncConfig(), conflictStrategy };

      expect(syncExecutePayloadSchema.safeParse({ config }).success).toBe(true);
    },
  );

  it.each(['source_to_target', 'bidirectional'])('accepts direction %j', (direction) => {
    const config = { ...validSyncConfig(), direction };

    expect(syncExecutePayloadSchema.safeParse({ config }).success).toBe(true);
  });
});
