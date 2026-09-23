/**
 * Gate: jsforce reaches the extension only through its lazy boundary.
 *
 * The activation bundle keeps jsforce and its dependency cluster out of the
 * path VS Code runs at startup: `core/connection/jsforceEntry.ts` is built as
 * a file of its own, and the bundler leaves `./jsforceEntry.js` external. The
 * external rule matches that specifier as written, so it holds only for an
 * import made from `core/connection` by that name. A real-time handler that
 * imported `../../core/connection/jsforceEntry.js` from `bridge/handlers`
 * put all of jsforce back in the activation bundle — 1 014 kB became
 * 2 479 kB — and every unit test still passed: the source resolves the same
 * file either way.
 *
 * Run: node --test scripts/jsforce-lazy-boundary.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'packages', 'extension', 'src');
const BOUNDARY_DIR = join(SRC, 'core', 'connection');

/** Every source file of the extension, tests left out. */
function sourceFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

/** The source with its comments blanked, so a mention in prose is not an import. */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Where a file loads jsforce itself, or the boundary by a name the bundler keeps in. */
function boundaryBreaches(file, source) {
  const code = withoutComments(source);
  const found = [];
  const rel = relative(root, file);
  if (file === join(BOUNDARY_DIR, 'jsforceEntry.ts')) return found;
  // A value import of jsforce anywhere else bundles it; a type import does not.
  for (const match of code.matchAll(
    /^\s*import\s+(?!type\b)[^;]*?from\s+['"]jsforce(?:\/[^'"]*)?['"]/gm,
  )) {
    found.push(`${rel}: imports jsforce itself — ${match[0].trim()}`);
  }
  for (const match of code.matchAll(
    /(?:import\s*\(|from\s+|require\s*\()\s*['"]([^'"]*jsforceEntry(?:\.js)?)['"]/g,
  )) {
    const specifier = match[1];
    const kept = dirname(file) === BOUNDARY_DIR && specifier === './jsforceEntry.js';
    if (!kept) found.push(`${rel}: loads the boundary as '${specifier}'`);
  }
  return found;
}

test('nothing outside the boundary loads jsforce, and the boundary is loaded by its external name', () => {
  const files = sourceFiles(SRC);
  // Positive control: the walk reads the files that use the boundary properly.
  const helper = readFileSync(join(BOUNDARY_DIR, 'ConnectionHelper.ts'), 'utf8');
  assert.ok(
    helper.includes("import('./jsforceEntry.js')"),
    'ConnectionHelper.ts no longer loads ./jsforceEntry.js — re-point this gate',
  );
  const breaches = files.flatMap((file) => boundaryBreaches(file, readFileSync(file, 'utf8')));
  assert.deepEqual(
    breaches,
    [],
    'jsforce would be bundled into the activation path: load it through a helper in ' +
      'core/connection (getJsforceConnection, connectionAnnouncing).',
  );
});

test('the rule catches an import of the boundary from another directory, and a direct import', () => {
  const handler = join(SRC, 'bridge', 'handlers', 'X.ts');
  assert.equal(
    boundaryBreaches(
      handler,
      "const { jsforce } = await import('../../core/connection/jsforceEntry.js');",
    ).length,
    1,
  );
  assert.equal(boundaryBreaches(handler, "import jsforce from 'jsforce';").length, 1);
  assert.equal(boundaryBreaches(handler, "import type { Connection } from 'jsforce';").length, 0);
  assert.equal(
    boundaryBreaches(join(BOUNDARY_DIR, 'Y.ts'), "await import('./jsforceEntry.js');").length,
    0,
  );
  assert.equal(
    boundaryBreaches(handler, "// see await import('../../core/connection/jsforceEntry.js')")
      .length,
    0,
  );
});
