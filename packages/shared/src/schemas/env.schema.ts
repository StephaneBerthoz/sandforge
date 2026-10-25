import * as z from 'zod';
import { SEED_MAX_RECORDS_PER_OBJECT } from '../constants/defaults.js';
import { SEED_RELATION_LIMITS } from '../utils/seed-relations.js';
import {
  checkpointIdSchema,
  checkpointIgnoredFieldsSchema,
  checkpointOrganizationIdSchema,
} from './checkpoint.schema.js';
import { fieldRuleConfigSchema, fieldRuleSchema } from './seed-config.schema.js';

/**
 * Zod schemas of an environment as code: the file that describes the data an
 * environment needs (`sandforge.yaml`, version 1), what SandForge keeps of
 * one environment applied to one org (the state), what applying it would do
 * (the plan) and how each step ended.
 *
 * The file is reviewed and committed with a project, and read by a pipeline
 * nobody watches. Every object of it is strict: a key it does not name is
 * refused with the keys it does, as a misspelt `dry_run` is refused by the
 * MCP server and `--dry-run=true` by every script. A dropped key would be a
 * setting the file seems to hold and the run never applies.
 *
 * Two rules hold over the whole file, whatever its shape:
 *
 * - no key may be shaped like a secret ({@link secretKeyOf}). Credentials
 *   stay with the `sf` CLI; a Frozen load never reads its salt; DataOps
 *   templates carry no hash salt. A file is copied into pull requests, CI
 *   logs and caches, and a secret written in it is a secret published;
 * - a value comes from the process environment only through `{ env: NAME }`,
 *   and only where {@link isEnvRefPlace} says. A string template inside a
 *   `where` or a field value would turn the file into code, with a path for a
 *   CI variable into a query.
 *
 * The schema refuses both by its shape — a record key of either is refused
 * by its key schema, any other key is one no strict object names, and an
 * `{ env }` object stands nowhere else in the shape — and
 * {@link secretKeysIn} and {@link envRefsIn} find each one, so a refusal can
 * say where the thing goes instead.
 *
 * Version 1 holds the `seed` kind of resource. `targets` and `checkpoint`
 * are read and checked; what they ask is applied by the guards and the
 * checkpoint steps.
 */

// ─── Names and values ───────────────────────────────────────────────────────

/**
 * The secrets a file is most likely to be handed, each as the words a key is
 * made of. `token` covers `accessToken` and `refreshToken`, `secret` covers
 * `clientSecret`; they are listed for the joined spellings (`accesstoken`).
 */
const SECRET_KEYS: ReadonlyArray<{ name: string; words: readonly string[] }> = [
  { name: 'password', words: ['password'] },
  { name: 'passwd', words: ['passwd'] },
  { name: 'secret', words: ['secret'] },
  { name: 'token', words: ['token'] },
  { name: 'accessToken', words: ['access', 'token'] },
  { name: 'refreshToken', words: ['refresh', 'token'] },
  { name: 'sfdxAuthUrl', words: ['sfdx', 'auth', 'url'] },
  { name: 'authUrl', words: ['auth', 'url'] },
  { name: 'privateKey', words: ['private', 'key'] },
  { name: 'clientSecret', words: ['client', 'secret'] },
  { name: 'salt', words: ['salt'] },
  { name: 'apiKey', words: ['api', 'key'] },
];

/** The words of a key: `sfdxAuthUrl`, `SFDX_AUTH_URL` and `sfdx-auth-url` alike. */
function wordsOf(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== '')
    .map((word) => word.toLowerCase());
}

/** Whether `word` is `name`, or its plural. */
function isWord(word: string, name: string): boolean {
  return word === name || word === `${name}s`;
}

/**
 * The secret a key is shaped like, as the list names it, or undefined. A key
 * is read as its words, so `SF_ACCESS_TOKEN`, `apiKeys` and `client-secret`
 * are caught, and `apikey` written as one word too; a word that merely holds
 * one, as `basalt` holds `salt`, is not.
 */
export function secretKeyOf(key: string): string | undefined {
  const words = wordsOf(key);
  for (const secret of SECRET_KEYS) {
    const joined = secret.words.join('');
    if (words.some((word) => isWord(word, joined))) return secret.name;
    const last = secret.words.length - 1;
    for (let start = 0; start + last < words.length; start += 1) {
      const matches = secret.words.every((part, i) =>
        i === last ? isWord(words[start + i] ?? '', part) : words[start + i] === part,
      );
      if (matches) return secret.name;
    }
  }
  return undefined;
}

/**
 * A name the file gives: the environment's, a resource's, an org role's, a
 * checkpoint's. It becomes a folder of the state and part of a run id, so it
 * is one fixed shape: no separator, no dot, nothing a path or a command line
 * reads apart.
 */
export const envNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, {
  error:
    'A name is lower-case letters, digits and dashes, starting with a letter, 63 characters at most',
});

/** A name the file gives as a key: a resource's, a role's. A key shaped like a secret is refused. */
const envKeySchema = envNameSchema.refine((name) => secretKeyOf(name) === undefined, {
  error: (issue) =>
    `"${String(issue.input)}" is shaped like a secret (${secretKeyOf(String(issue.input))}): ` +
    'the file holds no secret, so name it otherwise',
});

/** An object's or a field's API name, namespaced ones included. */
const apiNameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, { error: 'Not a Salesforce API name' })
  .max(80);

/** A lookup named with its object: `Contact.AccountId`. */
const lookupSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*$/, {
    error: 'A lookup is named with its object, as Contact.AccountId',
  })
  .max(161);

/** A sha256, hex: a fingerprint, a digest. */
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, { error: 'Expected a sha256, hex' });

/** An instant, ISO 8601 with its zone. */
const instantSchema = z.iso.datetime({ offset: true });

const countSchema = z.number().int().nonnegative();

/**
 * A strict object of the file: a key it does not name is refused, with the
 * keys it does, so the refusal says what was meant.
 *
 * @param what - The object as the refusal names it: `a seed resource`.
 */
function strictObject<T extends z.core.$ZodLooseShape>(what: string, shape: T) {
  const keys = Object.keys(shape).join(', ');
  return z.strictObject(shape, {
    error: (issue) => {
      if (issue.code === 'unrecognized_keys') {
        const named = issue.keys.map((key) => `"${key}"`).join(', ');
        const verb = issue.keys.length === 1 ? 'is not a key' : 'are not keys';
        return `${named} ${verb} of ${what}, which takes ${keys}`;
      }
      if (issue.code === 'invalid_type') {
        return issue.input === undefined
          ? `${what} is missing`
          : `${what} is a mapping of keys, not ${Array.isArray(issue.input) ? 'a list' : `a ${typeof issue.input}`}`;
      }
      return undefined;
    },
  });
}

// ─── Values from the environment ────────────────────────────────────────────

/** `{ env: NAME }`: a value read from the process environment, by name. */
export const envRefSchema = strictObject('a variable', {
  env: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/, {
    error: 'A variable is named in upper-case letters, digits and underscores, as SF_UAT_ALIAS',
  }),
});

/**
 * Where `{ env: NAME }` may stand, as a refusal names it. Version 1 has one
 * place: the alias of an org role. A frozen dataset's path joins it with the
 * `frozen` kind.
 */
export const ENV_REF_PLACES: readonly string[] = ['orgs.<role>.alias'];

/** Whether `path` is a place {@link ENV_REF_PLACES} names. */
export function isEnvRefPlace(path: ReadonlyArray<string | number>): boolean {
  return path.length === 3 && path[0] === 'orgs' && path[2] === 'alias';
}

/**
 * An sf CLI alias, or the variable that holds one. It never starts with `-`,
 * which a script's command line would read as a flag, and holds no space.
 */
const aliasValueSchema = z.union(
  [
    z.string().regex(/^[^-\s][^\s]{0,199}$/, {
      error: 'An alias holds no space and does not start with "-"',
    }),
    envRefSchema,
  ],
  { error: 'An alias is a word of the sf CLI, or { env: NAME } naming the variable that holds it' },
);

// ─── The file: targets, org roles, checkpoint settings ───────────────────────

/** The kinds of org an environment may be applied to: never a production org. */
export const envTargetKindSchema = z.enum(['scratch', 'developer', 'sandbox']);

const targetsSchema = strictObject('targets', {
  kinds: z.array(envTargetKindSchema).min(1).max(3).default(['scratch', 'developer']),
  /** Organization Ids of the sandboxes an apply may write to. */
  sandboxes: z.array(checkpointOrganizationIdSchema).max(50).default([]),
  /** Organization Ids refused whatever else says. */
  protect: z.array(checkpointOrganizationIdSchema).max(50).default([]),
}).superRefine((targets, ctx) => {
  if (new Set(targets.kinds).size !== targets.kinds.length) {
    ctx.addIssue({ code: 'custom', path: ['kinds'], message: 'A kind of org is listed twice' });
  }
  // Nothing Salesforce says tells a full copy from a developer sandbox, so a
  // sandbox is written to only when the file lists it and allows the kind:
  // a list the kinds then refuse would read as allowed and refuse every apply.
  if (targets.sandboxes.length > 0 && !targets.kinds.includes('sandbox')) {
    ctx.addIssue({
      code: 'custom',
      path: ['sandboxes'],
      message:
        'targets.sandboxes lists sandboxes and targets.kinds does not allow sandbox: add ' +
        'sandbox to the kinds, or empty the list',
    });
  }
});

const orgRoleSchema = strictObject('an org role', { alias: aliasValueSchema });

const checkpointSettingsSchema = strictObject('checkpoint', {
  /** Take a checkpoint before the first write; `destroy --rewind` returns to it. */
  before: z.boolean().optional(),
  /** Take one, under this name, once applied; `reset` rewinds to it. */
  after: z.union([z.literal(false), envNameSchema]).optional(),
  ignoreFields: checkpointIgnoredFieldsSchema.optional(),
});

// ─── The file: the seed kind ─────────────────────────────────────────────────

/**
 * The most objects one seed resource writes: the bound `seed:execute` holds a
 * template to.
 */
export const ENV_SEED_MAX_OBJECTS = 100;

/** A field rule, as the panel saves it (`seed-config.schema.ts`), held strict. */
const fieldRuleFileSchema = strictObject('a field rule', {
  ...fieldRuleSchema.shape,
  config: strictObject('a field rule’s config', fieldRuleConfigSchema.shape),
});

const seedObjectFileSchema = strictObject('an object of a seed resource', {
  object: apiNameSchema,
  count: z.number().int().positive().max(SEED_MAX_RECORDS_PER_OBJECT),
  fields: z.array(fieldRuleFileSchema).max(500).optional(),
  /** Record types by DeveloperName; several take turns at random. */
  recordTypes: z.array(apiNameSchema).min(1).max(20).optional(),
  batchSize: z.number().int().positive().max(10_000).optional(),
});

/**
 * Where a relation's parents come from: the records this resource writes of
 * `object`, or, with `existing`, records the org already holds.
 */
const seedParentsFileSchema = strictObject('a relation’s parents', {
  object: apiNameSchema,
  existing: strictObject('existing parents', {
    /** A SOQL WHERE condition, without the keyword; held to the SOQL rule where it is checked. */
    where: z.string().min(1).max(2000).optional(),
    limit: z.number().int().positive().max(SEED_RELATION_LIMITS.maxExistingParents),
  }).optional(),
});

const seedDistributionFileSchema = z
  .discriminatedUnion(
    'mode',
    [
      strictObject('a distribution', {
        mode: z.literal('perParent'),
        count: z.number().int().positive().max(SEED_RELATION_LIMITS.maxPerParent),
      }),
      strictObject('a distribution', {
        mode: z.literal('range'),
        min: z.number().int().nonnegative().max(SEED_RELATION_LIMITS.maxPerParent),
        max: z.number().int().positive().max(SEED_RELATION_LIMITS.maxPerParent),
      }),
      strictObject('a distribution', {
        mode: z.literal('ratio'),
        ratio: z.number().min(SEED_RELATION_LIMITS.minRatio).max(SEED_RELATION_LIMITS.maxPerParent),
      }),
    ],
    { error: 'A distribution’s mode is perParent, range or ratio' },
  )
  .refine((distribution) => distribution.mode !== 'range' || distribution.min <= distribution.max, {
    path: ['min'],
    error: 'A range of children per parent cannot start above its end',
  });

const seedRelationFileSchema = strictObject('a relation', {
  lookup: lookupSchema,
  parents: seedParentsFileSchema,
  distribution: seedDistributionFileSchema,
});

/** What every kind of resource takes beside its own keys. */
const commonResourceShape = {
  /** Resources applied before this one, and destroyed after it. */
  dependsOn: z.array(envNameSchema).max(50).optional(),
  /** Acceptances reviewed in the file: CI has nobody to ask. */
  accept: strictObject('accept', { automation: z.boolean().optional() }).optional(),
};

export const envSeedResourceSchema = strictObject('a seed resource', {
  kind: z.literal('seed'),
  ...commonResourceShape,
  /** A built-in template's id. */
  template: z.string().min(1).max(200).optional(),
  objects: z.array(seedObjectFileSchema).min(1).max(ENV_SEED_MAX_OBJECTS).optional(),
  relations: z.array(seedRelationFileSchema).max(100).optional(),
  locale: z
    .string()
    .regex(/^[a-z]{2,3}(?:_[A-Za-z0-9]{2,4}){0,2}$/, { error: 'A locale is written as fr_FR' })
    .optional(),
  /** The draws; recorded in the state when left out. */
  seed: z
    .number()
    .int()
    .min(0)
    .max(2 ** 32 - 1)
    .optional(),
}).superRefine((resource, ctx) => {
  if (resource.template === undefined && resource.objects === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: [],
      message:
        'A seed resource names a built-in template (template) or the objects it writes ' +
        '(objects): give one',
    });
  }
  if (resource.template !== undefined && resource.objects !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['objects'],
      message: 'A seed resource names a built-in template or its objects, not both: keep one',
    });
  }
  if (resource.template !== undefined && resource.relations !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['relations'],
      message: 'Relations go with objects: a built-in template brings its own',
    });
  }
  const seen = new Set<string>();
  (resource.objects ?? []).forEach((object, index) => {
    if (seen.has(object.object)) {
      ctx.addIssue({
        code: 'custom',
        path: ['objects', index, 'object'],
        message: `${object.object} is listed twice: an object is listed once, with its count`,
      });
    }
    seen.add(object.object);
  });
});

/** Kinds that come with a later version of the file. */
const LATER_KINDS: readonly string[] = ['forge', 'frozen', 'mask'];

/** A resource of the file, told apart by its `kind`. */
export const envResourceSchema = z.discriminatedUnion('kind', [envSeedResourceSchema], {
  error: (issue) => {
    const input = issue.input;
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return 'A resource is a mapping of keys, starting with its kind: kind: seed';
    }
    const kind = (input as Record<string, unknown>)['kind'];
    if (kind === undefined) return 'A resource says its kind: kind: seed';
    if (typeof kind === 'string' && LATER_KINDS.includes(kind)) {
      return `Resources of kind ${kind} come with a later SandForge: this one applies seed resources`;
    }
    return `"${String(kind)}" is not a kind of resource: this SandForge applies seed resources`;
  },
});

/** The most resources one file holds, and the most org roles. */
export const ENV_MAX_RESOURCES = 100;
export const ENV_MAX_ORG_ROLES = 20;

/** `sandforge.yaml`, version 1. */
export const envFileSchema = strictObject('the file', {
  version: z.literal(1, {
    error: (issue) => {
      if (issue.input === undefined)
        return 'The file names no version: write version: 1 at its top';
      return typeof issue.input === 'number' && issue.input > 1
        ? `This file is written for a later SandForge (version ${issue.input}): this one reads version 1`
        : 'The version of the file is 1';
    },
  }),
  name: envNameSchema,
  description: z.string().max(2_000).optional(),
  targets: targetsSchema.prefault({}),
  /** Roles the resources name, each an sf CLI alias; never the target. */
  orgs: z.record(envKeySchema, orgRoleSchema).default({}),
  checkpoint: checkpointSettingsSchema.optional(),
  resources: z.record(envKeySchema, envResourceSchema, {
    error: (issue) =>
      issue.input === undefined ? 'The file names no resources: write resources:' : undefined,
  }),
}).superRefine((file, ctx) => {
  if (Object.keys(file.resources).length > ENV_MAX_RESOURCES) {
    ctx.addIssue({
      code: 'custom',
      path: ['resources'],
      message: `A file holds ${ENV_MAX_RESOURCES} resources at most: split it into two environments`,
    });
  }
  if (Object.keys(file.orgs).length > ENV_MAX_ORG_ROLES) {
    ctx.addIssue({
      code: 'custom',
      path: ['orgs'],
      message: `A file names ${ENV_MAX_ORG_ROLES} org roles at most`,
    });
  }
});

// ─── Rules over the whole document ───────────────────────────────────────────

/** A place in a document: its keys and list positions from the top. */
export type EnvDocumentPath = Array<string | number>;

/** How deep a document is walked: no file of the schema's shape goes half as deep. */
const WALK_DEPTH = 64;

/**
 * Visit every mapping of a document, with its path, once each: a YAML alias
 * may name a node twice, or name one of its own parents.
 */
function walkMappings(
  document: unknown,
  visit: (mapping: Record<string, unknown>, path: EnvDocumentPath) => void,
): void {
  const seen = new Set<object>();
  const walk = (node: unknown, path: EnvDocumentPath): void => {
    if (node === null || typeof node !== 'object' || seen.has(node) || path.length > WALK_DEPTH) {
      return;
    }
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, [...path, index]));
      return;
    }
    const mapping = node as Record<string, unknown>;
    visit(mapping, path);
    for (const [key, value] of Object.entries(mapping)) walk(value, [...path, key]);
  };
  walk(document, []);
}

/** Every key of a document shaped like a secret, with where it is and what it looks like. */
export function secretKeysIn(
  document: unknown,
): Array<{ path: EnvDocumentPath; key: string; secret: string }> {
  const found: Array<{ path: EnvDocumentPath; key: string; secret: string }> = [];
  walkMappings(document, (mapping, path) => {
    for (const key of Object.keys(mapping)) {
      const secret = secretKeyOf(key);
      if (secret !== undefined) found.push({ path: [...path, key], key, secret });
    }
  });
  return found;
}

/**
 * Every `{ env: NAME }` of a document — a mapping whose one key is `env` —
 * with where it stands. Whether it may stand there is {@link isEnvRefPlace}'s.
 */
export function envRefsIn(document: unknown): Array<{ path: EnvDocumentPath; name: unknown }> {
  const found: Array<{ path: EnvDocumentPath; name: unknown }> = [];
  walkMappings(document, (mapping, path) => {
    const keys = Object.keys(mapping);
    if (keys.length === 1 && keys[0] === 'env') found.push({ path, name: mapping['env'] });
  });
  return found;
}

// ─── The state ───────────────────────────────────────────────────────────────

export const envResourceKindSchema = z.enum(['seed', 'forge', 'frozen', 'mask']);

/** The script that applies, refreshes and destroys each kind of resource. */
export const envScriptSchema = z.enum([
  'sandforge-seed',
  'sandforge-clone',
  'sandforge-frozen',
  'sandforge-dataops',
]);

export const envResourceStatusSchema = z.enum([
  'applying',
  'applied',
  'partial',
  'failed',
  'destroying',
  'destroyed',
]);

/**
 * Where a run's `--json` summary is kept, from the state's folder:
 * `runs/<resource>/<n>.summary.json`. It becomes a path, so it is that shape
 * and no other.
 */
const runSummaryPathSchema = z
  .string()
  .regex(/^runs\/[a-z][a-z0-9-]{0,62}\/[1-9][0-9]{0,5}\.summary\.json$/, {
    error: 'Expected runs/<resource>/<n>.summary.json',
  });

/** Where a Frozen resource's loads are kept, from the state's folder: `frozen/<resource>`. */
const runSasPathSchema = z.string().regex(/^frozen\/[a-z][a-z0-9-]{0,62}$/, {
  error: 'Expected frozen/<resource>',
});

const envRunObjectSchema = z.strictObject({
  objectApiName: apiNameSchema,
  created: countSchema,
  refused: countSchema,
});

export const envRunSchema = z.strictObject({
  /** The run's rank among its resource's runs, from 1. */
  n: z.number().int().positive().max(999_999),
  script: envScriptSchema,
  /** Seed's run id, given by the environment. */
  runId: z.string().min(1).max(200).optional(),
  summary: runSummaryPathSchema.optional(),
  sas: runSasPathSchema.optional(),
  /** A mask's DataOps snapshot. */
  snapshotId: z.string().min(1).max(200).optional(),
  /** A seed's draws. */
  seed: z
    .number()
    .int()
    .min(0)
    .max(2 ** 32 - 1)
    .optional(),
  /** On the org's clock. */
  startedAt: instantSchema,
  endedAt: instantSchema.optional(),
  exitCode: z.number().int().min(0).max(255).optional(),
  objects: z.array(envRunObjectSchema).max(1_000),
});

export const envResourceStateSchema = z
  .strictObject({
    kind: envResourceKindSchema,
    fingerprint: sha256Schema,
    dependsOn: z.array(envNameSchema).max(50),
    status: envResourceStatusSchema,
    /** The last is current; earlier ones are runs a replace took back. */
    runs: z.array(envRunSchema).max(1_000),
  })
  .refine(
    (resource) =>
      resource.runs.every((run, i) => i === 0 || run.n > (resource.runs[i - 1]?.n ?? 0)),
    { path: ['runs'], error: 'Runs are kept in the order they ran' },
  );

/** `state.json`, version 1: ids, counts and dates, never a record's values. */
export const envStateSchema = z.strictObject({
  version: z.literal(1),
  /** The file's name. */
  env: envNameSchema,
  /** Set at the first apply: a state found under another org, or made again, is told apart. */
  lineage: z.uuid(),
  /** One more on every write: a plan names the serial it was made against. */
  serial: countSchema,
  sandforgeVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, {
    error: 'Expected a version, as 1.68.0',
  }),
  /** When the state was last written, by this machine's clock: a scratch org's expires from it. */
  updatedAt: instantSchema,
  org: z.strictObject({
    organizationId: checkpointOrganizationIdSchema,
    kind: envTargetKindSchema,
    username: z.string().min(1).max(255),
    alias: z.string().min(1).max(255).optional(),
  }),
  /** The resolved, canonical file it was last applied from. */
  file: z.strictObject({ digest: sha256Schema }),
  checkpoints: z
    .strictObject({ before: checkpointIdSchema.optional(), after: checkpointIdSchema.optional() })
    .optional(),
  resources: z.record(envNameSchema, envResourceStateSchema),
});

// ─── The plan ────────────────────────────────────────────────────────────────

/** What applying does to a resource: runs it, keeps it, replaces it, takes it back, or refuses. */
export const envActionKindSchema = z.enum([
  'create',
  'keep',
  'replace',
  'delete',
  'drifted',
  'blocked',
]);

/** The emails a day an org sends, by limit: what a step's records make it send against what is left. */
const envEmailLimitSchema = z.enum(['SingleEmail', 'DailyWorkflowEmails']);

const envPlanObjectSchema = z.strictObject({
  object: apiNameSchema,
  /** Records a create or a replace would write: its dry run's count. */
  wouldCreate: countSchema.optional(),
  /** Records of an earlier apply the org still holds as written. */
  present: countSchema.optional(),
  /** Records of an earlier apply deleted since, the recycle bin's included. */
  gone: countSchema.optional(),
  /** Records of an earlier apply someone changed since. */
  changed: countSchema.optional(),
});

/** What one action takes of the org's day. */
const envActionGatesSchema = z.strictObject({
  apiRequests: countSchema.optional(),
  storageBytes: countSchema.optional(),
  emails: z.array(z.strictObject({ limit: envEmailLimitSchema, emails: countSchema })).optional(),
});

export const envActionSchema = z.strictObject({
  resource: envNameSchema,
  kind: envResourceKindSchema,
  action: envActionKindSchema,
  /** Why, in a sentence: "replaced: its objects changed in the file". */
  why: z.string().min(1).max(2_000),
  objects: z.array(envPlanObjectSchema).max(1_000),
  gates: envActionGatesSchema.optional(),
  /** What refuses a blocked action. */
  refusal: z.string().min(1).max(2_000).optional(),
});

/**
 * The day's budget, summed across the resources a plan writes. What the org
 * has left is absent when its `/limits` did not say, and `unread` says why:
 * a Standard User is not told its org's storage, and a sum held to nothing
 * is no gate.
 */
const envPlanGatesSchema = z.strictObject({
  apiRequests: z.strictObject({
    estimate: countSchema,
    leftToday: z.number().int().optional(),
    /** A script whose dry run gives no estimate leaves the sum short of the truth. */
    partial: z.boolean(),
    /** What the sum leaves out, each named: a dry run not run, a removal's requests. */
    notCounted: z
      .array(z.string().min(1).max(2_000))
      .max(ENV_MAX_RESOURCES * 2)
      .optional(),
    unread: z.string().min(1).max(2_000).optional(),
  }),
  storage: z.strictObject({
    bytes: countSchema,
    left: z.number().int().optional(),
    unread: z.string().min(1).max(2_000).optional(),
  }),
  emails: z.array(
    z.strictObject({
      limit: envEmailLimitSchema,
      emails: countSchema,
      left: z.number().int().optional(),
    }),
  ),
});

export const envPlanSchema = z.strictObject({
  env: envNameSchema,
  org: z.strictObject({
    organizationId: checkpointOrganizationIdSchema,
    kind: envTargetKindSchema,
    alias: z.string().min(1).max(255).optional(),
  }),
  state: z.strictObject({ found: z.boolean(), serial: countSchema.optional() }),
  /** In the order apply runs them. */
  actions: z.array(envActionSchema).max(ENV_MAX_RESOURCES * 2),
  totals: z.strictObject({
    create: countSchema,
    keep: countSchema,
    replace: countSchema,
    delete: countSchema,
    drifted: countSchema,
    blocked: countSchema,
  }),
  gates: envPlanGatesSchema,
  /** The whole org against the checkpoint taken after the last apply. */
  drift: z.strictObject({ checkpoint: checkpointIdSchema, differs: z.boolean() }).optional(),
  /** What a real apply would meet now. */
  refusal: z.string().min(1).max(2_000).optional(),
  /** Made with `--quick`: no dry run, no removal preview, so no count of what the org holds. */
  quick: z.literal(true).optional(),
  /** What the plan says without refusing: an apply under way, a scratch org with no state. */
  warnings: z.array(z.string().min(1).max(2_000)).max(50).optional(),
});

// ─── How each step ended ─────────────────────────────────────────────────────

/** A step runs a resource's script, or takes a run of it back. */
export const envStepPhaseSchema = z.enum(['run', 'remove']);

const envStepObjectSchema = z.strictObject({
  object: apiNameSchema,
  created: countSchema,
  refused: countSchema,
  deleted: countSchema,
  kept: countSchema,
  /** Why records were kept or refused, as the script said it. */
  reason: z.string().min(1).max(2_000).optional(),
});

export const envStepResultSchema = z.strictObject({
  resource: envNameSchema,
  /** The plan's action the step serves. */
  action: envActionKindSchema,
  phase: envStepPhaseSchema,
  /** The rank of the run the step ran, or took back. */
  run: z.number().int().positive().max(999_999),
  script: envScriptSchema,
  exitCode: z.number().int().min(0).max(255),
  /** The resource's status once the step ended. */
  status: envResourceStatusSchema,
  summary: runSummaryPathSchema.optional(),
  objects: z.array(envStepObjectSchema).max(1_000),
  /** The script's own `--json` answer, as it gave it. */
  answer: z.unknown().optional(),
});

/** What `apply` and `destroy` answer with `--json`. */
export const envRunResultSchema = z.strictObject({
  plan: envPlanSchema,
  steps: z.array(envStepResultSchema).max(ENV_MAX_RESOURCES * 4),
  /** Resources no step ran for, each with why: a dependency left partial, a stop before them. */
  skipped: z
    .array(z.strictObject({ resource: envNameSchema, why: z.string().min(1).max(2_000) }))
    .max(ENV_MAX_RESOURCES * 2)
    .optional(),
  status: z.enum(['success', 'partial', 'failure', 'cancelled']),
  /** Why nothing was done, when it was refused before its first step. */
  refusal: z.string().min(1).max(4_000).optional(),
  /** The state as the run left it; `deleted` once a destroy took back everything it named. */
  state: z.strictObject({ serial: countSchema, deleted: z.literal(true).optional() }),
});

// ─── What the other verbs answer ─────────────────────────────────────────────

/** One refusal or warning of the file, where it stands. */
const envIssueSchema = z.strictObject({
  /** Where in the file, as a line names it: `resources.accounts.objects[0].count`. */
  path: z.string().max(1_000),
  resource: envNameSchema.optional(),
  message: z.string().min(1).max(4_000),
});

/** What a verb refused before it read or wrote anything, as `--json` answers it. */
export const envRefusalAnswerSchema = z.strictObject({
  refusal: z.strictObject({
    /** What refused, in a word a pipeline reads: PRODUCTION, NOT_LISTED, LOCKED… */
    code: z.string().regex(/^[A-Z][A-Z_]{1,40}$/),
    message: z.string().min(1).max(8_000),
    /** The file's refusals, each where it stands. */
    issues: z.array(envIssueSchema).max(500).optional(),
  }),
});

/** What `validate --json` answers: the file checked offline, or why it is not valid. */
export const envValidationSchema = z.strictObject({
  file: z.string().min(1).max(4_096),
  valid: z.boolean(),
  /** Present when valid. */
  env: envNameSchema.optional(),
  /** In the order apply runs them. */
  resources: z
    .array(
      z.strictObject({
        name: envNameSchema,
        kind: envResourceKindSchema,
        dependsOn: z.array(envNameSchema).max(50),
        objects: z.array(z.strictObject({ object: apiNameSchema, count: countSchema })).max(1_000),
      }),
    )
    .max(ENV_MAX_RESOURCES)
    .optional(),
  /** The variables the file reads, and whether this process has each set. */
  variables: z
    .array(
      z.strictObject({ name: z.string().min(1).max(128), role: envNameSchema, set: z.boolean() }),
    )
    .max(ENV_MAX_ORG_ROLES)
    .optional(),
  issues: z.array(envIssueSchema).max(500),
  warnings: z.array(envIssueSchema).max(500),
});

/** One state kept on this machine, as `state --json` lists it. */
export const envStateListEntrySchema = z.strictObject({
  env: envNameSchema,
  organizationId: checkpointOrganizationIdSchema,
  alias: z.string().min(1).max(255).optional(),
  kind: envTargetKindSchema.optional(),
  serial: countSchema.optional(),
  resources: z.record(envNameSchema, envResourceStatusSchema).optional(),
  updatedAt: instantSchema.optional(),
  expiresAt: instantSchema.optional(),
  /** Why the state is not used: it does not parse, or names another org. */
  damaged: z.string().min(1).max(4_000).optional(),
});

/** What `state --json` answers: the states kept on this machine, and those it deleted on their date. */
export const envStateListSchema = z.strictObject({
  journalDir: z.string().min(1).max(4_096),
  states: z.array(envStateListEntrySchema).max(10_000),
  expired: z
    .array(
      z.strictObject({
        env: envNameSchema,
        organizationId: checkpointOrganizationIdSchema,
        alias: z.string().min(1).max(255).optional(),
        expiresAt: instantSchema,
      }),
    )
    .max(10_000),
});
