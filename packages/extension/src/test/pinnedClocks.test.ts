/**
 * A test that dates its world from a day written in its source pins this
 * machine's clock to it.
 *
 * The checkpoint store and its handler judge an undo's fifteen days, a
 * checkpoint's expiry and the recycle bin's reach by this machine's clock.
 * Tests that dated their org from 22 October and left that clock real passed
 * for fifteen days, then thirteen of them failed together on every branch,
 * each undo they offered refused as closed: nothing in them had changed but
 * the day. A test file that sets its origin from a written date — `const T0 =
 * Date.parse('2026-…')` — pins the clock to it (`vi.useFakeTimers` with that
 * origin, or `vi.setSystemTime`), so it runs the same on any day; one that
 * does not is named here the day it is written, not fifteen days later.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const PACKAGE = join(__dirname, '..', '..');

/** A time origin set from a date written in the source. */
const WRITTEN_ORIGIN =
  /^const ([A-Za-z_]*T0[A-Za-z_]*) = Date\.parse\('\d{4}-\d{2}-\d{2}[^']*'\);$/m;

/** Every test file of the package, by its path from the package. */
function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return entry.name.endsWith('.test.ts') ? [relative(PACKAGE, path)] : [];
  });
}

/** Whether `source` pins this machine's clock to its origin `name`, or sets it at all. */
function pinsTheClock(source: string, name: string): boolean {
  const pinnedToOrigin = new RegExp(
    `vi\\.useFakeTimers\\(\\{[^}]*toFake: \\['Date'\\][^}]*now: ${name}\\b`,
  );
  return pinnedToOrigin.test(source) || /vi\.setSystemTime\(/.test(source);
}

describe('test files that date their world from a written day', () => {
  const files = ['src', 'cli', 'tools'].flatMap((dir) => testFiles(join(PACKAGE, dir)));

  it('finds them: the checkpoint tests among them, and this one', () => {
    // Positive control: the walk reaches the files whose clock once ran out.
    expect(files).toContain('cli/sandforge-checkpoint.host.test.ts');
    expect(files).toContain('src/modules/checkpoint/undoCheckpoint.test.ts');
    expect(files).toContain('src/test/pinnedClocks.test.ts');
  });

  it('pins this machine’s clock to that day, so that none of them runs out with the calendar', () => {
    const unpinned = files.filter((file) => {
      const source = readFileSync(join(PACKAGE, file), 'utf8');
      const origin = WRITTEN_ORIGIN.exec(source);
      return origin !== null && !pinsTheClock(source, origin[1] ?? '');
    });
    expect(unpinned).toEqual([]);
  });

  it('tells a pinned file from one left to the real clock', () => {
    const origin = "const T0 = Date.parse('2026-10-22T14:05:12.731Z');";
    const left = `${origin}\nbeforeEach(() => {\n  clock = T0;\n});\n`;
    const pinned =
      `${origin}\nbeforeEach(() => {\n` +
      "  vi.useFakeTimers({ toFake: ['Date'], now: T0 + 60_000, shouldAdvanceTime: true });\n});\n";
    expect(WRITTEN_ORIGIN.exec(left)?.[1]).toBe('T0');
    expect(pinsTheClock(left, 'T0')).toBe(false);
    expect(pinsTheClock(pinned, 'T0')).toBe(true);
    // Pinned to another origin than its own, it still runs out.
    expect(pinsTheClock(pinned.replace('now: T0', 'now: LATER'), 'T0')).toBe(false);
  });
});
