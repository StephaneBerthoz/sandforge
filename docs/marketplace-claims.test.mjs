/**
 * Gate for the surfaces a buyer reads before installing: the extension
 * manifest, the two READMEs, and the DataOps module page.
 *
 * The sibling gates (`product-claims.test.mjs`,
 * `automation-scheduler-claims.test.mjs`) pin prose that outran the code. This
 * one pins the opposite failures found in the same review — prose and manifest
 * that lag the code, plus manifest entries that ship broken to the user:
 *
 *   MKT-04  `sandforge.openOrgInBrowser` was in the Command Palette with a
 *           100% failure rate: it needs an org id the palette cannot supply.
 *   MKT-09  `capabilities.untrustedWorkspaces` had no `description`, so VS Code
 *           disabled the extension in a restricted workspace without saying why.
 *   FR-08   the three `sandforge.grappe.*` descriptions were raw English inside
 *           a fully localized Settings block.
 *   FR-05   the Get Started walkthrough had four steps and no action button.
 *   VSIX-01 the bundle carried a `sourceMappingURL` to a map `.vscodeignore`
 *           excludes, so every load looked for a file that is not in the VSIX.
 *   MKT-05  the listing buys the "sfdmu" and "data loader" keywords and never
 *           answered "why switch".
 *   MKT-06  DataOps Restore ships since v1.18.0 and the docs still called it
 *   /MKT-10 unbuilt.
 *
 * FR-08 also moves the Grappe wording out of `package.json` and into the six
 * `package.nls.*` files, which `product-claims.test.mjs` does not read. The
 * honesty checks it applied to the manifest are re-applied here to the resolved
 * locale values, so localizing the setting does not buy Grappe an exemption.
 *
 *   node --test docs/marketplace-claims.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const docsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(docsDir, '..');
const read = (...p) => readFileSync(join(repoRoot, ...p), 'utf8');
const readJson = (...p) => JSON.parse(read(...p));

const EXT = ['packages', 'extension'];
const manifest = () => readJson(...EXT, 'package.json');

/** The six manifest locale bundles, as `locale → flat key/value map`. */
const NLS_FILES = {
  en: 'package.nls.json',
  fr: 'package.nls.fr.json',
  de: 'package.nls.de.json',
  es: 'package.nls.es.json',
  ja: 'package.nls.ja.json',
  'pt-br': 'package.nls.pt-br.json',
};
const bundles = () =>
  Object.fromEntries(Object.entries(NLS_FILES).map(([l, f]) => [l, readJson(...EXT, f)]));

/** `%key%` → the value each locale gives it. Throws if any locale lacks it. */
function resolveNls(placeholder) {
  const key = /^%(.+)%$/.exec(placeholder)?.[1];
  assert.ok(key, `not a localization placeholder: ${JSON.stringify(placeholder)}`);
  const out = {};
  for (const [locale, bundle] of Object.entries(bundles())) {
    const value = bundle[key];
    assert.equal(
      typeof value,
      'string',
      `${NLS_FILES[locale]} has no entry for "${key}" — the manifest renders the raw %key%`,
    );
    out[locale] = value;
  }
  return out;
}

// ── MKT-04: a palette command that cannot succeed ─────────────────────────

test('anchor: openOrgInBrowser still needs an org id the palette cannot give', () => {
  const src = read(...EXT, 'src', 'extension.ts');
  assert.match(
    src,
    /'sandforge\.openOrgInBrowser',\s*\(orgId\?: string\) => \{/,
    'the command signature changed — if it can now pick an org itself, it may go back into the ' +
      'Command Palette and this guard should be re-read, not deleted blindly',
  );
});

test('openOrgInBrowser is hidden from the Command Palette', () => {
  const entries = manifest().contributes?.menus?.commandPalette ?? [];
  const entry = entries.find((e) => e.command === 'sandforge.openOrgInBrowser');
  assert.ok(
    entry,
    'sandforge.openOrgInBrowser is listed in the palette, where its org id is undefined and the ' +
      'only possible outcome is "pick an org in the launcher dropdown first"',
  );
  assert.equal(entry.when, 'false', 'the palette entry must be suppressed unconditionally');
});

// ── MKT-09: Restricted Mode with no explanation ───────────────────────────

test('untrustedWorkspaces says why the extension is disabled, in six languages', () => {
  const untrusted = manifest().capabilities?.untrustedWorkspaces;
  assert.equal(untrusted?.supported, false, 'the capability declaration moved — re-read this gate');
  assert.ok(
    typeof untrusted.description === 'string' && untrusted.description.length > 0,
    'VS Code shows this line in the Restricted Mode panel; without it a consultant opening an ' +
      'untrusted client repo sees the extension disabled with no reason given',
  );
  for (const [locale, text] of Object.entries(resolveNls(untrusted.description))) {
    assert.ok(text.trim().length > 20, `${locale}: the restricted-mode reason is not a sentence`);
  }
});

// ── FR-08: the Grappe settings were the only untranslated block ───────────

const GRAPPE_KEYS = [
  'sandforge.grappe.enabled',
  'sandforge.grappe.autoActivateThreshold',
  'sandforge.grappe.grappeSize',
];

test('every sandforge.grappe.* description is localized', () => {
  const props = manifest().contributes?.configuration?.properties ?? {};
  for (const key of GRAPPE_KEYS) {
    const description = props[key]?.description;
    assert.ok(description, `${key} has no description`);
    assert.match(
      description,
      /^%[\w.]+%$/,
      `${key} carries raw English inside a Settings block where every other line is translated`,
    );
    resolveNls(description); // throws unless all six locales define it
  }
});

test('localizing Grappe did not smuggle the claims product-claims.test.mjs bans', () => {
  // That gate reads `properties[...].description` straight out of the manifest;
  // a `%key%` is opaque to it, so the same two assertions are re-run here
  // against what the six locales actually say. Same anchor, same direction.
  const orchestrator = read(...EXT, 'src', 'modules', 'autopilot', 'AutopilotOrchestrator.ts');
  assert.doesNotMatch(
    orchestrator,
    /grappeAdapter\s*\.\s*partition\s*\(/,
    'Grappe may really partition work now — re-read the six locale descriptions before relaxing',
  );
  assert.match(orchestrator, /grappeActive/, 'nothing activates Grappe any more');

  const props = manifest().contributes?.configuration?.properties ?? {};
  const offenders = [];
  for (const key of GRAPPE_KEYS) {
    for (const [locale, text] of Object.entries(resolveNls(props[key].description))) {
      // "parallel" is the one word that cannot be used while `grappeActive`
      // only wraps a sequential loop in two progress events.
      if (/\bparall[eèa]l|並列/i.test(text)) offenders.push(`${locale} ${key}: ${text}`);
      if (/no operation activates|aucune opération ne l/i.test(text)) {
        offenders.push(`${locale} ${key}: ${text}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'these locale strings resell Grappe as parallel execution:\n  ' + offenders.join('\n  '),
  );
});

// ── FR-05: a walkthrough with no buttons ──────────────────────────────────

test('every Get Started step offers a command button, in six languages', () => {
  const m = manifest();
  const walkthrough = (m.contributes?.walkthroughs ?? []).find(
    (w) => w.id === 'sandforge.gettingStarted',
  );
  assert.ok(walkthrough, 'the gettingStarted walkthrough is gone — re-read this gate');
  assert.equal(walkthrough.steps.length, 4, 'step count changed; every step still needs a button');

  const declared = new Set((m.contributes?.commands ?? []).map((c) => c.command));
  const offenders = [];
  for (const step of walkthrough.steps) {
    for (const [locale, text] of Object.entries(resolveNls(step.description))) {
      const links = [...text.matchAll(/\]\(command:([\w.]+)\)/g)].map((mm) => mm[1]);
      if (links.length === 0) {
        offenders.push(`${locale} ${step.id}: no command: link, so VS Code renders no button`);
        continue;
      }
      for (const command of links) {
        if (!declared.has(command))
          offenders.push(`${locale} ${step.id}: unknown command ${command}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'walkthrough steps without a working button:\n  ' + offenders.join('\n  '),
  );
});

// ── VSIX-01: a sourceMappingURL to a file the VSIX does not contain ───────

test('the bundle does not point at a source map the VSIX excludes', () => {
  const excludesMaps = /^\*\*\/\*\.map$/m.test(read(...EXT, '.vscodeignore'));
  assert.ok(
    excludesMaps,
    '.vscodeignore no longer excludes **/*.map — ship the maps and this constraint disappears',
  );
  const build = manifest().scripts.build;
  assert.doesNotMatch(
    build,
    /--sourcemap(?=\s|$)/,
    'a bare --sourcemap appends `//# sourceMappingURL=extension.js.map` to the bundle, and the ' +
      'map is not packaged: every load of the extension hunts for a file that is not there. Use ' +
      '--sourcemap=external (map on disk, no comment) or drop the flag.',
  );
});

// ── MKT-05: the listing never answered "why switch" ───────────────────────

const READMES = ['README.md', 'packages/extension/README.md'];

/** The block between the pitch and the quick start, in either README. */
function whySwitch(relPath) {
  const text = readFileSync(join(repoRoot, relPath), 'utf8');
  const start = text.search(/^## Why switch from SFDMU or Data Loader\?$/m);
  assert.notEqual(
    start,
    -1,
    `${relPath} buys the "sfdmu" and "data loader" keywords in package.json and never answers ` +
      'why a reader should switch',
  );
  const quickStart = text.indexOf('## Your first clone in 2 minutes');
  assert.ok(
    start < quickStart,
    `${relPath}: the answer must come before the quick start, where the scanner still is`,
  );
  return text.slice(start, quickStart);
}

test('both READMEs answer "why switch", with the same four claims', () => {
  const blocks = READMES.map((p) => [p, whySwitch(p)]);
  for (const [relPath, block] of blocks) {
    assert.match(block, /no config file/i, `${relPath}: the config-file claim is missing`);
    assert.match(block, /BFS|breadth-first/i, `${relPath}: say how discovery replaces the config`);
    assert.match(block, /remap/i, `${relPath}: ID remapping is the second half of that claim`);
    assert.match(block, /Production Guard/, `${relPath}: the default-on guardrail is missing`);
    assert.match(block, /export\.json/, `${relPath}: say the existing SFDMU config still works`);
  }
  assert.equal(
    blocks[0][1].trim(),
    blocks[1][1].trim(),
    'the Marketplace README and the GitHub README must make the same promise word for word',
  );
});

test('the CSV claim says optional, never absent', () => {
  // Seed and Migration both advertise CSV import further down the same page;
  // "no CSV" would contradict the module table two screens below.
  for (const relPath of READMES) {
    const block = whySwitch(relPath);
    assert.match(
      block,
      /mandatory CSV round-trip|CSV round-trip.*optional/i,
      `${relPath}: qualify the CSV claim — the round-trip is optional, the import is not absent`,
    );
    assert.match(
      block,
      /CSV import is still there/i,
      `${relPath}: the same page advertises CSV import twice below; do not deny it here`,
    );
  }
});

test('the SFDMU FAQ answer keeps the search term and answers the question', () => {
  const faq = read('packages', 'extension', 'README.md')
    .split('\n')
    .find((line) => /SFDMU replacement/.test(line));
  assert.ok(faq, 'the "SFDMU replacement" phrasing is what the searcher scans for — keep it');
  assert.match(
    faq,
    /\byes\b/i,
    'the answer described the Migration module instead of answering; take a position',
  );
  assert.match(
    faq,
    /SFDMU keeps the edge|SFDMU (?:still )?(?:wins|is better)/i,
    'an answer that claims everything answers nothing — name what SFDMU still does better',
  );
});

// ── MKT-06 / MKT-10: Restore shipped, the docs did not notice ─────────────

test('anchor: DataOps Restore is wired end to end', () => {
  const handler = read(...EXT, 'src', 'bridge', 'handlers', 'DataOpsHandler.ts');
  assert.match(
    handler,
    /partitionWritableFields\(/,
    'the field-by-field CRUD/FLS split is gone — restore may be refusing every object again, and ' +
      'the docs below would have to go back to "coming soon"',
  );
  const page = read('packages', 'webview', 'src', 'pages', 'DataOps', 'DataOpsPage.tsx');
  // `[^(]*` rather than `[^>]*`: the type argument is itself generic
  // (`Record<string, unknown>`), so stopping at the first `>` matches nothing.
  assert.match(
    page,
    /useBridgeMutation<[^(]*\(\s*'dataops:rollback'/,
    'the Restore tab sends nothing',
  );
  assert.match(page, /useBridgeQuery<[^(]*\(\s*'backup:list'/, 'the backup list is not loaded');
});

test('no surface still calls DataOps Restore unbuilt', () => {
  const surfaces = {
    'docs/modules/dataops.md': read('docs', 'modules', 'dataops.md'),
    ...Object.fromEntries(READMES.map((p) => [p, read(...p.split('/'))])),
  };
  // A line may legitimately name Restore next to a coming-soon caveat about
  // Compliance or Quality. What is banned is Restore *inside* the caveat, so
  // the check reads the parenthetical, not the whole line.
  const offenders = [];
  for (const [label, text] of Object.entries(surfaces)) {
    for (const line of text.split('\n')) {
      for (const [, inside] of line.matchAll(/\(([^)]*)\)/g)) {
        if (/\brestore/i.test(inside) && /coming soon|not (?:yet )?wired/i.test(inside)) {
          offenders.push(`${label}: (${inside.trim().slice(0, 120)})`);
        }
      }
      if (/only Backup and Anonymize are wired/i.test(line)) {
        offenders.push(`${label}: ${line.trim().slice(0, 140)}`);
      }
    }
  }
  // The Restore section of the module page is where the claim was loudest.
  const dataops = surfaces['docs/modules/dataops.md'];
  const restoreSection = dataops.slice(
    dataops.indexOf('### Restore'),
    dataops.indexOf('### Anonymize'),
  );
  assert.ok(restoreSection.length > 0, 'the Restore section is gone from docs/modules/dataops.md');
  if (/coming soon/i.test(restoreSection)) {
    offenders.push(
      'docs/modules/dataops.md: the ### Restore section still carries a coming-soon banner',
    );
  }
  assert.deepEqual(
    offenders,
    [],
    'Restore has worked since v1.18.0; these lines still sell it as unbuilt:\n  ' +
      offenders.join('\n  '),
  );
});
