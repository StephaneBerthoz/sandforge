import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnvFrozenResource, EnvFrozenRun } from '@sandforge/shared';

vi.mock('../../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../sfSession.js', async (original) => ({
  ...(await original<typeof import('../../sfSession.js')>()),
  loadOrg: vi.fn(),
  makeConn: vi.fn(),
}));
vi.mock('../../sandforge-clone.js', async (original) => ({
  ...(await original<typeof import('../../sandforge-clone.js')>()),
  targetAutomationReader: vi.fn(),
}));
vi.mock('../../../src/modules/forge/ForgeRunRemoval.js', async (original) => ({
  ...(await original<typeof import('../../../src/modules/forge/ForgeRunRemoval.js')>()),
  removalOrg: vi.fn(),
}));
vi.mock('../../../src/core/connection/ConnectionHelper.js', async (original) => ({
  ...(await original<typeof import('../../../src/core/connection/ConnectionHelper.js')>()),
  getJsforceConnection: vi.fn(),
}));

import { frozenDatasetDigest } from '../../../src/modules/frozendataset/datasetDigest.js';
import { parseArgs as parseFrozenArgs } from '../../sandforge-frozen.js';
import { EnvWorld } from '../../testing/envWorld.js';
import { freezeDataset } from '../../testing/frozenDataset.js';
import { StepAnswerError } from './common.js';
import {
  FROZEN_SCRIPT,
  derivedConfigOf,
  frozenApplyLine,
  frozenDryRunCount,
  frozenDryRunLine,
  frozenPreviewLine,
  frozenRefreshOf,
  frozenRemoveLine,
  frozenRunCount,
  frozenRunOfResource,
  frozenVerdictShortOf,
  frozenVerifyLine,
  frozenWritten,
  readFrozenDataset,
  readFrozenDryRun,
  readFrozenPreview,
  readFrozenRemoval,
  readFrozenRun,
  readFrozenVerify,
  reloadPurgedWhole,
  resourceOfSas,
  type FrozenDryRunAnswer,
} from './frozen.js';

/*
 * A frozen resource's conversion, its dataset read at the plan, its lines —
 * each one `sandforge-frozen`'s own parser reads — and the readers of what
 * the script answers, held to what it prints when its own `main` runs in
 * this process against the memory org, through the Load tab's handler.
 */

let dir: string;
let project: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandforge-env-frozen-kind-'));
  project = join(dir, 'project');
  mkdirSync(project);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const DIGEST = `sha256:${'a'.repeat(64)}`;
const resource = (over: Partial<EnvFrozenResource> = {}): EnvFrozenResource => ({
  kind: 'frozen',
  config: 'claims.frozen.json',
  dataset: { path: '/data/claims', version: '1.0.0', digest: DIGEST },
  ...over,
});

function configure(config: unknown): void {
  writeFileSync(join(project, 'claims.frozen.json'), JSON.stringify(config));
}

describe('a frozen resource, converted', () => {
  it('reads the committed configuration, held to Frozen’s own schema, without the folders the environment sets', () => {
    configure({
      rootObject: 'Account',
      axes: [],
      edgeCases: [],
      identityKeys: { Account: ['Name'] },
      datasetDir: '/elsewhere',
    });

    const converted = frozenRunOfResource(
      'claims',
      resource({ accept: { automation: true } }),
      project,
    );

    if ('refusals' in converted) throw new Error(converted.refusals[0]?.message);
    expect(converted.run).toEqual({
      configFile: 'claims.frozen.json',
      config: {
        rootObject: 'Account',
        axes: [],
        edgeCases: [],
        identityKeys: { Account: ['Name'] },
      },
      dataset: { path: '/data/claims', version: '1.0.0', digest: DIGEST },
    });
    expect(converted.warnings.map((warning) => warning.message)).toEqual([
      'claims.frozen.json gives datasetDir, which the environment sets: the loads are kept beside the state, and the dataset is the one the file pins',
    ]);
  });

  it('refuses a configuration that cannot be read, is not JSON, holds a key Frozen does not name, or one shaped like a secret', () => {
    const refusal = () => {
      const converted = frozenRunOfResource('claims', resource(), project);
      return 'refusals' in converted ? converted.refusals.map((r) => r.message) : [];
    };

    expect(refusal()).toEqual([expect.stringMatching(/^claims\.frozen\.json cannot be read: /)]);
    writeFileSync(join(project, 'claims.frozen.json'), '{ rootObject: Account');
    expect(refusal()).toEqual([
      "claims.frozen.json is not JSON: a Frozen configuration is the panel's, as JSON",
    ]);
    configure({ rootObject: 'Account', axes: [], edgeCases: [], budget: 3 });
    expect(refusal()).toEqual([
      expect.stringContaining(
        "claims.frozen.json is refused by Frozen's configuration schema at its top",
      ),
    ]);
    configure({ rootObject: 'Account', axes: [], edgeCases: [], rules: { salt: 'x' } });
    expect(refusal()).toEqual([
      'claims.frozen.json holds a key shaped like a secret (salt) at rules.salt: a load never reads the salt, and the configuration holds no secret. Take it out.',
    ]);
  });

  it('is fingerprinted by its dataset’s digest and version and what a load writes by, never its path, nor what the extraction alone reads', () => {
    const run: EnvFrozenRun = {
      configFile: 'claims.frozen.json',
      config: {
        rootObject: 'Account',
        axes: [],
        edgeCases: [],
        identityKeys: { Account: ['Name'] },
      },
      dataset: { path: '/data/claims', version: '1.0.0', digest: DIGEST },
    };
    const written = frozenWritten(run);

    expect(
      frozenWritten({ ...run, dataset: { ...run.dataset, path: { env: 'ELSEWHERE' } } }),
    ).toEqual(written);
    expect(frozenWritten({ ...run, config: { ...run.config, budgetMaxRecords: 10 } })).toEqual(
      written,
    );
    expect(frozenWritten({ ...run, config: { ...run.config, identityKeys: {} } })).not.toEqual(
      written,
    );
    expect(
      frozenWritten({ ...run, dataset: { ...run.dataset, digest: `sha256:${'b'.repeat(64)}` } }),
    ).not.toEqual(written);
    expect(derivedConfigOf(run, { sasDir: '/sas', datasetDir: '/data' })).toEqual({
      ...run.config,
      sasDir: '/sas',
      datasetDir: '/data',
    });
  });
});

describe('a frozen resource’s dataset, read at the plan', () => {
  it('reads its digest and version, and refuses one that is not what the file pins, naming both', async () => {
    const dataset = await freezeDataset(join(dir, 'dataset'), {
      accounts: 1,
      perAccount: 0,
      mark: 'k',
    });
    const digest = await frozenDatasetDigest(dataset);

    expect(await readFrozenDataset(dataset, { path: dataset, version: '1.0.0', digest })).toEqual({
      digest,
      version: '1.0.0',
    });
    expect(
      await readFrozenDataset(dataset, { path: dataset, version: '1.0.0', digest: DIGEST }),
    ).toEqual({
      refusal: `its dataset at ${dataset} has the digest ${digest}, and the file pins ${DIGEST}: it is not the dataset the file was reviewed with. Point the path at that one, or pin this digest once this dataset is reviewed`,
    });
    expect(await readFrozenDataset(dataset, { path: dataset, version: '2.0.0', digest })).toEqual({
      refusal: `its dataset at ${dataset} is version 1.0.0, and the file pins version 2.0.0: pin the version its manifest says`,
    });
    expect(
      await readFrozenDataset(join(dir, 'none'), { path: '/x', version: '1.0.0', digest }),
    ).toEqual({
      refusal: expect.stringMatching(/^its dataset at .*none cannot be read: No frozen dataset at/),
    });
  });
});

describe('a frozen resource’s lines', () => {
  const line = { configFile: '/state/templates/claims.1.json', target: 'TGT' };
  /** The line as `sandforge-frozen` reads it, or the exit its parser stops with. */
  function parsed(args: string[]) {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    return parseFrozenArgs(['node', 'sandforge-frozen.ts', ...args]);
  }

  it('dry-runs a load, a reload for a replace, its own store apart from the sas, as the script reads it', () => {
    expect(parsed(frozenDryRunLine({ ...line, reload: false }))).toMatchObject({
      step: 'load',
      configPath: line.configFile,
      target: 'TGT',
      dryRun: true,
      reload: false,
      json: true,
    });
    expect(
      parsed(frozenDryRunLine({ ...line, reload: true, store: '/tmp/store.json' })),
    ).toMatchObject({
      reload: true,
      storePath: '/tmp/store.json',
      dryRun: true,
    });
  });

  it('tells the dry run of a replace what the apply takes back before it, and a first load’s nothing', () => {
    // The script reads it as the dry run of a reload: refused anywhere else.
    expect(
      parsed(frozenDryRunLine({ ...line, reload: true, goneFirst: '/tmp/gone-first.json' })),
    ).toMatchObject({ reload: true, dryRun: true, goneFirst: '/tmp/gone-first.json' });
    expect(
      frozenDryRunLine({ ...line, reload: false, goneFirst: '/tmp/gone-first.json' }),
    ).not.toContain('--gone-first');
  });

  it('hands a first load and its dry run the acceptance of automation it was given, as a reload', () => {
    // A load asks what fires as it inserts and updates, as a reload asks
    // what fires as its purge deletes: given to a reload alone, the
    // acceptance left a first load refused for the flow on its contacts.
    expect(
      parsed(frozenDryRunLine({ ...line, reload: false, acceptAutomation: true })),
    ).toMatchObject({ step: 'load', reload: false, dryRun: true, acceptAutomation: true });
    expect(
      parsed(frozenApplyLine({ ...line, reload: false, maxTotal: 4, acceptAutomation: true })),
    ).toMatchObject({ step: 'load', reload: false, acceptAutomation: true, yes: true });
    expect(parsed(frozenApplyLine({ ...line, reload: false, maxTotal: 4 }))).toMatchObject({
      acceptAutomation: false,
    });
  });

  it('runs a load held to its dry run’s count, asked nothing, a reload for a replace', () => {
    expect(parsed(frozenApplyLine({ ...line, reload: true, maxTotal: 4 }))).toMatchObject({
      step: 'load',
      reload: true,
      maxTotal: 4,
      yes: true,
      dryRun: false,
      json: true,
    });
  });

  it('verifies, previews a removal and removes, as the script reads each', () => {
    expect(parsed(frozenVerifyLine(line))).toMatchObject({ step: 'verify', json: true });
    expect(parsed(frozenPreviewLine({ ...line, includeChanged: true }))).toMatchObject({
      step: 'remove',
      preview: true,
      includeChanged: true,
      yes: false,
    });
    expect(parsed(frozenRemoveLine({ ...line, sweep: true }))).toMatchObject({
      step: 'remove',
      preview: false,
      sweep: true,
      acceptAutomation: false,
      yes: true,
    });
    // A destroy's sweep, to its preview too, which reads what it would take.
    expect(parsed(frozenPreviewLine({ ...line, sweep: true }))).toMatchObject({
      step: 'remove',
      preview: true,
      sweep: true,
    });
  });

  it('hands a removal and its preview the acceptance of automation it was given, as the script reads it', () => {
    expect(parsed(frozenRemoveLine({ ...line, acceptAutomation: true }))).toMatchObject({
      step: 'remove',
      acceptAutomation: true,
    });
    expect(parsed(frozenPreviewLine({ ...line, acceptAutomation: true }))).toMatchObject({
      step: 'remove',
      preview: true,
      acceptAutomation: true,
    });
  });

  it('refuses a value a script would read as a flag', () => {
    expect(() => frozenVerifyLine({ ...line, target: '--yes' })).toThrow(
      '--target cannot be "--yes": a value that starts with "-" reads as a flag.',
    );
  });
});

describe('what sandforge-frozen answers, read', () => {
  let world: EnvWorld;
  let config: string;
  let datasetDir: string;
  const signal = new AbortController().signal;
  const frozen = (args: string[]) =>
    world.runner(FROZEN_SCRIPT, [...args, '--config', config, '--target', 'TGT', '--json'], signal);

  beforeEach(async () => {
    world = new EnvWorld();
    datasetDir = await freezeDataset(join(dir, 'dataset'), {
      accounts: 2,
      perAccount: 1,
      mark: 'k',
    });
    config = join(dir, 'frozen.json');
    writeFileSync(
      config,
      JSON.stringify({
        rootObject: 'Account',
        axes: [],
        edgeCases: [],
        sasDir: join(dir, 'sas'),
        datasetDir,
      }),
    );
  });

  it('reads a dry run’s counts per object, exactly, its storage the documented size of a record', async () => {
    const ran = await frozen(['load', '--dry-run']);

    expect(ran.code).toBe(0);
    expect(frozenDryRunCount(readFrozenDryRun(ran.stdout))).toEqual({
      objects: [
        { object: 'Account', wouldCreate: 2 },
        { object: 'Contact', wouldCreate: 2 },
      ],
      total: 4,
      created: 4,
      storageBytes: 4 * 2048,
      emails: [],
    });
  });

  it('reads the emails a dry run’s gate counted, for the day’s gate to add', async () => {
    // Counted nowhere, a load of 73 contacts into a Developer Edition of 15
    // single emails a day passed the day's gate.
    const ran = await frozen(['load', '--dry-run']);
    const answer = readFrozenDryRun(ran.stdout);
    const preview = answer.posted.find((m) => m.type === 'frozen:load:preview:response');
    const plan = (preview?.payload as { plan: Record<string, unknown> }).plan;
    plan['emails'] = {
      counted: [
        {
          limit: 'SingleEmail',
          emails: 146,
          verdict: 'exceeds',
          remaining: 15,
          max: 15,
          objects: [],
        },
        { limit: 'DailyWorkflowEmails', emails: 73, verdict: 'fits', objects: [] },
      ],
      verdict: 'withheld',
      accepted: false,
    };

    expect(frozenDryRunCount(answer).emails).toEqual([
      { limit: 'SingleEmail', emails: 146 },
      { limit: 'DailyWorkflowEmails', emails: 73 },
    ]);
  });

  it('reads a load, the verification it chains, its verification, its preview and its removal', async () => {
    const loaded = await frozen(['load', '--yes']);
    const run = readFrozenRun(loaded.stdout);
    expect(frozenRunCount(run)).toEqual({
      objects: [
        { object: 'Account', created: 2, refused: 0, errors: [] },
        { object: 'Contact', created: 2, refused: 0, errors: [] },
      ],
      created: 4,
    });
    expect(run.verdict?.status).toBe('PASSED');
    expect(frozenVerdictShortOf(run.verdict ?? { status: 'FAILED', objects: [] })).toEqual({
      unstable: false,
    });

    expect(frozenRefreshOf(readFrozenVerify((await frozen(['verify'])).stdout))).toEqual({
      failed: [],
    });
    const preview = readFrozenPreview((await frozen(['remove', '--preview'])).stdout);
    expect(preview.refusals).toEqual([]);
    expect(preview.preview.objects.map((o) => [o.objectApiName, o.toDelete])).toEqual([
      ['Contact', 2],
      ['Account', 2],
    ]);
    const removed = readFrozenRemoval((await frozen(['remove', '--yes'])).stdout);
    expect(removed.result.status).toBe('success');
    expect(removed.result.objects.map((o) => [o.objectApiName, o.deleted])).toEqual([
      ['Contact', 2],
      ['Account', 2],
    ]);
    expect(world.records('Account')).toEqual([]);
    // Nothing left: a removal, and its preview, take nothing, whole.
    expect(readFrozenRemoval((await frozen(['remove', '--yes'])).stdout).result).toEqual({
      status: 'success',
      planned: 0,
      objects: [],
    });
    expect(readFrozenPreview((await frozen(['remove', '--preview'])).stdout)).toMatchObject({
      preview: { planned: 0, objects: [] },
      refusals: [],
    });
  });

  it('reads a verification that FAILED an object, naming it, after a record of the load was deleted', async () => {
    await frozen(['load', '--yes']);
    const [contact] = world.records('Contact');
    world.org.trash('Contact', String(contact?.['Id']));

    expect(frozenRefreshOf(readFrozenVerify((await frozen(['verify'])).stdout))).toEqual({
      failed: ['Contact FAILED (1 of 2 found)'],
    });
  });

  it('reads a reload whose purge took the loads before it whole', async () => {
    await frozen(['load', '--yes']);
    const reloaded = await frozen(['load', '--reload', '--yes']);

    expect(reloadPurgedWhole(readFrozenRun(reloaded.stdout))).toBe(true);
    expect(world.records('Account')).toHaveLength(2);
  });

  it('reads the refusal of a load in the handler’s own words: no count to insert without a dataset', async () => {
    writeFileSync(
      config,
      JSON.stringify({
        rootObject: 'Account',
        axes: [],
        edgeCases: [],
        sasDir: join(dir, 'sas'),
        datasetDir: join(dir, 'none'),
      }),
    );
    const ran = await frozen(['load', '--dry-run']);

    const count = frozenDryRunCount(readFrozenDryRun(ran.stdout));
    expect(count.refusal).toContain(`No frozen dataset found at ${join(dir, 'none')}`);
    expect(count.objects).toEqual([]);
  });

  it('refuses an answer that does not read as one, naming the script', () => {
    expect(() => readFrozenDryRun('nothing')).toThrow(StepAnswerError);
    expect(() => readFrozenRemoval(JSON.stringify({ tool: 'sandforge-seed' }))).toThrow(
      'sandforge frozen did not answer the outcome of a removal',
    );
  });
});

describe('what a frozen dry run counts, as the plan reads it', () => {
  const answer = (
    over: Partial<FrozenDryRunAnswer>,
    plan: Record<string, unknown> = {},
  ): FrozenDryRunAnswer => ({
    tool: 'sandforge-frozen',
    step: 'load',
    posted: [{ type: 'frozen:load:preview:response', payload: { plan } }],
    objects: [
      {
        objectApiName: 'Contact',
        fromFiles: 2,
        toInsert: 2,
        toLink: 0,
        notSent: 0,
        toPurge: 0,
        toDeactivate: 0,
      },
    ],
    ...over,
  });

  it('says what a load would leave out, encrypted in the target, and the picklist values a rule rewrites, without refusing it', () => {
    const count = frozenDryRunCount(
      answer(
        {},
        {
          removals: [
            {
              objectApiName: 'Contact',
              field: 'Ssn__c',
              reason: 'may-hold-masks',
              affectedRecords: 2,
            },
          ],
          perObject: [{ objectApiName: 'Contact', picklistsRewritten: 1, fieldsDropped: 0 }],
        },
      ),
    );

    expect(count.refusal).toBeUndefined();
    expect(count.notes).toEqual([
      "it would leave out, encrypted in the target, Contact.Ssn__c (2): the dataset's manifest does not say its extraction left out what it read masked, so they may hold masks such as ****1234",
      'Contact: 1 picklist value(s) a restricted picklist of the target refuses, rewritten by their rule',
    ]);
  });

  it('refuses one the handler refused, in its words; one past its count gate; and one that would insert nothing', () => {
    const refused = answer({
      objects: undefined,
      posted: [
        {
          type: 'frozen:load:preview:error',
          payload: {
            message:
              'A removal of the loads this reload replaces would leave 1 of their records in the org',
            code: 'REPLACE_LEAVES_RECORDS',
          },
        },
      ],
    });
    expect(frozenDryRunCount(refused).refusal).toBe(
      'A removal of the loads this reload replaces would leave 1 of their records in the org',
    );
    expect(frozenDryRunCount(refused).refusalCodes).toEqual(['REPLACE_LEAVES_RECORDS']);
    expect(
      frozenDryRunCount(
        answer({
          refusals: ['TGT runs automation as this load inserts its records.'],
          refusalCodes: ['AUTOMATION_NOT_ACCEPTED'],
        }),
      ).refusalCodes,
    ).toEqual(['AUTOMATION_NOT_ACCEPTED']);
    // A refusal it gave no code, and the plan's own words.
    expect(
      frozenDryRunCount(answer({ refusals: ['This load would insert 2 record(s)'] })),
    ).not.toHaveProperty('refusalCodes');
    expect(
      frozenDryRunCount(
        answer({ refusals: ['This load would insert 2 record(s), more than the 1 it may'] }),
      ).refusal,
    ).toBe('This load would insert 2 record(s), more than the 1 it may');
    const nothing = answer({
      objects: [
        {
          objectApiName: 'Contact',
          fromFiles: 2,
          toInsert: 0,
          toLink: 2,
          notSent: 0,
          toPurge: 0,
          toDeactivate: 0,
        },
      ],
    });
    expect(frozenDryRunCount(nothing).refusal).toContain('it would insert nothing');
  });

  it('names a verdict short of the load, object by object, and an unstable one as such', () => {
    expect(
      frozenVerdictShortOf({
        status: 'FAILED',
        objects: [
          {
            objectApiName: 'Account',
            verdict: 'PASSED',
            expected: 2,
            found: 2,
            notLoaded: 0,
            orphans: 0,
            missingKeys: 0,
          },
          {
            objectApiName: 'Contact',
            verdict: 'FAILED',
            expected: 2,
            found: 2,
            notLoaded: 0,
            orphans: 1,
            missingKeys: 0,
          },
        ],
      }),
    ).toEqual({ unstable: false, short: 'Contact FAILED (2 of 2 found, 1 orphan(s))' });
    expect(frozenVerdictShortOf({ status: 'UNSTABLE', objects: [] }).unstable).toBe(true);
    expect(frozenRefreshOf({ tool: 'sandforge-frozen', step: 'verify', posted: [] })).toEqual({
      unread: 'the verification gave no verdict',
    });
  });

  it('tells a frozen run’s sas from another run’s summary', () => {
    expect(resourceOfSas('frozen/claims')).toBe('claims');
    expect(resourceOfSas('runs/claims/1.summary.json')).toBeUndefined();
    expect(resourceOfSas(undefined)).toBeUndefined();
  });
});
