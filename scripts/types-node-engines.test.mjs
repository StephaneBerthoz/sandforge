/**
 * Gate: the extension's `@types/node` major is the Node major of the oldest VS
 * Code it declares support for.
 *
 * The extension host is not the Node on a developer's machine: it is the Node
 * that Electron embeds in each VS Code release. `engines.vscode` promises the
 * extension runs on that oldest release, so typing against a newer Node lets
 * code call an API the promised host does not have, and `tsc` says nothing.
 * The repository's own Node (22, in `.nvmrc` and root `engines`) is the
 * toolchain's, not the host's. docs/ADR/0005 records the decision.
 *
 * Moving `engines.vscode` fails this gate until the Node major of the new
 * floor is looked up and written below — and `@types/node` is moved with it.
 *
 * Run: node --test scripts/types-node-engines.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(
  readFileSync(join(root, 'packages', 'extension', 'package.json'), 'utf8'),
);

/**
 * Node major of the extension host, per VS Code `major.minor` floor.
 *
 * Source: the Electron `target` in the `.npmrc` of the VS Code release tag,
 * then the Node version that Electron release ships (releases.electronjs.org).
 *
 * A Map keyed by text, not an object: an object key written `1.100:` is a
 * number literal stored as '1.1', and the formatter strips the quotes from a
 * numeric object key.
 */
const HOST_NODE = new Map([['1.95', { electron: '32.2.1', node: '20.18.0' }]]);

/** `major.minor` of the lowest version a caret or plain range admits, or null. */
const floorOf = (range) => {
  const m = /^\s*(?:\^|~|>=)?\s*(\d+)\.(\d+)(?:\.\d+)?\s*$/.exec(range ?? '');
  return m ? `${m[1]}.${m[2]}` : null;
};

/** Major of a caret, tilde or exact version range, or null. */
const majorOf = (range) => {
  const m = /^\s*(?:\^|~)?\s*(\d+)(?:\.\d+){0,2}\s*$/.exec(range ?? '');
  return m ? Number(m[1]) : null;
};

test('@types/node follows the Node of the oldest supported VS Code host', () => {
  const vscodeRange = manifest.engines?.vscode;
  const floor = floorOf(vscodeRange);
  assert.ok(floor, `engines.vscode "${vscodeRange}" is not a range this gate can read`);

  const host = HOST_NODE.get(floor);
  assert.ok(
    host,
    `engines.vscode now starts at ${floor}. Look up the Electron target in that VS Code ` +
      `release's .npmrc and the Node it embeds, add it to HOST_NODE, and move ` +
      `@types/node to that major in the same change.`,
  );

  const typesRange = manifest.devDependencies?.['@types/node'];
  const typesMajor = majorOf(typesRange);
  assert.ok(typesMajor !== null, `@types/node "${typesRange}" is not a range this gate can read`);
  assert.equal(
    typesMajor,
    Number(host.node.split('.')[0]),
    `@types/node is ${typesRange}, but VS Code ${floor} runs Electron ${host.electron} ` +
      `with Node ${host.node}: typing against another major hides APIs the host lacks ` +
      `or has.`,
  );
});

test('HOST_NODE floors are text, so a 1.100 floor is not stored as 1.1', () => {
  assert.ok(HOST_NODE.size > 0, 'HOST_NODE is empty');
  for (const floor of HOST_NODE.keys()) {
    assert.equal(
      typeof floor,
      'string',
      `HOST_NODE floor ${floor} is a number; write it as a quoted 'major.minor'`,
    );
    assert.match(floor, /^\d+\.\d+$/);
  }
});

test('the range readers refuse what they cannot read instead of guessing', () => {
  assert.equal(floorOf('^1.95.0'), '1.95');
  assert.equal(floorOf('>=1.101.0'), '1.101');
  assert.equal(floorOf('*'), null);
  assert.equal(floorOf('1.95.0 - 1.99.0'), null);
  assert.equal(majorOf('^20'), 20);
  assert.equal(majorOf('22.10.1'), 22);
  assert.equal(majorOf('>=20'), null);
  assert.equal(majorOf('latest'), null);
});
