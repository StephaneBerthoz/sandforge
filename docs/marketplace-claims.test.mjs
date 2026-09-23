/**
 * Gate for the surfaces a buyer reads before installing: the extension
 * manifest, the two READMEs, and the DataOps module page.
 *
 * The sibling gates (`product-claims.test.mjs`,
 * `automation-scheduler-claims.test.mjs`) pin prose that outran the code. This
 * one pins the opposite failures found in the same review — prose and manifest
 * that lag the code, plus manifest entries that ship broken to the user:
 *
 *   - `sandforge.openOrgInBrowser` was in the Command Palette with a 100%
 *     failure rate: it needed an org id the palette cannot supply. It now
 *     asks for the org itself, and the palette entry is back.
 *   - `capabilities.untrustedWorkspaces` had no `description`, so VS Code
 *     disabled the extension in a restricted workspace without saying why.
 *   - the three `sandforge.grappe.*` descriptions were raw English inside a
 *     fully localized Settings block.
 *   - the Get Started walkthrough had four steps and no action button.
 *   - the bundle carried a `sourceMappingURL` to a map `.vscodeignore`
 *     excludes, so every load looked for a file that is not in the VSIX.
 *   - the listing buys the "sfdmu" and "data loader" keywords and never
 *     answered "why switch".
 *   - DataOps Restore ships since v1.18.0 and the docs still called it unbuilt.
 *
 * Localizing Grappe also moved its wording out of `package.json` and into the
 * six `package.nls.*` files. The honesty checks the sibling gate applied to the
 * manifest are re-applied here to the resolved locale values, on the same
 * anchor, so localizing a setting cannot buy Grappe an exemption; the
 * resolution itself is shared, in `claims-surfaces.mjs`.
 *
 *   node --test docs/marketplace-claims.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parallelAssertions, resolveNls } from './claims-surfaces.mjs';

const docsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(docsDir, '..');
const read = (...p) => readFileSync(join(repoRoot, ...p), 'utf8');
const readJson = (...p) => JSON.parse(read(...p));

const EXT = ['packages', 'extension'];
const manifest = () => readJson(...EXT, 'package.json');

// ── the listing sold an automation that does not run ──────────────────────

/**
 * What the Marketplace description may not promise, language by language.
 *
 * The listing's one paragraph sold "automate pipelines, with streaming
 * execution for large datasets" while no pipeline step touched an org, and
 * Seed and Sync write their batches one after the other. A pipeline now backs
 * up, compares and checks orgs, and starts by hand, on a schedule or on a
 * sandbox refresh — while VS Code is open, which is no automation service —
 * but it runs no step that writes, and streams nothing. An English denylist
 * would have passed on all five translations, which said the same thing in
 * their own words, so each locale carries its own.
 */
const DESCRIPTION_OVERCLAIM = {
  en: /automate pipelines|streaming execution/i,
  fr: /automatis|exécution streaming/i,
  de: /automatisier|Streaming-Ausführung/i,
  es: /automatiza|ejecución en streaming|streaming/i,
  ja: /自動化|ストリーミング/,
  'pt-br': /automatiza|execução em streaming|streaming/i,
};

/**
 * The step types that write to an org. None runs in a pipeline: each runs
 * from its own page, behind Production Guard, and a pipeline runs unattended.
 */
const WRITE_STEP_TYPES = ['seed', 'sync', 'restore', 'anonymize', 'delete'];

/**
 * The step types a pipeline runs: the executor's own, and the ones the
 * extension registers through a module's flow.
 */
function handledStepTypes() {
  const executor = read(...EXT, 'src', 'modules', 'automation', 'StepExecutor.ts');
  const defaults = /private registerDefaults\(\): void \{([\s\S]*?)\n {2}\}/.exec(executor);
  assert.ok(defaults, 'registerDefaults moved — re-point this anchor');
  const own = [...defaults[1].matchAll(/this\.handlers\.set\('([a-z_]+)'/g)].map((m) => m[1]);
  const steps = read(...EXT, 'src', 'bridge', 'handlers', 'pipelineSteps.ts');
  const registration = /export function registerPipelineSteps\([\s\S]*?\n\}/.exec(steps);
  assert.ok(registration, 'registerPipelineSteps moved — re-point this anchor');
  const viaModules = [...registration[0].matchAll(/registerHandler\(\s*'([a-z_]+)'/g)].map(
    (m) => m[1],
  );
  return [...own, ...viaModules];
}

test('anchor: no step that writes to an org runs in a pipeline', () => {
  const handled = handledStepTypes();
  // Positive control: an anchor that reads no handler would pass on anything,
  // and one blind to the module steps would miss a write step registered there.
  assert.ok(handled.includes('delay'), 'the anchor reads no handler in registerDefaults');
  assert.ok(
    handled.includes('backup'),
    'the anchor does not see the steps registerPipelineSteps adds',
  );
  assert.deepEqual(
    handled.filter((type) => WRITE_STEP_TYPES.includes(type)),
    [],
    'a step that writes to an org runs in a pipeline now — the description says none does, and ' +
      'this rule has to go with it',
  );
});

test('the Marketplace description promises no automation and no streaming, in six languages', () => {
  const offenders = [];
  for (const [locale, text] of Object.entries(resolveNls(manifest().description))) {
    const hit = DESCRIPTION_OVERCLAIM[locale]?.exec(text);
    assert.ok(DESCRIPTION_OVERCLAIM[locale], `${locale}: no rule written for this locale`);
    if (hit) offenders.push(`${locale}: "${hit[0]}" in the listing's one paragraph`);
  }
  assert.deepEqual(
    offenders,
    [],
    'the listing sells a pipeline runner and a streaming engine the extension does not have:\n  ' +
      offenders.join('\n  '),
  );
});

/**
 * Neither `delay` nor `condition` is handed anything that reaches an org, so
 * the listing may not credit those two with acting on it, in any language.
 */
const STEPS_CREDITED_WITH_THE_ORG = {
  en: /\b(?:delay|condition)\b[^.]*\bacts? on your org/i,
  fr: /(?:délai|condition)[^.]*\bagiss\w* sur votre org/i,
  de: /(?:\bwirk\w*[^.]*(?:Verzögerung|Bedingung)|(?:Verzögerung|Bedingung)[^.]*\bwirk\w*)[^.]*auf Ihre Org/i,
  es: /(?:espera|condición)[^.]*\bactúa\w* sobre tu org/i,
  ja: /(?:待機|条件)[^。]*Org に作用|Org に作用[^。]*(?:待機|条件)/,
  'pt-br': /(?:espera|condição)[^.]*\bagem na sua org/i,
};

/** That no pipeline step writes to the org, as each language says it. */
const NO_STEP_WRITES_TO_THE_ORG = {
  en: /no pipeline step writes to your org/i,
  fr: /aucune étape de pipeline n'écrit dans votre org/i,
  de: /kein Pipeline-Schritt schreibt in Ihre Org/i,
  es: /ningún paso de pipeline escribe en tu org/i,
  ja: /Org に書き込むパイプラインのステップはありません/,
  'pt-br': /nenhum passo de pipeline grava na sua org/i,
};

test('anchor: the delay and condition steps are handed nothing that reaches an org', () => {
  const executor = read(...EXT, 'src', 'modules', 'automation', 'StepExecutor.ts');
  const context = /export interface StepContext \{([^}]*)\}/.exec(executor);
  assert.ok(context, 'StepContext moved — re-point this anchor');
  assert.doesNotMatch(
    context[1],
    /conn|org|client|adapter/i,
    'a step is handed something that reaches an org now — re-read what the listing says steps do',
  );
  for (const factory of ['createDelayHandler', 'createConditionHandler']) {
    const body = new RegExp(`private ${factory}\\(\\)[\\s\\S]*?\\n  \\}\\n`).exec(executor);
    assert.ok(body, `${factory} is gone — re-point this anchor`);
    assert.doesNotMatch(
      body[0],
      /conn|jsforce|orgId|adapter|this\.(?!evaluateSimpleCondition)\w+/i,
      `${factory} reaches past its step and variables now — the listing may say it acts`,
    );
  }
});

test('the Marketplace description says no pipeline step writes to the org, in six languages', () => {
  const offenders = [];
  for (const [locale, text] of Object.entries(resolveNls(manifest().description))) {
    assert.ok(STEPS_CREDITED_WITH_THE_ORG[locale], `${locale}: no rule written for this locale`);
    const hit = STEPS_CREDITED_WITH_THE_ORG[locale].exec(text);
    if (hit) offenders.push(`${locale}: "${hit[0]}"`);
    if (!NO_STEP_WRITES_TO_THE_ORG[locale].test(text)) {
      offenders.push(`${locale}: does not say that no pipeline step writes to the org`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'a pipeline backs up, compares and checks an org, and writes to none; delay waits and ' +
      'condition reads variables:\n  ' +
      offenders.join('\n  '),
  );
});

// ── ID remapping, sold without its one exception ──────────────────────────

/** The six walkthrough languages, as their file suffixes spell them. */
const WALKTHROUGH_LOCALES = ['en', 'fr', 'de', 'es', 'ja', 'pt-br'];

/**
 * Every surface outside the webview that tells a reader what Forge does to
 * Ids, as `[label, locale, text]`: the quick start in both READMEs and both
 * getting started guides, and the Forge walkthrough body in six languages.
 */
const REMAP_SURFACES = () => [
  ['README.md', 'en', read('README.md')],
  ['packages/extension/README.md', 'en', read(...EXT, 'README.md')],
  ['docs/getting-started.md', 'en', read('docs', 'getting-started.md')],
  ['docs/forge-quickstart.md', 'en', read('docs', 'forge-quickstart.md')],
  ...WALKTHROUGH_LOCALES.map((locale) => [
    `walkthrough/forge-clone${locale === 'en' ? '' : `.nls.${locale}`}.md`,
    locale,
    read(...EXT, 'walkthrough', `forge-clone${locale === 'en' ? '' : `.nls.${locale}`}.md`),
  ]),
];

/**
 * "Every ID is remapped", in the shapes the six languages published it: the
 * Id first ("every ID is remapped", "every inserted record gets its IDs
 * remapped"), the verb first ("remapping every ID"), German's separable verb
 * ("vergibt jede ID neu") and the two Japanese orders. A span may cross a line
 * break, since a code block wraps the sentence. A record type Id is a lookup
 * too, so "every lookup is remapped" makes the same promise.
 */
const UNQUALIFIED_REMAP = [
  /(?:every|chaque|jede[rnms]?|cada|todos?)\s[^.。;]{0,60}?\bIDs?\b[^.。;]{0,40}?(?:remap|neu zugeordnet|reasign|réattribu)/iu,
  /(?:remapp?ing|réattribuant|reasignando|remapeando)\s+(?:every|chaque|cada)\s+IDs?\b/iu,
  /\bremaps?\s+(?:every|all)\s+IDs?\b/iu,
  /\b(?:every|all)\s+lookups?\s+(?:is|are|gets?)\s+remapped\b/iu,
  /jede[rnms]?\s[^.;]{0,60}?(?:neu zugeordnete\s+IDs|ID\s+neu)/iu,
  /(?:すべての\s*ID|ID\s*はすべて)[^。\n]*(?:再マッピング|マッピングし直|付け替え)/u,
];

/**
 * What the exception has to carry in each language: that it is about a record
 * type, that the match is on the API name, and that the log says so — the log
 * line is what explains the refusal that follows.
 */
const REMAP_EXCEPTION = {
  en: { recordType: /record type/i, apiName: /API name/i, log: /\blog\b/i },
  fr: { recordType: /type d'enregistrement/i, apiName: /nom d'API/i, log: /journal/i },
  de: { recordType: /Datensatztyp/i, apiName: /API-Namen/i, log: /Protokoll/i },
  es: { recordType: /tipo de registro/i, apiName: /nombre de API/i, log: /\blog de SandForge/i },
  ja: { recordType: /レコードタイプ/, apiName: /API 参照名/, log: /ログ/ },
  'pt-br': { recordType: /tipo de registro/i, apiName: /nome de API/i, log: /\blog\b/i },
};

test('anchor: a record type with no counterpart on the target keeps its source Id', () => {
  const mapper = read(...EXT, 'src', 'modules', 'sync', 'RecordTypeMapper.ts');
  assert.match(
    mapper,
    /export function warnUnmappedRecordType/,
    'the unmapped-record-type warning is gone — either every Id really is remapped now, or the ' +
      'exception below is no longer reported anywhere',
  );
  assert.match(
    mapper,
    /Records keep the source Id/,
    'the warning no longer says the record keeps its source Id — re-read the quick start below',
  );
  assert.match(
    mapper,
    /record type with the same API name/,
    'the warning no longer matches on the API name — re-read what the surfaces below say',
  );
  const executor = read(...EXT, 'src', 'modules', 'forge', 'ForgeExecutor.ts');
  assert.match(
    executor,
    /warnUnmappedRecordType\(/,
    'Forge no longer reports an unmapped record type, so nothing tells the user why the insert ' +
      'was refused',
  );
});

test('the unqualified remap rule refuses what shipped and leaves the qualified sentence alone', () => {
  const refuses = (text) => UNQUALIFIED_REMAP.some((rule) => rule.test(text));
  for (const shipped of [
    'Every ID is remapped automatically.',
    'Review the plan, then run it: every inserted record gets its IDs remapped',
    'into your sandbox, remapping every ID.',
    'SandForge discovers the relationship graph and remaps every ID on write.',
    'BFS discovery walks the relationship graph for you and every lookup is remapped on write.',
    'records are inserted into your target sandbox with every ID\n       remapped',
    'Jeder eingefügte Datensatz erhält neu zugeordnete IDs',
    'in Ihre Sandbox und vergibt dabei jede ID neu.',
    'vers votre sandbox, en réattribuant chaque ID.',
    'cada registro insertado recibe sus ID reasignados',
    'hacia su sandbox, reasignando cada ID.',
    'para sua sandbox, remapeando cada ID.',
    '挿入されるレコードの ID はすべて再マッピングされます',
    'サンドボックスへ複製し、すべてのIDを自動で付け替えます。',
  ]) {
    assert.ok(refuses(shipped), `the rule lets through: ${shipped}`);
  }
  assert.ok(
    !refuses(
      'IDs are remapped as the records are written; a record type with no active record type ' +
        'of the same API name on the target keeps its source Id, and the SandForge log names it.',
    ),
    'the rule refuses the qualified sentence',
  );
});

test('no surface promises that every ID is remapped, in six languages', () => {
  const offenders = [];
  for (const [label, , text] of REMAP_SURFACES()) {
    for (const rule of UNQUALIFIED_REMAP) {
      const hit = rule.exec(text);
      if (hit) offenders.push(`${label}: "${hit[0].replace(/\s+/g, ' ').trim()}"`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'a record type with no active record type of the same API name on the target keeps its ' +
      'source Id, and these surfaces promise otherwise:\n  ' +
      offenders.join('\n  '),
  );
});

test('every surface that remaps IDs says what happens to a record type the target does not have', () => {
  const missing = [];
  for (const [label, locale, text] of REMAP_SURFACES()) {
    const rules = REMAP_EXCEPTION[locale];
    assert.ok(rules, `${label}: no rule written for ${locale}`);
    for (const [part, rule] of Object.entries(rules)) {
      if (!rule.test(text)) missing.push(`${label}: the exception does not carry its ${part}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    'the exception has to travel with the claim:\n  ' + missing.join('\n  '),
  );
});

// ── what the store search and the palette show ────────────────────────────

/**
 * The Marketplace sorts by category and matches the first keywords hardest,
 * and the Command Palette shows every command that is not hidden. All three
 * were left as they were written: the listing sat under "Visualization", which
 * it is not, and the palette offered "SandForge: Cheers!" — an easter egg that
 * shows a mojito — beside "SandForge: Open Grappe", a word a Salesforce
 * consultant has no reason to know.
 */
test('the listing is filed under what it does', () => {
  const categories = manifest().categories ?? [];
  assert.ok(categories.length > 0, 'the categories are gone — re-read this gate');
  assert.ok(
    !categories.includes('Visualization'),
    "Monitor's charts and Compare's diff serve the data work; the listing is not a " +
      'visualization tool, and the category brings browsers it disappoints',
  );
  assert.deepEqual(categories, ['Other', 'Testing'], 'the filed categories changed');
});

test('the keywords a searcher matches first are the ones this is about', () => {
  assert.deepEqual(
    (manifest().keywords ?? []).slice(0, 5),
    ['salesforce', 'sandbox', 'test data', 'seed data', 'data masking'],
    'the first keywords weigh most in Marketplace search; moving one is a positioning decision, ' +
      'not a tidy-up',
  );
});

/** Words a palette entry may not be named after, with what would redeem them. */
const PALETTE_JARGON = {
  // The module's own name, which says nothing about what the view shows.
  grappe: /progress|progression|fortschritt|progreso|progresso|進捗/iu,
  // The easter egg. Nothing redeems it in the palette: it is not a feature.
  cheers: null,
  prost: null,
  salud: null,
  saúde: null,
  乾杯: null,
};

test('every command the palette shows is named after what it does, in six languages', () => {
  const m = manifest();
  const hidden = new Set(
    (m.contributes?.menus?.commandPalette ?? [])
      .filter((entry) => entry.when === 'false')
      .map((entry) => entry.command),
  );
  const visible = (m.contributes?.commands ?? []).filter((c) => !hidden.has(c.command));
  // Positive control: the palette really is being read, not an empty list.
  assert.ok(visible.length > 10, `only ${visible.length} commands read — re-point this gate`);

  const offenders = [];
  for (const command of visible) {
    for (const [locale, title] of Object.entries(resolveNls(command.title))) {
      for (const [word, redeemed] of Object.entries(PALETTE_JARGON)) {
        if (!new RegExp(`(?<!\\p{L})${word}(?!\\p{L})`, 'iu').test(title)) continue;
        if (redeemed && redeemed.test(title)) continue;
        offenders.push(`${locale} ${command.command}: "${title}"`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'these palette entries are named after something only this codebase knows:\n  ' +
      offenders.join('\n  '),
  );
});

// ── a palette command that could not succeed ──────────────────────────────

test('anchor: openOrgInBrowser asks for the org when none is passed', () => {
  const src = read(...EXT, 'src', 'extension.ts');
  const start = src.indexOf("'sandforge.openOrgInBrowser',");
  assert.notEqual(start, -1, 'the command registration moved — re-read this gate');
  const handler = src.slice(start, src.indexOf('\n  );', start));
  assert.match(
    handler,
    /showQuickPick\(/,
    'without an org id the command no longer asks for one: from the palette it is a dead end ' +
      'again, so either restore the picker or hide the palette entry',
  );
});

test('openOrgInBrowser is offered in the Command Palette', () => {
  const entries = manifest().contributes?.menus?.commandPalette ?? [];
  const entry = entries.find((e) => e.command === 'sandforge.openOrgInBrowser');
  assert.ok(
    !entry || entry.when !== 'false',
    'the command picks the org itself; hiding it leaves the launcher dropdown as the only way in',
  );
});

// ── Restricted Mode with no explanation ───────────────────────────────────

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

// ── the Grappe settings were the only untranslated block ──────────────────

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
  // The sibling gate now resolves `%key%` too, so this is deliberate overlap
  // rather than the only cover: the same two assertions, on the same anchor,
  // written against the three keys that were localized. Same direction, so the two
  // can only ever fail together.
  const orchestrator = read(...EXT, 'src', 'modules', 'autopilot', 'AutopilotOrchestrator.ts');
  assert.doesNotMatch(
    orchestrator,
    /grappeAdapter\s*\.\s*partition\s*\(/,
    'an autopilot run may really be partitioned now — re-read the six locale descriptions, which ' +
      'say that path reports only its start and its end',
  );
  assert.match(orchestrator, /grappeActive/, 'nothing activates Grappe any more');

  const props = manifest().contributes?.configuration?.properties ?? {};
  const offenders = [];
  for (const key of GRAPPE_KEYS) {
    for (const [locale, text] of Object.entries(resolveNls(props[key].description))) {
      // Concurrency is what cannot be claimed while every grappe path is a
      // sequential `for await`; a sentence that denies it is honest and passes.
      for (const sentence of parallelAssertions(text)) {
        offenders.push(`${locale} ${key}: ${sentence}`);
      }
      if (/no operation activates|aucune opération ne l/i.test(text)) {
        offenders.push(`${locale} ${key}: ${text}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'these locale strings resell Grappe as concurrent execution:\n  ' + offenders.join('\n  '),
  );
});

// ── a walkthrough with no buttons ─────────────────────────────────────────

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

// ── onboarding that fails on the machine it is read on ────────────────────

/**
 * The first step of the walkthrough offered "OAuth (Web)" as the path for a
 * reader with no CLI. It is not one: the browser login is `sf org login web`,
 * so a reader without the CLI followed the step, clicked the alternative, and
 * got "Salesforce CLI (sf) not found on PATH" — on the one screen written to
 * get them started.
 */
test('anchor: the browser login refuses without the CLI, like the import does', () => {
  const handler = read(...EXT, 'src', 'bridge', 'handlers', 'OrgHandler.ts');
  const refusals = handler.match(/failConnect\(\s*msg,\s*SF_CLI_MISSING_MESSAGE/g) ?? [];
  assert.ok(
    refusals.length >= 2,
    'only one path refuses for want of the CLI now — if OAuth no longer needs it, the ' +
      'prerequisite below applies to the import alone and has to be rewritten',
  );
  assert.match(
    read('packages', 'shared', 'src', 'constants', 'defaults.ts'),
    /SF_CLI_MISSING_MESSAGE = 'Salesforce CLI \(sf\) not found on PATH\.'/,
    'the refusal both paths share no longer says the CLI is missing — re-read this anchor',
  );
  assert.match(
    handler,
    /OAuth web login runs through it/,
    'the OAuth path no longer says it needs the CLI — re-read this anchor',
  );
});

test('the first walkthrough step states the Salesforce CLI prerequisite, in six languages', () => {
  const missing = [];
  const bodies = ['', '.nls.de', '.nls.es', '.nls.fr', '.nls.ja', '.nls.pt-br'].map((suffix) => [
    `walkthrough/connect-org${suffix}.md`,
    read(...EXT, 'walkthrough', `connect-org${suffix}.md`),
  ]);
  const step = (manifest().contributes?.walkthroughs ?? [])
    .flatMap((w) => w.steps ?? [])
    .find((s) => s.id === 'sandforge.connectOrg');
  assert.ok(step, 'the connect-org step is gone — re-read this gate');
  const descriptions = Object.entries(resolveNls(step.description)).map(([locale, text]) => [
    `walkthrough.step.connectOrg.description (${locale})`,
    text,
  ]);

  for (const [label, text] of [...bodies, ...descriptions]) {
    // The CLI names itself `sf`; PATH is where the reader has to have put it.
    if (!/\bsf\b/.test(text) || !/PATH/.test(text)) {
      missing.push(`${label}: does not say the sf CLI has to be on PATH`);
    }
  }
  for (const [label, text] of bodies) {
    if (!text.includes('https://developer.salesforce.com/tools/salesforcecli')) {
      missing.push(`${label}: no link to install the CLI`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    'both connection paths run the CLI, and these surfaces let a reader start without it:\n  ' +
      missing.join('\n  '),
  );
});

// ── a sourceMappingURL to a file the VSIX does not contain ────────────────

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

// ── the listing never answered "why switch" ───────────────────────────────

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

// ── Restore shipped, the docs did not notice ──────────────────────────────

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

// ── a Compare row that described a different module ───────────────────────

/**
 * Both READMEs sold Compare as a "permission matrix" and "drift detection".
 * The Permissions tab reads permission set and profile names, with no object
 * or field permission behind them, and the Drift tab reads five fields of the
 * Organization record when it is opened. The module page says so; the two
 * Compare rows of each README have to say the same.
 */
const COMPARE_OVERCLAIM = /permission matrix|drift detection/i;

test('anchor: Compare reads permission names and five Organization fields, nothing more', () => {
  const handler = read(...EXT, 'src', 'bridge', 'handlers', 'CompareHandler.ts');
  // Positive control: this is the file that runs the Organization query.
  assert.match(handler, /FROM Organization/, 'CompareHandler moved — re-point this anchor');
  assert.doesNotMatch(
    handler,
    /ObjectPermissions|FieldPermissions/,
    'Compare reads object or field permissions now — the READMEs may describe a matrix again',
  );
  const drift = /private async handleDrift\([\s\S]*?(?=\n  (?:private|public) |\n\}\n)/.exec(
    handler,
  );
  assert.ok(drift, 'handleDrift is gone — re-point this anchor');
  assert.deepEqual(
    drift[0].match(/\bFROM \w+/g),
    ['FROM Organization'],
    'the Drift tab reads more than the Organization record now — re-read the Compare rows',
  );
  assert.doesNotMatch(
    drift[0],
    /\.metadata\.|\.tooling\./,
    'the Drift tab reads metadata now — re-read the Compare rows',
  );
});

test('the Compare rows of both READMEs describe what Compare reads', () => {
  const offenders = [];
  for (const relPath of READMES) {
    const rows = read(...relPath.split('/'))
      .split('\n')
      .filter((line) => /^\|\s*(?:\*\*Compare\*\*|\[Compare\])/.test(line));
    // Positive control: the feature table row and the module index row.
    assert.equal(rows.length, 2, `${relPath}: expected two Compare rows, found ${rows.length}`);
    for (const row of rows) {
      const hit = COMPARE_OVERCLAIM.exec(row);
      if (hit) offenders.push(`${relPath}: "${hit[0]}"`);
      if (!/five Organization settings/.test(row)) {
        offenders.push(
          `${relPath}: a Compare row does not say the drift is five Organization settings`,
        );
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'Compare shows which permission sets and profiles exist on each side and five Organization ' +
      'settings, and these rows promise more:\n  ' +
      offenders.join('\n  '),
  );
});
