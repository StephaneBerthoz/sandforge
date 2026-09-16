/**
 * Every string a user reads, in every language, is made of the letters that
 * language writes with.
 *
 * Two Portuguese words were once written with a stray character: "grava" +
 * U+0327 + "ção", a combining cedilla left after an "a", and "prot" + U+0229 +
 * "ção", an "e with cedilla" no Portuguese word uses. Both render, and both
 * pass the key-parity check: nothing stopped them reaching the message shown
 * when a write to a production org is declined.
 *
 * Two rules, over the webview bundles, the manifest bundles and the host
 * bundles, in every language:
 *
 *  - no combining mark (Unicode category Mn). Text here is written with
 *    precomposed letters; a mark on its own is a keyboard or an encoding
 *    accident, and NFC normalisation cannot catch it when no precomposed
 *    letter exists for the pair ("a" + cedilla);
 *  - no letter from Latin Extended-B or Latin Extended Additional. French,
 *    German, Spanish and Portuguese are written with Latin-1 and the two
 *    ligatures of Latin Extended-A; the blocks above hold letters for other
 *    languages, and one appearing here is a substitution.
 *
 * Run: node --test scripts/locale-text.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const COMBINING_MARK = /\p{Mn}/u;
const FOREIGN_LATIN = /[ƀ-ɏḀ-ỿ]/u;

/** The first character in `text` no bundle may hold, or null. */
export function strayCharacter(text) {
  const match = COMBINING_MARK.exec(text) ?? FOREIGN_LATIN.exec(text);
  return match ? { char: match[0], index: match.index } : null;
}

function bundles() {
  const listed = (dir, pattern) =>
    existsSync(join(repoRoot, dir))
      ? readdirSync(join(repoRoot, dir))
          .filter((name) => pattern.test(name))
          .map((name) => join(dir, name))
      : [];
  return [
    ...listed('packages/webview/src/i18n/locales', /\.json$/),
    ...listed('packages/extension', /^package\.nls.*\.json$/),
    ...listed('packages/extension/l10n', /\.json$/),
  ];
}

function leaves(node, path = [], acc = []) {
  if (typeof node === 'string') acc.push([path.join('.'), node]);
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) leaves(value, [...path, key], acc);
  }
  return acc;
}

const codePoint = (char) => `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

test('the two corruptions that shipped are caught, and the letters of six languages are not', () => {
  assert.ok(strayCharacter('grava\u0327\u00e7\u00e3o'));
  assert.ok(strayCharacter('prot\u0229\u00e7\u00e3o'));
  for (const word of [
    'gravação',
    'proteção',
    'Straße',
    'œuvre',
    'añadir',
    'Déploiement',
    'ダッシュボード',
  ]) {
    assert.equal(strayCharacter(word), null, `rejected a correct word: ${word}`);
  }
});

test('the scan reads every language bundle', () => {
  const found = bundles();
  // Six webview locales and six manifest bundles at the least.
  assert.ok(found.length >= 12, `only ${found.length} bundles found — has a directory moved?`);
});

test('no bundle holds a combining mark or a letter from another alphabet', () => {
  const offenders = [];
  for (const file of bundles()) {
    const content = JSON.parse(readFileSync(join(repoRoot, file), 'utf8'));
    for (const [key, value] of leaves(content)) {
      const stray = strayCharacter(value);
      if (stray) {
        const around = value.slice(Math.max(0, stray.index - 12), stray.index + 12);
        offenders.push(`${file} › ${key}: ${codePoint(stray.char)} in "${around}"`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
