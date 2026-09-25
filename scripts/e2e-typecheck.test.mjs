/**
 * Gate: the Playwright specs are typechecked.
 *
 * Playwright strips the types from a spec without checking them, and the
 * webview's tsconfigs take in `src/` alone, so nothing read `e2e/` as
 * TypeScript: a spec that read a field no longer there, or passed an argument
 * of the wrong shape, still ran, and failed at run time or passed without
 * checking what it named. The first check of the folder found every axe result
 * typed `any` — the helper imported the type from `axe-core`, a dependency of
 * `@axe-core/playwright` that the webview does not declare, so the import
 * resolved nowhere and nothing that read a result was checked — and an org
 * factory that built orgs without the `tags` the Organizations page reads
 * unguarded.
 *
 * Run: node --test scripts/e2e-typecheck.test.mjs
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webviewDir = join(root, 'packages', 'webview');
const webviewPkg = JSON.parse(readFileSync(join(webviewDir, 'package.json'), 'utf8'));

/** A path under the webview, with forward slashes on every platform. */
const fromWebview = (file) => relative(webviewDir, file).replace(/\\/g, '/');

/** A webview tsconfig as TypeScript reads it: `extends` followed, globs expanded. */
function readTsconfig(name) {
  const file = join(webviewDir, name);
  const { config, error } = ts.readConfigFile(file, ts.sys.readFile);
  assert.ok(!error, `cannot read packages/webview/${name}`);
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, webviewDir, undefined, file);
  const errors = parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  assert.deepEqual(errors, [], `packages/webview/${name} does not parse`);
  return parsed;
}

/**
 * The flags that decide what a type error is. Each is compared, not only
 * `strict`, because any one of them can be turned off under a `strict: true`.
 */
const STRICTNESS = [
  'strict',
  'noImplicitAny',
  'strictNullChecks',
  'strictFunctionTypes',
  'strictBindCallApply',
  'strictPropertyInitialization',
  'strictBuiltinIteratorReturn',
  'noImplicitThis',
  'useUnknownInCatchVariables',
  'alwaysStrict',
  'noImplicitReturns',
  'noUnusedLocals',
  'noUnusedParameters',
  'noFallthroughCasesInSwitch',
  'noUncheckedSideEffectImports',
];

test('the e2e tsconfig takes in every file under e2e/ and the configs the suite runs with', () => {
  const sources = readdirSync(join(webviewDir, 'e2e'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => fromWebview(join(entry.parentPath, entry.name)));
  assert.ok(
    sources.length > 0,
    'no TypeScript under packages/webview/e2e — this gate reads nothing',
  );
  const taken = new Set(readTsconfig('tsconfig.e2e.json').fileNames.map(fromWebview));
  // vite.config.e2e.ts also brings Node's types: `@types/node` is not a
  // dependency of the webview, so `types: ["node"]` resolves nowhere, and the
  // declarations of the Vite it imports reference them.
  const missed = [...sources, 'playwright.config.ts', 'vite.config.e2e.ts'].filter(
    (file) => !taken.has(file),
  );
  assert.deepEqual(missed, [], `tsconfig.e2e.json leaves out ${missed.join(', ')}`);
});

test("the e2e tsconfig holds the specs to the webview's own strictness", () => {
  // A flag turned off is how a type error goes quiet: with noImplicitAny off,
  // the untyped callbacks over axe results that the first check reported
  // would have compiled as they were.
  const webview = readTsconfig('tsconfig.json').options;
  const e2e = readTsconfig('tsconfig.e2e.json').options;
  assert.equal(webview.strict, true, 'the webview tsconfig is no longer strict');
  for (const flag of STRICTNESS) {
    assert.equal(
      e2e[flag],
      webview[flag],
      `tsconfig.e2e.json has ${flag} ${e2e[flag]}, the webview tsconfig ${webview[flag]}`,
    );
  }
});

test('the webview typecheck runs the e2e tsconfig', () => {
  // `pnpm typecheck` is what CI's Validate step and the pre-commit hook run: a
  // tsconfig no script names checks nothing.
  assert.match(webviewPkg.scripts.typecheck, /\btsc\b[^&|;]*\s-p tsconfig\.e2e\.json\b/);
});
