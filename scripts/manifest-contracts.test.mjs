/**
 * The manifest and the code agree, and something checks that they do.
 *
 * `contributes` is a set of names the editor resolves at runtime and the
 * compiler never sees: a view id, a container id, a walkthrough's media path, a
 * `%key%` placeholder, a module id the panel router keys on. Rename one side
 * and nothing fails — not the types, not the tests, not the linter. The editor
 * simply shows an empty view, a blank walkthrough step, the literal
 * `%config.ai.enabled.description%` in the Settings editor, or
 * "Unknown module: monitor" in a full-width panel.
 *
 * That is the shape of the defect that shipped in 1.23.0, where the extension
 * linked two stylesheet names the build had stopped producing. The build side
 * is covered now (`check-webview-assets.mjs`); this is the same question asked
 * of the manifest.
 *
 * Every pair below matches today. That is the point: they are cheap to keep
 * matching and expensive to notice once they stop.
 *
 * Not here, because it is covered elsewhere:
 *   - the settings tables in both READMEs, against the declared settings —
 *     `docs/readme-settings.test.mjs`, in both directions including defaults;
 *   - contributed commands actually registering in a real editor —
 *     `packages/extension/src/test/smoke/extension.smoke.test.ts`;
 *   - keybindings referencing declared commands — `pre-publish-check.sh`.
 *
 * Run: node --test scripts/manifest-contracts.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = join('packages', 'extension');

const read = (...parts) => readFileSync(join(repoRoot, ...parts), 'utf8');
const readJson = (...parts) => JSON.parse(read(...parts));

const manifest = readJson(EXTENSION, 'package.json');
const contributes = manifest.contributes ?? {};

test('every %key% in the manifest resolves, and the bundle has no key nothing uses', () => {
  // The first direction shows `%config.ai.enabled.description%` verbatim in the
  // Settings editor. The second is how a bundle grows entries for settings that
  // were removed, which the five translated bundles then have to carry too.
  const nls = readJson(EXTENSION, 'package.nls.json');
  const placeholders = new Set(
    [...JSON.stringify(manifest).matchAll(/%([^%"]+)%/g)].map((match) => match[1]),
  );
  assert.ok(placeholders.size > 40, `only ${placeholders.size} placeholders found`);

  assert.deepEqual(
    [...placeholders].filter((key) => !(key in nls)).sort(),
    [],
    'the manifest names a string package.nls.json does not define',
  );
  assert.deepEqual(
    Object.keys(nls)
      .filter((key) => !placeholders.has(key))
      .sort(),
    [],
    'package.nls.json defines a string the manifest never names',
  );
});

test('every walkthrough step points at a file that exists', () => {
  // `.vscodeignore` already blanket-ignores `docs/`, `test/` and more; a step
  // whose markdown stops shipping renders as an empty page in Get Started.
  const steps = (contributes.walkthroughs ?? []).flatMap((walkthrough) => walkthrough.steps ?? []);
  assert.ok(steps.length > 0, 'no walkthrough steps found — has the manifest moved?');

  const missing = [];
  for (const step of steps) {
    for (const [kind, path] of Object.entries(step.media ?? {})) {
      if (kind === 'altText') continue;
      if (!existsSync(join(repoRoot, EXTENSION, path))) missing.push(`${step.id}: ${path}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('every walkthrough completion event names a contributed command', () => {
  const commands = new Set((contributes.commands ?? []).map((entry) => entry.command));
  const steps = (contributes.walkthroughs ?? []).flatMap((walkthrough) => walkthrough.steps ?? []);

  const dangling = [];
  for (const step of steps) {
    for (const event of step.completionEvents ?? []) {
      const command = /^onCommand:(.+)$/.exec(event)?.[1];
      // A step whose command is gone never ticks, and Get Started shows it as
      // outstanding for ever.
      if (command && !commands.has(command)) dangling.push(`${step.id}: ${event}`);
    }
  }
  assert.deepEqual(dangling, []);
});

test('the view, its container and the provider are one name', () => {
  // Rename the container and the two keybindings below stop firing, silently:
  // their `when` clause names it as a workbench viewlet id. Rename the view and
  // the activity bar shows a container with a permanently empty panel.
  const containers = (contributes.viewsContainers?.activitybar ?? []).map((entry) => entry.id);
  assert.deepEqual(containers, ['sandforge']);

  const [container] = containers;
  assert.deepEqual(Object.keys(contributes.views ?? {}), [container]);

  const viewIds = contributes.views[container].map((entry) => entry.id);
  assert.equal(viewIds.length, 1);
  const [viewId] = viewIds;

  // The provider registers under this exact string.
  const provider = read(EXTENSION, 'src', 'providers', 'SidebarViewProvider.ts');
  const declared = /viewType\s*=\s*'([^']+)'/.exec(provider)?.[1];
  assert.equal(declared, viewId, 'SidebarViewProvider.viewType is not the contributed view id');

  const whenClauses = (contributes.keybindings ?? []).map((entry) => entry.when).filter(Boolean);
  assert.ok(whenClauses.length > 0, 'no keybinding `when` clauses found');
  for (const clause of whenClauses) {
    if (!clause.includes('workbench.view.extension.')) continue;
    assert.ok(
      clause.includes(`workbench.view.extension.${container}`),
      `a keybinding waits on a viewlet that is not ${container}: ${clause}`,
    );
  }
});

test('every module the extension can open is a route the webview can mount', () => {
  /*
   * `MODULE_COMMANDS` is the extension's list; the panel router's
   * `panelComponents` is the webview's. The id travels between them as
   * `window.__SANDFORGE_MODULE__`, injected into the HTML shell — a string, in
   * two packages that do not depend on each other. A command whose module the
   * router does not know opens a full-width panel reading "Unknown module".
   */
  const source = read(EXTENSION, 'src', 'composition', 'moduleCommands.ts');
  const opened = [...source.matchAll(/moduleId:\s*'([^']+)'/g)].map((match) => match[1]).sort();
  assert.ok(opened.length > 10, `only ${opened.length} module ids found in moduleCommands.ts`);

  const router = read('packages', 'webview', 'src', 'PanelRouter.tsx');
  const table = /const panelComponents[^{]*\{([\s\S]*?)\n\};/.exec(router);
  assert.ok(table, 'panelComponents is not where this expects it');
  const mountable = new Set([...table[1].matchAll(/^\s{2}(\w+):/gm)].map((match) => match[1]));

  assert.deepEqual(
    opened.filter((id) => !mountable.has(id)),
    [],
    'a command opens a module the panel router cannot mount',
  );
});

test('every setting the code reads is a setting the manifest declares', () => {
  /*
   * The other direction — a declared setting nothing reads — is deliberately
   * not asserted: several are read by the webview through the settings blob
   * rather than by name, and `docs/readme-settings.test.mjs` already holds the
   * declared set to what both READMEs promise. This direction is the one that
   * fails silently: `getConfiguration('sandforge').get('x')` for an undeclared
   * `x` returns undefined, so the feature quietly takes its fallback for ever.
   */
  const declared = new Set(Object.keys(contributes.configuration?.properties ?? {}));
  assert.ok(declared.size > 10, `only ${declared.size} settings declared`);

  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) files.push(path);
    }
  };
  walk(join(repoRoot, EXTENSION, 'src'));

  const read1 = /getSandforgeSetting\(\s*'([a-zA-Z][\w.]*)'/g;
  const read2 = /getConfiguration\('sandforge'\)[\s\S]{0,40}?\.get<[^>]*>\(\s*'([a-zA-Z][\w.]*)'/g;

  const unknown = new Set();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const pattern of [read1, read2]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(source)) !== null) {
        const key = `sandforge.${match[1]}`;
        if (!declared.has(key)) unknown.add(`${key} (${file.slice(repoRoot.length + 1)})`);
      }
    }
  }
  assert.deepEqual([...unknown].sort(), []);
});

test('the VSIX leaves out whatever a tsc emit of src/ would put in dist/', () => {
  // tsconfig.json emits into dist/, beside the esbuild bundle the VSIX runs.
  // The list named the four folders src/ had when it was written, and missed
  // adapters/, composition/ and services.js once they came.
  const ignored = new Set(
    read(EXTENSION, '.vscodeignore')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('dist/')),
  );
  const emitted = readdirSync(join(repoRoot, EXTENSION, 'src'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || /^(?!.*\.test\.ts$).*\.ts$/.test(entry.name))
    .filter((entry) => entry.name !== 'extension.ts')
    .map((entry) =>
      entry.isDirectory() ? `dist/${entry.name}/**` : `dist/${entry.name.replace(/\.ts$/, '.js')}`,
    );
  assert.ok(emitted.length > 4, 'src/ listing came back nearly empty — has it moved?');
  assert.deepEqual(
    emitted.filter((path) => !ignored.has(path)),
    [],
    'a tsc emit of src/ would ship: add it to packages/extension/.vscodeignore',
  );
});
