/**
 * Gate: no two modules of one folder share a name that differs only by case.
 *
 * `ModuleHowTo.tsx` and `moduleHowTo.ts` stood side by side in
 * packages/webview/src/components/ui. On Linux, `import … from './ModuleHowTo'`
 * found the component; on the case-insensitive disks of macOS and Windows the
 * resolver tried `.ts` first and found the registry, and CI failed there alone
 * ("has no exported member named 'ModuleHowTo'"), every local gate green.
 * An import names a module without its extension, so the check is on names
 * without it, among the extensions an import resolves; `SidePanel.tsx` beside
 * `sidepanel.css` is imported with its extension and is left alone.
 *
 * Run: node --test scripts/case-collisions.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

const RESOLVED = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** Pairs of tracked modules in one folder whose names differ only by case. */
export function caseCollisions(paths) {
  const seen = new Map();
  const found = [];
  for (const path of paths.filter((p) => RESOLVED.test(p))) {
    const name = path.replace(RESOLVED, '');
    const key = name.toLowerCase();
    const other = seen.get(key);
    if (other !== undefined && other.replace(RESOLVED, '') !== name) found.push([other, path]);
    else if (other === undefined) seen.set(key, path);
  }
  return found;
}

test('no two modules of a folder differ only by the case of their name', () => {
  const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n');
  assert.deepEqual(caseCollisions(tracked), []);
});

test('a component and a module of the same name in another case are caught, a stylesheet is not', () => {
  assert.deepEqual(caseCollisions(['ui/ModuleHowTo.tsx', 'ui/moduleHowTo.ts']), [
    ['ui/ModuleHowTo.tsx', 'ui/moduleHowTo.ts'],
  ]);
  assert.deepEqual(caseCollisions(['src/SidePanel.tsx', 'src/sidepanel.css']), []);
  assert.deepEqual(caseCollisions(['ui/Card.tsx', 'ui/Card.test.tsx', 'other/card.ts']), []);
});
