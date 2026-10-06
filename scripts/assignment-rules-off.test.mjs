import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Every record any module creates or writes again over REST says whether the
 * target's assignment rules apply to it.
 *
 * A REST create or update that does not send `Sforce-Auto-Assign` has the
 * target apply its active assignment rules. Forge learnt it first and sends
 * `FALSE` unless a run asks for the rules (`forgeWriteHeaders`); Seed, its
 * record clone, DataOps and Autopilot went on writing without it, so the
 * Cases, Leads and Accounts they created went to whoever the rules routed
 * them to, and the new owners could be mailed. `forge-write-headers.test.mjs`
 * reads Forge's two writers; this reads every writer, so the next one cannot
 * forget it either.
 *
 * Bulk API 2.0 runs an assignment rule only when a job names one
 * (`assignmentRuleId`). No job names one, and the last test keeps it so.
 */

const ROOT = join(import.meta.dirname, '..');

/** Every tracked TypeScript file under the extension package, tests aside. */
function sourceFiles() {
  return execFileSync('git', ['ls-files', 'packages/extension'], { encoding: 'utf8', cwd: ROOT })
    .split('\n')
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts'));
}

/**
 * Calls that create or update records in an org: a `.create(`, `.upsert(` or
 * `.update(` chained off a `.sobject(...)` shortly before it, with the window
 * after the call long enough to hold its options on the lines that follow. A
 * call a comment names is none.
 */
function orgWriteCalls(text) {
  const calls = [];
  const pattern = /\.(create|upsert|update)\(/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const lineStart = text.lastIndexOf('\n', match.index) + 1;
    if (/^\s*(\*|\/\/|\/\*)/.test(text.slice(lineStart, match.index))) continue;
    const lookBack = text.slice(Math.max(0, match.index - 200), match.index);
    if (!/\.sobject\(/.test(lookBack)) continue;
    calls.push({ at: match.index, window: text.slice(match.index, match.index + 240) });
  }
  return calls;
}

/** The 1-indexed line `offset` falls on. */
function lineOf(text, offset) {
  return text.slice(0, offset).split('\n').length;
}

/** The two helpers that build a write's headers with `Sforce-Auto-Assign` in them. */
const HEADER_HELPERS = ['recordWriteHeaders(', 'forgeWriteHeaders('];

test('every REST create, update and upsert says whether the assignment rules apply', () => {
  const offenders = [];
  let seen = 0;
  for (const path of sourceFiles()) {
    const text = readFileSync(join(ROOT, path), 'utf8');
    if (!text.includes('.sobject(')) continue;
    for (const call of orgWriteCalls(text)) {
      seen++;
      if (!HEADER_HELPERS.some((helper) => call.window.includes(helper))) {
        offenders.push(`${path}:${lineOf(text, call.at)}`);
      }
    }
  }
  // Seed, Seed Clone, Sync's writer, DataOps, Autopilot, Forge: fewer seen
  // would be the gate looking at nothing.
  assert.ok(seen >= 15, `only ${seen} write calls found under packages/extension`);
  assert.deepEqual(
    offenders,
    [],
    'these writes leave the target free to apply its assignment rules, which REST does by ' +
      `default: ${offenders.join(', ')}. Pass \`headers: recordWriteHeaders()\`.`,
  );
});

test('the headers of every other module keep the assignment rules off', () => {
  const text = readFileSync(
    join(ROOT, 'packages/shared/src/constants/forge-write-headers.ts'),
    'utf8',
  );
  assert.match(
    text,
    /export function recordWriteHeaders\(\)[^{]*\{\s*return forgeWriteHeaders\(\{ applyAssignmentRules: false \}\);/,
  );
});

test('no Bulk API job names an assignment rule, so none runs on what a job writes', () => {
  // The job's property, set; a comment may name it.
  const naming = sourceFiles().filter((path) =>
    /['"]?assignmentRuleId['"]?\s*:/.test(readFileSync(join(ROOT, path), 'utf8')),
  );
  assert.deepEqual(
    naming,
    [],
    `a Bulk API 2.0 job that names an assignment rule runs it on every row: ${naming.join(', ')}`,
  );
});
