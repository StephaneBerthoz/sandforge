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

/**
 * What a lint script hands ESLint, `--fix` aside: its files, after the
 * recursive run of the packages' own when there is one.
 */
function eslintTargets(script) {
  const own = script.replace(/^pnpm -r lint(?::fix)? && /, '');
  return {
    recursive: own !== script,
    files: own
      .replace(/^eslint /, '')
      .split(' ')
      .filter((word) => word !== '--fix' && word !== ''),
  };
}

/*
 * The root lint read the scripts and gates, and `lint:fix` still ran the
 * packages' alone: a finding `lint` reported there, `lint:fix` left. The
 * webview's `lint:fix` fixed `src/` and none of the end-to-end specs and
 * configurations its `lint` reads.
 */
test('each lint:fix fixes every file its lint reads', () => {
  const manifests = [
    ['package.json', rootPkg],
    ...['shared', 'extension', 'webview'].map((name) => [
      `packages/${name}/package.json`,
      JSON.parse(readFileSync(join(root, 'packages', name, 'package.json'), 'utf8')),
    ]),
  ];
  for (const [file, manifest] of manifests) {
    const { lint, 'lint:fix': fix } = manifest.scripts;
    assert.match(fix ?? '', /--fix$/, `${file}: lint:fix does not end with --fix: ${fix}`);
    assert.deepEqual(eslintTargets(fix), eslintTargets(lint), `${file}: lint:fix reads ${fix}`);
  }
  // The control: the root script as it was refuses.
  assert.notDeepEqual(eslintTargets('pnpm -r lint:fix'), eslintTargets(rootPkg.scripts.lint));
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
