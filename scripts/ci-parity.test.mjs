/**
 * Gate: every gate in `pnpm validate` must also run in CI.
 *
 * This exists because the drift already happened, twice over. Commit 4a66ffb
 * ("run the gates the sweep wrote — four of them were never executed") added
 * `test:docs`, `test:gates`, `audit:orphans` and `audit:test-siblings` to the
 * `validate` script — and CI does not call `validate`, it spells its own list
 * out. So the four gates carried on not running, and the commit that fixed
 * "these never execute" shipped without executing them.
 *
 * A comment saying "keep these in sync" is what was there before. This is the
 * version that fails.
 *
 * Run: node --test scripts/ci-parity.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const ciYaml = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');

/**
 * Script names invoked as `pnpm <name>` in a script body.
 *
 * `pnpm run x`, `pnpm x` and `pnpm -r x` all count; `pnpm --filter y x` does
 * not, because that targets one package rather than naming a root gate.
 */
const pnpmTargets = (body) => {
  const names = new Set();
  for (const m of body.matchAll(/pnpm\s+(?:run\s+|-r\s+)?([a-z][a-z0-9]*(?::[a-z0-9-]+)?)\b/g)) {
    const name = m[1];
    if (name === 'run' || name === 'exec' || name === 'install') continue;
    names.add(name);
  }
  return names;
};

/** Gates whose CI coverage is deliberately provided by a different step. */
const COVERED_ELSEWHERE = new Map([
  // `validate` ends with a build; CI builds in the per-OS matrix step.
  ['build', 'Validate (typecheck + test + build)'],
  ['build:shared', 'Validate (typecheck + test + build)'],
  ['typecheck', 'Validate (typecheck + test + build)'],
  ['test', 'Validate (typecheck + test + build)'],
]);

test('every gate in `validate` is executed by CI', () => {
  const validate = pkg.scripts.validate;
  assert.ok(validate, 'root package.json has no `validate` script');

  const missing = [];
  for (const gate of pnpmTargets(validate)) {
    if (COVERED_ELSEWHERE.has(gate)) {
      assert.ok(
        ciYaml.includes(COVERED_ELSEWHERE.get(gate)),
        `\`${gate}\` is documented as covered by the CI step ` +
          `"${COVERED_ELSEWHERE.get(gate)}", and that step no longer exists`,
      );
      continue;
    }
    if (!new RegExp(`pnpm\\s+${gate.replace(':', '\\:')}\\b`).test(ciYaml)) {
      missing.push(gate);
    }
  }

  assert.deepEqual(
    missing,
    [],
    `these gates run in \`pnpm validate\` but never in CI: ${missing.join(', ')}. ` +
      `Add them to .github/workflows/ci.yml, or move them out of \`validate\` — ` +
      `a gate that only the author's machine runs is not a gate.`,
  );
});

test('every script CI invokes actually exists in package.json', () => {
  // The mirror failure: CI referencing a gate that was renamed or deleted.
  // A missing script makes pnpm exit non-zero, so this would surface in CI
  // anyway — but only for whoever can run CI, which is the whole problem.
  const declared = new Set(Object.keys(pkg.scripts));
  const unknown = [];
  for (const m of ciYaml.matchAll(
    /pnpm\s+((?:test|audit|check|lint|build|sync)(?::[a-z0-9-]+)?)\b/g,
  )) {
    if (!declared.has(m[1])) unknown.push(m[1]);
  }

  assert.deepEqual(
    [...new Set(unknown)],
    [],
    `CI invokes scripts that package.json does not define: ${[...new Set(unknown)].join(', ')}`,
  );
});
