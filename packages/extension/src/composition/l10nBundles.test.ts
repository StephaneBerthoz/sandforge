import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { knownErrorCodes, knownErrorTexts } from '../core/common/errorKnowledgeBase';

/**
 * Manifest-level l10n guard, mirroring what `scripts/check-i18n-parity.ts`
 * does for the webview locales and `package.nls.*`: the extension host's
 * `vscode.l10n.t` bundles are a third translation surface, and nothing else
 * checks them.
 *
 * Three properties, all drift-detecting rather than taste-based:
 *   1. every `vscode.l10n.t('…')` source literal has an entry in the English
 *      bundle (a missing entry ships an untranslated string in all 5 locales);
 *   2. the 5 locale bundles have exactly the English key set — no missing, no
 *      orphans left behind by a reworded source string;
 *   3. a translation keeps the `{0}`/`{1}` placeholders of its source, so an
 *      interpolated org alias cannot silently vanish from a French dialog;
 *   4. every entry of the table of known Salesforce error codes is in all six
 *      bundles. Those sentences reach `vscode.l10n.t` through a variable, so
 *      the source-literal scan above cannot see them at either end: they would
 *      read as orphans in the reference bundle, and a code added to the table
 *      with no translation would ship English to five locales unnoticed.
 */

const L10N_DIR = join(__dirname, '..', '..', 'l10n');
const SRC_DIR = join(__dirname, '..');
const REFERENCE = 'bundle.l10n.json';
const LOCALES = ['fr', 'de', 'es', 'ja', 'pt-br'] as const;

/** Matches `vscode.l10n.t('…')` — group 1 is the raw (still escaped) literal. */
const L10N_CALL_RE = /vscode\.l10n\.t\(\s*'((?:[^'\\]|\\.)*)'/g;

/** Matches every `{0}`-style placeholder. */
const PLACEHOLDER_RE = /\{\d+\}/g;

function loadBundle(file: string): Record<string, string> {
  return JSON.parse(readFileSync(join(L10N_DIR, file), 'utf8')) as Record<string, string>;
}

/** The `command.*` titles of one `package.nls` bundle, by key. */
function loadCommandTitles(file: string): Record<string, string> {
  const nls = JSON.parse(readFileSync(join(L10N_DIR, '..', file), 'utf8')) as Record<
    string,
    string
  >;
  return Object.fromEntries(Object.entries(nls).filter(([key]) => key.startsWith('command.')));
}

/** Turn a TS single-quoted literal back into the runtime string it denotes. */
function unescapeLiteral(raw: string): string {
  return raw.replace(/\\(n|t|r|'|\\)/g, (_m, char: string) =>
    char === 'n' ? '\n' : char === 't' ? '\t' : char === 'r' ? '\r' : char,
  );
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** Every string passed to `vscode.l10n.t` in the production sources. */
function readSourceStrings(): Set<string> {
  const strings = new Set<string>();
  for (const file of walk(SRC_DIR)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(L10N_CALL_RE)) strings.add(unescapeLiteral(m[1]));
  }
  return strings;
}

/**
 * The curated sentences the host translates: the explanation and the first
 * suggestion of every entry in the table of known Salesforce error codes.
 *
 * `localizedFixSuggestion` passes them to `vscode.l10n.t` as a variable read
 * out of the table, so they are collected from the table itself rather than
 * from a source literal.
 */
function readKnowledgeBaseStrings(): Set<string> {
  const strings = new Set<string>();
  for (const code of knownErrorCodes()) {
    const texts = knownErrorTexts(code);
    if (!texts) continue;
    strings.add(texts.explanation);
    if (texts.suggestion) strings.add(texts.suggestion);
  }
  return strings;
}

describe('extension host l10n bundles', () => {
  const reference = loadBundle(REFERENCE);

  it('extracts a non-trivial number of l10n call sites (regex sanity guard)', () => {
    // 8 dialogs + 2 action labels + the 4 background-notification variants at
    // introduction. An empty extraction must fail loudly, not pass vacuously.
    expect(readSourceStrings().size).toBeGreaterThanOrEqual(10);
  });

  it('has an English entry for every vscode.l10n.t call site', () => {
    const missing = [...readSourceStrings()].filter((s) => !(s in reference));
    expect(missing).toEqual([]);
  });

  it('keeps the reference bundle free of entries no source string uses', () => {
    const used = new Set([...readSourceStrings(), ...readKnowledgeBaseStrings()]);
    const orphans = Object.keys(reference).filter((key) => !used.has(key));
    expect(orphans).toEqual([]);
  });

  it('collects both sentences of every known error code (extraction sanity guard)', () => {
    // Two sentences per code: an empty or halved extraction must fail loudly
    // rather than make the parity check below pass vacuously.
    expect(knownErrorCodes().length).toBeGreaterThanOrEqual(20);
    expect(readKnowledgeBaseStrings().size).toBe(knownErrorCodes().length * 2);
  });

  it.each(['en', ...LOCALES])('bundle.l10n.%s.json translates every known error code', (locale) => {
    const bundle = locale === 'en' ? reference : loadBundle(`bundle.l10n.${locale}.json`);
    const missing: string[] = [];
    // A value left as its English key passes the key check and still shows
    // English: the reference bundle is the only one allowed to hold it back.
    const untranslated: string[] = [];
    for (const code of knownErrorCodes()) {
      const texts = knownErrorTexts(code);
      if (!texts) continue;
      if (!(texts.explanation in bundle)) missing.push(`${code}.explanation`);
      if (texts.suggestion && !(texts.suggestion in bundle)) missing.push(`${code}.suggestion`);
      if (locale === 'en') continue;
      if (bundle[texts.explanation] === texts.explanation) {
        untranslated.push(`${code}.explanation`);
      }
      if (texts.suggestion && bundle[texts.suggestion] === texts.suggestion) {
        untranslated.push(`${code}.suggestion`);
      }
    }
    expect(missing).toEqual([]);
    expect(untranslated).toEqual([]);
  });

  it.each(LOCALES)('bundle.l10n.%s.json is at key parity with English', (locale) => {
    const bundle = loadBundle(`bundle.l10n.${locale}.json`);
    const referenceKeys = Object.keys(reference).sort();
    expect(Object.keys(bundle).sort()).toEqual(referenceKeys);
  });

  // A sentence that sends the user to a command names it by its title. The
  // Command Palette shows that title from `package.nls.<locale>.json`, so a
  // translation keeping the English one leads to an empty search.
  it.each(LOCALES)('bundle.l10n.%s.json names a command as that palette shows it', (locale) => {
    const bundle = loadBundle(`bundle.l10n.${locale}.json`);
    const englishTitles = loadCommandTitles('package.nls.json');
    const localeTitles = loadCommandTitles(`package.nls.${locale}.json`);
    const named: string[] = [];
    const offenders: string[] = [];
    for (const key of Object.keys(reference)) {
      for (const [titleKey, englishTitle] of Object.entries(englishTitles)) {
        if (!key.includes(englishTitle)) continue;
        named.push(titleKey);
        if (!bundle[key]?.includes(localeTitles[titleKey])) {
          offenders.push(`${titleKey} in: ${bundle[key]}`);
        }
      }
    }
    expect(named.length).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it.each(LOCALES)('bundle.l10n.%s.json preserves every placeholder', (locale) => {
    const bundle = loadBundle(`bundle.l10n.${locale}.json`);
    const dropped: string[] = [];
    for (const [key, value] of Object.entries(bundle)) {
      const expected = (key.match(PLACEHOLDER_RE) ?? []).sort();
      const actual = (value.match(PLACEHOLDER_RE) ?? []).sort();
      if (expected.join(',') !== actual.join(',')) {
        dropped.push(`${key} -> ${value}`);
      }
    }
    expect(dropped).toEqual([]);
  });
});
