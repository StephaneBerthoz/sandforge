import { describe, it, expect } from 'vitest';
import { syncConfigSavePayloadSchema, syncExecutePayloadSchema } from './validatePayload.js';

/**
 * The orchestrator has one direction branch, `bidirectional`, and every other
 * value writes source to target. A config asking for `target_to_source` ran
 * the opposite way to what it said, into the org the user meant to read from.
 * The modes behave the same way: only a full sync exists, so `incremental`,
 * `delta` and `cdc` would each replay the whole object set while claiming not
 * to. Both are refused before anything runs.
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
        operation: 'upsert',
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

  it.each(['incremental', 'delta', 'cdc'])('refuses mode %j', (mode) => {
    const result = syncExecutePayloadSchema.safeParse({ config: { ...validSyncConfig(), mode } });

    expect(result.success).toBe(false);
    expect(issueFor(result, 'config.mode')).toContain(mode);
    expect(issueFor(result, 'config.mode')).toContain('full');
  });

  it.each(['source_to_target', 'bidirectional'])('accepts direction %j', (direction) => {
    const config = { ...validSyncConfig(), direction };

    expect(syncExecutePayloadSchema.safeParse({ config }).success).toBe(true);
  });
});
