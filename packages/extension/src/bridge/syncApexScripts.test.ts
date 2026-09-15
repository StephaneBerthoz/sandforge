import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { tmpdir } from 'node:os';
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

  it('sync:config:save refuses a config carrying preScript, and says why', () => {
    const config = { ...validSyncConfig(), preScript: 'System.debug("pre");' };
    const result = syncConfigSavePayloadSchema.safeParse({ config });

    expect(result.success).toBe(false);
    expect(issueFor(result, 'config.preScript')).toContain('preScript');
    expect(issueFor(result, 'config.preScript')).toContain('Apex');
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

/**
 * Hand-written source files under `root`, tests excluded.
 *
 * Entries are resolved through `statSync`, which follows links: a symlinked
 * directory is walked like any other (a `Dirent` reports it as a link, not a
 * directory, so it used to be skipped along with every file behind it), and a
 * link whose target is gone is passed over instead of reaching `readFileSync`
 * and failing the run. Directories are keyed on their real path, so a link
 * back to an ancestor cannot loop.
 */
function productionSources(root: string): string[] {
  const found: string[] = [];
  const visited = new Set<string>();

  const walk = (dir: string): void => {
    const real = realpathSync(dir);
    if (visited.has(real)) return;
    visited.add(real);

    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      let stats: Stats;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        if (!SKIPPED_DIRS.has(name)) walk(path);
        continue;
      }
      if (!stats.isFile() || !/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
      found.push(path);
    }
  };

  walk(root);
  return found;
}

/** `files` as `/`-separated paths relative to `root`, sorted. */
function relativeSorted(root: string, files: string[]): string[] {
  return files.map((file) => relative(root, file).split(sep).join('/')).sort();
}

describe('no production source runs anonymous Apex', () => {
  it('nothing under packages/ calls executeAnonymous', () => {
    const offenders = productionSources(PACKAGES_ROOT).filter((file) =>
      readFileSync(file, 'utf8').includes('executeAnonymous'),
    );

    expect(relativeSorted(PACKAGES_ROOT, offenders)).toEqual([]);
  });

  describe('the source walk', () => {
    let scratch: string;

    beforeEach(() => {
      scratch = mkdtempSync(join(tmpdir(), 'sync-apex-walk-'));
    });

    afterEach(() => {
      rmSync(scratch, { recursive: true, force: true });
    });

    it('reads through a symlinked directory, skips a dangling link and does not loop', () => {
      const root = join(scratch, 'root');
      const outside = join(scratch, 'outside');
      mkdirSync(join(root, 'src'), { recursive: true });
      mkdirSync(outside);
      writeFileSync(join(root, 'src', 'real.ts'), 'export {};\n');
      writeFileSync(join(root, 'src', 'real.test.ts'), 'export {};\n');
      writeFileSync(join(outside, 'linked.ts'), 'export {};\n');
      symlinkSync(outside, join(root, 'src', 'linked'), 'dir');
      symlinkSync(root, join(root, 'src', 'loop'), 'dir');
      symlinkSync(join(scratch, 'gone.ts'), join(root, 'src', 'dangling.ts'));

      const found = productionSources(root);

      expect(relativeSorted(root, found)).toEqual(['src/linked/linked.ts', 'src/real.ts']);
      // Every path the walk returns can be read: the scan above calls readFileSync on each.
      expect(() => found.forEach((file) => readFileSync(file, 'utf8'))).not.toThrow();
    });
  });
});
