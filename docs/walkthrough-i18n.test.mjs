/**
 * FR-04 — the Get Started walkthrough spoke English only.
 *
 * The manifest strings around the four steps were translated six ways
 * (`package.nls.*.json`, pinned by `marketplace-claims.test.mjs`), but the
 * markdown *bodies* the steps render — `walkthrough/*.md` — existed in English
 * and nowhere else. A German or Japanese user opened the onboarding page and
 * read an English paragraph under a German title.
 *
 * VS Code localizes those bodies by filename, with no manifest entry to add.
 * `GettingStartedDetailsRenderer.readContentsOfPath`
 * (src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStartedDetailsRenderer.ts)
 * builds two candidates before falling back to the base file:
 *
 *     const localizedPath = path.with({ path: path.path.replace(/\.md$/, `.nls.${language}.md`) });
 *     const generalizedLocale = language?.replace(/-.*$/, '');
 *     const generalizedLocalizedPath = path.with({ path: path.path.replace(/\.md$/, `.nls.${generalizedLocale}.md`) });
 *
 * and reads the first one that exists *with a non-zero size* (the size check is
 * deliberate — microsoft/vscode#131809, file system providers that fake `stat`).
 * `language` is `vs/base/common/platform.ts`'s display language: the same
 * lowercase token the extension already ships as `package.nls.pt-br.json` and
 * `l10n/bundle.l10n.pt-br.json`, which is why the locale list here is read off
 * those manifest files rather than hardcoded.
 *
 * So this gate asserts, for every step the manifest declares and every locale
 * the extension claims:
 *
 *   - the `<name>.nls.<locale>.md` sibling exists and is not empty;
 *   - it carries exactly the base file's `command:` links, all declared in
 *     `contributes.commands` — those links are the step's buttons, and a
 *     translation that drops or mistypes one ships a step with no way out;
 *   - it is not a copy of the English body (a copied file passes every
 *     structural check and still shows English);
 *   - it has as many list items as the base, so no numbered step is lost in
 *     translation;
 *   - French is accented.
 *
 *   node --test docs/walkthrough-i18n.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const docsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(docsDir, '..');
const extensionDir = join(repoRoot, 'packages', 'extension');

const manifest = () => JSON.parse(readFileSync(join(extensionDir, 'package.json'), 'utf8'));

/** The markdown body of every step of the Get Started walkthrough, manifest order. */
function walkthroughMarkdownPaths() {
  const m = manifest();
  const walkthroughs = m.contributes?.walkthroughs ?? [];
  assert.ok(walkthroughs.length > 0, 'no walkthrough left in the manifest — re-read this gate');
  return walkthroughs.flatMap((w) =>
    (w.steps ?? [])
      .filter((step) => typeof step.media?.markdown === 'string')
      .map((step) => ({ id: step.id, relative: step.media.markdown })),
  );
}

/**
 * Locales the extension claims, read off `package.nls.<locale>.json`. VS Code
 * resolves both those files and the walkthrough bodies with the same `language`
 * token, so one list cannot drift from the other.
 */
function claimedLocales() {
  return readdirSync(extensionDir)
    .map((f) => /^package\.nls\.([\w-]+)\.json$/.exec(f)?.[1])
    .filter((locale) => typeof locale === 'string')
    .sort();
}

/** VS Code's own path rule: `foo.md` → `foo.nls.<locale>.md`, same directory. */
const localizedPath = (relativePath, locale) => relativePath.replace(/\.md$/, `.nls.${locale}.md`);

const read = (relativePath) => readFileSync(join(extensionDir, relativePath), 'utf8');

const commandLinks = (text) => [...text.matchAll(/\]\(command:([\w.]+)\)/g)].map((m) => m[1]);

const listItems = (text) =>
  text.split('\n').filter((line) => /^\s*(?:[-*]|\d+\.)\s+\S/.test(line)).length;

test('the manifest still ships localizable walkthrough bodies', () => {
  const steps = walkthroughMarkdownPaths();
  assert.ok(steps.length > 0, 'no step renders a markdown body — re-read this gate');
  for (const step of steps) {
    assert.ok(
      existsSync(join(extensionDir, step.relative)),
      `${step.id}: the manifest points at ${step.relative}, which does not exist`,
    );
  }
  assert.deepEqual(
    claimedLocales(),
    ['de', 'es', 'fr', 'ja', 'pt-br'],
    'the set of non-English locales changed; every walkthrough body needs the new one too',
  );
});

test('every walkthrough body has a body in every language the extension claims', () => {
  const missing = [];
  for (const step of walkthroughMarkdownPaths()) {
    for (const locale of claimedLocales()) {
      const candidate = localizedPath(step.relative, locale);
      const absolute = join(extensionDir, candidate);
      if (!existsSync(absolute)) {
        missing.push(`${candidate} — ${locale} readers get the English body`);
        continue;
      }
      // VS Code only accepts the localized file when `stat` reports a size.
      if (readFileSync(absolute, 'utf8').trim().length === 0) {
        missing.push(`${candidate} — empty, VS Code falls back to English`);
      }
    }
  }
  assert.deepEqual(
    missing,
    [],
    'these walkthrough translations are missing:\n  ' + missing.join('\n  '),
  );
});

test('a translated body keeps the buttons of the English one', () => {
  const declared = new Set((manifest().contributes?.commands ?? []).map((c) => c.command));
  const offenders = [];
  for (const step of walkthroughMarkdownPaths()) {
    const base = read(step.relative);
    const expected = commandLinks(base);
    assert.ok(expected.length > 0, `${step.relative}: the English body has no command: link`);
    for (const command of expected) {
      if (!declared.has(command)) offenders.push(`${step.relative}: unknown command ${command}`);
    }
    for (const locale of claimedLocales()) {
      const candidate = localizedPath(step.relative, locale);
      if (!existsSync(join(extensionDir, candidate))) continue;
      const links = commandLinks(read(candidate));
      if (links.join(',') !== expected.join(',')) {
        offenders.push(`${candidate}: buttons are [${links}], English has [${expected}]`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'these bodies lost a button:\n  ' + offenders.join('\n  '));
});

test('a translated body is translated, not copied', () => {
  const offenders = [];
  for (const step of walkthroughMarkdownPaths()) {
    const base = read(step.relative).trim();
    const baseItems = listItems(base);
    for (const locale of claimedLocales()) {
      const candidate = localizedPath(step.relative, locale);
      if (!existsSync(join(extensionDir, candidate))) continue;
      const text = read(candidate).trim();
      if (text === base) offenders.push(`${candidate}: byte-identical to the English body`);
      if (listItems(text) !== baseItems) {
        offenders.push(`${candidate}: ${listItems(text)} list items, English has ${baseItems}`);
      }
      // The English heading survives a half-done translation of the body.
      const heading = base.split('\n')[0];
      if (text.split('\n')[0] === heading) {
        offenders.push(`${candidate}: still carries the English heading "${heading}"`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'these bodies are not really translated:\n  ' + offenders.join('\n  '),
  );
});

test('the French walkthrough is written with its accents', () => {
  // Same watch list as scripts/check-i18n-parity.ts section 5, blocking here:
  // four files are a small enough corpus that a false positive is not a risk.
  const unaccented =
    /\b(Termines?|Crees?|Donnees|Parametres?|Selectionn|executions?|operations?|Echec|reussi|genere|requetes?|deja|apres|securite|defaut|Modeles?|Delai|Etapes?|Executer|qualite|Durees?|Apercu|regles?|Resultats?|dependances?|premieres?|systemes?|reelle?s?|developpement)\b/i;
  const offenders = [];
  for (const step of walkthroughMarkdownPaths()) {
    const candidate = localizedPath(step.relative, 'fr');
    if (!existsSync(join(extensionDir, candidate))) continue;
    const text = read(candidate);
    const hit = unaccented.exec(text);
    if (hit) offenders.push(`${candidate}: "${hit[1]}"`);
    if (!/[àâäçéèêëîïôöùûüœ]/i.test(text)) {
      offenders.push(`${candidate}: not one accented character in the whole file`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'French written without its accents:\n  ' + offenders.join('\n  '),
  );
});
