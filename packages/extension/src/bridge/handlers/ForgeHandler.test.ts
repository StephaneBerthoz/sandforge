import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ForgeHandler } from './ForgeHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import type {
  BaseMessage,
  ForgeConfig,
  ForgeGraph,
  ForgeExecutionResult,
  ForgeTemplate,
  ForgePlan,
} from '@sandforge/shared';
import { ForgeOrchestrator } from '../../modules/forge/ForgeOrchestrator.js';
import type { ForgeOrchestratorDeps } from '../../modules/forge/ForgeOrchestrator.js';
import { ForgeAbortedError, ForgeExecutor } from '../../modules/forge/ForgeExecutor.js';
import type { ForgeExecutorDeps } from '../../modules/forge/ForgeExecutor.js';
import type { ForgePlanGenerator } from '../../modules/forge/ForgePlanGenerator.js';
import type { ForgeComplianceService } from '../../modules/forge/ForgeComplianceService.js';
import type { ForgeMetadataDiff } from '../../modules/forge/ForgeMetadataDiff.js';
import type { DiscoveryOptions } from '../../modules/forge/GraphDiscoveryService.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { keepPartialSummary } from '../../modules/forge/interruptedRun.js';
import { LineageStore } from '../../modules/audit/lineage.js';
import { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import type { LiveOperation } from '../../modules/monitor/LiveOperationTracker.js';

vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));
vi.mock('../../core/common/soqlQueryHelper.js', () => ({
  queryWithFieldsFallback: vi.fn(),
}));
vi.mock('../../core/common/sforceLimitParser.js', () => ({
  checkApiLimits: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { queryWithFieldsFallback } from '../../core/common/soqlQueryHelper.js';
import { inboundRequest } from '../../test/mockFactories.js';

const mockGetConn = vi.mocked(getJsforceConnection);
const mockQueryFallback = vi.mocked(queryWithFieldsFallback);

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
    // 15-char strict Salesforce ID — forgeConfigSchema enforces the regex
    recordId: '001000000000123',
    depth: 'direct',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    anonymizePII: false,
    skipEmpty: false,
    batchSize: 'auto',
    ...overrides,
  };
}

function createMockResult(overrides?: Partial<ForgeExecutionResult>): ForgeExecutionResult {
  return {
    forgeId: 'forge-123',
    status: 'success',
    graph: createMockGraph(),
    duration: 1000,
    timestamp: '2026-03-07T00:00:00.000Z',
    idRemapCount: 5,
    ...overrides,
  };
}

function createMockTemplate(overrides?: Partial<ForgeTemplate>): ForgeTemplate {
  return {
    id: 'tpl-1',
    name: 'Test Template',
    description: 'A test template',
    config: {
      inputMode: 'record',
      depth: 'direct',
      anonymizePII: false,
      skipEmpty: false,
      batchSize: 'auto',
    },
    objectCount: 3,
    recordCount: 100,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: '2026-03-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Captured progress listener from orchestrator.on('forge:progress', ...). */
type ProgressListener = (event: unknown) => void;

function createMockOrchestrator(): ForgeOrchestrator {
  return {
    discover: vi.fn().mockResolvedValue(createMockGraph()),
    execute: vi.fn().mockResolvedValue(createMockResult()),
    on: vi.fn().mockReturnValue(vi.fn()),
    abort: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    clearDiscoveryCache: vi.fn(),
    // A discovered graph knows its fields: nothing to read, handed back as is.
    readPersonalFields: vi.fn(async (graph: ForgeGraph) => graph),
  } as unknown as ForgeOrchestrator;
}

/** Build a BaseMessage with optional payload. */
function buildMsg(type: string, payload?: unknown): InboundRequest {
  return inboundRequest({
    id: `test-${type}-${Date.now()}`,
    type,
    timestamp: Date.now(),
    ...(payload !== undefined ? { payload } : {}),
  } as BaseMessage);
}

/** Creates standard mock deps following the HandlerDeps pattern. */
function createMockDeps(): HandlerDeps {
  let idCounter = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: { getOrg: vi.fn() } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore: {
      get: vi.fn().mockReturnValue(undefined),
      set: vi.fn(),
    } as unknown as HandlerDeps['configStore'],
    secretVault: {} as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
    // A run refuses to write without a Production Guard, and the extension
    // always injects one.
    infraServices: {
      productionGuard: new ProductionGuard(),
    } as unknown as HandlerDeps['infraServices'],
    nextId: () => String(++idCounter),
  };
}

describe('ForgeHandler', () => {
  let handler: ForgeHandler;
  let deps: HandlerDeps;
  let orchestrator: ForgeOrchestrator;

  /**
   * The results of the `operation:completed` posted for the one operation
   * started. A request that failed with its error alone left the recent
   * operations showing it running for the rest of the session.
   */
  function endOfTheOperation(): unknown[] {
    const posted = vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(
        ([m]) => m as BaseMessage & { payload: { operationId: string; result?: unknown } },
      );
    const started = posted.filter((m) => m.type === 'operation:started');
    expect(started).toHaveLength(1);
    return posted
      .filter(
        (m) =>
          m.type === 'operation:completed' &&
          m.payload.operationId === started[0].payload.operationId,
      )
      .map((m) => m.payload.result);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createMockDeps();
    handler = new ForgeHandler(deps);
    orchestrator = createMockOrchestrator();
    handler.setForgeOrchestrator(orchestrator);
  });

  describe('message routing', () => {
    it('returns false for unhandled message types', async () => {
      const msg = buildMsg('unknown:type');
      const result = await handler.handle(msg);
      expect(result).toBe(false);
    });

    it('returns false for non-forge message types', async () => {
      const msg = buildMsg('autopilot:execute');
      const result = await handler.handle(msg);
      expect(result).toBe(false);
    });
  });

  describe('forge:discover', () => {
    it('calls orchestrator.discover and posts response with correlationId', async () => {
      const config = createMockConfig();
      const graph = createMockGraph();
      vi.mocked(orchestrator.discover).mockResolvedValue(graph);

      const msg = buildMsg('forge:discover', { config });
      const handled = await handler.handle(msg);

      expect(handled).toBe(true);
      expect(orchestrator.discover).toHaveBeenCalledWith(
        config,
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          onProgress: expect.any(Function),
        }),
      );

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const responseCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:discover:response',
      );
      expect(responseCalls).toHaveLength(1);
      const response = responseCalls[0][0] as BaseMessage & {
        correlationId?: string;
        payload: { graph: ForgeGraph };
      };
      expect(response.correlationId).toBe(msg.id);
      expect(response.payload.graph).toEqual(graph);
    });

    it('posts error message when discover fails', async () => {
      const config = createMockConfig();
      vi.mocked(orchestrator.discover).mockRejectedValue(new Error('Discovery failed'));

      const msg = buildMsg('forge:discover', { config });
      const handled = await handler.handle(msg);

      expect(handled).toBe(true);
      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const errCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:discover:error',
      );
      expect(errCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('sends error when orchestrator not initialized', async () => {
      const freshHandler = new ForgeHandler(deps);
      const msg = buildMsg('forge:discover', { config: createMockConfig() });
      const handled = await freshHandler.handle(msg);

      expect(handled).toBe(true);
      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const errCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:discover:error',
      );
      expect(errCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('posts discovery progress events to webview with correlationId', async () => {
      const config = createMockConfig();
      vi.mocked(orchestrator.discover).mockImplementation(
        async (_config: ForgeConfig, options?: DiscoveryOptions) => {
          options?.onProgress?.({
            phase: 'object',
            objectApiName: 'Account',
            discoveredCount: 1,
            queueRemaining: 3,
          });
          return createMockGraph();
        },
      );

      const msg = buildMsg('forge:discover', { config });
      await handler.handle(msg);

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const progressCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:discover:progress',
      );
      expect(progressCalls).toHaveLength(1);
      const progressResponse = progressCalls[0][0] as BaseMessage & {
        correlationId?: string;
      };
      expect(progressResponse.correlationId).toBe(msg.id);
    });

    it('aborts a discovery still running when a new one starts', async () => {
      const signals: AbortSignal[] = [];
      const resolvers: Array<(graph: ForgeGraph) => void> = [];
      vi.mocked(orchestrator.discover).mockImplementation(
        (_config: ForgeConfig, options?: DiscoveryOptions) =>
          new Promise<ForgeGraph>((resolve) => {
            if (options?.signal) signals.push(options.signal);
            resolvers.push(resolve);
          }),
      );

      const first = handler.handle(buildMsg('forge:discover', { config: createMockConfig() }));
      const second = handler.handle(buildMsg('forge:discover', { config: createMockConfig() }));
      await vi.waitFor(() => expect(signals).toHaveLength(2));

      expect(signals[0].aborted).toBe(true);
      expect(signals[1].aborted).toBe(false);

      // The superseded BFS settles while its replacement is still running. It
      // must not clear the live one's controller, or forge:abort could no
      // longer reach the discovery on screen.
      resolvers[0](createMockGraph());
      await first;
      await handler.handle(buildMsg('forge:abort'));
      expect(signals[1].aborted).toBe(true);

      resolvers[1](createMockGraph());
      await second;
    });

    it('posts nothing for a discovery that was cancelled or superseded', async () => {
      const resolvers: Array<(graph: ForgeGraph) => void> = [];
      vi.mocked(orchestrator.discover).mockImplementation(
        () =>
          new Promise<ForgeGraph>((resolve) => {
            resolvers.push(resolve);
          }),
      );

      const firstMsg = buildMsg('forge:discover', { config: createMockConfig() });
      const first = handler.handle(firstMsg);
      await vi.waitFor(() => expect(resolvers).toHaveLength(1));
      await handler.handle(buildMsg('forge:abort'));
      // The aborted BFS hands back the partial graph it had reached.
      resolvers[0]({ ...createMockGraph(), nodes: [] });
      await first;

      const answers = vi
        .mocked(deps.broker.postToWebview)
        .mock.calls.map((call) => call[0] as BaseMessage & { correlationId?: string })
        .filter(
          (m) =>
            m.correlationId === firstMsg.id &&
            (m.type === 'forge:discover:response' || m.type === 'forge:discover:error'),
        );
      expect(answers).toEqual([]);
    });

    it.each([
      ['cancelled', 'forge:abort'],
      ['superseded', 'forge:discover'],
    ])('posts no error for a discovery that fails after it was %s', async (_label, next) => {
      const rejecters: Array<(error: Error) => void> = [];
      const resolvers: Array<(graph: ForgeGraph) => void> = [];
      vi.mocked(orchestrator.discover).mockImplementation(
        () =>
          new Promise<ForgeGraph>((resolve, reject) => {
            resolvers.push(resolve);
            rejecters.push(reject);
          }),
      );

      const firstMsg = buildMsg('forge:discover', { config: createMockConfig() });
      const first = handler.handle(firstMsg);
      await vi.waitFor(() => expect(rejecters).toHaveLength(1));
      const second = handler.handle(
        next === 'forge:abort'
          ? buildMsg('forge:abort')
          : // Its own id: two messages built in the same millisecond share one.
            inboundRequest({
              id: 'live-discover',
              type: 'forge:discover',
              timestamp: Date.now(),
              payload: { config: createMockConfig() },
            } as BaseMessage),
      );
      if (next === 'forge:discover') {
        await vi.waitFor(() => expect(rejecters).toHaveLength(2));
      }
      // A cancelled walk can still throw: a describe cut short, a timeout.
      rejecters[0](new Error('describeGlobal failed'));
      await first;
      resolvers[1]?.(createMockGraph());
      await second;

      const answers = vi
        .mocked(deps.broker.postToWebview)
        .mock.calls.map((call) => call[0] as BaseMessage & { correlationId?: string })
        .filter(
          (m) =>
            m.correlationId === firstMsg.id &&
            (m.type === 'forge:discover:response' || m.type === 'forge:discover:error'),
        );
      expect(answers).toEqual([]);
    });
  });

  describe('forge:execute record type translation', () => {
    /** Connection double answering the active RecordType query of one org. */
    function recordTypeConn(rows: Array<Record<string, unknown>>) {
      return {
        query: vi.fn().mockResolvedValue({ records: rows, done: true, totalSize: rows.length }),
        queryMore: vi.fn(),
      };
    }

    it('builds the table from both orgs by object and DeveloperName and hands it to the run', async () => {
      const source = recordTypeConn([
        {
          Id: '012SRCACC000001',
          Name: 'Business',
          DeveloperName: 'Business',
          SobjectType: 'Account',
        },
        {
          Id: '012SRCOPP000001',
          Name: 'Business',
          DeveloperName: 'Business',
          SobjectType: 'Opportunity',
        },
        { Id: '012SRCCAS000001', Name: 'Legacy', DeveloperName: 'Legacy', SobjectType: 'Case' },
      ]);
      const target = recordTypeConn([
        {
          Id: '012TGTOPP000001',
          Name: 'Business',
          DeveloperName: 'Business',
          SobjectType: 'Opportunity',
        },
        {
          Id: '012TGTACC000001',
          Name: 'Business',
          DeveloperName: 'Business',
          SobjectType: 'Account',
        },
      ]);
      mockGetConn.mockImplementation(async (orgId: string) =>
        orgId === 'src-org' ? (source as never) : (target as never),
      );

      await handler.handle(
        buildMsg('forge:execute', { graph: createMockGraph(), config: createMockConfig() }),
      );

      expect(source.query.mock.calls[0][0]).toContain('FROM RecordType WHERE IsActive = true');
      expect(target.query.mock.calls[0][0]).toContain('FROM RecordType WHERE IsActive = true');
      expect(vi.mocked(orchestrator.execute).mock.calls[0][2]).toEqual({
        recordTypeMappings: [
          { sourceId: '012SRCACC000001', targetId: '012TGTACC000001', developerName: 'Business' },
          { sourceId: '012SRCOPP000001', targetId: '012TGTOPP000001', developerName: 'Business' },
        ],
      });
    });

    it('still runs, untranslated, when the record types cannot be read', async () => {
      mockGetConn.mockRejectedValue(new Error('INVALID_SESSION_ID'));

      await handler.handle(
        buildMsg('forge:execute', { graph: createMockGraph(), config: createMockConfig() }),
      );

      expect(vi.mocked(orchestrator.execute).mock.calls[0][2]).toEqual({
        recordTypeMappings: undefined,
      });
      const responses = vi
        .mocked(deps.broker.postToWebview)
        .mock.calls.filter((call) => (call[0] as BaseMessage).type === 'forge:execute:response');
      expect(responses).toHaveLength(1);
    });

    it('runs untranslated when the record type lookup never answers', async () => {
      vi.useFakeTimers();
      try {
        mockGetConn.mockImplementation(() => new Promise(() => {}));

        const executePromise = handler.handle(
          buildMsg('forge:execute', { graph: createMockGraph(), config: createMockConfig() }),
        );
        await vi.advanceTimersByTimeAsync(30_000);
        await executePromise;

        expect(vi.mocked(orchestrator.execute).mock.calls[0][2]).toEqual({
          recordTypeMappings: undefined,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('refuses a RecordType row of the wrong shape instead of mapping it', async () => {
      const conn = recordTypeConn([{ Id: 42, DeveloperName: null }]);
      mockGetConn.mockResolvedValue(conn as never);

      await handler.handle(
        buildMsg('forge:execute', { graph: createMockGraph(), config: createMockConfig() }),
      );

      expect(vi.mocked(orchestrator.execute).mock.calls[0][2]).toEqual({
        recordTypeMappings: undefined,
      });
    });
  });

  describe('forge:execute before-write checks, through a real run', () => {
    /** Fake ids: the root Account, its record type in each org, and the record the target holds. */
    const ROOT_ID = '001000000000123';
    const SOURCE_RT = '012Fk00000RtGhIIAV';
    const TARGET_RT = '012Fk00000RtDeFIAV';
    const EXISTING_15 = '001Fk00000AbCdE';

    // The connection double answers with a real table; the suites after this
    // one run with no connection at all.
    afterEach(() => {
      mockGetConn.mockReset();
    });

    /** Both orgs answer the record type query with a Partner type on Account. */
    function recordTypeConnections(): void {
      mockGetConn.mockImplementation(async (orgId: string) => {
        const id = orgId === 'src-org' ? SOURCE_RT : TARGET_RT;
        const rows = [
          { Id: id, Name: 'Partner', DeveloperName: 'Partner', SobjectType: 'Account' },
        ];
        return {
          query: vi.fn().mockResolvedValue({ records: rows, done: true, totalSize: 1 }),
          queryMore: vi.fn(),
        } as never;
      });
    }

    /** An executor over fakes, with the target's record types and inserts supplied per test. */
    function realRun(
      available: boolean,
      insertRecords: ForgeExecutorDeps['insertRecords'],
    ): ForgeExecutorDeps {
      const executorDeps: ForgeExecutorDeps = {
        queryRecords: vi.fn(async () => [{ Id: ROOT_ID, Name: 'Acme', RecordTypeId: SOURCE_RT }]),
        insertRecords: vi.fn(insertRecords),
        describeFields: vi.fn(async () => [
          { name: 'Id', queryable: true, createable: false, isReference: false },
          { name: 'Name', queryable: true, createable: true, isReference: false },
          {
            name: 'RecordTypeId',
            queryable: true,
            createable: true,
            isReference: true,
            referenceTo: ['RecordType'],
          },
        ]),
        describeObject: vi.fn(async () => ({
          keyPrefix: '001',
          recordTypes: [
            {
              recordTypeId: TARGET_RT,
              developerName: 'Partner',
              name: 'Partner',
              available,
              active: true,
              master: false,
              defaultRecordTypeMapping: false,
            },
          ],
        })),
      };
      const real = new ForgeOrchestrator({
        discoveryService: {} as ForgeOrchestratorDeps['discoveryService'],
        executor: new ForgeExecutor(executorDeps),
      });
      handler.setForgeOrchestrator(real);
      return executorDeps;
    }

    /** The result the handler posted back. */
    function postedResult(): ForgeExecutionResult | undefined {
      const response = vi
        .mocked(deps.broker.postToWebview)
        .mock.calls.map(
          (call) => call[0] as BaseMessage & { payload?: { result?: ForgeExecutionResult } },
        )
        .find((m) => m.type === 'forge:execute:response');
      return response?.payload?.result;
    }

    it('answers with the object held back and why when its record type is closed to the running user', async () => {
      recordTypeConnections();
      const executorDeps = realRun(false, async (_o, _n, records) =>
        records.map(() => ({ id: '001Fk00000NeWaSIAV', success: true, errors: [] })),
      );

      await handler.handle(
        buildMsg('forge:execute', { graph: createMockGraph(), config: createMockConfig() }),
      );

      expect(executorDeps.insertRecords).not.toHaveBeenCalled();
      const result = postedResult();
      expect(result?.status).toBe('failure');
      expect(result?.errors).toEqual([
        {
          objectApiName: 'Account',
          stage: 'scope',
          failedCount: 1,
          attemptedCount: 0,
          samples: [
            {
              recordSummary: 'RecordType=Partner (1 record)',
              messages: [
                'RECORD_TYPE_UNAVAILABLE: 1 Account record uses record type Partner, which the ' +
                  'running user cannot use in the target org. Give the running user access to ' +
                  'record type Partner on Account, or map it to one they have.',
              ],
            },
          ],
        },
      ]);
    });

    it('answers with the record linked, not failed, when the target already holds it', async () => {
      recordTypeConnections();
      realRun(true, async (_o, _n, records) =>
        records.map(() => ({
          id: '',
          success: false,
          errors: [
            `DUPLICATE_VALUE: duplicate value found: Name duplicates value on record with id: ${EXISTING_15}`,
          ],
        })),
      );

      await handler.handle(
        buildMsg('forge:execute', { graph: createMockGraph(), config: createMockConfig() }),
      );

      const result = postedResult();
      expect(result?.status).toBe('success');
      expect(result?.linkedExistingCount).toBe(1);
      expect(result?.existingRecords).toEqual([
        { objectApiName: 'Account', linked: 1, unidentified: 0 },
      ]);
      expect(result?.idRemapTable).toEqual({ [ROOT_ID]: '001Fk00000AbCdEIAV' });
      expect(result?.idRemapExisting).toEqual([ROOT_ID]);
    });
  });

  describe('forge:execute of an object left out of the graph, through a real run', () => {
    /** Fake ids: the project cloned, its two tasks, and the team each task is staffed by. */
    const PROJECT = 'a01000000000001';
    const TASKS = ['a02000000000001', 'a02000000000002'];
    const TEAM = 'a03000000000001';

    const field = (name: string, referenceTo?: string) => ({
      name,
      queryable: true,
      createable: name !== 'Id',
      isReference: referenceTo !== undefined,
      ...(referenceTo !== undefined ? { referenceTo: [referenceTo], nillable: false } : {}),
    });
    const FIELDS: Record<string, ReturnType<typeof field>[]> = {
      Project__c: [field('Id'), field('Name')],
      // A task cannot be written without its project, nor without its team.
      Task__c: [
        field('Id'),
        field('Name'),
        field('Project__c', 'Project__c'),
        field('Squad__c', 'Team__c'),
      ],
      Team__c: [field('Id'), field('Name')],
    };
    const ROWS: Record<string, Array<Record<string, unknown>>> = {
      Project__c: [{ Id: PROJECT, Name: 'Launch' }],
      Task__c: TASKS.map((Id, i) => ({
        Id,
        Name: `Task ${String(i + 1)}`,
        Project__c: PROJECT,
        Squad__c: TEAM,
      })),
      Team__c: [{ Id: TEAM, Name: 'Crew' }],
    };

    /** A graph of the project, its tasks, and their team, the team as `team` leaves it. */
    function projectGraph(team: Partial<ForgeGraph['nodes'][number]>): ForgeGraph {
      const [root] = createMockGraph().nodes;
      return {
        ...createMockGraph(),
        nodes: [
          { ...root, objectApiName: 'Project__c', recordCount: 1 },
          { ...root, objectApiName: 'Task__c', recordCount: 2, level: 1 },
          { ...root, objectApiName: 'Team__c', recordCount: 1, level: 2, ...team },
        ],
        edges: [
          {
            sourceObject: 'Project__c',
            targetObject: 'Task__c',
            relationshipName: 'Tasks__r',
            type: 'master-detail',
            required: true,
          },
          {
            sourceObject: 'Team__c',
            targetObject: 'Task__c',
            relationshipName: 'Squad__r',
            type: 'lookup',
            required: true,
          },
        ],
      };
    }

    /** A real run over a source holding the rows above; what the target was sent, per object. */
    function realRun(): Record<string, Array<Record<string, unknown>>> {
      const inserted: Record<string, Array<Record<string, unknown>>> = {};
      let created = 0;
      const executorDeps: ForgeExecutorDeps = {
        describeFields: async (_org, object) => FIELDS[object] ?? [field('Id')],
        queryRecords: async (org, soql) => {
          const object = /\bFROM (\w+)/.exec(soql)?.[1] ?? '';
          // Copies: a run takes out of what it read the rows it holds back.
          return org === 'src-org' ? (ROWS[object] ?? []).map((row) => ({ ...row })) : [];
        },
        insertRecords: async (_org, object, rows) => {
          (inserted[object] ??= []).push(...rows);
          return rows.map(() => ({
            id: `${object.slice(0, 3)}TGT${String(++created).padStart(9, '0')}`,
            success: true,
            errors: [],
          }));
        },
      };
      handler.setForgeOrchestrator(
        new ForgeOrchestrator({
          discoveryService: {} as ForgeOrchestratorDeps['discoveryService'],
          executor: new ForgeExecutor(executorDeps),
        }),
      );
      return inserted;
    }

    /** The result the handler posted back. */
    function postedResult(): ForgeExecutionResult | undefined {
      const response = vi
        .mocked(deps.broker.postToWebview)
        .mock.calls.map(
          (call) => call[0] as BaseMessage & { payload?: { result?: ForgeExecutionResult } },
        )
        .find((m) => m.type === 'forge:execute:response');
      return response?.payload?.result;
    }

    it('holds back what cannot be written without an object unchecked on the page, and says so', async () => {
      // Unchecked on the page, the team was skipped as a node discovery left
      // out: the tasks were sent without it, and the target refused each.
      const inserted = realRun();

      await handler.handle(
        buildMsg('forge:execute', {
          graph: projectGraph({ included: false, leftOutByUser: true }),
          config: createMockConfig({ recordId: PROJECT }),
        }),
      );

      expect(inserted['Project__c']).toHaveLength(1);
      expect(inserted['Task__c']).toBeUndefined();
      expect(inserted['Team__c']).toBeUndefined();
      expect(postedResult()?.errors).toContainEqual({
        objectApiName: 'Task__c',
        stage: 'scope',
        failedCount: 2,
        attemptedCount: 0,
        samples: [
          {
            recordSummary: 'Squad__c → Team__c (2 records)',
            messages: [
              'Not written: Squad__c may not be left empty, and Team__c is excluded from this run.',
            ],
          },
        ],
      });
    });

    it('still sends the rows under an object discovery could not read, which nobody left out', async () => {
      const inserted = realRun();

      await handler.handle(
        buildMsg('forge:execute', {
          graph: projectGraph({
            included: false,
            recordCount: 0,
            status: 'error',
            errors: ['Describe unavailable: INSUFFICIENT_ACCESS'],
          }),
          config: createMockConfig({ recordId: PROJECT }),
        }),
      );

      expect(inserted['Task__c']).toHaveLength(2);
      const said = JSON.stringify(postedResult()?.errors ?? []);
      expect(said).not.toContain('excluded from this run');
    });
  });

  describe('forge:execute', () => {
    it('calls orchestrator.execute and posts result with correlationId', async () => {
      const graph = createMockGraph();
      const config = createMockConfig();
      const result = createMockResult();
      const unsubscribe = vi.fn();

      vi.mocked(orchestrator.execute).mockResolvedValue(result);
      vi.mocked(orchestrator.on).mockReturnValue(unsubscribe);

      const msg = buildMsg('forge:execute', { graph, config });
      const handled = await handler.handle(msg);

      expect(handled).toBe(true);
      expect(orchestrator.on).toHaveBeenCalledWith('forge:progress', expect.any(Function));
      // No connection in this suite, so no record type table could be built.
      expect(orchestrator.execute).toHaveBeenCalledWith(graph, config, {
        recordTypeMappings: undefined,
      });
      expect(unsubscribe).toHaveBeenCalled();

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const responseCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:execute:response',
      );
      expect(responseCalls).toHaveLength(1);
      const response = responseCalls[0][0] as BaseMessage & {
        correlationId?: string;
        payload: { result: ForgeExecutionResult };
      };
      expect(response.correlationId).toBe(msg.id);
      expect(response.payload.result).toEqual(result);
    });

    it('hands the method Review holds for each PII category to the run', async () => {
      const graph = createMockGraph();
      const config = { ...createMockConfig(), anonymizePII: true };

      await handler.handle(
        buildMsg('forge:execute', {
          graph,
          config,
          anonymizationRules: { email: 'hash', phone: 'redact' },
        }),
      );

      expect(vi.mocked(orchestrator.execute).mock.calls[0][2]).toEqual({
        recordTypeMappings: undefined,
        anonymizationRules: { email: 'hash', phone: 'redact' },
      });
    });

    it('refuses an anonymization method it does not know, before anything runs', async () => {
      await handler.handle(
        buildMsg('forge:execute', {
          graph: createMockGraph(),
          config: { ...createMockConfig(), anonymizePII: true },
          anonymizationRules: { email: 'encrypt' },
        }),
      );

      expect(orchestrator.execute).not.toHaveBeenCalled();
      const errors = vi
        .mocked(deps.broker.postToWebview)
        .mock.calls.filter((call) => (call[0] as BaseMessage).type === 'forge:execute:error');
      expect(errors).toHaveLength(1);
    });

    describe('copying the files of the cloned records', () => {
      /** The errors the page was answered with, code and message. */
      function executeErrors(): Array<{ code?: string; message: string }> {
        return vi
          .mocked(deps.broker.postToWebview)
          .mock.calls.map(
            ([m]) => m as BaseMessage & { payload: { code?: string; message: string } },
          )
          .filter((m) => m.type === 'forge:execute:error')
          .map((m) => ({ code: m.payload.code, message: m.payload.message }));
      }

      it('hands the size Review set and the acceptance to the run', async () => {
        const files = { maxFileSizeMB: 5, acceptedAsIs: false };

        await handler.handle(
          buildMsg('forge:execute', {
            graph: createMockGraph(),
            config: createMockConfig(),
            files,
          }),
        );

        expect(vi.mocked(orchestrator.execute).mock.calls[0][2]).toMatchObject({ files });
      });

      it('refuses a run that anonymizes before the files were accepted as they are, and records the stop', async () => {
        const store = new ConfigStore(new InMemoryConfigStoreBackend());
        store.initialize();
        deps.configStore = store;
        const guard = deps.infraServices?.productionGuard as ProductionGuard;
        const check = vi.spyOn(guard, 'check');

        await handler.handle(
          buildMsg('forge:execute', {
            graph: createMockGraph(),
            config: { ...createMockConfig(), anonymizePII: true },
            files: { maxFileSizeMB: 10, acceptedAsIs: false },
          }),
        );

        expect(orchestrator.execute).not.toHaveBeenCalled();
        expect(check).not.toHaveBeenCalled();
        expect(executeErrors()).toEqual([
          { code: 'FILES_NOT_ACCEPTED', message: expect.stringContaining('copied as they are') },
        ]);
        expect(new AuditTrailStore(store).list().entries).toEqual([
          expect.objectContaining({
            action: 'forge_execute',
            outcome: 'stopped',
            details: { code: 'FILES_NOT_ACCEPTED' },
          }),
        ]);
      });

      it('lets a run that anonymizes copy the files once they were accepted as they are', async () => {
        await handler.handle(
          buildMsg('forge:execute', {
            graph: createMockGraph(),
            config: { ...createMockConfig(), anonymizePII: true },
            files: { maxFileSizeMB: 10, acceptedAsIs: true },
          }),
        );

        expect(orchestrator.execute).toHaveBeenCalledTimes(1);
        expect(executeErrors()).toEqual([]);
      });

      it('refuses a file size one call to Salesforce would not carry, before anything runs', async () => {
        await handler.handle(
          buildMsg('forge:execute', {
            graph: createMockGraph(),
            config: createMockConfig(),
            files: { maxFileSizeMB: 50, acceptedAsIs: false },
          }),
        );

        expect(orchestrator.execute).not.toHaveBeenCalled();
        expect(executeErrors()).toHaveLength(1);
      });
    });

    it('forwards progress events with correlationId', async () => {
      const graph = createMockGraph();
      const config = createMockConfig();
      let capturedListener: ProgressListener | undefined;

      vi.mocked(orchestrator.on).mockImplementation((_type, listener) => {
        capturedListener = listener;
        return vi.fn();
      });
      vi.mocked(orchestrator.execute).mockImplementation(async () => {
        if (capturedListener) {
          capturedListener({
            objectName: 'Account',
            status: 'running',
            progress: 50,
            message: 'Inserting...',
          });
        }
        return createMockResult();
      });

      const msg = buildMsg('forge:execute', { graph, config });
      await handler.handle(msg);

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const progressCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:progress',
      );
      expect(progressCalls).toHaveLength(1);
      const progressMsg = progressCalls[0][0] as BaseMessage & {
        correlationId?: string;
      };
      expect(progressMsg.correlationId).toBe(msg.id);
    });

    it('posts error message when execute fails', async () => {
      const graph = createMockGraph();
      const config = createMockConfig();
      vi.mocked(orchestrator.execute).mockRejectedValue(new Error('Execution failed'));

      const msg = buildMsg('forge:execute', { graph, config });
      const handled = await handler.handle(msg);

      expect(handled).toBe(true);
      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const errCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:execute:error',
      );
      expect(errCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('unsubscribes progress listener even when execute fails', async () => {
      const graph = createMockGraph();
      const config = createMockConfig();
      const unsubscribe = vi.fn();

      vi.mocked(orchestrator.on).mockReturnValue(unsubscribe);
      vi.mocked(orchestrator.execute).mockRejectedValue(new Error('Boom'));

      const msg = buildMsg('forge:execute', { graph, config });
      await handler.handle(msg);

      expect(unsubscribe).toHaveBeenCalled();
    });

    it('includes operationId in forge:execute:response payload', async () => {
      const graph = createMockGraph();
      const config = createMockConfig();
      const result = createMockResult();
      vi.mocked(orchestrator.execute).mockResolvedValue(result);

      const msg = buildMsg('forge:execute', { graph, config });
      await handler.handle(msg);

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const responseCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:execute:response',
      );
      expect(responseCalls).toHaveLength(1);
      const response = responseCalls[0][0] as BaseMessage & {
        payload: { result: ForgeExecutionResult; operationId: string };
      };
      expect(response.payload.operationId).toBeDefined();
      expect(response.payload.operationId).toMatch(/^forge-execute-/);
    });

    it('includes code and retryable in error payloads when execute fails', async () => {
      const graph = createMockGraph();
      const config = createMockConfig();
      vi.mocked(orchestrator.execute).mockRejectedValue(new Error('Execution failed'));

      const msg = buildMsg('forge:execute', { graph, config });
      await handler.handle(msg);

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const errCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:execute:error',
      );
      expect(errCalls).toHaveLength(1);
      const errPayload = (
        errCalls[0][0] as BaseMessage & {
          payload: { message: string; code: string; retryable: boolean };
        }
      ).payload;
      expect(errPayload.code).toBe('EXECUTE_ERROR');
      expect(errPayload.retryable).toBe(true);
    });

    it('persists result to history via ConfigStore (capped at 20)', async () => {
      const graph = createMockGraph();

      for (let i = 0; i < 25; i++) {
        const config = createMockConfig({
          recordId: `001XXXXXXXXX${String(i).padStart(3, '0')}`,
        });
        const result = createMockResult({ forgeId: `forge-${i}` });
        vi.mocked(orchestrator.execute).mockResolvedValue(result);

        // Each execution reads then writes history
        const currentHistory = Array.from({ length: Math.min(i, 20) }, (_, idx) =>
          createMockResult({ forgeId: `forge-${i - 1 - idx}` }),
        );
        vi.mocked(deps.configStore.get).mockReturnValue(currentHistory);

        const msg = buildMsg('forge:execute', { graph, config });
        await handler.handle(msg);
      }

      // Verify configStore.set was called with history category
      expect(deps.configStore.set).toHaveBeenCalledWith(
        'forge:history',
        expect.any(Array),
        'forge',
      );
    });
  });

  describe('background registry', () => {
    let registry: BackgroundOperationRegistry;
    /** Lifecycle events the registry emitted, in order, per operation. */
    let events: Array<[string, string]>;

    beforeEach(() => {
      registry = new BackgroundOperationRegistry();
      events = [];
      registry.onEvent((operationId, type) => events.push([operationId, type]));
      // The registry reaches a handler through the shared infra bundle, the
      // way composition supplies it, beside the guard every run passes.
      deps.infraServices = {
        backgroundRegistry: registry,
        productionGuard: new ProductionGuard(),
      } as unknown as NonNullable<HandlerDeps['infraServices']>;
    });

    it('stops a run in flight when the registry is disposed', async () => {
      const graph = createMockGraph();
      const config = createMockConfig();
      let release: (r: ForgeExecutionResult) => void = () => {};
      vi.mocked(orchestrator.execute).mockReturnValue(
        new Promise<ForgeExecutionResult>((resolve) => {
          release = resolve;
        }),
      );

      const run = handler.handle(buildMsg('forge:execute', { graph, config }));
      await vi.waitFor(() => expect(orchestrator.execute).toHaveBeenCalledTimes(1));
      expect(registry.getRunning()).toHaveLength(1);

      registry.dispose();

      expect(orchestrator.abort).toHaveBeenCalledTimes(1);
      release(createMockResult());
      await run;
    });

    it('records a run the user stopped as aborted, not as completed', async () => {
      const graph = createMockGraph();
      const config = createMockConfig();
      let release: (r: ForgeExecutionResult) => void = () => {};
      vi.mocked(orchestrator.execute).mockReturnValue(
        new Promise<ForgeExecutionResult>((resolve) => {
          release = resolve;
        }),
      );

      const run = handler.handle(buildMsg('forge:execute', { graph, config }));
      await vi.waitFor(() => expect(orchestrator.execute).toHaveBeenCalledTimes(1));
      const [operationId] = registry.getRunning().map((o) => o.operationId);
      expect(operationId).toBeDefined();

      await handler.handle(buildMsg('forge:abort', {}));

      // The stop is what the registry recorded, and it recorded it once.
      expect(events.filter(([id]) => id === operationId)).toEqual([
        [operationId, 'started'],
        [operationId, 'aborted'],
      ]);

      // The orchestrator settles afterwards, as it does in a real run: that
      // must not turn the stopped run into a completed one.
      release(createMockResult());
      await run;
      expect(events.filter(([id]) => id === operationId)).toEqual([
        [operationId, 'started'],
        [operationId, 'aborted'],
      ]);
    });

    it('lists a run, then stops listing it once it has settled', async () => {
      await handler.handle(
        buildMsg('forge:execute', { graph: createMockGraph(), config: createMockConfig() }),
      );

      expect(events.map(([, type]) => type)).toEqual(['started', 'completed']);
      expect(registry.getRunning()).toHaveLength(0);
      registry.dispose();
      expect(orchestrator.abort).not.toHaveBeenCalled();
    });

    it('lists a run that threw as failed, not as completed', async () => {
      vi.mocked(orchestrator.execute).mockRejectedValue(new Error('target refused every insert'));

      await handler.handle(
        buildMsg('forge:execute', { graph: createMockGraph(), config: createMockConfig() }),
      );

      expect(events.map(([, type]) => type)).toEqual(['started', 'failed']);
      expect(registry.get(events[0][0])?.resultSummary).toBe('target refused every insert');
    });

    it('lists a run the executor could not finish as failed', async () => {
      // The executor reports that outcome by resolving, not by throwing.
      vi.mocked(orchestrator.execute).mockResolvedValue(
        createMockResult({ status: 'failure', idRemapCount: 0 }),
      );

      await handler.handle(
        buildMsg('forge:execute', { graph: createMockGraph(), config: createMockConfig() }),
      );

      expect(events.map(([, type]) => type)).toEqual(['started', 'failed']);
    });

    it('lists a discovery that threw as failed', async () => {
      vi.mocked(orchestrator.discover).mockRejectedValue(new Error('source org unreachable'));

      await handler.handle(buildMsg('forge:discover', { config: createMockConfig() }));

      expect(events.map(([, type]) => type)).toEqual(['started', 'failed']);
    });

    it('cancelling a discovery leaves the Forge run beside it alone', async () => {
      // One orchestrator serves every Forge run, so a per-run cancel must not
      // reach it: aborting it here would stop the execute running next to it.
      vi.mocked(orchestrator.discover).mockReturnValue(new Promise<ForgeGraph>(() => {}));
      void handler.handle(buildMsg('forge:discover', { config: createMockConfig() }));
      await vi.waitFor(() => expect(registry.getRunning()).toHaveLength(1));
      const discovery = registry.getRunning()[0];

      registry.abort(discovery.operationId);

      // The walk stops on the signal it was handed; the shared executor is
      // left alone.
      const options = vi.mocked(orchestrator.discover).mock.calls[0][1] as DiscoveryOptions;
      expect(options.signal?.aborted).toBe(true);
      expect(orchestrator.abort).not.toHaveBeenCalled();
    });

    it('records a discovery a newer one replaced as aborted, not as completed', async () => {
      // Stopped by its controller alone, the replaced walk settled with no
      // error, and the registry listed it completed: Live Operations said it
      // had finished, and "forge completed" popped up with no panel open.
      const resolvers: Array<(graph: ForgeGraph) => void> = [];
      vi.mocked(orchestrator.discover).mockImplementation(
        () =>
          new Promise<ForgeGraph>((resolve) => {
            resolvers.push(resolve);
          }),
      );

      const first = handler.handle(buildMsg('forge:discover', { config: createMockConfig() }));
      await vi.waitFor(() => expect(registry.getRunning()).toHaveLength(1));
      const [replaced] = registry.getRunning().map((o) => o.operationId);
      const second = handler.handle(
        // Its own id: two messages built in the same millisecond share one.
        inboundRequest({
          id: 'newer-discover',
          type: 'forge:discover',
          timestamp: Date.now(),
          payload: { config: createMockConfig() },
        } as BaseMessage),
      );
      await vi.waitFor(() => expect(resolvers).toHaveLength(2));

      // The replaced walk hands back the partial graph it had reached.
      resolvers[0]({ ...createMockGraph(), nodes: [] });
      await first;

      expect(events.filter(([id]) => id === replaced)).toEqual([
        [replaced, 'started'],
        [replaced, 'aborted'],
      ]);
      // The newer discovery is the one still running.
      expect(registry.getRunning().map((o) => o.operationId)).not.toContain(replaced);
      expect(registry.getRunning()).toHaveLength(1);

      resolvers[1](createMockGraph());
      await second;
    });

    describe('the end of a run, as the recent operations read it', () => {
      /**
       * A failed or stopped run posted its screen's error and no end: the
       * recent operations and the side panel showed it running for the rest
       * of the session.
       */
      function ends(): Array<{ type: string; payload: Record<string, unknown> }> {
        return vi
          .mocked(deps.broker.postToWebview)
          .mock.calls.map(([m]) => m as BaseMessage & { payload: Record<string, unknown> })
          .filter((m) => m.type === 'operation:completed' || m.type === 'operation:failed');
      }

      it('ends a discovery that failed as failed', async () => {
        vi.mocked(orchestrator.discover).mockRejectedValue(new Error('source org unreachable'));

        await handler.handle(buildMsg('forge:discover', { config: createMockConfig() }));

        expect(ends()).toEqual([
          expect.objectContaining({
            type: 'operation:failed',
            payload: expect.objectContaining({ error: 'source org unreachable' }),
          }),
        ]);
      });

      it('ends a clone that failed as failed, and still shows its error', async () => {
        vi.mocked(orchestrator.execute).mockRejectedValue(new Error('target refused every insert'));

        await handler.handle(
          buildMsg('forge:execute', { graph: createMockGraph(), config: createMockConfig() }),
        );

        expect(ends()).toEqual([
          expect.objectContaining({
            type: 'operation:failed',
            payload: expect.objectContaining({ error: 'target refused every insert' }),
          }),
        ]);
        const shown = vi
          .mocked(deps.broker.postToWebview)
          .mock.calls.filter(([m]) => (m as BaseMessage).type === 'forge:execute:error');
        expect(shown).toHaveLength(1);
      });

      it('ends a clone the user stopped as aborted, in the lifecycle and the registry', async () => {
        let stop: (err: Error) => void = () => {};
        vi.mocked(orchestrator.execute).mockReturnValue(
          new Promise<ForgeExecutionResult>((_resolve, reject) => {
            stop = reject;
          }),
        );
        const run = handler.handle(
          buildMsg('forge:execute', { graph: createMockGraph(), config: createMockConfig() }),
        );
        await vi.waitFor(() => expect(orchestrator.execute).toHaveBeenCalledTimes(1));
        const [operationId] = registry.getRunning().map((o) => o.operationId);

        await handler.handle(buildMsg('forge:abort', {}));
        // The executor stops between two batches with its own error.
        stop(new ForgeAbortedError('Forge execution was aborted by user request.'));
        await run;

        expect(ends()).toEqual([
          expect.objectContaining({
            type: 'operation:completed',
            payload: { operationId, result: { aborted: true } },
          }),
        ]);
        expect(registry.get(operationId)?.status).toBe('aborted');
      });

      it('ends a clone stopped before it started as aborted', async () => {
        let releaseLookup: () => void = () => {};
        mockGetConn.mockImplementation(
          () =>
            new Promise((resolve) => {
              releaseLookup = () => resolve({} as never);
            }),
        );
        try {
          const run = handler.handle(
            buildMsg('forge:execute', { graph: createMockGraph(), config: createMockConfig() }),
          );
          await vi.waitFor(() => expect(registry.getRunning()).toHaveLength(1));

          await handler.handle(buildMsg('forge:abort', {}));
          releaseLookup();
          await run;
        } finally {
          // The lookup that hangs is this case's alone.
          mockGetConn.mockReset();
        }

        expect(orchestrator.execute).not.toHaveBeenCalled();
        expect(ends()).toEqual([
          expect.objectContaining({
            type: 'operation:completed',
            payload: expect.objectContaining({ result: { aborted: true } }),
          }),
        ]);
      });

      it('still ends a clone as failed when it fails while the stop is pending', async () => {
        let fail: (err: Error) => void = () => {};
        vi.mocked(orchestrator.execute).mockReturnValue(
          new Promise<ForgeExecutionResult>((_resolve, reject) => {
            fail = reject;
          }),
        );
        const run = handler.handle(
          buildMsg('forge:execute', { graph: createMockGraph(), config: createMockConfig() }),
        );
        await vi.waitFor(() => expect(orchestrator.execute).toHaveBeenCalledTimes(1));

        await handler.handle(buildMsg('forge:abort', {}));
        fail(new Error('INVALID_SESSION_ID: Session expired or invalid'));
        await run;

        expect(ends()).toEqual([
          expect.objectContaining({
            type: 'operation:failed',
            payload: expect.objectContaining({
              error: 'INVALID_SESSION_ID: Session expired or invalid',
            }),
          }),
        ]);
      });
    });
  });

  describe('forge:execute in Live Operations', () => {
    let tracker: LiveOperationTracker;
    let registry: BackgroundOperationRegistry;

    beforeEach(() => {
      tracker = new LiveOperationTracker();
      handler.setLiveOperationTracker(tracker);
      registry = new BackgroundOperationRegistry();
      deps.infraServices = {
        backgroundRegistry: registry,
        productionGuard: new ProductionGuard(),
      } as unknown as NonNullable<HandlerDeps['infraServices']>;
    });

    afterEach(() => {
      tracker.dispose();
      registry.dispose();
    });

    function execute(graph: ForgeGraph = createMockGraph()): Promise<boolean> {
      return handler.handle(buildMsg('forge:execute', { graph, config: createMockConfig() }));
    }

    it('lists a clone while it runs, under the id its Cancel reaches it by', async () => {
      let listed: LiveOperation[] = [];
      let running: string[] = [];
      vi.mocked(orchestrator.execute).mockImplementation(async () => {
        listed = tracker.getAll().map((op) => ({ ...op }));
        running = registry.getRunning().map((op) => op.operationId);
        return createMockResult();
      });

      await execute();

      expect(listed).toEqual([expect.objectContaining({ module: 'forge', status: 'running' })]);
      // Cancel sends the listed id to the registry, which stops the run by it.
      expect(running).toEqual([listed[0].operationId]);
      expect(tracker.get(listed[0].operationId)?.status).toBe('completed');
    });

    it('moves object by object, with the records of the objects the run is through', async () => {
      let listener: ProgressListener | undefined;
      vi.mocked(orchestrator.on).mockImplementation((_type, l) => {
        listener = l as ProgressListener;
        return vi.fn();
      });
      const account = createMockGraph().nodes[0];
      const graph = {
        ...createMockGraph(),
        nodes: [account, { ...account, objectApiName: 'Contact', level: 1 }],
      };
      let midway: LiveOperation | undefined;
      vi.mocked(orchestrator.execute).mockImplementation(async () => {
        listener?.({
          objectName: 'Account',
          status: 'running',
          progress: 0,
          recordCount: 10,
          message: 'Inserting 10 Account records in 1 batch(es)...',
        });
        listener?.({
          objectName: 'Account',
          status: 'done',
          progress: 100,
          message: 'Completed Account: 10 succeeded, 0 failed',
        });
        midway = { ...tracker.getAll()[0] };
        return createMockResult();
      });

      await execute(graph);

      expect(midway).toMatchObject({
        status: 'running',
        percentage: 50,
        processedRecords: 10,
        currentStep: 'Completed Account: 10 succeeded, 0 failed',
      });
    });

    it('ends a clone that threw as failed, with its error', async () => {
      vi.mocked(orchestrator.execute).mockRejectedValue(new Error('target refused every insert'));

      await execute();

      expect(tracker.getAll()).toEqual([
        expect.objectContaining({ status: 'failed', error: 'target refused every insert' }),
      ]);
    });

    it('ends a clone the executor could not finish as failed', async () => {
      vi.mocked(orchestrator.execute).mockResolvedValue(
        createMockResult({ status: 'failure', idRemapCount: 0 }),
      );

      await execute();

      expect(tracker.getAll()).toEqual([expect.objectContaining({ status: 'failed' })]);
    });

    it('ends a clone a cancel stopped as cancelled', async () => {
      vi.mocked(orchestrator.execute).mockRejectedValue(
        new ForgeAbortedError('Forge execution was aborted by user request.'),
      );

      await execute();

      expect(tracker.getAll()).toEqual([expect.objectContaining({ status: 'cancelled' })]);
    });
  });

  describe('forge:execute duplicate guard', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Count of forge:execute:error payloads carrying the DUPLICATE code. */
    function duplicateErrors(): number {
      return vi.mocked(deps.broker.postToWebview).mock.calls.filter((call) => {
        const m = call[0] as BaseMessage & { payload?: { code?: string } };
        return m.type === 'forge:execute:error' && m.payload?.code === 'DUPLICATE';
      }).length;
    }

    it('refuses an identical payload while the first run is still in flight', async () => {
      const graph = createMockGraph();
      const config = createMockConfig();
      let release: (r: ForgeExecutionResult) => void = () => {};
      vi.mocked(orchestrator.execute).mockReturnValue(
        new Promise<ForgeExecutionResult>((resolve) => {
          release = resolve;
        }),
      );

      const first = handler.handle(buildMsg('forge:execute', { graph, config }));
      await handler.handle(buildMsg('forge:execute', { graph, config }));

      expect(duplicateErrors()).toBe(1);
      // The first run reads both orgs' record types before it starts.
      await vi.waitFor(() => expect(orchestrator.execute).toHaveBeenCalledTimes(1));

      release(createMockResult());
      await first;
    });

    it('lets the user re-run immediately after a failed run', async () => {
      const graph = createMockGraph();
      const config = createMockConfig();

      vi.mocked(orchestrator.execute).mockRejectedValueOnce(new Error('Bulk job failed'));
      await handler.handle(buildMsg('forge:execute', { graph, config }));

      vi.mocked(orchestrator.execute).mockResolvedValueOnce(createMockResult());
      await handler.handle(buildMsg('forge:execute', { graph, config }));

      // The retry actually ran: a failed clone must not lock the recipe out.
      expect(orchestrator.execute).toHaveBeenCalledTimes(2);
      expect(duplicateErrors()).toBe(0);
    });

    it('lets the user re-run a run that completed without writing anything', async () => {
      const graph = createMockGraph();
      const config = createMockConfig();

      vi.mocked(orchestrator.execute).mockResolvedValueOnce(
        createMockResult({ status: 'failure', idRemapCount: 0 }),
      );
      await handler.handle(buildMsg('forge:execute', { graph, config }));

      vi.mocked(orchestrator.execute).mockResolvedValueOnce(createMockResult());
      await handler.handle(buildMsg('forge:execute', { graph, config }));

      expect(orchestrator.execute).toHaveBeenCalledTimes(2);
      expect(duplicateErrors()).toBe(0);
    });

    it('lets the user re-run a run that only linked records the target already held', async () => {
      const graph = createMockGraph();
      const config = createMockConfig();

      vi.mocked(orchestrator.execute).mockResolvedValueOnce(
        createMockResult({ status: 'success', idRemapCount: 3, linkedExistingCount: 3 }),
      );
      await handler.handle(buildMsg('forge:execute', { graph, config }));

      vi.mocked(orchestrator.execute).mockResolvedValueOnce(createMockResult());
      await handler.handle(buildMsg('forge:execute', { graph, config }));

      expect(orchestrator.execute).toHaveBeenCalledTimes(2);
      expect(duplicateErrors()).toBe(0);
    });

    it('lets the user re-run a run whose remap table holds only what it matched', async () => {
      const graph = createMockGraph();
      const config = createMockConfig();

      // The standard price book and a parent found in place are in the remap
      // table, not in what the run created.
      vi.mocked(orchestrator.execute).mockResolvedValueOnce(
        createMockResult({
          status: 'success',
          idRemapCount: 2,
          linkedExistingCount: 0,
          createdCount: 0,
        }),
      );
      await handler.handle(buildMsg('forge:execute', { graph, config }));

      vi.mocked(orchestrator.execute).mockResolvedValueOnce(createMockResult());
      await handler.handle(buildMsg('forge:execute', { graph, config }));

      expect(orchestrator.execute).toHaveBeenCalledTimes(2);
      expect(duplicateErrors()).toBe(0);
    });

    it('holds an identical re-run for the cooldown after a run that wrote, then releases it', async () => {
      vi.useFakeTimers();
      const graph = createMockGraph();
      const config = createMockConfig();
      vi.mocked(orchestrator.execute).mockResolvedValue(createMockResult({ idRemapCount: 5 }));

      await handler.handle(buildMsg('forge:execute', { graph, config }));

      // Straight after a writing run: an accidental second submit is refused.
      await handler.handle(buildMsg('forge:execute', { graph, config }));
      expect(duplicateErrors()).toBe(1);
      expect(orchestrator.execute).toHaveBeenCalledTimes(1);

      // Past the cooldown (60s) the same recipe is runnable again — it used to
      // stay blocked for the tracker's full 1h TTL.
      vi.advanceTimersByTime(61_000);
      await handler.handle(buildMsg('forge:execute', { graph, config }));
      expect(orchestrator.execute).toHaveBeenCalledTimes(2);
      expect(duplicateErrors()).toBe(1);
    });
  });

  describe('production guard', () => {
    /** Wires a mock ProductionGuard into deps.infraServices and returns its spies. */
    function wireGuard(behavior: {
      allowed: boolean;
      requiresConfirmation?: boolean;
      blockedReason?: string;
      confirmed?: boolean;
    }): {
      check: ReturnType<typeof vi.fn>;
      confirmIfNeeded: ReturnType<typeof vi.fn>;
    } {
      const check = vi.fn().mockReturnValue({
        allowed: behavior.allowed,
        requiresConfirmation: behavior.requiresConfirmation ?? false,
        requiresApproval: false,
        blockedReason: behavior.blockedReason,
        warnings: [],
        impactSummary: 'INSERT 10 Account record(s) on production org tgt-org [module: forge]',
      });
      const confirmIfNeeded = vi.fn().mockResolvedValue(behavior.confirmed ?? true);
      deps.infraServices = {
        performanceTracker: { start: vi.fn(), complete: vi.fn() },
        productionGuard: { check, confirmIfNeeded },
        offlineManager: undefined,
        piiDetector: undefined,
      } as unknown as NonNullable<HandlerDeps['infraServices']>;
      return { check, confirmIfNeeded };
    }

    function mockTargetOrgType(orgType: string): void {
      vi.mocked(deps.orgManager.getOrg).mockReturnValue({
        orgType,
      } as unknown as ReturnType<HandlerDeps['orgManager']['getOrg']>);
    }

    it('refuses with NOT_INITIALIZED, and runs nothing, when no Production Guard was injected', async () => {
      // A host that never wired the guard used to skip it and run the clone.
      deps.infraServices = undefined;
      mockTargetOrgType('Production');

      const msg = buildMsg('forge:execute', {
        graph: createMockGraph(),
        config: createMockConfig(),
      });
      await handler.handle(msg);

      expect(orchestrator.execute).not.toHaveBeenCalled();
      const errors = vi
        .mocked(deps.broker.postToWebview)
        .mock.calls.map(([m]) => m as BaseMessage & { payload: { code?: string } })
        .filter((m) => m.type === 'forge:execute:error');
      expect(errors).toHaveLength(1);
      expect(errors[0].correlationId).toBe(msg.id);
      expect(errors[0].payload.code).toBe('NOT_INITIALIZED');
      // Recorded as the guard's own refusals are, with the code that says why.
      const trail = vi
        .mocked(deps.configStore.set)
        .mock.calls.filter(([key]) => key === 'audit:trail');
      expect(trail.at(-1)?.[1]).toEqual([
        expect.objectContaining({
          action: 'forge_execute',
          outcome: 'stopped',
          details: { code: 'NOT_INITIALIZED' },
        }),
      ]);
    });

    it('asks for production confirmation before executing on a production target', async () => {
      const guard = wireGuard({
        allowed: true,
        requiresConfirmation: true,
        confirmed: true,
      });
      mockTargetOrgType('Production');

      const msg = buildMsg('forge:execute', {
        graph: createMockGraph(),
        config: createMockConfig(),
      });
      await handler.handle(msg);

      // The tier is resolved from the target org of the forge config.
      expect(guard.check).toHaveBeenCalledTimes(1);
      expect(guard.check.mock.calls[0][0]).toMatchObject({
        orgId: 'tgt-org',
        orgTier: 'production',
        operation: 'insert',
        module: 'forge',
      });
      expect(guard.confirmIfNeeded).toHaveBeenCalledTimes(1);
      expect(guard.check).toHaveBeenCalledTimes(1);
      expect(orchestrator.execute).toHaveBeenCalledTimes(1);
      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const responses = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:execute:response',
      );
      expect(responses).toHaveLength(1);
    });

    it('blocks the execution when the guard refuses — no write, forge:execute:error', async () => {
      const guard = wireGuard({
        allowed: false,
        blockedReason: 'insert is not allowed on production org tgt-org',
      });
      mockTargetOrgType('Production');

      const msg = buildMsg('forge:execute', {
        graph: createMockGraph(),
        config: createMockConfig(),
      });
      await handler.handle(msg);

      expect(guard.check).toHaveBeenCalledTimes(1);
      expect(guard.confirmIfNeeded).not.toHaveBeenCalled();
      expect(orchestrator.execute).not.toHaveBeenCalled();
      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const errCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:execute:error',
      );
      expect(errCalls).toHaveLength(1);
      const errPayload = (
        errCalls[0][0] as BaseMessage & {
          payload: { message: string; code: string; retryable: boolean };
        }
      ).payload;
      expect(errPayload.message).toContain('insert is not allowed on production org tgt-org');
      expect(errPayload.code).toBe('GUARD_BLOCKED');
    });

    it('cancels the execution when the user declines the production confirmation', async () => {
      const guard = wireGuard({
        allowed: true,
        requiresConfirmation: true,
        confirmed: false,
      });
      mockTargetOrgType('Production');

      const msg = buildMsg('forge:execute', {
        graph: createMockGraph(),
        config: createMockConfig(),
      });
      await handler.handle(msg);

      expect(guard.confirmIfNeeded).toHaveBeenCalledTimes(1);
      expect(orchestrator.execute).not.toHaveBeenCalled();
      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const errCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:execute:error',
      );
      expect(errCalls).toHaveLength(1);
      const errPayload = (
        errCalls[0][0] as BaseMessage & {
          payload: { message: string; code: string; retryable: boolean };
        }
      ).payload;
      expect(errPayload.message).toContain('production confirmation declined');
      expect(errPayload.code).toBe('GUARD_DECLINED');
    });

    it('asks before executing on an org the registry does not know, and runs nothing when declined', async () => {
      // A real guard, and getOrg left unstubbed: nothing shows 'tgt-org' is a
      // sandbox. It was classed as development, so the run started without a
      // word to the user.
      const requestConfirmation = vi.fn().mockResolvedValue(false);
      const guard = new ProductionGuard({ requestConfirmation });
      const check = vi.spyOn(guard, 'check');
      deps.infraServices = {
        performanceTracker: { start: vi.fn(), complete: vi.fn() },
        productionGuard: guard,
        offlineManager: undefined,
        piiDetector: undefined,
      } as unknown as NonNullable<HandlerDeps['infraServices']>;

      await handler.handle(
        buildMsg('forge:execute', { graph: createMockGraph(), config: createMockConfig() }),
      );

      expect(requestConfirmation).toHaveBeenCalledWith(
        'INSERT 10 Account record(s) on production org tgt-org [module: forge]',
        'production',
      );
      expect(check.mock.calls.map(([request]) => request.orgTier)).toEqual(['production']);
      expect(orchestrator.execute).not.toHaveBeenCalled();
      const errors = vi
        .mocked(deps.broker.postToWebview)
        .mock.calls.map((call) => call[0] as BaseMessage & { payload: { code?: string } })
        .filter((m) => m.type === 'forge:execute:error');
      expect(errors).toHaveLength(1);
      expect(errors[0].payload.code).toBe('GUARD_DECLINED');
    });

    it('lets sandbox executions through once the guard has judged them', async () => {
      const guard = wireGuard({ allowed: true, requiresConfirmation: false });
      mockTargetOrgType('Sandbox');

      const msg = buildMsg('forge:execute', {
        graph: createMockGraph(),
        config: createMockConfig(),
      });
      await handler.handle(msg);

      expect(guard.check).toHaveBeenCalledTimes(1);
      expect(guard.check.mock.calls[0][0]).toMatchObject({
        orgId: 'tgt-org',
        orgTier: 'development',
        module: 'forge',
      });
      expect(orchestrator.execute).toHaveBeenCalledTimes(1);
      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const errCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:execute:error',
      );
      expect(errCalls).toHaveLength(0);
    });
  });

  describe('audit trail', () => {
    const SOURCE_ID = '001Fk00000AbCdEFGH';
    const TARGET_ID = '001Fk00000ZyXwVUTS';

    /** A real store, read back the way the Reports page reads it. */
    function recordingStore(): ConfigStore {
      const store = new ConfigStore(new InMemoryConfigStoreBackend());
      store.initialize();
      deps.configStore = store;
      return store;
    }

    function execute(): Promise<boolean> {
      return handler.handle(
        buildMsg('forge:execute', { graph: createMockGraph(), config: createMockConfig() }),
      );
    }

    it('records a finished run once: what it created and lost per object, and where from', async () => {
      const store = recordingStore();
      vi.mocked(orchestrator.execute).mockResolvedValue(
        createMockResult({
          status: 'partial',
          idRemapTable: { [SOURCE_ID]: TARGET_ID },
          idRemapByObject: [
            { objectApiName: 'Account', created: 2, linked: 1 },
            { objectApiName: 'Contact', created: 3, linked: 0 },
          ],
          errors: [
            {
              objectApiName: 'Contact',
              stage: 'insert',
              failedCount: 1,
              attemptedCount: 4,
              samples: [],
            },
            // A pass, not an object; and reference data never meant to be written.
            {
              objectApiName: '__pass2__',
              stage: 'insert',
              failedCount: 2,
              attemptedCount: 2,
              samples: [],
            },
            {
              objectApiName: 'Product2',
              stage: 'scope',
              failedCount: 4,
              attemptedCount: 4,
              samples: [],
            },
          ],
        }),
      );

      await execute();

      const { entries } = new AuditTrailStore(store).list();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        action: 'forge_execute',
        module: 'forge',
        orgId: 'tgt-org',
        sourceOrgId: 'src-org',
        outcome: 'partial',
        objects: [
          { objectApiName: 'Account', created: 2, updated: 0, deleted: 0, failed: 0 },
          { objectApiName: 'Contact', created: 3, updated: 0, deleted: 0, failed: 1 },
        ],
      });
      expect(entries[0].operationId).toMatch(/^forge-execute-/);
      // The lineage counts the remap table: created and linked rows alike.
      const lineage = new LineageStore(store).get(entries[0].operationId);
      expect(lineage?.nodes.filter((n) => n.type === 'object').map((n) => n.recordCount)).toEqual([
        3, 3,
      ]);
    });

    it('counts the files a run copied per object, as it counts records', async () => {
      const store = recordingStore();
      vi.mocked(orchestrator.execute).mockResolvedValue(
        createMockResult({
          status: 'partial',
          idRemapByObject: [
            { objectApiName: 'Case', created: 1, linked: 0 },
            { objectApiName: 'ContentDocument', created: 2, linked: 0 },
            { objectApiName: 'Attachment', created: 1, linked: 0 },
          ],
          errors: [
            {
              objectApiName: 'ContentDocument',
              stage: 'insert',
              failedCount: 1,
              attemptedCount: 1,
              samples: [],
            },
          ],
        }),
      );

      await execute();

      expect(new AuditTrailStore(store).list().entries[0].objects).toEqual([
        { objectApiName: 'Case', created: 1, updated: 0, deleted: 0, failed: 0 },
        { objectApiName: 'ContentDocument', created: 2, updated: 0, deleted: 0, failed: 1 },
        { objectApiName: 'Attachment', created: 1, updated: 0, deleted: 0, failed: 0 },
      ]);
    });

    it('counts the records an upsert wrote over as updated, never as created', async () => {
      const store = recordingStore();
      vi.mocked(orchestrator.execute).mockResolvedValue(
        createMockResult({
          idRemapByObject: [{ objectApiName: 'Account', created: 1, linked: 0, updated: 2 }],
        }),
      );

      await execute();

      const { entries } = new AuditTrailStore(store).list();
      expect(entries[0].objects).toEqual([
        { objectApiName: 'Account', created: 1, updated: 2, deleted: 0, failed: 0 },
      ]);
      // The lineage counts every row the run carried into the target.
      const lineage = new LineageStore(store).get(entries[0].operationId);
      expect(lineage?.nodes.filter((n) => n.type === 'object').map((n) => n.recordCount)).toEqual([
        3,
      ]);
    });

    it('keeps no record id of the remap table in the trail or the lineage', async () => {
      const store = recordingStore();
      vi.mocked(orchestrator.execute).mockResolvedValue(
        createMockResult({
          idRemapTable: { [SOURCE_ID]: TARGET_ID },
          idRemapByObject: [{ objectApiName: 'Account', created: 1, linked: 0 }],
        }),
      );

      await execute();

      const stored = JSON.stringify([store.get('audit:trail'), store.get('lineage:runs')]);
      expect(stored).toContain('Account');
      expect(stored).not.toContain(SOURCE_ID);
      expect(stored).not.toContain(TARGET_ID);
    });

    it('records a run Production Guard refused as stopped, with the refusal', async () => {
      const store = recordingStore();
      deps.infraServices = {
        productionGuard: {
          check: vi.fn().mockReturnValue({
            allowed: false,
            requiresConfirmation: false,
            requiresApproval: false,
            blockedReason: 'insert is not allowed on production org tgt-org',
            warnings: [],
            impactSummary: '',
          }),
          confirmIfNeeded: vi.fn(),
        },
      } as unknown as NonNullable<HandlerDeps['infraServices']>;

      await execute();

      expect(orchestrator.execute).not.toHaveBeenCalled();
      expect(new AuditTrailStore(store).list().entries).toEqual([
        expect.objectContaining({ outcome: 'stopped', guard: 'refused', objects: [] }),
      ]);
      expect(new LineageStore(store).get()).toBeNull();
    });

    it('records the confirmation a person gave with the run it let through', async () => {
      const store = recordingStore();
      deps.infraServices = {
        productionGuard: {
          check: vi.fn().mockReturnValue({
            allowed: true,
            requiresConfirmation: true,
            requiresApproval: false,
            warnings: [],
            impactSummary: '',
          }),
          confirmIfNeeded: vi.fn().mockResolvedValue(true),
          canAskForConfirmation: true,
        },
      } as unknown as NonNullable<HandlerDeps['infraServices']>;

      await execute();

      expect(new AuditTrailStore(store).list().entries).toEqual([
        expect.objectContaining({ outcome: 'success', guard: 'confirmed' }),
      ]);
    });

    it('records a run that threw as failed, without counts it cannot know', async () => {
      const store = recordingStore();
      vi.mocked(orchestrator.execute).mockRejectedValue(new Error('session expired'));

      await execute();

      expect(new AuditTrailStore(store).list().entries).toEqual([
        expect.objectContaining({ outcome: 'failure', objects: [] }),
      ]);
    });

    it('records what a run that threw had written, per object, and where from', async () => {
      // Stopped by an abort after the Accounts and the first Contacts: the
      // entry said "failed" and nothing else, as if the org had not been touched.
      const store = recordingStore();
      const stopped = new Error('Forge execution was aborted by user request.');
      keepPartialSummary(stopped, {
        successCount: 5,
        updatedCount: 0,
        linkedCount: 0,
        wouldInsertCount: 0,
        failedCount: 1,
        skippedCount: 0,
        remapCount: 5,
        errors: [
          {
            objectApiName: 'Contact',
            stage: 'insert',
            failedCount: 1,
            attemptedCount: 4,
            samples: [],
          },
        ],
        truncatedObjects: [],
        remapTable: {},
        existingRecords: [],
        existingSourceIds: [],
        updatedSourceIds: [],
        remapByObject: [
          { objectApiName: 'Account', created: 2, linked: 0 },
          { objectApiName: 'Contact', created: 3, linked: 0 },
        ],
        createdByObject: [],
        readByObject: [
          { objectApiName: 'Account', read: 2 },
          { objectApiName: 'Contact', read: 4 },
        ],
        failedReads: [],
      });
      vi.mocked(orchestrator.execute).mockRejectedValue(stopped);

      await execute();

      const { entries } = new AuditTrailStore(store).list();
      expect(entries).toEqual([
        expect.objectContaining({
          outcome: 'failure',
          sourceOrgId: 'src-org',
          objects: [
            { objectApiName: 'Account', created: 2, updated: 0, deleted: 0, failed: 0 },
            { objectApiName: 'Contact', created: 3, updated: 0, deleted: 0, failed: 1 },
          ],
        }),
      ]);
      expect(new LineageStore(store).get(entries[0].operationId)).not.toBeNull();
    });
  });

  describe('a run that stopped part way, in the history', () => {
    const CREATED_SOURCE = '001000000000001SRC';
    const CREATED_TARGET = '001000000000001AAA';
    const LINKED_SOURCE = '001000000000002SRC';
    const LINKED_TARGET = '001000000000002AAA';

    function historyStore(): ConfigStore {
      const store = new ConfigStore(new InMemoryConfigStoreBackend());
      store.initialize();
      deps.configStore = store;
      return store;
    }

    const kept = (store: ConfigStore): ForgeExecutionResult[] =>
      store.get<ForgeExecutionResult[]>('forge:history') ?? [];

    /**
     * `error`, carrying what the executor held when it threw: an account it
     * linked to the one the target held and, unless `createdOne` is false, an
     * account it created.
     */
    function stoppedWith(error: Error, createdOne = true): Error {
      keepPartialSummary(error, {
        successCount: createdOne ? 1 : 0,
        updatedCount: 0,
        linkedCount: 1,
        wouldInsertCount: 0,
        failedCount: 0,
        skippedCount: 0,
        remapCount: createdOne ? 2 : 1,
        errors: [],
        truncatedObjects: [],
        remapTable: {
          ...(createdOne ? { [CREATED_SOURCE]: CREATED_TARGET } : {}),
          [LINKED_SOURCE]: LINKED_TARGET,
        },
        existingRecords: [{ objectApiName: 'Account', linked: 1, unidentified: 0 }],
        existingSourceIds: [LINKED_SOURCE],
        updatedSourceIds: [],
        remapByObject: [{ objectApiName: 'Account', created: createdOne ? 1 : 0, linked: 1 }],
        createdByObject: createdOne
          ? [{ objectApiName: 'Account', sourceIds: [CREATED_SOURCE] }]
          : [],
        readByObject: [{ objectApiName: 'Account', read: createdOne ? 2 : 1 }],
        failedReads: [],
      });
      return error;
    }

    async function executeThrowing(error: Error): Promise<void> {
      vi.mocked(orchestrator.execute).mockRejectedValue(error);
      await handler.handle(
        buildMsg('forge:execute', { graph: createMockGraph(), config: createMockConfig() }),
      );
    }

    /** The config a history entry keeps: the run's, without its org pair. */
    const KEPT_CONFIG = {
      inputMode: 'record',
      recordId: '001000000000123',
      depth: 'direct',
      anonymizePII: false,
      skipEmpty: false,
      batchSize: 'auto',
    };

    it('keeps a run that failed after writing as failed, with what it created and where', async () => {
      const store = historyStore();

      await executeThrowing(
        stoppedWith(new Error('INVALID_SESSION_ID: Session expired or invalid')),
      );

      expect(kept(store)).toEqual([
        expect.objectContaining({
          status: 'failure',
          targetOrgId: 'tgt-org',
          config: KEPT_CONFIG,
          createdCount: 1,
          linkedExistingCount: 1,
          idRemapTable: { [CREATED_SOURCE]: CREATED_TARGET, [LINKED_SOURCE]: LINKED_TARGET },
          idRemapExisting: [LINKED_SOURCE],
          idRemapCreated: [{ objectApiName: 'Account', sourceIds: [CREATED_SOURCE] }],
        }),
      ]);
      expect(kept(store)[0]).not.toHaveProperty('cancelled');
    });

    it('keeps a run a cancel stopped after writing as cancelled, never as a success', async () => {
      const store = historyStore();

      await executeThrowing(
        stoppedWith(new ForgeAbortedError('Forge execution was aborted by user request.')),
      );

      expect(kept(store)).toEqual([
        expect.objectContaining({
          status: 'partial',
          cancelled: true,
          targetOrgId: 'tgt-org',
          idRemapCreated: [{ objectApiName: 'Account', sourceIds: [CREATED_SOURCE] }],
        }),
      ]);
    });

    it('keeps nothing of a run that stopped before it created a record', async () => {
      const store = historyStore();

      await executeThrowing(stoppedWith(new Error('INVALID_SESSION_ID'), false));
      await executeThrowing(new Error('source org unreachable'));

      expect(kept(store)).toEqual([]);
    });

    /** The `forge:execute:error` payloads posted so far. */
    function errorsPosted(): Array<Record<string, unknown>> {
      return vi
        .mocked(deps.broker.postToWebview)
        .mock.calls.map((call) => call[0] as BaseMessage & { payload: Record<string, unknown> })
        .filter((m) => m.type === 'forge:execute:error')
        .map((m) => m.payload);
    }

    it('tells the screen what a run that failed after writing had created, as the history keeps it', async () => {
      // The error said only what went wrong: the screen could not say that the
      // run had left records in the target, nor show them.
      const store = historyStore();

      await executeThrowing(
        stoppedWith(new Error('INVALID_SESSION_ID: Session expired or invalid')),
      );

      const [error] = errorsPosted();
      expect(error).toMatchObject({
        message: 'INVALID_SESSION_ID: Session expired or invalid',
        code: 'EXECUTE_ERROR',
      });
      // The entry but the config and the org the history adds, as a finished
      // run is answered: the same run, under the same id, that Retry names.
      expect(error.result).toEqual({
        ...kept(store)[0],
        config: undefined,
        targetOrgId: undefined,
      });
      expect(error.result).not.toHaveProperty('config');
      expect(error.result).toMatchObject({
        status: 'failure',
        createdCount: 1,
        idRemapCreated: [{ objectApiName: 'Account', sourceIds: [CREATED_SOURCE] }],
      });
    });

    it('tells the screen that a run a cancel stopped after writing was cancelled', async () => {
      historyStore();

      await executeThrowing(
        stoppedWith(new ForgeAbortedError('Forge execution was aborted by user request.')),
      );

      expect(errorsPosted()[0].result).toMatchObject({ status: 'partial', cancelled: true });
    });

    it('says nothing of records for a run that created none', async () => {
      historyStore();

      await executeThrowing(stoppedWith(new Error('INVALID_SESSION_ID'), false));
      await executeThrowing(new Error('source org unreachable'));

      const errors = errorsPosted();
      expect(errors).toHaveLength(2);
      expect(errors.map((error) => 'result' in error)).toEqual([false, false]);
    });

    it('records a finished run as it always has', async () => {
      const store = historyStore();
      const result = createMockResult({
        idRemapByObject: [{ objectApiName: 'Account', created: 5, linked: 0 }],
      });
      vi.mocked(orchestrator.execute).mockResolvedValue(result);

      await handler.handle(
        buildMsg('forge:execute', { graph: createMockGraph(), config: createMockConfig() }),
      );

      expect(kept(store)).toEqual([{ ...result, config: KEPT_CONFIG, targetOrgId: 'tgt-org' }]);
    });
  });

  describe('forge:pause', () => {
    it('delegates to orchestrator.pause', async () => {
      const msg = buildMsg('forge:pause');
      const handled = await handler.handle(msg);

      expect(handled).toBe(true);
      expect(orchestrator.pause).toHaveBeenCalledOnce();
    });
  });

  describe('forge:resume', () => {
    it('delegates to orchestrator.resume', async () => {
      const msg = buildMsg('forge:resume');
      const handled = await handler.handle(msg);

      expect(handled).toBe(true);
      expect(orchestrator.resume).toHaveBeenCalledOnce();
    });
  });

  describe('forge:abort', () => {
    it('calls abort on the active AbortController', async () => {
      const graph = createMockGraph();
      const config = createMockConfig();
      const abortSpy = vi.spyOn(AbortController.prototype, 'abort');

      let resolveExecute: ((value: ForgeExecutionResult) => void) | undefined;
      vi.mocked(orchestrator.execute).mockImplementation(
        () =>
          new Promise<ForgeExecutionResult>((resolve) => {
            resolveExecute = resolve;
          }),
      );

      const execMsg = buildMsg('forge:execute', { graph, config });
      const executePromise = handler.handle(execMsg);
      // The run reads both orgs' record types before it starts.
      await vi.waitFor(() => expect(resolveExecute).toBeDefined());

      await handler.handle(buildMsg('forge:abort'));
      expect(abortSpy).toHaveBeenCalled();

      resolveExecute!(createMockResult());
      await executePromise;

      abortSpy.mockRestore();
    });

    it('never starts a run aborted while record types are still being read', async () => {
      let releaseLookup: () => void = () => {};
      mockGetConn.mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            releaseLookup = () => reject(new Error('lookup released'));
          }),
      );

      const executePromise = handler.handle(
        buildMsg('forge:execute', { graph: createMockGraph(), config: createMockConfig() }),
      );
      await vi.waitFor(() => expect(mockGetConn).toHaveBeenCalled());
      await handler.handle(buildMsg('forge:abort'));
      releaseLookup();
      await executePromise;

      expect(orchestrator.execute).not.toHaveBeenCalled();
      const errors = vi
        .mocked(deps.broker.postToWebview)
        .mock.calls.map((call) => call[0] as BaseMessage & { payload?: { message?: string } })
        .filter((m) => m.type === 'forge:execute:error');
      expect(errors).toHaveLength(1);
      expect(errors[0].payload?.message).toContain('aborted before it started');
    });

    it('refuses the run as soon as Abort is pressed during a record type lookup that hangs', async () => {
      mockGetConn.mockImplementation(() => new Promise(() => {}));

      const executePromise = handler.handle(
        buildMsg('forge:execute', { graph: createMockGraph(), config: createMockConfig() }),
      );
      await vi.waitFor(() => expect(mockGetConn).toHaveBeenCalled());
      await handler.handle(buildMsg('forge:abort'));
      // The lookup is never released: the handler must settle on the Abort alone.
      await executePromise;

      expect(orchestrator.execute).not.toHaveBeenCalled();
      const errors = vi
        .mocked(deps.broker.postToWebview)
        .mock.calls.map((call) => call[0] as BaseMessage & { payload?: { message?: string } })
        .filter((m) => m.type === 'forge:execute:error');
      expect(errors).toHaveLength(1);
      expect(errors[0].payload?.message).toContain('aborted before it started');
    });

    it('aborts discovery when forge:abort is called during discover', async () => {
      const config = createMockConfig();
      const abortSpy = vi.spyOn(AbortController.prototype, 'abort');

      let resolveDiscover: ((value: ForgeGraph) => void) | undefined;
      vi.mocked(orchestrator.discover).mockImplementation(
        () =>
          new Promise<ForgeGraph>((resolve) => {
            resolveDiscover = resolve;
          }),
      );

      const discoverMsg = buildMsg('forge:discover', { config });
      const discoverPromise = handler.handle(discoverMsg);

      await handler.handle(buildMsg('forge:abort'));
      expect(abortSpy).toHaveBeenCalled();

      resolveDiscover!(createMockGraph());
      await discoverPromise;

      abortSpy.mockRestore();
    });

    it('delegates to orchestrator.abort', async () => {
      const msg = buildMsg('forge:abort');
      const handled = await handler.handle(msg);

      expect(handled).toBe(true);
      expect(orchestrator.abort).toHaveBeenCalledOnce();
    });

    it('returns true even when no active execution', async () => {
      const msg = buildMsg('forge:abort');
      const handled = await handler.handle(msg);
      expect(handled).toBe(true);
    });
  });

  describe('forge:templates:list', () => {
    it('returns empty templates from ConfigStore initially', async () => {
      vi.mocked(deps.configStore.get).mockReturnValue(undefined);

      const msg = buildMsg('forge:templates:list');
      const handled = await handler.handle(msg);

      expect(handled).toBe(true);
      expect(deps.configStore.get).toHaveBeenCalledWith('forge:templates');

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const responseCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:templates:list:response',
      );
      expect(responseCalls).toHaveLength(1);
      const response = responseCalls[0][0] as BaseMessage & {
        correlationId?: string;
        payload: { templates: ForgeTemplate[] };
      };
      expect(response.correlationId).toBe(msg.id);
      expect(response.payload.templates).toEqual([]);
    });

    it('returns templates loaded from ConfigStore', async () => {
      const templates = [createMockTemplate()];
      vi.mocked(deps.configStore.get).mockReturnValue(templates);

      const msg = buildMsg('forge:templates:list');
      await handler.handle(msg);

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const responseCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:templates:list:response',
      );
      const response = responseCalls[0][0] as BaseMessage & {
        payload: { templates: ForgeTemplate[] };
      };
      expect(response.payload.templates).toEqual(templates);
    });
  });

  describe('forge:templates:save', () => {
    it('persists template to ConfigStore with correlationId response', async () => {
      vi.mocked(deps.configStore.get).mockReturnValue([]);
      const template = createMockTemplate();

      const msg = buildMsg('forge:templates:save', { template });
      const handled = await handler.handle(msg);

      expect(handled).toBe(true);
      expect(deps.configStore.set).toHaveBeenCalledWith('forge:templates', [template], 'forge');

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const responseCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:templates:save:response',
      );
      expect(responseCalls).toHaveLength(1);
      const response = responseCalls[0][0] as BaseMessage & {
        correlationId?: string;
        payload: { success: boolean };
      };
      expect(response.correlationId).toBe(msg.id);
      expect(response.payload.success).toBe(true);
    });

    it('replaces template with same id', async () => {
      const template1 = createMockTemplate({ id: 'tpl-1', name: 'V1' });
      vi.mocked(deps.configStore.get).mockReturnValue([template1]);

      const template2 = createMockTemplate({ id: 'tpl-1', name: 'V2' });
      const msg = buildMsg('forge:templates:save', { template: template2 });
      await handler.handle(msg);

      expect(deps.configStore.set).toHaveBeenCalledWith('forge:templates', [template2], 'forge');
    });
  });

  describe('forge:templates:delete', () => {
    it('removes a template by id and persists to ConfigStore', async () => {
      const template = createMockTemplate({ id: 'tpl-del' });
      vi.mocked(deps.configStore.get).mockReturnValue([template]);

      const msg = buildMsg('forge:templates:delete', { templateId: 'tpl-del' });
      const handled = await handler.handle(msg);

      expect(handled).toBe(true);
      expect(deps.configStore.set).toHaveBeenCalledWith('forge:templates', [], 'forge');

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const responseCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:templates:delete:response',
      );
      expect(responseCalls).toHaveLength(1);
      const response = responseCalls[0][0] as BaseMessage & {
        correlationId?: string;
        payload: { success: boolean };
      };
      expect(response.correlationId).toBe(msg.id);
      expect(response.payload.success).toBe(true);
    });
  });

  describe('forge:history:list', () => {
    it('returns empty history from ConfigStore initially', async () => {
      vi.mocked(deps.configStore.get).mockReturnValue(undefined);

      const msg = buildMsg('forge:history:list');
      const handled = await handler.handle(msg);

      expect(handled).toBe(true);
      expect(deps.configStore.get).toHaveBeenCalledWith('forge:history');

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const responseCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:history:list:response',
      );
      expect(responseCalls).toHaveLength(1);
      const response = responseCalls[0][0] as BaseMessage & {
        correlationId?: string;
        payload: { history: ForgeExecutionResult[] };
      };
      expect(response.correlationId).toBe(msg.id);
      expect(response.payload.history).toEqual([]);
    });

    it('returns history loaded from ConfigStore', async () => {
      const history = [createMockResult()];
      vi.mocked(deps.configStore.get).mockReturnValue(history);

      const msg = buildMsg('forge:history:list');
      await handler.handle(msg);

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const responseCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:history:list:response',
      );
      const response = responseCalls[0][0] as BaseMessage & {
        payload: { history: ForgeExecutionResult[] };
      };
      expect(response.payload.history).toEqual(history);
    });
  });

  describe('forge:plan:request', () => {
    it('sends error when planGenerator not configured', async () => {
      const msg = buildMsg('forge:plan:request', {
        graph: createMockGraph(),
        config: createMockConfig(),
      });
      const handled = await handler.handle(msg);

      expect(handled).toBe(true);
      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const errCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:plan:error',
      );
      expect(errCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('calls planGenerator.generate and posts response with correlationId', async () => {
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
      const planGenerator = {
        generate: vi.fn().mockReturnValue(mockPlan),
      } as unknown as ForgePlanGenerator;
      handler.setForgeOrchestrator(orchestrator, { planGenerator });

      const graph = createMockGraph();
      const msg = buildMsg('forge:plan:request', {
        graph,
        config: createMockConfig(),
      });
      const handled = await handler.handle(msg);

      expect(handled).toBe(true);
      expect(planGenerator.generate).toHaveBeenCalledWith(graph);

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const responseCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:plan:response',
      );
      expect(responseCalls).toHaveLength(1);
      const response = responseCalls[0][0] as BaseMessage & {
        correlationId?: string;
      };
      expect(response.correlationId).toBe(msg.id);
    });

    it('emits operation:started then operation:completed on success', async () => {
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
      const planGenerator = {
        generate: vi.fn().mockReturnValue(mockPlan),
      } as unknown as ForgePlanGenerator;
      handler.setForgeOrchestrator(orchestrator, { planGenerator });

      const msg = buildMsg('forge:plan:request', {
        graph: createMockGraph(),
        config: createMockConfig(),
      });
      await handler.handle(msg);

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const startedCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'operation:started',
      );
      const completedCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'operation:completed',
      );
      expect(startedCalls).toHaveLength(1);
      expect(completedCalls).toHaveLength(1);
      const startedPayload = (
        startedCalls[0][0] as BaseMessage & {
          payload: { operationId: string; description: string };
        }
      ).payload;
      expect(startedPayload.operationId).toMatch(/^forge-plan-/);
      expect(startedPayload.description).toBe('Generating execution plan');
    });

    describe('a graph whose nodes know none of their fields', () => {
      const plan: ForgePlan = {
        waves: [],
        totalRecords: 0,
        totalApiCalls: 0,
        estimatedDurationSeconds: 0,
        cycleResolutions: [],
      };
      /** A starter template's graph: built without discovery, no field known. */
      const starter = (): ForgeGraph => ({
        ...createMockGraph(),
        nodes: createMockGraph().nodes.map((n) => ({ ...n, fieldCount: 0 })),
      });

      /** The plan response the handler posted. */
      function planResponse(): { plan: ForgePlan; graph?: ForgeGraph } {
        const call = vi
          .mocked(deps.broker.postToWebview)
          .mock.calls.find((c) => (c[0] as BaseMessage).type === 'forge:plan:response');
        return (call?.[0] as BaseMessage & { payload: { plan: ForgePlan; graph?: ForgeGraph } })
          .payload;
      }

      beforeEach(() => {
        const planGenerator = { generate: vi.fn().mockReturnValue(plan) };
        handler.setForgeOrchestrator(orchestrator, {
          planGenerator: planGenerator as unknown as ForgePlanGenerator,
        });
      });

      it('sends back the graph with the personal fields read from the source org', async () => {
        const graph = starter();
        const described: ForgeGraph = {
          ...graph,
          nodes: graph.nodes.map((n) => ({
            ...n,
            piiFields: ['Email'],
            anonymizeFields: ['Email'],
          })),
        };
        vi.mocked(orchestrator.readPersonalFields).mockResolvedValue(described);

        await handler.handle(
          buildMsg('forge:plan:request', {
            graph,
            config: createMockConfig({ anonymizePII: true }),
          }),
        );

        expect(orchestrator.readPersonalFields).toHaveBeenCalledWith(
          graph,
          expect.objectContaining({ sourceOrgId: 'src-org', anonymizePII: true }),
          expect.any(AbortSignal),
        );
        expect(planResponse()).toEqual({ plan, graph: described });
      });

      it('sends no graph back when the read found nothing to add', async () => {
        await handler.handle(
          buildMsg('forge:plan:request', { graph: starter(), config: createMockConfig() }),
        );

        expect(planResponse()).toEqual({ plan });
      });

      it('plans all the same when the read fails, and sends no graph back', async () => {
        vi.mocked(orchestrator.readPersonalFields).mockRejectedValue(
          new Error('INVALID_SESSION_ID'),
        );

        await handler.handle(
          buildMsg('forge:plan:request', { graph: starter(), config: createMockConfig() }),
        );

        expect(planResponse()).toEqual({ plan });
        const errors = vi
          .mocked(deps.broker.postToWebview)
          .mock.calls.filter((c) => (c[0] as BaseMessage).type === 'forge:plan:error');
        expect(errors).toHaveLength(0);
      });
    });

    it('emits forge:plan:error only (no duplicate operation:failed) when planGenerator throws', async () => {
      const planGenerator = {
        generate: vi.fn().mockImplementation(() => {
          throw new Error('generation failed');
        }),
      } as unknown as ForgePlanGenerator;
      handler.setForgeOrchestrator(orchestrator, { planGenerator });

      const msg = buildMsg('forge:plan:request', {
        graph: createMockGraph(),
        config: createMockConfig(),
      });
      await handler.handle(msg);

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      // B8: single error channel — every operation:failed also triggers an
      // error resolution, so emitting both caused a parasitic duplicate per
      // forge failure.
      const failedCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'operation:failed',
      );
      expect(failedCalls).toHaveLength(0);

      const errCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:plan:error',
      );
      expect(errCalls).toHaveLength(1);
      const errPayload = (
        errCalls[0][0] as BaseMessage & {
          payload: { message: string; code: string; retryable: boolean };
        }
      ).payload;
      expect(errPayload.code).toBe('PLAN_ERROR');
      expect(errPayload.retryable).toBe(false);
      expect(endOfTheOperation()).toEqual([{ status: 'failure' }]);
    });
  });

  describe('forge:compliance:request', () => {
    it('sends error when complianceService not configured', async () => {
      const msg = buildMsg('forge:compliance:request', {
        framework: 'gdpr',
        graph: createMockGraph(),
        config: createMockConfig(),
      });
      const handled = await handler.handle(msg);

      expect(handled).toBe(true);
      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const errCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:compliance:error',
      );
      expect(errCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('calls complianceService.generate and posts response with correlationId', async () => {
      const mockReport = { id: 'r-1', framework: 'gdpr' };
      const complianceService = {
        generate: vi.fn().mockReturnValue(mockReport),
      } as unknown as ForgeComplianceService;
      handler.setForgeOrchestrator(orchestrator, { complianceService });

      const graph = createMockGraph();
      const config = createMockConfig();
      const msg = buildMsg('forge:compliance:request', {
        framework: 'gdpr',
        graph,
        config,
      });
      const handled = await handler.handle(msg);

      expect(handled).toBe(true);
      expect(complianceService.generate).toHaveBeenCalledWith('gdpr', graph, 'src-org', 'tgt-org');

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const responseCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:compliance:response',
      );
      expect(responseCalls).toHaveLength(1);
      const response = responseCalls[0][0] as BaseMessage & {
        correlationId?: string;
      };
      expect(response.correlationId).toBe(msg.id);
    });

    it('shows one error and ends the operation as failed when the report cannot be made', async () => {
      const complianceService = {
        generate: vi.fn().mockImplementation(() => {
          throw new Error('report failed');
        }),
      } as unknown as ForgeComplianceService;
      handler.setForgeOrchestrator(orchestrator, { complianceService });

      await handler.handle(
        buildMsg('forge:compliance:request', {
          framework: 'gdpr',
          graph: createMockGraph(),
          config: createMockConfig(),
        }),
      );

      const types = vi
        .mocked(deps.broker.postToWebview)
        .mock.calls.map(([m]) => (m as BaseMessage).type);
      expect(types.filter((t) => t === 'forge:compliance:error')).toHaveLength(1);
      expect(types.filter((t) => t === 'operation:failed')).toHaveLength(0);
      expect(endOfTheOperation()).toEqual([{ status: 'failure' }]);
    });

    it('emits operation lifecycle events on success', async () => {
      const mockReport = { id: 'r-1', framework: 'gdpr' };
      const complianceService = {
        generate: vi.fn().mockReturnValue(mockReport),
      } as unknown as ForgeComplianceService;
      handler.setForgeOrchestrator(orchestrator, { complianceService });

      const msg = buildMsg('forge:compliance:request', {
        framework: 'gdpr',
        graph: createMockGraph(),
        config: createMockConfig(),
      });
      await handler.handle(msg);

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const startedCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'operation:started',
      );
      const completedCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'operation:completed',
      );
      expect(startedCalls).toHaveLength(1);
      expect(completedCalls).toHaveLength(1);
      const startedPayload = (
        startedCalls[0][0] as BaseMessage & {
          payload: { operationId: string; description: string };
        }
      ).payload;
      expect(startedPayload.operationId).toMatch(/^forge-compliance-/);
      expect(startedPayload.description).toBe('Generating compliance report');
    });
  });

  describe('forge:metadata-diff:request', () => {
    it('sends error when metadataDiff not configured', async () => {
      const msg = buildMsg('forge:metadata-diff:request', {
        sourceOrgId: 'src',
        targetOrgId: 'tgt',
        objectApiNames: ['Account'],
      });
      const handled = await handler.handle(msg);

      expect(handled).toBe(true);
      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const errCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:metadata-diff:error',
      );
      expect(errCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('calls metadataDiff.compare and posts response with correlationId', async () => {
      const mockDiffs = [
        {
          objectApiName: 'Account',
          fieldApiName: 'Custom__c',
          issue: 'missing',
          severity: 'error',
          details: 'Missing field',
        },
      ];
      const metadataDiff = {
        compare: vi.fn().mockResolvedValue(mockDiffs),
      } as unknown as ForgeMetadataDiff;
      handler.setForgeOrchestrator(orchestrator, { metadataDiff });

      const msg = buildMsg('forge:metadata-diff:request', {
        sourceOrgId: 'src',
        targetOrgId: 'tgt',
        objectApiNames: ['Account'],
      });
      const handled = await handler.handle(msg);

      expect(handled).toBe(true);
      expect(metadataDiff.compare).toHaveBeenCalledWith('src', 'tgt', ['Account']);

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const responseCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:metadata-diff:response',
      );
      expect(responseCalls).toHaveLength(1);
      const response = responseCalls[0][0] as BaseMessage & {
        correlationId?: string;
      };
      expect(response.correlationId).toBe(msg.id);
    });

    it('emits operation lifecycle events on success', async () => {
      const mockDiffs = [
        {
          objectApiName: 'Account',
          fieldApiName: 'Custom__c',
          issue: 'missing',
          severity: 'error',
          details: 'Missing field',
        },
      ];
      const metadataDiff = {
        compare: vi.fn().mockResolvedValue(mockDiffs),
      } as unknown as ForgeMetadataDiff;
      handler.setForgeOrchestrator(orchestrator, { metadataDiff });

      const msg = buildMsg('forge:metadata-diff:request', {
        sourceOrgId: 'src',
        targetOrgId: 'tgt',
        objectApiNames: ['Account'],
      });
      await handler.handle(msg);

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const startedCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'operation:started',
      );
      const completedCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'operation:completed',
      );
      expect(startedCalls).toHaveLength(1);
      expect(completedCalls).toHaveLength(1);
      const startedPayload = (
        startedCalls[0][0] as BaseMessage & {
          payload: { operationId: string; description: string };
        }
      ).payload;
      expect(startedPayload.operationId).toMatch(/^forge-metadata-diff-/);
      expect(startedPayload.description).toBe('Comparing metadata schemas');
    });

    it('emits forge:metadata-diff:error only (no duplicate operation:failed) when compare throws', async () => {
      const metadataDiff = {
        compare: vi.fn().mockRejectedValue(new Error('diff failed')),
      } as unknown as ForgeMetadataDiff;
      handler.setForgeOrchestrator(orchestrator, { metadataDiff });

      const msg = buildMsg('forge:metadata-diff:request', {
        sourceOrgId: 'src',
        targetOrgId: 'tgt',
        objectApiNames: ['Account'],
      });
      await handler.handle(msg);

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      // B8: single error channel (see forge:plan test for the rationale).
      const failedCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'operation:failed',
      );
      expect(failedCalls).toHaveLength(0);

      const errCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:metadata-diff:error',
      );
      expect(errCalls).toHaveLength(1);
      const errPayload = (
        errCalls[0][0] as BaseMessage & {
          payload: { message: string; code: string; retryable: boolean };
        }
      ).payload;
      expect(errPayload.code).toBe('METADATA_DIFF_ERROR');
      expect(errPayload.retryable).toBe(false);
      expect(endOfTheOperation()).toEqual([{ status: 'failure' }]);
    });
  });

  describe('forge:preview', () => {
    it('includes estimatedRecordCount, totalFieldCount, and estimatedSize in response', async () => {
      const mockConn = {
        describeGlobal: vi.fn().mockResolvedValue({
          sobjects: [{ name: 'Account', label: 'Account', keyPrefix: '001' }],
        }),
        describe: vi.fn().mockResolvedValue({
          fields: [{ name: 'Name' }, { name: 'Phone' }, { name: 'Industry' }],
        }),
        query: vi.fn().mockResolvedValue({ totalSize: 5000 }),
        limitInfo: {},
      };
      mockGetConn.mockResolvedValue(mockConn as never);
      mockQueryFallback.mockResolvedValue([
        { Id: '001xx000003DGb1', Name: 'Acme', Phone: '555-1234' },
      ]);

      const msg = buildMsg('forge:preview', {
        recordId: '001xx000003DGb1',
        orgId: 'org-1',
      });
      await handler.handle(msg);

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const responseCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:preview:response',
      );
      expect(responseCalls).toHaveLength(1);
      const response = responseCalls[0][0] as BaseMessage & {
        payload: {
          estimatedRecordCount: number;
          totalFieldCount: number;
          estimatedSize: number;
        };
      };
      expect(response.payload.totalFieldCount).toBe(3);
      expect(response.payload.estimatedRecordCount).toBe(5000);
      expect(response.payload.estimatedSize).toBeCloseTo(5);
    });

    it('defaults estimatedRecordCount to 0 when COUNT() query fails', async () => {
      const mockConn = {
        describeGlobal: vi.fn().mockResolvedValue({
          sobjects: [{ name: 'Account', label: 'Account', keyPrefix: '001' }],
        }),
        describe: vi.fn().mockResolvedValue({
          fields: [{ name: 'Name' }],
        }),
        query: vi.fn().mockRejectedValue(new Error('INVALID_QUERY')),
        limitInfo: {},
      };
      mockGetConn.mockResolvedValue(mockConn as never);
      mockQueryFallback.mockResolvedValue([{ Id: '001xx000003DGb1', Name: 'Acme' }]);

      const msg = buildMsg('forge:preview', {
        recordId: '001xx000003DGb1',
        orgId: 'org-1',
      });
      await handler.handle(msg);

      const postCalls = vi.mocked(deps.broker.postToWebview).mock.calls;
      const responseCalls = postCalls.filter(
        (call) => (call[0] as BaseMessage).type === 'forge:preview:response',
      );
      expect(responseCalls).toHaveLength(1);
      const response = responseCalls[0][0] as BaseMessage & {
        payload: {
          estimatedRecordCount: number;
          estimatedSize: number;
        };
      };
      expect(response.payload.estimatedRecordCount).toBe(0);
      expect(response.payload.estimatedSize).toBe(0);
    });

    it('refuses a record id carrying a quote before any query is built', async () => {
      // The Id lands inside a quoted SOQL literal. This suite used to stub the
      // escaping out, so nothing here showed a quote could not break out.
      await handler.handle(
        buildMsg('forge:preview', { recordId: "001xx0000' OR Id != '", orgId: 'org-1' }),
      );

      expect(mockGetConn).not.toHaveBeenCalled();
      expect(mockQueryFallback).not.toHaveBeenCalled();
      const errors = vi
        .mocked(deps.broker.postToWebview)
        .mock.calls.filter((call) => (call[0] as BaseMessage).type === 'forge:preview:error');
      expect(errors).toHaveLength(1);
    });

    it('queries the previewed record through a quoted, escaped Id literal', async () => {
      const mockConn = {
        describeGlobal: vi.fn().mockResolvedValue({
          sobjects: [{ name: 'Account', label: 'Account', keyPrefix: '001' }],
        }),
        describe: vi.fn().mockResolvedValue({ fields: [{ name: 'Name' }] }),
        query: vi.fn().mockResolvedValue({ totalSize: 1 }),
        limitInfo: {},
      };
      mockGetConn.mockResolvedValue(mockConn as never);
      mockQueryFallback.mockResolvedValue([{ Id: '001xx000003DGb1', Name: 'Acme' }]);

      await handler.handle(
        buildMsg('forge:preview', { recordId: '001xx000003DGb1', orgId: 'org-1' }),
      );

      expect(mockQueryFallback.mock.calls[0][2]).toBe(
        "SELECT FIELDS(STANDARD) FROM Account WHERE Id = '001xx000003DGb1' LIMIT 1",
      );
    });

    // describeGlobal returns 1-2 MB of JSON and the webview fires a
    // preview on every corrected record id. The prefix table is org-wide, so
    // it must be downloaded once per org, not once per keystroke.
    describe('describeGlobal caching', () => {
      /** Connection double whose describeGlobal/describe/query are countable. */
      function createPreviewConn(): {
        describeGlobal: ReturnType<typeof vi.fn>;
        describe: ReturnType<typeof vi.fn>;
        query: ReturnType<typeof vi.fn>;
        limitInfo: Record<string, never>;
      } {
        return {
          describeGlobal: vi.fn().mockResolvedValue({
            sobjects: [
              { name: 'Account', label: 'Account', keyPrefix: '001' },
              { name: 'Contact', label: 'Contact', keyPrefix: '003' },
            ],
          }),
          describe: vi.fn().mockResolvedValue({ fields: [{ name: 'Name' }] }),
          query: vi.fn().mockResolvedValue({ totalSize: 42 }),
          limitInfo: {},
        };
      }

      it('describes the global prefix table once for two previews on the same org', async () => {
        const mockConn = createPreviewConn();
        mockGetConn.mockResolvedValue(mockConn as never);
        mockQueryFallback.mockResolvedValue([{ Id: '001xx000003DGb1', Name: 'Acme' }]);

        await handler.handle(
          buildMsg('forge:preview', {
            recordId: '001xx000003DGb1',
            orgId: 'org-1',
          }),
        );
        await handler.handle(
          buildMsg('forge:preview', {
            recordId: '001xx000003DGb2',
            orgId: 'org-1',
          }),
        );

        expect(mockConn.describeGlobal).toHaveBeenCalledTimes(1);
        const responseCalls = vi
          .mocked(deps.broker.postToWebview)
          .mock.calls.filter((call) => (call[0] as BaseMessage).type === 'forge:preview:response');
        expect(responseCalls).toHaveLength(2);
      });

      it('serves the cached prefix table without losing the object label', async () => {
        const mockConn = createPreviewConn();
        mockGetConn.mockResolvedValue(mockConn as never);
        mockQueryFallback.mockResolvedValue([{ Id: '003xx000004TMi9', Name: 'Ada' }]);

        await handler.handle(
          buildMsg('forge:preview', {
            recordId: '003xx000004TMi9',
            orgId: 'org-1',
          }),
        );
        await handler.handle(
          buildMsg('forge:preview', {
            recordId: '003xx000004TMi8',
            orgId: 'org-1',
          }),
        );

        const responseCalls = vi
          .mocked(deps.broker.postToWebview)
          .mock.calls.filter((call) => (call[0] as BaseMessage).type === 'forge:preview:response');
        expect(responseCalls).toHaveLength(2);
        const second = responseCalls[1][0] as BaseMessage & {
          payload: { objectApiName: string; objectLabel: string };
        };
        expect(second.payload.objectApiName).toBe('Contact');
        expect(second.payload.objectLabel).toBe('Contact');
      });

      it('reads the prefix table of an org again once told to forget it', async () => {
        // A refreshed sandbox is a new org behind the same id: the table its
        // old self answered with would be served for five more minutes.
        const mockConn = createPreviewConn();
        mockGetConn.mockResolvedValue(mockConn as never);
        mockQueryFallback.mockResolvedValue([{ Id: '001xx000003DGb1', Name: 'Acme' }]);
        const preview = () =>
          handler.handle(
            buildMsg('forge:preview', { recordId: '001xx000003DGb1', orgId: 'org-1' }),
          );

        await preview();
        handler.forgetOrg('org-1');
        await preview();

        expect(mockConn.describeGlobal).toHaveBeenCalledTimes(2);
      });

      it('drops the discovered graphs and describes of the org it forgets', () => {
        handler.forgetOrg('org-1');

        expect(orchestrator.clearDiscoveryCache).toHaveBeenCalledWith(['org-1']);
      });

      it('does not serve one org cached prefix table to another org', async () => {
        const orgOneConn = createPreviewConn();
        const orgTwoConn = {
          ...createPreviewConn(),
          describeGlobal: vi.fn().mockResolvedValue({
            sobjects: [{ name: 'Case', label: 'Case', keyPrefix: '001' }],
          }),
        };
        mockGetConn.mockImplementation(async (orgId: string) =>
          orgId === 'org-1' ? (orgOneConn as never) : (orgTwoConn as never),
        );
        mockQueryFallback.mockResolvedValue([{ Id: '001xx000003DGb1', Name: 'Acme' }]);

        await handler.handle(
          buildMsg('forge:preview', {
            recordId: '001xx000003DGb1',
            orgId: 'org-1',
          }),
        );
        await handler.handle(
          buildMsg('forge:preview', {
            recordId: '001xx000003DGb1',
            orgId: 'org-2',
          }),
        );

        expect(orgOneConn.describeGlobal).toHaveBeenCalledTimes(1);
        expect(orgTwoConn.describeGlobal).toHaveBeenCalledTimes(1);
        const responseCalls = vi
          .mocked(deps.broker.postToWebview)
          .mock.calls.filter((call) => (call[0] as BaseMessage).type === 'forge:preview:response');
        expect(responseCalls).toHaveLength(2);
        expect(
          (
            responseCalls[1][0] as BaseMessage & {
              payload: { objectApiName: string };
            }
          ).payload.objectApiName,
        ).toBe('Case');
      });
    });
  });
});
