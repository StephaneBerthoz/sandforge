/**
 * Write the JSON Schema of `sandforge.yaml` the extension ships, which the
 * editor checks the file with as it is typed.
 *
 * VS Code reads no YAML schema itself. Red Hat's YAML extension does: it
 * reads the `yamlValidation` contribution of every installed extension's
 * manifest, resolves a `url` that starts with `./` against that extension's
 * folder, and checks each file a `fileMatch` pattern matches against the
 * schema there. SandForge's manifest names the file this script writes.
 *
 * The schema is generated, never written by hand: `z.toJSONSchema` of
 * `envFileSchema`, the zod schema `sandforge-env validate` reads the file
 * with, as a file is written (`io: 'input'`, so a key the schema fills in is
 * not asked of it). It holds the shape -- every key, its type and its values,
 * and the keys a strict object refuses -- and none of what the zod schema
 * checks in code beyond it: `validate` checks the file whole.
 *
 * Draft 7 rather than zod's default, 2020-12: the YAML language server checks
 * a 2020-12 schema only since its 1.20.0, and before its 1.19.1 checked every
 * schema as draft 7, whatever it declared. For this schema both dialects say
 * the same, which the sibling test holds.
 *
 * Each key says what it holds as it is hovered or offered: the texts of
 * `env-schema-descriptions.ts`, laid on their nodes by path as both
 * `markdownDescription` and `description`. The YAML extension shows the
 * first; for a key that may take two shapes it shows the second as written,
 * so the two are the same Markdown. A node with no text, a text that names no
 * node, a key whose text leaves one of its listed values out, and a bound a
 * text names that its node does not have each stop the script: the file is
 * never written with a hover missing, or one that says what is not.
 *
 * The output is formatted by Prettier with the repository's config, so the
 * file it writes passes `format:check` as written.
 *
 *   pnpm exec tsx packages/extension/tools/write-env-schema.ts           # write the file
 *   pnpm exec tsx packages/extension/tools/write-env-schema.ts --check   # exit 1 if it is stale
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as z from 'zod';

import { envFileSchema } from '@sandforge/shared';

import {
  ENV_SCHEMA_DESCRIPTIONS,
  ENV_SCHEMA_RECORD_KEYS,
  figure,
} from './env-schema-descriptions.js';

/** The schema file, relative to the extension's folder: the manifest's `url` names it. */
export const ENV_SCHEMA_PATH = 'resources/schemas/sandforge.schema.json';

/** The schema file on disk. */
export const ENV_SCHEMA_FILE = join(__dirname, '..', ...ENV_SCHEMA_PATH.split('/'));

/** The command that writes the file again, as a stale check names it. */
export const WRITE_COMMAND = 'pnpm exec tsx packages/extension/tools/write-env-schema.ts';

/** A node of a JSON Schema, as `z.toJSONSchema` writes one. */
type SchemaNode = Record<string, unknown>;

function isNode(value: unknown): value is SchemaNode {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A node a hover can land on, by its path, written as `env-schema-descriptions.ts` says. */
export interface HoveredNode {
  path: string;
  node: SchemaNode;
  /** Whether the node takes a text of its own. */
  own: boolean;
  /**
   * The path of the text the node shows: its own; its list's, for an item;
   * the key's that holds it, for a shape named by its type.
   */
  shows: string | undefined;
  /** Whether that text is laid on the node: on every one but a shape named by its type. */
  laid: boolean;
}

/**
 * How a shape of a `oneOf` or an `anyOf` is named in a path: by the constant
 * one of its keys holds (`kind: seed`), or else by its type.
 */
function shapeOf(branch: SchemaNode): { name: string; byConstant: boolean } {
  const properties = isNode(branch['properties']) ? branch['properties'] : {};
  for (const child of Object.values(properties)) {
    if (isNode(child) && 'const' in child)
      return { name: String(child['const']), byConstant: true };
  }
  const type = branch['type'];
  return { name: Array.isArray(type) ? type.join('|') : String(type), byConstant: false };
}

/**
 * Every node of `schema` a hover can land on, with its path: each key, each
 * key of a mapping whose keys the file chooses, each item of a list and each
 * shape of a key that may take several.
 *
 * @param recordKeys - The word a path names the keys of each such mapping by.
 * @throws Error naming a mapping that has no word, or two shapes of one name.
 */
export function hoveredNodes(
  schema: SchemaNode,
  recordKeys: Readonly<Record<string, string>> = ENV_SCHEMA_RECORD_KEYS,
): HoveredNode[] {
  const found: HoveredNode[] = [];
  const walk = (node: SchemaNode, path: string, shows: string | undefined): void => {
    const under = (key: string): string => (path === '' ? key : `${path}.${key}`);
    const properties = isNode(node['properties']) ? node['properties'] : {};
    for (const [key, child] of Object.entries(properties)) {
      if (!isNode(child)) continue;
      const at = under(key);
      found.push({ path: at, node: child, own: true, shows: at, laid: true });
      walk(child, at, at);
    }
    const values = node['additionalProperties'];
    if (isNode(values)) {
      const word = recordKeys[path];
      if (word === undefined) {
        throw new Error(
          `the mapping at ${path || 'the top'} has no word its keys are named by in a path: ` +
            'give it one in ENV_SCHEMA_RECORD_KEYS',
        );
      }
      const at = under(`<${word}>`);
      found.push({ path: at, node: values, own: true, shows: at, laid: true });
      walk(values, at, at);
    }
    const items = node['items'];
    if (isNode(items)) {
      const at = `${path}[]`;
      found.push({ path: at, node: items, own: false, shows, laid: true });
      walk(items, at, shows);
    }
    for (const keyword of ['anyOf', 'oneOf'] as const) {
      const branches = node[keyword];
      if (!Array.isArray(branches)) continue;
      const seen = new Set<string>();
      for (const branch of branches) {
        if (!isNode(branch)) continue;
        const shape = shapeOf(branch);
        if (seen.has(shape.name)) {
          throw new Error(`two shapes of ${path} are both named {${shape.name}} in a path`);
        }
        seen.add(shape.name);
        const at = `${path}{${shape.name}}`;
        const own = shape.byConstant;
        found.push({ path: at, node: branch, own, shows: own ? at : shows, laid: own });
        walk(branch, at, own ? at : shows);
      }
    }
  };
  walk(schema, '', undefined);
  return found;
}

/** The keywords of a node a text may name as a bound, as `{maximum}`. */
const BOUND = /\{(minimum|maximum|exclusiveMinimum|minItems|maxItems|minLength|maxLength)\}/g;

/** What a set of texts leaves unsaid of a schema, or says wrongly. */
export interface DescriptionProblems {
  /** Nodes that take a text and are given none. */
  missing: string[];
  /** Texts given for a path that names no node. */
  orphaned: string[];
  /** Nodes whose listed values the text they show leaves out of its backticks. */
  unnamed: Array<{ path: string; values: string[] }>;
  /** Bounds a text names that its node does not have. */
  unbounded: Array<{ path: string; bound: string }>;
}

/** Whether `problems` holds any. */
export function hasDescriptionProblems(problems: DescriptionProblems): boolean {
  return (
    problems.missing.length > 0 ||
    problems.orphaned.length > 0 ||
    problems.unnamed.length > 0 ||
    problems.unbounded.length > 0
  );
}

/** The values a node lists: its `enum`, its `const`, and the `enum` its keys are held to. */
function listedValues(node: SchemaNode): string[] {
  const values: unknown[] = [];
  if (Array.isArray(node['enum'])) values.push(...(node['enum'] as unknown[]));
  if ('const' in node) values.push(node['const']);
  const names = node['propertyNames'];
  if (isNode(names) && Array.isArray(names['enum'])) values.push(...(names['enum'] as unknown[]));
  return values.map(String);
}

/**
 * Lay `descriptions` on `schema`, in place: each node's text, its bounds
 * written in, as its `markdownDescription` and its `description`. What the
 * texts miss or say wrongly is returned; the schema is described as far as
 * they go.
 */
export function describeSchema(
  schema: SchemaNode,
  descriptions: Readonly<Record<string, string>> = ENV_SCHEMA_DESCRIPTIONS,
  recordKeys: Readonly<Record<string, string>> = ENV_SCHEMA_RECORD_KEYS,
): DescriptionProblems {
  const nodes = hoveredNodes(schema, recordKeys);
  const owned = new Map(nodes.filter((at) => at.own).map((at) => [at.path, at.node]));
  const problems: DescriptionProblems = {
    missing: [...owned.keys()].filter((path) => descriptions[path] === undefined),
    orphaned: Object.keys(descriptions).filter((path) => !owned.has(path)),
    unnamed: [],
    unbounded: [],
  };
  const texts = new Map<string, string>();
  for (const [path, node] of owned) {
    const text = descriptions[path];
    if (text === undefined) continue;
    const written = text.replace(BOUND, (placeholder: string, bound: string) => {
      const value = node[bound];
      if (typeof value === 'number') return figure(value);
      problems.unbounded.push({ path, bound });
      return placeholder;
    });
    texts.set(path, written);
  }
  for (const { path, node, shows, laid } of nodes) {
    const text = shows === undefined ? undefined : texts.get(shows);
    if (text === undefined) continue;
    if (laid) {
      node['markdownDescription'] = text;
      node['description'] = text;
    }
    const left = listedValues(node).filter((value) => !text.includes(`\`${value}\``));
    if (left.length > 0) problems.unnamed.push({ path, values: left });
  }
  return problems;
}

/** The problems of the texts, one line each, as the script says them. */
export function describeProblems(problems: DescriptionProblems): string {
  return [
    ...problems.missing.map((path) => `no text for ${path}`),
    ...problems.orphaned.map((path) => `a text for ${path}, which names no key of the schema`),
    ...problems.unnamed.map(
      ({ path, values }) =>
        `the text ${path} shows leaves out ${values.map((value) => `\`${value}\``).join(', ')}`,
    ),
    ...problems.unbounded.map(
      ({ path, bound }) => `the text for ${path} names {${bound}}, which its node does not have`,
    ),
  ].join('\n');
}

/** Thrown when the texts do not hold the schema: the file would say what is not. */
export class EnvSchemaDescriptionError extends Error {
  constructor(readonly problems: DescriptionProblems) {
    super(
      `the texts of tools/env-schema-descriptions.ts do not hold the schema:\n` +
        describeProblems(problems),
    );
    this.name = 'EnvSchemaDescriptionError';
  }
}

/** The JSON Schema of the file as it is written, in the dialect asked: its shape alone. */
export function bareEnvFileJsonSchema(
  target: 'draft-7' | 'draft-2020-12' = 'draft-7',
): Record<string, unknown> {
  return z.toJSONSchema(envFileSchema, { io: 'input', target }) as Record<string, unknown>;
}

/**
 * The JSON Schema of the file as it is written, in the dialect asked, each
 * key with its text.
 *
 * @throws EnvSchemaDescriptionError when the texts do not hold the schema.
 */
export function envFileJsonSchema(
  target: 'draft-7' | 'draft-2020-12' = 'draft-7',
): Record<string, unknown> {
  const schema = bareEnvFileJsonSchema(target);
  const problems = describeSchema(schema);
  if (hasDescriptionProblems(problems)) throw new EnvSchemaDescriptionError(problems);
  return schema;
}

/** The text of the schema file, as this script writes it. */
export async function envSchemaText(): Promise<string> {
  const prettier = await import('prettier');
  const config = (await prettier.resolveConfig(ENV_SCHEMA_FILE)) ?? {};
  return prettier.format(JSON.stringify(envFileJsonSchema()), { ...config, parser: 'json' });
}

/** Whether the file at `file` holds the schema as this script would write it. */
export async function isEnvSchemaCurrent(file: string = ENV_SCHEMA_FILE): Promise<boolean> {
  let shipped: string;
  try {
    shipped = readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  return shipped === (await envSchemaText());
}

/** Write the schema to `file`, its folder made if missing. */
export async function writeEnvSchema(file: string = ENV_SCHEMA_FILE): Promise<void> {
  const text = await envSchemaText();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
}

/** The script: write the file, or with `--check` say whether it is stale. */
export async function main(
  argv: readonly string[],
  file: string = ENV_SCHEMA_FILE,
): Promise<number> {
  const unknown = argv.filter((arg) => arg !== '--check');
  if (unknown.length > 0) {
    process.stderr.write(`unknown argument: ${unknown.join(' ')}; only --check is read\n`);
    return 2;
  }
  try {
    return await checkOrWrite(argv.includes('--check'), file);
  } catch (err: unknown) {
    if (!(err instanceof EnvSchemaDescriptionError)) throw err;
    process.stderr.write(`${err.message}\nNothing was written.\n`);
    return 1;
  }
}

async function checkOrWrite(check: boolean, file: string): Promise<number> {
  if (check) {
    if (await isEnvSchemaCurrent(file)) {
      process.stdout.write(`${file} holds the schema of envFileSchema\n`);
      return 0;
    }
    process.stderr.write(
      `${file} is stale: it is not what envFileSchema gives. Run ${WRITE_COMMAND}\n`,
    );
    return 1;
  }
  await writeEnvSchema(file);
  process.stdout.write(`wrote ${file}\n`);
  return 0;
}

// Only when run as a script: the sibling test imports the module.
if (/write-env-schema\.[cm]?[jt]s$/.test(process.argv[1] ?? '')) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(
        `FATAL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      process.exit(1);
    });
}
