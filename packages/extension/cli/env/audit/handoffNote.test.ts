import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  envRunResultSchema,
  usersApplyAnswerSchema,
  type EnvAction,
  type EnvAuditResult,
  type EnvOutput,
  type EnvRunResult,
  type UsersApplyAnswer,
} from '@sandforge/shared';
import { commandOf } from '../../invocation.js';
import {
  handoffNoteOf,
  handoffPathOf,
  writeHandoffNote,
  type HandoffInput,
} from './handoffNote.js';

const AFTER = '00Dxx0000002AbCEAU';
const HOST = 'acme--uat.sandbox.my.salesforce.com';
const CHECKPOINT = 'ck-20261120-081200-a1b2';

/**
 * Words a script or the org could say, which may quote what a record holds:
 * none of them is ever written into the note.
 */
const SAID = [
  'SAID-IN-A-REASON',
  'SAID-IN-A-REFUSAL',
  'SAID-IN-AN-ANSWER',
  'SAID-IN-A-WHY',
  'SAID-IN-A-NOTE',
  'SAID-IN-A-WARNING',
  'SAID-IN-A-SKIP',
  'SAID-BY-THE-CHECKPOINT',
  'SAID-IN-A-CONDITION',
  'SAID-BY-THE-ORG',
];

const action = (
  resource: string,
  kind: EnvAction['kind'],
  over: Partial<EnvAction> = {},
): EnvAction => ({
  resource,
  kind,
  action: 'create',
  why: 'SAID-IN-A-WHY: not applied yet',
  objects: [],
  notes: ['SAID-IN-A-NOTE'],
  ...over,
});

const USERS: UsersApplyAnswer = {
  org: { organizationId: AFTER, kind: 'sandbox', alias: 'uat', username: 'admin@acme.com.uat' },
  run: 1,
  status: 'partial',
  users: [
    {
      username: 'jane.qa@acme.com.uat',
      userId: '005xx0000001AAAAAA',
      before: { isActive: true, isFrozen: true, profileId: '00exx0000001AAAAAA' },
      done: [
        { what: 'email', to: 'awaiting' },
        { what: 'frozen', from: true, to: false },
        { what: 'permissionSet', name: 'QA_Tools', to: 'added' },
        { what: 'group', name: 'QA_Team', type: 'Regular', to: 'added' },
      ],
      created: {
        permissionSetAssignments: ['0Paxx0000001AAAAAA'],
        groupMembers: ['011xx0000001AAAAAA'],
      },
      address: 'awaiting',
    },
    {
      username: 'paul.qa@acme.com.uat',
      userId: '005xx0000002AAAAAA',
      before: { isActive: false, isFrozen: false, profileId: '00exx0000001AAAAAA' },
      done: [{ what: 'profile', from: 'Standard User', to: 'QA Tester' }],
      created: { permissionSetAssignments: [], groupMembers: [] },
      refused: [
        {
          change: { what: 'active', from: false, to: true },
          code: 'LICENSE_LIMIT_EXCEEDED',
          message: 'SAID-BY-THE-ORG: License Limit Exceeded',
        },
      ],
    },
    {
      username: 'erp.integration@acme.com.uat',
      userId: '005xx0000003AAAAAA',
      before: { isActive: true, isFrozen: true, profileId: '00exx0000001AAAAAA' },
      done: [],
      created: { permissionSetAssignments: [], groupMembers: [] },
      address: 'kept',
    },
  ],
  emailsToPeople: 1,
  apiRequests: 12,
};

const AUDITS: EnvAuditResult = {
  org: { organizationId: AFTER, kind: 'sandbox', alias: 'uat', host: HOST },
  at: '2026-11-20T08:14:49.000Z',
  apiRequests: 8,
  deliverability: { read: 'closed' },
  schedules: {
    now: 5,
    against: {
      savedAt: '2026-11-18T20:00:00.000Z',
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
        owner: 'ops.batch@acme.com.uat',
        nextFireTime: '2026-11-21T06:00:00.000Z',
      },
      { status: 'new', name: 'Data cleanup', type: 'Batch Job' },
    ],
    kept: 3,
  },
  endpoints: {
    productionHosts: ['acme.my.salesforce.com', 'login.salesforce.com', 'erp.acme.com'],
    found: [
      {
        source: 'namedCredential',
        name: 'ERP_API',
        url: 'https://erp.acme.com/api/v2/orders',
        host: 'erp.acme.com',
        why: 'listed',
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
  findings: 4,
};

function apply(over: Partial<EnvRunResult> = {}): EnvRunResult {
  return {
    plan: {
      env: 'uat-after-refresh',
      org: { organizationId: AFTER, kind: 'sandbox', alias: 'uat', host: HOST },
      state: { found: false },
      actions: [
        action('testers', 'users'),
        action('customers', 'mask'),
        action('test-data', 'replay'),
        action('demo-cases', 'seed'),
        action('old-cases', 'seed', { action: 'keep' }),
        action('crm-copy', 'forge', { action: 'blocked', refusal: 'SAID-IN-A-REFUSAL' }),
        action('late-cases', 'seed'),
      ],
      totals: { create: 5, keep: 1, replace: 0, delete: 0, drifted: 0, blocked: 1 },
      gates: { apiRequests: { estimate: 40, partial: false }, storage: { bytes: 0 }, emails: [] },
      checkpoints: [
        {
          step: 'after',
          name: 'uat-baseline',
          estimate: { records: 420, apiRequests: 6, seconds: 12, bytes: 40_000 },
        },
      ],
      warnings: ['SAID-IN-A-WARNING'],
    },
    steps: [
      {
        resource: 'testers',
        action: 'create',
        phase: 'run',
        run: 1,
        script: 'sandforge-users',
        exitCode: 3,
        status: 'partial',
        summary: 'runs/testers/1.summary.json',
        objects: [],
        answer: USERS,
      },
      {
        resource: 'customers',
        action: 'create',
        phase: 'run',
        run: 1,
        script: 'sandforge-dataops',
        exitCode: 0,
        status: 'applied',
        summary: 'runs/customers/1.summary.json',
        objects: [
          {
            object: 'Contact',
            created: 0,
            refused: 0,
            deleted: 0,
            kept: 0,
            masked: 118,
            reason: 'SAID-IN-A-REASON: jane.doe@acme.com',
          },
        ],
        answer: { firstValue: 'SAID-IN-AN-ANSWER' },
      },
      {
        resource: 'test-data',
        action: 'create',
        phase: 'run',
        run: 1,
        script: 'sandforge-checkpoint',
        exitCode: 3,
        status: 'partial',
        objects: [
          { object: 'Account', created: 40, refused: 0, deleted: 0, kept: 0 },
          {
            object: 'Contact',
            created: 118,
            refused: 2,
            deleted: 0,
            kept: 0,
            reason: 'SAID-IN-A-REASON',
          },
        ],
        refusal: 'SAID-IN-A-REFUSAL: duplicate of Jane Doe',
      },
      {
        resource: 'demo-cases',
        action: 'create',
        phase: 'run',
        run: 1,
        script: 'sandforge-seed',
        exitCode: 0,
        status: 'applied',
        objects: [{ object: 'Case', created: 25, refused: 0, deleted: 0, kept: 0 }],
      },
    ],
    checkpoints: [
      {
        step: 'after',
        checkpoint: CHECKPOINT,
        exitCode: 0,
        answer: { said: 'SAID-BY-THE-CHECKPOINT' },
      },
    ],
    skipped: [{ resource: 'late-cases', why: 'SAID-IN-A-SKIP' }],
    status: 'partial',
    state: { serial: 4 },
    audits: AUDITS,
    ...over,
  };
}

const OUTPUT: EnvOutput = {
  env: 'uat-after-refresh',
  org: { organizationId: AFTER, kind: 'sandbox', alias: 'uat' },
  state: { serial: 4, updatedAt: '2026-11-20T08:14:00.000Z' },
  resources: {
    customers: {
      kind: 'mask',
      status: 'applied',
      run: 1,
      records: {},
      masked: { Contact: 118 },
      snapshotId: 'op-20261120-081000-c3d4',
    },
  },
};

function input(over: Partial<HandoffInput> = {}): HandoffInput {
  return {
    run: apply(),
    org: { organizationId: AFTER, kind: 'sandbox', alias: 'uat', host: HOST },
    file: '../uat/sandforge.yaml',
    at: '2026-11-20T08:14:00.000Z',
    sandforgeVersion: '1.82.0',
    output: OUTPUT,
    resources: {
      testers: { kind: 'users', users: [{ username: 'jane.qa@acme.com' }] },
      customers: {
        kind: 'mask',
        rules: 'contact-points',
        object: 'Contact',
        where: "Email LIKE 'SAID-IN-A-CONDITION%'",
      },
      'test-data': { kind: 'replay', checkpoint: { name: 'uat-before-refresh' }, owners: 'same' },
      'demo-cases': { kind: 'seed', template: 'prebuilt-service-cloud-starter' },
    } as HandoffInput['resources'],
    masking: {
      'contact-points': {
        rules: [
          { fieldPattern: 'Contact.Email', ruleType: 'fake' },
          { fieldPattern: 'Contact.Phone', ruleType: 'mask', config: { maskKeepLast: 2 } },
        ],
      },
    } as HandoffInput['masking'],
    ...over,
  };
}

describe('the fixture of an apply', () => {
  it('is an answer apply gives, its users step one sandforge users gives', () => {
    expect(envRunResultSchema.safeParse(apply()).error?.issues).toBeUndefined();
    expect(usersApplyAnswerSchema.safeParse(USERS).error?.issues).toBeUndefined();
  });
});

describe('the handoff note', () => {
  it('holds its five sections, in order', () => {
    const note = handoffNoteOf(input());
    const headings = note.split('\n').filter((line) => line.startsWith('## '));
    expect(headings).toEqual([
      '## Environment',
      '## Access',
      '## Data',
      '## Still to do, in this order',
      '## Not touched by SandForge',
    ]);
    expect(note.startsWith('# Handoff: `uat-after-refresh` on `uat`\n')).toBe(true);
  });

  it('names the environment, the org by its My Domain and Id, when, the version and the state', () => {
    const note = handoffNoteOf(input());
    expect(note).toContain('- Environment: `uat-after-refresh`, state serial 4.');
    expect(note).toContain(`- Org: \`uat\`, sandbox \`acme--uat\`, \`${AFTER}\`.`);
    expect(note).toContain(
      '- Applied: 2026-11-20T08:14:00Z, by SandForge 1.82.0; it ended partial.',
    );
  });

  it('says per user what was done, and lists apart each address awaiting its owner, with its 72 hours', () => {
    const note = handoffNoteOf(input());
    expect(note).toContain(
      '- `jane.qa@acme.com.uat`: address asked back, awaiting its owner; unfrozen; permission set ' +
        '`QA_Tools`; public group `QA_Team`.',
    );
    expect(note).toContain(
      '- `paul.qa@acme.com.uat`: profile `QA Tester`; activated refused (LICENSE_LIMIT_EXCEEDED).',
    );
    expect(note).toContain('- `erp.integration@acme.com.uat`: as the file says already.');
    expect(note).toContain(
      '### Addresses awaiting their owner\n\n- `jane.qa@acme.com.uat`: the address stays under ' +
        '`.invalid` until its owner follows the link Salesforce sent to it, by about ' +
        '2026-11-23T08:14:00Z (72 hours).',
    );
    expect(note).toContain(
      'SandForge resets no password: a user without one sets it by **Forgot your password?** on ' +
        "the sandbox's login page, once the address is theirs again.",
    );
  });

  it('says what each data resource did by counts alone, the fields masked and the snapshot taken first', () => {
    const note = handoffNoteOf(input());
    expect(note).toContain(
      '- `customers` (mask): applied; masked Contact 118; fields `Contact.Email`, `Contact.Phone`; ' +
        'snapshot `op-20261120-081000-c3d4`, taken first.',
    );
    expect(note).toContain(
      '- `test-data` (replay): applied in part; created Account 40, Contact 118; refused Contact 2; ' +
        'owners kept as the checkpoint names them.',
    );
    expect(note).toContain('- `demo-cases` (seed): applied; created Case 25.');
    expect(note).toContain('- `old-cases` (seed): kept, as applied before');
    expect(note).toContain('- `crm-copy` (forge): not applied: refused before it wrote');
    expect(note).toContain(
      '- `late-cases` (seed): not run: a resource it depends on did not end whole',
    );
  });

  it('names the starting point the testers get, and the line that returns the org to it', () => {
    const note = handoffNoteOf(input());
    expect(note).toContain(
      `- Checkpoint \`uat-baseline\` \`${CHECKPOINT}\`, about 420 records: the org as the testers get it.`,
    );
    expect(note).toContain(
      `- Back to it between two test runs: \`${commandOf('env')} reset --file ../uat/sandforge.yaml --org uat\``,
    );
  });

  it('holds no value of a record, and no word a script or the org said', () => {
    const note = handoffNoteOf(input());
    for (const said of SAID) expect(note).not.toContain(said);
    expect(note).not.toContain('Jane Doe');
    expect(note).not.toContain('jane.doe@acme.com');
  });

  it('names an endpoint by its host alone: never its URL, its path nor its query', () => {
    const note = handoffNoteOf(input());
    expect(note).toContain(
      '   - Named Credential `ERP_API` names `erp.acme.com`, a production host the file lists.',
    );
    expect(note).not.toContain('https://');
    expect(note).not.toContain('/api/v2/orders');
    expect(note).not.toContain('oauth2');
  });

  it('lists what is left in a refresh checklist’s order: credentials, jobs, emails, deliverability', () => {
    const note = handoffNoteOf(input());
    const at = (words: string): number => note.indexOf(words);
    expect(at('1. Credentials and technical components')).toBeGreaterThan(at('## Still to do'));
    expect(at('2. Scheduled jobs')).toBeGreaterThan(at('1. Credentials'));
    expect(at('3. Automations that send emails')).toBeGreaterThan(at('2. Scheduled jobs'));
    expect(at('4. Deliverability.')).toBeGreaterThan(at('3. Automations'));
    expect(note).toContain(
      '   - `Nightly ERP sync` (Scheduled Apex) was scheduled in the inventory of 2026-11-18, and is not now.',
    );
    expect(note).toContain(
      '   - `Weekly digest` (Scheduled Apex) runs as `ops.batch@acme.com.uat`, who is frozen: its next run fails.',
    );
    expect(note).not.toContain('Data cleanup');
    expect(note).toContain(
      '   - Read closed, System email only or No access: leave it so until the masking is done.',
    );
  });

  it('says what was not audited, with the line that audits it', () => {
    const note = handoffNoteOf(input({ run: apply({ audits: undefined }) }));
    const line = `\`${commandOf('env')} audit --file ../uat/sandforge.yaml --org uat\``;
    expect(note).toContain(`   - Not audited: ${line} lists those that still name production.`);
    expect(note).toContain(`   - Not audited: ${line} compares them with their inventory.`);
    expect(note).toContain('   - Not read: Setup > Deliverability shows it.');
  });

  it('says what of an audit was not read, never taken for nothing found', () => {
    const unread: EnvAuditResult = {
      ...AUDITS,
      deliverability: { unread: 'the org refused it' },
      schedules: { now: 0, jobs: [], kept: 0, unread: 'the org refused it' },
      endpoints: {
        productionHosts: ['login.salesforce.com'],
        found: [],
        unread: 'the org refused it',
      },
      findings: 0,
    };
    const note = handoffNoteOf(input({ run: apply({ audits: unread }) }));
    expect(note).toContain(
      '   - Not all read: check the Named Credentials, the Remote Site Settings and the Custom Metadata in Setup.',
    );
    expect(note).toContain('   - Not all read: Setup > Scheduled Jobs lists them.');
    expect(note).not.toContain('None of those read names production.');
    expect(note).not.toContain('None gone, none stuck.');
  });

  it('with no inventory from before the refresh, never says no job is gone', () => {
    const none: EnvAuditResult = {
      ...AUDITS,
      schedules: { now: 3, jobs: [], kept: 3 },
      findings: 2,
    };
    const note = handoffNoteOf(input({ run: apply({ audits: none }) }));
    expect(note).toContain(
      '   - No inventory from before the refresh was kept on this machine: what is gone is not known.',
    );
    expect(note).toContain('   - None stuck.');
    expect(note).not.toContain('None gone');
  });

  it('says whose each thing SandForge leaves is: Setup, sf or the deployment', () => {
    const note = handoffNoteOf(input());
    const left = note.slice(note.indexOf('## Not touched by SandForge'));
    for (const line of left.split('\n').filter((one) => one.startsWith('- '))) {
      expect(line).toMatch(/Setup|`sf`|deployment|Forgot your password\?/);
    }
    expect(left).toContain('Named and External Credentials');
    expect(left).toContain('DKIM');
  });

  it('keeps a name from breaking its line or its code span', () => {
    const note = handoffNoteOf(
      input({
        run: apply({
          plan: { ...apply().plan, env: 'uat-after-refresh' },
          audits: {
            ...AUDITS,
            schedules: {
              now: 1,
              jobs: [{ status: 'gone', name: 'Bad `name`\n## Injected', type: 'Scheduled Apex' }],
              kept: 0,
            },
          },
        }),
      }),
    );
    expect(note).not.toContain('\n## Injected');
    expect(note).toContain('`Bad  name ## Injected`');
  });
});

describe('where a note is kept', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('is the journal directory by default, outside the repository, by environment, instant and org', () => {
    expect(
      handoffPathOf('/j', {
        env: 'uat-after-refresh',
        organizationId: AFTER,
        at: '2026-11-20T08:14:00.000Z',
      }),
    ).toBe(join(resolve('/j'), 'handoff', 'uat-after-refresh', `20261120T081400000Z-${AFTER}.md`));
    expect(() =>
      handoffPathOf('/j', {
        env: '../escape',
        organizationId: AFTER,
        at: '2026-11-20T08:14:00.000Z',
      }),
    ).toThrow("Not an environment's name");
  });

  it('is written whole, for its owner alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandforge-handoff-'));
    made.push(dir);
    const path = handoffPathOf(dir, {
      env: 'uat-after-refresh',
      organizationId: AFTER,
      at: '2026-11-20T08:14:00.000Z',
    });
    const note = handoffNoteOf(input());
    await writeHandoffNote(path, note);
    expect(readFileSync(path, 'utf8')).toBe(note);
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'handoff', 'uat-after-refresh')).mode & 0o777).toBe(0o700);
    }
  });
});
