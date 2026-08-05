import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AutopilotOrchestrator } from './AutopilotOrchestrator';
import type { AutopilotOrchestratorDeps } from './AutopilotOrchestrator';
import type { SchemaScanResult, ObjectDescribeResult, FieldDescribeResult } from './SchemaScanner';
import type {
  AutopilotConfig,
  AutopilotGraph,
  AutopilotEvent,
  ExecutionPlan,
  ComplianceProfile,
  AnonymizationSummary,
  PIIFieldDetection,
  AutopilotAnonymizationRule,
} from '@sandforge/shared';
import {
  AutopilotExecutor,
  type ExecutionResult,
  type InsertFn,
  type InsertResult,
} from './AutopilotExecutor';
import type { SmartAnonymizer } from './SmartAnonymizer';
import type { RecordIdRemapper } from './RecordIdRemapper';

/** Helper: create a minimal FieldDescribeResult. */
function mockField(name: string, overrides?: Partial<FieldDescribeResult>): FieldDescribeResult {
  return {
    name,
    label: name,
    type: 'string',
    nillable: true,
    createable: true,
    updateable: true,
    unique: false,
    externalId: false,
    referenceTo: [],
    relationshipName: null,
    defaultValue: null,
    ...overrides,
  };
}

/** Helper: create a minimal ObjectDescribeResult. */
function mockDescribe(name: string, fields: FieldDescribeResult[] = []): ObjectDescribeResult {
  return {
    name,
    label: name,
    custom: name.endsWith('__c'),
    keyPrefix: '001',
    fields: fields.length > 0 ? fields : [mockField('Id'), mockField('Name')],
    recordTypeInfos: [],
  };
}

/** Helper: create a minimal SchemaScanResult. */
function mockScanResult(): SchemaScanResult {
  const objectDescribes = new Map<string, ObjectDescribeResult>();
  objectDescribes.set('Account', mockDescribe('Account'));
  objectDescribes.set(
    'Contact',
    mockDescribe('Contact', [
      mockField('Id'),
      mockField('AccountId', {
        type: 'reference',
        referenceTo: ['Account'],
        relationshipName: 'Account',
      }),
    ]),
  );

  const recordCounts = new Map<string, number>();
  recordCounts.set('Account', 100);
  recordCounts.set('Contact', 200);

  return {
    objectDescribes,
    autoDiscoveredObjects: [],
    missingInTarget: [],
    recordCounts,
    totalObjectsScanned: 2,
  };
}

/** Helper: create a minimal AutopilotGraph. */
function mockGraph(): AutopilotGraph {
  return {
    nodes: [],
    edges: [],
    cycles: [],
    stats: {
      totalObjects: 2,
      totalRelationships: 1,
      cycleCount: 0,
      maxDepth: 1,
      totalRecords: 300,
      totalEstimatedApiCalls: 4,
    },
  };
}

/** Helper: create a minimal ExecutionPlan. */
function mockPlan(): ExecutionPlan {
  return {
    waves: [{ order: 0, objects: ['Account'], dependsOn: [] }],
    totalRecords: 100,
    estimatedDurationSec: 10,
    estimatedApiCalls: 2,
    complianceFramework: 'gdpr',
    anonymizationSummary: {
      totalPiiFields: 0,
      totalFieldsToAnonymize: 0,
      methodBreakdown: {} as AnonymizationSummary['methodBreakdown'],
      objectsWithPii: [],
    },
    cycleResolutions: [],
  };
}

/** Helper: create a minimal ComplianceProfile. */
function mockProfile(): ComplianceProfile {
  return {
    framework: 'gdpr',
    rules: [],
    autoDetectedPII: [],
    userOverrides: [],
    auditRequired: true,
  };
}

/** Mock of the per-execution executor produced by the createExecutor factory. */
interface ExecutorMock {
  execute: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  skip: ReturnType<typeof vi.fn>;
}

/** Helper: create mock deps. Each call to createExecutor produces a fresh tracked mock. */
function createMockDeps(): { deps: AutopilotOrchestratorDeps; executors: ExecutorMock[] } {
  const scanResult = mockScanResult();
  const graph = mockGraph();
  const plan = mockPlan();
  const profile = mockProfile();
  const executors: ExecutorMock[] = [];

  const deps: AutopilotOrchestratorDeps = {
    schemaScanner: {
      scan: vi.fn().mockResolvedValue(scanResult),
    } as unknown as AutopilotOrchestratorDeps['schemaScanner'],
    graphBuilder: {
      build: vi.fn().mockReturnValue(graph),
    } as unknown as AutopilotOrchestratorDeps['graphBuilder'],
    complianceEngine: {
      buildProfile: vi.fn().mockReturnValue(profile),
      generateRules: vi.fn().mockReturnValue([]),
      buildSummary: vi.fn().mockReturnValue({
        totalPiiFields: 0,
        totalFieldsToAnonymize: 0,
        methodBreakdown: {},
        objectsWithPii: [],
      }),
      generateReport: vi.fn().mockReturnValue({
        id: 'report-1',
        generatedAt: '2026-01-01T00:00:00.000Z',
        framework: 'gdpr',
        sourceOrgId: 'src',
        targetOrgId: 'tgt',
        totalFieldsScanned: 10,
        totalPiiDetected: 0,
        totalFieldsAnonymized: 0,
        objectSummaries: [],
        entries: [],
        checksum: 'abc123',
      }),
    } as unknown as AutopilotOrchestratorDeps['complianceEngine'],
    anonymizer: {} as unknown as AutopilotOrchestratorDeps['anonymizer'],
    planGenerator: {
      generate: vi.fn().mockReturnValue(plan),
    } as unknown as AutopilotOrchestratorDeps['planGenerator'],
    remapper: {} as unknown as AutopilotOrchestratorDeps['remapper'],
    createExecutor: vi.fn(() => {
      const executor: ExecutorMock = {
        execute: vi.fn().mockResolvedValue({
          totalSuccess: 100,
          totalFailure: 0,
          totalSkipped: 0,
          elapsedMs: 5000,
          completedObjects: ['Account'],
          failedObjects: [],
          skippedObjects: [],
        } satisfies ExecutionResult),
        pause: vi.fn(),
        resume: vi.fn(),
        skip: vi.fn(),
      };
      executors.push(executor);
      return executor;
    }) as unknown as AutopilotOrchestratorDeps['createExecutor'],
    grappeAdapter: {
      shouldUseGrappe: vi.fn().mockReturnValue(false),
      partition: vi.fn().mockReturnValue([]),
      getThreshold: vi.fn().mockReturnValue(5000),
      getPartitionSize: vi.fn().mockReturnValue(2000),
    } as unknown as AutopilotOrchestratorDeps['grappeAdapter'],
  };
  return { deps, executors };
}

/**
 * Helper: deps whose factory builds REAL AutopilotExecutor instances, each
 * with its own query/insert mocks — used to prove per-execution state
 * isolation (pause/skip) rather than mock-level delegation.
 */
function createRealExecutorDeps(): {
  deps: AutopilotOrchestratorDeps;
  created: Array<{
    executor: AutopilotExecutor;
    query: ReturnType<typeof vi.fn>;
    insert: InsertFn;
  }>;
} {
  const { deps } = createMockDeps();
  const created: Array<{
    executor: AutopilotExecutor;
    query: ReturnType<typeof vi.fn>;
    insert: InsertFn;
  }> = [];
  deps.createExecutor = () => {
    const query = vi.fn();
    const insert: InsertFn = vi.fn(
      async (_obj: string, records: Record<string, unknown>[]): Promise<InsertResult> => ({
        successIds: records.map((r) => `t_${String(r.Id)}`),
        sourceIds: records.map((r) => String(r.Id)),
        errors: [],
      }),
    );
    const executor = new AutopilotExecutor({
      query,
      insert,
      anonymizer: { anonymize: vi.fn() } as unknown as SmartAnonymizer,
      remapper: {
        remapRecords: vi.fn(),
        registerMappings: vi.fn(),
      } as unknown as RecordIdRemapper,
      batchSize: 2,
    });
    created.push({ executor, query, insert });
    return executor;
  };
  return { deps, created };
}

/** Creates a manually-resolved promise for in-flight concurrency tests. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Helper: two-wave plan (Account → Contact) for skip-isolation tests. */
function twoWavePlan(): ExecutionPlan {
  return {
    ...mockPlan(),
    waves: [
      { order: 0, objects: ['Account'], dependsOn: [] },
      { order: 1, objects: ['Contact'], dependsOn: [0] },
    ],
  };
}

/** Helper: create a minimal AutopilotConfig. */
function mockConfig(): AutopilotConfig {
  return {
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    selectedObjects: ['Account', 'Contact'],
    complianceFramework: 'gdpr',
    maxRecordsPerObject: 0,
    objectFilters: {},
    includeStandardObjects: false,
    grappeThreshold: 5000,
  };
}

/** Helper: create a mock AutopilotConnection. */
function mockConnection(): {
  describe: ReturnType<typeof vi.fn>;
  describeGlobal: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
} {
  return {
    describe: vi.fn(),
    describeGlobal: vi.fn(),
    query: vi.fn(),
  };
}

describe('AutopilotOrchestrator', () => {
  let deps: AutopilotOrchestratorDeps;
  let executors: ExecutorMock[];
  let orchestrator: AutopilotOrchestrator;

  beforeEach(() => {
    ({ deps, executors } = createMockDeps());
    orchestrator = new AutopilotOrchestrator(deps);
  });

  describe('scanSchemas', () => {
    it('emits scan-started and scan-completed events', async () => {
      const events: AutopilotEvent[] = [];
      orchestrator.onEvent((event) => events.push(event));

      const conn = mockConnection();
      await orchestrator.scanSchemas(
        conn as unknown as Parameters<typeof orchestrator.scanSchemas>[0],
        conn as unknown as Parameters<typeof orchestrator.scanSchemas>[1],
        mockConfig(),
      );

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('scan-started');
      expect(events[1].type).toBe('scan-completed');
    });

    it('delegates to schemaScanner.scan with correct arguments', async () => {
      const conn = mockConnection();
      const config = mockConfig();
      await orchestrator.scanSchemas(
        conn as unknown as Parameters<typeof orchestrator.scanSchemas>[0],
        conn as unknown as Parameters<typeof orchestrator.scanSchemas>[1],
        config,
      );

      expect(deps.schemaScanner.scan).toHaveBeenCalledWith(
        conn,
        conn,
        config.selectedObjects,
        config.includeStandardObjects,
      );
    });
  });

  describe('buildGraph', () => {
    it('converts scan results to GraphObjectDescribe format and delegates to graphBuilder', () => {
      const scanResult = mockScanResult();
      orchestrator.buildGraph(scanResult, 500);

      const buildMock = deps.graphBuilder.build as ReturnType<typeof vi.fn>;
      expect(buildMock).toHaveBeenCalledTimes(1);

      const [describes, recordCounts, batchSize] = buildMock.mock.calls[0] as [
        Map<string, unknown>,
        Map<string, number>,
        number,
      ];
      expect(batchSize).toBe(500);
      expect(describes.size).toBe(2);
      expect(recordCounts.get('Account')).toBe(100);
      expect(recordCounts.get('Contact')).toBe(200);

      // Verify Contact fields were converted correctly
      const contactDescribe = describes.get('Contact') as {
        name: string;
        fields: Array<{ name: string; type: string; referenceTo: string[] }>;
      };
      expect(contactDescribe.name).toBe('Contact');
      const accountIdField = contactDescribe.fields.find(
        (f: { name: string }) => f.name === 'AccountId',
      );
      expect(accountIdField).toBeDefined();
      expect(accountIdField?.type).toBe('reference');
      expect(accountIdField?.referenceTo).toEqual(['Account']);
    });
  });

  describe('buildCompliance', () => {
    it('returns profile and rules from compliance engine', () => {
      const piiDetections: PIIFieldDetection[] = [];
      const result = orchestrator.buildCompliance('gdpr', piiDetections);

      expect(result.profile).toBeDefined();
      expect(result.rules).toBeDefined();
      expect(deps.complianceEngine.buildProfile).toHaveBeenCalledWith('gdpr', piiDetections);
      expect(deps.complianceEngine.generateRules).toHaveBeenCalled();
    });
  });

  describe('generatePlan', () => {
    it('emits plan-generated event', () => {
      const events: AutopilotEvent[] = [];
      orchestrator.onEvent((event) => events.push(event));

      const graph = mockGraph();
      const rules: AutopilotAnonymizationRule[] = [];
      orchestrator.generatePlan(graph, 'gdpr', rules);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('plan-generated');
    });

    it('delegates to planGenerator.generate with summary', () => {
      const graph = mockGraph();
      const rules: AutopilotAnonymizationRule[] = [];
      orchestrator.generatePlan(graph, 'gdpr', rules);

      expect(deps.complianceEngine.buildSummary).toHaveBeenCalledWith(rules);
      expect(deps.planGenerator.generate).toHaveBeenCalled();
    });
  });

  describe('pause/resume/skip', () => {
    it('pause delegates to the running executor', async () => {
      const run = orchestrator.executePlan(mockPlan(), mockGraph(), [], new Map());
      // The executor is created synchronously; execute() is still awaited.
      orchestrator.pause();
      expect(executors[0].pause).toHaveBeenCalledTimes(1);
      await run;
    });

    it('resume delegates to the running executor', async () => {
      const run = orchestrator.executePlan(mockPlan(), mockGraph(), [], new Map());
      orchestrator.resume();
      expect(executors[0].resume).toHaveBeenCalledTimes(1);
      await run;
    });

    it('skip delegates to the running executor with object name', async () => {
      const run = orchestrator.executePlan(mockPlan(), mockGraph(), [], new Map());
      orchestrator.skip('Account');
      expect(executors[0].skip).toHaveBeenCalledWith('Account');
      await run;
    });

    it('pause with no running execution is a no-op and does not leak into the next one', async () => {
      orchestrator.pause();
      await orchestrator.executePlan(mockPlan(), mockGraph(), [], new Map());
      expect(executors[0].pause).not.toHaveBeenCalled();
    });

    it('skip with no running execution is applied to the next execution only', async () => {
      orchestrator.skip('Account');

      await orchestrator.executePlan(mockPlan(), mockGraph(), [], new Map());
      expect(executors[0].skip).toHaveBeenCalledWith('Account');
      // The held skip is applied before the execution starts.
      expect(executors[0].skip.mock.invocationCallOrder[0]).toBeLessThan(
        executors[0].execute.mock.invocationCallOrder[0],
      );

      // Consumed: the following execution starts clean.
      await orchestrator.executePlan(mockPlan(), mockGraph(), [], new Map());
      expect(executors[1].skip).not.toHaveBeenCalled();
    });
  });

  describe('event listeners', () => {
    it('all listeners receive events', () => {
      const events1: AutopilotEvent[] = [];
      const events2: AutopilotEvent[] = [];
      orchestrator.onEvent((event) => events1.push(event));
      orchestrator.onEvent((event) => events2.push(event));

      const graph = mockGraph();
      orchestrator.generatePlan(graph, 'gdpr', []);

      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);
      expect(events1[0].type).toBe('plan-generated');
      expect(events2[0].type).toBe('plan-generated');
    });

    it('unsubscribe removes listener', () => {
      const events: AutopilotEvent[] = [];
      const unsub = orchestrator.onEvent((event) => events.push(event));

      orchestrator.generatePlan(mockGraph(), 'gdpr', []);
      expect(events).toHaveLength(1);

      unsub();
      orchestrator.generatePlan(mockGraph(), 'gdpr', []);
      expect(events).toHaveLength(1); // No new events after unsubscribe
    });

    it('listener errors do not break event emission', () => {
      const events: AutopilotEvent[] = [];
      orchestrator.onEvent(() => {
        throw new Error('listener boom');
      });
      orchestrator.onEvent((event) => events.push(event));

      // Should not throw despite first listener error
      orchestrator.generatePlan(mockGraph(), 'gdpr', []);
      expect(events).toHaveLength(1);
    });
  });
});

describe('AutopilotOrchestrator — execution isolation (real executors)', () => {
  const recordCounts = () =>
    new Map([
      ['Account', 1],
      ['Contact', 1],
    ]);

  it('pausing one execution does not pause a simultaneous one', async () => {
    const { deps, created } = createRealExecutorDeps();
    const orchestrator = new AutopilotOrchestrator(deps);
    // 4 records at batchSize 2 → each executor hits checkPause() a second time,
    // which is where a paused executor would block mid-execution.
    const counts = new Map([['Account', 4]]);

    const gateA = deferred<Record<string, unknown>[]>();
    const runA = orchestrator.executePlan(mockPlan(), mockGraph(), [], counts);
    created[0].query.mockImplementationOnce(() => gateA.promise).mockResolvedValue([]);
    const pausedA: string[] = [];
    created[0].executor.on('paused', () => pausedA.push('paused'));

    const gateB = deferred<Record<string, unknown>[]>();
    const runB = orchestrator.executePlan(mockPlan(), mockGraph(), [], counts);
    created[1].query.mockImplementationOnce(() => gateB.promise).mockResolvedValue([]);
    const pausedB: string[] = [];
    created[1].executor.on('paused', () => pausedB.push('paused'));

    // Targets the most recently started execution (B), never A.
    orchestrator.pause();

    // A completes on its own — with the old shared executor it would have
    // deadlocked here on the shared pause state.
    gateA.resolve([{ Id: 'a1' }, { Id: 'a2' }]);
    const resultA = await runA;
    expect(resultA.totalSuccess).toBe(2);
    expect(pausedA).toHaveLength(0);

    // B runs into its own pause gate after the first batch and stays paused.
    gateB.resolve([{ Id: 'b1' }, { Id: 'b2' }]);
    let bSettled = false;
    void runB.then(() => {
      bSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(pausedB).toHaveLength(1);
    expect(bSettled).toBe(false);

    orchestrator.resume();
    const resultB = await runB;
    expect(bSettled).toBe(true);
    expect(resultB.totalSuccess).toBe(2);
  });

  it('skipping an object targets one execution only, not simultaneous ones', async () => {
    const { deps, created } = createRealExecutorDeps();
    const orchestrator = new AutopilotOrchestrator(deps);
    const plan = twoWavePlan();

    const gateA = deferred<Record<string, unknown>[]>();
    const runA = orchestrator.executePlan(plan, mockGraph(), [], recordCounts());
    created[0].query.mockImplementationOnce(() => gateA.promise).mockResolvedValue([{ Id: 'c1' }]);

    const gateB = deferred<Record<string, unknown>[]>();
    const runB = orchestrator.executePlan(plan, mockGraph(), [], recordCounts());
    created[1].query.mockImplementationOnce(() => gateB.promise).mockResolvedValue([{ Id: 'c2' }]);

    // Both executions are parked in wave 0; the skip lands on B (latest) only.
    orchestrator.skip('Contact');

    gateA.resolve([{ Id: 'a1' }]);
    const resultA = await runA;
    expect(resultA.skippedObjects).toEqual([]);
    expect(resultA.completedObjects).toEqual(['Account', 'Contact']);
    expect(created[0].query.mock.calls.map((c) => c[0])).toContain('Contact');

    gateB.resolve([{ Id: 'b1' }]);
    const resultB = await runB;
    expect(resultB.skippedObjects).toEqual(['Contact']);
    expect(resultB.totalSkipped).toBe(1);
    expect(resultB.completedObjects).toEqual(['Account']);
    // B never queried the skipped object.
    expect(created[1].query.mock.calls.map((c) => c[0])).not.toContain('Contact');
  });

  it('skips from a finished execution do not leak into the next one', async () => {
    const { deps, created } = createRealExecutorDeps();
    const orchestrator = new AutopilotOrchestrator(deps);
    const plan = twoWavePlan();

    const gate1 = deferred<Record<string, unknown>[]>();
    const run1 = orchestrator.executePlan(plan, mockGraph(), [], recordCounts());
    created[0].query.mockImplementationOnce(() => gate1.promise).mockResolvedValue([{ Id: 'c1' }]);
    orchestrator.skip('Contact');
    gate1.resolve([{ Id: 'a1' }]);
    const result1 = await run1;
    expect(result1.skippedObjects).toEqual(['Contact']);

    // Second execution: fresh executor, no leftover skippedObjects.
    const run2 = orchestrator.executePlan(plan, mockGraph(), [], recordCounts());
    created[1].query.mockResolvedValue([{ Id: 'x1' }]);
    const result2 = await run2;
    expect(result2.skippedObjects).toEqual([]);
    expect(result2.completedObjects).toEqual(['Account', 'Contact']);
  });

  it('a skip registered before any execution applies to the next execution only', async () => {
    const { deps, created } = createRealExecutorDeps();
    const orchestrator = new AutopilotOrchestrator(deps);
    const plan = twoWavePlan();

    // Historical "skip before execute" semantics, with nothing running.
    orchestrator.skip('Contact');

    const run1 = orchestrator.executePlan(plan, mockGraph(), [], recordCounts());
    created[0].query.mockResolvedValue([{ Id: 'x1' }]);
    const result1 = await run1;
    expect(result1.skippedObjects).toEqual(['Contact']);
    expect(created[0].query.mock.calls.map((c) => c[0])).not.toContain('Contact');

    // The held skip was consumed: the next execution runs Contact normally.
    const run2 = orchestrator.executePlan(plan, mockGraph(), [], recordCounts());
    created[1].query.mockResolvedValue([{ Id: 'x1' }]);
    const result2 = await run2;
    expect(result2.skippedObjects).toEqual([]);
    expect(result2.completedObjects).toEqual(['Account', 'Contact']);
  });
});
