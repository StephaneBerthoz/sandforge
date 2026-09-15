import { describe, it, expect } from 'vitest';
import { syncConfigSavePayloadSchema, syncExecutePayloadSchema } from './validatePayload.js';

/**
 * A sync run always writes to the target org. `dryRun` was declared on the
 * config and read by nothing: a configuration asking for a simulation was
 * accepted and then executed for real, silently. It is refused here rather
 * than dropped, so the request fails instead of the org changing.
 *
 * `dryRun: false` stays legal. Every config SandForge ever wrote carries it
 * with that value — the webview wizard, QuickSync, both importers — and those
 * snapshots are replayed by `sync:history:rerun`. Refusing them would break
 * stored history to forbid what the sync already does.
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

describe('a sync config may not ask for a dry run', () => {
  it('sync:execute refuses a config carrying dryRun: true', () => {
    const config = { ...validSyncConfig(), dryRun: true };

    const result = syncExecutePayloadSchema.safeParse({ config });

    expect(result.success).toBe(false);
    expect(issueFor(result, 'config.dryRun')).toContain('dryRun');
    expect(issueFor(result, 'config.dryRun')).toContain('writes');
  });

  it('sync:config:save refuses a config carrying dryRun: true', () => {
    const config = { ...validSyncConfig(), dryRun: true };

    expect(syncConfigSavePayloadSchema.safeParse({ config }).success).toBe(false);
  });

  it('accepts dryRun: false — every stored config carries it and it is the truth', () => {
    const config = { ...validSyncConfig(), dryRun: false };

    expect(syncExecutePayloadSchema.safeParse({ config }).success).toBe(true);
  });

  it('accepts an explicit undefined (a stored config round-tripping through JSON)', () => {
    const config = { ...validSyncConfig(), dryRun: undefined };

    expect(syncExecutePayloadSchema.safeParse({ config }).success).toBe(true);
  });

  it('still accepts a config with no dryRun field at all', () => {
    expect(syncExecutePayloadSchema.safeParse({ config: validSyncConfig() }).success).toBe(true);
  });
});
