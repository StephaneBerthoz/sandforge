import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AutomationHandler } from './AutomationHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import type { BaseMessage } from '@sandforge/shared';
import { inboundRequest } from '../../test/mockFactories.js';
import { ErrorResolver } from '../../modules/ai/ErrorResolver.js';
import type { AIProvider } from '../../modules/ai/ErrorResolver.js';
import { PipelineOrchestrator } from '../../modules/automation/PipelineOrchestrator.js';
import type { PipelineOrchestratorDependencies } from '../../modules/automation/PipelineOrchestrator.js';
import { PipelineMarketplace } from '../../modules/automation/PipelineMarketplace.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import type { PipelineStepRunners } from './pipelineSteps.js';
import { DataOpsHandler } from './DataOpsHandler.js';

/* A Backup step can run on DataOps's own snapshot flow, which reaches the org
   through the connection helper: replaced for the whole file, as vi.mock is
   hoisted above the imports. No other test here opens a connection. */
vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

/**
 * Module flows that answer at once, standing in for DataOps, Compare and the
 * Monitor: what the handler is given by `ExtensionHandlers`.
 */
function fakeRunners(overrides: Partial<PipelineStepRunners> = {}): PipelineStepRunners {
  return {
    orgName: (orgId) => (orgId === 'org-a' ? 'uat' : orgId === 'org-b' ? 'dev' : undefined),
    newId: () => 'snap-1',
    backup: vi.fn(async (request) => ({
      operationId: request.operationId,
      objects: [{ objectApiName: 'Account', recordCount: 4, truncated: false }],
      totalRecords: 4,
      partial: false,
      timestamp: '2026-09-23T00:00:00.000Z',
    })),
    compare: vi.fn(async () => ({
      configId: 'cfg',
      sourceOrgId: 'org-a',
      targetOrgId: 'org-b',
      mode: 'metadata' as const,
      summary: {
        totalItems: 3,
        added: 1,
        removed: 0,
        modified: 1,
        unchanged: 1,
        notCompared: 0,
        byType: {},
      },
      content: {
        compared: 2,
        notCompared: { unreadable: 0, read_failed: 0, over_budget: 0 },
        budget: { components: 400, seconds: 120 },
      },
      diffs: [],
      timestamp: '2026-09-23T00:00:00.000Z',
      duration: 10,
    })),
    readOrgHealth: vi.fn(async () => [
      {
        name: 'apiLimits',
        status: 'warning' as const,
        score: 28,
        message: 'API usage at 72%',
        percent: 72,
      },
    ]),
    notify: vi.fn(),
    ...overrides,
  };
}

/**
 * Creates minimal mock deps for AutomationHandler tests.
 */
function createMockDeps(): HandlerDeps {
  let idCounter = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: { getOrg: vi.fn() } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore: {
      get: vi.fn(),
      set: vi.fn(),
    } as unknown as HandlerDeps['configStore'],
    secretVault: {} as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
    nextId: () => String(++idCounter),
  };
}

/**
 * A ConfigStore that keeps its entries in memory, so a test can run a pipeline
 * and then read the history back the way the History tab reads it.
 */
function createMemoryConfigStore(): HandlerDeps['configStore'] {
  const entries = new Map<string, { value: unknown; category: string }>();
  return {
    get: vi.fn((key: string) => entries.get(key)?.value),
    set: vi.fn((key: string, value: unknown, category = 'general') => {
      entries.set(key, { value, category });
    }),
    delete: vi.fn((key: string) => entries.delete(key)),
    getByCategory: vi.fn((category: string) =>
      Object.fromEntries(
        [...entries]
          .filter(([, entry]) => entry.category === category)
          .map(([key, entry]) => [key, entry.value]),
      ),
    ),
  } as unknown as HandlerDeps['configStore'];
}

/** Composition-root services whose orchestrator resolves with `run`. */
function servicesReturning(run: Record<string, unknown>): HandlerDeps['services'] {
  return {
    getSandforgeSetting: vi.fn(() => 300_000),
    automationOrchestrator: vi.fn(() => ({
      on: vi.fn(),
      off: vi.fn(),
      getActiveRuns: vi.fn(() => []),
      execute: vi.fn().mockResolvedValue(run),
    })),
  } as unknown as HandlerDeps['services'];
}

/** What a run built by {@link realServices} reported when it ended. */
interface RunEnd {
  status: string;
  executed: number;
}

/**
 * Composition-root services that build the real orchestrator, as services.ts
 * does, so a run walks the real StepExecutor the handler constructs.
 * `ends` collects each run's final status and how many step executions it made.
 */
function realServices(timeoutMs = 300_000): {
  services: HandlerDeps['services'];
  ends: RunEnd[];
} {
  const ends: RunEnd[] = [];
  const services = {
    getSandforgeSetting: vi.fn(() => timeoutMs),
    automationOrchestrator: vi.fn((orchestratorDeps: PipelineOrchestratorDependencies) => {
      const execute = vi.spyOn(orchestratorDeps.stepExecutor, 'execute');
      const orchestrator = new PipelineOrchestrator(orchestratorDeps);
      const record = (_event: unknown, data: unknown): void => {
        const { status } = data as { status?: string };
        ends.push({ status: status ?? 'failed', executed: execute.mock.calls.length });
      };
      orchestrator.on('completed', record);
      orchestrator.on('failed', record);
      return orchestrator;
    }),
  } as unknown as HandlerDeps['services'];
  return { services, ends };
}

/** A pipeline definition as the webview sends it on `pipeline:execute`. */
function pipelinePayload(steps: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: 'pipe-9',
    name: 'Refresh QA',
    description: '',
    version: 1,
    steps: steps.map((step, index) => ({
      id: `s${index + 1}`,
      name: `Step ${index + 1}`,
      config: {},
      continueOnError: false,
      ...step,
    })),
    triggers: [],
    variables: [],
    tags: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

/** Every message the handler posted, by type. */
function posted(deps: HandlerDeps, type: string): Array<BaseMessage & { payload: never }> {
  const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
  return postToWebview.mock.calls
    .map(([message]) => message as BaseMessage & { payload: never })
    .filter((message) => message.type === type);
}

/** The run `pipeline:run:response` carried back. */
function runResponse(deps: HandlerDeps): {
  status: string;
  error?: string;
  stepResults: Array<Record<string, unknown>>;
} {
  const [response] = posted(deps, 'pipeline:run:response');
  expect(response).toBeDefined();
  return response.payload;
}

/** The single entry the History tab would read. */
function onlyHistoryEntry(deps: HandlerDeps): Record<string, unknown> {
  const entries = Object.values(deps.configStore.getByCategory('pipeline-history'));
  expect(entries).toHaveLength(1);
  return entries[0] as Record<string, unknown>;
}

/** A finished run as PipelineOrchestrator.execute resolves it. */
function completedRun(id: string, startTime: string): Record<string, unknown> {
  return {
    id,
    pipelineId: 'pipe-1',
    pipelineName: 'Nightly refresh',
    status: 'completed',
    triggeredBy: 'manual',
    startTime,
    endTime: startTime,
    duration: 1_200,
    stepResults: [
      { stepId: 's1', stepName: 'Wait', stepType: 'delay', status: 'completed' },
      { stepId: 's2', stepName: 'Check', stepType: 'condition', status: 'failed' },
    ],
    variables: {},
  };
}

describe('AutomationHandler', () => {
  let handler: AutomationHandler;
  let deps: HandlerDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createMockDeps();
    handler = new AutomationHandler(deps);
  });

  it('returns false for unhandled message types', async () => {
    const msg: InboundRequest = inboundRequest({
      id: '1',
      type: 'unknown:type',
      timestamp: Date.now(),
    });
    const result = await handler.handle(msg);
    expect(result).toBe(false);
  });

  it('handles pipeline:templates and response includes correlationId', async () => {
    const msg: InboundRequest = inboundRequest({
      id: 'req-auto-1',
      type: 'pipeline:templates',
      timestamp: Date.now(),
    });

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      correlationId?: string;
      payload: { templates: unknown[] };
    };
    expect(response.type).toBe('pipeline:templates:response');
    expect(response.correlationId).toBe('req-auto-1');
    expect(Array.isArray(response.payload.templates)).toBe(true);
  });

  it('handles marketplace:list error path with correlationId', async () => {
    // No marketplace injected -- will throw
    const msg: InboundRequest & { payload: Record<string, unknown> } = inboundRequest({
      id: 'req-auto-2',
      type: 'marketplace:list',
      timestamp: Date.now(),
      payload: {},
    });

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      correlationId?: string;
      payload: { success: boolean; error: string };
    };
    expect(response.type).toBe('marketplace:list:response');
    expect(response.correlationId).toBe('req-auto-2');
    expect(response.payload.success).toBe(false);
    expect(response.payload.error).toContain('not available');
  });

  it('handles marketplace:list success path with correlationId', async () => {
    const mockMarketplace = {
      getTemplates: vi.fn().mockReturnValue([
        {
          id: 'tpl-1',
          name: 'Test Template',
          description: 'Desc',
          category: 'test',
          steps: [{ type: 'seed' }, { type: 'delay' }],
        },
      ]),
      search: vi.fn(),
      getByCategory: vi.fn(),
    };
    handler.setPipelineMarketplace(
      mockMarketplace as unknown as Parameters<typeof handler.setPipelineMarketplace>[0],
    );

    const msg: InboundRequest & { payload: Record<string, unknown> } = inboundRequest({
      id: 'req-auto-3',
      type: 'marketplace:list',
      timestamp: Date.now(),
      payload: {},
    });

    await handler.handle(msg);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      correlationId?: string;
      payload: { success: boolean; templates: Array<{ stepTypes: string[] }> };
    };
    expect(response.type).toBe('marketplace:list:response');
    expect(response.correlationId).toBe('req-auto-3');
    expect(response.payload.success).toBe(true);
    expect(response.payload.templates).toHaveLength(1);
    // The card has to be able to say, before Install, which steps cannot run.
    expect(response.payload.templates[0].stepTypes).toEqual(['seed', 'delay']);
  });

  it('gives every built-in Marketplace card the step types of its template', async () => {
    const marketplace = new PipelineMarketplace();
    handler.setPipelineMarketplace(marketplace);

    await handler.handle(
      inboundRequest({
        id: 'req-auto-cards',
        type: 'marketplace:list',
        timestamp: Date.now(),
        payload: {},
      } as unknown as BaseMessage),
    );

    const [response] = posted(deps, 'marketplace:list:response') as unknown as Array<{
      payload: { templates: Array<{ id: string; stepTypes: string[] }> };
    }>;
    const cards = response.payload.templates;
    expect(cards).toHaveLength(marketplace.getTemplates().length);
    for (const card of cards) {
      expect(card.stepTypes).toEqual(marketplace.getById(card.id)?.steps.map((step) => step.type));
    }
    expect(cards.find((card) => card.id === 'tpl-nightly-backup')?.stepTypes).toEqual([
      'backup',
      'backup',
      'precheck',
    ]);
  });

  it('handles marketplace:install error path with correlationId', async () => {
    const msg: InboundRequest & { payload: { templateId: string } } = inboundRequest({
      id: 'req-auto-4',
      type: 'marketplace:install',
      timestamp: Date.now(),
      payload: { templateId: 'nonexistent' },
    });

    await handler.handle(msg);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      correlationId?: string;
      payload: { success: boolean };
    };
    expect(response.type).toBe('marketplace:install:response');
    expect(response.correlationId).toBe('req-auto-4');
    expect(response.payload.success).toBe(false);
  });

  it('handles pipeline:list with correlationId and returns pipelines from ConfigStore', async () => {
    const configStore = deps.configStore as unknown as {
      getByCategory: ReturnType<typeof vi.fn>;
    };
    configStore.getByCategory = vi.fn().mockReturnValue({
      'pipeline:saved:p1': {
        id: 'p1',
        name: 'Test Pipeline',
        savedAt: '2026-03-17T00:00:00Z',
      },
    });

    const msg: InboundRequest = inboundRequest({
      id: 'req-auto-list',
      type: 'pipeline:list',
      timestamp: Date.now(),
    });

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      correlationId?: string;
      payload: { pipelines: unknown[] };
    };
    expect(response.type).toBe('pipeline:list:response');
    expect(response.correlationId).toBe('req-auto-list');
    expect(response.payload.pipelines).toHaveLength(1);
  });

  it('handles pipeline:history with correlationId and returns sorted history', async () => {
    const configStore = deps.configStore as unknown as {
      getByCategory: ReturnType<typeof vi.fn>;
    };
    configStore.getByCategory = vi.fn().mockReturnValue({
      'pipeline:history:h1': { id: 'h1', status: 'completed', timestamp: 100 },
      'pipeline:history:h2': { id: 'h2', status: 'failed', timestamp: 200 },
    });

    const msg: InboundRequest = inboundRequest({
      id: 'req-auto-hist',
      type: 'pipeline:history',
      timestamp: Date.now(),
    });

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      correlationId?: string;
      payload: { history: Array<{ timestamp: number }> };
    };
    expect(response.type).toBe('pipeline:history:response');
    expect(response.correlationId).toBe('req-auto-hist');
    expect(response.payload.history).toHaveLength(2);
    // Sorted by timestamp descending (200 before 100)
    expect(response.payload.history[0].timestamp).toBe(200);
    expect(response.payload.history[1].timestamp).toBe(100);
  });

  it('keeps a finished run where pipeline:history reads it, and its pipeline only in storage', async () => {
    // The History tab is fed by the 'pipeline-history' category of the config
    // store; a run that is not written there leaves the tab empty for ever.
    deps.configStore = createMemoryConfigStore();
    deps.services = servicesReturning(completedRun('run-h1', '2026-09-01T10:00:00.000Z'));

    await handler.handle(
      inboundRequest({
        id: 'run-hist-1',
        type: 'pipeline:execute',
        timestamp: Date.now(),
        payload: { pipeline: { id: 'pipe-1', name: 'Nightly refresh', steps: [] } },
      } as unknown as BaseMessage),
    );

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    postToWebview.mockClear();

    await handler.handle(
      inboundRequest({ id: 'hist-1', type: 'pipeline:history', timestamp: Date.now() }),
    );

    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: {
        history: Array<Record<string, unknown>>;
      };
    };
    expect(response.type).toBe('pipeline:history:response');
    expect(response.payload.history).toHaveLength(1);
    const [entry] = response.payload.history;
    expect(entry['runId']).toBe('run-h1');
    expect(entry['status']).toBe('completed');
    expect(entry['stepCount']).toBe(2);
    expect(entry['errorCount']).toBe(1);

    // The definition is kept for a future replay, but nothing in the tab reads
    // it, and a pipeline's variables can hold a secret default: it stays in
    // extension storage and does not cross the bridge.
    const stored = deps.configStore.get('pipeline:history:run-h1') as {
      pipeline: { name: string };
    };
    expect(stored.pipeline.name).toBe('Nightly refresh');
    expect(entry['pipeline']).toBeUndefined();
    expect(entry['key']).toBeUndefined();
  });

  it('drops the oldest run once the history is full', async () => {
    // Each entry carries a whole pipeline definition, so an unbounded log would
    // grow the workspace state file on every click on Run.
    deps.configStore = createMemoryConfigStore();
    for (let i = 0; i < 50; i++) {
      deps.configStore.set(
        `pipeline:history:old-${i}`,
        { runId: `old-${i}`, timestamp: 1_000 + i },
        'pipeline-history',
      );
    }
    deps.services = servicesReturning(completedRun('run-newest', '2026-09-02T10:00:00.000Z'));

    await handler.handle(
      inboundRequest({
        id: 'run-hist-2',
        type: 'pipeline:execute',
        timestamp: Date.now(),
        payload: { pipeline: { id: 'pipe-1', name: 'Nightly refresh', steps: [] } },
      } as unknown as BaseMessage),
    );

    const stored = deps.configStore.getByCategory('pipeline-history') as Record<
      string,
      { runId: string }
    >;
    expect(Object.keys(stored)).toHaveLength(50);
    expect(stored['pipeline:history:old-0']).toBeUndefined();
    expect(stored['pipeline:history:run-newest']).toBeDefined();
  });

  it('handles pipeline:save with correlationId and persists to ConfigStore', async () => {
    const configStore = deps.configStore as unknown as {
      set: ReturnType<typeof vi.fn>;
    };
    configStore.set = vi.fn();

    const msg: InboundRequest & {
      payload: { id: string; config: Record<string, unknown> };
    } = inboundRequest({
      id: 'req-auto-save',
      type: 'pipeline:save',
      timestamp: Date.now(),
      payload: { id: 'p-save-1', config: { name: 'My Pipeline', steps: [] } },
    });

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    expect(configStore.set).toHaveBeenCalledWith(
      'pipeline:saved:p-save-1',
      expect.objectContaining({ name: 'My Pipeline', id: 'p-save-1' }),
      'pipelines',
    );

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      correlationId?: string;
      payload: { success: boolean; id: string };
    };
    expect(response.type).toBe('pipeline:save:response');
    expect(response.correlationId).toBe('req-auto-save');
    expect(response.payload.success).toBe(true);
    expect(response.payload.id).toBe('p-save-1');
  });

  it('handles pipeline:list error path', async () => {
    const configStore = deps.configStore as unknown as {
      getByCategory: ReturnType<typeof vi.fn>;
    };
    configStore.getByCategory = vi.fn().mockImplementation(() => {
      throw new Error('store failed');
    });

    const msg: InboundRequest = inboundRequest({
      id: 'req-auto-list-err',
      type: 'pipeline:list',
      timestamp: Date.now(),
    });

    await handler.handle(msg);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: { message: string };
    };
    expect(response.type).toBe('pipeline:error');
    expect(response.payload.message).toBe('store failed');
  });

  it('tells the model which module and request a failed pipeline run came from', async () => {
    // The prompt is all the model sees: a failure with no run behind it gets
    // an answer that fits any operation.
    const provider = vi.fn<AIProvider>(() =>
      Promise.resolve(JSON.stringify({ explanation: 'why', suggestions: [], confidence: 0.4 })),
    );
    deps.errorResolver = new ErrorResolver(provider);
    deps.broker = {
      postToWebview: vi.fn(),
      panelCount: 1,
      showFixSuggestion: vi.fn(),
    } as unknown as HandlerDeps['broker'];

    await handler.handle(
      inboundRequest({
        id: 'run-1',
        type: 'pipeline:execute',
        timestamp: Date.now(),
        payload: { pipeline: { name: 'Nightly refresh', steps: [] } },
      } as unknown as BaseMessage),
    );
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));

    const [prompt] = provider.mock.calls[0];
    expect(prompt).toContain('Module: automation');
    expect(prompt).toContain('Operation: pipeline:execute');
  });

  it('tells the model where a pipeline that ran and reported a failure came from', async () => {
    // A run that reaches the org and comes back failed reports on the same
    // channel as one that never started, and needs the same context.
    const provider = vi.fn<AIProvider>(() =>
      Promise.resolve(JSON.stringify({ explanation: 'why', suggestions: [], confidence: 0.4 })),
    );
    deps.errorResolver = new ErrorResolver(provider);
    deps.broker = {
      postToWebview: vi.fn(),
      panelCount: 1,
      showFixSuggestion: vi.fn(),
    } as unknown as HandlerDeps['broker'];
    deps.services = {
      getSandforgeSetting: vi.fn(() => 300_000),
      automationOrchestrator: vi.fn(() => ({
        on: vi.fn(),
        off: vi.fn(),
        getActiveRuns: vi.fn(() => []),
        execute: vi.fn().mockResolvedValue({
          id: 'run-abc',
          status: 'failed',
          error: 'SOMETHING_WE_HAVE_NEVER_SEEN: odd',
          stepResults: [],
        }),
      })),
    } as unknown as HandlerDeps['services'];

    await handler.handle(
      inboundRequest({
        id: 'run-2',
        type: 'pipeline:execute',
        timestamp: Date.now(),
        payload: { pipeline: { name: 'Nightly refresh', steps: [] } },
      } as unknown as BaseMessage),
    );
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));

    const [prompt] = provider.mock.calls[0];
    expect(prompt).toContain('Module: automation');
    expect(prompt).toContain('Operation: pipeline:execute');
  });

  describe('a run on the real executor', () => {
    /** Send `pipeline:execute` for `steps` and wait for the handler to answer. */
    async function run(steps: Array<Record<string, unknown>>, id = 'run-real'): Promise<void> {
      await handler.handle(
        inboundRequest({
          id,
          type: 'pipeline:execute',
          timestamp: Date.now(),
          payload: { pipeline: pipelinePayload(steps), variables: {} },
        } as unknown as BaseMessage),
      );
    }

    beforeEach(() => {
      deps.configStore = createMemoryConfigStore();
    });

    it.each([
      // The steps that write to an org: a pipeline runs unattended, and each
      // of them runs from its own page, behind Production Guard.
      'seed',
      'sync',
      'restore',
      'anonymize',
      'delete',
      'script',
      'approval',
      'loop',
      'parallel',
      // Names the predefined templates and the AI draft use, outside the union.
      'dataops:backup',
      'dataops',
    ])(
      'refuses a pipeline holding a %s step before any step runs, and History records it failed',
      async (type) => {
        const { services, ends } = realServices();
        deps.services = services;
        // The module flows are there: the refusal is the step type's own.
        handler.setStepRunners(fakeRunners());

        // `continueOnError` on the refused step: it must not buy a completed run.
        await run([
          { type: 'delay', config: { seconds: 0 } },
          { type, name: 'Do the work', continueOnError: true },
        ]);

        const result = runResponse(deps);
        expect(result.status).toBe('failed');
        expect(result.stepResults).toEqual([
          expect.objectContaining({
            stepId: 's2',
            status: 'failed',
            error: `Step "Do the work" is a ${type} step, and this step type cannot run in a pipeline yet.`,
          }),
        ]);
        expect(result.error).toMatch(/^Pipeline did not start: /);
        expect(ends).toEqual([{ status: 'failed', executed: 0 }]);

        expect(posted(deps, 'operation:failed')).toHaveLength(1);
        expect(posted(deps, 'operation:completed')).toHaveLength(0);

        const entry = onlyHistoryEntry(deps);
        expect(entry['status']).toBe('failed');
        expect(entry['stepCount']).toBe(1);
        expect(entry['errorCount']).toBe(1);
      },
    );

    it.each(['backup', 'compare', 'precheck', 'notification'])(
      'refuses a %s step where no module flow was given to run it',
      async (type) => {
        deps.services = realServices().services;

        await run([{ type, name: 'Do the work' }]);

        expect(runResponse(deps).stepResults).toEqual([
          expect.objectContaining({
            status: 'failed',
            error: `Step "Do the work" is a ${type} step, and this step type cannot run in a pipeline yet.`,
          }),
        ]);
      },
    );

    it('runs Backup, Compare, Pre-check and Notification through the module flows, and History keeps what each did', async () => {
      deps.services = realServices().services;
      const flows = fakeRunners();
      handler.setStepRunners(flows);

      await run([
        { type: 'backup', name: 'Snapshot', config: { orgId: 'org-a', objects: ['Account'] } },
        {
          type: 'compare',
          name: 'Diff',
          config: { sourceOrgId: 'org-a', targetOrgId: 'org-b', types: ['Flow'] },
        },
        { type: 'precheck', name: 'Limits', config: { orgId: 'org-a', checks: ['apiLimits'] } },
        {
          type: 'condition',
          name: 'Busy',
          condition: { field: 'apiUsagePercent', operator: 'gt', value: 60 },
        },
        { type: 'notification', name: 'Tell me', config: { message: 'API usage is high.' } },
      ]);

      const result = runResponse(deps);
      expect(result.status).toBe('completed');
      expect(result.stepResults.map((step) => step['status'])).toEqual([
        'completed',
        'completed',
        'completed',
        'completed',
        'completed',
      ]);
      expect(flows.backup).toHaveBeenCalledWith(
        { operationId: 'snap-1', orgId: 'org-a', objects: ['Account'] },
        expect.any(AbortSignal),
      );
      // The Condition read the API usage the Pre-check handed on.
      expect(result.stepResults[3]['output']).toEqual({ conditionMet: true });
      expect(flows.notify).toHaveBeenCalledWith('Refresh QA: API usage is high.');

      expect(onlyHistoryEntry(deps)['steps']).toEqual([
        expect.objectContaining({
          stepName: 'Snapshot',
          stepType: 'backup',
          status: 'completed',
          summary: 'Backed up 4 records of 1 object from uat.',
        }),
        expect.objectContaining({
          stepName: 'Diff',
          summary:
            'Compared 1 component type of uat with dev: 0 only in uat, 1 only in dev, 1 modified, 1 unchanged, 0 not compared.',
        }),
        expect.objectContaining({
          stepName: 'Limits',
          summary: 'The check passed on uat: API usage at 72% (warning).',
        }),
        expect.objectContaining({ stepName: 'Busy', summary: 'The condition held.' }),
        expect.objectContaining({
          stepName: 'Tell me',
          summary: 'Showed a notification in VS Code.',
        }),
      ]);
    });

    it('tells the page each step as it starts and ends, under the id of its request', async () => {
      deps.services = realServices().services;

      await run(
        [
          {
            type: 'condition',
            name: 'Only in prod',
            condition: { field: 'env', operator: 'eq', value: 'prod' },
          },
          { type: 'delay', config: { seconds: 0 } },
        ],
        'run-watched',
      );

      const updates = posted(deps, 'pipeline:step').map(
        (message) =>
          (
            message as unknown as {
              payload: { operationId: string; stepId: string; status: string };
            }
          ).payload,
      );
      expect(updates.map(({ stepId, status }) => [stepId, status])).toEqual([
        ['s1', 'running'],
        ['s1', 'completed'],
        ['s2', 'skipped'],
      ]);
      expect(new Set(updates.map((update) => update.operationId))).toEqual(
        new Set(['run-watched']),
      );
    });

    it('stops a run cancelled from the page through the orchestrator, and History records it cancelled', async () => {
      deps.services = realServices().services;
      const registry = new BackgroundOperationRegistry();
      deps.infraServices = {
        backgroundRegistry: registry,
      } as unknown as HandlerDeps['infraServices'];

      const started = handler.handle(
        inboundRequest({
          id: 'run-cancel',
          type: 'pipeline:execute',
          timestamp: Date.now(),
          payload: {
            pipeline: pipelinePayload([
              { type: 'delay', config: { seconds: 5 } },
              { type: 'delay', config: { seconds: 0 } },
            ]),
            variables: {},
          },
        } as unknown as BaseMessage),
      );
      // The run is registered under its request's id, which the page's
      // Cancel sends on execution:abort.
      await vi.waitFor(() => expect(posted(deps, 'pipeline:step')).toHaveLength(1));
      expect(registry.get('run-cancel')?.status).toBe('running');
      registry.abort('run-cancel');
      await started;

      const result = runResponse(deps);
      expect(result.status).toBe('cancelled');
      expect(result.stepResults).toEqual([
        expect.objectContaining({ stepId: 's1', status: 'failed' }),
      ]);
      expect(onlyHistoryEntry(deps)['status']).toBe('cancelled');
      expect(posted(deps, 'operation:failed')).toHaveLength(0);
    });

    it('takes no new snapshot when Live Operations cancels a Backup step, and History records the run cancelled', async () => {
      // The cancel reaches the snapshot's own registry entry, not the run's:
      // the step failed, each retry took a new snapshot, and the run was
      // written as failed — or went on, once a retry's snapshot was taken.
      deps.services = realServices().services;
      const registry = new BackgroundOperationRegistry();
      deps.infraServices = {
        backgroundRegistry: registry,
      } as unknown as HandlerDeps['infraServices'];
      const dataOps = new DataOpsHandler(deps);
      let snapshots = 0;
      const flows = fakeRunners({
        newId: () => `snap-${++snapshots}`,
        backup: (request, signal) => dataOps.backupForPipeline(request, signal),
      });
      handler.setStepRunners(flows);
      // Cancel on the snapshot, as execution:abort sends it, while the first
      // of its objects is read.
      const query = vi.fn(async () => {
        registry.abort('snap-1');
        return { records: [{ Id: '001' }], done: true };
      });
      vi.mocked(getJsforceConnection).mockResolvedValue({
        describe: vi.fn().mockResolvedValue({ fields: [{ name: 'Id' }] }),
        query,
      } as never);

      await run(
        [
          {
            type: 'backup',
            name: 'Snapshot',
            retries: 2,
            config: { orgId: 'org-a', objects: ['Account', 'Contact'] },
          },
          { type: 'notification', name: 'Tell me', config: { message: 'Snapshot taken.' } },
        ],
        'run-snapshot-cancelled',
      );

      expect(snapshots).toBe(1);
      expect(query).toHaveBeenCalledTimes(1);
      const result = runResponse(deps);
      expect(result.status).toBe('cancelled');
      expect(result.error).toBeUndefined();
      expect(result.stepResults).toEqual([
        expect.objectContaining({
          stepId: 's1',
          status: 'failed',
          error:
            'Backup was cancelled before it finished. Nothing was saved — run it again to take a complete snapshot.',
          cancelled: true,
        }),
      ]);
      expect(flows.notify).not.toHaveBeenCalled();
      expect(onlyHistoryEntry(deps)['status']).toBe('cancelled');
      // The snapshot says it was stopped, not that it failed; nor is the run
      // reported as failing.
      expect(posted(deps, 'operation:failed')).toEqual([]);
      expect(
        posted(deps, 'operation:completed')
          .map((message) => message.payload as { operationId: string; result: unknown })
          .filter((payload) => payload.operationId === 'snap-1'),
      ).toEqual([{ operationId: 'snap-1', result: { aborted: true } }]);
    });

    it('runs a pipeline that carries no variables and no triggers', async () => {
      // Every run of such a definition failed on pipeline:error, with
      // "pipeline.variables is not iterable".
      deps.services = realServices().services;
      const pipeline = pipelinePayload([{ type: 'delay', config: { seconds: 0 } }]);
      delete pipeline['variables'];
      delete pipeline['triggers'];

      await handler.handle(
        inboundRequest({
          id: 'run-bare',
          type: 'pipeline:execute',
          timestamp: Date.now(),
          payload: { pipeline },
        } as unknown as BaseMessage),
      );

      expect(posted(deps, 'pipeline:error')).toEqual([]);
      expect(runResponse(deps).status).toBe('completed');
    });

    it('does not send a refused pipeline to the model: SandForge wrote the reason itself', async () => {
      const provider = vi.fn<AIProvider>(() =>
        Promise.resolve(JSON.stringify({ explanation: 'why', suggestions: [], confidence: 0.4 })),
      );
      deps.errorResolver = new ErrorResolver(provider);
      deps.broker = {
        postToWebview: vi.fn(),
        panelCount: 1,
        showFixSuggestion: vi.fn(),
      } as unknown as HandlerDeps['broker'];
      deps.services = realServices().services;

      await run([{ type: 'seed' }]);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(runResponse(deps).status).toBe('failed');
      expect(provider).not.toHaveBeenCalled();

      // Positive control: an org's error on the same deps still reaches it.
      deps.services = servicesReturning({
        id: 'run-org',
        status: 'failed',
        error: 'SOMETHING_WE_HAVE_NEVER_SEEN: odd',
        stepResults: [],
      });
      await run([{ type: 'delay', config: { seconds: 0 } }], 'run-org');
      await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));
    });

    it('waits the seconds a Delay step was given, and History records the run completed', async () => {
      deps.services = realServices().services;

      await run([{ type: 'delay', config: { seconds: 0.02 } }]);

      const result = runResponse(deps);
      expect(result.status).toBe('completed');
      expect(result.stepResults[0]).toMatchObject({
        status: 'completed',
        output: { delayed: 20 },
      });
      expect(onlyHistoryEntry(deps)['status']).toBe('completed');
      expect(posted(deps, 'operation:completed')).toHaveLength(1);
    });

    it('builds the orchestrator without a pipeline scheduler, since nothing would read one', async () => {
      const { services } = realServices();
      deps.services = services;

      await run([{ type: 'delay', config: { seconds: 0 } }]);

      expect(runResponse(deps).status).toBe('completed');
      const build = services?.automationOrchestrator as unknown as ReturnType<typeof vi.fn>;
      expect(build).toHaveBeenCalledTimes(1);
      // A scheduler was built for every run and handed to an orchestrator that
      // never read it. The schedules that do start runs are the trigger
      // scheduler's, which starts them through this same run path.
      expect(build.mock.calls[0][0]).not.toHaveProperty('scheduler');
    });

    it('refuses a Delay step with no duration rather than calling a 0 ms wait done', async () => {
      deps.services = realServices().services;

      await run([{ type: 'delay', name: 'Pause' }]);

      const result = runResponse(deps);
      expect(result.status).toBe('failed');
      expect(result.stepResults).toEqual([
        expect.objectContaining({
          status: 'failed',
          error: 'Delay step "Pause" has no duration: set how many seconds it waits.',
        }),
      ]);
      expect(onlyHistoryEntry(deps)['status']).toBe('failed');
    });

    it('refuses a Condition step the page built, since nothing there gives it a condition', async () => {
      deps.services = realServices().services;

      await run([{ type: 'condition', name: 'Gate' }]);

      const result = runResponse(deps);
      expect(result.status).toBe('failed');
      expect(result.stepResults[0]).toMatchObject({
        status: 'failed',
        error: 'Condition step "Gate" has no condition to evaluate.',
      });
    });

    it('stops a run when the pipeline timeout is spent, answers it, and History records it failed', async () => {
      const { services, ends } = realServices(30);
      deps.services = services;

      await run([
        { type: 'delay', config: { seconds: 60 } },
        { type: 'delay', config: { seconds: 0 } },
      ]);

      // The run stops where it is: the Delay stops waiting out its 60 s, and
      // the step after it never starts…
      expect(ends).toEqual([{ status: 'cancelled', executed: 1 }]);

      // …and it is answered and recorded. It used to be dropped: no
      // `pipeline:run:response`, so the page waited out a limit of its own,
      // and no History entry.
      const result = runResponse(deps);
      expect(result.status).toBe('failed');
      expect(result.error).toBe(
        'Pipeline ran out of time: sandforge.pipeline.timeout stopped it after 30 ms.',
      );
      expect(result.stepResults).toEqual([
        expect.objectContaining({ stepId: 's1', status: 'failed' }),
      ]);

      const [failure] = posted(deps, 'operation:failed') as unknown as Array<{
        payload: { error: string; retryable: boolean };
      }>;
      expect(failure.payload.error).toBe(result.error);
      expect(failure.payload.retryable).toBe(true);

      const entry = onlyHistoryEntry(deps);
      expect(entry['status']).toBe('failed');
      expect(entry['stepCount']).toBe(1);
      expect(entry['errorCount']).toBe(1);
    });

    it('does not send a run the pipeline timeout stopped to the model: SandForge wrote the reason', async () => {
      const provider = vi.fn<AIProvider>(() =>
        Promise.resolve(JSON.stringify({ explanation: 'why', suggestions: [], confidence: 0.4 })),
      );
      deps.errorResolver = new ErrorResolver(provider);
      deps.broker = {
        postToWebview: vi.fn(),
        panelCount: 1,
        showFixSuggestion: vi.fn(),
      } as unknown as HandlerDeps['broker'];
      deps.services = realServices(30).services;

      await run([{ type: 'delay', config: { seconds: 60 } }]);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(runResponse(deps).status).toBe('failed');
      expect(provider).not.toHaveBeenCalled();
    });

    it('holds back the steps after a Condition on a declared variable that does not hold', async () => {
      deps.services = realServices().services;
      const pipeline = pipelinePayload([
        {
          type: 'condition',
          name: 'Only in prod',
          condition: { field: 'env', operator: 'eq', value: 'prod' },
        },
        { type: 'delay', config: { seconds: 0 } },
      ]);
      pipeline['variables'] = [
        { name: 'env', type: 'string', defaultValue: 'dev', required: false, description: '' },
      ];

      await handler.handle(
        inboundRequest({
          id: 'run-gate',
          type: 'pipeline:execute',
          timestamp: Date.now(),
          payload: { pipeline, variables: {} },
        } as unknown as BaseMessage),
      );

      const result = runResponse(deps);
      expect(result.status).toBe('completed');
      expect(result.stepResults).toEqual([
        expect.objectContaining({
          stepId: 's1',
          status: 'completed',
          output: { conditionMet: false },
        }),
        expect.objectContaining({ stepId: 's2', status: 'skipped' }),
      ]);
      // History says how many steps ran: the one passed over is not one of them.
      expect(onlyHistoryEntry(deps)['stepCount']).toBe(1);
    });
  });

  it('leaves no run listed as running in Live Operations when the orchestrator throws', async () => {
    const registry = new BackgroundOperationRegistry();
    deps.infraServices = {
      backgroundRegistry: registry,
    } as unknown as HandlerDeps['infraServices'];
    deps.services = {
      getSandforgeSetting: vi.fn(() => 300_000),
      automationOrchestrator: vi.fn(() => ({
        on: vi.fn(),
        off: vi.fn(),
        getActiveRuns: vi.fn(() => []),
        execute: vi.fn().mockRejectedValue(new Error('history store is gone')),
      })),
    } as unknown as HandlerDeps['services'];

    await handler.handle(
      inboundRequest({
        id: 'run-breaks',
        type: 'pipeline:execute',
        timestamp: Date.now(),
        payload: { pipeline: pipelinePayload([{ type: 'delay', config: { seconds: 0 } }]) },
      } as unknown as BaseMessage),
    );

    await vi.waitFor(() => expect(registry.get('run-breaks')?.status).toBe('failed'));
    expect(posted(deps, 'pipeline:error')).toHaveLength(1);
  });

  it('answers a run that throws on the error channel of its request, so the page stops waiting', async () => {
    // No composition-root services: the handler throws before the run starts.
    await handler.handle(
      inboundRequest({
        id: 'run-throws',
        type: 'pipeline:execute',
        timestamp: Date.now(),
        payload: { pipeline: pipelinePayload([{ type: 'delay', config: { seconds: 0 } }]) },
      } as unknown as BaseMessage),
    );

    const [error] = posted(deps, 'pipeline:error') as unknown as Array<{
      correlationId?: string;
      payload: { message: string };
    }>;
    expect(error.correlationId).toBe('run-throws');
    expect(error.payload.message).toContain('composition-root services not injected');
    expect(posted(deps, 'operation:failed')).toHaveLength(1);
  });

  describe('payload validation', () => {
    it('rejects pipeline:save without config (INVALID_PAYLOAD)', async () => {
      const msg = inboundRequest({
        id: 'bad-save',
        type: 'pipeline:save',
        timestamp: Date.now(),
        payload: { id: 'p-1' },
      } as unknown as BaseMessage);

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const errMsg = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { code: string };
      };
      expect(errMsg.type).toBe('pipeline:error');
      expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
    });

    it('rejects pipeline:execute with a malformed pipeline (INVALID_PAYLOAD)', async () => {
      const msg = inboundRequest({
        id: 'bad-run',
        type: 'pipeline:execute',
        timestamp: Date.now(),
        payload: { pipeline: { name: '' } },
      } as unknown as BaseMessage);

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const errMsg = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { code: string };
      };
      expect(errMsg.type).toBe('pipeline:error');
      expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
    });

    it('rejects marketplace:install without templateId (INVALID_PAYLOAD)', async () => {
      const msg = inboundRequest({
        id: 'bad-install',
        type: 'marketplace:install',
        timestamp: Date.now(),
        payload: {},
      } as unknown as BaseMessage);

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const errMsg = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { code: string };
      };
      expect(errMsg.type).toBe('pipeline:error');
      expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
    });
  });
});
