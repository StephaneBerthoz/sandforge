#!/usr/bin/env node
/**
 * Vendor the Anthropic AI SDK — and every package its shipped runtime files
 * actually import, transitively — into `packages/extension/dist/node_modules/`.
 *
 * Nothing here is a hand-kept package list. The set is recomputed on every
 * build from what the copied files import, intersected with what the copied
 * package declares (`dependencies` + `peerDependencies`):
 *   - `zod` ships because `helpers/zod.mjs` imports `zod/v4`, and the SDK
 *     declares zod as an (optional) peer dependency;
 *   - `json-schema-to-ts` does not, because it appears only in the SDK's type
 *     definitions — no shipped `.js`/`.mjs`/`.cjs` imports it;
 *   - `@modelcontextprotocol/sdk`, named in `helpers/beta/mcp` JSDoc, is not
 *     declared by the SDK at all, so it is not ours to vendor.
 * An SDK bump that grows a real runtime dependency therefore vendors it on the
 * next build, and one whose dependency cannot be resolved fails the build —
 * instead of shipping a VSIX where every AI call throws MODULE_NOT_FOUND.
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
 * node_modules, zod's v3 tree) — only the runtime payload is kept.
 *
 * Usage: `node scripts/vendor-ai-sdk.mjs [extensionDir]`. Invoked by the
 * extension's `build` script, right after esbuild; the optional argument lets
 * the tests drive the real script over a fixture tree.
 */
import { cpSync, existsSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import { basename, dirname, join, relative, resolve } from 'node:path';
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
/**
 * The zod entry points pruned below. A future SDK reaching for `zod/v3` — or
 * for the bare `zod` root, which resolves to the same v3 tree — has to break
 * the build here rather than every AI call at runtime.
 */
const DEAD_ZOD_IMPORT =
  /(?:\bfrom|\brequire\s*\(|\bimport\s*\()\s*(['"])(zod(?:\/v3(?:\/[^'"]*)?)?)\1/;

export function pruneFilter(src) {
  const base = basename(src);
  if (PRUNE_DIRS.has(base)) return false;
  if (PRUNE_FILE.test(base) && !/^LICENSE/i.test(base)) return false;
  return true;
}

/**
 * zod's root export `.` maps to `./v3/external.js`, so the whole v3 tree and
 * the root `index.js`/`index.cjs` that re-export it are dead weight here — the
 * SDK only ever imports `zod/v4`. Anchored on the copy root instead of on
 * `basename`, so a `zod` directory vendored inside some other package can
 * never be pruned by accident.
 */
export function zodPruneFilter(zodRoot) {
  return (src) => {
    if (!pruneFilter(src)) return false;
    const segments = relative(zodRoot, src).split(/[\\/]/);
    if (segments[0] === 'v3') return false;
    return !(segments.length === 1 && (segments[0] === 'index.js' || segments[0] === 'index.cjs'));
  };
}

/** The pruned zod specifier `source` imports, or null when it imports none. */
export function findDeadZodImport(source) {
  return DEAD_ZOD_IMPORT.exec(source)?.[2] ?? null;
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
  cpSync(src, dest, {
    recursive: true,
    filter: name === 'zod' ? zodPruneFilter(src) : pruneFilter,
  });
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
  const queue = [{ name: SDK_PKG, src: realpathSync(sdkLink) }];
  while (queue.length > 0) {
    const { name, src } = queue.shift();
    if (vendored.has(name)) continue;
    const dest = vendorPackage(name, src, outDir);
    vendored.set(name, dest);

    const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
    const imported = new Set();
    for (const file of await filesMatching(dest, SCRIPT_FILE))
      for (const spec of importedPackages(readFileSync(file, 'utf8'))) imported.add(spec);

    for (const dep of vendorableDeps(pkg, imported)) {
      if (vendored.has(dep) || queue.some((queued) => queued.name === dep)) continue;
      queue.push({ name: dep, src: packageDirOf(src, dep, name) });
    }
  }

  // ── Sanity checks: the exact files Node will require() at runtime. ──────────
  const sdkDest = join(outDir, ...SDK_PKG.split('/'));
  const zodDest = join(outDir, 'zod');
  if (!existsSync(join(sdkDest, 'index.js'))) fail('vendored SDK is missing index.js');
  if (!existsSync(join(sdkDest, 'helpers', 'zod.js')))
    fail('vendored SDK is missing helpers/zod.js');
  if (!existsSync(join(zodDest, 'v4', 'index.cjs'))) fail('vendored zod is missing v4/index.cjs');

  // ESM entry points — AnthropicAdapter loads the SDK through dynamic import(),
  // which resolves the "import" conditions of each package's exports map:
  //   @anthropic-ai/sdk          → index.mjs
  //   @anthropic-ai/sdk/helpers/zod → helpers/zod.mjs
  //   zod/v4                     → v4/index.js
  // The CJS checks above are not sufficient: a copy missing only the ESM files
  // would pass them yet break every AI call at runtime.
  if (!existsSync(join(sdkDest, 'index.mjs')))
    fail('vendored SDK is missing index.mjs (ESM entry)');
  if (!existsSync(join(sdkDest, 'helpers', 'zod.mjs')))
    fail('vendored SDK is missing helpers/zod.mjs (ESM entry)');
  if (!existsSync(join(zodDest, 'v4', 'index.js')))
    fail('vendored zod is missing v4/index.js (ESM entry for zod/v4)');

  // The prune is only safe while nothing reaches for what it removed, and an
  // unresolvable specifier inside a lazily imported graph surfaces as a failed
  // AI call in a shipped VSIX. Sweep the payload so it surfaces here instead.
  for (const file of await filesMatching(outDir, SCRIPT_FILE)) {
    const dead = findDeadZodImport(readFileSync(file, 'utf8'));
    if (dead)
      fail(
        `${relative(outDir, file)} imports "${dead}", an entry point this script prunes — ` +
          'stop pruning zod/v3, or move the SDK onto zod/v4.',
      );
  }

  const sizes = [];
  for (const [name, dest] of vendored)
    sizes.push(`${name} (${((await dirSize(dest)) / 1024).toFixed(0)} KB)`);
  console.log(`[vendor-ai-sdk] vendored ${sizes.join(' + ')} → ${outDir}`);
}

// Importing this module (from its test) must not vendor anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main(resolve(process.argv[2] ?? defaultExtDir));
