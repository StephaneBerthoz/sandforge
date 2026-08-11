import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PipelineOrchestrator } from './PipelineOrchestrator';
import type {
  PipelineOrchestratorDependencies,
  PipelineEventHandler,
} from './PipelineOrchestrator';
import type { PipelineDefinition, PipelineStepResult } from '@sandforge/shared';

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
    scheduler: {
      schedule: vi.fn(),
      unschedule: vi.fn(),
      getScheduledPipelines: vi.fn().mockReturnValue([]),
      isScheduled: vi.fn().mockReturnValue(false),
      getSchedule: vi.fn(),
    } as unknown as PipelineOrchestratorDependencies['scheduler'],
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
      getExecutor: vi.fn(),
      registerHandler: vi.fn(),
    } as unknown as PipelineOrchestratorDependencies['stepExecutor'],
    conditionalRouter: {
      evaluate: vi.fn().mockReturnValue(true),
      evaluateGroup: vi.fn().mockReturnValue(true),
      getNextStep: vi.fn().mockReturnValue(undefined),
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

  describe('pause / resume / cancel', () => {
    it('should track paused runs', async () => {
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
        orchestrator.pause(runId);
      });

      const run = await orchestrator.execute(pipeline, {}, 'manual');

      expect(run.status).toBe('paused');
    });

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
});
