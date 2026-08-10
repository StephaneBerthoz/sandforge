#!/usr/bin/env node
/**
 * Vendor the Anthropic AI SDK (and its only runtime dependency, zod — the
 * SDK requires `zod/v4`) into `packages/extension/dist/node_modules/`.
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
 * node_modules) — only the runtime payload is kept.
 *
 * Invoked by the extension's `build` script, right after esbuild. Fails
 * loudly when a source package is missing: a VSIX without the vendored SDK
 * would break every AI call at runtime.
 */
import { cpSync, existsSync, realpathSync, rmSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extDir = join(repoRoot, 'packages', 'extension');
const outDir = join(extDir, 'dist', 'node_modules');

/** Directory names dropped from the vendored copy (dead weight at runtime). */
const PRUNE_DIRS = new Set(['src', 'bin', '.bin', '.github', 'node_modules', 'test', 'tests', 'docs']);
/** Files dropped from the vendored copy: type defs, source maps, markdown docs (LICENSE kept). */
const PRUNE_FILE = /\.(d\.ts|d\.mts|d\.cts|map)$|\.md$/i;

function pruneFilter(src) {
  const base = basename(src);
  if (PRUNE_DIRS.has(base)) return false;
  if (PRUNE_FILE.test(base) && !/^LICENSE/i.test(base)) return false;
  return true;
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

function fail(msg) {
  console.error(`[vendor-ai-sdk] ERROR: ${msg}`);
  process.exit(1);
}

// ── Resolve sources (pnpm symlinks package dirs into .pnpm — dereference). ──
const sdkLink = join(extDir, 'node_modules', '@anthropic-ai', 'sdk');
if (!existsSync(sdkLink)) fail(`@anthropic-ai/sdk not found at ${sdkLink} — run pnpm install first.`);
const sdkSrc = realpathSync(sdkLink);

// Resolve zod as the SDK sees it (peer dependency instance), not whatever
// version happens to be hoisted for the extension itself.
const sdkRequire = createRequire(join(sdkSrc, 'package.json'));
const zodSrc = realpathSync(dirname(sdkRequire.resolve('zod/package.json')));

// ── Copy ─────────────────────────────────────────────────────────────────────
rmSync(outDir, { recursive: true, force: true });

const sdkDest = join(outDir, '@anthropic-ai', 'sdk');
const zodDest = join(outDir, 'zod');
cpSync(sdkSrc, sdkDest, { recursive: true, filter: pruneFilter });
cpSync(zodSrc, zodDest, { recursive: true, filter: pruneFilter });

// ── Sanity checks: the exact files Node will require() at runtime. ──────────
if (!existsSync(join(sdkDest, 'index.js'))) fail('vendored SDK is missing index.js');
if (!existsSync(join(sdkDest, 'helpers', 'zod.js'))) fail('vendored SDK is missing helpers/zod.js');
if (!existsSync(join(zodDest, 'v4', 'index.cjs'))) fail('vendored zod is missing v4/index.cjs');

// ESM entry points — AnthropicAdapter loads the SDK through dynamic import(),
// which resolves the "import" conditions of each package's exports map:
//   @anthropic-ai/sdk          → index.mjs
//   @anthropic-ai/sdk/helpers/zod → helpers/zod.mjs
//   zod/v4                     → v4/index.js
// The CJS checks above are not sufficient: a copy missing only the ESM files
// would pass them yet break every AI call at runtime.
if (!existsSync(join(sdkDest, 'index.mjs'))) fail('vendored SDK is missing index.mjs (ESM entry)');
if (!existsSync(join(sdkDest, 'helpers', 'zod.mjs')))
  fail('vendored SDK is missing helpers/zod.mjs (ESM entry)');
if (!existsSync(join(zodDest, 'v4', 'index.js')))
  fail('vendored zod is missing v4/index.js (ESM entry for zod/v4)');

const sdkSize = await dirSize(sdkDest);
const zodSize = await dirSize(zodDest);
console.log(
  `[vendor-ai-sdk] vendored @anthropic-ai/sdk (${(sdkSize / 1024).toFixed(0)} KB) ` +
    `+ zod (${(zodSize / 1024).toFixed(0)} KB) → ${outDir}`,
);
