/**
 * Gate: no Playwright spec reaches into the panel's modules by the URL the dev
 * server serves them under.
 *
 * Two axe tests of Forge Review put their gaps on screen by importing
 * `/src/stores/useForgeStore.ts` from the page and calling the store. The dev
 * server serves a module again under a `?t=` stamp once its file changes, and
 * the panel then imports the stamped URL while the test's import still names
 * the bare path: a second copy of the module, a store the panel never reads,
 * and a test that failed on a page that had done nothing wrong. Touching the
 * store's file once before the run turned all eight of them red. A spec puts
 * a state on screen the way the extension does, through the messages the
 * page listens to.
 *
 * What it reads: every string in the specs, helpers and harness under
 * `packages/webview/e2e` that names a path the dev server serves modules
 * under — `/src/`, `/node_modules/`, `/@fs/`, `/@id/`. A spec's own imports
 * (`../src/…`) are read by Playwright in Node, not by the page, and pass.
 *
 * Run: node --test scripts/e2e-served-modules.test.mjs
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const E2E_DIR = join(root, 'packages', 'webview', 'e2e');

/** A quoted string, or the head of a template, that starts with a path the dev server serves modules under. */
const SERVED_PATH = /(['"`])(\/(?:src|node_modules|@fs|@id)\/[^'"`$]*)/g;

/** The served module paths `source` names. */
export function servedPaths(source) {
  return [...source.matchAll(SERVED_PATH)].map((match) => match[2]);
}

test('the reader finds a served path in each of the forms a spec writes it', () => {
  assert.deepEqual(servedPaths("await import('/src/stores/useForgeStore.ts')"), [
    '/src/stores/useForgeStore.ts',
  ]);
  assert.deepEqual(servedPaths('{ storeModule: "/src/stores/useForgeStore.ts" }'), [
    '/src/stores/useForgeStore.ts',
  ]);
  assert.deepEqual(servedPaths('import(`/node_modules/.vite/deps/zustand.js`)'), [
    '/node_modules/.vite/deps/zustand.js',
  ]);
  assert.deepEqual(servedPaths("import { x } from '../src/styles/testing/vscodeThemes';"), []);
  assert.deepEqual(servedPaths("await page.goto('/e2e/harness/unwired-reports.html');"), []);
});

test('no spec, helper or harness names a module by the URL the dev server serves it under', () => {
  const files = readdirSync(E2E_DIR, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(tsx?|html)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
  assert.ok(files.length > 20, `only ${files.length} file(s) under e2e — has the folder moved?`);
  const offenders = files.flatMap((file) =>
    servedPaths(readFileSync(file, 'utf8')).map(
      (path) => `${relative(root, file).replace(/\\/g, '/')}: ${path}`,
    ),
  );
  assert.deepEqual(offenders, []);
});
