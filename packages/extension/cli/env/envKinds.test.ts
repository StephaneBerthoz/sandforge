import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  EnvForgeResource,
  EnvFrozenResource,
  EnvMaskResource,
  EnvSeedResource,
  SeedTemplate,
} from '@sandforge/shared';
import {
  applyLineOf,
  convertResource,
  dryRunCountOf,
  dryRunLineOf,
  isAppliedKind,
  objectsOfRun,
  payloadOf,
  previewedRunsOf,
  previewLineOf,
  refreshLineOf,
  removeLineOf,
  replacesInOneRun,
  scriptOfKind,
  writtenOf,
} from './envKinds.js';
import type { EnvFileResource } from './envFile.js';
import type { ForgeDryRunAnswer } from './kinds/forge.js';

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
      'sandforge-dataops takes no run back: a masking is never undone',
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
      '--yes',
      '--json',
    ]);
    expect(previewLineOf('frozen', removal).args).toEqual(
      expect.arrayContaining(['remove', '--preview', '--json']),
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
