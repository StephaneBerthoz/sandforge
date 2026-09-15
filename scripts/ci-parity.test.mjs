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
 * runs — bar the files a package excludes from its coverage run, which the
 * last test below holds `validate` to running another way — and enforces
 * thresholds on top; `format:check` is the read-only
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
  // Left out of the extension's coverage run (see the last test below); CI
  // runs it through `pnpm test` on all three operating systems.
  ['test:correlation', 'Validate (typecheck + test + build)'],
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
  // `validate` itself. `stryker.yml` runs on push, but only when mutated code
  // changes, and it calls Stryker through `pnpm exec` rather than a root
  // script: mutation testing is deliberately not part of a local pre-push run.
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

test('a test left out of a coverage run still runs in `validate`', () => {
  // `validate` runs `test:coverage`, not `test`. A file a package excludes from
  // its coverage run therefore stops running locally at all — unless a script
  // `validate` invokes runs it by name. The correlation gate is excluded
  // because V8 coverage slows its synchronous type-checking pass enough to
  // starve vitest's worker RPC on a two-core runner.
  const validateGates = pnpmTargets(pkg.scripts.validate);
  const dropped = [];
  for (const dir of ['shared', 'extension', 'webview']) {
    const scripts =
      JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8')).scripts ?? {};
    for (const [, glob] of (scripts['test:coverage'] ?? '').matchAll(/--exclude\s+(\S+)/g)) {
      const rerun = Object.entries(scripts).some(
        ([name, body]) =>
          name !== 'test:coverage' && validateGates.has(name) && body.includes(glob),
      );
      if (!rerun) dropped.push(`${dir}: ${glob}`);
    }
  }
  assert.deepEqual(
    dropped,
    [],
    `excluded from a coverage run and run by nothing \`validate\` invokes: ${dropped.join(', ')}`,
  );
});

/** Every workflow file, with and without its comments. */
const workflows = readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith('.yml'))
  .map((file) => {
    const raw = readFileSync(join(WORKFLOW_DIR, file), 'utf8');
    return { file, raw, yaml: withoutComments(raw) };
  });

/** The `uses:` references of a workflow, with the raw line each sits on. */
const actionRefs = ({ raw, yaml }) => {
  const rawLines = raw.split('\n');
  return yaml
    .split('\n')
    .map((line, i) => ({
      match: line.match(/^\s*(?:-\s+)?uses:\s*['"]?([^\s'"]+)/),
      raw: rawLines[i],
    }))
    .filter(({ match }) => match && !match[1].startsWith('./') && !match[1].startsWith('docker://'))
    .map(({ match, raw: line }) => ({ ref: match[1], line }));
};

test('every action a workflow runs is pinned to a commit, with the version it is', () => {
  // A tag is a pointer its owner can move. In release.yml, pnpm/action-setup
  // installs the pnpm binary that later runs `vsce publish` with the
  // Marketplace token in its environment, and every action there runs with a
  // token that can push to the repository: whoever moves the tag runs code in
  // that job. A commit cannot be moved. The trailing `# vX.Y.Z` is what lets a
  // reader, and Dependabot, tell which release the commit is.
  const unpinned = [];
  for (const workflow of workflows) {
    for (const { ref, line } of actionRefs(workflow)) {
      if (!/@[0-9a-f]{40}$/.test(ref) || !/#\s*v\d+(\.\d+){0,2}\s*$/.test(line)) {
        unpinned.push(`${workflow.file}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(
    unpinned,
    [],
    `these actions are not pinned to a full commit SHA followed by \`# vX.Y.Z\`:\n  ` +
      unpinned.join('\n  '),
  );
});

test('the release job runs no action from outside GitHub and pnpm', () => {
  // The job holds a token that can write the repository and, for one step, the
  // Marketplace token. Creating a GitHub release needs neither a third party
  // nor an action: `gh` is on the runner.
  const release = workflows.find(({ file }) => file === 'release.yml');
  assert.ok(release, 'release.yml is gone');
  const foreign = actionRefs(release)
    .map(({ ref }) => ref)
    .filter((ref) => !/^(actions|pnpm)\//.test(ref));
  assert.deepEqual(foreign, [], `release.yml runs third-party actions: ${foreign.join(', ')}`);
});

/**
 * The dispatch inputs a workflow declares, by name, with their `type:`.
 *
 * An input without a type is a string, which is what GitHub assumes too.
 */
const dispatchInputs = (yaml) => {
  const lines = yaml.slice(0, yaml.search(/^jobs:/m)).split('\n');
  const start = lines.findIndex((line) => /^\s+inputs:\s*$/.test(line));
  const inputs = new Map();
  if (start === -1) return inputs;
  const base = lines[start].search(/\S/);
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue;
    const indent = line.search(/\S/);
    if (indent <= base) break;
    const name = line.match(/^\s*([A-Za-z0-9_-]+):\s*$/);
    if (name && (current === null || indent <= current.indent)) {
      current = { name: name[1], indent };
      inputs.set(current.name, 'string');
      continue;
    }
    const type = line.match(/^\s*type:\s*['"]?(\w+)/);
    if (type && current) inputs.set(current.name, type[1]);
  }
  return inputs;
};

/** The text of every `run:` step (or other `key:`, such as `script:`), inline or block. */
const runBodies = (yaml, key = 'run') => {
  const lines = yaml.split('\n');
  const bodies = [];
  lines.forEach((line, i) => {
    const m = line.match(new RegExp(`^(\\s*)(?:-\\s+)?${key}:\\s*(.*)$`));
    if (!m) return;
    if (!/^[|>][-+]?\s*$/.test(m[2])) {
      bodies.push(m[2]);
      return;
    }
    const body = [];
    for (const next of lines.slice(i + 1)) {
      if (next.trim() !== '' && next.search(/\S/) <= m[1].length) break;
      body.push(next);
    }
    bodies.push(body.join('\n'));
  });
  return bodies;
};

/** The input names every `${{ }}` expression in a shell body refers to. */
const interpolatedInputs = (body) => {
  // Any reference inside the expression counts, not only a bare one:
  // `inputs.x || ''` or `format('{0}', inputs.x)` paste the same text.
  const names = [];
  for (const [, expression] of body.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
    for (const [, name] of expression.matchAll(
      /(?<![\w.-])(?:github\.event\.)?inputs\.([A-Za-z0-9_-]+)/g,
    )) {
      names.push(name);
    }
  }
  return names;
};

test('no `run:` step pastes a free-text dispatch input into its shell', () => {
  // `${{ }}` is substituted into the script before the shell parses it, so an
  // input of `"; curl … | sh; "` becomes shell code. A choice, a boolean or a
  // number can only be one of the values the workflow allows; a string can be
  // anything. Strings reach the script through `env:` and a quoted variable.
  // A github-script `script:` block is the same paste, into JavaScript.
  const unsafe = [];
  for (const { file, yaml } of workflows) {
    const inputs = dispatchInputs(yaml);
    for (const body of [...runBodies(yaml), ...runBodies(yaml, 'script')]) {
      for (const name of interpolatedInputs(body)) {
        const type = inputs.get(name) ?? 'string';
        if (!['choice', 'boolean', 'number'].includes(type))
          unsafe.push(`${file}: ${name} (${type})`);
      }
    }
  }
  assert.deepEqual(
    [...new Set(unsafe)],
    [],
    `these free-text inputs are interpolated into a shell or a script: ${[...new Set(unsafe)].join(', ')}. ` +
      `Pass them through the step's env: and quote the variable.`,
  );
});

test('the input check sees an interpolated string input and ignores a choice', () => {
  const planted = [
    'on:',
    '  workflow_dispatch:',
    '    inputs:',
    '      glob:',
    "        description: 'free text'",
    '      level:',
    '        type: choice',
    '        options: [a, b]',
    'jobs:',
    '  x:',
    '    steps:',
    '      - run: |',
    '          echo "${{ github.event.inputs.glob }}"',
    '          echo ${{ inputs.level }}',
    '      - run: echo "${{ inputs.glob }}"',
    '      - uses: actions/github-script@0000000000000000000000000000000000000000 # v8.0.0',
    '        with:',
    '          script: |',
    "            core.info('${{ inputs.glob }}');",
    '        env:',
    '          LEVEL: ${{ inputs.level }}',
  ].join('\n');
  const scripts = runBodies(planted, 'script');
  assert.equal(scripts.length, 1);
  assert.deepEqual(interpolatedInputs(scripts[0]), ['glob']);
  const inputs = dispatchInputs(planted);
  assert.deepEqual(Object.fromEntries(inputs), { glob: 'string', level: 'choice' });
  const bodies = runBodies(planted);
  assert.equal(bodies.length, 2);
  assert.match(bodies[0], /inputs\.glob/);
  assert.match(bodies[0], /inputs\.level/);
  assert.match(bodies[1], /inputs\.glob/);
  assert.deepEqual(interpolatedInputs(bodies[0]), ['glob', 'level']);

  // The same paste, wrapped in an expression rather than bare.
  for (const wrapped of [
    `echo "\${{ inputs.glob || '' }}"`,
    `echo "\${{ github.event.inputs.glob || 'packages/**' }}"`,
    `echo "\${{ format('{0}', inputs.glob) }}"`,
    `echo "\${{ inputs.level == 'a' && inputs.glob }}"`,
  ]) {
    assert.ok(interpolatedInputs(wrapped).includes('glob'), wrapped);
  }
  assert.deepEqual(interpolatedInputs('echo "$GLOB" ${{ matrix.inputs }}'), []);
});

/**
 * What is wrong with a workflow's top-level concurrency settings, or null.
 *
 * A group holds one running and one pending run: a newly queued run cancels
 * the pending one whatever `cancel-in-progress` says. So a group shared by
 * every master push drops the result of any commit that arrives while an
 * earlier run is still going. Only a pull request's runs may share a group;
 * every other run needs a group of its own, which `github.run_id` gives.
 */
const concurrencyProblem = (yaml) => {
  const block = yaml.match(/^concurrency:\s*\n((?:[ \t]+\S.*\n?)+)/m)?.[1] ?? '';
  const group = block.match(/^\s+group:\s*(.+)$/m)?.[1]?.trim() ?? '';
  const cancel = block.match(/^\s+cancel-in-progress:\s*(.+)$/m)?.[1]?.trim() ?? '';
  if (!group) return 'no top-level concurrency group';
  if (!group.includes('github.workflow')) return 'the group is not keyed on github.workflow';
  const shared = group.replace(
    /github\.event_name\s*==\s*'pull_request'\s*&&\s*github\.(?:ref|head_ref)\s*\|\|\s*github\.run_id/,
    '',
  );
  if (shared === group || /github\.(?:ref|head_ref|sha)\b/.test(shared)) {
    return 'runs outside a pull request share a group: key them on github.run_id';
  }
  if (cancel !== "${{ github.event_name == 'pull_request' }}") {
    return 'cancel-in-progress is not limited to pull requests';
  }
  return null;
};

test('every push or pull-request workflow cancels only superseded pull-request runs', () => {
  // Without a group, a run for a commit that a newer push has already replaced
  // goes on to the end: on a pull request that is a 15-minute, three-OS CI run
  // nobody will read. Outside a pull request every run is its own group, so
  // master pushes run side by side as before and each commit gets a result.
  const problems = blockingWorkflows
    .map(({ file, yaml }) => [file, concurrencyProblem(yaml)])
    .filter(([, problem]) => problem)
    .map(([file, problem]) => `${file}: ${problem}`);
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the concurrency check rejects a group that master pushes share', () => {
  const planted = (group, cancel = "${{ github.event_name == 'pull_request' }}") =>
    `on:\n  push:\nconcurrency:\n  group: ${group}\n  cancel-in-progress: ${cancel}\njobs:\n`;
  const perRun =
    "${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.run_id }}";
  assert.equal(concurrencyProblem(planted(perRun)), null);
  assert.match(concurrencyProblem(planted('${{ github.workflow }}-${{ github.ref }}')), /run_id/);
  assert.match(
    concurrencyProblem(planted(`${perRun}-\${{ github.ref }}`)),
    /run_id/,
    'a ref outside the pull-request branch makes pushes share the group again',
  );
  assert.match(concurrencyProblem(planted(perRun, 'true')), /pull requests/);
  assert.match(concurrencyProblem('on:\n  push:\njobs:\n'), /no top-level/);
});
