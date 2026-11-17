import { describe, it, expect } from 'vitest';
import * as z from 'zod';

import {
  ENV_MAX_RESOURCES,
  ENV_REF_PLACES,
  RECOVERED_FINGERPRINT,
  envAuditResultSchema,
  envFileSchema,
  envOutputSchema,
  envPlanSchema,
  envRecoverResultSchema,
  envRefusalAnswerSchema,
  envRefsIn,
  envRewindResultSchema,
  envRunResultSchema,
  envSavedPlanSchema,
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
      ': "dry_run" is not a key of the file, which takes version, name, description, targets, orgs, checkpoint, masking, resources, audits',
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

  it('still reads a field rule an older panel saved with a referenceField, which nothing reads', () => {
    const saved = (config: Record<string, unknown>) =>
      exampleWith(
        ['resources', 'accounts', 'objects', 0, 'fields'],
        [{ fieldApiName: 'ParentId', ruleType: 'reference', config }],
      );

    expect(
      envFileSchema.safeParse(saved({ referenceObject: 'Account', referenceField: 'Id' })).success,
    ).toBe(true);
    expect(refusalsOf(saved({ referenceObject: 'Account', referenceFieldd: 'Id' }))).toEqual([
      expect.stringContaining('"referenceFieldd" is not a key of a field rule’s config'),
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

  it('applies seed, forge, frozen, mask, users and replay resources, and names them when a kind is none of them', () => {
    expect(refusalsOf(exampleWith(['resources', 'x'], { kind: 'clone' }))).toEqual([
      'resources.x.kind: "clone" is not a kind of resource: this SandForge applies seed, forge, frozen, mask, users and replay resources',
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

describe('a seed resource fitted to the target', () => {
  it('takes fit: share, or fit with the MB it is held within, and nothing else', () => {
    expect(refusalsOf(exampleWith(['resources', 'accounts', 'fit'], 'share'))).toEqual([]);
    expect(refusalsOf(exampleWith(['resources', 'accounts', 'fit'], { withinMB: 50 }))).toEqual([]);
    for (const fit of ['all', { withinMB: 0 }, { withinMB: 50, share: true }, true]) {
      expect(
        refusalsOf(exampleWith(['resources', 'accounts', 'fit'], fit)),
        JSON.stringify(fit),
      ).toEqual([expect.stringMatching(/^resources\.accounts\.fit/)]);
    }
  });
});

describe('a mask resource, and the masking sets it names', () => {
  /** The example with a masking set of contact points, and a mask resource beside its seeds. */
  const withMask = (
    resource: Record<string, unknown>,
    masking: Record<string, unknown> = {
      'contact-points': {
        rules: [
          { fieldPattern: 'Contact.Email', ruleType: 'hash' },
          { fieldPattern: 'Contact.Phone', ruleType: 'mask', config: { maskKeepLast: 2 } },
        ],
      },
    },
  ): Record<string, unknown> => {
    const document = exampleWith(['resources', 'customers'], { kind: 'mask', ...resource });
    return { ...document, masking };
  };

  it('reads a mask resource naming a set of the file, or a template that ships, one object or every one', () => {
    const bySet = envFileSchema.parse(
      withMask({ rules: 'contact-points', object: 'Contact', where: 'Email != null' }),
    );
    const byTemplate = envFileSchema.parse(withMask({ rules: { template: 'tpl-gdpr-standard' } }));

    expect(bySet.resources['customers']).toEqual({
      kind: 'mask',
      rules: 'contact-points',
      object: 'Contact',
      where: 'Email != null',
    });
    expect(bySet.masking['contact-points']?.rules).toHaveLength(2);
    expect(byTemplate.resources['customers']).toEqual({
      kind: 'mask',
      rules: { template: 'tpl-gdpr-standard' },
    });
    // A file that names no set holds none.
    expect(envFileSchema.parse(example()).masking).toEqual({});
  });

  it('refuses a condition with no object to hold it to, as the DataOps script refuses --where', () => {
    expect(refusalsOf(withMask({ rules: 'contact-points', where: 'Email != null' }))).toEqual([
      'resources.customers.where: where filters the records of one object: give it with object',
    ]);
  });

  it('reads a masking in slices, the records a slice holds and a bound on its requests', () => {
    const sliced = envFileSchema.parse(
      withMask({
        rules: 'contact-points',
        object: 'Contact',
        slices: true,
        maxRecords: 1000,
        maxRequests: 40,
      }),
    );

    expect(sliced.resources['customers']).toMatchObject({
      slices: true,
      maxRecords: 1000,
      maxRequests: 40,
    });
  });

  it('refuses a bound on requests that is not a whole number, or given without slices, as the script refuses --max-requests', () => {
    expect(
      refusalsOf(
        withMask({ rules: 'contact-points', object: 'Contact', slices: true, maxRequests: 40.5 }),
      ),
    ).toEqual(['resources.customers.maxRequests: maxRequests is a whole number of requests']);
    expect(
      refusalsOf(withMask({ rules: 'contact-points', object: 'Contact', maxRequests: 40 })),
    ).toEqual([
      'resources.customers.maxRequests: maxRequests bounds a masking in slices: give it with slices: true',
    ]);
    expect(
      refusalsOf(withMask({ rules: 'contact-points', object: 'Contact', slices: 'yes' })),
    ).toEqual([expect.stringMatching(/^resources\.customers\.slices: /)]);
  });

  it('holds maxRecords within what a snapshot takes, 100 to 1000000', () => {
    for (const maxRecords of [99, 1_000_001, 500.5]) {
      expect(
        refusalsOf(withMask({ rules: 'contact-points', object: 'Contact', maxRecords })),
      ).toEqual([expect.stringMatching(/^resources\.customers\.maxRecords: /)]);
    }
    expect(
      refusalsOf(withMask({ rules: 'contact-points', object: 'Contact', maxRecords: 100 })),
    ).toEqual([]);
  });

  it('refuses a set the file does not declare, naming the sets it does', () => {
    expect(refusalsOf(withMask({ rules: 'gdpr', object: 'Contact' }))).toEqual([
      'resources.customers.rules: "gdpr" is no rule set of the file: declare it under masking, as masking: { gdpr: { rules: [ … ] } } (its sets are contact-points)',
    ]);
    expect(refusalsOf(withMask({ rules: { template: 'GDPR Standard' } }))).toEqual([
      'resources.customers.rules.template: A template that ships is named by its id, as tpl-gdpr-standard',
    ]);
    expect(refusalsOf(withMask({ rules: 3 }))).toEqual([
      'resources.customers.rules: rules names a set of the file’s masking, as rules: gdpr-contacts, or a template that ships, as rules: { template: tpl-gdpr-standard }',
    ]);
  });

  it('holds a set’s rules to the keys and methods the DataOps panel saves', () => {
    const rule = (extra: Record<string, unknown>) =>
      withMask(
        { rules: 'r', object: 'Contact' },
        { r: { rules: [{ fieldPattern: 'Contact.Email', ruleType: 'hash', ...extra }] } },
      );

    expect(refusalsOf(rule({ salt: 'x' }))).toEqual([
      expect.stringContaining('"salt" is not a key of a masking rule, which takes fieldPattern'),
    ]);
    expect(refusalsOf(rule({ ruleType: 'scramble' }))).toHaveLength(1);
    expect(refusalsOf(rule({ fieldPattern: 'Email' }))).toEqual([
      'masking.r.rules.0.fieldPattern: Expected Object.Field',
    ]);
    expect(refusalsOf(rule({ config: { keep: 2 } }))).toEqual([
      expect.stringContaining('"keep" is not a key of a masking rule’s config'),
    ]);
    expect(refusalsOf(withMask({ rules: 'r', object: 'Contact' }, { r: { rules: [] } }))).toEqual([
      'masking.r.rules: A rule set holds one rule at least',
    ]);
  });

  it('takes the limit of the checkpoints and the objects they leave out, which answer a take past its limit', () => {
    const checkpoint = (settings: Record<string, unknown>) =>
      exampleWith(['checkpoint'], { after: 'baseline', ...settings });

    expect(
      refusalsOf(checkpoint({ maxTotal: 1_000_000, excludeObjects: ['Task', 'ns__Log__c'] })),
    ).toEqual([]);
    expect(refusalsOf(checkpoint({ maxTotal: 0 }))).toEqual([
      expect.stringMatching(/^checkpoint\.maxTotal: /),
    ]);
    expect(refusalsOf(checkpoint({ maxTotal: 1_000_001 }))).toEqual([
      expect.stringMatching(/^checkpoint\.maxTotal: /),
    ]);
    expect(refusalsOf(checkpoint({ excludeObjects: ['Task', 'Task'] }))).toEqual([
      'checkpoint.excludeObjects.1: Task is listed twice: an object is left out once',
    ]);
    expect(refusalsOf(checkpoint({ excludeObjects: ['not an object'] }))).toEqual([
      expect.stringMatching(/^checkpoint\.excludeObjects\.0: /),
    ]);
  });

  it('refuses a checkpoint before the first write beside a mask resource: destroy --rewind would unmask', () => {
    const before = {
      ...withMask({ rules: 'contact-points', object: 'Contact' }),
      checkpoint: { before: true },
    };

    expect(refusalsOf(before)).toEqual([
      'checkpoint.before: A checkpoint before the first write holds, in clear, the values the mask resources (customers) write over, and destroy --rewind would put them back into the org: a file with a mask resource takes none. Take checkpoint.before out',
    ]);
    // Negative control: the same file without the mask resource takes it.
    expect(refusalsOf({ ...example(), checkpoint: { before: true } })).toEqual([]);
  });
});

describe('a forge resource', () => {
  /** The example with one forge resource beside its seeds, cloning from the uat role. */
  const withForge = (resource: Record<string, unknown>): Record<string, unknown> =>
    exampleWith(['resources', 'bug-1234'], { kind: 'forge', source: 'uat', ...resource });

  it('reads one record by a query or by its id, and whole tables with a template, an anonymization and a ceiling', () => {
    const byQuery = envFileSchema.parse(
      withForge({
        record: { object: 'Case', where: "  CaseNumber = '00001026'  " },
        template: { file: '.sandforge/forge-templates.json', id: 'case-with-history' },
        anonymize: { rules: { email: 'fake', phone: 'mask', name: 'fake' } },
        maxTotal: 500,
        accept: { automation: true },
      }),
    );
    const tables = envFileSchema.parse(
      withForge({
        tables: [{ object: 'Account', where: "Name LIKE 'SFENV%'" }, { object: 'Contact' }],
        depth: 'custom',
        customDepth: 2,
        maxNodes: 20,
        keepContactPoints: false,
      }),
    );

    expect(byQuery.resources['bug-1234']).toMatchObject({
      kind: 'forge',
      source: 'uat',
      // Trimmed as the clone trims its --where: the same condition, the same fingerprint.
      record: { object: 'Case', where: "CaseNumber = '00001026'" },
      maxTotal: 500,
    });
    expect(
      envFileSchema.safeParse(withForge({ record: { id: '500xx0000001234AAA' } })).success,
    ).toBe(true);
    expect(tables.resources['bug-1234']).toMatchObject({
      tables: [{ object: 'Account', where: "Name LIKE 'SFENV%'" }, { object: 'Contact' }],
      customDepth: 2,
    });
  });

  it('accepts real data from a production source in the file, a forge resource alone', () => {
    const accepted = envFileSchema.parse(
      withForge({ tables: [{ object: 'Case' }], accept: { realData: true, automation: true } }),
    );

    expect(accepted.resources['bug-1234']).toMatchObject({
      accept: { realData: true, automation: true },
    });
    // A seed writes what it draws: it has no real data to accept.
    expect(
      refusalsOf(exampleWith(['resources', 'accounts', 'accept'], { realData: true })).join('\n'),
    ).toContain('"realData" is not a key of accept, which takes automation');
    expect(
      refusalsOf(withForge({ tables: [{ object: 'Case' }], accept: { realdata: true } })).join(
        '\n',
      ),
    ).toContain('"realdata" is not a key of accept, which takes automation, realData');
  });

  it('clones one record or whole tables, one of them, a record named one way', () => {
    expect(refusalsOf(withForge({}))).toEqual([
      'resources.bug-1234: A forge resource clones one record (record), the records a query chooses (records), whole tables (tables) or the whole org (depth: all): give one of them',
    ]);
    expect(
      refusalsOf(withForge({ record: { id: '500xx0000001234AAA' }, tables: [{ object: 'Case' }] })),
    ).toHaveLength(1);
    expect(
      refusalsOf(
        withForge({ record: { id: '500xx0000001234AAA', object: 'Case', where: 'x = 1' } }),
      ),
    ).toEqual([
      'resources.bug-1234.record: A record is named by its id, or by its object and a where its source answers with exactly one row: give one of them',
    ]);
    expect(refusalsOf(withForge({ record: { object: 'Case' } }))).toEqual([
      'resources.bug-1234.record.where: A record named by a query gives its object and its where both',
    ]);
    expect(refusalsOf(withForge({ record: { id: '500-not-an-id' } }))).toEqual([
      'resources.bug-1234.record.id: A record id is 15 or 18 letters and digits',
    ]);
  });

  it('refuses a table listed twice, and a custom depth beside another depth', () => {
    expect(
      refusalsOf(
        withForge({ tables: [{ object: 'Account' }, { object: 'Account', where: 'x = 1' }] }),
      ),
    ).toEqual([
      'resources.bug-1234.tables.1.object: Account is listed twice: a table is listed once, with its condition',
    ]);
    expect(
      refusalsOf(withForge({ tables: [{ object: 'Account' }], depth: 'full', customDepth: 3 })),
    ).toEqual([
      'resources.bug-1234.customDepth: customDepth goes with depth: custom, not depth: full',
    ]);
  });

  it('takes the depth all, the clone of the whole org, with a fit, and nothing a walk starts from', () => {
    const whole = envFileSchema.parse(
      withForge({
        depth: 'all',
        fit: { withinMB: 150 },
        anonymize: { rules: {} },
        maxTotal: 40_000,
      }),
    );
    expect(whole.resources['bug-1234']).toMatchObject({
      depth: 'all',
      fit: { withinMB: 150 },
      maxTotal: 40_000,
    });
    expect(envFileSchema.safeParse(withForge({ depth: 'all', fit: 'share' })).success).toBe(true);

    expect(
      refusalsOf(
        withForge({
          depth: 'all',
          tables: [{ object: 'Account' }],
          record: { id: '500xx0000001234AAA' },
          template: { file: 'templates.json', id: 't' },
          customDepth: 3,
          maxNodes: 20,
        }),
      ),
    ).toEqual([
      'resources.bug-1234.record: depth: all clones the whole org, and does not go with record: it starts from no record',
      'resources.bug-1234.tables: depth: all clones the whole org, and does not go with tables: it starts from no table',
      'resources.bug-1234.template: depth: all clones the whole org, and does not go with template: a template holds the choices of a walk from its record or query; sandforge clone --depth all takes them from --config',
      'resources.bug-1234.customDepth: depth: all clones the whole org, and does not go with customDepth: it walks no depth',
      'resources.bug-1234.maxNodes: depth: all clones the whole org, and does not go with maxNodes: it takes every object it can',
    ]);
    // Its anonymization is every category's default method: no other is taken.
    expect(
      refusalsOf(withForge({ depth: 'all', anonymize: { rules: { email: 'hash' } } })),
    ).toEqual([
      'resources.bug-1234.anonymize: depth: all anonymizes every personal field by its category’s default method, the clone of the whole org taking no other: give anonymize: { rules: {} }',
    ]);
    // A sample is of the whole org alone.
    expect(refusalsOf(withForge({ tables: [{ object: 'Account' }], fit: 'share' }))).toEqual([
      'resources.bug-1234.fit: fit goes with depth: all: it copies a sample of the whole org that fits the target. A clone of a record or of tables writes what it reaches',
    ]);
  });

  it('holds each condition to the rule the clone holds its --where to', () => {
    const refusedWhere = (where: string) =>
      refusalsOf(withForge({ tables: [{ object: 'Case', where }] }));

    expect(refusedWhere("Subject = 'a' --")).toHaveLength(1);
    expect(refusedWhere("Subject = 'a' /* b */")).toHaveLength(1);
    expect(refusedWhere("Subject = 'a';")).toHaveLength(1);
    expect(refusedWhere('-1 < Amount')).toHaveLength(1);
    expect(refusedWhere(`Subject = '${'a'.repeat(512)}'`)).toEqual([
      'resources.bug-1234.tables.0.where: A condition is 512 characters at most, as the clone takes one',
    ]);
    expect(refusedWhere("Subject = 'a-b'")).toEqual([]);
  });

  it('clones from a role the file declares, never from an alias of its own', () => {
    expect(refusalsOf(withForge({ source: 'prod', tables: [{ object: 'Case' }] }))).toEqual([
      'resources.bug-1234.source: "prod" is no org role of the file: declare it under orgs, as orgs: { prod: { alias: { env: … } } } (its roles are uat)',
    ]);
    expect(refusalsOf(withForge({ source: 'uat', tables: [{ object: 'Case' }] }))).toEqual([]);
  });

  it('reads a template from a path of the project, never one absolute or up out of its folder', () => {
    const refusedPath = (file: string) =>
      refusalsOf(withForge({ tables: [{ object: 'Case' }], template: { file, id: 't' } }));

    expect(refusedPath('/etc/forge-templates.json')).toHaveLength(1);
    expect(refusedPath('C:\\templates.json')).toHaveLength(1);
    expect(refusedPath('../other/.sandforge/forge-templates.json')).toHaveLength(1);
    expect(refusedPath('config\\..\\..\\t.json')).toHaveLength(1);
    expect(refusedPath('config/forge-templates.json')).toEqual([]);
  });

  it('holds its anonymization to Forge’s categories and methods, and refuses a key it does not name', () => {
    expect(
      refusalsOf(
        withForge({ tables: [{ object: 'Case' }], anonymize: { rules: { emails: 'fake' } } }),
      ),
    ).toHaveLength(1);
    expect(
      refusalsOf(
        withForge({ tables: [{ object: 'Case' }], anonymize: { rules: { email: 'scramble' } } }),
      ),
    ).toHaveLength(1);
    expect(
      refusalsOf(
        withForge({ tables: [{ object: 'Case' }], anonymize: { rules: {}, preset: 'gdpr' } }),
      ),
    ).toEqual([expect.stringContaining('"preset" is not a key of anonymize')]);
    expect(refusalsOf(withForge({ tables: [{ object: 'Case' }], sourceAlias: 'UAT' }))).toEqual([
      expect.stringContaining('"sourceAlias" is not a key of a forge resource'),
    ]);
  });

  it('clones the records a query chooses, by its object, condition, order and limit', () => {
    const energy = envFileSchema.parse(
      withForge({
        records: {
          object: 'Account',
          where: "  Industry = 'Energy'  ",
          orderBy: 'CreatedDate DESC',
          limit: 50,
        },
        depth: 'full',
      }),
    );
    expect(energy.resources['bug-1234']).toMatchObject({
      // Trimmed as a table's condition is: the same condition, the same fingerprint.
      records: {
        object: 'Account',
        where: "Industry = 'Energy'",
        orderBy: 'CreatedDate DESC',
        limit: 50,
      },
    });
    expect(
      envFileSchema.safeParse(withForge({ records: { object: 'Case', limit: 2_000 } })).success,
    ).toBe(true);
  });

  it('asks the limit of the records a query chooses, the same each plan, and holds it to the most a clone takes', () => {
    expect(refusalsOf(withForge({ records: { object: 'Account', where: 'x = 1' } }))).toEqual([
      'resources.bug-1234.records.limit: records gives limit, the most records it clones, 1 to 2000: each plan reads them again, and must read the same',
    ]);
    expect(refusalsOf(withForge({ records: { object: 'Account', limit: 2_001 } }))).toEqual([
      'resources.bug-1234.records.limit: Too big: expected number to be <=2000',
    ]);
    expect(refusalsOf(withForge({ records: { object: 'Account', limit: 0 } }))).toHaveLength(1);
  });

  it('holds the order of the records a query chooses to field paths and their directions', () => {
    expect(
      refusalsOf(withForge({ records: { object: 'Account', orderBy: 'Name; DELETE', limit: 5 } })),
    ).toEqual([
      'resources.bug-1234.records.orderBy: An ORDER BY takes field paths, each with ASC or DESC and NULLS FIRST or LAST, separated by commas',
    ]);
    expect(
      refusalsOf(withForge({ records: { object: 'Account', where: "Name = 'a';", limit: 5 } })),
    ).toHaveLength(1);
    expect(
      refusalsOf(withForge({ records: { object: 'Account', limit: 5, query: 'SELECT Id' } })),
    ).toEqual([
      expect.stringContaining(
        '"query" is not a key of records, which takes object, where, orderBy, limit',
      ),
    ]);
  });

  it('clones the records a query chooses or a record or tables, one of them, never with the whole org', () => {
    expect(
      refusalsOf(
        withForge({
          records: { object: 'Account', limit: 5 },
          record: { id: '500xx0000001234AAA' },
        }),
      ),
    ).toEqual([
      'resources.bug-1234: A forge resource clones one record (record), the records a query chooses (records), whole tables (tables) or the whole org (depth: all): give one of them',
    ]);
    expect(
      refusalsOf(
        withForge({ records: { object: 'Account', limit: 5 }, tables: [{ object: 'Case' }] }),
      ),
    ).toHaveLength(1);
    expect(
      refusalsOf(withForge({ records: { object: 'Account', limit: 5 }, depth: 'all' })),
    ).toEqual([
      'resources.bug-1234.records: depth: all clones the whole org, and does not go with records: it starts from no query; a sample of it filters its roots with fit: { where }',
    ]);
  });
});

describe('a forge resource’s sample of the whole org, its roots chosen', () => {
  /** The example with a forge resource cloning a sample of the whole org from the uat role. */
  const withFit = (fit: unknown): Record<string, unknown> =>
    exampleWith(['resources', 'sample'], {
      kind: 'forge',
      source: 'uat',
      depth: 'all',
      anonymize: { rules: {} },
      fit,
    });

  it('takes the seed, the draw, a window, filters of the roots and strata, as the clone’s --fit-* flags', () => {
    const fit = {
      withinMB: 150,
      seed: 7,
      draw: 'oldest',
      window: { field: 'created', from: '2025-01-01', to: '2025-06-30' },
      where: { Account: "BillingCountry = 'France'" },
      strata: ['Account.RecordTypeId', 'Lead.Status'],
    };
    expect(envFileSchema.parse(withFit(fit)).resources['sample']).toMatchObject({ fit });
    expect(refusalsOf(withFit({ draw: 'recent' }))).toEqual([]);
    expect(refusalsOf(withFit({ window: { field: 'modified', lastDays: 30 } }))).toEqual([]);
    expect(
      refusalsOf(withFit({ window: { field: 'created', from: '2025-01-01T06:00:00Z' } })),
    ).toEqual([]);
    expect(refusalsOf(withFit({}))).toEqual([]);
  });

  it('refuses a draw, a window or a stratum the clone would not take, each in its words', () => {
    const shapes =
      'resources.sample.fit: fit is share, or a mapping of withinMB, seed, draw (uniform, recent or oldest), window ({ field: created or modified, from, to } or { field, lastDays }), where and strata';
    expect(refusalsOf(withFit({ draw: 'newest' }))).toEqual([shapes]);
    expect(refusalsOf(withFit({ window: { field: 'created' } }))).toEqual([
      'resources.sample.fit.window: A window gives from, to or both, or lastDays: the last days the roots were made in',
    ]);
    expect(
      refusalsOf(withFit({ window: { field: 'created', from: '2025-01-01', lastDays: 7 } })),
    ).toEqual([
      'resources.sample.fit.window.lastDays: lastDays counts back from each draw, and takes no from or to: give one or the other',
    ]);
    // A date alone as the end takes its whole day: the same day both ends is one day.
    expect(
      refusalsOf(withFit({ window: { field: 'created', from: '2025-06-30', to: '2025-06-30' } })),
    ).toEqual([]);
    expect(
      refusalsOf(withFit({ window: { field: 'created', from: '2025-07-01', to: '2025-06-30' } })),
    ).toEqual(['resources.sample.fit.window.to: A window’s from is before its to']);
    expect(refusalsOf(withFit({ window: { field: 'created', from: '01/07/2025' } }))).toEqual([
      'resources.sample.fit.window.from: A bound is a date, as 2025-06-30, or an instant in UTC, as 2025-06-30T12:00:00Z',
    ]);
    expect(refusalsOf(withFit({ window: { field: 'made', lastDays: 7 } }))).toEqual([shapes]);
    expect(refusalsOf(withFit({ strata: ['RecordTypeId', 'OwnerId'] }))).toEqual([
      'resources.sample.fit.strata.1: OwnerId: the roots are stratified by one field of every object at most',
    ]);
    expect(refusalsOf(withFit({ where: { Account: "Name = 'x' --" } }))).toHaveLength(1);
  });

  it('refuses a key of the fit it does not name, and the seed’s fit refuses the draw', () => {
    expect(refusalsOf(withFit({ draws: 'oldest' }))).toEqual([
      expect.stringContaining(
        '"draws" is not a key of fit, which takes withinMB, seed, draw, window, where, strata',
      ),
    ]);
    // A seed draws no root: its fit takes the MB alone.
    expect(
      refusalsOf(exampleWith(['resources', 'accounts', 'fit'], { withinMB: 5, draw: 'oldest' })),
    ).toEqual([expect.stringMatching(/^resources\.accounts\.fit/)]);
  });
});

/** A frozen resource as a project's file pins its dataset. */
function frozen(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'frozen',
    config: 'frozen/claims.frozen.json',
    dataset: {
      path: { env: 'SANDFORGE_CLAIMS_DATASET' },
      version: '1.4.0',
      digest: `sha256:${'3f'.repeat(32)}`,
    },
    ...over,
  };
}

describe('a frozen resource', () => {
  it('reads a committed configuration and a dataset pinned by its version and its digest, its path a variable or from the root', () => {
    expect(refusalsOf(exampleWith(['resources', 'claims'], frozen()))).toEqual([]);
    expect(
      refusalsOf(
        exampleWith(
          ['resources', 'claims'],
          frozen({
            dataset: { path: '/data/claims', version: '1.4.0', digest: `sha256:${'0'.repeat(64)}` },
          }),
        ),
      ),
    ).toEqual([]);
    expect(
      refusalsOf(
        exampleWith(
          ['resources', 'claims'],
          frozen({
            dataset: {
              path: 'C:\\data\\claims',
              version: '1.4.0',
              digest: `sha256:${'0'.repeat(64)}`,
            },
          }),
        ),
      ),
    ).toEqual([]);
  });

  it('refuses a dataset named from the file’s folder, a version or a digest its manifest would not give, and one left unpinned', () => {
    const dataset = (over: Record<string, unknown>) =>
      refusalsOf(
        exampleWith(
          ['resources', 'claims'],
          frozen({
            dataset: {
              path: '/data/claims',
              version: '1.4.0',
              digest: `sha256:${'0'.repeat(64)}`,
              ...over,
            },
          }),
        ),
      );
    expect(dataset({ path: 'datasets/claims' })).toEqual([
      expect.stringContaining('resources.claims.dataset.path: A dataset is named by its path'),
    ]);
    expect(dataset({ version: 'v1' })).toEqual([
      'resources.claims.dataset.version: A dataset’s version is the one its manifest says, as 1.4.0',
    ]);
    expect(dataset({ digest: '3f1c' })).toEqual([
      'resources.claims.dataset.digest: A dataset’s digest is sha256: and 64 hexadecimal digits, as sandforge frozen gives it',
    ]);
    expect(dataset({ digest: undefined })).toEqual([
      expect.stringContaining('resources.claims.dataset.digest'),
    ]);
    expect(
      refusalsOf(exampleWith(['resources', 'claims'], frozen({ config: '../frozen.json' }))),
    ).toEqual([
      expect.stringContaining(
        'resources.claims.config: A path is written from the folder of the file',
      ),
    ]);
    expect(refusalsOf(exampleWith(['resources', 'claims'], frozen({ salted: true })))).toEqual([
      expect.stringContaining(
        '"salted" is not a key of a frozen resource, which takes kind, dependsOn, accept, config, dataset',
      ),
    ]);
  });
});

describe('a relation drawing its parents from another resource', () => {
  const contacts = (parents: Record<string, unknown>) =>
    exampleWith(['resources', 'contacts', 'relations', 0, 'parents'], parents);

  it('reads from a resource with its object, or from a resource and its object together, a limit beside it', () => {
    expect(refusalsOf(contacts({ object: 'Account', from: 'accounts' }))).toEqual([]);
    expect(refusalsOf(contacts({ from: 'accounts.Account' }))).toEqual([]);
    expect(refusalsOf(contacts({ object: 'Account', from: 'accounts.Account', limit: 5 }))).toEqual(
      [],
    );
  });

  it('refuses parents with no object, two objects, existing records beside them, and a limit with no from', () => {
    const at = 'resources.contacts.relations.0.parents';
    expect(refusalsOf(contacts({ from: 'accounts' }))).toEqual([
      `${at}.object: A relation’s parents name their object: object: Account, or from: <resource>.Account`,
    ]);
    expect(refusalsOf(contacts({ object: 'Account', from: 'accounts.Contact' }))).toEqual([
      `${at}.from: from names Contact records and object names Account: keep one of them`,
    ]);
    expect(
      refusalsOf(contacts({ object: 'Account', from: 'accounts', existing: { limit: 2 } })),
    ).toEqual([
      `${at}.existing: The parents are the records another resource created (from) or records the org holds (existing), not both: keep one`,
    ]);
    expect(refusalsOf(contacts({ object: 'Account', limit: 2 }))).toEqual([
      `${at}.limit: limit goes with from: existing parents take their own, under existing`,
    ]);
    expect(refusalsOf(contacts({ object: 'Account', from: 'Accounts' }))).toEqual([
      expect.stringContaining(`${at}.from: from names a resource of the file`),
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
  it('reads { env: NAME } as an org role’s alias and a dataset’s path, and nowhere else', () => {
    expect(isEnvRefPlace(['orgs', 'uat', 'alias'])).toBe(true);
    expect(isEnvRefPlace(['resources', 'claims', 'dataset', 'path'])).toBe(true);
    for (const path of [
      ['resources', 'claims', 'dataset', 'version'],
      ['resources', 'claims', 'config'],
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
 * The uat sandbox, refreshed from production, handed back to its testers: its
 * testers set up first, its contacts masked, the records it held before its
 * refresh replayed, demo cases seeded, then the audits and the handoff note.
 */
function refreshedUat(): Record<string, unknown> {
  return {
    version: 1,
    name: 'uat-after-refresh',
    targets: { kinds: ['sandbox'], sandboxes: [{ myDomain: 'acme--uat' }] },
    orgs: { prod: { alias: { env: 'SF_PROD_ALIAS' } } },
    checkpoint: { after: 'uat-baseline' },
    masking: {
      'contact-points': {
        rules: [
          { fieldPattern: 'Contact.Email', ruleType: 'fake' },
          { fieldPattern: 'Contact.Phone', ruleType: 'mask', config: { maskKeepLast: 2 } },
        ],
      },
    },
    resources: {
      testers: {
        kind: 'users',
        defaults: { email: 'restore', frozen: false },
        users: [
          {
            username: 'jane.qa@acme.example',
            permissionSets: ['QA_Tools'],
            groups: ['QA_Team'],
          },
          {
            username: 'paul.qa@acme.example',
            active: true,
            profile: 'QA Tester',
            permissionSetGroups: ['Support_Bundle'],
          },
          { username: 'erp.integration@acme.example', email: 'keep', frozen: true },
        ],
      },
      customers: { kind: 'mask', rules: 'contact-points', object: 'Contact' },
      'test-data': {
        kind: 'replay',
        dependsOn: ['customers'],
        checkpoint: { name: 'uat-before-refresh' },
        owners: 'same',
      },
      'demo-cases': {
        kind: 'seed',
        dependsOn: ['test-data'],
        template: 'prebuilt-service-cloud-starter',
      },
    },
    audits: {
      schedules: true,
      endpoints: {
        productionHosts: ['erp.acme.example'],
        fields: ['Integration_Setting__mdt.Endpoint__c'],
      },
      handoff: true,
    },
  };
}

/** The refreshed uat file with one change at `path`. */
function refreshedWith(path: Array<string | number>, value: unknown): Record<string, unknown> {
  const document = refreshedUat();
  let node: Record<string | number, unknown> = document;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  const last = path[path.length - 1] as string | number;
  if (value === undefined) delete node[last];
  else node[last] = value;
  return document;
}

describe('the file of a sandbox refreshed, handed back', () => {
  it('reads it whole: users, a masking, a replay, a seed, the audits', () => {
    expect(refusalsOf(refreshedUat())).toEqual([]);
  });
});

describe('a users resource', () => {
  const testers = ['resources', 'testers'];

  it('takes kind, accept, defaults and users, and nothing else: no dependsOn, it is applied first', () => {
    expect(refusalsOf(refreshedWith([...testers, 'accept'], { automation: true }))).toEqual([]);
    expect(refusalsOf(refreshedWith([...testers, 'dependsOn'], ['customers']))).toEqual([
      'resources.testers: "dependsOn" is not a key of a users resource, which takes kind, accept, defaults, users: a users resource is applied first, before every other, and depends on none',
    ]);
    expect(refusalsOf(refreshedWith([...testers, 'profiles'], ['QA Tester']))).toEqual([
      expect.stringContaining('"profiles" is not a key of a users resource'),
    ]);
  });

  it('refuses a resource that depends on a users resource, which runs first whatever the file says', () => {
    expect(
      refusalsOf(refreshedWith(['resources', 'test-data', 'dependsOn'], ['customers', 'testers'])),
    ).toEqual([
      'resources.test-data.dependsOn: testers is a users resource, applied first whatever the file says: take it out of dependsOn',
    ]);
  });

  it('refuses a relation drawing its parents from a users resource, which creates no record', () => {
    const drawing = refreshedWith(['resources', 'cases'], {
      kind: 'seed',
      objects: [{ object: 'Case', count: 3 }],
      relations: [
        {
          lookup: 'Case.OwnerId',
          parents: { object: 'User', from: 'testers' },
          distribution: { mode: 'perParent', count: 1 },
        },
      ],
    });
    expect(refusalsOf(drawing)).toEqual([
      'resources.cases.relations.0.parents.from: testers is a users resource: it creates no record to draw parents from',
    ]);
  });

  it('takes each user’s keys, a password reset among none of them', () => {
    const jane = [...testers, 'users', 0];
    expect(refusalsOf(refreshedWith([...jane, 'login'], 'reset-email'))).toEqual([
      'resources.testers.users.0: "login" is not a key of a user of a users resource, which takes username, email, active, frozen, profile, permissionSets, permissionSetGroups, groups: SandForge resets no password; once the address is restored, its owner asks Salesforce for one with Forgot your password?',
    ]);
    const reset = refreshedWith([...jane, 'resetPassword'], true);
    expect(refusalsOf(reset)).toEqual([
      expect.stringContaining('"resetPassword" is not a key of a user of a users resource'),
    ]);
    expect(secretKeysIn(reset)).toEqual([
      {
        path: ['resources', 'testers', 'users', 0, 'resetPassword'],
        key: 'resetPassword',
        secret: 'password',
      },
    ]);
    expect(
      secretKeysIn(refreshedWith([...testers, 'defaults', 'password'], 'Welcome1')),
    ).toHaveLength(1);
    expect(secretKeyOf('keyEnv')).toBeUndefined();
  });

  it('takes restore or keep for email, and booleans for active and frozen', () => {
    const jane = [...testers, 'users', 0];
    expect(refusalsOf(refreshedWith([...jane, 'email'], 'reset'))).toEqual([
      'resources.testers.users.0.email: email is restore, which takes off the .invalid the copy added, or keep, the address as it is',
    ]);
    expect(refusalsOf(refreshedWith([...jane, 'email'], 'jane.qa@acme.example'))).toHaveLength(1);
    expect(refusalsOf(refreshedWith([...jane, 'active'], 'yes'))).toEqual([
      expect.stringMatching(/^resources\.testers\.users\.0\.active: /),
    ]);
    expect(refusalsOf(refreshedWith([...testers, 'defaults', 'frozen'], 1))).toEqual([
      expect.stringMatching(/^resources\.testers\.defaults\.frozen: /),
    ]);
    expect(
      refusalsOf(refreshedWith([...testers, 'defaults', 'username'], 'x@acme.example')),
    ).toEqual([
      expect.stringContaining('"username" is not a key of the defaults of a users resource'),
    ]);
  });

  it('holds 1 to 200 users, 50 permission sets, 20 groups of them and 50 groups each', () => {
    const users = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ username: `tester${i}@acme.example` }));
    const names = (count: number, prefix: string) =>
      Array.from({ length: count }, (_, i) => `${prefix}_${i}`);
    expect(refusalsOf(refreshedWith([...testers, 'users'], users(200)))).toEqual([]);
    expect(refusalsOf(refreshedWith([...testers, 'users'], users(201)))).toEqual([
      'resources.testers.users: 201 users: a users resource holds 200 at most: split it in two',
    ]);
    expect(refusalsOf(refreshedWith([...testers, 'users'], []))).toEqual([
      'resources.testers.users: A users resource lists one user at least: username, then what to set up',
    ]);
    const jane = [...testers, 'users', 0];
    expect(refusalsOf(refreshedWith([...jane, 'permissionSets'], names(50, 'PS')))).toEqual([]);
    expect(refusalsOf(refreshedWith([...jane, 'permissionSets'], names(51, 'PS')))).toEqual([
      'resources.testers.users.0.permissionSets: A user is given 50 permission sets at most in one entry',
    ]);
    expect(refusalsOf(refreshedWith([...jane, 'permissionSetGroups'], names(21, 'G')))).toEqual([
      'resources.testers.users.0.permissionSetGroups: A user is given 20 permission set groups at most in one entry',
    ]);
    expect(refusalsOf(refreshedWith([...jane, 'groups'], names(51, 'Q')))).toEqual([
      'resources.testers.users.0.groups: A user joins 50 groups and queues at most in one entry',
    ]);
    expect(refusalsOf(refreshedWith([...jane, 'groups'], ['QA_Team', 'QA_Team']))).toEqual([
      'resources.testers.users.0.groups.1: QA_Team is listed twice: name a group once',
    ]);
    expect(refusalsOf(refreshedWith([...jane, 'permissionSets'], ['QA Tools']))).toEqual([
      'resources.testers.users.0.permissionSets.0: A permission set is named by its API name, as QA_Tools (Setup > Permission Sets > API Name)',
    ]);
  });

  it('names each user once in the file, all its users resources together', () => {
    const admins = refreshedWith(['resources', 'admins'], {
      kind: 'users',
      users: [{ username: 'Paul.QA@acme.example', permissionSets: ['Admin_Tools'] }],
    });
    expect(refusalsOf(admins)).toEqual([
      'resources.admins.users.0.username: Paul.QA@acme.example is listed twice (also resources.testers.users[1]): one entry per user',
    ]);
    expect(
      refusalsOf(
        refreshedWith([...testers, 'users', 2], {
          username: 'jane.qa@acme.example',
          frozen: true,
        }),
      ),
    ).toEqual([
      'resources.testers.users.2.username: jane.qa@acme.example is listed twice (also resources.testers.users[0]): one entry per user',
    ]);
  });

  it('takes a username shaped as Salesforce holds one, production’s or the sandbox’s', () => {
    const jane = [...testers, 'users', 0, 'username'];
    expect(refusalsOf(refreshedWith(jane, 'jane.qa@acme.example.uat'))).toEqual([]);
    for (const username of ['jane.qa', 'jane qa@acme.example', `${'j'.repeat(70)}@acme.example`]) {
      expect(refusalsOf(refreshedWith(jane, username)), username).toEqual([
        expect.stringMatching(/^resources\.testers\.users\.0\.username: .* is not a username/),
      ]);
    }
  });
});

describe('a sandbox listed by its My Domain', () => {
  it('lists a sandbox or protects an org by its My Domain, beside Organization Ids', () => {
    const listed = refreshedWith(['targets'], {
      kinds: ['sandbox'],
      sandboxes: ['00Dxx0000001234AAA', { myDomain: 'acme--uat' }],
      protect: [{ myDomain: 'acme--full' }, '00Dxx0000005678AAA'],
    });
    expect(refusalsOf(listed)).toEqual([]);
    expect(envFileSchema.parse(listed).targets.sandboxes[1]).toEqual({ myDomain: 'acme--uat' });
  });

  it('refuses production’s My Domain and a whole host, each with the name to give', () => {
    expect(refusalsOf(refreshedWith(['targets', 'sandboxes', 0, 'myDomain'], 'acme'))).toEqual([
      "targets.sandboxes.0.myDomain: acme is production's My Domain: a sandbox's is acme--<its name>, as acme--uat",
    ]);
    expect(
      refusalsOf(
        refreshedWith(
          ['targets', 'sandboxes', 0, 'myDomain'],
          'acme--uat.sandbox.my.salesforce.com',
        ),
      ),
    ).toEqual([
      "targets.sandboxes.0.myDomain: acme--uat.sandbox.my.salesforce.com is a host: give the sandbox's My Domain alone, the part before .sandbox.my.salesforce.com, as acme--uat",
    ]);
    expect(refusalsOf(refreshedWith(['targets', 'protect'], [{ myDomain: 'Acme--UAT' }]))).toEqual([
      expect.stringContaining(
        "targets.protect.0.myDomain: A sandbox's My Domain is lower-case letters, digits and dashes",
      ),
    ]);
    expect(
      refusalsOf(refreshedWith(['targets', 'sandboxes', 0], { myDomain: 'acme--uat', id: 'x' })),
    ).toEqual([expect.stringContaining('"id" is not a key of a My Domain, which takes myDomain')]);
  });

  it('says how to write a My Domain given where an Organization Id goes', () => {
    expect(refusalsOf(refreshedWith(['targets', 'sandboxes', 0], 'acme--uat'))).toEqual([
      'targets.sandboxes.0: acme--uat is no Organization Id: list an org by its Id (00D…, 15 or 18 characters), or a sandbox by its My Domain, as { myDomain: acme--uat }',
    ]);
  });
});

describe('a replay resource', () => {
  const replay = ['resources', 'test-data'];

  it('replays a checkpoint by its id, by its name, or by a file and the variable holding its key', () => {
    for (const checkpoint of [
      { id: 'ck-20261114-174750-5e38' },
      { name: 'uat-before-refresh' },
      { file: '/runner/work/uat-before-refresh.sfcheckpoint', keyEnv: 'UAT_CHECKPOINT_KEY' },
      { file: { env: 'UAT_CHECKPOINT_FILE' }, keyEnv: 'UAT_CHECKPOINT_KEY' },
    ]) {
      expect(
        refusalsOf(refreshedWith([...replay, 'checkpoint'], checkpoint)),
        JSON.stringify(checkpoint),
      ).toEqual([]);
    }
  });

  it('takes one form of checkpoint, its key named by a variable and never written', () => {
    const one = 'resources.test-data.checkpoint: give id, name, or file with keyEnv: one of them';
    expect(refusalsOf(refreshedWith([...replay, 'checkpoint'], {}))).toEqual([one]);
    expect(
      refusalsOf(
        refreshedWith([...replay, 'checkpoint'], { id: 'ck-20261114-174750-5e38', name: 'x' }),
      ),
    ).toEqual([one]);
    expect(
      refusalsOf(refreshedWith([...replay, 'checkpoint'], { file: '/runner/x.sfcheckpoint' })),
    ).toEqual([
      'resources.test-data.checkpoint.keyEnv: a checkpoint file is read with the key the variable keyEnv names: give keyEnv, as keyEnv: UAT_CHECKPOINT_KEY',
    ]);
    expect(refusalsOf(refreshedWith([...replay, 'checkpoint'], { keyEnv: 'KEY' }))).toEqual([
      'resources.test-data.checkpoint.keyEnv: keyEnv goes with file, the checkpoint file it opens',
    ]);
    const withKey = (keyEnv: unknown) =>
      refreshedWith([...replay, 'checkpoint'], { file: '/runner/x.sfcheckpoint', keyEnv });
    expect(refusalsOf(withKey({ env: 'UAT_CHECKPOINT_KEY' }))).toEqual([
      'resources.test-data.checkpoint.keyEnv: keyEnv is the name of the variable that holds the key, as keyEnv: UAT_CHECKPOINT_KEY, not { env: … }',
    ]);
    expect(refusalsOf(withKey('uat_key'))).toEqual([
      'resources.test-data.checkpoint.keyEnv: A variable is named in upper-case letters, digits and underscores, as UAT_CHECKPOINT_KEY',
    ]);
    expect(refusalsOf(withKey('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRST'))).toEqual([
      'resources.test-data.checkpoint.keyEnv: this is shaped like the key itself: keyEnv names the variable that holds it, and the file holds no secret',
    ]);
    expect(
      refusalsOf(refreshedWith([...replay, 'checkpoint'], { id: 'uat-before-refresh' })),
    ).toEqual([
      expect.stringMatching(/^resources\.test-data\.checkpoint\.id: .*name: uat-before-refresh/),
    ]);
  });

  it('names a checkpoint file from the root or by a variable: it holds records, outside the repository', () => {
    expect(
      refusalsOf(
        refreshedWith([...replay, 'checkpoint'], {
          file: 'exports/uat.sfcheckpoint',
          keyEnv: 'UAT_CHECKPOINT_KEY',
        }),
      ),
    ).toEqual([
      'resources.test-data.checkpoint.file: A checkpoint file is named by its path from the root, as /runner/work/uat.sfcheckpoint, or by { env: NAME }: it holds records, and lives outside the repository',
    ]);
    expect(isEnvRefPlace(['resources', 'test-data', 'checkpoint', 'file'])).toBe(true);
    expect(isEnvRefPlace(['resources', 'test-data', 'checkpoint', 'keyEnv'])).toBe(false);
    expect(isEnvRefPlace(['resources', 'test-data', 'checkpoint', 'name'])).toBe(false);
    expect(ENV_REF_PLACES).toContain('resources.<replay>.checkpoint.file');
  });

  it('takes the org role a named checkpoint was taken of with from, and nowhere else', () => {
    expect(
      refusalsOf(
        refreshedWith(replay, {
          kind: 'replay',
          checkpoint: { name: 'pr-before' },
          from: 'prod',
        }),
      ),
    ).toEqual([]);
    expect(
      refusalsOf(
        refreshedWith(replay, {
          kind: 'replay',
          checkpoint: { id: 'ck-20261114-174750-5e38' },
          from: 'prod',
        }),
      ),
    ).toEqual([
      'resources.test-data.from: from goes with checkpoint: { name }: it names the org role the checkpoint of that name was taken of',
    ]);
    expect(
      refusalsOf(refreshedWith(replay, { kind: 'replay', checkpoint: { name: 'x' }, from: 'uat' })),
    ).toEqual([
      'resources.test-data.from: "uat" is no org role of the file: declare it under orgs, as orgs: { uat: { alias: { env: … } } } (its roles are prod)',
    ]);
  });

  it('takes the choices of sandforge checkpoint replay, each under its flag’s name', () => {
    const choices = {
      kind: 'replay',
      checkpoint: { name: 'uat-before-refresh' },
      objects: ['Account', 'Contact', 'Case'],
      excludeObjects: ['Task'],
      owners: 'me',
      customSettings: true,
      mask: true,
      keepContactPoints: false,
      maxRecords: 5_000,
      accept: { automation: true },
    };
    expect(refusalsOf(refreshedWith(replay, choices))).toEqual([]);
    expect(refusalsOf(refreshedWith(replay, { ...choices, owners: 'them' }))).toEqual([
      'resources.test-data.owners: owners is same, each record keeping its owner where that user is active, or me, the user connected',
    ]);
    expect(refusalsOf(refreshedWith(replay, { ...choices, maxRecords: 0 }))).toEqual([
      expect.stringMatching(/^resources\.test-data\.maxRecords: /),
    ]);
    expect(refusalsOf(refreshedWith(replay, { ...choices, objects: ['Case', 'Case'] }))).toEqual([
      'resources.test-data.objects.1: Case is listed twice: an object is listed once',
    ]);
    for (const key of ['link', 'ownerMap', 'noRealData', 'again', 'acceptEmails']) {
      expect(refusalsOf(refreshedWith(replay, { ...choices, [key]: true })), key).toEqual([
        expect.stringContaining(`"${key}" is not a key of a replay resource`),
      ]);
    }
  });
});

describe('the audits a file asks', () => {
  const endpoints = ['audits', 'endpoints'];

  it('takes the scheduled jobs, the endpoints and the handoff note, each asked by itself', () => {
    expect(refusalsOf(refreshedWith(endpoints, true))).toEqual([]);
    expect(refusalsOf(refreshedWith(['audits'], { handoff: true }))).toEqual([]);
    expect(refusalsOf(refreshedWith(['audits', 'jobs'], true))).toEqual([
      'audits: "jobs" is not a key of audits, which takes schedules, endpoints, handoff',
    ]);
    expect(refusalsOf(refreshedWith(['audits', 'handoff'], 'yes'))).toEqual([
      expect.stringMatching(/^audits\.handoff: /),
    ]);
  });

  it('takes production’s hosts as names alone, each once, 50 at most', () => {
    const hosts = [...endpoints, 'productionHosts'];
    expect(refusalsOf(refreshedWith(hosts, ['https://erp.acme.example/api']))).toEqual([
      'audits.endpoints.productionHosts.0: https://erp.acme.example/api is no host name: write the host alone, without https:// nor a path, as erp.acme.example',
    ]);
    expect(refusalsOf(refreshedWith(hosts, ['erp.acme.example', 'erp.acme.example']))).toEqual([
      'audits.endpoints.productionHosts.1: erp.acme.example is listed twice: a host is listed once',
    ]);
    const many = Array.from({ length: 51 }, (_, i) => `host${i}.acme.example`);
    expect(refusalsOf(refreshedWith(hosts, many))).toEqual([
      'audits.endpoints.productionHosts: 50 hosts at most: SandForge deduces production’s own from the sandbox',
    ]);
  });

  it('takes the fields that hold a URL, of a Custom Metadata Type or a Custom Setting, named with it', () => {
    const fields = [...endpoints, 'fields'];
    expect(
      refusalsOf(
        refreshedWith(fields, ['acme__Integration__mdt.acme__Url__c', 'ERP_Settings__c.Url__c']),
      ),
    ).toEqual([]);
    for (const field of ['Account.Website', 'Integration_Setting__mdt', 'Endpoint__c']) {
      expect(refusalsOf(refreshedWith(fields, [field])), field).toEqual([
        `audits.endpoints.fields.0: ${field} is no field of a Custom Metadata Type (__mdt) or a Custom Setting named with it: write Object.Field, as Integration_Setting__mdt.Endpoint__c`,
      ]);
    }
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
    expect(
      holdsTo(
        jsonSchema,
        exampleWith(['resources', 'bug-1234'], {
          kind: 'forge',
          source: 'uat',
          record: { object: 'Case', where: "CaseNumber = '00001026'" },
          anonymize: { rules: { email: 'fake' } },
        }),
      ),
    ).toEqual([]);
    expect(holdsTo(jsonSchema, exampleWith(['resources', 'claims'], frozen()))).toEqual([]);
    expect(holdsTo(jsonSchema, refreshedUat())).toEqual([]);
    expect(
      holdsTo(
        jsonSchema,
        refreshedWith(['resources', 'test-data', 'checkpoint'], {
          file: { env: 'UAT_CHECKPOINT_FILE' },
          keyEnv: 'UAT_CHECKPOINT_KEY',
        }),
      ),
    ).toEqual([]);
  });

  it('refuses by its shape a My Domain that is no sandbox’s, a user’s key it does not take and an email it does not know', () => {
    const refused = [
      refreshedWith(['targets', 'sandboxes', 0, 'myDomain'], 'acme'),
      refreshedWith(['resources', 'testers', 'users', 0, 'login'], 'reset-email'),
      refreshedWith(['resources', 'testers', 'users', 0, 'email'], 'reset'),
      refreshedWith(['resources', 'testers', 'dependsOn'], ['customers']),
      refreshedWith(['resources', 'test-data', 'owners'], 'them'),
      refreshedWith(['audits', 'endpoints', 'fields'], ['Account.Website']),
    ];

    for (const document of refused) {
      expect(holdsTo(jsonSchema, document)).not.toEqual([]);
      expect(envFileSchema.safeParse(document).success).toBe(false);
    }
  });

  it('refuses what the zod schema refuses, by the same shape', () => {
    const refused = [
      exampleWith(['dry_run'], true),
      exampleWith(['version'], 2),
      exampleWith(['resources', 'claims'], { kind: 'frozen' }),
      exampleWith(['resources', 'masked'], { kind: 'mask' }),
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

  it('reads a resource state recover rebuilt, marked so and fingerprinted as no resource is', () => {
    const record = state();
    const accounts = (record['resources'] as Record<string, Record<string, unknown>>)['accounts'];
    accounts!['recovered'] = true;
    accounts!['fingerprint'] = RECOVERED_FINGERPRINT;
    expect(envStateSchema.safeParse(record).success).toBe(true);
    expect(RECOVERED_FINGERPRINT).toMatch(/^[0-9a-f]{64}$/);
    // Only the mark: a resource is recovered or says nothing of it.
    accounts!['recovered'] = false;
    expect(envStateSchema.safeParse(record).success).toBe(false);
  });

  it('reads a users resource run by sandforge users and a replay by sandforge checkpoint, and the host the org answered on', () => {
    const record = state();
    (record['org'] as Record<string, unknown>)['host'] = 'acme--uat.sandbox.my.salesforce.com';
    const resources = record['resources'] as Record<string, unknown>;
    const run = (script: string) => ({
      n: 1,
      script,
      summary: 'runs/x/1.summary.json',
      startedAt: '2026-11-20T08:14:00.000Z',
      exitCode: 0,
      objects: [],
    });
    resources['testers'] = {
      kind: 'users',
      fingerprint: 'c'.repeat(64),
      dependsOn: [],
      status: 'applied',
      runs: [run('sandforge-users')],
    };
    resources['test-data'] = {
      kind: 'replay',
      fingerprint: 'd'.repeat(64),
      dependsOn: [],
      status: 'applied',
      runs: [run('sandforge-checkpoint')],
    };
    expect(envStateSchema.safeParse(record).success).toBe(true);
    // A host is a name, never a URL with its path.
    (record['org'] as Record<string, unknown>)['host'] =
      'https://acme--uat.sandbox.my.salesforce.com/';
    expect(envStateSchema.safeParse(record).success).toBe(false);
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

  it('reads a users action: what changes for each user, and the emails Salesforce sends to people', () => {
    const users = {
      ...plan,
      org: { ...plan.org, kind: 'sandbox', host: 'acme--uat.sandbox.my.salesforce.com' },
      state: {
        found: false,
        refreshed: {
          organizationId: '00Dxx0000001gPLEAY',
          serial: 9,
          updatedAt: '2026-11-14T17:47:50.000Z',
          setAside: '/home/dev/.sandforge/env/00Dxx0000001gPLEAY/uat-after-refresh',
        },
      },
      actions: [
        {
          resource: 'testers',
          kind: 'users',
          action: 'create',
          why: 'not applied to this org yet',
          objects: [{ object: 'User', wouldCreate: 3 }],
          users: [
            {
              username: 'jane.qa@acme.example.uat',
              given: 'jane.qa@acme.example',
              userId: '005000000000001AAA',
              address: 'invalid',
              changes: [
                { what: 'email', to: 'awaiting' },
                { what: 'frozen', from: true, to: false },
                { what: 'permissionSet', name: 'QA_Tools', to: 'added' },
                { what: 'group', name: 'QA_Team', type: 'Regular', to: 'added' },
              ],
              emailsToPeople: 1,
            },
          ],
          gates: { emailsToPeople: 1 },
        },
      ],
      gates: { ...plan.gates, emailsToPeople: { count: 1, accepted: false } },
    };

    expect(envPlanSchema.safeParse(users).success).toBe(true);
    // A plan made before 1.82 says nothing of people's emails, and still reads.
    expect(envPlanSchema.safeParse(plan).success).toBe(true);
    const address = structuredClone(users);
    (address.actions[0]!.users[0] as Record<string, unknown>)['email'] = 'jane.qa@acme.example';
    expect(envPlanSchema.safeParse(address).success).toBe(false);
    expect(
      envPlanSchema.safeParse({
        ...users,
        gates: { ...users.gates, emailsToPeople: { count: 1 } },
      }).success,
    ).toBe(false);
  });

  it('reads a count given as the most a run writes, and only as true', () => {
    const bounded = (atMost: unknown) => ({
      ...plan,
      actions: [{ ...plan.actions[0], objects: [{ object: 'Contact', wouldCreate: 6, atMost }] }],
    });
    expect(envPlanSchema.safeParse(bounded(true)).success).toBe(true);
    expect(envPlanSchema.safeParse(bounded(false)).success).toBe(false);
  });

  it('reads the parents a relation draws from another resource, counted once that one has run and not before', () => {
    const drawing = (draws: unknown) => ({
      ...plan,
      actions: [{ ...plan.actions[0], resource: 'contacts', draws }],
    });
    const draw = { lookup: 'Contact.AccountId', from: 'accounts', object: 'Account' };
    expect(envPlanSchema.safeParse(drawing([{ ...draw, parents: 20 }])).success).toBe(true);
    expect(envPlanSchema.safeParse(drawing([draw])).success).toBe(true);
    expect(envPlanSchema.safeParse(drawing([{ ...draw, parents: -1 }])).success).toBe(false);
    expect(envPlanSchema.safeParse(drawing([{ ...draw, ids: ['001'] }])).success).toBe(false);
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

  it('reads the checkpoints a plan takes, each with its estimate or its refusal, and the drift of the whole org', () => {
    const withCheckpoints = {
      ...plan,
      actions: [{ ...plan.actions[0], notes: ['its source is a production org'] }],
      checkpoints: [
        {
          step: 'before',
          name: 'case-flow-e2e before',
          estimate: { records: 120, apiRequests: 31, seconds: 4.5, bytes: 40_960 },
        },
        {
          step: 'after',
          name: 'baseline',
          refusal: { code: 'PERMISSIONS', message: 'Modify All Data is missing' },
        },
      ],
      drift: { checkpoint: 'ck-20261025-090000-a1b2', differs: true, toDelete: 1, toGiveBack: 2 },
    };

    expect(envPlanSchema.safeParse(withCheckpoints).success).toBe(true);
    expect(
      envPlanSchema.safeParse({
        ...withCheckpoints,
        checkpoints: [{ step: 'during', name: 'x' }],
      }).success,
    ).toBe(false);
    expect(
      envPlanSchema.safeParse({
        ...withCheckpoints,
        drift: { checkpoint: 'baseline', differs: false },
      }).success,
    ).toBe(false);
  });

  it('reads the checkpoints an apply took or deleted, by the checkpoint script’s exit', () => {
    const result = {
      plan,
      steps: [],
      checkpoints: [
        { step: 'before', checkpoint: 'ck-20261025-090000-a1b2', exitCode: 0 },
        { step: 'delete', checkpoint: 'ck-20261024-090000-c3d4', exitCode: 0 },
        { step: 'after', exitCode: 1, refusal: 'PERMISSIONS: Modify All Data is missing' },
      ],
      status: 'partial',
      state: { serial: 9 },
    };

    expect(envRunResultSchema.safeParse(result).success).toBe(true);
    expect(
      envRunResultSchema.safeParse({
        ...result,
        checkpoints: [{ step: 'reset', exitCode: 0 }],
      }).success,
    ).toBe(false);
  });

  it('reads what reset and destroy --rewind answer: an undo offered with its line, or why not', () => {
    const rewound = {
      env: 'case-flow-e2e',
      org: { organizationId: '00Dxx0000001234AAA', kind: 'scratch', alias: 'pool-1' },
      verb: 'reset',
      checkpoint: { step: 'after', id: 'ck-20261025-090000-a1b2', name: 'baseline' },
      preview: { toDelete: 1, toGiveBack: 2, toBringBack: 1, lastChangedBy: { Tester: 3 } },
      exitCode: 0,
      status: 'success',
      undo: {
        offered: true,
        until: '2026-11-09T09:00:00.000Z',
        line: 'npx sandforge checkpoint undo --org pool-1 --checkpoint ck-20261025-090000-a1b2',
      },
      state: { serial: 4 },
    };

    expect(envRewindResultSchema.safeParse(rewound).success).toBe(true);
    expect(
      envRewindResultSchema.safeParse({
        ...rewound,
        verb: 'destroy',
        undo: { offered: false, why: 'its checkpoints are deleted with the environment' },
      }).success,
    ).toBe(true);
    // An undo offered names until when, and the line that does it.
    expect(envRewindResultSchema.safeParse({ ...rewound, undo: { offered: true } }).success).toBe(
      false,
    );
    expect(envRewindResultSchema.safeParse({ ...rewound, verb: 'rewind' }).success).toBe(false);
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

  it('reads the handoff note an apply wrote and the audits it read, as env audit answers them', () => {
    const result = {
      plan,
      steps: [],
      status: 'success',
      state: { serial: 12 },
      audits: audited(),
      handoff: {
        path: '/home/dev/.sandforge/env/00Dxx0000002AbCEAU/uat-after-refresh/handoff-2026-11-20T08-14-51Z.md',
      },
    };
    expect(envRunResultSchema.safeParse(result).success).toBe(true);
    expect(
      envRunResultSchema.safeParse({ ...result, handoff: { path: '', text: '# Environment' } })
        .success,
    ).toBe(false);
  });

  it('reads a step refused before it wrote, in its script’s words, and no empty refusal', () => {
    const refused = {
      resource: 'cloned',
      action: 'create',
      phase: 'run',
      run: 1,
      script: 'sandforge-clone',
      exitCode: 1,
      status: 'failed',
      objects: [],
      refusal: 'The run would write 6 records, more than --max-total 5. Nothing was written.',
    };
    const result = { plan, steps: [refused], status: 'failure', state: { serial: 2 } };

    expect(envRunResultSchema.parse(result).steps[0]?.refusal).toBe(refused.refusal);
    expect(
      envRunResultSchema.safeParse({ ...result, steps: [{ ...refused, refusal: '' }] }).success,
    ).toBe(false);
  });
});

describe('a saved plan', () => {
  const saved = {
    savedPlan: 1,
    sandforgeVersion: '1.69.0',
    madeAt: '2026-10-25T09:00:00.000Z',
    file: { digest: 'a'.repeat(64) },
    state: { found: true, serial: 4, lineage: '0b6f4a35-6d2e-4f8e-9a3c-2b1d5e7f9a10' },
    line: {
      replace: ['accounts'],
      replaceDrifted: false,
      acceptAutomation: false,
      acceptNoState: false,
    },
    seeds: { accounts: 4242 },
    plan: {
      env: 'case-flow',
      org: { organizationId: '00Dxx0000001234AAA', kind: 'scratch', alias: 'pool-1' },
      state: { found: true, serial: 4 },
      actions: [],
      totals: { create: 0, keep: 0, replace: 0, delete: 0, drifted: 0, blocked: 0 },
      gates: { apiRequests: { estimate: 0, partial: false }, storage: { bytes: 0 }, emails: [] },
    },
  };

  it('reads what plan --out writes: the plan, the state it was made against, its line and its seeds', () => {
    expect(envSavedPlanSchema.parse(saved).state).toEqual(saved.state);
    expect(envSavedPlanSchema.safeParse({ ...saved, state: { found: false } }).success).toBe(true);
  });

  it('reads whether its line accepted the emails, and a plan saved before the line could say so as accepting none', () => {
    const accepting = { ...saved, line: { ...saved.line, acceptEmails: true } };

    expect(envSavedPlanSchema.parse(accepting).line.acceptEmails).toBe(true);
    expect(envSavedPlanSchema.parse(saved).line).not.toHaveProperty('acceptEmails');
    expect(
      envSavedPlanSchema.safeParse({ ...saved, line: { ...saved.line, acceptEmails: 'yes' } })
        .success,
    ).toBe(false);
  });

  it('reads whether its line accepted the emails Salesforce sends to people, and a plan saved before 1.82 as accepting none', () => {
    const accepting = { ...saved, line: { ...saved.line, acceptUserEmails: true } };

    expect(envSavedPlanSchema.parse(accepting).line.acceptUserEmails).toBe(true);
    expect(envSavedPlanSchema.parse(saved).line).not.toHaveProperty('acceptUserEmails');
    expect(
      envSavedPlanSchema.safeParse({ ...saved, line: { ...saved.line, acceptUserEmails: 1 } })
        .success,
    ).toBe(false);
  });

  it('refuses a key it does not name, a state found with no lineage, and a version it does not know', () => {
    expect(envSavedPlanSchema.safeParse({ ...saved, accessToken: 'x' }).success).toBe(false);
    expect(
      envSavedPlanSchema.safeParse({ ...saved, state: { found: true, serial: 4 } }).success,
    ).toBe(false);
    expect(envSavedPlanSchema.safeParse({ ...saved, savedPlan: 2 }).success).toBe(false);
    expect(
      envSavedPlanSchema.safeParse({ ...saved, plan: { ...saved.plan, values: {} } }).success,
    ).toBe(false);
  });
});

describe('what output answers', () => {
  const output = {
    env: 'case-flow',
    org: { organizationId: '00Dxx0000001234AAA', kind: 'scratch', alias: 'pool-1' },
    state: { serial: 4, updatedAt: '2026-10-25T09:03:00.000Z' },
    resources: {
      accounts: {
        kind: 'seed',
        status: 'applied',
        run: 1,
        records: { Account: ['001000000000000AAA', '001000000000001AAA'] },
      },
      customers: {
        kind: 'mask',
        status: 'applied',
        run: 1,
        records: {},
        masked: { Contact: 3 },
        snapshotId: 'cli-dataops-anonymize-1-a1b2c3-snapshot',
        why: 'a masking creates no record',
      },
      gone: { kind: 'seed', status: 'destroyed', records: {}, why: 'taken back by a destroy' },
    },
  };

  it('reads each resource by its name, the ids of what it created by object', () => {
    expect(envOutputSchema.parse(output).resources['accounts']?.records['Account']).toHaveLength(2);
  });

  it('names the users a users resource set up, by username and id alone', () => {
    const withUsers = (users: unknown) => ({
      ...output,
      resources: {
        testers: {
          kind: 'users',
          status: 'applied',
          run: 1,
          records: {},
          users,
          why: 'a users resource creates no record',
        },
      },
    });
    expect(
      envOutputSchema.safeParse(
        withUsers([{ username: 'jane.qa@acme.example.uat', userId: '005000000000001AAA' }]),
      ).success,
    ).toBe(true);
    expect(
      envOutputSchema.safeParse(
        withUsers([
          {
            username: 'jane.qa@acme.example.uat',
            userId: '005000000000001AAA',
            email: 'jane.qa@acme.example',
          },
        ]),
      ).success,
    ).toBe(false);
  });

  it('refuses an id that is no record’s, and a value beside the ids', () => {
    const withRecords = (records: unknown) => ({
      ...output,
      resources: { accounts: { kind: 'seed', status: 'applied', records } },
    });
    expect(envOutputSchema.safeParse(withRecords({ Account: ['CI account'] })).success).toBe(false);
    expect(
      envOutputSchema.safeParse(withRecords({ Account: [{ Id: '001000000000000AAA', Name: 'x' }] }))
        .success,
    ).toBe(false);
  });
});

describe('what the other verbs answer', () => {
  it('reads what state recover answers, and no key it does not name', () => {
    const answer = {
      env: 'case-flow',
      org: { organizationId: '00D000000000009EAA', kind: 'developer', alias: 'DEV' },
      state: { serial: 1, lineage: '7c1d3f9e-2b4a-4c5d-8e6f-0a1b2c3d4e5f' },
      setAside:
        '/home/dev/.sandforge/env/00D000000000009EAA/case-flow/state.json.damaged-20261028-090000',
      resources: {
        contacts: { kind: 'seed', status: 'applied', runs: [1, 2], takenBack: [1], inFile: true },
      },
      checkpoints: {},
      notLinked: ['checkpoint before: the file asks none'],
    };
    expect(envRecoverResultSchema.safeParse(answer).success).toBe(true);
    expect(envRecoverResultSchema.safeParse({ ...answer, records: {} }).success).toBe(false);
  });

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
        variables: [
          { name: 'SF_UAT_ALIAS', role: 'uat', set: false },
          { name: 'SANDFORGE_CLAIMS_DATASET', resource: 'claims', set: true },
        ],
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

/** What env audit answers of the uat sandbox after its refresh. */
function audited(): Record<string, unknown> {
  return {
    org: {
      organizationId: '00Dxx0000002AbCEAU',
      kind: 'sandbox',
      alias: 'uat',
      host: 'acme--uat.sandbox.my.salesforce.com',
    },
    at: '2026-11-20T08:14:49.000Z',
    apiRequests: 8,
    deliverability: { read: 'closed' },
    schedules: {
      now: 6,
      against: {
        savedAt: '2026-11-18T18:00:00.000Z',
        organizationId: '00Dxx0000001gPLEAY',
        refreshed: true,
      },
      jobs: [
        {
          status: 'gone',
          name: 'Nightly ERP sync',
          type: 'Scheduled Apex',
          cronExpression: '0 0 2 * * ?',
        },
        {
          status: 'frozen',
          name: 'Weekly digest',
          type: 'Scheduled Apex',
          owner: 'ops.batch@acme.example.uat',
          nextFireTime: '2026-11-21T06:00:00.000Z',
        },
        { status: 'new', name: 'Data cleanup', type: 'Batch Job' },
      ],
      kept: 3,
    },
    endpoints: {
      productionHosts: [
        'acme.my.salesforce.com',
        'acme.lightning.force.com',
        'acme.my.site.com',
        'login.salesforce.com',
        'erp.acme.example',
      ],
      found: [
        {
          source: 'namedCredential',
          name: 'ERP_API',
          url: 'https://erp.acme.example/api',
          host: 'erp.acme.example',
          why: 'listed',
        },
        {
          source: 'remoteSite',
          name: 'SF_Prod',
          url: 'https://acme.my.salesforce.com/',
          host: 'acme.my.salesforce.com',
          why: 'myDomain',
        },
        {
          source: 'field',
          name: 'Integration_Setting__mdt.Default.Endpoint__c',
          url: 'https://login.salesforce.com/services/oauth2/token',
          host: 'login.salesforce.com',
          why: 'login',
        },
      ],
    },
    findings: 5,
  };
}

describe('what env audit answers', () => {
  it('reads the deliverability, the scheduled jobs against the inventory before the refresh, and the endpoints that name production', () => {
    expect(envAuditResultSchema.safeParse(audited()).success).toBe(true);
    const unread = {
      ...audited(),
      deliverability: { unread: 'the org refused the anonymous Apex that reads it' },
      schedules: { now: 0, jobs: [], kept: 0, unread: 'CronTrigger is not readable by this user' },
    };
    expect(envAuditResultSchema.safeParse(unread).success).toBe(true);
  });

  it('never holds a URL’s query, fragment or the credentials it may carry', () => {
    const withUrl = (url: string) => {
      const answer = audited();
      const endpoints = answer['endpoints'] as { found: Array<Record<string, unknown>> };
      endpoints.found[0]!['url'] = url;
      return answer;
    };
    expect(envAuditResultSchema.safeParse(withUrl('https://erp.acme.example/api/v2')).success).toBe(
      true,
    );
    for (const url of [
      'https://erp.acme.example/api/v2?key=abc123',
      'https://erp.acme.example/api#token',
      'https://user:pass@erp.acme.example/api',
    ]) {
      expect(envAuditResultSchema.safeParse(withUrl(url)).success, url).toBe(false);
    }
  });

  it('never names a job by its owner’s address, nor a status it does not know', () => {
    const job = (over: Record<string, unknown>) => {
      const answer = audited();
      const schedules = answer['schedules'] as { jobs: Array<Record<string, unknown>> };
      schedules.jobs[0] = { ...schedules.jobs[0], ...over };
      return answer;
    };
    expect(envAuditResultSchema.safeParse(job({ status: 'late' })).success).toBe(false);
    expect(envAuditResultSchema.safeParse(job({ ownerEmail: 'ops@acme.example' })).success).toBe(
      false,
    );
  });
});
