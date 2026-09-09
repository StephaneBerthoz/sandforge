/**
 * Tests for sections 3 and 4 of check-i18n-parity.ts.
 *
 * The gate is a CLI whose contract is "exit 1 and name the offender", so it is
 * exercised as a CLI: a throwaway repo is built in a temp dir, the real script
 * is copied into its `scripts/` (every path it reads is `__dirname`-relative),
 * and the exit code plus stdout are the assertions.
 *
 * Run: node --test scripts/check-i18n-parity.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const gateScript = join(scriptsDir, 'check-i18n-parity.ts');
const tsxCli = resolve(scriptsDir, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');

const LOCALES = 'packages/webview/src/i18n/locales';

const EN = {
  greeting: {
    hello: 'Hello there',
    itemCount_one: '{{count}} item',
    itemCount_other: '{{count}} items',
  },
  brand: { name: 'SandForge Pro', unit: 'Total' },
  prose: { welcome: 'Welcome to the sandbox' },
};

/** French catalogue, `prose.welcome` overridable to stage an untranslated value. */
const fr = (welcome = 'Bienvenue dans le bac a sable') => ({
  greeting: {
    hello: 'Bonjour',
    itemCount_one: '{{count}} objet',
    itemCount_other: '{{count}} objets',
  },
  brand: { name: 'SandForge Pro', unit: 'Total' },
  prose: { welcome },
});

/** The component every fixture ships, plus whatever extra t() calls a case needs. */
const app = (...calls) =>
  [
    'export function App({ t, suffix }) {',
    "  return [t('greeting.hello'), t('greeting.itemCount', { count: 2 }),",
    "    t('brand.name'), t('brand.unit'), t('prose.welcome'),",
    ...calls.map((c) => `    ${c},`),
    "  ].join('') + suffix;",
    '}',
    '',
  ].join('\n');

/**
 * A repo the gate passes on: en/fr parity, every catalogue key referenced by a
 * source file (section 6), no unaccented French (section 5). `brand.name` is
 * identical across locales on purpose and allowlisted; `brand.unit` is
 * identical too but a single word, which section 4 ignores on its own.
 */
const baseFixture = () => ({
  [`${LOCALES}/en.json`]: JSON.stringify(EN),
  [`${LOCALES}/fr.json`]: JSON.stringify(fr()),
  'packages/webview/src/App.tsx': app(),
  'packages/extension/package.nls.json': JSON.stringify({ 'command.run.title': 'Run' }),
  'scripts/i18n-identical-allowlist.json': JSON.stringify({ keys: ['brand.name'] }),
});

function runGate(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sf-i18n-gate-'));
  try {
    for (const [rel, content] of Object.entries({ ...baseFixture(), ...overrides })) {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf8');
    }
    const script = join(dir, 'scripts', 'check-i18n-parity.ts');
    copyFileSync(gateScript, script);
    const run = spawnSync(process.execPath, [tsxCli, script], { encoding: 'utf8' });
    return { status: run.status, output: `${run.stdout}${run.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const RESOLVES_OK = '✓ t() keys: every literal key resolves against en.json';
const PROSE_OK = '✓ identical-to-English: no untranslated prose outside the allowlist';

test('section 3 passes when the catalogue backs every literal key', () => {
  const { status, output } = runGate();
  assert.ok(output.includes(RESOLVES_OK), output);
  assert.equal(status, 0);
});

test('section 3 fails and names a bare t() key with no en.json entry', () => {
  const { status, output } = runGate({
    'packages/webview/src/App.tsx': app("t('greeting.missing')"),
  });
  assert.ok(output.includes('✗ t() keys: 1 key(s) absent from en.json (renders raw)'), output);
  assert.ok(output.includes('greeting.missing (App.tsx)'), output);
  assert.equal(status, 1);
});

// `greeting.itemCount` exists only as `_one`/`_other`; i18next picks at runtime.
test('section 3 resolves a key through its plural variants', () => {
  const { output } = runGate();
  assert.ok(!output.includes('greeting.itemCount'), output);
});

test('section 3 reports an unbacked inline default separately from a raw key', () => {
  const { status, output } = runGate({
    'packages/webview/src/App.tsx': app("t('greeting.absent', 'English copy')"),
  });
  assert.ok(output.includes(RESOLVES_OK), output);
  assert.ok(output.includes('✗ inline defaults: 1 key(s) absent from en.json'), output);
  assert.ok(output.includes('greeting.absent (App.tsx)'), output);
  assert.equal(status, 1);
});

test('section 3 ignores a literal that is only the prefix of a runtime key', () => {
  const { status, output } = runGate({
    'packages/webview/src/App.tsx': app("t('greeting.' + suffix)"),
  });
  assert.ok(output.includes(RESOLVES_OK), output);
  assert.equal(status, 0);
});

test('section 3 ignores keys used only in *.test.* and *.spec.* files', () => {
  const { status, output } = runGate({
    'packages/webview/src/App.spec.tsx': "t('greeting.specOnly');\n",
    'packages/webview/src/App.test.tsx': "t('greeting.testOnly');\n",
  });
  assert.ok(!output.includes('greeting.specOnly'), output);
  assert.ok(!output.includes('greeting.testOnly'), output);
  assert.equal(status, 0);
});

test('section 4 stays silent on single-word and allowlisted identical values', () => {
  const { status, output } = runGate();
  assert.ok(output.includes(PROSE_OK), output);
  // 'Total' and 'SandForge Pro' are byte-identical in fr and must not surface.
  assert.ok(!output.includes('brand.unit'), output);
  assert.ok(!output.includes('brand.name'), output);
  assert.equal(status, 0);
});

test('section 4 FAILS on a multi-word value left in English', () => {
  // Report-only until v1.19.0, which is how the count reached 14 while the
  // product advertised six languages: nothing ever stopped a release over
  // prose that had simply never been translated.
  const { status, output } = runGate({
    [`${LOCALES}/fr.json`]: JSON.stringify(fr('Welcome to the sandbox')),
  });
  assert.ok(
    output.includes('identical-to-English: 1 value(s) still carrying the English copy'),
    output,
  );
  assert.ok(output.includes('- prose.welcome [fr]'), output);
  assert.ok(output.includes('i18n-identical-allowlist.json'), output);
  assert.equal(status, 1);
});

test('section 4 surfaces an identical value once it leaves the allowlist', () => {
  const { output } = runGate({
    'scripts/i18n-identical-allowlist.json': JSON.stringify({ keys: [] }),
  });
  assert.ok(output.includes('- brand.name [fr]'), output);
});
