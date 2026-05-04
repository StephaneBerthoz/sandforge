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
import type { ExecutionResult } from './AutopilotExecutor';

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

/** Helper: create mock deps. */
function createMockDeps(): AutopilotOrchestratorDeps {
  const scanResult = mockScanResult();
  const graph = mockGraph();
  const plan = mockPlan();
  const profile = mockProfile();

  return {
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
    executor: {
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
    } as unknown as AutopilotOrchestratorDeps['executor'],
    grappeAdapter: {
      shouldUseGrappe: vi.fn().mockReturnValue(false),
      partition: vi.fn().mockReturnValue([]),
      getThreshold: vi.fn().mockReturnValue(5000),
      getPartitionSize: vi.fn().mockReturnValue(2000),
    } as unknown as AutopilotOrchestratorDeps['grappeAdapter'],
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
  let orchestrator: AutopilotOrchestrator;

  beforeEach(() => {
    deps = createMockDeps();
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
    it('pause delegates to executor', () => {
      orchestrator.pause();
      expect(deps.executor.pause).toHaveBeenCalledTimes(1);
    });

    it('resume delegates to executor', () => {
      orchestrator.resume();
      expect(deps.executor.resume).toHaveBeenCalledTimes(1);
    });

    it('skip delegates to executor with object name', () => {
      orchestrator.skip('Account');
      expect(deps.executor.skip).toHaveBeenCalledWith('Account');
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
