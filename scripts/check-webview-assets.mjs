/**
 * Every file the webview shell links to has to be a file the build produced.
 *
 * The HTML shell is assembled in the extension and the assets are emitted by
 * Vite, and nothing used to tie the two together. 1.23.0 shipped with the two
 * `<link rel="stylesheet">` tags pointing at `assets/style.css` and
 * `assets/sidepanel.css` while the build emitted a single `assets/webview.css`
 * — Vite 6 names the lib-mode stylesheet after the package, where Vite 5 named
 * it `style.css`. Both links 404'd, so every panel and the sidebar rendered
 * with no CSS at all: default button borders, the skip link visible, labels
 * with no spacing between them. Every gate passed. The unit tests mock
 * `vscode` and assert the shape of the HTML, the E2E suite loads the Vite
 * build directly rather than through the extension, and the VSIX payload
 * checks looked for the locale bundles and the lazy chunks, not for the
 * stylesheets.
 *
 * So this reads the paths out of the providers and asks the file system:
 *
 *  - every `webview-dist/assets/...` path the extension resolves exists in the
 *    built `webview-dist` and is not empty;
 *  - at least four of them are found (two bundles, two stylesheets), so a
 *    refactor that moves the calls out of reach fails here instead of checking
 *    nothing;
 *  - the panel and the sidebar link different stylesheets. Both Vite passes
 *    write into one `dist`, so one name for both means the second pass
 *    overwrites the first and the panels get the sidebar's CSS;
 *  - with `--vsix`, every one of those paths is in `sandforge.vsix` too. The
 *    VSIX is what a user installs, and `.vscodeignore` can drop a file the
 *    build produced. It is a flag rather than "check it if it is there"
 *    because a VSIX left over from an earlier run says nothing about this
 *    tree: only a caller that just packaged one knows it is current, and a
 *    caller that passes the flag and finds no VSIX fails.
 *
 * Runs after a build — `pnpm check:webview-assets`, wired into `validate`
 * after `pnpm build`, and with `--vsix` at the end of `package` and in
 * `pre-publish-check.sh`, so it always judges a real build instead of skipping
 * when there is none.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROVIDERS_DIR = join('packages', 'extension', 'src', 'providers');
const BUILT_DIR = join('packages', 'extension', 'webview-dist');
const VSIX = 'sandforge.vsix';

/**
 * The `webview-dist` paths a source file resolves, as posix paths relative to
 * `webview-dist`.
 *
 * Matches the one form the providers use: `joinPath(<base>, 'webview-dist',
 * 'assets', 'index.js')`, with any amount of whitespace or newlines between
 * the parts and an optional trailing comma — which is what Prettier writes as
 * soon as the call wraps over several lines, and what this missed until its
 * own test tried the wrapped shape.
 */
export function requestedAssets(source) {
  const call = /joinPath\(\s*[^,]+,\s*'webview-dist'\s*,\s*((?:'[^']+'\s*,\s*)*'[^']+')\s*,?\s*\)/g;
  const found = [];
  for (const match of source.matchAll(call)) {
    found.push([...match[1].matchAll(/'([^']+)'/g)].map((part) => part[1]).join('/'));
  }
  return found;
}

function providerSources() {
  const dir = join(repoRoot, PROVIDERS_DIR);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({
      file: join(PROVIDERS_DIR, name),
      source: readFileSync(join(dir, name), 'utf8'),
    }));
}

/** Paths the extension asks for, each with the files that ask for it. */
export function collectRequested(sources) {
  const byPath = new Map();
  for (const { file, source } of sources) {
    for (const path of requestedAssets(source)) {
      if (!byPath.has(path)) byPath.set(path, []);
      byPath.get(path).push(file);
    }
  }
  return byPath;
}

const fail = [];
const note = (message) => fail.push(message);

const requested = collectRequested(providerSources());

if (requested.size < 4) {
  note(
    `only ${requested.size} webview-dist path(s) found in ${PROVIDERS_DIR} — expected at least 4 ` +
      '(two bundles, two stylesheets). Has the resolution moved out of joinPath()?',
  );
}

// 1. Every requested path exists in the build, and carries bytes.
for (const [path, askers] of [...requested].sort()) {
  const onDisk = join(repoRoot, BUILT_DIR, path);
  if (!existsSync(onDisk)) {
    const siblings = existsSync(join(repoRoot, BUILT_DIR, 'assets'))
      ? readdirSync(join(repoRoot, BUILT_DIR, 'assets')).join(', ')
      : '(no assets directory)';
    note(
      `${BUILT_DIR}/${path} does not exist, and ${askers.join(', ')} links to it — ` +
        `the webview would load it as a 404. Built instead: ${siblings}`,
    );
  } else if (statSync(onDisk).size === 0) {
    note(`${BUILT_DIR}/${path} is empty, and ${askers.join(', ')} links to it`);
  }
}

// 2. The panel and the sidebar link different stylesheets.
const stylesheets = [...requested.keys()].filter((path) => path.endsWith('.css'));
if (stylesheets.length < 2) {
  note(
    `the providers link ${stylesheets.length} stylesheet(s) (${stylesheets.join(', ') || 'none'}) — ` +
      'the panels and the sidebar each need their own, since both Vite passes write into one dist',
  );
}

// 3. The VSIX carries them too, for a caller that just packaged one.
const checkVsix = process.argv.includes('--vsix');
if (checkVsix) {
  if (!existsSync(join(repoRoot, VSIX))) {
    note(
      `--vsix was asked for and ${VSIX} is not there — nothing was checked against the artifact`,
    );
  } else {
    const listing = execFileSync('unzip', ['-l', join(repoRoot, VSIX)], { encoding: 'utf8' });
    for (const path of [...requested.keys()].sort()) {
      if (!listing.includes(`extension/webview-dist/${path}`)) {
        note(`${VSIX} has no extension/webview-dist/${path} — an install would render without it`);
      }
    }
  }
}

if (fail.length > 0) {
  console.error('FAIL: the webview shell links files the build does not produce\n');
  for (const message of fail) console.error(`  - ${message}`);
  process.exit(1);
}

console.log(
  `PASS: webview assets — ${requested.size} path(s) linked by the providers, all built` +
    (checkVsix ? ' and present in the VSIX' : '') +
    `: ${[...requested.keys()].sort().join(', ')}`,
);
