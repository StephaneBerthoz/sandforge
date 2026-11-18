import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  EnvForgeResource,
  EnvFrozenResource,
  EnvMaskResource,
  EnvReplayResource,
  EnvSeedResource,
  EnvUsersResource,
  SeedTemplate,
} from '@sandforge/shared';
import {
  applyLineOf,
  convertResource,
  dryRunCountOf,
  dryRunLineOf,
  isAppliedKind,
  notesOf,
  objectsOfRun,
  payloadOf,
  previewedRunsOf,
  previewLineOf,
  readDryRunOf,
  readPreviewOf,
  readRemovalOf,
  refreshLineOf,
  removalObjectsOf,
  removeLineOf,
  replacesInOneRun,
  scriptOfKind,
  writtenOf,
} from './envKinds.js';
import type { EnvFileResource } from './envFile.js';
import type { ForgeDryRunAnswer } from './kinds/forge.js';
import type { EnvReplayCheckpointRead, EnvReplayPlace } from './kinds/replay.js';

/*
 * The kinds of resource are reached through one module: each function picks
 * the kind's own. A kind this SandForge does not apply is refused, never
 * taken for another.
 */

const NOW = new Date('2026-10-25T09:00:00.000Z');

const seed: EnvSeedResource = {
  kind: 'seed',
  objects: [
    {
      object: 'Account',
      count: 2,
      fields: [{ fieldApiName: 'Name', ruleType: 'static', config: { staticValue: 'SFENV' } }],
    },
  ],
};
const forge: EnvForgeResource = {
  kind: 'forge',
  source: 'uat',
  tables: [{ object: 'Account', where: "Name = 'SFENV'" }],
};

/** The project folder a frozen resource's configuration is read from. */
const project = mkdtempSync(join(tmpdir(), 'sandforge-env-kinds-'));
afterAll(() => rmSync(project, { recursive: true, force: true }));
writeFileSync(
  join(project, 'claims.frozen.json'),
  JSON.stringify({ rootObject: 'Account', axes: [], edgeCases: [] }),
);
const frozen: EnvFrozenResource = {
  kind: 'frozen',
  config: 'claims.frozen.json',
  dataset: { path: '/data/claims', version: '1.0.0', digest: `sha256:${'0'.repeat(64)}` },
};

/** Contacts drawing their accounts from what another resource created. */
const drawing: EnvSeedResource = {
  kind: 'seed',
  objects: [
    {
      object: 'Contact',
      count: 4,
      fields: [{ fieldApiName: 'LastName', ruleType: 'static', config: { staticValue: 'SFENV' } }],
    },
  ],
  relations: [
    {
      lookup: 'Contact.AccountId',
      parents: { from: 'accounts.Account' },
      distribution: { mode: 'perParent', count: 2 },
    },
  ],
};

/** Contacts with an email, masked by a set of the file: the email hashed. */
const mask: EnvMaskResource = {
  kind: 'mask',
  rules: 'contact-points',
  object: 'Contact',
  where: "LastName = 'Copied'",
};
const SETS = {
  'contact-points': {
    name: 'contact-points',
    rules: [{ fieldPattern: 'Contact.Email', ruleType: 'hash' as const }],
  },
};

/** A resource of the file, ready to plan, as `resolveEnvFile` makes one. */
function ready(
  resource: EnvSeedResource | EnvForgeResource | EnvFrozenResource | EnvMaskResource,
  read?: { organizationId: string; recordId?: string },
  sets: Parameters<typeof convertResource>[5] = SETS,
): EnvFileResource {
  const converted = convertResource('demo', 'r', resource, project, NOW, sets);
  if ('refusals' in converted) throw new Error(converted.refusals.map((r) => r.message).join('; '));
  const { run } = converted;
  if (run.kind === 'seed') {
    const { kind, ...rest } = run;
    return { name: 'r', kind, dependsOn: [], fingerprint: '', run: rest };
  }
  if (run.kind === 'mask') {
    const { kind, ...rest } = run;
    return { name: 'r', kind, dependsOn: [], fingerprint: '', run: rest };
  }
  if (run.kind === 'frozen') {
    const { kind, ...rest } = run;
    return {
      name: 'r',
      kind,
      dependsOn: [],
      fingerprint: '',
      run: rest,
      dataset: { dir: '/data/claims' },
    };
  }
  if (run.kind !== 'forge') throw new Error(`not made ready here: ${run.kind}`);
  const { kind, ...rest } = run;
  return {
    name: 'r',
    kind,
    dependsOn: [],
    fingerprint: '',
    run: rest,
    source: { role: 'uat', alias: 'SRC', ...(read !== undefined ? { read } : {}) },
  };
}

describe('the kinds of resource', () => {
  it('applies seed, forge, frozen and mask resources, each by its script', () => {
    expect(isAppliedKind('seed')).toBe(true);
    expect(isAppliedKind('frozen')).toBe(true);
    expect(isAppliedKind('mask')).toBe(true);
    expect(scriptOfKind('seed')).toBe('sandforge-seed');
    expect(scriptOfKind('forge')).toBe('sandforge-clone');
    expect(scriptOfKind('frozen')).toBe('sandforge-frozen');
    expect(scriptOfKind('mask')).toBe('sandforge-dataops');
  });

  it('gives a mask resource’s lines to sandforge-dataops: its dry run and its run, in its own store, and never a removal', () => {
    const context = {
      target: 'TGT',
      templateFile: '/tmp/r.1.json',
      runId: '',
      store: '/journal/env/o/e/dataops/r',
    };

    expect(dryRunLineOf(ready(mask), context).args).toEqual([
      'anonymize',
      '--org',
      'TGT',
      '--object',
      'Contact',
      '--where',
      "LastName = 'Copied'",
      '--rules',
      '/tmp/r.1.json',
      '--store',
      '/journal/env/o/e/dataops/r',
      '--dry-run',
      '--json',
    ]);
    expect(applyLineOf(ready(mask), { ...context, summaryFile: '' }).args.slice(-3)).toEqual([
      '/journal/env/o/e/dataops/r',
      '--yes',
      '--json',
    ]);
    // A template that ships is named by its id, and needs no rules file.
    const shipped = ready({ kind: 'mask', rules: { template: 'tpl-gdpr-standard' } });
    expect(dryRunLineOf(shipped, context).args).toEqual(
      expect.arrayContaining(['--template', 'tpl-gdpr-standard']),
    );
    expect(dryRunLineOf(shipped, context).args).not.toContain('--rules');
    // Its snapshots are kept in its store: no line without one.
    expect(() => dryRunLineOf(ready(mask), { ...context, store: undefined })).toThrow(
      'r is given no store to keep its snapshots in: plan again.',
    );
    // A masking is never taken back, nor previewed for a removal.
    const removal = {
      target: 'TGT',
      subject: '/s',
      includeChanged: false,
      acceptAutomation: false,
    };
    expect(() => removeLineOf('mask', { ...removal, sweep: false })).toThrow(
      'sandforge dataops takes no run back: a masking is never undone',
    );
    expect(() => previewLineOf('mask', removal)).toThrow('takes no run back');
    const runs: Array<{ n: number; takenBack?: true }> = [{ n: 1 }, { n: 2 }];
    expect(previewedRunsOf('mask', runs)).toEqual([]);
    expect(replacesInOneRun('mask')).toBe(true);
    // Its payload is the rules file sandforge-dataops --rules reads.
    expect(payloadOf(ready(mask), {})).toEqual(SETS['contact-points']);
  });

  it('fingerprints a mask resource by what its rules do, not by their name or their order', () => {
    const twoRules = (order: 'email-first' | 'phone-first', name: string) => {
      const rules = [
        { fieldPattern: 'Contact.Email', ruleType: 'hash' as const },
        { fieldPattern: 'Contact.Phone', ruleType: 'nullify' as const },
      ];
      return writtenOf(
        ready({ kind: 'mask', rules: name, object: 'Contact' }, undefined, {
          [name]: { name, rules: order === 'email-first' ? rules : [...rules].reverse() },
        }),
      );
    };

    expect(twoRules('email-first', 'a')).toEqual(twoRules('phone-first', 'b'));
    expect(writtenOf(ready(mask))).not.toEqual(
      writtenOf(ready({ ...mask, where: "LastName = 'Other'" })),
    );
  });

  it('converts each resource by its kind’s module, and lists what each writes', () => {
    const seedRun = convertResource('demo', 'accounts', seed, tmpdir(), NOW);
    const forgeRun = convertResource('demo', 'cloned', forge, tmpdir(), NOW);

    if ('refusals' in seedRun || 'refusals' in forgeRun) throw new Error('refused');
    expect(seedRun.run.kind).toBe('seed');
    expect(forgeRun.run.kind).toBe('forge');
    expect(objectsOfRun(seedRun.run)).toEqual([{ object: 'Account', count: 2 }]);
    expect(objectsOfRun(forgeRun.run)).toEqual([{ object: 'Account' }]);
    expect(writtenOf(ready(seed))).toMatchObject({ kind: 'seed' });
    expect(writtenOf(ready(forge, { organizationId: '00D000000000008AAA' }))).toMatchObject({
      kind: 'forge',
      source: '00D000000000008',
    });
  });

  it('gives each kind’s lines to its own script, a removal and its preview by the kind the state names', () => {
    const context = { target: 'TGT', templateFile: '/tmp/t.json', runId: 'env-demo-r-1-x' };

    expect(dryRunLineOf(ready(seed), context).script).toBe('sandforge-seed');
    expect(dryRunLineOf(ready(forge), context)).toMatchObject({ script: 'sandforge-clone' });
    expect(
      applyLineOf(ready(forge), { ...context, summaryFile: '/tmp/1.summary.json', maxTotal: 3 })
        .args,
    ).toEqual(expect.arrayContaining(['--max-total', '3', '--summary', '/tmp/1.summary.json']));
    const removal = {
      target: 'TGT',
      subject: '/tmp/1.summary.json',
      includeChanged: false,
      acceptAutomation: false,
    };
    expect(previewLineOf('forge', removal)).toMatchObject({ script: 'sandforge-clone' });
    expect(removeLineOf('seed', { ...removal, sweep: true }).args).toContain('--sweep');
  });

  it('refuses a forge run with no count from its dry run, and a record its query has not answered', () => {
    const context = {
      target: 'TGT',
      templateFile: '/tmp/t.json',
      runId: '',
      summaryFile: '/tmp/s.json',
    };
    const byQuery: EnvForgeResource = {
      kind: 'forge',
      source: 'uat',
      record: { object: 'Case', where: 'x = 1' },
    };

    expect(() => applyLineOf(ready(forge), context)).toThrow(
      'r has no count from its dry run to be held to: plan again.',
    );
    expect(() => dryRunLineOf(ready(byQuery), context)).toThrow(
      'r names its record by a query its source has not answered: plan again.',
    );
    expect(
      dryRunLineOf(
        ready(byQuery, { organizationId: '00D000000000008AAA', recordId: '500000000000001AAA' }),
        context,
      ).args,
    ).toEqual(expect.arrayContaining(['--record', '500000000000001AAA']));
  });

  it('gives a frozen resource’s lines to sandforge-frozen: its dry run, its run held to a count, a reload for a replace, its verification and its removal', () => {
    const context = { target: 'TGT', templateFile: '/tmp/r.1.json', runId: '' };

    expect(dryRunLineOf(ready(frozen), context).args).toEqual([
      'load',
      '--config',
      '/tmp/r.1.json',
      '--target',
      'TGT',
      '--dry-run',
      '--json',
    ]);
    expect(
      dryRunLineOf(ready(frozen), { ...context, replace: true, storeFile: '/tmp/store.json' }).args,
    ).toEqual(expect.arrayContaining(['--reload', '--store', '/tmp/store.json', '--dry-run']));
    expect(
      applyLineOf(ready(frozen), { ...context, summaryFile: '', maxTotal: 4, replace: true }).args,
    ).toEqual([
      'load',
      '--config',
      '/tmp/r.1.json',
      '--target',
      'TGT',
      '--reload',
      '--max-total',
      '4',
      '--yes',
      '--json',
    ]);
    // Held to a count, or not run: --max-total takes no nought.
    expect(() => applyLineOf(ready(frozen), { ...context, summaryFile: '' })).toThrow(
      'r has no count from its dry run to be held to: plan again.',
    );
    const removal = {
      target: 'TGT',
      subject: '/tmp/r.1.json',
      includeChanged: true,
      acceptAutomation: true,
    };
    expect(removeLineOf('frozen', { ...removal, sweep: false }).args).toEqual([
      'remove',
      '--config',
      '/tmp/r.1.json',
      '--target',
      'TGT',
      '--include-changed',
      '--accept-automation',
      '--yes',
      '--json',
    ]);
    expect(previewLineOf('frozen', removal).args).toEqual(
      expect.arrayContaining(['remove', '--accept-automation', '--preview', '--json']),
    );
    expect(refreshLineOf('frozen', { target: 'TGT', subject: '/tmp/r.1.json' })?.args).toEqual([
      'verify',
      '--config',
      '/tmp/r.1.json',
      '--target',
      'TGT',
      '--json',
    ]);
    expect(refreshLineOf('seed', { target: 'TGT', subject: '/tmp/s.json' })).toBeUndefined();
  });

  it('replaces a frozen resource in one run, a reload, and previews the removal of its last load alone', () => {
    expect(replacesInOneRun('frozen')).toBe(true);
    expect(replacesInOneRun('seed')).toBe(false);
    expect(replacesInOneRun('forge')).toBe(false);
    const runs = [{ n: 1 }, { n: 2, takenBack: true as const }, { n: 3 }];
    expect(previewedRunsOf('frozen', runs).map((run) => run.n)).toEqual([3]);
    expect(previewedRunsOf('seed', runs).map((run) => run.n)).toEqual([3, 1]);
  });

  it('gives a frozen run the committed configuration with the sas and the dataset the environment sets', () => {
    expect(payloadOf(ready(frozen), { sasDir: '/journal/env/o/e/frozen/r' })).toEqual({
      rootObject: 'Account',
      axes: [],
      edgeCases: [],
      sasDir: '/journal/env/o/e/frozen/r',
      datasetDir: '/data/claims',
    });
    expect(() => payloadOf(ready(frozen), {})).toThrow('r is given no folder to keep its loads in');
  });

  it('gives a seed the parents its draw is handed by id, a dry run a stand-in before they are known, and a run none', () => {
    const resource = ready(drawing);
    const relationOf = (template: unknown) => (template as SeedTemplate).relations?.[0];

    expect(
      relationOf(payloadOf(resource, { drawn: new Map([[0, ['001000000000001AAA']]]) })),
    ).toMatchObject({
      childObject: 'Contact',
      lookupField: 'AccountId',
      parentObject: 'Account',
      parents: { kind: 'records', ids: ['001000000000001AAA'] },
    });
    expect(relationOf(payloadOf(resource, { standIns: true }))?.parents).toEqual({
      kind: 'existing',
      limit: 2000,
    });
    expect(() => payloadOf(resource, {})).toThrow(
      'The relation on Contact.AccountId draws its parents from accounts, whose records are not known: plan again.',
    );
    // Its fingerprint is of the draw as the file gives it, never of the ids.
    expect(writtenOf(resource)).toMatchObject({
      draws: [expect.objectContaining({ at: 0, from: 'accounts' })],
    });
    expect(JSON.stringify(writtenOf(ready(seed)))).not.toContain('draws');
  });

  it('reads each dry run by the script that printed it', () => {
    const answer: ForgeDryRunAnswer = {
      tool: 'sandforge-clone',
      version: 1,
      dryRun: true,
      result: { wouldInsertCount: 1, failedCount: 0 },
      writePlan: {
        totalRows: 1,
        storageBytes: 2048,
        objects: [{ objectApiName: 'Account', rows: 1, storageBytes: 2048 }],
      },
    };

    expect(dryRunCountOf(answer)).toMatchObject({
      total: 1,
      objects: [{ object: 'Account', wouldCreate: 1 }],
    });
  });
});

// ─── users and replay ────────────────────────────────────────────────────────

/** The testers of the recipe: production's usernames, defaults given to each. */
const users: EnvUsersResource = {
  kind: 'users',
  defaults: { email: 'restore', frozen: false },
  users: [
    { username: 'jane.qa@acme.com', permissionSets: ['QA_Tools'], groups: ['QA_Team'] },
    { username: 'paul.qa@acme.com', active: true, profile: 'QA Tester' },
    { username: 'erp.integration@acme.com', email: 'keep', frozen: true },
  ],
};

/** The checkpoint a sandbox held before its refresh, by name, with every choice of the file. */
const replay: EnvReplayResource = {
  kind: 'replay',
  checkpoint: { name: 'uat-before-refresh' },
  objects: ['Account', 'Contact', 'Case'],
  excludeObjects: ['Task', 'Event'],
  owners: 'me',
  customSettings: true,
  mask: true,
  keepContactPoints: true,
  maxRecords: 500,
};

/** The checkpoint the plan resolved a name to. */
const RESOLVED: EnvReplayCheckpointRead = {
  checkpointId: 'ck-20261114-174750-5e38',
  organizationId: '00D000000000001AAA',
  name: 'uat-before-refresh',
};

/** A users or a replay resource, ready to plan, as `resolveEnvFile` makes one. */
function readyOf(
  resource: EnvUsersResource | EnvReplayResource,
  place: EnvReplayPlace = {},
): EnvFileResource {
  const converted = convertResource('demo', 'r', resource, project, NOW);
  if ('refusals' in converted) throw new Error(converted.refusals.map((r) => r.message).join('; '));
  const { run } = converted;
  if (run.kind === 'users') {
    const { kind, ...rest } = run;
    return { name: 'r', kind, dependsOn: [], fingerprint: '', run: rest };
  }
  if (run.kind !== 'replay') throw new Error(`not a users or replay run: ${run.kind}`);
  const { kind, ...rest } = run;
  return { name: 'r', kind, dependsOn: [], fingerprint: '', run: rest, checkpoint: place };
}

/** A run's answer, kept as its summary beside the state. */
function summaryFile(name: string, answer: unknown): string {
  const file = join(project, name);
  writeFileSync(file, JSON.stringify(answer));
  return file;
}

describe('a users resource', () => {
  const context = { target: 'TGT', templateFile: '/tmp/r.json', runId: '' };

  it('is applied by sandforge users, the file’s users and defaults its config', () => {
    expect(isAppliedKind('users')).toBe(true);
    expect(scriptOfKind('users')).toBe('sandforge-users');
    const converted = convertResource('demo', 'testers', users, project, NOW);
    if ('refusals' in converted) throw new Error('refused');
    expect(converted.run.kind).toBe('users');
    expect(objectsOfRun(converted.run)).toEqual([{ object: 'User', count: 3 }]);
    expect(payloadOf(readyOf(users), {})).toEqual({
      defaults: { email: 'restore', frozen: false },
      users: users.users,
    });
    expect(notesOf(readyOf(users), { alias: 'TGT' })).toEqual([]);
  });

  it('gives its plan and its run their exact lines: the config, the run it converges from, the emails the line accepts', () => {
    expect(dryRunLineOf(readyOf(users), context)).toEqual({
      script: 'sandforge-users',
      args: ['plan', '--org', 'TGT', '--config', '/tmp/r.json', '--json'],
    });
    expect(
      dryRunLineOf(readyOf(users), {
        ...context,
        replace: true,
        replacesRun: 4,
        acceptUserEmails: true,
      }).args,
    ).toEqual([
      'plan',
      '--org',
      'TGT',
      '--config',
      '/tmp/r.json',
      '--replaces',
      '4',
      '--accept-user-emails',
      '--json',
    ]);
    expect(
      applyLineOf(readyOf(users), {
        ...context,
        summaryFile: '',
        replace: true,
        replacesRun: 4,
        acceptUserEmails: true,
      }),
    ).toEqual({
      script: 'sandforge-users',
      args: [
        'apply',
        '--org',
        'TGT',
        '--config',
        '/tmp/r.json',
        '--replaces',
        '4',
        '--accept-user-emails',
        '--yes',
        '--json',
      ],
    });
    // A run that replaces none converges from none; the line accepts no email unasked.
    expect(applyLineOf(readyOf(users), { ...context, summaryFile: '' }).args).toEqual([
      'apply',
      '--org',
      'TGT',
      '--config',
      '/tmp/r.json',
      '--yes',
      '--json',
    ]);
    expect(() =>
      applyLineOf(readyOf(users), { ...context, summaryFile: '', replacesRun: 0 }),
    ).toThrow('--replaces takes the number of a run of sandforge users, not 0.');
    // What fires as its users are written, accepted by the file or by the line.
    const accepting = readyOf({ ...users, accept: { automation: true } });
    expect(dryRunLineOf(accepting, context).args).toEqual([
      'plan',
      '--org',
      'TGT',
      '--config',
      '/tmp/r.json',
      '--accept-automation',
      '--json',
    ]);
    expect(
      applyLineOf(readyOf(users), { ...context, summaryFile: '', acceptAutomation: true }).args,
    ).toContain('--accept-automation');
  });

  it('replaces in one run that converges, previews no removal, and takes a run back by the number its summary names', () => {
    expect(replacesInOneRun('users')).toBe(true);
    const runs: Array<{ n: number; takenBack?: true }> = [{ n: 1 }, { n: 2 }];
    expect(previewedRunsOf('users', runs)).toEqual([]);
    expect(refreshLineOf('users', { target: 'TGT', subject: '/s' })).toBeUndefined();
    const subject = summaryFile('testers.3.summary.json', { run: 3, status: 'success' });
    const removal = { target: 'TGT', subject, includeChanged: false, acceptAutomation: false };

    expect(removeLineOf('users', { ...removal, sweep: false })).toEqual({
      script: 'sandforge-users',
      args: ['remove', '--org', 'TGT', '--run', '3', '--yes', '--json'],
    });
    expect(
      removeLineOf('users', {
        ...removal,
        includeChanged: true,
        acceptAutomation: true,
        sweep: true,
      }).args,
    ).toEqual([
      'remove',
      '--org',
      'TGT',
      '--run',
      '3',
      '--include-changed',
      '--accept-automation',
      '--yes',
      '--json',
    ]);
    expect(() => previewLineOf('users', removal)).toThrow(
      'sandforge users previews no removal: its plan reads what the org holds of its users',
    );
    const unnamed = summaryFile('testers.4.summary.json', { status: 'failure' });
    expect(() => removeLineOf('users', { ...removal, subject: unnamed, sweep: false })).toThrow(
      'names no run of sandforge users',
    );
  });

  it('fingerprints the users it sets up, whatever the file’s order, case or defaults', () => {
    const spelled: EnvUsersResource = {
      kind: 'users',
      users: [
        { username: 'ERP.Integration@acme.com', email: 'keep', frozen: true },
        {
          username: 'jane.qa@acme.com',
          email: 'restore',
          frozen: false,
          groups: ['qa_team'],
          permissionSets: ['QA_Tools'],
        },
        {
          username: 'paul.qa@acme.com',
          email: 'restore',
          frozen: false,
          active: true,
          profile: 'QA Tester',
        },
      ],
    };

    expect(writtenOf(readyOf(spelled))).toEqual(writtenOf(readyOf(users)));
    expect(writtenOf(readyOf(users))).toMatchObject({ kind: 'users', kindVersion: 1 });
    // A permission set taken off the file is another set up: a replace takes it back.
    const fewer: EnvUsersResource = {
      ...users,
      users: users.users.map((user) =>
        user.username === 'jane.qa@acme.com' ? { ...user, permissionSets: [] } : user,
      ),
    };
    expect(writtenOf(readyOf(fewer))).not.toEqual(writtenOf(readyOf(users)));
  });

  it('reads its plan as every kind’s dry run: the users to set up, the requests, the emails to people', () => {
    const answer = readDryRunOf(
      'users',
      JSON.stringify({
        org: {
          organizationId: '00D000000000002AAA',
          kind: 'sandbox',
          alias: 'TGT',
          username: 'admin@acme.com.uat',
        },
        users: [
          {
            username: 'jane.qa@acme.com.uat',
            given: 'jane.qa@acme.com',
            userId: '005000000000001AAA',
            address: 'invalid',
            changes: [{ what: 'email', to: 'awaiting' }],
            emailsToPeople: 1,
          },
          { username: 'paul.qa@acme.com.uat', userId: '005000000000002AAA', changes: [] },
        ],
        emailsToPeople: 1,
        apiRequests: 6,
      }),
    );

    expect(dryRunCountOf(answer)).toEqual({
      objects: [{ object: 'User', wouldCreate: 1 }],
      total: 1,
      created: 0,
      apiRequests: 6,
      storageBytes: 0,
      emails: [],
      emailsToPeople: 1,
    });
  });
});

describe('a replay resource', () => {
  const context = {
    target: 'TGT',
    templateFile: '/tmp/r.json',
    runId: '',
    checkpointStore: '/journal/checkpoints',
  };
  const KEY = 'ABCD'.repeat(13);

  it('is applied by sandforge checkpoint replay, and lists the objects it names', () => {
    expect(isAppliedKind('replay')).toBe(true);
    expect(scriptOfKind('replay')).toBe('sandforge-checkpoint');
    const converted = convertResource('demo', 'test-data', replay, project, NOW);
    if ('refusals' in converted) throw new Error('refused');
    expect(objectsOfRun(converted.run)).toEqual([
      { object: 'Account' },
      { object: 'Contact' },
      { object: 'Case' },
    ]);
    expect(payloadOf(readyOf(replay, { read: RESOLVED }), {})).toEqual({});
  });

  it('gives its dry run each choice of the file as its own flag, the checkpoint by the id the plan resolved', () => {
    expect(dryRunLineOf(readyOf(replay, { read: RESOLVED }), context)).toEqual({
      script: 'sandforge-checkpoint',
      args: [
        'replay',
        '--checkpoint',
        'ck-20261114-174750-5e38',
        '--from',
        '00D000000000001AAA',
        '--target',
        'TGT',
        '--store',
        '/journal/checkpoints',
        '--objects',
        'Account,Contact,Case',
        '--exclude-object',
        'Task',
        '--exclude-object',
        'Event',
        '--owners',
        'me',
        '--custom-settings',
        '--mask',
        '--keep-contact-points',
        '--max-records',
        '500',
        '--dry-run',
        '--json',
      ],
    });
    // Named by a name the plan has not resolved, no line: what it would replay is not known.
    expect(() => dryRunLineOf(readyOf(replay), context)).toThrow(
      'r names its checkpoint by a name this plan has not resolved: plan again.',
    );
    // Named by its id, the id is its line's even unread.
    expect(
      dryRunLineOf(
        readyOf({ kind: 'replay', checkpoint: { id: 'ck-20261114-174750-5e38' } }),
        context,
      ).args,
    ).toEqual([
      'replay',
      '--checkpoint',
      'ck-20261114-174750-5e38',
      '--target',
      'TGT',
      '--store',
      '/journal/checkpoints',
      '--dry-run',
      '--json',
    ]);
    expect(() =>
      dryRunLineOf(readyOf(replay, { read: RESOLVED }), { ...context, checkpointStore: undefined }),
    ).toThrow('r is given no store of checkpoints to replay from: plan again.');
  });

  it('names a checkpoint file by its path and the variable that holds its key, never the key', () => {
    const before = process.env['UAT_CHECKPOINT_KEY'];
    process.env['UAT_CHECKPOINT_KEY'] = KEY;
    try {
      const fromFile = readyOf(
        {
          kind: 'replay',
          checkpoint: { file: { env: 'UAT_CHECKPOINT_FILE' }, keyEnv: 'UAT_CHECKPOINT_KEY' },
        },
        { file: '/runner/work/uat.sfcheckpoint', read: RESOLVED },
      );
      const line = applyLineOf(fromFile, { ...context, summaryFile: '', maxTotal: 292 }).args;

      expect(line).toEqual([
        'replay',
        '--file',
        '/runner/work/uat.sfcheckpoint',
        '--key-env',
        'UAT_CHECKPOINT_KEY',
        '--target',
        'TGT',
        '--store',
        '/journal/checkpoints',
        '--max-records',
        '292',
        '--yes',
        '--json',
      ]);
      expect(line.join(' ')).not.toContain(KEY);
    } finally {
      if (before === undefined) delete process.env['UAT_CHECKPOINT_KEY'];
      else process.env['UAT_CHECKPOINT_KEY'] = before;
    }
  });

  it('holds its run to its dry run’s count, replays again for a replace, and gives the file’s acceptance', () => {
    const accepting = readyOf({ ...replay, accept: { automation: true } }, { read: RESOLVED });
    const line = applyLineOf(accepting, {
      ...context,
      summaryFile: '',
      maxTotal: 292,
      replace: true,
    }).args;

    expect(line.slice(line.indexOf('--keep-contact-points'))).toEqual([
      '--keep-contact-points',
      '--again',
      '--accept-automation',
      '--max-records',
      '292',
      '--yes',
      '--json',
    ]);
    expect(replacesInOneRun('replay')).toBe(true);
    expect(() => applyLineOf(accepting, { ...context, summaryFile: '' })).toThrow(
      'r has no count from its dry run to be held to: plan again.',
    );
  });

  it('is taken back by the replay’s own removal, named by the checkpoint its summary says, and previews its last run alone', () => {
    const subject = summaryFile('test-data.1.summary.json', {
      command: 'replay',
      action: 'replay',
      checkpoint: { id: 'ck-20261114-174750-5e38', organizationId: '00D000000000001AAA' },
      target: { alias: 'TGT' },
      exit: 0,
    });
    const removal = {
      target: 'TGT',
      subject,
      includeChanged: false,
      acceptAutomation: false,
      checkpointStore: '/journal/checkpoints',
    };
    const base = [
      'replay',
      '--checkpoint',
      'ck-20261114-174750-5e38',
      '--from',
      '00D000000000001AAA',
      '--target',
      'TGT',
      '--store',
      '/journal/checkpoints',
      '--remove',
    ];

    expect(removeLineOf('replay', { ...removal, sweep: false })).toEqual({
      script: 'sandforge-checkpoint',
      args: [...base, '--yes', '--json'],
    });
    expect(
      removeLineOf('replay', {
        ...removal,
        includeChanged: true,
        acceptAutomation: true,
        sweep: true,
      }).args,
    ).toEqual([...base, '--include-changed', '--sweep', '--accept-automation', '--yes', '--json']);
    expect(previewLineOf('replay', removal).args).toEqual([...base, '--preview', '--json']);
    expect(() =>
      removeLineOf('replay', { ...removal, checkpointStore: undefined, sweep: false }),
    ).toThrow('a replay is given no store of checkpoints to take it back from: plan again.');
    const runs: Array<{ n: number; takenBack?: true }> = [
      { n: 1 },
      { n: 2 },
      { n: 3, takenBack: true },
    ];
    expect(previewedRunsOf('replay', runs)).toEqual([{ n: 2 }]);
    expect(refreshLineOf('replay', { target: 'TGT', subject })).toBeUndefined();
  });

  it('reads its dry run, its removal’s preview and its removal as every kind’s are', () => {
    const base = {
      command: 'replay',
      checkpoint: { id: 'ck-20261114-174750-5e38', organizationId: '00D000000000001AAA' },
      target: { alias: 'TGT' },
      exit: 0,
    };
    const dry = readDryRunOf(
      'replay',
      JSON.stringify({
        ...base,
        action: 'dryRun',
        objects: [
          {
            objectApiName: 'Account',
            fromFiles: 40,
            toInsert: 40,
            toLink: 0,
            notSent: 0,
            toPurge: 0,
          },
          {
            objectApiName: 'Contact',
            fromFiles: 212,
            toInsert: 212,
            toLink: 0,
            notSent: 0,
            toPurge: 0,
          },
        ],
      }),
    );
    expect(dryRunCountOf(dry)).toMatchObject({
      objects: [
        { object: 'Account', wouldCreate: 40 },
        { object: 'Contact', wouldCreate: 212 },
      ],
      total: 252,
      created: 252,
    });
    const preview = readPreviewOf(
      'replay',
      JSON.stringify({
        ...base,
        action: 'remove',
        preview: true,
        objects: [
          {
            objectApiName: 'Contact',
            planned: 212,
            toDelete: 210,
            alreadyGone: 1,
            changedSince: 1,
            keptChanged: 1,
            undeletable: 0,
            notVisible: 0,
            unread: 0,
          },
        ],
      }),
    );
    expect(preview).toMatchObject({
      preview: { planned: 212, objects: [{ objectApiName: 'Contact', toDelete: 210 }] },
      refusals: [],
    });
    const removed = readRemovalOf(
      'replay',
      JSON.stringify({
        ...base,
        action: 'remove',
        removal: {
          status: 'success',
          objects: [
            {
              objectApiName: 'Contact',
              planned: 212,
              deleted: 212,
              alreadyGone: 0,
              keptChanged: 0,
              keptDependents: 0,
              refused: 0,
              heldBy: [],
              reasons: [],
            },
          ],
        },
      }),
    );
    expect(removalObjectsOf(removed)).toEqual([expect.objectContaining({ deleted: 212 })]);
  });

  it('fingerprints the checkpoint the plan resolved and the choices, not the name, the file or the key’s variable that found it', () => {
    const newer: EnvReplayCheckpointRead = { ...RESOLVED, checkpointId: 'ck-20261119-080000-a1b2' };

    expect(writtenOf(readyOf(replay, { read: RESOLVED }))).toEqual(
      writtenOf(
        readyOf(
          {
            ...replay,
            checkpoint: { file: '/runner/uat.sfcheckpoint', keyEnv: 'OTHER_KEY' },
            objects: ['case', 'Account', 'contact'],
            maxRecords: 10,
          },
          { file: '/runner/uat.sfcheckpoint', read: RESOLVED },
        ),
      ),
    );
    // A newer checkpoint of the same name is another replay, which replaces the one before.
    expect(writtenOf(readyOf(replay, { read: newer }))).not.toEqual(
      writtenOf(readyOf(replay, { read: RESOLVED })),
    );
    expect(writtenOf(readyOf({ ...replay, mask: false }, { read: RESOLVED }))).not.toEqual(
      writtenOf(readyOf(replay, { read: RESOLVED })),
    );
    // The owners the replay defaults to, written or not, are the same.
    const plain: EnvReplayResource = { kind: 'replay', checkpoint: { name: 'uat-before-refresh' } };
    expect(writtenOf(readyOf({ ...plain, owners: 'same' }, { read: RESOLVED }))).toEqual(
      writtenOf(readyOf(plain, { read: RESOLVED })),
    );
  });
});
