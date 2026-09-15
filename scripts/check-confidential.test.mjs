/**
 * Tests for check-confidential.mjs: the shapes an identifier takes in this
 * repository, and runs of the real script over planted repositories and over
 * this one.
 *
 * The last test is the gate itself, on every push. CI has no
 * `.confidential-names`, so there it checks identifiers only; a local run
 * checks names too.
 *
 * Every realistic identifier below is assembled from pieces, so this file never
 * contains one the scan would report.
 *
 * Run: node --test scripts/check-confidential.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { identifiersIn, isSyntheticOrgId, masked } from './check-confidential.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const script = join(scriptsDir, 'check-confidential.mjs');

const ORG_15 = '00D' + '5g000004abcD';
const ORG_18 = ORG_15 + 'EAA';
const CASE_ID = '500' + 'AP0000' + '0aBcDeF';

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

/** A throwaway repository tracking `files`, with an untracked names file like the real one. */
function plantedRepo(files, names) {
  const dir = mkdtempSync(join(tmpdir(), 'sf-confidential-'));
  tempDirs.push(dir);
  git(dir, ['init', '-q']);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  git(dir, ['add', ...Object.keys(files)]);
  if (names !== undefined) writeFileSync(join(dir, '.confidential-names'), names);
  return dir;
}

function run(cwd) {
  return spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
}

test('the stand-ins this repository uses are not orgs', () => {
  const standIns = [
    '00D000000000001',
    '00D000000000002',
    '00DXXXXXXXXXXXX',
    '00DXXXXXXXXXXXXXXX',
    '00DYYYYYYYYYYYYYYY',
    '00Dxx0000001gEQ',
  ];
  for (const id of standIns) {
    assert.equal(isSyntheticOrgId(id), true, id);
    assert.deepEqual(identifiersIn(`orgId: '${id}',`), [], id);
  }
});

test('an org Id is reported in either length, quoted or inside a URL', () => {
  assert.equal(isSyntheticOrgId(ORG_15), false);
  assert.deepEqual(identifiersIn(`orgId: '${ORG_15}',`), [ORG_15]);
  assert.deepEqual(identifiersIn(`https://example.my.salesforce.com/${ORG_18}/view`), [ORG_18]);
});

test('the same characters inside a longer token are not an Id', () => {
  // Where the old pattern found its lockfile match: the middle of a digest.
  assert.deepEqual(identifiersIn(`integrity: sha512-mjYNkHPfGpUR${ORG_18}WcZ9Z41+4Q==`), []);
  // The same run closing a digest: only the character before it tells.
  assert.deepEqual(identifiersIn(`integrity: sha512-WcZ9Z41mjYNkHPfGpUR${ORG_15}==`), []);
  assert.deepEqual(identifiersIn(`${ORG_15}Z`), []);
});

test('a pattern describing an Id is not one', () => {
  assert.deepEqual(identifiersIn('const ORG_ID = /00D[A-Za-z0-9]{12}/;'), []);
});

test('a Case Id under the blocked prefix is reported', () => {
  assert.deepEqual(identifiersIn(`caseId: '${CASE_ID}'`), [CASE_ID]);
  assert.deepEqual(identifiersIn(`integrity: sha512-mjYN${CASE_ID}`), []);
});

test('a report locates an identifier without repeating it', () => {
  assert.equal(masked(ORG_18), '00D5g…');
});

test('a planted Id and a planted name fail the run, by file and line only', () => {
  const dir = plantedRepo(
    {
      'fixture.ts': `export const org = {\n  id: '${ORG_15}',\n};\n`,
      'notes.md': '# Notes\n\nMigrated for Globex Corporation.\n',
    },
    '# clients\nglobex\n',
  );

  const result = run(dir);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /fixture\.ts:2 — identifier 00D5g…/);
  assert.match(result.stderr, /notes\.md:3 — a name listed in \.confidential-names/);
  assert.doesNotMatch(result.stderr, /globex/i);
  assert.ok(!result.stderr.includes(ORG_15), 'the full Id reached the output');
});

test('stand-ins alone pass, and a run without the names file says what it left out', () => {
  const dir = plantedRepo({ 'fixture.ts': "export const orgId = '00D000000000001';\n" });

  const result = run(dir);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /\.confidential-names absent/);
  assert.match(result.stdout, /no real org identifier in 1 tracked file$/m);
});

test('this repository passes', () => {
  const result = run(repoRoot);

  assert.equal(result.status, 0, result.stderr);
});
