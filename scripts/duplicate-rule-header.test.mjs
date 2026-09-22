import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Every path that creates records in a target org sends the duplicate-rule
 * header.
 *
 * A copy writes rows that look exactly like rows the target already holds —
 * which is what a duplicate rule exists to stop. Salesforce provides a header
 * that says "I know, save it anyway", and it waives duplicate RULES only: a
 * unique index still refuses, which is right.
 *
 * Four modules have now had to learn this the same way, each against a live
 * org, each after the one before it:
 *
 *  - Forge, 1.25.3 — every clone of an Account refused before writing;
 *  - Sync, 1.28.0 — fourteen of sixteen accounts refused;
 *  - Seed, 1.29.0 — a hundred seeded contacts refused;
 *  - Autopilot, 1.30.0 — every contact of a two-object run refused.
 *
 * The shared constant existed from the first of those. What was missing each
 * time was any way to notice that the module next door did not use it, so
 * this counts the call sites instead of trusting the next author to remember.
 */

const ROOT = join(import.meta.dirname, '..');

/** Every tracked TypeScript file under the extension package. */
function sourceFiles() {
  return execFileSync('git', ['ls-files', 'packages/extension'], { encoding: 'utf8', cwd: ROOT })
    .split('\n')
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts'));
}

/**
 * Calls that create records in an org: a `.create(` chained off a
 * `.sobject(...)`, which is the only shape a write to Salesforce takes here.
 *
 * The look-back matters. A first version of this matched every `.create(` in
 * a file that mentioned `sobject` anywhere, and reported a seed TEMPLATE
 * being saved to local storage as an unguarded org write.
 *
 * The window that follows the call carries ~240 characters, so a header
 * passed on the next line is still seen.
 */
function orgCreateCalls(text) {
  const calls = [];
  const pattern = /\.create\(/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
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

test('every create call into a target org waives duplicate rules', () => {
  const offenders = [];

  for (const path of sourceFiles()) {
    const text = readFileSync(join(ROOT, path), 'utf8');
    // Only files that write to an org at all: `sobject(...).create(...)` is
    // the shape every write path uses, through jsforce.
    if (!text.includes('.sobject(')) continue;

    for (const call of orgCreateCalls(text)) {
      if (call.window.includes('duplicateRuleHeaders')) continue;
      // A call that passes headers built elsewhere is fine as long as it says
      // so; anything else is a write that a duplicate rule can refuse.
      if (/headers\s*:/.test(call.window)) continue;
      offenders.push(`${path}:${lineOf(text, call.at)}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'these write records without waiving duplicate rules, so a target that ' +
      `already resembles the source refuses them: ${offenders.join(', ')}. ` +
      'Pass `{ headers: duplicateRuleHeaders(true) }`, or say in a comment why not.',
  );
});

test('the header itself still says what it is meant to say', () => {
  // A gate that counts call sites is worth nothing if the constant behind
  // them drifts.
  const text = readFileSync(join(ROOT, 'packages/shared/src/constants/duplicate-rules.ts'), 'utf8');
  assert.match(text, /Sforce-Duplicate-Rule-Header/);
  assert.match(text, /allowSave=true/);
});
