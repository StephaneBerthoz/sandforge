/**
 * What the README, the CI guide and the FAQ say of environments as code,
 * beyond the guide they send a reader to, held to the code that does it: the
 * kinds of resource and the script each runs, a masking that no destroy
 * undoes, the MCP server's tools, and the editor's check of the file.
 *
 * `docs/environments.docs.test.ts` holds the guide, and the promises these
 * pages share with it: a production org refused, nothing written twice, the
 * state outside the repository. These pages each say in a line what the
 * feature covers, and a line is where a kind goes missing: in 1.68.0, which
 * ran the clone and Frozen's load too, the CI guide still said `sandforge-env`
 * ran the seed script. A kind left out reads as a kind the feature lacks; a
 * destroy said to take everything back, of a masking, promises values back
 * that are gone.
 *
 * Each list below is read from the code first, so a kind or a tool the code
 * gains fails here until the pages name it.
 *
 *   node --test docs/environment-claims.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');

const CLI = ['packages', 'extension', 'cli'];
const SCHEMA = read('packages', 'shared', 'src', 'schemas', 'env.schema.ts');
const KINDS_TABLE = read(...CLI, 'env', 'envKinds.ts');
const MASK_KIND = read(...CLI, 'env', 'kinds', 'mask.ts');
const ENV_SCRIPT = read(...CLI, 'sandforge-env.ts');
const ENV_FILE = read(...CLI, 'env', 'envFile.ts');
const MCP_SERVER = read(...CLI, 'sandforge-mcp.ts');
const SCHEMA_TOOL = read('packages', 'extension', 'tools', 'write-env-schema.ts');
const MANIFEST = JSON.parse(read('packages', 'extension', 'package.json'));

/** A `## ` or `### ` section of a page, its heading included, up to the next of its level. */
function section(markdown, heading) {
  const start = markdown.indexOf(`${heading}\n`);
  assert.ok(start !== -1, `no section ${heading}: re-point this gate`);
  const level = heading.split(' ')[0];
  const next = markdown.indexOf(`\n${level} `, start + heading.length);
  return markdown.slice(start, next === -1 ? undefined : next);
}

const README = section(read('README.md'), '## Test data as code, for the command line & CI');
const GUIDE = read('ci-examples', 'README.md');
/** The paragraph of the CI guide that says what each file of `cli/` is. */
const GUIDE_SCRIPTS = GUIDE.split('\n').find((line) =>
  line.startsWith('SandForge is a **VSCode extension**'),
);
const GUIDE_ROW = GUIDE.split('\n').find((line) =>
  line.startsWith('| `packages/extension/cli/sandforge-env.ts`'),
);
const GUIDE_ENV = section(GUIDE, '## An environment as code');
const FAQ = section(
  read('docs', 'faq.md'),
  '### Can I describe test data in a file my CI applies?',
);

/** The kinds of resource the file schema has, in its order. */
function kinds() {
  const list = /envResourceKindSchema = z\.enum\(\[([^\]]+)\]\)/.exec(SCHEMA);
  assert.ok(list, 'envResourceKindSchema is not where this expects it');
  return [...list[1].matchAll(/'([a-z]+)'/g)].map((match) => match[1]);
}

/** The script each kind runs, from the dispatch table and each kind's constant. */
function scriptsOfKinds() {
  const table = /const SCRIPTS[^{]*\{([^}]+)\}/.exec(KINDS_TABLE);
  assert.ok(table, 'the SCRIPTS table of envKinds.ts moved');
  const constants = {};
  for (const kind of ['seed', 'forge', 'frozen', 'mask']) {
    const source = read(...CLI, 'env', 'kinds', `${kind}.ts`);
    for (const [, name, script] of source.matchAll(/export const (\w+_SCRIPT) = '([\w-]+)'/g)) {
      constants[name] = script;
    }
  }
  return Object.fromEntries(
    [...table[1].matchAll(/(\w+): (\w+_SCRIPT)/g)].map(([, kind, name]) => [kind, constants[name]]),
  );
}

test('each page names every kind of resource the file has, and what applies it', () => {
  // Positive control: the four kinds, and the script each one runs.
  assert.deepEqual(kinds(), ['seed', 'forge', 'frozen', 'mask']);
  assert.deepEqual(scriptsOfKinds(), {
    seed: 'sandforge-seed',
    forge: 'sandforge-clone',
    frozen: 'sandforge-frozen',
    mask: 'sandforge-dataops',
  });

  /** Per kind, the words each page gives it. */
  const said = {
    seed: {
      readme: 'so many contacts under each',
      apply: 'Seed',
      guide: 'the seed',
      faq: "Seed's",
    },
    forge: {
      readme: 'records cloned from an org it names',
      apply: 'Forge',
      guide: 'the clone',
      faq: "Forge's",
    },
    frozen: {
      readme: 'a Frozen Dataset it loads',
      apply: 'Frozen Dataset',
      guide: "Frozen's load",
      faq: "Frozen Dataset's",
    },
    mask: {
      readme: 'the records a sandbox copied from production already holds, masked',
      apply: 'DataOps',
      guide: "DataOps' masking for a mask resource",
      faq: "DataOps'",
    },
  };
  assert.deepEqual(Object.keys(said), kinds(), 'a kind of the schema no page names');

  for (const [kind, words] of Object.entries(said)) {
    assert.ok(README.includes(words.readme), `README: the ${kind} kind is not named`);
    assert.ok(GUIDE_SCRIPTS.includes(words.guide), `CI guide: what a ${kind} resource runs`);
  }
  assert.ok(README.includes('`apply` writes it through Seed, Forge, Frozen Dataset and DataOps'));
  assert.ok(FAQ.includes("through Seed's, Forge's, Frozen Dataset's and DataOps' own runs"));
  assert.ok(GUIDE_ROW.includes('through the runs of the seed, the clone, Frozen and DataOps'));
  assert.ok(GUIDE_ENV.includes('-- the seed, the clone, a Frozen load, a DataOps masking --'));
  assert.ok(!GUIDE_SCRIPTS.includes('by running the seed script'), 'the CI guide runs Seed alone');
});

test('a page that says destroy takes an environment back says a masking is never undone', () => {
  // Positive control: the mask kind takes no run back, and its destroy
  // deletes its store, the snapshots with it.
  assert.ok(
    KINDS_TABLE.includes(
      'takes no run back: a masking is never undone, and its destroy deletes its store',
    ),
  );
  assert.ok(MASK_KIND.includes('export function maskStoreOf(resource: string): string'));

  assert.ok(
    README.includes(
      '`destroy` takes it back into the recycle bin, but never unmasks what it masked',
    ),
  );
  assert.ok(FAQ.includes('never unmasked by a destroy'));
  assert.ok(
    GUIDE_SCRIPTS.includes(
      "but a masking, which it never undoes: its destroy deletes the masking's snapshots",
    ),
  );
  assert.ok(GUIDE_ROW.includes('into the recycle bin, a masking excepted, never unmasked'));
  assert.ok(GUIDE_ENV.includes("that script's own removal, but a masking, which is never undone"));
});

test('the CI guide says the cache of the journal directory holds what a masking wrote over', () => {
  // Positive control: the store sits in the state's folder, which is the
  // folder the guide has the pipeline cache.
  assert.ok(
    MASK_KIND.includes(
      "/** A resource's DataOps store, from the state's folder: `dataops/<resource>`. */",
    ),
  );
  assert.ok(GUIDE_ENV.includes('Keep it between jobs in a cache keyed by the org'));

  assert.ok(
    GUIDE_ENV.includes(
      "A mask resource's snapshots are kept in that folder too, with the values its masking wrote over, unencrypted, until its destroy deletes them: a cache of the folder holds them as well.",
    ),
  );
});

test('the CI guide names the environment tools the MCP server registers, and the FAQ the server', () => {
  const tools = [...MCP_SERVER.matchAll(/name: '(env_\w+)'/g)].map((match) => match[1]);
  // Positive control: the three tools, no more.
  assert.deepEqual(tools, ['env_plan', 'env_apply', 'env_destroy']);

  const named = '`env_plan`, `env_apply` and `env_destroy`';
  assert.ok(GUIDE_SCRIPTS.includes(`the last three as ${named}`));
  assert.ok(
    GUIDE_ROW.includes(`the MCP server's ${named} run its \`plan\`, \`apply\` and \`destroy\``),
  );
  assert.ok(
    FAQ.includes(
      "plans, applies and destroys an environment through the tools of the [MCP server](mcp.md), each write confirmed by the org's alias",
    ),
  );
});

test("the FAQ's checkpoints are the ones reset and destroy --rewind return to", () => {
  // Positive control: the help says what each returns to.
  assert.ok(
    ENV_SCRIPT.includes('reset     rewind the org to the checkpoint taken after the last apply'),
  );
  assert.ok(
    ENV_SCRIPT.includes(
      '--rewind                   rewind the org to the checkpoint taken before the first apply',
    ),
  );

  assert.ok(
    FAQ.includes(
      'let `reset` return the org to how its last apply left it, between two test suites, and `destroy --rewind` to how it was before the first apply',
    ),
  );
});

test("the README's editor paragraph names the files the manifest has checked, and what reads the schema", () => {
  // Positive control: the manifest's one YAML schema, generated from the zod
  // schema validate parses the file with; and the help's word for what
  // validate checks beyond it.
  const [entry] = MANIFEST.contributes.yamlValidation;
  const names = entry.fileMatch.map((pattern) => pattern.replace(/^\*\*\//, ''));
  assert.deepEqual(names, ['sandforge.yaml', 'sandforge.yml']);
  assert.ok(SCHEMA_TOOL.includes('z.toJSONSchema(envFileSchema, {'));
  assert.ok(ENV_FILE.includes('envFileSchema.safeParse(document)'));
  assert.ok(ENV_SCRIPT.includes("each resource against its module's own rules,"));
  assert.ok(
    ENV_SCRIPT.includes('the order of the resources, the variables it names; reaches no org'),
  );

  const editor = README.split('\n\n').find((paragraph) =>
    paragraph.startsWith('**In the editor**'),
  );
  assert.ok(editor, 'the README has no editor paragraph in its environments section');
  for (const name of names) assert.ok(editor.includes(`\`${name}\``), `the README misses ${name}`);
  assert.ok(
    editor.includes('](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml)'),
  );
  assert.ok(editor.includes('generated from the one `sandforge-env validate` reads the file with'));
  assert.ok(
    editor.includes(
      'The YAML extension is what reads that schema; without it, the editor checks nothing.',
    ),
  );
  assert.ok(
    editor.includes(
      "`validate` checks the rest, offline -- each resource against its module's own rules, the order of the resources, the variables the file names",
    ),
  );
  assert.ok(
    FAQ.includes("with Red Hat's YAML extension installed, VS Code checks the file as you type it"),
  );
});
