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
 * And a translation is written in its language:
 *
 *  - a host bundle (`l10n/bundle.l10n.<lang>.json`) is keyed by the English
 *    text, so a value equal to its key is a string nobody translated. None is
 *    legitimately identical today, and a new one would show English to a user
 *    who picked another language;
 *  - in the webview and manifest bundles a value may rightly match English —
 *    "Sandbox", "Type", a module name — but an English sentence left as it is
 *    may not. A value of three words or more holding an English function word,
 *    identical in a translated bundle to its English one, is refused, with the
 *    exceptions named below and the reason each one stands.
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

/** English words that only occur in running English text. */
const ENGLISH_FUNCTION_WORD =
  /\b(the|and|or|is|are|to|of|for|with|this|that|your|you|not|no|from|in|on|at|be|will|can|has|have|was|were|a|an)\b/i;

/** A value that reads as an English sentence rather than as a name. */
export function looksLikeEnglishSentence(text) {
  return (
    typeof text === 'string' &&
    ENGLISH_FUNCTION_WORD.test(text) &&
    text.trim().split(/\s+/).length >= 3
  );
}

/**
 * Values that are English in every language on purpose.
 * Each one is code or a proper noun a user types or reads verbatim.
 */
const SAME_IN_EVERY_LANGUAGE = new Map([
  ['forge.soqlPlaceholder', 'a SOQL query: the keywords are the language, not English'],
]);

const flatten = (node, prefix = '', acc = {}) => {
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') flatten(value, path, acc);
    else acc[path] = value;
  }
  return acc;
};

const readJson = (relative) => JSON.parse(readFileSync(join(repoRoot, relative), 'utf8'));

test('a sentence is told apart from a name', () => {
  assert.ok(looksLikeEnglishSentence('Save the configuration first'));
  assert.ok(looksLikeEnglishSentence('This saved template no longer exists.'));
  for (const name of ['Sandbox', 'Reset Budget', 'Bulk API 2.0', 'Open Settings']) {
    assert.equal(looksLikeEnglishSentence(name), false, `took a name for a sentence: ${name}`);
  }
});

test('no host bundle leaves a string in English', () => {
  const dir = 'packages/extension/l10n';
  const translated = existsSync(join(repoRoot, dir))
    ? readdirSync(join(repoRoot, dir)).filter((name) => /^bundle\.l10n\..+\.json$/.test(name))
    : [];
  assert.ok(translated.length >= 5, `only ${translated.length} translated host bundles found`);
  const offenders = [];
  for (const file of translated) {
    for (const [key, value] of Object.entries(readJson(join(dir, file)))) {
      if (value === key) offenders.push(`${dir}/${file}: ${JSON.stringify(key)}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('no translated bundle leaves an English sentence as it is', () => {
  const offenders = [];
  const compare = (label, english, translated) => {
    for (const [key, value] of Object.entries(english)) {
      if (SAME_IN_EVERY_LANGUAGE.has(key)) continue;
      if (translated[key] === value && looksLikeEnglishSentence(value)) {
        offenders.push(`${label} › ${key}: ${JSON.stringify(value)}`);
      }
    }
  };

  const webview = 'packages/webview/src/i18n/locales';
  const webviewEnglish = flatten(readJson(`${webview}/en.json`));
  for (const name of readdirSync(join(repoRoot, webview)).filter((n) => n.endsWith('.json'))) {
    if (name === 'en.json') continue;
    compare(`${webview}/${name}`, webviewEnglish, flatten(readJson(`${webview}/${name}`)));
  }

  const manifestEnglish = readJson('packages/extension/package.nls.json');
  for (const name of readdirSync(join(repoRoot, 'packages/extension')).filter((n) =>
    /^package\.nls\..+\.json$/.test(n),
  )) {
    compare(`packages/extension/${name}`, manifestEnglish, readJson(`packages/extension/${name}`));
  }

  assert.deepEqual(offenders, []);
});

test('every named exception still exists, so none outlives what it excuses', () => {
  const english = flatten(readJson('packages/webview/src/i18n/locales/en.json'));
  for (const key of SAME_IN_EVERY_LANGUAGE.keys()) {
    assert.ok(key in english, `exception ${key} names a string that is gone — remove it`);
  }
});
