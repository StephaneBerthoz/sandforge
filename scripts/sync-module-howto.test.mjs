/**
 * Gate: each module's docs page carries the how-to its page and its Help
 * section show, as `sync-module-howto.mjs` writes it from en.json.
 *
 * Run: node --test scripts/sync-module-howto.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EN_CATALOGUE,
  END,
  HOW_TO_DOCS,
  START,
  howToBlock,
  howToOf,
  howToPages,
  withHowTo,
} from './sync-module-howto.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { howTo } = JSON.parse(readFileSync(join(ROOT, EN_CATALOGUE), 'utf8'));

test('every module with a how-to has a docs page, and every page a how-to', () => {
  const modules = Object.keys(howTo).filter((key) => typeof howTo[key] === 'object');
  assert.deepEqual(modules.sort(), Object.keys(HOW_TO_DOCS).sort());
});

test('every docs page holds the how-to en.json says', () => {
  const drifted = howToPages()
    .filter(([, current, expected]) => current !== expected)
    .map(([path]) => path);
  assert.deepEqual(drifted, [], 'run node scripts/sync-module-howto.mjs');
});

test('the steps are read in order, and a gap, a stray key or no tip is refused', () => {
  const entry = { step2: 'b', step1: 'a', tip: 't' };
  assert.deepEqual(howToOf({ m: entry }, 'm'), { steps: ['a', 'b'], tip: 't' });
  assert.throws(() => howToOf({ m: { step1: 'a', step3: 'c', tip: 't' } }, 'm'), /no step2/);
  assert.throws(() => howToOf({ m: { step1: 'a', note: 'n', tip: 't' } }, 'm'), /neither/);
  assert.throws(() => howToOf({ m: { step1: 'a' } }, 'm'), /no tip/);
  assert.throws(() => howToOf({}, 'm'), /no howTo\.m/);
});

test('the block replaces what stands between its markers, and only there', () => {
  const block = howToBlock(
    'm',
    { steps: ['Open it', 'Run it'], tip: 'Undo is there.' },
    {
      title: 'How to',
      tipLabel: 'Tip:',
    },
  );
  assert.match(block, /^## How to\n\n1\. Open it\n2\. Run it\n\n\*\*Tip:\*\* Undo is there\.$/m);
  const doc = `# M\n\nIntro.\n\n${START} -->\nold\n${END}\n\n## More\n`;
  const written = withHowTo(doc, block, 'm.md');
  assert.equal(written, `# M\n\nIntro.\n\n${block}\n\n## More\n`);
  assert.equal(withHowTo(written, block, 'm.md'), written);
  assert.throws(() => withHowTo('# M\n', block, 'm.md'), /no how-to block/);
  assert.throws(() => withHowTo(`${doc}${START} -->\n${END}\n`, block, 'm.md'), /two how-to/);
});
