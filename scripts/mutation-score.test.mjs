/**
 * Tests for mutation-score.mjs, the number the Stryker job summary prints.
 *
 * The summary used to compute its own score and got a different one from
 * Stryker's: it counted the Ignored mutants as survivors and left the
 * NoCoverage ones out. On the nightly run whose report the first fixture
 * reproduces, Stryker's log said 79.15 and the summary on the same page said
 * 46.95. The break threshold it printed was a literal copied from the config,
 * free to drift from the one Stryker enforced.
 *
 * Run: node --test scripts/mutation-score.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { breakThreshold, mutationScore, summaryLines } from './mutation-score.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const script = join(scriptsDir, 'mutation-score.mjs');

/** A Stryker JSON report holding the given number of mutants per status. */
const report = (counts) => {
  let id = 0;
  const mutants = Object.entries(counts).flatMap(([status, n]) =>
    Array.from({ length: n }, () => ({ id: String((id += 1)), status })),
  );
  // Split across two files: the score is over the whole report, not one file.
  const half = Math.floor(mutants.length / 2);
  return {
    schemaVersion: '2',
    files: {
      'packages/shared/src/utils/a.ts': { language: 'typescript', mutants: mutants.slice(0, half) },
      'packages/shared/src/utils/b.ts': { language: 'typescript', mutants: mutants.slice(half) },
    },
  };
};

const NIGHTLY_COUNTS = { Killed: 262, Survived: 52, NoCoverage: 17, Ignored: 244 };

test('the score of a real nightly report is the one Stryker logged for it', () => {
  const { score } = mutationScore(report(NIGHTLY_COUNTS));
  assert.equal(score.toFixed(2), '79.15');
});

test('Ignored mutants do not count and NoCoverage mutants count as undetected', () => {
  assert.equal(mutationScore(report({ Killed: 3, Ignored: 100 })).score, 100);
  assert.equal(mutationScore(report({ Killed: 3, NoCoverage: 1 })).score, 75);
});

test('a timeout is a detection, and compile or runtime errors are not mutants', () => {
  const { score, detected, valid } = mutationScore(
    report({ Killed: 1, Timeout: 1, Survived: 2, CompileError: 5, RuntimeError: 5 }),
  );
  assert.deepEqual({ score, detected, valid }, { score: 50, detected: 2, valid: 4 });
});

test('a report with nothing to score has no score rather than zero or a hundred', () => {
  assert.equal(mutationScore(report({ Ignored: 4 })).score, null);
  assert.match(summaryLines({ report: report({}), breakAt: 75, scope: 'x' })[0], /no mutant/i);
});

test('the break threshold is read from the config Stryker enforces', () => {
  const conf = JSON.parse(readFileSync(join(repoRoot, 'stryker.conf.json'), 'utf8'));
  assert.equal(breakThreshold(conf), conf.thresholds.break);
  assert.equal(breakThreshold({}), null);
});

/**
 * Each Stryker config, with the counts of its last full local run: the shared
 * utilities, and the extension's Bulk, retry and timeout engine.
 */
const MEASURED = [
  { config: 'stryker.conf.json', counts: NIGHTLY_COUNTS, score: '79.15' },
  {
    config: 'stryker.extension.conf.json',
    counts: { Killed: 608, Timeout: 14, Survived: 158, NoCoverage: 72 },
    score: '73.00',
  },
];

const readConfig = (name) => JSON.parse(readFileSync(join(repoRoot, name), 'utf8'));
const strykerYaml = readFileSync(join(repoRoot, '.github', 'workflows', 'stryker.yml'), 'utf8');

for (const { config, counts, score: expected } of MEASURED) {
  test(`${config} breaks under its measured score, not 25 points below it`, () => {
    // A break at 54 under a 79 score let a quarter of the killed mutants start
    // surviving before anything failed.
    const conf = readConfig(config);
    const measured = mutationScore(report(counts)).score;
    assert.equal(measured.toFixed(2), expected);
    assert.ok(breakThreshold(conf) >= measured - 5, `break ${breakThreshold(conf)} vs ${measured}`);
    assert.ok(breakThreshold(conf) < measured, `break ${breakThreshold(conf)} vs ${measured}`);
    assert.ok(conf.mutate?.length > 0, `${config} mutates nothing`);
  });
}

/** The legs of the Stryker workflow's matrix, as `{ name, config, reports, … }`. */
const matrixLegs = (yaml) => {
  const legs = [];
  let indent = -1;
  for (const line of yaml.slice(yaml.indexOf('include:')).split('\n').slice(1)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const start = line.match(/^(\s*)- (\w+): (.+)$/);
    if (start && (indent === -1 || start[1].length === indent)) {
      indent = start[1].length;
      legs.push({ [start[2]]: start[3].trim() });
      continue;
    }
    const field = line.match(/^(\s*)(\w+): (.+)$/);
    if (legs.length === 0 || !field || field[1].length <= indent) break;
    legs[legs.length - 1][field[2]] = field[3].trim();
  }
  return legs;
};

test('the Stryker workflow runs every config and reads the report that config writes', () => {
  const legs = matrixLegs(strykerYaml);
  assert.deepEqual(
    legs.map(({ config }) => config).sort(),
    MEASURED.map(({ config }) => config).sort(),
  );
  for (const { name, config, reports } of legs) {
    assert.equal(readConfig(config).jsonReporter?.fileName, `${reports}/mutation.json`, name);
  }
});

/**
 * Wall times of runs with no incremental file, in seconds, measured locally at
 * concurrency 4, and the words the workflow header uses for each config.
 */
const COLD_RUNS = [
  { name: 'shared', label: 'packages/shared', seconds: [48] },
  { name: 'extension', label: 'the extension engine', seconds: [141, 223, 234] },
];
const MINUTES = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5 };
const COUNT = Object.keys(MINUTES).join('|');

test('the Stryker workflow gives each config a run time its cold runs fit in', () => {
  // The header said about a minute per config, and the timeout comment about
  // a minute, while cold extension runs took between 2 min 21 s and 3 min 54 s.
  const prose = (text) => text.replace(/^\s*#\s?/gm, '').replace(/\s+/g, ' ');
  const header = prose(strykerYaml.slice(0, strykerYaml.search(/^on:/m)));
  assert.deepEqual(
    matrixLegs(strykerYaml)
      .map(({ name }) => name)
      .sort(),
    COLD_RUNS.map(({ name }) => name).sort(),
  );
  for (const { label, seconds } of COLD_RUNS) {
    const claim = header.match(
      new RegExp(`\\b(about|under|(?:${COUNT}) to) (${COUNT}) minutes? for ${label}\\b`),
    );
    assert.ok(claim, `the header gives no run time for ${label}`);
    const [low, high] = [Math.min(...seconds), Math.max(...seconds)];
    const bound = MINUTES[claim[2]] * 60;
    const said = `${label}: ${low} to ${high} s, ${claim[0]}`;
    if (claim[1] === 'under') assert.ok(high < bound, said);
    else if (claim[1] === 'about') assert.ok(low >= bound / 2 && high <= bound * 1.5, said);
    else {
      const from = MINUTES[claim[1].split(' ')[0]] * 60;
      assert.ok(from <= low && high <= bound, said);
    }
  }

  const job = strykerYaml.slice(strykerYaml.indexOf('\njobs:'));
  const [, comment, limit] = job.match(/((?:^\s+#.*\n)+)\s+timeout-minutes: (\d+)/m) ?? [];
  const range = prose(comment ?? '').match(
    /\btakes (a|one|two|three|four|five) to (\w+) minutes\b/,
  );
  assert.ok(range, 'the timeout comment gives no run time');
  const fastest = Math.min(...COLD_RUNS.flatMap(({ seconds }) => seconds));
  const slowest = Math.max(...COLD_RUNS.flatMap(({ seconds }) => seconds));
  assert.ok(MINUTES[range[1]] * 60 <= fastest * 1.5, `${range[0]} vs ${fastest} s`);
  assert.ok(MINUTES[range[2]] * 60 >= slowest, `${range[0]} vs ${slowest} s`);
  assert.ok(Number(limit) > MINUTES[range[2]], `timeout-minutes ${limit} vs ${range[0]}`);
});

/**
 * The extension leg on GitHub's runners, read from the logs of its runs of
 * 17 to 19 November 2026, in seconds: the setup before Stryker starts, the
 * initial test run, and the mutation phase after it. The longest of each over
 * the forty runs since 3 November are here. On 44098161849 the job's own limit,
 * thirty minutes then, cut the mutation phase at 399 mutants of 413, so its
 * figure is the least that phase needed.
 */
const RUNNER_RUNS = [
  { run: 44238683596, setup: 26, initial: 583, mutation: 544 },
  { run: 44165161611, setup: 26, initial: 576, mutation: 1133 },
  { run: 44249323534, setup: 29, initial: 563, mutation: 448 },
  { run: 44098161849, setup: 27, initial: 556, mutation: 1224 },
  { run: 44395185297, setup: 45, initial: 515, mutation: 581 },
];

test('the extension config gives its initial test run half again the longest a runner took', () => {
  // At ten minutes Stryker cut it on six runs of 17 and 18 November, two
  // release pull requests among them, while the same commits went green on
  // other runs at 8 min 35 s: the tests that reach the engine had grown from
  // 9 185 to 13 063 in a fortnight, and a runner's pace varies from run to run.
  const ceiling = readConfig('stryker.extension.conf.json').dryRunTimeoutMinutes * 60;
  const longest = Math.max(...RUNNER_RUNS.map(({ initial }) => initial));
  assert.ok(
    ceiling >= longest * 1.5,
    `dryRunTimeoutMinutes allows ${ceiling} s, a runner took up to ${longest} s`,
  );
});

test('the Stryker job outlasts its setup, the initial test run its configs allow and half again the longest mutation phase', () => {
  const job = strykerYaml.slice(strykerYaml.indexOf('\njobs:'));
  const limit = Number(job.match(/^\s+timeout-minutes: (\d+)/m)?.[1]) * 60;
  // Stryker's own default is five minutes.
  const ceiling =
    Math.max(
      ...matrixLegs(strykerYaml).map(({ config }) => readConfig(config).dryRunTimeoutMinutes ?? 5),
    ) * 60;
  const setup = Math.max(...RUNNER_RUNS.map((run) => run.setup));
  const mutation = Math.max(...RUNNER_RUNS.map((run) => run.mutation));
  const needed = setup + ceiling + mutation * 1.5;
  assert.ok(limit >= needed, `timeout-minutes gives ${limit} s, a run may need ${needed} s`);
});

test('the score step fails when the script does, even though its output is piped', () => {
  // A step without `shell: bash` runs under `bash -e` with no pipefail: a
  // malformed report makes the script throw, `tee` exits 0, and the step goes
  // green with no score in the summary.
  const step = strykerYaml.slice(strykerYaml.indexOf('- name: Mutation score'));
  const body = step.slice(0, step.indexOf('\n      - '));
  assert.match(body, /node scripts\/mutation-score\.mjs[^\n]*\|/);
  assert.match(body, /^\s+shell: bash\s*$|set -o pipefail/m);
});

test('the Stryker workflow runs when anything that changes what it measures changes', () => {
  const trigger = (event) => {
    const start = strykerYaml.indexOf(`\n  ${event}:`);
    const block = strykerYaml.slice(start + 1).split(/\n {2}\w/)[0];
    return [...block.matchAll(/^\s+- '([^']+)'/gm)].map(([, path]) => path);
  };
  const required = [
    'packages/shared/src/**',
    'packages/shared/vitest.config.ts',
    'packages/extension/src/core/engine/**',
    'packages/extension/src/test/**',
    'packages/extension/vitest.config.ts',
    'stryker.conf.json',
    'stryker.extension.conf.json',
    'pnpm-lock.yaml',
    'scripts/mutation-score.mjs',
    '.github/workflows/stryker.yml',
  ];
  for (const event of ['push', 'pull_request']) {
    const paths = trigger(event);
    assert.deepEqual(
      required.filter((path) => !paths.includes(path)),
      [],
      `${event} paths miss inputs of the run`,
    );
  }
});

const work = mkdtempSync(join(tmpdir(), 'mutation-score-'));
after(() => rmSync(work, { recursive: true, force: true }));

test('the command prints the score, the scope and the threshold of the config it is given', () => {
  const reportPath = join(work, 'mutation.json');
  const confPath = join(work, 'stryker.conf.json');
  writeFileSync(reportPath, JSON.stringify(report(NIGHTLY_COUNTS)));
  writeFileSync(
    confPath,
    JSON.stringify({ mutate: ['packages/shared/src/**/*.ts'], thresholds: { break: 61 } }),
  );
  const run = spawnSync(process.execPath, [script, reportPath, confPath], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /79\.15%/);
  assert.match(run.stdout, /`packages\/shared\/src\/\*\*\/\*\.ts`/);
  assert.match(run.stdout, /\(61\)/);
  assert.doesNotMatch(run.stdout, /46\.95/);

  const narrowed = spawnSync(
    process.execPath,
    [script, reportPath, confPath, 'packages/shared/src/utils/*.ts'],
    { encoding: 'utf8' },
  );
  assert.match(narrowed.stdout, /Scope: `packages\/shared\/src\/utils\/\*\.ts`/);
  const unset = spawnSync(process.execPath, [script, reportPath, confPath, ''], {
    encoding: 'utf8',
  });
  assert.match(unset.stdout, /Scope: `packages\/shared\/src\/\*\*\/\*\.ts`/);
});

test('the command fails when the report is missing, instead of printing a score', () => {
  const run = spawnSync(
    process.execPath,
    [script, join(work, 'absent.json'), join(repoRoot, 'stryker.conf.json')],
    { encoding: 'utf8' },
  );
  assert.notEqual(run.status, 0);
  assert.doesNotMatch(run.stdout, /%/);
});

test('the Stryker workflow prints the score through this script, not a formula of its own', () => {
  const yaml = readFileSync(join(repoRoot, '.github', 'workflows', 'stryker.yml'), 'utf8');
  assert.match(yaml, /node scripts\/mutation-score\.mjs/);
  assert.doesNotMatch(yaml, /status\s*[!=]==/, 'the workflow counts mutant statuses itself');
  assert.doesNotMatch(yaml, /thresholds\.break`?\s*\(\d+\)/, 'the workflow hard-codes a threshold');
});
