import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BaseMessage,
  PipelineExportOutcome,
  PipelineOutsideStatus,
  PipelineTrigger,
  SalesforceOrg,
} from '@sandforge/shared';
import { readPipelineFile } from '@sandforge/shared';
import { AutomationHandler, type PipelineDryRunApplier } from './AutomationHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import type { PipelineStepRunners } from './pipelineSteps.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { PipelineOrchestrator } from '../../modules/automation/PipelineOrchestrator.js';
import type { PipelineOrchestratorDependencies } from '../../modules/automation/PipelineOrchestrator.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import type { LockSelf } from '../../modules/checkpoint/linkedLock.js';
import {
  acquirePipelineRunLock,
  pipelineRunLockHolder,
} from '../../modules/automation/PipelineRunLock.js';
import { recordCliRun } from '../../modules/automation/cliRunHistory.js';

const USERNAME = 'admin.person@example.test.uat';

/** The registered orgs, by SandForge id: a sandbox with an alias of its own. */
const ORGS: Record<string, Partial<SalesforceOrg>> = {
  'org-uat': {
    id: 'org-uat',
    alias: 'uat',
    username: USERNAME,
    orgId: '00D000000000001AAA',
    orgType: 'Sandbox',
    authMethod: 'sfdx_import',
  },
};

/** A process of this machine that is running: the one that started this test. */
const RUNNING_CLI: LockSelf = {
  host: hostname(),
  pid: process.ppid,
  startedAt: new Date(Date.now() - 60_000).toISOString(),
};

/** A process of this machine that has ended: no system gives out a process id this high. */
const ENDED_CLI: LockSelf = { ...RUNNING_CLI, pid: 2_000_000_000 };

function createDeps(): HandlerDeps {
  let ids = 0;
  const configStore = new ConfigStore(new InMemoryConfigStoreBackend());
  configStore.initialize();
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: {
      getOrg: vi.fn((orgId: string) => ORGS[orgId]),
    } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as HandlerDeps['orgRegistry'],
    configStore,
    secretVault: {} as HandlerDeps['secretVault'],
    authProvider: {} as HandlerDeps['authProvider'],
    sfdxBridge: {} as HandlerDeps['sfdxBridge'],
    nextId: () => `ext-${++ids}`,
    services: {
      getSandforgeSetting: <T>(_key: string, fallback: T): T => fallback,
      automationOrchestrator: (d: PipelineOrchestratorDependencies) => new PipelineOrchestrator(d),
    } as unknown as HandlerDeps['services'],
  };
}

/** Module flows that answer at once: a Backup step's snapshot, a Compare, a Pre-check. */
function runners(): PipelineStepRunners {
  return {
    orgName: (orgId: string) => ORGS[orgId]?.alias,
    newId: () => 'snap-1',
    backup: vi.fn(async (request: { operationId: string }) => ({
      operationId: request.operationId,
      objects: [{ objectApiName: 'Account', recordCount: 4, truncated: false }],
      totalRecords: 4,
      partial: false,
      timestamp: '2026-11-20T00:00:00.000Z',
    })),
    compare: vi.fn(),
    readOrgHealth: vi.fn(async () => []),
  } as unknown as PipelineStepRunners;
}

const nightly: PipelineTrigger = {
  id: 'nightly',
  type: 'schedule',
  enabled: true,
  config: { cron: '0 2 * * *', timezone: 'Europe/Paris' },
};

function definition(
  steps: Array<Record<string, unknown>>,
  triggers: PipelineTrigger[] = [nightly],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'pipe-1',
    name: 'Nightly reset',
    description: '',
    version: 1,
    steps: steps.map((step, index) => ({
      id: `s${index + 1}`,
      name: `Step ${index + 1}`,
      config: {},
      continueOnError: false,
      ...step,
    })),
    triggers,
    variables: [],
    tags: [],
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...extra,
  };
}

const BACKUP = {
  type: 'backup',
  name: 'Snapshot',
  config: { orgId: 'org-uat', objects: ['Account'] },
};

function posted(deps: HandlerDeps, type: string): Array<BaseMessage & { payload: never }> {
  const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
  return postToWebview.mock.calls
    .map(([message]) => message as BaseMessage & { payload: never })
    .filter((message) => message.type === type);
}

const made: string[] = [];
function pipelinesRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-automation-export-'));
  made.push(dir);
  return join(dir, 'pipelines');
}

describe('AutomationHandler beside the command line', () => {
  let deps: HandlerDeps;
  let handler: AutomationHandler;
  let root: string;

  async function send(type: string, payload?: unknown, id = `${type}-req`): Promise<void> {
    await handler.handle(
      inboundRequest({
        id,
        type,
        timestamp: Date.now(),
        ...(payload !== undefined ? { payload } : {}),
      } as unknown as BaseMessage),
    );
  }

  async function save(pipeline: Record<string, unknown>): Promise<void> {
    await send('pipeline:save', { id: pipeline['id'], config: pipeline });
  }

  async function exportOf(pipelineId: string): Promise<PipelineExportOutcome> {
    await send('pipeline:export', { pipelineId });
    const [answer] = posted(deps, 'pipeline:export:response').slice(-1) as Array<
      BaseMessage & { payload: PipelineExportOutcome }
    >;
    return answer.payload;
  }

  function lastError(): { message: string; code: string } {
    const [error] = posted(deps, 'pipeline:error').slice(-1) as Array<
      BaseMessage & { payload: { message: string; code: string } }
    >;
    return error.payload;
  }

  beforeAll(async () => {
    await Promise.all([
      import('../../modules/automation/PipelineBuilder.js'),
      import('../../modules/automation/StepLibrary.js'),
      import('../../modules/automation/StepExecutor.js'),
      import('../../modules/automation/ConditionalRouter.js'),
      import('../../modules/automation/PipelineHistory.js'),
      import('../../modules/automation/TriggerEngine.js'),
    ]);
  });

  beforeEach(() => {
    deps = createDeps();
    handler = new AutomationHandler(deps);
    handler.setStepRunners(runners());
    root = pipelinesRoot();
    handler.setPipelinesRoot(root);
  });

  afterEach(() => {
    handler.stopTriggers();
    vi.useRealTimers();
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  describe('pipeline:export', () => {
    it('exports the pipeline as saved, each step checked where it sits as the editor checks it, and no username', async () => {
      handler.setSandforgeVersion('1.81.0');
      await save(
        definition([BACKUP, { type: 'restore', name: 'Put back', config: { orgId: 'org-uat' } }]),
      );

      const outcome = await exportOf('pipe-1');

      if (!outcome.exported) throw new Error(outcome.message);
      expect(outcome.fileName).toBe('nightly-reset.sandforge-pipeline.json');
      expect(outcome.text).not.toContain(USERNAME);
      const read = readPipelineFile(outcome.text);
      expect(read.ok && read.file.orgs['org-uat']).toEqual({
        alias: 'uat',
        organizationId: '00D000000000001AAA',
        kind: 'sandbox',
        staging: false,
      });
      expect(outcome.steps.map((step) => [step.name, step.fate])).toEqual([
        ['Snapshot', 'runs'],
        ['Put back', 'refused'],
      ]);
      expect(outcome.steps[1]?.refusal).toBe(
        'Step "Put back" is a restore step, and this step type cannot run in a pipeline yet.',
      );
      expect(outcome.problems).toContain(outcome.steps[1]?.refusal);
      expect(outcome.launchers.cron.text).toContain("npx -y 'sandforge@1.81.0'");
    });

    it('exports a Rewind step never confirmed here as the terminal of the run confirms it, never refused in the page’s words', async () => {
      // Exported, the step was marked refused, "open it and type the org's
      // alias", and the dialog listed it among what a run of the file
      // refuses: a run of the file confirms it on its own machine.
      handler.setSandforgeVersion('1.81.0');
      handler.setStepRunners({
        ...runners(),
        rewind: vi.fn(),
        orgTier: () => 'sandbox',
      } as unknown as PipelineStepRunners);
      await save(
        definition([
          {
            type: 'rewind',
            name: 'Back',
            config: { orgId: 'org-uat', checkpointId: 'ck-20261120-020000-abcd', maxRecords: 10 },
          },
        ]),
      );

      const outcome = await exportOf('pipe-1');

      if (!outcome.exported) throw new Error(outcome.message);
      expect(outcome.steps).toEqual([
        expect.objectContaining({
          name: 'Back',
          fate: 'asks',
          notes: ['REWIND_NEEDS_CONFIRMATION', 'REWIND_CHECKPOINT_ELSEWHERE'],
        }),
      ]);
      expect(outcome.problems).toEqual([]);
      expect(outcome.text).toContain('--confirm-rewind uat');
      expect(outcome.text).not.toContain('open it');
    });

    it('names the release the checkpoint dialogs of the host name, and refuses where none is named', async () => {
      await save(definition([BACKUP]));
      expect(await exportOf('pipe-1')).toMatchObject({ exported: false, code: 'VERSION_UNKNOWN' });

      deps.infraServices = {
        checkpointFiles: { sandforgeVersion: '1.81.0' },
      } as unknown as HandlerDeps['infraServices'];
      expect(await exportOf('pipe-1')).toMatchObject({
        exported: true,
        text: expect.stringContaining('"exportedBy": "SandForge 1.81.0"'),
      });
    });

    it('refuses a pipeline that is not saved, saying an export takes the pipeline as saved', async () => {
      handler.setSandforgeVersion('1.81.0');
      expect(await exportOf('never-saved')).toMatchObject({
        exported: false,
        code: 'NOT_SAVED',
        message: expect.stringContaining('An export takes the pipeline as saved'),
      });
    });
  });

  describe('the hand-over of a schedule', () => {
    it('lists whether the file handed over still holds what an export writes now', async () => {
      handler.setSandforgeVersion('1.81.0');
      await save(definition([BACKUP]));
      const exported = await exportOf('pipe-1');
      if (!exported.exported) throw new Error(exported.message);
      const handedOver = (steps: Array<Record<string, unknown>>) =>
        definition(steps, [{ ...nightly, enabled: false }], {
          runsOutside: {
            since: '2026-11-20T10:00:00.000Z',
            runner: 'cron',
            file: exported.fileName,
            digest: exported.digest,
          },
        });

      const outside = async (): Promise<PipelineOutsideStatus[] | undefined> => {
        await send('pipeline:list');
        const [answer] = posted(deps, 'pipeline:list:response').slice(-1) as Array<
          BaseMessage & { payload: { outside?: PipelineOutsideStatus[] } }
        >;
        return answer.payload.outside;
      };

      await save(handedOver([BACKUP]));
      expect(await outside()).toEqual([
        { pipelineId: 'pipe-1', matches: true, digest: exported.digest },
      ]);

      await save(handedOver([{ ...BACKUP, config: { orgId: 'org-uat', objects: ['Contact'] } }]));
      expect(await outside()).toEqual([
        {
          pipelineId: 'pipe-1',
          matches: false,
          digest: expect.not.stringMatching(exported.digest),
        },
      ]);
    });

    it('refuses to save a hand-over that names the file by its path, and saves nothing', async () => {
      await save(
        definition([BACKUP], [nightly], {
          runsOutside: {
            since: '2026-11-20T10:00:00.000Z',
            runner: 'cron',
            file: '/home/someone/nightly.sandforge-pipeline.json',
            digest: `sha256:${'a'.repeat(64)}`,
          },
        }),
      );

      expect(lastError()).toMatchObject({
        code: 'INVALID_PAYLOAD',
        message: expect.stringContaining("runsOutside.file: The file's name, without its folder"),
      });
      expect(deps.configStore.get('pipeline:saved:pipe-1')).toBeUndefined();
    });
  });

  describe('the run lock', () => {
    it('refuses a run from the page while the command line runs the pipeline, saying who and since when', async () => {
      const cli = acquirePipelineRunLock(
        root,
        'pipe-1',
        { pipelineName: 'Nightly reset', ranFrom: 'commandLine', triggeredBy: 'schedule' },
        { self: RUNNING_CLI },
      );
      if (!('lock' in cli)) throw new Error('the lock was not taken');
      const pipeline = definition([BACKUP]);

      await send('pipeline:execute', { pipeline, variables: {} });

      expect(lastError()).toMatchObject({
        code: 'PIPELINE_RUNNING',
        message: expect.stringContaining(
          'is already running on this machine: a run from the command line (sandforge pipeline run)',
        ),
      });
      expect(posted(deps, 'pipeline:run:response')).toHaveLength(0);
      cli.lock.release();

      // Nothing of the refused run stays held: the next run goes.
      await send('pipeline:execute', { pipeline, variables: {} }, 'second');
      expect(posted(deps, 'pipeline:run:response')).toHaveLength(1);
      expect(pipelineRunLockHolder(root, 'pipe-1')).toBeUndefined();
    });

    it('holds the lock while the page’s run goes, so the command line is refused meanwhile', async () => {
      let during: unknown;
      handler.setStepRunners({
        ...runners(),
        backup: vi.fn(async (request) => {
          during = pipelineRunLockHolder(root, 'pipe-1');
          return {
            operationId: request.operationId,
            objects: [],
            totalRecords: 0,
            partial: false,
            timestamp: '2026-11-20T00:00:00.000Z',
          };
        }),
      });

      await send('pipeline:execute', { pipeline: definition([BACKUP]), variables: {} });

      expect(during).toMatchObject({ ranFrom: 'editor', triggeredBy: 'manual', pid: process.pid });
      expect(pipelineRunLockHolder(root, 'pipe-1')).toBeUndefined();
    });

    it('takes over the lock of a command line run whose process ended, and says so in the log', async () => {
      const left = acquirePipelineRunLock(
        root,
        'pipe-1',
        { pipelineName: 'Nightly reset', ranFrom: 'commandLine', triggeredBy: 'schedule' },
        { self: ENDED_CLI },
      );
      expect('lock' in left).toBe(true);

      await send('pipeline:execute', { pipeline: definition([BACKUP]), variables: {} });

      expect(posted(deps, 'pipeline:run:response')).toHaveLength(1);
      expect(deps.log).toHaveBeenCalledWith(
        expect.stringContaining(
          'was left by a run from the command line (sandforge pipeline run) started at',
        ),
      );
    });

    it('starts nothing on a schedule while the command line runs the pipeline, and says why in the log', async () => {
      // The clock stays the machine's: a lock is believed for a day after it
      // was taken, by a process started since the machine was.
      const minute = Math.floor(Date.now() / 60_000) * 60_000;
      vi.useFakeTimers();
      vi.setSystemTime(minute + 59_000);
      const due = new Date(minute + 60_000);
      const cli = acquirePipelineRunLock(
        root,
        'pipe-1',
        { pipelineName: 'Nightly reset', ranFrom: 'commandLine', triggeredBy: 'schedule' },
        { self: { ...RUNNING_CLI, startedAt: new Date(minute).toISOString() } },
      );
      if (!('lock' in cli)) throw new Error('the lock was not taken');
      handler.startTriggers({ report: () => undefined });
      await save(
        definition(
          [BACKUP],
          [
            {
              ...nightly,
              config: {
                cron: `${due.getUTCMinutes()} ${due.getUTCHours()} * * *`,
                timezone: 'UTC',
              },
            },
          ],
        ),
      );

      await vi.advanceTimersByTimeAsync(61_000);

      expect(posted(deps, 'operation:started')).toHaveLength(0);
      expect(deps.log).toHaveBeenCalledWith(
        expect.stringContaining(
          '[pipeline-triggers] Pipeline "Nightly reset" is already running on this machine',
        ),
      );
      const missed = Object.values(deps.configStore.getByCategory('pipeline-history'));
      expect(missed).toEqual([expect.objectContaining({ status: 'missed' })]);
      cli.lock.release();
    });
  });

  describe('pipeline:history', () => {
    it('lists the runs the command line made on this machine beside the editor’s, marked, newest first, and a file that does not read once', async () => {
      await send('pipeline:execute', { pipeline: definition([BACKUP]), variables: {} });
      recordCliRun(root, 'pipe-1', {
        runId: 'cli-run',
        pipelineId: 'pipe-1',
        pipelineName: 'Nightly reset',
        status: 'completed',
        triggeredBy: 'schedule',
        startTime: new Date(Date.now() + 60_000).toISOString(),
        duration: 10,
        stepCount: 1,
        errorCount: 0,
      });
      mkdirSync(join(root, 'broken'), { recursive: true });
      writeFileSync(join(root, 'broken', 'history.json'), '{');

      await send('pipeline:history');
      await send('pipeline:history');

      const [answer] = posted(deps, 'pipeline:history:response').slice(-1) as Array<
        BaseMessage & { payload: { history: Array<Record<string, unknown>> } }
      >;
      expect(answer.payload.history.map((entry) => [entry['runId'], entry['ranFrom']])).toEqual([
        ['cli-run', 'commandLine'],
        [expect.any(String), undefined],
      ]);
      const said = (deps.log as ReturnType<typeof vi.fn>).mock.calls.filter(([line]) =>
        String(line).includes('broken'),
      );
      expect(said).toHaveLength(1);
    });
  });

  describe('a dry run', () => {
    it('is refused, nothing run, where nothing can make it one', async () => {
      const backup = vi.fn();
      handler.setStepRunners({ ...runners(), backup });

      await send('pipeline:execute', {
        pipeline: definition([BACKUP]),
        variables: {},
        dryRun: true,
      });

      expect(lastError()).toMatchObject({ code: 'DRY_RUN_UNAVAILABLE' });
      expect(backup).not.toHaveBeenCalled();
      expect(posted(deps, 'operation:started')).toHaveLength(0);
    });

    it('runs the steps the applier made of them, keeps no history, and says it was a dry run', async () => {
      const flows = runners();
      handler.setStepRunners(flows);
      const applier = vi.fn<PipelineDryRunApplier>((executor) => {
        executor.wrapHandler('backup', () => async (step) => ({
          stepId: step.id,
          stepName: step.name,
          stepType: step.type,
          status: 'completed',
          startTime: new Date().toISOString(),
          summary: 'Would snapshot Account',
        }));
      });
      handler.setDryRunApplier(applier);

      await send('pipeline:execute', {
        pipeline: definition([BACKUP]),
        variables: {},
        dryRun: true,
      });

      expect(applier).toHaveBeenCalledTimes(1);
      // The runners the steps were registered with, the run's confirmation
      // of a Rewind among them: the given ones alone left a Rewind nothing
      // to dry-run with.
      expect(applier.mock.calls[0]?.[1]).toMatchObject({
        orgName: flows.orgName,
        compare: flows.compare,
        readOrgHealth: flows.readOrgHealth,
        rewindGrant: expect.any(Function),
        checkpointKept: expect.any(Function),
      });
      expect(flows.backup).not.toHaveBeenCalled();
      const [response] = posted(deps, 'pipeline:run:response') as Array<
        BaseMessage & {
          payload: { dryRun?: boolean; status: string; stepResults: Array<{ summary?: string }> };
        }
      >;
      expect(response?.payload).toMatchObject({ dryRun: true, status: 'completed' });
      expect(response?.payload.stepResults[0]?.summary).toBe('Would snapshot Account');
      expect(Object.values(deps.configStore.getByCategory('pipeline-history'))).toEqual([]);
    });
  });
});
