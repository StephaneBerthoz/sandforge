#!/usr/bin/env node
/**
 * Vendor the Anthropic AI SDK — and every package its shipped runtime files
 * actually import, transitively — into `packages/extension/dist/node_modules/`.
 *
 * Nothing here is a hand-kept package list. The set is recomputed on every
 * build from what the copied files import, intersected with what the copied
 * package declares (`dependencies` + `peerDependencies`):
 *   - `json-schema-to-ts` does not ship, because it appears only in the SDK's
 *     type definitions — no shipped `.js`/`.mjs`/`.cjs` imports it;
 *   - `@modelcontextprotocol/sdk`, named in `helpers/beta/mcp` JSDoc, is not
 *     declared by the SDK at all, so it is not ours to vendor;
 *   - `zod` does not ship either. The SDK declares it as an OPTIONAL peer, and
 *     only its zod helpers import it (`helpers/zod`, `helpers/beta/zod`, and
 *     `helpers/index`, which re-exports the first). The extension loads none
 *     of them, so the copy leaves them out — and with them every import that
 *     would have pulled zod in.
 * An SDK bump that grows a real runtime dependency therefore vendors it on the
 * next build, and one whose dependency cannot be resolved fails the build —
 * instead of shipping a VSIX where every AI call throws MODULE_NOT_FOUND. The
 * prune is held to the same standard: the build fails if an SDK entry point, or
 * anything `dist/extension.js` loads from the SDK, reaches a file left out.
 * The residual blind spot is a dependency imported through a computed
 * specifier; published SDK builds import statically.
 *
 * Context: esbuild bundles the extension with `--external:@anthropic-ai/sdk`
 * (see packages/extension/package.json) and AnthropicAdapter loads the SDK
 * lazily via dynamic import() — activation never requires it. The VSIX is
 * built with `vsce package --no-dependencies`, which structurally skips the
 * root node_modules/**, and the `.vscodeignore` `node_modules/**` pattern is
 * root-anchored, so `dist/node_modules/` is the one location that both ships
 * in the VSIX and satisfies Node's require() resolution from
 * `dist/extension.js`.
 *
 * The copy is pruned (type defs, source maps, TS sources, docs, nested
 * node_modules, and the SDK files that need an optional peer) — only the
 * runtime payload the extension can load is kept.
 *
 * Usage: `node scripts/vendor-ai-sdk.mjs [extensionDir]`. Invoked by the
 * extension's `build` script, right after esbuild; the optional argument lets
 * the tests drive the real script over a fixture tree.
 */
import { cpSync, existsSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultExtDir = join(repoRoot, 'packages', 'extension');

/** The package the extension loads; the root of the vendored graph. */
const SDK_PKG = '@anthropic-ai/sdk';

/** Directory names dropped from the vendored copy (dead weight at runtime). */
const PRUNE_DIRS = new Set([
  'src',
  'bin',
  '.bin',
  '.github',
  'node_modules',
  'test',
  'tests',
  'docs',
]);
/** Files dropped from the vendored copy: type defs, source maps, markdown docs (LICENSE kept). */
const PRUNE_FILE = /\.(d\.ts|d\.mts|d\.cts|map)$|\.md$/i;
/** Vendored files that Node can execute, hence can carry a module specifier. */
const SCRIPT_FILE = /\.(js|mjs|cjs)$/;
/**
 * Every module specifier a source file can carry.
 *
 * `from '…'`, `require('…')`, `import('…')` — and `import '…';`, the
 * side-effect form with no binding. That last one was missing, and it made the
 * guard fail OPEN: a dependency reached only that way was never vendored, and
 * the VSIX shipped with the exact MODULE_NOT_FOUND this script exists to
 * prevent. A guard that misses a case is worse than no guard, because the
 * build stays green while the artifact breaks.
 */
const IMPORT_SPECIFIER = /(?:\bfrom|\brequire\s*\(|\bimport\s*\(|\bimport)\s*(['"])([^'"]+)\1/g;
/** What a bundle loads from the SDK — `import("@anthropic-ai/sdk…")` or `require(…)` — not a mere mention. */
const SDK_LOAD = /\b(?:require|import)\s*\(\s*(['"])(@anthropic-ai\/sdk(?:\/[^'"]*)?)\1\s*\)/g;

export function pruneFilter(src) {
  const base = basename(src);
  if (PRUNE_DIRS.has(base)) return false;
  if (PRUNE_FILE.test(base) && !/^LICENSE/i.test(base)) return false;
  return true;
}

/**
 * The package a module specifier points at — `zod/v4` → `zod`, `@a/b/c` → `@a/b`
 * — or null for a relative path or a Node builtin, which need no vendoring.
 */
export function packageOfSpecifier(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || isBuiltin(specifier)) return null;
  const segments = specifier.split('/');
  if (!specifier.startsWith('@')) return segments[0] || null;
  return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : null;
}

/** Every package `source` imports, requires or dynamically imports. */
export function importedPackages(source) {
  const names = new Set();
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const name = packageOfSpecifier(match[2]);
    if (name) names.add(name);
  }
  return names;
}

/**
 * The packages to vendor alongside `pkg`: the ones it declares (dependency or
 * peer dependency alike) AND its shipped runtime files import. Declared without
 * an import means type-only — the copy would be dead weight; imported without a
 * declaration means the package is not `pkg`'s to bring, so vendoring it here
 * would guess at a version nobody asked for.
 */
export function vendorableDeps(pkg, imported) {
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]);
  return [...declared].filter((name) => imported.has(name)).sort();
}

/**
 * The peers `pkg` marks optional: by its own declaration, only the files that
 * import them need them, and a consumer installs one only to use those files.
 */
export function optionalPeerDependencies(pkg) {
  const meta = pkg.peerDependenciesMeta ?? {};
  return Object.keys(pkg.peerDependencies ?? {})
    .filter((name) => meta[name]?.optional === true)
    .sort();
}

/** Every relative specifier `source` imports, requires or re-exports. */
function relativeSpecifiers(source) {
  return [...source.matchAll(IMPORT_SPECIFIER)]
    .map((match) => match[2])
    .filter((specifier) => specifier.startsWith('.'));
}

/** The file of `sources` a relative specifier in `from` lands on, as Node would find it — or null. */
function resolveRelative(sources, from, specifier) {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`];
  candidates.push(`${base}/index.js`, `${base}/index.mjs`);
  return candidates.find((candidate) => sources.has(candidate)) ?? null;
}

/**
 * The runtime files to leave out of a copy: those that import one of the
 * package's optional peers, then — until nothing changes — those whose relative
 * imports reach a file already left out. `sources` maps posix paths to source.
 */
export function filesToDrop(sources, optionalPeers) {
  const peers = new Set(optionalPeers);
  const dropped = new Set();
  for (const [file, source] of sources) {
    if ([...importedPackages(source)].some((name) => peers.has(name))) dropped.add(file);
  }
  let grew = dropped.size > 0;
  while (grew) {
    grew = false;
    for (const [file, source] of sources) {
      if (dropped.has(file)) continue;
      const reachesDropped = relativeSpecifiers(source).some((specifier) =>
        dropped.has(resolveRelative(sources, file, specifier)),
      );
      if (reachesDropped) {
        dropped.add(file);
        grew = true;
      }
    }
  }
  return [...dropped].sort();
}

/** The relative imports reachable from `entry` that land on no file of `sources`, as `file → specifier`. */
export function unresolvedImports(sources, entry) {
  const missing = [];
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of relativeSpecifiers(sources.get(file) ?? '')) {
      const target = resolveRelative(sources, file, specifier);
      if (target) queue.push(target);
      else missing.push(`${file} → ${specifier}`);
    }
  }
  return missing;
}

/** The SDK specifiers a bundle loads, deduplicated and sorted. */
export function sdkSpecifiers(bundle) {
  return [...new Set([...bundle.matchAll(SDK_LOAD)].map((match) => match[2]))].sort();
}

/** The SDK files a specifier can land on: the ESM entry first, as dynamic import() resolves it. */
function sdkEntryCandidates(specifier) {
  const subpath = specifier.slice(SDK_PKG.length).replace(/^\//, '');
  if (!subpath) return ['index.mjs', 'index.js'];
  return [
    `${subpath}.mjs`,
    `${subpath}.js`,
    subpath,
    `${subpath}/index.mjs`,
    `${subpath}/index.js`,
  ];
}

/** Total byte size of all files under dir (recursive). */
async function dirSize(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(p);
    else if (entry.isFile()) total += statSync(p).size;
  }
  return total;
}

/** Every file under dir whose name matches `re` (recursive). */
async function filesMatching(dir, re, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) await filesMatching(p, re, out);
    else if (entry.isFile() && re.test(entry.name)) out.push(p);
  }
  return out;
}

function fail(msg) {
  console.error(`[vendor-ai-sdk] ERROR: ${msg}`);
  process.exit(1);
}

/** Where `dependent` (installed at `fromDir`) resolves `name` — or a build failure. */
function packageDirOf(fromDir, name, dependent) {
  try {
    const req = createRequire(join(fromDir, 'package.json'));
    return realpathSync(dirname(req.resolve(`${name}/package.json`)));
  } catch (err) {
    fail(
      `"${dependent}" imports "${name}", which does not resolve from ${fromDir} ` +
        `(${err.code ?? 'resolution failed'}) — run pnpm install, or add "${name}" to the ` +
        "extension's dependencies so the VSIX can carry it.",
    );
    return ''; // unreachable: fail() exits.
  }
}

/** Copy `src` into the vendored tree, pruning what never runs. */
function vendorPackage(name, src, outDir) {
  const dest = join(outDir, ...name.split('/'));
  cpSync(src, dest, { recursive: true, filter: pruneFilter });
  return dest;
}

async function main(extensionDir) {
  // ── Resolve sources (pnpm symlinks package dirs into .pnpm — dereference). ──
  const outDir = join(extensionDir, 'dist', 'node_modules');
  const sdkLink = join(extensionDir, 'node_modules', ...SDK_PKG.split('/'));
  if (!existsSync(sdkLink)) fail(`${SDK_PKG} not found at ${sdkLink} — run pnpm install first.`);

  // ── Copy the SDK, then whatever it reaches for, transitively ───────────────
  rmSync(outDir, { recursive: true, force: true });

  const vendored = new Map();
  let sdkSources = new Map();
  let sdkDropped = [];
  const queue = [{ name: SDK_PKG, src: realpathSync(sdkLink) }];
  while (queue.length > 0) {
    const { name, src } = queue.shift();
    if (vendored.has(name)) continue;
    const dest = vendorPackage(name, src, outDir);
    vendored.set(name, dest);

    const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
    const sources = new Map();
    for (const file of await filesMatching(dest, SCRIPT_FILE)) {
      sources.set(relative(dest, file).split(sep).join('/'), readFileSync(file, 'utf8'));
    }
    // Only the SDK is pruned this way: it is the package the extension loads
    // by entry point, so what the prune leaves out can be checked below.
    if (name === SDK_PKG) {
      sdkDropped = filesToDrop(sources, optionalPeerDependencies(pkg));
      for (const file of sdkDropped) {
        rmSync(join(dest, ...file.split('/')));
        sources.delete(file);
      }
      sdkSources = sources;
    }

    const imported = new Set();
    for (const source of sources.values())
      for (const spec of importedPackages(source)) imported.add(spec);

    for (const dep of vendorableDeps(pkg, imported)) {
      if (vendored.has(dep) || queue.some((queued) => queued.name === dep)) continue;
      queue.push({ name: dep, src: packageDirOf(src, dep, name) });
    }
  }

  // ── Sanity checks: everything Node will load at runtime is in the copy. ────
  // AnthropicAdapter loads the SDK through dynamic import(), which resolves the
  // "import" condition (index.mjs); require() resolves index.js. Each entry has
  // to survive the prune, and every file it reaches has to have been copied —
  // a gap here is a failed AI call in a shipped VSIX.
  for (const entry of ['index.js', 'index.mjs']) {
    if (sdkDropped.includes(entry))
      fail(
        `the SDK entry point ${entry} imports an optional peer dependency — leaving it out ` +
          'would ship an SDK that cannot load.',
      );
    if (!sdkSources.has(entry)) fail(`vendored SDK is missing ${entry}`);
    const missing = unresolvedImports(sdkSources, entry);
    if (missing.length > 0)
      fail(`vendored SDK ${entry} reaches files the copy lacks: ${missing.join(', ')}`);
  }

  // What the bundle loads from the SDK has to be in the copy too. esbuild writes
  // the bundle immediately before this script runs in the extension's build;
  // run on its own, with no bundle yet, the script has no such import to check.
  const bundlePath = join(extensionDir, 'dist', 'extension.js');
  if (existsSync(bundlePath)) {
    for (const specifier of sdkSpecifiers(readFileSync(bundlePath, 'utf8'))) {
      const candidates = sdkEntryCandidates(specifier);
      const entry = candidates.find((candidate) => sdkSources.has(candidate));
      if (!entry) {
        const leftOut = candidates.some((candidate) => sdkDropped.includes(candidate));
        fail(
          `dist/extension.js loads "${specifier}", which the vendored SDK does not carry` +
            (leftOut
              ? ' — it imports an optional peer dependency, so the copy leaves it out.'
              : '.'),
        );
      }
      const missing = unresolvedImports(sdkSources, entry);
      if (missing.length > 0)
        fail(`"${specifier}" reaches files the vendored SDK lacks: ${missing.join(', ')}`);
    }
  }

  const sizes = [];
  for (const [name, dest] of vendored)
    sizes.push(`${name} (${((await dirSize(dest)) / 1024).toFixed(0)} KB)`);
  const leftOut =
    sdkDropped.length > 0 ? `, less ${sdkDropped.length} files that need an optional peer` : '';
  console.log(`[vendor-ai-sdk] vendored ${sizes.join(' + ')}${leftOut} → ${outDir}`);
}

// Importing this module (from its test) must not vendor anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main(resolve(process.argv[2] ?? defaultExtDir));
