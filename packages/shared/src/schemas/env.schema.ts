import * as z from 'zod';
import {
  BACKUP_MAX_RECORDS_PER_OBJECT,
  SEED_MAX_RECORDS_PER_OBJECT,
} from '../constants/defaults.js';
import { SEED_RELATION_LIMITS } from '../utils/seed-relations.js';
import {
  checkpointIdSchema,
  checkpointIgnoredFieldsSchema,
  checkpointNameSchema,
  checkpointOrganizationIdSchema,
} from './checkpoint.schema.js';
import {
  TEMPLATE_MAX_RULES,
  savedTemplateRuleSchema,
} from '../constants/saved-anonymization-templates.js';
import {
  FORGE_SAMPLE_MAX_LAST_DAYS,
  FORGE_SAMPLE_MAX_ROOT_WHERE,
  forgeAnonymizationRulesSchema,
  forgeRunDepthSchema,
  forgeSampleStrataSchema,
  forgeSampleWindowBound,
} from './forge.schema.js';
import { FORGE_ROOTS_MAX } from '../utils/forge-run-gate.js';
import { soqlOrderBySchema } from '../utils/soqlRoot.js';
import { fieldRuleConfigSchema, fieldRuleSchema } from './seed-config.schema.js';
import {
  USERS_MAX,
  usernamesTwice,
  usersListSchema,
  usersPlanUserSchema,
  usersSettingsShape,
  usersUsernameSchema,
} from './users.schema.js';

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
 * Version 1 holds the `seed`, `forge`, `frozen`, `mask`, `users` and
 * `replay` kinds of resource, and the `masking:` sets of DataOps rules a mask
 * resource names. `targets`, `checkpoint` and `audits` are read and checked;
 * what they ask is applied by the guards, the checkpoint steps and the
 * audits.
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
 * @param why - For a key the object refuses that a reader may well write,
 *   why it is refused and what to do instead, said after the keys it takes.
 */
function strictObject<T extends z.core.$ZodLooseShape>(
  what: string,
  shape: T,
  why: Readonly<Record<string, string>> = {},
) {
  const keys = Object.keys(shape).join(', ');
  return z.strictObject(shape, {
    error: (issue) => {
      if (issue.code === 'unrecognized_keys') {
        const named = issue.keys.map((key) => `"${key}"`).join(', ');
        const verb = issue.keys.length === 1 ? 'is not a key' : 'are not keys';
        const reason = issue.keys.map((key) => why[key]).find((said) => said !== undefined);
        return `${named} ${verb} of ${what}, which takes ${keys}${reason === undefined ? '' : `: ${reason}`}`;
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
 * Where `{ env: NAME }` may stand, as a refusal names it. Version 1 has three
 * places: the alias of an org role, the path of a frozen resource's dataset,
 * and the checkpoint file a replay resource opens, which a pipeline downloads
 * where its runner says. The variable that holds a checkpoint file's key is
 * named by `keyEnv`, as a name: the key is read from it, never written.
 */
export const ENV_REF_PLACES: readonly string[] = [
  'orgs.<role>.alias',
  'resources.<frozen>.dataset.path',
  'resources.<replay>.checkpoint.file',
];

/**
 * Whether `path` is a place {@link ENV_REF_PLACES} names. A dataset's path
 * stands in a frozen resource alone, and a checkpoint's file in a replay
 * resource alone: no other kind takes a `dataset` or a `checkpoint`, which
 * its strict schema refuses.
 */
export function isEnvRefPlace(path: ReadonlyArray<string | number>): boolean {
  if (path.length === 3 && path[0] === 'orgs' && path[2] === 'alias') return true;
  if (path.length !== 4 || path[0] !== 'resources') return false;
  return (
    (path[2] === 'dataset' && path[3] === 'path') ||
    (path[2] === 'checkpoint' && path[3] === 'file')
  );
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

/** A sandbox's My Domain: production's, two dashes, the sandbox's name, as `acme--uat`. */
const SANDBOX_MY_DOMAIN = /^[a-z0-9-]+--[a-z0-9]+$/;

/**
 * Why a My Domain given is not a sandbox's, with the one to give: a whole
 * host gives its first label, production's own gives itself with `--uat`.
 */
function myDomainRefusal(given: string): string {
  const name = given.split('.')[0]?.toLowerCase() ?? '';
  if (given.includes('.')) {
    const example = name.includes('--') ? name : `${name}--uat`;
    return (
      `${given} is a host: give the sandbox's My Domain alone, the part before ` +
      `.sandbox.my.salesforce.com, as ${example}`
    );
  }
  if (/^[a-z0-9-]+$/.test(given) && !given.includes('--')) {
    return `${given} is production's My Domain: a sandbox's is ${given}--<its name>, as ${given}--uat`;
  }
  return (
    "A sandbox's My Domain is lower-case letters, digits and dashes, then -- and the sandbox's " +
    'name, as acme--uat'
  );
}

/**
 * A sandbox by its My Domain, which a refresh keeps where it changes the
 * Organization Id: `{ myDomain: acme--uat }`, the name alone, never a host
 * and never production's.
 */
const myDomainEntrySchema = strictObject('a My Domain', {
  myDomain: z
    .string()
    .max(80)
    .regex(SANDBOX_MY_DOMAIN, { error: (issue) => myDomainRefusal(String(issue.input)) }),
});

/**
 * An org of `targets`: its Organization Id, or a sandbox's My Domain. A My
 * Domain written where an Id goes is told how to be written.
 */
const targetOrgSchema = z.union(
  [
    z.string().regex(/^00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/, {
      error: (issue) => {
        const given = String(issue.input);
        const example = SANDBOX_MY_DOMAIN.test(given) ? given : 'acme--uat';
        return (
          `${given} is no Organization Id: list an org by its Id (00D…, 15 or 18 characters), ` +
          `or a sandbox by its My Domain, as { myDomain: ${example} }`
        );
      },
    }),
    myDomainEntrySchema,
  ],
  {
    error:
      'An org is listed by its Organization Id (00D…), or a sandbox by its My Domain, as ' +
      '{ myDomain: acme--uat }',
  },
);

const targetsSchema = strictObject('targets', {
  kinds: z.array(envTargetKindSchema).min(1).max(3).default(['scratch', 'developer']),
  /**
   * The sandboxes an apply may write to, by Organization Id or by My Domain:
   * a refresh changes the Id, and keeps the My Domain.
   */
  sandboxes: z.array(targetOrgSchema).max(50).default([]),
  /** Orgs refused whatever else says, by Organization Id or by a sandbox's My Domain. */
  protect: z.array(targetOrgSchema).max(50).default([]),
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

/**
 * The most records a checkpoint of the file may be asked to hold: what a
 * checkpoint holds of one object at most, the bound the Checkpoints page
 * holds its Records at most to.
 */
export const ENV_CHECKPOINT_MAX_TOTAL = 1_000_000;

const checkpointSettingsSchema = strictObject('checkpoint', {
  /** Take a checkpoint before the first write; `destroy --rewind` returns to it. */
  before: z.boolean().optional(),
  /** Take one, under this name, once applied; `reset` rewinds to it. */
  after: z.union([z.literal(false), envNameSchema]).optional(),
  ignoreFields: checkpointIgnoredFieldsSchema.optional(),
  /**
   * The records each checkpoint holds at most, all objects together: the
   * take's `--max-total`. A take past its limit was refused with nothing in
   * the file to answer it.
   */
  maxTotal: z.number().int().positive().max(ENV_CHECKPOINT_MAX_TOTAL).optional(),
  /** Objects the checkpoints leave out, by API name: the take's `--exclude-object`. */
  excludeObjects: z.array(apiNameSchema).min(1).max(500).optional(),
}).superRefine((settings, ctx) => {
  const seen = new Set<string>();
  (settings.excludeObjects ?? []).forEach((object, index) => {
    if (seen.has(object)) {
      ctx.addIssue({
        code: 'custom',
        path: ['excludeObjects', index],
        message: `${object} is listed twice: an object is left out once`,
      });
    }
    seen.add(object);
  });
});

// ─── The file: the seed kind ─────────────────────────────────────────────────

/**
 * The most objects one seed resource writes: the bound `seed:execute` holds a
 * template to.
 */
export const ENV_SEED_MAX_OBJECTS = 100;

/**
 * A field rule, as the panel saves it (`seed-config.schema.ts`), held strict.
 * The panel saved a `referenceField` beside `referenceObject` until no run was
 * found to read it: a file copied from one of those still validates, the key
 * saying nothing.
 */
const fieldRuleFileSchema = strictObject('a field rule', {
  ...fieldRuleSchema.shape,
  config: strictObject('a field rule’s config', {
    ...fieldRuleConfigSchema.shape,
    referenceField: z.string().optional(),
  }),
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
 * The resource a relation draws its parents from, and the object of its
 * records it draws: `accounts`, or `accounts.Account`.
 */
const drawnFromSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,62}(?:\.[A-Za-z][A-Za-z0-9_]*)?$/, {
    error:
      'from names a resource of the file, or a resource and the object of its records, as ' +
      'accounts or accounts.Account',
  })
  .max(144);

/**
 * Where a relation's parents come from: the records this resource writes of
 * `object`; with `existing`, records the org already holds; with `from`, the
 * records another resource of the file created, by their ids.
 */
const seedParentsFileSchema = strictObject('a relation’s parents', {
  object: apiNameSchema.optional(),
  existing: strictObject('existing parents', {
    /** A SOQL WHERE condition, without the keyword; held to the SOQL rule where it is checked. */
    where: z.string().min(1).max(2000).optional(),
    limit: z.number().int().positive().max(SEED_RELATION_LIMITS.maxExistingParents),
  }).optional(),
  /** Another resource of the file, whose records of `object` the parents are. */
  from: drawnFromSchema.optional(),
  /** With `from`: the most of those records drawn, the first created first. */
  limit: z.number().int().positive().max(SEED_RELATION_LIMITS.maxExistingParents).optional(),
}).superRefine((parents, ctx) => {
  const [, named] = parents.from?.split('.') ?? [];
  if (parents.object === undefined && named === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['object'],
      message:
        'A relation’s parents name their object: object: Account, or from: <resource>.Account',
    });
  }
  if (parents.object !== undefined && named !== undefined && named !== parents.object) {
    ctx.addIssue({
      code: 'custom',
      path: ['from'],
      message: `from names ${named} records and object names ${parents.object}: keep one of them`,
    });
  }
  if (parents.from !== undefined && parents.existing !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['existing'],
      message:
        'The parents are the records another resource created (from) or records the org holds ' +
        '(existing), not both: keep one',
    });
  }
  if (parents.limit !== undefined && parents.from === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['limit'],
      message: 'limit goes with from: existing parents take their own, under existing',
    });
  }
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

/**
 * The most MB a fit may be held to: the bound the seed's `--fit-within`
 * and the clone's take.
 */
const FIT_WITHIN_MOST_MB = 1_000_000;

/** A fit's `withinMB`: no more than that many MB, whatever the target has left. */
const fitWithinSchema = z.number().positive().max(FIT_WITHIN_MOST_MB);

/**
 * A seed fitted to the target's data storage, as `sandforge seed --fit share`
 * seeds it: the largest share of every count that fits, or of what fits
 * within `withinMB` (`--fit-within`). A forge resource's takes more: see
 * {@link forgeFitSchema}.
 */
const seedFitSchema = z.union(
  [z.literal('share'), strictObject('fit', { withinMB: fitWithinSchema })],
  { error: 'fit is share, or { withinMB: <MB> }' },
);

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
  /**
   * Seed the largest share of every count that fits the target: `share`, or
   * `{ withinMB }`. A seed past the target's storage was refused naming
   * `--fit share`, which the file could not say.
   */
  fit: seedFitSchema.optional(),
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

// ─── The file: the forge kind ────────────────────────────────────────────────

/** A record's id, 15 or 18 characters: the source's, which the file names a long-lived record by. */
const recordIdSchema = z.string().regex(/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/, {
  error: 'A record id is 15 or 18 letters and digits',
});

/**
 * A SOQL condition, written without WHERE, held as the clone holds its
 * `--where`: 512 characters at most, no comment marker and no trailing `;`,
 * which would end the statement it goes into; and never starting with `-`,
 * which a script's line would read as a flag.
 */
const whereClauseSchema = z
  .string()
  .trim()
  .min(1, { error: 'A condition is not empty' })
  .max(512, { error: 'A condition is 512 characters at most, as the clone takes one' })
  .refine((where) => !/--|\/\*|\*\/|;\s*$/.test(where) && !where.startsWith('-'), {
    error:
      'A condition holds no comment marker (--, /*, */), ends with no ; and does not start with -',
  });

/**
 * A path the file names, from the folder it is in: never absolute, never up
 * out of that folder, so the file reads the same in every checkout of the
 * repository and names nothing outside it.
 */
const relativePathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (path) =>
      !/^(?:[\\/]|[A-Za-z]:)/.test(path) && !path.split(/[\\/]/).some((part) => part === '..'),
    { error: 'A path is written from the folder of the file, never absolute and never up with ..' },
  );

/** A bound of a window, as the file writes it: a date, or an instant in UTC to the second. */
const windowBoundSchema = z
  .string()
  .refine((bound) => forgeSampleWindowBound(bound, false) !== undefined, {
    error: 'A bound is a date, as 2025-06-30, or an instant in UTC, as 2025-06-30T12:00:00Z',
  });

/**
 * The dates a sample draws its roots in, as `--fit-window` takes them: of
 * their making (`created`) or their last change (`modified`), from `from`,
 * included, to `to`, a date there taking the whole day, either left out; or
 * the last `lastDays` days, fixed each time the sample is drawn.
 */
const forgeFitWindowFileSchema = strictObject('window', {
  field: z.enum(['created', 'modified']),
  from: windowBoundSchema.optional(),
  to: windowBoundSchema.optional(),
  lastDays: z.number().int().min(1).max(FORGE_SAMPLE_MAX_LAST_DAYS).optional(),
}).superRefine((window, ctx) => {
  const bounded = window.from !== undefined || window.to !== undefined;
  if (!bounded && window.lastDays === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: [],
      message: 'A window gives from, to or both, or lastDays: the last days the roots were made in',
    });
  }
  if (bounded && window.lastDays !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['lastDays'],
      message:
        'lastDays counts back from each draw, and takes no from or to: give one or the other',
    });
  }
  const from = window.from === undefined ? undefined : forgeSampleWindowBound(window.from, false);
  const to = window.to === undefined ? undefined : forgeSampleWindowBound(window.to, true);
  if (from !== undefined && to !== undefined && from >= to) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: 'A window’s from is before its to' });
  }
});

/**
 * A forge resource's sample of the whole org, with `depth: all`, as
 * `sandforge clone --depth all --fit share` draws it: `share`, the sample
 * that fits the org to fill, or the same within `withinMB`, by the seed, the
 * draw, the window, the filters of the roots and the strata given — the
 * `--fit-*` flags of the same names. The seed's `fit` takes `withinMB` alone:
 * a seed draws no root.
 */
const forgeFitSchema = z.union(
  [
    z.literal('share'),
    strictObject('fit', {
      withinMB: fitWithinSchema.optional(),
      seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      draw: z.enum(['uniform', 'recent', 'oldest']).optional(),
      window: forgeFitWindowFileSchema.optional(),
      where: z
        .record(apiNameSchema, whereClauseSchema)
        .refine((where) => Object.keys(where).length <= FORGE_SAMPLE_MAX_ROOT_WHERE, {
          error: `The roots of ${FORGE_SAMPLE_MAX_ROOT_WHERE} objects at most are filtered`,
        })
        .optional(),
      strata: forgeSampleStrataSchema.optional(),
    }),
  ],
  // A value a key of the mapping refuses outright — a draw or a window's
  // field it does not list — fails both shapes, and is said here: the
  // refinements of the mapping say their own words, at their own keys.
  {
    error:
      'fit is share, or a mapping of withinMB, seed, draw (uniform, recent or oldest), window ' +
      '({ field: created or modified, from, to } or { field, lastDays }), where and strata',
  },
);

/**
 * The record a forge resource clones: by its id, for a source that lives on,
 * or by its object and a condition its source answers with exactly one row,
 * read at each plan, for a source made again: the same case of a scratch org
 * made again tomorrow has another id.
 */
const forgeRecordFileSchema = strictObject('a record', {
  id: recordIdSchema.optional(),
  object: apiNameSchema.optional(),
  where: whereClauseSchema.optional(),
}).superRefine((record, ctx) => {
  const byId = record.id !== undefined;
  const byQuery = record.object !== undefined || record.where !== undefined;
  if (byId === byQuery) {
    ctx.addIssue({
      code: 'custom',
      path: [],
      message:
        'A record is named by its id, or by its object and a where its source answers with ' +
        'exactly one row: give one of them',
    });
  } else if (byQuery && (record.object === undefined || record.where === undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: [record.object === undefined ? 'object' : 'where'],
      message: 'A record named by a query gives its object and its where both',
    });
  }
});

/**
 * The records a forge resource clones from a query, each with what the
 * clone of that record would copy, as `sandforge clone --query` clones them:
 * those of `object` its `where` selects, in the order `orderBy` gives — `Id`
 * unless it says otherwise —, `limit` of them at most. The limit is asked: a
 * plan reads the records again each time, and must read the same ones.
 */
const forgeRecordsFileSchema = strictObject('records', {
  object: apiNameSchema,
  where: whereClauseSchema.optional(),
  orderBy: soqlOrderBySchema
    .refine((orderBy) => !orderBy.startsWith('-'), {
      error: 'An ORDER BY does not start with -',
    })
    .optional(),
  limit: z
    .number({
      error: (issue) =>
        issue.input === undefined
          ? `records gives limit, the most records it clones, 1 to ${FORGE_ROOTS_MAX}: each plan reads them again, and must read the same`
          : undefined,
    })
    .int()
    .min(1)
    .max(FORGE_ROOTS_MAX),
});

/** A table a forge resource clones whole, under its condition. */
const forgeTableFileSchema = strictObject('a table', {
  object: apiNameSchema,
  where: whereClauseSchema.optional(),
});

/** An entry of a Forge templates file, as the Template tab saves them, by its id. */
const forgeTemplateRefFileSchema = strictObject('a template', {
  file: relativePathSchema,
  id: z.string().min(1).max(200),
});

/** Forge's anonymization, as a template holds it, held strict. */
const forgeAnonymizeFileSchema = strictObject('anonymize', {
  presetId: z.string().min(1).max(100).optional(),
  rules: forgeAnonymizationRulesSchema,
  fields: z
    .array(
      strictObject('the personal fields of an object', {
        objectApiName: apiNameSchema,
        fieldNames: z.array(apiNameSchema).max(500),
      }),
    )
    .max(2_000)
    .optional(),
});

/** The most tables one forge resource clones, as discovery's graph holds them. */
export const ENV_FORGE_MAX_TABLES = 50;

/**
 * A forge resource's acceptances, reviewed in the file: those every resource
 * takes, and `realData`, which lets a resource clone a production source
 * without anonymizing what it clones.
 */
const forgeAcceptSchema = strictObject('accept', {
  automation: z.boolean().optional(),
  /** Real people's data from a production source, written into the org to fill as read. */
  realData: z.boolean().optional(),
});

export const envForgeResourceSchema = strictObject('a forge resource', {
  kind: z.literal('forge'),
  ...commonResourceShape,
  accept: forgeAcceptSchema.optional(),
  /** The org role it clones from: a key of the file's orgs, never the target. */
  source: envNameSchema,
  /** One record and what discovery reaches from it. */
  record: forgeRecordFileSchema.optional(),
  /** The records a query chooses, each with what the clone of that record would copy. */
  records: forgeRecordsFileSchema.optional(),
  /** Whole tables, the first the one discovery starts from. */
  tables: z.array(forgeTableFileSchema).min(1).max(ENV_FORGE_MAX_TABLES).optional(),
  /** A template the Template tab saved: its decisions, exclusions, filters and mappings. */
  template: forgeTemplateRefFileSchema.optional(),
  /** A walk's depth, or `all`: the whole org, from no record, no table and no template. */
  depth: forgeRunDepthSchema.optional(),
  /**
   * With `depth: all`, a sample of the whole org that fits the target:
   * `share`, or `{ withinMB, seed, draw, window, where, strata }`.
   */
  fit: forgeFitSchema.optional(),
  customDepth: z.number().int().positive().max(10).optional(),
  maxNodes: z.number().int().min(10).max(500).optional(),
  anonymize: forgeAnonymizeFileSchema.optional(),
  keepContactPoints: z.boolean().optional(),
  /** The most records a run of it may write; each run is held to its plan's count below it. */
  maxTotal: z.number().int().positive().max(1_000_000).optional(),
}).superRefine((resource, ctx) => {
  if (resource.depth === 'all') {
    // The clone of the whole org starts from nothing a walk starts from, and
    // takes what a walk alone takes nowhere: refused by key, as the clone's
    // own line refuses each flag.
    const notWithAll: Array<[keyof typeof resource, string]> = [
      ['record', 'it starts from no record'],
      ['records', 'it starts from no query; a sample of it filters its roots with fit: { where }'],
      ['tables', 'it starts from no table'],
      [
        'template',
        'a template holds the choices of a walk from its record or query; ' +
          'sandforge clone --depth all takes them from --config',
      ],
      ['customDepth', 'it walks no depth'],
      ['maxNodes', 'it takes every object it can'],
    ];
    for (const [key, why] of notWithAll) {
      if (resource[key] === undefined) continue;
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `depth: all clones the whole org, and does not go with ${key}: ${why}`,
      });
    }
    const anonymize = resource.anonymize;
    if (
      anonymize !== undefined &&
      (Object.keys(anonymize.rules).length > 0 ||
        anonymize.fields !== undefined ||
        anonymize.presetId !== undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['anonymize'],
        message:
          'depth: all anonymizes every personal field by its category’s default method, the ' +
          'clone of the whole org taking no other: give anonymize: { rules: {} }',
      });
    }
    return;
  }
  if (resource.fit !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['fit'],
      message:
        'fit goes with depth: all: it copies a sample of the whole org that fits the target. ' +
        'A clone of a record or of tables writes what it reaches',
    });
  }
  const starts = (['record', 'records', 'tables'] as const).filter(
    (key) => resource[key] !== undefined,
  );
  if (starts.length !== 1) {
    ctx.addIssue({
      code: 'custom',
      path: [],
      message:
        'A forge resource clones one record (record), the records a query chooses (records), ' +
        'whole tables (tables) or the whole org (depth: all): give one of them',
    });
  }
  const seen = new Set<string>();
  (resource.tables ?? []).forEach((table, index) => {
    if (seen.has(table.object)) {
      ctx.addIssue({
        code: 'custom',
        path: ['tables', index, 'object'],
        message: `${table.object} is listed twice: a table is listed once, with its condition`,
      });
    }
    seen.add(table.object);
  });
  if (resource.customDepth !== undefined && (resource.depth ?? 'custom') !== 'custom') {
    ctx.addIssue({
      code: 'custom',
      path: ['customDepth'],
      message: `customDepth goes with depth: custom, not depth: ${resource.depth ?? ''}`,
    });
  }
});

// ─── The file: the frozen kind ───────────────────────────────────────────────

/**
 * A path on the machine that runs the command, from its root: a dataset, or
 * a checkpoint file, sits outside the project's repository, where a pipeline
 * downloads it, so it is never named from the file's folder.
 *
 * @param error - What the refusal says, naming the thing and the way.
 */
function absolutePathOf(error: string) {
  return z
    .string()
    .min(1)
    .max(4_096)
    .refine((path) => /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path), { error });
}

const absolutePathSchema = absolutePathOf(
  'A dataset is named by its path from the root, as /data/claims, or by { env: NAME }: it ' +
    'lives outside the repository',
);

/** A dataset's version, as its manifest stamps it. */
const datasetVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/, {
  error: 'A dataset’s version is the one its manifest says, as 1.4.0',
});

/**
 * A dataset's digest, as `sandforge frozen --json` gives it: `sha256:` and 64
 * hexadecimal digits, over the files a load reads.
 */
const datasetDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/, {
  error: 'A dataset’s digest is sha256: and 64 hexadecimal digits, as sandforge frozen gives it',
});

export const envFrozenResourceSchema = strictObject('a frozen resource', {
  kind: z.literal('frozen'),
  ...commonResourceShape,
  /** The Frozen configuration, committed with the project: it holds no record. */
  config: relativePathSchema,
  /** The dataset a person froze beforehand, pinned by its version and its digest. */
  dataset: strictObject('a dataset', {
    path: z.union([absolutePathSchema, envRefSchema], {
      error: 'A dataset is named by its path from the root, or by { env: NAME }',
    }),
    version: datasetVersionSchema,
    digest: datasetDigestSchema,
  }),
});

// ─── The file: masking sets and the mask kind ────────────────────────────────

/**
 * A rule of a masking set, as the DataOps panel saves a template's rule: the
 * `Object.Field` it masks, the method a DataOps run masks it by, and the
 * settings that method takes. Its keys are held strict here; the set is then
 * held to the schema the panel's save goes through, which refuses a setting a
 * method does not take and a field given two rules.
 */
const maskingRuleFileSchema = strictObject('a masking rule', {
  fieldPattern: savedTemplateRuleSchema.shape.fieldPattern,
  ruleType: savedTemplateRuleSchema.shape.ruleType,
  config: strictObject(
    'a masking rule’s config',
    savedTemplateRuleSchema.shape.config.unwrap().shape,
  ).optional(),
});

/** A named set of DataOps rules, as `sandforge dataops --rules` takes them: what mask resources name. */
const maskingSetFileSchema = strictObject('a rule set', {
  rules: z
    .array(maskingRuleFileSchema)
    .min(1, { error: 'A rule set holds one rule at least' })
    .max(TEMPLATE_MAX_RULES),
});

/**
 * The fewest records a mask resource's `maxRecords` gives a snapshot: the
 * least `sandforge.backup.maxRecordsPerObject` takes, which the script
 * raises a smaller `--max-records` to.
 */
const MASK_MIN_RECORDS = 100;

/** The most requests a mask resource's `maxRequests` gives, as `--max-requests` takes them. */
const MASK_MAX_REQUESTS = 1_000_000_000;

/** A DataOps template that ships, by its id. */
const maskTemplateFileSchema = strictObject('a template that ships', {
  template: z.string().regex(/^tpl-[a-z0-9-]{1,60}$/, {
    error: 'A template that ships is named by its id, as tpl-gdpr-standard',
  }),
});

/**
 * Records the org already holds — a sandbox copied from production — masked
 * by DataOps: the rules of a set of the file's `masking`, or of a template
 * that ships; one object and the records its condition selects, or every
 * object those rules mask.
 */
export const envMaskResourceSchema = strictObject('a mask resource', {
  kind: z.literal('mask'),
  ...commonResourceShape,
  /** The DataOps rules it masks with: a set of the file's masking, by its name, or a template that ships. */
  rules: z.union([envNameSchema, maskTemplateFileSchema], {
    error:
      'rules names a set of the file’s masking, as rules: gdpr-contacts, or a template that ' +
      'ships, as rules: { template: tpl-gdpr-standard }',
  }),
  /** The object it masks; without it, every object its rules mask. */
  object: apiNameSchema.optional(),
  /** With `object`: the records it masks, a SOQL condition without WHERE. */
  where: whereClauseSchema.optional(),
  /** Mask in slices of `maxRecords` records, each backed up just before it is masked: `--slices`. */
  slices: z.boolean().optional(),
  /**
   * The most records of an object its snapshot holds, a slice's with
   * `slices`: `--max-records`, held within what `sandforge.backup.maxRecordsPerObject`
   * takes.
   */
  maxRecords: z
    .number()
    .int({ error: 'maxRecords is a whole number of records' })
    .min(MASK_MIN_RECORDS)
    .max(BACKUP_MAX_RECORDS_PER_OBJECT)
    .optional(),
  /** With `slices`: the most requests a run sends, `--max-requests`. */
  maxRequests: z
    .number()
    .int({ error: 'maxRequests is a whole number of requests' })
    .positive()
    .max(MASK_MAX_REQUESTS)
    .optional(),
}).superRefine((resource, ctx) => {
  if (resource.where !== undefined && resource.object === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['where'],
      message: 'where filters the records of one object: give it with object',
    });
  }
  // A bound on requests stops a run between two slices: a run of the whole
  // object has none to stop between, and the script refuses it.
  if (resource.maxRequests !== undefined && resource.slices !== true) {
    ctx.addIssue({
      code: 'custom',
      path: ['maxRequests'],
      message: 'maxRequests bounds a masking in slices: give it with slices: true',
    });
  }
});

// ─── The file: the users kind ────────────────────────────────────────────────

/**
 * What a users resource answers a key that would reset a password: the
 * product resets none, and the owner of an address asked back gets their own
 * once they have confirmed it. Never said restored: the address stays under
 * `.invalid` until its owner clicks the link Salesforce sends.
 */
const NO_PASSWORD_RESET =
  'SandForge resets no password; once its owner has confirmed the address asked back, they ask ' +
  'Salesforce for one with Forgot your password?';

/** One user of a users resource: who, by username, and what it is set up with. */
const usersUserFileSchema = strictObject(
  'a user of a users resource',
  { username: usersUsernameSchema, ...usersSettingsShape },
  { login: NO_PASSWORD_RESET },
);

/**
 * The users of a sandbox handed back to its testers — an address the copy
 * put under `.invalid` restored, a user activated, frozen or unfrozen, a
 * profile, permission sets, groups of them, groups and queues — set up by
 * `sandforge users`, before every other resource of the file and taken back
 * after them all. It takes no `dependsOn`, and none names it: a replay keeps
 * a record's owner only where that user is active, so the users come first
 * whatever the file says.
 */
export const envUsersResourceSchema = strictObject(
  'a users resource',
  {
    kind: z.literal('users'),
    accept: commonResourceShape.accept,
    /** What every user is set up with unless it says otherwise, its key replacing theirs. */
    defaults: strictObject('the defaults of a users resource', usersSettingsShape, {
      login: NO_PASSWORD_RESET,
    }).optional(),
    users: usersListSchema(usersUserFileSchema),
  },
  { dependsOn: 'a users resource is applied first, before every other, and depends on none' },
);

// ─── The file: the replay kind ───────────────────────────────────────────────

/** The checkpoint id `checkpoint list` gives: `ck-20261114-174750-5e38`. */
const replayCheckpointIdSchema = z.string().regex(/^ck-\d{8}-\d{6}-[a-z0-9]{4}$/, {
  error: (issue) =>
    `${String(issue.input)} is no checkpoint id (ck-YYYYMMDD-HHMMSS-xxxx, as sandforge ` +
    `checkpoint list gives it): a checkpoint is named so with name: ${String(issue.input)}`,
});

/** A checkpoint's name, as `checkpoint take --name` gave it: one line, not read as a flag. */
const replayCheckpointNameSchema = checkpointNameSchema.refine((name) => !name.startsWith('-'), {
  error: 'A checkpoint name does not start with -, which a command line reads as a flag',
});

/** A checkpoint file's path from the root, or the variable that holds it. */
const replayCheckpointFileSchema = z.union(
  [
    absolutePathOf(
      'A checkpoint file is named by its path from the root, as /runner/work/uat.sfcheckpoint, ' +
        'or by { env: NAME }: it holds records, and lives outside the repository',
    ),
    envRefSchema,
  ],
  { error: 'A checkpoint file is named by its path from the root, or by { env: NAME }' },
);

/**
 * The letters of a checkpoint file's key, as `checkpoint export` prints it
 * without its dashes: 52 of base32. A name of that shape is the key written
 * where its variable's name goes.
 */
const ARCHIVE_KEY_LETTERS = /^[A-Z2-7]{52}$/;

/**
 * The name of the variable that holds a checkpoint file's key: a name, never
 * `{ env }` and never the key, which the file does not hold.
 */
const keyEnvSchema = z
  .string({
    error: (issue) =>
      issue.input !== null && typeof issue.input === 'object'
        ? 'keyEnv is the name of the variable that holds the key, as keyEnv: ' +
          'UAT_CHECKPOINT_KEY, not { env: … }'
        : undefined,
  })
  .regex(/^[A-Z_][A-Z0-9_]{0,127}$/, {
    error:
      'A variable is named in upper-case letters, digits and underscores, as UAT_CHECKPOINT_KEY',
  })
  .refine((name) => !ARCHIVE_KEY_LETTERS.test(name), {
    error:
      'this is shaped like the key itself: keyEnv names the variable that holds it, and the ' +
      'file holds no secret',
  });

/**
 * The checkpoint a replay resource replays, by one of three forms: its `id`,
 * kept on this machine; its `name`, the newest of that name taken of this
 * sandbox before its refresh, or of the org role `from` names; or a `file`
 * exported with `sandforge checkpoint export`, opened with the key of the
 * variable `keyEnv` names.
 */
const replayCheckpointRefSchema = strictObject('a checkpoint', {
  id: replayCheckpointIdSchema.optional(),
  name: replayCheckpointNameSchema.optional(),
  file: replayCheckpointFileSchema.optional(),
  keyEnv: keyEnvSchema.optional(),
}).superRefine((checkpoint, ctx) => {
  const byFile = checkpoint.file !== undefined || checkpoint.keyEnv !== undefined;
  const forms = [checkpoint.id !== undefined, checkpoint.name !== undefined, byFile];
  if (forms.filter(Boolean).length !== 1) {
    ctx.addIssue({
      code: 'custom',
      path: [],
      message: 'give id, name, or file with keyEnv: one of them',
    });
    return;
  }
  if (checkpoint.file !== undefined && checkpoint.keyEnv === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['keyEnv'],
      message:
        'a checkpoint file is read with the key the variable keyEnv names: give keyEnv, as ' +
        'keyEnv: UAT_CHECKPOINT_KEY',
    });
  }
  if (checkpoint.keyEnv !== undefined && checkpoint.file === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['keyEnv'],
      message: 'keyEnv goes with file, the checkpoint file it opens',
    });
  }
});

/** Objects of a replay, by API name, each once. */
function replayObjectsSchema() {
  return z
    .array(apiNameSchema)
    .min(1)
    .max(500)
    .superRefine((objects, ctx) => {
      const seen = new Set<string>();
      objects.forEach((object, index) => {
        const key = object.toLowerCase();
        if (seen.has(key)) {
          ctx.addIssue({
            code: 'custom',
            path: [index],
            message: `${object} is listed twice: an object is listed once`,
          });
        }
        seen.add(key);
      });
    });
}

/**
 * A checkpoint replayed into the org by `sandforge checkpoint replay` — the
 * records a sandbox held before its refresh, or those of another org's
 * checkpoint —, its choices each under its flag's name, and taken back by
 * the replay's own removal.
 */
export const envReplayResourceSchema = strictObject('a replay resource', {
  kind: z.literal('replay'),
  ...commonResourceShape,
  checkpoint: replayCheckpointRefSchema,
  /** With `checkpoint.name`: the org role the checkpoint of that name was taken of. */
  from: envNameSchema.optional(),
  /** `--objects`: the objects replayed, the checkpoint's others left out. */
  objects: replayObjectsSchema().optional(),
  /** `--exclude-object`: the objects left out. */
  excludeObjects: replayObjectsSchema().optional(),
  /** `--owners`: each record keeps its owner where that user is active, or goes to the user connected. */
  owners: z
    .enum(['same', 'me'], {
      error:
        'owners is same, each record keeping its owner where that user is active, or me, the ' +
        'user connected',
    })
    .optional(),
  /** `--custom-settings`: the custom settings' records too. */
  customSettings: z.boolean().optional(),
  /** `--mask`: the personal fields masked as they are written. */
  mask: z.boolean().optional(),
  /** `--keep-contact-points`: emails and phone numbers written as the checkpoint holds them. */
  keepContactPoints: z.boolean().optional(),
  /** `--max-records`: the most records it may create. */
  maxRecords: z.number().int().positive().max(ENV_CHECKPOINT_MAX_TOTAL).optional(),
}).superRefine((resource, ctx) => {
  if (resource.from !== undefined && resource.checkpoint.name === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['from'],
      message:
        'from goes with checkpoint: { name }: it names the org role the checkpoint of that name ' +
        'was taken of',
    });
  }
});

/** Kinds that come with a later version of the file. */
const LATER_KINDS: readonly string[] = [];

/** The kinds this version applies, as a refusal names them. */
const KINDS_APPLIED = 'seed, forge, frozen, mask, users and replay resources';

/** A resource of the file, told apart by its `kind`. */
export const envResourceSchema = z.discriminatedUnion(
  'kind',
  [
    envSeedResourceSchema,
    envForgeResourceSchema,
    envFrozenResourceSchema,
    envMaskResourceSchema,
    envUsersResourceSchema,
    envReplayResourceSchema,
  ],
  {
    error: (issue) => {
      const input = issue.input;
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return 'A resource is a mapping of keys, starting with its kind: kind: seed';
      }
      const kind = (input as Record<string, unknown>)['kind'];
      if (kind === undefined) return 'A resource says its kind: kind: seed';
      if (typeof kind === 'string' && LATER_KINDS.includes(kind)) {
        return `Resources of kind ${kind} come with a later SandForge: this one applies ${KINDS_APPLIED}`;
      }
      return `"${String(kind)}" is not a kind of resource: this SandForge applies ${KINDS_APPLIED}`;
    },
  },
);

// ─── The file: the audits ────────────────────────────────────────────────────

/** A host name, as a URL holds it between its scheme and its path. */
const HOST_NAME =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** A host name, which an answer names a URL's or an org's host by. */
const hostSchema = z.string().max(253).regex(HOST_NAME, { error: 'Not a host name' });

/** The most production hosts, and the most fields, a file names to the endpoints audit. */
const AUDIT_MOST_NAMES = 50;

/**
 * Names each once, whatever their case: the second time one is given is
 * refused where it stands. The bound is checked here rather than by `max`,
 * whose refusal inside `endpoints`, `true` or a mapping, zod reports as
 * neither shape matching instead of naming the list.
 */
function onceEach(
  names: readonly string[],
  ctx: z.core.$RefinementCtx,
  what: string,
  bound: string,
): void {
  if (names.length > AUDIT_MOST_NAMES) {
    ctx.addIssue({ code: 'custom', path: [], message: bound });
    return;
  }
  const seen = new Set<string>();
  names.forEach((name, index) => {
    const key = name.toLowerCase();
    if (seen.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: [index],
        message: `${name} is listed twice: ${what} is listed once`,
      });
    }
    seen.add(key);
  });
}

/** A production host, as the file names one: the host alone, which a URL given is told down to. */
const productionHostSchema = z
  .string()
  .max(253)
  .regex(HOST_NAME, {
    error: (issue) => {
      const given = String(issue.input);
      const host = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:@\s]+)/i.exec(given)?.[1] ?? 'erp.acme.com';
      return (
        `${given} is no host name: write the host alone, without https:// nor a path, as ` +
        host.toLowerCase()
      );
    },
  });

/**
 * A field that holds a URL, of a Custom Metadata Type or a Custom Setting,
 * named with it: a custom field of an object whose API name ends in `__mdt`,
 * or in `__c` for a Custom Setting, which only the org tells from another
 * custom object.
 */
const endpointFieldSchema = z
  .string()
  .max(161)
  .regex(/^[A-Za-z][A-Za-z0-9_]*__(?:mdt|c)\.[A-Za-z][A-Za-z0-9_]*__c$/, {
    error: (issue) =>
      `${String(issue.input)} is no field of a Custom Metadata Type (__mdt) or a Custom ` +
      'Setting named with it: write Object.Field, as Integration_Setting__mdt.Endpoint__c',
  });

/**
 * What the endpoints audit reads beside what SandForge deduces of the
 * production the sandbox was copied from: its other hosts, and the fields
 * that hold a URL.
 */
const auditEndpointsSchema = strictObject('endpoints', {
  /** Production's hosts beside those deduced from the sandbox's: the ERP, the middleware. */
  productionHosts: z
    .array(productionHostSchema)
    .superRefine((hosts, ctx) =>
      onceEach(
        hosts,
        ctx,
        'a host',
        `${AUDIT_MOST_NAMES} hosts at most: SandForge deduces production’s own from the sandbox`,
      ),
    )
    .optional(),
  /** Fields of Custom Metadata Types or Custom Settings that hold a URL, as `Object.Field`. */
  fields: z
    .array(endpointFieldSchema)
    .superRefine((fields, ctx) =>
      onceEach(
        fields,
        ctx,
        'a field',
        `${AUDIT_MOST_NAMES} fields at most: the audit reads each object they are of, a request each`,
      ),
    )
    .optional(),
});

/**
 * The audits an apply reads once it wrote, and `env audit` reads at any
 * time: the scheduled jobs, the endpoints that still name production, and the
 * handoff note an apply writes. Each reads and writes nothing in the org.
 */
const auditsSchema = strictObject('audits', {
  /** The scheduled jobs, against the inventory `env audit --save` kept before the refresh. */
  schedules: z.boolean().optional(),
  /** The Named Credentials, Remote Sites and fields that still name production: `true`, or what to read beside. */
  endpoints: z
    .union([z.boolean(), auditEndpointsSchema], {
      error: 'endpoints is true, or a mapping of productionHosts and fields',
    })
    .optional(),
  /** A note of what the apply did and what is left to do, written once it ends. */
  handoff: z.boolean().optional(),
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
  /** Named sets of DataOps rules, which mask resources name. */
  masking: z.record(envKeySchema, maskingSetFileSchema).default({}),
  resources: z.record(envKeySchema, envResourceSchema, {
    error: (issue) =>
      issue.input === undefined ? 'The file names no resources: write resources:' : undefined,
  }),
  /** The audits read once applied, and by `env audit`. */
  audits: auditsSchema.optional(),
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
  // The org a forge resource clones from, and the org a replay's checkpoint
  // was taken of, are named by a role the file declares, its alias given
  // there or on the line: never by an alias of their own, which a pipeline
  // could not point at another org.
  const roles = Object.keys(file.orgs);
  for (const [name, resource] of Object.entries(file.resources)) {
    const named =
      resource.kind === 'forge'
        ? { key: 'source', role: resource.source }
        : resource.kind === 'replay' && resource.from !== undefined
          ? { key: 'from', role: resource.from }
          : undefined;
    if (named === undefined || roles.includes(named.role)) continue;
    ctx.addIssue({
      code: 'custom',
      path: ['resources', name, named.key],
      message:
        `"${named.role}" is no org role of the file: declare it under orgs, as ` +
        `orgs: { ${named.role}: { alias: { env: … } } }` +
        (roles.length > 0 ? ` (its roles are ${roles.join(', ')})` : ''),
    });
  }
  // A users resource is applied before every other and taken back after them
  // all, whatever the file says: a dependsOn naming one would say an order
  // that is not kept, and a relation drawing from one draws from no record.
  const users = Object.entries(file.resources).filter(([, resource]) => resource.kind === 'users');
  const usersNames = new Set(users.map(([name]) => name));
  for (const [name, resource] of Object.entries(file.resources)) {
    if (resource.kind === 'users') continue;
    for (const other of resource.dependsOn ?? []) {
      if (!usersNames.has(other)) continue;
      ctx.addIssue({
        code: 'custom',
        path: ['resources', name, 'dependsOn'],
        message: `${other} is a users resource, applied first whatever the file says: take it out of dependsOn`,
      });
    }
    if (resource.kind !== 'seed') continue;
    (resource.relations ?? []).forEach((relation, index) => {
      const from = relation.parents.from?.split('.')[0];
      if (from === undefined || !usersNames.has(from)) return;
      ctx.addIssue({
        code: 'custom',
        path: ['resources', name, 'relations', index, 'parents', 'from'],
        message: `${from} is a users resource: it creates no record to draw parents from`,
      });
    });
  }
  // A user is named once in the file, all its users resources together: two
  // entries would each set the same user up their own way, and a removal of
  // one would undo what the other did.
  for (const { path, message } of usernamesTwice(
    users.map(([name, resource]) => ({
      at: `resources.${name}.users`,
      path: ['resources', name, 'users'],
      users: resource.kind === 'users' ? resource.users : [],
    })),
  )) {
    ctx.addIssue({ code: 'custom', path, message });
  }
  // A mask resource names its rules by a set the file declares, as a forge
  // resource names its source by a role.
  const sets = Object.keys(file.masking);
  for (const [name, resource] of Object.entries(file.resources)) {
    if (resource.kind !== 'mask' || typeof resource.rules !== 'string') continue;
    if (sets.includes(resource.rules)) continue;
    ctx.addIssue({
      code: 'custom',
      path: ['resources', name, 'rules'],
      message:
        `"${resource.rules}" is no rule set of the file: declare it under masking, as ` +
        `masking: { ${resource.rules}: { rules: [ … ] } }` +
        (sets.length > 0 ? ` (its sets are ${sets.join(', ')})` : ''),
    });
  }
  // A checkpoint taken before the first write holds the values a masking then
  // writes over, in clear, and destroy --rewind writes them back: it would
  // unmask what destroy never unmasks.
  const masks = Object.entries(file.resources).filter(([, resource]) => resource.kind === 'mask');
  if (file.checkpoint?.before === true && masks.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['checkpoint', 'before'],
      message:
        'A checkpoint before the first write holds, in clear, the values the mask resources ' +
        `(${masks.map(([name]) => name).join(', ')}) write over, and destroy --rewind would ` +
        'put them back into the org: a file with a mask resource takes none. Take ' +
        'checkpoint.before out',
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

export const envResourceKindSchema = z.enum(['seed', 'forge', 'frozen', 'mask', 'users', 'replay']);

/**
 * The script that applies, refreshes and destroys each kind of resource: a
 * replay's is the checkpoint script, which replays and takes a replay back.
 */
export const envScriptSchema = z.enum([
  'sandforge-seed',
  'sandforge-clone',
  'sandforge-frozen',
  'sandforge-dataops',
  'sandforge-users',
  'sandforge-checkpoint',
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
  /** A masking's: the records it went through, masked or holding nothing to mask. */
  masked: countSchema.optional(),
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
  /** Taken back whole by a removal: a later removal of the resource skips it. */
  takenBack: z.literal(true).optional(),
});

/**
 * The fingerprint of a resource whose state `state recover` rebuilt from its
 * run files: none of them says what the resource was applied from, and a
 * fingerprint read back from the file as it stands now would declare kept
 * an environment written from another one. No sha256 of a resource is
 * this one, so the next plan replaces it.
 */
export const RECOVERED_FINGERPRINT = '0'.repeat(64);

export const envResourceStateSchema = z
  .strictObject({
    kind: envResourceKindSchema,
    fingerprint: sha256Schema,
    dependsOn: z.array(envNameSchema).max(50),
    status: envResourceStatusSchema,
    /** The last is current; earlier ones are runs a replace took back. */
    runs: z.array(envRunSchema).max(1_000),
    /**
     * Rebuilt by `state recover` from its run files, its fingerprint
     * {@link RECOVERED_FINGERPRINT}: the next plan replaces it, and its next
     * run writes the resource whole again, without the mark.
     */
    recovered: z.literal(true).optional(),
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
    /**
     * The host the org answered on, its My Domain's: a refresh keeps it and
     * changes the Organization Id, so a state of another Id under the same
     * host proves the org refreshed. A state written before 1.82 has none,
     * and proves nothing.
     */
    host: hostSchema.optional(),
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
  /**
   * `wouldCreate` is the most it writes, not its count: its records hang from
   * records a resource that runs first in the same apply writes, which its
   * dry run could not read.
   */
  atMost: z.literal(true).optional(),
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
  /**
   * The emails Salesforce sends to people as a users resource is applied —
   * the link of each address asked back —, which no daily limit counts and
   * only the line accepts.
   */
  emailsToPeople: countSchema.optional(),
});

/**
 * A relation whose parents are the records another resource created: how many
 * there are, once that resource has run; absent while it runs in the same
 * apply, before which nobody knows.
 */
const envActionDrawSchema = z.strictObject({
  lookup: lookupSchema,
  from: envNameSchema,
  object: apiNameSchema,
  parents: countSchema.optional(),
});

/**
 * The codes of what refused, each as the script or the command that refused
 * names it — `AUTOMATION_NOT_ACCEPTED`, `LOCKED` —, beside a refusal said in
 * words: a pipeline read the code of a destroy's refusal on stderr alone.
 */
const envRefusalCodesSchema = z.array(z.string().min(1).max(64)).min(1).max(50);

export const envActionSchema = z.strictObject({
  resource: envNameSchema,
  kind: envResourceKindSchema,
  action: envActionKindSchema,
  /** Why, in a sentence: "replaced: its objects changed in the file". */
  why: z.string().min(1).max(4_000),
  objects: z.array(envPlanObjectSchema).max(1_000),
  /** The relations whose parents another resource created. */
  draws: z.array(envActionDrawSchema).max(100).optional(),
  gates: envActionGatesSchema.optional(),
  /** What refuses a blocked action. */
  refusal: z.string().min(1).max(2_000).optional(),
  /** The codes of what `refusal` says, where its scripts give them. */
  refusalCodes: envRefusalCodesSchema.optional(),
  /** What the plan says of it beside why: a production source's data, and what is done to it. */
  notes: z.array(z.string().min(1).max(2_000)).max(20).optional(),
  /** A users resource's: each user, its address as read, and what applying would change. */
  users: z.array(usersPlanUserSchema).max(USERS_MAX).optional(),
});

/** A checkpoint of the environment's lifecycle: taken before the first write, or once applied. */
export const envCheckpointStepSchema = z.enum(['before', 'after']);

/** A refusal the checkpoint script gives, in its own code and words. */
const envCheckpointRefusalSchema = z.strictObject({
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(4_000),
});

/** A checkpoint an apply takes, as its plan says it, with the checkpoint script's estimate. */
const envPlanCheckpointSchema = z.strictObject({
  step: envCheckpointStepSchema,
  name: z.string().min(1).max(255),
  estimate: z
    .strictObject({
      records: countSchema,
      apiRequests: countSchema,
      seconds: z.number().nonnegative(),
      bytes: countSchema,
    })
    .optional(),
  /** What refuses it now: a refusal refuses the apply before its first write. */
  refusal: envCheckpointRefusalSchema.optional(),
  /** Why it was not estimated: --quick, or the script gave no answer. */
  unread: z.string().min(1).max(4_000).optional(),
});

/** The whole org against the checkpoint taken after the last apply, as its own preview reads it. */
const envPlanDriftSchema = z.strictObject({
  checkpoint: checkpointIdSchema,
  differs: z.boolean(),
  toDelete: countSchema.optional(),
  toGiveBack: countSchema.optional(),
  toBringBack: countSchema.optional(),
  /** Why the org could not be compared with it: never taken for one that does not differ. */
  unread: z.string().min(1).max(4_000).optional(),
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
  /**
   * The emails Salesforce would send to people, all users resources
   * together, and whether the line accepted them (`--accept-user-emails`).
   * Absent from a plan made before 1.82.
   */
  emailsToPeople: z.strictObject({ count: countSchema, accepted: z.boolean() }).optional(),
});

/**
 * The state of this environment this machine kept under another Organization
 * Id of the same host: the org was refreshed since, and the apply starts
 * anew. That state is set aside, kept, never deleted.
 */
const envPlanRefreshedSchema = z.strictObject({
  organizationId: checkpointOrganizationIdSchema,
  serial: countSchema,
  updatedAt: instantSchema,
  /** Where it is kept, set aside. */
  setAside: z.string().min(1).max(4_096),
});

export const envPlanSchema = z.strictObject({
  env: envNameSchema,
  org: z.strictObject({
    organizationId: checkpointOrganizationIdSchema,
    kind: envTargetKindSchema,
    alias: z.string().min(1).max(255).optional(),
    /** The host the org answers on, its My Domain's. */
    host: hostSchema.optional(),
  }),
  state: z.strictObject({
    found: z.boolean(),
    serial: countSchema.optional(),
    /** With no state for this Id: the state of the same org before its refresh. */
    refreshed: envPlanRefreshedSchema.optional(),
  }),
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
  /** The checkpoints an apply takes, in the order it takes them. */
  checkpoints: z.array(envPlanCheckpointSchema).max(2).optional(),
  /** The whole org against the checkpoint taken after the last apply. */
  drift: envPlanDriftSchema.optional(),
  /** What a real apply would meet now. */
  refusal: z.string().min(1).max(2_000).optional(),
  /** The codes of what `refusal` says, where its scripts give them. */
  refusalCodes: envRefusalCodesSchema.optional(),
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
  /** A masking's: the records it masked, or left masked once destroyed. */
  masked: countSchema.optional(),
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
  /** What refused or failed the step, in its script's own words. */
  refusal: z.string().min(1).max(4_000).optional(),
});

/** A checkpoint taken or deleted by an apply or a destroy, and how the checkpoint script ended it. */
export const envCheckpointStepResultSchema = z.strictObject({
  step: z.enum(['before', 'after', 'delete']),
  checkpoint: checkpointIdSchema.optional(),
  exitCode: z.number().int().min(0).max(255),
  /** What refused or failed it, in the checkpoint script's words. */
  refusal: z.string().min(1).max(4_000).optional(),
  /** The checkpoint script's own `--json` answer, as it gave it. */
  answer: z.unknown().optional(),
});

// ─── What the audits read ────────────────────────────────────────────────────

/** Why an audit did not read: never taken for one that found nothing. */
const auditUnreadSchema = z.string().min(1).max(2_000);

/**
 * A URL as an audit names it: its scheme, its host and its path, and nothing
 * else. A URL's query may carry a key, and its authority a user and a
 * password: neither is ever printed, kept or answered.
 */
const auditUrlSchema = z
  .string()
  .max(2_048)
  .regex(/^[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]+(?:\/[^\s?#]*)?$/, {
    error: 'A URL is named by its scheme, its host and its path alone: no query, no credentials',
  });

/**
 * Whether the org delivers email, as the reservation probe reads it: open,
 * All email; closed, System email only or No access, which no API tells
 * apart.
 */
const auditDeliverabilitySchema = z.strictObject({
  read: z.enum(['open', 'closed']).optional(),
  unread: auditUnreadSchema.optional(),
});

/** A scheduled job as the audit names it: never by its owner's address. */
const auditJobSchema = z.strictObject({
  /**
   * `gone`, in the inventory before and not now; `frozen` or `inactive`, run
   * as a user who can no longer; `new`, not in the inventory before.
   */
  status: z.enum(['gone', 'frozen', 'inactive', 'new']),
  /** `CronJobDetail.Name`. */
  name: z.string().min(1).max(255),
  /** Its type, as Setup names it: Scheduled Apex, Batch Job… */
  type: z.string().min(1).max(80),
  cronExpression: z.string().min(1).max(255).optional(),
  /** The username of the user it runs as. */
  owner: z.string().min(1).max(255).optional(),
  nextFireTime: instantSchema.optional(),
});

/** The scheduled jobs, against the inventory kept before the refresh when there is one. */
const auditSchedulesSchema = z.strictObject({
  /** The jobs the org holds now. */
  now: countSchema,
  /**
   * The inventory compared against: the newest `env audit --save` kept of the
   * same host, and whether it is of another Organization Id — the sandbox
   * before its refresh.
   */
  against: z
    .strictObject({
      savedAt: instantSchema,
      organizationId: checkpointOrganizationIdSchema,
      refreshed: z.boolean(),
    })
    .optional(),
  /** Those gone, run as a user who can no longer, or new; the others are `kept`. */
  jobs: z.array(auditJobSchema).max(10_000),
  kept: countSchema,
  /** Where `--save` kept the inventory read now. */
  saved: z.string().min(1).max(4_096).optional(),
  unread: auditUnreadSchema.optional(),
});

/** A place that still names production, and why that host is production's. */
const auditEndpointSchema = z.strictObject({
  source: z.enum(['namedCredential', 'remoteSite', 'field']),
  /** The Named Credential's or the Remote Site's name; a field's as `Object.Record.Field`. */
  name: z.string().min(1).max(400),
  url: auditUrlSchema,
  host: hostSchema,
  /**
   * `listed`, among the file's productionHosts; `myDomain`, `lightning` and
   * `site`, production's own, deduced from the sandbox's host; `login`,
   * login.salesforce.com.
   */
  why: z.enum(['listed', 'myDomain', 'lightning', 'site', 'login']),
});

/** The endpoints that still name production. */
const auditEndpointsReadSchema = z.strictObject({
  /** The hosts compared against: those deduced, login.salesforce.com, and the file's. */
  productionHosts: z.array(hostSchema).max(AUDIT_MOST_NAMES + 10),
  found: z.array(auditEndpointSchema).max(10_000),
  /** Why no host was deduced: the org's host is not a sandbox's. */
  notDeduced: z.string().min(1).max(2_000).optional(),
  unread: auditUnreadSchema.optional(),
});

/**
 * What `env audit --json` answers, and an apply that read the audits once it
 * wrote: the org's deliverability, its scheduled jobs and the endpoints that
 * still name production. Each was read, and nothing written; one that could
 * not be read says why, and never changes how the apply ended.
 */
export const envAuditResultSchema = z.strictObject({
  org: z.strictObject({
    organizationId: checkpointOrganizationIdSchema,
    kind: envTargetKindSchema,
    alias: z.string().min(1).max(255).optional(),
    host: hostSchema.optional(),
  }),
  /** When it was read, on this machine's clock: the org's would cost a request more. */
  at: instantSchema,
  apiRequests: countSchema,
  deliverability: auditDeliverabilitySchema.optional(),
  schedules: auditSchedulesSchema.optional(),
  endpoints: auditEndpointsReadSchema.optional(),
  /** What `--fail-on-findings` exits 3 on: jobs gone or stuck, endpoints that name production, an open deliverability. */
  findings: countSchema,
});

/** What `apply` and `destroy` answer with `--json`. */
export const envRunResultSchema = z.strictObject({
  plan: envPlanSchema,
  steps: z.array(envStepResultSchema).max(ENV_MAX_RESOURCES * 4),
  /** The checkpoints taken and deleted, in order. */
  checkpoints: z.array(envCheckpointStepResultSchema).max(10).optional(),
  /** Resources no step ran for, each with why: a dependency left partial, a stop before them. */
  skipped: z
    .array(z.strictObject({ resource: envNameSchema, why: z.string().min(1).max(2_000) }))
    .max(ENV_MAX_RESOURCES * 2)
    .optional(),
  status: z.enum(['success', 'partial', 'failure', 'cancelled']),
  /** Why nothing was done, when it was refused before its first step. */
  refusal: z.string().min(1).max(4_000).optional(),
  /** The codes of what `refusal` says, where they are known. */
  refusalCodes: envRefusalCodesSchema.optional(),
  /** The state as the run left it: a destroy that took everything back keeps it, every resource destroyed. */
  state: z.strictObject({ serial: countSchema }),
  /** The audits the file asks, read once the apply wrote. */
  audits: envAuditResultSchema.optional(),
  /** The handoff note the apply wrote. */
  handoff: z.strictObject({ path: z.string().min(1).max(4_096) }).optional(),
});

/** Whether the checkpoint script offers to undo a rewind, until when and the line that does, or why not. */
const envRewindUndoSchema = z.union([
  z.strictObject({
    offered: z.literal(true),
    until: instantSchema,
    line: z.string().min(1).max(2_000),
  }),
  z.strictObject({ offered: z.literal(false), why: z.string().min(1).max(2_000) }),
]);

/** What `reset` and `destroy --rewind` answer with `--json`. */
export const envRewindResultSchema = z.strictObject({
  env: envNameSchema,
  org: z.strictObject({
    organizationId: checkpointOrganizationIdSchema,
    kind: envTargetKindSchema,
    alias: z.string().min(1).max(255).optional(),
  }),
  verb: z.enum(['reset', 'destroy']),
  checkpoint: z.strictObject({
    step: envCheckpointStepSchema,
    id: checkpointIdSchema,
    name: z.string().min(1).max(255).optional(),
    takenAt: instantSchema.optional(),
  }),
  preview: z
    .strictObject({
      toDelete: countSchema,
      toGiveBack: countSchema,
      toBringBack: countSchema,
      lastChangedBy: z.record(z.string().min(1).max(255), countSchema),
    })
    .optional(),
  exitCode: z.number().int().min(0).max(255),
  status: z.enum(['success', 'partial', 'unstable', 'failure', 'cancelled']),
  answer: z.unknown().optional(),
  undo: envRewindUndoSchema,
  refusal: z.string().min(1).max(8_000).optional(),
  deleted: z.array(envCheckpointStepResultSchema).max(10).optional(),
  state: z.strictObject({ serial: countSchema }),
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
        /** The org role a forge resource clones from. */
        source: envNameSchema.optional(),
        /** The objects it writes; a forge resource's are counted by its dry run alone. */
        objects: z
          .array(z.strictObject({ object: apiNameSchema, count: countSchema.optional() }))
          .max(1_000),
      }),
    )
    .max(ENV_MAX_RESOURCES)
    .optional(),
  /** The variables the file reads, and whether this process has each set. */
  variables: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(128),
        /** The org role whose alias it holds. */
        role: envNameSchema.optional(),
        /** The frozen resource whose dataset's path it holds. */
        resource: envNameSchema.optional(),
        set: z.boolean(),
      }),
    )
    .max(ENV_MAX_ORG_ROLES + ENV_MAX_RESOURCES)
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

/** What `state recover` rebuilt of one resource from its run files. */
const envRecoveredResourceSchema = z.strictObject({
  kind: envResourceKindSchema,
  status: envResourceStatusSchema,
  /** The ranks of its runs, in the order they ran. */
  runs: z.array(z.number().int().positive().max(999_999)).max(1_000),
  /** Those a removal's own record says it took back whole. */
  takenBack: z.array(z.number().int().positive().max(999_999)).max(1_000),
  /** Whether the file still has it: one it no longer has, the next plan deletes. */
  inFile: z.boolean(),
});

/**
 * What `state recover --json` answers: the state rebuilt from the run files
 * the journal directory keeps, per resource what it holds, the checkpoints it
 * linked, what it could not link, and the damaged state it set aside.
 */
export const envRecoverResultSchema = z.strictObject({
  env: envNameSchema,
  org: z.strictObject({
    organizationId: checkpointOrganizationIdSchema,
    kind: envTargetKindSchema,
    alias: z.string().min(1).max(255).optional(),
  }),
  state: z.strictObject({ serial: countSchema, lineage: z.uuid() }),
  /** Where a state that did not read was set aside, kept, never deleted. */
  setAside: z.string().min(1).max(4_096).optional(),
  resources: z.record(envNameSchema, envRecoveredResourceSchema),
  checkpoints: z.strictObject({
    before: checkpointIdSchema.optional(),
    after: checkpointIdSchema.optional(),
  }),
  /** What could not be linked, each in words: a checkpoint no file proves. */
  notLinked: z.array(z.string().min(1).max(2_000)).max(20),
});

// ─── Saved plans ─────────────────────────────────────────────────────────────

/** A seed's draws, as a run and its dry run name them. */
const seedNumberSchema = z
  .number()
  .int()
  .min(0)
  .max(2 ** 32 - 1);

/** The switches of the line a plan was made with: those `apply --plan` applies it with. */
const envSavedPlanLineSchema = z.strictObject({
  replace: z.array(envNameSchema).max(ENV_MAX_RESOURCES),
  replaceDrifted: z.boolean(),
  acceptAutomation: z.boolean(),
  // Absent from a plan saved before the emails were asked: none accepted.
  acceptEmails: z.boolean().optional(),
  acceptNoState: z.boolean(),
  // Absent from a plan saved before 1.82: no email to a person accepted.
  acceptUserEmails: z.boolean().optional(),
});

/**
 * A plan `plan --out` kept for `apply --plan`, version 1: the plan, and what
 * it was made against. Strict, as every answer is: what it does not name is
 * neither written nor read, so a record's value or a credential has no place
 * in it.
 */
export const envSavedPlanSchema = z.strictObject({
  savedPlan: z.literal(1),
  sandforgeVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, {
    error: 'Expected a version, as 1.69.0',
  }),
  /** On this machine's clock: a plan a day old is refused. */
  madeAt: instantSchema,
  file: z.strictObject({ digest: sha256Schema }),
  /** The state it was made against: none, or its serial and lineage. */
  state: z.union([
    z.strictObject({ found: z.literal(false) }),
    z.strictObject({ found: z.literal(true), serial: countSchema, lineage: z.uuid() }),
  ]),
  line: envSavedPlanLineSchema,
  /** The draws each seed resource's dry run was seeded with, by resource. */
  seeds: z.record(envNameSchema, seedNumberSchema),
  plan: envPlanSchema,
});

// ─── Outputs ─────────────────────────────────────────────────────────────────

/** What `output` says of one resource of the state: the records its last run created, or why it names none. */
const envOutputResourceSchema = z.strictObject({
  kind: envResourceKindSchema,
  status: envResourceStatusSchema,
  /** The run its records are of. */
  run: z.number().int().positive().max(999_999).optional(),
  /** By object, the ids of the records it created, in the order they were written. */
  records: z.record(apiNameSchema, z.array(recordIdSchema).max(1_000_000)),
  /** A mask resource's: per object, the records its last run went through. */
  masked: z.record(apiNameSchema, countSchema).optional(),
  /** A mask resource's: the snapshot its last run took first. */
  snapshotId: z.string().min(1).max(200).optional(),
  /** A users resource's: the users its last run set up, by username and id alone. */
  users: z
    .array(
      z.strictObject({
        username: usersUsernameSchema,
        userId: z.string().regex(/^005[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/, {
          error: 'Not a User Id',
        }),
      }),
    )
    .max(USERS_MAX)
    .optional(),
  /** Why it names no record. */
  why: z.string().min(1).max(4_000).optional(),
});

/** What `output --json` answers: per resource the state holds, what it created, read on this machine. */
export const envOutputSchema = z.strictObject({
  env: envNameSchema,
  org: z.strictObject({
    organizationId: checkpointOrganizationIdSchema,
    kind: envTargetKindSchema,
    alias: z.string().min(1).max(255).optional(),
    /** The host the state keeps, its My Domain's: a sandbox is named by it, as its plan names it. */
    host: hostSchema.optional(),
  }),
  state: z.strictObject({ serial: countSchema, updatedAt: instantSchema }),
  resources: z.record(envNameSchema, envOutputResourceSchema),
});
