import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseMessage, SalesforceOrg } from '@sandforge/shared';

import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { PipelineMarketplace } from '../../modules/automation/PipelineMarketplace.js';
import { PipelineOrchestrator } from '../../modules/automation/PipelineOrchestrator.js';
import type { PipelineOrchestratorDependencies } from '../../modules/automation/PipelineOrchestrator.js';
import { RewindGrants } from '../../modules/automation/RewindGrants.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { AutomationHandler } from './AutomationHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import type { PipelineStepRunners, RewindCheckpoint } from './pipelineSteps.js';

const CHECKPOINT_ID = 'ck-20261030-020000-abcd';
const ORGANIZATION_ID = '00D000000000001AAA';

/** The orgs registered here: one with an alias, one with none. */
const ORGS: Record<string, Partial<SalesforceOrg>> = {
  'org-dev': {
    id: 'org-dev',
    alias: 'training-dev',
    username: 'admin@example.invalid',
    orgId: ORGANIZATION_ID,
    orgType: 'Sandbox',
  },
  'org-bare': {
    id: 'org-bare',
    alias: '',
    username: 'bare@example.invalid',
    orgId: '00D000000000002AAA',
    orgType: 'Sandbox',
  },
};

/** A Rewind step's configuration, as saved. */
const REWIND = { orgId: 'org-dev', checkpointId: CHECKPOINT_ID, maxRecords: 100 };

function pipeline(
  config: Record<string, unknown> = REWIND,
  id = 'pipe-1',
): Record<string, unknown> {
  return {
    id,
    name: 'Nightly reset',
    description: '',
    version: 1,
    steps: [{ id: 'step-r', name: 'Reset', type: 'rewind', config, continueOnError: false }],
    triggers: [],
    variables: [],
    tags: [],
    createdAt: '2026-10-30T00:00:00.000Z',
    updatedAt: '2026-10-30T00:00:00.000Z',
  };
}

describe('AutomationHandler: the confirmation of a Rewind step', () => {
  let deps: HandlerDeps;
  let store: ConfigStore;
  let handler: AutomationHandler;
  let kept: Record<string, RewindCheckpoint>;
  let rewind: ReturnType<typeof vi.fn>;
  let next = 0;

  /** Send a message and return what the handler answered on `type`. */
  async function send(type: string, payload?: unknown): Promise<Record<string, unknown>> {
    const id = `req-${++next}`;
    await handler.handle(
      inboundRequest({ id, type, timestamp: Date.now(), payload } as unknown as BaseMessage),
    );
    const calls = vi.mocked(deps.broker.postToWebview).mock.calls.map(([m]) => m as BaseMessage);
    const answer = calls.find(
      (m) => (m as { correlationId?: string }).correlationId === id && m.type !== 'pipeline:step',
    );
    return ((answer as { payload?: Record<string, unknown> } | undefined)?.payload ?? {}) as Record<
      string,
      unknown
    >;
  }

  const save = (config: Record<string, unknown> = REWIND, id = 'pipe-1') =>
    send('pipeline:save', { id, config: pipeline(config, id) });
  const grant = (typed: string, stepId = 'step-r', pipelineId = 'pipe-1') =>
    send('pipeline:rewind-grant', { pipelineId, stepId, typed });

  beforeEach(() => {
    store = new ConfigStore(new InMemoryConfigStoreBackend());
    kept = {
      [CHECKPOINT_ID]: {
        kept: true,
        organizationId: '00D000000000001',
        name: 'Baseline',
        valid: true,
      },
    };
    rewind = vi.fn(async () => ({
      operationId: 'op-rewind',
      checkpointId: CHECKPOINT_ID,
      result: {
        checkpointId: CHECKPOINT_ID,
        rewindId: 'rw-20261030-020100-ef01',
        status: 'success',
        deleted: [],
        restored: [],
        undeleted: [],
        residual: [],
        passes: 1,
        apiRequests: { used: 3, leftToday: 1000 },
        finishedAt: '2026-10-30T02:01:00.000Z',
      },
      notes: [],
      estimate: {},
    }));
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn((id: string) => ORGS[id]),
        getAllOrgs: vi.fn(() => Object.values(ORGS)),
      } as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as HandlerDeps['orgRegistry'],
      configStore: store,
      secretVault: {} as HandlerDeps['secretVault'],
      authProvider: {} as HandlerDeps['authProvider'],
      sfdxBridge: {} as HandlerDeps['sfdxBridge'],
      nextId: () => String(++next),
      services: {
        getSandforgeSetting: vi.fn(() => 300_000),
        automationOrchestrator: vi.fn(
          (orchestratorDeps: PipelineOrchestratorDependencies) =>
            new PipelineOrchestrator(orchestratorDeps),
        ),
      } as unknown as HandlerDeps['services'],
    };
    handler = new AutomationHandler(deps);
    const runners: PipelineStepRunners = {
      orgName: (orgId) => ORGS[orgId]?.alias || ORGS[orgId]?.username,
      newId: () => 'id',
      backup: vi.fn(),
      compare: vi.fn(),
      readOrgHealth: vi.fn(),
      orgTier: (orgId) => (ORGS[orgId] ? 'development' : undefined),
      organizationIdsOf: (orgId) => (ORGS[orgId]?.orgId ? [ORGS[orgId].orgId!] : []),
      readCheckpoint: vi.fn(async (id: string) => kept[id] ?? { kept: false }),
      takeCheckpoint: vi.fn(),
      rewind: rewind as unknown as PipelineStepRunners['rewind'],
    };
    handler.setStepRunners(runners);
  });

  it('keeps a confirmation for the saved step once the alias is typed exactly', async () => {
    await save();
    const answer = await grant('training-dev');
    expect(answer).toMatchObject({
      granted: true,
      pipelineId: 'pipe-1',
      stepId: 'step-r',
      step: {
        stepId: 'step-r',
        checkpointId: CHECKPOINT_ID,
        valid: true,
        granted: { digestMatches: true },
      },
    });
    const kept = new RewindGrants(store).get('pipe-1', 'step-r');
    expect(kept).toMatchObject({ organizationId: '00D000000000001', checkpointId: CHECKPOINT_ID });
  });

  it.each(['TRAINING-DEV', 'training-dev ', 'training'])(
    'refuses %j, which is not the alias character for character, and keeps nothing',
    async (typed) => {
      await save();
      expect(await grant(typed)).toMatchObject({ granted: false, code: 'TYPED_MISMATCH' });
      expect(new RewindGrants(store).all()).toEqual([]);
    },
  );

  it('takes the username of an org with no alias, as the Checkpoints page does', async () => {
    kept[CHECKPOINT_ID] = { ...kept[CHECKPOINT_ID], organizationId: '00D000000000002' } as never;
    await save({ ...REWIND, orgId: 'org-bare' });
    expect(await grant('bare@example.invalid')).toMatchObject({ granted: true });
  });

  it('refuses a pipeline not saved, and a step the saved pipeline does not hold', async () => {
    expect(await grant('training-dev')).toMatchObject({ granted: false, code: 'NOT_SAVED' });
    await save();
    expect(await grant('training-dev', 'step-other')).toMatchObject({
      granted: false,
      code: 'NOT_SAVED',
    });
  });

  it('reads the step as saved, never as the page holds it', async () => {
    await save({ ...REWIND, maxRecords: 0 });
    expect(await grant('training-dev')).toMatchObject({ granted: false, code: 'CONFIG_INVALID' });
  });

  it('refuses an org not registered here', async () => {
    await save({ ...REWIND, orgId: 'org-gone' });
    expect(await grant('training-dev')).toMatchObject({ granted: false, code: 'ORG_UNKNOWN' });
  });

  it.each([
    [{ kept: false }, 'missing'],
    [{ kept: true, organizationId: '00D000000000009', name: 'Other', valid: true }, 'otherOrg'],
    [
      {
        kept: true,
        organizationId: '00D000000000001',
        name: 'Old',
        valid: false,
        why: 'refreshed',
      },
      'refreshed',
    ],
  ] as Array<[RewindCheckpoint, string]>)(
    'refuses a checkpoint that cannot be rewound to here: %j',
    async (checkpoint, why) => {
      kept[CHECKPOINT_ID] = checkpoint;
      await save();
      expect(await grant('training-dev')).toMatchObject({
        granted: false,
        code: 'CHECKPOINT_INVALID',
        why,
      });
      expect(new RewindGrants(store).all()).toEqual([]);
    },
  );

  it('takes it back when a save changes the step, and saving the old configuration does not bring it back', async () => {
    await save();
    await grant('training-dev');
    await save({ ...REWIND, maxRecords: 101 });
    expect(new RewindGrants(store).get('pipe-1', 'step-r')).toBeUndefined();
    await save();
    expect(new RewindGrants(store).get('pipe-1', 'step-r')).toBeUndefined();
    const steps = await send('pipeline:rewind-steps', { pipelineId: 'pipe-1' });
    expect(steps).toEqual({
      pipelineId: 'pipe-1',
      steps: [{ stepId: 'step-r', checkpointId: CHECKPOINT_ID, valid: true }],
    });
  });

  it('keeps it across a save that renames the step', async () => {
    await save();
    await grant('training-dev');
    const renamed = pipeline();
    (renamed['steps'] as Array<Record<string, unknown>>)[0]['name'] = 'Reset the training org';
    await send('pipeline:save', { id: 'pipe-1', config: renamed });
    expect(new RewindGrants(store).get('pipe-1', 'step-r')).toBeDefined();
  });

  it('takes it back when the pipeline is no longer saved, or its checkpoint no longer kept', async () => {
    await save();
    await save(REWIND, 'pipe-2');
    await grant('training-dev');
    await grant('training-dev', 'step-r', 'pipe-2');
    store.delete('pipeline:saved:pipe-1');
    await send('pipeline:list');
    expect(new RewindGrants(store).all().map((g) => g.pipelineId)).toEqual(['pipe-2']);
    kept[CHECKPOINT_ID] = { kept: false };
    await handler.revokeVoidGrants();
    expect(new RewindGrants(store).all()).toEqual([]);
  });

  it('takes it back on a Marketplace install of a pipeline under its id', async () => {
    handler.setPipelineMarketplace(new PipelineMarketplace());
    await save(REWIND, 'tpl-sandbox-refresh');
    await grant('training-dev', 'step-r', 'tpl-sandbox-refresh');
    expect(new RewindGrants(store).all()).toHaveLength(1);
    await send('marketplace:install', { templateId: 'tpl-sandbox-refresh' });
    expect(new RewindGrants(store).all()).toEqual([]);
  });

  it('takes it back on request, once', async () => {
    await save();
    await grant('training-dev');
    const revoke = () => send('pipeline:rewind-revoke', { pipelineId: 'pipe-1', stepId: 'step-r' });
    expect(await revoke()).toMatchObject({ revoked: true });
    expect(await revoke()).toMatchObject({ revoked: false });
  });

  it('refuses a run of an unconfirmed Rewind step before its first step, asking the org nothing', async () => {
    await save();
    await send('pipeline:execute', { pipeline: pipeline() });
    expect(rewind).not.toHaveBeenCalled();
    const run = vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { payload: Record<string, unknown> })
      .find((m) => m.type === 'pipeline:run:response');
    expect(run?.payload['status']).toBe('failed');
    expect(String(run?.payload['error'])).toContain('has never been confirmed');
  });

  it('runs a confirmed Rewind step with the confirmation, the trigger and the step named', async () => {
    await save();
    await grant('training-dev');
    await send('pipeline:execute', { pipeline: pipeline() });
    expect(rewind).toHaveBeenCalledTimes(1);
    expect(rewind.mock.calls[0][0]).toMatchObject({
      grant: { checkpointId: CHECKPOINT_ID, organizationId: '00D000000000001' },
      origin: { pipeline: 'Nightly reset', step: 'Reset', trigger: 'manual' },
    });
  });

  it('runs an edit of a confirmed step only once saved and confirmed again', async () => {
    await save();
    await grant('training-dev');
    await send('pipeline:execute', { pipeline: pipeline({ ...REWIND, acceptNoUndo: true }) });
    expect(rewind).not.toHaveBeenCalled();
  });

  it('arms no schedule of a pipeline whose Rewind step is unconfirmed, saying why, and stops saying so once confirmed', async () => {
    const scheduled = {
      ...pipeline(),
      triggers: [
        {
          id: 'trig-night',
          type: 'schedule',
          enabled: true,
          config: { cron: '0 2 * * *', timezone: 'UTC' },
        },
      ],
    };
    await send('pipeline:save', { id: 'pipe-1', config: scheduled });
    const before = (await send('pipeline:list'))['triggers'] as Array<Record<string, unknown>>;
    expect(before).toEqual([
      expect.objectContaining({ triggerId: 'trig-night', armed: false, idle: 'cannotRun' }),
    ]);
    expect(String(before[0]?.['detail'])).toContain('has never been confirmed');
    await grant('training-dev');
    // Nothing watches triggers in this host: what is left is that, and no
    // step that cannot run.
    const after = (await send('pipeline:list'))['triggers'] as Array<Record<string, unknown>>;
    expect(after).toEqual([
      expect.objectContaining({ triggerId: 'trig-night', armed: false, idle: 'stopped' }),
    ]);
  });

  it("holds the pipeline's time budget while a rewind runs past it", async () => {
    vi.mocked(deps.services!.getSandforgeSetting!).mockReturnValue(20 as never);
    rewind.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return {
        operationId: 'op-rewind',
        checkpointId: CHECKPOINT_ID,
        result: {
          checkpointId: CHECKPOINT_ID,
          rewindId: 'rw-20261030-020100-ef01',
          status: 'success',
          deleted: [],
          restored: [],
          undeleted: [],
          residual: [],
          passes: 1,
          apiRequests: { used: 3, leftToday: 1000 },
          finishedAt: '2026-10-30T02:01:00.000Z',
        },
        notes: [],
        estimate: {},
      };
    });
    await save();
    await grant('training-dev');
    await send('pipeline:execute', { pipeline: pipeline() });
    const run = vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { payload: Record<string, unknown> })
      .find((m) => m.type === 'pipeline:run:response');
    expect(run?.payload['status']).toBe('completed');
  });
});
