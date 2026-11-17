/**
 * Gate: the `sandforge` npm package builds, holds what it should and nothing
 * else, and runs.
 *
 * The package is the scripts of `packages/extension/cli/` bundled, run by
 * people who have no checkout and often an older Node than the repository's.
 * Its tests are the checks `node scripts/npm-package.mjs check` runs before a
 * publish, on a package this file builds in a folder of its own: the
 * manifest, the files npm packs, no source map and no path of this machine,
 * no client name, each command's help by both its names, a refused flag on 2,
 * the MCP server's handshake and a tool call that starts a packaged script,
 * and the refusal of a Node older than the package's floor. A test that only
 * read the sources would pass on a package that cannot start.
 *
 * The same package is a plugin of the Salesforce CLI: where an sf is found,
 * the package is installed into a world of its own (its home, its sf folders
 * in a scratch folder, never the machine's) and run through it, as
 * `node scripts/npm-package.mjs check-sf` does; with no sf, those tests say
 * so and are skipped.
 *
 * SANDFORGE_BIN_NODE=<node> runs the package under another Node than this one.
 * SANDFORGE_SF=<sf> names the sf to check the plugin with (the PATH's by default).
 *
 * Run: node --test scripts/npm-package.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CHECKS,
  NODE_FLOOR,
  REDIRECT_CHECKS,
  REDIRECT_EXIT,
  SF_CHECKS,
  build,
  buildRedirects,
  nodeVersionOf,
  packageVersion,
  redirectMessage,
  runBin,
  scratchFolder,
  sfOnPath,
  sfWorld,
  toolNames,
} from './npm-package.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const node = process.env.SANDFORGE_BIN_NODE ?? process.execPath;

let folder;
let built;
let redirects;
/** The sf the plugin is checked with, or null: none on this machine. */
const sf = process.env.SANDFORGE_SF ?? sfOnPath();
let world;

before(async () => {
  folder = scratchFolder();
  built = await build(join(folder, 'package'));
  redirects = buildRedirects(join(folder, 'redirects'));
  if (sf !== null) world = sfWorld(built.out, node, sf);
});

after(() => {
  world?.dispose();
  rmSync(folder, { recursive: true, force: true });
});

test(`the package runs under the Node it is checked with (${nodeVersionOf(node)})`, () => {
  const [major, minor] = nodeVersionOf(node).split('.').map(Number);
  const [floorMajor, floorMinor] = NODE_FLOOR.split('.').map(Number);
  assert.ok(
    major > floorMajor || (major === floorMajor && minor >= floorMinor),
    `Node ${nodeVersionOf(node)} is older than the package's floor, ${NODE_FLOOR}`,
  );
});

for (const check of CHECKS) {
  test(check.name, async () => {
    await check.run({ out: built.out, node, requireNames: false });
  });
}

for (const check of SF_CHECKS) {
  test(`as an sf plugin: ${check.name}`, async (t) => {
    if (world === undefined) {
      t.skip('no sf: neither SANDFORGE_SF nor an sf on the PATH');
      return;
    }
    if (check.localOnly && process.env.CI === 'true') {
      t.skip('a CI runner has no sf of its own to keep');
      return;
    }
    await check.run({ out: built.out, node, world });
  });
}

for (const check of REDIRECT_CHECKS) {
  test(`the redirects: ${check.name}`, async () => {
    await check.run({ out: redirects.out, node, requireNames: false });
  });
}

test('each old name says the command that runs now, in the words a reader types, and runs nothing', () => {
  assert.deepEqual(
    redirects.packages.map((each) => each.tool),
    toolNames(),
  );
  assert.equal(REDIRECT_EXIT, 2);
  assert.equal(
    redirectMessage('checkpoint'),
    'sandforge-checkpoint is now `npx sandforge checkpoint`. Nothing was run.\n',
  );
  for (const { tool, folder: at } of redirects.packages) {
    const bin = readFileSync(join(at, 'bin.mjs'), 'utf8');
    // It hands the line on to nothing: no import, no child process, no require.
    assert.doesNotMatch(
      bin,
      /\b(?:import|require|spawn|exec)\b/,
      `sandforge-${tool} runs something`,
    );
    const readme = readFileSync(join(at, 'README.md'), 'utf8');
    assert.equal(
      readme.trim().split('\n').length,
      1,
      `sandforge-${tool}'s README is more than a line`,
    );
    // The addresses it links, each read whole, its sentence's full stop left out.
    const addresses = [...readme.matchAll(/https:\/\/[^\s)]+/g)].map(([address]) =>
      address.replace(/\.$/, ''),
    );
    assert.ok(
      readme.includes(`npx sandforge ${tool}`) &&
        addresses.some((address) => address === 'https://github.com/StephaneBerthoz/sandforge'),
      `sandforge-${tool}'s README names neither the package's command nor the repository`,
    );
  }
});

test('the redirects move with the version of the package, which bump-version.sh moves', () => {
  for (const { folder: at } of redirects.packages) {
    assert.equal(
      JSON.parse(readFileSync(join(at, 'package.json'), 'utf8')).version,
      packageVersion(),
    );
  }
  const other = join(folder, 'other-redirects');
  mkdirSync(join(other, 'notes'), { recursive: true });
  assert.throws(() => buildRedirects(other), /holds notes: no build of the redirects writes these/);
});

test('the third-party notices name every package the bundle holds', () => {
  // The license texts are fenced: a heading of their own (BlueOak's "## No
  // Liability") is not a package.
  const notices = readFileSync(join(built.out, 'THIRD-PARTY-NOTICES.md'), 'utf8').replace(
    /^````\n[\s\S]*?\n````$/gm,
    '',
  );
  const named = new Set([...notices.matchAll(/^## (\S+) \S+$/gm)].map((match) => match[1]));
  assert.deepEqual([...named].sort(), built.bundled);
  // jsforce and zod are the two the scripts cannot run without.
  assert.ok(named.has('jsforce') && named.has('zod'), 'the bundle no longer holds jsforce and zod');
});

test('the version of the package moves with the extension, and the build refuses a gap', () => {
  assert.equal(
    packageVersion(),
    JSON.parse(readFileSync(join(root, 'packages', 'extension', 'package.json'), 'utf8')).version,
  );
  const bump = readFileSync(join(root, 'scripts', 'bump-version.sh'), 'utf8');
  const manifests = bump.match(/^for PKG in (.+); do$/m)?.[1]?.split(/\s+/) ?? [];
  assert.ok(
    manifests.includes('packages/cli/package.json'),
    'bump-version.sh leaves the package behind',
  );

  const gap = join(folder, 'gap');
  mkdirSync(gap);
  writeFileSync(join(gap, 'cli.json'), JSON.stringify({ version: '1.0.0' }));
  writeFileSync(join(gap, 'extension.json'), JSON.stringify({ version: '1.0.1' }));
  assert.throws(
    () => packageVersion(join(gap, 'cli.json'), join(gap, 'extension.json')),
    /packages\/cli\/package\.json is at 1\.0\.0 and the extension at 1\.0\.1/,
  );
});

test('the build empties no folder that holds something other than a build of the package', async () => {
  const other = join(folder, 'other');
  mkdirSync(other);
  writeFileSync(join(other, 'notes.txt'), 'kept');
  await assert.rejects(
    () => build(other),
    /holds notes\.txt: no build of the sandforge package writes these/,
  );
  assert.equal(readFileSync(join(other, 'notes.txt'), 'utf8'), 'kept');
});

test('the publish workflow checks the package on its Node floor, and publishes with no token', () => {
  const workflow = readFileSync(join(root, '.github', 'workflows', 'npm-publish.yml'), 'utf8');
  const legs = [...workflow.matchAll(/^\s+- \{ bin-node: '([^']+)', sf: '([^']+)' \}/gm)].map(
    ([, binNode, sfVersion]) => ({ binNode, sfVersion }),
  );
  assert.ok(legs.length > 0, 'the workflow has no bin-node legs');
  const nodes = legs.map((leg) => leg.binNode);
  const [floorMajor, floorMinor] = NODE_FLOOR.split('.');
  assert.ok(
    nodes.includes(`${floorMajor}.${floorMinor}`),
    `the matrix does not run the package on its floor, ${floorMajor}.${floorMinor}: ${nodes.join(', ')}`,
  );
  assert.ok(nodes.includes('22'), 'the matrix does not run the package on Node 22');
  // Trusted publishing: an OIDC token of the run, no npm token anywhere.
  assert.match(workflow, /^ {6}id-token: write$/m);
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./);
  assert.match(workflow, /npm publish packages\/cli\/dist --provenance --access public/);
  assert.match(workflow, /node scripts\/npm-package\.mjs check packages\/cli\/dist/);
  // The old names, checked on each Node, published after sandforge, the same way.
  assert.match(workflow, /node scripts\/npm-package\.mjs check-redirects/);
  const publishes = workflow.indexOf('npm publish packages/cli/dist ');
  const redirected = workflow.indexOf('npm publish "$folder" --provenance --access public');
  assert.ok(
    publishes !== -1 && redirected > publishes,
    'the redirects are not published after sandforge',
  );
  // A redirect whose package npm does not hold yet has no trusted publisher to
  // publish it by: the job says how to publish it once by hand and goes on,
  // and any other failure of npm stops it.
  const loop = workflow.slice(workflow.indexOf('for folder in dist/npm-redirects/'));
  assert.match(loop, /E404/, 'the redirect loop does not tell a package npm does not hold yet');
  assert.match(
    loop,
    /::warning::/,
    'the redirect loop does not warn of a package to publish by hand',
  );
  assert.match(loop, /npm publish dist\/npm-redirects\/\$NAME --access public/);
  assert.match(loop, /exit 1/, 'the redirect loop goes on past a failure of npm that is not E404');
});

test('the publish workflow checks the package as an sf plugin on each leg, with a pinned sf, the oldest one on the Node floor', () => {
  const workflow = readFileSync(join(root, '.github', 'workflows', 'npm-publish.yml'), 'utf8');
  const legs = [...workflow.matchAll(/^\s+- \{ bin-node: '([^']+)', sf: '([^']+)' \}/gm)].map(
    ([, binNode, sfVersion]) => ({ binNode, sfVersion }),
  );
  for (const { binNode, sfVersion } of legs) {
    assert.match(sfVersion, /^\d+\.\d+\.\d+$/, `the leg on Node ${binNode} does not pin its sf`);
  }
  // sf 2.140.6, on oclif 4, runs on Node 18.6 and later, where sf 2.150.5 and
  // later ask for 22: the plugin is proven there on the package's floor.
  const [floorMajor, floorMinor] = NODE_FLOOR.split('.');
  assert.deepEqual(
    legs.find((leg) => leg.binNode === `${floorMajor}.${floorMinor}`)?.sfVersion,
    '2.140.6',
  );
  for (const binNode of ['22', '24']) {
    assert.ok(
      legs.some((leg) => leg.binNode === binNode),
      `no leg runs the plugin on Node ${binNode}`,
    );
  }
  const job = workflow.slice(workflow.indexOf('\n  bin:'), workflow.indexOf('\n  publish:'));
  const installs = job.indexOf('npm install --global @salesforce/cli@${{ matrix.sf }}');
  const checks = job.indexOf('node scripts/npm-package.mjs check-sf packages/cli/dist');
  assert.ok(installs !== -1, 'the bin legs do not install the pinned sf');
  assert.ok(checks > installs, 'the bin legs do not check the package as an sf plugin');
  assert.ok(
    job.indexOf('node-version: ${{ matrix.bin-node }}') < installs,
    'sf is installed under the repository’s Node, not the leg’s',
  );
});

test('a run dispatched by hand checks every leg and never publishes: publishing is a tag’s, behind the npm environment', () => {
  const workflow = readFileSync(join(root, '.github', 'workflows', 'npm-publish.yml'), 'utf8');
  assert.match(workflow, /^ {2}workflow_dispatch:\s*$/m, 'the workflow cannot be run by hand');
  assert.doesNotMatch(workflow, /inputs\./, 'a run dispatched by hand can still ask to publish');
  const publish = workflow.slice(workflow.indexOf('\n  publish:'));
  assert.match(
    publish,
    /^ {4}if: \$\{\{ github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\) \}\}$/m,
  );
  assert.match(publish, /^ {4}environment: npm$/m);
  assert.match(publish, /^ {4}needs: bin$/m);
  assert.match(workflow, /^ {2}push:\n {4}tags: \['v\*'\]$/m);
});

test('the guides give the package first and the checkout second, at the Node the package runs on', () => {
  const read = (...path) => readFileSync(join(root, ...path), 'utf8');
  const sectionOf = (text, heading) => {
    const start = text.indexOf(`\n${heading}\n`);
    assert.notEqual(start, -1, `no "${heading}" section`);
    const end = text.indexOf('\n## ', start + heading.length + 2);
    return text.slice(start, end === -1 ? undefined : end);
  };
  const floor = `Node.js ${NODE_FLOOR.split('.').slice(0, 2).join('.')} or later`;
  const npx = 'claude mcp add sandforge -- npx -y sandforge mcp';
  const checkout =
    'claude mcp add sandforge -- pnpm exec tsx packages/extension/cli/sandforge-mcp.ts';

  const add = sectionOf(read('docs', 'mcp.md'), '## Add it to Claude Code');
  assert.ok(add.includes(floor), `docs/mcp.md does not say the package needs ${floor}`);
  assert.ok(add.includes(npx) && add.includes(checkout), 'docs/mcp.md lost a way to add it');
  assert.ok(add.indexOf(npx) < add.indexOf(checkout), 'docs/mcp.md gives the checkout first');
  // The line the guide gives is the one the packaged server and command print.
  assert.ok(
    runBin(built.out, ['sandforge', 'mcp', '--help'], { node }).stdout.includes(`    ${npx}\n`),
  );
  assert.ok(runBin(built.out, ['sandforge', '--help'], { node }).stdout.includes(`  ${npx}\n`));

  const requirements = sectionOf(read('README.md'), '## Requirements');
  assert.ok(requirements.includes('npx sandforge --help') && requirements.includes(floor));
  assert.ok(requirements.indexOf(floor) < requirements.indexOf('pnpm build:shared'));
  const cli = read('ci-examples', 'README.md');
  assert.ok(cli.includes('`npx sandforge <name> ...`') && cli.includes(floor));
  const own = read('packages', 'cli', 'README.md');
  assert.ok(own.includes(floor) && own.includes(npx), 'the package README says otherwise');
});

test('the package README says how to install the sf plugin after npx, what it runs on, what sf records, and every command', async () => {
  const read = (...path) => readFileSync(join(root, ...path), 'utf8');
  const own = read('packages', 'cli', 'README.md');
  const heading = '## As an sf plugin';
  const at = own.indexOf(`\n${heading}\n`);
  assert.notEqual(at, -1, `the package README has no "${heading}" section`);
  const end = own.indexOf('\n## ', at + heading.length + 2);
  const plugin = own.slice(at, end === -1 ? undefined : end);
  const floor = `Node.js ${NODE_FLOOR.split('.').slice(0, 2).join('.')} or later`;
  for (const said of [
    'sf plugins trust allowlist add --name sandforge',
    'sf plugins install sandforge',
    'sf sandforge <command>',
    floor,
    'disable-telemetry',
    'sf plugins uninstall sandforge',
  ]) {
    assert.ok(plugin.includes(said), `the sf plugin section does not say "${said}"`);
  }
  // The menu of sfdx-hardis: each entry the plugin gives it.
  const { HARDIS_MENUS } = await import(pathToFileURL(join(built.out, 'lib', 'sfPlugin.mjs')).href);
  for (const { command } of HARDIS_MENUS.flatMap((menu) => menu.commands)) {
    assert.ok(plugin.includes(`\`${command}\``), `the sf plugin section does not name ${command}`);
  }
  // npx first: it needs nothing installed.
  assert.ok(own.indexOf('npx sandforge') < at, 'the package README gives the plugin before npx');
  const requirements = read('README.md');
  assert.ok(
    requirements.indexOf('npx sandforge --help') <
      requirements.indexOf('sf plugins install sandforge'),
    'the README gives the plugin before npx',
  );
  // The table of the commands names every one.
  for (const tool of toolNames()) {
    assert.match(own, new RegExp(`^\\| \`${tool}\` +\\|`, 'm'), `the table leaves out ${tool}`);
  }
});

test('the packaged clone says how to copy a sample of the whole org, each flag of it, and refuses one alone on 2', () => {
  const help = runBin(built.out, ['sandforge', 'clone', '--help'], { node });
  assert.equal(help.code, 0, help.stderr);
  for (const flag of [
    '--fit share',
    '--fit-within <MB>',
    '--fit-seed <n>',
    '--fit-draw uniform|recent|oldest',
    '--fit-window created|modified:<from>..<to> | created|modified:<n>d',
    '--fit-where <Object>=<WHERE>',
    '--fit-strata <Field>|<Object>.<Field>',
    '--fit-parents all|required',
    '--fit-children <n>|all',
    '--fit-whole <Object>',
    '--fit-floor <n>',
    '--fit-plan <folder>',
    'SAMPLE_PLAN_GONE',
    'SAMPLE_STORAGE_UNREAD',
  ]) {
    assert.ok(help.stdout.includes(flag), `sandforge clone --help does not say ${flag}`);
  }
  // A flag of a sample without --fit share is refused before any org is reached.
  const alone = runBin(
    built.out,
    ['sandforge', 'clone', '--depth', 'all', '--source', 'S', '--target', 'T', '--fit-seed', '3'],
    { node },
  );
  assert.equal(alone.code, 2, alone.stderr);
  assert.match(alone.stderr, /--fit-seed goes with --depth all --fit share/);
});
