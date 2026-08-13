/**
 * Unit tests for the vendoring rules in vendor-ai-sdk.mjs, plus one end-to-end
 * run: the prune decisions are what keep zod's dead v3 tree out of the VSIX,
 * and a mistake there surfaces as a broken AI call in a shipped release.
 *
 * Run: node --test scripts/vendor-ai-sdk.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  TYPE_ONLY_DEPS,
  findDeadZodImport,
  pruneFilter,
  unvendoredRuntimeDeps,
  zodPruneFilter,
} from './vendor-ai-sdk.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const vendorScript = join(scriptsDir, 'vendor-ai-sdk.mjs');
const outDir = join(repoRoot, 'packages', 'extension', 'dist', 'node_modules');

const zodRoot = resolve('/pnpm/zod@3.25.76/node_modules/zod');
const keeps = zodPruneFilter(zodRoot);

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

test('unvendoredRuntimeDeps reports a declared dependency with no vendored copy', () => {
  const vendored = new Set(['zod']);
  assert.deepEqual(
    unvendoredRuntimeDeps({ dependencies: { 'some-new-dep': '^1.0.0' } }, (d) => vendored.has(d)),
    ['some-new-dep'],
  );
  assert.deepEqual(
    unvendoredRuntimeDeps({ dependencies: { zod: '^4' } }, (d) => vendored.has(d)),
    [],
  );
  assert.deepEqual(
    unvendoredRuntimeDeps({}, () => false),
    [],
  );
});

test('unvendoredRuntimeDeps exempts the type-only dependencies', () => {
  assert.ok(TYPE_ONLY_DEPS.has('json-schema-to-ts'));
  assert.deepEqual(
    unvendoredRuntimeDeps({ dependencies: { 'json-schema-to-ts': '^3.1.1' } }, () => false),
    [],
  );
});

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

    const helper = readFileSync(join(sdkDest, 'helpers', 'zod.mjs'), 'utf8');
    assert.equal(findDeadZodImport(helper), null, 'SDK helper still imports a pruned zod entry');
  },
);
