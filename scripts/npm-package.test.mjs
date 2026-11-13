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
 * SANDFORGE_BIN_NODE=<node> runs the package under another Node than this one.
 *
 * Run: node --test scripts/npm-package.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CHECKS,
  NODE_FLOOR,
  build,
  nodeVersionOf,
  packageVersion,
  runBin,
  scratchFolder,
} from './npm-package.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const node = process.env.SANDFORGE_BIN_NODE ?? process.execPath;

let folder;
let built;

before(async () => {
  folder = scratchFolder();
  built = await build(join(folder, 'package'));
});

after(() => {
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
  const matrix = /^\s+bin-node: \[([^\]]+)\]$/m.exec(workflow)?.[1];
  assert.ok(matrix, 'the workflow has no bin-node matrix');
  const nodes = matrix.split(',').map((each) => each.trim().replace(/^['"]|['"]$/g, ''));
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
