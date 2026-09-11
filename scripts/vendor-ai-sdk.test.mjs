/**
 * Tests for vendor-ai-sdk.mjs: the pure vendoring rules, plus end-to-end runs
 * of the real script over fixture `node_modules` trees and over the repo's own.
 *
 * The fixture runs are the point. The prune keeps out of the VSIX what the
 * extension never loads — the SDK's zod helpers, and zod with them — and the
 * dependency discovery keeps the VSIX complete: an SDK bump that grows a
 * runtime dependency must vendor it, and one whose dependency cannot be
 * resolved must break the build. A prune that removes something the bundle or
 * the SDK entry points load must break the build too. Each mistake otherwise
 * surfaces only as `MODULE_NOT_FOUND` on the first AI call of a shipped
 * release, with every other gate green — so they are exercised here against a
 * real copy on disk, not against a stubbed one.
 *
 * Run: node --test scripts/vendor-ai-sdk.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as vendor from './vendor-ai-sdk.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const vendorScript = join(scriptsDir, 'vendor-ai-sdk.mjs');

test('importedPackages sees a side-effect import, which has no binding', () => {
  // The form the guard used to miss entirely. A dependency reached only this
  // way was never vendored, and the VSIX shipped with the MODULE_NOT_FOUND
  // this script exists to prevent — while the build stayed green.
  assert.deepEqual([...vendor.importedPackages("import 'side-effect-pkg';")], ['side-effect-pkg']);
  assert.deepEqual([...vendor.importedPackages('import "@scope/pkg";')], ['@scope/pkg']);
});

test('importedPackages still sees every bound form', () => {
  assert.deepEqual([...vendor.importedPackages("import x from 'a';")], ['a']);
  assert.deepEqual([...vendor.importedPackages("require('b')")], ['b']);
  assert.deepEqual([...vendor.importedPackages("await import('c')")], ['c']);
  assert.deepEqual([...vendor.importedPackages("import * as d from 'd';")], ['d']);
});

test('pruneFilter keeps the runtime entry points and drops what never runs', () => {
  const sdkRoot = resolve('/pnpm/@anthropic-ai+sdk@0.93.0/node_modules/@anthropic-ai/sdk');
  assert.equal(vendor.pruneFilter(join(sdkRoot, 'index.js')), true);
  assert.equal(vendor.pruneFilter(join(sdkRoot, 'index.mjs')), true);
  assert.equal(vendor.pruneFilter(join(sdkRoot, 'LICENSE')), true);
  assert.equal(vendor.pruneFilter(join(sdkRoot, 'index.d.ts')), false);
  assert.equal(vendor.pruneFilter(join(sdkRoot, 'index.mjs.map')), false);
  assert.equal(vendor.pruneFilter(join(sdkRoot, 'README.md')), false);
});

test('optionalPeerDependencies names only the peers a package marks optional', () => {
  assert.deepEqual(
    vendor.optionalPeerDependencies({
      peerDependencies: { zod: '^3.25.0 || ^4.0.0', react: '^18.0.0' },
      peerDependenciesMeta: { zod: { optional: true }, react: { optional: false } },
    }),
    ['zod'],
  );
  assert.deepEqual(vendor.optionalPeerDependencies({ peerDependencies: { zod: '^4.0.0' } }), []);
  assert.deepEqual(vendor.optionalPeerDependencies({}), []);
});

test('filesToDrop takes what imports an optional peer, and whatever reaches it relatively', () => {
  // The real SDK's shape: two zod helpers, and helpers/index re-exporting one.
  const sources = new Map([
    ['index.mjs', "import { Client } from './client.mjs';\nexport default Client;\n"],
    ['client.mjs', "import { readFile } from 'node:fs';\nexport class Client {}\n"],
    ['core/error.mjs', 'export class AnthropicError extends Error {}\n'],
    ['helpers/zod.mjs', "import * as z from 'zod/v4';\nimport { E } from '../core/error.mjs';\n"],
    ['helpers/json-schema.mjs', 'export const jsonSchemaOutputFormat = () => ({});\n'],
    [
      'helpers/index.mjs',
      'export { jsonSchemaOutputFormat } from "./json-schema.mjs";\nexport { zodOutputFormat } from "./zod.mjs";\n',
    ],
    ['helpers/beta/zod.js', "const z = require('zod/v4');\n"],
    ['lib/beta-runner.js', "const helper = require('../helpers/beta/zod');\n"],
  ]);
  assert.deepEqual(vendor.filesToDrop(sources, ['zod']), [
    'helpers/beta/zod.js',
    'helpers/index.mjs',
    'helpers/zod.mjs',
    'lib/beta-runner.js',
  ]);
  assert.deepEqual(vendor.filesToDrop(sources, []), []);
});

test('unresolvedImports names every relative import an entry point reaches and the copy lacks', () => {
  const sources = new Map([
    ['index.mjs', "import './core/a.mjs';\nexport * from './core/b';\n"],
    ['core/a.mjs', "import '../internal/c.mjs';\n"],
    ['core/b.mjs', 'export {};\n'],
  ]);
  assert.deepEqual(vendor.unresolvedImports(sources, 'index.mjs'), [
    'core/a.mjs → ../internal/c.mjs',
  ]);
  sources.set('internal/c.mjs', 'export {};\n');
  assert.deepEqual(vendor.unresolvedImports(sources, 'index.mjs'), []);
});

test('sdkSpecifiers reads what a bundle loads from the SDK, not what it merely names', () => {
  const bundle = [
    'const a=import("@anthropic-ai/sdk");',
    "const b=require('@anthropic-ai/sdk/helpers/zod');",
    'const note="@anthropic-ai/sdk/helpers/beta/zod";',
    'const c=import("@anthropic-ai/sdk-extra");',
  ].join('\n');
  assert.deepEqual(vendor.sdkSpecifiers(bundle), [
    '@anthropic-ai/sdk',
    '@anthropic-ai/sdk/helpers/zod',
  ]);
});

test('packageOfSpecifier names the package a specifier needs, or nothing to vendor', () => {
  assert.equal(vendor.packageOfSpecifier('zod/v4'), 'zod');
  assert.equal(vendor.packageOfSpecifier('json-schema-to-ts'), 'json-schema-to-ts');
  assert.equal(
    vendor.packageOfSpecifier('@modelcontextprotocol/sdk/client/index.js'),
    '@modelcontextprotocol/sdk',
  );
  assert.equal(vendor.packageOfSpecifier('./internal/zod.js'), null);
  assert.equal(vendor.packageOfSpecifier('../shim.mjs'), null);
  assert.equal(vendor.packageOfSpecifier('/abs/path.js'), null);
  // Builtins ship with Node, with or without the prefix the SDK happens to use.
  assert.equal(vendor.packageOfSpecifier('node:crypto'), null);
  assert.equal(vendor.packageOfSpecifier('crypto'), null);
  assert.equal(vendor.packageOfSpecifier('fs/promises'), null);
  // A scope on its own resolves to no package.
  assert.equal(vendor.packageOfSpecifier('@scope'), null);
});

test('importedPackages reads every import form the SDK ships', () => {
  const source = [
    "import { z } from 'zod/v4';",
    'const { Client } = require("@modelcontextprotocol/sdk/client/index.js");',
    "const lazy = await import('json-schema-to-ts');",
    "import './internal/shim.js';",
    "import crypto from 'node:crypto';",
  ].join('\n');
  assert.deepEqual([...vendor.importedPackages(source)].sort(), [
    '@modelcontextprotocol/sdk',
    'json-schema-to-ts',
    'zod',
  ]);
  assert.deepEqual([...vendor.importedPackages('module.exports = 1;')], []);
});

test('vendorableDeps ships what is both declared and imported — nothing else', () => {
  const pkg = {
    dependencies: { 'json-schema-to-ts': '^3.1.1', 'new-runtime-dep': '^1.0.0' },
    peerDependencies: { 'peer-runtime-dep': '^4.0.0' },
  };
  // peer-runtime-dep: declared as a peer and imported — vendored.
  // new-runtime-dep: declared and imported — vendored, no allowlist edit needed.
  // json-schema-to-ts: declared but imported by no shipped runtime file — left out.
  // @modelcontextprotocol/sdk: imported (in JSDoc) but undeclared — not ours to bring.
  assert.deepEqual(
    vendor.vendorableDeps(
      pkg,
      new Set(['peer-runtime-dep', 'new-runtime-dep', '@modelcontextprotocol/sdk']),
    ),
    ['new-runtime-dep', 'peer-runtime-dep'],
  );
  assert.deepEqual(vendor.vendorableDeps(pkg, new Set()), []);
  assert.deepEqual(vendor.vendorableDeps({}, new Set(['zod'])), []);
});

// ── End-to-end over a fixture tree ───────────────────────────────────────────
// A fixture SDK carrying what the real one carries: CJS and ESM entry points,
// zod helpers behind an optional peer (one of them re-exported by
// helpers/index), a declared-and-imported runtime dependency with a dependency
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
function makeFixture({
  sdkDeps = {},
  extraPackages = {},
  sdkImports = [],
  entryImportsZod = false,
  bundle,
} = {}) {
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
      peerDependencies: { zod: '^3.25.0 || ^4.0.0' },
      peerDependenciesMeta: { zod: { optional: true } },
    }),
    'index.js': `require('./client.js');\n${imports}\nmodule.exports = {};\n`,
    'index.mjs': `import './client.mjs';\n${entryImportsZod ? "import 'zod/v4';\n" : ''}${esmImports}\nexport default {};\n`,
    'client.js': 'module.exports = {};\n',
    'client.mjs': 'export {};\n',
    // Type definitions are pruned, so what they import must not drive vendoring.
    'index.d.ts': "import type { FromSchema } from 'fixture-type-only';\nexport { FromSchema };\n",
    'helpers/zod.js': "module.exports = require('zod/v4');\n",
    'helpers/zod.mjs': "export * from 'zod/v4';\n",
    'helpers/json-schema.js': 'module.exports = {};\n',
    'helpers/json-schema.mjs': 'export {};\n',
    'helpers/index.js':
      "module.exports = { ...require('./zod.js'), ...require('./json-schema.js') };\n",
    'helpers/index.mjs': "export * from './zod.mjs';\nexport * from './json-schema.mjs';\n",
  });

  // Installed, as pnpm resolves the peer in development: if the prune let a
  // zod import through, discovery would vendor this copy and the test would see it.
  writePkg(join(modules, 'zod'), {
    'package.json': JSON.stringify({ name: 'zod', version: '4.0.0', main: './index.js' }),
    'index.js': "module.exports = require('./v4/index.cjs');\n",
    'v4/index.js': 'export const z = { v4: true };\n',
    'v4/index.cjs': 'module.exports = { z: { v4: true } };\n',
  });

  for (const [name, files] of Object.entries(extraPackages)) writePkg(join(modules, name), files);
  if (bundle !== undefined) writePkg(join(root, 'dist'), { 'extension.js': bundle });
  return root;
}

function runVendor(extensionDir) {
  return spawnSync(process.execPath, [vendorScript, extensionDir], { encoding: 'utf8' });
}

test('an SDK dependency its runtime files import is vendored, with its own dependencies', () => {
  const fixture = makeFixture({
    sdkDeps: { 'fixture-tokenizer': '^1.0.0', 'fixture-type-only': '^1.0.0' },
    sdkImports: ['fixture-tokenizer'],
    bundle: 'const sdk=import("@anthropic-ai/sdk");\n',
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
  assert.equal(
    existsSync(join(vendored, 'fixture-type-only')),
    false,
    'a dependency only the type definitions import is dead weight in the VSIX',
  );
});

test('an optional peer only the SDK helpers import stays out of the VSIX, with those helpers', () => {
  const fixture = makeFixture({ bundle: 'const sdk=import("@anthropic-ai/sdk");\n' });
  const run = runVendor(fixture);
  assert.equal(run.status, 0, `vendoring failed:\n${run.stderr}${run.stdout}`);

  const vendored = join(fixture, 'dist', 'node_modules');
  const sdk = join(vendored, '@anthropic-ai', 'sdk');
  assert.equal(
    existsSync(join(vendored, 'zod')),
    false,
    'zod ships, although nothing the extension loads imports it',
  );
  for (const dropped of [
    'helpers/zod.js',
    'helpers/zod.mjs',
    'helpers/index.js',
    'helpers/index.mjs',
  ]) {
    assert.equal(
      existsSync(join(sdk, dropped)),
      false,
      `${dropped} ships, and it cannot load without zod`,
    );
  }
  for (const kept of [
    'index.js',
    'index.mjs',
    'client.js',
    'client.mjs',
    'helpers/json-schema.mjs',
  ]) {
    assert.ok(existsSync(join(sdk, kept)), `${kept} was dropped, but it imports no optional peer`);
  }
});

test('a bundle that loads an SDK file the prune drops breaks the build', () => {
  const fixture = makeFixture({ bundle: 'const zod=import("@anthropic-ai/sdk/helpers/zod");\n' });
  const run = runVendor(fixture);
  assert.equal(run.status, 1, 'the VSIX would throw MODULE_NOT_FOUND on that import');
  assert.match(run.stderr, /\[vendor-ai-sdk\] ERROR/);
  assert.match(run.stderr, /@anthropic-ai\/sdk\/helpers\/zod/);
});

test('an SDK entry point that imports the optional peer breaks the build', () => {
  const fixture = makeFixture({
    entryImportsZod: true,
    bundle: 'const sdk=import("@anthropic-ai/sdk");\n',
  });
  const run = runVendor(fixture);
  assert.equal(run.status, 1, 'dropping that entry point would ship an SDK that cannot load');
  assert.match(run.stderr, /\[vendor-ai-sdk\] ERROR/);
  assert.match(run.stderr, /index\.mjs/);
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

test('the vendored tree carries the SDK entry points and no zod', { timeout: 120_000 }, () => {
  // The script runs over a scratch extension dir that links the repo's
  // node_modules and holds no bundle. Pointed at the repo itself, it would also
  // check whatever dist/extension.js an earlier build left behind, and fail
  // `validate` on a bundle the build step is about to replace. The guard on the
  // bundle has its own fixture test above.
  const extensionDir = realpathSync(mkdtempSync(join(tmpdir(), 'sandforge-vendor-')));
  fixtureRoots.push(extensionDir);
  const modules = join(extensionDir, 'node_modules');
  symlinkSync(join(repoRoot, 'packages', 'extension', 'node_modules'), modules, 'junction');
  try {
    execFileSync(process.execPath, [vendorScript, extensionDir], { stdio: 'pipe' });
  } finally {
    // Unlinked before the fixture cleanup, so no recursive removal walks into it.
    unlinkSync(modules);
  }

  const outDir = join(extensionDir, 'dist', 'node_modules');
  const sdkDest = join(outDir, '@anthropic-ai', 'sdk');
  assert.ok(existsSync(join(sdkDest, 'index.js')));
  assert.ok(existsSync(join(sdkDest, 'index.mjs')));
  assert.equal(
    existsSync(join(outDir, 'zod')),
    false,
    'zod ships, and nothing the extension loads needs it',
  );
  assert.equal(existsSync(join(sdkDest, 'helpers', 'zod.mjs')), false);
  // json-schema-to-ts is a declared dependency of the SDK that no shipped
  // runtime file imports — it must stay out of the VSIX on that evidence.
  assert.equal(existsSync(join(outDir, 'json-schema-to-ts')), false);
});
