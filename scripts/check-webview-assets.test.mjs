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
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  PAGES_THAT_VALIDATE,
  PAGE_FIRST_PAINT_BUDGET,
  bundleEnglishLoaders,
  bundleFiles,
  chunkImports,
  collectRequested,
  englishLoaders,
  namespaceSentinels,
  namespacesHeld,
  panelRoutes,
  panelShellNamespaces,
  preloadGaps,
  requestedAssets,
  routeFirstPaint,
  shellEnglishOutsideBase,
  staticBundleFiles,
  zodJitlessVerdict,
} from './check-webview-assets.mjs';

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
  assert.deepEqual(found.get('WebviewPanelManager.ts'), [
    'assets/index.js',
    'assets/preload.json',
    'assets/style.css',
  ]);
  assert.deepEqual(found.get('SidebarViewProvider.ts'), [
    'assets/sidepanel.css',
    'assets/sidepanel.js',
  ]);
});

test('importing the gate judges no build, and running it does', () => {
  // This file imports the reader, and the check used to run on import: it
  // judged whatever build was on disk, from a test `validate` runs before
  // `pnpm build`. A tree never built failed there, a tree built earlier
  // passed on its old build, and neither said anything of this tree.
  const gate = join(repoRoot, 'scripts', 'check-webview-assets.mjs');
  const imported = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(gate).href)});`],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(`${imported.stdout}${imported.stderr}`, '');

  const run = spawnSync(process.execPath, [gate], { cwd: repoRoot, encoding: 'utf8' });
  assert.match(`${run.stdout}${run.stderr}`, /^(PASS|FAIL): /m);
});

test('it reads the imports a minified ES chunk writes, and no package name', () => {
  const source =
    'import{r as e,t}from"./chunks/rolldown-runtime-a1.js";import"./chunks/side-b2.js";' +
    'export{x as y}from"../shared-c3.js";import{createRoot as k}from"react-dom";' +
    'const p=()=>import(`./chunks/SeedPage-d4.js`),q=()=>import("./chunks/Forge-e5.js");';
  assert.deepEqual(chunkImports(source), [
    './chunks/rolldown-runtime-a1.js',
    './chunks/side-b2.js',
    '../shared-c3.js',
    './chunks/SeedPage-d4.js',
    './chunks/Forge-e5.js',
  ]);
});

test('it follows a bundle into the chunks its chunks import, and names a missing one with its importer', () => {
  const built = new Map([
    ['assets/index.js', 'import"./chunks/a.js";const p=()=>import(`./chunks/page.js`);'],
    ['assets/chunks/a.js', 'export const a=1;'],
    ['assets/chunks/page.js', 'import{a}from"./a.js";import"./lost.js";'],
  ]);
  const { files, missing } = bundleFiles('assets/index.js', (path) => built.get(path));
  assert.deepEqual(files.sort(), [
    'assets/chunks/a.js',
    'assets/chunks/lost.js',
    'assets/chunks/page.js',
    'assets/index.js',
  ]);
  assert.deepEqual([...missing], [['assets/chunks/lost.js', 'assets/chunks/page.js']]);
});

test('it requires the file holding zod to turn its compiler off', () => {
  const zod = 'var t=e(`$ZodType`,(n,r)=>{});';
  assert.deepEqual(
    zodJitlessVerdict(new Map([['assets/chunks/zod.js', `${zod}S({jitless:!0});`]])),
    { path: 'assets/chunks/zod.js', jitless: true },
  );
  // The call left in another file, which runs after the chunks it imports.
  assert.deepEqual(
    zodJitlessVerdict(
      new Map([
        ['assets/index.js', 'import"./chunks/zod.js";S({jitless:!0});'],
        ['assets/chunks/zod.js', zod],
      ]),
    ),
    { path: 'assets/chunks/zod.js', jitless: false },
  );
  assert.equal(zodJitlessVerdict(new Map([['assets/sidepanel.js', 'no schema here']])), undefined);
});

test('it reads what a panel parses up front: the static imports, not the chunks loaded on demand', () => {
  const built = new Map([
    [
      'assets/index.js',
      'import{a}from"./chunks/a.js";const l={forge:()=>import(`./chunks/forge.js`)};',
    ],
    ['assets/chunks/a.js', 'import"./b.js";export const a=1;'],
    ['assets/chunks/b.js', 'export const b=2;'],
    ['assets/chunks/forge.js', 'import"./b.js";export default {title:`Forge`};'],
  ]);
  assert.deepEqual(staticBundleFiles('assets/index.js', (path) => built.get(path)).sort(), [
    'assets/chunks/a.js',
    'assets/chunks/b.js',
    'assets/index.js',
  ]);
});

test('it finds a namespace by a plain sentence of its own, and the namespaces a build holds', () => {
  const catalogue = {
    common: { cancel: 'Cancel', shared: 'Something both namespaces say' },
    forge: {
      title: 'Forge',
      hint: 'Copy a real record and everything around it',
      quoted: 'A "quoted" sentence longer than the plain one is',
      shared: 'Something both namespaces say',
    },
    nav: { home: 'Home' },
  };
  const sentinels = namespaceSentinels(catalogue);
  // A sentence two namespaces share tells neither apart; a quoted one may be
  // escaped by the minifier; a namespace of short labels has none.
  assert.deepEqual([...sentinels], [['forge', 'Copy a real record and everything around it']]);
  assert.deepEqual(namespacesHeld(['x=`Copy a real record and everything around it`'], sentinels), [
    'forge',
  ]);
  assert.deepEqual(namespacesHeld(['x=`Cancel`'], sentinels), []);
});

test('it reads the namespaces the panel catalogue starts with', () => {
  const source = [
    "import { a11y, common, nav } from '../i18n/locales/en.json';",
    '',
    'export default { a11y, common, nav };',
  ].join('\n');
  assert.deepEqual(panelShellNamespaces(source), ['a11y', 'common', 'nav']);
  const onDisk = readFileSync(
    join(repoRoot, 'packages', 'webview', 'src', 'i18n', 'panelCatalogue.ts'),
    'utf8',
  );
  assert.ok(panelShellNamespaces(onDisk).includes('common'), 'the catalogue on disk is not read');
});

test('it reads the routes of the panel bundle as the minifier leaves them, a namespace object read too', () => {
  const source =
    'var Ao={home:L(()=>import(`./chunks/HomePage-a1.js`),`HomePage`,[`errors`,`status`]),' +
    'seed:L(()=>import(`./chunks/SeedPage-b2.js`).then(e=>e.t),`SeedPage`,[`seed`]),' +
    'ai:L(()=>import("./chunks/AIPage-c3.js"),"AIPage",["ai","errors"])};' +
    'var Wo=(0,A.lazy)(Ht(()=>import(`./chunks/WelcomePage-d4.js`).then(e=>({default:e.WelcomePage})),[`onboarding`]));';
  assert.deepEqual(panelRoutes(source), [
    {
      route: 'home',
      chunk: './chunks/HomePage-a1.js',
      page: 'HomePage',
      english: ['errors', 'status'],
    },
    { route: 'seed', chunk: './chunks/SeedPage-b2.js', page: 'SeedPage', english: ['seed'] },
    { route: 'ai', chunk: './chunks/AIPage-c3.js', page: 'AIPage', english: ['ai', 'errors'] },
  ]);
});

test('it reads the loaders of the English namespaces, and no route for one', () => {
  const source =
    'zt={forge:()=>import(`./chunks/forge-a1.js`),"a11y":()=>import("./chunks/a11y-b2.js")},' +
    'Ao={home:L(()=>import(`./chunks/HomePage-c3.js`),`HomePage`,[`errors`])};';
  assert.deepEqual(
    [...englishLoaders(source)],
    [
      ['forge', './chunks/forge-a1.js'],
      ['a11y', './chunks/a11y-b2.js'],
    ],
  );
});

test('it reads the loaders where the bundler put them, a chunk the bundle imports up front included', () => {
  // Imported by a step Forge loads on demand too, the loaders left the bundle
  // for a chunk of their own: read from the bundle alone, no page had English.
  const built = new Map([
    ['assets/index.js', 'import{t as e}from"./chunks/englishNamespaces-a1.js";'],
    [
      'assets/chunks/englishNamespaces-a1.js',
      'const n={forge:()=>import("./forge-b2.js"),forgeRun:()=>import("./forgeRun-c3.js")};',
    ],
    ['assets/chunks/StepLoadedLater.js', 'x={sync:()=>import("./sync-d4.js")};'],
  ]);
  assert.deepEqual(
    [...bundleEnglishLoaders('assets/index.js', (path) => built.get(path))],
    [
      ['forge', './chunks/forge-b2.js'],
      ['forgeRun', './chunks/forgeRun-c3.js'],
    ],
  );
});

test('it weighs what a page parses before it paints: the base, its chunk, its English, once each', () => {
  const built = new Map([
    ['assets/index.js', 'import"./chunks/react.js";'],
    ['assets/chunks/react.js', 'x'.repeat(100)],
    ['assets/chunks/Page.js', 'import"./react.js";import"./chart.js";' + 'p'.repeat(20)],
    ['assets/chunks/chart.js', 'c'.repeat(300)],
    // A chunk the page loads on demand weighs nothing on its first paint.
    ['assets/chunks/Lazy.js', 'l'.repeat(5000)],
    ['assets/chunks/forge.js', 'export default{}'],
  ]);
  const read = (path) => built.get(path);
  const loaders = new Map([['forge', './chunks/forge.js']]);
  const paint = routeFirstPaint(
    'assets/index.js',
    { route: 'forge', chunk: './chunks/Page.js', page: 'Page', english: ['forge', 'nowhere'] },
    loaders,
    read,
  );
  assert.deepEqual(paint.files.sort(), [
    'assets/chunks/Page.js',
    'assets/chunks/chart.js',
    'assets/chunks/forge.js',
    'assets/chunks/react.js',
    'assets/index.js',
  ]);
  const expected = paint.files.reduce((total, path) => total + Buffer.byteLength(read(path)), 0);
  assert.equal(paint.bytes, expected);
  assert.deepEqual(paint.unloaded, ['nowhere']);
});

test('it finds a namespace every panel starts with in a chunk outside the base, and only there', () => {
  const sentinels = new Map([
    ['common', 'Type the name of the org to confirm'],
    ['forge', 'Copy a real record and everything around it'],
  ]);
  const built = new Map([
    ['assets/index.js', 'x=`Type the name of the org to confirm`'],
    ['assets/chunks/common-a1.js', 'export default{t:`Type the name of the org to confirm`}'],
    [
      'assets/chunks/forge-b2.js',
      'export default{t:`Copy a real record and everything around it`}',
    ],
  ]);
  assert.deepEqual(
    shellEnglishOutsideBase(
      ['assets/index.js', 'assets/chunks/common-a1.js', 'assets/chunks/forge-b2.js'],
      ['assets/index.js'],
      (path) => built.get(path),
      sentinels,
      ['common'],
    ),
    [{ namespace: 'common', path: 'assets/chunks/common-a1.js' }],
  );
});

test('a page may parse no more than 900 kB before it paints, and only four pages may parse zod', () => {
  assert.equal(PAGE_FIRST_PAINT_BUDGET, 900_000);
  assert.deepEqual([...PAGES_THAT_VALIDATE.keys()].sort(), [
    'automation',
    'dataops',
    'forge',
    'migration',
  ]);
  assert.ok(!PAGES_THAT_VALIDATE.has('home'), 'Home reads a record id, and validates nothing');
});

test('the English catalogue gives most of its namespaces a sentence to be found by', () => {
  const en = JSON.parse(
    readFileSync(
      join(repoRoot, 'packages', 'webview', 'src', 'i18n', 'locales', 'en.json'),
      'utf8',
    ),
  );
  const sentinels = namespaceSentinels(en);
  assert.ok(
    sentinels.size >= 25,
    `only ${sentinels.size} of ${Object.keys(en).length} namespaces can be found in a build`,
  );
  // The big ones, whose place in the build the check is for.
  for (const namespace of ['forge', 'onboarding', 'errors', 'sync', 'seed', 'dataops']) {
    assert.ok(sentinels.has(namespace), `no sentence finds "${namespace}"`);
  }
});

test("it finds where the build's preload list and its own reading of the build differ", () => {
  const expected = new Map([
    ['forge', ['assets/chunks/ForgePage.js', 'assets/chunks/react.js']],
    ['home', ['assets/chunks/HomePage.js']],
  ]);

  assert.deepEqual(
    preloadGaps(
      {
        forge: ['assets/chunks/ForgePage.js', 'assets/chunks/react.js'],
        home: ['assets/chunks/HomePage.js'],
      },
      expected,
    ),
    [],
  );
  const gaps = preloadGaps(
    { forge: ['assets/chunks/ForgePage.js', 'assets/chunks/Old.js'], ghost: [] },
    expected,
  );
  assert.equal(gaps.length, 4);
  assert.match(gaps[0], /leaves out 1 file\(s\) the "forge" page needs .*react\.js/);
  assert.match(gaps[1], /names 1 file\(s\) the "forge" page does not need .*Old\.js/);
  assert.match(gaps[2], /lists nothing for the "home" page/);
  assert.match(gaps[3], /lists "ghost", no route of the panel/);
  assert.deepEqual(preloadGaps(['assets/index.js'], expected), [
    'assets/preload.json is not a list by route',
  ]);
});
