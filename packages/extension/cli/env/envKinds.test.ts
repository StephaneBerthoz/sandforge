import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import type { EnvForgeResource, EnvSeedResource } from '@sandforge/shared';
import {
  applyLineOf,
  convertResource,
  dryRunCountOf,
  dryRunLineOf,
  isAppliedKind,
  objectsOfRun,
  previewLineOf,
  removeLineOf,
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

/** A resource of the file, ready to plan, as `resolveEnvFile` makes one. */
function ready(
  resource: EnvSeedResource | EnvForgeResource,
  read?: { organizationId: string; recordId?: string },
): EnvFileResource {
  const converted = convertResource('demo', 'r', resource, tmpdir(), NOW);
  if ('refusals' in converted) throw new Error(converted.refusals.map((r) => r.message).join('; '));
  const { run } = converted;
  if (run.kind === 'seed') {
    const { kind, ...rest } = run;
    return { name: 'r', kind, dependsOn: [], fingerprint: '', run: rest };
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
  it('applies seed and forge resources, each by its script, and refuses a kind a later SandForge applies', () => {
    expect(isAppliedKind('seed')).toBe(true);
    expect(isAppliedKind('frozen')).toBe(false);
    expect(scriptOfKind('seed')).toBe('sandforge-seed');
    expect(scriptOfKind('forge')).toBe('sandforge-clone');
    expect(() => scriptOfKind('mask')).toThrow(
      'The state holds a resource of kind mask, which a later SandForge applies',
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
