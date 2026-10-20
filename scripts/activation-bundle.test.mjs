/**
 * Gate: the packages the activation bundle carries are the ones listed here.
 *
 * VS Code sets no limit on an extension's size. What costs is what the
 * extension host reads at every window start: `dist/extension.js`, built by
 * esbuild from `src/extension.ts`. Our own code grows with every feature and
 * is not what this watches. A dependency is: jsforce evaluated at activation
 * costs about 70 ms per window, and in 1.35.0 an import by the wrong path put
 * all of it back in the bundle — 1 014 kB became 2 479 kB — with every test
 * green. A byte budget caught it, but a byte budget mixes that leak with our
 * own growth, and was raised the first time the growth tripped it.
 *
 * This bundles the extension as its build does, reads which npm packages end
 * up in it, and fails on one that is not listed below — so bringing a
 * dependency into the activation path is a decision written here, not a number
 * that drifts. A listed package that is no longer bundled fails too, so the
 * list stays the truth.
 *
 * Run: node --test scripts/activation-bundle.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = join(root, 'packages', 'extension');

/**
 * The npm packages the activation bundle may carry, and why each is there.
 * Measured on 1.35.0: 284 kB of dependencies next to about 900 kB of our code.
 */
const ALLOWED = new Map([
  ['zod', 'every payload the bridge receives is validated at the boundary'],
  ['cron-parser', 'sync schedules and pipeline triggers are planned at startup'],
  ['luxon', 'cron-parser reads time zones through it'],
  ['pino', 'the extension log'],
  ['@pinojs/redact', 'pino'],
  ['atomic-sleep', 'pino'],
  ['on-exit-leak-free', 'pino'],
  ['pino-std-serializers', 'pino'],
  ['quick-format-unescaped', 'pino'],
  ['safe-stable-stringify', 'pino'],
  ['sonic-boom', 'pino'],
  ['thread-stream', 'pino'],
]);

/** The flags of the build step that makes dist/extension.js, read from package.json. */
function buildOptions() {
  const script = JSON.parse(readFileSync(join(EXTENSION, 'package.json'), 'utf8')).scripts.build;
  const step = script.split('&&').find((part) => part.includes('./src/extension.ts'));
  assert.ok(step, 'the build no longer bundles ./src/extension.ts — re-point this gate');
  const external = [...step.matchAll(/--external:("?)([^\s"]+)\1/g)].map((match) => match[2]);
  assert.ok(external.includes('./jsforceEntry.js'), 'the build no longer keeps jsforce external');
  const alias = Object.fromEntries(
    [...step.matchAll(/--alias:("?)([^\s"=]+)=([^\s"]+)\1/g)].map((match) => [match[2], match[3]]),
  );
  return {
    // The build runs from packages/extension, and esbuild resolves a relative
    // alias against the working directory.
    absWorkingDir: EXTENSION,
    entryPoints: [join(EXTENSION, 'src', 'extension.ts')],
    bundle: true,
    outfile: join(EXTENSION, 'dist', 'extension.js'),
    external,
    alias,
    format: 'cjs',
    platform: 'node',
    minify: true,
    metafile: true,
    write: false,
    logLevel: 'silent',
  };
}

/** The npm packages in a bundle's output, with the bytes each adds. */
function bundledPackages(metafile) {
  const [output] = Object.values(metafile.outputs);
  const packages = new Map();
  for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
    const at = input.lastIndexOf('node_modules/');
    if (at === -1) continue;
    const parts = input.slice(at + 'node_modules/'.length).split('/');
    const name = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
    packages.set(name, (packages.get(name) ?? 0) + bytesInOutput);
  }
  return packages;
}

/**
 * What the bundle holds of zod and of the shared package that it should not.
 *
 * zod ships each of its files twice, as ESM (`.js`) and as CommonJS (`.cjs`),
 * and esbuild takes whichever form the importer asks for. The bundle used to
 * hold both: the extension's sources import zod as ESM, while
 * `@sandforge/shared` was taken from its tsc output, CommonJS, whose
 * `require("zod")` picked the other copy. That was two zods, with two
 * `ZodError` classes that `instanceof` tells apart, and none of the shared
 * package's unused templates and presets left out. Each copy also carried all
 * of zod's locales: `import { z } from 'zod'` binds a namespace object that
 * holds `z.locales`, which esbuild cannot shake, where `import * as z from
 * 'zod'` lets it keep what the code calls, and English, the messages zod uses
 * by default. Together they were a third of the bundle: 2 914 kB, 1 920 kB
 * without them.
 */
function zodFindings(metafile) {
  const [output] = Object.values(metafile.outputs);
  const inputs = Object.keys(output.inputs);
  const findings = [];
  const fromSharedBuild = inputs.filter((input) => /(^|\/)shared\/dist\//.test(input));
  if (fromSharedBuild.length > 0) {
    findings.push(
      `@sandforge/shared comes from its CommonJS build (${fromSharedBuild.length} files under ` +
        'shared/dist): alias it to ../shared/src/index.ts in the build, as vite.config.ts does',
    );
  }
  const zod = inputs.filter((input) => input.includes('node_modules/zod/'));
  const commonJs = zod.filter((input) => input.endsWith('.cjs'));
  if (commonJs.length > 0 && commonJs.length < zod.length) {
    findings.push(
      `zod is bundled twice, as ESM and as CommonJS (${commonJs.length} .cjs files beside ` +
        `${zod.length - commonJs.length} others)`,
    );
  }
  const locales = zod
    .filter((input) => input.includes('/locales/'))
    .map((input) => input.slice(input.lastIndexOf('/') + 1).replace(/\.c?js$/, ''))
    .filter((name) => name !== 'en' && name !== 'index');
  if (locales.length > 0) {
    findings.push(
      `zod carries ${locales.length} locale file(s) besides English (${[...new Set(locales)]
        .slice(0, 5)
        .join(', ')}, …): import it as \`import * as z from 'zod'\`, not \`import { z }\``,
    );
  }
  return findings;
}

let activationBuild;
/** The metafile of the activation bundle, built once for every test here. */
function activationMetafile() {
  activationBuild ??= createRequire(join(EXTENSION, 'package.json'))('esbuild')
    .build(buildOptions())
    .then((result) => result.metafile);
  return activationBuild;
}

test('the activation bundle carries the listed packages and no other', async () => {
  const metafile = await activationMetafile();
  const packages = bundledPackages(metafile);
  // Positive control: the walk reads the packages the bundle is known to carry.
  assert.ok(packages.has('zod'), 'the bundle shows no zod — this gate is not reading it');

  const unlisted = [...packages]
    .filter(([name]) => !ALLOWED.has(name))
    .map(([name, bytes]) => `${name} (${Math.round(bytes / 1024)} kB)`);
  assert.deepEqual(
    unlisted,
    [],
    'a package entered the activation bundle. Load it lazily from where it is used ' +
      '(jsforce: through a helper in core/connection), or list it above with its reason.',
  );
  const gone = [...ALLOWED.keys()].filter((name) => !packages.has(name));
  assert.deepEqual(gone, [], 'a listed package is no longer bundled: remove it from the list');
});

test('the activation bundle carries one copy of zod, with its English messages only', async () => {
  const metafile = await activationMetafile();
  const [output] = Object.values(metafile.outputs);
  // Positive control: the bundle is known to carry zod's English locale.
  assert.ok(
    Object.keys(output.inputs).some((input) => /node_modules\/zod\/.*\/locales\/en\./.test(input)),
    "the bundle shows no zod locale at all — this test is not reading zod's files",
  );
  assert.deepEqual(zodFindings(metafile), []);
});

test('the zod reading flags a second copy, extra locales and the shared CommonJS build', () => {
  const zod = '../../node_modules/.pnpm/zod@4.6.5/node_modules/zod';
  const bundle = (inputs) => ({
    outputs: {
      'dist/extension.js': {
        inputs: Object.fromEntries(inputs.map((input) => [input, { bytesInOutput: 1 }])),
      },
    },
  });
  const clean = [
    'src/extension.ts',
    '../shared/src/index.ts',
    `${zod}/v4/classic/schemas.js`,
    `${zod}/v4/locales/en.js`,
    `${zod}/v4/locales/index.js`,
  ];
  assert.deepEqual(zodFindings(bundle(clean)), []);

  const findings = zodFindings(
    bundle([
      ...clean,
      '../shared/dist/index.js',
      `${zod}/v4/classic/schemas.cjs`,
      `${zod}/v4/locales/en.cjs`,
      `${zod}/v4/locales/pl.cjs`,
      `${zod}/v4/locales/pl.js`,
    ]),
  );
  assert.equal(findings.length, 3, findings.join('\n'));
  assert.match(findings[0], /CommonJS build \(1 files under shared\/dist\)/);
  assert.match(findings[1], /zod is bundled twice/);
  assert.match(findings[2], /2 locale file\(s\) besides English \(pl, …\)/);
});

test('the package reading names scoped and plain packages, and skips our own files', () => {
  const packages = bundledPackages({
    outputs: {
      'dist/extension.js': {
        inputs: {
          'src/extension.ts': { bytesInOutput: 900 },
          '../../node_modules/.pnpm/pino@9/node_modules/pino/pino.js': { bytesInOutput: 10 },
          '../../node_modules/.pnpm/x/node_modules/@pinojs/redact/index.js': { bytesInOutput: 5 },
          '../../node_modules/.pnpm/x/node_modules/@pinojs/redact/lib/a.js': { bytesInOutput: 1 },
        },
      },
    },
  });
  assert.deepEqual(
    [...packages],
    [
      ['pino', 10],
      ['@pinojs/redact', 6],
    ],
  );
});
