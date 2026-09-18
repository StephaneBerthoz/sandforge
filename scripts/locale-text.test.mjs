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
 * And Spanish, Brazilian Portuguese and German keep their accents. All three
 * were once written largely without them — "Configuracion", "Sessao expirada", "nao" — in
 * text that renders and passes every other check. Each language is refused a
 * word that is never correct unaccented: a singular -cion/-sion/-xion in Spanish (its
 * plural -ciones rightly drops the accent), an ending -cao/-coes/-sao/-soes/-xao
 * in Portuguese, and a short list of common words. German is refused the
 * transliterations "ae", "oe" and "ue" that stand in for its umlauts — with the
 * sequences that are not one: "ue" after a vowel or a "q" ("Dauer", "neue",
 * "Quelle"), the Latin "-uell" ending ("aktuell", "manuell") and "zuerst".
 * Placeholders, paths, email addresses, identifiers and code are set aside
 * first: "{{version}}", "/home/voce/export.json", "allOrNone=true" and
 * "tokenBudgetMaxPerSession" are not prose.
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

/**
 * A letter from a script the language is not written in.
 *
 * Han, kana, Hangul, Cyrillic, Greek, Hebrew and Arabic — none of which
 * belongs in English, French, German, Spanish or Portuguese. One Han character
 * reached a French string ("c'est正 correct") while these very bundles were
 * being written, and every check passed it: the two rules above look for
 * combining marks and for Latin letters from the wrong block, and a Han
 * character is neither. It renders, it is visible, and only a reader of that
 * language can tell. Japanese is exempt by construction — the check runs on
 * the five Latin-script bundles.
 */
const FOREIGN_SCRIPT =
  /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\u0400-\u04ff\u0370-\u03ff\u0590-\u05ff\u0600-\u06ff]/u;

/** The bundles written in the Latin alphabet, by the language code in their name. */
const LATIN_SCRIPT_LANGS = new Set(['en', 'fr', 'de', 'es', 'pt-BR', 'pt-br']);

/** The language a bundle file is for, from its name. */
export function bundleLanguage(file) {
  const name = file.split(/[\\/]/).pop() ?? '';
  // The two references carry no language in their name; they are English.
  if (name === 'package.nls.json' || name === 'bundle.l10n.json') return 'en';
  const stem = name
    .replace(/^package\.nls\./, '')
    .replace(/^bundle\.l10n\./, '')
    .replace(/\.json$/, '');
  return /^[a-zA-Z]{2}(?:-[a-zA-Z]{2,4})?$/.test(stem) ? stem : '';
}

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

test('a bundle written in the Latin alphabet holds no letter from another script', () => {
  const offenders = [];
  for (const file of bundles()) {
    const language = bundleLanguage(file);
    if (!LATIN_SCRIPT_LANGS.has(language)) continue;
    const content = JSON.parse(readFileSync(join(repoRoot, file), 'utf8'));
    for (const [key, value] of leaves(content)) {
      const stray = FOREIGN_SCRIPT.exec(value);
      if (stray) {
        const around = value.slice(Math.max(0, stray.index - 12), stray.index + 12);
        offenders.push(`${file} › ${key}: ${codePoint(stray[0])} in "${around}"`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('the language of a bundle is read from its name', () => {
  assert.equal(bundleLanguage('packages/webview/src/i18n/locales/fr.json'), 'fr');
  assert.equal(bundleLanguage('packages/webview/src/i18n/locales/pt-BR.json'), 'pt-BR');
  assert.equal(bundleLanguage('packages/extension/package.nls.de.json'), 'de');
  assert.equal(bundleLanguage('packages/extension/l10n/bundle.l10n.ja.json'), 'ja');
  // The two English references carry no language in their name.
  assert.equal(bundleLanguage('packages/extension/package.nls.json'), 'en');
  assert.equal(bundleLanguage('packages/extension/l10n/bundle.l10n.json'), 'en');
});

test('every named exception still exists, so none outlives what it excuses', () => {
  const english = flatten(readJson('packages/webview/src/i18n/locales/en.json'));
  for (const key of SAME_IN_EVERY_LANGUAGE.keys()) {
    assert.ok(key in english, `exception ${key} names a string that is gone — remove it`);
  }
});

/** A word no correct text in the language writes without its accent. */
const UNACCENTED = {
  es: new RegExp(
    String.raw`(?<!\p{L})(?:\p{L}*(?:cion|sion|xion)|pagina|numero|tambien|despues|codigo|metodo|aqui|ademas|automaticamente)(?!\p{L})`,
    'iu',
  ),
  'pt-BR': new RegExp(
    String.raw`(?<!\p{L})(?:\p{L}*(?:cao|coes|sao|soes|xao|xoes)|nao|voce|tambem|numero|pagina|codigo|metodo|disponivel|possivel|usuario|apos)(?!\p{L})`,
    'iu',
  ),
  de: new RegExp(
    String.raw`(?<!\p{L})(?!zuerst(?!\p{L}))\p{L}*(?:ae|oe|(?<![aeq])ue(?!ll))\p{L}*(?!\p{L})`,
    'iu',
  ),
};

/** Everything in a string that is not prose: placeholders, paths, addresses, identifiers, code. */
export function proseOnly(text) {
  return text
    .replace(/`[^`]*`/g, ' ')
    .replace(/\{\{[^}]*\}\}|\{\d+\}/g, ' ')
    .replace(/\S+@\S+/g, ' ')
    .replace(/[\w.]+=\S+/g, ' ')
    .replace(/(?:[A-Za-z]:)?\/\S*/g, ' ')
    .replace(/\b[\w-]+(?:\.[\w-]+)+\b/g, ' ')
    .replace(/\b[a-z]+[A-Z]\w*\b/g, ' ');
}

/** The first unaccented word in `text` for `lang`, or null. */
export function missingAccent(lang, text) {
  const match = UNACCENTED[lang].exec(proseOnly(text));
  return match ? match[0] : null;
}

const ACCENTED_BUNDLES = {
  es: [
    'packages/webview/src/i18n/locales/es.json',
    'packages/extension/package.nls.es.json',
    'packages/extension/l10n/bundle.l10n.es.json',
  ],
  'pt-BR': [
    'packages/webview/src/i18n/locales/pt-BR.json',
    'packages/extension/package.nls.pt-br.json',
    'packages/extension/l10n/bundle.l10n.pt-br.json',
  ],
  de: [
    'packages/webview/src/i18n/locales/de.json',
    'packages/extension/package.nls.de.json',
    'packages/extension/l10n/bundle.l10n.de.json',
  ],
};

test('an unaccented word is caught, and what only looks like one is not', () => {
  assert.equal(missingAccent('es', 'Configuracion'), 'Configuracion');
  assert.equal(missingAccent('es', 'Error de conexion'), 'conexion');
  assert.equal(missingAccent('pt-BR', 'Sessao expirada'), 'Sessao');
  assert.equal(missingAccent('pt-BR', 'Voce nao tem acesso'), 'Voce');
  assert.equal(missingAccent('de', 'Datensaetze auswaehlen'), 'Datensaetze');
  assert.equal(missingAccent('de', 'Lauf ausfuehren'), 'ausfuehren');
  assert.equal(missingAccent('de', 'Neue Groesse'), 'Groesse');
  assert.equal(missingAccent('de', 'Ausloeser'), 'Ausloeser');
  for (const [lang, text] of [
    ['es', 'Configuración de sesión'],
    ['es', 'Operaciones recientes'],
    ['es', 'Conjunto de datos v{{version}}'],
    ['es', 'Suba sandforge.ai.tokenBudgetMaxPerSession'],
    ['pt-BR', 'Paginação'],
    ['pt-BR', 'Sessão expirada'],
    ['pt-BR', 'no formato usuario@dominio.com.'],
    ['pt-BR', 'por exemplo /home/voce/export.json'],
    ['de', 'Datensätze auswählen'],
    ['de', 'Die aktuelle Dauer der neuen manuellen Ausführung'],
    ['de', 'Quelle, Sequenz und Steuerung'],
    ['de', 'Speichern Sie zuerst eine Konfiguration'],
    ['de', 'Ø {{value}}ms'],
    ['de', 'Aggregat-SOQL (axisValue)'],
    ['de', 'Ein Stapelvorgang mit allOrNone=true ist fehlgeschlagen'],
  ]) {
    assert.equal(missingAccent(lang, text), null, `rejected correct ${lang} text: ${text}`);
  }
});

test('Spanish, Brazilian Portuguese and German keep their accents', () => {
  const offenders = [];
  for (const [lang, files] of Object.entries(ACCENTED_BUNDLES)) {
    for (const file of files) {
      for (const [key, value] of Object.entries(flatten(readJson(file)))) {
        if (typeof value !== 'string') continue;
        const word = missingAccent(lang, value);
        if (word) offenders.push(`${file} › ${key}: "${word}"`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
