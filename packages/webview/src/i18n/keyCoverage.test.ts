import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import en from './locales/en.json';

/**
 * Translation-key coverage guard.
 *
 * `t('some.key')` with no second argument has no fallback: i18next renders the
 * key itself, so a missing entry ships a raw dotted string like
 * `sync.schedules.builderTitle` into the UI — in every language, since the
 * fallback locale is missing it too. 64 keys were shipping that way across Sync
 * Schedules, Sync History and Settings → AI before this guard existed.
 *
 * Calls that DO pass a default (`t('k', 'Text')`) are deliberately not flagged:
 * they degrade to readable English, which is a different, tolerable state.
 *
 * check-i18n-parity.ts covers the other half of the problem — en.json vs the
 * other five locales. This covers code vs en.json.
 */

const SRC = join(__dirname, '..');

/** Every non-test source file under src/. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) acc.push(full);
  }
  return acc;
}

function hasKey(dotted: string): boolean {
  return (
    dotted
      .split('.')
      .reduce<unknown>(
        (o, part) =>
          o && typeof o === 'object' ? (o as Record<string, unknown>)[part] : undefined,
        en,
      ) !== undefined
  );
}

describe('i18n key coverage', () => {
  const files = sourceFiles(SRC);

  it('scans a meaningful number of source files', () => {
    // Guards the guard: a broken walk would make the assertion below vacuous.
    expect(files.length).toBeGreaterThan(100);
  });

  it('resolves every t() key that has no inline default', () => {
    const missing: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      // t('a.b') only — a second argument means an inline default exists.
      for (const match of Array.from(source.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'\s*\)/g))) {
        const key = match[1];
        if (!key.includes('.')) continue;
        if (!hasKey(key)) missing.push(`${key} (${file.slice(SRC.length + 1)})`);
      }
    }

    expect(missing).toEqual([]);
  });
});
