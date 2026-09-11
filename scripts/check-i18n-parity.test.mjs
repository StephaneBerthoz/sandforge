/**
 * Tests for sections 3, 4 and 6 of check-i18n-parity.ts.
 *
 * The gate is a CLI whose contract is "exit 1 and name the offender", so it is
 * exercised as a CLI: a throwaway repo is built in a temp dir, the real script
 * is copied into its `scripts/` (every path it reads is `__dirname`-relative),
 * and the exit code plus stdout are the assertions.
 *
 * Section 6's baseline is the one thing the copy cannot keep: the shipped list
 * is empty, and a case that needs entries needs ones a throwaway catalogue
 * defines. Each case stages the list and the census it is about, and asserts
 * the substitution actually landed.
 *
 * Run: node --test scripts/check-i18n-parity.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const gateSource = readFileSync(gateScript, 'utf8');
const BASELINE_DECL = /const UNREFERENCED_BASELINE: readonly string\[\] = \[[\s\S]*?\];/;
const CENSUS_DECL = /const BASELINE_CENSUS = \{[^}]*\} as const;/;
const TAILS_DECL = /const DYNAMIC_TAIL_PREFIXES: readonly string\[\] = \[[\s\S]*?\];/;

/**
 * The real gate, with section 6's baseline, census and declared tail families
 * swapped for the case's. `DYNAMIC_TAIL_PREFIXES` is staged for the same reason
 * the baseline is: the shipped value names `home` and `sidePanel.relativeTime`,
 * which a throwaway catalogue neither calls nor defines — and
 * `auditDynamicTailPrefixes` fails, correctly, on a declared prefix no call
 * passes or that builds no key. Empty by default, so a fixture that says
 * nothing about tail families gets no exemption at all.
 */
function stagedGate(baseline, census, tailPrefixes) {
  const staged = gateSource
    .replace(
      BASELINE_DECL,
      `const UNREFERENCED_BASELINE: readonly string[] = ${JSON.stringify(baseline)};`,
    )
    .replace(CENSUS_DECL, `const BASELINE_CENSUS = ${JSON.stringify(census)} as const;`)
    .replace(
      TAILS_DECL,
      `const DYNAMIC_TAIL_PREFIXES: readonly string[] = ${JSON.stringify(tailPrefixes)};`,
    );
  // A rename that silently left the shipped declaration in place would turn
  // every section 6 assertion below into noise, so prove both edits landed.
  // Asserting the *result* is what keeps this able to fail: the old canary
  // named a member of the shipped list, and went vacuous the day that list was
  // emptied — it would have passed on a substitution that never ran.
  assert.ok(
    staged.includes(
      `const UNREFERENCED_BASELINE: readonly string[] = ${JSON.stringify(baseline)};`,
    ),
    'baseline substitution missed the real list',
  );
  assert.ok(
    staged.includes(JSON.stringify(census)),
    'census substitution missed the real constant',
  );
  assert.ok(
    staged.includes(
      `const DYNAMIC_TAIL_PREFIXES: readonly string[] = ${JSON.stringify(tailPrefixes)};`,
    ),
    'tail-prefix substitution missed the real list',
  );
  return staged;
}

function runGate(overrides = {}, { baseline = [], census, tailPrefixes = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sf-i18n-gate-'));
  try {
    for (const [rel, content] of Object.entries({ ...baseFixture(), ...overrides })) {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf8');
    }
    const script = join(dir, 'scripts', 'check-i18n-parity.ts');
    writeFileSync(
      script,
      stagedGate(
        baseline,
        census ?? { recorded: '2026-01-01', count: baseline.length },
        tailPrefixes,
      ),
      'utf8',
    );
    const run = spawnSync(process.execPath, [tsxCli, script], { encoding: 'utf8' });
    return { status: run.status, output: `${run.stdout}${run.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const RESOLVES_OK = '✓ t() keys: every literal key resolves against en.json';
const PROSE_OK = '✓ identical-to-English: no untranslated prose outside the allowlist';
const BASELINE_OK = '✓ baseline: every entry is still an unreferenced key of the catalogue';
const NO_FRESH = '✓ no key added since the baseline is unreferenced';

/** en/fr carrying one extra entry `App.tsx` never mentions. */
const orphanCatalogue = {
  [`${LOCALES}/en.json`]: JSON.stringify({ ...EN, orphan: { old: 'Retired copy' } }),
  [`${LOCALES}/fr.json`]: JSON.stringify({ ...fr(), orphan: { old: 'Texte retiré' } }),
};

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

// --- section 6: the baseline is a ratchet ----------------------------------

test('section 6 fails on an unreferenced key the baseline does not cover', () => {
  const { status, output } = runGate(orphanCatalogue, { baseline: [] });
  assert.ok(output.includes('✗ 1 newly unreferenced key(s)'), output);
  assert.ok(output.includes('    - orphan.old'), output);
  assert.equal(status, 1);
});

test('section 6 falls silent once that key is listed in the baseline', () => {
  const { status, output } = runGate(orphanCatalogue, { baseline: ['orphan.old'] });
  assert.ok(output.includes(NO_FRESH), output);
  assert.ok(output.includes(BASELINE_OK), output);
  assert.equal(status, 0);
});

test('a baseline entry whose consumer came back fails until it is deleted', () => {
  // `greeting.hello` is rendered by App.tsx, so it has no business being here:
  // a key that lost its consumer for the length of a purge was written down
  // as dead instead of left to come back.
  const staleRun = runGate(orphanCatalogue, { baseline: ['greeting.hello', 'orphan.old'] });
  assert.ok(
    staleRun.output.includes(
      '✗ baseline: 1 entry(ies) referenced again — delete them from UNREFERENCED_BASELINE',
    ),
    staleRun.output,
  );
  assert.ok(staleRun.output.includes('    - greeting.hello'), staleRun.output);
  assert.equal(staleRun.status, 1);

  // The other direction: deleting it is the whole fix, and the list shrinks.
  const fixedRun = runGate(orphanCatalogue, { baseline: ['orphan.old'] });
  assert.ok(fixedRun.output.includes(BASELINE_OK), fixedRun.output);
  assert.equal(fixedRun.status, 0);
});

test('a baseline entry the catalogue no longer defines fails the run', () => {
  const { status, output } = runGate(orphanCatalogue, { baseline: ['gone.key', 'orphan.old'] });
  assert.ok(output.includes('✗ baseline: 1 entry(ies) absent from en.json — delete them'), output);
  assert.ok(output.includes('    - gone.key'), output);
  assert.equal(status, 1);
});

test('the baseline may not grow past the census it was counted at', () => {
  // Appending is the failure mode the baseline was built to stop: `orphan.old`
  // is legitimately unreferenced, so section 6 itself is happy — only the
  // census catches the entry that was added on top of the recorded count.
  const { status, output } = runGate(orphanCatalogue, {
    baseline: ['orphan.old'],
    census: { recorded: '2026-01-01', count: 0 },
  });
  assert.ok(output.includes(NO_FRESH), output);
  assert.ok(
    output.includes(
      '✗ baseline: 1 entries against 0 recorded 2026-01-01 — the baseline may shrink, never grow.',
    ),
    output,
  );
  assert.equal(status, 1);
});

test('the census reports how far the list has fallen since it was counted', () => {
  const { status, output } = runGate(orphanCatalogue, {
    baseline: ['orphan.old'],
    census: { recorded: '2026-01-01', count: 5 },
  });
  assert.ok(
    output.includes(
      'baseline census — 5 entries recorded 2026-01-01, 1 listed today (4 removed since)',
    ),
    output,
  );
  assert.equal(status, 0);
});

// --- section 6: the two exemptions must not become blanket amnesties -------

/** A test file whose ASSERTION MESSAGE happens to contain a dotted prefix. */
const assertionMessageFixture = {
  'packages/webview/src/styles/design-system.test.ts': [
    "for (const severity of ['info', 'warn']) {",
    '  expect(block[severity]).toBeTruthy(',
    '    `status.${severity} is not a hardened, alpha-capable token`,',
    '  );',
    '}',
    '',
  ].join('\n'),
  [`${LOCALES}/en.json`]: JSON.stringify({ ...EN, status: { dead: 'Retired status copy' } }),
  [`${LOCALES}/fr.json`]: JSON.stringify({ ...fr(), status: { dead: 'Statut retiré' } }),
};

test('section 6 flags a dead key whose prefix only exists in an assertion message', () => {
  const { status, output } = runGate(assertionMessageFixture, { baseline: [] });
  assert.ok(output.includes('✗ 1 newly unreferenced key(s)'), output);
  assert.ok(output.includes('    - status.dead'), output);
  assert.equal(status, 1);
});

/**
 * `t(`${p}.justNow`)` — the tail is literal, the prefix arrives as a value.
 * `before` is a line above the builder, `call` the array element that hands
 * the builder its prefix — really, or only in appearance.
 */
const tailApp = ({ before = '', call = "rel('home')" } = {}) =>
  [
    'export function App({ t, suffix }) {',
    before,
    '  const rel = (p) => t(`${p}.justNow`);',
    "  return [t('greeting.hello'), t('greeting.itemCount', { count: 2 }),",
    `    t('brand.name'), t('brand.unit'), t('prose.welcome'), ${call},`,
    "  ].join('') + suffix;",
    '}',
    '',
  ].join('\n');

/** en/fr carrying a `home` namespace built from `[leaf, english, french]` triples. */
const homeCatalogue = (...leaves) => ({
  [`${LOCALES}/en.json`]: JSON.stringify({
    ...EN,
    home: Object.fromEntries(leaves.map(([leaf, english]) => [leaf, english])),
  }),
  [`${LOCALES}/fr.json`]: JSON.stringify({
    ...fr(),
    home: Object.fromEntries(leaves.map(([leaf, , french]) => [leaf, french])),
  }),
});
const JUST_NOW = ['justNow', 'Just now', "À l'instant"];

const tailFirstFixture = {
  'packages/webview/src/App.tsx': tailApp(),
  [`${LOCALES}/en.json`]: JSON.stringify({
    ...EN,
    home: { justNow: 'Just now' },
    zzDead: { justNow: 'Dead tail copy' },
  }),
  [`${LOCALES}/fr.json`]: JSON.stringify({
    ...fr(),
    home: { justNow: "À l'instant" },
    zzDead: { justNow: 'Copie morte' },
  }),
};

const UNCALLED = '✗ dynamic tails: 1 declared prefix(es) no production call passes to its builder';

test('section 6 exempts a declared tail family and flags the same tail elsewhere', () => {
  // Both halves in one run: exempting on the bare tail let `zzDead.justNow`
  // through, and dropping the tail rule would print `home.justNow` — the six
  // keys `formatRelativeTimeI18n` builds and no file spells out.
  const { status, output } = runGate(tailFirstFixture, { tailPrefixes: ['home'] });
  assert.ok(output.includes('✗ 1 newly unreferenced key(s)'), output);
  assert.ok(output.includes('    - zzDead.justNow'), output);
  assert.ok(!output.includes('    - home.justNow'), output);
  assert.ok(output.includes('✓ dynamic tails: 1 declared prefix(es) × 1 tail(s)'), output);
  assert.equal(status, 1);
});

test('a declared tail prefix no production call passes to its builder fails the run', () => {
  const { status, output } = runGate(tailFirstFixture, { tailPrefixes: ['home', 'zzDead'] });
  // `zzDead` is spelled nowhere in App.tsx, so nothing builds `zzDead.justNow`.
  assert.ok(output.includes(UNCALLED), output);
  assert.ok(output.includes('    - zzDead\n'), output);
  assert.equal(status, 1);
});

test('a prefix named in a comment, a string or another call is not a call site', () => {
  // The shipped check searched for the quoted literal anywhere in production
  // code, so the JSDoc of `formatRelativeTimeI18n` — "e.g. 'home' or
  // 'sidePanel.relativeTime'" — kept both families exempt with every real call
  // deleted, and five dead keys out of the report. Each shape below is such a
  // mention, and none of them may stand in for the call.
  const impostors = {
    'a JSDoc': { before: "  /** @param p - the namespace, e.g. 'home' */", call: 'suffix' },
    // The shape of the original defect: formatters.ts carried the prefix on an
    // interior line of a seven-line JSDoc. Every other comment impostor here is
    // a single line, so a stripper that stopped at the first line still passed.
    'a multi-line JSDoc': {
      before: [
        '  /**',
        '   * Formats a relative time.',
        "   * @param p - the namespace, e.g. 'home'",
        "   * @example rel('home')",
        '   */',
      ].join('\n'),
      call: 'suffix',
    },
    'a line comment': { before: "  // rel('home')", call: 'suffix' },
    'a block comment': { call: "/* rel('home') */ suffix" },
    'a string': { call: `"rel('home')"` },
    'a template literal': { call: "`rel('home')`" },
    'another call': { call: "navigate('home')" },
    'the wrong argument': { call: "rel(suffix, 'home')" },
  };
  for (const [label, shape] of Object.entries(impostors)) {
    const { status, output } = runGate(
      { ...homeCatalogue(JUST_NOW), 'packages/webview/src/App.tsx': tailApp(shape) },
      { tailPrefixes: ['home'] },
    );
    assert.ok(output.includes(UNCALLED), `${label}\n${output}`);
    assert.ok(output.includes('    - home\n'), `${label}\n${output}`);
    // Not a call, so not an exemption either: the key it would build is dead.
    assert.ok(output.includes('    - home.justNow'), `${label}\n${output}`);
    assert.equal(status, 1, label);
  }
});

test('a declared tail prefix that builds no catalogue key fails the run on its own', () => {
  // No fresh key in this fixture, so the exit code can only come from the
  // keyless check. The previous fixture also carried `zzDead.justNow`, whose
  // own failure kept this test green with that check cut off from the exit.
  const { status, output } = runGate(
    {
      ...homeCatalogue(JUST_NOW),
      'packages/webview/src/App.tsx': tailApp({ call: "rel('home'), rel('greeting')" }),
    },
    { tailPrefixes: ['home', 'greeting'] },
  );
  assert.ok(output.includes(NO_FRESH), output);
  assert.ok(!output.includes(UNCALLED), output);
  assert.ok(output.includes(`✗ dynamic tails: 1 declared prefix(es) build no en.json key`), output);
  assert.ok(output.includes('    - greeting (looked for greeting.justNow)'), output);
  assert.equal(status, 1);
});

test('a tail written only in a comment builds no exempt key', () => {
  const { status, output } = runGate(
    {
      ...homeCatalogue(JUST_NOW, ['hoursAgo', '{{count}} h ago', 'il y a {{count}} h']),
      'packages/webview/src/App.tsx': tailApp({
        before: '  // const hours = (p) => t(`${p}.hoursAgo`);',
      }),
    },
    { tailPrefixes: ['home'] },
  );
  assert.ok(output.includes('    - home.hoursAgo'), output);
  assert.ok(!output.includes('    - home.justNow'), output);
  assert.equal(status, 1);
});

test('a tail builder that lives in test code exempts nothing', () => {
  // A spec, and a helper directory no file name marks as a test: neither is a
  // construction site, so neither may mint the call that keeps a family alive.
  for (const file of ['App.test.tsx', 'test/helpers.ts', 'i18n/testing/bridge.ts']) {
    const { status, output } = runGate(
      {
        ...homeCatalogue(JUST_NOW, ['minutesAgo', '{{count}} min ago', 'il y a {{count}} min']),
        'packages/webview/src/App.tsx': tailApp(),
        [`packages/webview/src/${file}`]:
          "export const ago = (t, p) => t(`${p}.minutesAgo`, { count: 2 });\nago(t, 'home');\n",
      },
      { tailPrefixes: ['home'] },
    );
    assert.ok(output.includes('    - home.minutesAgo'), `${file}\n${output}`);
    assert.equal(status, 1, file);
  }
});

// --- section 6: a prefix is minted by a t() call, not by a dotted string ---

const navCatalogue = {
  [`${LOCALES}/en.json`]: JSON.stringify({ ...EN, nav: { forge: 'Forge' } }),
  [`${LOCALES}/fr.json`]: JSON.stringify({ ...fr(), nav: { forge: 'Forge' } }),
};

test('a prefix passed to a real t() call still exempts the keys it builds', () => {
  // The other direction of the prefix narrowing: anchoring on `t(` must not
  // start reporting the runtime-built keys it exists to protect.
  const shapes = {
    'a template': 't(`nav.${suffix}`)',
    'a concatenation': "t('nav.' + suffix)",
    'a call split over lines': 't(\n      `nav.${suffix}`,\n    )',
  };
  for (const [label, call] of Object.entries(shapes)) {
    const { status, output } = runGate({
      ...navCatalogue,
      'packages/webview/src/App.tsx': app(call),
    });
    assert.ok(output.includes(NO_FRESH), `${label}\n${output}`);
    assert.ok(!output.includes('nav.forge'), `${label}\n${output}`);
    assert.equal(status, 0, label);
  }
});

test('a dotted template outside a real t() call exempts nothing', () => {
  // A log line, a class name or a URL shaped like `status.${x}` is not a key
  // construction site, and neither is a t() call that only survives in a
  // comment or inside a string. Any of them used to retire `status.*` whole.
  const impostors = {
    'a log line': 'export const log = (kind) => console.log(`status.${kind} changed`);\n',
    'a bare template': 'export const cls = (kind) => `status.${kind}`;\n',
    'a concatenation': "export const url = (kind) => fetch('status.' + kind);\n",
    'a block comment': '/* t(`status.${kind}`) */\nexport const x = 1;\n',
    'a line comment': "// t('status.' + kind)\nexport const x = 1;\n",
    'a string': 'export const doc = "t(`status.${kind}`)";\n',
  };
  for (const [label, impostor] of Object.entries(impostors)) {
    const { status, output } = runGate({
      [`${LOCALES}/en.json`]: JSON.stringify({ ...EN, status: { dead: 'Retired status copy' } }),
      [`${LOCALES}/fr.json`]: JSON.stringify({ ...fr(), status: { dead: 'Statut retiré' } }),
      'packages/webview/src/impostor.ts': impostor,
    });
    assert.ok(output.includes('✗ 1 newly unreferenced key(s)'), `${label}\n${output}`);
    assert.ok(output.includes('    - status.dead'), `${label}\n${output}`);
    assert.equal(status, 1, label);
  }
});

// --- section 6: a mention is code, not a comment ----------------------------

test('a key named only in a comment is still unreferenced', () => {
  const commented = runGate({
    ...orphanCatalogue,
    'packages/webview/src/legacy.ts':
      "// t('orphan.old') went with the old banner\n/** @see orphan.old */\nexport const x = 1;\n",
  });
  assert.ok(commented.output.includes('✗ 1 newly unreferenced key(s)'), commented.output);
  assert.ok(commented.output.includes('    - orphan.old'), commented.output);
  assert.equal(commented.status, 1);

  // Comments are found by lexing, not by pattern: a `/*` inside a string opens
  // nothing, so the key named on the next line is still named.
  const quoted = runGate({
    ...orphanCatalogue,
    'packages/webview/src/legacy.ts':
      "export const glob = 'src/*.ts';\nexport const key = 'orphan.old';\nexport const end = '*/';\n",
  });
  assert.ok(quoted.output.includes(NO_FRESH), quoted.output);
  assert.equal(quoted.status, 0);
});
