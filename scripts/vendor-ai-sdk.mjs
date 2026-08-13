#!/usr/bin/env node
/**
 * Vendor the Anthropic AI SDK — plus zod, its *optional peer* dependency,
 * because the SDK's `helpers/zod` entry points import `zod/v4` — into
 * `packages/extension/dist/node_modules/`. The SDK's only declared runtime
 * dependency is `json-schema-to-ts`, which nothing in its shipped runtime
 * files imports (see TYPE_ONLY_DEPS).
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
 * Invoked by the extension's `build` script, right after esbuild. Fails
 * loudly when a source package is missing: a VSIX without the vendored SDK
 * would break every AI call at runtime.
 */
import { cpSync, existsSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extDir = join(repoRoot, 'packages', 'extension');
const outDir = join(extDir, 'dist', 'node_modules');

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
/**
 * Declared SDK dependencies that exist for their types only — no shipped
 * runtime file imports them, so they are deliberately left out of the copy.
 * Spelled out so the check below stays a check instead of a rubber stamp.
 */
export const TYPE_ONLY_DEPS = new Set(['json-schema-to-ts']);
/** Vendored files that Node can execute, hence can carry a module specifier. */
const SCRIPT_FILE = /\.(js|mjs|cjs)$/;
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
 * Declared runtime dependencies of the SDK that never made it into the copy.
 * `isVendored` is injected so the rule can be exercised without a real tree.
 */
export function unvendoredRuntimeDeps(sdkPkg, isVendored) {
  return Object.keys(sdkPkg.dependencies ?? {}).filter(
    (dep) => !TYPE_ONLY_DEPS.has(dep) && !isVendored(dep),
  );
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

async function main() {
  // ── Resolve sources (pnpm symlinks package dirs into .pnpm — dereference). ──
  const sdkLink = join(extDir, 'node_modules', '@anthropic-ai', 'sdk');
  if (!existsSync(sdkLink))
    fail(`@anthropic-ai/sdk not found at ${sdkLink} — run pnpm install first.`);
  const sdkSrc = realpathSync(sdkLink);

  // Resolve zod as the SDK sees it (peer dependency instance), not whatever
  // version happens to be hoisted for the extension itself.
  const sdkRequire = createRequire(join(sdkSrc, 'package.json'));
  const zodSrc = realpathSync(dirname(sdkRequire.resolve('zod/package.json')));

  // ── Copy ───────────────────────────────────────────────────────────────────
  rmSync(outDir, { recursive: true, force: true });

  const sdkDest = join(outDir, '@anthropic-ai', 'sdk');
  const zodDest = join(outDir, 'zod');
  cpSync(sdkSrc, sdkDest, { recursive: true, filter: pruneFilter });
  cpSync(zodSrc, zodDest, { recursive: true, filter: zodPruneFilter(zodSrc) });

  // The copy list above is hand-written; nothing keeps it in step with the SDK
  // but this check, which turns a new dependency into a build failure.
  const sdkPkg = JSON.parse(readFileSync(join(sdkSrc, 'package.json'), 'utf8'));
  for (const dep of unvendoredRuntimeDeps(sdkPkg, (name) => existsSync(join(outDir, name))))
    fail(
      `SDK dependency "${dep}" is declared but not vendored — copy it above, or ` +
        'add it to TYPE_ONLY_DEPS if no shipped runtime file imports it.',
    );

  // ── Sanity checks: the exact files Node will require() at runtime. ──────────
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

  const sdkSize = await dirSize(sdkDest);
  const zodSize = await dirSize(zodDest);
  console.log(
    `[vendor-ai-sdk] vendored @anthropic-ai/sdk (${(sdkSize / 1024).toFixed(0)} KB) ` +
      `+ zod (${(zodSize / 1024).toFixed(0)} KB) → ${outDir}`,
  );
}

// Importing this module (from its test) must not vendor anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
