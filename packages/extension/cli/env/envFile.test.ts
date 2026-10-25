import { describe, expect, it } from 'vitest';
import { PREBUILT_SEED_TEMPLATES } from '@sandforge/shared';
import { seedTemplatePayloadSchema } from '../../src/bridge/validatePayload.js';
import {
  canonicalJson,
  checkEnvFile,
  documentOf,
  pathText,
  readEnvFile,
  refusalLine,
  resolveEnvFile,
  unsetVariablesOf,
  type EnvFileChecked,
  type EnvFileResolved,
} from './envFile.js';

const FOLDER = '/work/project';
const NOW = new Date('2026-10-25T12:00:00.000Z');

/** Two seed resources: accounts, then contacts drawn from the org's accounts after them. */
function file(): Record<string, unknown> {
  return {
    version: 1,
    name: 'case-flow',
    orgs: { uat: { alias: { env: 'SF_UAT_ALIAS' } } },
    resources: {
      accounts: {
        kind: 'seed',
        seed: 4242,
        objects: [
          {
            object: 'Account',
            count: 20,
            fields: [
              { fieldApiName: 'Name', ruleType: 'faker', config: { fakerMethod: 'company.name' } },
              {
                fieldApiName: 'Industry',
                ruleType: 'picklist_random',
                config: { picklistValues: ['Banking', 'Energy'] },
              },
            ],
          },
        ],
      },
      contacts: {
        kind: 'seed',
        dependsOn: ['accounts'],
        accept: { automation: true },
        locale: 'fr_FR',
        objects: [
          {
            object: 'Contact',
            count: 60,
            recordTypes: ['Customer', 'Customer', 'Partner'],
            fields: [
              {
                fieldApiName: 'LastName',
                ruleType: 'faker',
                config: { fakerMethod: 'person.lastName' },
              },
            ],
          },
        ],
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

/** `document` with one change at `path`; `undefined` takes the key out. */
function edited(
  document: Record<string, unknown>,
  path: Array<string | number>,
  value: unknown,
): Record<string, unknown> {
  let node: Record<string | number, unknown> = document;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  const last = path[path.length - 1] as string | number;
  if (value === undefined) delete node[last];
  else node[last] = value;
  return document;
}

/** The file with one change at `path`. */
function fileWith(path: Array<string | number>, value: unknown): Record<string, unknown> {
  return edited(file(), path, value);
}

/** `value` with the keys of every mapping in it in the reverse order. */
function reversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, item]) => [key, reversedKeys(item)]),
  );
}

const ENV = { SF_UAT_ALIAS: 'SRC-ORG' };

function checked(document: unknown = file()): EnvFileChecked {
  const result = checkEnvFile(document, FOLDER, { now: NOW });
  if ('refusals' in result) throw new Error(result.refusals.map(refusalLine).join('\n'));
  return result.checked;
}

function resolved(document: unknown = file(), env: NodeJS.ProcessEnv = ENV): EnvFileResolved {
  const result = readEnvFile(document, FOLDER, env, { now: NOW });
  if ('refusals' in result) throw new Error(result.refusals.map(refusalLine).join('\n'));
  return result.resolved;
}

/** The lines a check refuses a document with. */
function refusedWith(document: unknown): string[] {
  const result = checkEnvFile(document, FOLDER, { now: NOW });
  return 'refusals' in result ? result.refusals.map(refusalLine) : [];
}

function fingerprintsOf(document: unknown, env: NodeJS.ProcessEnv = ENV): Record<string, string> {
  return Object.fromEntries(resolved(document, env).resources.map((r) => [r.name, r.fingerprint]));
}

describe('documentOf', () => {
  it('reads a file written in JSON, a byte-order mark before it or not', () => {
    expect(documentOf('{"version": 1}')).toEqual({ document: { version: 1 } });
    expect(documentOf('﻿{"version": 1}')).toEqual({ document: { version: 1 } });
  });

  it('says that YAML’s own syntax arrives with the yaml dependency', () => {
    const answer = documentOf('version: 1\nname: case-flow\n');

    expect(answer).toEqual({ refusal: expect.stringContaining('does not read as JSON') });
    expect('refusal' in answer && answer.refusal).toContain(
      'YAML’s own syntax — comments, keys without quotes, indented blocks — arrives with the yaml dependency',
    );
  });

  it('refuses a key a mapping holds twice, which JSON alone would read as the last one', () => {
    const twice =
      '{"version":1,"resources":{"accounts":{"kind":"seed"},"contacts":{},"accounts":{"kind":"seed","seed":1}}}';

    expect(JSON.parse(twice).resources.accounts).toEqual({ kind: 'seed', seed: 1 });
    expect(documentOf(twice)).toEqual({
      refusal:
        'resources holds the key "accounts" twice: a mapping holds each key once, and the ' +
        'second would replace the first unseen. Keep one.',
    });
    expect(documentOf('{"a":[{"b":1},{"c":{"d":1,"d":2}}]}')).toEqual({
      refusal: expect.stringMatching(/^a\[1\]\.c holds the key "d" twice/),
    });
    // Keys are told apart by case, in JSON as in YAML.
    expect(documentOf('{"a":1,"A":2}')).toEqual({ document: { a: 1, A: 2 } });
  });

  it('reads the same key in two mappings, and keys and brackets inside strings, as JSON does', () => {
    const text =
      '{"a":{"name":"x"},"b":{"name":"{\\"name\\": [1, 2]}"},"c":["name","name"],"d":{"e\\"":1,"e":2}}';

    expect(documentOf(text)).toEqual({ document: JSON.parse(text) });
  });
});

describe('checking the file', () => {
  it('reads a file of seed resources into what each runs, in the order apply runs them', () => {
    const { order, runs, variables, folder } = checked();

    expect(order).toEqual(['accounts', 'contacts']);
    expect(folder).toBe(FOLDER);
    expect(variables).toEqual([
      { name: 'SF_UAT_ALIAS', path: ['orgs', 'uat', 'alias'], role: 'uat' },
    ]);
    expect(runs['accounts']).toMatchObject({
      seed: 4242,
      acceptAutomation: false,
      template: {
        id: 'env-case-flow-accounts',
        name: 'case-flow/accounts',
        strategy: 'faker',
        objects: [
          {
            objectApiName: 'Account',
            recordCount: 20,
            excludedFields: [],
            insertOrder: 0,
            batchSize: 200,
          },
        ],
      },
    });
    expect(runs['contacts']).toMatchObject({
      locale: 'fr_FR',
      acceptAutomation: true,
      recordTypes: { Contact: ['Customer', 'Partner'] },
      template: {
        relations: [
          {
            childObject: 'Contact',
            lookupField: 'AccountId',
            parentObject: 'Account',
            parents: { kind: 'existing', where: "Name LIKE 'SFENV%'", limit: 20 },
            distribution: { mode: 'perParent', count: 3 },
          },
        ],
      },
    });
    for (const run of Object.values(runs)) {
      expect(seedTemplatePayloadSchema.safeParse(run.template).success).toBe(true);
    }
  });

  it('runs what each resource depends on first, and the others in file order', () => {
    const document = fileWith(['resources'], {
      late: { kind: 'seed', dependsOn: ['middle', 'middle'], template: 'prebuilt-minimal-demo' },
      first: { kind: 'seed', template: 'prebuilt-minimal-demo' },
      middle: { kind: 'seed', dependsOn: ['first'], template: 'prebuilt-minimal-demo' },
      alone: { kind: 'seed', template: 'prebuilt-minimal-demo' },
    });

    expect(checked(document).order).toEqual(['first', 'middle', 'late', 'alone']);
  });

  it('refuses a key shaped like a secret wherever it stands, saying where the thing goes instead', () => {
    const credentials = fileWith(['orgs', 'uat', 'sfdxAuthUrl'], 'force://x');
    const salt = fileWith(
      ['resources', 'accounts', 'objects', 0, 'fields', 0, 'config', 'salt'],
      'x',
    );

    expect(refusedWith(credentials)).toEqual([
      'orgs.uat.sfdxAuthUrl: a key shaped like a secret (sfdxAuthUrl). The file holds no ' +
        'secret: org credentials stay with the sf CLI — log the org in with sf org login ' +
        'sfdx-url or sf org login jwt before the step, and name it in the file by its alias.',
    ]);
    expect(refusedWith(salt)).toEqual([
      'resources.accounts.objects[0].fields[0].config.salt: a key shaped like a secret (salt). ' +
        'The file holds no secret: a Frozen load never reads its salt, and DataOps templates ' +
        'carry no hash salt: leave it out.',
    ]);
    expect(checkEnvFile(salt, FOLDER)).toMatchObject({ refusals: [{ resource: 'accounts' }] });
  });

  it('refuses { env } anywhere but an org role’s alias, naming where it may stand', () => {
    const where = fileWith(
      ['resources', 'contacts', 'relations', 0, 'parents', 'existing', 'where'],
      { env: 'FILTER' },
    );

    expect(refusedWith(where)).toEqual([
      'resources.contacts.relations[0].parents.existing.where: { env } stands in ' +
        'orgs.<role>.alias alone: write this value in the file. A variable inside a query or a ' +
        'field value would let a CI variable into what is written.',
    ]);
  });

  it('refuses what the file’s schema refuses, each where it is', () => {
    expect(refusedWith(fileWith(['resources', 'accounts', 'dry_run'], true))).toEqual([
      expect.stringMatching(/^resources\.accounts: "dry_run" is not a key of a seed resource/),
    ]);
    expect(refusedWith(fileWith(['resources', 'claims'], { kind: 'frozen' }))).toEqual([
      'resources.claims.kind: Resources of kind frozen come with a later SandForge: this one applies seed resources',
    ]);
    expect(
      refusedWith(fileWith(['resources', 'api-token'], { kind: 'seed', template: 'x' })),
    ).toEqual([
      expect.stringMatching(/^resources\.api-token: a key shaped like a secret \(token\)/),
    ]);
  });

  it('refuses a dependency on no resource of the file, or on itself', () => {
    expect(refusedWith(fileWith(['resources', 'contacts', 'dependsOn'], ['acounts']))).toEqual([
      'resources.contacts.dependsOn[0]: "acounts" is no resource of this file: name one of accounts, contacts',
    ]);
    expect(refusedWith(fileWith(['resources', 'accounts', 'dependsOn'], ['accounts']))).toEqual([
      'resources.accounts.dependsOn[0]: a resource does not depend on itself: take accounts out of its dependsOn',
    ]);
  });

  it('refuses resources that depend on each other in a circle, naming it in order', () => {
    const circle = fileWith(['resources'], {
      a: { kind: 'seed', template: 'prebuilt-minimal-demo' },
      b: { kind: 'seed', dependsOn: ['d'], template: 'prebuilt-minimal-demo' },
      c: { kind: 'seed', dependsOn: ['b'], template: 'prebuilt-minimal-demo' },
      d: { kind: 'seed', dependsOn: ['c', 'a'], template: 'prebuilt-minimal-demo' },
    });

    expect(refusedWith(circle)).toEqual([
      'resources.b: the resources depend on each other in a circle, b → d → c → b: no order ' +
        'applies them. Take one of them out of the dependsOn of the next.',
    ]);
  });

  it('runs a built-in template’s content, and refuses one there is not, naming those there are', () => {
    const builtIn = checked(
      fileWith(['resources'], { demo: { kind: 'seed', template: 'prebuilt-minimal-demo' } }),
    );
    const demo = PREBUILT_SEED_TEMPLATES.find((t) => t.id === 'prebuilt-minimal-demo');

    expect(builtIn.runs['demo']?.template.objects).toEqual(demo?.objects);
    expect(builtIn.runs['demo']?.template.relations).toEqual(demo?.relations);
    expect(builtIn.runs['demo']?.template.objects).not.toBe(demo?.objects);
    expect(
      refusedWith(fileWith(['resources'], { demo: { kind: 'seed', template: 'crm' } })),
    ).toEqual([
      expect.stringMatching(
        /^resources\.demo\.template: there is no built-in template "crm": there is prebuilt-crm-starter, /,
      ),
    ]);
  });

  it('refuses what Seed’s own payload schema refuses, where the file wrote it', () => {
    const limit = fileWith(
      ['resources', 'contacts', 'relations', 0, 'parents', 'existing', 'where'],
      "Name LIKE 'SFENV%' LIMIT 1",
    );

    expect(refusedWith(limit)).toEqual([
      expect.stringMatching(
        /^resources\.contacts\.relations\[0\]\.parents\.existing\.where: A WHERE clause may only filter/,
      ),
    ]);
  });

  it('refuses what a seed run would refuse after writing the objects before it, where the file wrote it', () => {
    const noValues = fileWith(['resources', 'accounts', 'objects', 0, 'fields', 1, 'config'], {});
    const noFields = fileWith(['resources', 'accounts', 'objects', 0, 'fields'], undefined);
    const generated = fileWith(['resources', 'contacts', 'relations', 0, 'parents'], {
      object: 'Account',
    });
    const method = fileWith(['resources', 'accounts', 'objects', 0, 'fields', 0, 'config'], {
      fakerMethod: 'company.motto',
    });

    expect(refusedWith(noValues)).toEqual([
      'resources.accounts.objects[0].fields[1]: Picklist rule requires at least one value',
    ]);
    expect(refusedWith(noFields)).toEqual([
      'resources.accounts.objects[0]: Account asks for 20 record(s) and names no field to fill: add at least one field rule',
    ]);
    expect(refusedWith(generated)).toEqual([
      "resources.contacts.relations[0]: The relation draws Contact's parents from the Account records this run writes, and the template writes none",
    ]);
    expect(refusedWith(method)).toEqual([
      expect.stringMatching(
        /^resources\.accounts\.objects\[0\]\.fields\[0\]: Faker method "company\.motto"/,
      ),
    ]);
  });

  it('lists the variables the environment leaves unset, or sets to nothing', () => {
    const file = checked();

    expect(unsetVariablesOf(file, {})).toEqual(file.variables);
    expect(unsetVariablesOf(file, { SF_UAT_ALIAS: '  ' })).toEqual(file.variables);
    expect(unsetVariablesOf(file, ENV)).toEqual([]);
  });
});

describe('reading the variables', () => {
  it('reads an org role’s alias from the variable the file names', () => {
    expect(resolved().orgs).toEqual({ uat: 'SRC-ORG' });
  });

  it('refuses a variable unset, naming it and the way out', () => {
    const result = resolveEnvFile(checked(), {});

    expect(result).toEqual({
      refusals: [
        {
          path: ['orgs', 'uat', 'alias'],
          message:
            "the variable SF_UAT_ALIAS is not set: set it in the job's environment to the alias " +
            'of the uat org, or give --alias uat=<alias>',
        },
      ],
    });
  });

  it('refuses a variable or a line that holds no alias, which a script would read as a flag', () => {
    expect(resolveEnvFile(checked(), { SF_UAT_ALIAS: '--target-org' })).toMatchObject({
      refusals: [{ message: expect.stringContaining('the variable SF_UAT_ALIAS holds no alias') }],
    });
    expect(resolveEnvFile(checked(), ENV, { aliases: { uat: '-x' } })).toMatchObject({
      refusals: [{ message: expect.stringContaining('--alias uat= gives no alias') }],
    });
  });

  it('lets an alias the line gives win over the file’s, and refuses one for a role it does not declare', () => {
    const given = resolveEnvFile(checked(), {}, { aliases: { uat: 'OTHER-SRC' } });

    expect('resolved' in given && given.resolved.orgs).toEqual({ uat: 'OTHER-SRC' });
    expect(resolveEnvFile(checked(), ENV, { aliases: { prod: 'P' } })).toEqual({
      refusals: [
        {
          path: ['orgs'],
          message:
            "--alias names the role prod, which the file's orgs do not declare: its roles are uat",
        },
      ],
    });
  });
});

describe('fingerprints', () => {
  it('give each resource a sha256 of what it writes, in the order apply runs them', () => {
    const { resources, digest } = resolved();

    expect(resources.map((r) => [r.name, r.kind, r.dependsOn])).toEqual([
      ['accounts', 'seed', []],
      ['contacts', 'seed', ['accounts']],
    ]);
    for (const value of [...resources.map((r) => r.fingerprint), digest]) {
      expect(value).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('are the same for the same file written in another key order, or on another day', () => {
    const reordered = reversedKeys(file());
    const later = readEnvFile(file(), FOLDER, ENV, { now: new Date('2027-01-01T00:00:00Z') });

    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(file()));
    expect(fingerprintsOf(reordered)).toEqual(fingerprintsOf(file()));
    expect(resolved(reordered).digest).toBe(resolved().digest);
    expect('resolved' in later && later.resolved.digest).toBe(resolved().digest);
  });

  it('change with any value that changes what is written', () => {
    const before = fingerprintsOf(file());
    const changes: Array<[Array<string | number>, unknown]> = [
      [['resources', 'accounts', 'objects', 0, 'count'], 21],
      [
        ['resources', 'accounts', 'objects', 0, 'fields', 1, 'config', 'picklistValues'],
        ['Banking'],
      ],
      [['resources', 'accounts', 'seed'], 4243],
      [['resources', 'accounts', 'seed'], undefined],
      [['resources', 'accounts', 'locale'], 'de_DE'],
      [['resources', 'accounts', 'objects', 0, 'recordTypes'], ['Partner']],
    ];

    for (const [path, value] of changes) {
      expect(fingerprintsOf(fileWith(path, value))['accounts'], path.join('.')).not.toBe(
        before['accounts'],
      );
    }
    const where = fileWith(
      ['resources', 'contacts', 'relations', 0, 'parents', 'existing', 'where'],
      "Name LIKE 'OTHER%'",
    );
    expect(fingerprintsOf(where)['contacts']).not.toBe(before['contacts']);
    expect(fingerprintsOf(where)['accounts']).toBe(before['accounts']);
  });

  it('stay with what changes no record: the description, an acceptance, a batch size', () => {
    const before = fingerprintsOf(file());
    const unchanged: Array<[Array<string | number>, unknown]> = [
      [['description'], 'The data the Case flow tests need'],
      [['resources', 'contacts', 'accept'], undefined],
      [['resources', 'accounts', 'objects', 0, 'batchSize'], 50],
    ];

    for (const [path, value] of unchanged) {
      expect(fingerprintsOf(fileWith(path, value)), path.join('.')).toEqual(before);
    }
  });

  it('chain: a resource another depends on, changed, changes the other too', () => {
    const count = ['resources', 'accounts', 'objects', 0, 'count'];
    const unlinked = (accounts: number) =>
      edited(fileWith(count, accounts), ['resources', 'contacts', 'dependsOn'], undefined);

    expect(fingerprintsOf(fileWith(count, 30))['contacts']).not.toBe(
      fingerprintsOf(file())['contacts'],
    );
    // Without the dependency, the contacts are what they were.
    expect(fingerprintsOf(unlinked(30))['contacts']).toBe(fingerprintsOf(unlinked(20))['contacts']);
  });

  it('follow a built-in template’s content: a SandForge whose template changed replaces it', () => {
    const demo = { demo: { kind: 'seed', template: 'prebuilt-minimal-demo' } };
    const before = fingerprintsOf(fileWith(['resources'], demo));
    const template = PREBUILT_SEED_TEMPLATES.find((t) => t.id === 'prebuilt-minimal-demo');
    const account = template?.objects[0];
    if (account === undefined) throw new Error('no built-in template to change');
    const count = account.recordCount;

    account.recordCount = count + 1;
    try {
      expect(fingerprintsOf(fileWith(['resources'], demo))).not.toEqual(before);
    } finally {
      account.recordCount = count;
    }
    expect(fingerprintsOf(fileWith(['resources'], demo))).toEqual(before);
  });

  it('give the file a digest that moves with an alias read and with any key of the file', () => {
    const digest = resolved().digest;

    expect(resolved(file(), { SF_UAT_ALIAS: 'OTHER-SRC' }).digest).not.toBe(digest);
    expect(resolved(fileWith(['description'], 'x')).digest).not.toBe(digest);
  });
});

describe('the lines a refusal is said in', () => {
  it('name the place in the file as it is written', () => {
    expect(pathText([])).toBe('the file');
    expect(pathText(['resources', 'accounts', 'objects', 0, 'count'])).toBe(
      'resources.accounts.objects[0].count',
    );
    expect(pathText(['resources', 'a b', 'x'])).toBe('resources["a b"].x');
  });

  it('write each object’s keys in one order, leave out what is undefined, and keep lists in order', () => {
    expect(canonicalJson({ b: [2, { d: 1, c: undefined }], a: 1 })).toBe('{"a":1,"b":[2,{"d":1}]}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});
