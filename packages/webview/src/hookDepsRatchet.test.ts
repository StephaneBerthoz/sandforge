import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, it, expect } from 'vitest';

/**
 * A ratchet on `react-hooks/exhaustive-deps` suppressions.
 *
 * Each suppression is a promise that the dependency array is right for a
 * reason the linter cannot see, and it silences the rule for every dependency
 * added to that array later, not only the one it was written for. Most could
 * be written as real dependencies instead. The ones left are listed below with
 * the reason they cannot be expressed as dependencies.
 *
 * The count may fall. It may not rise: a new suppression has to earn its place
 * in {@link ALLOWED} and in this file's history, rather than being added in a
 * hurry to make a warning go away.
 *
 * The usual alternative to a suppression is `useLatestRef`: name the trigger
 * in the dependency array and read everything else through a stable ref.
 */

const SRC_DIR = join(__dirname);
/**
 * Any `eslint-disable`, `eslint-disable-line` or `eslint-disable-next-line`
 * directive that names the rule, wherever it sits in the directive's rule list.
 */
const SUPPRESSION = /eslint-disable(?:-next-line|-line)?\s[^\n]*\breact-hooks\/exhaustive-deps\b/;

/**
 * The suppressions that are allowed to remain, each with the reason the
 * dependency array cannot simply be completed.
 */
const ALLOWED: Record<string, string> = {
  'components/graph/LiveGraph.tsx':
    'layout is memoised on a topology key derived from the graph, so the graph itself must not be a dependency',
};

/** Every `.ts`/`.tsx` module under `src/`, excluding tests. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

/** `relative path -> number of suppressions in that file`. */
function suppressionsByFile(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of sourceFiles(SRC_DIR)) {
    const hits = readFileSync(file, 'utf-8')
      .split('\n')
      .filter((line) => SUPPRESSION.test(line)).length;
    if (hits > 0) counts.set(relative(SRC_DIR, file).split('\\').join('/'), hits);
  }
  return counts;
}

/** The ceiling. Lower it when suppressions go; never raise it. */
const MAX_SUPPRESSIONS = 1;

describe('react-hooks/exhaustive-deps ratchet', () => {
  describe('the suppression scan', () => {
    // Every way eslint accepts to switch the rule off must be counted, or a
    // suppression written in another form walks past the ceiling unseen.
    it.each([
      ['next-line comment', '    // eslint-disable-next-line react-hooks/exhaustive-deps'],
      ['same-line comment', '  }, [t]); // eslint-disable-line react-hooks/exhaustive-deps'],
      ['file-level block', '/* eslint-disable react-hooks/exhaustive-deps */'],
      ['block next-line', '  /* eslint-disable-next-line react-hooks/exhaustive-deps */'],
      [
        'rule named after another in a list',
        '// eslint-disable-next-line react-hooks/rules-of-hooks, react-hooks/exhaustive-deps',
      ],
      [
        'rule named before a reason',
        '// eslint-disable-next-line react-hooks/exhaustive-deps -- mount only',
      ],
    ])('counts a %s', (_form, line) => {
      expect(SUPPRESSION.test(line)).toBe(true);
    });

    it.each([
      ['another rule', '// eslint-disable-next-line no-console'],
      ['the rule switched back on', '/* eslint-enable react-hooks/exhaustive-deps */'],
    ])('ignores %s', (_form, line) => {
      expect(SUPPRESSION.test(line)).toBe(false);
    });
  });

  it('holds the suppression count at or below the ceiling', () => {
    const counts = suppressionsByFile();
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0);

    // Guard the guard: a rewritten scan that matched nothing would make this
    // test pass by measuring an empty set.
    expect(counts.size).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(MAX_SUPPRESSIONS);
  });

  it('suppresses the rule only in files that state why', () => {
    const counts = suppressionsByFile();
    const undocumented = [...counts.keys()].filter((file) => !(file in ALLOWED));

    expect(undocumented).toEqual([]);
  });

  it('keeps the ceiling tight against the files that still suppress', () => {
    // A ceiling well above the real count is not a ratchet, it is headroom.
    const total = [...suppressionsByFile().values()].reduce((sum, n) => sum + n, 0);

    expect(MAX_SUPPRESSIONS).toBe(total);
  });
});
