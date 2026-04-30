import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForgeOrchestrator } from './ForgeOrchestrator.js';
import type { ForgeOrchestratorDeps } from './ForgeOrchestrator.js';
import type { ForgeConfig, ForgeGraph, ForgeExecutionResult, ForgePlan } from '@sandforge/shared';
import type { ForgeProgressEvent, ExecutionSummary } from './ForgeExecutor.js';
import type { ForgePlanGenerator } from './ForgePlanGenerator.js';

function createMockGraph(): ForgeGraph {
  return {
    nodes: [
      {
        objectApiName: 'Account',
        recordCount: 10,
        fieldCount: 5,
        status: 'idle',
        progress: 0,
        included: true,
        piiFields: [],
        anonymizeFields: [],
        errors: [],
        level: 0,
        successCount: 0,
        failureCount: 0,
        createableFieldCount: 0,
        estimatedSizeMB: 0,
        estimatedApiCalls: 0,
        batchStrategy: 'auto',
      },
    ],
    edges: [],
    totalRecords: 10,
    estimatedSizeMB: 0.01,
    estimatedDurationSeconds: 0.1,
  };
}

function createMockConfig(overrides?: Partial<ForgeConfig>): ForgeConfig {
  return {
    inputMode: 'record',
    recordId: '001XXXXXXXXXX',
    depth: 'direct',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    anonymizePII: false,
    skipEmpty: false,
    batchSize: 'auto',
    ...overrides,
  };
}

function createMockSummary(overrides?: Partial<ExecutionSummary>): ExecutionSummary {
  return {
    successCount: 10,
    failedCount: 0,
    skippedCount: 0,
    remapCount: 5,
    ...overrides,
  };
}

function createMockDeps(): ForgeOrchestratorDeps {
  return {
    discoveryService: {
      discover: vi.fn().mockResolvedValue(createMockGraph()),
    } as unknown as ForgeOrchestratorDeps['discoveryService'],
    executor: {
      execute: vi.fn().mockResolvedValue(createMockSummary()),
      abort: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    } as unknown as ForgeOrchestratorDeps['executor'],
  };
}

describe('ForgeOrchestrator', () => {
  let deps: ForgeOrchestratorDeps;
  let orchestrator: ForgeOrchestrator;

  beforeEach(() => {
    deps = createMockDeps();
    orchestrator = new ForgeOrchestrator(deps);
  });

  describe('discover', () => {
    it('should delegate to discoveryService.discover', async () => {
      const config = createMockConfig();
      const graph = await orchestrator.discover(config);

      expect(deps.discoveryService.discover).toHaveBeenCalledWith(config, undefined);
      expect(graph.nodes).toHaveLength(1);
      expect(graph.nodes[0].objectApiName).toBe('Account');
    });

    it('should pass options through to discoveryService.discover', async () => {
      const controller = new AbortController();
      const onProgress = vi.fn();
      const config = createMockConfig();

      await orchestrator.discover(config, { signal: controller.signal, onProgress, maxNodes: 25 });

      expect(deps.discoveryService.discover).toHaveBeenCalledWith(config, {
        signal: controller.signal,
        onProgress,
        maxNodes: 25,
      });
    });

    it('should propagate errors from discoveryService', async () => {
      vi.mocked(deps.discoveryService.discover).mockRejectedValue(
        new Error('Cannot resolve root object'),
      );

      const config = createMockConfig();
      await expect(orchestrator.discover(config)).rejects.toThrow('Cannot resolve root object');
    });
  });

  describe('execute', () => {
    it('should call executor with graph, source/target orgs, and progress callback', async () => {
      const graph = createMockGraph();
      const config = createMockConfig();
      await orchestrator.execute(graph, config);

      expect(deps.executor.execute).toHaveBeenCalledWith(
        graph,
        'src-org',
        'tgt-org',
        expect.any(Function),
        // 5th arg: scoped ExecuteOptions when inputMode='record', else undefined
        expect.anything(),
      );
    });

    it('should return success status when no failures', async () => {
      vi.mocked(deps.executor.execute).mockResolvedValue(
        createMockSummary({ successCount: 10, failedCount: 0 }),
      );

      const result = await orchestrator.execute(createMockGraph(), createMockConfig());
      expect(result.status).toBe('success');
    });

    it('should return partial status when some succeed and some fail', async () => {
      vi.mocked(deps.executor.execute).mockResolvedValue(
        createMockSummary({ successCount: 5, failedCount: 5 }),
      );

      const result = await orchestrator.execute(createMockGraph(), createMockConfig());
      expect(result.status).toBe('partial');
    });

    it('should return failure status when all fail', async () => {
      vi.mocked(deps.executor.execute).mockResolvedValue(
        createMockSummary({ successCount: 0, failedCount: 10 }),
      );

      const result = await orchestrator.execute(createMockGraph(), createMockConfig());
      expect(result.status).toBe('failure');
    });

    it('should include idRemapCount from executor summary', async () => {
      vi.mocked(deps.executor.execute).mockResolvedValue(
        createMockSummary({ remapCount: 42 }),
      );

      const result = await orchestrator.execute(createMockGraph(), createMockConfig());
      expect(result.idRemapCount).toBe(42);
    });

    it('should include duration and timestamp in result', async () => {
      const result = await orchestrator.execute(createMockGraph(), createMockConfig());
      expect(result.duration).toBeGreaterThanOrEqual(0);
      expect(result.timestamp).toBeTruthy();
    });

    it('should include forgeId in result', async () => {
      const result = await orchestrator.execute(createMockGraph(), createMockConfig());
      expect(result.forgeId).toMatch(/^forge-\d+$/);
    });

    it('should include graph in result', async () => {
      const graph = createMockGraph();
      const result = await orchestrator.execute(graph, createMockConfig());
      expect(result.graph).toBe(graph);
    });
  });

  describe('events', () => {
    it('should emit forge:progress when executor reports progress', async () => {
      const progressEvents: ForgeProgressEvent[] = [];
      orchestrator.on('forge:progress', (event) => progressEvents.push(event));

      // Make the executor call the onProgress callback
      vi.mocked(deps.executor.execute).mockImplementation(
        async (_graph, _src, _tgt, onProgress) => {
          onProgress({
            objectName: 'Account',
            status: 'running',
            progress: 50,
            message: 'Inserting records...',
          });
          return createMockSummary();
        },
      );

      await orchestrator.execute(createMockGraph(), createMockConfig());

      expect(progressEvents).toHaveLength(1);
      expect(progressEvents[0].objectName).toBe('Account');
      expect(progressEvents[0].status).toBe('running');
    });

    it('should emit forge:complete when execution finishes', async () => {
      const completeEvents: ForgeExecutionResult[] = [];
      orchestrator.on('forge:complete', (event) => completeEvents.push(event));

      await orchestrator.execute(createMockGraph(), createMockConfig());

      expect(completeEvents).toHaveLength(1);
      expect(completeEvents[0].status).toBe('success');
    });

    it('should emit forge:error when executor throws', async () => {
      const errorEvents: Array<{ message: string }> = [];
      orchestrator.on('forge:error', (event) => errorEvents.push(event));

      vi.mocked(deps.executor.execute).mockRejectedValue(new Error('Executor crash'));

      await expect(
        orchestrator.execute(createMockGraph(), createMockConfig()),
      ).rejects.toThrow('Executor crash');

      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].message).toBe('Executor crash');
    });

    it('should support unsubscribing from events', async () => {
      const results: ForgeExecutionResult[] = [];
      const unsub = orchestrator.on('forge:complete', (event) => results.push(event));

      await orchestrator.execute(createMockGraph(), createMockConfig());
      expect(results).toHaveLength(1);

      unsub();
      await orchestrator.execute(createMockGraph(), createMockConfig());
      expect(results).toHaveLength(1); // No new events
    });
  });

  describe('abort', () => {
    it('should delegate to executor.abort', () => {
      orchestrator.abort();
      expect(deps.executor.abort).toHaveBeenCalledOnce();
    });
  });

  describe('pause', () => {
    it('should delegate to executor.pause', () => {
      orchestrator.pause();
      expect(deps.executor.pause).toHaveBeenCalledOnce();
    });
  });

  describe('resume', () => {
    it('should delegate to executor.resume', () => {
      orchestrator.resume();
      expect(deps.executor.resume).toHaveBeenCalledOnce();
    });
  });

  describe('generatePlan', () => {
    it('should generate a plan from graph when planGenerator is configured', async () => {
      const mockPlan: ForgePlan = {
        waves: [
          {
            order: 0,
            objectApiNames: ['Account'],
            totalRecords: 10,
            estimatedDurationSeconds: 0.5,
            estimatedApiCalls: 1,
          },
        ],
        totalRecords: 10,
        totalApiCalls: 1,
        estimatedDurationSeconds: 0.5,
        cycleResolutions: [],
      };

      const mockPlanGenerator = {
        generate: vi.fn().mockReturnValue(mockPlan),
      } as unknown as ForgePlanGenerator;

      const depsWithPlan: ForgeOrchestratorDeps = {
        ...createMockDeps(),
        planGenerator: mockPlanGenerator,
      };
      const orchestratorWithPlan = new ForgeOrchestrator(depsWithPlan);

      const graph = createMockGraph();
      const plan = await orchestratorWithPlan.generatePlan(graph);

      expect(mockPlanGenerator.generate).toHaveBeenCalledWith(graph);
      expect(plan.waves).toHaveLength(1);
      expect(plan.waves[0].objectApiNames).toContain('Account');
      expect(plan.totalRecords).toBe(10);
    });

    it('should throw when planGenerator is not configured', async () => {
      const graph = createMockGraph();
      await expect(orchestrator.generatePlan(graph)).rejects.toThrow(
        'Plan generator not configured',
      );
    });
  });
});
