/**
 * Keeps the prose a user reads honest about features the code does not have.
 *
 * Every rule below reads the same surfaces, and they are every place this
 * product writes a sentence to somebody who has not read its source:
 *
 *  - `README.md` and `packages/extension/README.md` — the repository landing
 *    page and the Marketplace listing;
 *  - `SECURITY.md` and `CONTRIBUTING.md` — the other two pages the repository
 *    root publishes;
 *  - every `.md` under `docs/`, linked from a README or not, minus
 *    `docs/archive/` (untracked, and no longer maintained);
 *  - the four walkthrough bodies under `packages/extension/walkthrough/` and
 *    the five translations of each, which VS Code renders in Get Started;
 *  - `ci-examples/README.md` and `packages/extension/examples/README.md` —
 *    neither ships in the VSIX (the first sits outside the extension package,
 *    the second is listed in `.vscodeignore`), and both are tracked by git and
 *    served by GitHub, which is what makes them pages somebody reads;
 *  - every `description` and `markdownDescription` in the extension manifest —
 *    settings, the Restricted Mode notice, the walkthrough steps — with `%key%`
 *    resolved into the six sentences VS Code shows, through the same
 *    `resolveNls` the marketplace gate uses (`claims-surfaces.mjs`);
 *  - the six `package.nls*.json`, by value: the listing text, the Settings
 *    editor, the command palette;
 *  - the six `l10n/bundle.l10n*.json`, by value: the notifications an operation
 *    ends on and the modal that gates a write to production, which VS Code
 *    renders outside the webview and the VSIX carries;
 *  - the six webview locale bundles, by value.
 *
 * Checked against the VSIX rather than claimed: `unzip -l sandforge.vsix` lists
 * the manifest, the six `package.nls*`, the readme, the changelog, the 24
 * walkthrough bodies, the six `l10n/bundle.l10n*`, `dist/` and `webview-dist/`.
 * Every one of them is read here, or is a build of something read here, bar the
 * changelog — which is left out on purpose, below. The VSIX is the floor, not
 * the boundary: what a reader meets is decided by publication, so the `.md`
 * files git tracks outside it are read too. That is every one of them today
 * except the changelogs and `.github/PULL_REQUEST_TEMPLATE.md`, a form only a
 * contributor opening a pull request ever sees.
 *
 * A bundle is read by string VALUE, never by key: `config.grappe.enabled` is an
 * identifier no reader meets, and it must be able neither to trip a rule nor to
 * satisfy one.
 *
 * On top of that, the AI Assistant rules alone also read the English fallbacks
 * the webview hands to `t()`, because that is where this repository keeps its
 * source strings rather than in `locales/en.json`.
 *
 * Not read, on purpose: source comments, and the changelogs — a note about what
 * a release withdrew has to be free to name it.
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
 * anything — there, `grappeAdapter.partition()` has no caller and `grappeActive`
 * only wraps an unchanged sequential loop in two progress events.
 *
 * What does partition is Seed: `executeWithGrappe` asks the adapter to split the
 * template, then walks the chunks in a `for` loop, awaiting each and reporting
 * it before the next begins. Sync reports one partition per object from its own
 * awaited loop. So three anchors read the three paths — two for what happens,
 * one for what does not — and the surfaces are held to all of them: per
 * partition for Seed, per object for Sync, start and end only for Autopilot,
 * and no sentence that reaches for the vocabulary of concurrency, or for the
 * ordinary phrases that say the same thing, to describe any of them. Words,
 * not the idea: the limit is spelt out below.
 *
 * CDC is the same story: its tab hidden from the Sync page, disclaimed in
 * `docs/modules/sync.md`, routed to `NoOpHandler` in the extension — and still
 * sold as a working "near real-time" sync mode by the in-app help panel, in all
 * six languages.
 *
 * The rest of that panel went further. Through v1.22 it taught a sync rollback
 * nothing reads, an API-timeout setting the manifest never declared, Grappe as
 * the cure for a slow run, deploying straight from a Compare diff, pipelines
 * started by schedules and webhooks, DSR handling, quality scans and mass
 * deletes that were coming-soon tabs, and two Ctrl shortcuts no listener
 * answered. Those rules are vocabularies scoped by key, each tied to the code
 * that makes it false.
 *
 * The AI Assistant row in both READMEs sold "failed-job diagnosis over 10
 * read-only tools". No screen could start a diagnosis, the tools were wired to
 * nothing, and the one call into the tool loop handed it an empty list.
 *
 * The FAQ's privacy answer said data reached the provider "only when you
 * explicitly use AI features", from the first FAQ to v1.21. `operation:failed`
 * has been resolved inside the extension since the diagnose flow was removed:
 * every failed run hands the org's error text — which quotes record values — to
 * the model with no screen, no button and no consent in between.
 *
 * Compare's schema advice and Monitor's anomaly scan went the other way. Both
 * are built with no provider at all and wired before the API-key gate, and both
 * were sold as "AI-powered" on the module pages and in the Marketplace listing —
 * then, once corrected, as rule-based but "still need AI enabled with a key".
 *
 * So each assertion here is anchored to the code that decides the truth, and
 * fails in BOTH directions: build the feature — the partition, the CDC route,
 * the tools, a provider for the rule modules — and the anchor test trips first,
 * telling you the prose is now understating the product and may be rewritten.
 * The wordings that named no tool are the exception, and the limits below say
 * so.
 *
 * The code is read off the syntax tree. The prose is not read for meaning at
 * all: it is matched against the wording this product actually published,
 * mined from every revision of every public surface in the repository. An
 * earlier cut guessed at what a promise looks like, and flagged the honest
 * removal note, a competitor comparison and a true sentence about Monitor and
 * Compare — a class of false alarm that only a negation parser in six
 * languages would close. Refusing the wording that shipped needs none.
 *
 * Two rules keep that from becoming the same noise by another route. A wording
 * is mined whole, as the bullet or the cell that sold it: `read-only tool
 * surface` on its own is security vocabulary any module may use, and four
 * translators borrow the English term for a sentence that promises nothing. And
 * structure separates — a table cell, a link label, a list item, a sentence —
 * so no wording is assembled out of two neighbours a reader never meets as one
 * phrase.
 *
 * What the AI Assistant checks do not see, one limit per line:
 *  - Code is read under `packages/extension/src`, `packages/shared/src` and `packages/webview/src`, plus the JSON under the first two and under `packages/extension/resources`; a fourth workspace package fails the control below instead of passing unread.
 *  - A key of that name that sends nothing — a log field `{ tools: 0 }`, a panel config — is refused like a request. Rename it: telling the two apart means reading where the object goes, and a rule that trusted the call target would let a request built in a helper through.
 *  - Provider options handed through from outside the code — a webview payload, a user setting spread into the request — carry a `tools` key written nowhere in the repository.
 *  - A tool catalogue written into the prompt text, whose reply is parsed by hand, gives the model tools under no key and no block type this scan knows.
 *  - A key computed at runtime (a variable, a template, `Reflect.set`, `Object.defineProperty`) hides `tools` from the scan.
 *  - A request that bypasses the SDK, such as a raw HTTP call to `/v1/messages` whose body is built from strings, is invisible.
 *  - A tool call read without the SDK's type name or a `'tool_use'` literal, say `'input' in block`, is invisible; it can only arrive after a request sent tools.
 *  - A tool helper a later SDK exports under a new name or path is caught only through the request key it still needs.
 *  - An OpenAI-shaped request, `functions` with `function_call`, is not watched: Functions is a Salesforce product this extension talks about, so the key is ordinary vocabulary here. Reaching that shape means a second provider, which the code anchor's own controls would show.
 *  - A tool factory whose name carries on past the word, `createToolRegistry`, is not caught by name — `Tools` is also a panel label in this product, so the name has to end on it. What the factory builds is still caught when it reaches a request or an SDK helper.
 *  - The editor's model namespace taken whole — `const api = vscode.lm`, `.bind(vscode.lm)` — is refused even when only a chat model is wanted, since the scan cannot follow the alias to what it calls. A renamed import of `vscode` itself is still read, because the member is still named `lm`.
 *  - Prose refuses published wording, whole: a paraphrase, a new sentence, a translation, or the same sentence with a word inflected — `diagnostics` for `diagnosis`, `surfaces` for `surface` — passes. The count is the one word that may change.
 *  - Any quotation of a published wording is refused like the promise: struck through, inside quotation marks, in a removal note or in an answer about an old version alike. A changelog is not a surface, so that is where the quote belongs.
 *  - A wording that does not name the tools is released by rewriting it, not by the anchor: the anchor answers one question, whether shipped code gives the model tools.
 *  - Markdown is read by paragraph, table row, heading and list item: a fenced code block is not prose, and a wording split across two rows or two items passes — as it does across two locale keys rendered side by side.
 *  - The webview's English fallbacks are read for these wordings, by the Grappe rules and by the CDC rule, which is how `grappe.subtitle` and `grappe.step2Desc` were caught — `Parallel execution engine`, six languages and the fallback, on the Grappe page header.
 *
 * What the two code anchors added last do not see, one limit per line:
 *  - The automatic-resolution anchor reads one emitter, `sendOperationFailed`. A second path to `resolveError` — another caller, a webview channel wired back — is not read; it would only make the wordings more false, never less.
 *  - It reads the conditions around the call — an `if`, a ternary, the right side of `&&`, `||`, `??`, `&&=`, `||=` or `??=`, a `switch` case (its switch expression, its own label and the labels falling through into it), a `while`, `do`, `for`, `for…of` or `for…in` loop, an argument of an optional call `consent?.(…)` — inside the expression the call is made on, `(asked ? resolver : undefined)?.resolveError(…)`, and inside every value given to the name that expression starts from: assigned, destructured, set as a property, or held in an object literal, `const [r] = asked ? [resolver] : []` and `const box = { r: asked ? resolver : undefined }` included. It accepts only a condition that reads the resolver and nothing else, so `true` and a `case 'asked'` label are refused. What it does not read, and this list may not be complete: an early exit ABOVE the call — `if (!userAskedForIt) return;`, a `throw`, a `continue`, a `break` out of a labelled block — which is ordinary filtering there, and refusing it would fail the anchor on honest code; a call placed in a `catch` block or a `finally`; a resolver chosen inside a helper, `const resolver = pick(deps)`; the value of a name read through another name, `const alias = box; alias.r?.resolveError(…)`; and a call made inside a callback, `deps.onConsent(() => resolver.resolveError(error))`, since when a callback runs is decided by the function it is handed to.
 *  - It reads one wire, `setAIModules` writing the injected resolver into `handlerDeps` — the object every handler is constructed on, and the only one the emitter can be reading. A second injection — a constructor argument, a deps object built elsewhere — is not read.
 *  - The rule-module anchor counts constructor ARGUMENTS in the composition root. A provider reaching `AnomalyDetector` another way — a setter, a field assigned later, a default parameter — is invisible; the count only answers the question the composition root answers today.
 *  - It also reads POSITION: the statement that wires them runs before the first statement of `initAIComposition` that can return. A gate built some third way — a throw, an early exit inside a helper it awaits — is not read as a gate. And "the first statement that can return" is a proxy for the AI gate, not the gate itself: a guard clause added above it moves the line this anchor measures without moving the gate.
 *  - It reads the condition around the call, never inside it: `setRuleModules(enabled ? modules : undefined)` puts the AI switch back in front of the rule-based modules with no `if` anywhere an ancestor walk can see. Left unread on purpose — a ternary in an argument is ordinary code, and a rule that refused one would fail this gate on honest wiring.
 *  - Both read `aiComposition.ts` by name. Move the composition root and they fail loudly on a missing construction rather than passing on an empty file, which is the failure mode worth having.
 *
 * What the Grappe rules do not see, one limit per line:
 *  - The Seed anchor reads `executeWithGrappe` in `SeedOrchestrator`, the Sync anchor reads `execute` in `SyncOrchestrator`, and the Autopilot anchor reads `executePlan`. A fourth path that emits `grappe:*` is read by none of them.
 *  - The rules are VOCABULARIES, not a meaning: the words `paral*`, `concurren*`/`concorren*`, `gleichzeitig`/`nebenläufig`, `simult*`, 並列/並行/同時 anywhere Grappe is the subject, and the phrases "at once", "at the same time", "à la fois", "en même temps", "auf einmal", "zur gleichen Zeit", "zugleich", "de una vez", "a la vez", "al mismo tiempo", "ao mesmo tempo", "de uma vez", 一度に, 一斉に in a sentence that names Grappe or in a string whose key does. Any other paraphrase — "side by side", "in one go", "all together" — passes, and so does a phrase in a paragraph that names Grappe only in another sentence.
 *  - Concurrency reached without a word for it — an unawaited call inside the loop, a queue drained elsewhere — is invisible to the prose rules; the anchors' `Promise.all` checks are what watch the Seed and Sync paths for it.
 *  - A sentence that denies concurrency passes, and a sentence that denies one thing while asserting concurrency in the same breath passes with it: "not queued: run in parallel" reads as a denial. Widening the negation class to the elided and contracted forms the six languages actually write widened that hole with it — deliberately, since the other direction refuses true sentences. What stands behind it is the mined list of wordings this product published, which is refused whole, quotation included.
 *  - Two wordings are too short to mine — `Motor de ejecución paralela`, `大規模データ操作のための並列実行エンジン` — and are left to the word rule, which is what caught them.
 *  - The Seed anchor pins the report to the innermost loop that inserts, which is the granularity the surfaces publish. It does not read what that loop iterates: chunk the objects into one partition each and the report is still per partition, and still true.
 *  - The run-id check reads the name each opening and closing event hands as `operationId`. Two names bound to the same value pass only when they are one name; one name reassigned between the two events passes too.
 *
 * What the CDC and Production Guard rules do not see, one limit per line:
 *  - The CDC rule is a word and a disclaimer: a sentence, clause (split at `;`) or list item naming CDC or Change Data Capture is refused unless that same piece carries a disclaimer word — refused, not implemented, coming soon, in its own language. It does not read what the word is about: "CDC streams every change, and a rejected record is refused" passes on the comma. "Real-time streaming of every change" names neither and passes.
 *  - The Real-Time panel's strings (`sync.realtime.*`) are not read by it, for as long as the Sync page does not offer that tab — the anchor pins that. A screen that renders one of them elsewhere is not seen. A mode label (`sync.modes.*`) is read like any string, except when it is the mode's bare name.
 *  - The Production Guard rule reads "audit trail" in the six languages in a string that names Production Guard. A persisted log sold under another name — "a history of every decision" — passes, and so does "audit trail" in a paragraph that names the guard only in the next one.
 *
 *   node --test docs/product-claims.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { CODE_ATTACKS, PROSE_ATTACKS } from './claims-replay.fixtures.mjs';
import {
  NLS_FILES,
  isNlsPlaceholder,
  ordinaryConcurrencyAssertions,
  parallelAssertions,
  resolveNls,
} from './claims-surfaces.mjs';

const docsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(docsDir, '..');
const read = (...p) => readFileSync(join(repoRoot, ...p), 'utf8');

const LOCALES_DIR = join(repoRoot, 'packages', 'webview', 'src', 'i18n', 'locales');
const localeFiles = () => readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.json'));

const READMES = ['README.md', 'packages/extension/README.md'];

/**
 * The other pages the repository publishes from its root. `changelog.md` is
 * deliberately not here — a note about what a release withdrew has to be able
 * to name it — and neither is any file git does not track.
 */
const ROOT_PAGES = ['SECURITY.md', 'CONTRIBUTING.md'];

const EXT = ['packages', 'extension'];
const WALKTHROUGH_DIR = 'packages/extension/walkthrough';
const L10N_DIR = 'packages/extension/l10n';

/** A `.test.` / `.spec.` file is tooling, whatever its extension. */
const isTestFile = (name) => /\.(?:test|spec)\./.test(name);

/**
 * Every page under `docs/`, linked or not, minus `docs/archive/` — which is
 * untracked, superseded by the pages above it, and no longer maintained.
 *
 * An earlier cut read only the pages a README links to, on the theory that the
 * link list maintains itself. It does, and it also lets a page drop out of the
 * checks by losing a link, which is the opposite of what a published page
 * needs: `docs/` is served by GitHub whether anything points at it or not.
 */
function docPages() {
  const pages = [];
  const walk = (relativeDir) => {
    for (const entry of readdirSync(join(repoRoot, relativeDir), { withFileTypes: true })) {
      const rel = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== 'archive') walk(rel);
      } else if (entry.name.endsWith('.md') && !isTestFile(entry.name)) {
        pages.push(rel);
      }
    }
  };
  walk('docs');
  assert.ok(
    pages.length >= 15,
    `the walk found ${pages.length} pages under docs/, fewer than the 15 it carries — it has ` +
      'stopped reading them, so an empty result below proves nothing',
  );
  return pages.sort();
}

/**
 * The walkthrough bodies VS Code renders in the Get Started page: the four
 * English ones the manifest points at, and the five translations of each that
 * VS Code picks up by filename (`<name>.nls.<locale>.md`, pinned by
 * `walkthrough-i18n.test.mjs`). All of them are read, so a claim cannot be
 * made in German only.
 */
function walkthroughPages() {
  const files = readdirSync(join(repoRoot, WALKTHROUGH_DIR)).filter((f) => f.endsWith('.md'));
  assert.ok(
    files.length >= 24,
    `the walk found ${files.length} walkthrough bodies, fewer than the 24 the extension ships ` +
      '(4 steps × 6 languages) — an empty result below would prove nothing',
  );
  return files.sort().map((f) => `${WALKTHROUGH_DIR}/${f}`);
}

/**
 * Every `description` and `markdownDescription` in the manifest, wherever it
 * sits — a setting, the untrusted-workspace notice, a walkthrough step — with
 * `%key%` resolved into the six sentences VS Code actually shows. The raw
 * placeholder is not prose and reading it as prose is how a localized setting
 * used to escape these checks.
 */
function manifestDescriptions() {
  const surfaces = {};
  const visit = (value, path) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const at = path ? `${path}.${key}` : key;
      if ((key === 'description' || key === 'markdownDescription') && typeof child === 'string') {
        if (isNlsPlaceholder(child)) {
          for (const [locale, text] of Object.entries(resolveNls(child))) {
            surfaces[`packages/extension/package.json ${at} [${locale}]`] = text;
          }
        } else {
          surfaces[`packages/extension/package.json ${at}`] = child;
        }
      }
      visit(child, at);
    }
  };
  visit(JSON.parse(read(...EXT, 'package.json')), '');
  assert.ok(
    Object.keys(surfaces).length >= 100,
    `the walk found ${Object.keys(surfaces).length} manifest descriptions, fewer than the 100 ` +
      'the manifest carries once localized — it has stopped reading them',
  );
  return surfaces;
}

/**
 * The six `l10n/bundle.l10n*.json`: what VS Code itself renders — the
 * notifications an operation ends on, and the modal that gates a write to a
 * production org. They are packaged in the VSIX and a user meets them without
 * ever opening the panel, so they are prose like any other. The English bundle
 * keys are the English sentences; like every bundle here it is read by VALUE.
 */
function l10nBundles() {
  const files = readdirSync(join(repoRoot, ...L10N_DIR.split('/'))).filter((f) =>
    f.endsWith('.json'),
  );
  assert.ok(
    files.length >= 6,
    `the walk found ${files.length} l10n bundles, fewer than the 6 the extension ships — it has ` +
      'stopped reading them, so an empty result below proves nothing',
  );
  return files.sort();
}

/**
 * Every surface a user or a buyer reads, once, as `{ label, text }` for prose
 * and `{ label, json }` for a bundle whose string values are the prose:
 *
 *  - both READMEs — the repository landing page and the Marketplace listing;
 *  - `SECURITY.md` and `CONTRIBUTING.md`, the other two pages the root
 *    publishes;
 *  - every page under `docs/` outside the archive;
 *  - the four walkthrough bodies and their five translations each;
 *  - `ci-examples/README.md`, which documents what can be automated, and
 *    `packages/extension/examples/README.md`, the Forge recipes — neither
 *    ships in the VSIX, and both are published by GitHub all the same, which
 *    is the only thing that decides whether a reader meets them;
 *  - every manifest description, `%key%` resolved in all six languages;
 *  - the six `package.nls*.json` — the listing text, the Settings editor and
 *    the command palette titles;
 *  - the six `l10n/bundle.l10n*.json` — the notifications and the production
 *    guard modal VS Code renders outside the webview;
 *  - the six webview locale bundles.
 *
 * That is every file of the VSIX that carries a sentence, bar one: the
 * changelog, which ships with the extension and is deliberately not read — a
 * note about what a release withdrew has to be able to name it. `dist/` and
 * `webview-dist/` are builds of sources already read here, and source comments
 * are not surfaces.
 */
function surfaceSources() {
  const sources = [];
  const file = (label, ...parts) => sources.push({ label, text: read(...parts) });

  for (const readme of READMES) file(readme, ...readme.split('/'));
  for (const page of ROOT_PAGES) file(page, page);
  for (const page of docPages()) file(page, ...page.split('/'));
  for (const page of walkthroughPages()) file(page, ...page.split('/'));
  file('ci-examples/README.md', 'ci-examples', 'README.md');
  file('packages/extension/examples/README.md', ...EXT, 'examples', 'README.md');

  for (const [label, text] of Object.entries(manifestDescriptions())) sources.push({ label, text });

  for (const nls of Object.values(NLS_FILES)) {
    sources.push({ label: `packages/extension/${nls}`, json: JSON.parse(read(...EXT, nls)) });
  }

  for (const bundle of l10nBundles()) {
    sources.push({
      label: `${L10N_DIR}/${bundle}`,
      json: JSON.parse(read(...L10N_DIR.split('/'), bundle)),
    });
  }

  const locales = localeFiles();
  assert.ok(
    locales.length >= 6,
    `only ${locales.length} locale files found, the extension ships 6`,
  );
  for (const f of locales) {
    sources.push({
      label: `locales/${f}`,
      json: JSON.parse(readFileSync(join(LOCALES_DIR, f), 'utf8')),
    });
  }
  return sources;
}

// ── Grappe ────────────────────────────────────────────────────────────────

const SEED_ORCHESTRATOR_FILE = 'packages/extension/src/modules/seed/SeedOrchestrator.ts';
const AUTOPILOT_ORCHESTRATOR_FILE =
  'packages/extension/src/modules/autopilot/AutopilotOrchestrator.ts';
const SYNC_ORCHESTRATOR_FILE = 'packages/extension/src/modules/sync/SyncOrchestrator.ts';

/** Whether a node sits inside a loop, without leaving the body it was found in. */
function isLooped(node, body) {
  for (let parent = node.parent; parent && parent !== body; parent = parent.parent) {
    if (
      ts.isForOfStatement(parent) ||
      ts.isForInStatement(parent) ||
      ts.isForStatement(parent) ||
      ts.isWhileStatement(parent) ||
      ts.isDoStatement(parent)
    ) {
      return parent;
    }
  }
  return null;
}

/** Whether a string literal with this exact text is written anywhere under a node. */
function mentions(node, literal) {
  let found = false;
  const visit = (child) => {
    if (ts.isStringLiteralLike(child) && child.text === literal) found = true;
    else ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/** Whether an identifier of this name is read anywhere under a node. */
function reads(node, name) {
  let found = false;
  const visit = (child) => {
    if (ts.isIdentifier(child) && child.text === name) found = true;
    else ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/** Every distinct `grappe:*` event literal written under a node, sorted. */
function grappeEventsIn(node) {
  const events = new Set();
  const visit = (child) => {
    if (ts.isStringLiteralLike(child) && child.text.startsWith('grappe:')) events.add(child.text);
    else ts.forEachChild(child, visit);
  };
  visit(node);
  return [...events].sort();
}

/** Whether a node awaits something itself, rather than in a callback it hands out. */
function awaits(node) {
  let found = false;
  const visit = (child) => {
    if (ts.isFunctionLike(child)) return;
    if (ts.isAwaitExpression(child)) found = true;
    else ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

/** `Promise.all` and its siblings: the calls that would run partitions at once. */
const FAN_OUT = new Set(['all', 'allSettled', 'race', 'any']);
const fanOutCalls = (node) =>
  callsWithin(node).filter((call) => {
    const chain = accessChain(call.node.expression);
    return chain[0] === 'Promise' && FAN_OUT.has(chain[chain.length - 1]);
  });

/**
 * What Seed's grappe mode actually does — the code the Grappe page is now
 * written against, read off the syntax tree rather than asserted to be absent.
 *
 * `executeWithGrappe` asks the adapter to `partition(...)` the template, then
 * walks the chunks in a `for` loop: each one is awaited, and each one is
 * reported with `grappe:partitionProgress` before the next begins. That is
 * "per-partition progress" and "one after another, each reported as it
 * completes", which is what six locales and the webview fallback now say.
 *
 * Fails in both directions. Take the partitioning away, take the report out of
 * the loop, hand the chunks to `Promise.all` — each one trips an assertion
 * here, and the page has to be rewritten with it.
 */
function assertSeedPartitionsAndReportsEachOne() {
  const body = methodBody(parseFile(SEED_ORCHESTRATOR_FILE), 'executeWithGrappe');
  assert.ok(
    body,
    `${SEED_ORCHESTRATOR_FILE} no longer declares executeWithGrappe — the path that partitions a ` +
      'seed moved, so this anchor is reading nothing; find it and re-point the scan',
  );
  const calls = callsWithin(body);

  // Positive control: the walk reads that body, and sees it insert records.
  assert.ok(
    calls.some((call) => call.name === 'insert'),
    'the scan cannot see executeWithGrappe inserting anything — it is reading an empty body, so ' +
      'everything below would prove nothing',
  );

  assert.ok(
    calls.some((call) => {
      const chain = accessChain(call.node.expression);
      return chain[chain.length - 1] === 'partition' && chain.includes('adapter');
    }),
    'executeWithGrappe no longer calls adapter.partition(...) — nothing partitions a seed any ' +
      'more, and the surfaces that promise per-partition progress became false',
  );

  const started = calls.find((call) => call.args.some((arg) => mentions(arg, 'grappe:started')));
  const progress = calls.find((call) =>
    call.args.some((arg) => mentions(arg, 'grappe:partitionProgress')),
  );
  assert.ok(
    progress,
    'executeWithGrappe no longer emits grappe:partitionProgress — the Grappe view is told ' +
      'nothing per partition, and the surfaces that promise it became false',
  );
  // Positive control for the loop test: the run-level event is in the same body
  // and is NOT in a loop, so "inside a loop" below distinguishes something.
  assert.ok(started, 'executeWithGrappe no longer emits grappe:started — re-read this anchor');
  assert.equal(
    isLooped(started.node, body),
    null,
    'grappe:started is now emitted inside a loop — the walk cannot tell a per-partition event ' +
      'from a per-run one, so the check below proves nothing',
  );

  const loop = isLooped(progress.node, body);
  assert.ok(
    loop,
    'grappe:partitionProgress is no longer emitted from inside a loop — a run reports once, not ' +
      'once per partition, and every "each partition as it completes" wording became false',
  );

  // WHICH loop. `executeWithGrappe` nests two: the objects of the template, and
  // the chunks each object is split into. Only the inner one is a partition, and
  // the granularity the surfaces publish turns on that — "Seed reports each
  // partition" is written against it, and "Sync reports one partition per
  // object" is the coarser thing it is contrasted with. So the report has to sit
  // in the same innermost loop as the write it reports: move the emission up one
  // level and a seed starts reporting per object, with every assertion that only
  // asked for "a loop" still green.
  const inserts = calls.filter((call) => call.name === 'insert');
  const insertLoop = isLooped(inserts[0].node, body);
  assert.ok(
    insertLoop,
    'executeWithGrappe no longer writes its partitions from inside a loop — there is one write, ' +
      'so there are no partitions to report one by one',
  );
  // Positive control, measured on the writes rather than on the report: the
  // walk finds the object loop around `mapFields` and the partition loop around
  // `insert`, and tells them apart. Without it, "same loop" would be true for
  // free in a body with only one loop left.
  const mapped = calls.find((call) => call.name === 'mapFields');
  const objectLoop = mapped ? isLooped(mapped.node, body) : null;
  assert.ok(
    objectLoop && objectLoop !== insertLoop,
    'the walk no longer sees the object loop nested outside the partition loop in ' +
      'executeWithGrappe — it cannot tell two loops apart, so the check below proves nothing',
  );
  assert.ok(
    inserts.every((call) => isLooped(call.node, body) === loop),
    'the loop that emits grappe:partitionProgress is no longer the innermost loop that inserts a ' +
      'partition — a seed now reports at a coarser grain than it writes, and "Seed reports each ' +
      'partition" became the wording Sync carries, one report per object',
  );

  assert.ok(
    awaits(loop),
    'the loop that reports each partition no longer awaits anything — the partitions may not be ' +
      'written one after another any more, which is what the Grappe page says they are',
  );
  assert.deepEqual(
    fanOutCalls(body).map((call) => accessChain(call.node.expression).join('.')),
    [],
    'executeWithGrappe now hands its work to Promise.all (or a sibling) — partitions may really ' +
      'run at once. Re-read every Grappe surface before relaxing anything: they are written to ' +
      'say the partitions go one at a time.',
  );
  // Positive control for that walk: the same detector finds a real fan-out in
  // the composition root, so an empty result above is a fact and not a blind spot.
  assert.ok(
    fanOutCalls(parseFile(AI_COMPOSITION_FILE)).length > 0,
    `the scan sees no Promise.all in ${AI_COMPOSITION_FILE}, which is built on two — it is not ` +
      'reading fan-out calls, so their absence above proves nothing',
  );
}

/**
 * What Autopilot's grappe mode does: nothing to the work. `executePlan` brackets
 * an unchanged executor with `grappe:started` and `grappe:completed` and never
 * calls `grappeAdapter.partition(...)`, so on that path there is no partition
 * and nothing to report per partition — which is why the surfaces name Seed and
 * Sync where they promise per-partition progress, and Autopilot only for the
 * start and the end.
 *
 * "Only bracketed" is the claim, so the events are what this reads: the set of
 * `grappe:*` literals `executePlan` writes has to be exactly the two, no more.
 * An earlier cut asserted the absence of one call — `grappeAdapter.partition(` —
 * and would have stayed green through an autopilot run that reported every wave
 * it walked, which is the thing six locales say it does not do.
 *
 * The other half is the opposite error, shipped in the same table row: the run
 * IS bracketed, so "no operation activates it" is false too.
 */
function assertAutopilotOnlyBracketsTheRun() {
  const body = methodBody(parseFile(AUTOPILOT_ORCHESTRATOR_FILE), 'executePlan');
  assert.ok(
    body,
    `${AUTOPILOT_ORCHESTRATOR_FILE} no longer declares executePlan — the path that brackets an ` +
      'autopilot run moved, so this anchor is reading nothing; find it and re-point the scan',
  );

  // Positive control: the same walk reads three events out of the seed path,
  // `grappe:partitionProgress` among them. So the two below are a fact about
  // Autopilot, not a scan that cannot see a per-partition event anywhere.
  const seedBody = methodBody(parseFile(SEED_ORCHESTRATOR_FILE), 'executeWithGrappe');
  assert.ok(
    seedBody,
    `${SEED_ORCHESTRATOR_FILE} no longer declares executeWithGrappe — the per-partition path ` +
      'this anchor measures itself against moved; find it and re-point both scans',
  );
  assert.deepEqual(
    grappeEventsIn(seedBody),
    ['grappe:completed', 'grappe:partitionProgress', 'grappe:started'],
    'the walk no longer reads three grappe events out of executeWithGrappe — it is not reading ' +
      'event literals, so the set it reads out of executePlan below proves nothing',
  );
  assert.deepEqual(
    grappeEventsIn(body),
    ['grappe:completed', 'grappe:started'],
    'executePlan no longer emits exactly grappe:started and grappe:completed. If it reports a ' +
      'partition now, the surfaces that say an autopilot run reports only its start and its end ' +
      'became false in six languages — re-read them before touching this test.',
  );

  assertOneRunIdBracketsTheRun(body, 'AutopilotOrchestrator.executePlan');

  const orchestrator = read(...AUTOPILOT_ORCHESTRATOR_FILE.split('/'));
  assert.doesNotMatch(
    orchestrator,
    /grappeAdapter\s*\.\s*partition\s*\(/,
    'AutopilotOrchestrator now calls grappeAdapter.partition() — an autopilot run may really be ' +
      'partitioned. Re-read every surface below before deleting this test: they are written to ' +
      'say that path reports only its start and its end.',
  );
  assert.match(
    orchestrator,
    /grappeActive/,
    'nothing sets grappeActive any more — the "not activated" wording may be true again',
  );
}

/** The name an event call hands as `operationId`: the shorthand, or the identifier after the colon. */
function operationIdName(call) {
  let name = null;
  const visit = (node) => {
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'operationId') {
      name = 'operationId';
    } else if (ts.isPropertyAssignment(node) && memberName(node) === 'operationId') {
      const value = unwrap(node.initializer);
      if (ts.isIdentifier(value)) name = value.text;
    } else {
      ts.forEachChild(node, visit);
    }
  };
  call.args.forEach(visit);
  return name;
}

/**
 * The Grappe view opens a run on `grappe:started` and closes it on
 * `grappe:completed`, and the id both carry is the only thing that says the
 * second closes the first. Autopilot used to mint the id twice, from the clock,
 * once on each side of the executor: every closing event named a run nobody
 * had opened. So the two events hand over one name, or the view is told about
 * two runs where there was one.
 */
function assertOneRunIdBracketsTheRun(body, where) {
  const calls = callsWithin(body);
  const started = calls.find((call) => call.args.some((arg) => mentions(arg, 'grappe:started')));
  const completed = calls.find((call) =>
    call.args.some((arg) => mentions(arg, 'grappe:completed')),
  );
  assert.ok(
    started && completed,
    `${where} no longer emits both grappe:started and grappe:completed — re-read this anchor`,
  );
  const opened = operationIdName(started);
  assert.ok(
    opened,
    `${where} opens its run with an operationId written inline, not a name — the closing event ` +
      'cannot be read as closing the same run',
  );
  assert.equal(
    operationIdName(completed),
    opened,
    `${where} closes its run under another operationId than the one it opened — the Grappe view ` +
      'is told about a run that never started',
  );
}

/**
 * What Sync's grappe mode does: its own loop over the objects of the run,
 * each one synced and awaited, and reported with `grappe:partitionProgress`
 * before the next begins — "a Sync reports one partition per object", in six
 * locales, the manifest and `docs/modules/sync.md`. And it starts only past
 * `sandforge.grappe.autoActivateThreshold`, like Seed and Autopilot, which is
 * what the setting's description now says.
 *
 * Fails in both directions: take the report out of the loop, move it off the
 * loop that syncs, hand the objects to `Promise.all`, or stop reading the
 * threshold — each trips an assertion here.
 */
function assertSyncReportsOnePartitionPerObject() {
  const source = parseFile(SYNC_ORCHESTRATOR_FILE);
  const body = methodBody(source, 'execute');
  assert.ok(
    body,
    `${SYNC_ORCHESTRATOR_FILE} no longer declares execute — the path that reports a sync moved, so ` +
      'this anchor is reading nothing; find it and re-point the scan',
  );
  const calls = callsWithin(body);
  const writes = calls.filter((call) => call.name === 'syncObject');
  // Positive control: the walk reads that body, and sees it sync objects.
  assert.ok(
    writes.length > 0,
    'the scan cannot see execute syncing an object — it is reading an empty body, so everything ' +
      'below would prove nothing',
  );

  const started = calls.find((call) => call.args.some((arg) => mentions(arg, 'grappe:started')));
  const progress = calls.find((call) =>
    call.args.some((arg) => mentions(arg, 'grappe:partitionProgress')),
  );
  assert.ok(
    progress,
    'SyncOrchestrator.execute no longer emits grappe:partitionProgress — the surfaces that say a ' +
      'Sync reports one partition per object became false',
  );
  assert.ok(
    started,
    'SyncOrchestrator.execute no longer emits grappe:started — re-read this anchor',
  );
  // Positive control for the loop test: the run-level event is in the same
  // body and is NOT in a loop.
  assert.equal(
    isLooped(started.node, body),
    null,
    'grappe:started is now emitted inside a loop — the walk cannot tell a per-object event from ' +
      'a per-run one, so the check below proves nothing',
  );
  const loop = isLooped(progress.node, body);
  assert.ok(
    loop,
    'grappe:partitionProgress is no longer emitted from inside a loop — a sync reports once, not ' +
      'once per object',
  );
  assert.ok(
    writes.every((call) => isLooped(call.node, body) === loop),
    'the loop that emits grappe:partitionProgress is no longer the loop that syncs each object — ' +
      'a sync now reports at another grain than it writes',
  );
  assert.ok(
    awaits(loop),
    'the loop that reports each object no longer awaits anything — the objects may not be synced ' +
      'one after another any more, which is what the surfaces say',
  );
  assert.deepEqual(
    fanOutCalls(body).map((call) => accessChain(call.node.expression).join('.')),
    [],
    'SyncOrchestrator.execute now hands its work to Promise.all (or a sibling) — objects may really ' +
      'sync at once. Re-read every Grappe surface before relaxing anything.',
  );
  assert.ok(
    fanOutCalls(parseFile(AI_COMPOSITION_FILE)).length > 0,
    `the scan sees no Promise.all in ${AI_COMPOSITION_FILE}, which is built on two — it is not ` +
      'reading fan-out calls, so their absence above proves nothing',
  );
  assertOneRunIdBracketsTheRun(body, 'SyncOrchestrator.execute');

  const activation = methodBody(source, 'isGrappeActive');
  assert.ok(
    activation && reads(activation, 'enabled'),
    'SyncOrchestrator no longer decides activation in isGrappeActive — re-point this anchor',
  );
  assert.ok(
    reads(activation, 'autoActivateThreshold'),
    'SyncOrchestrator no longer holds a run to sandforge.grappe.autoActivateThreshold — the ' +
      'setting description that names Sync became false in six languages',
  );
}

test('anchor: a seed partitions, and reports each partition as it completes', () => {
  assertSeedPartitionsAndReportsEachOne();
});

test('anchor: a sync past the threshold reports one partition per object, one after another', () => {
  assertSyncReportsOnePartitionPerObject();
});

test('anchor: an autopilot run is only bracketed by two events', () => {
  assertAutopilotOnlyBracketsTheRun();
});

/**
 * A string a reader meets, and the subject it is written about. For a bundle
 * value the subject is its key: `grappe.subtitle` is a sentence about Grappe
 * even when the word "Grappe" is nowhere in the sentence, which is exactly how
 * `Parallel execution engine for large-scale data operations` sat on the
 * Grappe page header, in six languages, under a rule that required both words
 * on one line. The key is a subject, never prose: it cannot satisfy a rule,
 * only say what the value is about.
 */
const grappeUnits = () =>
  userFacingProse().filter((unit) => /grappe/i.test(unit.label) || /grappe/i.test(unit.text));

/**
 * What this product published about Grappe running things at once, mined from
 * every revision of the surfaces read here. Refused whole, like the AI
 * wordings, and for the same reason: it is the text that shipped, not a guess
 * at what a promise looks like.
 *
 * Two of the six languages carry a wording short enough that the floor in
 * `assertMinedWordingsCarryAClaim` rejects it — `Motor de ejecución paralela`,
 * `大規模データ操作のための並列実行エンジン`. They are left to the word rule below,
 * which is what caught them in the first place.
 *
 * Built lazily: `mine` normalises, and `normalizeProse` is defined further down
 * this file.
 */
const GRAPPE_WORDINGS = [
  {
    // The Grappe page header, `grappe.subtitle` + the webview fallback, from
    // 7ad1d527 (2026-03-17) through 335040c0 (2026-08-13) to v1.21.
    text: 'Parallel execution engine for large-scale data operations',
    where: 'the Grappe page header, English, 2026-03-17 to v1.21',
  },
  {
    text: "Moteur d'exécution parallèle pour les opérations de données à grande échelle",
    where: 'the Grappe page header, French, 2026-08-13 to v1.21',
  },
  {
    text: 'Parallele Ausführungs-Engine für Datenoperationen im großen Maßstab',
    where: 'the Grappe page header, German, 2026-08-13 to v1.21',
  },
  {
    text: 'Motor de execução paralela para operações de dados em larga escala',
    where: 'the Grappe page header, Portuguese, 2026-08-13 to v1.21',
  },
  {
    // `grappe.step2Desc`, the middle card of "How Grappe Works", same span.
    text: 'Parallel workers process partitions with back-pressure control',
    where: 'the "How Grappe Works" card, English, 2026-03-17 to v1.21',
  },
  {
    text: 'Des workers parallèles traitent les partitions avec contrôle de la contre-pression',
    where: 'the "How Grappe Works" card, French, 2026-08-13 to v1.21',
  },
  {
    text: 'Parallele Worker verarbeiten Partitionen mit Gegendruck-Steuerung',
    where: 'the "How Grappe Works" card, German, 2026-08-13 to v1.21',
  },
  {
    text: 'Workers paralelos procesan las particiones con control de contrapresión',
    where: 'the "How Grappe Works" card, Spanish, 2026-08-13 to v1.21',
  },
  {
    text: 'Workers paralelos processam as partições com controle de contrapressão',
    where: 'the "How Grappe Works" card, Portuguese, 2026-08-13 to v1.21',
  },
  {
    text: '並列ワーカーがバックプレッシャー制御のもとでパーティションを処理します',
    where: 'the "How Grappe Works" card, Japanese, 2026-08-13 to v1.21',
  },
  {
    // `settings.enableGrappeDesc`, the Settings toggle, 7ad1d527 (2026-03-17)
    // to e9a4bdeb (2026-09-09). French shipped in both spellings.
    text: 'Automatically partition large operations into parallel clusters for faster execution',
    where: 'the Settings toggle, English, 2026-03-17 to 2026-09-09',
  },
  {
    text: 'Partitionne automatiquement les operations volumineuses en clusters paralleles pour une execution plus rapide',
    where: 'the Settings toggle, French, 2026-03-17 to 2026-09-09',
  },
  {
    text: 'Partitionne automatiquement les opérations volumineuses en clusters parallèles pour une exécution plus rapide',
    where: 'the Settings toggle, French with accents, 2026-09-09',
  },
  {
    text: 'Große Operationen für schnellere Ausführung automatisch in parallele Cluster aufteilen',
    where: 'the Settings toggle, German, 2026-03-17 to 2026-09-09',
  },
  {
    text: 'Particionar automáticamente operaciones grandes en clústeres paralelos para una ejecución más rápida',
    where: 'the Settings toggle, Spanish, 2026-03-17 to 2026-09-09',
  },
  {
    text: 'Particiona automaticamente operações grandes em clusters paralelos para execução mais rápida',
    where: 'the Settings toggle, Portuguese, 2026-03-17 to 2026-09-09',
  },
  {
    text: '大規模な操作を自動的に並列クラスターに分割し、高速に実行します',
    where: 'the Settings toggle, Japanese, 2026-03-17 to 2026-09-09',
  },
  {
    // The module table of both READMEs, f25de974 (2026-08-06) to 35dd6060.
    text: 'Parallel execution engine for datasets above 10,000 records',
    where: 'the Grappe row of the module table, both READMEs, 2026-08-06 to 2026-08-12',
  },
  {
    // What replaced it, wrong in the other direction too, to e9a4bdeb.
    text: 'Partitioned parallel execution engine for large datasets',
    where: 'the Grappe row of the module table, both READMEs, 2026-08-12 to 2026-09-09',
  },
  {
    // The settings table of README.md, d1b1e371 (2026-03-16) to 8c9d15a3.
    text: 'Enable parallel processing for large datasets',
    where: 'the settings table, README.md, 2026-03-16 to 2026-08-10',
  },
  {
    // README.md release highlights and the packages/extension/README.md AI-era
    // feature list, 2026-03-16 to 2026-03-28.
    text: 'Grappe Engine for parallel processing of large datasets',
    where: 'the highlights, README.md, 2026-03-16 to 2026-03-28',
  },
  {
    text: '**Parallel Processing** — Grappe engine with 7 partitioning strategies for 10K+ records',
    where: 'the feature list, packages/extension/README.md, 2026-03-20 to 2026-03-28',
  },
  {
    // docs/faq.md, cb52cda6 (2026-03-16) to 35dd6060 (2026-08-12).
    text: 'the Grappe Engine activates automatically for parallel processing',
    where: 'the slow-run answer, docs/faq.md, 2026-03-16 to 2026-08-12',
  },
  {
    // docs/modules/sync.md, 35dd6060 (2026-08-12) to 02a61d14 (2026-09-10).
    text: 'Grappe parallel execution is coming soon',
    where: 'the execution section, docs/modules/sync.md, 2026-08-12 to 2026-09-10',
  },
  {
    // The Grappe page empty state, webview fallback, 2026-03-17 to 2026-08-13.
    text: 'Grappe automatically activates when operations exceed the parallel threshold',
    where: 'the Grappe page empty state, 2026-03-17 to 2026-08-13',
  },
  {
    // `sandforge.grappe.maxWorkers`, removed from the manifest in v1.17.0:
    // nothing read it, and there is no concurrency to size.
    text: 'Maximum number of partitions processed concurrently',
    where: 'the sandforge.grappe.maxWorkers description, the manifest, to v1.17.0',
  },
];

let grappeClaimsCache;
const grappeClaims = () => (grappeClaimsCache ??= GRAPPE_WORDINGS.map(mine));

test('no user-facing surface republishes the withdrawn Grappe wording', () => {
  assertSeedPartitionsAndReportsEachOne();
  assertAutopilotOnlyBracketsTheRun();

  const offenders = [];
  for (const { label, text } of userFacingProse()) {
    for (const claim of republishedClaims(text, grappeClaims())) {
      offenders.push(`${label}: "${claim.text}" — published in ${claim.where}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'a seed walks its partitions one at a time and an autopilot run is not partitioned at all; ' +
      'these surfaces put back wording the product withdrew. Rewrite the sentence; a note about ' +
      'the removal belongs in a changelog, which this gate does not read:\n  ' +
      offenders.join('\n  '),
  );
});

test('no user-facing surface claims Grappe runs anything at once', () => {
  assertSeedPartitionsAndReportsEachOne();
  assertSyncReportsOnePartitionPerObject();
  assertAutopilotOnlyBracketsTheRun();

  // Beyond the wordings that shipped, the claim itself: every grappe path is a
  // sequential `for await`, so no sentence about Grappe may assert concurrency
  // in any of the six languages, in the vocabulary or in ordinary words. A
  // sentence that DENIES it is the honest one, and passes — `docs/faq.md`
  // publishes exactly that.
  const offenders = [];
  for (const { label, text } of grappeUnits()) {
    const aboutGrappe = /grappe/i.test(label);
    for (const sentence of [
      ...parallelAssertions(text),
      ...ordinaryConcurrencyAssertions(text, { aboutGrappe }),
    ]) {
      offenders.push(`${label}: ${sentence.slice(0, 140)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'these lines sell Grappe as concurrent execution, which it is not:\n  ' +
      offenders.join('\n  '),
  );
});

test('the Grappe rules refuse what shipped and leave an honest denial alone', () => {
  assertMinedWordingsCarryAClaim(grappeClaims());

  // Each wording as published, then the shapes a reappearance takes: a table
  // row, a paragraph wrapped mid-phrase, emphasis inside a word, a
  // non-breaking hyphen, a space written as an entity, the count brought up to
  // date, a longer sentence carrying it, and a removal note quoting it.
  const republished = [
    ...GRAPPE_WORDINGS.map((claim) => claim.text),
    '| **Grappe** | Parallel execution engine for datasets above 10,000 records |',
    'Parallel execution engine\nfor large-scale data operations',
    'Parallel *execution* engine for large-scale data operations',
    'Parallel execution engine for datasets above 10,000&nbsp;records',
    'Parallel execution engine for datasets above 25,000 records',
    'Grappe is a parallel execution engine for large-scale data operations, and always was.',
    '~~Parallel workers process partitions with back-pressure control~~ — withdrawn in 1.21.',
    'The Grappe page used to read "Parallel execution engine for large-scale data operations".',
  ];
  assert.deepEqual(
    republished.filter((text) => republishedClaims(text, grappeClaims()).length === 0),
    [],
    'these republish wording the product withdrew about Grappe, and the rules let them through',
  );

  // The word rule, in the direction that matters: a sentence asserting
  // concurrency about Grappe is refused in all six languages, whichever word it
  // reaches for — the accented French forms and `concurrently` are the two the
  // first class could not see.
  const asserted = [
    'Grappe processes partitions in parallel across a worker pool.',
    'Partitions are processed concurrently once the threshold is reached.',
    'Le parallélisme de Grappe accélère les gros volumes.',
    'La parallélisation des partitions est automatique.',
    'Grappe verarbeitet die Partitionen gleichzeitig.',
    'Las particiones se procesan de forma simultánea.',
    'As partições são processadas simultaneamente.',
    'Grappe はパーティションを並行して処理します。',
    'Maximum number of partitions processed concurrently',
  ];
  assert.deepEqual(
    asserted.filter((text) => parallelAssertions(text).length === 0),
    [],
    'these sell a concurrency no grappe path has, and the word rule lets them through',
  );

  // The same claim in ordinary words, which the word rule cannot see: refused
  // in a sentence naming Grappe, and in any sentence of a string keyed to it.
  const assertedInOrdinaryWords = [
    'Grappe runs every partition at once.',
    'With Grappe, all partitions are written at the same time.',
    'Avec Grappe, les partitions sont traitées en même temps.',
    'Grappe traite les partitions à la fois.',
    'Grappe verarbeitet alle Partitionen auf einmal.',
    'Grappe schreibt die Partitionen zur gleichen Zeit.',
    'Grappe procesa todas las particiones al mismo tiempo.',
    'Grappe escribe las particiones a la vez.',
    'O Grappe grava as partições ao mesmo tempo.',
    'O Grappe processa todas as partições de uma vez.',
    'Grappe はすべてのパーティションを一度に処理します。',
  ];
  assert.deepEqual(
    assertedInOrdinaryWords.filter((text) => ordinaryConcurrencyAssertions(text).length === 0),
    [],
    'these sell Grappe as concurrent without a word for it, and the phrase rule lets them through',
  );
  assert.deepEqual(
    ordinaryConcurrencyAssertions('Partitions are processed at the same time', {
      aboutGrappe: true,
    }),
    ['Partitions are processed at the same time'],
    'a grappe.* string that never names Grappe sells concurrency, and the phrase rule lets it through',
  );
  // The phrases are ordinary prose everywhere else: a sentence that does not
  // name Grappe, outside a string about it, is not read by this rule.
  const ordinaryElsewhere = [
    'Once Deploy from Diff ships, prefer it over deploying everything at once',
    'The bar shows every object at once, so a long run stays readable.',
  ];
  assert.deepEqual(
    ordinaryElsewhere.filter((text) => ordinaryConcurrencyAssertions(text).length > 0),
    [],
    'the phrase rule refuses sentences that are not about Grappe',
  );

  // Prose an honest page could hold, in the six languages the extension ships:
  // the denials `docs/faq.md` and `docs/modules/sync.md` publish today, the ADR
  // such a decision deserves, and the sentences the newly-read surfaces carry —
  // the production-guard modal, the offline-queue notifications, SECURITY.md
  // and CONTRIBUTING.md. Every one of them passes both Grappe rules.
  const honest = [
    'Grappe, when enabled, reports progress per partition; it does not run the partitions concurrently.',
    'With Grappe enabled, the run reports progress one partition per object over that same sequential loop -- nothing is split and nothing runs concurrently.',
    '# ADR 0012 — Grappe is not a parallel executor',
    'Partitions are processed one after another, each reported as it completes',
    'Grappe needs sandforge.grappe.enabled. A Seed run past the record threshold then reports each partition as it completes.',
    'SandForge: org unreachable — the queued operation will replay automatically when connectivity returns.',
    'This operation writes data to a PRODUCTION org.',
    'Report a vulnerability privately through GitHub Security Advisories; do not open a public issue.',
    'Run `pnpm validate` before opening a pull request: it is the same pipeline CI runs, and it is not parallel.',
    "Les partitions ne sont pas traitées en parallèle : Grappe signale chacune d'elles à sa fin.",
    "Grappe n'exécute rien simultanément ; il rend compte, partition par partition.",
    'Die Partitionen werden nicht gleichzeitig verarbeitet, sondern nacheinander gemeldet.',
    'Grappe ist keine parallele Ausführungs-Engine; es meldet nur jede Partition nach Abschluss.',
    'Las particiones no se procesan en paralelo: Grappe informa cada una al completarse.',
    'Grappe no ejecuta nada de forma simultánea.',
    'As partições não são processadas em paralelo; o Grappe informa cada uma ao concluí-la.',
    'O Grappe não executa nada simultaneamente.',
    'Grappe はパーティションを並列に処理しません。完了ごとに報告するだけです。',
    'Grappe が処理を同時に実行することはありません。',
    // The same denial written the way each language actually writes it: the
    // elided phrase, the contracted preposition, the nominal form. Every one of
    // these was refused before the negation class was widened, two per language.
    'Seed writes its partitions in sequence, in place of the parallel worker pool the page once promised.',
    'Grappe walks the partitions one by one, sequentially instead — the concurrency it advertised was withdrawn.',
    "Grappe traite les partitions l'une après l'autre, plutôt qu'en parallèle.",
    "Grappe rend compte partition par partition, au lieu d'une exécution en parallèle.",
    "Le parallélisme annoncé n'existe plus : chaque partition est signalée à sa fin.",
    'Die Partitionen werden nacheinander geschrieben, anstelle einer parallelen Ausführung.',
    'Grappe verarbeitet die Partitionen keinesfalls gleichzeitig.',
    'Las particiones se escriben una tras otra, en lugar del motor paralelo que se anunciaba.',
    'Grappe procesa las particiones de una en una, en vez de hacerlo de forma simultánea.',
    'As partições são gravadas uma após a outra, em vez do processamento paralelo prometido.',
    'O Grappe relata cada partição ao concluí-la, em lugar da execução simultânea.',
    'Grappe は並列実行の代わりに、パーティションごとの進捗を報告します。',
    'Grappe は同時実行なしで、パーティションごとに結果を報告します。',
    // The ordinary phrases, denied the way each language denies them.
    'Grappe does not write the partitions at once: it reports each one as it completes.',
    "Grappe n'écrit pas les partitions en même temps.",
    'Grappe schreibt die Partitionen nicht auf einmal.',
    'Grappe no escribe las particiones al mismo tiempo.',
    'O Grappe não grava as partições ao mesmo tempo.',
    'Grappe はパーティションを一度に書き込みません。',
    'With Grappe enabled and a source counted at or above sandforge.grappe.autoActivateThreshold records, the run reports progress one partition per object over that same sequential loop -- nothing is split and nothing runs concurrently.',
  ];
  assert.deepEqual(
    honest.filter(
      (text) =>
        republishedClaims(text, grappeClaims()).length > 0 ||
        parallelAssertions(text).length > 0 ||
        ordinaryConcurrencyAssertions(text).length > 0,
    ),
    [],
    'the Grappe rules flag these honest sentences — a gate that refuses a true sentence gets ' +
      'weakened by hand, which costs more than the coverage it buys',
  );
});

test('no user-facing surface claims nothing activates Grappe', () => {
  // The opposite error, shipped in the same table row: Seed, Sync and Autopilot
  // all set `grappeActive`, so "no operation activates it" is equally false.
  assertAutopilotOnlyBracketsTheRun();

  const offenders = [];
  for (const { label, text } of grappeUnits()) {
    if (/no operation activates/i.test(text)) {
      offenders.push(`${label}: ${text.trim().slice(0, 120)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'these lines deny an activation that happens:\n  ' + offenders.join('\n  '),
  );
});

/**
 * A line that names Autopilot beside partitioned reporting has to say the
 * autopilot path reports only its start and its end, in the words each
 * language publishes. The Settings row for `sandforge.grappe.enabled` once
 * listed "Seed, Sync and Autopilot runs partition by partition" two rows below
 * a module row that said the opposite, and no rule read that cell.
 */
const AUTOPILOT_BRACKET_ONLY =
  /only (?:its |the )?start and (?:its |the )?end|ne signale que (?:son|le) début|nur (?:seinen )?Beginn|開始と終了(?:の|だけ)|solo (?:informa )?(?:su |el )?inicio|apenas (?:seu |o )?início/iu;
const NAMES_PARTITIONED_REPORTING = /partition|partici|partiç|パーティション/iu;

const autopilotPartitionOverclaims = (units) =>
  units.filter(
    ({ text }) =>
      /autopilot/i.test(text) &&
      NAMES_PARTITIONED_REPORTING.test(text) &&
      !AUTOPILOT_BRACKET_ONLY.test(text),
  );

test('the autopilot rule refuses the settings row that shipped and leaves the qualified one alone', () => {
  assert.equal(
    autopilotPartitionOverclaims([
      {
        text: '| `sandforge.grappe.enabled` | Report large Seed, Sync and Autopilot runs partition by partition; execution stays sequential | `false` |',
      },
    ]).length,
    1,
    'the rule lets through the row that published per-partition reporting for Autopilot',
  );
  assert.deepEqual(
    autopilotPartitionOverclaims([
      {
        text: '| `sandforge.grappe.enabled` | Report large Seed and Sync runs partition by partition (an Autopilot run reports only its start and end); execution stays sequential | `false` |',
      },
    ]),
    [],
    'the rule refuses the qualified row',
  );
});

test('no user-facing surface says an autopilot run is reported partition by partition', () => {
  assertAutopilotOnlyBracketsTheRun();

  const offenders = autopilotPartitionOverclaims(grappeUnits()).map(
    ({ label, text }) => `${label}: ${text.trim().slice(0, 140)}`,
  );
  assert.deepEqual(
    offenders,
    [],
    'an autopilot run reports only its start and its end, and these lines put it beside ' +
      'per-partition reporting without saying so:\n  ' +
      offenders.join('\n  '),
  );
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

const SYNC_PAGE_FILE = 'packages/webview/src/pages/Sync/SyncPage.tsx';

/**
 * The Sync page offers the tabs `OFFERED_SYNC_TABS` lists, and Real-Time is not
 * one of them: the CDC panel, its strings and its store stay in the tree, and
 * no reader reaches them. That is what lets the CDC rule leave `sync.realtime.*`
 * unread — offer the tab again and this trips before the strings go on screen.
 */
function assertRealtimeTabIsNotOffered() {
  let tabs = null;
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'OFFERED_SYNC_TABS' &&
      node.initializer &&
      ts.isArrayLiteralExpression(unwrap(node.initializer))
    ) {
      tabs = unwrap(node.initializer)
        .elements.filter(ts.isStringLiteralLike)
        .map((element) => element.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parseFile(SYNC_PAGE_FILE));
  // Positive control: the walk reads the list, and the tab that is offered.
  assert.ok(
    tabs?.includes('sync'),
    `${SYNC_PAGE_FILE} no longer declares OFFERED_SYNC_TABS with the sync tab in it — the walk ` +
      'reads nothing, so the absence below proves nothing',
  );
  assert.equal(
    tabs.includes('realtime'),
    false,
    'the Sync page offers the Real-Time tab again — its sync.realtime.* strings are on screen, and ' +
      'the CDC rule has to read them before this is relaxed',
  );
}

test('anchor: the Sync page does not offer the Real-Time tab', () => {
  assertRealtimeTabIsNotOffered();
});

const CDC_WORD = /\bCDC\b|change data capture/i;

/**
 * What marks the gap, in the six languages, built from what the surfaces
 * actually say: the first cut matched only English and flagged four correct
 * translations, and the next read "not implemented" and nothing else — which
 * refused `docs/modules/sync.md` ("mode selection returns when incremental,
 * delta, and CDC are implemented", and now "is refused before it runs").
 */
const CDC_DISCLAIMER = [
  /coming soon|not (?:yet )?(?:wired|available|implemented|shown|offered)|no-op|\brefused\b|\breturns? when\b.*\bimplemented\b/i,
  /n['’](?:est|sont) pas impl|ne sont pas impl|pas encore|refus/i,
  /nicht implementiert|abgelehnt/i,
  /no est[áa]n? implementad|rechaza/i,
  /n[ãa]o est[ãa]o? implementad|recusad/i,
  /未実装/,
];

/** The panel the Sync page does not offer; see {@link assertRealtimeTabIsNotOffered}. */
const UNOFFERED_CDC_KEY = /^locales\/\S+ sync\.realtime\./;

/**
 * The mode labels are rendered on screens that are offered — a run's history
 * detail, the template picker — so they are read like any string, and only the
 * mode's bare name is a label rather than a claim.
 */
const CDC_MODE_KEY = /^locales\/\S+ sync\.modes\./;
const BARE_CDC_NAME = /^\s*(?:CDC|Change Data Capture)\s*$/i;

/**
 * Where a disclaimer has to sit: in the sentence, clause or list item that
 * names CDC. Read over the whole string, "refused" about a rejected record or a
 * neighbouring bullet's "not implemented" cleared a promise beside it.
 */
const CDC_CLAUSE = /(?<=[.!?…])\s+|[。！？；;\n]+/u;

/** The units that name CDC with nothing marking it as unbuilt, as `label: text`. */
function cdcPromises(units) {
  return units
    .filter(
      ({ label, text }) =>
        !UNOFFERED_CDC_KEY.test(label) &&
        !(CDC_MODE_KEY.test(label) && BARE_CDC_NAME.test(text)) &&
        text
          .split(CDC_CLAUSE)
          .some(
            (clause) =>
              CDC_WORD.test(clause) && !CDC_DISCLAIMER.some((pattern) => pattern.test(clause)),
          ),
    )
    .map(({ label, text }) => `${label}: ${text.trim().slice(0, 140)}`);
}

test('no user-facing surface sells CDC as a working sync mode', () => {
  assertRealtimeTabIsNotOffered();

  // `help.syncContent` promised "4 sync modes: Full, Incremental, Delta, CDC"
  // in six languages, for a mode the extension answers with `comingSoon: true`.
  // The same promise on a README, a module page, a setting or a notification is
  // the same defect, so every surface is read.
  const units = userFacingProse();
  const naming = units.filter(({ text }) => CDC_WORD.test(text));
  // Positive control: the walk sees the disclaimers that name CDC today — the
  // Sync module page and the help panel in six languages.
  assert.ok(
    naming.some(({ label }) => label === 'docs/modules/sync.md') &&
      naming.filter(({ label }) => / help\.syncContent$/.test(label)).length >= 6,
    'the walk no longer sees CDC named in docs/modules/sync.md and the six help.syncContent — it ' +
      'is not reading those surfaces, so an empty result below proves nothing',
  );
  const offenders = cdcPromises(units);
  assert.deepEqual(
    offenders,
    [],
    'these surfaces sell a sync mode that is a registered no-op:\n  ' + offenders.join('\n  '),
  );
});

test('the CDC rule refuses a promise on any surface and leaves a disclaimer alone', () => {
  const refused = [
    {
      label: 'packages/extension/package.nls.json config.sync.mode.description',
      text: 'Sync mode: Full, Incremental, Delta or CDC.',
    },
    { label: 'docs/modules/sync.md', text: '- **Near real-time** -- CDC keeps the target in step' },
    {
      label: 'README.md',
      text: '| **Sync** | Change Data Capture streams every change to the target |',
    },
    {
      label: 'locales/fr.json help.syncContent',
      text: '- 4 modes : Complet, Incrémental, Delta, CDC',
    },
    { label: 'docs/faq.md', text: 'Start a CDC stream to see metrics.' },
    {
      label: 'packages/extension/l10n/bundle.l10n.json Sync',
      text: 'CDC is running: changes replay as they happen.',
    },
    // A disclaimer word about something else, beside the promise.
    {
      label: 'docs/faq.md',
      text: 'Sync streams every change with CDC; a record the target rejects is refused and logged.',
    },
    {
      label: 'locales/en.json help.syncContent',
      text: '- Full sync only (incremental and delta are not implemented)\n- CDC keeps the target org in step with every change',
    },
    {
      label: 'docs/faq.md',
      text: 'CDC keeps the target in step. Delta mode is not implemented yet.',
    },
    // A mode label that says more than the mode's name.
    { label: 'locales/en.json sync.modes.cdc', text: 'CDC — near real-time streaming' },
  ];
  assert.deepEqual(
    refused.filter((unit) => cdcPromises([unit]).length === 0).map((unit) => unit.text),
    [],
    'these sell CDC on a surface a reader meets, and the rule lets them through',
  );

  const honest = [
    {
      label: 'docs/modules/sync.md',
      text: '- **Full Sync Only** -- Every run syncs the complete object set; a configuration asking for incremental, delta or CDC is refused before it runs',
    },
    {
      label: 'docs/modules/sync.md',
      text: '- mode selection returns when incremental, delta, and CDC are implemented',
    },
    {
      label: 'docs/modules/sync.md',
      text: '- **No real-time sync** -- Real-time (CDC) replication is not implemented, so its tab is not shown',
    },
    {
      label: 'locales/de.json help.syncContent',
      text: '- Nur Vollsynchronisierung (Inkrementell, Delta und CDC sind nicht implementiert)',
    },
    {
      label: 'locales/ja.json help.syncContent',
      text: '（インクリメンタル、デルタ、CDC は未実装です）',
    },
    // The hidden panel's own strings, for as long as the tab is not offered.
    {
      label: 'locales/en.json sync.realtime.metricsPanel.noMetrics',
      text: 'Start a CDC stream to see metrics.',
    },
    { label: 'locales/en.json sync.modes.cdc', text: 'CDC' },
    {
      label: 'locales/en.json help.syncContent',
      text: 'Sync data between two Salesforce orgs:\n- Full sync only: every run replays the whole object set (incremental, delta and CDC are not implemented)\n- Auto field mapping with confidence scores',
    },
  ];
  assert.deepEqual(
    honest.filter((unit) => cdcPromises([unit]).length > 0).map((unit) => unit.text),
    [],
    'the CDC rule refuses these honest sentences',
  );
});

// ── In-app help: features the product does not have ───────────────────────

/**
 * The bundle keys a reader meets as the Help page (`help.*`, one bullet per
 * line) and as the DataOps welcome (`dataops.emptyState.*`).
 */
const HELP_KEYS = /^help\./;
const HELP_AND_DATAOPS_WELCOME_KEYS = /^(?:help\.|dataops\.emptyState\.)/;

/**
 * Every non-empty line of the keys a rule reads, in the six bundles, with the
 * bundle's own `common.comingSoon` — the one disclaimer these rules accept, and
 * only where the gap is on the roadmap.
 */
function helpLines(keys) {
  const lines = [];
  for (const file of localeFiles()) {
    const bundle = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8'));
    const comingSoon = bundle.common?.comingSoon;
    assert.ok(
      typeof comingSoon === 'string' && comingSoon.trim() !== '',
      `locales/${file} has no common.comingSoon — the disclaimer these rules accept is missing, ` +
        'so an honest "coming soon" line would be refused',
    );
    for (const [key, value] of jsonStrings(bundle)) {
      if (!keys.test(key)) continue;
      for (const line of value.split('\n')) {
        if (line.trim() !== '') lines.push({ label: `locales/${file} ${key}`, line, comingSoon });
      }
    }
  }
  return lines;
}

/** Every string literal written in the shipped source under a root, JSX attribute values included. */
const literalCache = new Map();
function stringLiteralsUnder(root) {
  if (literalCache.has(root)) return literalCache.get(root);
  const literals = new Set();
  for (const file of sourceFilesUnder(join(repoRoot, ...root.split('/')))) {
    const visit = (node) => {
      if (ts.isStringLiteralLike(node)) literals.add(node.text);
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true));
  }
  literalCache.set(root, literals);
  return literals;
}

/** The `data-testid` of every `<ComingSoon>` a page mounts, sorted. */
function comingSoonMounts(relativePath) {
  const source = parseFile(relativePath);
  const ids = [];
  const visit = (node) => {
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      node.tagName.getText(source) === 'ComingSoon'
    ) {
      for (const attribute of node.attributes.properties) {
        if (
          ts.isJsxAttribute(attribute) &&
          attribute.name.getText(source) === 'data-testid' &&
          attribute.initializer &&
          ts.isStringLiteral(attribute.initializer)
        ) {
          ids.push(attribute.initializer.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return ids.sort();
}

const SHIPPED_SOURCE_ROOTS = [
  'packages/extension/src',
  'packages/shared/src',
  'packages/webview/src',
];
const DATAOPS_PAGE_FILE = 'packages/webview/src/pages/DataOps/DataOpsPage.tsx';
const COMPARE_PAGE_FILE = 'packages/webview/src/pages/Compare/ComparePage.tsx';

/** Whether an initializer is `false`, or a schema default of `false`: `z.boolean().default(false)`. */
function isFalseValue(expression) {
  const node = unwrap(expression);
  if (node.kind === ts.SyntaxKind.FalseKeyword) return true;
  return (
    ts.isCallExpression(node) &&
    invokedName(node.expression) === 'default' &&
    node.arguments.length === 1 &&
    unwrap(node.arguments[0]).kind === ts.SyntaxKind.FalseKeyword
  );
}

/**
 * `enableRollback` is declared on the sync config and written `false` at every
 * call site — the Sync page, Quick Sync, both migration importers — and read by
 * nothing. So a sync run keeps no restore point, and the Help page that taught
 * "enable Rollback before executing" described a switch no screen shows and no
 * code consults.
 */
function assertNothingReadsEnableRollback() {
  const writes = [];
  const others = [];
  for (const root of SHIPPED_SOURCE_ROOTS) {
    for (const file of sourceFilesUnder(join(repoRoot, ...root.split('/')))) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node) => {
        if (
          (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
          node.text === 'enableRollback'
        ) {
          const { parent } = node;
          const at = `${toRepoPath(file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
          if (ts.isPropertySignature(parent) && parent.name === node) {
            // A type naming the field reads nothing.
          } else if (
            ts.isPropertyAssignment(parent) &&
            parent.name === node &&
            isFalseValue(parent.initializer)
          ) {
            writes.push(at);
          } else {
            others.push(at);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  // Positive control: the walk sees the four call sites that write it.
  assert.ok(
    writes.length >= 4,
    `the scan found ${writes.length} places writing enableRollback: false, fewer than the four ` +
      'call sites that do — it is not reading them, so the empty list below proves nothing',
  );
  assert.deepEqual(
    others,
    [],
    'enableRollback is now read or set to something other than false — a sync may keep a restore ' +
      'point. Re-read help.syncContent and help.faqContent in six locales before relaxing this:\n  ' +
      others.join('\n  '),
  );
}

/** The manifest declares one timeout, for a pipeline run; none for a Salesforce call. */
function assertNoApiTimeoutSetting() {
  const { configuration } = JSON.parse(read(...EXT, 'package.json')).contributes;
  const sections = Array.isArray(configuration) ? configuration : [configuration];
  const keys = sections.flatMap((section) => Object.keys(section.properties ?? {}));
  assert.ok(
    keys.length >= 12,
    `the walk found ${keys.length} settings in the manifest, fewer than the 16 it declares — it ` +
      'has stopped reading them',
  );
  assert.deepEqual(
    keys.filter((key) => /timeout/i.test(key)),
    ['sandforge.pipeline.timeout'],
    'the manifest now declares another timeout setting — an API timeout may exist. Re-read ' +
      'help.faqContent and help.troubleshootingContent before relaxing this.',
  );
}

/** No channel deploys a Compare diff, and the Deploy tab says so. */
function assertCompareDeploysNothing() {
  const channels = SHIPPED_SOURCE_ROOTS.flatMap((root) => [...stringLiteralsUnder(root)]);
  assert.ok(
    channels.includes('compare:drift'),
    'the literal scan does not see compare:drift, a channel that exists — it is not reading ' +
      'channel names, so the absence below proves nothing',
  );
  assert.deepEqual(
    channels.filter((literal) => literal.startsWith('compare:deploy')),
    [],
    'a compare:deploy channel exists — Deploy from Diff may be wired. Re-read help.compareContent ' +
      'in six locales before relaxing this.',
  );
  assert.deepEqual(
    comingSoonMounts(COMPARE_PAGE_FILE),
    ['compare-deploy-soon'],
    'ComparePage no longer mounts exactly the Deploy tab as coming soon',
  );
}

const SCHEMAS_FILE = 'packages/shared/src/bridge/messageSchemas.ts';

/** The channel literals a file hands to every `name(…)` call, as a list or on their own. */
function channelsPassedTo(relativePath, name) {
  return callsWithin(parseFile(relativePath))
    .filter((call) => call.name === name && call.args.length > 0)
    .flatMap(({ args }) => {
      const first = unwrap(args[0]);
      const channels = ts.isArrayLiteralExpression(first) ? first.elements : [first];
      return channels.filter(ts.isStringLiteralLike).map((channel) => channel.text);
    });
}

/**
 * Pipelines start by hand: no `scheduler:*` channel is routed or declared. The
 * four that once were reached only the no-op handler, and no screen sent them.
 */
function assertNoPipelineScheduler() {
  for (const [file, channels] of [
    [HANDLERS_FILE, channelsPassedTo(HANDLERS_FILE, 'route')],
    [SCHEMAS_FILE, channelsPassedTo(SCHEMAS_FILE, 'msg')],
  ]) {
    // Positive control: the walk reads the Sync schedules, which are there.
    assert.ok(
      channels.includes('sync:schedule:upsert'),
      `the walk does not see sync:schedule:upsert in ${file}, where it is — it is not reading ` +
        'channels, so the absence below proves nothing',
    );
    assert.deepEqual(
      channels.filter((channel) => channel.startsWith('scheduler:')),
      [],
      `${file} carries a scheduler:* channel again — pipelines may start on a timer. Re-read ` +
        'help.automationContent and help.dataopsContent before relaxing this.',
    );
  }
}

/** Compliance and Cleanup are the two DataOps tabs mounted as coming soon. */
function assertDataOpsTabsAreComingSoon() {
  // Positive control: the same walk reads the Deploy tab out of ComparePage.
  assert.deepEqual(comingSoonMounts(COMPARE_PAGE_FILE), ['compare-deploy-soon']);
  assert.deepEqual(
    comingSoonMounts(DATAOPS_PAGE_FILE),
    ['dataops-cleanup-soon', 'dataops-gdpr-soon'],
    'DataOpsPage no longer mounts Compliance and Cleanup as coming soon — one of them may be ' +
      'built. Re-read help.dataopsContent and dataops.emptyState in six locales.',
  );
}

/**
 * The Quality tab runs three checks — fill counts, repeated values, stale
 * records — and names them in the one type every check's error carries. No
 * format, range or referential check exists, so no count of rule types that
 * includes them is true.
 */
function assertQualityScanRunsThreeChecks() {
  const typesFile = 'packages/shared/src/types/dataops.types.ts';
  const source = ts.createSourceFile(typesFile, read(typesFile), ts.ScriptTarget.Latest, true);
  const error = source.statements.find(
    (node) => ts.isInterfaceDeclaration(node) && node.name.text === 'DataQualityCheckError',
  );
  assert.ok(error, `DataQualityCheckError is no longer declared in ${typesFile}`);
  const check = error.members.find((member) => member.name?.getText(source) === 'check');
  assert.ok(
    check?.type && ts.isUnionTypeNode(check.type),
    'DataQualityCheckError.check is no longer the union of the checks a scan runs — re-point this',
  );
  const checks = check.type.types.map((type) => type.getText(source).replace(/'/g, '')).sort();
  // Positive control: the walk reads the check the fill counts report under.
  assert.ok(
    checks.includes('fill'),
    `the walk read ${checks.join(', ')} from DataQualityCheckError — not the checks a scan ` +
      'runs, so the check below proves nothing',
  );
  assert.deepEqual(
    checks,
    ['duplicates', 'fill', 'stale'],
    'the quality scan runs another check — it may test formats or ranges now. Re-read ' +
      'help.dataopsContent in six locales before relaxing this.',
  );
}

/** Ctrl+Enter used to broadcast `sandforge:execute`, and nothing ever listened. */
function assertNothingRunsOnCtrlEnter() {
  const literals = stringLiteralsUnder('packages/webview/src');
  assert.ok(
    literals.has('help-search'),
    'the literal scan does not see the Help page search box — it is not reading the webview',
  );
  assert.equal(
    literals.has('sandforge:execute'),
    false,
    'the webview names sandforge:execute again — Ctrl+Enter may run something. Re-read ' +
      'help.shortcutsContent in six locales before relaxing this.',
  );
}

/**
 * What the Help page taught through v1.22, in six languages, and the code that
 * says it is false. Each rule is a vocabulary over the keys it names, refused
 * line by line. A line that carries the bundle's `common.comingSoon` passes the
 * rules whose gap is on the roadmap; a rollback, a timeout setting, a Grappe
 * speed-up and a shortcut nothing handles are not, so nothing excuses them.
 *
 * `shipped` is the wording each rule was written against, and `honest` what a
 * true page says instead; the self-test below holds the vocabulary to both.
 *
 * What these rules do not see, one limit per line:
 *  - They read `help.*`, and `dataops.emptyState.*` for the DataOps rule, in the six locale bundles. The same promise on a README, a module page or a walkthrough is left to the rules above and to the module gates.
 *  - A vocabulary, not a meaning: "a sync can be reversed" passes the rollback rule, and any paraphrase that avoids a rule's words passes it.
 *  - A line carrying its bundle's "Coming soon" passes a disclaimable rule whatever else it says.
 *  - Ctrl+1..9/0 has no code anchor: VS Code decides whether the keystroke reaches the webview, and nothing in this repository can read that. The rule stands on the note in `PanelApp.tsx`.
 *  - The pipeline-start rule's anchor reads channel names only: no `scheduler:*` channel is routed or declared. A scheduler wired under another name, or one that fires a pipeline's triggers from the host with no channel, is not seen. Webhook and event triggers have no executor either, and nothing here reads that absence.
 *  - The DataOps and Compare anchors read `<ComingSoon>` mounts by test id. A tab that renders a real panel under the same id is not seen.
 *  - The quality-scan anchor reads the checks `DataQualityCheckError` names. A check that reports its failures some other way is not seen.
 */
const HELP_CLAIM_RULES = [
  {
    name: 'a sync rollback or restore point',
    keys: HELP_KEYS,
    pattern:
      /roll-?back|restore point|point de restauration|wiederherstellungspunkt|punto de restauraci[óo]n|ponto de restaura[çc][ãa]o|ロールバック|復元ポイント/iu,
    disclaimable: false,
    anchor: assertNothingReadsEnableRollback,
    shipped: [
      '- Rollback support for safe operations',
      'A: Yes, enable Rollback before executing. SandForge creates a restore point.',
      '- Support du rollback pour des opérations sécurisées',
      "R : Oui, activez le Rollback avant l'exécution. SandForge crée un point de restauration.",
      '- Rollback-Unterstuetzung fuer sichere Operationen',
      'A: Ja, aktivieren Sie Rollback vor der Ausfuehrung. SandForge erstellt einen Wiederherstellungspunkt.',
      '- Soporte de rollback para operaciones seguras',
      'R: Si, habilite Rollback antes de ejecutar. SandForge crea un punto de restauracion.',
      '- Suporte a rollback para operacoes seguras',
      'R: Sim, habilite o Rollback antes de executar. O SandForge cria um ponto de restauracao.',
      '- 安全な操作のためのロールバックサポート',
      'A：はい、実行前にロールバックを有効にしてください。SandForgeが復元ポイントを作成します。',
    ],
    honest: [
      'A: No. A sync run cannot be reversed.',
      '- Restore: puts a backup back, whole, into the org it was taken from',
    ],
  },
  {
    name: 'an API timeout setting',
    keys: HELP_KEYS,
    pattern: /api[- ]?timeout|timeout (?:de |d'|da )?(?:l'|la )?api\b|api\s*タイムアウト/iu,
    disclaimable: false,
    anchor: assertNoApiTimeoutSetting,
    shipped: [
      'A: Increase API timeout in Settings > Advanced. For large datasets, enable Grappe mode.',
      '- Increase API timeout in Settings > Advanced',
      '- Augmentez le timeout API dans Paramètres > Avancé',
      '- Erhöhen Sie das API-Timeout in Einstellungen > Erweitert',
      '- Aumente el timeout de API en Configuración > Avanzado',
      '- Aumente o timeout de API em Configurações > Avançado',
      '- 設定 > 詳細設定でAPIタイムアウトを増やしてください',
    ],
    honest: ['A: SandForge has no timeout setting for Salesforce calls.'],
  },
  {
    name: 'Grappe mode as the cure for a slow run',
    keys: HELP_KEYS,
    pattern: /grappe[- ]?(?:mode|modus)|mode grappe|modo grappe|grappe\s*モード/iu,
    disclaimable: false,
    anchor: assertSeedPartitionsAndReportsEachOne,
    shipped: [
      '- Enable Grappe mode for large datasets',
      '- Activez le mode Grappe pour les gros volumes',
      '- Aktivieren Sie den Grappe-Modus für große Datenmengen',
      '- Habilite el modo Grappe para datasets grandes',
      '- Habilite o modo Grappe para grandes volumes de dados',
      '- 大規模データセットにはGrappeモードを有効にしてください',
    ],
    honest: ['Grappe does not make a run faster: it reports progress per partition.'],
  },
  {
    name: 'deploying from a Compare diff, or an impact graph',
    keys: HELP_KEYS,
    pattern:
      /deploy(?:ment)?s? directly|déploiement direct|direkte bereitstellung|despliegue directo|implanta[çc][ãa]o direta|直接デプロイ|impact analysis|analyse d'impact|auswirkungsanalyse|an[áa]lisis de impacto|an[áa]lise de impacto|影響分析/iu,
    disclaimable: true,
    anchor: assertCompareDeploysNothing,
    shipped: [
      '- Impact analysis graph',
      '- Deploy directly from diff results',
      "- Graphe d'analyse d'impact",
      '- Déploiement direct depuis les résultats',
      '- Auswirkungsanalyse-Diagramm',
      '- Direkte Bereitstellung aus Diff-Ergebnissen',
      '- Grafico de analisis de impacto',
      '- Despliegue directo desde resultados de diferencias',
      '- Grafico de analise de impacto',
      '- Implantacao direta a partir dos resultados de diferenca',
      '- 影響分析グラフ',
      '- 差分結果からの直接デプロイ',
    ],
    honest: [
      '- Deploy: coming soon, nothing is deployed from a diff yet',
      '- Diff viewer grouped by category and risk level',
    ],
  },
  {
    name: 'pipelines or backups started by a schedule, a webhook or a trigger',
    keys: HELP_KEYS,
    pattern:
      /schedul|webhook|\bcron\b|planifi|zeitpl(?:a|ä|ae)n|programaci[óo]n|agendament|スケジュール|trigger|d[ée]clencheur|ausl(?:ö|oe)ser|disparador|gatilho|トリガー/iu,
    disclaimable: true,
    anchor: assertNoPipelineScheduler,
    shipped: [
      '- Backup & Restore with scheduling',
      '- 6 trigger types including schedules and webhooks',
      '- Sauvegarde & Restauration avec planification',
      '- 6 types de déclencheurs dont planification et webhooks',
      '- Sicherung & Wiederherstellung mit Zeitplanung',
      '- 6 Ausloesertypen einschliesslich Zeitplaene und Webhooks',
      '- Respaldo y restauracion con programacion',
      '- 6 tipos de disparadores incluyendo programacion y webhooks',
      '- Backup e restauracao com agendamento',
      '- 6 tipos de gatilhos incluindo agendamento e webhooks',
      '- スケジュール付きバックアップとリストア',
      '- スケジュールとWebhookを含む6つのトリガータイプ',
    ],
    honest: ['- Pipelines start by hand, from the Run button; nothing else starts one yet'],
  },
  {
    name: 'DataOps tabs that are not built: DSR, cleanup, mass delete',
    keys: HELP_AND_DATAOPS_WELCOME_KEYS,
    pattern:
      /\bDSR\b|data subject request|sujets de donn[ée]es|betroffenenanfrage|titulares de datos|titulares de dados|データ主体|clean(?:s|ing)? ?up|nettoi|nettoy|bereinig|limpi|limpa\b|limpez|クリーンアップ|mass delete|en masse|massenl(?:ö|oe)sch|eliminaci[óo]n masiva|em massa|一括削除|storage optimi|optimisation du stockage|speicheroptimierung|optimizaci[óo]n de almacenamiento|otimiza[çc][ãa]o de armazenamento|ストレージ最適化/iu,
    disclaimable: true,
    anchor: assertDataOpsTabsAreComingSoon,
    shipped: [
      '- Mass delete and storage optimization',
      '- Data Subject Request (DSR) management',
      'DataOps backs up, restores, anonymizes and cleans up your org data — with GDPR tooling and quality dashboards built in.',
      'Schedule cleanups and track data quality',
      '- Suppression en masse et optimisation du stockage',
      '- Gestion des demandes de sujets de données (DSR)',
      'Planifiez les nettoyages et suivez la qualité des données',
      '- Massenloeschung und Speicheroptimierung',
      '- Verwaltung von Betroffenenanfragen (DSR)',
      '- Eliminacion masiva y optimizacion de almacenamiento',
      'DataOps respalda, restaura, anonimiza y limpia los datos de su org — con herramientas GDPR y paneles de calidad integrados.',
      '- Exclusao em massa e otimizacao de armazenamento',
      'O DataOps faz backup, restaura, anonimiza e limpa os dados da sua org — com ferramentas GDPR e painéis de qualidade integrados.',
      '- 一括削除とストレージ最適化',
      '- データ主体リクエスト（DSR）管理',
      'クリーンアップを計画しデータ品質を追跡',
    ],
    honest: [
      '- Compliance and Cleanup: coming soon, nothing runs behind these tabs yet',
      '- Anonymize: masks fields in place with the built-in GDPR, CCPA and HIPAA templates',
      'Restore a backup into the org it was taken from',
      '- Quality: for the objects you pick, counts how often each field is filled, which values of a key such as Name or Email more than one record shares, and how many records nobody has modified in a number of days; the org does the counting, and nothing is read record by record or written',
    ],
  },
  {
    name: 'a quality scan of seven rule types',
    keys: HELP_AND_DATAOPS_WELCOME_KEYS,
    pattern:
      /\b7\s*(?:rule types|types de r[èe]gles|regeltypen|tipos de reglas|tipos de regras)|7\s*つのルールタイプ/iu,
    disclaimable: false,
    anchor: assertQualityScanRunsThreeChecks,
    shipped: [
      '- Data quality scanning with 7 rule types',
      '- Scan de qualité des données avec 7 types de règles',
      '- Datenqualitaets-Scan mit 7 Regeltypen',
      '- Escaneo de calidad de datos con 7 tipos de reglas',
      '- Escaneamento de qualidade de dados com 7 tipos de regras',
      '- 7つのルールタイプによるデータ品質スキャン',
    ],
    honest: [
      '- Quality: for the objects you pick, counts how often each field is filled, which values of a key such as Name or Email more than one record shares, and how many records nobody has modified in a number of days; the org does the counting, and nothing is read record by record or written',
      '- 品質：選択したオブジェクトについて、各項目の入力件数、Name や Email などのキーで複数のレコードが共有する値、指定した日数のあいだ誰も更新していないレコード数を数えます。数えるのは Org 自身で、レコードを 1 件ずつ読むことも書き込むこともありません',
    ],
  },
  {
    name: 'a Ctrl shortcut nothing handles: Ctrl+1..9/0 or Ctrl+Enter',
    keys: HELP_KEYS,
    pattern: /(?:ctrl|strg|cmd|⌘)\s*\+\s*(?:\d|enter|entr[ée]e|eingabe|intro)/iu,
    disclaimable: false,
    anchor: assertNothingRunsOnCtrlEnter,
    shipped: [
      'Ctrl+1..9/0 — Jump to a module (Monitor, Seed, Sync, Compare, DataOps, Automation, Grappe, Autopilot, Migration, Forge)',
      'Ctrl+Enter — Run the current action',
      "Ctrl+Entrée — Exécuter l'action courante",
      'Strg+1..9/0 — Zu einem Modul springen (Monitor, Seed, Sync, Compare, DataOps, Automation, Grappe, Autopilot, Migration, Forge)',
      'Strg+Eingabe — Aktuelle Aktion ausfuehren',
      'Ctrl+1..9/0 — モジュールへ移動 (Monitor, Seed, Sync, Compare, DataOps, Automation, Grappe, Autopilot, Migration, Forge)',
    ],
    honest: ['Ctrl+K — Command palette', 'G + letter — Jump to a module (e.g. G then F for Forge)'],
  },
];

/** Whether a line sells what the rule refuses, given the disclaimer its own bundle writes. */
const helpLineOffends = (rule, line, comingSoon) =>
  rule.pattern.test(line) &&
  !(rule.disclaimable && line.toLowerCase().includes(comingSoon.toLowerCase()));

for (const rule of HELP_CLAIM_RULES) {
  test(`anchor: the in-app help rule on ${rule.name} still reads true code`, () => {
    rule.anchor();
  });
}

test('the in-app help teaches no feature the product does not have', () => {
  const offenders = [];
  for (const rule of HELP_CLAIM_RULES) {
    rule.anchor();
    const lines = helpLines(rule.keys);
    // Positive control: six bundles of Help text are being read, not an empty walk.
    assert.ok(
      lines.length >= 6 * 40,
      `the walk found ${lines.length} lines of help text across the locales — it has stopped ` +
        'reading them, so an empty result below proves nothing',
    );
    for (const { label, line, comingSoon } of lines) {
      if (helpLineOffends(rule, line, comingSoon)) {
        offenders.push(`${label} — ${rule.name}: ${line.trim().slice(0, 140)}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'the in-app help teaches these features, and the code above says they do not exist:\n  ' +
      offenders.join('\n  '),
  );
});

test('the help rules refuse what shipped and leave an honest rewrite alone', () => {
  const markers = localeFiles().map(
    (file) => JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8')).common.comingSoon,
  );
  const refusedBy = (rule, text) => markers.every((marker) => helpLineOffends(rule, text, marker));
  const passedBy = (rule, text) => markers.some((marker) => !helpLineOffends(rule, text, marker));

  assert.deepEqual(
    HELP_CLAIM_RULES.flatMap((rule) =>
      rule.shipped.filter((text) => !refusedBy(rule, text)).map((text) => `${rule.name}: ${text}`),
    ),
    [],
    'these lines shipped in the Help page and the rule written against them lets them through',
  );
  assert.deepEqual(
    HELP_CLAIM_RULES.flatMap((rule) =>
      rule.honest.filter((text) => !passedBy(rule, text)).map((text) => `${rule.name}: ${text}`),
    ),
    [],
    'the help rules refuse these true sentences — a gate that refuses the honest rewrite gets ' +
      'weakened by hand',
  );
  // A coming-soon marker excuses only a gap that is on the roadmap.
  assert.equal(
    refusedBy(HELP_CLAIM_RULES[0], '- Rollback support: coming soon'),
    true,
    'a coming-soon marker now excuses a rollback, which nothing plans',
  );
});

// ── Production Guard: a log kept for the session, not a trail ─────────────

const PRODUCTION_GUARD_FILE = 'packages/extension/src/core/precheck/ProductionGuard.ts';

/**
 * Production Guard records each safety-check decision in `auditLog`, an array
 * field capped at 1 000 entries, and imports nothing: no file, no storage URI,
 * no channel. So the log ends with the window, and nothing can read it back
 * afterwards — which is what "audit trail" promises and what
 * `docs/modules/frozen-dataset.md` said every Frozen Dataset write left behind.
 *
 * Fails in both directions: give the guard somewhere to write, and the import
 * check trips before "kept in memory for the session" goes stale.
 */
function assertGuardLogStaysInMemory() {
  const source = parseFile(PRODUCTION_GUARD_FILE);
  const guard = source.statements.find(
    (node) => ts.isClassDeclaration(node) && node.name?.text === 'ProductionGuard',
  );
  assert.ok(guard, `${PRODUCTION_GUARD_FILE} no longer declares ProductionGuard — re-point this`);
  const field = guard.members.find(
    (member) => ts.isPropertyDeclaration(member) && memberName(member) === 'auditLog',
  );
  assert.ok(
    field?.initializer && ts.isArrayLiteralExpression(unwrap(field.initializer)),
    'ProductionGuard no longer keeps its decisions in an auditLog array — the log moved; read ' +
      'where before trusting the check below',
  );
  // Positive control: the same walk reads the imports of a file that has them.
  const imports = (file) =>
    parseFile(file)
      .statements.filter((node) => ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly)
      .map((node) => node.moduleSpecifier.text);
  assert.ok(
    imports(AI_COMPOSITION_FILE).length > 0,
    `the walk reads no import in ${AI_COMPOSITION_FILE}, which has several — the empty list below ` +
      'would prove nothing',
  );
  assert.deepEqual(
    imports(PRODUCTION_GUARD_FILE),
    [],
    'ProductionGuard.ts now imports code — its decisions may be written somewhere that outlives ' +
      'the session. Re-read every surface that says the log is kept in memory before relaxing this.',
  );
}

test('anchor: Production Guard keeps its decisions in memory, for the session', () => {
  assertGuardLogStaysInMemory();
});

const AUDIT_TRAIL =
  /audit[- ]?trail|piste d['’]audit|pr(?:ü|ue)fpfad|registro de auditor[ií]a|trilha de auditoria|監査証跡/iu;
const AUDIT_TRAIL_DISCLAIMER =
  /still to come|coming soon|not (?:yet )?(?:built|persisted)|à venir|pas encore|noch nicht|todav[ií]a no|pr[óo]ximamente|ainda n[ãa]o|em breve|未実装|今後/iu;

/** Units that sell Production Guard an audit trail, as `label: text`. */
function guardAuditTrailClaims(units) {
  return units
    .filter(
      ({ text }) =>
        /production guard/i.test(text) &&
        AUDIT_TRAIL.test(text) &&
        !AUDIT_TRAIL_DISCLAIMER.test(text),
    )
    .map(({ label, text }) => `${label}: ${text.trim().slice(0, 140)}`);
}

test('no user-facing surface gives Production Guard an audit trail', () => {
  assertGuardLogStaysInMemory();

  const units = userFacingProse();
  // Positive control: the walk sees the guard named where its log is described.
  assert.ok(
    units.filter(({ text }) => /production guard/i.test(text)).length >= 10,
    'the walk sees Production Guard named on fewer than ten surfaces — it is not reading them',
  );
  const offenders = guardAuditTrailClaims(units);
  assert.deepEqual(
    offenders,
    [],
    'Production Guard keeps its decisions in memory for the session; these surfaces promise a ' +
      'trail that outlives it:\n  ' +
      offenders.join('\n  '),
  );

  const refused = [
    '- All DML goes through the existing **Production Guard** (tier check + audit trail).',
    'Production Guard keeps a full audit trail of every write.',
    "Production Guard conserve une piste d'audit de chaque écriture.",
    'Production Guard führt einen Prüfpfad über jeden Schreibvorgang.',
    'Production Guard mantiene un registro de auditoría de cada escritura.',
    'O Production Guard mantém uma trilha de auditoria de cada gravação.',
    'Production Guard はすべての書き込みの監査証跡を残します。',
  ];
  assert.deepEqual(
    refused.filter((text) => guardAuditTrailClaims([{ label: 'fixture', text }]).length === 0),
    [],
    'these give Production Guard an audit trail, and the rule lets them through',
  );
  const honest = [
    'Its safety-check decisions are held in memory for the session only — a persisted, readable audit trail is still to come.',
    '| **Reports** | Execution reports and success-rate analytics _(audit trail and data lineage coming soon)_ |',
    '- All DML goes through the existing **Production Guard** (tier check; with `sandforge.safety.auditLogging` on, its decisions are kept in memory for the session only).',
    'Production Guard, on by default, and its log of safety-check decisions -- kept in memory for the session, never written to disk.',
  ];
  assert.deepEqual(
    honest.filter((text) => guardAuditTrailClaims([{ label: 'fixture', text }]).length > 0),
    [],
    'the Production Guard rule refuses these honest sentences',
  );
});

// ── AI Assistant ──────────────────────────────────────────────────────────

/**
 * Everything esbuild puts in `dist/extension.js` — the extension's sources and
 * the shared package it inlines (only `vscode`, the Anthropic SDK and the
 * jsforce entry stay external) — and the webview sources Vite puts in
 * `webview-dist/`. The webview never calls the model, but it can compose what
 * the extension sends: a `tools` key in a payload an adapter spreads into its
 * request lives there and nowhere else. The floors sit below today's counts; a
 * scan that falls under one has stopped reading shipped code.
 */
const WEBVIEW_ROOT = 'packages/webview/src';
const SHIPPED_ROOTS = [
  { root: 'packages/extension/src', minFiles: 250 },
  { root: 'packages/shared/src', minFiles: 60 },
  { root: WEBVIEW_ROOT, minFiles: 250 },
];

/** The three packages that premise covers. A fourth would be inlined the same way, and read by nothing here. */
const WORKSPACE_PACKAGES = ['@sandforge/shared', '@sandforge/webview', 'sandforge'];

/**
 * Where a tool definition can sit as data rather than as code: beside the
 * sources, and in the folder the VSIX ships verbatim.
 */
const DATA_ROOTS = [
  'packages/extension/src',
  'packages/shared/src',
  'packages/extension/resources',
];

/** Directory names that hold test support rather than shipped code. */
const TEST_SUPPORT_DIRS = new Set(['test', '__tests__', '__mocks__', 'fixtures']);

/** A file esbuild can bundle, TypeScript or JavaScript; declaration files cannot be imported. */
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/;
const isDeclarationFile = (name) => /\.d\.[cm]?ts$/.test(name);

/** A shipped source file: a script that is neither a test nor a declaration file. */
const isSourceFile = (name) =>
  SCRIPT_FILE.test(name) && !isDeclarationFile(name) && !/\.(?:test|spec)\./.test(name);

/**
 * Keys that hand the model tools: the Messages API's own `tools` and
 * `tool_choice`, `mcp_servers` — the remote connector, which hands over a whole
 * tool set without ever naming one — and the Agent SDK's `allowedTools`.
 *
 * The OpenAI-shaped pair `functions`/`function_call` is deliberately NOT here:
 * Functions is a Salesforce product this extension talks about, so a key of
 * that name is ordinary domain vocabulary and the rule would fire on honest
 * code. An OpenAI-shaped tool request is a declared limit below.
 *
 * Nothing else in this extension has a use for the keys above, so one as a value
 * anywhere in shipped code counts — an object member, a class field, a property
 * assigned later — whatever finally receives the object: a request built in a
 * helper, spread from a variable or handed to a constructor is still a request.
 * A log field named `tools` counts too; rename it. A type naming them sends
 * nothing and does not count.
 */
const TOOL_REQUEST_PROPERTY = new Set(['tools', 'tool_choice', 'mcp_servers', 'allowedTools']);

/**
 * The Anthropic SDK's tool machinery, as the installed package lays it out.
 * `lib/tools/*`, `tools/*`, `helpers/beta/memory` and `helpers/beta/mcp` hold
 * nothing else, so any import from them counts. `helpers/beta/json-schema` and
 * `helpers/beta/zod` also export structured-output formats, so there only the
 * tool helpers count — by name, as does the runner on `client.beta.messages`.
 */
const SDK_TOOL_SUBPATH =
  /^@anthropic-ai\/sdk\/(?:lib\/tools|tools|helpers\/beta\/(?:memory|mcp))(?:[/.]|$)/;
const SDK_TOOL_HELPER = new Set([
  'toolRunner',
  'BetaToolRunner',
  'betaTool',
  'betaZodTool',
  'betaMemoryTool',
  'BetaLocalFilesystemMemoryTool',
  'mcpTool',
  'mcpTools',
]);

/**
 * Calls that build, hand over or run tools of our own: any verb from that
 * family joined to `Tool`/`Tools` — `runTools`, `wrapTool`, `buildReadOnlyTools`,
 * `createToolRegistry`, and the ones a second turn is written with,
 * `dispatchTools`, `executeTools`, `invokeTool`, `callTools`,
 * `continueWithTools`. `Toolbar` and `Tooltip` are different words: the suffix
 * has to start a new one.
 *
 * The name has to END on it. `Tools` is also a panel label in this product, so
 * a name that carries on past the word — `buildToolsPanelItems` — is interface
 * code, not a tool factory. The cost is that a factory named past the word
 * (`createToolRegistry`) is not caught here; what it builds still is, the
 * moment it reaches a request or an SDK helper.
 */
const TOOL_VERB_CALL =
  /^(?:[Rr]un|[Ww]rap|[Bb]uild|[Mm]ake|[Cc]reate|[Rr]egister|[Ww]ith|[Dd]ispatch|[Ee]xecute|[Ii]nvoke|[Cc]all|[Cc]ontinue[Ww]ith)(?:[A-Z0-9_]\w*)?Tools?$/;

/**
 * The editor's own model has a tool API, and an extension reaches it without
 * touching the Anthropic SDK: `vscode.lm.registerTool`, `vscode.lm.invokeTool`,
 * `vscode.lm.registerMcpServerDefinitionProvider`, or a class that implements
 * `LanguageModelTool`. Any member of `lm` whose name carries `tool` or `mcp`
 * counts, so a renamed import or a later sibling call is caught with them.
 */
const LANGUAGE_MODEL_NAMESPACE = 'lm';
const LANGUAGE_MODEL_MEMBER = /tool|mcp/i;
const LANGUAGE_MODEL_TOOL_TYPE = /^(?:vscode\.)?LanguageModelTool(?:[A-Z]\w*)?$/;

/**
 * Packages whose whole purpose is running tools: a second SDK from the same
 * publisher, and the MCP SDK — with which this extension would be the *server*,
 * handing an org tool set to whatever model the editor talks to. Any import of
 * either counts.
 */
const TOOL_RUNTIME_PACKAGES = ['@anthropic-ai/claude-agent-sdk', '@modelcontextprotocol/sdk'];
const isToolRuntimeSpecifier = (specifier) =>
  TOOL_RUNTIME_PACKAGES.some((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`));

/**
 * The file an editor reads to attach an MCP server to its chat. Writing it
 * hands over a tool set without a single request leaving this extension, so the
 * name counts as a string wherever shipped code writes it.
 */
const MCP_CONFIG_FILE = /(?:^|[/\\])mcp\.json$/;

/** Content blocks that only exist once the model has tools: their `type` values, and the SDK's type names for them. */
const TOOL_BLOCK_TYPE = new Set([
  'tool_use',
  'tool_result',
  'server_tool_use',
  'mcp_tool_use',
  'mcp_tool_result',
]);
const TOOL_BLOCK_TYPE_NAME = /^(?:Beta)?(?:Server|MCP)?Tool(?:Use|Result)(?:[A-Z]\w*)?$/;

const SDK_PACKAGE = '@anthropic-ai/sdk';
const isSdkSpecifier = (specifier) =>
  specifier === SDK_PACKAGE || specifier.startsWith(`${SDK_PACKAGE}/`);

const toRepoPath = (file) => relative(repoRoot, file).replace(/\\/g, '/');

function sourceFilesUnder(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!TEST_SUPPORT_DIRS.has(entry.name)) sourceFilesUnder(full, acc);
    } else if (isSourceFile(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * The JSON that ships beside the code, where a tool definition can sit without
 * a single line of TypeScript. Unlike the script walk, this one enters the test
 * support directories: a test file is not shipped, but a data file in
 * `fixtures/` is read at runtime by whatever calls `readFileSync` on it.
 */
function jsonFilesUnder(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) jsonFilesUnder(full, acc);
    else if (entry.name.endsWith('.json')) acc.push(full);
  }
  return acc;
}

/** The keys an API tool definition carries beside its name. */
const TOOL_SCHEMA_KEY = new Set(['input_schema', 'inputSchema', 'parameters', 'schema']);

/**
 * A tool defined as data: an object carrying `input_schema`, or a `tools` array
 * whose entries pair a `name` with a schema. Either shape is a tool list a
 * single spread puts in a request, so the JSON counts wherever it sits under a
 * data root.
 */
function jsonToolDefinitions(value, path = '') {
  const found = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => found.push(...jsonToolDefinitions(item, `${path}[${index}]`)));
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  if ('input_schema' in value) found.push(path || '(root)');
  for (const [key, child] of Object.entries(value)) {
    if (
      key === 'tools' &&
      Array.isArray(child) &&
      child.length > 0 &&
      child.every(
        (item) =>
          item &&
          typeof item === 'object' &&
          typeof item.name === 'string' &&
          Object.keys(item).some((k) => TOOL_SCHEMA_KEY.has(k)),
      )
    ) {
      found.push(path ? `${path}.tools` : 'tools');
    }
    found.push(...jsonToolDefinitions(child, path ? `${path}.${key}` : key));
  }
  return [...new Set(found)];
}

/** The file a relative specifier lands on, as TypeScript and esbuild resolve it: `./a.js` may be `./a.ts`, `./dir` may be `./dir/index.ts`. */
function resolveRelativeImport(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base];
  const script = /\.([cm]?)jsx?$/.exec(base);
  if (script) {
    const stem = base.slice(0, -script[0].length);
    candidates.push(`${stem}.${script[1]}ts`, `${stem}.tsx`);
  }
  for (const extension of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs']) {
    candidates.push(base + extension);
  }
  for (const index of [
    'index.ts',
    'index.tsx',
    'index.js',
    'index.jsx',
    'index.mjs',
    'index.cjs',
  ]) {
    candidates.push(join(base, index));
  }
  return (
    candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null
  );
}

/** Strip the wrappers that do not change what an expression refers to. */
function unwrap(node) {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    (ts.isSatisfiesExpression && ts.isSatisfiesExpression(node))
  ) {
    node = node.expression;
  }
  return node;
}

/** The name a call or `new` invokes: `f()`, `a.b.f()`, `a['f']()`. */
function invokedName(callee) {
  const target = unwrap(callee);
  if (ts.isIdentifier(target) || ts.isPrivateIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  if (ts.isElementAccessExpression(target) && ts.isStringLiteralLike(target.argumentExpression)) {
    return target.argumentExpression.text;
  }
  return null;
}

/** The names along an access chain: `this.client.beta.messages.create` → this, client, beta, messages, create. */
function accessChain(expression) {
  const names = [];
  let node = unwrap(expression);
  for (;;) {
    if (ts.isPropertyAccessExpression(node)) {
      names.unshift(node.name.text);
      node = unwrap(node.expression);
    } else if (ts.isElementAccessExpression(node)) {
      if (ts.isStringLiteralLike(node.argumentExpression)) {
        names.unshift(node.argumentExpression.text);
      }
      node = unwrap(node.expression);
    } else if (ts.isCallExpression(node)) {
      node = unwrap(node.expression);
    } else {
      if (ts.isIdentifier(node)) names.unshift(node.text);
      else if (node.kind === ts.SyntaxKind.ThisKeyword) names.unshift('this');
      return names;
    }
  }
}

/** The name a member declares, when it is written out. */
function memberName(member) {
  const { name } = member;
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text;
  }
  return null;
}

/** The property an assignment writes: `a.tools = …`, `a['tools'] ??= …`. */
function assignedProperty(target) {
  const node = unwrap(target);
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return null;
}

/** A literal inside the list handed to a schema enumeration: `z.enum(['end_turn', 'tool_use'])`. */
function isSchemaEnumMember(literal) {
  const list = literal.parent;
  return (
    ts.isArrayLiteralExpression(list) &&
    ts.isCallExpression(list.parent) &&
    list.parent.arguments.includes(list) &&
    invokedName(list.parent.expression) === 'enum'
  );
}

const isAssignment = (node) =>
  ts.isBinaryExpression(node) &&
  node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
  node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;

let shippedScan;

/**
 * Read every shipped source file once, off the syntax tree — never off the
 * text: a comment, a JSDoc line or a string that mentions `tools:` or
 * `runTools(` is not code, so it can neither trip an assertion nor satisfy a
 * positive control.
 *
 * The result is published only once the walk has finished, so a walk that
 * throws halfway cannot leave a truncated scan behind for the next test.
 */
function scanShippedCode() {
  if (shippedScan) return shippedScan;
  const scan = emptyScan();

  for (const { root } of SHIPPED_ROOTS) {
    const files = sourceFilesUnder(join(repoRoot, root));
    scan.filesByRoot.set(root, files.map(toRepoPath));
    for (const file of files) {
      scan.read.add(file);
      scanFile(scan, file, { webview: root === WEBVIEW_ROOT });
    }
  }

  for (const root of DATA_ROOTS) {
    for (const file of jsonFilesUnder(join(repoRoot, root))) {
      scan.jsonFiles.push(toRepoPath(file));
      let data;
      try {
        data = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      for (const at of jsonToolDefinitions(data)) {
        scan.findings.push(`${toRepoPath(file)} tool definition at ${at}`);
      }
    }
  }

  shippedScan = scan;
  return scan;
}

/** What one walk collects, before it has read anything. */
function emptyScan() {
  return {
    filesByRoot: new Map(),
    /** Absolute paths of every file read. */
    read: new Set(),
    /** `path:line what` for every way shipped code could give the model tools or act on a tool call. */
    findings: [],
    /** `{ at, text }` for each tool-block literal listed in a schema enumeration. */
    enumeratedToolBlocks: [],
    /** `path:line` of every `max_tokens` member. */
    maxTokensMembers: [],
    /** `{ at, specifier, dynamic }` for every module specifier naming the Anthropic SDK. */
    sdkImports: [],
    /** `{ at, called }` for every use of a member named `chat`. */
    chatUses: [],
    /** `{ at, from, specifier }` for every relative import that is not type-only. */
    relativeImports: [],
    /** Repo paths of the JSON files that ship under the data roots; none today. */
    jsonFiles: [],
  };
}

/**
 * Read one file into a scan. `text` stands in for the file on disk, which is
 * how the attack corpus is replayed without writing to the tree; `webview`
 * marks a file of the panel, where importing the SDK at all is a finding.
 */
function scanFile(scan, file, { text, webview = false } = {}) {
  const source = ts.createSourceFile(
    file,
    text ?? readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const where = (node) =>
    `${toRepoPath(file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
  const found = (node, what) => scan.findings.push(`${where(node)} ${what}`);

  const moduleSpecifier = (node, specifier, { typeOnly = false, dynamic = false } = {}) => {
    if (specifier.startsWith('.')) {
      if (!typeOnly) scan.relativeImports.push({ at: where(node), from: file, specifier });
    } else if (isSdkSpecifier(specifier)) {
      scan.sdkImports.push({ at: where(node), specifier, dynamic });
      // The panel has no business with the SDK: anything it builds from it is
      // a request, or a piece of one, that the extension would send.
      if (webview || SDK_TOOL_SUBPATH.test(specifier)) found(node, `import '${specifier}'`);
    } else if (isToolRuntimeSpecifier(specifier)) {
      found(node, `import '${specifier}'`);
    }
  };
  const sdkHelperNames = (node, specifier, elements) => {
    if (!isSdkSpecifier(specifier)) return;
    for (const element of elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (SDK_TOOL_HELPER.has(imported)) found(element, `import { ${imported} }`);
    }
  };

  const visit = (node) => {
    // Modules: what is imported, from where.
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      moduleSpecifier(node, specifier, { typeOnly: !!node.importClause?.isTypeOnly });
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        sdkHelperNames(node, specifier, bindings.elements);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      moduleSpecifier(node, specifier, { typeOnly: node.isTypeOnly });
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        sdkHelperNames(node, specifier, node.exportClause.elements);
      }
    }

    // Calls and constructors: dynamic imports, and anything that runs or builds tools.
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const args = node.arguments ?? [];
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
        args[0] &&
        ts.isStringLiteralLike(args[0])
      ) {
        moduleSpecifier(node, args[0].text, { dynamic: true });
      }
      const name = invokedName(node.expression);
      if (name && (SDK_TOOL_HELPER.has(name) || TOOL_VERB_CALL.test(name))) {
        found(node, `${ts.isNewExpression(node) ? 'new ' : ''}${name}()`);
      } else if (name && LANGUAGE_MODEL_MEMBER.test(name)) {
        // The editor's model API, reached through `lm` however it was imported.
        const chain = accessChain(node.expression);
        if (chain.includes(LANGUAGE_MODEL_NAMESPACE)) found(node, `${chain.join('.')}()`);
      }
    }

    // The same API taken without being called: `vscode.lm` held whole — stored,
    // destructured, handed to `.bind` — or one of its tool members read as a
    // value. `const register = vscode.lm.registerTool.bind(vscode.lm)` calls
    // `bind`, and the call rule above never sees `registerTool` invoked.
    if (ts.isPropertyAccessExpression(node)) {
      const outer = node.parent;
      const accessed =
        (ts.isPropertyAccessExpression(outer) || ts.isElementAccessExpression(outer)) &&
        outer.expression === node;
      const called = ts.isCallExpression(outer) && outer.expression === node;
      const chain = accessChain(node);
      if (node.name.text === LANGUAGE_MODEL_NAMESPACE && !accessed) {
        found(node, `${chain.join('.')} taken whole`);
      } else if (
        LANGUAGE_MODEL_MEMBER.test(node.name.text) &&
        !called &&
        chain.slice(0, -1).includes(LANGUAGE_MODEL_NAMESPACE)
      ) {
        found(node, `${chain.join('.')} read without a call`);
      }
    }

    // A tool of our own, written to the editor's interface.
    if (ts.isClassLike(node)) {
      for (const clause of node.heritageClauses ?? []) {
        if (clause.token !== ts.SyntaxKind.ImplementsKeyword) continue;
        for (const type of clause.types) {
          const name = ts.isIdentifier(type.expression)
            ? type.expression.text
            : accessChain(type.expression).join('.');
          if (LANGUAGE_MODEL_TOOL_TYPE.test(name)) found(type, `implements ${name}`);
        }
      }
    }

    // Request fragments: a `tools` key written as a value, wherever the object goes.
    if (
      (ts.isPropertyAssignment(node) ||
        ts.isShorthandPropertyAssignment(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)) &&
      ts.isObjectLiteralExpression(node.parent)
    ) {
      const name = memberName(node);
      if (TOOL_REQUEST_PROPERTY.has(name)) found(node, `{ ${name} }`);
      if (name === 'max_tokens') {
        scan.maxTokensMembers.push(where(node));
      }
    } else if (
      ts.isPropertyDeclaration(node) &&
      node.initializer &&
      TOOL_REQUEST_PROPERTY.has(memberName(node))
    ) {
      found(node, `${memberName(node)} = …`);
    } else if (isAssignment(node) && TOOL_REQUEST_PROPERTY.has(assignedProperty(node.left))) {
      found(node, `.${assignedProperty(node.left)} = …`);
    }

    // The editor's tool configuration, named as a path — whole or as the tail of a template.
    const literal =
      ts.isStringLiteralLike(node) ||
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail
        ? node.text
        : null;
    if (literal !== null && MCP_CONFIG_FILE.test(literal)) found(node, `'${literal}'`);

    // Tool calls in a response: the block types, as values or as the SDK's type names.
    if (
      ts.isStringLiteralLike(node) &&
      TOOL_BLOCK_TYPE.has(node.text) &&
      !ts.isLiteralTypeNode(node.parent)
    ) {
      // The Messages API's stop_reason vocabulary includes `tool_use`. A schema
      // enumerating every way a response can end acts on no tool call, and a
      // response can only stop on `tool_use` if a request sent tools — which
      // the key rule above rules out. Any other use of the literal counts.
      if (isSchemaEnumMember(node)) {
        scan.enumeratedToolBlocks.push({ at: where(node), text: node.text });
      } else {
        found(node, `'${node.text}'`);
      }
    } else if (ts.isTypeReferenceNode(node)) {
      const { typeName } = node;
      const last = ts.isIdentifier(typeName) ? typeName.text : typeName.right.text;
      if (TOOL_BLOCK_TYPE_NAME.test(last)) found(node, last);
    }

    if (
      (ts.isPropertyAccessExpression(node) && node.name.text === 'chat') ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === 'chat')
    ) {
      let outer = node;
      while (outer.parent && unwrap(outer.parent) !== outer.parent) outer = outer.parent;
      const called = ts.isCallExpression(outer.parent) && outer.parent.expression === outer;
      scan.chatUses.push({ at: where(node), called });
    } else if (
      ts.isBindingElement(node) &&
      (memberName({ name: node.propertyName }) ?? memberName(node)) === 'chat'
    ) {
      scan.chatUses.push({ at: where(node), called: false });
    }

    ts.forEachChild(node, visit);
  };
  visit(source);
}

/**
 * Positive controls. An empty finding list proves nothing unless the same scan
 * demonstrably reads what ships, sees the calls that do reach the model, and
 * reads the objects and specifiers they are made of. Every test that relies on
 * the scan calls this.
 */
function assertScanReadsShippedCode(scan) {
  for (const { root, minFiles } of SHIPPED_ROOTS) {
    const scanned = scan.filesByRoot.get(root);
    assert.ok(
      scanned.length >= minFiles,
      `the scan read ${scanned.length} files under ${root}, fewer than ${minFiles} — it has ` +
        'stopped reading shipped code, so an empty result below proves nothing',
    );
  }

  // The premise under `SHIPPED_ROOTS` — everything esbuild inlines lives under
  // those roots — holds for three workspace packages. A fourth would be inlined
  // exactly as `@sandforge/shared` is, and read by nothing here, without a
  // floor moving.
  const packagesDir = join(repoRoot, 'packages');
  const workspacePackages = readdirSync(packagesDir, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(join(packagesDir, entry.name, 'package.json')),
    )
    .map((entry) => JSON.parse(readFileSync(join(packagesDir, entry.name, 'package.json'), 'utf8')))
    .map((manifest) => manifest.name)
    .sort();
  assert.deepEqual(
    workspacePackages,
    WORKSPACE_PACKAGES,
    'the workspace no longer holds the three packages this scan is scoped to — a new one is ' +
      'inlined into dist/extension.js and read by nothing here; add its sources to SHIPPED_ROOTS',
  );

  // Coverage is judged by what shipped code loads, at any depth: every relative
  // import of a file the scan read lands on a file the scan read too. A test
  // support directory is skipped only as long as nothing shipped imports from it.
  const unread = [];
  for (const { at, from, specifier } of scan.relativeImports) {
    const target = resolveRelativeImport(from, specifier);
    if (target === null) {
      unread.push(`${at} '${specifier}' lands on no file the scan can find`);
    } else if (SCRIPT_FILE.test(target) && !isDeclarationFile(target) && !scan.read.has(target)) {
      unread.push(`${at} '${specifier}' → ${toRepoPath(target)}`);
    }
  }
  assert.deepEqual(
    unread,
    [],
    'shipped code imports files the scan does not read — whatever they hold ships unchecked:\n  ' +
      unread.join('\n  '),
  );

  // The assistant and the model-backed modules reach the model through
  // `aiClient().chat({...})` in the AI composition root. `chat` has to be
  // called there, never bound, aliased or destructured: a call made through an
  // alias is a call this scan cannot attribute.
  const compositionRoot = 'packages/extension/src/composition/aiComposition.ts:';
  const chatUses = scan.chatUses.filter((use) => use.at.startsWith(compositionRoot));
  assert.ok(
    chatUses.some((use) => use.called),
    'the scan no longer sees aiComposition.ts calling chat() — it is reading nothing',
  );
  const indirect = chatUses.filter((use) => !use.called).map((use) => use.at);
  assert.deepEqual(
    indirect,
    [],
    'aiComposition.ts takes chat without calling it — the scan cannot see what that route ' +
      'sends:\n  ' +
      indirect.join('\n  '),
  );

  // The key rule reads object members wherever they are written: the walk
  // that would find `tools` in a request finds `max_tokens`, the key every
  // request to the model carries, today — in a literal handed to the SDK or in
  // an object built beforehand alike.
  assert.ok(
    scan.maxTokensMembers.length > 0,
    'the scan no longer sees a `max_tokens` member anywhere in shipped code — it is not reading ' +
      'object members, so it cannot see `tools` either',
  );

  // The sub-path rule reads module specifiers, dynamic ones included: the walk
  // that would find `@anthropic-ai/sdk/lib/tools/…` finds the lazy
  // `import('@anthropic-ai/sdk')` today, whichever file holds it.
  assert.ok(
    scan.sdkImports.some((entry) => entry.dynamic && entry.specifier === SDK_PACKAGE),
    "the scan no longer sees import('@anthropic-ai/sdk') anywhere in shipped code — it is not " +
      'reading dynamic imports, so it cannot see an SDK tool sub-path either',
  );
}

/** Every way shipped code could give the model tools or act on a tool call, as `path:line what`. */
function toolCapabilities() {
  const scan = scanShippedCode();
  assertScanReadsShippedCode(scan);
  return scan.findings;
}

test('anchor: nothing shipped gives the model tools or acts on a tool call', (t) => {
  const found = toolCapabilities();
  for (const literal of shippedScan.enumeratedToolBlocks) {
    t.diagnostic(`stop_reason vocabulary, not a tool call: ${literal.at} '${literal.text}'`);
  }
  assert.deepEqual(
    found,
    [],
    'shipped code can give the model tools or act on a tool call again — the assistant may ' +
      'really use tools. Re-read every surface below before deleting this test: they are ' +
      'currently written to say it does not.\n  ' +
      found.join('\n  '),
  );
});

/**
 * Where a replayed piece of source is read as if it lived: the extension, the
 * shared package, the webview, or the AI composition root itself — the one
 * file where taking `chat` without calling it is a finding.
 */
const ATTACK_FILES = {
  extension: 'packages/extension/src/attack',
  shared: 'packages/shared/src/attack',
  webview: `${WEBVIEW_ROOT}/attack`,
  composition: 'packages/extension/src/composition/aiComposition',
};

/** What the scan finds in a piece of source that is not in the tree: `ts`, `js`, or a `json` data file. */
function scanSource({ source, shape = 'ts', root = 'extension' }) {
  if (shape === 'json') return jsonToolDefinitions(JSON.parse(source));
  const scan = emptyScan();
  const file = `${ATTACK_FILES[root]}.${shape}`;
  scanFile(scan, join(repoRoot, ...file.split('/')), {
    text: source,
    webview: root === 'webview',
  });
  const indirectChat =
    root === 'composition'
      ? scan.chatUses
          .filter((use) => !use.called)
          .map((use) => `${use.at} chat taken without a call`)
      : [];
  return [...scan.findings, ...indirectChat];
}

/**
 * The attacks this gate was written against, and the ones thrown at it since,
 * replayed on every run without touching the tree: each piece of code through
 * the same `scanFile` the anchor uses, each sentence through the same match the
 * surfaces get. A verdict is what the gate does today — `unseen` and `passes`
 * are the declared limits in the header, named in each entry's `why` — so a
 * change to either rule that moves one of them fails here and has to be read.
 */
test('the recorded attacks get the verdicts this gate declares, in code and in prose', () => {
  assert.deepEqual(
    [...new Set(CODE_ATTACKS.map((attack) => attack.verdict))].sort(),
    ['found', 'unseen'],
    'the code corpus no longer holds both verdicts — it cannot tell a scan that sees nothing from ' +
      'one that sees everything',
  );
  assert.deepEqual(
    [...new Set(PROSE_ATTACKS.map((attack) => attack.verdict))].sort(),
    ['passes', 'refused'],
    'the prose corpus no longer holds both verdicts — it cannot tell a rule that refuses nothing ' +
      'from one that refuses everything',
  );

  const code = CODE_ATTACKS.filter(
    (attack) => (scanSource(attack).length > 0 ? 'found' : 'unseen') !== attack.verdict,
  ).map((attack) => `declared ${attack.verdict}: ${attack.why}`);
  assert.deepEqual(
    code,
    [],
    'the scan no longer gives these the verdict the corpus declares — a limit was closed or a hole ' +
      'opened; read the entry, then move the verdict or the scan:\n  ' +
      code.join('\n  '),
  );

  const prose = PROSE_ATTACKS.filter(
    (attack) =>
      (republishedClaims(attack.text, PUBLISHED_CLAIMS).length > 0 ? 'refused' : 'passes') !==
      attack.verdict,
  ).map((attack) => `declared ${attack.verdict}: "${attack.text}" — ${attack.why}`);
  assert.deepEqual(
    prose,
    [],
    'the mined wordings no longer give these the verdict the corpus declares:\n  ' +
      prose.join('\n  '),
  );
});

/**
 * The English a user reads when a locale has no entry for a key: the fallback
 * argument of `t('key', 'English')`, which is where this repository keeps the
 * source string rather than in `locales/en.json`. Read off the syntax tree, so
 * the same call written in a comment is not a surface.
 */
let webviewFallbackCache;
function webviewFallbackStrings() {
  if (webviewFallbackCache) return webviewFallbackCache;
  const units = [];
  for (const file of sourceFilesUnder(join(repoRoot, 'packages', 'webview', 'src'))) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node) => {
      if (ts.isCallExpression(node) && invokedName(node.expression) === 't') {
        const [key, fallback] = node.arguments;
        if (key && fallback && ts.isStringLiteralLike(key) && ts.isStringLiteralLike(fallback)) {
          units.push({ label: `${toRepoPath(file)} t('${key.text}')`, text: fallback.text });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.ok(
    units.length >= 200,
    `the scan found ${units.length} English fallbacks in the webview, far fewer than the 300 it ` +
      'carries — it has stopped reading them, so an empty result below proves nothing',
  );
  webviewFallbackCache = units;
  return units;
}

/**
 * `surfaceSources()` as a reader meets it, one unit per thing read: Markdown by
 * paragraph, with soft line breaks joined and fenced code left out; a bundle by
 * string value, never by key, the key kept in the label so an offender can be
 * named and so a rule can tell what the value is about; and the webview's
 * English fallbacks, one string each.
 *
 * There is no second, line-oriented view of the same walk. There was, and it
 * could not name which key of a bundle it had just quoted — which is how six
 * `grappe.subtitle` values sold a parallel execution engine under a rule that
 * read every one of them.
 */
function userFacingProse() {
  const units = [];
  for (const source of surfaceSources()) {
    if (source.json) {
      for (const [key, value] of jsonStrings(source.json)) {
        units.push({ label: `${source.label} ${key}`, text: value });
      }
    } else if (source.label.endsWith('.md')) {
      for (const paragraph of markdownParagraphs(source.text)) {
        units.push({ label: source.label, text: paragraph });
      }
    } else {
      units.push({ label: source.label, text: source.text });
    }
  }
  return [...units, ...webviewFallbackStrings()];
}

function* jsonStrings(value, key = '') {
  if (typeof value === 'string') {
    yield [key, value];
  } else if (value && typeof value === 'object') {
    for (const [child, nested] of Object.entries(value)) {
      yield* jsonStrings(nested, key ? `${key}.${child}` : child);
    }
  }
}

/** Paragraphs, table rows, headings and list items, each as one line of text. */
function markdownParagraphs(text) {
  const paragraphs = [];
  let lines = [];
  let fence = null;
  const flush = () => {
    if (lines.length > 0) paragraphs.push(lines.join(' '));
    lines = [];
  };
  for (const raw of text.split(/\r?\n/)) {
    const fenceMark = /^\s*(`{3,}|~{3,})/.exec(raw)?.[1];
    if (fence) {
      if (fenceMark && fenceMark[0] === fence[0] && fenceMark.length >= fence.length) fence = null;
      continue;
    }
    if (fenceMark) {
      flush();
      fence = fenceMark;
      continue;
    }
    // A blockquote reads like the paragraph it quotes.
    const line = raw.replace(/^\s*(?:>\s?)+/, '');
    if (line.trim() === '') {
      flush();
      continue;
    }
    const standsAlone = /^\s*\||^\s{0,3}#{1,6}\s/.test(line);
    if (standsAlone || /^\s*(?:[-*+]|\d+[.)])\s/.test(line)) flush();
    lines.push(line.trim());
    if (standsAlone) flush();
  }
  flush();
  return paragraphs;
}

/**
 * Number words two to twelve, in the five Latin-script locales, folded to the
 * digit: a wording mined with `10` is still that wording written `ten`, `dix`,
 * `zehn`, `diez` or `dez`. One is left alone — its translations are articles.
 */
const NUMBER_WORDS = {
  2: ['two', 'deux', 'zwei', 'dos', 'dois', 'duas'],
  3: ['three', 'trois', 'drei', 'tres', 'três'],
  4: ['four', 'quatre', 'vier', 'cuatro', 'quatro'],
  5: ['five', 'cinq', 'fünf', 'funf', 'cinco'],
  6: ['six', 'sechs', 'seis'],
  7: ['seven', 'sept', 'sieben', 'siete', 'sete'],
  8: ['eight', 'huit', 'acht', 'ocho', 'oito'],
  9: ['nine', 'neuf', 'neun', 'nueve', 'nove'],
  10: ['ten', 'dix', 'zehn', 'diez', 'dez'],
  11: ['eleven', 'onze', 'elf', 'once'],
  12: ['twelve', 'douze', 'zwölf', 'zwolf', 'doce', 'doze'],
};
const NUMBER_WORD = new Map(
  Object.entries(NUMBER_WORDS).flatMap(([digits, words]) => words.map((word) => [word, digits])),
);
const NUMBER_WORD_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(${[...NUMBER_WORD.keys()]
    .sort((a, b) => b.length - a.length)
    .join('|')})(?![\p{L}\p{N}])`,
  'gu',
);

/** The sixth locale counts with kanji, so those fold too — but only in front of a counter, where the character is a number and not a word. */
const JAPANESE_NUMERAL = {
  一: '1',
  二: '2',
  三: '3',
  四: '4',
  五: '5',
  六: '6',
  七: '7',
  八: '8',
  九: '9',
  十: '10',
  十一: '11',
  十二: '12',
};
const JAPANESE_NUMERAL_PATTERN = /(十[一二]|[一二三四五六七八九十])(?=個|つ|種類|件)/gu;

/** Width-less characters a copy-paste leaves behind, mid-word and invisible. */
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;

/** The entities a writer reaches for instead of the character: a space that will not break, and the dashes. */
const SPACE_ENTITY =
  /&(?:nbsp|ensp|emsp|thinsp|#0*160|#0*8194|#0*8195|#0*8201|#0*8239|#[xX]0*a0);/gi;
const DASH_ENTITY = /&(?:ndash|mdash|shy|#0*8211|#0*8212|#0*8209|#0*173);/gi;

/** What an i18n string writes where a number goes; it reads as the number it will hold. */
const INTERPOLATION = /\{\{[^{}]*\}\}|\$\{[^{}]*\}|\{[^{}\s]*\}|%[sd]/g;

/**
 * Markup that ends a line or a block. What follows starts a new run of text,
 * the way a new table cell or a new list item does; inline tags are typography
 * and fold to a space, so `read-<b>only</b>` still reads as `read only`.
 */
const BLOCK_TAG =
  /<\/?(?:br|hr|p|div|li|ul|ol|tr|td|th|table|thead|tbody|section|h[1-6]|blockquote)\b[^>]*>/gi;

/** Where one run of text ends and the next begins. No mined wording spans one. */
const BREAK = '\n';

/**
 * Prose, and a mined wording, reduced to the words a reader meets. Both sides
 * go through this, so the comparison is about words and not about typography:
 * compatibility forms folded (NFKC), zero-width characters and Markdown link
 * targets dropped, space and dash entities resolved, an interpolated count read
 * as a count, emphasis and code ticks dropped with no space, quotes and
 * parentheses spaced, soft separators (comma, colon, semicolon, arrow) spaced,
 * every Unicode dash — the non-breaking hyphen included — folded to a hyphen
 * and then to a space, number words folded to digits, lower case. So
 * `read-*only*`, `read‑only`, `read&nbsp;only`, `read only`, `ten`,
 * `{{count}}`, `１０`, and `read-only` with a zero-width space pasted into it,
 * all read alike.
 *
 * Structure, on the other hand, separates: a sentence end, a table bar, a link
 * label's brackets and a line-breaking tag each start a new run of text, and a
 * wording is only ever matched inside one run. Two neighbouring cells, two
 * link labels in a list, a label and the value after its colon: none of them
 * can be glued into a phrase no reader ever sees.
 */
const normalizeProse = (text) =>
  text
    .normalize('NFKC')
    .replace(ZERO_WIDTH, '')
    .replace(SPACE_ENTITY, ' ')
    .replace(DASH_ENTITY, '-')
    .replace(INTERPOLATION, '0')
    .replace(/\s+/g, ' ')
    .replace(/\]\([^)]*\)/g, ']')
    .replace(BLOCK_TAG, BREAK)
    .replace(/<[^>]*>/g, ' ')
    .replace(/[*_`~]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/["«»“”„(){}]/g, ' ')
    .replace(/[[\]|]|[.!?…。！？]+/g, BREAK)
    .replace(/[,;:、，]|→|⇒|->/g, ' ')
    .replace(/[\p{Pd}­]/gu, '-')
    .replace(/-/g, ' ')
    .toLowerCase()
    .replace(NUMBER_WORD_PATTERN, (word) => NUMBER_WORD.get(word))
    .replace(JAPANESE_NUMERAL_PATTERN, (numeral) => JAPANESE_NUMERAL[numeral])
    .split(BREAK)
    .map((run) => run.replace(/\s+/g, ' ').trim())
    .filter((run) => run !== '')
    .join(BREAK);

/**
 * The wording that sold the tools, or the diagnosis they served, on a surface a
 * user reads. Mined from every revision of both READMEs, `docs/`, the manifest,
 * `package.nls*.json`, the walkthrough pages and the six locale files that this
 * repository has ever held, in the six languages.
 *
 * The five other languages returned nothing: every locale string that carries a
 * tools noun is a side-panel label, an onboarding tagline or a GDPR line, and
 * none of them was ever about the assistant. So the list below is English, and
 * it is the whole of it.
 *
 * This is not a guess at what a promise looks like — an earlier cut tried that
 * and flagged the honest removal note, the competitor comparison and a true
 * sentence about Monitor and Compare. It is the text that shipped. A wording
 * comes off this list only when the anchor above says the feature is back, or
 * — for the wordings that never named the tools — when it is rewritten.
 *
 * Each one is mined whole, as the cell or the bullet carried it. A fragment is
 * not: `read-only tool surface` alone is what any module with no write access
 * has, in English and in the four languages that borrow the term, and
 * `10 fine-grained read-only tools` is a sentence about Compare's drift checks
 * as easily as one about the assistant.
 */
const PUBLISHED_CLAIMS = [
  {
    // `| **AI Assistant** | … |`, the feature table of README.md from f25de974
    // (2026-08-06) and of packages/extension/README.md from 73a8da80 (v1.7.0,
    // 2026-08-11), in both until 8110fd25 (2026-09-11) removed the flow.
    // NL2SOQL, the other half of the cell, works and stays out of the wording.
    text: 'failed-job diagnosis over 10 read-only tools',
    where: 'the AI Assistant row of the feature table, both READMEs, v1.7.0 to v1.21',
  },
  {
    // The bullet the table replaced: packages/extension/README.md, f25de974
    // (2026-08-06) to 73a8da80, with and without the parenthesis that followed.
    text: 'failed-job diagnosis, read-only by design',
    where: 'the AI assistant bullet, packages/extension/README.md, 2026-08-06 to v1.7.0',
  },
  {
    // README.md "Read-only by design" bullet, 885842ee (v1.2.6, 2026-05-05) to
    // f25de974. The ten tool names it went on to list are left to the anchor:
    // listing them again means the tools exist again, and that trips first.
    text: '**Read-only by design** — 10 fine-grained read-only tools',
    where: 'the "Read-only by design" bullet, README.md, v1.2.6 to 2026-08-06',
  },
  {
    // README.md release highlights, same span, with the parenthesis that made
    // it a claim about the assistant rather than a property of a module.
    text: '**Read-only tool surface** (10 tools, registry CI fence, `DML_FORBIDDEN` at 2 layers)',
    where: 'the release highlights, README.md, v1.2.6 to 2026-08-06',
  },
  {
    // README.md AI section, same span. A diagnose flow built again — without
    // tools, so the anchor stays green — is described in new words; this
    // sentence stays refused because it promises the screen that never shipped.
    text: '**Failed-job diagnose flow** — Right-click a failed bulk job in Monitor → "Diagnose with AI"',
    where: 'the AI section, README.md, v1.2.6 to 2026-08-06',
  },
  {
    // The same flow in the release highlights, named after the handler that was
    // deleted with it: the arrow reads as a space.
    text: '**Failed-job → diagnose flow** with `AIDiagnoseHandler` + `ActionCard`',
    where: 'the release highlights, README.md, v1.2.6 to 2026-08-06',
  },
  {
    // The half of the diagnose bullet that promised execution, not an answer.
    text: 'Read-only suggested actions auto-execute silently',
    where: 'the "Failed-job diagnose flow" bullet, README.md, v1.2.6 to 2026-08-06',
  },
].map(mine);

/** A mined wording, ready to match: the words a reader meets, and the pattern for them. */
function mine(claim) {
  const needle = normalizeProse(claim.text);
  return { ...claim, needle, pattern: claimPattern(needle) };
}

/**
 * A mined wording as a pattern: the words as they were published, on word
 * boundaries, with the count left free. Rewriting `10` as `12` — or as the
 * `{{count}}` a locale interpolates, which normalises to a number — is editing
 * the sentence that shipped, not writing a new one.
 */
function claimPattern(needle) {
  const body = needle
    .split(/(\d+)/)
    .map((part, index) =>
      index % 2 === 1 ? String.raw`\d+` : part.replace(/[\\^$.*+?()[\]{}|]/g, String.raw`\$&`),
    )
    .join('');
  return new RegExp(String.raw`(?<![\p{L}\p{N}])${body}(?![\p{L}\p{N}])`, 'u');
}

/**
 * The mined wordings a text republishes. A wording has to be there whole, on
 * word boundaries and inside one run of text: wrapping it in a sentence does
 * not excuse it, so a prefix or a suffix — including one that disowns it —
 * still counts. Rewrite the sentence, or put the quote in a changelog, which is
 * not a surface.
 */
function republishedClaims(text, claims) {
  const runs = normalizeProse(text).split(BREAK);
  return claims.filter((claim) => runs.some((run) => claim.pattern.test(run)));
}

/**
 * A wording short enough to be written by accident makes the gate noise: the
 * 22-character `read-only tool surface` refused five true sentences, one of
 * them in a language that borrows the English term. A mined wording carries a
 * whole claim, so the floor sits under the shortest one that does.
 */
function assertMinedWordingsCarryAClaim(claims) {
  const short = claims.filter((claim) => claim.needle.length < 30);
  assert.deepEqual(
    short.map((claim) => claim.text),
    [],
    'these mined wordings are too short to be refused on their own: mine the sentence that ' +
      'carried them, or leave the claim to the anchor that reads the code',
  );
}

test('the mined wordings are matched whole, and honest prose is left alone', () => {
  assertMinedWordingsCarryAClaim(PUBLISHED_CLAIMS);

  // Each wording as published, then the shapes a reappearance takes: a table
  // row, a paragraph wrapped mid-phrase, emphasis inside a word, a
  // non-breaking hyphen, a space written as an entity, an invisible character
  // pasted mid-word, the count spelled out in another language, interpolated by
  // i18n or brought up to date, and the wording carried by a longer sentence.
  const republished = [
    ...PUBLISHED_CLAIMS.map((claim) => claim.text),
    '| **AI Assistant**   | NL2SOQL and failed-job diagnosis over 10 read-only tools |',
    'NL2SOQL and failed-job\ndiagnosis over 10 read-only tools, with your own key.',
    'NL2SOQL and failed-*job* diagnosis over `10` read-only tools',
    'NL2SOQL and failed‑job diagnosis over 10 read‑only tools',
    'NL2SOQL and failed-job diagnosis over 10&nbsp;read-only tools',
    'NL2SOQL and failed-job diagnosis over 10 read\u200B-only tools', // a zero-width space, pasted from a mock-up
    'failed job diagnosis over ten read only tools',
    'failed-job diagnosis over {{count}} read-only tools',
    'failed-job diagnosis over 12 read-only tools',
    'Diagnose fehlgeschlagener Jobs: failed-job diagnosis over zehn read-only tools',
    'The assistant now offers failed-job diagnosis over 10 read-only tools again.',
    // A quotation of a withdrawn wording republishes it on a page a user reads,
    // whether it is struck through, in a removal note or in an answer about an
    // old version. All three are refused like the promise, on purpose: the
    // alternative is a negation rule per language, which is the guessing this
    // gate dropped. Quote it in a changelog, which is not a surface.
    'Version 1.20 removed failed-job diagnosis over ten read-only tools from the AI Assistant.',
    '~~Failed-job diagnosis over 10 read-only tools~~ — withdrawn in 1.20.',
    'The v1.2.6 README promised "**Read-only by design** — 10 fine-grained read-only tools". It was never true.',
    '- **AI assistant**: NL2SOQL and failed-job diagnosis, read-only by design.',
    '- **Read-only by design** — 10 fine-grained read-only tools (`describe_object`, `query_records`).',
    '- **Read-only tool surface** (10 tools, registry CI fence, `DML_FORBIDDEN` at 2 layers)',
    '- **Failed-job diagnose flow** — Right-click a failed bulk job in Monitor → "Diagnose with AI" surfaces an ActionCard.',
    '- **Failed-job → diagnose flow** with `AIDiagnoseHandler` + `ActionCard` (Approve / Modify / Reject)',
    'Read-only suggested actions auto-execute silently; org-mutating ones gate behind Approve.',
  ];
  assert.deepEqual(
    republished.filter((text) => republishedClaims(text, PUBLISHED_CLAIMS).length === 0),
    [],
    'these republish wording that was withdrawn, and the rules let them through',
  );

  // Prose an honest page could hold, with the same words in it. The removal
  // notes, the competitor comparison and the Monitor/Compare sentences are the
  // ones an earlier, guessing cut of this gate flagged, in the six languages.
  // The block after them is what a cut that mined fragments flagged next: true
  // sentences about modules that have no write access, a capability matrix, a
  // settings line, an index of archived links, and a diagnose flow rebuilt
  // without tools and described in its own words.
  const honest = [
    'Read-only mode prevents writes to production',
    'Read-only orgs hide the write tools',
    'Diagnose why an operation failed from the log panel',
    'In a production org, only read-only tools stay enabled.',
    'Monitor and Compare are two read-only tools: they never write to an org.',
    'Monitor and Compare are two read-only tools for inspecting a failed Sync run.',
    'Diagnostics: Monitor and Compare are two read-only tools for inspecting a failed Sync run.',
    'Read-only tools in the toolbar stay available while the AI Assistant is off.',
    'The diagnostics panel shows why the last Sync run failed.',
    'While AI is on, every failed Seed run sends its error message to the model for a fix suggestion.',
    'The AI Assistant does not use read-only tools or diagnose failed jobs.',
    'Can the AI Assistant diagnose failed jobs with read-only tools?',
    'Unlike SFDMU, SandForge does not ship an agent with ten read-only org tools.',
    'The assistant can explain a failed job, but it has no read-only tools.',
    'Version 1.20 removed the tool-based diagnosis from the AI Assistant.',
    'Tools',
    "Diagnostiquer une erreur de connexion à l'org",
    "Le mode lecture seule masque les outils d'écriture.",
    'En production, seuls les outils en lecture seule restent actifs.',
    'Le panneau de diagnostic affiche la dernière exécution en échec.',
    'Monitor et Compare sont deux outils en lecture seule pour analyser une exécution en échec.',
    "L'assistant IA ne propose plus le diagnostic des jobs en échec par dix outils en lecture seule.",
    'Im schreibgeschützten Modus sind die Schreibwerkzeuge ausgeblendet.',
    'Im Schutzmodus bleiben nur zwei Werkzeuge ohne Schreibzugriff aktiv.',
    'Der KI-Assistent erklärt Fehler, führt aber keine Werkzeuge aus.',
    'Der KI-Assistent führt zehn schreibgeschützte Werkzeuge nicht mehr aus.',
    'Die Diagnose fehlgeschlagener Jobs über zehn schreibgeschützte Werkzeuge wurde in Version 1.20 entfernt.',
    'El modo de solo lectura oculta las herramientas de escritura.',
    'Herramientas de consulta SOQL',
    'En producción solo quedan activas las herramientas de solo lectura.',
    'El asistente de IA ya no ejecuta diez herramientas de solo lectura.',
    'El diagnóstico de trabajos fallidos con diez herramientas de solo lectura se eliminó en la versión 1.20.',
    'O modo somente leitura oculta as ferramentas de escrita.',
    'O painel de diagnóstico mostra a última execução com falha.',
    'O diagnóstico de jobs com falha usando dez ferramentas somente leitura foi removido na versão 1.20.',
    '読み取り専用モードでは書き込みツールが非表示になります',
    '診断パネルに失敗したジョブの一覧が表示されます',
    'AIアシスタントの読み取り専用ツールによる診断は廃止されました',
    'In a production org SandForge keeps a read-only tool surface: Compare inspects the schema, Monitor reads job state, and neither writes a record.',
    '**Read-only tool surface** — the set of operations a module may run without write access. Compare and Monitor never leave it.',
    'Unlike SFDMU, SandForge ships no agent at all: its read-only tool surface is limited to what Compare and Monitor read for you.',
    'Le mode read-only tool surface de Compare est le seul que la production autorise.',
    'Compare und Monitor bilden eine Read-only-Tool-Surface: Sie schreiben nie in die Org.',
    'Compare y Monitor mantienen una read-only tool surface: nunca escriben en la org.',
    'Compare と Monitor は read-only tool surface (読み取り専用) の範囲でのみ動作します。',
    '| Read-only suggested actions | Auto-execute | Never — you apply them yourself |',
    'Read-only suggested actions: auto-execute is off, and there is no setting that turns it on.',
    'See also: [Failed-job diagnosis](archive/diagnose.md), [read-only by design](archive/read-only.md) — both pages describe versions before 1.20.',
    "Compare's drift detection runs 10 fine-grained read-only tools of its own. None of them is an AI feature, and none needs a key.",
    '- **Failed-job diagnose flow** — right-click a failed bulk job in Monitor and the assistant explains the error in prose.',
  ];
  assert.deepEqual(
    honest.filter((text) => republishedClaims(text, PUBLISHED_CLAIMS).length > 0),
    [],
    'the mined wordings flag these honest sentences',
  );

  // The limit, pinned so it cannot drift into a claim this gate does not make:
  // prose refuses what was published, not what it means. Every line here is a
  // promise the extension cannot keep, and every line here passes. The anchor
  // above is what stops the tools themselves coming back, and it fails in both
  // directions — build them and it trips first, then this list is stale. The
  // last four are the near misses: a word inflected, and a wording split over
  // two locale keys that a component renders side by side.
  const paraphrasesThatPass = [
    'Chat, NL2SOQL, and read-only Salesforce tools that answer questions about your org',
    'The AI Assistant diagnoses failed jobs with ten read-only org tools.',
    'The assistant answers your questions with ten read-only sandbox tools.',
    'Ten read-only actions: it looks up records and explains why a job failed',
    'The AI Assistant queries your org with {{count}} read-only tools.',
    "L'assistant IA interroge votre org avec dix outils de consultation.",
    'Zehn schreibgeschützte KI-Werkzeuge beantworten Fragen zu Ihrer Org.',
    'El asistente de IA responde con diez herramientas de consulta.',
    'O assistente de IA consulta sua org com dez ferramentas de leitura.',
    'AIアシスタントが参照専用ツールでお答えします',
    'NL2SOQL and failed-job diagnostics over 10 read-only tools',
    '- **Read-only tool surfaces** (10 tools, registry CI fence, `DML_FORBIDDEN` at 2 layers)',
    'NL2SOQL and failed-job diagnosis over',
    '10 read-only tools',
  ];
  assert.deepEqual(
    paraphrasesThatPass.filter((text) => republishedClaims(text, PUBLISHED_CLAIMS).length > 0),
    [],
    'a paraphrase is now being refused — the rules have started guessing again, which is what ' +
      'this gate was rewritten to stop; re-read the limits in the header',
  );
});

test('no user-facing surface republishes the withdrawn AI wording', () => {
  // Diagnosis was only ever reachable through tools, so the wording is judged
  // against the same scan — controls included — rather than trusted.
  const found = toolCapabilities();
  assert.deepEqual(
    found,
    [],
    'shipped code can give the model tools again — the wording below may be true again:\n  ' +
      found.join('\n  '),
  );

  const offenders = [];
  for (const { label, text } of userFacingProse()) {
    for (const claim of republishedClaims(text, PUBLISHED_CLAIMS)) {
      offenders.push(`${label}: "${claim.text}" — published in ${claim.where}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'these surfaces put back wording the product withdrew. Rewrite the sentence; a note about ' +
      'the removal belongs in a changelog, which this gate does not read:\n  ' +
      offenders.join('\n  '),
  );
});

// ── Reading one file's syntax tree ────────────────────────────────────────

/** One shipped file, parsed. Never read as text: a comment promises nothing. */
function parseFile(relativePath) {
  const file = join(repoRoot, ...relativePath.split('/'));
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
}

/** Every call and `new` under a node, as `{ name, args, node }`, at any depth. */
function callsWithin(node) {
  const calls = [];
  const visit = (child) => {
    if (ts.isCallExpression(child) || ts.isNewExpression(child)) {
      calls.push({
        name: invokedName(child.expression),
        args: child.arguments ?? [],
        node: child,
      });
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return calls;
}

/** The body of a function declared at any depth in a file, by name. */
function functionBody(source, name) {
  let body;
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body) body = node.body;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return body;
}

/** The body of a class method declared at any depth in a file, by name. */
function methodBody(source, name) {
  let body;
  const visit = (node) => {
    if (ts.isMethodDeclaration(node) && memberName(node) === name && node.body) body = node.body;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return body;
}

/** Whether a node sits under an `if` — the difference between "always" and "sometimes". */
function isConditional(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isIfStatement(parent) || ts.isConditionalExpression(parent)) return true;
  }
  return false;
}

/**
 * Whether a condition asks nothing but whether the resolver is wired:
 * `resolver`, `deps.errorResolver`. A condition that reads neither — `true`, a
 * `case 'asked'` label — is not the resolver check either.
 */
function asksOnlyForTheResolver(condition) {
  let other = false;
  let readsResolver = false;
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (accessChain(node).join('.') !== 'deps.errorResolver') other = true;
      else readsResolver = true;
      return;
    }
    if (ts.isCallExpression(node) || (ts.isIdentifier(node) && node.text !== 'resolver')) {
      other = true;
    }
    if (ts.isIdentifier(node) && node.text === 'resolver') readsResolver = true;
    ts.forEachChild(node, visit);
  };
  visit(condition);
  return !other && readsResolver;
}

const SHORT_CIRCUIT = [
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
];

const LOGICAL_ASSIGNMENT = SHORT_CIRCUIT.slice(3);

/** Whether control runs off the end of a `switch` clause into the next one. */
function fallsThrough(clause) {
  let last = clause.statements.at(-1);
  while (last && ts.isBlock(last)) last = last.statements.at(-1);
  return !(
    last &&
    (ts.isBreakStatement(last) ||
      ts.isContinueStatement(last) ||
      ts.isReturnStatement(last) ||
      ts.isThrowStatement(last))
  );
}

/**
 * What decides whether a `switch` clause runs: the switch expression, the
 * clause's own label, and the label of every clause that falls through into
 * it — every label of the switch, once a `default` is on that path.
 */
function switchConditions(clause) {
  const { clauses } = clause.parent;
  const conditions = [clause.parent.parent.expression];
  const add = (reached) => {
    const labels = ts.isCaseClause(reached)
      ? [reached.expression]
      : clauses.filter(ts.isCaseClause).map((c) => c.expression);
    for (const label of labels) if (!conditions.includes(label)) conditions.push(label);
  };
  add(clause);
  for (let i = clauses.indexOf(clause) - 1; i >= 0 && fallsThrough(clauses[i]); i--) {
    add(clauses[i]);
  }
  return conditions;
}

/**
 * The conditions a node sits behind up to `body`: an `if` branch, a ternary
 * arm, the right of `&&`, `||`, `??` and of `&&=`, `||=`, `??=`, a `case` or
 * `default` of a `switch` (with the labels falling through into it), the body
 * of a `while`, `do`, `for`, `for…of` or `for…in` loop, and an argument of an
 * optional call or access, `consent?.(…)`.
 */
function enclosingConditions(node, body) {
  const conditions = [];
  for (let child = node; child.parent && child !== body; child = child.parent) {
    const parent = child.parent;
    if (ts.isIfStatement(parent) && child !== parent.expression) {
      conditions.push(parent.expression);
    } else if (ts.isConditionalExpression(parent) && child !== parent.condition) {
      conditions.push(parent.condition);
    } else if (
      (ts.isCaseClause(parent) && child !== parent.expression) ||
      ts.isDefaultClause(parent)
    ) {
      conditions.push(...switchConditions(parent));
    } else if (
      (ts.isCallExpression(parent) && parent.arguments.includes(child)) ||
      (ts.isElementAccessExpression(parent) && child === parent.argumentExpression)
    ) {
      for (
        let link = parent;
        ts.isCallExpression(link) ||
        ts.isPropertyAccessExpression(link) ||
        ts.isElementAccessExpression(link);
        link = link.expression
      ) {
        if (link.questionDotToken) conditions.push(link.expression);
      }
    } else if (
      (ts.isWhileStatement(parent) ||
        ts.isDoStatement(parent) ||
        ts.isForOfStatement(parent) ||
        ts.isForInStatement(parent)) &&
      child === parent.statement
    ) {
      conditions.push(parent.expression);
    } else if (ts.isForStatement(parent) && child === parent.statement) {
      if (parent.condition) conditions.push(parent.condition);
    } else if (
      ts.isBinaryExpression(parent) &&
      child === parent.right &&
      SHORT_CIRCUIT.includes(parent.operatorToken.kind)
    ) {
      conditions.push(parent.left);
    }
  }
  return conditions;
}

/**
 * The conditions written inside a value: every ternary and every left side of
 * a short-circuit in it, `{ r: asked ? resolver : undefined }` included. The
 * body of a function written in it is not the value, and is not read.
 */
function valueConditions(value) {
  const conditions = [];
  const visit = (node) => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isConditionalExpression(node)) conditions.push(node.condition);
    else if (ts.isBinaryExpression(node) && SHORT_CIRCUIT.includes(node.operatorToken.kind)) {
      conditions.push(node.left);
    }
    ts.forEachChild(node, visit);
  };
  visit(value);
  return conditions;
}

/**
 * Whether an assignment target gives `name` a value: the name itself, a
 * property of it (`box.r = …`), or a destructuring pattern that binds it
 * (`const [r] = …`, `({ r } = …)`).
 */
function bindsName(target, name) {
  const node = unwrap(target);
  if (ts.isIdentifier(node)) return node.text === name;
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    return accessChain(node)[0] === name;
  }
  if (ts.isArrayBindingPattern(node) || ts.isObjectBindingPattern(node)) {
    return node.elements.some(
      (element) => ts.isBindingElement(element) && bindsName(element.name, name),
    );
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.some((element) =>
      bindsName(
        ts.isSpreadElement(element)
          ? element.expression
          : ts.isBinaryExpression(element) &&
              element.operatorToken.kind === ts.SyntaxKind.EqualsToken
            ? element.left
            : element,
        name,
      ),
    );
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.some((property) =>
      ts.isShorthandPropertyAssignment(property)
        ? property.name.text === name
        : ts.isPropertyAssignment(property)
          ? bindsName(
              ts.isBinaryExpression(property.initializer) &&
                property.initializer.operatorToken.kind === ts.SyntaxKind.EqualsToken
                ? property.initializer.left
                : property.initializer,
              name,
            )
          : ts.isSpreadAssignment(property) && bindsName(property.expression, name),
    );
  }
  return false;
}

/**
 * The conditions under which a name is given its value inside a body: every
 * ternary and short-circuit in the value it is assigned or destructured from,
 * or in a default written in the pattern; the name's own earlier value, when
 * it is assigned with `&&=`, `||=` or `??=`; and whatever the assignment itself
 * sits behind.
 */
function bindingConditions(name, body) {
  const conditions = [];
  const visit = (node) => {
    let target = null;
    let value = null;
    if (ts.isVariableDeclaration(node) && node.initializer && bindsName(node.name, name)) {
      target = node.name;
      value = node.initializer;
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      bindsName(node.left, name)
    ) {
      target = node.left;
      value = node.right;
      if (LOGICAL_ASSIGNMENT.includes(node.operatorToken.kind)) conditions.push(node.left);
    }
    if (value) {
      conditions.push(...valueConditions(value));
      if (!ts.isIdentifier(unwrap(target))) conditions.push(...valueConditions(target));
      conditions.push(...enclosingConditions(node, body));
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return conditions;
}

/**
 * The conditions a `resolveError` call sits behind inside a body, as written,
 * minus the resolver check — around the call, inside the expression it is
 * called on, and around every value given to the name that expression starts
 * from, so `const resolver = asked ? deps.errorResolver : undefined` is a gate
 * like `if (asked)`.
 */
function resolveErrorConditions(body) {
  const conditions = [];
  for (const call of callsWithin(body).filter((c) => c.name === 'resolveError')) {
    const found = enclosingConditions(call.node, body);
    const callee = unwrap(call.node.expression);
    if (ts.isIdentifier(callee)) {
      found.push(...bindingConditions(callee.text, body));
    } else if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
      const receiver = unwrap(callee.expression);
      found.push(...valueConditions(receiver));
      const [root] = accessChain(receiver);
      if (root && root !== 'this') {
        found.push(...bindingConditions(root, body));
      }
    }
    for (const condition of found) {
      if (!asksOnlyForTheResolver(condition)) conditions.push(condition.getText());
    }
  }
  return conditions;
}

const OPERATION_FAILED_FILE = 'packages/extension/src/bridge/handlers/HandlerTypes.ts';
const AI_COMPOSITION_FILE = 'packages/extension/src/composition/aiComposition.ts';
const HANDLERS_FILE = 'packages/extension/src/bridge/ExtensionHandlers.ts';

/** Every assignment written under a node, `a.b = c` and `a.b ??= c` alike. */
function assignmentsWithin(node) {
  const assignments = [];
  const visit = (child) => {
    if (isAssignment(child)) assignments.push(child);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return assignments;
}

/** Whether a statement can return from the function it sits in. */
function returnsFrom(node) {
  let found = false;
  const visit = (child) => {
    if (ts.isFunctionLike(child)) return;
    if (ts.isReturnStatement(child)) found = true;
    else ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

// ── Error resolution nobody asked for ─────────────────────────────────────

/**
 * The extension asks the model to explain a failure the moment one happens.
 *
 * `sendOperationFailed` is the only emitter of `operation:failed`, and it ends
 * on `resolveFailedOperation`, which calls `resolver.resolveError(...)` — with
 * no screen, no button and no consent in between. The resolver reads a
 * knowledge base first, so a *known* Salesforce error code is answered from
 * disk; an unknown one goes to `this.provider(...)`, which
 * `aiComposition.ts` builds out of `services.aiClient().chat`.
 *
 * So while AI is on, a failed run can put the org's own error text — which
 * quotes record values — in front of the model without the user doing
 * anything. Any surface that says data leaves only when the user asks for it
 * is describing a version of this extension that stopped existing when the
 * resolution moved into the emitter.
 *
 * Fails in both directions: put the resolution back behind a button and the
 * assertions below trip, and the wording they refuse may be published again.
 */
function assertFailureResolutionIsAutomatic() {
  const source = parseFile(OPERATION_FAILED_FILE);

  const emitter = functionBody(source, 'sendOperationFailed');
  assert.ok(
    emitter,
    `${OPERATION_FAILED_FILE} no longer declares sendOperationFailed — the emitter of ` +
      'operation:failed moved, so this anchor is reading nothing; find it and re-point the scan',
  );
  const emitterCalls = callsWithin(emitter).map((call) => call.name);
  // Positive control: the walk reads that body, and sees what it does with the
  // message before it sees what it does about the failure.
  assert.ok(
    emitterCalls.includes('postToWebview'),
    'the scan cannot see sendOperationFailed posting the lifecycle message — it is reading an ' +
      'empty body, so the absence of a resolution call below would prove nothing',
  );
  assert.ok(
    emitterCalls.includes('resolveFailedOperation'),
    'sendOperationFailed no longer resolves the failure it reports. If a user action is needed ' +
      'again before anything reaches the model, the wordings below became true and may go back.',
  );

  const resolution = functionBody(source, 'resolveFailedOperation');
  assert.ok(resolution, `${OPERATION_FAILED_FILE} no longer declares resolveFailedOperation`);
  const resolutionCalls = callsWithin(resolution).map((call) => call.name);
  assert.ok(
    resolutionCalls.includes('resolveError'),
    'resolveFailedOperation no longer calls resolveError — nothing is asked of the model on a ' +
      'failure any more, and the wordings below may be published again',
  );
  // The resolver it calls is the one handed to the emitter's deps, by that name.
  assert.ok(
    resolution.getText().includes('deps.errorResolver'),
    'resolveFailedOperation no longer reads deps.errorResolver — it resolves through something ' +
      'else, so the wire checked below is no longer the wire that matters',
  );

  // WHEN it is called. A resolution put behind `if (userAskedForIt)` still
  // reads `resolveError` above, and the wordings below would be true again
  // with every other assertion here green. The one condition that changes
  // nothing is whether a resolver is wired at all: that is the AI switch.
  // Positive control first: the same walk finds the gates a probe puts in.
  const probe = functionBody(
    ts.createSourceFile(
      'probe.ts',
      [
        'function resolveFailedOperation(deps, error) {',
        '  const resolver = deps.errorResolver;',
        '  if (!resolver) return;',
        '  if (resolver) void resolver.resolveError(error);',
        '  void deps.errorResolver?.resolveError(error);',
        '  if (deps.userAskedForIt) { void resolver.resolveError(error); }',
        '  void (consented(error) ? resolver.resolveError(error) : undefined);',
        '  deps.userAskedForIt && resolver.resolveError(error);',
        '  const chosen = deps.userAskedForIt ? deps.errorResolver : undefined;',
        '  void chosen?.resolveError(error);',
        '  const either = deps.errorResolver ?? undefined;',
        '  void either?.resolveError(error);',
        '  let late;',
        '  if (consented(error)) late = deps.errorResolver;',
        '  void late?.resolveError(error);',
        "  switch (deps.mode) { case 'asked': void resolver.resolveError(error); break; default: break; }",
        '  switch (deps.mode) { default: void resolver.resolveError(error); }',
        '  while (deps.pending()) void resolver.resolveError(error);',
        '  do { void resolver.resolveError(error); } while (deps.again);',
        '  for (let i = 0; i < deps.asked; i++) void resolver.resolveError(error);',
        '  for (const failure of deps.askedFailures) void resolver.resolveError(failure);',
        '  for (;;) { void resolver.resolveError(error); break; }',
        '  switch (true) { case deps.userAskedForIt: void resolver.resolveError(error); }',
        "  switch (deps.kind) { case deps.first: case 'second': void resolver.resolveError(error); }",
        '  const [picked] = deps.userAskedForIt ? [deps.errorResolver] : [];',
        '  void picked?.resolveError(error);',
        '  void (deps.userAskedForIt ? resolver : undefined)?.resolveError(error);',
        '  const box = { r: deps.userAskedForIt ? resolver : undefined };',
        '  void box.r?.resolveError(error);',
        '  const slot = {};',
        '  slot.r = deps.userAskedForIt ? resolver : undefined;',
        '  void slot.r?.resolveError(error);',
        '  let other;',
        '  ({ other } = deps.userAskedForIt ? { other: resolver } : {});',
        '  void other?.resolveError(error);',
        '  const { alt = deps.userAskedForIt ? resolver : undefined } = deps;',
        '  void alt?.resolveError(error);',
        '  const { resolveError } = deps.userAskedForIt ? resolver : {};',
        '  void resolveError(error);',
        '  let asked = deps.userAskedForIt;',
        '  asked &&= !!resolver.resolveError(error);',
        '  let kept = deps.userAskedForIt;',
        '  kept &&= deps.errorResolver;',
        '  void kept?.resolveError(error);',
        '  deps.onConsent?.(resolver.resolveError(error));',
        '}',
      ].join('\n'),
      ts.ScriptTarget.Latest,
      true,
    ),
    'resolveFailedOperation',
  );
  assert.deepEqual(
    resolveErrorConditions(probe),
    [
      'deps.userAskedForIt',
      'consented(error)',
      'deps.userAskedForIt',
      'deps.userAskedForIt',
      'consented(error)',
      'deps.mode',
      "'asked'",
      'deps.mode',
      'deps.pending()',
      'deps.again',
      'i < deps.asked',
      'deps.askedFailures',
      'true',
      'deps.userAskedForIt',
      'deps.kind',
      "'second'",
      'deps.first',
      'deps.userAskedForIt',
      'deps.userAskedForIt',
      'deps.userAskedForIt',
      'deps.userAskedForIt',
      'deps.userAskedForIt',
      'deps.userAskedForIt',
      'deps.userAskedForIt',
      'asked',
      'kept',
      'deps.onConsent',
    ],
    'the condition walk no longer tells a consent gate from the resolver check — the empty list ' +
      'below would prove nothing',
  );
  // A gate written into `deps` itself is a gate too: a property set on it, or
  // a new value for it, puts the call behind the condition exactly as an `if`
  // would. Each shape gets a body of its own, because a value given to a name
  // gates every call made through that name.
  for (const written of [
    'deps.errorResolver = deps.userAskedForIt ? deps.errorResolver : undefined;',
    'deps = deps.userAskedForIt ? deps : { ...deps, errorResolver: undefined };',
  ]) {
    const body = functionBody(
      ts.createSourceFile(
        'probe.ts',
        [
          'function resolveFailedOperation(deps, error) {',
          `  ${written}`,
          '  void deps.errorResolver?.resolveError(error);',
          '}',
        ].join('\n'),
        ts.ScriptTarget.Latest,
        true,
      ),
      'resolveFailedOperation',
    );
    assert.deepEqual(
      resolveErrorConditions(body),
      ['deps.userAskedForIt'],
      `the condition walk no longer reads a gate written into deps: ${written}`,
    );
  }
  const gated = resolveErrorConditions(resolution);
  assert.deepEqual(
    gated,
    [],
    'resolveFailedOperation now calls resolveError behind a condition — a failure may reach the ' +
      'model only when something asks for it, and the wordings below may be true again:\n  ' +
      gated.join('\n  '),
  );

  // And something puts a resolver in those deps. `setAIModules` is the only
  // wire between the AI stack and the emitter: it mutates the shared deps
  // object, and deleting that one line leaves every call above in place while
  // no failure ever reaches the model again — `resolveFailedOperation` returns
  // on its first statement. The wordings would be true, with nothing else in
  // this anchor moving.
  const setter = methodBody(parseFile(HANDLERS_FILE), 'setAIModules');
  assert.ok(
    setter,
    `${HANDLERS_FILE} no longer declares setAIModules — the injection point moved; find it and ` +
      're-point this anchor rather than dropping it',
  );
  // Positive control: the walk reads that body, and sees it hand the modules on.
  assert.ok(
    callsWithin(setter).some((call) => call.name === 'setAIModules'),
    'the scan cannot see setAIModules passing the modules to the AI handler — it is reading an ' +
      'empty body, so the assignment below would prove nothing',
  );
  // Into WHICH object. `handlerDeps` is the one the emitter is handed — every
  // handler is constructed on it — so an assignment named `errorResolver` on any
  // other deps object is a resolver nothing reads. Matching the property name
  // alone left this anchor green while the wire was cut.
  const intoHandlerDeps = (target) => accessChain(target).includes('handlerDeps');
  const wired = assignmentsWithin(setter).filter(
    (node) =>
      assignedProperty(node.left) === 'errorResolver' &&
      intoHandlerDeps(node.left) &&
      reads(node.right, 'modules'),
  );
  // The same wire written as a merge: `Object.assign(this.handlerDeps, { … })`
  // reaches the emitter exactly as the assignment does, and refusing to read it
  // would fail this anchor on a rewrite that changed nothing.
  const merged = callsWithin(setter).filter((call) => {
    if (accessChain(call.node.expression).join('.') !== 'Object.assign') return false;
    const [target, ...patches] = call.args;
    if (!target || !intoHandlerDeps(target)) return false;
    return patches.some(
      (patch) =>
        ts.isObjectLiteralExpression(patch) &&
        patch.properties.some((property) => memberName(property) === 'errorResolver') &&
        reads(patch, 'modules'),
    );
  });
  assert.equal(
    wired.length + merged.length,
    1,
    'setAIModules no longer copies the injected errorResolver into the handler deps the emitter ' +
      'reads — nothing reaches the model on a failure any more, and the wordings below became true',
  );

  // And that resolver can reach the model: it is built with the provider that
  // closes over `services.aiClient().chat`.
  const built = callsWithin(parseFile(AI_COMPOSITION_FILE)).filter(
    (call) => call.name === 'ErrorResolver',
  );
  assert.ok(
    built.length > 0,
    `${AI_COMPOSITION_FILE} no longer builds an ErrorResolver — re-read this anchor`,
  );
  const providerless = built.filter((call) => call.args.length === 0);
  assert.equal(
    providerless.length,
    0,
    'the ErrorResolver is built with no provider — it can only answer from its knowledge base, ' +
      'nothing reaches the model on a failure, and the wordings below became true',
  );
}

test('anchor: a failed operation still asks the model on its own', () => {
  assertFailureResolutionIsAutomatic();
});

/**
 * What this product published about when data leaves, mined from every
 * revision of `docs/faq.md`: one privacy answer, in two wordings, carried from
 * the first FAQ (cb52cda6, 2026-03-16) to the day the automatic resolution was
 * documented (8110fd25, 2026-09-11).
 *
 * `No data is sent otherwise`, the sentence that followed, is not mined: at 25
 * characters it is a phrase any page about telemetry or about a provider that
 * is not configured may write truthfully.
 */
const AUTOMATIC_SEND_CLAIMS = [
  {
    text: 'Data is sent to your LLM provider (Anthropic) only when you explicitly use AI features',
    where: 'the privacy answer, docs/faq.md, 2026-08-10 to 2026-09-10',
  },
  {
    text: 'Data is sent to your chosen LLM provider only when you explicitly use AI features',
    where: 'the privacy answer, docs/faq.md, 2026-03-16 to 2026-03-27',
  },
].map(mine);

test('no user-facing surface says the model hears nothing you did not ask for', () => {
  assertFailureResolutionIsAutomatic();

  const offenders = [];
  for (const { label, text } of userFacingProse()) {
    for (const claim of republishedClaims(text, AUTOMATIC_SEND_CLAIMS)) {
      offenders.push(`${label}: "${claim.text}" — published in ${claim.where}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'a failed run sends its error text to the model with no user action, so these surfaces ' +
      'promise a silence the extension does not keep:\n  ' +
      offenders.join('\n  '),
  );
});

// ── Rule-based analysis sold as AI ────────────────────────────────────────

/**
 * Compare's schema advice and Monitor's anomaly scan run on local heuristics.
 *
 * Every other AI module in `aiComposition.ts` is handed `aiProvider`, the
 * function that closes over `services.aiClient().chat` — `new NL2SOQL(…)`,
 * `new ErrorResolver(…)`, `new PipelineGenerator(…)`. `AnomalyDetector` and
 * `SchemaAdvisor` are constructed with nothing at all, so there is no route
 * from either to a model, and `setRuleModules` is called outside the
 * `isAIEnabled()` / API-key gate, so neither needs the setting or the key.
 *
 * Fails in both directions: pass either one a provider and the arity check
 * trips, which is the moment the wordings below stop being false.
 */
function assertRuleModulesHaveNoProvider() {
  const calls = callsWithin(parseFile(AI_COMPOSITION_FILE));

  // Positive control: the same arity check sees the constructions that DO take
  // a provider, in the same file. Without it, a walk returning nothing would
  // read as "no provider anywhere".
  const withProvider = calls.filter((call) =>
    ['NL2SOQL', 'ErrorResolver', 'PipelineGenerator'].includes(call.name),
  );
  assert.equal(
    withProvider.length,
    3,
    `the scan sees ${withProvider.length} model-backed modules built in ${AI_COMPOSITION_FILE}, ` +
      'not the three it carries — it is not reading constructions, so the arity check below ' +
      'proves nothing',
  );
  assert.deepEqual(
    withProvider.filter((call) => call.args.length === 0).map((call) => call.name),
    [],
    'a model-backed AI module is now built with no argument — the arity check cannot tell a ' +
      'rule-based module from a model-backed one any more',
  );

  for (const name of ['AnomalyDetector', 'SchemaAdvisor']) {
    const built = calls.filter((call) => call.name === name);
    assert.ok(
      built.length > 0,
      `${AI_COMPOSITION_FILE} no longer builds a ${name} — re-point this anchor before ` +
        'trusting it',
    );
    assert.deepEqual(
      built.filter((call) => call.args.length > 0).map((call) => call.name),
      [],
      `${name} is now built with an argument. If that argument is a model provider, the ` +
        'wordings below became true and may be published again — check, then rewrite this anchor.',
    );
  }

  // Wired outside the AI gate, so "needs AI enabled with a key" is false too.
  // The gate is not an `if` wrapped around the wiring: `initAIComposition`
  // leaves on an early `return` when the setting is off and again when no key
  // is stored. So the question this asks is position — does the statement that
  // wires them run before anything in that body can return? Move the call six
  // lines down, under both returns, and no condition appears anywhere near it
  // while the modules stop existing for a user with AI off.
  const composition = functionBody(parseFile(AI_COMPOSITION_FILE), 'initAIComposition');
  assert.ok(
    composition,
    `${AI_COMPOSITION_FILE} no longer declares initAIComposition — the composition root moved; ` +
      'find it and re-point this anchor',
  );
  const statements = [...composition.statements];
  const wiringAt = statements.findIndex((statement) =>
    callsWithin(statement).some((call) => call.name === 'setRuleModules'),
  );
  assert.ok(
    wiringAt >= 0,
    'initAIComposition no longer wires the rule-based modules at all — the anomaly scan and the ' +
      'schema advice reach no screen, whatever the AI setting says',
  );
  // Positive control: the walk sees the gate it is measuring against. A body
  // with no early exit would make "before the first return" true for free.
  const firstReturnAt = statements.findIndex(returnsFrom);
  assert.ok(
    firstReturnAt > 0,
    'the scan sees no statement that can return in initAIComposition — the AI gate is not two ' +
      'early returns any more, so the position check below proves nothing; read the body and ' +
      'rewrite this anchor against whatever gates it now',
  );
  assert.ok(
    wiringAt < firstReturnAt,
    `setRuleModules is now wired at statement ${wiringAt + 1}, after the first one that can ` +
      `return (${firstReturnAt + 1}) — the rule-based modules sit behind the AI gate, so "they ` +
      'run with AI off and no key" became false in every language that says it',
  );

  const wiring = calls.filter((call) => call.name === 'setRuleModules');
  assert.equal(wiring.length, 1, 'setRuleModules is no longer called exactly once — re-read this');
  assert.equal(
    isConditional(wiring[0].node),
    false,
    'the rule-based modules are now wired behind a condition — they may depend on the AI ' +
      'setting or the key again',
  );
  // Positive control: the same ancestor walk finds a call that IS gated.
  assert.ok(
    calls.some((call) => call.name === 'teardownAI' && isConditional(call.node)),
    'the scan sees no conditional call in the composition root — it is not reading ancestors, ' +
      'so "not behind a condition" above proves nothing',
  );
}

test('anchor: schema advice and the anomaly scan are still built without a model', () => {
  assertRuleModulesHaveNoProvider();
});

/**
 * What this product published about those two, mined from every revision of
 * `packages/extension/README.md` and of the two module pages. The headings
 * themselves (`### Schema Advice (AI)`) are not mined: three words are too few
 * to refuse, and `docs/modules/compare.docs.test.ts` pins that one anyway.
 */
const RULE_BASED_CLAIMS = [
  {
    text: 'The Schema Advice button uses AI to analyze your source org schema and surface issues',
    where: 'the Schema Advice section, docs/modules/compare.md, to v1.21',
  },
  {
    text: 'Anomaly scan button that uses AI to detect statistical outliers',
    where: 'the Monitor feature list, docs/modules/monitor.md, to v1.21',
  },
  {
    text: '**Schema Advice** — AI-powered schema analysis and recommendations',
    where: 'the AI section, packages/extension/README.md, to v1.7.0',
  },
  {
    text: '**Schema Advice** — AI-powered schema analysis with actionable recommendations',
    where: 'the AI section, packages/extension/README.md, to v1.7.0',
  },
  {
    text: '**Anomaly Detection** — AI-powered statistical outlier detection',
    where: 'the AI section, packages/extension/README.md, to v1.7.0',
  },
  {
    // The opposite error, in the row that replaced them: rule-based, but sold
    // as needing the stack `setRuleModules` is deliberately wired before.
    text: "Compare's schema advice and Monitor's anomaly scan are rule-based but still need AI enabled with a key",
    where: 'the AI Assistant row of the feature table, both READMEs, v1.21',
  },
].map(mine);

test('no user-facing surface sells the rule-based analysis as a model', () => {
  assertRuleModulesHaveNoProvider();

  const offenders = [];
  for (const { label, text } of userFacingProse()) {
    for (const claim of republishedClaims(text, RULE_BASED_CLAIMS)) {
      offenders.push(`${label}: "${claim.text}" — published in ${claim.where}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'schema advice and the anomaly scan are built with no provider and wired before the AI ' +
      'gate; these surfaces sell them as something else:\n  ' +
      offenders.join('\n  '),
  );
});

test('the two new mined lists are matched whole, and honest prose is left alone', () => {
  assertMinedWordingsCarryAClaim(AUTOMATIC_SEND_CLAIMS);
  assertMinedWordingsCarryAClaim(RULE_BASED_CLAIMS);

  // Each wording as published, then the shapes a reappearance takes: the whole
  // FAQ answer it sat in, a paragraph wrapped mid-phrase, emphasis inside a
  // word, a space written as an entity, an invisible character pasted mid-word,
  // a heading plus the sentence under it, a bullet carried on past the wording,
  // and a removal note quoting it.
  const republished = [
    ...AUTOMATIC_SEND_CLAIMS.map((claim) => claim.text),
    ...RULE_BASED_CLAIMS.map((claim) => claim.text),
    'Data is sent to your LLM provider (Anthropic) only when you explicitly use AI features (AI data generation, NL2SOQL, Schema Advice, Pipeline Generator). No data is sent otherwise.',
    'Data is sent to your LLM provider (Anthropic) only when you\nexplicitly use AI features.',
    'Data is sent to your LLM provider (Anthropic) only when you *explicitly* use AI features',
    'Data is sent to your LLM&nbsp;provider (Anthropic) only when you explicitly use AI features',
    'Data is sent to your LLM provider (Anthropic) only when you explic​itly use AI features',
    'Until 1.21 the FAQ said "Data is sent to your chosen LLM provider only when you explicitly use AI features".',
    '### Schema Advice (AI)\n\nThe Schema Advice button uses AI to analyze your source org schema and surface issues:',
    '- Anomaly scan button that uses AI to detect statistical outliers, future dates and negative amounts',
    '- **Schema Advice** -- AI-powered schema analysis and recommendations',
    '- **Anomaly Detection** — AI-powered statistical outlier detection',
    "| **AI Assistant** | Compare's schema advice and Monitor's anomaly scan are rule-based but still need AI enabled with a key |",
  ];
  assert.deepEqual(
    republished.filter(
      (text) =>
        republishedClaims(text, AUTOMATIC_SEND_CLAIMS).length === 0 &&
        republishedClaims(text, RULE_BASED_CLAIMS).length === 0,
    ),
    [],
    'these republish wording the product withdrew, and the rules let them through',
  );

  // Prose an honest page could hold, with the same words in it, in the six
  // languages the extension ships — the current FAQ privacy answer, the
  // current README row and the current module pages among them. The last two
  // are the near misses the header's limits declare: one word inflected, and a
  // true sentence built out of the same vocabulary.
  const honest = [
    'Only to Anthropic, and nothing before you turn AI on and store an Anthropic key. Every failed Seed, Sync, DataOps or Automation run also sends its error message automatically, for a fix suggestion.',
    'No data is sent to the model while AI is off.',
    'Data is sent to your LLM provider automatically when a run fails, as well as when you use an AI feature.',
    'Telemetry is opt-in and never includes org data or PII.',
    "Compare's schema advice and Monitor's anomaly scan are rule-based: they run with AI off and no key",
    'The Schema Advice button reads your source org describe and runs it through a set of rules -- no model, no key, nothing leaves the machine',
    'Anomaly scan button: statistical outliers, future dates, negative amounts. Rules only -- no model, no key, and it works with AI off',
    'Unlike SFDMU, SandForge sends nothing to an LLM unless you turn AI on.',
    'Schema advice and the anomaly scan were once described as AI-powered. They have always been rule-based.',
    "Les données ne partent chez Anthropic qu'une fois l'IA activée et la clé enregistrée.",
    'Les conseils de schéma de Compare reposent sur des règles : aucun modèle, aucune clé.',
    "Chaque exécution en échec envoie son message d'erreur au modèle, sans action de votre part.",
    'Die Schema-Empfehlungen von Compare sind regelbasiert: kein Modell, kein Schlüssel.',
    'Daten werden an Anthropic gesendet, sobald ein Lauf fehlschlägt.',
    'El escaneo de anomalías de Monitor se basa en reglas y no usa ningún modelo.',
    'Los datos se envían a su proveedor de IA en cuanto una ejecución falla.',
    'A varredura de anomalias do Monitor é baseada em regras: nenhum modelo, nenhuma chave.',
    'Os dados são enviados ao provedor de IA assim que uma execução falha.',
    'Compare のスキーマ提案はルールベースで、モデルもキーも使いません。',
    'AIが有効な場合、失敗した実行のエラーメッセージが自動的にモデルへ送信されます。',
    'Data is sent to your LLM provider (Anthropic) only when you explicitly use an AI feature',
    'The Schema Advice button uses a rule set to analyze your source org schema and surface issues',
  ];
  assert.deepEqual(
    honest.filter(
      (text) =>
        republishedClaims(text, AUTOMATIC_SEND_CLAIMS).length > 0 ||
        republishedClaims(text, RULE_BASED_CLAIMS).length > 0,
    ),
    [],
    'the two new mined lists flag these honest sentences — the rules have started guessing, ' +
      'which is what this gate was rewritten to stop',
  );
});

// ── one model setting, sold as the chat's ─────────────────────────────────

const SERVICES_FILE = 'packages/extension/src/services.ts';
const AI_FACTORY_FILE = 'packages/extension/src/adapters/ai/AIClientFactory.ts';
const SEED_HANDLER_FILE = 'packages/extension/src/bridge/handlers/SeedOpsHandler.ts';
const MODEL_SETTING = 'sandforge.ai.model';

/** The `aiClient().chat(…)` calls a file makes — the one route to a model. */
function sharedClientChatCalls(relativePath) {
  return callsWithin(parseFile(relativePath)).filter((call) => {
    if (call.name !== 'chat') return false;
    return accessChain(call.node.expression).slice(-2).join('.') === 'aiClient.chat';
  });
}

/**
 * `sandforge.ai.model` configures one adapter, and every feature that talks to
 * a model goes through it.
 *
 * `services.ts` reads the setting in the `getModel` it hands to
 * `createAIClientFactory`, the factory passes it to each adapter it builds,
 * and `services.aiClient()` returns one memoised instance per provider. From
 * there the calls fan out: `aiComposition.ts` closes over `.chat` twice — once
 * for the assistant, once for the `aiProvider` that NL2SOQL, the
 * `ErrorResolver` and the `PipelineGenerator` are built on — and
 * `SeedOpsHandler.ts` calls it twice more, for a custom persona and for the
 * field values a seed run generates.
 *
 * Fails in both directions: cut the setting off from the factory, or route a
 * feature around `aiClient()`, and the counts below move — which is the moment
 * a description naming one feature could start being true.
 */
function assertOneModelSettingServesEveryAIFeature() {
  const factoryCall = callsWithin(parseFile(SERVICES_FILE)).find(
    (call) => call.name === 'createAIClientFactory',
  );
  assert.ok(factoryCall, `${SERVICES_FILE} no longer builds the AI client factory`);
  const deps = factoryCall.args[0];
  assert.ok(
    deps && ts.isObjectLiteralExpression(deps),
    'the AI client factory is built with no dependency object — re-read this anchor',
  );
  const getModel = deps.properties.find((property) => memberName(property) === 'getModel');
  assert.ok(getModel, 'the factory gets no model reader — the setting reaches no adapter');

  const reads = callsWithin(getModel).map((call) => ({
    name: call.name,
    literals: call.args.filter(ts.isStringLiteralLike).map((arg) => arg.text),
  }));
  assert.ok(
    reads.some(
      (call) => call.name === 'getConfiguration' && call.literals.includes('sandforge.ai'),
    ),
    'the model reader no longer reads the sandforge.ai configuration section',
  );
  assert.ok(
    reads.some((call) => call.name === 'get' && call.literals.includes('model')),
    `the model reader no longer reads \`model\` — ${MODEL_SETTING} configures nothing`,
  );

  const adapters = callsWithin(parseFile(AI_FACTORY_FILE)).filter((call) =>
    /Adapter$/.test(call.name ?? ''),
  );
  assert.equal(
    adapters.length,
    3,
    `the scan sees ${adapters.length} adapters built in ${AI_FACTORY_FILE}, not the three it ` +
      'carries — it is not reading constructions, so the check below proves nothing',
  );
  assert.deepEqual(
    adapters
      .filter((adapter) => {
        const arg = adapter.args[0];
        return (
          !arg ||
          !ts.isObjectLiteralExpression(arg) ||
          !arg.properties.some((property) => memberName(property) === 'model')
        );
      })
      .map((adapter) => adapter.name),
    [],
    'an adapter is built without the model this setting carries',
  );

  assert.equal(
    sharedClientChatCalls(AI_COMPOSITION_FILE).length,
    2,
    `${AI_COMPOSITION_FILE} no longer makes the two model calls the assistant and the AI ` +
      'modules are built on — re-read this anchor',
  );
  assert.equal(
    callsWithin(parseFile(AI_COMPOSITION_FILE)).filter((call) =>
      ['NL2SOQL', 'ErrorResolver', 'PipelineGenerator'].includes(call.name),
    ).length,
    3,
    'the three model-backed modules are no longer built there',
  );
  assert.equal(
    sharedClientChatCalls(SEED_HANDLER_FILE).length,
    2,
    `${SEED_HANDLER_FILE} no longer calls the model for personas and field values — the setting ` +
      'may have stopped reaching Seed',
  );
}

test('anchor: every AI feature calls the model this setting names', () => {
  assertOneModelSettingServesEveryAIFeature();
});

/**
 * What a description of this setting cannot leave out, named by the two words
 * that survive translation: `NL2SOQL` and `Seed` are product nouns, written the
 * same in all six bundles, and each belongs to a module the chat panel has
 * nothing to do with. A sentence that names both is not selling the setting as
 * the assistant's.
 *
 * The wording is otherwise free: what this pins is that the reader learns the
 * model is shared, not that six locales repeat one sentence.
 */
const SHARED_MODEL_MARKERS = [
  { name: 'NL2SOQL', pattern: /NL2SOQL/i },
  { name: 'Seed', pattern: /Seed/i },
];

/**
 * The eight places this setting is described: the sentence VS Code shows in
 * the Settings editor, in six languages, and the row each README gives it.
 */
function modelSettingDescriptions() {
  const properties =
    JSON.parse(read(...EXT, 'package.json')).contributes?.configuration?.properties ?? {};
  const placeholder = properties[MODEL_SETTING]?.description;
  assert.ok(
    isNlsPlaceholder(placeholder),
    `${MODEL_SETTING} carries no localized description — re-read this gate`,
  );
  const surfaces = Object.entries(resolveNls(placeholder)).map(([locale, text]) => ({
    label: `${NLS_FILES[locale]} config.ai.model.description`,
    text,
  }));
  for (const readme of READMES) {
    const row = read(...readme.split('/'))
      .split(/\r?\n/)
      .find((line) => line.startsWith(`| \`${MODEL_SETTING}\``));
    assert.ok(row, `${readme} no longer lists ${MODEL_SETTING} in its settings table`);
    surfaces.push({ label: `${readme} settings table`, text: row.split('|')[2] ?? '' });
  }
  assert.equal(surfaces.length, 8, 'the eight descriptions of this setting are no longer eight');
  return surfaces;
}

test('the model setting is described by everything that reads it', () => {
  assertOneModelSettingServesEveryAIFeature();

  const offenders = [];
  for (const { label, text } of modelSettingDescriptions()) {
    const missing = SHARED_MODEL_MARKERS.filter((marker) => !marker.pattern.test(text));
    if (missing.length > 0) {
      offenders.push(
        `${label}: "${text.trim()}" — names neither ${missing.map((m) => m.name).join(' nor ')}`,
      );
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'this setting picks the model for NL2SOQL, pipeline drafts, error resolution and Seed as ' +
      'much as for the chat; these descriptions hand it to one feature:\n  ' +
      offenders.join('\n  '),
  );
});

/**
 * The sentence that gave the setting to the assistant, as it shipped in five of
 * the six bundles and in both README settings tables.
 *
 * The Japanese one is not mined: at 16 characters it is any line about a model
 * an assistant uses, and refusing it across the whole product would cost more
 * than it buys. All six locales are covered by the marker rule above, which
 * reads this setting's own descriptions rather than every page.
 */
const ASSISTANT_ONLY_MODEL_CLAIMS = [
  {
    text: 'AI model to use for the assistant',
    where: 'the Settings editor, package.nls.json, to v1.21',
  },
  {
    text: 'AI model used by the assistant',
    where: 'the settings table, both READMEs, to v1.21',
  },
  {
    text: "Modèle IA à utiliser pour l'assistant",
    where: 'the Settings editor, package.nls.fr.json, to v1.21',
  },
  {
    text: 'Zu verwendendes KI-Modell für den Assistenten',
    where: 'the Settings editor, package.nls.de.json, to v1.21',
  },
  {
    text: 'Modelo de IA a usar para el asistente',
    where: 'the Settings editor, package.nls.es.json, to v1.21',
  },
  {
    text: 'Modelo de IA a ser usado pelo assistente',
    where: 'the Settings editor, package.nls.pt-br.json, to v1.21',
  },
].map(mine);

test('no user-facing surface gives the model setting to the assistant alone', () => {
  assertMinedWordingsCarryAClaim(ASSISTANT_ONLY_MODEL_CLAIMS);
  assertOneModelSettingServesEveryAIFeature();

  const offenders = [];
  for (const { label, text } of userFacingProse()) {
    for (const claim of republishedClaims(text, ASSISTANT_ONLY_MODEL_CLAIMS)) {
      offenders.push(`${label}: "${claim.text}" — published in ${claim.where}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'five features pick their model from this setting; these surfaces still give it to one:\n  ' +
      offenders.join('\n  '),
  );
});

// ── a saved conversation that could not be continued ──────────────────────

const AI_CHAT_HANDLER_FILE = 'packages/extension/src/bridge/handlers/ai/AIChatHandler.ts';
const AI_ASSISTANT_FILE = 'packages/extension/src/modules/ai/AIAssistant.ts';

/**
 * A conversation reopened after a restart can be continued, and the model is
 * given its last 20 messages.
 *
 * The assistant only knew the conversations opened in the current session, so
 * the first message sent into an older one came back as "conversation not
 * found". Chat now reloads it from the store before it answers. What the
 * transcript shows and what the model is given are two different things: the
 * page shows the conversation whole, the assistant sends the tail.
 */
function assertChatRestoresAConversationAndSendsItsTail() {
  const handler = parseFile(AI_CHAT_HANDLER_FILE);
  const chat = methodBody(handler, 'handleChat');
  assert.ok(chat, `${AI_CHAT_HANDLER_FILE} no longer declares handleChat — re-point this anchor`);
  const called = callsWithin(chat).map((call) => call.name);
  // Positive control: the walk reads that body, and sees it chat.
  assert.ok(
    called.includes('chat'),
    'the scan cannot see handleChat calling the assistant — it is reading an empty body, so the ' +
      'restore below would prove nothing',
  );
  assert.ok(
    called.includes('restoreConversationIfNeeded'),
    'handleChat no longer reloads a persisted conversation: an older chat cannot be continued ' +
      'again, and the wordings below became true',
  );

  const assistant = parseFile(AI_ASSISTANT_FILE);
  const window = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      memberName(node.expression) === 'slice' &&
      node.arguments.length === 1
    ) {
      window.push(node.arguments[0].getText(assistant));
    }
    ts.forEachChild(node, visit);
  };
  visit(assistant);
  assert.ok(
    window.includes('-20'),
    'the assistant no longer gives the model the last 20 messages of a conversation — say what ' +
      'it gives now wherever the number is written',
  );
}

test('anchor: a reopened conversation is continued, and the model gets its last 20 messages', () => {
  assertChatRestoresAConversationAndSendsItsTail();
});

/**
 * What this product published about a saved chat, mined from the two surfaces
 * that carried it: the feature table of both READMEs, and the release note
 * that announced the fix while overstating what the model is given.
 */
const SAVED_CHAT_CLAIMS = [
  {
    text: 'A saved chat can be reread but not continued once VS Code restarts or an AI setting changes',
    where: 'the AI Assistant row of the feature table, both READMEs, v1.22.0',
  },
  {
    text: 'It now resumes with its full history, in order',
    where: 'the conversation-restore note, the v1.22.0 changelogs',
  },
].map(mine);

test('no user-facing surface says a saved chat cannot be continued', () => {
  assertMinedWordingsCarryAClaim(SAVED_CHAT_CLAIMS);
  assertChatRestoresAConversationAndSendsItsTail();

  const offenders = [];
  for (const { label, text } of userFacingProse()) {
    for (const claim of republishedClaims(text, SAVED_CHAT_CLAIMS)) {
      offenders.push(`${label}: "${claim.text}" — published in ${claim.where}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'a reopened conversation is continued, and the model is given its last 20 messages, so ' +
      'these surfaces are wrong in one direction or the other:\n  ' +
      offenders.join('\n  '),
  );
});

test('the saved-chat rule refuses what shipped and leaves the qualified sentence alone', () => {
  const refused = (text) => republishedClaims(text, SAVED_CHAT_CLAIMS).length > 0;
  for (const shipped of [
    'A saved chat can be reread but not continued once VS Code restarts or an AI setting changes.',
    'It now resumes with its full history, in order, and deleting it removes it from the list.',
  ]) {
    assert.equal(
      refused(shipped),
      true,
      `the rule lets this published sentence through: ${shipped}`,
    );
  }
  for (const honest of [
    'A saved chat continues after a restart or an AI setting change; the model is given its last 20 messages.',
    'The conversation is shown in full, and the model receives the last 20 messages of it.',
  ]) {
    assert.equal(refused(honest), false, `the rule refuses this true sentence: ${honest}`);
  }
});

// ── the pilot load: optional, and one root folder ─────────────────────────

const FROZEN_LOAD_TAB_FILE = 'packages/webview/src/pages/Frozen/FrozenLoadTab.tsx';
const FROZEN_LOADER_FILE = 'packages/extension/src/modules/frozendataset/FrozenDatasetLoader.ts';

/** The initial value of the `useState` held by a name, as written. */
function useStateInitializer(source, name) {
  let initializer;
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isArrayBindingPattern(node.name) &&
      node.name.elements.some(
        (element) =>
          ts.isBindingElement(element) &&
          ts.isIdentifier(element.name) &&
          element.name.text === name,
      ) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      invokedName(node.initializer.expression) === 'useState'
    ) {
      initializer = node.initializer.arguments[0]?.getText(source) ?? '';
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return initializer;
}

/**
 * The pilot is a box the user ticks, and it loads one root folder.
 *
 * `FrozenLoadTab` starts with it off, and the loader's pilot path narrows the
 * dataset to a single root reference. Help text that makes the pilot a step
 * every load goes through, or one that covers several folders, describes a
 * different feature.
 */
function assertPilotIsOptionalAndOneFolder() {
  const tab = parseFile(FROZEN_LOAD_TAB_FILE);
  // Positive control: the reader finds the state and can tell true from false.
  const probe = ts.createSourceFile(
    'probe.tsx',
    'const [pilot, setPilot] = useState(true);',
    ts.ScriptTarget.Latest,
    true,
  );
  assert.equal(
    useStateInitializer(probe, 'pilot'),
    'true',
    'the reader no longer sees what the pilot toggle starts as — the check below proves nothing',
  );
  assert.equal(
    useStateInitializer(tab, 'pilot'),
    'false',
    `${FROZEN_LOAD_TAB_FILE} no longer starts with the pilot off: it is a step every load goes ` +
      'through now, and the help text has to say so',
  );

  const loader = parseFile(FROZEN_LOADER_FILE);
  const scope = methodBody(loader, 'filterPilotScope');
  assert.ok(
    scope,
    `${FROZEN_LOADER_FILE} no longer declares filterPilotScope — re-point this anchor`,
  );
  assert.match(
    scope.getText(loader),
    /rootReferenceId/,
    'the pilot path no longer narrows the load to one root reference — it may cover several ' +
      'folders now, and the help text has to say so',
  );
}

test('anchor: the pilot load starts off and covers one root folder', () => {
  assertPilotIsOptionalAndOneFolder();
});

/** "Pilot", in the six languages the webview ships. */
const PILOT_WORD = /(?<!\p{L})pilot[aeo]?(?!\p{L})|パイロット/iu;

/** A step nobody can skip. */
const MANDATORY =
  /(?<!\p{L})(?:must|required|mandatory|always|obligatoire|toujours|obligatorio|siempre|obrigatóri[ao]|sempre|erforderlich|verpflichtend|zwingend|immer)(?!\p{L})|必須|必ず/iu;

/** More than one folder, in the words each language uses for the unit. */
const MANY_FOLDERS =
  /(?<!\p{L})(?:folders|dossiers|expedientes|pastas|Ordnern)(?!\p{L})|(?<!\p{L})(?:all|every|each|tous|toutes|todos|todas|alle|jede[rnms]?)\s+(?:the\s+|les\s+|los\s+|as\s+)?(?:root\s+|racines?\s+|raíz\s+|raiz\s+|Wurzel)?(?:folder|dossier|expediente|pasta|Ordner)|すべての(?:ルート|案件|フォルダ)|各(?:ルート|案件|フォルダ)/iu;

/** The sentences of a text that sell the pilot as compulsory, or as many folders. */
function pilotOverclaims(text) {
  const offenders = [];
  for (const sentence of String(text).split(/(?<=[.!?…])\s+|[。！？\n]+/u)) {
    if (!PILOT_WORD.test(sentence)) continue;
    if (MANDATORY.test(sentence) || MANY_FOLDERS.test(sentence)) offenders.push(sentence.trim());
  }
  return [...new Set(offenders)];
}

test('the in-app help keeps the pilot load optional and on one folder', () => {
  assertPilotIsOptionalAndOneFolder();

  const offenders = [];
  let bundlesRead = 0;
  for (const file of localeFiles()) {
    const bundle = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8'));
    const text = bundle.help?.frozenContent;
    assert.equal(
      typeof text,
      'string',
      `locales/${file} has no help.frozenContent — the rule below reads nothing`,
    );
    bundlesRead += 1;
    for (const sentence of pilotOverclaims(text)) {
      offenders.push(`locales/${file} help.frozenContent: ${sentence.slice(0, 140)}`);
    }
  }
  assert.equal(bundlesRead, 6, `the walk read ${bundlesRead} bundles, the extension ships 6`);
  assert.deepEqual(
    offenders,
    [],
    'the pilot is a box the user ticks, on one root folder, and the help says otherwise:\n  ' +
      offenders.join('\n  '),
  );
});

test('the pilot rule refuses a compulsory or multi-folder pilot and leaves the shipped text alone', () => {
  for (const refused of [
    '- Load: sandbox targets only, with a Pilot on every root folder before the full load',
    '- Load: the Pilot pass is required before the full load',
    '- Chargement : un Pilote obligatoire précède le chargement complet',
    '- Carga: un Piloto sobre todos los expedientes raíz antes de la carga completa',
    '- Laden: ein Pilot ist vor dem vollständigen Laden erforderlich',
    '- Carga: um Piloto sobre todas as pastas raiz antes da carga completa',
    '- ロード：本ロードの前にパイロットは必須です',
  ]) {
    assert.ok(pilotOverclaims(refused).length > 0, `the rule lets this through: ${refused}`);
  }
  for (const file of localeFiles()) {
    const bundle = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8'));
    assert.deepEqual(
      pilotOverclaims(bundle.help.frozenContent),
      [],
      `the rule refuses the shipped sentence in locales/${file}`,
    );
  }
});

// ── the provider list, and the failure sent on its own ────────────────────

/** Anthropic is the only provider the settings offer. */
function assertAnthropicIsTheOnlyProviderOffered() {
  const property = JSON.parse(read(...EXT, 'package.json')).contributes?.configuration
    ?.properties?.['sandforge.ai.provider'];
  assert.ok(property, 'sandforge.ai.provider is gone from the manifest — re-read this gate');
  assert.deepEqual(
    property.enum,
    ['anthropic'],
    'the provider setting offers more than Anthropic now: the surfaces below may name the ' +
      'others again, and each one has to say what it sends',
  );
}

/** The failure of a run is sent with nobody asking, so it has a switch of its own. */
function assertErrorResolutionHasASwitch() {
  const properties =
    JSON.parse(read(...EXT, 'package.json')).contributes?.configuration?.properties ?? {};
  assert.ok(
    properties['sandforge.ai.errorResolution'],
    'the failure a run reports is sent to the model with nobody asking, and the setting that ' +
      'turns it off is gone from the manifest',
  );
  const composition = read(...EXT, 'src', 'composition', 'aiComposition.ts');
  assert.match(
    composition,
    /ai\.errorResolution/,
    'nothing reads sandforge.ai.errorResolution any more — the setting is a box that does ' +
      'nothing, and the surfaces below promise it works',
  );
}

test('anchor: Anthropic is the only provider, and error resolution has a switch', () => {
  assertAnthropicIsTheOnlyProviderOffered();
  assertErrorResolutionHasASwitch();
});

/**
 * The built-in table answers only while a SandForge view is open, like the
 * model does: the switch's own description says so, in each language.
 */
const WHILE_A_VIEW_IS_OPEN = {
  en: /while a SandForge view is open/i,
  fr: /tant qu'une vue SandForge est ouverte/i,
  de: /solange eine SandForge-Ansicht geöffnet ist/i,
  es: /mientras haya una vista de SandForge abierta/i,
  ja: /SandForge のビューが開いている間/,
  'pt-br': /enquanto uma visualização do SandForge estiver aberta/i,
};

test('the error resolution switch says the built-in table answers only while a view is open', () => {
  const handlers = read(...EXT, 'src', 'bridge', 'handlers', 'HandlerTypes.ts');
  assert.match(
    handlers,
    /const watched = deps\.broker\.panelCount > 0;\s*if \(!watched/,
    'a failure is resolved with no SandForge view open now — the setting may drop its condition',
  );
  const properties =
    JSON.parse(read(...EXT, 'package.json')).contributes?.configuration?.properties ?? {};
  const missing = [];
  for (const [locale, text] of Object.entries(
    resolveNls(properties['sandforge.ai.errorResolution'].description),
  )) {
    assert.ok(WHILE_A_VIEW_IS_OPEN[locale], `${locale}: no rule written for this locale`);
    if (!WHILE_A_VIEW_IS_OPEN[locale].test(text)) missing.push(locale);
  }
  assert.deepEqual(missing, [], 'the setting promises an answer with every SandForge view closed');
});

/** Providers sold as a choice the Settings editor offers. */
const PROVIDERS_IN_SETTINGS =
  /(?:providers?|fournisseurs?|Anbieter|proveedores?|provedores?|プロバイダー?)[^.\n]{0,40}(?:listed in settings|in settings|dans les param|in den Einstellungen|en (?:los )?ajustes|en la configuraci|nas configurações|設定)/iu;

test('no user-facing surface offers a provider the settings do not', () => {
  assertAnthropicIsTheOnlyProviderOffered();

  const offenders = [];
  for (const { label, text } of userFacingProse()) {
    if (PROVIDERS_IN_SETTINGS.test(text)) offenders.push(`${label}: ${text.trim().slice(0, 160)}`);
    // Naming one of the two that were taken out of the enum, beside the word
    // settings, reads as a choice the editor offers.
    if (
      /\bOpenAI\b/i.test(text) &&
      /settings|param|Einstellungen|ajustes|configuraç|設定/i.test(text)
    ) {
      offenders.push(`${label}: names OpenAI as a setting — ${text.trim().slice(0, 140)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'the setting offers one provider; these surfaces describe a list:\n  ' + offenders.join('\n  '),
  );
});

test('both AI rows answer with AI off and name the switch that stops the sending', () => {
  assertErrorResolutionHasASwitch();

  const offenders = [];
  for (const relPath of READMES) {
    const row = read(...relPath.split('/'))
      .split('\n')
      .find((line) => /^\|\s*\*\*AI Assistant\*\*/.test(line));
    assert.ok(row, `${relPath}: the AI Assistant row of the feature table is gone`);
    if (!/AI off/i.test(row)) {
      offenders.push(`${relPath}: the row does not say what still answers with AI off`);
    }
    if (!row.includes('sandforge.ai.errorResolution')) {
      offenders.push(`${relPath}: the row does not name the setting that stops the sending`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'the row is where a buyer reads what leaves the machine:\n  ' + offenders.join('\n  '),
  );
});

test('the privacy answer names the switch and the failures it never sends', () => {
  assertErrorResolutionHasASwitch();

  const answer = read('docs', 'faq.md')
    .split('\n')
    .find((line) => /Only to Anthropic/.test(line));
  assert.ok(answer, 'docs/faq.md no longer answers where data goes — re-read this gate');
  assert.ok(
    answer.includes('sandforge.ai.errorResolution'),
    'the privacy answer does not name the setting that stops a failure being sent',
  );
  // The pipeline runner's fallback carries no detail; it is one of the messages
  // the handler refuses to send, and the answer enumerates them.
  assert.match(
    answer,
    /Pipeline failed/,
    'the answer lists the messages SandForge writes itself and leaves out the one a failed ' +
      'pipeline ends on',
  );
});

// ── how many generators Seed has without a model ──────────────────────────

/** The methods the generator implements, read off the shared list. */
function supportedFakerMethods() {
  const source = read('packages', 'shared', 'src', 'constants', 'faker-methods.ts');
  const list = /export const SUPPORTED_FAKER_METHODS = \[([\s\S]*?)\] as const;/.exec(source);
  assert.ok(list, 'SUPPORTED_FAKER_METHODS moved — re-point this gate');
  const methods = [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(
    methods.length > 10,
    `the list reads as ${methods.length} methods — re-point this gate`,
  );
  return methods;
}

test('the FAQ counts the generators the code has', () => {
  const expected = supportedFakerMethods().length;
  const answer = read('docs', 'faq.md')
    .split('\n')
    .find((line) => /Faker generators/.test(line));
  assert.ok(answer, 'docs/faq.md no longer says how many generators Seed has without a model');
  const counted = /(\d+)(\+?)\s+(?:locale-aware\s+)?Faker generators/.exec(answer);
  assert.ok(counted, `the count is not written as a number: ${answer.trim().slice(0, 140)}`);
  assert.equal(
    counted[2],
    '',
    'a "+" is a promise of more than the generator implements: write the number',
  );
  assert.equal(
    Number(counted[1]),
    expected,
    `the FAQ says ${counted[1]} generators, the generator implements ${expected}`,
  );
});
