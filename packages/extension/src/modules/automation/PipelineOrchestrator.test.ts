import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PipelineOrchestrator } from './PipelineOrchestrator';
import type {
  PipelineOrchestratorDependencies,
  PipelineEventHandler,
} from './PipelineOrchestrator';
import { StepExecutor } from './StepExecutor';
import type { StepContext } from './StepExecutor';
import { ConditionalRouter } from './ConditionalRouter';
import type {
  PipelineDefinition,
  PipelineRun,
  PipelineStep,
  PipelineStepResult,
} from '@sandforge/shared';

function createMockDeps(): PipelineOrchestratorDependencies {
  return {
    builder: {
      validate: vi.fn().mockReturnValue([]),
      create: vi.fn(),
      addStep: vi.fn(),
      removeStep: vi.fn(),
      moveStep: vi.fn(),
      addTrigger: vi.fn(),
      removeTrigger: vi.fn(),
      addVariable: vi.fn(),
      clone: vi.fn(),
    } as unknown as PipelineOrchestratorDependencies['builder'],
    triggerEngine: {
      evaluateTrigger: vi.fn().mockReturnValue(true),
      matchesCron: vi.fn().mockReturnValue(false),
      matchesEvent: vi.fn().mockReturnValue(false),
      getNextFireTime: vi.fn(),
      getActiveTriggers: vi.fn().mockReturnValue([]),
    } as unknown as PipelineOrchestratorDependencies['triggerEngine'],
    stepLibrary: {
      getStepTypes: vi.fn().mockReturnValue([]),
      getStepType: vi.fn(),
      getDefaultConfig: vi.fn().mockReturnValue({}),
      validateStepConfig: vi.fn().mockReturnValue([]),
      getStepCategories: vi.fn().mockReturnValue([]),
    } as unknown as PipelineOrchestratorDependencies['stepLibrary'],
    stepExecutor: {
      execute: vi
        .fn<(step: unknown, ctx: unknown) => Promise<PipelineStepResult>>()
        .mockImplementation(async (step: unknown): Promise<PipelineStepResult> => {
          const s = step as { id: string; name: string; type: string };
          return {
            stepId: s.id,
            stepName: s.name,
            stepType: s.type as PipelineStepResult['stepType'],
            status: 'completed',
            startTime: new Date().toISOString(),
            endTime: new Date().toISOString(),
            duration: 10,
          };
        }),
      check: vi.fn<(step: unknown) => string | undefined>().mockReturnValue(undefined),
      getExecutor: vi.fn(),
      registerHandler: vi.fn(),
    } as unknown as PipelineOrchestratorDependencies['stepExecutor'],
    conditionalRouter: {
      evaluate: vi.fn().mockReturnValue(true),
      check: vi.fn().mockReturnValue(undefined),
      evaluateGroup: vi.fn().mockReturnValue(true),
      getNextStep: vi.fn().mockReturnValue(undefined),
      endsRun: vi.fn().mockReturnValue(false),
      findBranch: vi.fn().mockReturnValue([]),
    } as unknown as PipelineOrchestratorDependencies['conditionalRouter'],
    history: {
      record: vi.fn(),
      getHistory: vi.fn().mockReturnValue([]),
      getRun: vi.fn(),
      getStats: vi.fn().mockReturnValue({ totalRuns: 0, successRate: 0, avgDuration: 0 }),
      clearHistory: vi.fn(),
      getRecentRuns: vi.fn().mockReturnValue([]),
    } as unknown as PipelineOrchestratorDependencies['history'],
  };
}

function createPipeline(overrides?: Partial<PipelineDefinition>): PipelineDefinition {
  return {
    id: 'pipeline-1',
    name: 'Test Pipeline',
    description: 'A test pipeline',
    version: 1,
    steps: [
      {
        id: 'step-1',
        name: 'Seed Data',
        type: 'seed',
        config: {},
        continueOnError: false,
      },
    ],
    triggers: [],
    variables: [],
    tags: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('PipelineOrchestrator', () => {
  let orchestrator: PipelineOrchestrator;
  let deps: PipelineOrchestratorDependencies;

  beforeEach(() => {
    deps = createMockDeps();
    orchestrator = new PipelineOrchestrator(deps);
  });

  describe('execute', () => {
    it('should execute all steps and return a completed run', async () => {
      const pipeline = createPipeline();
      const run = await orchestrator.execute(pipeline, {}, 'manual');

      expect(run.status).toBe('completed');
      expect(run.stepResults).toHaveLength(1);
      expect(run.pipelineId).toBe('pipeline-1');
      expect(run.triggeredBy).toBe('manual');
    });

    it('should validate the pipeline before execution', async () => {
      vi.mocked(deps.builder.validate).mockReturnValue(['Pipeline name is required']);

      const pipeline = createPipeline({ name: '' });
      const run = await orchestrator.execute(pipeline, {}, 'manual');

      expect(run.status).toBe('failed');
      expect(run.error).toContain('Validation failed');
    });

    it('should record the run in history after completion', async () => {
      const pipeline = createPipeline();
      await orchestrator.execute(pipeline, {}, 'manual');

      expect(deps.history.record).toHaveBeenCalledTimes(1);
    });

    it('should pass variables to the step executor', async () => {
      const pipeline = createPipeline();
      const vars = { orgId: 'org-123' };

      await orchestrator.execute(pipeline, vars, 'manual');

      expect(deps.stepExecutor.execute).toHaveBeenCalledWith(
        pipeline.steps[0],
        expect.objectContaining({ variables: vars }),
      );
    });

    it('should mark run as failed when a step fails and continueOnError is false', async () => {
      vi.mocked(deps.stepExecutor.execute).mockResolvedValue({
        stepId: 'step-1',
        stepName: 'Seed Data',
        stepType: 'seed',
        status: 'failed',
        error: 'Connection refused',
      });

      const pipeline = createPipeline();
      const run = await orchestrator.execute(pipeline, {}, 'manual');

      expect(run.status).toBe('failed');
      expect(run.error).toBe('Connection refused');
    });

    it('should continue execution when continueOnError is true', async () => {
      vi.mocked(deps.stepExecutor.execute)
        .mockResolvedValueOnce({
          stepId: 'step-1',
          stepName: 'Step 1',
          stepType: 'seed',
          status: 'failed',
          error: 'Partial failure',
        })
        .mockResolvedValueOnce({
          stepId: 'step-2',
          stepName: 'Step 2',
          stepType: 'sync',
          status: 'completed',
        });

      const pipeline = createPipeline({
        steps: [
          { id: 'step-1', name: 'Step 1', type: 'seed', config: {}, continueOnError: true },
          { id: 'step-2', name: 'Step 2', type: 'sync', config: {}, continueOnError: false },
        ],
      });

      const run = await orchestrator.execute(pipeline, {}, 'manual');

      expect(run.status).toBe('completed_with_warnings');
      expect(run.stepResults).toHaveLength(2);
    });

    it('should skip steps whose condition is not met', async () => {
      vi.mocked(deps.conditionalRouter.evaluate).mockReturnValue(false);

      const pipeline = createPipeline({
        steps: [
          {
            id: 'step-1',
            name: 'Conditional Step',
            type: 'seed',
            config: {},
            continueOnError: false,
            condition: { field: 'env', operator: 'eq', value: 'prod' },
          },
        ],
      });

      const run = await orchestrator.execute(pipeline, {}, 'manual');

      expect(run.stepResults).toHaveLength(1);
      expect(run.stepResults[0].status).toBe('skipped');
      expect(deps.stepExecutor.execute).not.toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    it('should cancel a run', async () => {
      const pipeline = createPipeline({
        steps: [
          { id: 'step-1', name: 'S1', type: 'seed', config: {}, continueOnError: false },
          { id: 'step-2', name: 'S2', type: 'sync', config: {}, continueOnError: false },
        ],
      });

      let runId = '';
      orchestrator.on('started', (_event, data) => {
        const d = data as { runId: string };
        runId = d.runId;
        orchestrator.cancel(runId);
      });

      const run = await orchestrator.execute(pipeline, {}, 'manual');

      expect(run.status).toBe('cancelled');
    });
  });

  describe('getRun', () => {
    it('should return a run from history when not active', async () => {
      const mockRun = createPipeline();
      vi.mocked(deps.history.getRun).mockReturnValue({
        id: 'run-1',
        pipelineId: mockRun.id,
        pipelineName: mockRun.name,
        status: 'completed',
        triggeredBy: 'manual',
        stepResults: [],
        variables: {},
        startTime: '2026-01-01T00:00:00Z',
      });

      const run = orchestrator.getRun('run-1');
      expect(run).toBeDefined();
      expect(run!.status).toBe('completed');
    });

    it('should return undefined when run does not exist', () => {
      vi.mocked(deps.history.getRun).mockReturnValue(undefined);
      expect(orchestrator.getRun('non-existent')).toBeUndefined();
    });
  });

  describe('getActiveRuns', () => {
    it('should return empty array when no runs are active', () => {
      expect(orchestrator.getActiveRuns()).toEqual([]);
    });
  });

  describe('event handling', () => {
    it('should emit started event when execution begins', async () => {
      const handler = vi.fn();
      orchestrator.on('started', handler);

      await orchestrator.execute(createPipeline(), {}, 'manual');

      expect(handler).toHaveBeenCalledWith(
        'started',
        expect.objectContaining({ pipelineId: 'pipeline-1' }),
      );
    });

    it('should emit completed event when execution finishes', async () => {
      const handler = vi.fn();
      orchestrator.on('completed', handler);

      await orchestrator.execute(createPipeline(), {}, 'manual');

      expect(handler).toHaveBeenCalledWith(
        'completed',
        expect.objectContaining({ status: 'completed' }),
      );
    });

    it('should emit stepCompleted for each executed step', async () => {
      const handler = vi.fn();
      orchestrator.on('stepCompleted', handler);

      const pipeline = createPipeline({
        steps: [
          { id: 'step-1', name: 'S1', type: 'seed', config: {}, continueOnError: false },
          { id: 'step-2', name: 'S2', type: 'sync', config: {}, continueOnError: false },
        ],
      });

      await orchestrator.execute(pipeline, {}, 'manual');

      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('should support unregistering event handlers', async () => {
      const handler: PipelineEventHandler = vi.fn();
      orchestrator.on('started', handler);
      orchestrator.off('started', handler);

      await orchestrator.execute(createPipeline(), {}, 'manual');

      expect(handler).not.toHaveBeenCalled();
    });

    it('should not throw when removing handler that was never added', () => {
      const handler = vi.fn();
      expect(() => orchestrator.off('started', handler)).not.toThrow();
    });
  });

  describe('a pipeline with a step that cannot run', () => {
    const refusal =
      'Step "Load Target" is a seed step, and this step type cannot run in a pipeline yet.';

    function refuseSeedSteps(): void {
      vi.mocked(deps.stepExecutor.check).mockImplementation((step: PipelineStep) =>
        step.type === 'seed' ? refusal : undefined,
      );
    }

    it('does not start: no step runs, and the run is recorded failed with the reason', async () => {
      refuseSeedSteps();
      const started = vi.fn();
      const failed = vi.fn();
      orchestrator.on('started', started);
      orchestrator.on('failed', failed);

      const run = await orchestrator.execute(
        createPipeline({
          steps: [
            { id: 'step-1', name: 'Wait', type: 'delay', config: {}, continueOnError: false },
            { id: 'step-2', name: 'Load Target', type: 'seed', config: {}, continueOnError: false },
          ],
        }),
        {},
        'manual',
      );

      expect(deps.stepExecutor.execute).not.toHaveBeenCalled();
      expect(run.status).toBe('failed');
      expect(run.error).toBe(`Pipeline did not start: ${refusal}`);
      // One result per refused step; the delay before it was never reached.
      expect(run.stepResults).toEqual([
        {
          stepId: 'step-2',
          stepName: 'Load Target',
          stepType: 'seed',
          status: 'failed',
          error: refusal,
        },
      ]);
      expect(deps.history.record).toHaveBeenCalledWith(run);
      expect(started).not.toHaveBeenCalled();
      expect(failed).toHaveBeenCalledWith('failed', { runId: run.id, error: run.error });
    });

    it('names every refused step, not only the first', async () => {
      vi.mocked(deps.stepExecutor.check).mockImplementation((step: PipelineStep) =>
        step.type === 'delay' ? undefined : `refused ${step.name}.`,
      );

      const run = await orchestrator.execute(
        createPipeline({
          steps: [
            { id: 'a', name: 'Backup', type: 'backup', config: {}, continueOnError: false },
            { id: 'b', name: 'Wait', type: 'delay', config: {}, continueOnError: false },
            { id: 'c', name: 'Notify', type: 'notification', config: {}, continueOnError: false },
          ],
        }),
        {},
        'manual',
      );

      expect(run.stepResults.map((result) => [result.stepId, result.status])).toEqual([
        ['a', 'failed'],
        ['c', 'failed'],
      ]);
      expect(run.error).toBe('Pipeline did not start: refused Backup. refused Notify.');
    });

    it('does not let continueOnError walk past a refused step to a completed run', async () => {
      refuseSeedSteps();

      const run = await orchestrator.execute(
        createPipeline({
          steps: [
            { id: 'step-1', name: 'Load Target', type: 'seed', config: {}, continueOnError: true },
            { id: 'step-2', name: 'Wait', type: 'delay', config: {}, continueOnError: false },
          ],
        }),
        {},
        'manual',
      );

      expect(run.status).toBe('failed');
      expect(deps.stepExecutor.execute).not.toHaveBeenCalled();
    });

    it('is refused by the real executor for every step type it has no handler for', async () => {
      deps.stepExecutor = new StepExecutor();
      orchestrator = new PipelineOrchestrator(deps);

      const run = await orchestrator.execute(
        createPipeline({
          steps: [
            {
              id: 'step-1',
              name: 'Wait',
              type: 'delay',
              config: { seconds: 0 },
              continueOnError: false,
            },
            { id: 'step-2', name: 'Copy', type: 'sync', config: {}, continueOnError: true },
          ],
        }),
        {},
        'manual',
      );

      expect(run.status).toBe('failed');
      expect(run.stepResults).toHaveLength(1);
      expect(run.stepResults[0]).toMatchObject({ stepId: 'step-2', status: 'failed' });
      expect(run.error).toContain('cannot run in a pipeline yet');
    });
  });

  describe('stopping a run while a Delay waits', () => {
    const twoDelays = (): PipelineDefinition =>
      createPipeline({
        steps: [
          {
            id: 'long',
            name: 'Long wait',
            type: 'delay',
            config: { seconds: 60 },
            continueOnError: false,
          },
          {
            id: 'after',
            name: 'Short wait',
            type: 'delay',
            config: { seconds: 0 },
            continueOnError: false,
          },
        ],
      });

    beforeEach(() => {
      vi.useFakeTimers();
      deps.stepExecutor = new StepExecutor();
      orchestrator = new PipelineOrchestrator(deps);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Start `pipeline` and report, without waiting on it, whether it has settled. */
    function start(
      pipeline: PipelineDefinition,
      signal?: AbortSignal,
    ): { settled: () => boolean; run: ReturnType<PipelineOrchestrator['execute']> } {
      let done = false;
      const run = orchestrator.execute(pipeline, {}, 'manual', signal).then((result) => {
        done = true;
        return result;
      });
      return { settled: () => done, run };
    }

    it('stops the wait and every step after it when the caller aborts', async () => {
      const aborter = new AbortController();
      const { settled, run } = start(twoDelays(), aborter.signal);

      await vi.advanceTimersByTimeAsync(1_000);
      aborter.abort();
      await vi.advanceTimersByTimeAsync(0);

      // Settled with 59 s of the wait still on the clock.
      expect(settled()).toBe(true);
      const finished = await run;
      expect(finished.status).toBe('cancelled');
      expect(finished.stepResults.map((result) => [result.stepId, result.status])).toEqual([
        ['long', 'failed'],
      ]);
    });

    it('stops the wait in progress when the run is cancelled', async () => {
      const { settled, run } = start(twoDelays());

      await vi.advanceTimersByTimeAsync(1_000);
      const [active] = orchestrator.getActiveRuns();
      orchestrator.cancel(active.id);
      await vi.advanceTimersByTimeAsync(0);

      expect(settled()).toBe(true);
      const finished = await run;
      expect(finished.status).toBe('cancelled');
      expect(finished.stepResults).toHaveLength(1);
    });

    it('runs no step when the caller has already given up', async () => {
      const aborter = new AbortController();
      aborter.abort();

      const finished = await orchestrator.execute(twoDelays(), {}, 'manual', aborter.signal);

      expect(finished.status).toBe('cancelled');
      expect(finished.stepResults).toEqual([]);
    });

    it('hands each step the signal that stops it', async () => {
      const execute = vi.spyOn(deps.stepExecutor, 'execute');
      const { run } = start(twoDelays());

      await vi.runAllTimersAsync();
      expect((await run).status).toBe('completed');

      const contexts = execute.mock.calls.map(([, context]) => context as StepContext);
      expect(contexts).toHaveLength(2);
      for (const context of contexts) {
        expect(context.signal).toBeInstanceOf(AbortSignal);
      }
    });
  });

  /** A Delay step of no length: it runs at once and completes. */
  function delayStep(id: string, overrides?: Partial<PipelineStep>): PipelineStep {
    return {
      id,
      name: id.toUpperCase(),
      type: 'delay',
      config: { seconds: 0 },
      continueOnError: false,
      ...overrides,
    };
  }

  /** Each result of `run` as [step id, status]. */
  function statuses(run: PipelineRun): Array<[string, string]> {
    return run.stepResults.map((result) => [result.stepId, result.status]);
  }

  describe('routing', () => {
    beforeEach(() => {
      deps.conditionalRouter = new ConditionalRouter();
      orchestrator = new PipelineOrchestrator(deps);
    });

    /** The ids of the steps the executor was asked to run, in order. */
    function executed(): string[] {
      return vi
        .mocked(deps.stepExecutor.execute)
        .mock.calls.map(([step]) => (step as PipelineStep).id);
    }

    it('runs the step a route jumps to once, and passes over the steps it jumps past', async () => {
      const run = await orchestrator.execute(
        createPipeline({
          steps: [
            delayStep('a', { onSuccess: 'c' }),
            delayStep('b'),
            delayStep('c'),
            delayStep('d'),
          ],
        }),
        {},
        'manual',
      );

      // The target used to run twice: once when routed to, and again in its turn.
      expect(executed()).toEqual(['a', 'c', 'd']);
      expect(statuses(run)).toEqual([
        ['a', 'completed'],
        ['b', 'skipped'],
        ['c', 'completed'],
        ['d', 'completed'],
      ]);
      expect(run.status).toBe('completed');
    });

    it('goes on from the onFailure step of a failed step that carries on, and runs it once', async () => {
      vi.mocked(deps.stepExecutor.execute).mockResolvedValueOnce({
        stepId: 'a',
        stepName: 'A',
        stepType: 'delay',
        status: 'failed',
        error: 'boom',
      });

      const run = await orchestrator.execute(
        createPipeline({
          steps: [
            delayStep('a', { continueOnError: true, onFailure: 'c' }),
            delayStep('b'),
            delayStep('c'),
          ],
        }),
        {},
        'manual',
      );

      expect(executed()).toEqual(['a', 'c']);
      expect(statuses(run)).toEqual([
        ['a', 'failed'],
        ['b', 'skipped'],
        ['c', 'completed'],
      ]);
      expect(run.status).toBe('completed_with_warnings');
    });

    it('refuses, before any step runs, a route that points back', async () => {
      const run = await orchestrator.execute(
        createPipeline({ steps: [delayStep('a'), delayStep('b', { onSuccess: 'a' })] }),
        {},
        'manual',
      );

      expect(executed()).toEqual([]);
      expect(run.status).toBe('failed');
      expect(run.error).toBe(
        'Pipeline did not start: Step "B" routes on success to "A", which does not come after it: a route can only skip ahead.',
      );
    });

    it('refuses a route to the step itself, or to a step the pipeline does not have', async () => {
      const toItself = await orchestrator.execute(
        createPipeline({ steps: [delayStep('a', { onFailure: 'a' })] }),
        {},
        'manual',
      );
      const toNowhere = await orchestrator.execute(
        createPipeline({ steps: [delayStep('a', { onSuccess: 'zz' })] }),
        {},
        'manual',
      );

      expect(toItself.stepResults[0].error).toBe(
        'Step "A" routes on failure to "A", which does not come after it: a route can only skip ahead.',
      );
      expect(toNowhere.stepResults[0].error).toBe(
        'Step "A" routes on success to "zz", which is not a step of this pipeline: a route can only skip ahead.',
      );
      expect(executed()).toEqual([]);
    });
  });

  describe('conditions', () => {
    beforeEach(() => {
      deps.stepExecutor = new StepExecutor();
      deps.conditionalRouter = new ConditionalRouter();
      orchestrator = new PipelineOrchestrator(deps);
    });

    /** A Condition step that holds when `env` is `prod`. */
    function gate(overrides?: Partial<PipelineStep>): PipelineStep {
      return {
        id: 'gate',
        name: 'Gate',
        type: 'condition',
        config: {},
        continueOnError: false,
        condition: { field: 'env', operator: 'eq', value: 'prod' },
        ...overrides,
      };
    }

    it('records a Condition that does not hold as answered, and runs no step after it', async () => {
      // It used to be recorded skipped, as if never asked, and every step
      // after it ran all the same.
      const run = await orchestrator.execute(
        createPipeline({ steps: [gate(), delayStep('then'), delayStep('after')] }),
        { env: 'dev' },
        'manual',
      );

      expect(run.stepResults[0]).toMatchObject({
        stepId: 'gate',
        status: 'completed',
        output: { conditionMet: false },
      });
      expect(statuses(run).slice(1)).toEqual([
        ['then', 'skipped'],
        ['after', 'skipped'],
      ]);
      expect(run.status).toBe('completed');
    });

    it('runs the steps after a Condition that holds', async () => {
      const run = await orchestrator.execute(
        createPipeline({ steps: [gate(), delayStep('then')] }),
        { env: 'prod' },
        'manual',
      );

      expect(run.stepResults[0].output).toEqual({ conditionMet: true });
      expect(statuses(run)).toEqual([
        ['gate', 'completed'],
        ['then', 'completed'],
      ]);
    });

    it('goes on from the onFailure step of a Condition that does not hold', async () => {
      const run = await orchestrator.execute(
        createPipeline({
          steps: [gate({ onFailure: 'else' }), delayStep('then'), delayStep('else')],
        }),
        { env: 'dev' },
        'manual',
      );

      expect(statuses(run)).toEqual([
        ['gate', 'completed'],
        ['then', 'skipped'],
        ['else', 'completed'],
      ]);
    });

    it("reads the pipeline's variables at their defaults, under the values the run was given", async () => {
      // A default was read by nothing: the condition found `env` unset.
      const pipeline = createPipeline({
        steps: [gate()],
        variables: [
          { name: 'env', type: 'string', defaultValue: 'prod', required: false, description: '' },
        ],
      });

      const onDefault = await orchestrator.execute(pipeline, {}, 'manual');
      const overridden = await orchestrator.execute(pipeline, { env: 'dev' }, 'manual');

      expect(onDefault.stepResults[0].output).toEqual({ conditionMet: true });
      expect(overridden.stepResults[0].output).toEqual({ conditionMet: false });
      // What the run was given is what it records.
      expect(onDefault.variables).toEqual({});
    });

    it('runs a step whose condition compares a number with the text of a variable', async () => {
      const run = await orchestrator.execute(
        createPipeline({
          steps: [delayStep('then', { condition: { field: 'count', operator: 'eq', value: 5 } })],
        }),
        { count: '5' },
        'manual',
      );

      expect(statuses(run)).toEqual([['then', 'completed']]);
    });

    it('fails a step whose condition has no answer, instead of passing it over', async () => {
      const run = await orchestrator.execute(
        createPipeline({
          steps: [delayStep('then', { condition: { field: 'count', operator: 'gt', value: 5 } })],
        }),
        {},
        'manual',
      );

      expect(run.stepResults).toEqual([
        {
          stepId: 'then',
          stepName: 'THEN',
          stepType: 'delay',
          status: 'failed',
          error:
            'Step "THEN" did not run: its condition could not be evaluated, as "count" has no value to compare with 5.',
        },
      ]);
      expect(run.status).toBe('failed');
    });

    it('refuses, before any step runs, a condition that cannot be evaluated', async () => {
      const execute = vi.spyOn(deps.stepExecutor, 'execute');

      const run = await orchestrator.execute(
        createPipeline({
          steps: [
            delayStep('first'),
            delayStep('then', {
              condition: { field: 'usage', operator: '>' as never, value: '80' },
            }),
          ],
        }),
        {},
        'manual',
      );

      expect(execute).not.toHaveBeenCalled();
      expect(run.error).toBe(
        'Pipeline did not start: Step "THEN" runs only when its condition holds, and the condition uses an unknown operator: >.',
      );
    });
  });
});
