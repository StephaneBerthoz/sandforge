/**
 * The file an environment is described by, read, checked and made into what
 * each resource runs.
 *
 * The check comes in two stages. The file is held to its own schema first
 * (`envFileSchema`): strict, versioned, no key shaped like a secret, a value
 * from the environment only where `{ env: NAME }` may stand. Then each
 * resource is converted into its module's own payload and held to that
 * module's own schema and rules, as its kind's module says (`envKinds.ts`):
 * a seed resource into a `SeedTemplate`, checked by `seedTemplatePayloadSchema`
 * as `seed:execute` checks the panel's, and by the validator a seed run
 * starts with; a forge resource into an exported template, checked by
 * `forgeTemplateSchema` as the clone's `--template` reads it. What the check
 * accepted is what the run is given: a refusal the run would meet after its
 * first objects were written is met here, before any.
 *
 * Text becomes a document in one place, {@link documentOf}, which reads YAML
 * 1.2 — JSON included. Everything after it takes the parsed document.
 *
 * Each refusal names where in the file it is, the resource it is of, and the
 * way out, as the command lines' refusals do.
 */

import { resolve } from 'node:path';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import {
  ENV_REF_PLACES,
  envFileSchema,
  envRefsIn,
  isEnvRefPlace,
  secretKeysIn,
  type EnvDocumentPath,
  type EnvFile,
  type EnvForgeRun,
  type EnvSeedRun,
} from '@sandforge/shared';
import { convertResource, writtenOf, type EnvKindRun } from './envKinds.js';
import { canonicalJson, pathText, refusalAt, sha256, type EnvFileRefusal } from './kinds/common.js';
import type { EnvSourceRead } from './kinds/forge.js';

export { canonicalJson, pathText, type EnvFileRefusal };

/** A refusal as a line of the command line says it. */
export function refusalLine(refusal: EnvFileRefusal): string {
  return `${pathText(refusal.path)}: ${refusal.message}`;
}

// ─── Text to document ────────────────────────────────────────────────────────

/** The aliases a file may resolve: enough for a shared block, too few to blow one up. */
const MAX_ALIASES = 100;

/**
 * The document a file's text holds: the one place text becomes one. YAML 1.2
 * with its core schema, so JSON reads too; strict as the schema is. A key
 * given twice in one mapping is refused, which YAML does not allow and a
 * reader that keeps the last would apply once, the first replaced unseen. So
 * are a tag the core schema does not know, a merge key (`<<`, gone from YAML
 * 1.2), a second document in the file, and more aliases than {@link
 * MAX_ALIASES}: whatever YAML would read otherwise than it is written.
 */
export function documentOf(text: string): { document: unknown } | { refusal: string } {
  const body = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const parsed = parseDocument(body, {
    version: '1.2',
    schema: 'core',
    merge: false,
    uniqueKeys: false,
    prettyErrors: true,
  });
  const problem = parsed.errors[0] ?? parsed.warnings[0];
  if (problem) {
    return {
      refusal: `The file does not read as YAML 1.2: ${problem.message.split('\n')[0]}`,
    };
  }
  const duplicate = duplicateKeyIn(parsed.contents, []);
  if (duplicate !== undefined) {
    return {
      refusal:
        `${pathText(duplicate.path)} holds the key "${duplicate.key}" twice: a mapping holds ` +
        'each key once, and the second would replace the first unseen. Keep one.',
    };
  }
  try {
    return { document: parsed.toJS({ maxAliasCount: MAX_ALIASES }) };
  } catch (err: unknown) {
    return {
      refusal: `The file does not read as YAML 1.2: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * The first key a mapping of the document holds twice, with the mapping's
 * path. An alias is walked where its anchor stands.
 */
function duplicateKeyIn(
  node: unknown,
  path: EnvDocumentPath,
): { path: EnvDocumentPath; key: string } | undefined {
  if (isMap(node)) {
    const keys = new Set<string>();
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
      if (keys.has(key)) return { path, key };
      keys.add(key);
      const inner = duplicateKeyIn(pair.value, [...path, key]);
      if (inner) return inner;
    }
  } else if (isSeq(node)) {
    for (const [index, item] of node.items.entries()) {
      const inner = duplicateKeyIn(item, [...path, index]);
      if (inner) return inner;
    }
  }
  return undefined;
}

// ─── The check ───────────────────────────────────────────────────────────────

/** A variable the file reads, and where. */
export interface EnvFileVariable {
  name: string;
  path: EnvDocumentPath;
  /** The org role whose alias it holds. */
  role: string;
}

/** A file that passed the check, offline: what `validate` answers from. */
export interface EnvFileChecked {
  file: EnvFile;
  /** The folder the file is in, resolved. */
  folder: string;
  /** The resources in the order apply runs them: what each depends on first, ties in file order. */
  order: string[];
  /** What each resource runs, by name, with its kind. */
  runs: Record<string, EnvKindRun>;
  /** The variables the file reads. */
  variables: EnvFileVariable[];
  /** What a module's rules warn of without refusing it. */
  warnings: EnvFileRefusal[];
}

/** Where a secret goes instead of the file. */
function whereSecretGoes(secret: string): string {
  return secret === 'salt'
    ? 'a Frozen load never reads its salt, and DataOps templates carry no hash salt: leave it out'
    : 'org credentials stay with the sf CLI — log the org in with sf org login sfdx-url or sf ' +
        'org login jwt before the step, and name it in the file by its alias';
}

/**
 * Check a parsed document, offline: the file's own rules and schema, each
 * resource against its module's, the resources' order. The variables it reads
 * are listed, not read: `validate` says which are unset, and every verb that
 * reaches an org resolves them ({@link resolveEnvFile}).
 *
 * @param folder - The folder the file is in: the repository rule and the
 *   paths a resource names are of it.
 */
export function checkEnvFile(
  document: unknown,
  folder: string,
  options: { now?: Date } = {},
): { checked: EnvFileChecked } | { refusals: EnvFileRefusal[] } {
  // The two rules over the whole document first: a secret written in the file
  // is refused for what it is, wherever it stands, before the shape is read.
  const ruled: EnvFileRefusal[] = [
    ...secretKeysIn(document).map(({ path, secret }) =>
      refusalAt(
        path,
        `a key shaped like a secret (${secret}). The file holds no secret: ${whereSecretGoes(secret)}.`,
      ),
    ),
    ...envRefsIn(document)
      .filter(({ path }) => !isEnvRefPlace(path))
      .map(({ path }) =>
        refusalAt(
          path,
          `{ env } stands in ${ENV_REF_PLACES.join(' and ')} alone: write this value in the ` +
            'file. A variable inside a query or a field value would let a CI variable into what ' +
            'is written.',
        ),
      ),
  ];
  if (ruled.length > 0) return { refusals: ruled };

  const parsed = envFileSchema.safeParse(document);
  if (!parsed.success) {
    return {
      refusals: parsed.error.issues.map((issue) => {
        const nested = issue.code === 'invalid_key' ? issue.issues.map((i) => i.message) : [];
        return refusalAt(issue.path as EnvDocumentPath, nested.join('; ') || issue.message);
      }),
    };
  }
  const file = parsed.data;

  const ordered = orderOf(file);
  if ('refusals' in ordered) return ordered;

  const refusals: EnvFileRefusal[] = [];
  const warnings: EnvFileRefusal[] = [];
  const runs: Record<string, EnvKindRun> = {};
  for (const [name, resource] of Object.entries(file.resources)) {
    const converted = convertResource(
      file.name,
      name,
      resource,
      resolve(folder),
      options.now ?? new Date(),
    );
    if ('refusals' in converted) {
      refusals.push(...converted.refusals);
      continue;
    }
    warnings.push(...converted.warnings);
    runs[name] = converted.run;
  }
  if (refusals.length > 0) return { refusals };

  const variables: EnvFileVariable[] = [];
  for (const [role, { alias }] of Object.entries(file.orgs)) {
    if (typeof alias !== 'string') {
      variables.push({ name: alias.env, path: ['orgs', role, 'alias'], role });
    }
  }
  return {
    checked: { file, folder: resolve(folder), order: ordered.order, runs, variables, warnings },
  };
}

/** The variables a checked file reads that `env` leaves unset, or sets to nothing. */
export function unsetVariablesOf(
  checked: Pick<EnvFileChecked, 'variables'>,
  env: NodeJS.ProcessEnv,
): EnvFileVariable[] {
  return checked.variables.filter((variable) => (env[variable.name] ?? '').trim() === '');
}

// ─── The order ───────────────────────────────────────────────────────────────

/**
 * The resources in the order apply runs them: each after what it depends on,
 * ties in file order; a destroy runs it backwards. A dependency on no resource
 * of the file, or a circle of them, is refused: no order would apply it.
 */
function orderOf(file: EnvFile): { order: string[] } | { refusals: EnvFileRefusal[] } {
  const names = Object.keys(file.resources);
  const refusals: EnvFileRefusal[] = [];
  const edges = new Map<string, string[]>();
  for (const [name, resource] of Object.entries(file.resources)) {
    const deps: string[] = [];
    (resource.dependsOn ?? []).forEach((dependency, index) => {
      const path = ['resources', name, 'dependsOn', index];
      if (dependency === name) {
        refusals.push(
          refusalAt(
            path,
            `a resource does not depend on itself: take ${name} out of its dependsOn`,
          ),
        );
      } else if (!(dependency in file.resources)) {
        refusals.push(
          refusalAt(
            path,
            `"${dependency}" is no resource of this file: name one of ${names.join(', ')}`,
          ),
        );
      } else if (!deps.includes(dependency)) {
        deps.push(dependency);
      }
    });
    edges.set(name, deps);
  }
  if (refusals.length > 0) return { refusals };

  const circle = circleIn(names, edges);
  if (circle !== undefined) {
    return {
      refusals: [
        refusalAt(
          ['resources', circle[0] ?? ''],
          `the resources depend on each other in a circle, ${circle.join(' → ')}: no order ` +
            'applies them. Take one of them out of the dependsOn of the next.',
        ),
      ],
    };
  }

  const order: string[] = [];
  const placed = new Set<string>();
  while (order.length < names.length) {
    const next = names.find(
      (name) => !placed.has(name) && (edges.get(name) ?? []).every((dep) => placed.has(dep)),
    );
    // A circle was refused above: there is always a next one.
    if (next === undefined) break;
    order.push(next);
    placed.add(next);
  }
  return { order };
}

/** The first circle of dependencies, from the resource it starts at back to it; undefined when none. */
function circleIn(names: string[], edges: Map<string, string[]>): string[] | undefined {
  const done = new Set<string>();
  const trail: string[] = [];
  const visit = (name: string): string[] | undefined => {
    const at = trail.indexOf(name);
    if (at >= 0) return [...trail.slice(at), name];
    if (done.has(name)) return undefined;
    trail.push(name);
    for (const dep of edges.get(name) ?? []) {
      const circle = visit(dep);
      if (circle !== undefined) return circle;
    }
    trail.pop();
    done.add(name);
    return undefined;
  };
  for (const name of names) {
    const circle = visit(name);
    if (circle !== undefined) return circle;
  }
  return undefined;
}

// ─── Resolution and fingerprints ─────────────────────────────────────────────

/**
 * The fingerprint of a resource, given the fingerprints of what it depends on:
 * chained, so that one of them changed moves it too. Of what its run writes
 * alone, as its kind says it (`writtenOf`).
 */
export function fingerprintOf(
  resource: EnvFileResource,
  dependsOn: Readonly<Record<string, string | undefined>>,
): string {
  return sha256(canonicalJson({ ...writtenOf(resource), dependsOn }));
}

/** What every resource ready to plan holds, whatever its kind. */
interface EnvFileResourceBase {
  name: string;
  dependsOn: string[];
  /** sha256 of what it writes, canonical: a change to the file that writes nothing else keeps it. */
  fingerprint: string;
}

/** The org a forge resource clones from: its role, the alias the role resolves to, and what a plan read of it. */
export interface EnvForgeSource {
  role: string;
  alias: string;
  /** Read at each plan; absent until it is, and for a destroy, which reads no source. */
  read?: EnvSourceRead;
}

/** A resource ready to plan: what it runs, and the fingerprint it would be applied from. */
export type EnvFileResource =
  | (EnvFileResourceBase & { kind: 'seed'; run: EnvSeedRun })
  | (EnvFileResourceBase & { kind: 'forge'; run: EnvForgeRun; source: EnvForgeSource });

/** A file whose variables are read: what `plan`, `apply` and `destroy` work from. */
export interface EnvFileResolved {
  checked: EnvFileChecked;
  /** Each org role's alias, read. */
  orgs: Record<string, string>;
  /** In the order apply runs them. */
  resources: EnvFileResource[];
  /** sha256 of the resolved file, canonical: the state's `file.digest`. */
  digest: string;
}

/** An alias as the sf CLI and a script's line take one: no space, never a flag. */
const ALIAS = /^[^-\s][^\s]{0,199}$/;

/**
 * Read the variables of a checked file, refusing one unset and naming it,
 * then fingerprint each resource. An alias given on the command line wins
 * over the file's.
 *
 * @param aliases - Aliases the line gives, by org role (`--alias uat=SRC`).
 * @param sources - What a plan read of each forge resource's source, by
 *   resource: the org its alias reaches and the record its query names,
 *   which its fingerprint is of. A resource whose source was not read is
 *   fingerprinted without it, and a plan blocks it.
 */
export function resolveEnvFile(
  checked: EnvFileChecked,
  env: NodeJS.ProcessEnv,
  options: {
    aliases?: Readonly<Record<string, string>>;
    sources?: Readonly<Record<string, EnvSourceRead>>;
  } = {},
): { resolved: EnvFileResolved } | { refusals: EnvFileRefusal[] } {
  const roles = Object.keys(checked.file.orgs);
  const refusals: EnvFileRefusal[] = [];
  const aliases = options.aliases ?? {};
  for (const [role, alias] of Object.entries(aliases)) {
    if (!roles.includes(role)) {
      refusals.push(
        refusalAt(
          ['orgs'],
          `--alias names the role ${role}, which the file's orgs do not declare: ` +
            (roles.length > 0 ? `its roles are ${roles.join(', ')}` : 'it declares none'),
        ),
      );
    } else if (!ALIAS.test(alias)) {
      refusals.push(
        refusalAt(
          ['orgs', role, 'alias'],
          `--alias ${role}= gives no alias: one holds no space and does not start with "-"`,
        ),
      );
    }
  }
  const orgs: Record<string, string> = {};
  for (const [role, { alias }] of Object.entries(checked.file.orgs)) {
    const given = aliases[role];
    if (given !== undefined) {
      orgs[role] = given;
      continue;
    }
    if (typeof alias === 'string') {
      orgs[role] = alias;
      continue;
    }
    const value = (env[alias.env] ?? '').trim();
    if (value === '') {
      refusals.push(
        refusalAt(
          ['orgs', role, 'alias'],
          `the variable ${alias.env} is not set: set it in the job's environment to the alias ` +
            `of the ${role} org, or give --alias ${role}=<alias>`,
        ),
      );
    } else if (!ALIAS.test(value)) {
      refusals.push(
        refusalAt(
          ['orgs', role, 'alias'],
          `the variable ${alias.env} holds no alias: one holds no space and does not start ` +
            'with "-"',
        ),
      );
    } else {
      orgs[role] = value;
    }
  }
  if (refusals.length > 0) return { refusals };

  const fingerprints: Record<string, string> = {};
  const resources: EnvFileResource[] = [];
  for (const name of checked.order) {
    const kindRun = checked.runs[name];
    const resource = checked.file.resources[name];
    if (kindRun === undefined || resource === undefined) continue;
    const dependsOn = [...new Set(resource.dependsOn ?? [])];
    let ready: EnvFileResource;
    if (kindRun.kind === 'seed') {
      const { kind, ...run } = kindRun;
      ready = { name, kind, dependsOn, fingerprint: '', run };
    } else {
      const { kind, ...run } = kindRun;
      const read = options.sources?.[name];
      ready = {
        name,
        kind,
        dependsOn,
        fingerprint: '',
        run,
        source: {
          role: run.source,
          alias: orgs[run.source] ?? '',
          ...(read !== undefined ? { read } : {}),
        },
      };
    }
    ready.fingerprint = fingerprintOf(
      ready,
      Object.fromEntries(dependsOn.map((dep) => [dep, fingerprints[dep]])),
    );
    fingerprints[name] = ready.fingerprint;
    resources.push(ready);
  }
  const digest = sha256(
    canonicalJson({
      ...checked.file,
      orgs: Object.fromEntries(Object.entries(orgs).map(([role, alias]) => [role, { alias }])),
    }),
  );
  return { resolved: { checked, orgs, resources, digest } };
}

/**
 * Check a parsed document and read its variables: what every verb that
 * reaches an org starts from.
 */
export function readEnvFile(
  document: unknown,
  folder: string,
  env: NodeJS.ProcessEnv,
  options: {
    aliases?: Readonly<Record<string, string>>;
    sources?: Readonly<Record<string, EnvSourceRead>>;
    now?: Date;
  } = {},
): { resolved: EnvFileResolved } | { refusals: EnvFileRefusal[] } {
  const checked = checkEnvFile(document, folder, options.now ? { now: options.now } : {});
  if ('refusals' in checked) return checked;
  return resolveEnvFile(checked.checked, env, {
    ...(options.aliases ? { aliases: options.aliases } : {}),
    ...(options.sources ? { sources: options.sources } : {}),
  });
}
