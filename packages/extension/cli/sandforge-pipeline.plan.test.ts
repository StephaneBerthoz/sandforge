import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./sfSession.js', async (original) => ({
  ...(await original<typeof import('./sfSession.js')>()),
  loadOrg: vi.fn(),
  makeConn: vi.fn(),
}));
vi.mock('./sandforge-clone.js', async (original) => ({
  ...(await original<typeof import('./sandforge-clone.js')>()),
  targetAutomationReader: vi.fn(),
}));
vi.mock('../src/modules/forge/ForgeRunRemoval.js', async (original) => ({
  ...(await original<typeof import('../src/modules/forge/ForgeRunRemoval.js')>()),
  removalOrg: vi.fn(),
}));
vi.mock('../src/core/connection/ConnectionHelper.js', async (original) => ({
  ...(await original<typeof import('../src/core/connection/ConnectionHelper.js')>()),
  getJsforceConnection: vi.fn(),
}));

import {
  ACCOUNTS_TEMPLATE,
  PipelineWorld,
  WORLD_TARGET_ID,
  step,
} from './testing/pipelineWorld.js';
import type { PlanRefusal } from './sandforge-pipeline.js';

/*
 * The plan: each org connected and typed live, the Automation page's check
 * made in the host, and what the command line adds — every refusal said at
 * once, exit 2, before anything is written.
 */

let dir: string;
let journalBefore: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandforge-pipeline-plan-'));
  journalBefore = process.env['SANDFORGE_JOURNAL_DIR'];
  process.env['SANDFORGE_JOURNAL_DIR'] = join(dir, 'journal');
});
afterEach(() => {
  if (journalBefore === undefined) delete process.env['SANDFORGE_JOURNAL_DIR'];
  else process.env['SANDFORGE_JOURNAL_DIR'] = journalBefore;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const SEED = step('s1', 'Fill', 'seed', { orgId: 'reg-uat', templateId: ACCOUNTS_TEMPLATE.id });
const TEMPLATES = { [ACCOUNTS_TEMPLATE.id]: ACCOUNTS_TEMPLATE };

/** A Sync configuration of Account, from one org of the file to another. */
function syncConfig(source: string, target: string) {
  return {
    id: 'cfg-accounts',
    name: 'Accounts',
    description: '',
    sourceOrgId: source,
    targetOrgId: target,
    direction: 'source_to_target',
    mode: 'full',
    objects: [
      {
        objectApiName: 'Account',
        operation: 'insert',
        batchSize: 200,
        fieldMappings: [],
        transformRules: [],
        excludedFields: [],
        addOnFields: [],
        insertOrder: 0,
      },
    ],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

/** The refusals of a plan's JSON. */
function refusalsOf(stdout: string): PlanRefusal[] {
  return (JSON.parse(stdout) as { refusals: PlanRefusal[] }).refusals;
}

describe('sandforge pipeline plan', () => {
  it('refuses an org that answers as another Organization Id, with --accept-org, and writes nothing; taken once accepted', async () => {
    const world = new PipelineWorld(dir, [{ alias: 'UAT', organizationId: WORLD_TARGET_ID }]);
    const file = world.file({
      orgs: {
        'reg-uat': {
          alias: 'UAT',
          organizationId: '00D000000000001AAA',
          kind: 'sandbox',
          staging: false,
        },
      },
      steps: [SEED],
      seedTemplates: TEMPLATES,
    });

    const moved = await world.run(['plan', '--file', file, '--json']);

    expect(moved.code).toBe(2);
    expect(refusalsOf(moved.stdout)).toEqual([
      expect.objectContaining({
        code: 'ORG_MOVED',
        org: 'reg-uat',
        message: expect.stringContaining('a sandbox refreshed since is another org'),
        wayOut: expect.stringContaining(`--accept-org UAT=${WORLD_TARGET_ID}`),
      }),
    ]);
    expect(moved.stderr).toContain('Refused before the first step, nothing run (exit 2)');
    expect(world.env.records('Account')).toHaveLength(0);

    // The way out as it is printed, and the org's key in the file alike.
    for (const name of ['UAT', 'reg-uat']) {
      const accepted = await world.run([
        'plan',
        '--file',
        file,
        '--accept-org',
        `${name}=${WORLD_TARGET_ID}`,
        '--json',
      ]);
      expect(accepted.code).toBe(0);
      expect(refusalsOf(accepted.stdout)).toEqual([]);
      expect(accepted.stderr).toContain(`taken, as --accept-org ${name}=${WORLD_TARGET_ID} says.`);
    }
  });

  it('says the kind changed when a file that names a sandbox reaches a Developer Edition org', async () => {
    // The file's org edited to a sandbox of another Id, its alias a
    // Developer Edition org; the key, as the editor exports it, its Org Id.
    const world = new PipelineWorld(dir, [
      { alias: 'DEVED', organizationId: WORLD_TARGET_ID, sandbox: false },
    ]);
    const file = world.file({
      orgs: {
        '00D000000000001AAA': {
          alias: 'DEVED',
          organizationId: '00D000000000001AAA',
          kind: 'sandbox',
          staging: false,
        },
      },
      steps: [{ ...SEED, config: { ...SEED.config, orgId: '00D000000000001AAA' } }],
      seedTemplates: TEMPLATES,
    });

    const moved = await world.run(['plan', '--file', file, '--json']);

    expect(moved.code).toBe(2);
    expect(refusalsOf(moved.stdout)).toEqual([
      expect.objectContaining({
        code: 'ORG_MOVED',
        message:
          `DEVED answers as org ${WORLD_TARGET_ID}, and the file names 00D000000000001AAA: ` +
          'another org, of another kind: a Developer Edition org here, a sandbox in the file. ' +
          'Nothing was run.',
        wayOut:
          `check that DEVED is the org the pipeline is for, then run again with --accept-org ` +
          `DEVED=${WORLD_TARGET_ID}; or export the pipeline again from the Automation page.`,
      }),
    ]);
  });

  it('does not pin a scratch org made again under its alias to its Id, and says so', async () => {
    const world = new PipelineWorld(dir, [
      { alias: 'UAT', organizationId: WORLD_TARGET_ID, scratch: true },
    ]);
    const file = world.file({
      orgs: {
        'reg-uat': {
          alias: 'UAT',
          organizationId: '00D000000000001AAA',
          kind: 'scratch',
          staging: false,
        },
      },
      steps: [SEED],
      seedTemplates: TEMPLATES,
    });

    const planned = await world.run(['plan', '--file', file, '--json']);

    expect(planned.code).toBe(0);
    const answer = JSON.parse(planned.stdout) as { orgs: unknown[]; notes: string[] };
    expect(answer.orgs).toEqual([expect.objectContaining({ alias: 'UAT', kind: 'scratch' })]);
    expect(answer.notes.join(' ')).toContain('is not pinned to its Id');
  });

  it('refuses a write to a sandbox the file marks Staging when no Approval step stands before it', async () => {
    const world = new PipelineWorld(dir, [{ alias: 'UAT', organizationId: WORLD_TARGET_ID }]);
    const file = world.file({
      orgs: {
        'reg-uat': {
          alias: 'UAT',
          organizationId: WORLD_TARGET_ID,
          kind: 'sandbox',
          staging: true,
        },
      },
      steps: [SEED],
      seedTemplates: TEMPLATES,
    });

    const planned = await world.run(['plan', '--file', file, '--json']);

    expect(planned.code).toBe(2);
    expect(refusalsOf(planned.stdout)).toEqual([
      expect.objectContaining({
        code: 'STEP_REFUSED',
        step: 'Fill',
        message: expect.stringContaining('a sandbox marked Staging'),
      }),
    ]);
    expect(JSON.parse(planned.stdout).orgs).toEqual([
      expect.objectContaining({ alias: 'UAT', staging: true }),
    ]);
  });

  it('refuses a Sync into a production org typed live though an Approval stands before it, and says every refusal at once', async () => {
    const world = new PipelineWorld(dir, [
      { alias: 'UAT', organizationId: WORLD_TARGET_ID },
      {
        alias: 'PROD',
        organizationId: '00D000000000002AAA',
        sandbox: false,
        edition: 'Enterprise Edition',
      },
    ]);
    const file = world.file({
      orgs: {
        'reg-uat': {
          alias: 'UAT',
          organizationId: WORLD_TARGET_ID,
          kind: 'sandbox',
          staging: false,
        },
        'reg-prod': {
          alias: 'PROD',
          organizationId: '00D000000000002AAA',
          kind: 'production',
          staging: false,
        },
      },
      steps: [
        step('s1', 'Go?', 'approval', { timeoutMinutes: 5 }),
        step('s2', 'Push', 'sync', { configId: 'cfg-accounts' }),
      ],
      syncConfigs: { 'cfg-accounts': syncConfig('reg-uat', 'reg-prod') },
      variables: [{ name: 'ticket', type: 'string', required: true, description: '' }],
    });

    const planned = await world.run(['plan', '--file', file, '--json']);

    expect(planned.code).toBe(2);
    expect(refusalsOf(planned.stdout).filter((r) => r.code === 'PIPELINE_REFUSED')).toEqual([]);
    expect(
      refusalsOf(planned.stdout)
        .map((refusal) => refusal.code)
        .sort(),
    ).toEqual(['APPROVAL_NO_TERMINAL', 'PRODUCTION_TARGET', 'VARIABLE_MISSING']);
    expect(
      refusalsOf(planned.stdout).find((refusal) => refusal.code === 'PRODUCTION_TARGET'),
    ).toMatchObject({
      step: 'Push',
      message: expect.stringContaining('PROD, a production org'),
    });
    expect(
      refusalsOf(planned.stdout).find((refusal) => refusal.code === 'APPROVAL_NO_TERMINAL'),
    ).toMatchObject({
      wayOut: 'run it in a terminal, or add --approve "Go?".',
    });
  });

  it('asks the alias of an org the file names by none, and takes the one --org gives', async () => {
    const world = new PipelineWorld(dir, [{ alias: 'UAT', organizationId: WORLD_TARGET_ID }]);
    const file = world.file({
      orgs: { 'reg-uat': { organizationId: WORLD_TARGET_ID, kind: 'sandbox', staging: false } },
      steps: [SEED],
      seedTemplates: TEMPLATES,
    });

    const unnamed = await world.run(['plan', '--file', file, '--json']);
    expect(unnamed.code).toBe(2);
    expect(refusalsOf(unnamed.stdout)).toEqual([
      expect.objectContaining({
        code: 'ORG_NO_ALIAS',
        wayOut: expect.stringContaining('--org reg-uat=<alias>'),
      }),
    ]);

    const named = await world.run(['plan', '--file', file, '--org', 'reg-uat=UAT', '--json']);
    expect(named.code).toBe(0);
  });

  it('refuses a file a later release wrote, naming the release that runs it', async () => {
    const world = new PipelineWorld(dir, [{ alias: 'UAT', organizationId: WORLD_TARGET_ID }]);
    const file = join(dir, 'later.sandforge-pipeline.json');
    writeFileSync(file, JSON.stringify({ sandforgePipeline: 2, exportedBy: 'SandForge 1.83.0' }));

    const planned = await world.run(['plan', '--file', file]);

    expect(planned.code).toBe(2);
    expect(planned.stderr).toContain(`npx -y sandforge@1.83.0 pipeline plan --file ${file}`);
  });
});

describe('sandforge pipeline plan, a Rewind step never confirmed on this machine', () => {
  it("refuses it with the terminal's ways to confirm it, --confirm-rewind and confirm, never the page's gesture", async () => {
    // Run for real, the refusal was the page's: "open it and type the org's
    // alias", which a terminal has no page to do in.
    const world = new PipelineWorld(dir, [{ alias: 'UAT', organizationId: WORLD_TARGET_ID }]);
    const file = world.file({
      orgs: {
        'reg-uat': {
          alias: 'UAT',
          organizationId: WORLD_TARGET_ID,
          kind: 'sandbox',
          staging: false,
        },
      },
      steps: [
        step('s1', 'Back', 'rewind', {
          orgId: 'reg-uat',
          checkpointId: 'ck-20261120-020000-abcd',
          maxRecords: 10,
        }),
      ],
    });
    const store = join(dir, 'kept');

    for (const verb of ['plan', 'run']) {
      const refused = await world.run([verb, '--file', file, '--store', store, '--json']);

      expect(refused.code).toBe(2);
      expect(refusalsOf(refused.stdout)).toEqual([
        {
          code: 'REWIND_NOT_CONFIRMED',
          step: 'Back',
          message:
            'Rewind step "Back" has never been confirmed on this machine: it rewinds UAT only ' +
            "once UAT's alias is confirmed for it.",
          wayOut:
            'run it with --confirm-rewind UAT; or confirm it once, at a terminal, with ' +
            `pnpm exec tsx packages/extension/cli/sandforge-pipeline.ts confirm --file ${file} ` +
            `--store ${store}, typing UAT: the runs of that store then rewind it without the flag.`,
        },
      ]);
      const answer = JSON.parse(refused.stdout) as { steps: Array<{ refusal?: string }> };
      expect(answer.steps[0]?.refusal).not.toContain('open it');
      expect(refused.stderr).not.toContain('open it');
      expect(refused.stderr).toContain('--confirm-rewind UAT');
    }
  });
});

describe('sandforge pipeline confirm', () => {
  it('says there is nothing to confirm without a Rewind step, and refuses with no terminal to type the alias at', async () => {
    const world = new PipelineWorld(dir, [{ alias: 'UAT', organizationId: WORLD_TARGET_ID }]);
    const orgs = {
      'reg-uat': {
        alias: 'UAT',
        organizationId: WORLD_TARGET_ID,
        kind: 'sandbox' as const,
        staging: false,
      },
    };

    const none = await world.run([
      'confirm',
      '--file',
      world.file({ orgs, steps: [SEED], seedTemplates: TEMPLATES }),
    ]);
    expect(none.code).toBe(0);
    expect(none.stdout).toContain('has no Rewind step: nothing to confirm.');

    const rewound = world.file(
      {
        orgs,
        steps: [step('s1', 'Back', 'rewind', { orgId: 'reg-uat', checkpointId: 'cp-1' })],
      },
      'rewound',
    );
    const alone = await world.run(['confirm', '--file', rewound]);
    expect(alone.code).toBe(2);
    expect(alone.stderr).toContain(
      'Give --confirm-rewind <alias> to run instead. Nothing was confirmed.',
    );
  });
});
