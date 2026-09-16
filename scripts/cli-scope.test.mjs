/**
 * Gate: the extension's command-line scripts are typechecked and linted.
 *
 * `cli/` and `tools/` live beside `src/`, not inside it, so the extension's
 * tsconfig and `eslint src/` used to read neither: an undeclared constant or a
 * type error in a script surfaced only when someone ran it against a real org.
 * Widening the scope is one line in three files; so is narrowing it again,
 * which is what this gate refuses.
 *
 * Run: node --test scripts/cli-scope.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionDir = join(root, 'packages', 'extension');
const extensionPkg = JSON.parse(readFileSync(join(extensionDir, 'package.json'), 'utf8'));

test('the scripts tsconfig includes cli/ and tools/', () => {
  const tsconfig = JSON.parse(readFileSync(join(extensionDir, 'tsconfig.scripts.json'), 'utf8'));
  assert.ok(Array.isArray(tsconfig.include), 'tsconfig.scripts.json has no include list');
  assert.ok(tsconfig.include.includes('cli/**/*.ts'), 'tsconfig.scripts.json misses cli/**/*.ts');
  assert.ok(
    tsconfig.include.includes('tools/**/*.ts'),
    'tsconfig.scripts.json misses tools/**/*.ts',
  );
});

test('the extension typecheck runs the scripts tsconfig', () => {
  assert.match(extensionPkg.scripts.typecheck, /tsc -p tsconfig\.scripts\.json/);
});

test('the extension lint reads cli/ and tools/', () => {
  const lintArgs = extensionPkg.scripts.lint.split(/\s+/);
  assert.ok(
    lintArgs.includes('cli/'),
    `lint script does not name cli/: ${extensionPkg.scripts.lint}`,
  );
  assert.ok(
    lintArgs.includes('tools/'),
    `lint script does not name tools/: ${extensionPkg.scripts.lint}`,
  );
});

test('the lint rules and typed linting apply to cli/ and tools/', () => {
  const eslintConfig = readFileSync(join(root, 'eslint.config.mjs'), 'utf8');
  for (const glob of ['packages/extension/cli/**/*.ts', 'packages/extension/tools/**/*.ts']) {
    const occurrences = eslintConfig.split(`'${glob}'`).length - 1;
    assert.ok(
      occurrences >= 2,
      `eslint.config.mjs names ${glob} ${occurrences} time(s); the shared rules and the typed-linting block both need it`,
    );
  }
  assert.match(eslintConfig, /\.\/packages\/extension\/tsconfig\.scripts\.json/);
});

/** The eslint binary of the workspace, wherever the install put it. */
function eslintBin() {
  const local = join(extensionDir, 'node_modules', '.bin', 'eslint');
  return existsSync(local) ? local : join(root, 'node_modules', '.bin', 'eslint');
}

test('eslint resolves typed rules for a script file', () => {
  // The assertions above read the config source; this one asks ESLint what it
  // would apply. An `ignores` entry or a later block reordering would leave the
  // globs written where they are and still silence both folders.
  for (const file of ['cli/sandforge-cleanup.ts', 'tools/recipe-forge-grappe.ts']) {
    const printed = execFileSync(eslintBin(), ['--print-config', file], {
      cwd: extensionDir,
      encoding: 'utf8',
    });
    // An ignored file has no configuration at all, and ESLint prints
    // `undefined` for it rather than failing.
    assert.ok(
      printed.trim().startsWith('{'),
      `eslint applies no configuration to ${file}: an ignores entry matches it`,
    );
    const config = JSON.parse(printed);
    assert.equal(
      config.rules['@typescript-eslint/no-explicit-any']?.[0],
      2,
      `no-explicit-any is not an error for ${file}`,
    );
    // A typed rule: it only resolves when the file belongs to a tsconfig.
    assert.equal(
      config.rules['@typescript-eslint/no-floating-promises']?.[0],
      2,
      `typed linting does not reach ${file}`,
    );
    const projects = Object.values(config.languageOptions?.parserOptions?.project ?? {});
    assert.ok(
      projects.some((p) => String(p).endsWith('tsconfig.scripts.json')),
      `${file} is parsed without the scripts tsconfig: ${JSON.stringify(projects)}`,
    );
  }
});
