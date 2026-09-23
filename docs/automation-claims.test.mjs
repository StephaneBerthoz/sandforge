/**
 * Keeps the Automation surfaces honest about what a pipeline step does.
 *
 * `StepExecutor` gives Delay and Condition handlers of its own, and the
 * extension registers four more for its runs in `pipelineSteps.ts` — Backup,
 * Compare, Pre-check and Notification, each through the flow its module's page
 * runs. Every other step type is refused: a pipeline that holds one does not
 * start. (Until the refusal, those types went to a pass-through that returned
 * success without opening a connection.) Around that sit the places that
 * describe steps: the predefined catalogue the host serves on
 * `pipeline:templates`, the Marketplace catalogue, the step registry's own
 * descriptions, the config fields the Step Config Panel renders, and the
 * module page. Each of them has, at some point, promised work no step does — a
 * "Dry Run" that validates "without committing", a notification "via email,
 * Slack, or other channels", an approval that "pauses and waits", a box asking
 * which channel to notify.
 *
 * A banner on the page cannot fix a template card: the card is read on its
 * own, and its own words are what a reader takes. So this gate reads the
 * sources, not the prose, and refuses the claims while the steps behind them
 * are refused. Give a step type a real handler and the assertions about it
 * stop applying — `handledStepTypes` is read from where the handlers are
 * registered, so the gate follows the code rather than a copy of it.
 *
 * Its sibling `automation-scheduler-claims.test.mjs` does the same for the
 * docs about triggers and the scheduler.
 *
 *   node --test docs/automation-claims.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const docsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(docsDir, '..');
const extensionSrc = join(repoRoot, 'packages', 'extension', 'src');
const webviewSrc = join(repoRoot, 'packages', 'webview', 'src');

const read = (...parts) => readFileSync(join(...parts), 'utf8');

const templates = read(extensionSrc, 'bridge', 'templates', 'pipelineTemplates.ts');
const pipelineSteps = read(extensionSrc, 'bridge', 'handlers', 'pipelineSteps.ts');
const automationHandler = read(extensionSrc, 'bridge', 'handlers', 'AutomationHandler.ts');
const extensionHandlers = read(extensionSrc, 'bridge', 'ExtensionHandlers.ts');
const marketplace = read(extensionSrc, 'modules', 'automation', 'PipelineMarketplace.ts');
const stepExecutor = read(extensionSrc, 'modules', 'automation', 'StepExecutor.ts');
const stepLibrary = read(extensionSrc, 'modules', 'automation', 'StepLibrary.ts');
const automationPage = read(webviewSrc, 'pages', 'Automation', 'AutomationPage.tsx');
const stepConfigPanel = read(webviewSrc, 'pages', 'Automation', 'StepConfigPanel.tsx');
const automationTypes = read(repoRoot, 'packages', 'shared', 'src', 'types', 'automation.types.ts');

/** Every member of the `PipelineStepType` union. */
function allStepTypes() {
  const union = automationTypes.match(/export type PipelineStepType =([^;]+);/);
  assert.ok(union, 'PipelineStepType union not found in automation.types.ts');
  return [...union[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

/**
 * The step types a pipeline runs: the ones `StepExecutor.registerDefaults`
 * gives a handler, and the ones `registerPipelineSteps` registers — provided
 * the run handler calls it and the extension gives it the module flows.
 */
function handledStepTypes() {
  const defaults = stepExecutor.match(/private registerDefaults\(\): void \{([\s\S]*?)\n {2}\}/);
  assert.ok(defaults, 'no `registerDefaults` found in StepExecutor.ts — has the executor changed?');
  const own = [...defaults[1].matchAll(/this\.handlers\.set\('([a-z_]+)'/g)].map((m) => m[1]);
  // Positive control: a parse that sees no handler would call every type refused.
  assert.ok(own.length > 0, 'registerDefaults was read as registering no handler');

  const registration = pipelineSteps.match(/export function registerPipelineSteps\([\s\S]*?\n\}/);
  assert.ok(registration, 'no `registerPipelineSteps` found in pipelineSteps.ts — has it moved?');
  const viaModules = [...registration[0].matchAll(/registerHandler\(\s*'([a-z_]+)'/g)].map(
    (m) => m[1],
  );
  assert.ok(viaModules.length > 0, 'registerPipelineSteps was read as registering no handler');
  // Registered only where a run uses them: the run handler calls it, and the
  // extension hands the run handler the module flows.
  assert.match(
    automationHandler,
    /registerPipelineSteps\(stepExecutor, this\.stepRunners\)/,
    'the run handler no longer registers the module steps — they would be refused again',
  );
  assert.match(
    extensionHandlers,
    /this\.automationHandler\.setStepRunners\(/,
    'ExtensionHandlers no longer gives the run handler the module flows',
  );
  return [...own, ...viaModules];
}

/** The step types a pipeline refuses: every member of the union with no handler. */
function refusedStepTypes() {
  const handled = handledStepTypes();
  return allStepTypes().filter((type) => !handled.includes(type));
}

/**
 * The step types that write to an org. None of them may run in a pipeline:
 * each runs from its own page, where Production Guard stops a write to a
 * production org or asks the person at the panel first, and a pipeline runs
 * unattended.
 */
const WRITE_STEP_TYPES = ['seed', 'sync', 'restore', 'anonymize', 'delete'];

/**
 * Every `name:` and `description:` value of a template file, in source order.
 * Ids are left out on purpose: `tpl-migration-dry-run` is not shown on a card,
 * and a reader takes the name and the description, not the id.
 */
function readableStrings(source) {
  return [...source.matchAll(/(?:name|description):\s*\n?\s*'((?:[^'\\]|\\.)*)'/g)].map(
    (m) => m[1],
  );
}

/** The steps of a template file, as `{ name, type, config, description }`. */
function templateSteps(source) {
  const pattern =
    /\{\s*name: '((?:[^'\\]|\\.)*)',\s*type: '([\w:-]+)',\s*(?:config: (\{[^}]*\}),\s*)?description: '((?:[^'\\]|\\.)*)',\s*\}/g;
  return [...source.matchAll(pattern)].map(([, name, type, config, description]) => ({
    name,
    type,
    config: config ?? '{}',
    description,
  }));
}

/** A promise of unattended validation that leaves the target untouched. */
const DRY_RUN = /dry.?run|without commit/i;

/**
 * Named delivery channels. A pipeline reaches none of them: the `notification`
 * step shows its message in the VS Code window, and the extension has no
 * Slack, Teams, email or incident-tool client at all.
 */
const DELIVERY_CHANNEL = /\bslack|\bteams\b|\bemail|\bsms\b|pagerduty|datadog|\bjira\b|\bwebhook/i;

/**
 * Config keys that ask where to deliver something. A field named after a
 * destination is a promise in itself: a user who fills it in expects the run
 * to reach that destination.
 */
const DELIVERY_FIELD = /channel|recipient|webhook|slack|teams|email|sms/i;

/** The registry entry of a step type in `StepLibrary`, as source text. */
function stepLibraryEntry(type) {
  const start = stepLibrary.indexOf(`type: '${type}',`);
  assert.ok(start >= 0, `no '${type}' entry found in StepLibrary.ts`);
  const end = stepLibrary.indexOf('\n  },', start);
  assert.ok(end > start, `the '${type}' entry of StepLibrary.ts is not shaped as expected`);
  return stepLibrary.slice(start, end);
}

/** The `{ key, labelKey }` pairs the Step Config Panel renders for a step type. */
function configPanelFields(type) {
  const start = stepConfigPanel.indexOf(`\n  ${type}: [`);
  if (start < 0) return [];
  const end = stepConfigPanel.indexOf('],', start);
  const block = stepConfigPanel.slice(start, end);
  return [...block.matchAll(/key: '([^']*)', labelKey: '([^']*)'/g)].map(([, key, labelKey]) => ({
    key,
    labelKey,
  }));
}

test('no template offers a dry run', () => {
  // A template named "Dry Run" promises a rehearsal that leaves the target
  // untouched. Nothing in either catalogue inspects anything: the marketplace
  // template's sync step writes to the target org once sync steps run, and the
  // predefined one names step types the executor does not implement at all.
  for (const [file, source] of [
    ['pipelineTemplates.ts', templates],
    ['PipelineMarketplace.ts', marketplace],
  ]) {
    for (const value of readableStrings(source)) {
      assert.doesNotMatch(
        value,
        DRY_RUN,
        `${file} offers a rehearsal no step performs: ${JSON.stringify(value)}`,
      );
    }
  }
});

test('a notification step names no channel but the VS Code window it shows in', () => {
  // The step runs now, and what it runs is a VS Code notification: the
  // handler calls the one notifier it is given, which the composition root
  // builds from `vscode.window.showInformationMessage`.
  assert.ok(handledStepTypes().includes('notification'), 'the notification step is refused again');
  const handler = pipelineSteps.match(/function notificationHandler\([\s\S]*?\n\}/);
  assert.ok(handler, 'no notificationHandler found in pipelineSteps.ts');
  assert.match(
    handler[0],
    /runners\.notify\(/,
    'the notification step no longer shows its message',
  );
  assert.doesNotMatch(handler[0], DELIVERY_CHANNEL, 'the notification step reaches a channel now');
  assert.match(
    read(extensionSrc, 'services.ts'),
    /showNotification: \(message: string\): void => \{\s*void vscode\.window\.showInformationMessage\(message\);/,
    'showNotification is no longer a VS Code notification — re-read what the notification step promises',
  );

  for (const [file, source] of [
    ['pipelineTemplates.ts', templates],
    ['PipelineMarketplace.ts', marketplace],
  ]) {
    for (const step of templateSteps(source)) {
      if (!step.type.includes('notification')) continue;
      for (const text of [step.name, step.description, step.config]) {
        assert.doesNotMatch(
          text,
          DELIVERY_CHANNEL,
          `${file}: step "${step.name}" names a delivery channel: ${JSON.stringify(text)}`,
        );
      }
    }
  }

  const notification = stepLibrary.match(/type: 'notification',[\s\S]*?description: '([^']*)'/);
  assert.ok(notification, "no 'notification' entry found in StepLibrary.ts");
  assert.doesNotMatch(
    notification[1],
    DELIVERY_CHANNEL,
    'the notification step describes itself as a delivery it never performs',
  );
});

/**
 * The description of each template, as opposed to the descriptions of its
 * steps: the line a Marketplace card leads with.
 */
function templateDescriptions(source) {
  return [...source.matchAll(/^ {4}description:\s*\n?\s*'((?:[^'\\]|\\.)*)'/gm)].map((m) => m[1]);
}

/** A promise that someone is told: the work a notification step would do. */
const TELLS_SOMEONE = /\bnotif(?:y|ies|ied)\b|\balert/i;

test('no template card promises to tell anyone but the person running it', () => {
  // The notification step shows a VS Code notification, to whoever runs the
  // pipeline, and sends nothing anywhere. A card may say it shows one; a card
  // that ends on "notify the team" or "alert when" promises a delivery no run
  // makes, and the card is read on its own, away from the banner.
  for (const [file, source] of [
    ['pipelineTemplates.ts', templates],
    ['PipelineMarketplace.ts', marketplace],
  ]) {
    const descriptions = templateDescriptions(source);
    assert.ok(descriptions.length > 0, `no template description found in ${file}`);
    for (const description of descriptions) {
      assert.doesNotMatch(
        description,
        TELLS_SOMEONE,
        `${file}: a template promises a notification no run sends: ${JSON.stringify(description)}`,
      );
    }
  }
});

test('no step config asks where to deliver something nothing delivers', () => {
  // The palette description and the marketplace configs were made honest, but
  // the panel is the surface a user types into: a "Channel" box collects an
  // address no code reads, on a step that is refused and on the notification
  // step alike, which shows its message in VS Code and nowhere else.
  for (const type of allStepTypes()) {
    const entry = stepLibraryEntry(type);
    const schema = entry.match(/configSchema: \{([\s\S]*?)\}\s*,?\s*$/);
    for (const [, key] of schema ? schema[1].matchAll(/(\w+):\s*\{/g) : []) {
      assert.doesNotMatch(
        key,
        DELIVERY_FIELD,
        `StepLibrary.ts: the '${type}' step declares a destination it cannot reach: ${key}`,
      );
    }
    for (const field of configPanelFields(type)) {
      for (const text of [field.key, field.labelKey]) {
        assert.doesNotMatch(
          text,
          DELIVERY_FIELD,
          `StepConfigPanel.tsx: the '${type}' step offers a destination field: ${field.key}`,
        );
      }
    }
  }
});

test('the approval step does not claim to hold a run', () => {
  assert.ok(
    refusedStepTypes().includes('approval'),
    'approval has a handler now — re-read this gate before deleting it',
  );
  const approval = stepLibrary.match(/type: 'approval',[\s\S]*?description: '([^']*)'/);
  assert.ok(approval, "no 'approval' entry found in StepLibrary.ts");
  assert.doesNotMatch(
    approval[1],
    /pause|wait|hold|block/i,
    'the approval step promises to stop a run that runs to the end regardless',
  );
});

test('no pipeline view handles a status a run never reaches', () => {
  // `waiting_approval` was in the run-status union, badged in the history view
  // and treated as active in the execution view, although no code has ever
  // assigned it: the UI carried an approval concept nothing could produce.
  // `paused` went the same way once nothing could pause a run.
  const unreached = /waiting_approval|\bpaused\b/;
  const views = ['PipelineCanvas.tsx', 'PipelineExecutionView.tsx', 'PipelineHistoryView.tsx'];
  for (const file of views) {
    const source = read(webviewSrc, 'pages', 'Automation', file);
    assert.doesNotMatch(source, unreached, `${file} still handles a status no run reaches`);
  }
  const union = automationTypes.match(/export type PipelineRunStatus =([^;]+);/);
  assert.ok(union, 'PipelineRunStatus union not found in automation.types.ts');
  assert.doesNotMatch(
    union[1],
    unreached,
    'PipelineRunStatus still offers a status no run is ever given',
  );
});

test('no run can be paused, since nothing takes a paused run up again', () => {
  // `pause` stopped the run before its next step and recorded it as paused,
  // after which `resume` found no active run to wake. No message reached
  // either of them, and the execution view offered buttons for both.
  const orchestrator = read(extensionSrc, 'modules', 'automation', 'PipelineOrchestrator.ts');
  assert.doesNotMatch(
    orchestrator,
    /^ {2}(?:pause|resume)\(/m,
    'PipelineOrchestrator offers a pause or a resume again — does a paused run resume now?',
  );
  const view = read(webviewSrc, 'pages', 'Automation', 'PipelineExecutionView.tsx');
  assert.doesNotMatch(
    view,
    /\bon(?:Pause|Resume)\b/,
    'the execution view offers to pause or resume a run again',
  );
});

test('the Marketplace says its steps do not do the work yet', () => {
  const branchAt = automationPage.indexOf("activeTab === 'marketplace'");
  assert.ok(
    branchAt >= 0,
    'no marketplace branch found in AutomationPage.tsx — the notice may have moved',
  );
  const marketplaceView = automationPage.slice(branchAt);
  const notice =
    /data-testid="automation-marketplace-steps-soon"[\s\S]*?t\('automation\.soon\.steps'\)/.test(
      marketplaceView,
    ) ||
    /t\('automation\.soon\.steps'\)[\s\S]*?data-testid="automation-marketplace-steps-soon"/.test(
      marketplaceView,
    );

  const refused = refusedStepTypes();
  const inert = templateSteps(marketplace).filter((step) => refused.includes(step.type));
  assert.ok(inert.length > 0, 'no marketplace step is refused — has the executor changed?');

  if (notice) return;
  for (const step of inert) {
    assert.match(
      step.description,
      /\byet\b|not .*(?:run|perform|transfer)/i,
      `nothing tells a reader that "${step.name}" does no work: neither its own description nor a notice above the list`,
    );
  }
});

test('a finished run is written where the History tab reads it', () => {
  // `docs/modules/automation.md` says a run that completes or fails is kept in
  // extension storage. It was not: the tab read a category no code ever wrote
  // to, and was empty in every install.
  const handler = read(extensionSrc, 'bridge', 'handlers', 'AutomationHandler.ts');
  assert.match(
    handler,
    /configStore\.set\([\s\S]*?'pipeline-history',/,
    'the run handler writes no history entry, so the History tab stays empty',
  );
  // The writer is a private method: the run path has to call it, or the text
  // above matches while nothing is ever written.
  assert.match(
    handler,
    /await orchestrator\.execute\([\s\S]*?this\.recordRun\(/,
    'the run handler never calls the history writer after a run',
  );
  assert.match(
    handler,
    /configStore\.getByCategory\('pipeline-history'\)/,
    'nothing reads the history back — the cap and the tab both need it',
  );
});

test('no step that writes to an org runs in a pipeline', () => {
  const handled = handledStepTypes();
  // Positive control: the walk sees the steps registered through a module.
  for (const type of ['backup', 'compare', 'precheck', 'notification']) {
    assert.ok(handled.includes(type), `${type} is no longer seen as running — is the walk blind?`);
  }
  assert.deepEqual(
    handled.filter((type) => WRITE_STEP_TYPES.includes(type)),
    [],
    'a step that writes to an org runs in a pipeline now: it runs unattended, with no Production ' +
      'Guard confirmation. Re-read the module page, both READMEs and the listing before relaxing this.',
  );
  // And the palette says why each of them is refused, in the note its buttons point to.
  const note = JSON.parse(read(webviewSrc, 'i18n', 'locales', 'en.json')).automation.runnability
    .paletteNote;
  for (const label of ['Seed', 'Sync', 'Restore', 'Anonymize', 'Delete']) {
    assert.match(note, new RegExp(label), `the palette note does not name ${label}`);
  }
  assert.match(note, /write to an org/, 'the palette note does not say why they are refused');
});

/** Body of the section opened by `heading`, up to the next heading of the same or a higher level. */
function section(markdown, heading) {
  const start = markdown.indexOf(heading);
  assert.notEqual(start, -1, `heading not found, the guard is aimed at nothing: ${heading}`);
  const body = markdown.slice(start + heading.length);
  const level = heading.match(/^#+/)[0].length;
  const next = body.search(new RegExp(`^#{1,${level}} `, 'm'));
  return next === -1 ? body : body.slice(0, next);
}

/** The step type labels the page shows, by type. */
const STEP_LABELS = JSON.parse(read(webviewSrc, 'i18n', 'locales', 'en.json')).automation.stepTypes;

test('the module page lists exactly the step types that run, and names every one it refuses', () => {
  // The page said "only Delay steps run" for a release after Condition ran
  // too; it is read against the handlers now.
  const doc = read(repoRoot, 'docs', 'modules', 'automation.md');
  const stepTypes = section(doc, '### Step Types');
  const runs = stepTypes.match(/run in a pipeline:\n\n((?:- .*\n)+)/);
  assert.ok(runs, 'no "run in a pipeline:" list found under ### Step Types');
  const listed = [...runs[1].matchAll(/^- \*\*([^*]+)\*\*/gm)].map((m) => m[1]).sort();
  const expected = handledStepTypes()
    .map((type) => STEP_LABELS[type])
    .sort();
  assert.deepEqual(
    listed,
    expected,
    'the module page lists other step types than the ones that run',
  );

  const refused = stepTypes.slice(stepTypes.indexOf(runs[0]) + runs[0].length);
  for (const type of refusedStepTypes()) {
    assert.match(
      refused,
      new RegExp(STEP_LABELS[type]),
      `the module page does not name ${type} as refused`,
    );
  }
});

test('both READMEs name the step types that run, and say which are refused', () => {
  const handled = handledStepTypes();
  for (const file of ['README.md', join('packages', 'extension', 'README.md')]) {
    const row = read(repoRoot, file)
      .split('\n')
      .find((line) => line.startsWith('| **Automation**'));
    assert.ok(row, `${file} has no Automation row`);
    assert.doesNotMatch(row, /only `delay` runs/i, `${file} still says only delay runs`);
    for (const type of handled) {
      assert.match(row, new RegExp('`' + type + '`'), `${file} does not say ${type} runs`);
    }
    for (const type of WRITE_STEP_TYPES) {
      assert.match(row, new RegExp('`' + type + '`'), `${file} does not say ${type} is refused`);
    }
  }
});
