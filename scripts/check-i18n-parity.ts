/**
 * i18n parity gate.
 *
 * Section 1 — webview locales: loads `packages/webview/src/i18n/locales/en.json`
 * as the reference, flattens its nested keys, and for every other locale reports:
 *
 *   - missing keys  (present in en.json, absent from the locale)
 *   - orphan keys   (present in the locale, absent from en.json)
 *
 * Section 2 — extension manifest: loads `packages/extension/package.nls.json`
 * as the reference and applies the same missing/orphan check to every
 * `package.nls.*.json` locale file (flat key-value maps, no plural handling).
 *
 * Section 3 — code vs catalogue (blocking): parity between six files proves
 * nothing about the seventh party, the source. Three ways a string escapes the
 * catalogue entirely: a hardcoded `aria-label="…"` (invisible to sighted
 * reviewers AND to the translator), a `t('k')` whose key no locale defines (the
 * raw key renders), and an inline `t('k', 'English')` default for such a key —
 * the default renders in all six languages, so the gap never surfaces as a
 * missing translation.
 *
 * Section 4 — values byte-identical to English (report only), restricted to
 * multi-word values: a lone token shared with English is usually a proper noun,
 * an acronym or a unit, whereas a sentence is untranslated copy. The legitimate
 * multi-word cases live in `scripts/i18n-identical-allowlist.json`.
 *
 * Section 5 — French accents (report only). French written without accents
 * passes every structural check while reading as broken to a French user.
 *
 * Section 6 — catalogue vs code (blocking). Keys no source file mentions. It
 * reads the whole monorepo, tests included (`KEY_REFERENCE_ROOTS`), because a
 * key's only literal often lives in `packages/extension` or `packages/shared`
 * and reaches `t()` through a variable. Runtime-built keys are exempted from
 * both ends: by prefix for `t(`a.b.${x}`)`, by tail for `t(`${p}.justNow`)`.
 * The baseline of tolerated entries is empty and is a ratchet: it may only
 * shrink, and an entry that stops being an unreferenced catalogue key fails the
 * run until it is deleted from it.
 *
 * Plural handling (webview only): i18next (Intl.PluralRules) only has the
 * `other` category for Japanese, so `*_one` keys are not required in
 * `ja.json`. Every other supported locale (fr, de, es, pt-BR) has a `one`
 * category like English.
 *
 * Output is deterministic (keys sorted). Exits 1 when any locale drifts
 * from the reference; pass `--report` to print the report without failing.
 *
 * Run with:  pnpm check:i18n
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const WEBVIEW_LOCALES_DIR = join(__dirname, '..', 'packages', 'webview', 'src', 'i18n', 'locales');
const WEBVIEW_REFERENCE = 'en.json';

const EXTENSION_DIR = join(__dirname, '..', 'packages', 'extension');
const MANIFEST_REFERENCE = 'package.nls.json';

const WEBVIEW_SRC = join(__dirname, '..', 'packages', 'webview', 'src');
const IDENTICAL_ALLOWLIST = join(__dirname, 'i18n-identical-allowlist.json');

/** Locales whose i18next plural rules have no `one` category (Intl.PluralRules). */
const NO_ONE_CATEGORY = new Set(['ja']);

type JsonObject = Record<string, unknown>;

/** Flatten a nested locale object into `a.b.c` -> string leaf entries. */
function flatten(
  obj: JsonObject,
  prefix = '',
  out = new Map<string, string>(),
): Map<string, string> {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value as JsonObject, path, out);
    } else if (typeof value === 'string') {
      out.set(path, value);
    }
  }
  return out;
}

function loadLocale(dir: string, file: string): Map<string, string> {
  const text = readFileSync(join(dir, file), 'utf8');
  return flatten(JSON.parse(text) as JsonObject);
}

/**
 * Compare every locale file in `dir` against `referenceFile`.
 * Returns true when at least one locale drifts from the reference.
 */
function checkParity(options: {
  dir: string;
  referenceFile: string;
  header: string;
  /** Extra filter for candidate locale files (beyond `.json` and not the reference). */
  localeFilePattern?: RegExp;
  /** Drop `*_one` keys from the expected set for these locales (i18next plural rules). */
  noOneCategory?: Set<string>;
}): boolean {
  const { dir, referenceFile, header, localeFilePattern, noOneCategory } = options;

  const reference = loadLocale(dir, referenceFile);
  const referenceKeys = [...reference.keys()];

  const localeFiles = readdirSync(dir)
    .filter(
      (f) =>
        f.endsWith('.json') &&
        f !== referenceFile &&
        (localeFilePattern === undefined || localeFilePattern.test(f)),
    )
    .sort();

  let hasDrift = false;

  console.log(`${header} — reference ${referenceFile}: ${referenceKeys.length} keys\n`);

  for (const file of localeFiles) {
    const locale = file.replace(/\.json$/, '').replace(/^package\.nls\./, '');
    const keys = loadLocale(dir, file);

    // *_one plural keys are only required for locales with a `one` category.
    const expected =
      noOneCategory?.has(locale) === true
        ? referenceKeys.filter((k) => !k.endsWith('_one'))
        : referenceKeys;

    const missing = expected.filter((k) => !keys.has(k)).sort();
    const orphan = [...keys.keys()].filter((k) => !reference.has(k)).sort();

    const coverage = (((expected.length - missing.length) / expected.length) * 100).toFixed(1);

    if (missing.length === 0 && orphan.length === 0) {
      console.log(`✓ ${locale}: ${expected.length}/${expected.length} keys (100%)`);
      continue;
    }

    hasDrift = true;
    console.log(
      `✗ ${locale}: ${expected.length - missing.length}/${expected.length} keys (${coverage}%)`,
    );
    if (missing.length > 0) {
      console.log(`  missing (${missing.length}):`);
      for (const k of missing) console.log(`    - ${k}`);
    }
    if (orphan.length > 0) {
      console.log(`  orphan (${orphan.length}):`);
      for (const k of orphan) console.log(`    - ${k}`);
    }
  }

  return hasDrift;
}

/** Every non-test source file under `packages/webview/src`. */
function webviewSources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) webviewSources(full, acc);
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) acc.push(full);
  }
  return acc;
}

/**
 * Every file in the monorepo that can name a catalogue key — section 6 only.
 *
 * That section used to read `webviewSources`, i.e. `packages/webview/src`
 * minus its tests. Three reference paths fell outside that window, and each
 * one of them put a live key in the baseline:
 *
 *   - `packages/extension/src` builds keys the webview renders through
 *     `t(variable)`. `SmartActionAnalyzer` assigns `home.smartAction.reason*`
 *     and `SmartActionCard` renders `t(recommendation.reasonKey)`;
 *     `errorClassifier` assigns `ai.error.cancelled` and
 *     `AIProviderStatusBanner` renders it. Neither key exists as a literal in
 *     any webview source.
 *   - `packages/shared/src` carries the prebuilt catalogues. `seed-templates`
 *     and `sync-templates` store `seed.templates.*` / `sync.templates.*` in
 *     `name`/`nameKey` fields that `TemplateCard` hands straight to `t()`.
 *   - a key whose only mention is a test is still a key a source file
 *     mentions; deleting it reds the suite rather than the UI, which is the
 *     same signal arriving one layer earlier.
 *
 * Locale JSON is deliberately not in the walk: a catalogue that counts as its
 * own consumer makes every key referenced and the section vacuous.
 */
const KEY_REFERENCE_ROOTS = [
  join(__dirname, '..', 'packages', 'shared', 'src'),
  join(__dirname, '..', 'packages', 'extension', 'src'),
  join(__dirname, '..', 'packages', 'webview', 'src'),
  join(__dirname, '..', 'packages', 'webview', 'e2e'),
];

function referenceSources(dir: string, acc: string[] = []): string[] {
  // A root a checkout does not have contributes no references, it does not
  // crash the run: the gate's own fixture repos carry the webview alone.
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) referenceSources(full, acc);
    else if (/\.tsx?$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

/** `a.b` resolves if the key exists, or if its plural variants do. */
function resolves(key: string, reference: Map<string, string>): boolean {
  if (reference.has(key)) return true;
  return ['zero', 'one', 'two', 'few', 'many', 'other'].some((c) => reference.has(`${key}_${c}`));
}

/**
 * Every `t('a.b')` whose literal is the *complete* first argument. The trailing
 * `[),]` is what rules out `t('a.b.' + type)` and `` t(`a.b.${type}`) ``: those
 * literals are prefixes, and the key only exists once the component renders —
 * section 6 covers them by prefix instead.
 */
const LITERAL_KEY = /\bt\(\s*'([a-zA-Z0-9_.]+)'\s*[),]/g;

/** The same call with an English fallback: `t('k', 'Default')` / `{ defaultValue }`. */
const LITERAL_DEFAULT = /\bt\(\s*'([a-zA-Z0-9_.]+)'\s*,\s*(?:'|")/g;
const OPTION_DEFAULT = /\bt\(\s*'([a-zA-Z0-9_.]+)'\s*,\s*\{[^}]*defaultValue\s*:/g;

/** Every key captured by `pattern` in `source`, deduplicated. */
function matchedKeys(pattern: RegExp, source: string): Set<string> {
  const keys = new Set<string>();
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) keys.add(match[1]);
  return keys;
}

/**
 * Section 3 — the three ways a user-visible string bypasses the catalogue.
 * Returns true when at least one violation was found.
 */
function checkSources(reference: Map<string, string>): boolean {
  const files = webviewSources(WEBVIEW_SRC);
  const hardcodedLabels: string[] = [];
  const unresolvedKeys: string[] = [];
  const unbackedDefaults: string[] = [];

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const label = relative(WEBVIEW_SRC, file).replace(/\\/g, '/');

    if (file.endsWith('.tsx')) {
      const lines = source.split('\n');
      lines.forEach((line, i) => {
        if (line.includes('aria-label="')) hardcodedLabels.push(`${label}:${i + 1}`);
      });
    }

    const withDefault = new Set([
      ...matchedKeys(LITERAL_DEFAULT, source),
      ...matchedKeys(OPTION_DEFAULT, source),
    ]);

    for (const key of matchedKeys(LITERAL_KEY, source)) {
      // A dotless literal is a namespace or a sentinel, never a catalogue path.
      if (!key.includes('.') || resolves(key, reference)) continue;
      const site = `${key} (${label})`;
      if (withDefault.has(key)) unbackedDefaults.push(site);
      else unresolvedKeys.push(site);
    }
  }

  console.log(`i18n source scan — ${files.length} files\n`);

  if (hardcodedLabels.length === 0) {
    console.log('✓ aria-label: every accessible name goes through t()');
  } else {
    console.log(`✗ aria-label: ${hardcodedLabels.length} hardcoded English literal(s):`);
    for (const l of [...new Set(hardcodedLabels)].sort()) console.log(`    - ${l}`);
  }

  const unresolved = [...new Set(unresolvedKeys)].sort();
  if (unresolved.length === 0) {
    console.log('✓ t() keys: every literal key resolves against en.json');
  } else {
    console.log(`✗ t() keys: ${unresolved.length} key(s) absent from en.json (renders raw):`);
    for (const k of unresolved) console.log(`    - ${k}`);
  }

  const unbacked = [...new Set(unbackedDefaults)].sort();
  if (unbacked.length === 0) {
    console.log('✓ inline defaults: every t() default is backed by an en.json entry');
  } else {
    console.log(`✗ inline defaults: ${unbacked.length} key(s) absent from en.json:`);
    for (const k of unbacked) console.log(`    - ${k}`);
  }

  return hardcodedLabels.length > 0 || unresolved.length > 0 || unbacked.length > 0;
}

/**
 * Prose, as opposed to a token. A lone word shared with English — "Total",
 * "Import", an acronym, a bare `{{count}}` — is common enough across languages
 * that flagging it would drown the signal in false positives; a sentence that
 * came back from translation byte-for-byte did not come back by coincidence.
 */
function isProse(value: string): boolean {
  return value.trim().split(/\s+/).length > 1;
}

/**
 * Section 4 — non-EN prose byte-identical to the English one.
 *
 * Blocking since v1.19.0. It was report-only, which meant a release could ship
 * with prose that had never been translated and nothing stopped it: the count
 * sat at 14 while the product advertised six languages. Now that the list is
 * empty, blocking costs nothing and keeps it that way — a value that is
 * genuinely identical in another language ("Type incompatible" in French) goes
 * in `i18n-identical-allowlist.json` as a decision, not as a silent tolerance.
 *
 * @returns The number of offending keys — non-zero fails the run.
 */
function reportIdenticalValues(reference: Map<string, string>): number {
  const allowlist = new Set<string>(
    (JSON.parse(readFileSync(IDENTICAL_ALLOWLIST, 'utf8')) as { keys: string[] }).keys,
  );

  const perKey = new Map<string, string[]>();
  for (const file of readdirSync(WEBVIEW_LOCALES_DIR).sort()) {
    if (!file.endsWith('.json') || file === WEBVIEW_REFERENCE) continue;
    const locale = file.replace(/\.json$/, '');
    for (const [key, value] of loadLocale(WEBVIEW_LOCALES_DIR, file)) {
      if (allowlist.has(key) || reference.get(key) !== value || !isProse(value)) continue;
      if (!perKey.has(key)) perKey.set(key, []);
      perKey.get(key)?.push(locale);
    }
  }

  if (perKey.size === 0) {
    console.log('✓ identical-to-English: no untranslated prose outside the allowlist');
    return 0;
  }
  console.log(`✗ identical-to-English: ${perKey.size} value(s) still carrying the English copy:`);
  for (const key of [...perKey.keys()].sort()) {
    console.log(`    - ${key} [${perKey.get(key)?.join(', ')}]`);
  }
  console.log(
    '    Translate them, or add the ones that are legitimately identical to ' +
      'scripts/i18n-identical-allowlist.json.',
  );
  return perKey.size;
}

/**
 * Section 5 — French values spelled without their accents. Report only: the
 * word list is a heuristic, and a false positive must not block a release.
 */
const FRENCH_UNACCENTED =
  /\b(Termine|Cree|Donnees|Parametre|Selectionn|execution|operation|Echec|reussi|genere|requete|deja|apres|securite|defaut|Modele|Delai|Etape|etape|Executer|qualite|Duree|Apercu|regles?|Resultat|dependance)\b/;

function reportFrenchAccents(): void {
  const offenders: string[] = [];
  for (const [key, value] of loadLocale(WEBVIEW_LOCALES_DIR, 'fr.json')) {
    const hit = FRENCH_UNACCENTED.exec(value);
    if (hit) offenders.push(`${key} — "${hit[1]}"`);
  }
  if (offenders.length === 0) {
    console.log('✓ French accents: no unaccented form from the watch list');
    return;
  }
  console.log(`! French accents: ${offenders.length} value(s) missing an accent:`);
  for (const o of offenders.sort()) console.log(`    - ${o}`);
}

/**
 * Baseline for section 6: keys section 6 tolerates as unreferenced. Empty since
 * 2026-09-10, and meant to stay that way — an unreferenced key is now deleted,
 * not written down.
 *
 * It held 586 entries, and 555 of them were genuinely dead copy: deleted from
 * all six locales, ~3 300 strings out of every VSIX. The other 31 were never
 * dead. They were invisible to the sweep, which read `packages/webview/src`
 * minus its tests and matched whole literals:
 *
 *   - 16 keys whose literal lives in `packages/extension/src` or
 *     `packages/shared/src` and reaches `t()` through a variable
 *     (`t(recommendation.reasonKey)`, `t(item.name)`);
 *   - 6 built tail-first by `t(`${keyPrefix}.justNow`)` in `formatters.ts`,
 *     spelled out by no file at all;
 *   - 9 named only by a spec, which is still a source file naming them.
 *
 * `KEY_REFERENCE_ROOTS` and `dynamicSuffixes` in `findUnreferencedKeys` close
 * all three holes, so those 31 now resolve as referenced and need no entry.
 *
 * An entry, should one ever be added, earns its place by being unreferenced
 * *and* defined in en.json. The moment either stops holding — a consumer comes
 * back, the key leaves the catalogue — `auditBaseline` fails the run until the
 * entry is deleted from here. A list nobody can leave is a list that stops
 * describing anything.
 */
const UNREFERENCED_BASELINE: readonly string[] = [];

/**
 * Where the number stood, and when. `count` is an upper bound the run enforces:
 * the list may fall below it without anyone doing anything, but growing past it
 * means editing this number and the date beside it, in a diff a reviewer reads.
 * Lower both when you delete entries, so the next person can tell at a glance
 * whether the figure is going down. It read 590 on 2026-08-13, the day the
 * section landed and was neutralised in the same commit; 587 on 2026-09-09; 0
 * on 2026-09-10, which pins the ratchet shut — any new entry now trips it.
 */
const BASELINE_CENSUS = { recorded: '2026-09-10', count: 0 } as const;

/**
 * Section 6 — catalogue entries no source file mentions.
 * Returns the keys that are unreferenced and not in the baseline.
 */
function findUnreferencedKeys(reference: Map<string, string>): {
  unreferenced: string[];
  fresh: string[];
} {
  const sources = KEY_REFERENCE_ROOTS.flatMap((root) => referenceSources(root)).map((f) =>
    readFileSync(f, 'utf8'),
  );

  /*
   * Keys built at runtime — `t(`forge.anonCategory.${cat}`)`, `t('nav.' + id)` —
   * never appear whole in the source. Collect their prefixes first; without
   * this step the sweep reports (and a later cleanup deletes) live keys.
   */
  const dynamicPrefixes = new Set<string>();
  const templatePrefix = /['"`]([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*\.)\$\{/g;
  const concatPrefix = /['"]([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*\.)['"]\s*\+/g;
  for (const source of sources) {
    for (const pattern of [templatePrefix, concatPrefix]) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source)) !== null) dynamicPrefixes.add(match[1]);
    }
  }

  /*
   * The mirror image: `t(`${keyPrefix}.justNow`)`, where the variable comes
   * FIRST and only the tail is literal. `formatRelativeTimeI18n` is called with
   * `'home'` and with `'sidePanel.relativeTime'`, so six live keys exist that
   * no source file spells out — and the prefix sweep above, which needs a
   * literal before the `${`, sees none of them. They sat in the baseline as
   * dead until this pass; deleting them would have printed `home.justNow` on
   * the Home page and in the side panel. Matching is restricted to the tail of
   * a `t()` template so that `${x}.json` and `${x}.png` exempt nothing.
   */
  const dynamicSuffixes = new Set<string>();
  const templateSuffix = /\bt\(\s*`\$\{[^`]*?\}((?:\.[a-zA-Z0-9_]+)+)`/g;
  for (const source of sources) {
    templateSuffix.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = templateSuffix.exec(source)) !== null) dynamicSuffixes.add(match[1]);
  }

  const unreferenced: string[] = [];
  for (const key of reference.keys()) {
    const base = key.replace(/_(zero|one|two|few|many|other)$/, '');
    if ([...dynamicPrefixes].some((p) => base.startsWith(p))) continue;
    if ([...dynamicSuffixes].some((t) => base.endsWith(t))) continue;
    if (sources.some((s) => s.includes(base))) continue;
    unreferenced.push(key);
  }
  unreferenced.sort();

  const baseline = new Set(UNREFERENCED_BASELINE);
  return { unreferenced, fresh: unreferenced.filter((k) => !baseline.has(k)) };
}

/**
 * The ratchet on that baseline. Three ways it stops telling the truth, all of
 * them blocking:
 *
 *   - an entry referenced again — the DEADCODE-08 mechanism, where a key that
 *     merely lost its consumer for the length of a purge was written down as
 *     dead instead of being left to come back;
 *   - an entry en.json no longer defines, which suppresses nothing and only
 *     inflates the count;
 *   - a list longer than the census it was last counted at, i.e. an append.
 *
 * Nothing here rewrites the list — a source file that edits itself is worse
 * than the debt — so the run names the offenders and fails until they are gone.
 * The suppression itself is computed live, so a stale entry stops excusing
 * anything the moment it goes stale, whether or not anyone deletes the line.
 */
function auditBaseline(reference: Map<string, string>, unreferenced: string[]): boolean {
  const stillUnreferenced = new Set(unreferenced);
  const revived = UNREFERENCED_BASELINE.filter(
    (k) => reference.has(k) && !stillUnreferenced.has(k),
  ).sort();
  const dropped = UNREFERENCED_BASELINE.filter((k) => !reference.has(k)).sort();
  const removedSince = BASELINE_CENSUS.count - UNREFERENCED_BASELINE.length;

  console.log(
    `baseline census — ${BASELINE_CENSUS.count} entries recorded ${BASELINE_CENSUS.recorded}, ` +
      `${UNREFERENCED_BASELINE.length} listed today (${removedSince} removed since)`,
  );

  if (revived.length > 0) {
    console.log(
      `✗ baseline: ${revived.length} entry(ies) referenced again — delete them from UNREFERENCED_BASELINE:`,
    );
    for (const k of revived) console.log(`    - ${k}`);
  }
  if (dropped.length > 0) {
    console.log(
      `✗ baseline: ${dropped.length} entry(ies) absent from ${WEBVIEW_REFERENCE} — delete them from UNREFERENCED_BASELINE:`,
    );
    for (const k of dropped) console.log(`    - ${k}`);
  }
  if (removedSince < 0) {
    console.log(
      `✗ baseline: ${UNREFERENCED_BASELINE.length} entries against ${BASELINE_CENSUS.count} recorded ` +
        `${BASELINE_CENSUS.recorded} — the baseline may shrink, never grow.`,
    );
  }
  if (revived.length === 0 && dropped.length === 0 && removedSince >= 0) {
    console.log('✓ baseline: every entry is still an unreferenced key of the catalogue');
  }

  return revived.length > 0 || dropped.length > 0 || removedSince < 0;
}

const reportOnly = process.argv.includes('--report');

const webviewDrift = checkParity({
  dir: WEBVIEW_LOCALES_DIR,
  referenceFile: WEBVIEW_REFERENCE,
  header: 'i18n parity (webview)',
  noOneCategory: NO_ONE_CATEGORY,
});

console.log('');

const manifestDrift = checkParity({
  dir: EXTENSION_DIR,
  referenceFile: MANIFEST_REFERENCE,
  header: 'i18n parity (extension manifest)',
  localeFilePattern: /^package\.nls\..+\.json$/,
});

console.log('');

const englishCatalogue = loadLocale(WEBVIEW_LOCALES_DIR, WEBVIEW_REFERENCE);
const sourceDrift = checkSources(englishCatalogue);

console.log('');
const identicalCount = reportIdenticalValues(englishCatalogue);

console.log('');
reportFrenchAccents();

console.log('');
const { unreferenced, fresh } = findUnreferencedKeys(englishCatalogue);
console.log(
  `unreferenced keys — ${unreferenced.length} of ${englishCatalogue.size} (${UNREFERENCED_BASELINE.length} allowlisted as the baseline)`,
);
if (fresh.length === 0) {
  console.log('✓ no key added since the baseline is unreferenced');
} else {
  console.log(`✗ ${fresh.length} newly unreferenced key(s):`);
  for (const k of fresh) console.log(`    - ${k}`);
}

console.log('');
const baselineDrift = auditBaseline(englishCatalogue, unreferenced);

const hasDrift =
  webviewDrift ||
  manifestDrift ||
  sourceDrift ||
  fresh.length > 0 ||
  identicalCount > 0 ||
  baselineDrift;

if (hasDrift && !reportOnly) {
  console.error('\ni18n parity check FAILED — run with --report for details without failing.');
  process.exit(1);
}

console.log(
  hasDrift
    ? '\ni18n parity check reported drift (--report mode, not failing).'
    : '\nAll locales at 100% parity.',
);
