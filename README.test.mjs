/**
 * README claim gate for the Internationalization section.
 *
 * The extension README is the Marketplace description, so a sentence there is
 * read as a guarantee. Two i18n claims outran the code. A translation
 * *coverage* percentage: nothing measures one — the CI gate compares key sets
 * between locales, and a key present in all six files but translated in none
 * of them passes it untouched. And an unqualified "formatted with Intl APIs":
 * every formatter in the webview once resolved against the host — the editor —
 * and no code path fed it the picked language, so the README had to say
 * "using the editor locale".
 *
 * The second claim is pinned to the source rather than to a fixed string. The
 * wiring has since appeared — `uiLocale()` in utils/formatters.ts reads the
 * language i18next renders in — and the README now says formatting follows the
 * picked language; the gate holds that sentence to the wiring it describes.
 *
 * Run: node --test README.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const WEBVIEW_SRC = join(repoRoot, 'packages', 'webview', 'src');

/** Any of the Intl constructors whose output depends on a locale. */
const INTL_FORMATTER = /\bIntl\.(?:DateTimeFormat|NumberFormat|RelativeTimeFormat|ListFormat)\s*\(/;

/** The language i18next currently renders in — the one the picker changes. */
const ACTIVE_LANGUAGE = /\b(?:i18n|i18next)\.(?:language|resolvedLanguage)\b/;

/**
 * True when a module both builds an Intl formatter and reads the active
 * i18next language. Co-location is the cheapest reliable signal: the locale
 * argument is often a parameter or a hook value, so matching the call
 * expression alone would miss the wiring that matters.
 */
export function bindsFormattingToAppLanguage(source) {
  return INTL_FORMATTER.test(source) && ACTIVE_LANGUAGE.test(source);
}

/** Production `.ts`/`.tsx` under `dir`, tests excluded. */
function productionSources(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      productionSources(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** The `## Internationalization` section of a README, next heading excluded. */
function i18nSection(relPath) {
  const text = readFileSync(join(repoRoot, relPath), 'utf8');
  const start = text.indexOf('## Internationalization');
  assert.notEqual(start, -1, `${relPath} has no "## Internationalization" section`);
  const rest = text.slice(start + '## Internationalization'.length);
  const end = rest.indexOf('\n## ');
  return end === -1 ? rest : rest.slice(0, end);
}

test('the Marketplace README claims key parity, not translation coverage', () => {
  const section = i18nSection('packages/extension/README.md');

  assert.doesNotMatch(
    section,
    /coverage/i,
    'no gate measures translation coverage — claim what check-i18n-parity.ts enforces instead',
  );
  assert.doesNotMatch(
    section,
    /\d{1,3}\s?%/,
    'a percentage reads as a measurement; nothing produces this number',
  );
  assert.match(section, /parity/i, 'say which property CI actually enforces');
  assert.match(section, /\bCI\b/, 'name where it is enforced');
});

test('the root README says which locale drives Intl formatting', () => {
  const section = i18nSection('README.md');

  assert.match(
    section,
    /Intl APIs in the language picked in SandForge/,
    'say which language dates and numbers are written in',
  );
  assert.doesNotMatch(
    section,
    /editor locale/,
    'formatting follows the picked language: the editor only lends its region',
  );
});

test('the co-location scan distinguishes a bound formatter from a host-locale one', () => {
  const bound = `
    import i18n from '../i18n';
    export const fmt = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' });
  `;
  const hostLocale = `
    export const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
  `;
  const switcherWithoutFormatting = `
    export function current() { return i18n.resolvedLanguage; }
  `;

  assert.equal(bindsFormattingToAppLanguage(bound), true);
  assert.equal(bindsFormattingToAppLanguage(hostLocale), false);
  assert.equal(bindsFormattingToAppLanguage(switcherWithoutFormatting), false);
});

test('the webview binds its Intl formatters to the active language, as the README says', () => {
  const bound = productionSources(WEBVIEW_SRC)
    .filter((file) => bindsFormattingToAppLanguage(readFileSync(file, 'utf8')))
    .map((file) => relative(repoRoot, file).replaceAll('\\', '/'))
    .sort();

  assert.ok(
    bound.includes('packages/webview/src/utils/formatters.ts'),
    `no formatter reads the picked language any more (bound: ${bound.join(', ') || 'none'}) — the README's "language picked in SandForge" is false`,
  );
});
