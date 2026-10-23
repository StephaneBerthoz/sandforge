/**
 * Keeps what SandForge says about two of its settings true to the code: the
 * telemetry setting to the adapter, and the production setting, no longer
 * used, to the guard that no longer reads it.
 *
 * Telemetry first.
 *
 * `TelemetryAdapter` is a Pino logger behind the `sandforge.telemetry` gate: it
 * imports `pino` and nothing that opens a connection. The setting
 * was still described as "anonymous usage telemetry" in the six manifest
 * bundles and both READMEs, which reads as data leaving the machine, and the
 * Settings page labelled its counter "Events sent" beside a "Buffer size" row
 * the extension filled with a hard-coded 0.
 *
 * The first test anchors the claim on the code. If the adapter ever gains a
 * transport it fails, and whoever added it has to rewrite the wording below
 * rather than let "nothing is sent" become the new false claim.
 *
 *   node --test docs/settings-claims.test.mjs
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { bundles } from './claims-surfaces.mjs';

const docsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(docsDir, '..');
const read = (...parts) => readFileSync(join(repoRoot, ...parts), 'utf8');

/** Words each locale used for "anonymous" or "usage telemetry". */
const OLD_WORDING = {
  en: /anonymous|usage telemetry/i,
  fr: /anonyme|télémétrie d'utilisation/i,
  de: /anonym|Nutzungstelemetrie/i,
  es: /anónima|telemetría de uso/i,
  ja: /匿名|利用状況テレメトリ/,
  'pt-br': /anônima|telemetria de uso/i,
};

test('anchor: the telemetry adapter imports no network transport', () => {
  const src = read('packages', 'extension', 'src', 'adapters', 'telemetry', 'TelemetryAdapter.ts');
  const modules = [...src.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(modules)].sort(),
    ['pino'],
    'TelemetryAdapter imports something new — if it can send data, the setting text below is now false',
  );
  assert.doesNotMatch(
    src,
    /\bfetch\(|https?:\/\/|transport\s*:/,
    'TelemetryAdapter sends somewhere',
  );
});

test('the telemetry setting says local and nothing sent, in six languages', () => {
  for (const [locale, bundle] of Object.entries(bundles())) {
    const text = bundle['config.telemetry.description'];
    assert.equal(typeof text, 'string', `${locale}: config.telemetry.description is missing`);
    assert.doesNotMatch(text, OLD_WORDING[locale], `${locale}: still sells usage telemetry`);
  }
  assert.match(bundles().en['config.telemetry.description'], /locally/);
  assert.match(bundles().en['config.telemetry.description'], /Nothing is sent/);
});

test('both READMEs describe the telemetry setting as the manifest does', () => {
  const expected = bundles().en['config.telemetry.description'];
  for (const readme of [['README.md'], ['packages', 'extension', 'README.md']]) {
    const row = read(...readme)
      .split('\n')
      .find((line) => line.startsWith('| `sandforge.telemetry`'));
    assert.ok(row, `${readme.join('/')}: no sandforge.telemetry row`);
    assert.equal(row.split('|')[2].trim(), expected, `${readme.join('/')}: telemetry row drifted`);
  }
});

test('the Settings page shows no send counter and no buffer it cannot measure', () => {
  const en = JSON.parse(read('packages', 'webview', 'src', 'i18n', 'locales', 'en.json'));
  assert.doesNotMatch(en.settings.telemetryEventCount, /sent/i);
  assert.equal(en.settings.telemetryBufferSize, undefined);

  const page = read('packages', 'webview', 'src', 'pages', 'Settings', 'SettingsPage.tsx');
  assert.doesNotMatch(page, /bufferSize/, 'SettingsPage renders a buffer row again');
  const handler = read('packages', 'extension', 'src', 'bridge', 'handlers', 'SettingsHandler.ts');
  assert.doesNotMatch(handler, /bufferSize/, 'SettingsHandler reports a buffer size again');
});

// ── sandforge.safety.requireProdConfirmation, no longer used ─────────────

/** Words each locale says "no longer used" with, at the head of the setting's text. */
const NO_LONGER_USED = {
  en: /^No longer used/,
  fr: /^N'est plus utilisé/,
  de: /^Wird nicht mehr verwendet/,
  es: /^Ya no se usa/,
  ja: /^使用されなくなりました/,
  'pt-br': /^Não é mais usado/,
};

/** The extension's source files, tests left out. */
function extensionSources() {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) files.push(path);
    }
  };
  walk(join(repoRoot, 'packages', 'extension', 'src'));
  return files;
}

test('anchor: no setting drops the question a write to a production org is asked', () => {
  // Off, the setting let Seed, Sync, Autopilot and DataOps write into
  // production without a word, where their command lines refuse such a target.
  const readers = extensionSources().filter((file) =>
    /'safety\.requireProdConfirmation'/.test(readFileSync(file, 'utf8')),
  );
  assert.deepEqual(
    readers.map((file) => file.slice(repoRoot.length + 1)),
    [],
    'the setting is read again — the text below says it is no longer used',
  );
  const guard = read('packages', 'extension', 'src', 'core', 'precheck', 'ProductionGuard.ts');
  const production = guard.slice(guard.indexOf('private checkProduction('));
  assert.match(
    production.slice(0, production.indexOf('private checkStaging(')),
    /allowed: true,\s*requiresConfirmation: true,/,
    'a production write the guard allows no longer always asks',
  );
});

test('the production setting says it is no longer used, in the manifest, six languages and both READMEs', () => {
  const property = JSON.parse(read('packages', 'extension', 'package.json')).contributes
    .configuration.properties['sandforge.safety.requireProdConfirmation'];
  assert.ok(property, 'the setting is gone from the manifest — re-point this gate');
  assert.equal(property.deprecationMessage, '%config.safety.requireProdConfirmation.deprecation%');
  for (const [locale, bundle] of Object.entries(bundles())) {
    for (const key of ['description', 'deprecation']) {
      const text = bundle[`config.safety.requireProdConfirmation.${key}`];
      assert.equal(typeof text, 'string', `${locale}: ${key} is missing`);
      assert.match(text, NO_LONGER_USED[locale], `${locale}: the ${key} still sells the setting`);
    }
  }
  for (const readme of [['README.md'], ['packages', 'extension', 'README.md']]) {
    const row = read(...readme)
      .split('\n')
      .find((line) => line.startsWith('| `sandforge.safety.requireProdConfirmation`'));
    assert.ok(row, `${readme.join('/')}: no sandforge.safety.requireProdConfirmation row`);
    assert.match(row.split('|')[2].trim(), /^No longer used/, `${readme.join('/')}: row drifted`);
  }
  assert.doesNotMatch(
    read('docs', 'faq.md'),
    /requireProdConfirmation` turns|configure these protections/,
    'the FAQ says the setting still turns the production question off',
  );
});
