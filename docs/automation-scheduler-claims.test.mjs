/**
 * Keeps the Automation prose honest about the scheduler.
 *
 * SandForge has no pipeline scheduler. The `scheduler:*` channels it once
 * declared were sent by no screen and answered by `NoOpHandler`, and they are
 * gone: `ExtensionHandlers` routes none and the bridge's Zod union declares
 * none, so no pipeline has ever started on a timer. `docs/modules/automation.md`
 * says so in two banners — but the same file's own intro, quick start and tips
 * used to promise scheduling anyway, and the FAQ told readers pipelines run "on
 * a schedule". Banners lose to body copy: a reader who skims takes the promise.
 *
 * This gate asserts the three unbannered regions stay silent about scheduling
 * for as long as that absence holds. It fails in both directions: wire a
 * scheduler on those channels and the first check trips, telling whoever did it
 * that the docs are now understating the product and may be rewritten. It reads
 * channel names only: a scheduler wired under another name, or one that fires a
 * pipeline's triggers from the host with no channel at all, is not seen.
 *
 * Lives here rather than under `packages/*` because its subject is this
 * directory; run it the way `scripts/check-i18n-parity.test.mjs` is run:
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

const faq = readFileSync(join(docsDir, 'faq.md'), 'utf8');
const automation = readFileSync(join(docsDir, 'modules', 'automation.md'), 'utf8');

/** Anything that reads as a promise of unattended, time-based execution. */
const SCHEDULING = /schedul|cron|nightly|recurring|on a timer/i;

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

/** Every channel `ExtensionHandlers.ts` hands to `route(`, as a list or on its own. */
function routedChannels() {
  const src = readFileSync(
    join(repoRoot, 'packages', 'extension', 'src', 'bridge', 'ExtensionHandlers.ts'),
    'utf8',
  );
  return [...src.matchAll(/\broute\(\s*(\[[^\]]*\]|'[^']*')/g)].flatMap(([, channels]) =>
    [...channels.matchAll(/'([^']+)'/g)].map(([, channel]) => channel),
  );
}

/** Every channel the bridge's Zod union declares, one `msg('…')` member each. */
function declaredChannels() {
  const src = readFileSync(
    join(repoRoot, 'packages', 'shared', 'src', 'bridge', 'messageSchemas.ts'),
    'utf8',
  );
  return [...src.matchAll(/msg\('([^']+)'\)/g)].map(([, channel]) => channel);
}

test('no scheduler:* channel is routed or declared', () => {
  for (const [where, channels] of [
    ['routed in ExtensionHandlers.ts', routedChannels()],
    ['declared in messageSchemas.ts', declaredChannels()],
  ]) {
    // Positive control: the scan reads the Sync schedules, which are there, so
    // an empty list below is not an empty read.
    assert.ok(
      channels.includes('sync:schedule:upsert'),
      `sync:schedule:upsert is not seen ${where} — the scan is reading nothing`,
    );
    assert.deepEqual(
      channels.filter((channel) => channel.startsWith('scheduler:')),
      [],
      `a scheduler:* channel is ${where} again — a pipeline may now start on a timer. Re-read ` +
        'the Automation docs and the FAQ before relaxing this test',
    );
  }
});

test('the FAQ does not answer "recurring operations" with a schedule', () => {
  const answer = section(faq, '### Can I automate recurring operations?');
  assert.doesNotMatch(
    answer,
    /run them (?:manually )?or on a schedule/i,
    'the FAQ promises scheduled runs that no executor performs',
  );
  assert.match(
    answer,
    /not wired yet/i,
    'the FAQ must name the gap, not merely stop short of claiming it',
  );
});

test('the Automation intro and quick start stay silent about scheduling', () => {
  const lead = section(automation, '# Automation');
  const quickStart = section(automation, '## Quick Start');

  // The lead is everything before `## Quick Start`; slice it off so the two
  // regions are asserted separately and a failure names the right one.
  assert.doesNotMatch(lead.slice(0, lead.indexOf('## Quick Start')), SCHEDULING);
  assert.doesNotMatch(quickStart, SCHEDULING);
});

test('the Tips section does not sell triggers as automation', () => {
  const tips = section(automation, '## Tips');
  assert.doesNotMatch(tips, SCHEDULING);
  assert.doesNotMatch(tips, /use triggers/i);
});

test('the Triggers and Scheduler sections keep their coming-soon banners', () => {
  // These two sections describe the planned design in the present tense; the
  // banners are the only thing that makes that legitimate.
  for (const heading of ['### Triggers', '### Scheduler']) {
    assert.match(
      section(automation, heading),
      /> \*\*Coming soon:\*\*/,
      `${heading} describes unbuilt behaviour with no coming-soon banner`,
    );
  }
  assert.match(
    section(automation, '### Scheduler'),
    /there is no scheduler backend/,
    'the Scheduler banner must state there is no scheduler backend, not merely hedge',
  );
});

test('the Triggers section lists exactly the trigger types the panel offers', () => {
  // The section used to list File Watch, Record Change and Pipeline Completion,
  // which no TriggerType names, and to omit three that the panel does offer.
  const types = readFileSync(
    join(repoRoot, 'packages', 'shared', 'src', 'types', 'automation.types.ts'),
    'utf8',
  );
  const union = types.match(/export type TriggerType =([^;]+);/);
  assert.ok(union, 'TriggerType union not found in automation.types.ts');
  const ids = [...union[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  const en = JSON.parse(
    readFileSync(
      join(repoRoot, 'packages', 'webview', 'src', 'i18n', 'locales', 'en.json'),
      'utf8',
    ),
  );
  const labels = ids.map((id) => en.automation.triggerTypes[id]);

  const listed = [...section(automation, '### Triggers').matchAll(/^- \*\*([^*]+)\*\*(.*)$/gm)];
  assert.deepEqual(
    listed.map((m) => m[1]),
    labels,
  );
  for (const [, label, rest] of listed) {
    if (label === en.automation.triggerTypes.manual) continue;
    assert.match(rest, /_\(coming soon\)_/, `${label} is listed without its coming-soon marker`);
  }
});

test('the Automation banners name no release', () => {
  // "as of v1.3.0" sat in both banners of a v1.22 product. A banner that states
  // the present needs no version, and one that names a version goes stale.
  assert.doesNotMatch(automation, /\bas of v\d/i);
  for (const heading of ['### Triggers', '### Scheduler']) {
    const banner = section(automation, heading)
      .split('\n')
      .filter((line) => line.startsWith('>'))
      .join('\n');
    assert.doesNotMatch(banner, /\bv\d+\.\d+/, `${heading} banner pins a version`);
  }
});
