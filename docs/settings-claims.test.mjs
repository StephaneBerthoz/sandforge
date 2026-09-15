/**
 * Keeps what SandForge says about its telemetry setting true to the adapter.
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
import { readFileSync } from 'node:fs';
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
