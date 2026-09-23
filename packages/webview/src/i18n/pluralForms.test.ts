import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, it, expect } from 'vitest';

import en from './locales/en.json';
import fr from './locales/fr.json';
import de from './locales/de.json';
import es from './locales/es.json';
import ja from './locales/ja.json';
import ptBR from './locales/pt-BR.json';

/**
 * A count is written with the singular and plural forms of its language.
 *
 * i18next picks `key_one` or `key_other` from the `count` it is given, through
 * Intl.PluralRules. A key with neither is written the same at 1 and at 5, and
 * the catalogue hid that with bracketed endings the reader has to resolve:
 * "1 champ(s) PII détecté(s)", "1 sur 3 org(s) connectée(s)", and in English
 * "All 1 rows are valid". Japanese has no singular, so it carries `_other`
 * only (check-i18n-parity.ts exempts it from `_one`).
 */

type Catalogue = Record<string, unknown>;

const BUNDLES: Record<string, Catalogue> = { en, fr, de, es, ja, 'pt-BR': ptBR };

/** Keys passed a `count` whose text rightly reads the same at any count. */
const NO_PLURAL_NEEDED: Record<string, string> = {
  'home.minutesAgo': 'an abbreviated unit ("5m ago"), not a noun',
  'home.hoursAgo': 'an abbreviated unit ("5h ago"), not a noun',
  'sidePanel.relativeTime.minutesAgo': 'an abbreviated unit, not a noun',
  'sidePanel.relativeTime.hoursAgo': 'an abbreviated unit, not a noun',
  'quickSync.seconds': 'an abbreviated unit ("12s")',
  'seed.csv.validation.andMore': '"and 1 more" reads right in all six',
  'seed.csv.mapper.mapped': 'the noun agrees with the total, not with the count',
  'autopilot.step2.selectedCount': 'the noun agrees with the total, not with the count',
  'org.bannerConnected': 'a label and a ratio ("Orgs connected: 1 of 3"), no noun to agree',
  'compare.coverage.overBudget': 'a label and a number ("… (500 per org, 120 s): 1")',
  'compare.coverage.unreadable': 'a label and a number ("Content that cannot be read…: 1")',
  'compare.coverage.readFailed': 'a label and a number ("Read failed: 1")',
  'compare.coverage.managedLeftOut': 'a label and a number ("…, left out as asked: 1")',
};

/** Every string of a catalogue, as `a.b.c` → value. */
function flatten(
  obj: Catalogue,
  prefix = '',
  out = new Map<string, string>(),
): Map<string, string> {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object') flatten(value as Catalogue, path, out);
    else if (typeof value === 'string') out.set(path, value);
  }
  return out;
}

/** Every non-test source file under src/. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) acc.push(full);
  }
  return acc;
}

/** `t('key', { …count… })`: a literal key handed a count. */
const COUNTED_CALL = /\bt\(\s*'([a-zA-Z0-9_.]+)'\s*,\s*\{[^)]*?\bcount\b/g;

describe('plural forms', () => {
  it('writes no plural as a bracketed ending, in any language', () => {
    const bracketed = /[A-Za-zÀ-ÿ]\((?:s|es|en|er|e|r|n|x|ões)\)/;
    const found = Object.entries(BUNDLES).flatMap(([lng, bundle]) =>
      [...flatten(bundle)]
        .filter(([, value]) => bracketed.test(value))
        .map(([key, value]) => `${lng} ${key}: ${value}`),
    );
    expect(found).toEqual([]);
  });

  it('gives every key handed a count its singular and plural forms', () => {
    const src = join(__dirname, '..');
    const counted = new Map<string, string>();
    for (const file of sourceFiles(src)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(COUNTED_CALL)) {
        counted.set(match[1], relative(src, file));
      }
    }
    // Guards the guard: a pattern that stopped matching would pass everything.
    expect(counted.size).toBeGreaterThan(30);

    const flat = Object.fromEntries(
      Object.entries(BUNDLES).map(([lng, bundle]) => [lng, flatten(bundle)]),
    );
    const missing: string[] = [];
    for (const [key, file] of counted) {
      if (key in NO_PLURAL_NEEDED) continue;
      for (const lng of Object.keys(BUNDLES)) {
        const forms = lng === 'ja' ? ['_other'] : ['_one', '_other'];
        for (const form of forms) {
          if (!flat[lng].has(`${key}${form}`)) missing.push(`${lng} ${key}${form} (${file})`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('keeps every exemption about a key the code still hands a count', () => {
    const src = join(__dirname, '..');
    const all = sourceFiles(src)
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    const stale = Object.keys(NO_PLURAL_NEEDED).filter(
      (key) => !all.includes(`'${key}'`) && !all.includes(`.${key.split('.').pop()}\``),
    );
    expect(stale).toEqual([]);
  });
});
