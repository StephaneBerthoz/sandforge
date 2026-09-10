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
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const WORKFLOW_DIR = join(root, '.github', 'workflows');
/**
 * A workflow's text with its comments removed.
 *
 * Without this, commenting a step out still counted as running it: `#  pnpm
 * check:screenshots` satisfied both directions of the parity check while the
 * gate ran nowhere. The gate that guards every other gate is the last place
 * that can afford to accept a mention as proof of execution.
 *
 * `#` opens a comment in YAML and in the shell of a `run:` block alike, so
 * cutting from the first unquoted `#` to end of line covers both. Erring
 * toward cutting is safe here: a dropped invocation is reported as missing,
 * which fails loudly, while a kept comment fails silently.
 */
const withoutComments = (yaml) =>
  yaml
    .split('\n')
    .map((line) => {
      let quote = null;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (quote) {
          if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") {
          quote = ch;
        } else if (ch === '#') {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join('\n');

const ciYaml = withoutComments(readFileSync(join(WORKFLOW_DIR, 'ci.yml'), 'utf8'));

/** Workflow files that run on push or pull_request, with their contents. */
const blockingWorkflows = readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith('.yml'))
  .map((file) => ({
    file,
    yaml: withoutComments(readFileSync(join(WORKFLOW_DIR, file), 'utf8')),
  }))
  .filter(({ yaml }) => /^\s+(push|pull_request):/m.test(yaml.slice(0, yaml.indexOf('jobs:'))));

/**
 * Every blocking workflow's text, concatenated.
 *
 * "Runs in CI" is not "appears in ci.yml": `format:check` and `knip` block
 * every push from their own workflow files. Checking only ci.yml reported
 * both as ungated the moment `validate` started running them.
 */
const blockingYaml = blockingWorkflows.map(({ yaml }) => yaml).join('\n');

/**
 * Blocking gates that deliberately do not belong in a local `validate`.
 *
 * `version` is pnpm's own subcommand in a setup step, not a repo gate.
 */
const NOT_LOCALLY_RUNNABLE = new Set(['version']);

/**
 * Blocking gates satisfied by a strictly stronger gate in `validate`.
 *
 * Not exemptions — substitutions. `test:coverage` runs every test `test`
 * runs and then enforces thresholds on top; `format:check` is the read-only
 * half of `format`, which the workflow runs to annotate a PR rather than to
 * decide it. If the right-hand gate ever leaves `validate`, the left-hand one
 * is reported missing again.
 */
const SUBSUMED_BY = new Map([
  ['test', 'test:coverage'],
  ['format', 'format:check'],
]);

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
    if (!new RegExp(`pnpm\\s+${gate.replace(':', '\\:')}\\b`).test(blockingYaml)) {
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

test('every gate a blocking workflow runs is reachable from `pnpm validate`', () => {
  // The other direction, and the one that shipped a red build. `validate`
  // ran neither `format:check` (its own workflow), nor `knip` (its own
  // workflow), nor `test:coverage` (a CI step). All three are blocking on
  // push, so "validate is green" never meant "CI is green" — and the commit
  // that revived the E2E suite was pushed on exactly that false assurance.
  //
  // Only push/PR workflows count. `release.yml` is dispatch-only and calls
  // `validate` itself; `stryker.yml` is scheduled, and mutation testing is
  // deliberately not part of a local pre-push run.
  const validateGates = pnpmTargets(pkg.scripts.validate);
  const missing = [];

  for (const { file, yaml } of blockingWorkflows) {
    for (const gate of pnpmTargets(yaml)) {
      if (!(gate in pkg.scripts)) continue; // `pnpm install`, `pnpm exec`, …
      if (NOT_LOCALLY_RUNNABLE.has(gate)) continue;
      const stronger = SUBSUMED_BY.get(gate);
      if (stronger && validateGates.has(stronger)) continue;
      if (!validateGates.has(gate)) missing.push(`${gate} (${file})`);
    }
  }

  assert.deepEqual(
    [...new Set(missing)],
    [],
    `these gates block every push but are absent from \`pnpm validate\`: ` +
      `${[...new Set(missing)].join(', ')}. Add them to \`validate\`, or stop ` +
      `blocking on them — a gate you cannot run before pushing is a gate that ` +
      `fails after pushing.`,
  );
});

/**
 * Every workflow file's text, blocking or not.
 *
 * `release.yml` is dispatch-only, so it is deliberately absent from
 * `blockingWorkflows` above — but a gate it runs is still a gate that runs.
 * The sweep below needs "invoked by anything", not "invoked on push".
 */
const allWorkflowYaml = readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith('.yml'))
  .map((file) => readFileSync(join(WORKFLOW_DIR, file), 'utf8'))
  .join('\n');

/**
 * Root scripts reachable from an entry point, following `pnpm <name>` edges.
 *
 * Entry points are the script names a workflow spells out. Everything else is
 * reachable only by being called: `audit:orphans` runs because `validate` runs
 * it and `release.yml` runs `validate`. A script no chain reaches is a script
 * nothing executes.
 */
const reachableScripts = () => {
  const declared = new Set(Object.keys(pkg.scripts));
  const queue = [...pnpmTargets(allWorkflowYaml)].filter((name) => declared.has(name));
  const reached = new Set();
  while (queue.length > 0) {
    const name = queue.pop();
    if (reached.has(name)) continue;
    reached.add(name);
    for (const next of pnpmTargets(pkg.scripts[name])) {
      if (declared.has(next) && !reached.has(next)) queue.push(next);
    }
  }
  return reached;
};

test('every `check:*` / `audit:*` gate is reachable from something that runs', () => {
  // The hole the two tests above leave open, and it was occupied. Those tests
  // compare `validate` against the workflows — both directions — so they only
  // ever see a gate that at least one of the two sides names. `check:links`
  // and `check:screenshots` were named by neither: declared in package.json,
  // called by no script and no workflow. Written, green, never executed, and
  // invisible to the gate whose whole job is catching that.
  //
  // Reachability, not mere mention: a gate wired into a script that itself
  // runs nowhere is still a gate that never runs.
  const gates = Object.keys(pkg.scripts).filter((name) => /^(?:check|audit):/.test(name));
  assert.ok(
    gates.length >= 4,
    `expected the repo's check:*/audit:* gates, found ${gates.length} — ` +
      `the naming convention moved and this sweep is now aimed at nothing`,
  );

  const reached = reachableScripts();
  const unreachable = gates.filter((gate) => !reached.has(gate));

  assert.deepEqual(
    unreachable,
    [],
    `these gates are declared in package.json and invoked by nothing: ` +
      `${unreachable.join(', ')}. Wire each into \`validate\`, into another ` +
      `script a workflow runs, or into a workflow — or delete it. A gate no ` +
      `chain reaches is documentation, not a check.`,
  );
});
