/**
 * Keeps the Automation prose honest about what starts a pipeline.
 *
 * For most of SandForge's life a pipeline started by hand only: every other
 * trigger was stored and never fired, and this gate held the docs silent about
 * scheduling while the FAQ still told readers pipelines ran "on a schedule".
 * Two trigger types start runs now. `PipelineTriggerScheduler` fires the
 * Schedule and the Sandbox Refresh triggers of the saved pipelines, and the
 * composition root starts it when the extension activates. Event, Webhook and
 * Deployment Complete still start nothing.
 *
 * What a reader has to be told about the two that do is where the promise can
 * outrun the code: a schedule runs only while VS Code is open — it is no
 * server — and a start that falls due while VS Code is closed is reported
 * missed, never made late. A page that sells a schedule without saying so
 * promises a cron job.
 *
 * So the gate reads the code for which trigger types fire, and holds the
 * panel, the module page, the FAQ, the getting-started list and both READMEs
 * to it: the panel offers exactly the types that start a run, the module page
 * lists those and calls none of them, or of the others, coming soon, and
 * every region that sells a schedule says it runs while VS Code is open.
 *
 *   node --test docs/automation-scheduler-claims.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const docsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(docsDir, '..');
const read = (...parts) => readFileSync(join(repoRoot, ...parts), 'utf8');

const faq = read('docs', 'faq.md');
const automation = read('docs', 'modules', 'automation.md');
const en = JSON.parse(read('packages', 'webview', 'src', 'i18n', 'locales', 'en.json'));

/** Anything that reads as a promise of unattended, time-based execution. */
const SCHEDULING = /schedul|cron|nightly|recurring|on a timer/i;

/** The caveat every such promise has to carry. */
const WHILE_OPEN = /while VS Code is open/;

/**
 * Body of the section opened by `heading`, up to the next heading of the same
 * or a higher level — the span a reader attributes to that heading.
 */
function section(markdown, heading) {
  const start = markdown.indexOf(heading);
  assert.notEqual(start, -1, `heading not found, the guard is aimed at nothing: ${heading}`);
  const body = markdown.slice(start + heading.length);
  const level = heading.match(/^#+/)[0].length;
  const next = body.search(new RegExp(`^#{1,${level}} `, 'm'));
  return next === -1 ? body : body.slice(0, next);
}

/** Every member of the `TriggerType` union, in its order. */
function triggerTypes() {
  const types = read('packages', 'shared', 'src', 'types', 'automation.types.ts');
  const union = types.match(/export type TriggerType =([^;]+);/);
  assert.ok(union, 'TriggerType union not found in automation.types.ts');
  return [...union[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

/**
 * The trigger types that start a run: Manual, from the Run button, and the
 * ones the trigger scheduler reads out of a saved pipeline — provided the
 * extension starts the scheduler.
 */
function startingTriggerTypes() {
  const scheduler = read(
    'packages',
    'extension',
    'src',
    'modules',
    'automation',
    'PipelineTriggerScheduler.ts',
  );
  const method = scheduler.match(/private triggersOf\([\s\S]*?\n {2}\}/);
  assert.ok(method, 'no triggersOf in PipelineTriggerScheduler.ts — has the scheduler moved?');
  const fired = [...method[0].matchAll(/trigger\.type === '([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(fired.length > 0, 'triggersOf was read as firing no trigger type');

  assert.match(
    read('packages', 'extension', 'src', 'extension.ts'),
    /wirePipelineTriggers\(/,
    'the extension no longer starts the pipeline triggers at activation — none of them fires',
  );
  assert.match(
    read('packages', 'extension', 'src', 'bridge', 'ExtensionHandlers.ts'),
    /this\.automationHandler\.startTriggers\(/,
    'ExtensionHandlers no longer hands the triggers to the handler that starts them',
  );
  return ['manual', ...fired];
}

/** The label the panel shows for a trigger type. */
const label = (type) => en.automation.triggerTypes[type];

/** The trigger types the Trigger Config Panel adds, in its order. */
function offeredTriggerTypes() {
  const panel = read('packages', 'webview', 'src', 'pages', 'Automation', 'TriggerConfigPanel.tsx');
  const list = panel.match(/const OFFERED_TRIGGER_TYPES: TriggerType\[\] = \[([^\]]*)\]/);
  assert.ok(list, 'OFFERED_TRIGGER_TYPES not found in TriggerConfigPanel.tsx');
  assert.match(
    panel,
    /options=\{OFFERED_TRIGGER_TYPES\.map\(/,
    'the add list no longer offers OFFERED_TRIGGER_TYPES',
  );
  return [...list[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

test('anchor: the extension fires the schedule and sandbox refresh triggers, and no other', () => {
  const starting = startingTriggerTypes();
  // Positive control: the walk sees the schedule, which fires.
  assert.ok(starting.includes('schedule'), 'the walk does not see the schedules fire');
  assert.deepEqual(
    starting.filter((type) => ['event', 'webhook', 'deployment_complete'].includes(type)),
    [],
    'an event, webhook or deployment trigger fires now — the panel does not offer it, and the ' +
      'docs below say it starts nothing. Re-read the Triggers section, the FAQ and both READMEs ' +
      'before relaxing this.',
  );
});

test('the panel offers exactly the trigger types that start a run', () => {
  // It offered all six, the three that start nothing marked "Coming soon".
  assert.deepEqual([...offeredTriggerTypes()].sort(), [...startingTriggerTypes()].sort());
  // Positive control: the union holds more types than the panel offers.
  assert.ok(triggerTypes().length > offeredTriggerTypes().length);
});

test('the Triggers section lists exactly the trigger types the panel offers', () => {
  const listed = [...section(automation, '### Triggers').matchAll(/^- \*\*([^*]+)\*\*(.*)$/gm)];
  assert.deepEqual(
    listed.map((m) => m[1]),
    offeredTriggerTypes().map(label),
  );
});

test('the Triggers section calls no trigger coming soon', () => {
  const triggers = section(automation, '### Triggers');
  assert.doesNotMatch(triggers, /coming soon/i, 'the Triggers section promises a trigger again');
});

test('the Triggers section names every type that starts nothing, says so, and pins no release', () => {
  const starting = startingTriggerTypes();
  const triggers = section(automation, '### Triggers');
  const idle = triggerTypes().filter((type) => !starting.includes(type));
  assert.ok(idle.length > 0, 'every trigger type starts a run now — re-read this gate');
  const paragraph = triggers
    .split('\n\n')
    .find((block) => idle.every((type) => block.includes(`**${label(type)}**`)));
  assert.ok(paragraph, 'no paragraph of the Triggers section names every type that starts nothing');
  assert.match(paragraph, /start nothing/, 'the Triggers section does not say they start nothing');
  // "as of v1.3.0" sat in a banner of a v1.22 product: one that names a
  // version goes stale.
  assert.doesNotMatch(triggers, /\bv\d+\.\d+/, 'the Triggers section pins a version');
  assert.doesNotMatch(automation, /\bas of v\d/i);
});

test('the Triggers section says a start is never made late, and a pipeline runs once at a time', () => {
  const scheduler = read(
    'packages',
    'extension',
    'src',
    'modules',
    'automation',
    'PipelineTriggerScheduler.ts',
  );
  // The code the sentences below describe: a bound past which a start is
  // reported rather than made, and a start refused while a run is going.
  assert.match(scheduler, /export const LATE_AFTER_MS = /);
  assert.match(scheduler, /reason: 'busy'/);

  const triggers = section(automation, '### Triggers');
  assert.match(triggers, /is not made late/);
  assert.match(triggers, /written to Execution History as missed/);
  assert.match(triggers, /One run of a pipeline at a time/);
  assert.match(triggers, /steps can all run/);
});

test('every region that sells a schedule says it runs only while VS Code is open', () => {
  const regions = [
    ['the Automation lead', section(automation, '# Automation').split('## Quick Start')[0]],
    ['the Automation quick start', section(automation, '## Quick Start')],
    ['the Triggers section', section(automation, '### Triggers')],
    ['the Scheduler section', section(automation, '### Scheduler')],
    ['the Automation tips', section(automation, '## Tips')],
    ['the FAQ answer', section(faq, '### Can I automate recurring operations?')],
    [
      'the README Automation row',
      read('README.md')
        .split('\n')
        .find((line) => line.startsWith('| **Automation**')),
    ],
    [
      'the Marketplace README Automation row',
      read('packages', 'extension', 'README.md')
        .split('\n')
        .find((line) => line.startsWith('| **Automation**')),
    ],
  ];
  // Positive control: the lead sells schedules, so the rule below bites.
  assert.match(regions[0][1], SCHEDULING, 'the lead no longer mentions a schedule');
  for (const [where, text] of regions) {
    assert.ok(text, `${where} not found`);
    if (SCHEDULING.test(text)) {
      assert.match(
        text,
        WHILE_OPEN,
        `${where} sells a schedule without saying VS Code must be open`,
      );
    }
  }
});

test('the FAQ answers "recurring operations" with what starts a pipeline, and names the gap', () => {
  const answer = section(faq, '### Can I automate recurring operations?');
  assert.match(answer, /on a cron schedule/);
  assert.match(answer, /never made late/);
  assert.match(
    answer,
    /Event, webhook and deployment triggers start nothing/,
    'the FAQ must name the triggers that start nothing, not merely stop short of claiming them',
  );
});

test('the Scheduler section describes the tab the page renders: the sync and the pipeline schedules', () => {
  const calendar = read(
    'packages',
    'webview',
    'src',
    'pages',
    'Automation',
    'SchedulerCalendar.tsx',
  );
  assert.match(calendar, /<SyncSchedulePanel layout=\{ScheduleAgenda\} \/>/);
  assert.match(calendar, /<PipelineSchedules rows=\{pipelineSchedules\} \/>/);
  assert.doesNotMatch(calendar, /comingSoon/);

  const scheduler = section(automation, '### Scheduler');
  assert.match(scheduler, /sync schedules/);
  assert.match(scheduler, /pipeline schedules/);
  assert.match(
    scheduler,
    /never made late/,
    'the Scheduler section must say how a pipeline schedule differs from a sync one',
  );
  assert.doesNotMatch(
    scheduler,
    /no pipeline runs on a timer/,
    'the Scheduler section still says no pipeline runs on a timer',
  );
  assert.doesNotMatch(
    scheduler,
    /exclusion dates|holidays|maintenance windows/i,
    'the Scheduler section promises calendar features the tab does not have',
  );
});
