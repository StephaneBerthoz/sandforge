import { describe, it, expect } from 'vitest';
import * as z from 'zod';

import {
  ENV_MAX_RESOURCES,
  envFileSchema,
  envPlanSchema,
  envRefusalAnswerSchema,
  envRefsIn,
  envRunResultSchema,
  envStateListSchema,
  envStateSchema,
  envValidationSchema,
  isEnvRefPlace,
  secretKeyOf,
  secretKeysIn,
} from './env.schema.js';

/**
 * The file a project's end-to-end tests of a Case flow would keep, reduced to
 * what version 1 reads: its seed resources, the targets, an org role and the
 * checkpoint settings. Forge and Frozen resources, `masking:` sets and
 * `outputs:` come with their kinds. The contacts would draw their parents
 * from the records the accounts resource created, which comes with the
 * parents a resource draws from another; here they draw the accounts from the
 * org, after them.
 */
function example(): Record<string, unknown> {
  return {
    version: 1,
    name: 'case-flow-e2e',
    targets: { kinds: ['scratch', 'developer'], sandboxes: [], protect: [] },
    orgs: { uat: { alias: { env: 'SF_UAT_ALIAS' } } },
    checkpoint: { before: false, after: 'baseline', ignoreFields: ['Case.Last_Touched__c'] },
    resources: {
      accounts: {
        kind: 'seed',
        seed: 4242,
        objects: [
          {
            object: 'Account',
            count: 20,
            fields: [{ fieldApiName: 'Industry', ruleType: 'picklist_random', config: {} }],
          },
        ],
      },
      contacts: {
        kind: 'seed',
        dependsOn: ['accounts'],
        objects: [{ object: 'Contact', count: 60 }],
        relations: [
          {
            lookup: 'Contact.AccountId',
            parents: { object: 'Account', existing: { where: "Name LIKE 'SFENV%'", limit: 20 } },
            distribution: { mode: 'perParent', count: 3 },
          },
        ],
      },
    },
  };
}

/** The messages a parse refused with, each after the path it names. */
function refusalsOf(document: unknown): string[] {
  const parsed = envFileSchema.safeParse(document);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => {
    const nested = issue.code === 'invalid_key' ? issue.issues.map((i) => i.message) : [];
    return `${issue.path.join('.')}: ${[issue.message, ...nested].join(' — ')}`;
  });
}

/** The example with one change at `path`, for the cases that refuse it. */
function exampleWith(path: Array<string | number>, value: unknown): Record<string, unknown> {
  const document = example();
  let node: Record<string | number, unknown> = document;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  const last = path[path.length - 1] as string | number;
  if (value === undefined) delete node[last];
  else node[last] = value;
  return document;
}

describe('the file', () => {
  it('reads the example, and fills in what a file leaves out', () => {
    const parsed = envFileSchema.parse({
      version: 1,
      name: 'minimal',
      resources: { demo: { kind: 'seed', template: 'prebuilt-minimal-demo' } },
    });

    expect(envFileSchema.safeParse(example()).success).toBe(true);
    expect(parsed.targets).toEqual({ kinds: ['scratch', 'developer'], sandboxes: [], protect: [] });
    expect(parsed.orgs).toEqual({});
  });

  it('refuses a key no object of it names, and says which keys it takes', () => {
    expect(refusalsOf(exampleWith(['dry_run'], true))).toEqual([
      ': "dry_run" is not a key of the file, which takes version, name, description, targets, orgs, checkpoint, resources',
    ]);
    expect(refusalsOf(exampleWith(['resources', 'accounts', 'count'], 3))).toEqual([
      expect.stringContaining('"count" is not a key of a seed resource, which takes kind,'),
    ]);
    expect(
      refusalsOf(
        exampleWith(['resources', 'accounts', 'objects', 0, 'fields', 0, 'config', 'values'], []),
      ),
    ).toEqual([expect.stringContaining('"values" is not a key of a field rule’s config')]);
    expect(refusalsOf(exampleWith(['targets', 'kind'], ['scratch']))).toEqual([
      expect.stringContaining(
        '"kind" is not a key of targets, which takes kinds, sandboxes, protect',
      ),
    ]);
  });

  it('refuses a file with no version, or one written for a later SandForge', () => {
    expect(refusalsOf(exampleWith(['version'], undefined))).toEqual([
      'version: The file names no version: write version: 1 at its top',
    ]);
    expect(refusalsOf(exampleWith(['version'], 2))).toEqual([
      'version: This file is written for a later SandForge (version 2): this one reads version 1',
    ]);
    expect(refusalsOf(exampleWith(['version'], '1'))).toEqual([
      'version: The version of the file is 1',
    ]);
  });

  it('applies seed resources alone, and says when a kind comes with a later SandForge', () => {
    expect(refusalsOf(exampleWith(['resources', 'bug-1234'], { kind: 'forge' }))).toEqual([
      'resources.bug-1234.kind: Resources of kind forge come with a later SandForge: this one applies seed resources',
    ]);
    expect(refusalsOf(exampleWith(['resources', 'x'], { kind: 'clone' }))).toEqual([
      'resources.x.kind: "clone" is not a kind of resource: this SandForge applies seed resources',
    ]);
    expect(
      refusalsOf(exampleWith(['resources', 'x'], { template: 'prebuilt-minimal-demo' })),
    ).toEqual(['resources.x.kind: A resource says its kind: kind: seed']);
  });

  it('holds a seed resource to a built-in template or its objects, one of them', () => {
    expect(refusalsOf(exampleWith(['resources', 'x'], { kind: 'seed' }))).toEqual([
      'resources.x: A seed resource names a built-in template (template) or the objects it writes (objects): give one',
    ]);
    expect(
      refusalsOf(exampleWith(['resources', 'accounts', 'template'], 'prebuilt-minimal-demo')),
    ).toEqual([
      'resources.accounts.objects: A seed resource names a built-in template or its objects, not both: keep one',
    ]);
    expect(
      refusalsOf(
        exampleWith(['resources', 'x'], {
          kind: 'seed',
          template: 'prebuilt-minimal-demo',
          relations: [],
        }),
      ),
    ).toEqual([
      'resources.x.relations: Relations go with objects: a built-in template brings its own',
    ]);
  });

  it('refuses an object listed twice in one resource, whose count would be ambiguous', () => {
    const twice = exampleWith(['resources', 'accounts', 'objects', 1], {
      object: 'Account',
      count: 5,
    });

    expect(refusalsOf(twice)).toEqual([
      'resources.accounts.objects.1.object: Account is listed twice: an object is listed once, with its count',
    ]);
  });

  it('refuses a range of children per parent that starts above its end', () => {
    const range = exampleWith(['resources', 'contacts', 'relations', 0, 'distribution'], {
      mode: 'range',
      min: 4,
      max: 2,
    });

    expect(refusalsOf(range)).toEqual([
      'resources.contacts.relations.0.distribution.min: A range of children per parent cannot start above its end',
    ]);
  });

  it('gives every name one shape, which a folder and a run id can hold', () => {
    for (const name of ['Accounts', 'acc.ounts', '1-accounts', 'acc/ounts', 'a'.repeat(64)]) {
      expect(refusalsOf(exampleWith(['resources', name], { kind: 'seed', template: 't' }))).toEqual(
        [expect.stringContaining('A name is lower-case letters, digits and dashes')],
      );
    }
    expect(refusalsOf(exampleWith(['name'], 'Case Flow'))).toHaveLength(1);
  });

  it('refuses a sandbox listed while the kinds do not allow sandboxes, and a kind listed twice', () => {
    expect(refusalsOf(exampleWith(['targets', 'sandboxes'], ['00Dxx0000001234']))).toEqual([
      'targets.sandboxes: targets.sandboxes lists sandboxes and targets.kinds does not allow sandbox: add sandbox to the kinds, or empty the list',
    ]);
    expect(
      envFileSchema.safeParse(
        exampleWith(['targets'], { kinds: ['sandbox'], sandboxes: ['00Dxx0000001234AAA'] }),
      ).success,
    ).toBe(true);
    expect(refusalsOf(exampleWith(['targets', 'kinds'], ['scratch', 'scratch']))).toEqual([
      'targets.kinds: A kind of org is listed twice',
    ]);
    expect(refusalsOf(exampleWith(['targets', 'kinds'], ['production']))).toHaveLength(1);
    expect(refusalsOf(exampleWith(['targets', 'protect'], ['005xx0000001234AAA']))).toHaveLength(1);
  });

  it(`holds ${ENV_MAX_RESOURCES} resources at most`, () => {
    const resources = Object.fromEntries(
      Array.from({ length: ENV_MAX_RESOURCES + 1 }, (_, i) => [
        `r${i}`,
        { kind: 'seed', template: 'prebuilt-minimal-demo' },
      ]),
    );

    expect(refusalsOf(exampleWith(['resources'], resources))).toEqual([
      `resources: A file holds ${ENV_MAX_RESOURCES} resources at most: split it into two environments`,
    ]);
  });
});

describe('keys shaped like secrets', () => {
  it('catches each secret it names, in every spelling a key is written in', () => {
    const caught: Array<[string, string]> = [
      ['password', 'password'],
      ['DB_PASSWORD', 'password'],
      ['passwd', 'passwd'],
      ['clientSecret', 'secret'],
      ['client-secret', 'secret'],
      ['accessToken', 'token'],
      ['SF_ACCESS_TOKEN', 'token'],
      ['refresh_tokens', 'token'],
      ['accesstoken', 'accessToken'],
      ['sfdxAuthUrl', 'sfdxAuthUrl'],
      ['SFDX_AUTH_URL', 'sfdxAuthUrl'],
      ['sfdxauthurl', 'sfdxAuthUrl'],
      ['authUrl', 'authUrl'],
      ['privateKey', 'privateKey'],
      ['private-keys', 'privateKey'],
      ['salt', 'salt'],
      ['hashSalt', 'salt'],
      ['apiKey', 'apiKey'],
      ['APIKey', 'apiKey'],
      ['apikey', 'apiKey'],
    ];

    for (const [key, secret] of caught) expect(secretKeyOf(key), key).toBe(secret);
  });

  it('lets a word that merely holds one stand', () => {
    for (const key of ['basalt', 'tokenizer', 'secretariat', 'keys', 'accounts', 'apiVersion']) {
      expect(secretKeyOf(key), key).toBeUndefined();
    }
  });

  it('refuses a resource or an org role named like one, as a key of its own', () => {
    expect(
      refusalsOf(exampleWith(['resources', 'api-key'], { kind: 'seed', template: 't' })),
    ).toEqual([
      'resources.api-key: Invalid key in record — "api-key" is shaped like a secret (apiKey): the file holds no secret, so name it otherwise',
    ]);
    expect(refusalsOf(exampleWith(['orgs', 'token'], { alias: 'SRC' }))).toEqual([
      expect.stringContaining('"token" is shaped like a secret (token)'),
    ]);
  });

  it('refuses one anywhere else as a key no object names', () => {
    expect(refusalsOf(exampleWith(['orgs', 'uat', 'sfdxAuthUrl'], 'force://x'))).toEqual([
      expect.stringContaining('"sfdxAuthUrl" is not a key of an org role, which takes alias'),
    ]);
  });

  it('finds every one in a document, with where it is, whatever the shape around it', () => {
    const shared = { password: 'x' };
    const document = {
      ...example(),
      accessToken: 'x',
      orgs: { uat: { alias: 'SRC', auth: { privateKey: 'x' } } },
      lists: [[{ salt: 'x' }], shared, shared],
    };

    expect(secretKeysIn(document)).toEqual([
      { path: ['accessToken'], key: 'accessToken', secret: 'token' },
      { path: ['orgs', 'uat', 'auth', 'privateKey'], key: 'privateKey', secret: 'privateKey' },
      { path: ['lists', 0, 0, 'salt'], key: 'salt', secret: 'salt' },
      { path: ['lists', 1, 'password'], key: 'password', secret: 'password' },
    ]);
    expect(secretKeysIn(example())).toEqual([]);
  });

  it('walks a document that holds itself once, as a YAML alias can make one', () => {
    const looped: Record<string, unknown> = { token: 'x' };
    looped['self'] = looped;

    expect(secretKeysIn(looped)).toEqual([{ path: ['token'], key: 'token', secret: 'token' }]);
  });
});

describe('values from the environment', () => {
  it('reads { env: NAME } as an org role’s alias, and nowhere else', () => {
    expect(isEnvRefPlace(['orgs', 'uat', 'alias'])).toBe(true);
    for (const path of [
      ['resources', 'accounts', 'objects', 0, 'count'],
      ['name'],
      ['orgs', 'uat'],
      ['resources', 'contacts', 'relations', 0, 'parents', 'existing', 'where'],
    ]) {
      expect(isEnvRefPlace(path), path.join('.')).toBe(false);
    }
  });

  it('refuses one in any other place of the file', () => {
    expect(
      refusalsOf(exampleWith(['resources', 'accounts', 'objects', 0, 'count'], { env: 'COUNT' })),
    ).toHaveLength(1);
    expect(
      refusalsOf(
        exampleWith(['resources', 'contacts', 'relations', 0, 'parents', 'existing', 'where'], {
          env: 'WHERE',
        }),
      ),
    ).toHaveLength(1);
    expect(refusalsOf(exampleWith(['orgs', 'uat', 'alias'], { env: 'lower_case' }))).toEqual([
      'orgs.uat.alias.env: A variable is named in upper-case letters, digits and underscores, as SF_UAT_ALIAS',
    ]);
    expect(refusalsOf(exampleWith(['orgs', 'uat', 'alias'], '--target-org'))).toHaveLength(1);
  });

  it('finds every one in a document, with where it stands', () => {
    const document = exampleWith(['resources', 'accounts', 'seed'], { env: 'SEED' });

    expect(envRefsIn(document)).toEqual([
      { path: ['orgs', 'uat', 'alias'], name: 'SF_UAT_ALIAS' },
      { path: ['resources', 'accounts', 'seed'], name: 'SEED' },
    ]);
  });
});

/**
 * Whether `value` holds to `schema`, for the keywords `z.toJSONSchema` writes:
 * the editor checks a file with the generated schema, so the file the schema
 * describes is checked here the way an editor would. A keyword it does not
 * know fails the check, rather than letting what it says go unread.
 */
function holdsTo(schema: Record<string, unknown>, value: unknown, at = '$'): string[] {
  const problems: string[] = [];
  const known = new Set([
    '$schema',
    'default',
    'type',
    'properties',
    'required',
    'additionalProperties',
    'propertyNames',
    'items',
    'minItems',
    'maxItems',
    'enum',
    'const',
    'pattern',
    'minLength',
    'maxLength',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'anyOf',
    'oneOf',
  ]);
  for (const keyword of Object.keys(schema)) {
    if (!known.has(keyword)) problems.push(`${at}: unread keyword ${keyword}`);
  }
  const type = schema['type'];
  const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'object' && !isObject) return [...problems, `${at}: not an object`];
  if (type === 'array' && !Array.isArray(value)) return [...problems, `${at}: not an array`];
  if (type === 'string' && typeof value !== 'string') return [...problems, `${at}: not a string`];
  if (type === 'number' && typeof value !== 'number') return [...problems, `${at}: not a number`];
  if (type === 'integer' && !Number.isInteger(value)) return [...problems, `${at}: not an integer`];
  if (type === 'boolean' && typeof value !== 'boolean')
    return [...problems, `${at}: not a boolean`];
  if ('const' in schema && schema['const'] !== value) problems.push(`${at}: not the constant`);
  if (Array.isArray(schema['enum']) && !schema['enum'].includes(value)) {
    problems.push(`${at}: not one of the values`);
  }
  if (typeof value === 'string') {
    if (typeof schema['pattern'] === 'string' && !new RegExp(schema['pattern']).test(value)) {
      problems.push(`${at}: does not match ${schema['pattern']}`);
    }
    if (typeof schema['minLength'] === 'number' && value.length < schema['minLength']) {
      problems.push(`${at}: too short`);
    }
    if (typeof schema['maxLength'] === 'number' && value.length > schema['maxLength']) {
      problems.push(`${at}: too long`);
    }
  }
  if (typeof value === 'number') {
    if (typeof schema['minimum'] === 'number' && value < schema['minimum']) {
      problems.push(`${at}: below the minimum`);
    }
    if (typeof schema['maximum'] === 'number' && value > schema['maximum']) {
      problems.push(`${at}: above the maximum`);
    }
    if (typeof schema['exclusiveMinimum'] === 'number' && value <= schema['exclusiveMinimum']) {
      problems.push(`${at}: not above the minimum`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema['minItems'] === 'number' && value.length < schema['minItems']) {
      problems.push(`${at}: too few items`);
    }
    if (typeof schema['maxItems'] === 'number' && value.length > schema['maxItems']) {
      problems.push(`${at}: too many items`);
    }
    const items = schema['items'] as Record<string, unknown> | undefined;
    if (items) value.forEach((item, i) => problems.push(...holdsTo(items, item, `${at}[${i}]`)));
  }
  if (isObject) {
    const object = value as Record<string, unknown>;
    const properties = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
    for (const name of (schema['required'] ?? []) as string[]) {
      if (!(name in object)) problems.push(`${at}: misses ${name}`);
    }
    const names = schema['propertyNames'] as Record<string, unknown> | undefined;
    const rest = schema['additionalProperties'];
    for (const [key, item] of Object.entries(object)) {
      if (names) problems.push(...holdsTo(names, key, `${at}{${key}}`));
      if (key in properties) problems.push(...holdsTo(properties[key] ?? {}, item, `${at}.${key}`));
      else if (rest === false) problems.push(`${at}: ${key} is not a property`);
      else if (rest !== undefined) {
        problems.push(...holdsTo(rest as Record<string, unknown>, item, `${at}.${key}`));
      }
    }
  }
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const options = schema[keyword] as Array<Record<string, unknown>> | undefined;
    if (!options) continue;
    const passing = options.filter((option) => holdsTo(option, value, at).length === 0).length;
    if (keyword === 'anyOf' ? passing === 0 : passing !== 1) {
      problems.push(`${at}: ${passing} of the ${keyword} options hold`);
    }
  }
  return problems;
}

describe('the JSON Schema of the file', () => {
  const jsonSchema = z.toJSONSchema(envFileSchema, { io: 'input' }) as Record<string, unknown>;

  it('is generated from the zod schema, and describes the example', () => {
    expect(jsonSchema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(holdsTo(jsonSchema, example())).toEqual([]);
  });

  it('refuses what the zod schema refuses, by the same shape', () => {
    const refused = [
      exampleWith(['dry_run'], true),
      exampleWith(['version'], 2),
      exampleWith(['resources', 'claims'], { kind: 'frozen' }),
      exampleWith(['resources', 'accounts', 'objects', 0, 'count'], { env: 'COUNT' }),
      exampleWith(['resources', 'accounts', 'objects', 0, 'count'], 0),
      exampleWith(['resources', 'Accounts'], { kind: 'seed', template: 't' }),
      exampleWith(['orgs', 'uat', 'alias'], '-x'),
    ];

    for (const document of refused) {
      expect(holdsTo(jsonSchema, document)).not.toEqual([]);
      expect(envFileSchema.safeParse(document).success).toBe(false);
    }
  });

  it('leaves out of the file what it fills in, as an editor completes it', () => {
    const properties = jsonSchema['properties'] as Record<string, Record<string, unknown>>;

    expect(jsonSchema['required']).toEqual(['version', 'name', 'resources']);
    expect(properties['targets']?.['default']).toEqual({});
  });
});

/** A state as an apply writes it, of a seed resource applied whole. */
function state(): Record<string, unknown> {
  return {
    version: 1,
    env: 'case-flow-e2e',
    lineage: '6f1c2a4e-8b3d-4c5e-9f60-718293a4b5c6',
    serial: 4,
    sandforgeVersion: '1.68.0',
    updatedAt: '2026-10-25T10:00:00.000Z',
    org: {
      organizationId: '00Dxx0000001234AAA',
      kind: 'scratch',
      username: 'test-user@example.com',
      alias: 'pool-1',
    },
    file: { digest: 'a'.repeat(64) },
    resources: {
      accounts: {
        kind: 'seed',
        fingerprint: 'b'.repeat(64),
        dependsOn: [],
        status: 'applied',
        runs: [
          {
            n: 1,
            script: 'sandforge-seed',
            runId: 'env-case-flow-e2e-accounts-1-0a1b2c3d',
            summary: 'runs/accounts/1.summary.json',
            seed: 4242,
            startedAt: '2026-10-25T09:59:00.000Z',
            endedAt: '2026-10-25T09:59:40.000Z',
            exitCode: 0,
            objects: [{ objectApiName: 'Account', created: 20, refused: 0 }],
          },
        ],
      },
    },
  };
}

describe('the state', () => {
  it('reads a state as an apply writes it', () => {
    expect(envStateSchema.safeParse(state()).success).toBe(true);
  });

  it('refuses a key it does not name, rather than guess what a later SandForge meant by it', () => {
    expect(envStateSchema.safeParse({ ...state(), values: {} }).success).toBe(false);
    const record = state();
    (record['org'] as Record<string, unknown>)['password'] = 'x';
    expect(envStateSchema.safeParse(record).success).toBe(false);
  });

  it('never names a summary outside the state’s own folder', () => {
    for (const summary of [
      '../accounts/1.summary.json',
      '/tmp/1.summary.json',
      'runs/x/0.summary.json',
    ]) {
      const record = state();
      const accounts = (record['resources'] as Record<string, Record<string, unknown>>)['accounts'];
      (accounts?.['runs'] as Array<Record<string, unknown>>)[0]!['summary'] = summary;
      expect(envStateSchema.safeParse(record).success, summary).toBe(false);
    }
  });

  it('keeps a resource’s runs in the order they ran', () => {
    const record = state();
    const accounts = (record['resources'] as Record<string, Record<string, unknown>>)['accounts'];
    const runs = accounts?.['runs'] as Array<Record<string, unknown>>;
    runs.push({ ...runs[0], n: 1 });

    expect(envStateSchema.safeParse(record).success).toBe(false);
    runs[1] = { ...runs[0], n: 2 };
    expect(envStateSchema.safeParse(record).success).toBe(true);
  });

  it('refuses a lineage that is no uuid, and a state of a production org', () => {
    expect(envStateSchema.safeParse({ ...state(), lineage: 'abc' }).success).toBe(false);
    const record = state();
    (record['org'] as Record<string, unknown>)['kind'] = 'production';
    expect(envStateSchema.safeParse(record).success).toBe(false);
  });
});

describe('the plan and the steps', () => {
  const plan = {
    env: 'case-flow-e2e',
    org: { organizationId: '00Dxx0000001234AAA', kind: 'developer', alias: 'dev' },
    state: { found: true, serial: 4 },
    actions: [
      {
        resource: 'accounts',
        kind: 'seed',
        action: 'replace',
        why: 'replaced: its objects changed in the file',
        objects: [{ object: 'Account', wouldCreate: 25, present: 20, gone: 0, changed: 0 }],
        gates: {
          apiRequests: 3,
          storageBytes: 51_200,
          emails: [{ limit: 'SingleEmail', emails: 0 }],
        },
      },
    ],
    totals: { create: 0, keep: 0, replace: 1, delete: 0, drifted: 0, blocked: 0 },
    gates: {
      apiRequests: { estimate: 3, leftToday: 14_000, partial: false },
      storage: { bytes: 51_200, left: 4_000_000 },
      emails: [{ limit: 'SingleEmail', emails: 0, left: 15 }],
    },
  };

  it('reads a plan, and refuses an action it does not know', () => {
    expect(envPlanSchema.safeParse(plan).success).toBe(true);
    const unknown = { ...plan, actions: [{ ...plan.actions[0], action: 'update' }] };
    expect(envPlanSchema.safeParse(unknown).success).toBe(false);
  });

  it('reads a count given as the most a run writes, and only as true', () => {
    const bounded = (atMost: unknown) => ({
      ...plan,
      actions: [{ ...plan.actions[0], objects: [{ object: 'Contact', wouldCreate: 6, atMost }] }],
    });
    expect(envPlanSchema.safeParse(bounded(true)).success).toBe(true);
    expect(envPlanSchema.safeParse(bounded(false)).success).toBe(false);
  });

  it('reads what apply answers, each step with the script’s own answer', () => {
    const result = {
      plan,
      steps: [
        {
          resource: 'accounts',
          action: 'replace',
          phase: 'remove',
          run: 1,
          script: 'sandforge-seed',
          exitCode: 0,
          status: 'destroyed',
          objects: [{ object: 'Account', created: 0, refused: 0, deleted: 20, kept: 0 }],
          answer: { status: 'success', removed: 20 },
        },
      ],
      status: 'success',
      state: { serial: 6 },
    };

    expect(envRunResultSchema.parse(result).steps[0]?.answer).toEqual({
      status: 'success',
      removed: 20,
    });
    expect(envRunResultSchema.safeParse({ ...result, status: 'done' }).success).toBe(false);
  });

  it('reads a plan whose org did not say what it has left, the sum said short of the truth', () => {
    const unread = {
      ...plan,
      gates: {
        apiRequests: {
          estimate: 3,
          partial: true,
          notCounted: ['the removal of accounts'],
          unread: 'the org does not tell this user its daily API requests',
        },
        storage: { bytes: 51_200, unread: 'the org does not tell this user its data storage' },
        emails: [{ limit: 'SingleEmail', emails: 0 }],
      },
      quick: true,
      warnings: ['no state of this environment on this scratch org'],
    };

    expect(envPlanSchema.safeParse(unread).success).toBe(true);
    expect(envPlanSchema.safeParse({ ...unread, quick: false }).success).toBe(false);
  });

  it('reads a step by the rank of the run it served, a destroy that deleted its state, and what was skipped', () => {
    const step = {
      resource: 'accounts',
      action: 'create',
      phase: 'run',
      run: 2,
      script: 'sandforge-seed',
      exitCode: 3,
      status: 'partial',
      objects: [{ object: 'Account', created: 18, refused: 2, deleted: 0, kept: 0 }],
    };
    const result = {
      plan,
      steps: [step],
      skipped: [{ resource: 'contacts', why: 'it depends on accounts, left partial' }],
      status: 'partial',
      state: { serial: 7 },
    };

    expect(envRunResultSchema.safeParse(result).success).toBe(true);
    // A destroy keeps the state: a result says no state was deleted.
    expect(
      envRunResultSchema.safeParse({ ...result, state: { serial: 0, deleted: true } }).success,
    ).toBe(false);
    const unranked: Record<string, unknown> = { ...step };
    delete unranked['run'];
    expect(envRunResultSchema.safeParse({ ...result, steps: [unranked] }).success).toBe(false);
  });
});

describe('what the other verbs answer', () => {
  it('reads a refusal by its code, with the file’s issues where it gives them', () => {
    expect(
      envRefusalAnswerSchema.safeParse({
        refusal: {
          code: 'INVALID_FILE',
          message: 'The file does not validate',
          issues: [{ path: 'resources.accounts.objects[0].count', message: 'Too big' }],
        },
      }).success,
    ).toBe(true);
    expect(
      envRefusalAnswerSchema.safeParse({ refusal: { code: 'production', message: 'no' } }).success,
    ).toBe(false);
  });

  it('reads a validation, valid or not', () => {
    expect(
      envValidationSchema.safeParse({
        file: '/work/sandforge.yaml',
        valid: true,
        env: 'case-flow',
        resources: [
          {
            name: 'accounts',
            kind: 'seed',
            dependsOn: [],
            objects: [{ object: 'Account', count: 20 }],
          },
        ],
        variables: [{ name: 'SF_UAT_ALIAS', role: 'uat', set: false }],
        issues: [],
        warnings: [],
      }).success,
    ).toBe(true);
    expect(
      envValidationSchema.safeParse({
        file: '/work/sandforge.yaml',
        valid: false,
        issues: [{ path: 'the file', message: 'The file names no version' }],
        warnings: [],
        extra: true,
      }).success,
    ).toBe(false);
  });

  it('reads the states kept on this machine, a damaged one by why alone', () => {
    expect(
      envStateListSchema.safeParse({
        journalDir: '/home/me/.sandforge',
        states: [
          {
            env: 'case-flow',
            organizationId: '00Dxx0000001234AAA',
            alias: 'pool-1',
            kind: 'scratch',
            serial: 3,
            resources: { accounts: 'applied' },
            updatedAt: '2026-10-25T12:00:00.000Z',
            expiresAt: '2026-11-24T12:00:00.000Z',
          },
          { env: 'demo', organizationId: '00Dxx0000005678AAA', damaged: 'does not read' },
        ],
        expired: [],
      }).success,
    ).toBe(true);
  });
});
