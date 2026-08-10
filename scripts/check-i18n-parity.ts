/**
 * i18n parity gate.
 *
 * Loads `packages/webview/src/i18n/locales/en.json` as the reference,
 * flattens its nested keys, and for every other locale reports:
 *
 *   - missing keys  (present in en.json, absent from the locale)
 *   - orphan keys   (present in the locale, absent from en.json)
 *
 * Plural handling: i18next (Intl.PluralRules) only has the `other` category
 * for Japanese, so `*_one` keys are not required in `ja.json`. Every other
 * supported locale (fr, de, es, pt-BR) has a `one` category like English.
 *
 * Output is deterministic (keys sorted). Exits 1 when any locale drifts
 * from the reference; pass `--report` to print the report without failing.
 *
 * Run with:  pnpm check:i18n
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const LOCALES_DIR = join(__dirname, '..', 'packages', 'webview', 'src', 'i18n', 'locales');
const REFERENCE = 'en.json';

/** Locales whose i18next plural rules have no `one` category (Intl.PluralRules). */
const NO_ONE_CATEGORY = new Set(['ja']);

type JsonObject = Record<string, unknown>;

/** Flatten a nested locale object into `a.b.c` -> string leaf entries. */
function flatten(obj: JsonObject, prefix = '', out = new Map<string, string>()): Map<string, string> {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value as JsonObject, path, out);
    } else if (typeof value === 'string') {
      out.set(path, value);
    }
  }
  return out;
}

function loadLocale(file: string): Map<string, string> {
  const text = readFileSync(join(LOCALES_DIR, file), 'utf8');
  return flatten(JSON.parse(text) as JsonObject);
}

const reportOnly = process.argv.includes('--report');

const reference = loadLocale(REFERENCE);
const referenceKeys = [...reference.keys()];

const localeFiles = readdirSync(LOCALES_DIR)
  .filter((f) => f.endsWith('.json') && f !== REFERENCE)
  .sort();

let hasDrift = false;

console.log(`i18n parity — reference ${REFERENCE}: ${referenceKeys.length} keys\n`);

for (const file of localeFiles) {
  const locale = file.replace(/\.json$/, '');
  const keys = loadLocale(file);

  // *_one plural keys are only required for locales with a `one` category.
  const expected = NO_ONE_CATEGORY.has(locale)
    ? referenceKeys.filter((k) => !k.endsWith('_one'))
    : referenceKeys;

  const missing = expected.filter((k) => !keys.has(k)).sort();
  const orphan = [...keys.keys()].filter((k) => !reference.has(k)).sort();

  const coverage = (((expected.length - missing.length) / expected.length) * 100).toFixed(1);

  if (missing.length === 0 && orphan.length === 0) {
    console.log(`✓ ${locale}: ${expected.length}/${expected.length} keys (100%)`);
    continue;
  }

  hasDrift = true;
  console.log(`✗ ${locale}: ${expected.length - missing.length}/${expected.length} keys (${coverage}%)`);
  if (missing.length > 0) {
    console.log(`  missing (${missing.length}):`);
    for (const k of missing) console.log(`    - ${k}`);
  }
  if (orphan.length > 0) {
    console.log(`  orphan (${orphan.length}):`);
    for (const k of orphan) console.log(`    - ${k}`);
  }
}

if (hasDrift && !reportOnly) {
  console.error('\ni18n parity check FAILED — run with --report for details without failing.');
  process.exit(1);
}

console.log(hasDrift ? '\ni18n parity check reported drift (--report mode, not failing).' : '\nAll locales at 100% parity.');
