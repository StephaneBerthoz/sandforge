import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every record Forge creates or writes again in a target says whether the
 * target's assignment rules apply to it.
 *
 * Forge writes through REST, where a request that does not send
 * `Sforce-Auto-Assign` has the target apply its active assignment rules: the
 * Cases, Leads and Accounts a clone created went to whoever the rules routed
 * them to, over the owner the run had set, and the new owner could be mailed.
 * `forgeWriteHeaders` sends `FALSE` unless the run asks for the rules.
 *
 * Forge writes from two places, the extension's composition and the clone
 * command, and a write added to either without the headers would apply the
 * rules again with every test of the other one green: this reads the call
 * sites of both.
 */

const ROOT = join(import.meta.dirname, '..');

/** The two places Forge writes records to a target from. */
const FORGE_WRITERS = [
  'packages/extension/src/composition/forgeComposition.ts',
  'packages/extension/cli/sandforge-clone.ts',
];

/**
 * Calls that create or update records in an org: a `.create(`, `.upsert(` or
 * `.update(` chained off a `.sobject(...)` shortly before it, the window after
 * the call long enough to hold its options on the lines that follow. A call a
 * comment names is none.
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

test('every create, update and upsert of a Forge run sends the headers of a Forge write', () => {
  const offenders = [];
  let seen = 0;
  for (const path of FORGE_WRITERS) {
    const text = readFileSync(join(ROOT, path), 'utf8');
    for (const call of orgWriteCalls(text)) {
      seen++;
      if (!call.window.includes('forgeWriteHeaders('))
        offenders.push(`${path}:${lineOf(text, call.at)}`);
    }
  }
  // Three writes in each place: create, update, upsert. Fewer seen would be
  // the gate looking at nothing.
  assert.ok(seen >= 6, `only ${seen} write calls found in ${FORGE_WRITERS.join(', ')}`);
  assert.deepEqual(
    offenders,
    [],
    'these Forge writes do not say whether the target applies its assignment rules, so REST ' +
      `applies them: ${offenders.join(', ')}. Pass \`headers: forgeWriteHeaders(…)\`.`,
  );
});

test('the headers keep the assignment rules off unless the run asks for them', () => {
  const text = readFileSync(
    join(ROOT, 'packages/shared/src/constants/forge-write-headers.ts'),
    'utf8',
  );
  assert.match(text, /'Sforce-Auto-Assign'/);
  assert.match(text, /applyAssignmentRules \? 'TRUE' : 'FALSE'/);
  assert.match(text, /ALLOW_DUPLICATE_RULE_HEADER/);
});
