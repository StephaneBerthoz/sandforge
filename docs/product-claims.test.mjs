/**
 * Keeps every user-facing surface honest about two features the code does not
 * have — in all of the places each of them is written.
 *
 * The sibling gate, `automation-scheduler-claims.test.mjs`, guards one claim in
 * two files of `docs/`. That shape works: it is the one gate in this repo that
 * has actually caught prose drifting away from the code. Its blind spot is that
 * the same fact is written in far more than two places.
 *
 * Grappe is described in `README.md`, `packages/extension/README.md`,
 * `docs/faq.md`, three setting descriptions in the manifest, and six locale
 * files. At v1.17.0 it was wrong in two opposite directions at once: the
 * READMEs called it a "parallel execution engine" that "no operation activates
 * yet", while `AutopilotOrchestrator` does activate it and does not partition
 * anything — `grappeAdapter.partition()` has no caller, and `grappeActive`
 * only wraps an unchanged sequential loop in two progress events.
 *
 * CDC is the same story: removed from the Sync UI, disclaimed in
 * `docs/modules/sync.md`, routed to `NoOpHandler` in the extension — and still
 * sold as a working "near real-time" sync mode by the in-app help panel, in all
 * six languages.
 *
 * So each assertion here is anchored to the code that decides the truth, and
 * fails in BOTH directions: build the feature and the anchor test trips first,
 * telling you the prose is now understating the product and may be rewritten.
 *
 *   node --test docs/product-claims.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const docsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(docsDir, '..');
const read = (...p) => readFileSync(join(repoRoot, ...p), 'utf8');

const LOCALES_DIR = join(repoRoot, 'packages', 'webview', 'src', 'i18n', 'locales');
const localeFiles = () => readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.json'));

/** Every surface a user reads, as `label → text`. Source comments are not here. */
function userFacingText() {
  const surfaces = {
    'README.md': read('README.md'),
    'packages/extension/README.md': read('packages', 'extension', 'README.md'),
    'docs/faq.md': read('docs', 'faq.md'),
  };
  const manifest = JSON.parse(read('packages', 'extension', 'package.json'));
  const props = manifest.contributes?.configuration?.properties ?? {};
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('sandforge.grappe.') && typeof value.description === 'string') {
      surfaces[`package.json ${key}`] = value.description;
    }
  }
  for (const file of localeFiles()) {
    surfaces[`locales/${file}`] = readFileSync(join(LOCALES_DIR, file), 'utf8');
  }
  return surfaces;
}

// ── Grappe ────────────────────────────────────────────────────────────────

test('anchor: Grappe still does not partition or parallelise anything', () => {
  const orchestrator = read(
    'packages', 'extension', 'src', 'modules', 'autopilot', 'AutopilotOrchestrator.ts',
  );
  assert.doesNotMatch(
    orchestrator,
    /grappeAdapter\s*\.\s*partition\s*\(/,
    'AutopilotOrchestrator now calls grappeAdapter.partition() — Grappe may really partition ' +
      'work. Re-read every surface below before deleting this test: they are currently written ' +
      'to say it does not.',
  );
});

test('no user-facing surface calls Grappe parallel', () => {
  // `grappeActive` gates two progress events around a sequential executor, so
  // "parallel" is the one word that cannot be used until the anchor above trips.
  const offenders = [];
  for (const [label, text] of Object.entries(userFacingText())) {
    for (const line of text.split('\n')) {
      if (!/grappe/i.test(line)) continue;
      if (/\bparall[eè]l/i.test(line)) offenders.push(`${label}: ${line.trim().slice(0, 120)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'these lines sell Grappe as parallel execution, which it is not:\n  ' + offenders.join('\n  '),
  );
});

test('no user-facing surface claims nothing activates Grappe', () => {
  // The opposite error, shipped in the same table row: Seed, Sync and Autopilot
  // all set `grappeActive`, so "no operation activates it" is equally false.
  const activates = read(
    'packages', 'extension', 'src', 'modules', 'autopilot', 'AutopilotOrchestrator.ts',
  );
  assert.match(
    activates,
    /grappeActive/,
    'nothing sets grappeActive any more — the "not activated" wording may be true again',
  );

  const offenders = [];
  for (const [label, text] of Object.entries(userFacingText())) {
    for (const line of text.split('\n')) {
      if (!/grappe/i.test(line)) continue;
      if (/no operation activates/i.test(line)) offenders.push(`${label}: ${line.trim().slice(0, 120)}`);
    }
  }
  assert.deepEqual(offenders, [], 'these lines deny an activation that happens:\n  ' + offenders.join('\n  '));
});

// ── CDC / real-time sync ──────────────────────────────────────────────────

test('anchor: every realtime:* channel is still routed to the no-op handler', () => {
  const src = read('packages', 'extension', 'src', 'bridge', 'ExtensionHandlers.ts');
  const noOpRoute = [...src.matchAll(/route\(\s*\[([^\]]*)\]\s*,\s*this\.(\w+)/g)].find(
    ([, , handler]) => handler === 'noOpHandler',
  );
  assert.ok(noOpRoute, 'no `route([...], this.noOpHandler)` call found in ExtensionHandlers.ts');
  for (const channel of ['realtime:start', 'realtime:status', 'realtime:metrics']) {
    assert.match(
      noOpRoute[1],
      new RegExp(`'${channel}'`),
      `${channel} now has a real handler — CDC may work. Re-read the help panel copy in all six ` +
        'locales before deleting this test.',
    );
  }
});

test('the in-app help panel does not sell CDC as a working sync mode', () => {
  // `help.syncContent` is what the Help panel renders. It promised "4 sync
  // modes: Full, Incremental, Delta, CDC" in six languages, for a mode the UI
  // no longer offers and the extension answers with `comingSoon: true`.
  const offenders = [];
  for (const file of localeFiles()) {
    const bundle = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8'));
    const help = bundle.help?.syncContent;
    if (typeof help !== 'string') continue;
    // Accept any wording that marks the gap; reject a bare promise.
    const promises = /\bCDC\b|change data capture/i.test(help);
    // Built from what the six locales actually say, not from guessed wording:
    // the first cut matched only English and flagged four correct translations.
    const disclaims =
      /coming soon|not (?:yet )?(?:wired|available|implemented)|no-op/i.test(help) ||
      /ne sont pas impl|pas encore|no est[áa]n implementad|n[ãa]o est[ãa]o implementad|nicht implementiert|未実装/i.test(help);
    if (promises && !disclaims) offenders.push(`locales/${file}: help.syncContent promises CDC`);
  }
  assert.deepEqual(
    offenders,
    [],
    'the help panel sells a sync mode that is a registered no-op:\n  ' + offenders.join('\n  '),
  );
});
