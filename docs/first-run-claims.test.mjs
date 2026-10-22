/**
 * Gate for what a newcomer reads before the first click: the two READMEs, the
 * FAQ, the Autopilot guide, the command-line table and the Marketplace listing.
 *
 * The product is the answer to an empty dev org, and the pages read first
 * said otherwise. The README's only quick start asked for a record of a UAT
 * sandbox and a second org to clone it into; Quick Seed, which fills one empty
 * Developer Edition from a template with no AI key, was named nowhere a reader
 * starts. The Seed row led with AI personas. Autopilot was sold as
 * "zero-config sandbox seeding" while it copies whole tables, unmasked unless
 * asked, with no way to take a run back. The FAQ never said how to undo a run,
 * though undo differs by module, nor what SandForge keeps on disk. The ten
 * command-line scripts were linked from nowhere, and their table listed a
 * fraction of the flags each script's own help gives.
 *
 * Each rule reads the code that makes the sentence true, so the sentence goes
 * stale loudly: the template the gallery puts first, the handlers that keep
 * what a run created, the stores that write to disk, the scripts' HELP text.
 *
 *   node --test docs/first-run-claims.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveNls } from './claims-surfaces.mjs';

const docsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(docsDir, '..');
const read = (...parts) => readFileSync(join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');
const readJson = (...parts) => JSON.parse(read(...parts));

const READMES = ['README.md', 'packages/extension/README.md'];
const EXT = ['packages', 'extension'];
const EXT_SRC = [...EXT, 'src'];
const WEBVIEW_SRC = ['packages', 'webview', 'src'];

/** The English catalogue: the labels the panel shows. */
const en = () => readJson(...WEBVIEW_SRC, 'i18n', 'locales', 'en.json');

/** A dotted key of the English catalogue, which must exist. */
function label(key) {
  const value = key.split('.').reduce((node, part) => node?.[part], en());
  assert.equal(typeof value, 'string', `en.json has no ${key} — re-point this gate`);
  return value;
}

/** The body of a `## ` (or deeper) section, up to the next heading of its level or above. */
function section(text, heading) {
  const level = /^#+/.exec(heading)[0].length;
  const start = text.indexOf(`${heading}\n`);
  assert.notEqual(start, -1, `"${heading}" is missing`);
  const rest = text.slice(start + heading.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return next === -1 ? rest : rest.slice(0, next);
}

/** The table row of a section whose first or second cell names `name`. */
function row(body, name) {
  // The module is named in the first cell of the undo table, the second of the
  // table that says which tool copies what.
  const line = body.split('\n').find(
    (l) =>
      l.startsWith('|') &&
      l
        .split('|')
        .slice(1, 3)
        .some((cell) => cell.includes(name)),
  );
  assert.ok(line, `no row for ${name}`);
  return line;
}

// ── the empty org comes first ─────────────────────────────────────────────

/**
 * The template the gallery lists first and marks, by its catalogue label,
 * after checking that it needs no AI key: a template whose rules call the
 * model would make "no AI key" false the day it became the first.
 */
function firstTemplate() {
  const gallery = read(...WEBVIEW_SRC, 'pages', 'Seed', 'useTemplateGallery.ts');
  const id = /const FIRST_SEED_TEMPLATE_ID = '([^']+)'/.exec(gallery)?.[1];
  assert.ok(id, 'FIRST_SEED_TEMPLATE_ID is gone — re-point this gate');
  const templates = read('packages', 'shared', 'src', 'constants', 'seed-templates.ts');
  assert.doesNotMatch(
    templates,
    /ai_generate/,
    'a built-in template calls the model now: "no AI key" is not true of every one',
  );
  const block = new RegExp(`id: '${id}',\\s*name: '([^']+)'`).exec(templates);
  assert.ok(block, `the template ${id} is gone from seed-templates.ts`);
  return label(block[1]);
}

test('anchor: the template the gallery puts first writes with no AI key', () => {
  assert.equal(firstTemplate(), 'CRM Starter');
});

test('both READMEs open with filling one empty org, before the clone that needs two', () => {
  const template = firstTemplate();
  const labels = [
    label('sidePanel.firstOrg.title'),
    label('seed.gallery.useThis'),
    label('seed.quickSeed.startSeeding'),
    label('seed.removal.historyTitle'),
    template,
  ];
  for (const relPath of READMES) {
    const text = read(...relPath.split('/'));
    const headings = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    assert.match(headings[0], /empty org/i, `${relPath}: the first section is not the empty org`);
    assert.ok(
      headings.indexOf(headings[0]) < headings.indexOf('Your first clone in 2 minutes'),
      `${relPath}: the two-org clone comes before the empty org`,
    );
    const body = section(text, `## ${headings[0]}`);
    for (const name of labels) {
      assert.ok(
        body.includes(`**${name}**`),
        `${relPath}: the quick start does not name **${name}**`,
      );
    }
    assert.ok(
      body.includes(`**${template}**, marked _${label('seed.gallery.recommended')}_`),
      `${relPath}: the quick start does not point at the template the gallery marks`,
    );
    assert.match(body, /no AI key/i, `${relPath}: say that no AI key is needed`);
    assert.match(body, /seed\.png\)/, `${relPath}: the gallery's screenshot goes with it`);
  }
});

test('the Seed rows of both READMEs lead with the templates, AI optional', () => {
  for (const relPath of READMES) {
    const seed = read(...relPath.split('/'))
      .split('\n')
      .find((line) => line.startsWith('| **Seed**'));
    assert.ok(seed, `${relPath}: the Seed row is gone`);
    assert.match(seed, /no AI key/, `${relPath}: the Seed row does not say no AI key is needed`);
    assert.ok(
      seed.indexOf('template') !== -1 && seed.indexOf('template') < seed.search(/\bAI\b/),
      `${relPath}: the Seed row leads with AI again`,
    );
  }
});

// ── what a run keeps, and how it is taken back ────────────────────────────

/**
 * Which ways of writing keep what a run created, read from the code: only a
 * run that keeps it can be taken back.
 */
function removability() {
  const handlers = [...EXT_SRC, 'bridge', 'handlers'];
  const seedOps = read(...handlers, 'SeedOpsHandler.ts');
  assert.match(
    seedOps,
    /SeedRunCreations/,
    'a Seed template or wizard run no longer keeps what it created',
  );
  // A CSV import and a clone keep what they create as a seed does, and are
  // listed and removed with the seeds.
  for (const file of ['SeedCsvHandler.ts', 'SeedCloneHandler.ts']) {
    assert.match(
      read(...handlers, file),
      /SeedRunCreations/,
      `${file} no longer keeps what it created: the docs say it can be removed`,
    );
  }
  assert.ok(
    existsSync(join(repoRoot, ...handlers, 'SyncRemovalHandler.ts')),
    'Sync lost its removal',
  );
  assert.ok(
    existsSync(join(repoRoot, ...EXT_SRC, 'modules', 'forge', 'ForgeRunRemoval.ts')),
    'Forge lost its removal',
  );
  assert.doesNotMatch(
    read(...handlers, 'AutopilotHandler.ts'),
    /remov|RunCreations/i,
    'Autopilot keeps or removes what a run created now: the docs say a run cannot be removed',
  );
  assert.ok(
    !readdirSync(join(repoRoot, ...EXT_SRC, 'modules', 'autopilot')).some((f) => /remov/i.test(f)),
    'the Autopilot module has a removal now',
  );
  assert.equal(en().autopilot.removal, undefined, 'the Autopilot panel offers a removal now');
  return {
    forge: label('forge.history.remove'),
    seed: label('seed.removal.historyTitle'),
    seedResults: label('runRemoval.sync.title'),
    sync: label('runRemoval.sync.remove'),
    frozen: label('frozen.removal.remove'),
  };
}

test('anchor: Forge, every way of Seed — a template, the wizard, CSV Upload, Clone from Org — Sync and Frozen keep what they create; Autopilot does not', () => {
  removability();
});

test('the READMEs and the FAQ say which tool copies data, and how each run is taken back', () => {
  const labels = removability();
  const surfaces = [
    ...READMES.map((p) => [p, section(read(...p.split('/')), '## Which tool copies my data?')]),
    ['docs/faq.md', section(read('docs', 'faq.md'), '### Which tool copies my data?')],
  ];
  for (const [where, body] of surfaces) {
    assert.ok(row(body, 'Forge').includes(`**${labels.forge}**`), `${where}: Forge's removal`);
    assert.ok(row(body, 'Sync').includes(`**${labels.sync}**`), `${where}: Sync's removal`);
    assert.ok(row(body, 'Frozen Dataset').includes(`**${labels.frozen}**`), `${where}: Frozen's`);
    const seed = row(body, 'Seed');
    assert.ok(seed.includes(`**${labels.seed}**`), `${where}: Seed's removal`);
    assert.ok(seed.includes(`**${labels.seedResults}**`), `${where}: Seed's results removal`);
    assert.match(row(body, 'Autopilot'), /cannot be removed/, `${where}: Autopilot's run`);
  }
  for (const relPath of READMES) {
    const body = section(read(...relPath.split('/')), '## Which tool copies my data?');
    assert.match(
      body,
      /\*\*CSV Upload\*\* and \*\*Clone from Org\*\*[^\n]*taken back as a seed is/,
      `${relPath}: say that a CSV import and a clone from another org are taken back as a seed is`,
    );
    assert.doesNotMatch(
      body,
      /\*\*CSV Upload\*\* and \*\*Clone from Org\*\*[^\n]*cannot be taken back/,
      `${relPath}: still says that a CSV import and a clone cannot be taken back`,
    );
  }
});

test('the FAQ says how to undo a run, module by module, as the code allows', () => {
  const labels = removability();
  const body = section(read('docs', 'faq.md'), '### How do I undo what SandForge wrote?');
  assert.ok(row(body, 'Forge').includes(`**${labels.forge}**`));
  assert.ok(row(body, 'Sync').includes(`**${labels.sync}**`));
  assert.ok(row(body, 'Frozen Dataset').includes(`**${labels.frozen}**`));
  assert.ok(row(body, 'Seed: a template').includes(`**${labels.seed}**`));
  for (const way of ['CSV Upload', 'Clone from Org']) {
    assert.ok(row(body, way).includes(`**${labels.seed}**`), `${way}: Earlier seeds`);
    assert.ok(row(body, way).includes(`**${labels.seedResults}**`), `${way}: its results`);
    assert.doesNotMatch(row(body, way), /Not removable/);
  }
  assert.match(row(body, 'Autopilot'), /Not removable/);
  // The way out for a run nothing takes back, said with its danger.
  assert.match(body, /`sandforge-cleanup` deletes every record your user created/);
  assert.match(body, /--dry-run/);
  assert.match(body, /--objects/);
});

test('the FAQ answers the person account, currency and empty-org questions', () => {
  const faq = read('docs', 'faq.md');
  for (const heading of [
    '### I have one empty org. Where do I start?',
    '### Does SandForge handle person accounts?',
    '### Does SandForge handle multi-currency orgs?',
  ]) {
    assert.ok(section(faq, heading).trim().length > 200, `${heading} has no answer`);
  }
  assert.ok(
    section(faq, '### I have one empty org. Where do I start?').includes(`**${firstTemplate()}**`),
    'the empty-org answer does not name the template the gallery marks',
  );
});

/**
 * What SandForge keeps on disk, each read from the code that writes it: a
 * reader deciding whether to try it on a shared machine is owed the list.
 */
test('the FAQ says what SandForge keeps on the machine, where the code keeps it', () => {
  const body = section(read('docs', 'faq.md'), '### What does SandForge keep on my machine?');
  const modules = [...EXT_SRC, 'modules'];

  const seedRuns = /export const SEED_RUNS_KEPT = (\d+);/.exec(
    read(...modules, 'seed', 'SeedRunCreations.ts'),
  )?.[1];
  assert.ok(seedRuns, 'SEED_RUNS_KEPT is gone — re-point this gate');
  assert.match(body, new RegExp(`last ${seedRuns} Seed runs`));

  assert.match(
    read(...modules, 'forge', 'ForgeTemplateStore.ts'),
    /path\.join\(deps\.workspacePath, '\.sandforge', 'forge-templates\.json'\)/,
  );
  assert.ok(body.includes('`.sandforge/forge-templates.json`'), 'the Forge templates file');

  assert.match(
    read(...modules, 'forge', 'ForgeRunJournal.ts'),
    /path\.join\(deps\.storagePath, 'forge-runs'\)/,
  );
  assert.ok(body.includes('`forge-runs/`'), 'the Forge journals');

  assert.match(
    read(...EXT_SRC, 'bridge', 'handlers', 'FrozenDatasetHandler.ts'),
    /path\.join\(os\.homedir\(\), '\.sandforge-sas'\)/,
  );
  assert.ok(body.includes('`~/.sandforge-sas`'), "the Frozen Dataset's working folder");

  assert.match(
    read(...EXT_SRC, 'bridge', 'handlers', 'ai', 'AIChatHandler.ts'),
    /secretVault\.storeSecret\(AI_API_KEY_SECRET/,
  );
  assert.match(
    read(...modules, 'frozendataset', 'FrozenSalt.ts'),
    /secrets\.storeSecret\(FROZEN_SALT_SECRET_KEY/,
  );
  const secrets = body.split('\n').find((line) => line.includes('secret storage'));
  assert.ok(secrets, 'the secret storage line');
  assert.match(secrets, /Anthropic key/);
  assert.match(secrets, /salt/);

  assert.match(body, /DataOps backups, which hold the records' values/);
});

// ── Autopilot, as the copy it is ──────────────────────────────────────────

test('both READMEs and the Autopilot guide sell Autopilot as the copy it is', () => {
  removability();
  const store = read(...WEBVIEW_SRC, 'stores', 'useAutopilotStore.ts');
  assert.match(
    store,
    /complianceFramework: 'none' as ComplianceFrameworkType/,
    'Autopilot masks by default now — the guide says masking is off unless picked',
  );
  assert.match(
    store,
    /neutralizeContactPoints: true,/,
    'Autopilot keeps emails and phone numbers by default now — the guide says they are neutralized',
  );
  assert.match(
    read(...EXT_SRC, 'modules', 'autopilot', 'AutopilotExecutor.ts'),
    /options\.keepContactPoints === true \? undefined : new ContactPointNeutralizer\(\)/,
  );

  for (const relPath of READMES) {
    const autopilot = read(...relPath.split('/'))
      .split('\n')
      .find((line) => line.startsWith('| **Autopilot**'));
    assert.ok(autopilot, `${relPath}: the Autopilot row is gone`);
    assert.doesNotMatch(
      autopilot,
      /seeding|zero-config/i,
      `${relPath}: Autopilot copies, it does not seed`,
    );
    assert.match(autopilot, /whole objects/);
    assert.match(autopilot, /cannot be removed/);
    assert.match(autopilot, /autopilot\.md\)/, `${relPath}: the Autopilot row links no guide`);
  }
  const guide = read('docs', 'modules', 'autopilot.md');
  assert.match(guide, /copies whole tables/i);
  assert.match(guide, /Masking is off by default/);
  assert.match(guide, /Emails and phone numbers are neutralized/);
  assert.match(guide, /A run cannot be removed/);
  assert.ok(
    guide.includes(`**${label('autopilot.step4.contactPoints')}**`),
    'the box, as labelled',
  );
});

// ── the scripts the README never linked ───────────────────────────────────

const CLI_DIR = [...EXT, 'cli'];

/** The command-line scripts, as `sandforge-<name>`. */
const scripts = () =>
  readdirSync(join(repoRoot, ...CLI_DIR))
    .filter((file) => /^sandforge-[a-z]+\.ts$/.test(file))
    .map((file) => file.replace(/\.ts$/, ''))
    .sort();

/** Every `--flag` a script's HELP text names. */
function helpFlags(script) {
  const source = read(...CLI_DIR, `${script}.ts`);
  const help = /const HELP = `([\s\S]*?)`;/.exec(source)?.[1];
  assert.ok(help, `${script}.ts has no HELP text — re-point this gate`);
  return new Set([...help.matchAll(/(?<![\w-])--[a-z][a-z-]*/g)].map((m) => m[0]));
}

const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
];

test('both READMEs link the command-line scripts and say what they run on', () => {
  const count = NUMBER_WORDS[scripts().length];
  assert.ok(count, 'more scripts than this gate can spell — extend NUMBER_WORDS');
  const root = readJson('package.json');
  const node = /\d+/.exec(root.engines.node)[0];
  const pnpm = /^pnpm@(\d+)\./.exec(root.packageManager)[1];
  for (const relPath of READMES) {
    const text = read(...relPath.split('/'));
    const docs = section(text, '## Documentation');
    const cli = docs.split('\n').find((line) => line.includes('ci-examples/README.md'));
    assert.ok(cli, `${relPath}: the Documentation table does not link the command-line scripts`);
    assert.ok(cli.toLowerCase().includes(`${count} scripts`), `${relPath}: say how many scripts`);
    const requirements = section(text, '## Requirements');
    assert.match(requirements, new RegExp(`Node\\.js ${node} and pnpm ${pnpm}`));
    assert.match(requirements, /`pnpm install` and `pnpm build:shared`/);
  }
  assert.ok(
    read('ci-examples', 'README.md').includes(`What runs headless is ${count} TypeScript scripts`),
    'ci-examples/README.md counts the scripts otherwise',
  );
});

test('each script row of ci-examples names every flag its --help lists, and no other', () => {
  const table = read('ci-examples', 'README.md');
  const offenders = [];
  for (const script of scripts()) {
    const line = table
      .split('\n')
      .find((l) => l.startsWith(`| \`packages/extension/cli/${script}.ts\``));
    if (!line) {
      offenders.push(`${script}: no row`);
      continue;
    }
    const documented = new Set([...line.matchAll(/(?<![\w-])--[a-z][a-z-]*/g)].map((m) => m[0]));
    const help = helpFlags(script);
    help.delete('--help');
    for (const flag of help)
      if (!documented.has(flag)) offenders.push(`${script}: ${flag} missing`);
    for (const flag of documented)
      if (!help.has(flag)) offenders.push(`${script}: ${flag} unknown`);
  }
  assert.deepEqual(
    offenders,
    [],
    `the script table and the scripts' help disagree:\n  ${offenders.join('\n  ')}`,
  );
});

/**
 * Compare's and Monitor's help said `npx tsx`, the other eight and the
 * command-line page `pnpm exec tsx`: `npx` may fetch a tsx of its own where
 * the checkout has one installed, and a reader comparing two helps read two
 * ways of running them.
 */
test('every script’s help runs it the way ci-examples says every script is run', () => {
  const said = /is invoked as `(.+?) packages\/extension\/cli\/sandforge-<name>\.ts \.\.\.`/.exec(
    read('ci-examples', 'README.md'),
  )?.[1];
  assert.equal(said, 'pnpm exec tsx', 'ci-examples no longer says how a script is run');
  const offenders = [];
  for (const script of scripts()) {
    const help = /const HELP = `([\s\S]*?)`;/.exec(read(...CLI_DIR, `${script}.ts`))?.[1] ?? '';
    const runs = help.split('\n').filter((line) => line.includes(`cli/${script}.ts`));
    if (runs.length === 0) offenders.push(`${script}: no usage line`);
    for (const line of runs) {
      if (!line.trimStart().startsWith(`${said} packages/extension/cli/${script}.ts`))
        offenders.push(`${script}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], `help run otherwise:\n  ${offenders.join('\n  ')}`);
});

test("ci-examples names every refusal of a real clone before it writes, the emails' included", () => {
  assert.match(
    read(...CLI_DIR, 'sandforge-clone.ts'),
    /writes nothing past them/,
    'the clone no longer refuses past the emails the target has left — re-read this rule',
  );
  const refusals = read('ci-examples', 'README.md')
    .split('\n\n')
    .find((p) => p.startsWith('A dry run says what fires and goes on.'));
  assert.ok(refusals, 'the paragraph of the clone refusals moved — re-point this gate');
  assert.match(refusals, /10 000 records/);
  assert.match(refusals, /data storage/);
  assert.match(refusals, /more emails than it has left today/);
});

/**
 * `sf org display --verbose --json` prints the auth URL as "[REDACTED] Use 'sf
 * org auth show-sfdx-auth-url' to view": the secret the guide had users store
 * was that sentence. The repository's own canary logs in with a JWT.
 */
test('the CI guide gets an auth URL from the command that prints it, and documents the JWT login', () => {
  const guide = read('ci-examples', 'README.md');
  const setup = section(guide, '### 1. Configure credentials');
  assert.match(setup, /sf org auth show-sfdx-auth-url --target-org <alias> --json/);
  assert.match(setup, /result\.sfdxAuthUrl/);
  assert.doesNotMatch(setup, /obtained via `sf org display/);
  assert.match(setup, /sf org login jwt --client-id/);
  assert.match(setup, /https:\/\/test\.salesforce\.com/);
  assert.match(
    read('.github', 'workflows', 'canary.yml'),
    /sf org login jwt/,
    'the canary no longer logs in with a JWT — re-read the guide',
  );
});

// ── DataOps backs up what an anonymization overwrites ─────────────────────

test('both READMEs sell the DataOps snapshot as what it is', () => {
  assert.match(
    read(...WEBVIEW_SRC, 'pages', 'DataOps', 'BackupPanel.tsx'),
    /the objects it reads follow the templates/,
    'the Backup tab may pick its objects now — re-read the DataOps rows',
  );
  for (const relPath of READMES) {
    const text = read(...relPath.split('/'));
    const dataops = text.split('\n').find((line) => line.startsWith('| **DataOps**'));
    assert.ok(dataops, `${relPath}: the DataOps row is gone`);
    assert.doesNotMatch(dataops, /\|\s*Backup and restore/, `${relPath}: no backup of any object`);
    assert.match(dataops, /anonymization writes over/);
    const caption = text.split('\n').find((line) => line.includes('screenshots/dataops.png'));
    assert.doesNotMatch(caption, /backup history/i);
    assert.match(caption, /anonymization templates mask/);
  }
});

// ── the words people search for ───────────────────────────────────────────

/** The Marketplace keeps 30 tags; vsce sends every keyword as one. */
const MARKETPLACE_TAGS = 30;

test('the listing carries the words an empty dev org is searched by', () => {
  const keywords = readJson(...EXT, 'package.json').keywords ?? [];
  assert.ok(
    keywords.length <= MARKETPLACE_TAGS,
    `${keywords.length} keywords, the Marketplace keeps ${MARKETPLACE_TAGS}`,
  );
  for (const word of [
    'scratch org',
    'developer edition',
    'test data generator',
    'mock data',
    'fake data',
    'dummy data',
    'faker',
  ]) {
    assert.ok(keywords.includes(word), `the keywords miss "${word}"`);
  }
  const SCRATCH = {
    en: /scratch org/,
    fr: /scratch org/,
    de: /Scratch-Org/,
    es: /scratch org/,
    ja: /スクラッチ組織/,
    'pt-br': /scratch org/,
  };
  for (const [locale, text] of Object.entries(
    resolveNls(readJson(...EXT, 'package.json').description),
  )) {
    assert.ok(SCRATCH[locale], `${locale}: no rule written for this locale`);
    assert.match(text, SCRATCH[locale], `${locale}: the description names no scratch org`);
    assert.match(
      text,
      /Developer Edition/,
      `${locale}: the description names no Developer Edition`,
    );
  }
});

// ── a quickstart, not a specification ─────────────────────────────────────

/**
 * The Forge "60-second" quickstart ran to 434 lines, one bullet of 2,390
 * characters on currency conversion, another of 3,332 on the clone's JSON
 * summary. What a run reads, writes and keeps lives in the reference it links.
 */
const LONGEST_QUICKSTART_LINE = 800;

test('the Forge quickstart stays a quickstart, its reference in a page of its own', () => {
  const quickstart = read('docs', 'forge-quickstart.md');
  const long = quickstart
    .split('\n')
    .filter((line) => !line.startsWith('|') && line.length > LONGEST_QUICKSTART_LINE)
    .map((line) => `${line.length}: ${line.slice(0, 80)}`);
  assert.deepEqual(long, [], `prose a newcomer has to wade through:\n  ${long.join('\n  ')}`);
  assert.ok(quickstart.split('\n').length < 250, 'the quickstart has grown back into a reference');
  assert.ok(
    quickstart.includes('](forge-reference.md)'),
    'the quickstart does not link its reference',
  );
  assert.ok(quickstart.includes(`"${label('auth.sfdxImport')}"`), 'the import, as labelled');
});

// ── the labels the guides name ────────────────────────────────────────────

/** The guides a reader follows step by step, the archive of withdrawn pages left out. */
function guides() {
  const pages = ['README.md', 'ci-examples/README.md'];
  const walk = (dir) => {
    for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== 'archive') walk(rel);
      } else if (entry.name.endsWith('.md')) {
        pages.push(rel);
      }
    }
  };
  walk('docs');
  walk('packages/extension/walkthrough');
  return pages;
}

/**
 * Getting Started, the FAQ and the Forge quickstart told readers to click
 * "SFDX Import" in the "Org Manager": the button reads Import from SF CLI, on
 * a page called Organizations, and no screen shows either old name.
 */
test('the guides name the Salesforce CLI import and the Organizations page as the panel labels them', () => {
  const retired = /SFDX Import|Org Manager/;
  const pages = guides();
  assert.ok(pages.length > 20, 'the walk reads too few guides to prove anything');
  const offenders = [];
  for (const page of pages) {
    read(...page.split('/'))
      .split('\n')
      .forEach((line, i) => {
        if (retired.test(line)) offenders.push(`${page}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
  }
  assert.deepEqual(offenders, [], `labels no screen shows:\n  ${offenders.join('\n  ')}`);
  for (const page of ['docs/getting-started.md', 'docs/faq.md']) {
    assert.ok(
      read(...page.split('/')).includes(`**${label('auth.sfdxImport')}**`),
      `${page} does not name the import as the page labels it`,
    );
  }
  assert.ok(read('docs', 'getting-started.md').includes(`The ${label('org.title')} page`));
});

/**
 * Getting Started and the Seed guide still pointed at Minimal Demo as the
 * template marked Start here, after CRM Starter took its place at the head of
 * the gallery.
 */
test('every guide that says Start here names the template the gallery marks', () => {
  const template = firstTemplate();
  const mark = `_${label('seed.gallery.recommended')}_`;
  const others = Object.values(en().seed.templates)
    .map((entry) => entry?.name)
    .filter((name) => typeof name === 'string' && name !== template);
  assert.ok(others.length >= 4, 'the other template names are not read — re-point this gate');
  const offenders = [];
  let marks = 0;
  for (const page of guides()) {
    const text = read(...page.split('/'));
    for (let at = text.indexOf(mark); at !== -1; at = text.indexOf(mark, at + 1)) {
      marks += 1;
      const before = text.slice(Math.max(0, at - 60), at);
      if (!before.includes(`**${template}**`) || others.some((name) => before.includes(name))) {
        offenders.push(`${page}: …${before.replace(/\n/g, ' ')}${mark}`);
      }
    }
  }
  assert.ok(marks >= 4, `only ${marks} guides say ${mark}`);
  assert.deepEqual(offenders, [], `these mark another template:\n  ${offenders.join('\n  ')}`);
});
