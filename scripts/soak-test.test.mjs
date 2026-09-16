/**
 * Tests for soak-test.ts: runs of the real harness, briefly.
 *
 * The harness used to catch its own failure to load the extension, swap in an
 * array sort, run that for an hour and report PASS. Nothing about the result
 * said the extension had never been touched. These runs pin the outcomes that
 * matter: a composition root that loads is exercised, one that does not ends
 * the run with exit 1 and no report, and a cycle that leaves a panel
 * registered fails the run.
 *
 * The composition root imports @sandforge/shared from its dist/, so this file
 * runs after `pnpm build:shared` — as `validate` and CI both order it.
 *
 * Run: node --test scripts/soak-test.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const harness = join(scriptsDir, 'soak-test.ts');
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'sf-soak-'));
  tempDirs.push(dir);
  return dir;
}

/** Run a copy of the harness for about a second, from `cwd`. */
function runHarness(script, cwd) {
  return spawnSync(process.execPath, [tsxCli, script], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, SOAK_MINUTES: '0.02', SAMPLE_INTERVAL_MINUTES: '1' },
    timeout: 120_000,
  });
}

test('a composition root that loads is soaked, and the report says what was measured', () => {
  const cwd = tempDir();
  const run = runHarness(harness, cwd);

  assert.equal(run.status, 0, `harness failed:\n${run.stdout}\n${run.stderr}`);
  // Loading needs `vscode`, which exists only inside the host: this line is
  // the proof the stand-in was used rather than the load skipped.
  assert.match(run.stdout, /composition root wired/);

  const report = readFileSync(join(cwd, 'reports', 'soak-baseline.md'), 'utf8');
  assert.match(report, /\*\*Verdict:\*\* \*\*PASS\*\*/);
  assert.match(report, /Panels left registered: \*\*0\*\*/);
});

test('a composition root that fails to load ends the run with exit 1 and no report', () => {
  // The same harness, placed where its relative import of the composition root
  // points at nothing — the failure it used to swallow.
  const sandbox = tempDir();
  mkdirSync(join(sandbox, 'scripts'));
  const orphan = join(sandbox, 'scripts', 'soak-test.ts');
  copyFileSync(harness, orphan);

  const run = runHarness(orphan, sandbox);

  assert.equal(run.status, 1, `expected exit 1, got ${run.status}:\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /composition root failed to load/);
  assert.equal(existsSync(join(sandbox, 'reports', 'soak-baseline.md')), false);
});

test('a cycle that leaves a panel registered fails the run, whatever the memory says', () => {
  // The same harness with the panel's dispose taken out. One registration per
  // cycle is far too little to move RSS in a second, so only the panel count
  // can turn this run red.
  const sandbox = tempDir();
  mkdirSync(join(sandbox, 'scripts'));
  // The copy's relative import of the composition root must still land on it.
  symlinkSync(join(scriptsDir, '..', 'packages'), join(sandbox, 'packages'), 'junction');
  const source = readFileSync(harness, 'utf8');
  const leaking = source.replace(/^\s*registration\.dispose\(\);\n/m, '');
  assert.notEqual(
    leaking,
    source,
    'the harness no longer disposes its panel in a way this test can remove',
  );
  const copy = join(sandbox, 'scripts', 'soak-test.ts');
  writeFileSync(copy, leaking);

  const run = runHarness(copy, sandbox);

  assert.match(run.stdout, /composition root wired/, `harness did not load:\n${run.stderr}`);
  assert.equal(run.status, 1, `expected exit 1, got ${run.status}:\n${run.stdout}\n${run.stderr}`);
  const report = readFileSync(join(sandbox, 'reports', 'soak-baseline.md'), 'utf8');
  assert.match(report, /\*\*Verdict:\*\* \*\*FAIL\*\*/);
  assert.match(report, /Panels left registered: \*\*[1-9]\d*\*\*/);
});
