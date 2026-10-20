/**
 * Gate: the repository's own scripts and gates are linted.
 *
 * `scripts/`, `docs/` and the root hold the Node modules `node` and
 * `node --test` run, outside every package, so `pnpm -r lint` read none of
 * them; and ESLint, run on them by hand, called every `process` and `console`
 * an undefined name. Ninety-seven such reports hid an unused import and five
 * regular expressions whose runs of spaces nobody could count.
 *
 * Run: node --test scripts/scripts-lint.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** The globs of the root lint, as the script writes them. */
const GLOBS = ['scripts/**/*.mjs', 'docs/**/*.mjs', '*.mjs'];

/** The eslint binary of the workspace. */
function eslintBin() {
  const local = join(root, 'node_modules', '.bin', 'eslint');
  assert.ok(existsSync(local), 'no eslint in the workspace');
  return local;
}

test('the root lint reads the scripts and gates after the packages', () => {
  const lint = rootPkg.scripts.lint;
  assert.match(
    lint,
    /^pnpm -r lint && eslint /,
    `the root lint no longer lints the packages first: ${lint}`,
  );
  for (const glob of GLOBS) {
    assert.ok(lint.includes(`"${glob}"`), `the root lint does not name ${glob}: ${lint}`);
  }
});

test("ESLint gives a script Node's globals", () => {
  const printed = JSON.parse(
    execFileSync(eslintBin(), ['--print-config', 'scripts/trap-bypass.mjs'], {
      cwd: root,
      encoding: 'utf8',
    }),
  );
  for (const name of ['process', 'console', 'Buffer', 'fetch', 'setTimeout']) {
    assert.ok(
      printed.languageOptions?.globals?.[name] !== undefined,
      `ESLint does not know ${name} in a script`,
    );
  }
});

test('the scripts and gates lint clean', () => {
  // Thrown, with ESLint's report, when it finds anything.
  execFileSync(eslintBin(), ['--max-warnings', '0', ...GLOBS], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe',
  });
});
