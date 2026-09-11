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
 * it before the next begins. So the two anchors read the two paths — one for
 * what happens, one for what does not — and the surfaces are held to both: per
 * partition for Seed and Sync, start and end only for Autopilot, and no
 * sentence that reaches for the VOCABULARY of concurrency to describe either.
 * The vocabulary, not the idea: the limit is spelt out below.
 *
 * CDC is the same story: removed from the Sync UI, disclaimed in
 * `docs/modules/sync.md`, routed to `NoOpHandler` in the extension — and still
 * sold as a working "near real-time" sync mode by the in-app help panel, in all
 * six languages.
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
 *  - Code is read under `packages/extension/src` and `packages/shared/src`, plus the JSON under those and under `packages/extension/resources`; a fourth workspace package fails the control below instead of passing unread.
 *  - Provider options handed through from outside the code — a webview payload, a user setting spread into the request — carry a `tools` key written nowhere in the repository.
 *  - A tool catalogue written into the prompt text, whose reply is parsed by hand, gives the model tools under no key and no block type this scan knows.
 *  - A key computed at runtime (a variable, a template, `Reflect.set`, `Object.defineProperty`) hides `tools` from the scan.
 *  - A request that bypasses the SDK, such as a raw HTTP call to `/v1/messages` whose body is built from strings, is invisible.
 *  - A tool call read without the SDK's type name or a `'tool_use'` literal, say `'input' in block`, is invisible; it can only arrive after a request sent tools.
 *  - A tool helper a later SDK exports under a new name or path is caught only through the request key it still needs.
 *  - An OpenAI-shaped request, `functions` with `function_call`, is not watched: Functions is a Salesforce product this extension talks about, so the key is ordinary vocabulary here. Reaching that shape means a second provider, which the code anchor's own controls would show.
 *  - A tool factory whose name carries on past the word, `createToolRegistry`, is not caught by name — `Tools` is also a panel label in this product, so the name has to end on it. What the factory builds is still caught when it reaches a request or an SDK helper.
 *  - A tool API reached through an alias, `const register = vscode.lm.registerTool.bind(vscode.lm)`, is not read as a call on `lm`.
 *  - Prose refuses published wording, whole: a paraphrase, a new sentence, a translation, or the same sentence with a word inflected — `diagnostics` for `diagnosis`, `surfaces` for `surface` — passes. The count is the one word that may change.
 *  - Any quotation of a published wording is refused like the promise: struck through, inside quotation marks, in a removal note or in an answer about an old version alike. A changelog is not a surface, so that is where the quote belongs.
 *  - A wording that does not name the tools is released by rewriting it, not by the anchor: the anchor answers one question, whether shipped code gives the model tools.
 *  - Markdown is read by paragraph, table row, heading and list item: a fenced code block is not prose, and a wording split across two rows or two items passes — as it does across two locale keys rendered side by side.
 *  - The webview's English fallbacks are read for these wordings and by the Grappe rules, which is how `grappe.subtitle` and `grappe.step2Desc` were caught — `Parallel execution engine`, six languages and the fallback, on the Grappe page header. The CDC rule reads the six locale bundles it was written against and nothing else.
 *
 * What the two code anchors added last do not see, one limit per line:
 *  - The automatic-resolution anchor reads one emitter, `sendOperationFailed`. A second path to `resolveError` — another caller, a webview channel wired back — is not read; it would only make the wordings more false, never less.
 *  - It reads the call, not the condition: a resolution put behind `if (userAskedForIt)` inside `resolveFailedOperation` still reads as automatic. Move it back behind a screen and the wordings are true again while the anchor stays green, so rewrite the anchor with the feature.
 *  - It reads one wire, `setAIModules` writing the injected resolver into `handlerDeps` — the object every handler is constructed on, and the only one the emitter can be reading. A second injection — a constructor argument, a deps object built elsewhere — is not read.
 *  - The rule-module anchor counts constructor ARGUMENTS in the composition root. A provider reaching `AnomalyDetector` another way — a setter, a field assigned later, a default parameter — is invisible; the count only answers the question the composition root answers today.
 *  - It also reads POSITION: the statement that wires them runs before the first statement of `initAIComposition` that can return. A gate built some third way — a throw, an early exit inside a helper it awaits — is not read as a gate. And "the first statement that can return" is a proxy for the AI gate, not the gate itself: a guard clause added above it moves the line this anchor measures without moving the gate.
 *  - It reads the condition around the call, never inside it: `setRuleModules(enabled ? modules : undefined)` puts the AI switch back in front of the rule-based modules with no `if` anywhere an ancestor walk can see. Left unread on purpose — a ternary in an argument is ordinary code, and a rule that refused one would fail this gate on honest wiring.
 *  - Both read `aiComposition.ts` by name. Move the composition root and they fail loudly on a missing construction rather than passing on an empty file, which is the failure mode worth having.
 *
 * What the Grappe rules do not see, one limit per line:
 *  - The Seed anchor reads `executeWithGrappe` in `SeedOrchestrator` and the Autopilot anchor reads `executePlan`. Sync reports one partition per object from its own loop, and that loop is read by neither: a change there is caught by the prose rules only when the prose changes with it.
 *  - The rule is a VOCABULARY, not a meaning: `paral*`, `concurren*`/`concorren*`, `gleichzeitig`/`nebenläufig`, `simult*`, 並列/並行/同時. Concurrency said in ordinary language — "at once", "à la fois", "auf einmal", "de una vez", "ao mesmo tempo", 一度に — passes in all six, and it is the one way to sell this feature falsely that costs nothing to write.
 *  - Concurrency reached without a word for it — an unawaited call inside the loop, a queue drained elsewhere — is invisible to the prose rules; the anchor's `Promise.all` check is what watches the Seed path for it.
 *  - A sentence that denies concurrency passes, and a sentence that denies one thing while asserting concurrency in the same breath passes with it: "not queued: run in parallel" reads as a denial. Widening the negation class to the elided and contracted forms the six languages actually write widened that hole with it — deliberately, since the other direction refuses true sentences. What stands behind it is the mined list of wordings this product published, which is refused whole, quotation included.
 *  - Two wordings are too short to mine — `Motor de ejecución paralela`, `大規模データ操作のための並列実行エンジン` — and are left to the word rule, which is what caught them.
 *  - The Seed anchor pins the report to the innermost loop that inserts, which is the granularity the surfaces publish. It does not read what that loop iterates: chunk the objects into one partition each and the report is still per partition, and still true.
 *
 *   node --test docs/product-claims.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { NLS_FILES, isNlsPlaceholder, parallelAssertions, resolveNls } from './claims-surfaces.mjs';

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

test('anchor: a seed partitions, and reports each partition as it completes', () => {
  assertSeedPartitionsAndReportsEachOne();
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
  assertAutopilotOnlyBracketsTheRun();

  // Beyond the wordings that shipped, the claim itself: every grappe path is a
  // sequential `for await`, so no sentence about Grappe may assert concurrency
  // in any of the six languages. A sentence that DENIES it is the honest one,
  // and passes — `docs/faq.md` publishes exactly that.
  const offenders = [];
  for (const { label, text } of grappeUnits()) {
    for (const sentence of parallelAssertions(text)) {
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
  ];
  assert.deepEqual(
    honest.filter(
      (text) =>
        republishedClaims(text, grappeClaims()).length > 0 || parallelAssertions(text).length > 0,
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
      /ne sont pas impl|pas encore|no est[áa]n implementad|n[ãa]o est[ãa]o implementad|nicht implementiert|未実装/i.test(
        help,
      );
    if (promises && !disclaims) offenders.push(`locales/${file}: help.syncContent promises CDC`);
  }
  assert.deepEqual(
    offenders,
    [],
    'the help panel sells a sync mode that is a registered no-op:\n  ' + offenders.join('\n  '),
  );
});

// ── AI Assistant ──────────────────────────────────────────────────────────

/**
 * Everything esbuild puts in `dist/extension.js`: the extension's sources and
 * the shared package it inlines (only `vscode`, the Anthropic SDK and the
 * jsforce entry stay external). The floors sit below today's counts; a scan
 * that falls under one has stopped reading shipped code.
 */
const SHIPPED_ROOTS = [
  { root: 'packages/extension/src', minFiles: 250 },
  { root: 'packages/shared/src', minFiles: 60 },
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
  const scan = {
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

  for (const { root } of SHIPPED_ROOTS) {
    const files = sourceFilesUnder(join(repoRoot, root));
    scan.filesByRoot.set(root, files.map(toRepoPath));
    for (const file of files) {
      scan.read.add(file);
      scanFile(scan, file);
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

function scanFile(scan, file) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
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
      if (SDK_TOOL_SUBPATH.test(specifier)) found(node, `import '${specifier}'`);
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
