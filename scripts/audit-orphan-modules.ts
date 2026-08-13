/**
 * Orphan-module audit for the webview (DEADCODE-03).
 *
 * Walks the production import graph from the two Vite entry points
 * (`src/main.tsx` and `src/main.sidepanel.tsx`) and reports every module
 * under `packages/webview/src/` that nothing on that graph reaches.
 *
 * Why not knip: its vitest plugin treats `*.test.tsx` as an entry point, so
 * any orphan that still has a test file looks reachable. That is exactly the
 * shape of dead code this repo accumulated — a component nobody renders, kept
 * alive by its own test. This walk ignores test files on purpose: a module is
 * reachable only when *shipping* code imports it.
 *
 * Run with:  pnpm audit:orphans
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/** Webview source root, relative to the repo root. */
const SRC_ROOT = 'packages/webview/src';

/** Production entry points — the two Vite `build.lib.entry` values. */
const ENTRIES = ['main.tsx', 'main.sidepanel.tsx'];

/** Extensions tried, in order, when a specifier carries none. */
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.json'];

/**
 * Files reachable by means the import graph cannot see: type declarations
 * and anything under a test-support directory (helpers imported only by
 * `*.test.tsx`, which is legitimate — they exist to serve tests).
 */
const ALWAYS_REACHABLE = new Set(['vite-env.d.ts']);
const TEST_SUPPORT_DIRS = ['/testing/', '/__mocks__/', '/test-utils/'];

/**
 * Orphans this gate tolerates for now, each with the reason it survived the
 * DEADCODE-03 sweep. These three lost their only consumer in that sweep and
 * are dead too — they stayed because their removal was outside its scope.
 * Every entry must still exist on disk: the run fails on a stale one, so the
 * list cannot quietly outlive its subjects.
 */
const ALLOWLIST: ReadonlyArray<{ path: string; reason: string }> = [
  {
    path: 'packages/webview/src/components/ui/Logo.tsx',
    reason: 'sole consumer LoadingScreen.tsx deleted by DEADCODE-03',
  },
  {
    path: 'packages/webview/src/hooks/useExecutionProgress.ts',
    reason: 'sole consumer ObjectProgressPanel.tsx deleted by DEADCODE-03',
  },
  {
    path: 'packages/webview/src/hooks/useRetryManager.ts',
    reason: 'sole consumer ErrorRecoveryPanel.tsx deleted by DEADCODE-03',
  },
];

/** True for a spec/test/story file — never part of the production graph. */
function isTestFile(path: string): boolean {
  return /\.(test|spec|stories)\.[tj]sx?$/.test(path);
}

/** True for a helper that exists to serve tests rather than the bundle. */
function isTestSupport(path: string): boolean {
  return TEST_SUPPORT_DIRS.some((dir) => path.includes(dir));
}

/** Every source file under `dir`, as repo-relative POSIX paths. */
function walkSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walkSources(full, out);
      continue;
    }
    if (/\.[tj]sx?$/.test(entry)) {
      out.push(full.replace(/\\/g, '/'));
    }
  }
  return out;
}

/**
 * All module specifiers in a file: static imports, `export ... from`, and
 * dynamic `import()`. Only relative and `@/`-aliased ones matter — bare
 * specifiers resolve to node_modules or to the shared package.
 */
function readSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /(?:^|[\s;}])import\s+(?:[\s\S]*?\sfrom\s*)?['"]([^'"]+)['"]/g,
    /(?:^|[\s;}])export\s+[\s\S]*?\sfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const spec = match[1];
      if (spec) specs.push(spec);
    }
  }
  return specs;
}

/** Resolve a specifier from `fromFile` to a repo-relative path, or null. */
function resolveSpecifier(spec: string, fromFile: string, repoRoot: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) {
    base = resolve(repoRoot, SRC_ROOT, spec.slice(2));
  } else if (spec.startsWith('.')) {
    base = resolve(dirname(resolve(repoRoot, fromFile)), spec);
  } else {
    return null;
  }

  const candidates = [
    base,
    ...EXTENSIONS.map((ext) => base + ext),
    ...EXTENSIONS.map((ext) => join(base, 'index' + ext)),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return relative(repoRoot, candidate).replace(/\\/g, '/');
    }
  }
  return null;
}

function main(): void {
  const repoRoot = process.cwd();
  const srcDir = resolve(repoRoot, SRC_ROOT);
  if (!existsSync(srcDir)) {
    console.error(`[audit-orphan-modules] missing source root: ${SRC_ROOT}`);
    process.exit(1);
  }

  // Breadth-first walk from the production entries.
  const reachable = new Set<string>();
  const queue: string[] = ENTRIES.map((entry) => `${SRC_ROOT}/${entry}`);
  for (const entry of queue) {
    if (!existsSync(resolve(repoRoot, entry))) {
      console.error(`[audit-orphan-modules] missing entry point: ${entry}`);
      process.exit(1);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (reachable.has(current)) continue;
    reachable.add(current);

    const source = readFileSync(resolve(repoRoot, current), 'utf8');
    for (const spec of readSpecifiers(source)) {
      const resolved = resolveSpecifier(spec, current, repoRoot);
      if (resolved && resolved.startsWith(SRC_ROOT) && !reachable.has(resolved)) {
        queue.push(resolved);
      }
    }
  }

  const stale = ALLOWLIST.filter((entry) => !existsSync(resolve(repoRoot, entry.path)));
  if (stale.length > 0) {
    console.error('[audit-orphan-modules] stale ALLOWLIST entries — delete them from this script:');
    for (const entry of stale) {
      console.error(`  ${entry.path}`);
    }
    process.exit(1);
  }
  const allowed = new Set(ALLOWLIST.map((entry) => entry.path));

  const orphans = walkSources(srcDir)
    .map((abs) => relative(repoRoot, abs).replace(/\\/g, '/'))
    .filter((path) => !isTestFile(path))
    .filter((path) => !isTestSupport(path))
    .filter((path) => !path.endsWith('.d.ts'))
    .filter((path) => !ALWAYS_REACHABLE.has(path.slice(SRC_ROOT.length + 1)))
    .filter((path) => !allowed.has(path))
    .filter((path) => !reachable.has(path))
    .sort();

  console.log(
    `[audit-orphan-modules] ${reachable.size} module(s) reachable from ${ENTRIES.join(' + ')}.`,
  );

  // Print the tolerated ones on every clean run so the debt stays visible
  // instead of hiding behind a green gate.
  for (const entry of ALLOWLIST) {
    console.log(`[audit-orphan-modules] tolerated orphan: ${entry.path} — ${entry.reason}`);
  }

  if (orphans.length === 0) {
    console.log('[audit-orphan-modules] no orphan modules.');
    return;
  }

  console.error(`[audit-orphan-modules] ${orphans.length} module(s) no production code imports:`);
  for (const orphan of orphans) {
    console.error(`  ${orphan}`);
  }
  console.error(
    'Delete them (with their tests) or import them from a page — a module kept alive\n' +
      'only by its own test ships nothing and rots.',
  );
  process.exit(1);
}

main();
