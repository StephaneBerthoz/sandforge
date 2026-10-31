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
 *  - every chunk a bundle imports, statically or on demand, and every chunk
 *    those import, is in the build too. The panel bundle is an ES module that
 *    loads each page as a chunk with a hashed name the providers never spell
 *    out: a chunk the build or the VSIX lost is a page that never opens, and
 *    nothing else would say so;
 *  - the file that holds zod also turns its compiler off (`jitless`). zod
 *    probes `new Function` as each schema is built, which the webview CSP
 *    reports as a `script-src eval` violation. A chunk's imports run before
 *    it, so a call left in index.js ran after the schemas its chunks built;
 *  - what every panel parses before its page — the panel bundle and the
 *    chunks it imports up front — holds neither zod nor the English of a
 *    namespace `src/i18n/panelCatalogue.ts` leaves out, and holds the ones it
 *    names; every namespace is in some file the panel loads. Each namespace
 *    is found by its longest plain sentence. The base held both, 380 kB of
 *    the 874 every panel parsed, and every source-level test passed;
 *  - the namespaces every panel starts with have no loader and are in no
 *    chunk outside that base: their chunks were built and shipped, and never
 *    fetched;
 *  - what each page parses before it paints — that base, the page's chunk
 *    and what it imports up front, the English its route names — stays within
 *    PAGE_FIRST_PAINT_BUDGET, and holds zod only on a page that checks
 *    something against a schema before it paints (PAGES_THAT_VALIDATE). Forge
 *    parsed 1.4 MB before its first step, Home zod for a record id;
 *  - the list of what each page needs before it paints, which the build
 *    writes (`assets/preload.json`) and the panel's shell links for the
 *    webview to fetch at once, names for each route exactly the files this
 *    reading of the build finds: a file it leaves out is fetched one round
 *    later, and one it names in excess is fetched for nothing;
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
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
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

/**
 * The relative modules a built script imports: `import … from "./x.js"`,
 * `import "./x.js"`, `export … from "./x.js"` and `import("./x.js")`, the last
 * with any of the three quotes a minifier writes. Bare specifiers (an npm
 * package) are not files of the build and are left out.
 */
export function chunkImports(source) {
  const found = [];
  const staticForm =
    /(?:^|[;}\s])(?:import|export)\s*(?:[^'"`()]*?\bfrom\s*)?(['"])(\.{1,2}\/[^'"`]+)\1/g;
  const dynamicForm = /\bimport\(\s*(['"`])(\.{1,2}\/[^'"`]+)\1\s*\)/g;
  for (const match of source.matchAll(staticForm)) found.push(match[2]);
  for (const match of source.matchAll(dynamicForm)) found.push(match[2]);
  return found;
}

/**
 * Every file a bundle loads, as posix paths relative to `webview-dist`: the
 * bundle and the chunks it imports, followed through the chunks they import.
 * A file the build does not hold is listed too, for the caller to report.
 *
 * @param entry - The bundle, e.g. `assets/index.js`.
 * @param read - Reads a path relative to `webview-dist`; undefined when absent.
 */
export function bundleFiles(entry, read) {
  const seen = new Set();
  const missing = new Map();
  const queue = [entry];
  while (queue.length > 0) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    const source = read(path);
    if (source === undefined) continue;
    for (const specifier of chunkImports(source)) {
      const target = posix.normalize(posix.join(posix.dirname(path), specifier));
      if (read(target) === undefined && !missing.has(target)) missing.set(target, path);
      queue.push(target);
    }
  }
  return { files: [...seen], missing };
}

/**
 * Whether the file of `files` that defines zod's schema classes also turns
 * zod's compiler off. Undefined when no file holds zod.
 *
 * @param files - Map of path to source.
 */
export function zodJitlessVerdict(files) {
  // The name zod gives its base schema class, a string any minifier keeps.
  const zodFile = [...files].find(([, source]) => /["'`]\$ZodType["'`]/.test(source));
  if (!zodFile) return undefined;
  const [path, source] = zodFile;
  return { path, jitless: /jitless\s*:\s*(?:!0|true)\b/.test(source) };
}

/**
 * What every panel parses before its page can paint: the panel bundle and the
 * chunks it imports statically, followed through theirs. A chunk loaded on
 * demand — a page, a namespace of the English catalogue — is parsed only by
 * the panel that asks for it.
 *
 * @param entry - The bundle, e.g. `assets/index.js`.
 * @param read - Reads a path relative to `webview-dist`; undefined when absent.
 */
export function staticBundleFiles(entry, read) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    const source = read(path);
    if (source === undefined) continue;
    seen.add(path);
    const dynamic = new Set(
      [...source.matchAll(/\bimport\(\s*(['"`])(\.{1,2}\/[^'"`]+)\1\s*\)/g)].map((m) => m[2]),
    );
    for (const specifier of chunkImports(source)) {
      if (dynamic.has(specifier)) continue;
      queue.push(posix.normalize(posix.join(posix.dirname(path), specifier)));
    }
  }
  return [...seen];
}

/**
 * A string of each namespace of a catalogue that a build can be searched
 * for: its longest value written in plain words, which a minifier leaves as
 * it is, and which no other namespace holds. Namespaces with no such value
 * (a few short labels) are left out.
 *
 * @param catalogue - A locale catalogue, keyed by namespace.
 */
export function namespaceSentinels(catalogue) {
  const strings = (node) =>
    typeof node === 'string'
      ? [node]
      : node && typeof node === 'object'
        ? Object.values(node).flatMap(strings)
        : [];
  const byNamespace = new Map(
    Object.entries(catalogue).map(([namespace, node]) => [namespace, strings(node)]),
  );
  const sentinels = new Map();
  for (const [namespace, values] of byNamespace) {
    const elsewhere = new Set(
      [...byNamespace].filter(([other]) => other !== namespace).flatMap(([, own]) => own),
    );
    const plain = values
      .filter((value) => /^[A-Za-z][A-Za-z0-9 ,.()-]{15,}$/.test(value) && !elsewhere.has(value))
      .sort((a, b) => b.length - a.length);
    if (plain.length > 0) sentinels.set(namespace, plain[0]);
  }
  return sentinels;
}

/**
 * The namespaces whose sentinel one of `sources` holds.
 *
 * @param sources - The built files' sources.
 * @param sentinels - From {@link namespaceSentinels}.
 */
export function namespacesHeld(sources, sentinels) {
  return [...sentinels]
    .filter(([, sentinel]) => sources.some((source) => source.includes(sentinel)))
    .map(([namespace]) => namespace)
    .sort();
}

/** The namespaces of the English catalogue a panel starts with (src/i18n/panelCatalogue.ts). */
export function panelShellNamespaces(source) {
  const body = /export\s+default\s*\{([^}]*)\}/.exec(source);
  return body
    ? body[1]
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
        .sort()
    : [];
}

/**
 * The most a page may parse before it paints, in bytes: the panel bundle and
 * the chunks it imports up front, the page's chunk and the chunks that one
 * imports, and the English its route names (PanelRouter's `page` calls).
 *
 * Forge parsed 1.4 MB before its input step painted, Reports 1.2 MB before
 * its Executions tab, Monitor and Sync more than 1.1 MB: libraries their
 * first screen does not draw (Recharts, React Flow), zod for a constant, and
 * whole namespaces of English for a few words. 900 kB is what every page
 * reached once those came on demand, Sync the heaviest at 882 kB.
 */
export const PAGE_FIRST_PAINT_BUDGET = 900_000;

/**
 * The pages that check something against a schema before they paint, and
 * may parse zod with it, each with what it checks. Any other page parses no
 * zod before it paints: Home parsed it, 94 kB, to read a record id.
 */
export const PAGES_THAT_VALIDATE = new Map([
  ['forge', 'a SOQL filter typed in, against the rule the extension holds every filter to'],
  ['dataops', 'a masking template the user saves or imports, against the template schema'],
  ['migration', 'the configuration the user edits, against the Sync configuration schema'],
  [
    'automation',
    "a Checkpoint or Rewind step's configuration, against the schema the extension runs it by",
  ],
]);

/**
 * The routes of the panel, read from the panel bundle: each `page()` call of
 * src/PanelRouter.tsx as the minifier leaves it, with the chunk the route
 * loads, the page's export and the namespaces of English its loader names.
 * The bundler may read the export off the chunk's namespace object
 * (`.then(e=>e.t)`) when another chunk imports the page too.
 *
 * @param source - The panel bundle's source.
 */
export function panelRoutes(source) {
  const call =
    /([A-Za-z_$][\w$]*)\s*:\s*[\w$]+\(\s*\(\)\s*=>\s*import\(\s*(['"`])(\.{1,2}\/[^'"`]+)\2\s*\)(?:\s*\.then\(\s*[\w$]+\s*=>\s*[\w$]+\.[\w$]+\s*\))?\s*,\s*(['"`])(\w+)\4\s*,\s*\[([^\]]*)\]/g;
  return [...source.matchAll(call)].map((match) => ({
    route: match[1],
    chunk: match[3],
    page: match[5],
    english: [...match[6].matchAll(/['"`](\w+)['"`]/g)].map((name) => name[1]),
  }));
}

/**
 * The loaders of the English catalogue's namespaces, read from the panel
 * bundle (vite.config.ts `englishCatalogue`): each namespace with the chunk
 * that holds it.
 *
 * @param source - The panel bundle's source.
 */
export function englishLoaders(source) {
  const loader =
    /[{,]\s*(['"`]?)([A-Za-z][A-Za-z0-9]*)\1\s*:\s*\(\)\s*=>\s*import\(\s*(['"`])(\.{1,2}\/[^'"`]+)\3\s*\)/g;
  return new Map([...source.matchAll(loader)].map((match) => [match[2], match[4]]));
}

/**
 * The loaders of the English catalogue's namespaces wherever the bundler put
 * them among what the panel bundle imports up front: in the bundle, or in a
 * chunk of their own once a part loaded on demand imports them too, as the
 * Forge steps do (`withEnglish`). Each chunk as a specifier from the
 * bundle's folder, as {@link englishLoaders} reads one from the bundle.
 *
 * @param entry - The panel bundle, e.g. `assets/index.js`.
 * @param read - Reads a path relative to `webview-dist`; undefined when absent.
 */
export function bundleEnglishLoaders(entry, read) {
  const loaders = new Map();
  for (const file of staticBundleFiles(entry, read)) {
    for (const [namespace, specifier] of englishLoaders(read(file) ?? '')) {
      const path = posix.normalize(posix.join(posix.dirname(file), specifier));
      loaders.set(namespace, `./${posix.relative(posix.dirname(entry), path)}`);
    }
  }
  return loaders;
}

/**
 * What a panel parses before a route's page paints: what every panel parses
 * up front, the page's chunk and the chunks it imports up front, and the
 * chunks of the English the route names, as posix paths relative to
 * `webview-dist`, with their size in bytes. A namespace no loader holds is
 * listed, for the caller to report.
 *
 * @param entry - The panel bundle, e.g. `assets/index.js`.
 * @param route - From {@link panelRoutes}.
 * @param loaders - From {@link bundleEnglishLoaders}.
 * @param read - Reads a path relative to `webview-dist`; undefined when absent.
 */
export function routeFirstPaint(entry, route, loaders, read) {
  const at = (specifier) => posix.normalize(posix.join(posix.dirname(entry), specifier));
  const files = new Set(staticBundleFiles(entry, read));
  for (const file of staticBundleFiles(at(route.chunk), read)) files.add(file);
  const unloaded = [];
  for (const namespace of route.english) {
    const chunk = loaders.get(namespace);
    if (!chunk) {
      unloaded.push(namespace);
      continue;
    }
    for (const file of staticBundleFiles(at(chunk), read)) files.add(file);
  }
  const sizes = new Map([...files].map((file) => [file, Buffer.byteLength(read(file) ?? '')]));
  const bytes = [...sizes.values()].reduce((total, size) => total + size, 0);
  return { files: [...files], sizes, bytes, unloaded };
}

/**
 * The chunks outside what every panel parses up front that hold the English
 * of a namespace every panel starts with: built, shipped, and never fetched,
 * since a panel holds those namespaces from the start.
 *
 * @param paths - The chunks the panel bundle loads.
 * @param base - What it imports up front, from {@link staticBundleFiles}.
 * @param read - Reads a path relative to `webview-dist`.
 * @param sentinels - From {@link namespaceSentinels}.
 * @param shell - The namespaces a panel starts with ({@link panelShellNamespaces}).
 */
export function shellEnglishOutsideBase(paths, base, read, sentinels, shell) {
  const shellSentinels = new Map([...sentinels].filter(([namespace]) => shell.includes(namespace)));
  return paths
    .filter((path) => !base.includes(path))
    .flatMap((path) =>
      namespacesHeld([read(path) ?? ''], shellSentinels).map((namespace) => ({ namespace, path })),
    );
}

/** Where the build writes what each page needs before it paints. */
export const PAGE_PRELOAD_LIST = 'assets/preload.json';

/**
 * How the build's list of what each page needs before it paints differs from
 * what a reading of the build finds: a route it leaves out, a route it names
 * that the panel has not, a file missing for a route or named in excess.
 *
 * @param list - The list as the build wrote it, parsed; anything else is a gap.
 * @param expected - For each route, the files it needs, the panel bundle aside.
 * @returns One sentence per gap.
 */
export function preloadGaps(list, expected) {
  if (!list || typeof list !== 'object' || Array.isArray(list)) {
    return [`${PAGE_PRELOAD_LIST} is not a list by route`];
  }
  const gaps = [];
  for (const [route, files] of expected) {
    const listed = list[route];
    if (!Array.isArray(listed)) {
      gaps.push(`${PAGE_PRELOAD_LIST} lists nothing for the "${route}" page`);
      continue;
    }
    const missing = files.filter((file) => !listed.includes(file));
    const extra = listed.filter((file) => !files.includes(file));
    if (missing.length > 0) {
      gaps.push(
        `${PAGE_PRELOAD_LIST} leaves out ${missing.length} file(s) the "${route}" page needs ` +
          `before it paints, fetched one round later: ${missing.slice(0, 3).join(', ')}`,
      );
    }
    if (extra.length > 0) {
      gaps.push(
        `${PAGE_PRELOAD_LIST} names ${extra.length} file(s) the "${route}" page does not need ` +
          `before it paints: ${extra.slice(0, 3).join(', ')}`,
      );
    }
  }
  for (const route of Object.keys(list)) {
    if (!expected.has(route))
      gaps.push(`${PAGE_PRELOAD_LIST} lists "${route}", no route of the panel`);
  }
  return gaps;
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

/** A size in bytes, as kB to one decimal. */
function kiloBytes(bytes) {
  return `${(bytes / 1000).toFixed(1)} kB`;
}

/** Judges the build on disk, and the VSIX with `--vsix`; exits 1 on a gap. */
function main() {
  const fail = [];
  const note = (message) => fail.push(message);
  /** The page that parses the most before it paints, for the summary. */
  let heaviestPage;

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

  // 3. Every chunk a bundle loads is built, and the one holding zod turns
  // its compiler off. Read once each, so a chunk two bundles share costs one
  // read.
  const builtDir = join(repoRoot, BUILT_DIR);
  const cache = new Map();
  const readBuilt = (path) => {
    if (!cache.has(path)) {
      const onDisk = join(builtDir, path);
      cache.set(path, existsSync(onDisk) ? readFileSync(onDisk, 'utf8') : undefined);
    }
    return cache.get(path);
  };
  const loaded = new Set();
  for (const bundle of [...requested.keys()].filter((path) => path.endsWith('.js')).sort()) {
    if (readBuilt(bundle) === undefined) continue;
    const { files, missing } = bundleFiles(bundle, readBuilt);
    for (const file of files)
      if (file !== bundle && readBuilt(file) !== undefined) loaded.add(file);
    for (const [target, importer] of missing) {
      note(
        `${BUILT_DIR}/${target} does not exist, and ${importer} imports it — the page or the ` +
          `code it needs would fail to load in ${bundle}`,
      );
    }
    const sources = new Map(
      files.flatMap((file) => {
        const source = readBuilt(file);
        return source === undefined ? [] : [[file, source]];
      }),
    );
    const verdict = zodJitlessVerdict(sources);
    if (verdict && !verdict.jitless) {
      note(
        `${BUILT_DIR}/${verdict.path} holds zod, and not the call that turns its compiler off ` +
          `(src/zodJitless.ts): every schema ${bundle} builds would probe \`new Function\` and the ` +
          'CSP would report a script-src eval. Keep zodJitless in the chunk that holds zod.',
      );
    }
  }

  // 4. What every panel parses before its page holds neither zod nor the
  // English of a page: each comes with the pages that need it. Both were in
  // it, and only a reading of the build can tell: the sources that load them
  // on demand say nothing of where the bundler put them.
  const panelBundle = [...requested.keys()].find((path) => path.endsWith('/index.js'));
  if (panelBundle && readBuilt(panelBundle) !== undefined) {
    const base = staticBundleFiles(panelBundle, readBuilt);
    const baseSources = base.map((path) => readBuilt(path));
    const zodFile = base.find((path) => /["'`]\$ZodType["'`]/.test(readBuilt(path)));
    if (zodFile) {
      note(
        `${BUILT_DIR}/${zodFile} holds zod and ${panelBundle} imports it up front: every panel ` +
          'parses zod before its page, whether or not the page validates anything',
      );
    }
    const catalogue = JSON.parse(
      readFileSync(
        join(repoRoot, 'packages', 'webview', 'src', 'i18n', 'locales', 'en.json'),
        'utf8',
      ),
    );
    const shell = panelShellNamespaces(
      readFileSync(
        join(repoRoot, 'packages', 'webview', 'src', 'i18n', 'panelCatalogue.ts'),
        'utf8',
      ),
    );
    const sentinels = namespaceSentinels(catalogue);
    const held = namespacesHeld(baseSources, sentinels);
    const shipped = namespacesHeld(
      [...loaded, ...requested.keys()]
        .map((path) => readBuilt(path))
        .filter((source) => source !== undefined),
      sentinels,
    );
    for (const namespace of held.filter((n) => !shell.includes(n))) {
      note(
        `the English of "${namespace}" is in what ${panelBundle} imports up front, and ` +
          'src/i18n/panelCatalogue.ts leaves it out: every panel parses it before its page',
      );
    }
    for (const namespace of shell.filter((n) => sentinels.has(n) && !held.includes(n))) {
      note(
        `the English of "${namespace}", which every panel starts with, is not in what ` +
          `${panelBundle} imports up front — the shell would show its keys`,
      );
    }
    for (const namespace of [...sentinels.keys()].filter((n) => !shipped.includes(n))) {
      note(`the English of "${namespace}" is in no file the panel loads`);
    }

    // The namespaces every panel starts with have no chunk of their own: a
    // panel holds them from the start and asks for none of them.
    const loaders = bundleEnglishLoaders(panelBundle, readBuilt);
    for (const namespace of shell.filter((n) => loaders.has(n))) {
      note(
        `${panelBundle} has a loader for the English of "${namespace}", which every panel ` +
          'starts with: its chunk is built, shipped and never fetched',
      );
    }
    const panelChunks = bundleFiles(panelBundle, readBuilt).files.filter(
      (path) => path !== panelBundle && readBuilt(path) !== undefined,
    );
    for (const { namespace, path } of shellEnglishOutsideBase(
      panelChunks,
      base,
      readBuilt,
      sentinels,
      shell,
    )) {
      note(
        `${BUILT_DIR}/${path} holds the English of "${namespace}", which every panel starts ` +
          'with: a chunk built and shipped that no panel fetches',
      );
    }

    // 5. What each page parses before it paints stays within the budget,
    // and holds zod only where the page checks something against a schema.
    const routes = panelRoutes(readBuilt(panelBundle));
    const declared = (
      readFileSync(join(repoRoot, 'packages', 'webview', 'src', 'PanelRouter.tsx'), 'utf8').match(
        /\bpage\(\s*\(\)\s*=>\s*import\(/g,
      ) ?? []
    ).length;
    if (routes.length === 0 || routes.length !== declared) {
      note(
        `${panelBundle} reads as ${routes.length} route(s), where src/PanelRouter.tsx declares ` +
          `${declared}: the weight of a page this does not read is checked by nothing`,
      );
    }
    for (const route of routes) {
      const paint = routeFirstPaint(panelBundle, route, loaders, readBuilt);
      for (const namespace of paint.unloaded) {
        note(
          `the "${route.route}" page names the English of "${namespace}", which no loader holds`,
        );
      }
      if (paint.bytes > PAGE_FIRST_PAINT_BUDGET) {
        const heaviest = [...paint.sizes]
          .filter(([path]) => !base.includes(path))
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([path, size]) => `${posix.basename(path)} ${kiloBytes(size)}`)
          .join(', ');
        note(
          `the "${route.route}" page parses ${kiloBytes(paint.bytes)} before it paints, past the ` +
            `${kiloBytes(PAGE_FIRST_PAINT_BUDGET)} a page may; heaviest past the base: ${heaviest}`,
        );
      }
      const zodFile = paint.files.find((path) => /["'`]\$ZodType["'`]/.test(readBuilt(path) ?? ''));
      if (zodFile && !PAGES_THAT_VALIDATE.has(route.route)) {
        note(
          `the "${route.route}" page parses zod (${zodFile}) before it paints, and checks ` +
            'nothing against a schema there (PAGES_THAT_VALIDATE)',
        );
      }
      if (!heaviestPage || paint.bytes > heaviestPage.bytes) {
        heaviestPage = { route: route.route, bytes: paint.bytes };
      }
    }
    for (const route of PAGES_THAT_VALIDATE.keys()) {
      if (!routes.some((candidate) => candidate.route === route)) {
        note(`PAGES_THAT_VALIDATE names "${route}", which is no route of the panel`);
      }
    }

    // 6. The build's list of what each page needs before it paints, which the
    // shell links, is what this reading finds.
    const preloadText = readBuilt(PAGE_PRELOAD_LIST);
    if (preloadText !== undefined) {
      let list;
      try {
        list = JSON.parse(preloadText);
      } catch {
        list = undefined;
      }
      const expected = new Map(
        routes.map((route) => [
          route.route,
          routeFirstPaint(panelBundle, route, loaders, readBuilt)
            .files.filter((file) => file !== panelBundle)
            .sort(),
        ]),
      );
      for (const gap of preloadGaps(list, expected)) note(gap);
    }
  }

  // 7. The VSIX carries them too, for a caller that just packaged one.
  const checkVsix = process.argv.includes('--vsix');
  if (checkVsix) {
    if (!existsSync(join(repoRoot, VSIX))) {
      note(
        `--vsix was asked for and ${VSIX} is not there — nothing was checked against the artifact`,
      );
    } else {
      const listing = execFileSync('unzip', ['-l', join(repoRoot, VSIX)], { encoding: 'utf8' });
      for (const path of [...requested.keys(), ...loaded].sort()) {
        if (!listing.includes(`extension/webview-dist/${path}`)) {
          note(
            `${VSIX} has no extension/webview-dist/${path} — an install would render without it`,
          );
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
    `PASS: webview assets — ${requested.size} path(s) linked by the providers and ` +
      `${loaded.size} chunk(s) they import, all built` +
      (checkVsix ? ' and present in the VSIX' : '') +
      `: ${[...requested.keys()].sort().join(', ')}` +
      (heaviestPage
        ? `; heaviest first paint: ${heaviestPage.route} ${kiloBytes(heaviestPage.bytes)} of ` +
          `${kiloBytes(PAGE_FIRST_PAINT_BUDGET)}`
        : ''),
  );
}

// Run, not imported: the test imports the reader above, and the check judges
// a build. Run on import, it judged whatever build was on disk from the test,
// which `validate` runs before `pnpm build`: a tree never built failed there,
// and a tree built earlier passed on its old build.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
