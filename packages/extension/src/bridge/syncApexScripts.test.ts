import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { syncConfigSavePayloadSchema, syncExecutePayloadSchema } from './validatePayload.js';

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
    dryRun: false,
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

describe('a sync config may not carry Apex to run', () => {
  it('sync:execute refuses a config carrying preScript', () => {
    const config = {
      ...validSyncConfig(),
      preScript: 'Database.delete([SELECT Id FROM Account]);',
    };
    const result = syncExecutePayloadSchema.safeParse({ config });

    expect(result.success).toBe(false);
    expect(issueFor(result, 'config.preScript')).toContain('preScript');
    expect(issueFor(result, 'config.preScript')).toContain('Apex');
  });

  it('sync:execute refuses a config carrying postScript', () => {
    const config = { ...validSyncConfig(), postScript: 'System.debug("post");' };
    const result = syncExecutePayloadSchema.safeParse({ config });

    expect(result.success).toBe(false);
    expect(issueFor(result, 'config.postScript')).toContain('postScript');
  });

  it('sync:config:save refuses a config carrying preScript', () => {
    const config = { ...validSyncConfig(), preScript: 'System.debug("pre");' };

    expect(syncConfigSavePayloadSchema.safeParse({ config }).success).toBe(false);
  });

  it('still accepts a config with no script fields', () => {
    expect(syncExecutePayloadSchema.safeParse({ config: validSyncConfig() }).success).toBe(true);
  });

  it('accepts an explicit undefined (a stored config round-tripping through JSON)', () => {
    const config = { ...validSyncConfig(), preScript: undefined, postScript: undefined };

    expect(syncExecutePayloadSchema.safeParse({ config }).success).toBe(true);
  });
});

/** Workspace root (`packages/`), reached from `packages/extension/src/bridge`. */
const PACKAGES_ROOT = join(__dirname, '..', '..', '..');

/** Directories with no hand-written source: build output, deps, tool state. */
const SKIPPED_DIRS = new Set([
  'node_modules',
  'dist',
  'out',
  'webview-dist',
  'coverage',
  'playwright-report',
  'test-results',
  '.omc',
  '.serena',
]);

/** Hand-written source files under `packages/`, tests excluded. */
function productionSources(): string[] {
  const found: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(join(dir, entry.name));
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      found.push(join(dir, entry.name));
    }
  };

  walk(PACKAGES_ROOT);
  return found;
}

describe('no production source runs anonymous Apex', () => {
  it('nothing under packages/ calls executeAnonymous', () => {
    const offenders = productionSources()
      .filter((file) => readFileSync(file, 'utf8').includes('executeAnonymous'))
      .map((file) => relative(PACKAGES_ROOT, file).split(sep).join('/'));

    expect(offenders).toEqual([]);
  });
});
