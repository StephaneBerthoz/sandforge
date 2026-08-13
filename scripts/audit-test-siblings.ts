/**
 * Test-sibling ratchet for the extension host (TESTS-08).
 *
 * The repo constraint is "tests are mandatory for behaviour changes", but
 * nothing enforced it, so files carrying live bridge channels and bulk-write
 * logic reached 500 lines with no test at all. This gate makes that state
 * impossible to reach again *silently*: every source file above
 * `LINE_THRESHOLD` must be reachable from a test.
 *
 * A file is considered covered when either
 *   (a) a sibling `<name>.test.ts` exists, or
 *   (b) a `*.test.ts` in the same directory imports it by relative specifier
 *       — the shape `registry.test.ts` uses for `readOnlyTools.ts`, and
 *       `FrozenDatasetLoader.test.ts` for `loadTypes.ts`. Requiring the exact
 *       sibling name there would only produce a bookkeeping file.
 *
 * Everything else must carry an explicit ALLOWLIST entry stating why it is
 * untestable-by-shape (types, constant tables, composition roots). The list
 * is re-validated on every run so it cannot outlive its subjects.
 *
 * Scope is `packages/extension/src` — the tree the finding measured, and the
 * one where an untested file writes to a customer's Salesforce org. The
 * shared and webview trees are dominated by type modules and `.tsx` pages and
 * would need their own thresholds.
 *
 * Run with:  pnpm audit:test-siblings
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

/** Source root this gate walks, relative to the repo root. */
const SRC_ROOT = 'packages/extension/src';

/**
 * Line count above which a file must be reachable from a test. 200 is the
 * value the TESTS-08 measurement used; below it a file is small enough that
 * its callers' tests exercise it incidentally.
 */
const LINE_THRESHOLD = 200;

/**
 * Files above the threshold that no test reaches, each with the reason it is
 * tolerated. Only "untestable by shape" belongs here — a file with behaviour
 * gets a test, not an entry. Every entry is re-checked on each run: a missing
 * file, or one that has since gained a test, fails the gate so the list
 * cannot rot.
 */
const ALLOWLIST: ReadonlyArray<{ path: string; reason: string }> = [
  {
    path: 'packages/extension/src/bridge/templates/anonymizationTemplates.ts',
    reason: 'constant table — one exported array literal, no branches to assert',
  },
  {
    path: 'packages/extension/src/composition/forgeComposition.ts',
    reason:
      'composition root — one function of dynamic imports and late setters, ' +
      'asserted end-to-end by the Forge handler tests rather than in isolation',
  },
];

/** True for a test file — never a subject of this gate. */
function isTestFile(path: string): boolean {
  return /\.test\.ts$/.test(path);
}

/** Every `.ts` file under `dir`, recursively. */
function walkSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkSources(full, out);
      continue;
    }
    if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Line count of a file, matching what `wc -l`-style tooling reports. */
function countLines(absolutePath: string): number {
  return readFileSync(absolutePath, 'utf8').split('\n').length;
}

/**
 * True when a `*.test.ts` sitting in the same directory imports `moduleName`
 * through a relative specifier. Both the `./x.js` (NodeNext) and the bare
 * `./x` forms are in use across the tree, so both are matched.
 */
function importedByNeighbourTest(absolutePath: string): boolean {
  const dir = dirname(absolutePath);
  const name = basename(absolutePath, '.ts');
  const specifiers = [`./${name}.js`, `./${name}'`, `./${name}"`];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.test.ts'))
    .some((entry) => {
      const text = readFileSync(join(dir, entry), 'utf8');
      return specifiers.some((spec) => text.includes(spec));
    });
}

function main(): void {
  const repoRoot = process.cwd();
  const srcDir = resolve(repoRoot, SRC_ROOT);
  if (!existsSync(srcDir)) {
    console.error(`[audit-test-siblings] source root not found: ${SRC_ROOT}`);
    process.exit(1);
  }

  const sources = walkSources(srcDir)
    .filter((path) => !isTestFile(path))
    .filter((path) => !path.endsWith('.d.ts'));

  const uncovered = new Map<string, number>();
  for (const absolute of sources) {
    const lines = countLines(absolute);
    if (lines <= LINE_THRESHOLD) continue;
    if (existsSync(absolute.replace(/\.ts$/, '.test.ts'))) continue;
    if (importedByNeighbourTest(absolute)) continue;
    uncovered.set(relative(repoRoot, absolute).replace(/\\/g, '/'), lines);
  }

  const stale = ALLOWLIST.filter((entry) => !uncovered.has(entry.path));
  if (stale.length > 0) {
    console.error(
      '[audit-test-siblings] stale ALLOWLIST entries — these files are gone, shrank below ' +
        `${LINE_THRESHOLD} lines, or gained a test. Delete them from this script:`,
    );
    for (const entry of stale) {
      console.error(`  ${entry.path}`);
    }
    process.exit(1);
  }
  const allowed = new Set(ALLOWLIST.map((entry) => entry.path));

  const offenders = [...uncovered.entries()]
    .filter(([path]) => !allowed.has(path))
    .sort((a, b) => b[1] - a[1]);

  console.log(
    `[audit-test-siblings] ${sources.length} source file(s) under ${SRC_ROOT}, ` +
      `threshold ${LINE_THRESHOLD} lines.`,
  );

  // Print the tolerated ones on every clean run so the debt stays visible
  // instead of hiding behind a green gate.
  for (const entry of ALLOWLIST) {
    console.log(`[audit-test-siblings] tolerated: ${entry.path} — ${entry.reason}`);
  }

  if (offenders.length === 0) {
    console.log('[audit-test-siblings] every file above the threshold is reachable from a test.');
    return;
  }

  console.error(
    `[audit-test-siblings] ${offenders.length} file(s) above the threshold with no test:`,
  );
  for (const [path, lines] of offenders) {
    console.error(`  ${lines} lines  ${path}`);
  }
  console.error(
    'Add a sibling <name>.test.ts, or import it from a test in the same directory.\n' +
      'If the file is untestable by shape (types, constant table, composition root),\n' +
      'add it to ALLOWLIST in this script with the reason.',
  );
  process.exit(1);
}

main();
