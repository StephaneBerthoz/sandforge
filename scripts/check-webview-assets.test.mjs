/**
 * The asset gate reads the providers with a regular expression, and that is its
 * single point of failure: a shape it does not match is an asset it does not
 * check, and the gate passes. `check-webview-assets.mjs` guards the worst case
 * with a floor on how many paths it found — four, two bundles and two
 * stylesheets — but the floor cannot tell a shape it misreads from one it
 * misses.
 *
 * So the extractor is tested against the shapes the providers really use, and
 * against the ones it must not accept.
 *
 * Run: node --test scripts/check-webview-assets.test.mjs
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { collectRequested, requestedAssets } from './check-webview-assets.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROVIDERS = join(repoRoot, 'packages', 'extension', 'src', 'providers');

test('it reads the shape the panel manager uses', () => {
  const source = `
    const scriptUri = webview.asWebviewUri(
      joinPath(this.extensionUri, 'webview-dist', 'assets', 'index.js') as vscode.Uri,
    );
  `;
  assert.deepEqual(requestedAssets(source), ['assets/index.js']);
});

test('it reads the shape Prettier leaves when the call wraps', () => {
  const source = `
    const styleUri = webview.asWebviewUri(
      joinPath(
        this.extensionUri,
        'webview-dist',
        'assets',
        'sidepanel.css',
      ),
    );
  `;
  assert.deepEqual(requestedAssets(source), ['assets/sidepanel.css']);
});

test('it reads several paths from one file, in order', () => {
  const source = `
    joinPath(base, 'webview-dist', 'assets', 'index.js');
    joinPath(base, 'webview-dist', 'assets', 'style.css');
    joinPath(base, 'webview-dist', 'locales', 'fr.json');
  `;
  assert.deepEqual(requestedAssets(source), [
    'assets/index.js',
    'assets/style.css',
    'locales/fr.json',
  ]);
});

test('it ignores a join that is not under webview-dist', () => {
  const source = `
    joinPath(this.extensionUri, 'dist', 'extension.js');
    joinPath(this.extensionUri, 'resources', 'icon.png');
  `;
  assert.deepEqual(requestedAssets(source), []);
});

test('it does not invent a path from a computed segment', () => {
  // A name built at runtime cannot be checked against the file system, and
  // reporting it as a literal would fail the gate on a file that is fine. The
  // `requested.size < 4` floor is what catches a provider that moved to this
  // shape wholesale.
  const source = "joinPath(this.extensionUri, 'webview-dist', 'assets', `${name}.css`);";
  assert.deepEqual(requestedAssets(source), []);
});

test('it attributes each path to every file that asks for it', () => {
  const byPath = collectRequested([
    { file: 'a.ts', source: "joinPath(u, 'webview-dist', 'assets', 'style.css')" },
    { file: 'b.ts', source: "joinPath(u, 'webview-dist', 'assets', 'style.css')" },
    { file: 'c.ts', source: "joinPath(u, 'webview-dist', 'assets', 'index.js')" },
  ]);
  assert.deepEqual(byPath.get('assets/style.css'), ['a.ts', 'b.ts']);
  assert.deepEqual(byPath.get('assets/index.js'), ['c.ts']);
});

test('the providers on disk still use a shape it reads', () => {
  // The gate is worthless the day the providers resolve their assets some other
  // way, and it would go green rather than red. This is the tripwire: it names
  // the files that hold the calls today and the count they yield.
  const found = new Map();
  for (const name of readdirSync(PROVIDERS)) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
    const paths = requestedAssets(readFileSync(join(PROVIDERS, name), 'utf8'));
    if (paths.length > 0) found.set(name, paths.sort());
  }
  assert.deepEqual(
    [...found.keys()].sort(),
    ['SidebarViewProvider.ts', 'WebviewPanelManager.ts'],
    'the webview-dist paths moved out of the two providers the gate reads',
  );
  assert.deepEqual(found.get('WebviewPanelManager.ts'), ['assets/index.js', 'assets/style.css']);
  assert.deepEqual(found.get('SidebarViewProvider.ts'), [
    'assets/sidepanel.css',
    'assets/sidepanel.js',
  ]);
});
