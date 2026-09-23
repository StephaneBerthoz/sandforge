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
    recordId: '001XXXXXXXXXXXX',
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
    updatedCount: 0,
    linkedCount: 0,
    wouldInsertCount: 0,
    failedCount: 0,
    skippedCount: 0,
    remapCount: 5,
    errors: [],
    truncatedObjects: [],
    remapTable: {},
    existingRecords: [],
    existingSourceIds: [],
    updatedSourceIds: [],
    remapByObject: [],
    createdByObject: [],
    ...overrides,
  };
}

function createMockDeps(): ForgeOrchestratorDeps {
  return {
    discoveryService: {
      discover: vi.fn().mockResolvedValue(createMockGraph()),
      personalFields: vi.fn().mockReturnValue([]),
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

    it('should not serve a cancelled discovery partial graph to the next identical request', async () => {
      // An aborted BFS returns what it had reached. Caching it meant Back,
      // then Discover on the same record, showed the truncated graph as if
      // it were complete.
      const partial = { ...createMockGraph(), nodes: [] };
      const full = createMockGraph();
      vi.mocked(deps.discoveryService.discover)
        .mockResolvedValueOnce(partial)
        .mockResolvedValueOnce(full);
      const controller = new AbortController();
      controller.abort();

      await orchestrator.discover(createMockConfig(), { signal: controller.signal });
      const second = await orchestrator.discover(createMockConfig());

      expect(deps.discoveryService.discover).toHaveBeenCalledTimes(2);
      expect(second).toBe(full);
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
    it('should hand the RecordType translation table to the executor in both input modes', async () => {
      const recordTypeMappings = [
        { sourceId: '012SRC000000001', targetId: '012TGT000000001', developerName: 'Business' },
      ];

      await orchestrator.execute(createMockGraph(), createMockConfig(), { recordTypeMappings });
      await orchestrator.execute(
        createMockGraph(),
        createMockConfig({
          inputMode: 'soql',
          recordId: undefined,
          soqlQuery: 'SELECT Id FROM Account',
        }),
        { recordTypeMappings },
      );

      const optionsPassed = vi.mocked(deps.executor.execute).mock.calls.map((c) => c[4]);
      expect(optionsPassed[0]?.recordTypeMappings).toBe(recordTypeMappings);
      expect(optionsPassed[1]?.recordTypeMappings).toBe(recordTypeMappings);
    });

    it('asks the executor to anonymize the selected fields with the methods sent, in both input modes', async () => {
      const graph = createMockGraph();
      graph.nodes[0] = { ...graph.nodes[0], piiFields: ['Phone'], anonymizeFields: ['Phone'] };
      const anonymized = { anonymizePII: true };

      await orchestrator.execute(graph, createMockConfig(anonymized), {
        anonymizationRules: { phone: 'redact' },
      });
      await orchestrator.execute(
        graph,
        createMockConfig({
          ...anonymized,
          inputMode: 'soql',
          recordId: undefined,
          soqlQuery: 'SELECT Id FROM Account',
        }),
        { anonymizationRules: { phone: 'redact' } },
      );
      await orchestrator.execute(graph, createMockConfig(), {
        anonymizationRules: { phone: 'redact' },
      });

      const optionsPassed = vi.mocked(deps.executor.execute).mock.calls.map((c) => c[4]);
      const expected = {
        fields: { Account: ['Phone'] },
        methods: { phone: 'redact' },
        personalFieldsOf: expect.any(Function),
      };
      expect(optionsPassed[0]?.anonymization).toEqual(expected);
      expect(optionsPassed[1]?.anonymization).toEqual(expected);
      // The toggle off: nothing, whatever the node selects.
      expect(optionsPassed[2]?.anonymization).toBeUndefined();
    });

    it('names the personal fields of an object with no node as discovery would', async () => {
      vi.mocked(deps.discoveryService.personalFields).mockReturnValue(['Phone']);

      await orchestrator.execute(createMockGraph(), createMockConfig({ anonymizePII: true }));

      const anonymization = vi.mocked(deps.executor.execute).mock.calls[0][4]?.anonymization;
      const fields = [{ name: 'Phone', type: 'phone' }];
      expect(anonymization?.personalFieldsOf?.(fields)).toEqual(['Phone']);
      expect(deps.discoveryService.personalFields).toHaveBeenCalledWith(fields);
    });

    it('should carry the source -> target Id map into the result', async () => {
      // The executor has always returned remapTable; the orchestrator kept
      // only its length, so a finished clone could report a record count while
      // being unable to say where any single record landed.
      const remapTable = { '001SRC000000001': '001TGT000000001' };
      vi.mocked(deps.executor.execute).mockResolvedValue(createMockSummary({ remapTable }));

      const orchestrator = new ForgeOrchestrator(deps);
      const result = await orchestrator.execute(createMockGraph(), createMockConfig());

      expect(result.idRemapTable).toEqual(remapTable);
      expect(result.idRemapCount).toBe(5);
    });

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

    it('calls a run partial, not failed, when it linked what it could not create', async () => {
      vi.mocked(deps.executor.execute).mockResolvedValue(
        createMockSummary({ successCount: 0, linkedCount: 4, failedCount: 2 }),
      );

      const result = await orchestrator.execute(createMockGraph(), createMockConfig());
      expect(result.status).toBe('partial');
    });

    it('carries the records the target already held into the result, apart from the created ones', async () => {
      vi.mocked(deps.executor.execute).mockResolvedValue(
        createMockSummary({
          successCount: 6,
          linkedCount: 2,
          remapTable: {
            '001SRC000000001': '001TGT000000001',
            '001SRC000000002': '001TGT000000002',
          },
          existingRecords: [{ objectApiName: 'Account', linked: 2, unidentified: 1 }],
          existingSourceIds: ['001SRC000000002'],
        }),
      );

      const result = await orchestrator.execute(createMockGraph(), createMockConfig());

      expect(result.createdCount).toBe(6);
      expect(result.linkedExistingCount).toBe(2);
      expect(result.existingRecords).toEqual([
        { objectApiName: 'Account', linked: 2, unidentified: 1 },
      ]);
      expect(result.idRemapExisting).toEqual(['001SRC000000002']);
    });

    it('says which rows of the table the run created, per object', async () => {
      // The table also maps the standard price book and reference data matched
      // by name, which the run found and never wrote.
      vi.mocked(deps.executor.execute).mockResolvedValue(
        createMockSummary({
          remapTable: {
            '001SRC000000001': '001TGT000000001',
            '01sSRC000000001': '01sTGT000000001',
          },
          createdByObject: [{ objectApiName: 'Account', sourceIds: ['001SRC000000001'] }],
        }),
      );

      const result = await orchestrator.execute(createMockGraph(), createMockConfig());

      expect(result.idRemapCreated).toEqual([
        { objectApiName: 'Account', sourceIds: ['001SRC000000001'] },
      ]);
    });

    it('should include idRemapCount from executor summary', async () => {
      vi.mocked(deps.executor.execute).mockResolvedValue(createMockSummary({ remapCount: 42 }));

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

      await expect(orchestrator.execute(createMockGraph(), createMockConfig())).rejects.toThrow(
        'Executor crash',
      );

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
