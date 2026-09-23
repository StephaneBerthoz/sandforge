import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type {
  BaseMessage,
  PipelineHistoryEntry,
  PipelineTrigger,
  PipelineTriggerStatus,
  SalesforceOrg,
} from '@sandforge/shared';
import { TRIGGERED_RUN_PREFIX } from '@sandforge/shared';
import { AutomationHandler } from './AutomationHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { PipelineOrchestrator } from '../../modules/automation/PipelineOrchestrator.js';
import type { PipelineOrchestratorDependencies } from '../../modules/automation/PipelineOrchestrator.js';
import { PipelineMarketplace } from '../../modules/automation/PipelineMarketplace.js';
import type { TriggerReport } from '../../modules/automation/PipelineTriggerScheduler.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { ConfigProfileManager } from '../../core/config/ConfigProfileManager.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';

/** The registered orgs, by SandForge id: one sandbox, one production org. */
const ORGS: Record<string, Pick<SalesforceOrg, 'id' | 'alias' | 'username' | 'orgType'>> = {
  'org-uat': {
    id: 'org-uat',
    alias: 'uat',
    username: 'admin@example.test.uat',
    orgType: 'Sandbox',
  },
  'org-prod': {
    id: 'org-prod',
    alias: 'prod',
    username: 'admin@example.test',
    orgType: 'Production',
  },
};

/** Handler dependencies with a real ConfigStore and the orchestrator services.ts builds. */
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

/** A pipeline definition as the page saves it. */
function definition(
  id: string,
  steps: Array<Record<string, unknown>>,
  triggers: PipelineTrigger[],
  name = `Pipeline ${id}`,
): Record<string, unknown> {
  return {
    id,
    name,
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
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

const nightly: PipelineTrigger = {
  id: 'nightly',
  type: 'schedule',
  enabled: true,
  config: { cron: '0 2 * * *', timezone: 'UTC' },
};

const onRefreshOf = (orgId: string): PipelineTrigger => ({
  id: 'on-refresh',
  type: 'sandbox_refresh',
  enabled: true,
  config: { orgId },
});

/** Every message the handler posted, by type. */
function posted(deps: HandlerDeps, type: string): Array<BaseMessage & { payload: never }> {
  const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
  return postToWebview.mock.calls
    .map(([message]) => message as BaseMessage & { payload: never })
    .filter((message) => message.type === type);
}

/** The history the History tab would read. */
function history(deps: HandlerDeps): PipelineHistoryEntry[] {
  return Object.values(
    deps.configStore.getByCategory('pipeline-history'),
  ) as PipelineHistoryEntry[];
}

describe('AutomationHandler triggers', () => {
  let deps: HandlerDeps;
  let handler: AutomationHandler;
  let reports: TriggerReport[];

  /** Save a pipeline the way the page does. */
  async function save(pipeline: Record<string, unknown>): Promise<void> {
    await handler.handle(
      inboundRequest({
        id: `save-${String(pipeline.id)}`,
        type: 'pipeline:save',
        timestamp: Date.now(),
        payload: { id: pipeline.id, config: pipeline },
      } as unknown as BaseMessage),
    );
  }

  /** What `pipeline:list` answers about the triggers. */
  async function statuses(): Promise<PipelineTriggerStatus[]> {
    await handler.handle(
      inboundRequest({ id: 'list', type: 'pipeline:list', timestamp: Date.now() }),
    );
    const [answer] = posted(deps, 'pipeline:list:response').slice(-1) as Array<
      BaseMessage & { payload: { triggers: PipelineTriggerStatus[] } }
    >;
    return answer.payload.triggers;
  }

  beforeAll(async () => {
    // The handler loads the modules of a run the first time it builds one. A
    // load reads files, which a fake clock cannot hurry: loaded here, before
    // the clock is faked, a first run starts when its schedule says.
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
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-23T01:59:00.000Z'));
    deps = createDeps();
    handler = new AutomationHandler(deps);
    reports = [];
  });

  afterEach(() => {
    handler.stopTriggers();
    vi.useRealTimers();
  });

  it('starts a saved pipeline on its schedule, and the history says its schedule started it', async () => {
    handler.startTriggers({ report: (report) => reports.push(report) });
    await save(definition('p1', [{ type: 'delay', config: { seconds: 0 } }], [nightly], 'Nightly'));

    // Due at 02:00; the run it starts ends a moment later.
    await vi.advanceTimersByTimeAsync(61_000);

    expect(history(deps)).toEqual([
      expect.objectContaining({
        pipelineId: 'p1',
        pipelineName: 'Nightly',
        status: 'completed',
        triggeredBy: 'schedule',
        stepCount: 1,
      }),
    ]);
    // Every panel hears of the run, under an id no request of theirs carries.
    const [started] = posted(deps, 'operation:started') as Array<
      BaseMessage & { payload: { operationId: string; module: string } }
    >;
    expect(started.payload.module).toBe('automation');
    expect(started.payload.operationId.startsWith(TRIGGERED_RUN_PREFIX)).toBe(true);
    expect(posted(deps, 'operation:completed')).toHaveLength(1);
    expect(reports).toEqual([]);
  });

  it('leaves the runs of a saved pipeline out of a profile of the pipelines', async () => {
    // The keys the handler writes, read the way Settings exports them: the
    // pipelines category used to carry the run history along.
    handler.startTriggers({ report: (report) => reports.push(report) });
    await save(definition('p1', [{ type: 'delay', config: { seconds: 0 } }], [nightly], 'Nightly'));
    await vi.advanceTimersByTimeAsync(61_000);
    expect(history(deps)).toHaveLength(1);

    const exported = new ConfigProfileManager(deps.configStore).exportProfile(['pipelines']);

    const profile = JSON.parse(exported.json ?? '{}') as {
      data: { pipelines: Record<string, unknown> };
    };
    expect(Object.keys(profile.data.pipelines)).toEqual(['pipeline:saved:p1']);
  });

  it('lists the next start of a saved schedule, and why each trigger that starts nothing does not', async () => {
    await save(definition('p1', [{ type: 'delay', config: { seconds: 0 } }], [nightly]));
    await save(
      definition('p2', [{ type: 'delay', config: { seconds: 0 } }], [onRefreshOf('org-prod')]),
    );
    await save(
      definition(
        'p3',
        [{ type: 'seed', name: 'Seed accounts' }],
        [{ ...nightly, id: 'seed-nightly' }],
      ),
    );

    // Nothing watches the triggers until the extension starts them.
    expect((await statuses()).find((s) => s.pipelineId === 'p1')).toMatchObject({
      armed: false,
      idle: 'stopped',
    });

    handler.startTriggers({ report: (report) => reports.push(report) });
    const listed = await statuses();
    expect(listed.find((s) => s.pipelineId === 'p1')).toEqual({
      pipelineId: 'p1',
      triggerId: 'nightly',
      type: 'schedule',
      armed: true,
      timezone: 'UTC',
      nextRunAt: '2026-09-23T02:00:00.000Z',
    });
    expect(listed.find((s) => s.pipelineId === 'p2')).toMatchObject({
      type: 'sandbox_refresh',
      armed: false,
      idle: 'notSandbox',
    });
    // The executor's own refusal, the one a run from the page would meet.
    const seed = listed.find((s) => s.pipelineId === 'p3');
    expect(seed).toMatchObject({ armed: false, idle: 'cannotRun' });
    expect(seed?.detail).toContain('"Seed accounts" is a seed step, and this step type cannot run');
  });

  it("refuses the page's run of a pipeline its schedule is running, and names that run", async () => {
    handler.startTriggers({ report: (report) => reports.push(report) });
    const pipeline = definition('p1', [{ type: 'delay', config: { seconds: 120 } }], [nightly]);
    await save(pipeline);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(posted(deps, 'operation:started')).toHaveLength(1);

    await handler.handle(
      inboundRequest({
        id: 'wv-run',
        type: 'pipeline:execute',
        timestamp: Date.now(),
        payload: { pipeline, variables: {} },
      } as unknown as BaseMessage),
    );
    const [refusal] = posted(deps, 'pipeline:error') as Array<
      BaseMessage & { correlationId?: string; payload: { message: string; code: string } }
    >;
    expect(refusal.correlationId).toBe('wv-run');
    expect(refusal.payload.code).toBe('PIPELINE_RUNNING');
    expect(refusal.payload.message).toContain('"Pipeline p1" is already running');
    expect(refusal.payload.message).toContain('by its schedule at 2026-09-23T02:00:00.000Z');
    // Nothing of it started: the run under way is the only one.
    expect(posted(deps, 'operation:started')).toHaveLength(1);

    // Once that run ends, the page's run goes.
    await vi.advanceTimersByTimeAsync(120_000);
    const run = handler.handle(
      inboundRequest({
        id: 'wv-run-2',
        type: 'pipeline:execute',
        timestamp: Date.now(),
        payload: { pipeline: { ...pipeline, steps: [] }, variables: {} },
      } as unknown as BaseMessage),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await run;
    expect(posted(deps, 'pipeline:run:response')).toHaveLength(1);
  });

  it("writes a start that falls due during the page's run to the history as missed", async () => {
    handler.startTriggers({ report: (report) => reports.push(report) });
    const pipeline = definition('p1', [{ type: 'delay', config: { seconds: 120 } }], [nightly]);
    await save(pipeline);

    const run = handler.handle(
      inboundRequest({
        id: 'wv-run',
        type: 'pipeline:execute',
        timestamp: Date.now(),
        payload: { pipeline, variables: {} },
      } as unknown as BaseMessage),
    );
    await vi.advanceTimersByTimeAsync(150_000);
    await run;

    const entries = history(deps);
    expect(entries.map((entry) => [entry.status, entry.triggeredBy])).toEqual(
      expect.arrayContaining([
        ['completed', 'manual'],
        ['missed', 'schedule'],
      ]),
    );
    const missed = entries.find((entry) => entry.status === 'missed');
    expect(missed?.startTime).toBe('2026-09-23T02:00:00.000Z');
    expect(missed?.missed).toEqual({
      reason: 'busy',
      count: 1,
      busySince: '2026-09-23T01:59:00.000Z',
    });
    expect(reports).toEqual([expect.objectContaining({ kind: 'missed' })]);
  });

  describe('on a sandbox refresh', () => {
    it('starts the pipeline whose trigger names the refreshed sandbox, and the history says so', async () => {
      handler.startTriggers({ report: (report) => reports.push(report) });
      await save(
        definition('p1', [{ type: 'delay', config: { seconds: 0 } }], [onRefreshOf('org-uat')]),
      );

      await handler.noticeSandboxRefresh({ orgId: 'org-uat', key: '00D000000000011' });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(history(deps)).toEqual([
        expect.objectContaining({
          pipelineId: 'p1',
          status: 'completed',
          triggeredBy: 'sandbox_refresh',
        }),
      ]);
    });

    it('starts none of the Marketplace refresh template: every step it holds cannot run', async () => {
      handler.startTriggers({ report: (report) => reports.push(report) });
      // The work a refresh calls for, anonymizing and seeding, writes to an org.
      const template = JSON.parse(
        new PipelineMarketplace().exportTemplate('tpl-sandbox-refresh'),
      ) as {
        name: string;
        steps: Array<Record<string, unknown>>;
      };
      expect(template.steps.length).toBeGreaterThan(0);
      await save(definition('p1', template.steps, [onRefreshOf('org-uat')], template.name));

      await handler.noticeSandboxRefresh({ orgId: 'org-uat', key: '00D000000000011' });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(posted(deps, 'operation:started')).toHaveLength(0);
      const [entry] = history(deps);
      expect(entry).toMatchObject({
        status: 'missed',
        triggeredBy: 'sandbox_refresh',
        missed: { reason: 'cannotRun', count: 1 },
      });
      expect(entry.missed?.detail).toContain('cannot run in a pipeline');
      expect(reports).toEqual([expect.objectContaining({ kind: 'missed', sandboxName: 'uat' })]);
    });

    it('starts nothing before the extension starts the triggers', async () => {
      await save(
        definition('p1', [{ type: 'delay', config: { seconds: 0 } }], [onRefreshOf('org-uat')]),
      );
      await handler.noticeSandboxRefresh({ orgId: 'org-uat', key: '00D000000000011' });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(history(deps)).toEqual([]);
    });
  });
});
