import { describe, expect, it, vi } from 'vitest';
import type {
  CheckpointEstimate,
  CompareResult,
  GuardTier,
  PipelineDefinition,
  PipelineRun,
  PipelineStep,
  PipelineStepType,
  SyncSimulationResult,
} from '@sandforge/shared';
import {
  COMPARE_DIFFERENCE_COUNT,
  PREBUILT_SEED_TEMPLATES,
  pipelineRewindStepConfigSchema,
  rewindGrantDigest,
} from '@sandforge/shared';

import { CheckpointStepRefused } from '../../bridge/handlers/CheckpointHandler.js';
import type { HealthSignalName } from '../monitor/MonitorOpsFactory.js';
import { registerPipelineSteps } from '../../bridge/handlers/pipelineSteps.js';
import type { PipelineStepRunners } from '../../bridge/handlers/pipelineSteps.js';
import { ConditionalRouter } from './ConditionalRouter.js';
import { PipelineBuilder } from './PipelineBuilder.js';
import { PipelineHistory } from './PipelineHistory.js';
import { PipelineOrchestrator } from './PipelineOrchestrator.js';
import { StepExecutor } from './StepExecutor.js';
import { StepLibrary } from './StepLibrary.js';
import { TriggerEngine } from './TriggerEngine.js';
import { grantRefusalWords } from './RewindGrants.js';
import { applyDryRun } from './pipelineDryRun.js';

/** The orgs of the registry, by id: their names and the guard's tier of each. */
const ORGS: Record<string, { name: string; tier: GuardTier; organizationId: string }> = {
  'org-src': { name: 'source', tier: 'development', organizationId: '00D000000000005AAA' },
  'org-dev': { name: 'dev', tier: 'development', organizationId: '00D000000000001AAA' },
};

const CHECKPOINT_ID = 'ck-20261030-020000-abcd';

/** A saved Sync configuration, as the Sync page stores one: a delta of accounts. */
const SAVED_SYNC = {
  id: 'cfg-1',
  name: 'Accounts to dev',
  description: '',
  sourceOrgId: 'org-src',
  targetOrgId: 'org-dev',
  direction: 'source_to_target',
  mode: 'delta',
  objects: [
    {
      objectApiName: 'Account',
      operation: 'upsert',
      externalIdField: 'Ext_Id__c',
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
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

/** A comparison of two orgs that differ on `differences` components. */
function comparison(differences: number): CompareResult {
  return {
    configId: 'cfg-compare',
    sourceOrgId: 'org-src',
    targetOrgId: 'org-dev',
    mode: 'metadata',
    summary: {
      totalItems: differences + 4,
      added: differences,
      removed: 0,
      modified: 0,
      unchanged: 4,
      notCompared: 0,
      byType: {},
    },
    content: {
      compared: differences + 4,
      notCompared: { unreadable: 0, read_failed: 0, over_budget: 0 },
      budget: { components: 400, seconds: 120 },
    },
    diffs: [],
    timestamp: '2026-11-14T02:00:00.000Z',
    duration: 10,
  };
}

/** What Sync's simulation answers for the saved configuration: a first run from this store. */
function simulation(overrides: Partial<SyncSimulationResult> = {}): SyncSimulationResult {
  return {
    configId: 'cfg-1',
    operationId: 'sim-1',
    direction: 'source_to_target',
    conflictStrategy: 'source_wins',
    objects: [
      {
        objectApiName: 'Account',
        operation: 'upsert',
        read: 1000,
        insert: 400,
        update: 600,
        delete: 0,
        skipped: 0,
        refused: 0,
        conflicts: 0,
        conflictFields: [],
        notes: [],
        delta: {
          read: 'full',
          reason: 'first_run',
          changed: 1000,
          deletionsChecked: false,
          deleted: 0,
          deleteFailed: 0,
        },
      },
    ],
    duration: 10,
    timestamp: '2026-11-14T02:00:00.000Z',
    readCap: 1000,
    cutAtReadCap: ['Account'],
    ...overrides,
  } as SyncSimulationResult;
}

const ESTIMATE: CheckpointEstimate = {
  records: 1200,
  apiRequests: 14,
  apiRequestsLeft: 14_000,
  seconds: 30,
  bytes: 2 * 1024 * 1024,
};

/** What Seed's gates read of the org a template would seed: 2 MB of its 5 MB left. */
const SEED_PREVIEW = {
  records: 1000,
  objects: 2,
  storage: { verdict: 'fits' as const, estimateMB: 2, maxMB: 5, remainingMB: 5 },
  apiRequests: { verdict: 'fits' as const, estimate: 12, max: 15_000, remaining: 14_000 },
  automation: [],
  warnings: [],
};

/** The flows of the steps, each that writes, waits, asks or tells a spy that must stay silent. */
function runners(overrides: Partial<PipelineStepRunners> = {}): PipelineStepRunners {
  return {
    orgName: (orgId) => ORGS[orgId]?.name,
    newId: () => 'snap-1',
    backup: vi.fn(),
    compare: vi.fn(async () => comparison(3)),
    readOrgHealth: vi.fn(async (_orgId: string, signals: readonly HealthSignalName[]) =>
      signals.map((name) => ({ name, status: 'ok' as const, score: 100, message: 'fine' })),
    ),
    notify: vi.fn(),
    askApproval: vi.fn(),
    orgTier: (orgId) => ORGS[orgId]?.tier,
    organizationIdsOf: (orgId) => (ORGS[orgId] ? [ORGS[orgId].organizationId] : []),
    pipelineId: 'p-1',
    trigger: 'schedule',
    savedSyncConfig: (id) => (id === 'cfg-1' ? SAVED_SYNC : undefined),
    listSyncConfigs: () => [SAVED_SYNC],
    syncGuard: () => ({ decision: 'allowed' }),
    runSync: vi.fn(),
    savedSeedTemplate: () => undefined,
    listSeedTemplates: () => [],
    seed: vi.fn(),
    maskingTemplates: () => [
      {
        id: 'tpl-gdpr-standard',
        name: 'GDPR Standard',
        builtIn: true,
        rules: [{ fieldPattern: 'Contact.Email' }],
      },
    ],
    anonymize: vi.fn(),
    takeCheckpoint: vi.fn(),
    rewindGrant: vi.fn((_pipelineId, step) => {
      const config = pipelineRewindStepConfigSchema.parse(step.config);
      return {
        grant: {
          organizationId: '00D000000000001AAA',
          checkpointId: CHECKPOINT_ID,
          digest: rewindGrantDigest(config),
          grantedAt: '2026-10-29T09:00:00.000Z',
        },
      };
    }),
    checkpointKept: () => ({
      kept: true,
      organizationId: '00D000000000001',
      name: 'Baseline',
      valid: true,
    }),
    rewind: vi.fn(),
    simulateSync: vi.fn(async () => simulation()),
    previewSeed: vi.fn(async () => SEED_PREVIEW),
    previewMasking: vi.fn(async () => ({
      objects: [{ objectApiName: 'Contact', records: 6, fields: ['Email'] }],
      records: 6,
    })),
    estimateTake: vi.fn(async () => ({
      objects: 3,
      records: 1200,
      leftOut: 0,
      estimate: ESTIMATE,
    })),
    previewRewind: vi.fn(async () => ({
      checkpointId: CHECKPOINT_ID,
      toDelete: 2,
      toGiveBack: 1,
      toBringBack: 1,
      toRecreate: 0,
      estimate: { ...ESTIMATE, apiRequests: 12 },
    })),
    ...overrides,
  };
}

/** The spies of the flows that write, wait for a person, or tell one: none may be called in a dry run. */
function writes(flows: PipelineStepRunners): Array<ReturnType<typeof vi.fn>> {
  return [
    flows.backup,
    flows.notify,
    flows.askApproval,
    flows.runSync,
    flows.seed,
    flows.anonymize,
    flows.takeCheckpoint,
    flows.rewind,
  ].map((spy) => spy as unknown as ReturnType<typeof vi.fn>);
}

function step(
  id: string,
  type: PipelineStepType,
  config: Record<string, unknown>,
  extra: Partial<PipelineStep> = {},
): PipelineStep {
  return { id, name: id, type, config, continueOnError: false, ...extra };
}

/** A nightly pipeline: approve, compare, go on when they differ, then every step that writes. */
function nightly(): PipelineDefinition {
  return {
    id: 'p-1',
    name: 'Nightly reset',
    description: '',
    version: 1,
    steps: [
      step('Go?', 'approval', {}),
      step('Diff', 'compare', {
        sourceOrgId: 'org-src',
        targetOrgId: 'org-dev',
        types: ['ApexClass'],
      }),
      step(
        'Differs',
        'condition',
        {},
        {
          condition: { field: COMPARE_DIFFERENCE_COUNT, operator: 'gt', value: '0' },
        },
      ),
      step('Copy', 'sync', { configId: 'cfg-1' }),
      step('Seed', 'seed', { orgId: 'org-dev', templateId: PREBUILT_SEED_TEMPLATES[0].id }),
      step('Mask', 'anonymize', {
        orgId: 'org-dev',
        templateId: 'tpl-gdpr-standard',
        object: 'Contact',
      }),
      step('Keep', 'checkpoint', { orgId: 'org-dev', mode: 'everything' }),
      step('Back', 'rewind', { orgId: 'org-dev', checkpointId: CHECKPOINT_ID, maxRecords: 100 }),
      step('Snap', 'backup', { orgId: 'org-dev', objects: ['Account', 'Contact'] }),
      step('Wait', 'delay', { seconds: 3600 }),
      step('Tell', 'notification', { message: 'Done.' }),
    ],
    triggers: [],
    variables: [],
    tags: [],
    createdAt: '2026-11-14T00:00:00.000Z',
    updatedAt: '2026-11-14T00:00:00.000Z',
  };
}

/** An orchestrator whose executor runs the flows given, as a dry run when asked. */
function orchestratorOf(flows: PipelineStepRunners, dryRun: boolean): PipelineOrchestrator {
  const stepExecutor = new StepExecutor();
  registerPipelineSteps(stepExecutor, flows);
  if (dryRun) applyDryRun(stepExecutor, flows);
  return new PipelineOrchestrator({
    builder: new PipelineBuilder(),
    triggerEngine: new TriggerEngine(),
    stepLibrary: new StepLibrary(),
    stepExecutor,
    conditionalRouter: new ConditionalRouter(),
    history: new PipelineHistory(),
  });
}

/** Each step of a run, by name, with its status and what it says. */
function said(run: PipelineRun): Record<string, { status: string; text: string }> {
  return Object.fromEntries(
    run.stepResults.map((result) => [
      result.stepName,
      { status: result.status, text: result.summary ?? result.error ?? '' },
    ]),
  );
}

describe('applyDryRun', () => {
  it('runs every step of a pipeline through its checks and its route, and writes, waits, asks and tells nothing', async () => {
    const flows = runners();

    const run = await orchestratorOf(flows, true).execute(nightly(), {}, 'manual');

    expect(run.status).toBe('completed');
    for (const spy of writes(flows)) expect(spy).not.toHaveBeenCalled();
    // What only reads runs, so the Condition tests what the orgs hold.
    expect(flows.compare).toHaveBeenCalledOnce();
    const steps = said(run);
    expect(steps['Differs'].status).toBe('completed');
    expect(steps['Go?'].text).toBe(
      'Not asked in a simulation: the route goes on as if it were approved.',
    );
    expect(steps['Copy'].text).toBe(
      'Would sync "Accounts to dev" into dev: 400 to create, 600 to update, 0 to delete, 0 ' +
        'skipped and 0 refused of 1000 read; first run from this store for Account: no ' +
        'watermark yet, every record is read; Account read only up to 1000 records ' +
        '(sync.maxRecordsPerObject): the run copies part of each. Nothing was written.',
    );
    expect(steps['Seed'].text).toBe(
      `Would seed "${PREBUILT_SEED_TEMPLATES[0].name}" into dev: 1000 records of 2 objects, as ` +
        'its template asks; data storage: about 2 MB to write, dev has 5 MB left of 5 MB; about ' +
        '12 API requests of the 14000 dev has left today. Nothing was written.',
    );
    expect(steps['Mask'].text).toBe(
      'Would mask 6 records in dev: 6 of Contact (Email), after a snapshot of them. Nothing was written.',
    );
    expect(steps['Keep'].text).toBe(
      'Would take a checkpoint of dev: 1200 records of 3 objects now, about 14 API requests of ' +
        'the 14000 the org has left today, about 30 s. Nothing was taken.',
    );
    expect(steps['Back'].text).toBe(
      'Would rewind dev to the checkpoint ck-20261030-020000-abcd: 2 to delete, 1 to give their ' +
        'values back, 1 to bring back from the recycle bin, about 12 API requests of the 14000 ' +
        'the org has left today, about 30 s. Nothing was written.',
    );
    expect(steps['Snap'].text).toBe(
      'Would take a snapshot of 2 objects of dev (Account, Contact): a simulation takes none.',
    );
    expect(steps['Wait'].text).toBe('Would wait 1.0 h: a simulation does not wait.');
    expect(steps['Tell'].text).toBe(
      'Not shown in a simulation; the run would show in VS Code: "Done."',
    );
    // Each result says it is a dry run's, but those that only read.
    expect(
      run.stepResults
        .filter((result) => result.output?.['dryRun'] !== true)
        .map((result) => result.stepName),
    ).toEqual(['Diff', 'Differs']);
  });

  it('passes the simulation the saved configuration, and the masking preview the step as its run would ask it', async () => {
    const flows = runners();

    await orchestratorOf(flows, true).execute(nightly(), {}, 'manual');

    expect(flows.simulateSync).toHaveBeenCalledWith(SAVED_SYNC, expect.any(AbortSignal));
    expect(flows.previewMasking).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-dev',
        templateId: 'tpl-gdpr-standard',
        object: 'Contact',
        accord: { acceptAutomation: false, acceptEmails: false, muteAutomation: false },
      }),
      expect.any(AbortSignal),
    );
    expect(flows.previewRewind).toHaveBeenCalledWith(
      expect.objectContaining({
        grant: expect.objectContaining({ checkpointId: CHECKPOINT_ID }),
        origin: { pipeline: 'Nightly reset', step: 'Back', trigger: 'schedule' },
      }),
      expect.any(AbortSignal),
    );
  });

  it('goes where the run would go: a Condition that does not hold passes over every step after it', async () => {
    const flows = runners({ compare: vi.fn(async () => comparison(0)) });

    const run = await orchestratorOf(flows, true).execute(nightly(), {}, 'manual');

    expect(said(run)['Differs'].status).toBe('completed');
    expect(said(run)['Copy'].status).toBe('skipped');
    expect(flows.simulateSync).not.toHaveBeenCalled();
    expect(flows.estimateTake).not.toHaveBeenCalled();
  });

  it('checks every step as the run does: the same refusals, before anything is read', () => {
    const flows = runners({ savedSyncConfig: () => undefined, askApproval: undefined });
    const pipeline = nightly();

    const refusedRun = orchestratorOf(flows, false).check(pipeline);
    const refusedDry = orchestratorOf(flows, true).check(pipeline);

    expect(refusedDry).toEqual(refusedRun);
    expect(refusedDry).toEqual([
      'Approval step "Go?" cannot ask anyone: there is no VS Code window to ask in.',
      'Sync step "Copy" names a Sync configuration that is no longer saved (cfg-1): choose another.',
    ]);
  });

  it("fails a step its run would be refused for, in the run's words, and the route stops there", async () => {
    const refusal = new CheckpointStepRefused(
      'MAX_RECORDS',
      'The rewind would write 1,200 records, past the 100 the step allows.',
    );
    const flows = runners({ previewRewind: vi.fn(async () => Promise.reject(refusal)) });

    const run = await orchestratorOf(flows, true).execute(nightly(), {}, 'manual');

    expect(said(run)['Back']).toEqual({
      status: 'failed',
      text:
        'Rewind step "Back" would be refused: The rewind would write 1,200 records, past the ' +
        '100 the step allows.',
    });
    expect(said(run)['Snap']).toBeUndefined();
    expect(run.status).toBe('failed');
    for (const spy of writes(flows)) expect(spy).not.toHaveBeenCalled();
  });

  it('fails a Sync step whose simulation finds records the target would refuse, as the run fails its step', async () => {
    const flows = runners({
      simulateSync: vi.fn(async () =>
        simulation({
          objects: [{ ...simulation().objects[0], insert: 399, refused: 1 }],
          cutAtReadCap: undefined,
        }),
      ),
    });

    const run = await orchestratorOf(flows, true).execute(nightly(), {}, 'manual');

    expect(said(run)['Copy']).toEqual({
      status: 'failed',
      text:
        'Sync step "Copy" would run "Accounts to dev" into dev and not complete: 399 to create, ' +
        '600 to update, 0 to delete, 0 skipped and 1 refused of 1000 read; first run from this ' +
        'store for Account: no watermark yet, every record is read. Nothing was written.',
    });
    expect(flows.runSync).not.toHaveBeenCalled();
  });

  it('says why the target would refuse the records it counts refused, with the code, and gives the code in its output', async () => {
    // Two leads read with one e-mail address, upserted on Email: the dry run
    // said "0 refused", the run had both refused with DUPLICATE_VALUE.
    const note =
      '2 record(s) carry the Email of another record of the same call: an upsert finds its ' +
      'record by its key, and the target refuses every record of a call whose key another ' +
      'carries (DUPLICATE_VALUE: Duplicate external id specified).';
    const flows = runners({
      simulateSync: vi.fn(async () =>
        simulation({
          objects: [
            {
              ...simulation().objects[0],
              objectApiName: 'Lead',
              read: 4,
              insert: 2,
              update: 0,
              refused: 2,
              refusedFor: [{ code: 'DUPLICATE_VALUE', rows: 2, note }],
              notes: [note],
              delta: undefined,
            },
          ],
          cutAtReadCap: undefined,
        }),
      ),
    });

    const run = await orchestratorOf(flows, true).execute(nightly(), {}, 'manual');

    expect(said(run)['Copy']).toEqual({
      status: 'failed',
      text:
        'Sync step "Copy" would run "Accounts to dev" into dev and not complete: 2 to create, ' +
        '0 to update, 0 to delete, 0 skipped and 2 refused of 4 read; refused: Lead, 2 ' +
        'record(s) carry the Email of another record of the same call: an upsert finds its ' +
        'record by its key, and the target refuses every record of a call whose key another ' +
        'carries (DUPLICATE_VALUE: Duplicate external id specified). Nothing was written.',
    });
    const copy = run.stepResults.find((result) => result.stepName === 'Copy');
    expect(copy?.output?.['objects']).toEqual([
      expect.objectContaining({
        objectApiName: 'Lead',
        refused: 2,
        refusedFor: [{ code: 'DUPLICATE_VALUE', rows: 2, note }],
      }),
    ]);
  });

  it('says a Sync step read from the last watermark as such', async () => {
    const flows = runners({
      simulateSync: vi.fn(async () =>
        simulation({
          objects: [
            {
              ...simulation().objects[0],
              read: 0,
              insert: 0,
              update: 0,
              delta: {
                read: 'delta',
                since: '2026-11-13T02:00:00.000Z',
                changed: 0,
                deletionsChecked: false,
                deleted: 0,
                deleteFailed: 0,
              },
            },
          ],
          cutAtReadCap: undefined,
        }),
      ),
    });

    const run = await orchestratorOf(flows, true).execute(nightly(), {}, 'manual');

    expect(said(run)['Copy'].text).toBe(
      'Would sync "Accounts to dev" into dev: 0 to create, 0 to update, 0 to delete, 0 skipped ' +
        "and 0 refused of 0 read; Account read from the last run's watermark. Nothing was written.",
    );
  });

  it("fails a Seed step whose records do not fit the org's data storage, in its run's words, and the run with it", async () => {
    // A seed of 3 000 accounts into a Developer Edition with 5 MB left, which
    // its run alone refused.
    const words =
      'The records to write take about 5.86 MB of data storage, and dev has 5 MB left of 5 MB: ' +
      'leave objects out, lower the records per object, or free data storage in dev. Nothing ' +
      'was written.';
    const flows = runners({
      previewSeed: vi.fn(async () =>
        Promise.reject(Object.assign(new Error(words), { code: 'SEED_STORAGE_EXCEEDED' })),
      ),
    });

    const run = await orchestratorOf(flows, true).execute(nightly(), {}, 'manual');

    expect(run.status).toBe('failed');
    expect(run.stepResults.find((r) => r.stepName === 'Seed')).toMatchObject({
      status: 'failed',
      error: `Seed step "Seed" would be refused: ${words}`,
      output: { code: 'SEED_STORAGE_EXCEEDED', dryRun: true },
    });
    // The route stops where the run would.
    expect(said(run)['Mask']).toBeUndefined();
    for (const spy of writes(flows)) expect(spy).not.toHaveBeenCalled();
  });

  it("asks Seed's gates as the run would, approved by the Approval before the step, and by none without one", async () => {
    const flows = runners();
    await orchestratorOf(flows, true).execute(nightly(), {}, 'manual');
    const alone = runners();
    const pipeline = nightly();
    pipeline.steps = pipeline.steps.filter((each) => each.type === 'seed');
    await orchestratorOf(alone, true).execute(pipeline, {}, 'manual');

    expect(flows.previewSeed).toHaveBeenCalledWith(
      {
        orgId: 'org-dev',
        templateId: PREBUILT_SEED_TEMPLATES[0].id,
        pipeline: { name: 'Nightly reset' },
        answer: { approved: true },
      },
      expect.any(AbortSignal),
    );
    expect(alone.previewSeed).toHaveBeenCalledWith(
      expect.objectContaining({ answer: { approved: false } }),
      expect.any(AbortSignal),
    );
  });

  it("says when what a Seed's org has left could not be read", async () => {
    const flows = runners({
      previewSeed: vi.fn(async () => ({
        ...SEED_PREVIEW,
        storage: { verdict: 'unread' as const, estimateMB: 2, unread: 'INSUFFICIENT_ACCESS' },
      })),
    });

    const run = await orchestratorOf(flows, true).execute(nightly(), {}, 'manual');

    expect(said(run)['Seed'].text).toContain(
      'data storage: about 2 MB to write; what dev has left could not be read (INSUFFICIENT_ACCESS)',
    );
  });

  it('fails a masking its run would refuse, with the code its run gives', async () => {
    const flows = runners({
      previewMasking: vi.fn(async () =>
        Promise.reject(
          Object.assign(new Error('Nothing was masked: Contact holds 60000 record(s).'), {
            code: 'SNAPSHOT_NOT_TAKEN',
          }),
        ),
      ),
    });

    const run = await orchestratorOf(flows, true).execute(nightly(), {}, 'manual');

    expect(run.stepResults.find((r) => r.stepName === 'Mask')).toMatchObject({
      status: 'failed',
      error:
        'Anonymize step "Mask" would be refused: Nothing was masked: Contact holds 60000 record(s).',
      output: { code: 'SNAPSHOT_NOT_TAKEN', dryRun: true },
    });
  });

  it('fails a Rewind step no one confirmed, as the run does, without reading the org', async () => {
    const flows = runners({ rewindGrant: vi.fn(() => ({ refusal: 'never' as const })) });
    const executor = new StepExecutor();
    registerPipelineSteps(executor, flows);
    applyDryRun(executor, flows);
    const rewind = step('Back', 'rewind', {
      orgId: 'org-dev',
      checkpointId: CHECKPOINT_ID,
      maxRecords: 100,
    });

    const result = await executor.execute(rewind, {
      variables: {},
      previousResults: [],
      pipelineId: 'p-1',
      runId: 'r-1',
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBe(grantRefusalWords('Back', 'never'));
    expect(flows.previewRewind).not.toHaveBeenCalled();
  });

  it('fails a Rewind step whose confirmation was taken back after the check, before reading the org', async () => {
    let checked = false;
    const confirmed = runners().rewindGrant;
    const flows = runners({
      rewindGrant: vi.fn((pipelineId, rewindStep) => {
        if (checked) return { refusal: 'changed' as const };
        checked = true;
        return confirmed!(pipelineId, rewindStep);
      }),
    });
    const executor = new StepExecutor();
    registerPipelineSteps(executor, flows);
    applyDryRun(executor, flows);

    const result = await executor.execute(
      step('Back', 'rewind', { orgId: 'org-dev', checkpointId: CHECKPOINT_ID, maxRecords: 100 }),
      { variables: {}, previousResults: [], pipelineId: 'p-1', runId: 'r-1' },
    );

    expect(result).toMatchObject({
      status: 'failed',
      error: grantRefusalWords('Back', 'changed'),
      output: { code: 'NOT_CONFIRMED', dryRun: true },
    });
    expect(flows.previewRewind).not.toHaveBeenCalled();
  });

  it('says a Notification of the command line would be printed', async () => {
    const flows = runners({ ranFrom: 'commandLine' });
    const executor = new StepExecutor();
    registerPipelineSteps(executor, flows);
    applyDryRun(executor, flows);

    const result = await executor.execute(step('Tell', 'notification', { message: 'Done.' }), {
      variables: {},
      previousResults: [],
      pipelineId: 'p-1',
      runId: 'r-1',
    });

    expect(result.summary).toBe('Not printed in a simulation; the run would print: "Done."');
    expect(flows.notify).not.toHaveBeenCalled();
  });

  it('refuses rather than writes where the host gives no preview of a step that writes', async () => {
    const flows = runners({ simulateSync: undefined, previewMasking: undefined });
    const executor = new StepExecutor();
    registerPipelineSteps(executor, flows);
    applyDryRun(executor, flows);
    const context = { variables: {}, previousResults: [], pipelineId: 'p-1', runId: 'r-1' };

    const sync = await executor.execute(step('Copy', 'sync', { configId: 'cfg-1' }), context);
    const mask = await executor.execute(
      step('Mask', 'anonymize', {
        orgId: 'org-dev',
        templateId: 'tpl-gdpr-standard',
        object: 'Contact',
      }),
      context,
    );

    expect(sync.error).toBe(
      'Sync step "Copy" cannot be simulated here: nothing can read what it would do. Nothing was written.',
    );
    expect(mask.status).toBe('failed');
    expect(flows.runSync).not.toHaveBeenCalled();
    expect(flows.anonymize).not.toHaveBeenCalled();
  });
});
