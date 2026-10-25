/**
 * Gate: the MCP server never ships in the VSIX.
 *
 * `packages/extension/cli/sandforge-mcp.ts` gives an AI agent tools that
 * write to an org, run from a checkout of this repository. The extension
 * itself gives the model no tool, and `docs/product-claims.test.mjs` holds
 * that against everything the VSIX runs: but it reads `src/`, the shared
 * package and the webview, which is what esbuild bundles, and not what
 * `.vscodeignore` lets into the package beside the bundle. A `cli/` line
 * dropped from `.vscodeignore` would put the server, and every script it
 * runs, in every user's install, read by no gate.
 *
 * So this asks vsce itself which files `pnpm package` would put in the VSIX —
 * `vsce ls --no-dependencies`, the listing of the same `vsce package
 * --no-dependencies` the package script runs, which reads `.vscodeignore` as
 * packaging does and runs no build — and refuses any file of `cli/` in it.
 * The listing is proved able to see the server: with an ignore file that
 * lacks the one line, it lists it.
 *
 *   node --test scripts/mcp-server-not-shipped.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionDir = join(root, 'packages', 'extension');
const SERVER = 'cli/sandforge-mcp.ts';

/** The vsce the extension packages with, wherever the install put it. */
function vsce() {
  const manifest = createRequire(join(extensionDir, 'package.json')).resolve(
    '@vscode/vsce/package.json',
  );
  return join(dirname(manifest), 'vsce');
}

/** The files vsce would package, one path a line, relative to the extension. */
function packaged(ignoreFile) {
  const out = execFileSync(
    process.execPath,
    [vsce(), 'ls', '--no-dependencies', ...(ignoreFile ? ['--ignoreFile', ignoreFile] : [])],
    { cwd: extensionDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => line.replace(/\\/g, '/'));
}

test('the package script packages with --no-dependencies, the listing this gate reads', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.package, /vsce package --no-dependencies/);
});

test('.vscodeignore leaves cli/ out of the VSIX, and vsce lists no file of it', () => {
  const lines = readFileSync(join(extensionDir, '.vscodeignore'), 'utf8')
    .split('\n')
    .map((line) => line.trim());
  assert.ok(lines.includes('cli/'), '.vscodeignore no longer names cli/');

  const files = packaged();
  assert.ok(files.includes('package.json'), `vsce listed no package.json: ${files.join(', ')}`);
  assert.deepEqual(
    files.filter((file) => file.startsWith('cli/')),
    [],
    'the VSIX would hold the command-line scripts, the MCP server among them',
  );
});

test('the listing sees the server once .vscodeignore stops leaving cli/ out', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-vscodeignore-'));
  try {
    const ignoreFile = join(dir, '.vscodeignore');
    const withoutCli = readFileSync(join(extensionDir, '.vscodeignore'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== 'cli/')
      .join('\n');
    writeFileSync(ignoreFile, withoutCli, 'utf8');
    assert.ok(
      packaged(ignoreFile).includes(SERVER),
      `without the cli/ line, vsce does not list ${SERVER}: this gate would see nothing`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
