/**
 * What the pages say of the `sandforge` npm package as an sf plugin, held to
 * the code that makes it one.
 *
 * The package README, the root README, the CI guide, the MCP guide, the FAQ,
 * SECURITY.md and ADR 0006 each tell a reader to type something into sf, or
 * promise what happens when they do: which name to allowlist, which commands
 * sfdx-hardis's menu runs from a click, which org a command takes, what sf
 * records. A line like that is followed without being read twice. A menu entry
 * the pages call read only that reached an org would run from a click; a page
 * that said sf's default org was taken would have a reader leave out `--org`
 * on a command that writes. The package README's table of commands had already
 * fallen behind once: 1.81.0 shipped `sandforge pipeline` and the table did not
 * name it.
 *
 * Each claim below is read from the code first, so a command, a menu entry or
 * a platform the code gains or loses fails here until the pages say it.
 *
 *   node --test docs/sf-plugin-claims.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  NODE_FLOOR,
  REWRITES,
  manifest,
  packageVersion,
  toolNames,
} from '../scripts/npm-package.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');

const CLI = ['packages', 'extension', 'cli'];
const WORKFLOW = ['.github', 'workflows', 'npm-publish.yml'];

/** A `## ` or `### ` section of a page, its heading included, up to the next of its level or above. */
function section(markdown, heading) {
  const start = markdown.indexOf(`\n${heading}\n`);
  assert.ok(start !== -1, `no section ${heading}: re-point this gate`);
  const depth = heading.split(' ')[0].length;
  const body = start + heading.length + 2;
  const next = markdown.slice(body).search(new RegExp(`^#{1,${depth}} `, 'm'));
  return markdown.slice(start, next === -1 ? undefined : body + next);
}

const PUBLISHED = manifest(packageVersion());
const NAME = PUBLISHED.name;
const FLOOR = `Node.js ${NODE_FLOOR.split('.').slice(0, 2).join('.')} or later`;

const ALLOWLIST = `sf plugins trust allowlist add --name ${NAME}`;
const INSTALL = `sf plugins install ${NAME}`;

const PACKAGE_README = read('packages', 'cli', 'README.md');
const ADR_FILE = 'docs/ADR/0006-sf-plugin-without-oclif.md';

/**
 * The part of each page that speaks of the plugin, read when a test asks for
 * it: a page that lacks it fails the tests that read it, and those alone.
 */
const pages = {
  packageSf: () => section(PACKAGE_README, '## As an sf plugin'),
  requirements: () => section(read('README.md'), '## Requirements'),
  guide: () => section(read('ci-examples', 'README.md'), "## What exists (and what doesn't)"),
  mcpAdd: () => section(read('docs', 'mcp.md'), '## Add it to Claude Code'),
  faq: () => section(read('docs', 'faq.md'), '### Is SandForge an sf plugin?'),
  security: () => section(read('SECURITY.md'), '## The sf plugin'),
  adr: () => read(...ADR_FILE.split('/')),
};

/** Every page that tells a reader to install the plugin, by the name a failure message gives it. */
const installing = () => ({
  'packages/cli/README.md': pages.packageSf(),
  'README.md, Requirements': pages.requirements(),
  'ci-examples/README.md': pages.guide(),
  'docs/faq.md': pages.faq(),
  'SECURITY.md': pages.security(),
});

/** A source with its comments taken out: what a comment explains is not what the code does. */
const code = (source) => source.replace(/\/\*[^]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The summary of each command, as `sandforge --help` gives it. */
function toolSummaries() {
  const source = read(...CLI, 'sandforge.ts');
  const block = /export const TOOLS = \{\n([\s\S]*?)\n\} as const;/.exec(source);
  assert.ok(block, 'the TOOLS table of cli/sandforge.ts moved: re-point this gate');
  const entries = [...block[1].matchAll(/^ {2}([a-z]+): (['"])(.*)\2,$/gm)].map((m) => [
    m[1],
    m[3].replace(/\\'/g, "'"),
  ]);
  assert.equal(entries.length, block[1].split('\n').length, 'a TOOLS entry this gate cannot read');
  return Object.fromEntries(entries);
}

/** The rows of the package README's table of commands, as `{command: what it does}`. */
function commandRows() {
  const table = section(PACKAGE_README, '## Commands')
    .split('\n')
    .filter((line) => line.startsWith('| `'));
  return Object.fromEntries(
    table.map((line) => {
      const [command, what] = line
        .split('|')
        .slice(1, 3)
        .map((cell) => cell.trim());
      return [command.replace(/`/g, ''), what];
    }),
  );
}

/** The source of a file of `cli/` that makes the package an sf plugin, or a failure that says it is missing. */
function pluginSource(file) {
  const path = join(repoRoot, ...CLI, file);
  assert.ok(
    existsSync(path),
    `packages/extension/cli/${file} is not in this tree: the pages document an sf plugin ` +
      'this tree does not build',
  );
  return readFileSync(path, 'utf8');
}

test('the package README names every command the package runs, each as its --help summarises it', () => {
  const summaries = toolSummaries();
  assert.deepEqual(Object.keys(summaries).sort(), toolNames(), 'TOOLS and the scripts of cli/');
  assert.ok(toolNames().includes('pipeline'), 'positive control: 1.81.0 has sandforge pipeline');
  assert.deepEqual(commandRows(), summaries);
});

test('every page gives npx first, and the sf plugin after it', () => {
  const pairs = [
    ['packages/cli/README.md', PACKAGE_README, 'npx sandforge --help', '## As an sf plugin'],
    ['README.md, Requirements', pages.requirements(), 'npx sandforge --help', INSTALL],
    ['ci-examples/README.md', pages.guide(), '`npx sandforge <name> ...`', INSTALL],
    [
      'docs/mcp.md',
      pages.mcpAdd(),
      'claude mcp add sandforge -- npx -y sandforge mcp',
      'claude mcp add sandforge -- sf sandforge mcp',
    ],
  ];
  for (const [page, text, npx, sf] of pairs) {
    assert.ok(text.includes(npx), `${page} no longer says ${npx}`);
    assert.ok(text.includes(sf), `${page} does not say ${sf}`);
    assert.ok(text.indexOf(npx) < text.indexOf(sf), `${page} gives the sf plugin before npx`);
  }
});

test('every page that installs the plugin allowlists the published name first, at the same Node', () => {
  assert.equal(NAME, 'sandforge', 'positive control: the name the package is published under');
  const install = installing();
  for (const [page, text] of Object.entries(install)) {
    assert.ok(text.includes(ALLOWLIST), `${page} does not say ${ALLOWLIST}`);
    assert.ok(text.includes(INSTALL), `${page} does not say ${INSTALL}`);
    assert.ok(
      text.indexOf(ALLOWLIST) < text.indexOf(INSTALL),
      `${page} installs before it allowlists`,
    );
  }
  for (const [page, text] of Object.entries({ ...install, 'docs/mcp.md': pages.mcpAdd() })) {
    if (page === 'SECURITY.md') continue;
    assert.ok(text.includes(FLOOR), `${page} does not say the plugin needs ${FLOOR}`);
  }
  // The line the CI guide gives a job: one line, chained, a version pinned.
  assert.ok(pages.guide().includes(`\`${ALLOWLIST} && ${INSTALL}@<version>\``));
});

test('the pages quote the question sf asks before installing it, and say how to check the package instead', () => {
  const question =
    "isn't signed by Salesforce. Only install the plugin if you trust its creator. " +
    'Do you want to continue the installation?';
  assert.ok(pages.packageSf().includes(question), 'the package README does not quote it');
  for (const [page, text] of Object.entries({
    'packages/cli/README.md': pages.packageSf(),
    'SECURITY.md': pages.security(),
  })) {
    assert.ok(text.includes('npm view sandforge dist.attestations'), `${page}: the attestation`);
    assert.ok(text.includes('npm audit signatures'), `${page}: npm audit signatures`);
  }
  // Published by the workflow, with provenance, by OIDC: from 1.80.0, its first run.
  const workflow = read(...WORKFLOW);
  assert.match(workflow, /npm publish packages\/cli\/dist --provenance --access public/);
  assert.match(workflow, /id-token: write/);
  assert.match(pages.security(), /From 1\.80\.0/);
  assert.match(pages.security(), /npm-publish\.yml/);
});

test('the lines the commands print keep npx, as the pages say', () => {
  const rewrite = REWRITES.find((entry) => entry.file === 'invocation.ts');
  assert.ok(rewrite, 'the package no longer rewrites the line invocation.ts prints');
  assert.equal(rewrite.replace, '`npx sandforge ${tool}`');
  assert.match(pages.packageSf(), /The lines the commands print keep `npx sandforge/);
  assert.match(pages.guide(), /so do the lines the scripts print/);
  // The pipelines the guide hands out run npx, which needs nothing installed.
  const pipelines = readdirSync(join(repoRoot, 'ci-examples')).filter(
    (file) => !file.endsWith('.md') && !/\.test\./.test(file),
  );
  assert.ok(pipelines.length >= 4, 'positive control: the four pipelines are read');
  for (const file of pipelines) {
    assert.doesNotMatch(
      read('ci-examples', file),
      /sf sandforge|sf plugins install/,
      `ci-examples/${file}`,
    );
  }
});

test('sf records the command and the value of no flag, and SandForge adds no telemetry of its own', () => {
  for (const words of ['disable-telemetry=true', 'SF_DISABLE_TELEMETRY=true']) {
    assert.ok(pages.packageSf().includes(words), `the package README does not say ${words}`);
  }
  assert.match(pages.packageSf(), /SandForge adds no telemetry of its own/);
  const scripts = readdirSync(join(repoRoot, ...CLI), { recursive: true })
    .map(String)
    .filter((file) => file.endsWith('.ts') && !/\.test\.ts$/.test(file));
  assert.ok(scripts.length > 30, 'positive control: the scripts of cli/ are read');
  for (const file of scripts) {
    assert.doesNotMatch(code(read(...CLI, file)), /telemetry/i, `cli/${file} records telemetry`);
  }
  // sf records only the flags a command declares, and the plugin declares none.
  const build = read('scripts', 'npm-package.mjs');
  assert.match(build, /flags\s*[:=]\s*\{\s*\}/, 'the commands sf runs declare no flags');
  assert.doesNotMatch(build, /flags\s*[:=]\s*\{\s*[\w'"-]+\s*:/, 'a command declares a flag');
});

test('the four menu entries the pages give sfdx-hardis are the ones the plugin lists, and reach no org', () => {
  const entries = [
    'sf sandforge --help',
    'sf sandforge seed --list-templates',
    'sf sandforge env validate',
    'sf sandforge env state',
  ];
  const hardis = section(PACKAGE_README, "### In sfdx-hardis's menus");
  const listed = hardis
    .split('\n')
    .filter((line) => line.startsWith('- `sf sandforge'))
    .map((line) => /^- `([^`]+)`/.exec(line)[1]);
  assert.deepEqual(listed, entries, 'the package README lists other entries');

  // Each reaches no org, as the scripts' own help says.
  const env = read(...CLI, 'sandforge-env.ts');
  assert.match(env, /\n {2}validate {2}check the file, offline:[^]*?reaches no org\n/);
  assert.match(
    env,
    /\n {2}state {5}list the environments kept on this machine[^]*?reaches no org\n/,
  );
  assert.match(
    read(...CLI, 'sandforge-seed.ts'),
    /--list-templates {7}name the built-in templates, then stop/,
  );

  // The key sfdx-hardis reads a project's plugins from, and the name it installs.
  assert.match(hardis, /```yaml\ncustomPlugins:\n {2}- name: sandforge\n/);
  assert.doesNotMatch(hardis, /^plugins:/m);

  // The plugin's own list: each entry there, and only those.
  const plugin = code(pluginSource('sfPlugin.ts'));
  const start = plugin.search(/\bHARDIS_MENUS\b[^=\n]*=/);
  assert.notEqual(start, -1, 'sfPlugin.ts declares no HARDIS_MENUS');
  const end = plugin.slice(start).search(/\n\](?: as const)?\)?;/);
  const menus = plugin.slice(start, end === -1 ? undefined : start + end);
  const commands = [...menus.matchAll(/['"`](sf sandforge(?: [^'"`]*)?)['"`]/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(commands)].sort(), [...entries].sort(), 'HARDIS_MENUS');
  assert.match(plugin, /hardis-commands|hardisCommands/);
});

test("no command under sf takes sf's default org, and the plugin runs in sf's process without oclif's package", () => {
  for (const [page, text] of Object.entries({
    'packages/cli/README.md': pages.packageSf(),
    'ci-examples/README.md': pages.guide(),
    'docs/faq.md': pages.faq(),
    'ADR 0006': pages.adr(),
  })) {
    assert.match(text, /default org/, `${page} does not say which org a command takes`);
  }
  assert.match(pages.packageSf(), /`--target-org` is refused with exit code `2`/);

  const plugin = code(pluginSource('sfPlugin.ts'));
  const hook = code(pluginSource('sfHelpHook.ts'));
  for (const [file, source] of Object.entries({ 'sfPlugin.ts': plugin, 'sfHelpHook.ts': hook })) {
    assert.doesNotMatch(source, /target-org|targetOrg|SF_TARGET_ORG|sfDefaultOrg/, file);
    assert.doesNotMatch(source, /@oclif\//, `${file} imports oclif`);
  }
  // The commands run in sf's process; only the help hook starts one.
  assert.doesNotMatch(plugin, /child_process/, 'sfPlugin.ts starts a process');

  // The manifest sf reads: a plugin with an init hook, and still no dependency.
  assert.ok(PUBLISHED.oclif, 'the published manifest has no oclif section: no sf plugin');
  assert.match(String(PUBLISHED.oclif.hooks?.init), /sfHelpHook/);
  assert.equal(PUBLISHED.oclif.topicSeparator, ' ');
  for (const key of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.equal(PUBLISHED[key], undefined, `the published manifest has ${key}`);
  }
  assert.match(pages.security(), /`init` hook/);
  assert.match(pages.adr(), /`init` hook/);
});

test('what no gate runs yet is said to be not yet proven', () => {
  // The sf gate of the publishing workflow runs on the runners it names.
  const runners = [...read(...WORKFLOW).matchAll(/runs-on: (\S+)/g)].map((m) => m[1]);
  assert.ok(runners.length > 0, 'positive control: the workflow names its runners');
  const proven = section(PACKAGE_README, '### Where it is proven');
  if (!runners.some((runner) => /windows/.test(runner))) {
    assert.match(proven, /Windows[^.]*not yet proven/, 'Windows is said to be proven');
  }
  if (!runners.some((runner) => /macos/.test(runner))) {
    assert.match(proven, /macOS[^.]*not yet proven/, 'macOS is said to be proven');
  }
  assert.match(proven, /2\.151[^.]*not yet proven/, 'an sf on oclif 4 is said to be proven');
  assert.match(pages.faq(), /not yet proven/);
  assert.match(pages.adr(), /not yet proven/);
});
