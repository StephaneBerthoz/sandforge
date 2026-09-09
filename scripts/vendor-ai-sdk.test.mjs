/**
 * Tests for vendor-ai-sdk.mjs: the pure vendoring rules, plus end-to-end runs
 * of the real script over fixture `node_modules` trees and over the repo's own.
 *
 * The fixture runs are the point. The prune decisions keep zod's dead v3 tree
 * out of the VSIX, and the dependency discovery keeps the VSIX complete: an SDK
 * bump that grows a runtime dependency must vendor it, and one whose dependency
 * cannot be resolved must break the build. Both mistakes otherwise surface only
 * as `MODULE_NOT_FOUND` on the first AI call of a shipped release, with every
 * other gate green — so they are exercised here against a real copy on disk,
 * not against a stubbed one.
 *
 * Run: node --test scripts/vendor-ai-sdk.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  findDeadZodImport,
  importedPackages,
  packageOfSpecifier,
  pruneFilter,
  vendorableDeps,
  zodPruneFilter,
} from './vendor-ai-sdk.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const vendorScript = join(scriptsDir, 'vendor-ai-sdk.mjs');
const outDir = join(repoRoot, 'packages', 'extension', 'dist', 'node_modules');

const zodRoot = resolve('/pnpm/zod@3.25.76/node_modules/zod');
const keeps = zodPruneFilter(zodRoot);

test('importedPackages sees a side-effect import, which has no binding', () => {
  // The form the guard used to miss entirely. A dependency reached only this
  // way was never vendored, and the VSIX shipped with the MODULE_NOT_FOUND
  // this script exists to prevent — while the build stayed green.
  assert.deepEqual([...importedPackages("import 'side-effect-pkg';")], ['side-effect-pkg']);
  assert.deepEqual([...importedPackages('import "@scope/pkg";')], ['@scope/pkg']);
});

test('importedPackages still sees every bound form', () => {
  assert.deepEqual([...importedPackages("import x from 'a';")], ['a']);
  assert.deepEqual([...importedPackages("require('b')")], ['b']);
  assert.deepEqual([...importedPackages("await import('c')")], ['c']);
  assert.deepEqual([...importedPackages("import * as d from 'd';")], ['d']);
});

test('zodPruneFilter drops the v3 tree', () => {
  assert.equal(keeps(join(zodRoot, 'v3')), false);
  assert.equal(keeps(join(zodRoot, 'v3', 'external.js')), false);
  assert.equal(keeps(join(zodRoot, 'v3', 'helpers', 'util.cjs')), false);
  // cpSync hands over native paths; be indifferent to the separator anyway.
  assert.equal(keeps(`${zodRoot}/v3/external.js`), false);
});

test('zodPruneFilter drops the root entry points that only re-export v3', () => {
  assert.equal(keeps(join(zodRoot, 'index.js')), false);
  assert.equal(keeps(join(zodRoot, 'index.cjs')), false);
});

test('zodPruneFilter keeps the v4 payload and the copy root', () => {
  assert.equal(keeps(zodRoot), true);
  assert.equal(keeps(join(zodRoot, 'package.json')), true);
  assert.equal(keeps(join(zodRoot, 'LICENSE')), true);
  assert.equal(keeps(join(zodRoot, 'v4', 'index.js')), true);
  assert.equal(keeps(join(zodRoot, 'v4', 'index.cjs')), true);
  assert.equal(keeps(join(zodRoot, 'v4-mini', 'index.js')), true);
  // v4 has its own nested index.js files — only the root ones are dangling.
  assert.equal(keeps(join(zodRoot, 'v4', 'classic', 'index.js')), true);
});

test('the zod rules never reach the SDK copy, which needs its own index.js', () => {
  const sdkRoot = resolve('/pnpm/@anthropic-ai+sdk@0.93.0/node_modules/@anthropic-ai/sdk');
  assert.equal(pruneFilter(join(sdkRoot, 'index.js')), true);
  assert.equal(pruneFilter(join(sdkRoot, 'index.mjs')), true);
  assert.equal(pruneFilter(join(sdkRoot, 'helpers', 'zod.js')), true);
  assert.equal(pruneFilter(join(sdkRoot, 'index.d.ts')), false);
});

test('findDeadZodImport flags every specifier the prune makes unresolvable', () => {
  assert.equal(findDeadZodImport('const z = require("zod/v3");'), 'zod/v3');
  assert.equal(findDeadZodImport("import * as z from 'zod/v3/external.js';"), 'zod/v3/external.js');
  assert.equal(findDeadZodImport("const {z} = await import('zod');"), 'zod');
  assert.equal(findDeadZodImport('import z from"zod";'), 'zod');
});

test('findDeadZodImport leaves the vendored v4 entry points alone', () => {
  assert.equal(findDeadZodImport("import { z } from 'zod/v4';"), null);
  assert.equal(findDeadZodImport('const z = require("zod/v4/index.cjs");'), null);
  assert.equal(findDeadZodImport("import z from './internal/zod.js';"), null);
  assert.equal(findDeadZodImport('const versions = { v3: 3, v4: 4 };'), null);
});

test('packageOfSpecifier names the package a specifier needs, or nothing to vendor', () => {
  assert.equal(packageOfSpecifier('zod/v4'), 'zod');
  assert.equal(packageOfSpecifier('json-schema-to-ts'), 'json-schema-to-ts');
  assert.equal(
    packageOfSpecifier('@modelcontextprotocol/sdk/client/index.js'),
    '@modelcontextprotocol/sdk',
  );
  assert.equal(packageOfSpecifier('./internal/zod.js'), null);
  assert.equal(packageOfSpecifier('../shim.mjs'), null);
  assert.equal(packageOfSpecifier('/abs/path.js'), null);
  // Builtins ship with Node, with or without the prefix the SDK happens to use.
  assert.equal(packageOfSpecifier('node:crypto'), null);
  assert.equal(packageOfSpecifier('crypto'), null);
  assert.equal(packageOfSpecifier('fs/promises'), null);
  // A scope on its own resolves to no package.
  assert.equal(packageOfSpecifier('@scope'), null);
});

test('importedPackages reads every import form the SDK ships', () => {
  const source = [
    "import { z } from 'zod/v4';",
    'const { Client } = require("@modelcontextprotocol/sdk/client/index.js");',
    "const lazy = await import('json-schema-to-ts');",
    "import './internal/shim.js';",
    "import crypto from 'node:crypto';",
  ].join('\n');
  assert.deepEqual([...importedPackages(source)].sort(), [
    '@modelcontextprotocol/sdk',
    'json-schema-to-ts',
    'zod',
  ]);
  assert.deepEqual([...importedPackages('module.exports = 1;')], []);
});

test('vendorableDeps ships what is both declared and imported — nothing else', () => {
  const pkg = {
    dependencies: { 'json-schema-to-ts': '^3.1.1', 'new-runtime-dep': '^1.0.0' },
    peerDependencies: { zod: '^4.0.0' },
  };
  // zod: declared as an optional peer, imported by helpers/zod — vendored.
  // new-runtime-dep: declared and imported — vendored, no allowlist edit needed.
  // json-schema-to-ts: declared but imported by no shipped runtime file — left out.
  // @modelcontextprotocol/sdk: imported (in JSDoc) but undeclared — not ours to bring.
  assert.deepEqual(
    vendorableDeps(pkg, new Set(['zod', 'new-runtime-dep', '@modelcontextprotocol/sdk'])),
    ['new-runtime-dep', 'zod'],
  );
  assert.deepEqual(vendorableDeps(pkg, new Set()), []);
  assert.deepEqual(vendorableDeps({}, new Set(['zod'])), []);
});

// ── End-to-end over a fixture tree ───────────────────────────────────────────
// A fixture SDK carrying what the real one carries: CJS and ESM entry points,
// the zod helper, a declared-and-imported runtime dependency with a dependency
// of its own, and a declared dependency that only the type definitions import.

const fixtureRoots = [];
after(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
});

function writePkg(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
}

/** A fixture extension dir whose node_modules mirrors the shape pnpm installs. */
function makeFixture({ sdkDeps = {}, extraPackages = {}, sdkImports = [] } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sandforge-vendor-')));
  fixtureRoots.push(root);
  const modules = join(root, 'node_modules');
  const imports = sdkImports.map((name) => `require('${name}');`).join('\n');
  const esmImports = sdkImports.map((name, i) => `import _${i} from '${name}';`).join('\n');

  writePkg(join(modules, '@anthropic-ai', 'sdk'), {
    'package.json': JSON.stringify({
      name: '@anthropic-ai/sdk',
      version: '9.9.9',
      main: './index.js',
      dependencies: sdkDeps,
      peerDependencies: { zod: '^4.0.0' },
      peerDependenciesMeta: { zod: { optional: true } },
    }),
    'index.js': `require('zod/v4');\n${imports}\nmodule.exports = {};\n`,
    'index.mjs': `import 'zod/v4';\n${esmImports}\nexport default {};\n`,
    // Type definitions are pruned, so what they import must not drive vendoring.
    'index.d.ts': "import type { FromSchema } from 'fixture-type-only';\nexport { FromSchema };\n",
    'helpers/zod.js': "module.exports = require('zod/v4');\n",
    'helpers/zod.mjs': "export * from 'zod/v4';\n",
  });

  writePkg(join(modules, 'zod'), {
    'package.json': JSON.stringify({ name: 'zod', version: '4.0.0', main: './index.js' }),
    'index.js': "module.exports = require('./v3/external.js');\n",
    'index.cjs': "module.exports = require('./v3/external.js');\n",
    'v3/external.js': 'module.exports = { v3: true };\n',
    'v4/index.js': 'export const z = { v4: true };\n',
    'v4/index.cjs': 'module.exports = { z: { v4: true } };\n',
  });

  for (const [name, files] of Object.entries(extraPackages)) writePkg(join(modules, name), files);
  return root;
}

function runVendor(extensionDir) {
  return spawnSync(process.execPath, [vendorScript, extensionDir], { encoding: 'utf8' });
}

test('an SDK dependency its runtime files import is vendored, with its own dependencies', () => {
  const fixture = makeFixture({
    sdkDeps: { 'fixture-tokenizer': '^1.0.0', 'fixture-type-only': '^1.0.0' },
    sdkImports: ['fixture-tokenizer'],
    extraPackages: {
      'fixture-tokenizer': {
        'package.json': JSON.stringify({
          name: 'fixture-tokenizer',
          version: '1.0.0',
          main: './index.js',
          dependencies: { 'fixture-tokenizer-core': '^1.0.0' },
        }),
        'index.js': "module.exports = require('fixture-tokenizer-core');\n",
      },
      'fixture-tokenizer-core': {
        'package.json': JSON.stringify({
          name: 'fixture-tokenizer-core',
          version: '1.0.0',
          main: './index.js',
        }),
        'index.js': 'module.exports = () => 42;\n',
      },
      'fixture-type-only': {
        'package.json': JSON.stringify({
          name: 'fixture-type-only',
          version: '1.0.0',
          types: './index.d.ts',
        }),
        'index.d.ts': 'export type FromSchema = unknown;\n',
      },
    },
  });

  const run = runVendor(fixture);
  assert.equal(run.status, 0, `vendoring failed:\n${run.stderr}${run.stdout}`);

  const vendored = join(fixture, 'dist', 'node_modules');
  assert.ok(
    existsSync(join(vendored, 'fixture-tokenizer', 'index.js')),
    'a declared, imported SDK dependency must ship in the VSIX',
  );
  assert.ok(
    existsSync(join(vendored, 'fixture-tokenizer-core', 'index.js')),
    'the dependency of that dependency must ship too',
  );
  assert.ok(existsSync(join(vendored, 'zod', 'v4', 'index.js')));
  assert.equal(
    existsSync(join(vendored, 'fixture-type-only')),
    false,
    'a dependency only the type definitions import is dead weight in the VSIX',
  );
});

test('a dependency the SDK imports but cannot resolve breaks the build', () => {
  const fixture = makeFixture({
    sdkDeps: { 'fixture-ghost': '^1.0.0' },
    sdkImports: ['fixture-ghost'], // …and the package is never installed.
  });

  const run = runVendor(fixture);
  assert.equal(run.status, 1, 'an unvendorable dependency must fail the build');
  assert.match(run.stderr, /\[vendor-ai-sdk\] ERROR/);
  assert.match(run.stderr, /fixture-ghost/);
  assert.equal(
    existsSync(join(fixture, 'dist', 'node_modules', 'fixture-ghost')),
    false,
    'the missing package cannot have been vendored',
  );
});

test('a missing SDK fails loudly instead of writing an empty vendored tree', () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'sandforge-vendor-')));
  fixtureRoots.push(fixture);
  const run = runVendor(fixture);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /@anthropic-ai\/sdk not found/);
});

// ── End-to-end over the repo's own node_modules ──────────────────────────────

test(
  'the vendored tree carries zod v4 and nothing that resolves to v3',
  { timeout: 120_000 },
  () => {
    execFileSync(process.execPath, [vendorScript], { cwd: repoRoot, stdio: 'pipe' });

    const zodDest = join(outDir, 'zod');
    const sdkDest = join(outDir, '@anthropic-ai', 'sdk');
    assert.equal(existsSync(join(zodDest, 'v3')), false, 'zod/v3 must not ship');
    assert.equal(existsSync(join(zodDest, 'index.js')), false, 'dangling zod root ESM entry ships');
    assert.equal(
      existsSync(join(zodDest, 'index.cjs')),
      false,
      'dangling zod root CJS entry ships',
    );
    assert.ok(existsSync(join(zodDest, 'v4', 'index.js')));
    assert.ok(existsSync(join(zodDest, 'v4', 'index.cjs')));
    assert.ok(existsSync(join(sdkDest, 'index.js')));
    assert.ok(existsSync(join(sdkDest, 'helpers', 'zod.mjs')));
    // json-schema-to-ts is a declared dependency of the SDK that no shipped
    // runtime file imports — it must stay out of the VSIX on that evidence.
    assert.equal(existsSync(join(outDir, 'json-schema-to-ts')), false);

    const helper = readFileSync(join(sdkDest, 'helpers', 'zod.mjs'), 'utf8');
    assert.equal(findDeadZodImport(helper), null, 'SDK helper still imports a pruned zod entry');
  },
);
