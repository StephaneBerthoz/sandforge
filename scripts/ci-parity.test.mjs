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
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
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
 * `package` is not a gate either: it produces the VSIX that the pre-publish
 * checks in the same job then judge. Putting it in `validate` would build
 * twice and reach the network on every local run; the artifact and its gates
 * are one command away when packaging is what changed.
 */
const NOT_LOCALLY_RUNNABLE = new Set(['version', 'package']);

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

test('Dependabot proposes no npm update while a manifest takes its version from the catalog', () => {
  // Dependabot's npm updater does not read pnpm's catalog. Its grouped update
  // bumped typescript-eslint, left pnpm-workspace.yaml at `^8` and wrote 8.70.0
  // into the lockfile beside a manifest that still says `catalog:`, so
  // `pnpm install --frozen-lockfile` refused the branch on all three runners
  // ("lockfile: 8.70.0, manifest: catalog:"). Action pins carry no catalog, and
  // keeping them moving is what this config is for.
  const manifests = ['package.json'].concat(
    readdirSync(join(root, 'packages')).map((name) => join('packages', name, 'package.json')),
  );
  const managed = manifests.filter((file) => {
    try {
      return /:\s*"catalog:"/.test(readFileSync(join(root, file), 'utf8'));
    } catch {
      return false;
    }
  });
  const ecosystems = [
    ...withoutComments(readFileSync(join(root, '.github', 'dependabot.yml'), 'utf8')).matchAll(
      /package-ecosystem:\s*['"]?([\w-]+)/g,
    ),
  ].map(([, name]) => name);
  assert.ok(managed.length > 0, 'no manifest reads the catalog, so this gate reads nothing');
  assert.ok(
    !ecosystems.includes('npm'),
    `dependabot.yml updates npm while ${managed.join(', ')} read the catalog`,
  );
  assert.ok(
    ecosystems.includes('github-actions'),
    'dependabot.yml no longer moves the action pins',
  );
});

/**
 * A workflow's steps in order, each with the whole text it owns.
 *
 * Order is what most of the release checks below are about: a guard that runs
 * after the step it guards is not a guard, and the three releases that died in
 * the gallery had already pushed their tag by then. A step opens on its
 * `- name:`, `- uses:` or `- run:` line and owns every line until the next one
 * opens, so a `run:` block travels with the step that spells it out.
 */
const stepsOf = (yaml) => {
  const steps = [];
  let current = null;
  for (const line of yaml.split('\n')) {
    if (/^\s*-\s+(?:name|uses|run):/.test(line)) {
      current = { name: '', body: '' };
      steps.push(current);
    }
    if (!current) continue;
    const name = line.match(/^\s*-?\s*name:\s*(.+)$/);
    if (name) current.name = name[1].trim();
    current.body += `${line}\n`;
  }
  return steps;
};

/** One workflow, with its comments stripped like every other one here. */
const workflow = (file) => {
  const found = workflows.find((entry) => entry.file === file);
  assert.ok(found, `${file} is gone`);
  return found.yaml;
};

/**
 * One job's text, from the line under its key to the next job or the end.
 *
 * A property that has to hold for one job — a history checkout, a job-level
 * condition — is not proven by finding it anywhere in the file: another job
 * carrying the same line kept the check green while the job it was about lost
 * it.
 */
const jobOf = (yaml, job) => {
  const body = yaml.match(
    new RegExp(`^  ${job}:\\n([\\s\\S]*?)(?=^  [\\w-]+:\\n|(?![\\s\\S]))`, 'm'),
  )?.[1];
  assert.ok(body, `the workflow has no ${job} job`);
  return body;
};

test('the release job refuses a commit CI has not passed', () => {
  // `pnpm validate` is not CI: it runs on one operating system and it contains
  // no E2E suite. A dispatch from a commit whose CI run was red therefore
  // bumped, tagged, pushed and published it regardless, because no step in the
  // job ever looked up what CI had concluded about the commit in hand.
  const yaml = workflow('release.yml');
  const steps = stepsOf(yaml);
  const gate = steps.findIndex(
    (step) => /head_sha=\$\{?GITHUB_SHA/.test(step.body) && /conclusion/.test(step.body),
  );
  const bump = steps.findIndex((step) => /bump-version\.sh/.test(step.body));
  assert.ok(gate !== -1, 'no step reads the CI conclusion of the commit being released');
  assert.ok(bump !== -1, 'release.yml no longer bumps the version');
  assert.ok(gate < bump, 'the CI conclusion is read after the bump, too late to stop the release');
  assert.match(
    yaml,
    /permissions:[\s\S]*?actions:\s*read/,
    'the job has no `actions: read`, so the lookup cannot see the workflow run',
  );
  // Reading the conclusion is not refusing on it: a condition that can never
  // hold would look the same to every check above.
  assert.match(
    steps[gate].body,
    /if \[ "\$CONCLUSION" != "success" \]; then[\s\S]*?exit 1/,
    'the step reads the CI conclusion and goes on whatever it says',
  );
  // A commit CI never ran on, or has not finished running on, has no run to
  // read, and the jq fallback is what the comparison then sees. A fallback of
  // "success" releases exactly the commit this step exists to refuse.
  const fallback = steps[gate].body.match(/\.conclusion\s*\/\/\s*"([^"]*)"/)?.[1];
  assert.ok(fallback !== undefined, 'the CI gate has no fallback for a commit with no CI run');
  assert.notEqual(
    fallback,
    'success',
    'a commit with no completed CI run reads as "success" and is released',
  );
  // A gate that is skipped on a bump, allowed to fail, or pointed at another
  // workflow reads a conclusion and stops nothing.
  assert.ok(
    !/continue-on-error/.test(steps[gate].body),
    'the CI gate carries continue-on-error, so a red commit is released all the same',
  );
  const condition = steps[gate].body.match(/^\s*if:\s*(.+)$/m)?.[1]?.trim();
  assert.ok(
    condition === undefined || condition === '${{ !inputs.publish_only }}',
    `the CI gate runs only under \`${condition}\`, so a bump release can skip it`,
  );
  assert.match(
    steps[gate].body,
    /actions\/workflows\/ci\.yml\/runs/,
    'the CI gate reads the conclusion of a workflow other than ci.yml',
  );
});

test('the release commit carries only the files the bump writes', () => {
  // `git add -A` commits whatever else the tree happens to hold at that
  // moment, under a message that says "release": a stray build artifact, a
  // half-finished edit, a lockfile resolved against a different registry.
  const yaml = workflow('release.yml');
  assert.ok(!/git add -A/.test(yaml), 'the release commit is still built with `git add -A`');

  const bumpScript = readFileSync(join(root, 'scripts', 'bump-version.sh'), 'utf8');
  const manifests = bumpScript.match(/^for PKG in (.+); do$/m)?.[1]?.split(/\s+/) ?? [];
  assert.ok(manifests.length > 0, 'bump-version.sh no longer lists the manifests it rewrites');

  const commit = stepsOf(yaml).find((step) => /git commit -m/.test(step.body));
  assert.ok(commit, 'no step commits the bump');
  const expected = [...manifests, 'README.md', 'packages/extension/README.md', 'pnpm-lock.yaml'];
  const missing = expected.filter((file) => !commit.body.includes(file));
  assert.deepEqual(
    missing,
    [],
    `the bump writes these and the commit step never adds them: ${missing.join(', ')}`,
  );
  // The porcelain guard only sees what is left unstaged: a `git add .` or
  // `--all` ahead of it stages everything, and the guard then finds nothing to
  // refuse. Every path any `git add` names has to be one the bump writes.
  const invocations = commit.body.replace(/\\\n/g, ' ').match(/\bgit add\b[^\n]*/g) ?? [];
  assert.ok(invocations.length > 0, 'the commit step stages nothing by name');
  const extra = invocations
    .flatMap((line) => line.replace(/^git add\s*/, '').split(/\s+/))
    .filter((arg) => arg !== '' && !expected.includes(arg));
  assert.deepEqual(
    extra,
    [],
    `the release commit stages more than the files the bump writes: ${extra.join(' ')}`,
  );
  assert.match(
    commit.body,
    /status --porcelain \| grep -v '\^\[MA\] '/,
    'nothing reports a change the bump did not make, so it would ship unnoticed',
  );
  const refusal = commit.body.search(/exit 1/);
  assert.ok(
    refusal !== -1 && refusal < commit.body.indexOf('git commit -m'),
    'a change the bump did not make is reported and then committed all the same',
  );
});

test('the publish is bounded, retried, and confirmed against the Marketplace', () => {
  // Three dispatches in a row, a bump and two publish_only retries of the same
  // version, got an error back from the gallery call — and a Marketplace
  // version is immutable, so a failure that did land the upload
  // looks exactly like one that did not. A bounded attempt, a retry and a
  // query for the version that should now exist are what tell those apart.
  const yaml = workflow('release.yml');
  const steps = stepsOf(yaml);

  const publish = steps.findIndex((step) => /vsce publish/.test(step.body));
  assert.ok(publish !== -1, 'nothing publishes to the Marketplace');
  assert.match(
    steps[publish].body,
    /timeout\s+(?:--kill-after=\d+\s+)?\d+\s+pnpm exec vsce publish/,
    'the publish call has no timeout: a hung gallery burns the whole job',
  );
  // `timeout` signals pnpm, not the upload it started. A child that ignores the
  // signal would still be uploading when the next attempt begins.
  assert.match(
    steps[publish].body,
    /timeout\s+--kill-after=\d+\s+\d+\s+pnpm exec vsce publish/,
    'a timed-out publish attempt is only asked to stop, and can overlap the next one',
  );
  assert.match(
    steps[publish].body,
    /for\s+\w+\s+in\s+1\s+2/,
    'the publish is attempted exactly once',
  );

  const poll = steps.findIndex((step) => /extensionquery/.test(step.body));
  assert.ok(poll !== -1, 'no step asks the Marketplace whether the version is being served');
  assert.ok(poll > publish, 'the Marketplace is queried before the publish that should change it');
  // The poll is what stands between a publish that never landed and a public
  // release: a loop that falls through to success, or a step allowed to fail,
  // undrafts the release for a version the Marketplace does not serve.
  assert.match(
    steps[poll].body,
    /\n\s*done\n\s*echo "::error::[^\n]*\n\s*exit 1\s*$/,
    'the Marketplace poll runs out of attempts without failing the step',
  );
  // Only a version equal to the one being released counts as served: a query
  // that succeeds on any answer undrafts the release for a version that is
  // not there.
  assert.match(
    steps[poll].body,
    /versions\.some\(\(v\) => v\.version === process\.env\.NEW_VERSION\) \? 0 : 1/,
    'the Marketplace poll counts a version as served without comparing it with the one released',
  );
  const undraftStep = steps.findIndex((step) =>
    /gh release edit[\s\S]*--draft=false/.test(step.body),
  );
  for (const [index, label] of [
    [poll, 'the Marketplace poll'],
    [undraftStep, 'the undraft'],
  ]) {
    if (index === -1) continue;
    assert.ok(
      !/continue-on-error/.test(steps[index].body),
      `${label} step carries continue-on-error, so a version never served still goes public`,
    );
    assert.ok(
      !/^\s*if:.*\b(?:always|failure)\(\)/m.test(steps[index].body),
      `${label} step runs after a failed step, so a version never served still goes public`,
    );
  }
  const requestLimit = Number(steps[poll].body.match(/--max-time\s+(\d+)/)?.[1]);
  assert.ok(
    requestLimit > 0,
    'the gallery query has no --max-time: one hung request stalls the loop until the job is killed',
  );

  // The job limit has to hold the worst case, not the usual one: a runner kill
  // mid-poll leaves the tag pushed and the release a draft with no error said.
  // Everything before the publish measured 6.2 minutes on a real release run;
  // eight leaves room for a slower validate.
  const beforePublishSeconds = 8 * 60;
  const attempts = Number(
    steps[publish].body
      .match(/for\s+\w+\s+in\s+([\d\s]+);/)?.[1]
      .trim()
      .split(/\s+/).length,
  );
  const [, killAfter, attemptTimeout] =
    steps[publish].body.match(
      /timeout\s+(?:--kill-after=(\d+)\s+)?(\d+)\s+pnpm exec vsce publish/,
    ) ?? [];
  const attemptLimit = Number(attemptTimeout) + Number(killAfter ?? 0);
  const publishPause = Number(steps[publish].body.match(/sleep\s+(\d+)/)?.[1] ?? 0);
  const polls = Number(steps[poll].body.match(/seq\s+1\s+(\d+)/)?.[1]);
  const pollPause = Number(steps[poll].body.match(/sleep\s+(\d+)/)?.[1] ?? 0);
  const worstSeconds =
    beforePublishSeconds +
    attempts * (attemptLimit + publishPause) +
    polls * (requestLimit + pollPause);
  assert.ok(Number.isFinite(worstSeconds), 'the publish and poll budget could not be read');
  const timeout = Number(yaml.match(/timeout-minutes:\s*(\d+)/)?.[1]);
  assert.ok(
    worstSeconds <= timeout * 60,
    `timeout-minutes is ${timeout} but the worst case adds up to ${Math.ceil(worstSeconds / 60)}: the job dies mid-release`,
  );
});

test('the GitHub Release is drafted before the publish and undrafted after it', () => {
  // The release used to be created after the publish, so a failed publish left
  // the tag on origin with nothing to show for it. Drafted first, the notes
  // exist for whoever picks the release back up by hand; undrafted last, the
  // public release only appears once the Marketplace serves the version.
  const steps = stepsOf(workflow('release.yml'));
  const draft = steps.findIndex((step) => /gh release create[\s\S]*--draft/.test(step.body));
  const publish = steps.findIndex((step) => /vsce publish/.test(step.body));
  const poll = steps.findIndex((step) => /extensionquery/.test(step.body));
  const undraft = steps.findIndex((step) => /gh release edit[\s\S]*--draft=false/.test(step.body));
  assert.ok(draft !== -1, 'the GitHub Release is not created as a draft');
  assert.ok(undraft !== -1, 'nothing publishes the drafted release');
  assert.ok(draft < publish, 'the release is drafted after the publish');
  assert.ok(publish < undraft, 'the release is undrafted before the publish it announces');
  assert.ok(poll !== -1, 'no step asks the Marketplace whether the version is being served');
  assert.ok(poll < undraft, 'the release is undrafted before the Marketplace confirms the version');
});

test('a blocking workflow packages the VSIX and runs the pre-publish gates', () => {
  // The VSIX payload, size and locale gates live in pre-publish-check.sh, which
  // until now ran on release day only. Every one of them fails on a tree that
  // built and tested clean — a missing lazy chunk, a locale bundle the copy
  // step dropped — so release day was the first moment anything looked.
  const job = jobOf(workflow('ci.yml'), 'package');
  const packs = job.search(/pnpm package\b/);
  const gates = job.search(/scripts\/pre-publish-check\.sh/);
  assert.ok(packs !== -1, 'the package job does not package the VSIX');
  assert.ok(gates !== -1, 'the package job does not run the pre-publish gates');
  assert.ok(packs < gates, 'the pre-publish gates run before the VSIX they judge exists');
  // A job that is skipped, or whose failure does not fail the run, packages and
  // gates nothing anyone has to act on.
  assert.ok(!/^    if:/m.test(job), 'the package job runs only under a condition');
  assert.ok(!/continue-on-error/.test(job), 'a failure in the package job does not fail the run');
  // A command whose status is thrown away gates nothing: the step goes green
  // whatever the script found.
  for (const [pattern, label] of [
    [/pnpm package\b[^\n]*/, 'pnpm package'],
    [/scripts\/pre-publish-check\.sh[^\n]*/, 'the pre-publish gates'],
  ]) {
    const line = job.match(pattern)?.[0] ?? '';
    assert.ok(
      !/\|\||;\s*(?:true|:)\b|;\s*:\s*$/.test(line),
      `the package job discards the exit status of ${label}: ${line.trim()}`,
    );
  }
});

test('the pre-publish gates are invoked the way a fresh clone can run them', () => {
  // `scripts/pre-publish-check.sh` is committed without an executable bit, so
  // `./scripts/pre-publish-check.sh` is "Permission denied" on any fresh
  // clone. The workflows run it through `bash`; the contributor guide offers
  // the same command as "the local equivalent", and a command that exits 126
  // is not an equivalent of anything.
  const executable = (statSync(join(root, 'scripts', 'pre-publish-check.sh')).mode & 0o111) !== 0;
  const callers = {
    'CONTRIBUTING.md': readFileSync(join(root, 'CONTRIBUTING.md'), 'utf8'),
    'scripts/pre-publish-check.sh': readFileSync(
      join(root, 'scripts', 'pre-publish-check.sh'),
      'utf8',
    ),
    'ci.yml': readFileSync(join(WORKFLOW_DIR, 'ci.yml'), 'utf8'),
    'release.yml': readFileSync(join(WORKFLOW_DIR, 'release.yml'), 'utf8'),
  };
  for (const [name, text] of Object.entries(callers)) {
    const direct = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('./scripts/pre-publish-check.sh'));
    assert.deepEqual(
      executable ? [] : direct,
      [],
      `${name} runs the pre-publish gates as an executable the clone does not get`,
    );
  }
});

test('the pre-publish gate reads the locale list it checks the VSIX against', () => {
  // The locale gate takes its languages from the extension's own whitelist. If
  // that extraction stops matching, or the check for each bundle goes, a VSIX
  // that ships English only passes the gate that exists to refuse it.
  const script = readFileSync(join(root, 'scripts', 'pre-publish-check.sh'), 'utf8');
  const pattern = script.match(/const codes = \/(.+)\/\.exec\(src\);/)?.[1];
  assert.ok(pattern, 'pre-publish-check.sh no longer extracts the supported locale codes');
  const source = readFileSync(
    join(root, 'packages', 'extension', 'src', 'core', 'i18n', 'localeBundles.ts'),
    'utf8',
  );
  const list = new RegExp(pattern).exec(source)?.[1];
  assert.ok(
    list,
    'the locale extraction in pre-publish-check.sh matches nothing in localeBundles.ts',
  );
  const codes = [...list.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  // Under `set -e` a failing extraction ends the script right there, before
  // the gate can say why or the summary can count it.
  assert.match(
    script,
    /LOCALES=\$\(node -e "[^"]*SUPPORTED_LOCALE_CODES[^"]*" \|\| true\)/,
    'a failed locale extraction exits the script before the gate reports it',
  );
  assert.ok(codes.includes('fr'), `the extracted locale list is wrong: ${codes.join(' ')}`);
  assert.match(
    script,
    /for LNG in \$LOCALES; do[\s\S]*?unzip -l sandforge\.vsix[\s\S]*?webview-dist\/locales\/\$LNG\.json/,
    'the gate reads the locale list and never looks for those bundles in the VSIX',
  );
  // Looking for a bundle is not refusing its absence: a comparison that can
  // never hold lists nothing as missing and passes a VSIX with no translations.
  assert.match(
    script,
    /if \(\( LOCALE_COUNT == 0 \)\); then\s*MISSING_LOCALES="\$MISSING_LOCALES \$LNG"/,
    'the locale gate no longer records a bundle the VSIX lacks as missing',
  );
  assert.match(
    script,
    /if \[\[ -n "\$MISSING_LOCALES" \]\]; then\s*echo "FAIL: VSIX has no locale bundle[^\n]*\n\s*ERRORS=\$\(\(ERRORS \+ 1\)\)/,
    'a missing locale bundle is reported without failing the gate',
  );
});

test('the secret scan reads the whole history, pins what it runs, and redacts what it prints', () => {
  // The repository is public: a key committed and reverted an hour later is
  // still a key anyone can read out of the history. An unpinned scanner is
  // whichever binary the day serves, and a scanner that echoes what it found
  // puts the secret in a build log that outlives the commit.
  const yaml = workflow('ci.yml');
  const scan = stepsOf(yaml).find((step) => /gitleaks/.test(step.body));
  assert.ok(scan, 'ci.yml has no secret scan');
  assert.match(scan.body, /--redact\b/, 'the scan prints the secrets it finds into the run log');
  const version = scan.body.match(/GITLEAKS_VERSION:\s*(\d+\.\d+\.\d+)/)?.[1];
  assert.ok(version, 'the scanner version is not pinned');
  assert.match(
    scan.body,
    /releases\/download\/v\$\{GITLEAKS_VERSION\}/,
    `the step pins ${version} and then downloads whatever the URL happens to name`,
  );
  assert.match(
    scan.body,
    /\b[0-9a-f]{64}\b/,
    'the downloaded scanner is not written down as a digest',
  );
  const check = scan.body.match(/^[^\n]*(?:sha256sum|shasum)[^\n]*$/m)?.[0] ?? '';
  assert.ok(check, 'the digest is written down but never checked against the download');
  // A checksum whose result is thrown away pins nothing: any binary the URL
  // serves goes on to run against the history.
  assert.ok(
    !/\|\||;\s*(?:true|:)(?:\s|$)/.test(check),
    `the digest check discards its own result: ${check.trim()}`,
  );
  assert.match(
    jobOf(yaml, 'secret-scan'),
    /fetch-depth:\s*0/,
    'the scan job checks out a shallow clone: there is no history to read',
  );
  const run = scan.body.match(/^[^\n]*\.\/gitleaks git\b[^\n]*$/m)?.[0] ?? '';
  assert.ok(run, 'the scanner reads the working tree, not the commits behind it');
  // gitleaks exits 1 on a finding by default; `--exit-code 0` turns a leak into
  // a green job, and so does a status discarded after the call.
  const exitCodes = [...run.matchAll(/--exit-code[=\s]+(\S+)/g)].map((match) => match[1]);
  assert.deepEqual(
    exitCodes,
    ['1'],
    `the scan does not fail on a finding: --exit-code ${exitCodes.join(', ') || 'unset'}`,
  );
  assert.ok(
    !/\|\||;\s*(?:true|:)(?:\s|$)/.test(run),
    `the scan discards its own exit status: ${run.trim()}`,
  );
  // A job that is skipped, or whose failure does not fail the run, finds
  // secrets nobody has to act on, and a green ci.yml run then lets the
  // release gate through.
  const scanJob = jobOf(yaml, 'secret-scan');
  assert.ok(!/^    if:/m.test(scanJob), 'the secret-scan job runs only under a condition');
  assert.ok(
    !/continue-on-error/.test(scanJob),
    'a failure in the secret-scan job does not fail the run',
  );
  assert.ok(
    readFileSync(join(root, '.gitleaks.toml'), 'utf8').includes('[extend]'),
    '.gitleaks.toml does not extend the default rule set',
  );
});

test('the packaging and secret-scan jobs can only read the repository', () => {
  // Neither job writes anything back, and the scan downloads a binary and runs
  // it against the whole history. Without a permissions key a job gets the
  // repository's default token scopes, whatever those have been set to.
  const yaml = workflow('ci.yml');
  for (const job of ['package', 'secret-scan']) {
    const body = jobOf(yaml, job);
    assert.match(
      body,
      /^    permissions:\n      contents: read\n(?!      )/m,
      `the ${job} job runs with the default token scopes instead of read-only`,
    );
  }
});

test('a test that only passes on retry is reported', () => {
  // Playwright retries twice in CI and the html report is an artifact nobody
  // downloads on a green run, so a test that failed and then passed left no
  // trace at all. The json report is the one file a step can read, and a
  // warning annotation is the one place a reader will see it.
  const playwright = readFileSync(
    join(root, 'packages', 'webview', 'playwright.config.ts'),
    'utf8',
  );
  const outputFile = playwright.match(/\['json',\s*\{\s*outputFile:\s*'([^']+)'/)?.[1];
  assert.ok(outputFile, 'the Playwright reporters do not include a json report');

  const warn = stepsOf(workflow('ci.yml')).find((step) => step.body.includes(outputFile));
  assert.ok(warn, `nothing in ci.yml reads ${outputFile}`);
  // The runs that most need the count are the ones whose E2E step failed: some
  // tests flaky, others red. Without always() the step is skipped on exactly
  // those.
  assert.match(
    warn.body.match(/^\s*if:\s*(.+)$/m)?.[1] ?? '',
    /\balways\(\)/,
    'the flaky report is skipped whenever the E2E step failed',
  );
  assert.match(
    warn.body,
    /if \(stats\.flaky > 0\)/,
    'the step reads the report without acting on the flaky count',
  );
  assert.match(
    warn.body,
    /"::warning::" \+ stats\.flaky\b/,
    'a flaky run produces no annotation carrying the flaky count',
  );
});

test('the E2E dev server takes its port from the environment', () => {
  // Two checkouts running the suite at once both booted a server on the same
  // port: the second reused the first one's, and served the first one's
  // sources to the second one's assertions. A port per checkout keeps them
  // apart, and strictPort turns a collision into a failure instead of a silent
  // hop to the next free port, which would leave server and tests on two.
  const playwright = readFileSync(
    join(root, 'packages', 'webview', 'playwright.config.ts'),
    'utf8',
  );
  assert.match(
    playwright,
    /process\.env\.E2E_PORT/,
    'playwright.config.ts hard-codes the E2E port',
  );
  assert.match(playwright, /--strictPort/, 'the dev server may fall back to another port');
  const vite = readFileSync(join(root, 'packages', 'webview', 'vite.config.e2e.ts'), 'utf8');
  assert.ok(
    !/port:\s*\d+/.test(vite),
    'vite.config.e2e.ts pins a port of its own, a second source of truth beside the one Playwright passes',
  );
});

/**
 * The Playwright config as it loads under a given E2E_PORT, outside CI.
 *
 * The config is TypeScript; Node strips the types when it imports it, which is
 * how the value it computes is observed rather than the text that computes it.
 */
const loadPlaywrightConfig = (port) => {
  const env = { ...process.env };
  delete env.CI;
  delete env.E2E_PORT;
  if (port !== undefined) env.E2E_PORT = port;
  const config = join(root, 'packages', 'webview', 'playwright.config.ts');
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      '--input-type=module',
      '-e',
      `const { default: c } = await import(${JSON.stringify(`file://${config}`)});
       console.log(JSON.stringify({ baseURL: c.use.baseURL, url: c.webServer.url,
         command: c.webServer.command, reuse: c.webServer.reuseExistingServer }));`,
    ],
    { cwd: root, env, encoding: 'utf8' },
  );
  return {
    status: result.status,
    stderr: result.stderr,
    config: result.status === 0 ? JSON.parse(result.stdout.trim().split('\n').pop()) : null,
  };
};

test('the E2E port is refused unless it is a port, and an empty one means unset', () => {
  // `Number('')` is 0 and `Number('abc')` is NaN: the first booted on a random
  // port while reusing whatever server was up, since an empty string is falsy;
  // the second failed on `--port NaN` with nothing saying where NaN came from.
  // Whether a run has a port of its own is read from the parsed value, not from
  // the raw string: `E2E_PORT=' '` is no port, and a run with no port of its
  // own is the one allowed to reuse a server.
  for (const unset of [undefined, '', '  ']) {
    const { status, config, stderr } = loadPlaywrightConfig(unset);
    assert.equal(status, 0, `E2E_PORT=${JSON.stringify(unset)} fails to load: ${stderr}`);
    assert.equal(config.baseURL, 'http://localhost:5173');
    assert.equal(config.url, 'http://localhost:5173');
    assert.equal(
      config.reuse,
      true,
      `E2E_PORT=${JSON.stringify(unset)} is treated as a port of its own`,
    );
  }

  const own = loadPlaywrightConfig('5271');
  assert.equal(own.status, 0, own.stderr);
  assert.equal(own.config.baseURL, 'http://localhost:5271');
  assert.match(own.config.command, /--port 5271 --strictPort/);
  assert.equal(
    own.config.reuse,
    false,
    'a run with a port of its own would still reuse whatever is already listening',
  );

  for (const bad of ['abc', '0', '65536', '52.5', '-1', ' 5271x']) {
    const { status, stderr } = loadPlaywrightConfig(bad);
    assert.notEqual(status, 0, `E2E_PORT=${JSON.stringify(bad)} is accepted`);
    assert.match(stderr, /E2E_PORT/, `E2E_PORT=${JSON.stringify(bad)} fails without naming it`);
  }
});

test('CI validates on the lowest Node the engines allow and on the one development uses', () => {
  // Every leg ran the declared minimum, and nothing ran the version the work
  // is written on — so a difference between the two only ever surfaced on a
  // developer's machine, or after the release.
  const yaml = workflow('ci.yml');
  const engines = Number(pkg.engines.node.match(/(\d+)/)?.[1]);
  const validate = jobOf(yaml, 'validate');
  assert.match(
    validate,
    new RegExp(`node-version:\\s*${engines}\\b`),
    `the validate matrix does not run Node ${engines}, the declared minimum`,
  );
  const newer = jobOf(yaml, 'validate-node-24');
  const version = Number(newer.match(/node-version:\s*(\d+)/)?.[1]);
  assert.ok(version > engines, 'the Node 24 job runs the minimum Node, or nothing it names');
  assert.match(newer, /pnpm build:shared && pnpm typecheck && pnpm test && pnpm build/);
  // Node 22 is what every gate decides on; the newer Node only reports.
  assert.match(
    newer,
    /^    continue-on-error:\s*true\s*$/m,
    'a failure on the newer Node fails the run, though Node 22 is the version gates decide on',
  );
});

test('the validate legs keep the check names the branch ruleset requires', () => {
  // The master ruleset requires the context `validate (ubuntu-latest)` by name.
  // GitHub names a matrix leg after the job and every matrix value, so a second
  // dimension (`node: [22]`) renames that leg to `validate (ubuntu-latest, 22)`:
  // the required context is then never reported again and every pull request
  // waits on it forever. The job keeps a single `os` dimension and no name of
  // its own, which is what makes each leg's name `validate (<os>)`.
  const validate = jobOf(workflow('ci.yml'), 'validate');
  assert.ok(
    !/^    name:/m.test(validate),
    'the validate job names itself, so its legs are renamed',
  );
  const matrix = validate.match(/^      matrix:\n((?:^ {8,}.*\n?)+)/m)?.[1];
  assert.ok(matrix, 'the validate job has no matrix');
  const keys = [...matrix.matchAll(/^ {8}([\w-]+):/gm)].map((match) => match[1]);
  assert.deepEqual(
    keys,
    ['os'],
    `the validate matrix varies by ${keys.join(', ')}: its legs no longer report as validate (<os>)`,
  );
  const legs = (matrix.match(/os:\s*\[([^\]]+)\]/)?.[1] ?? '')
    .split(',')
    .map((os) => `validate (${os.trim()})`);
  assert.ok(
    legs.includes('validate (ubuntu-latest)'),
    `no leg reports the required context validate (ubuntu-latest): ${legs.join(', ')}`,
  );
});
